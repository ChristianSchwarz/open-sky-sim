using System;
using Retro.Core;
using Retro.Game;
using Retro.Sim;

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
        public void Draw(SimAircraft aircraft, Vec3d camera, double dt, bool visible, WingSweepMode sweepMode)
        {
            if (Def == null) return;
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
                    model.Pose(aircraft.GetPosition(), aircraft.GetQuaternion(), camera, new AircraftPoseInputs
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
                    });
                }
            }
            fx.BindTips(model);
            fx.Draw(new AircraftFxInput
            {
                ThrottleLever = aircraft.GetThrottle(),
                AbDetents = aircraft.Model.UseAfterburnerThrottleDetents,
                Position = aircraft.GetPosition(),
                Quaternion = aircraft.GetQuaternion(),
                Velocity = aircraft.GetVelocity(),
                WingSweep = sweepUnit,
            }, camera);
        }

        /// <summary>Hidden altogether (a parked AI airframe).</summary>
        public void Hide()
        {
            model?.SetVisible(false);
        }

        public void Destroy()
        {
            model?.Destroy();
            model = null;
            fx.Dispose();
        }
    }
}
