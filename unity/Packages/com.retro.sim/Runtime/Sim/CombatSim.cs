using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// The authoritative, headless combat simulation (port of physics/sim/combatSim.ts).
    /// Owns every aircraft, their pilots, guns and the projectile pool. Pilots run
    /// once per step reading the previous step's positions so all aircraft advance
    /// from a consistent world state. The worker/snapshot plumbing of the TS is not
    /// ported: the hits of the last step are <see cref="Hits"/>.
    /// </summary>
    public sealed class CombatSim : IProjectileSink
    {
        /// <summary>Seconds a tracer lives before self-destructing.</summary>
        private const double ProjectileLifespan = 2.5;
        /// <summary>Max ship-relative groundspeed (m/s) before kinematic deck park engages.</summary>
        private const double CarrierParkRelSpeedMps = 2.0;
        private const double ProjectileGravity = 9.80665;
        private const int ProjectilePoolSize = 480;
        /// <summary>Allow this much mesh-terrain overlap (m) when gear is down (spring travel).</summary>
        private const double GearTerrainMarginM = 0.8;
        /// <summary>Belly/wingtip scrape margin when gear is up (m).</summary>
        private const double BellyTerrainMarginM = 0.05;
        /// <summary>Impact speed into a solid that still destroys the airframe (m/s).</summary>
        private const double SolidCrashImpactMps = 55;
        /// <summary>Penetration past the margin that forces a wreck (m).</summary>
        private const double SolidCrashPenetrationM = 3.5;

        /// <summary>Seconds between full re-scans for aircraft engaging a whole faction.</summary>
        private const double TargetScanInterval = 0.5;
        /// <summary>A challenger must beat the incumbent's score by this factor to steal the fight.</summary>
        private const double TargetSwitchMargin = 0.75;
        /// <summary>How hard a target off the nose is penalised, as a fraction of its range at 180 degrees off.</summary>
        private const double TargetAtaWeight = 1.0;
        /// <summary>Minimum inward speed (m/s) before scrape FX / damage.</summary>
        private const double SolidScrapeFxMps = 6;
        /// <summary>Health lost per (m/s) of inward impact on a non-fatal scrape.</summary>
        private const double SolidScrapeDamagePerMps = 0.35;
        /// <summary>Min seconds between scrape FX bursts per aircraft.</summary>
        private const double SolidScrapeFxCooldownS = 0.1;
        /// <summary>Two aircraft meeting: no damage below this relative speed, both destroyed at the fatal one.</summary>
        private const double MidairSoftMps = 5;
        private const double MidairFatalMps = 70;
        /// <summary>How much of their closing speed they bounce apart with.</summary>
        private const double MidairRestitution = 0.25;
        /// <summary>Seconds before the same two aircraft can damage each other again.</summary>
        private const double MidairCooldownS = 1.0;
        /// <summary>The crash-scale severity a survivable landing is reported as: from none to destroyed.</summary>
        private const double DamageSeverityMin = 0.2;
        private const double DamageSeverityMax = 1.1;
        /// <summary>The share of a contact point's swing speed that counts toward how hard a belly landing was.</summary>
        private const double BellySwingShare = 0.3;
        /// <summary>A belly rubbing along the ground faster than this (m/s) throws sparks, at up to this many points.</summary>
        private const double SlideFxMinMps = 3;
        private const int SlideFxPoints = 3;
        private const double SlideFxIntervalS = 0.07;
        /// <summary>A hull point within this distance (m) of the ground takes part in the rigid contact response.</summary>
        private const double ContactActiveSlopM = 0.12;
        /// <summary>Passes over the contact points per step.</summary>
        private const int RigidContactPasses = 4;
        /// <summary>Sliding friction coefficient of the belly on the ground.</summary>
        private const double RigidContactFriction = 0.5;
        /// <summary>How strongly a contact's support tips the aircraft over the contact point.</summary>
        private const double SupportTorqueFactor = 3;
        /// <summary>Deceleration (m/s^2) applied on the frames an aircraft sliding on its belly is in contact.</summary>
        private const double BellyFrictionDecelMps2 = 12;
        /// <summary>Extra separation after resolving penetration (m).</summary>
        private const double SolidSlopM = 0.05;
        /// <summary>Contact-point drag rate (1/s) while the collider scrapes a solid.</summary>
        private const double SolidContactDragPerS = 0.45;
        /// <summary>Fraction of aircraft mass used when converting contact drag to an impulse.</summary>
        private const double SolidContactDragMassFrac = 0.12;
        /// <summary>Cap on per-step contact-velocity bleed.</summary>
        private const double SolidContactDragMaxFrac = 0.01;

        private static SimControlInputs NeutralInputs() => new SimControlInputs
        {
            Pitch = 0,
            Roll = 0,
            Yaw = 0,
            Throttle = 0,
            LandingGearDeployed = true,
            FlapsExtended = true,
            AirbrakesExtended = false,
            HookDeployed = false,
            WheelBrakesApplied = false,
            PitchLimiterMode = FcsPitchLimiter.Soft,
            LimitersEnabled = true,
            WantForceVectors = false,
            Firing = false,
        };

        public sealed class ProjectileSlot
        {
            public bool Active;
            public Faction Faction;
            public double Damage;
            public double Life;
            public Vec3d Pos;
            public Vec3d PrevPos;
            public Vec3d Vel;
        }

        private SceneWorldQuery world;
        /// <summary>Colliders that arrived before the world did; applied when it does.</summary>
        private List<SerializedStaticColliders> pendingColliders = new List<SerializedStaticColliders>();
        private List<ArrestorCableField> arrestorFields = new List<ArrestorCableField>();
        /// <summary>World velocity of the moving carrier (m/s); trap scrub is relative to this.</summary>
        private Vec3d carrierVel;
        private readonly OrderedMap<string, SimAircraft> aircraft = new OrderedMap<string, SimAircraft>();
        private readonly List<string> order = new List<string>();
        private readonly OrderedMap<string, ExternalCombatant> external = new OrderedMap<string, ExternalCombatant>();
        /// <summary>Sim-side keyboard/gamepad handlers for externally-controlled aircraft.</summary>
        private readonly OrderedMap<string, SimPlayerInput> playerInputs = new OrderedMap<string, SimPlayerInput>();
        private KeyboardControlLayoutId keyboardLayoutId = KeyboardControlLayoutId.ARROWS;
        private KeyboardPitchStickMode keyboardPitchStickMode = KeyboardPitchStickMode.LAYOUT_DEFAULT;

        private readonly List<ProjectileSlot> projectiles = new List<ProjectileSlot>();
        private readonly List<SimHitEvent> hits = new List<SimHitEvent>();

        private double targetScanTimer;

        /// <summary>The DEM, mirrored from the render side.</summary>
        private readonly ISimHeightField heightField;

        /// <summary>Scene Y to true altitude, handed to every flight model this sim owns.</summary>
        private readonly Func<double, double, double, double> altitudeAt;

        /// <summary>True between a <see cref="Rebase"/> and the world that must follow it.</summary>
        private bool pilotsStale;

        private readonly Dictionary<string, double> pairCooldown = new Dictionary<string, double>();
        private readonly List<string> pairCooldownOrder = new List<string>();

        private readonly Vec3d[] slideAt = new Vec3d[3];
        private readonly List<TerrainContactSample> contactSamples = new List<TerrainContactSample>();
        private int contactSampleCount;

        public CombatSim(ISimHeightField heightField = null)
        {
            this.heightField = heightField ?? new UnconfiguredHeightField();
            altitudeAt = (x, y, z) => this.heightField.GeodeticAltitudeAtWorld(x, y, z);
            for (int i = 0; i < ProjectilePoolSize; i++)
            {
                projectiles.Add(new ProjectileSlot { Active = false, Faction = Faction.PLAYER });
            }
        }

        // --- Inspection (what the TS reads through the snapshot codec) ---------------

        /// <summary>Every aircraft, in insertion order.</summary>
        public IReadOnlyList<SimAircraft> Aircraft => aircraft.Values;

        public SimAircraft GetAircraft(string id) => aircraft.Get(id);

        /// <summary>The hits of the last step (a copy, as encodeSnapshot hands them out).</summary>
        public List<SimHitEvent> Hits => new List<SimHitEvent>(hits);

        /// <summary>Hits of the last step, without copying them.</summary>
        public int HitCount => hits.Count;

        public IReadOnlyList<ProjectileSlot> Projectiles => projectiles;

        public int ActiveProjectileCount
        {
            get
            {
                int n = 0;
                foreach (ProjectileSlot p in projectiles) if (p.Active) n++;
                return n;
            }
        }

        /// <summary>Snapshot ids: aircraft in the order they were first added.</summary>
        public List<string> SnapshotIds()
        {
            var ids = new List<string>();
            foreach (string id in order)
            {
                if (aircraft.Has(id)) ids.Add(id);
            }
            return ids;
        }

        public SceneWorldQuery World => world;

        public void SetWorld(SerializedWorld serialized)
        {
            world = SerializedWorlds.DeserializeWorldQuery(serialized, (x, z) => heightField.HeightAtWorld(x, z));
            arrestorFields = SerializedWorlds.DeserializeArrestorCables(serialized);
            foreach (SerializedStaticColliders colliders in pendingColliders)
            {
                SerializedWorlds.ApplyStaticColliders(world, colliders);
            }
            pendingColliders = new List<SerializedStaticColliders>();
            // Any aircraft added before the world arrived can now get its pilot + terrain.
            // After a re-base every pilot is rebuilt.
            bool rebuild = pilotsStale;
            pilotsStale = false;
            foreach (SimAircraft a in aircraft.Values)
            {
                a.BindWorld(world);
                a.BuildPilot(null, world, rebuild && a.Pilot != null);
                if (rebuild && a.Pilot != null)
                {
                    RestorePilotTargets(a);
                }
            }
        }

        /// <summary>Carry every aircraft, round and mirror into a re-based scene frame.</summary>
        public void Rebase(FrameShift shift)
        {
            foreach (SimAircraft a in aircraft.Values)
            {
                a.Model.Rebase(shift);
                a.PrevPos = shift.Point(a.PrevPos);
                a.PrevHook = shift.Point(a.PrevHook);
                a.HookNow = shift.Point(a.HookNow);
                a.CarrierParkLocalValid = false;
                a.CrashedCarrierLocalValid = false;
            }
            foreach (ExternalCombatant ext in external.Values)
            {
                ext.Rebase(shift);
            }
            foreach (ProjectileSlot p in projectiles)
            {
                p.Pos = shift.Point(p.Pos);
                p.PrevPos = shift.Point(p.PrevPos);
                p.Vel = shift.Vector(p.Vel);
            }
            foreach (SimHitEvent h in hits)
            {
                Vec3d v = shift.Point(new Vec3d(h.Position[0], h.Position[1], h.Position[2]));
                h.Position = new[] { v.X, v.Y, v.Z };
                if (h.Velocity != null)
                {
                    v = shift.Vector(new Vec3d(h.Velocity[0], h.Velocity[1], h.Velocity[2]));
                    h.Velocity = new[] { v.X, v.Y, v.Z };
                }
            }
            carrierVel = shift.Vector(carrierVel);
            pilotsStale = true;
        }

        private void RestorePilotTargets(SimAircraft a)
        {
            string target = a.AutoTargetId ?? a.ExplicitTargetId;
            if (target != null)
            {
                a.Pilot?.SetTarget(ResolveCombatant(target));
            }
            if (a.FormationLeadId != null)
            {
                a.Pilot?.SetFormationLead(ResolveCombatant(a.FormationLeadId));
            }
        }

        /// <summary>More static ground for the world already set (buildings streamed in mid-flight).</summary>
        public void AddStaticColliders(SerializedStaticColliders colliders)
        {
            if (world == null)
            {
                pendingColliders.Add(colliders);
                return;
            }
            SerializedWorlds.ApplyStaticColliders(world, colliders);
        }

        /// <summary>Barricade functionality has been removed; kept as a no-op like the TS.</summary>
        public void SetBarricades(object barricades)
        {
        }

        public void SetArrestorCables(IReadOnlyList<SerializedArrestorCables> cables)
        {
            arrestorFields = SerializedWorlds.DeserializeArrestorCables(cables);
        }

        /// <summary>Update carrier mesh origins for ground contact when the ship moves.</summary>
        public void SetCarrierMeshOrigins(IReadOnlyList<Vec3d> origins)
        {
            world?.SetCarrierMeshOrigins(origins);
        }

        /// <summary>World-frame carrier velocity for ship-relative arrestor scrub.</summary>
        public void SetCarrierVelocity(double vx, double vy, double vz)
        {
            carrierVel = new Vec3d(vx, vy, vz);
        }

        public void AddAircraft(SimAircraftDesc desc)
        {
            if (aircraft.Has(desc.Id))
            {
                aircraft.Delete(desc.Id);
            }
            else
            {
                order.Add(desc.Id);
            }
            var added = new SimAircraft(desc, world, this);
            added.Model.SetAltitudeAt(altitudeAt);
            aircraft.Set(desc.Id, added);
            if (desc.Control == SimControlMode.External)
            {
                var input = new SimPlayerInput();
                input.SetKeyboardLayout(keyboardLayoutId);
                input.SetKeyboardPitchStickMode(keyboardPitchStickMode);
                input.SyncThrottle(desc.Spawn.Throttle);
                playerInputs.Set(desc.Id, input);
            }
        }

        public void RemoveAircraft(string id)
        {
            aircraft.Delete(id);
            playerInputs.Delete(id);
            order.Remove(id);
        }

        public void SetEnabled(string id, bool enabled)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null) a.Enabled = enabled;
        }

        public void SetControlMode(string id, SimControlMode control)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null)
            {
                a.BuildPilot(null, world);
                a.Control = control;
            }
        }

        public void KeyDown(string id, string key, bool repeat)
        {
            SimAircraft a = aircraft.Get(id);
            SimPlayerInput input = playerInputs.Get(id);
            if (a == null || input == null) return;
            input.KeyDown(key, repeat, a);
        }

        public void KeyUp(string id, string key)
        {
            SimAircraft a = aircraft.Get(id);
            SimPlayerInput input = playerInputs.Get(id);
            if (a == null || input == null) return;
            input.KeyUp(key, a);
        }

        public void SetKeyboardLayout(KeyboardControlLayoutId layoutId)
        {
            keyboardLayoutId = layoutId;
            foreach (SimPlayerInput input in playerInputs.Values)
            {
                input.SetKeyboardLayout(layoutId);
            }
        }

        public void SetKeyboardPitchStickMode(KeyboardPitchStickMode mode)
        {
            keyboardPitchStickMode = mode;
            foreach (SimPlayerInput input in playerInputs.Values)
            {
                input.SetKeyboardPitchStickMode(mode);
            }
        }

        public void GamepadAxes(string id, double pitch, double roll, double yaw, double throttle, bool connected)
        {
            playerInputs.Get(id)?.SetGamepadAxes(pitch, roll, yaw, throttle, connected);
        }

        public void InputBlur(string id)
        {
            playerInputs.Get(id)?.Blur();
        }

        public void SetInputEnabled(string id, bool enabled)
        {
            playerInputs.Get(id)?.SetInputEnabled(enabled);
        }

        public void SetForceVectorsRequested(string id, bool want)
        {
            playerInputs.Get(id)?.SetForceVectorsRequested(want);
        }

        public SimPlayerInput GetPlayerInput(string id) => playerInputs.Get(id);

        public void SetTarget(string id, string targetId)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            a.BuildPilot(null, world);
            // An explicit target wins over, and cancels, faction auto-selection.
            a.TargetFaction = null;
            a.AutoTargetId = null;
            a.ExplicitTargetId = targetId;
            a.Pilot?.SetTarget(!string.IsNullOrEmpty(targetId) ? ResolveCombatant(targetId) : null);
        }

        /// <summary>
        /// Engage a whole faction rather than one named aircraft: the sim picks the
        /// best live target now and re-picks as the fight develops. Null stops it.
        /// </summary>
        public void SetTargetFaction(string id, Faction? faction)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            a.BuildPilot(null, world);
            a.AutoTargetId = null;
            a.ExplicitTargetId = null;
            a.TargetFaction = faction;
            if (faction == null) return;
            SelectTargetFor(a, true);
        }

        /// <summary>Assign the aircraft whose wing this pilot flies in the FORMATION phase.</summary>
        public void SetFormationLead(string id, string leadId)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            a.BuildPilot(null, world);
            a.FormationLeadId = leadId;
            a.Pilot?.SetFormationLead(!string.IsNullOrEmpty(leadId) ? ResolveCombatant(leadId) : null);
        }

        public void SetPhase(string id, AiFlightPhase phase)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            a.BuildPilot(null, world);
            a.Pilot?.SetPhase(phase);
        }

        /// <summary>Rebuild the in-sim pilot with new options (AI model switch applies here).</summary>
        public void SetPilotOptions(string id, AiPilotOptions options)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            a.SetPilotOptions(options, world);
        }

        public void Respawn(string id, SimAircraftSpawn spawn)
        {
            aircraft.Get(id)?.Respawn(spawn);
        }

        public void ResetAircraft(string id, Vec3d position, Quatd quaternion, Vec3d velocity, bool landed, double throttle, SimFlightModelKind model)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            RebuildIfModelChanged(a, model);
            a.ArrestorLatch = -1;
            a.ArrestorFieldIndex = -1;
            a.ArrestorSnagAlong = 0;
            a.ArrestorHeld = false;
            a.CarrierDeckSticky = false;
            a.CarrierParkLocalValid = false;
            a.HasPrevHook = false;
            a.Model.Reset();
            a.Model.Position = position;
            a.Model.Quaternion = quaternion;
            a.Model.Velocity = velocity;
            a.Model.SetLanded(landed);
            a.Model.SetThrottle(throttle);
            // Match PlayerEntity.reset: gear/flaps down, hook stowed, on every spawn/teleport.
            a.SetLandingGearDeployed(true);
            a.SetFlapsExtended(true);
            a.SetHookDeployed(false);
            a.Health = a.MaxHealth;
            a.ResetGun();
            playerInputs.Get(id)?.SyncThrottle(throttle);
        }

        public void SetAircraftConfig(string id, Fm2AircraftConfig config, SimFlightModelKind model, AircraftCollisionMesh collision = null)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            // Carry over the live rigid-body state across the model swap.
            FlightModel next = SimFlightModel.Create(model, config);
            next.SetAltitudeAt(altitudeAt);
            next.Reset();
            next.SetCrashed(a.Model.IsCrashed);
            next.SetLanded(a.Model.IsLanded);
            next.Position = a.Model.Position;
            next.Quaternion = a.Model.Quaternion;
            next.Velocity = a.Model.Velocity;
            a.Model = next;
            a.ModelKind = model;
            a.Collision = collision;
            a.SetAfterburnerFromConfig(config);
            double[] hook = config.Hook ?? ArrestorCables.DefaultArrestorHookBody;
            a.HookBody = new Vec3d(hook[0], hook[1], hook[2]);
            a.BindWorld(world);
        }

        public void SetCollision(string id, AircraftCollisionMesh collision)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null) a.Collision = collision;
        }

        private void RebuildIfModelChanged(SimAircraft a, SimFlightModelKind model)
        {
            if (a.ModelKind == model) return;
            FlightModel next = SimFlightModel.Create(model);
            next.SetAltitudeAt(altitudeAt);
            next.SetCrashed(a.Model.IsCrashed);
            next.SetLanded(a.Model.IsLanded);
            next.Position = a.Model.Position;
            next.Quaternion = a.Model.Quaternion;
            next.Velocity = a.Model.Velocity;
            a.Model = next;
            a.ModelKind = model;
            a.BindWorld(world);
        }

        public void SetPosition(string id, Vec3d position)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null) a.Model.Position = position;
        }

        public void SetQuaternion(string id, Quatd quaternion)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null) a.Model.Quaternion = quaternion;
        }

        public void SetVelocity(string id, Vec3d velocity)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null) a.Model.Velocity = velocity;
        }

        public void SyncEffectiveThrottle(string id, double throttle)
        {
            SimAircraft a = aircraft.Get(id);
            if (a == null) return;
            a.Model.SetThrottle(throttle);
            a.Model.SyncEffectiveThrottle();
        }

        public void SnapPhysicsState(string id)
        {
            aircraft.Get(id)?.Model.SnapPhysicsState();
        }

        public void SetExternalState(string id, bool enabled, Faction faction, Vec3d position, Vec3d velocity, bool alive)
        {
            if (!enabled)
            {
                external.Delete(id);
                return;
            }
            ExternalCombatant ext = external.Get(id);
            if (ext == null)
            {
                ext = new ExternalCombatant();
                external.Set(id, ext);
            }
            ext.SetState(faction, position, velocity, alive);
        }

        public void ClearExternalState(string id)
        {
            external.Delete(id);
        }

        /// <summary>
        /// Refresh auto-selected targets. A full re-scan runs every
        /// <see cref="TargetScanInterval"/>; a target that has died or gone away is
        /// replaced immediately.
        /// </summary>
        private void UpdateAutoTargets(double delta)
        {
            targetScanTimer -= delta;
            bool rescan = targetScanTimer <= 0;
            if (rescan)
            {
                targetScanTimer = TargetScanInterval;
            }
            foreach (SimAircraft a in aircraft.Values)
            {
                if (a.TargetFaction == null || !a.Enabled || a.Pilot == null) continue;
                ICombatant current = a.AutoTargetId == null ? null : ResolveCombatant(a.AutoTargetId);
                bool lost = a.AutoTargetId != null && (current == null || !current.IsAlive());
                if (rescan || lost)
                {
                    SelectTargetFor(a, false);
                }
            }
        }

        /// <summary>
        /// Pick the best live target of a.TargetFaction: nearest, penalised by how
        /// far off the nose it is, with hysteresis in favour of the fight in progress.
        /// </summary>
        private void SelectTargetFor(SimAircraft a, bool force)
        {
            Faction? faction = a.TargetFaction;
            if (faction == null) return;

            Vec3d selfPos = a.ReadPosition();
            Vec3d selfFwd = SimConstants.Forward.Rotate(a.Model.Quaternion);

            string bestId = null;
            double bestScore = double.PositiveInfinity;
            foreach (string id in CombatantIds())
            {
                if (id == a.Id) continue;
                ICombatant c = ResolveCombatant(id);
                // ResolveCombatant falls back to a disabled aircraft when nothing else stands in for it.
                if (c == null || !c.IsAlive() || c.Faction != faction.Value) continue;
                if (c is SimAircraft sa && !sa.Enabled) continue;

                Vec3d candidatePos = c.ReadPosition();
                Vec3d los = candidatePos - selfPos;
                double range = los.Length;
                if (range < 1e-3) continue;
                double ata = JsTrig.Acos(JsMath.Clamp(Vec3d.Dot(los, selfFwd) / range, -1, 1));
                double score = range * (1 + TargetAtaWeight * ata / Math.PI);
                if (id == a.AutoTargetId)
                {
                    score *= TargetSwitchMargin;
                }
                if (score < bestScore)
                {
                    bestScore = score;
                    bestId = id;
                }
            }

            if (!force && bestId == a.AutoTargetId) return;
            a.AutoTargetId = bestId;
            a.Pilot?.SetTarget(!string.IsNullOrEmpty(bestId) ? ResolveCombatant(bestId) : null);
        }

        /// <summary>Every id that can resolve to a combatant: sim aircraft plus external mirrors, deduped, in order.</summary>
        private List<string> CombatantIds()
        {
            var ids = new List<string>();
            var seen = new HashSet<string>();
            foreach (string id in aircraft.Keys)
            {
                if (seen.Add(id)) ids.Add(id);
            }
            foreach (string id in external.Keys)
            {
                if (seen.Add(id)) ids.Add(id);
            }
            return ids;
        }

        private ICombatant ResolveCombatant(string id)
        {
            SimAircraft a = aircraft.Get(id);
            if (a != null && a.Enabled) return a;
            ExternalCombatant e = external.Get(id);
            return e != null ? e : (ICombatant)a;
        }

        /// <summary>
        /// Advance the world by `delta`. `inputs` carries control inputs for
        /// externally-controlled aircraft; those with a sim-side player input get
        /// theirs written into it first, as the TS does.
        /// </summary>
        public void Step(double delta, Dictionary<string, SimControlInputs> inputs = null)
        {
            inputs ??= new Dictionary<string, SimControlInputs>();
            hits.Clear();
            // 0. Sim-side player input to control inputs for externally-flown aircraft.
            foreach (KeyValuePair<string, SimPlayerInput> kv in playerInputs)
            {
                SimAircraft a = aircraft.Get(kv.Key);
                if (a == null || !a.Enabled || a.Control != SimControlMode.External) continue;
                inputs[kv.Key] = kv.Value.Tick(delta, a);
            }
            // 1. External inputs first, so pilots and models read a consistent buffer.
            foreach (SimAircraft a in aircraft.Values)
            {
                if (!a.Enabled) continue;
                if (a.Control == SimControlMode.External)
                {
                    a.SetExternalInputs(inputs.TryGetValue(a.Id, out SimControlInputs inp) && inp != null ? inp : NeutralInputs());
                }
            }
            // 2. Re-pick faction targets before the pilots read them.
            UpdateAutoTargets(delta);
            // 3. Run AI pilots, reading the previous step's world positions.
            foreach (SimAircraft a in aircraft.Values)
            {
                if (!a.Enabled || a.Control != SimControlMode.Ai || a.Pilot == null) continue;
                if (a.Health <= 0)
                {
                    // Kill stick so the wreck is not flown by the AI.
                    a.SetPitch(0);
                    a.SetRoll(0);
                    a.SetYaw(0);
                    a.SetThrottle(0);
                    continue;
                }
                a.Pilot.Update(delta);
            }
            // 4. Advance every model from the now-consistent command buffers.
            foreach (SimAircraft a in aircraft.Values)
            {
                if (!a.Enabled) continue;
                if (a.ScrapeFxCooldown > 0)
                {
                    a.ScrapeFxCooldown = Math.Max(0, a.ScrapeFxCooldown - delta);
                }
                if (a.SlideFxCooldown > 0)
                {
                    a.SlideFxCooldown = Math.Max(0, a.SlideFxCooldown - delta);
                }
                a.ApplyInputsToModel();
                if (a.Model.IsCrashed)
                {
                    // The model's step no-ops once crashed; ride the deck kinematically instead.
                    ApplyCrashedCarrierRide(a);
                    a.ResolveFiring();
                    continue;
                }
                bool parked = ApplyKinematicCarrierPark(a);
                if (!parked)
                {
                    bool onCarrierFrame = BeginCarrierRelativeFrame(a);
                    a.Model.Update(delta);
                    EndCarrierRelativeFrame(a, delta, onCarrierFrame);
                }
                if (!parked)
                {
                    // A hard but survivable touchdown: the airframe is damaged.
                    double fraction = a.Model.ConsumeHardLanding();
                    // (A belly landing with a collision mesh is judged by its contact, below.)
                    if (fraction > 0 && (a.IsGearDeployed() || a.Collision == null))
                    {
                        ApplyHardLanding(a, fraction);
                    }
                    ResolveSolidWorldContact(a, delta);
                }
                ResolveArrestor(a, delta);
                a.ResolveFiring();
            }
            // 4b. Aircraft against each other.
            ResolveAircraftCollisions(delta);
            // 5. Guns + projectiles.
            foreach (SimAircraft a in aircraft.Values)
            {
                if (!a.Enabled || a.Gun == null) continue;
                a.Gun.Update(delta);
                if (a.Firing && a.IsAlive())
                {
                    a.Gun.TryFire(a.Model.Position, a.Model.Quaternion, a.Model.Velocity);
                }
            }
            UpdateProjectiles(delta);
        }

        /// <summary><see cref="IProjectileSink"/>: guns push rounds here.</summary>
        public void SpawnProjectile(Vec3d origin, Vec3d velocity, Faction faction, double damage)
        {
            ProjectileSlot slot = null;
            foreach (ProjectileSlot s in projectiles)
            {
                if (!s.Active)
                {
                    slot = s;
                    break;
                }
            }
            if (slot == null) return;
            slot.Active = true;
            slot.Faction = faction;
            slot.Damage = damage;
            slot.Life = ProjectileLifespan;
            slot.Pos = origin;
            slot.PrevPos = origin;
            slot.Vel = velocity;
        }

        private void UpdateProjectiles(double delta)
        {
            List<ICombatant> combatants = CollectCombatants();
            for (int i = 0; i < projectiles.Count; i++)
            {
                ProjectileSlot slot = projectiles[i];
                if (!slot.Active) continue;
                slot.Life -= delta;
                if (slot.Life <= 0)
                {
                    slot.Active = false;
                    continue;
                }
                slot.PrevPos = slot.Pos;
                slot.Vel.Y -= ProjectileGravity * delta;
                slot.Pos = slot.Pos.AddScaled(slot.Vel, delta);
                CheckHit(slot, combatants);
            }
        }

        /// <summary>
        /// Solid-world contact against the heightfield (flat ground, hills, ski jump,
        /// carrier deck). Soft gear-down scrapes defer to the gear springs.
        /// </summary>
        private void ResolveSolidWorldContact(SimAircraft a, double delta)
        {
            if (a.Model.IsCrashed || world == null) return;

            SolidWorldContact? contact = FindSolidWorldContact(a);
            if (!contact.HasValue) return;

            ApplySolidWorldResponse(a, contact.Value, delta);
        }

        /// <summary>
        /// Arrestor-cable snag + deck-axis deceleration. Snags only with the hook
        /// down; once latched, scrub along-deck speed to stop over the pull-out.
        /// </summary>
        private void ResolveArrestor(SimAircraft a, double delta)
        {
            if (a.Model.IsCrashed || arrestorFields.Count == 0) return;

            a.HookNow = ArrestorCables.HookWorldPos(a.Model.Position, a.Model.Quaternion, a.HookBody);

            if (a.ArrestorLatch < 0)
            {
                for (int fi = 0; fi < arrestorFields.Count; fi++)
                {
                    ArrestorCableField field = arrestorFields[fi];
                    int idx = ArrestorCables.TrySnag(
                        a.HookNow,
                        a.HasPrevHook ? a.PrevHook : (Vec3d?)null,
                        a.Model.Velocity,
                        field,
                        a.IsHookDeployed());
                    if (idx >= 0)
                    {
                        a.ArrestorLatch = idx;
                        a.ArrestorFieldIndex = fi;
                        a.ArrestorSnagAlong = Vec3d.Dot(a.HookNow, field.DeckAxis);
                        a.ArrestorHeld = false;
                        break;
                    }
                }
            }

            if (a.ArrestorLatch >= 0 && a.ArrestorFieldIndex >= 0)
            {
                ArrestorCableField field = arrestorFields[a.ArrestorFieldIndex];
                Vec3d vel = a.Model.Velocity;
                double shipAlong = Vec3d.Dot(carrierVel, field.DeckAxis);
                if (!a.ArrestorHeld)
                {
                    double traveled = Vec3d.Dot(a.HookNow, field.DeckAxis) - a.ArrestorSnagAlong;
                    double remaining = ArrestorCables.ArrestorPullOutM - traveled;
                    bool stillPulling = ArrestorCables.ApplyArrestorVelocity(ref vel, field.DeckAxis, delta, remaining, shipAlong);
                    a.Model.Velocity = vel;
                    a.Model.SnapPhysicsState();
                    if (!stillPulling)
                    {
                        a.Model.SetLanded(true);
                        a.ArrestorHeld = true;
                    }
                }
                else
                {
                    // Ride with the ship along-deck; taxi relative speed can release.
                    double along = Vec3d.Dot(vel, field.DeckAxis);
                    vel = vel.AddScaled(field.DeckAxis, shipAlong - along);
                    a.Model.Velocity = vel;
                    a.Model.SnapPhysicsState();
                    vel = a.Model.Velocity;
                    double relSpeed = JsMath.Hypot(vel.X - carrierVel.X, vel.Z - carrierVel.Z);
                    if (relSpeed > ArrestorCables.ArrestorReleaseSpeedMps || !a.IsHookDeployed())
                    {
                        a.ArrestorLatch = -1;
                        a.ArrestorFieldIndex = -1;
                        a.ArrestorHeld = false;
                    }
                }
            }

            a.PrevHook = a.HookNow;
            a.HasPrevHook = true;
        }

        /// <summary>
        /// Idle on-deck: lock XZ to a ship-local offset, match carrier velocity, skip
        /// the model so gear springs cannot bob the airframe.
        /// </summary>
        private bool ApplyKinematicCarrierPark(SimAircraft a)
        {
            UpdateCarrierDeckSticky(a);
            if (!a.CarrierDeckSticky || !a.IsLanded() || !a.IsGearDeployed())
            {
                a.CarrierParkLocalValid = false;
                return false;
            }
            if (a.GetThrottle() > 0.05)
            {
                a.CarrierParkLocalValid = false;
                return false;
            }
            // Still pulling out; do not freeze pose.
            if (a.ArrestorLatch >= 0 && !a.ArrestorHeld)
            {
                a.CarrierParkLocalValid = false;
                return false;
            }
            // Rollout / landing: keep the model until nearly stopped relative to the deck.
            Vec3d vel = a.Model.Velocity;
            double relSpd = JsMath.Hypot(vel.X - carrierVel.X, vel.Z - carrierVel.Z);
            if (relSpd > CarrierParkRelSpeedMps)
            {
                a.CarrierParkLocalValid = false;
                return false;
            }
            if (world == null || !world.CarrierOrigin(out Vec3d origin))
            {
                a.CarrierParkLocalValid = false;
                return false;
            }
            Vec3d pos = a.Model.Position;
            if (!a.CarrierParkLocalValid)
            {
                a.CarrierParkLocalX = pos.X - origin.X;
                a.CarrierParkLocalZ = pos.Z - origin.Z;
                a.CarrierParkLocalValid = true;
            }
            pos.X = origin.X + a.CarrierParkLocalX;
            pos.Z = origin.Z + a.CarrierParkLocalZ;
            a.Model.Position = pos;
            vel.X = carrierVel.X;
            vel.Y = 0;
            vel.Z = carrierVel.Z;
            a.Model.Velocity = vel;
            a.Model.ClearAngularVelocity();
            a.Model.SnapPhysicsState();
            return true;
        }

        /// <summary>A wreck on a moving deck keeps riding the carrier; anywhere else it stays where it froze.</summary>
        private void ApplyCrashedCarrierRide(SimAircraft a)
        {
            if (world == null || !IsOnCarrierDeck(a) || !world.CarrierOrigin(out Vec3d origin))
            {
                a.CrashedCarrierLocalValid = false;
                return;
            }
            Vec3d pos = a.Model.Position;
            if (!a.CrashedCarrierLocalValid)
            {
                a.CrashedCarrierLocalX = pos.X - origin.X;
                a.CrashedCarrierLocalZ = pos.Z - origin.Z;
                a.CrashedCarrierLocalValid = true;
            }
            pos.X = origin.X + a.CrashedCarrierLocalX;
            pos.Z = origin.Z + a.CrashedCarrierLocalZ;
            a.Model.Position = pos;
            Vec3d vel = a.Model.Velocity;
            vel.X = carrierVel.X;
            vel.Y = 0;
            vel.Z = carrierVel.Z;
            a.Model.Velocity = vel;
            a.Model.SnapPhysicsState();
        }

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        private void UpdateCarrierDeckSticky(SimAircraft a)
        {
            if (world == null || a.Model.IsCrashed || !a.IsGearDeployed() || !a.IsLanded())
            {
                a.CarrierDeckSticky = false;
                return;
            }
            Vec3d pos = a.Model.Position;
            // Finite means a deck triangle covers this point.
            double carrierY = world.CarrierHeightAt(pos.X, pos.Z);
            if (!IsFinite(carrierY))
            {
                a.CarrierDeckSticky = false;
                return;
            }
            if (IsOnCarrierDeck(a))
            {
                a.CarrierDeckSticky = true;
            }
        }

        /// <summary>Run the model in the carrier's horizontal frame so gear friction sees deck-relative speed.</summary>
        private bool BeginCarrierRelativeFrame(SimAircraft a)
        {
            if (!ShouldUseCarrierRelativeFrame(a)) return false;
            Vec3d vel = a.Model.Velocity;
            vel.X -= carrierVel.X;
            vel.Z -= carrierVel.Z;
            a.Model.Velocity = vel;
            a.Model.SnapPhysicsState();
            return true;
        }

        private void EndCarrierRelativeFrame(SimAircraft a, double delta, bool active)
        {
            if (!active) return;
            Vec3d pos = a.Model.Position;
            pos.X += carrierVel.X * delta;
            pos.Z += carrierVel.Z * delta;
            a.Model.Position = pos;
            Vec3d vel = a.Model.Velocity;
            vel.X += carrierVel.X;
            vel.Z += carrierVel.Z;
            a.Model.Velocity = vel;
            a.Model.SnapPhysicsState();
        }

        private bool ShouldUseCarrierRelativeFrame(SimAircraft a)
        {
            if (world == null || a.Model.IsCrashed || !a.IsGearDeployed()) return false;
            UpdateCarrierDeckSticky(a);
            if (!a.CarrierDeckSticky && !IsOnCarrierDeck(a)) return false;
            if (a.IsLanded() || a.ArrestorLatch >= 0) return true;
            return a.Model.GearCompressionMean > 0.005;
        }

        /// <summary>True when gear contact height matches the carrier mesh (not plain terrain).</summary>
        private bool IsOnCarrierDeck(SimAircraft a)
        {
            Vec3d pos = a.Model.Position;
            double carrierY = world.CarrierHeightAt(pos.X, pos.Z);
            if (!IsFinite(carrierY)) return false;
            double groundY = world.GroundHeightAt(pos.X, pos.Z);
            return Math.Abs(carrierY - groundY) < 0.15;
        }

        private SolidWorldContact? FindSolidWorldContact(SimAircraft a)
        {
            Vec3d pos = a.Model.Position;
            Quatd quat = a.Model.Quaternion;
            bool gearDown = a.IsGearDeployed();
            SceneWorldQuery w = world;
            Func<double, double, double> groundAt = (x, z) => w.GroundHeightAt(x, z);

            if (a.Collision != null)
            {
                double terrainMargin = gearDown ? GearTerrainMarginM : BellyTerrainMarginM;
                SolidWorldContact? contact = AircraftCollision.FindCollisionMeshTerrainContact(
                    pos, quat, a.Collision, groundAt, terrainMargin);
                if (contact.HasValue && IsUnresolvedTerrain(contact.Value.Point.X, contact.Value.Point.Z))
                {
                    return null;
                }
                // Every point of the hull on or near the ground, for a rigid-body response.
                contactSampleCount = contact.HasValue && !gearDown
                    ? AircraftCollision.CollectCollisionMeshTerrainContacts(
                        pos, quat, a.Collision, groundAt, terrainMargin, ContactActiveSlopM, contactSamples)
                    : 0;
                return contact;
            }

            // No baked mesh: CG belly vs terrain only.
            double groundY = groundAt(pos.X, pos.Z);
            double margin = gearDown ? GearTerrainMarginM : BellyTerrainMarginM;
            double bellyY = pos.Y - (gearDown ? SimConstants.PlaneDistanceToGround : a.HitRadius * 0.35);
            double terrainPen = (groundY - margin) - bellyY;
            if (terrainPen <= 0 || IsUnresolvedTerrain(pos.X, pos.Z))
            {
                return null;
            }
            return new SolidWorldContact
            {
                Point = new Vec3d(pos.X, bellyY, pos.Z),
                Normal = new Vec3d(0, 1, 0),
                Penetration = terrainPen,
            };
        }

        /// <summary>
        /// True when the solid here is DEM relief known only at the coarse tier, so
        /// an aircraft flies through it instead of being wrecked against a guess.
        /// </summary>
        private bool IsUnresolvedTerrain(double x, double z)
        {
            if (world == null || heightField.IsAuthoritativeAt(x, z))
            {
                return false;
            }
            if (!heightField.IsLandAtWorld(x, z))
            {
                return false;
            }
            double demY = heightField.HeightAtWorld(x, z);
            return Math.Abs(world.GroundHeightAt(x, z) - demY) < 0.01;
        }

        private void ApplySolidWorldResponse(SimAircraft a, SolidWorldContact contact, double delta)
        {
            Vec3d n = contact.Normal;
            FlightModel model = a.Model;

            // Contact-point speed into the surface (CG + spin), for FX / fatality.
            double impactSpeed = model.ContactSpeedIntoNormal(contact.Point, n);
            int samples = contactSampleCount;
            contactSampleCount = 0;
            if (samples > 0 && n.Y > 0.5 && !a.IsGearDeployed())
            {
                // How hard a rigid body came in is how fast its centre was sinking,
                // plus a part of what the contact point's own swing adds.
                Vec3d v = model.Velocity;
                double cgInto = Math.Max(0, -(v.X * n.X + v.Y * n.Y + v.Z * n.Z));
                impactSpeed = cgInto + BellySwingShare * Math.Max(0, impactSpeed - cgInto);
            }

            // Soft rolling contact: gear springs own the vertical constraint.
            if (a.IsGearDeployed() && impactSpeed < SolidScrapeFxMps && contact.Penetration < 0.35)
            {
                return;
            }

            // Heightfield penetration is vertical depth: lift in Y only.
            Vec3d pos = model.Position;
            pos.Y += contact.Penetration + SolidSlopM;
            model.Position = pos;

            // Mild drag at the hit point (linear + torque). No bounce / no velocity dump.
            bool rigid = samples > 0 && n.Y > 0.5 && !a.IsGearDeployed();
            if (!rigid)
            {
                model.ApplyContactDragAt(
                    contact.Point,
                    delta,
                    SolidContactDragPerS,
                    SolidContactDragMassFrac,
                    SolidContactDragMaxFrac);
                model.SnapPhysicsState();
            }

            // The surface stops what is going into it.
            Vec3d vel = model.Velocity;
            double into = vel.X * n.X + vel.Y * n.Y + vel.Z * n.Z;
            if (!rigid && into < 0)
            {
                model.Velocity = vel.AddScaled(n, -into);
                model.SnapPhysicsState();
            }
            // Gear up, it slides on its belly: sliding friction brings it to a halt.
            if (!rigid && !a.IsGearDeployed() && n.Y > 0.5)
            {
                vel = model.Velocity;
                double vn = vel.X * n.X + vel.Y * n.Y + vel.Z * n.Z;
                double tx = vel.X - n.X * vn;
                double ty = vel.Y - n.Y * vn;
                double tz = vel.Z - n.Z * vn;
                double slide = JsMath.Hypot(tx, ty, tz);
                if (slide > 1e-3)
                {
                    double take = Math.Min(slide, BellyFrictionDecelMps2 * delta);
                    double k = take / slide;
                    vel.X -= tx * k;
                    vel.Y -= ty * k;
                    vel.Z -= tz * k;
                    model.Velocity = vel;
                    model.SnapPhysicsState();
                }
            }

            // On its belly it takes far less than on its gear.
            double crashSpeed = a.IsGearDeployed() ? SolidCrashImpactMps : LandingLimits.BellyFatalHardness;
            // Where the support is not under the centre of gravity the weight tips it over the contact point.
            if (rigid)
            {
                ResolveRigidContacts(a, n, samples, contact.Penetration + SolidSlopM);
            }
            else if (n.Y > 0.5)
            {
                double w = model.GetMassKg() * 9.80665 * delta * SupportTorqueFactor;
                Vec3d supportRel = contact.Point - model.Position;
                var supportImpulse = new Vec3d(-supportRel.Z * w, 0, supportRel.X * w);
                model.ApplyExternalWrench(Vec3d.Zero, supportImpulse);
            }

            bool fatal = impactSpeed >= crashSpeed
                || contact.Penetration >= SolidCrashPenetrationM;
            if (fatal)
            {
                model.SetCrashed(true);
                a.ApplyDamage(a.Health);
                EmitScrapeFx(a, contact.Point, true, impactSpeed);
                return;
            }

            if (rigid)
            {
                // A clean belly landing is no damage at all; beyond it the damage grows linearly with the sink rate.
                double fraction = LandingLimits.DamageFraction(impactSpeed, LandingLimits.BellySoftHardness, LandingLimits.BellyFatalHardness);
                if (fraction > 0)
                {
                    a.ApplyDamage(fraction * a.MaxHealth);
                    if (a.Health <= 0)
                    {
                        model.SetCrashed(true);
                    }
                    EmitScrapeFx(
                        a, contact.Point, false, impactSpeed,
                        DamageSeverityMin + fraction * (DamageSeverityMax - DamageSeverityMin));
                }
            }
            else if (impactSpeed >= SolidScrapeFxMps)
            {
                double dmg = impactSpeed * SolidScrapeDamagePerMps;
                a.ApplyDamage(dmg);
                if (a.Health <= 0)
                {
                    model.SetCrashed(true);
                }
                EmitScrapeFx(a, contact.Point, false, impactSpeed);
            }
            else if (contact.Penetration > 0.15)
            {
                EmitScrapeFx(a, contact.Point, false, impactSpeed);
            }
        }

        /// <summary>
        /// The airframe as a rigid body on the ground: at every hull point on or near
        /// it, an impulse stops the point's approach (no bounce) and Coulomb friction
        /// brakes its sliding, through the body's own mass and inertia.
        /// </summary>
        private void ResolveRigidContacts(SimAircraft a, Vec3d n, int count, double lift)
        {
            FlightModel model = a.Model;
            Vec3d pos = model.Position;
            int slidePoints = 0;
            for (int pass = 0; pass < RigidContactPasses; pass++)
            {
                for (int i = 0; i < count; i++)
                {
                    TerrainContactSample s = contactSamples[i];
                    // The sample positions were taken before the aircraft was lifted clear.
                    if (s.Pen - lift <= -ContactActiveSlopM)
                    {
                        continue;
                    }
                    var rigidPoint = new Vec3d(s.X, s.Y + lift, s.Z);
                    Vec3d rigidVel = model.PointVelocity(rigidPoint);
                    double vn = Vec3d.Dot(rigidVel, n);
                    if (vn >= 0)
                    {
                        continue;
                    }
                    double j = -vn / model.InvEffectiveMass(rigidPoint, n);
                    Vec3d rigidImpulse = n * j;
                    Vec3d rigidArm = rigidPoint - pos;
                    Vec3d rigidAngular = Vec3d.Cross(rigidArm, rigidImpulse);
                    model.ApplyExternalWrench(rigidImpulse, rigidAngular);

                    // Friction along the sliding direction, no more than the normal impulse allows.
                    rigidVel = model.PointVelocity(rigidPoint);
                    Vec3d rigidTangent = rigidVel.AddScaled(n, -Vec3d.Dot(rigidVel, n));
                    double slide = rigidTangent.Length;
                    if (slide < 1e-4)
                    {
                        continue;
                    }
                    if (pass == 0 && slide > SlideFxMinMps && a.SlideFxCooldown <= 0 && slidePoints < SlideFxPoints)
                    {
                        // Remember where the airframe is rubbing along the ground, for sparks and dust.
                        slideAt[slidePoints++] = rigidPoint;
                    }
                    rigidTangent = rigidTangent * (1 / slide);
                    double jt = Math.Min(RigidContactFriction * j, slide / model.InvEffectiveMass(rigidPoint, rigidTangent));
                    rigidImpulse = rigidTangent * -jt;
                    rigidAngular = Vec3d.Cross(rigidArm, rigidImpulse);
                    model.ApplyExternalWrench(rigidImpulse, rigidAngular);
                }
            }
            model.SnapPhysicsState();
            if (slidePoints > 0)
            {
                a.SlideFxCooldown = SlideFxIntervalS;
                Vec3d vel = model.Velocity;
                for (int i = 0; i < slidePoints; i++)
                {
                    Vec3d p = slideAt[i];
                    hits.Add(new SimHitEvent
                    {
                        Position = new[] { p.X, p.Y, p.Z },
                        Velocity = new[] { vel.X, vel.Y, vel.Z },
                        TargetId = a.Id,
                        Damage = 0,
                        Source = "scrape",
                        Slide = true,
                    });
                }
            }
        }

        /// <summary>
        /// Mid-air collisions. Two live airframes whose hulls interpenetrate bump:
        /// momentum is exchanged through the contact point, and each is damaged in
        /// proportion to how fast they met.
        /// </summary>
        private void ResolveAircraftCollisions(double delta)
        {
            var live = new List<SimAircraft>();
            foreach (SimAircraft a in aircraft.Values)
            {
                if (a.Enabled && a.Health > 0 && !a.Model.IsCrashed)
                {
                    live.Add(a);
                }
            }
            foreach (string key in new List<string>(pairCooldownOrder))
            {
                double t = pairCooldown[key];
                if (t - delta <= 0)
                {
                    pairCooldown.Remove(key);
                    pairCooldownOrder.Remove(key);
                }
                else
                {
                    pairCooldown[key] = t - delta;
                }
            }
            for (int i = 0; i < live.Count; i++)
            {
                for (int j = i + 1; j < live.Count; j++)
                {
                    SimAircraft a = live[i];
                    SimAircraft b = live[j];
                    double reach = a.CollisionReach() + b.CollisionReach();
                    if ((a.Model.Position - b.Model.Position).LengthSquared > reach * reach)
                    {
                        continue;
                    }
                    if (PairContact(a, b, out Vec3d point, out Vec3d normal))
                    {
                        Collide(a, b, point, normal);
                    }
                }
            }
        }

        private static bool PairContact(SimAircraft a, SimAircraft b, out Vec3d pairPoint, out Vec3d pairNormal)
        {
            if (a.Collision != null && b.Collision != null)
            {
                return AircraftCollision.FindAircraftPairContact(
                    a.Model.Position, a.Model.Quaternion, a.Collision,
                    b.Model.Position, b.Model.Quaternion, b.Collision,
                    out pairPoint, out pairNormal);
            }
            // No meshes: the hit spheres, at their working size.
            pairPoint = default;
            pairNormal = a.Model.Position - b.Model.Position;
            double dist = pairNormal.Length;
            double reach = a.CollisionReach() + b.CollisionReach();
            if (dist >= reach)
            {
                return false;
            }
            if (dist > 1e-6)
            {
                pairNormal = pairNormal * (1 / dist);
            }
            else
            {
                pairNormal = new Vec3d(0, 1, 0);
            }
            pairPoint = b.Model.Position.AddScaled(pairNormal, b.CollisionReach());
            return true;
        }

        private void Collide(SimAircraft a, SimAircraft b, Vec3d point, Vec3d n)
        {
            // n points from b toward a.
            Vec3d pairVelA = a.Model.PointVelocity(point);
            Vec3d pairVelB = b.Model.PointVelocity(point);
            Vec3d pairRel = pairVelA - pairVelB;
            double closing = -Vec3d.Dot(pairRel, n);
            double relSpeed = pairRel.Length;

            // Momentum exchange along the contact normal, nearly inelastic.
            if (closing > 0)
            {
                double ia = a.Model.InvEffectiveMass(point, n);
                double ib = b.Model.InvEffectiveMass(point, n);
                double j = (1 + MidairRestitution) * closing / (ia + ib);
                Vec3d pairImpulse = n * j;
                Vec3d pairArm = point - a.Model.Position;
                Vec3d pairTorque = Vec3d.Cross(pairArm, pairImpulse);
                a.Model.ApplyExternalWrench(pairImpulse, pairTorque);
                pairImpulse = pairImpulse * -1;
                pairArm = point - b.Model.Position;
                pairTorque = Vec3d.Cross(pairArm, pairImpulse);
                b.Model.ApplyExternalWrench(pairImpulse, pairTorque);
            }
            else
            {
                // Already parting but still overlapping: ease them apart.
                double ma = a.Model.GetMassKg();
                double mb = b.Model.GetMassKg();
                const double push = 0.05;
                a.Model.Position = a.Model.Position.AddScaled(n, push * mb / (ma + mb));
                b.Model.Position = b.Model.Position.AddScaled(n, -push * ma / (ma + mb));
            }
            a.Model.SnapPhysicsState();
            b.Model.SnapPhysicsState();

            // Damage, once per collision: linear in the speed they met at.
            string key = string.CompareOrdinal(a.Id, b.Id) < 0 ? a.Id + "|" + b.Id : b.Id + "|" + a.Id;
            if (pairCooldown.ContainsKey(key))
            {
                return;
            }
            pairCooldown[key] = MidairCooldownS;
            pairCooldownOrder.Add(key);
            double fraction = LandingLimits.DamageFraction(relSpeed, MidairSoftMps, MidairFatalMps);
            if (fraction <= 0)
            {
                return;
            }
            foreach (SimAircraft x in new[] { a, b })
            {
                x.ApplyDamage(fraction * x.MaxHealth);
                if (x.Health <= 0)
                {
                    // Destroyed: it comes apart where it is.
                    x.Model.SetCrashed(true);
                }
                Vec3d vel = x.Model.Velocity;
                hits.Add(new SimHitEvent
                {
                    Position = new[] { point.X, point.Y, point.Z },
                    Velocity = new[] { vel.X, vel.Y, vel.Z },
                    TargetId = x.Id,
                    Damage = 5,
                    ImpactSpeed = relSpeed,
                    Severity = DamageSeverityMin + fraction * (DamageSeverityMax - DamageSeverityMin),
                    Source = "gun",
                });
            }
        }

        /// <summary>A hard landing that did not destroy the aircraft: it takes damage and the render side is told.</summary>
        private void ApplyHardLanding(SimAircraft a, double fraction)
        {
            // Linear from nothing at the soft limit to destroyed at the fatal one.
            a.ApplyDamage(fraction * a.MaxHealth);
            Vec3d pos = a.Model.Position;
            Vec3d vel = a.Model.Velocity;
            hits.Add(new SimHitEvent
            {
                Position = new[] { pos.X, pos.Y - 1, pos.Z },
                Velocity = new[] { vel.X, vel.Y, vel.Z },
                TargetId = a.Id,
                Damage = 5,
                ImpactSpeed = 0,
                Severity = DamageSeverityMin + fraction * (DamageSeverityMax - DamageSeverityMin),
                Source = "scrape",
            });
        }

        private void EmitScrapeFx(SimAircraft a, Vec3d point, bool force, double impactSpeed, double? severity = null)
        {
            if (!force && a.ScrapeFxCooldown > 0) return;
            a.ScrapeFxCooldown = SolidScrapeFxCooldownS;
            Vec3d vel = a.Model.Velocity;
            hits.Add(new SimHitEvent
            {
                Position = new[] { point.X, point.Y, point.Z },
                Velocity = new[] { vel.X, vel.Y, vel.Z },
                TargetId = a.Id,
                Damage = force ? 50 : 5,
                ImpactSpeed = impactSpeed,
                Severity = severity,
                Source = "scrape",
            });
        }

        private void CheckHit(ProjectileSlot slot, List<ICombatant> combatants)
        {
            Vec3d seg = slot.Pos - slot.PrevPos;
            double segLenSq = seg.LengthSquared;
            Vec3d segEnd = slot.Pos;
            for (int i = 0; i < combatants.Count; i++)
            {
                ICombatant c = combatants[i];
                if (c.Faction == slot.Faction || !c.IsAlive()) continue;
                Vec3d cPos = c.ReadPosition();

                bool hit;
                Vec3d closest;
                SimAircraft simA = c as SimAircraft;
                if (simA?.Collision != null)
                {
                    hit = AircraftCollision.SegmentHitsCollisionMesh(
                        slot.PrevPos, segEnd, cPos, simA.Model.Quaternion, simA.Collision, out closest);
                }
                else
                {
                    double radius = c.GetHitRadius();
                    hit = AircraftCollision.SegmentHitsSphere(slot.PrevPos, seg, segLenSq, cPos, radius, out closest);
                }
                if (!hit) continue;

                c.ApplyDamage(slot.Damage);
                Vec3d cVel = c.ReadVelocity();
                hits.Add(new SimHitEvent
                {
                    Position = new[] { closest.X, closest.Y, closest.Z },
                    Velocity = new[] { cVel.X, cVel.Y, cVel.Z },
                    TargetId = CombatantId(c),
                    Damage = slot.Damage,
                });
                slot.Active = false;
                return;
            }
        }

        private string CombatantId(ICombatant c)
        {
            foreach (KeyValuePair<string, SimAircraft> kv in aircraft)
            {
                if (ReferenceEquals(kv.Value, c)) return kv.Key;
            }
            foreach (KeyValuePair<string, ExternalCombatant> kv in external)
            {
                if (ReferenceEquals(kv.Value, c)) return kv.Key;
            }
            return "";
        }

        private List<ICombatant> CollectCombatants()
        {
            var list = new List<ICombatant>();
            foreach (SimAircraft a in aircraft.Values)
            {
                if (a.Enabled) list.Add(a);
            }
            foreach (ExternalCombatant e in external.Values)
            {
                list.Add(e);
            }
            return list;
        }

        /// <summary>A projectile's tracer orientation (three.js setFromUnitVectors(FORWARD, dir)); null when it is not moving.</summary>
        public static Quatd? ProjectileQuaternion(ProjectileSlot slot)
        {
            if (!(slot.Vel.LengthSquared > 1e-6)) return null;
            Vec3d vTo = slot.Vel.Normalized();
            Vec3d vFrom = SimConstants.Forward;
            double r = Vec3d.Dot(vFrom, vTo) + 1;
            double x, y, z, w;
            if (r < 1e-8)
            {
                r = 0;
                if (Math.Abs(vFrom.X) > Math.Abs(vFrom.Z))
                {
                    x = -vFrom.Y; y = vFrom.X; z = 0; w = r;
                }
                else
                {
                    x = 0; y = -vFrom.Z; z = vFrom.Y; w = r;
                }
            }
            else
            {
                x = vFrom.Y * vTo.Z - vFrom.Z * vTo.Y;
                y = vFrom.Z * vTo.X - vFrom.X * vTo.Z;
                z = vFrom.X * vTo.Y - vFrom.Y * vTo.X;
                w = r;
            }
            return new Quatd(x, y, z, w).Normalized();
        }
    }
}
