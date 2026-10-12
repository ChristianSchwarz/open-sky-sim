using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// One sim aircraft drawn (player.ts / aiAircraft.ts render side): its glTF
    /// parts posed from the sim with the gear, flaps and airbrakes moving
    /// through their transits, the swing wings on their schedule, and its
    /// afterburner plumes and wingtip trails. The player and every AI airframe
    /// get one each.
    /// </summary>
    public sealed class AircraftView
    {
        // player.ts device animations: durations (s).
        private const double GearAnimS = 3, FlapsAnimS = 2, AirbrakesAnimS = 1.5;

        private AircraftModel model;
        private readonly AircraftFxRenderer fx = new AircraftFxRenderer();
        private readonly string name;
        private double gearUnit, flapsUnit, airbrakesUnit, sweepUnit;

        public FlyableAircraftDef Def { get; private set; }

        /// <summary>Damage from hard impacts it survived (player.ts / aiAircraft.ts damage).</summary>
        public readonly AirframeDamage Damage = new AirframeDamage();

        /// <summary>player.ts setReplayPose: a recorded pose to draw at instead of the sim's; null is the live one.</summary>
        public ReplayPose ReplayPose;
        private List<WreckMeshData> rootData;
        private List<(Mesh Mesh, Material Material)> rootMeshes;
        private double damageLowestHealth = double.PositiveInfinity;
        public AircraftFx Fx => fx.Fx;
        public bool Loaded => model != null && model.Loaded;

        /// <summary>Gear, flaps and airbrakes through their transits, 0 in to 1 out.</summary>
        public (double Gear, double Flaps, double Airbrakes) Units => (gearUnit, flapsUnit, airbrakesUnit);

        public AircraftView(string name)
        {
            this.name = name;
        }

        /// <summary>Load (or swap to) an airframe; the sweep starts spread.</summary>
        public void Load(FlyableAircraftDef def, IAircraftFiles files)
        {
            if (Def == def) return;
            model?.Destroy();
            Def = def;
            model = new AircraftModel(def, files, name);
            fx.Configure(def);
            Damage.Reset();
            sweepUnit = 0;
        }

        /// <summary>Gear, flaps and airbrakes shown where the sim has them, without the transit; trails cleared.</summary>
        public void Snap(SimAircraft aircraft)
        {
            gearUnit = aircraft.IsGearDeployed() ? 1 : 0;
            flapsUnit = aircraft.IsFlapsExtended() ? 1 : 0;
            airbrakesUnit = aircraft.IsAirbrakesExtended() ? 1 : 0;
            fx.Fx.ResetTrails();
        }

        private static double Toward(double unit, bool target, double durationS, double dt) =>
            Math.Max(0, Math.Min(1, unit + (target ? dt : -dt) / durationS));

        /// <summary>
        /// Step the devices and draw. <paramref name="visible"/> false hides the airframe
        /// (the player's own in the cockpit) but keeps its plumes and trails.
        /// </summary>
        /// <param name="wrecked">Shown as a wreck: neither the airframe nor its plumes and trails draw (render3D's early out).</param>
        public void Draw(SimAircraft aircraft, Vec3d camera, double dt, bool visible, WingSweepMode sweepMode, bool wrecked = false)
        {
            if (Def == null) return;
            RepairIfRestored(aircraft);
            if (wrecked)
            {
                model?.SetVisible(false);
                return;
            }
            Vec3d position = ReplayPose != null ? ReplayPose.Position : aircraft.GetPosition();
            Quatd quaternion = ReplayPose != null ? ReplayPose.Quaternion : aircraft.GetQuaternion();
            Vec3d velocity = ReplayPose != null ? ReplayPose.Velocity : aircraft.GetVelocity();
            gearUnit = Toward(gearUnit, aircraft.IsGearDeployed(), GearAnimS, dt);
            flapsUnit = Toward(flapsUnit, aircraft.IsFlapsExtended(), FlapsAnimS, dt);
            airbrakesUnit = Toward(airbrakesUnit, aircraft.IsAirbrakesExtended(), AirbrakesAnimS, dt);
            if (Def.SwingWings != null)
            {
                double target = WingSweep.Target(sweepMode, aircraft.GetAirspeed(), Def.SwingWings);
                sweepUnit = WingSweep.Step(sweepUnit, target, dt, Def.SwingWings);
            }
            if (model != null && model.Loaded)
            {
                model.SetVisible(visible);
                if (visible)
                {
                    FlightModel fm = aircraft.Model;
                    model.Pose(position, quaternion, camera, new AircraftPoseInputs
                    {
                        CommandedElevator = fm.CommandedElevator,
                        CommandedAileron = fm.CommandedAileron,
                        CommandedRudder = fm.CommandedRudder,
                        RollDemand = aircraft.GetRollInput(),
                        FlapsUnit = flapsUnit,
                        AirbrakesUnit = airbrakesUnit,
                        GearUnit = gearUnit,
                        SweepUnit = sweepUnit,
                        AngleOfAttack = aircraft.GetAngleOfAttack(),
                        Still = aircraft.IsCrashed(),
                    }, Damage);
                    DrawRoot(position, quaternion, camera);
                }
            }
            fx.BindTips(model);
            fx.Draw(new AircraftFxInput
            {
                ThrottleLever = aircraft.GetThrottle(),
                AbDetents = aircraft.Model.UseAfterburnerThrottleDetents,
                Position = position,
                Quaternion = quaternion,
                Velocity = velocity,
                WingSweep = sweepUnit,
            }, camera);
        }

        /// <summary>The airframe as the wreck field takes it apart, where it was last drawn; null before it has loaded.</summary>
        public WreckSource WreckSource(string id, Vec3d velocity) => model?.WreckSource(id, velocity, true, Damage);

        /// <summary>The health when a blow landed, for the repair once it is restored.</summary>
        public void NoteDamageHealth(double health) => damageLowestHealth = Math.Min(damageLowestHealth, health);

        /// <summary>
        /// repairDamageIfRestored: damage goes once the aircraft is back to full health after
        /// having been below it (a respawn).
        /// </summary>
        private void RepairIfRestored(SimAircraft a)
        {
            if (!Damage.Active)
            {
                damageLowestHealth = double.PositiveInfinity;
                return;
            }
            damageLowestHealth = Math.Min(damageLowestHealth, a.Health);
            if (a.Health >= a.MaxHealth && damageLowestHealth < a.MaxHealth - 0.1)
            {
                Damage.Reset();
                damageLowestHealth = double.PositiveInfinity;
            }
        }

        /// <summary>The airframe's root GameObject (its glTF parts), for the showcase's layer and picking.</summary>
        public Transform ModelRoot => model?.Root;

        /// <summary>Hidden altogether (a parked AI airframe).</summary>
        public void Hide()
        {
            model?.SetVisible(false);
        }

        /// <summary>The bent and torn airframe in place of the whole one, at the aircraft's pose.</summary>
        private void DrawRoot(Vec3d position, Quatd quaternion, Vec3d camera)
        {
            if (!Damage.Active) return;
            if (!ReferenceEquals(rootData, Damage.Root))
            {
                FreeRoot();
                rootData = Damage.Root;
                rootMeshes = WreckView.BuildMeshes(rootData);
            }
            Matrix4x4 m = SceneFrame.TileMatrix(position, camera, quaternion, 1);
            foreach ((Mesh mesh, Material mat) in rootMeshes)
            {
                if (mat == null) continue;
                Graphics.RenderMesh(new RenderParams(mat) { shadowCastingMode = ShadowCastingMode.On, receiveShadows = true }, mesh, 0, m);
            }
        }

        private void FreeRoot()
        {
            if (rootMeshes != null)
            {
                foreach ((Mesh mesh, _) in rootMeshes) UnityEngine.Object.Destroy(mesh);
            }
            rootMeshes = null;
            rootData = null;
        }

        public void Destroy()
        {
            FreeRoot();
            model?.Destroy();
            model = null;
            fx.Dispose();
        }
    }
}
