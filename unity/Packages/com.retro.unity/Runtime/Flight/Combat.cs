using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;

namespace Retro.Unity
{
    /// <summary>game.ts SpawnMode: the spawn menu's start buttons (digits as on the web); Location is a searched place.</summary>
    public enum SpawnMode
    {
        Location = 0,
        Approach = 1,
        Runway = 2,
        HeadOn = 3,
        Carrier = 4,
        CarrierTakeoff = 5,
        HighAlt = 6,
        Space = 7,
        CloseWing = 9,
    }

    /// <summary>
    /// The other aircraft of a sortie (game.ts setupCombat, spawnOpponent,
    /// spawnWingman): AI_OPPONENT_COUNT hostile airframes and one wingman, all
    /// the player's own type, parked disabled in the sim until a flight begins.
    /// Then the opponents are put ahead of the player (or head-on) and sent to
    /// ENGAGE the player's side, and the wingman joins in FORMATION (or flies
    /// abreast for the wingtip start). Each is drawn with its own
    /// <see cref="AircraftView"/>.
    /// </summary>
    public sealed class Combat
    {
        // game.ts
        public const int AiOpponentCount = 1;
        private const double AiEngageSpawnDistanceM = 300;
        private const double AiHeadOnSpawnDistanceM = 3000;
        private const double LateralSpacingM = 80;
        private const double WingmanHoldAltitudeAglM = 900;
        private const double WingmanHoldSpeedMps = 180;
        private const double CloseWingSideM = 4;
        private const double CloseWingAboveM = 2;
        /// <summary>PLAYER_HIT_RADIUS_M: player and AI share the airframe.</summary>
        public const double HitRadiusM = 10;
        public const string WingmanId = "wing0";
        public static string OpponentId(int index) => "ai" + index;

        /// <summary>PLAYER_GUN: the shared boresight gun.</summary>
        public static SimGunConfig Gun() => new SimGunConfig
        {
            MuzzleVelocity = 1000, RoundsPerSecond = 20, Damage = 8, Ammo = 2400,
            MuzzleOffset = new double[] { 0, 0, 9 }, Spread = 0.003,
        };

        /// <summary>The AI model the opponents and the wingman fly (the web game's Settings default).</summary>
        public AiPilotModels PilotModel = AiPilotModels.CLASSIC;

        private readonly CombatSim sim;
        private readonly string playerId;
        private readonly List<(string Id, AircraftView View)> others = new List<(string, AircraftView)>();

        public IReadOnlyList<(string Id, AircraftView View)> Others => others;

        public Combat(CombatSim sim, string playerId, FlyableAircraftDef def, IAircraftFiles files, Fm2AircraftConfig config,
            SimFlightModelKind model, Vec3d park, double heading)
        {
            this.sim = sim;
            this.playerId = playerId;
            Quatd q = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), heading);
            for (int i = 0; i <= AiOpponentCount; i++)
            {
                bool wingman = i == AiOpponentCount;
                string id = wingman ? WingmanId : OpponentId(i);
                sim.AddAircraft(new SimAircraftDesc
                {
                    Id = id,
                    // The wingman is the player's side: the projectile pool's same-faction
                    // check then rules out friendly fire both ways.
                    Faction = wingman ? Faction.PLAYER : Faction.ENEMY,
                    Control = SimControlMode.Ai,
                    Model = model,
                    AircraftConfig = config,
                    PilotOptions = PilotOptions(),
                    HitRadius = HitRadiusM,
                    MaxHealth = 100,
                    Gun = Gun(),
                    Collision = def.CollisionMesh,
                    Spawn = new SimAircraftSpawn
                    {
                        Position = new[] { park.X, park.Y, park.Z },
                        Quaternion = new[] { q.X, q.Y, q.Z, q.W },
                        Velocity = new double[] { 0, 0, 0 },
                        Landed = false, Throttle = 0, Airborne = true,
                    },
                    Enabled = false,
                });
                sim.SetEnabled(id, false);
                var view = new AircraftView(wingman ? "Wingman" : "Opponent " + i);
                view.Load(def, files);
                others.Add((id, view));
            }
        }

        /// <summary>opponentPilotOptions.</summary>
        private AiPilotOptions PilotOptions() => new AiPilotOptions
        {
            CruiseAltitude = ApproachAltitudeM,
            CruiseSpeed = ApproachSpeedMps,
            CombatSpeed = 180,
            GunRange = 900,
            HardDeck = 200,
            // CLASSIC-only knob; the other models run their own tactical matrix.
            AlwaysEngage = PilotModel == AiPilotModels.CLASSIC,
            Skill = AiSkillLevel.ACE,
            Model = PilotModel,
        };

        /// <summary>defs.ts APPROACH_ALTITUDE_M and APPROACH_SPEED_MPS.</summary>
        public const double ApproachAltitudeM = 1000;
        public const double ApproachSpeedMps = 400 / 3.6;

        /// <summary>The player's airframe changed: the others fly it too (applySelectedAircraft).</summary>
        public void SetAircraft(FlyableAircraftDef def, IAircraftFiles files, Fm2AircraftConfig config, SimFlightModelKind model)
        {
            foreach ((string id, AircraftView view) in others)
            {
                sim.SetAircraftConfig(id, config, model, def.CollisionMesh);
                view.Load(def, files);
            }
        }

        public SimAircraft Opponent => sim.GetAircraft(OpponentId(0));

        /// <summary>beginFlight's tail: the opponents and the wingman for this sortie.</summary>
        public void Begin(SpawnMode mode, Func<double, double, double> groundAt)
        {
            SpawnOpponents(mode == SpawnMode.HeadOn);
            SpawnWingman(mode == SpawnMode.CloseWing, groundAt);
        }

        private static Vec3d FlatForward(Quatd q)
        {
            Vec3d f = SceneAxes.Forward.Rotate(q);
            f.Y = 0;
            return f.Normalized();
        }

        /// <summary>RIGHT.applyAxisAngle(UP, heading).</summary>
        private static Vec3d RightOf(double heading) => SceneAxes.Right.Rotate(Quatd.FromAxisAngle(SceneAxes.Up, heading));

        private static SimAircraftSpawn Spawn(Vec3d position, double heading, bool airborne, double throttle, Vec3d velocity)
        {
            Quatd q = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), heading);
            return new SimAircraftSpawn
            {
                Position = new[] { position.X, position.Y, position.Z },
                Quaternion = new[] { q.X, q.Y, q.Z, q.W },
                Velocity = new[] { velocity.X, velocity.Y, velocity.Z },
                Landed = !airborne,
                Throttle = throttle,
                Airborne = airborne,
            };
        }

        /// <summary>spawnOpponent: ahead at the standoff, same heading or facing the player, at its speed.</summary>
        private void SpawnOpponents(bool headOn)
        {
            SimAircraft player = sim.GetAircraft(playerId);
            Vec3d p = player.GetPosition();
            Vec3d forward = FlatForward(player.GetQuaternion());
            double heading = JsTrig.Atan2(forward.X, forward.Z);
            Vec3d right = RightOf(heading);
            Vec3d v = player.GetVelocity();
            double speed = v.Length;
            Vec3d aiForward = headOn ? -forward : forward;
            Vec3d velocity = aiForward * speed;
            // Keep the vertical speed, so a co-altitude spawn stays level with the player.
            velocity.Y = v.Y;
            double standoff = headOn ? AiHeadOnSpawnDistanceM : AiEngageSpawnDistanceM;
            for (int i = 0; i < AiOpponentCount; i++)
            {
                string id = OpponentId(i);
                double lateral = AiOpponentCount == 1 ? 0 : (i - (AiOpponentCount - 1) / 2.0) * LateralSpacingM;
                Vec3d position = p.AddScaled(forward, standoff).AddScaled(right, lateral);
                sim.SetPilotOptions(id, PilotOptions());
                sim.Respawn(id, Spawn(position, headOn ? heading + Math.PI : heading, !player.IsLanded(), player.GetThrottle(), velocity));
                ViewOf(id).Snap(sim.GetAircraft(id));
                // The whole friendly side - player and wingman - re-picked as the fight develops.
                sim.SetTargetFaction(id, Faction.PLAYER);
                sim.SetPhase(id, AiFlightPhase.ENGAGE);
            }
            // The player's own autopilot flies home and lands; it knows the primary opponent.
            sim.SetTarget(playerId, OpponentId(0));
            sim.SetPhase(playerId, AiFlightPhase.RTB);
        }

        /// <summary>spawnWingman / spawnCloseWingman.</summary>
        private void SpawnWingman(bool close, Func<double, double, double> groundAt)
        {
            SimAircraft player = sim.GetAircraft(playerId);
            Vec3d p = player.GetPosition();
            Vec3d forward = FlatForward(player.GetQuaternion());
            double heading = JsTrig.Atan2(forward.X, forward.Z);
            Vec3d right = RightOf(heading);
            sim.SetPilotOptions(WingmanId, PilotOptions());
            if (close)
            {
                // Abreast, 4 m right and 2 m up, flying straight: any contact is the player's doing.
                Vec3d at = p.AddScaled(right, CloseWingSideM).AddScaled(new Vec3d(0, 1, 0), CloseWingAboveM);
                sim.Respawn(WingmanId, Spawn(at, heading, true, player.GetThrottle(), player.GetVelocity()));
                ViewOf(WingmanId).Snap(sim.GetAircraft(WingmanId));
                sim.SetPhase(WingmanId, AiFlightPhase.STRAIGHT);
                return;
            }
            Vec3d position = p.AddScaled(forward, -FormationSlot.Trail).AddScaled(right, FormationSlot.Side);
            position.Y += FormationSlot.Stack;
            Vec3d velocity;
            double throttle;
            if (player.IsLanded())
            {
                // No wing slot on the ground: hold overhead until the player is flying.
                position.Y = groundAt(position.X, position.Z) + WingmanHoldAltitudeAglM;
                velocity = forward * WingmanHoldSpeedMps;
                throttle = 1;
            }
            else
            {
                velocity = player.GetVelocity();
                throttle = player.GetThrottle();
            }
            sim.Respawn(WingmanId, Spawn(position, heading, true, throttle, velocity));
            ViewOf(WingmanId).Snap(sim.GetAircraft(WingmanId));
            sim.SetFormationLead(WingmanId, playerId);
            sim.SetTargetFaction(WingmanId, Faction.ENEMY);
            sim.SetPhase(WingmanId, AiFlightPhase.FORMATION);
        }

        /// <summary>clearOtherAircraft: an empty sky.</summary>
        public void Clear()
        {
            foreach ((string id, _) in others) sim.SetEnabled(id, false);
            sim.SetTarget(playerId, null);
        }

        private AircraftView ViewOf(string id)
        {
            foreach ((string i, AircraftView v) in others)
            {
                if (i == id) return v;
            }
            return null;
        }

        /// <summary>Draw every enabled airframe; parked ones are hidden.</summary>
        public void Draw(Vec3d camera, double dt)
        {
            foreach ((string id, AircraftView view) in others)
            {
                SimAircraft a = sim.GetAircraft(id);
                if (a == null || !a.Enabled)
                {
                    view.Hide();
                    continue;
                }
                view.Draw(a, camera, dt, true, WingSweepMode.Auto);
            }
        }

        public void Destroy()
        {
            foreach ((_, AircraftView view) in others) view.Destroy();
            others.Clear();
        }
    }
}
