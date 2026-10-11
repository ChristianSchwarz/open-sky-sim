using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using UnityEngine;
using UnityEngine.Rendering;
#if RETRO_INPUT_SYSTEM
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Controls;
#endif

namespace Retro.Unity
{
    public enum FlightView
    {
        Cockpit,
        ChaseBack,
        ChaseFront,
        Free,
        /// <summary>F6: behind (or, pressed again, ahead of) the opponent, looking at the player.</summary>
        AiChase,
        /// <summary>F3: over the carrier stern, looking at the player.</summary>
        CarrierStern,
    }

    /// <summary>
    /// The player's aircraft (M4): the ported <see cref="CombatSim"/> with one
    /// externally flown aircraft, stepped here on the main thread the way the
    /// web game's worker steps it, over <see cref="DemHeightField"/>.
    ///
    /// Keys go to the sim as KeyboardEvent.key names (the sim owns the
    /// keyboard and gamepad handling, as in the TS), so flaps, gear, brakes,
    /// autopilot and the layouts all behave as on the web. Views use the
    /// ported camera updaters: F1 cockpit, F2 chase back/front, F3 over the
    /// carrier stern, F6 the opponent, F10 free camera. R restarts the flight; Ctrl+1..9 starts one
    /// in that spawn mode (the spawn menu's digits). Each flight brings the
    /// opponent and the wingman (<see cref="Combat"/>).
    /// </summary>
    [DefaultExecutionOrder(-50)]
    public sealed class PlayerFlight : MonoBehaviour, ICameraActor
    {
        public const string PlayerId = "player";

        public TerrainRenderer terrain;
        public FlyCamera view;

        [Header("Spawn")]
        [Tooltip("The spawn menu's start (game.ts beginFlight); Location is airborne at the point below. Ctrl+digit in flight.")]
        public SpawnMode spawnMode = SpawnMode.Runway;
        [Tooltip("ICAO (or name) of the airfield to start at; empty picks the nearest base.")]
        public string preferIcao = "";
        public double spawnLat = 27.75;
        public double spawnLon = -15.6;
        [Tooltip("Metres above the ellipsoid; raised to clear the ground if needed.")]
        public double spawnAltitude = 1500;
        [Tooltip("Degrees clockwise from north.")]
        public double spawnHeadingDeg = 0;
        public double spawnSpeed = 200;
        [Range(0, 1)] public double spawnThrottle = 0.7;

        public SimFlightModelKind flightModel = SimFlightModelKind.Fm2;
        public KeyboardControlLayoutId keyboardLayout = KeyboardControlLayoutId.ARROWS;
        public FlightView flightView = FlightView.ChaseBack;
        public double fovDeg = 50;
        public bool showHud = true;

        [Tooltip("Which aircraft: 'f22' or a pack id from dist/assets (see Catalogue).")]
        public string aircraftId = "f22";
        [Tooltip("N on the web: Auto follows the swing-wing schedule.")]
        public WingSweepMode wingSweepMode = WingSweepMode.Auto;

        private CombatSim sim;
        private DemHeightField heightField;
        private SimAircraft aircraft;
        private readonly CameraPose pose = new CameraPose();
        private CockpitFrontCameraUpdater cockpitCamera;
        private ExteriorFrontBehindCameraUpdater chaseBack;
        private ExteriorFrontBehindCameraUpdater chaseFront;
        private CrashedCameraUpdater crashedCamera;
        private readonly Dictionary<int, string> heldKeys = new Dictionary<int, string>();
        private bool gamepadActive;
        private double gamepadThrottle;
        private readonly AircraftView airframeView = new AircraftView("Player aircraft");
        private Combat combat;
        private AiExteriorCameraUpdater aiChase;
        private ExteriorViewHeading aiChaseHeading = ExteriorViewHeading.Back;
        private TracerRenderer tracers;
        private Carrier carrier;
        private CarrierFx carrierFx;
        private readonly Tailhook tailhook = new Tailhook();
        private CarrierOverSternCameraUpdater carrierCamera;
        private Fm2AircraftConfig config;
        private List<SceneRunway> runways = new List<SceneRunway>();
        private SceneRunway startRunway;
        private SimFlightModelKind appliedModel;
        private List<AircraftCatalogue.Entry> catalogue;
        private System.Threading.Tasks.Task<List<AircraftCatalogue.Entry>> catalogueTask;
        private AircraftCatalogue.Entry current;

        /// <summary>The flyable aircraft found at boot: the F-22 and every pack.</summary>
        public IReadOnlyList<AircraftCatalogue.Entry> Catalogue => catalogue;
        public FlyableAircraftDef CurrentDef => current?.Def;
        // game.ts RUNWAY_SPAWN_INSET_M and AIRFIELD_SURFACE_EPS_M.
        private const double RunwaySpawnInsetM = 120;
        private const double AirfieldSurfaceEpsM = 1.5;
        /// <summary>game.ts SURFACE_PAD_FEATHER_M.</summary>
        private const double SurfacePadFeatherM = 15;
        /// <summary>Every runway's pavement as solid ground (game.ts addRunwayPad).</summary>
        private readonly List<Retro.Sim.SurfacePadCollider> runwayPads = new List<Retro.Sim.SurfacePadCollider>();
        /// <summary>Airfields this far from the frame origin count as the play area's.</summary>
        private const double AirfieldReachM = 150000;

        /// <summary>The last keys forwarded to the sim, newest last ("+key" down, "-key" up), for debugging input.</summary>
        public readonly Queue<string> KeyLog = new Queue<string>();

        public CombatSim Sim => sim;
        public SceneRunway StartRunway => startRunway;
        public SimAircraft Aircraft => aircraft;
        public DemHeightField HeightField => heightField;

        private void Update()
        {
            if (sim == null && !TryBoot()) return;

            ReadViewKeys();
            // However the view became Free (key, inspector, script), the camera is the free one's.
            if (flightView == FlightView.Free && view.External)
            {
                ReleaseAllKeys();
                view.ReleasePose();
            }
            if (flightModel != appliedModel)
            {
                // The Settings flight-model switch: same airframe, other model, state carried over.
                sim.SetAircraftConfig(PlayerId, config, flightModel, current.Def.CollisionMesh);
                appliedModel = flightModel;
            }
            if (catalogueTask != null && catalogueTask.IsCompleted)
            {
                // The packs, read off the main thread at boot: the F-22 flies meanwhile.
                if (catalogueTask.IsFaulted) Debug.LogException(catalogueTask.Exception);
                else catalogue = catalogueTask.Result;
                catalogueTask = null;
            }
            if (aircraftId != current.Def.Id && catalogueTask == null) SwapAircraft();
            if (flightView != FlightView.Free)
            {
                ForwardKeys();
                ForwardGamepad();
            }

            // combatSimClient.tick: a long stall becomes one 50 ms step; steps are at most 1/30 s.
            double delta = Time.deltaTime;
            if (delta > 0.1) delta = 0.05;
            // advanceCarrier then syncCarrierSystems, before the sim steps.
            carrier.Advance(delta);
            carrier.Sync(sim);
            while (delta > 1e-6)
            {
                double step = Math.Min(delta, 1.0 / 30);
                sim.Step(step);
                delta -= step;
            }

            Vec3d pos = aircraft.GetPosition();
            heightField.Focus(new[] { pos, pos.AddScaled(aircraft.GetVelocity(), 5) });
            PlaceCamera(Time.deltaTime);
            DrawAirframe();
        }

        private bool TryBoot()
        {
            if (terrain == null || view == null || terrain.Session == null) return false;
            if (heightField == null)
            {
                heightField = terrain.CreateHeightField();
                if (heightField == null) return false;
            }
            if (carrier == null) BootWorld();
            // game.ts awaits kuz.glb before setupCombat: the deck goes to the sim with the world.
            if (!carrier.Settled) return false;

            sim = new CombatSim(heightField);
            var world = new SerializedWorld
            {
                SurfacePads = runwayPads,
                CarrierMeshes = new List<SerializedCarrierMesh>(),
                ArrestorCables = new List<SerializedArrestorCables> { Carrier.Serialize(carrier.CableField()) },
            };
            if (carrier.Deck != null)
            {
                world.CarrierMeshes.Add(new SerializedCarrierMesh
                {
                    OriginX = carrier.Deck.OriginX, OriginY = carrier.Deck.OriginY, OriginZ = carrier.Deck.OriginZ,
                    Triangles = carrier.Deck.Triangles, Aabb = carrier.Deck.Aabb,
                });
            }
            foreach (SceneRunway r in runways)
            {
                world.Runways.Add(new SerializedRunway
                {
                    Center = new[] { r.Center.X, r.Center.Y, r.Center.Z },
                    Heading = r.Heading, HalfLength = r.HalfLength, HalfWidth = r.HalfWidth,
                });
            }
            sim.SetWorld(world);
            sim.SetKeyboardLayout(keyboardLayout);
            SimAircraftSpawn spawn = MakeSpawn();
            sim.AddAircraft(new SimAircraftDesc
            {
                Id = PlayerId,
                Faction = Faction.PLAYER,
                Control = SimControlMode.External,
                Model = flightModel,
                AircraftConfig = config,
                PilotOptions = new AiPilotOptions { CruiseAltitude = 3000, CruiseSpeed = 220, HardDeck = 150 },
                // game.ts PLAYER_HIT_RADIUS_M and PLAYER_GUN.
                HitRadius = 10,
                MaxHealth = 100,
                Gun = new SimGunConfig
                {
                    MuzzleVelocity = 1000, RoundsPerSecond = 20, Damage = 8, Ammo = 2400,
                    MuzzleOffset = new double[] { 0, 0, 9 }, Spread = 0.003,
                },
                Collision = current.Def.CollisionMesh,
                Spawn = spawn,
                Enabled = true,
            });
            aircraft = sim.GetAircraft(PlayerId);
            appliedModel = flightModel;
            cockpitCamera = new CockpitFrontCameraUpdater(this, pose);
            chaseBack = new ExteriorFrontBehindCameraUpdater(this, pose, ExteriorViewHeading.Back);
            chaseFront = new ExteriorFrontBehindCameraUpdater(this, pose, ExteriorViewHeading.Front);
            crashedCamera = new CrashedCameraUpdater(this, pose);
            carrierCamera = new CarrierOverSternCameraUpdater(this, pose, carrier);
            airframeView.Load(current.Def, current.Files);
            airframeView.Snap(aircraft);
            tailhook.Configure(current.Def);
            carrierFx = new CarrierFx(carrier, GroundAt);
            // setupCombat: the opponent and the wingman, parked until the flight begins.
            combat = new Combat(sim, PlayerId, current.Def, current.Files, config, flightModel, aircraft.GetPosition(), 0);
            aiChase = new AiExteriorCameraUpdater(this, pose, new SimChaseTarget(sim, Combat.OpponentId(0)), aiChaseHeading);
            tracers = new TracerRenderer();
            combat.Begin(spawnMode, GroundAt);
            Debug.Log($"Retro flight: {flightModel}, {runways.Count} runways near, start {spawnMode} "
                + (startRunway != null ? $"{startRunway.Icao} {startRunway.Name} {startRunway.Ref}" : $"at {spawnLat}, {spawnLon}")
                + $"; ground tiles fine {heightField.FineResident}, coarse {heightField.CoarseResident}");
            return true;
        }

        /// <summary>
        /// The world before the sim: the aircraft catalogue, the airfields near the origin
        /// and their runway pads, the start runway, and the carrier berthed near it.
        /// </summary>
        private void BootWorld()
        {
            string assetsDir = System.IO.Path.GetDirectoryName(terrain.Root);
            catalogue = new List<AircraftCatalogue.Entry> { new AircraftCatalogue.Entry { Def = AircraftDefs.F22(), Files = new DirectoryFiles(assetsDir) } };
            catalogueTask = System.Threading.Tasks.Task.Run(() => AircraftCatalogue.Load(assetsDir));
            current = catalogue[0];
            // The spawn menu's pick, kept between sessions like the web game's setting.
            string saved = PlayerPrefs.GetString(AircraftPref, "");
            if (aircraftId == "f22" && saved.Length > 0) aircraftId = saved;
            config = AircraftDefs.FlightConfigWithArrestorHook(current.Def);
            string airfieldsPath = System.IO.Path.Combine(terrain.Root, "airfields.json");
            List<Airfield> airfields = AirfieldsJson.Near(
                System.IO.File.Exists(airfieldsPath) ? AirfieldsJson.Parse(System.IO.File.ReadAllText(airfieldsPath)).Items : new List<Airfield>(),
                heightField.Basis, AirfieldReachM);
            runways = ActiveAirfield.SceneRunwaysOf(airfields, heightField.Basis, AirfieldSurfaceEpsM);
            startRunway = ActiveAirfield.PickStartRunway(runways, preferIcao);
            // The ground is the DEM with the airfield pads through the height field; the
            // runways go in for the AI pilots, as serializeSceneWorld sends them.
            foreach (SceneRunway r in runways)
            {
                // The gear rests on the pavement that is drawn (AIRFIELD_SURFACE_EPS_M over the
                // pad-flattened DEM), from the same three sampled points the pavement uses.
                runwayPads.Add(new Retro.Sim.SurfacePadCollider
                {
                    CenterX = r.Center.X, CenterZ = r.Center.Z, Heading = r.Heading,
                    HalfLength = r.HalfLength, HalfWidth = r.HalfWidth,
                    SurfaceY = r.Center.Y, BaseY = r.Center.Y - AirfieldSurfaceEpsM,
                    Feather = SurfacePadFeatherM, Slope = r.Slope,
                });
            }
            carrier = new Carrier(heightField, startRunway,
                (x, z) => Retro.Sim.SurfacePads.SampleSurfacePadYMax(x, z, runwayPads) != double.NegativeInfinity,
                new DirectoryFiles(assetsDir));
        }

        /// <summary>PlayerPrefs key of the selected aircraft id.</summary>
        public const string AircraftPref = "retro.aircraft";

        private AircraftCatalogue.Entry Pick(string id)
        {
            foreach (AircraftCatalogue.Entry e in catalogue)
            {
                if (e.Def.Id == id || (e.Def.PackId != null && e.Def.PackId == id)) return e;
            }
            Debug.LogWarning($"Retro flight: no aircraft '{id}', flying the F-22");
            return catalogue[0];
        }

        /// <summary>
        /// game.ts applySelectedAircraft: another airframe, same flight state; its
        /// hook, collision mesh and cockpit go to the sim, its model replaces this one.
        /// </summary>
        private void SwapAircraft()
        {
            AircraftCatalogue.Entry next = Pick(aircraftId);
            aircraftId = next.Def.Id;
            if (next == current) return;
            current = next;
            config = AircraftDefs.FlightConfigWithArrestorHook(current.Def);
            sim.SetAircraftConfig(PlayerId, config, flightModel, current.Def.CollisionMesh);
            airframeView.Load(current.Def, current.Files);
            tailhook.Configure(current.Def);
            combat.SetAircraft(current.Def, current.Files, config, flightModel);
            PlayerPrefs.SetString(AircraftPref, current.Def.Id);
            Debug.Log($"Retro flight: now flying {current.Def.Name}");
        }

        // game.ts spawn heights and states.
        private const double LandApproachFinalM = 4500;
        private static readonly double IlsGlideslopeTan = Math.Tan(3.0 * Math.PI / 180);
        private const double HighAltitudeM = 10000;
        private const double SpaceAltitudeM = 100000;
        private const double CloseWingAltitudeAglM = 1500;
        private const double ApproachThrottle = 0.38, SpaceThrottle = 1, CloseWingThrottle = 0.75;

        private SimAircraftSpawn MakeSpawn()
        {
            SpawnMode mode = spawnMode;
            if (mode == SpawnMode.Carrier) return carrier.ApproachSpawn(Combat.ApproachSpeedMps);
            if (mode == SpawnMode.CarrierTakeoff)
            {
                double gearY = current.Def.Flight != null
                    ? Fm2AircraftConfig.GroundRestHeight(current.Def.Flight)
                    : SimConstants.PlaneDistanceToGround;
                return carrier.TakeoffSpawn(gearY, GroundAt);
            }
            if (mode == SpawnMode.Location || startRunway == null) return AirborneSpawn();
            SceneRunway r = startRunway;
            Vec3d fwd = ActiveAirfield.HeadingForward(r.Heading);
            switch (mode)
            {
                case SpawnMode.Runway:
                    return RunwaySpawn(r);
                case SpawnMode.HighAlt:
                    return OverBase(r, HighAltitudeM, SpaceThrottle);
                case SpawnMode.Space:
                    return OverBase(r, SpaceAltitudeM, SpaceThrottle);
                case SpawnMode.CloseWing:
                    return OverBase(r, CloseWingAltitudeAglM, CloseWingThrottle);
                default:
                {
                    // Approach and head-on: a short final on the runway axis, on the glideslope.
                    Vec3d p = r.Center - fwd * LandApproachFinalM;
                    p.Y = GroundAt(p.X, p.Z, true) + LandApproachFinalM * IlsGlideslopeTan;
                    return Airborne(p, r.Heading, ApproachThrottle);
                }
            }
        }

        /// <summary>Overhead the base runway centre, the given height above its ground.</summary>
        private SimAircraftSpawn OverBase(SceneRunway r, double aglM, double throttle)
        {
            Vec3d p = r.Center;
            p.Y = GroundAt(p.X, p.Z, true) + aglM;
            return Airborne(p, r.Heading, throttle);
        }

        /// <summary>approachSpawnState: level, down the runway heading at approach speed.</summary>
        private static SimAircraftSpawn Airborne(Vec3d p, double heading, double throttle)
        {
            Quatd q = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), heading);
            Vec3d v = ActiveAirfield.HeadingForward(heading) * Combat.ApproachSpeedMps;
            return new SimAircraftSpawn
            {
                Position = new[] { p.X, p.Y, p.Z },
                Quaternion = new[] { q.X, q.Y, q.Z, q.W },
                Velocity = new[] { v.X, v.Y, v.Z },
                Landed = false,
                Throttle = throttle,
                Airborne = true,
            };
        }

        /// <summary>groundHeightAt: the DEM, or a runway pavement over it; `settle` waits for the fine DEM there first.</summary>
        private double GroundAt(double x, double z, bool settle)
        {
            if (settle)
            {
                heightField.Focus(new[] { new Vec3d(x, 0, z) });
                heightField.WaitIdle(TimeSpan.FromSeconds(5));
            }
            return Math.Max(Math.Max(heightField.HeightAtWorld(x, z), Retro.Sim.SurfacePads.SampleSurfacePadYMax(x, z, runwayPads)),
                carrier.DeckYAt(x, z));
        }

        private double GroundAt(double x, double z) => GroundAt(x, z, false);

        /// <summary>game.ts beginFlight: the player placed for the mode, then the opponent and the wingman.</summary>
        public void BeginFlight(SpawnMode mode)
        {
            if (sim == null) return;
            spawnMode = mode;
            Respawn();
            combat.Begin(mode, GroundAt);
        }

        /// <summary>
        /// game.ts runwaySpawnPosition: on the axis, RUNWAY_SPAWN_INSET_M in from the
        /// threshold with the roll-out ahead, wheels on the ground, engine idle.
        /// </summary>
        private SimAircraftSpawn RunwaySpawn(SceneRunway r)
        {
            Vec3d fwd = ActiveAirfield.HeadingForward(r.Heading);
            Vec3d p = r.Center - fwd * (r.HalfLength - RunwaySpawnInsetM);
            heightField.Focus(new[] { p });
            heightField.WaitIdle(TimeSpan.FromSeconds(5));
            // game.ts runwaySpawnPosition: the def's own gear rest height, else PLANE_DISTANCE_TO_GROUND.
            double gearY = current.Def.Flight != null
                ? Fm2AircraftConfig.GroundRestHeight(current.Def.Flight)
                : SimConstants.PlaneDistanceToGround;
            // groundHeightAt: the DEM, or the runway pavement over it.
            double ground = Math.Max(heightField.HeightAtWorld(p.X, p.Z), Retro.Sim.SurfacePads.SampleSurfacePadYMax(p.X, p.Z, runwayPads));
            p.Y = ground + gearY;
            // A scene heading of 0 faces +Z, which is the body's nose.
            Quatd q = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), r.Heading);
            return new SimAircraftSpawn
            {
                Position = new[] { p.X, p.Y, p.Z },
                Quaternion = new[] { q.X, q.Y, q.Z, q.W },
                Velocity = new double[] { 0, 0, 0 },
                Landed = true,
                Throttle = 0,
                Airborne = false,
            };
        }

        /// <summary>Airborne at the spawn point, level, at speed; at least 300 m over the ground.</summary>
        private SimAircraftSpawn AirborneSpawn()
        {
            Vec3d p = Geodesy.GeodeticToWorld(heightField.Basis, spawnLat, spawnLon, spawnAltitude);
            heightField.Focus(new[] { p });
            heightField.WaitIdle(TimeSpan.FromSeconds(5));
            double ground = heightField.HeightAtWorld(p.X, p.Z);
            if (p.Y < ground + 300) p.Y = ground + 300;
            // Body +Z is the nose: a turn of (180 - heading) about +Y points it at the heading.
            Quatd q = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), Math.PI - spawnHeadingDeg * Math.PI / 180);
            Vec3d v = new Vec3d(0, 0, 1).Rotate(q) * spawnSpeed;
            return new SimAircraftSpawn
            {
                Position = new[] { p.X, p.Y, p.Z },
                Quaternion = new[] { q.X, q.Y, q.Z, q.W },
                Velocity = new[] { v.X, v.Y, v.Z },
                Landed = false,
                Throttle = spawnThrottle,
                Airborne = true,
            };
        }

        public void Respawn()
        {
            if (sim == null) return;
            SimAircraftSpawn spawn = MakeSpawn();
            ReleaseAllKeys();
            // A fresh start: the arrows layout's latched stick goes back to centre.
            sim.InputBlur(PlayerId);
            sim.Respawn(PlayerId, spawn);
            sim.GetPlayerInput(PlayerId)?.SyncThrottle(spawn.Throttle);
            sim.SyncEffectiveThrottle(PlayerId, spawn.Throttle);
            airframeView.Snap(aircraft);
            tailhook.Snap(aircraft);
        }

        // --- Camera --------------------------------------------------------------------

        private void PlaceCamera(double delta)
        {
            if (flightView == FlightView.Free) return;
            pose.Up = new Vec3d(0, 1, 0);
            // game.ts PlayerViewState.CRASHED: every view gives way to the orbit round the wreck.
            if (aircraft.IsCrashed())
            {
                crashedCamera.Update(delta);
                view.SetPose(pose.Position, pose.Quaternion, fovDeg);
                return;
            }
            switch (flightView)
            {
                case FlightView.Cockpit: cockpitCamera.Update(delta); break;
                case FlightView.ChaseBack: chaseBack.Update(delta); break;
                case FlightView.ChaseFront: chaseFront.Update(delta); break;
                case FlightView.CarrierStern: carrierCamera.Update(delta); break;
                case FlightView.AiChase:
                    if (combat.Opponent != null && combat.Opponent.Enabled) aiChase.Update(delta);
                    else chaseBack.Update(delta);
                    break;
            }
            view.SetPose(pose.Position, pose.Quaternion, fovDeg);
        }

        public Vec3d GetDisplayPosition() => aircraft.GetPosition();
        public Quatd GetDisplayQuaternion() => aircraft.GetQuaternion();
        public Vec3d GetCockpitOffset() => current.Def.CockpitOffset;
        public Vec3d GetDisplayWorldDirection() => SceneAxes.Forward.Rotate(aircraft.GetQuaternion());
        public Vec3d GetDisplayWorldUp() => SceneAxes.Up.Rotate(aircraft.GetQuaternion());
        public Vec3d GetDisplayWorldRight() => SceneAxes.Right.Rotate(aircraft.GetQuaternion());
        public WeaponsTarget WeaponsTarget => combat?.Target();

        public bool GetWreckFocus(out Vec3d focus)
        {
            focus = default;
            return false;
        }

        // --- Input ---------------------------------------------------------------------

        private void ReadViewKeys()
        {
#if RETRO_INPUT_SYSTEM
            Keyboard k = Keyboard.current;
            if (k == null) return;
            FlightView before = flightView;
            if (k.f1Key.wasPressedThisFrame)
            {
                // A second F1 in the cockpit padlocks the current target.
                if (flightView == FlightView.Cockpit && WeaponsTarget != null) cockpitCamera.SetPadlock(!cockpitCamera.IsPadlock());
                flightView = FlightView.Cockpit;
            }
            if (k.f2Key.wasPressedThisFrame) flightView = flightView == FlightView.ChaseBack ? FlightView.ChaseFront : FlightView.ChaseBack;
            if (k.f3Key.wasPressedThisFrame) flightView = FlightView.CarrierStern;
            if (k.f6Key.wasPressedThisFrame)
            {
                // aiExteriorCameraUpdater.ts: F6 again swaps behind and ahead of the opponent.
                if (flightView == FlightView.AiChase)
                {
                    aiChaseHeading = aiChaseHeading == ExteriorViewHeading.Back ? ExteriorViewHeading.Front : ExteriorViewHeading.Back;
                    aiChase.SetHeading(aiChaseHeading);
                }
                flightView = FlightView.AiChase;
            }
            if (k.ctrlKey.isPressed)
            {
                for (int d = 1; d <= 9; d++)
                {
                    if (d == 8) continue; // the barricade start is gone
                    if (k[Key.Digit1 + (d - 1)].wasPressedThisFrame) BeginFlight((SpawnMode)d);
                }
            }
            if (k.f10Key.wasPressedThisFrame) flightView = flightView == FlightView.Free ? FlightView.ChaseBack : FlightView.Free;
            if (k.rKey.wasPressedThisFrame && flightView != FlightView.Free) BeginFlight(spawnMode);
            if (before != flightView && flightView == FlightView.Free)
            {
                ReleaseAllKeys();
                view.ReleasePose();
            }
#endif
        }

        /// <summary>Key presses and releases to the sim as KeyboardEvent.key (keyboardControlDevice.ts normalizeControlKey).</summary>
        private void ForwardKeys()
        {
#if RETRO_INPUT_SYSTEM
            Keyboard k = Keyboard.current;
            if (k == null) return;
            foreach (KeyControl key in k.allKeys)
            {
                if (key == null) continue;
                int code = (int)key.keyCode;
                if (key.wasPressedThisFrame && !heldKeys.ContainsKey(code))
                {
                    string js = JsKey(key);
                    if (js == null) continue;
                    heldKeys[code] = js;
                    LogKey("+" + js);
                    sim.KeyDown(PlayerId, js, false);
                }
                else if (key.wasReleasedThisFrame && heldKeys.TryGetValue(code, out string js))
                {
                    heldKeys.Remove(code);
                    LogKey("-" + js);
                    sim.KeyUp(PlayerId, js);
                }
            }
#endif
        }

        private void LogKey(string entry)
        {
            KeyLog.Enqueue($"{Time.frameCount}:{entry}");
            while (KeyLog.Count > 16) KeyLog.Dequeue();
        }

        private void ReleaseAllKeys()
        {
            foreach (string js in heldKeys.Values) sim.KeyUp(PlayerId, js);
            heldKeys.Clear();
        }

#if RETRO_INPUT_SYSTEM
        /// <summary>The browser's lower-cased KeyboardEvent.key for a key, or null for keys the sim never sees.</summary>
        private static string JsKey(KeyControl key)
        {
            switch (key.keyCode)
            {
                case Key.UpArrow: return "arrowup";
                case Key.DownArrow: return "arrowdown";
                case Key.LeftArrow: return "arrowleft";
                case Key.RightArrow: return "arrowright";
                case Key.Space: return " ";
                case Key.NumpadPlus: return "numpadadd";
                case Key.NumpadMinus: return "numpadsubtract";
                case Key.Enter: return "enter";
                case Key.Escape: return "escape";
                case Key.Tab: return "tab";
                case Key.LeftShift: case Key.RightShift: return "shift";
                case Key.LeftCtrl: case Key.RightCtrl: return "control";
                case Key.LeftAlt: case Key.RightAlt: return "alt";
                case Key.R: return null; // respawn, handled here
            }
            if (key.keyCode >= Key.F1 && key.keyCode <= Key.F12) return null;
            // The layout's character (displayName follows the OS keyboard layout, as event.key does).
            string name = key.displayName;
            return !string.IsNullOrEmpty(name) && name.Length == 1 ? name.ToLowerInvariant() : null;
        }
#endif

        /// <summary>
        /// joystickControlDevice.ts: axes go to the sim only once a pad has been
        /// touched, so an idle pad does not pin the throttle against the keys.
        /// Sticks are roll/pitch (left) and yaw (right); the triggers move the
        /// throttle, which a spring-centred pad has no axis for.
        /// </summary>
        private void ForwardGamepad()
        {
#if RETRO_INPUT_SYSTEM
            Gamepad g = Gamepad.current;
            if (g == null)
            {
                if (gamepadActive) sim.GamepadAxes(PlayerId, 0, 0, 0, 0, false);
                gamepadActive = false;
                return;
            }
            Vector2 left = g.leftStick.ReadValue();
            Vector2 right = g.rightStick.ReadValue();
            float up = g.rightTrigger.ReadValue(), down = g.leftTrigger.ReadValue();
            if (!gamepadActive)
            {
                if (left.magnitude < 0.3f && Mathf.Abs(right.x) < 0.3f && up < 0.3f && down < 0.3f) return;
                gamepadActive = true;
                gamepadThrottle = aircraft.GetThrottle();
            }
            gamepadThrottle = Math.Max(0, Math.Min(1, gamepadThrottle + (up - down) * 0.5 * Time.deltaTime));
            // Browser pads report the stick's y positive when pulled back: that is nose up.
            sim.GamepadAxes(PlayerId, -left.y, left.x, right.x, gamepadThrottle, true);
#endif
        }

        // --- Airframe ------------------------------------------------------------------

        /// <summary>The airframe, plumes and trails; the airframe itself is hidden from the cockpit.</summary>
        private void DrawAirframe()
        {
            bool visible = !(flightView == FlightView.Cockpit && !aircraft.IsCrashed());
            carrier.Draw(view.ScenePosition);
            airframeView.Draw(aircraft, view.ScenePosition, Time.deltaTime, visible, wingSweepMode);
            if (visible) tailhook.Draw(aircraft, carrier.Pose, view.ScenePosition, Time.deltaTime);
            carrierFx.Draw(aircraft, tailhook.HingeBody, view.ScenePosition, Time.deltaTime);
            combat.Draw(view.ScenePosition, Time.deltaTime);
            tracers.Draw(sim, view.ScenePosition, view.UnityCamera);
        }

        // --- HUD (debug readout until the HUD is ported) --------------------------------

        private GUIStyle hudStyle;

        private void OnGUI()
        {
            if (!showHud || aircraft == null) return;
            hudStyle ??= new GUIStyle(GUI.skin.label) { fontSize = 16, normal = { textColor = new Color(0.4f, 1f, 0.4f) } };
            Vec3d p = aircraft.GetPosition();
            double alt = heightField.GeodeticAltitudeAtWorld(p.X, p.Y, p.Z);
            double agl = p.Y - heightField.HeightAtWorld(p.X, p.Z);
            Vec3d f = GetDisplayWorldDirection();
            double heading = (Math.Atan2(f.X, -f.Z) * 180 / Math.PI + 360) % 360;
            string text =
                $"IAS {aircraft.GetAirspeed() * 1.94384:0} kt   ALT {alt * 3.28084:0} ft   AGL {agl:0} m   HDG {heading:000}\n" +
                $"THR {aircraft.GetThrottle() * 100:0}%   G {aircraft.GetLoadFactorG():0.0}   AOA {aircraft.GetAngleOfAttack() * 180 / Math.PI:0.0}\n" +
                $"{(aircraft.IsLanded() ? "LANDED  " : "")}{(aircraft.IsCrashed() ? "CRASHED (R to respawn)  " : "")}{(aircraft.Control == SimControlMode.Ai ? "AUTOPILOT  " : "")}" +
                $"view {flightView}   ground tiles {heightField.FineResident}+{heightField.FineInFlight} ({heightField.TierAtWorld(p.X, p.Z)})";
            GUI.Label(new Rect(12, 8, 1200, 80), text, hudStyle);
        }

        private void OnDisable()
        {
            if (sim != null) ReleaseAllKeys();
        }

        private void OnDestroy()
        {
            airframeView.Destroy();
            combat?.Destroy();
            carrier?.Destroy();
            carrierFx?.Dispose();
            tailhook.Dispose();
            tracers?.Dispose();
        }
    }
}
