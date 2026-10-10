using System;
using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    public sealed class FighterTacticalFsmOptions
    {
        public double? GunRange;
        public double? OvershootVc;
        public double? CombatSpeed;
        public double? MaxSpeed;
    }

    /// <summary>
    /// Shaw Fighter Combat tactical FSM: Offensive / Neutral / Defensive postures
    /// with pursuit curves, yo-yos, lead turn, scissors, and defensive spiral.
    /// Outputs <see cref="FlightCommand"/> setpoints only — never stick inputs.
    /// </summary>
    public sealed class FighterTacticalFSM
    {
        private TacticalState currentState = TacticalState.NEUTRAL;
        private double maneuverTimer;
        private ManeuverType? latchedManeuver;

        private readonly double gunMaxRange;
        private readonly double overshootVc;
        private readonly double combatSpeed;
        private readonly double maxSpeed;

        public FighterTacticalFSM(FighterTacticalFsmOptions options = null)
        {
            options ??= new FighterTacticalFsmOptions();
            gunMaxRange = options.GunRange ?? 900;
            overshootVc = options.OvershootVc ?? 80;
            combatSpeed = options.CombatSpeed ?? 200;
            maxSpeed = options.MaxSpeed ?? 240;
        }

        public TacticalState GetState() => currentState;

        /// <summary>Seconds accumulated across updates (kept from the TypeScript; nothing reads it yet).</summary>
        public double ManeuverTimer => maneuverTimer;

        public string GetManeuverLabel() => latchedManeuver?.ToString() ?? currentState.ToString();

        public FlightCommand Update(AircraftSnapshot self, AircraftSnapshot target, double delta)
        {
            TacticalGeometry geom = ShawGeometry.ComputeTacticalGeometry(self, target);
            currentState = EvaluateState(geom);
            maneuverTimer += delta;

            switch (currentState)
            {
                case TacticalState.OFFENSIVE:
                    return ExecuteOffensive(self, target, geom);
                case TacticalState.DEFENSIVE:
                    return ExecuteDefensive(self, target, geom);
                case TacticalState.NEUTRAL:
                default:
                    return ExecuteNeutral(self, target, geom);
            }
        }

        private static TacticalState EvaluateState(TacticalGeometry geom) => ClassifyTacticalState(geom);

        private FlightCommand ExecuteOffensive(AircraftSnapshot self, AircraftSnapshot target, TacticalGeometry geom)
        {
            ManeuverType maneuver = ManeuverType.PURE_PURSUIT;
            Vec3d dir = geom.LosVector;
            double throttleSpeed = combatSpeed;
            bool useAirbrakes = false;
            double targetG = self.MaxG;
            bool allowHardTurn = true;

            // High Yo-Yo: imminent overshoot (Shaw p. 71).
            if (geom.ClosureRate > overshootVc && geom.Range < 1200)
            {
                maneuver = ManeuverType.HIGH_YO_YO;
                dir = Normalize(geom.LosVector.AddScaled(self.Up, 0.7));
                throttleSpeed = combatSpeed * 0.85;
                allowHardTurn = false;
            }
            // Low Yo-Yo: close distance while cutting the circle (Shaw p. 73).
            else if (geom.Range > 1500 && geom.Range < 3000 && geom.EnergyDelta > -200)
            {
                maneuver = ManeuverType.LOW_YO_YO;
                dir = Normalize(geom.LosVector.AddScaled(self.Up, -0.5));
                throttleSpeed = Math.Min(maxSpeed, combatSpeed * 1.1);
                targetG = 2.0;
                allowHardTurn = false;
            }
            // Guns: lead pursuit.
            else if (geom.Range <= gunMaxRange)
            {
                maneuver = ManeuverType.LEAD_PURSUIT;
                double tof = geom.Range / 800;
                Vec3d lead = target.Position.AddScaled(target.Velocity, tof);
                dir = Normalize(lead - self.Position);
            }
            // Lag when ATA is large to avoid overshoot.
            else if (geom.Ata > 30 * Math.PI / 180)
            {
                maneuver = ManeuverType.LAG_PURSUIT;
                dir = Normalize(geom.LosVector.AddScaled(target.Forward, -0.3));
            }

            latchedManeuver = maneuver;
            bool fireGuns = geom.Range <= gunMaxRange && geom.Ata < 8 * Math.PI / 180
                && (maneuver == ManeuverType.LEAD_PURSUIT || maneuver == ManeuverType.PURE_PURSUIT);

            return new FlightCommand
            {
                StateName = TacticalState.OFFENSIVE,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = throttleSpeed,
                TargetGForce = targetG,
                UseAirbrakes = useAirbrakes,
                FireGuns = fireGuns,
                AllowHardTurn = allowHardTurn,
            };
        }

        private FlightCommand ExecuteNeutral(AircraftSnapshot self, AircraftSnapshot target, TacticalGeometry geom)
        {
            ManeuverType maneuver = ManeuverType.HEAD_ON_ENGAGE;
            Vec3d dir = geom.LosVector;
            double throttleSpeed = combatSpeed;

            // Lead turn before the merge (Shaw p. 74).
            if (geom.Range < 2000 && geom.Aot > 120 * Math.PI / 180)
            {
                maneuver = ManeuverType.LEAD_TURN;
                double side = self.Airspeed > target.Airspeed ? 1 : -1;
                dir = Normalize(geom.LosVector.AddScaled(target.Right, side));
            }
            else if (geom.EnergyDelta < -500)
            {
                maneuver = ManeuverType.ENERGY_CLIMB;
                dir = Normalize(geom.LosVector + new Vec3d(0, 0.5, 0));
                throttleSpeed = Math.Min(maxSpeed, combatSpeed * 1.05);
            }

            latchedManeuver = maneuver;
            return new FlightCommand
            {
                StateName = TacticalState.NEUTRAL,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = throttleSpeed,
                TargetGForce = self.MaxG * 0.8,
                UseAirbrakes = false,
                FireGuns = geom.Range <= gunMaxRange && geom.Ata < 5 * Math.PI / 180,
                AllowHardTurn = true,
            };
        }

        private FlightCommand ExecuteDefensive(AircraftSnapshot self, AircraftSnapshot target, TacticalGeometry geom)
        {
            ManeuverType maneuver;
            Vec3d dir;
            double throttleSpeed;
            bool useAirbrakes = false;

            if (geom.Range < 1200)
            {
                maneuver = ManeuverType.BREAK_TURN;
                bool breakRight = Vec3d.Dot(self.Right, geom.LosVector) > 0;
                Vec3d tmp = self.Right * (breakRight ? 1 : -1);
                dir = Normalize(self.Forward.AddScaled(tmp, 2.0));
                throttleSpeed = combatSpeed;
            }
            else if (self.Airspeed < self.CornerVelocity && self.Altitude > 1000)
            {
                maneuver = ManeuverType.DEFENSIVE_SPIRAL;
                dir = new Vec3d(0, -0.8, 0).AddScaled(self.Right, 0.5);
                dir = Normalize(dir + self.Forward);
                throttleSpeed = Math.Min(maxSpeed, combatSpeed * 1.1);
            }
            else
            {
                // Flat scissors (Shaw pp. 82–92): cut speed to force bandit ahead.
                maneuver = ManeuverType.FLAT_SCISSORS;
                useAirbrakes = self.Airspeed > target.Airspeed;
                throttleSpeed = useAirbrakes ? self.CornerVelocity * 0.7 : self.CornerVelocity;
                Vec3d reverse = Vec3d.Dot(self.Right, target.Forward) > 0
                    ? -self.Right
                    : self.Right;
                dir = Normalize(self.Forward + reverse);
            }

            latchedManeuver = maneuver;
            return new FlightCommand
            {
                StateName = TacticalState.DEFENSIVE,
                ManeuverName = maneuver,
                TargetDirection = dir,
                TargetSpeed = throttleSpeed,
                TargetGForce = self.MaxG,
                UseAirbrakes = useAirbrakes,
                FireGuns = false,
                AllowHardTurn = true,
            };
        }

        /// <summary>State classification (shared by the FSM and unit tests).</summary>
        public static TacticalState ClassifyTacticalState(TacticalGeometry geom)
        {
            // Defensive: bandit is in our rear hemisphere AND tracking us.
            // (TAA alone is also small in a head-on pass — require ATA > 120° so
            // the threat is actually on our six, not merging from the front.)
            if (geom.Taa < 60 * Math.PI / 180
                && geom.Ata > 120 * Math.PI / 180
                && geom.Range < 2500)
            {
                return TacticalState.DEFENSIVE;
            }
            // Offensive: we are on their six inside engagement range.
            if (geom.Aot < 60 * Math.PI / 180 && geom.Range < 4000)
            {
                return TacticalState.OFFENSIVE;
            }
            return TacticalState.NEUTRAL;
        }
    }
}
