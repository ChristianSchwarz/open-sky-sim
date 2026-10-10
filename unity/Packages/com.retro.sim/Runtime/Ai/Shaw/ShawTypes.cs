using Retro.Core;

namespace Retro.Sim
{
    /// <summary>High-level Shaw engagement posture (Fighter Combat Ch. 2–3).</summary>
    public enum TacticalState
    {
        OFFENSIVE,
        NEUTRAL,
        DEFENSIVE,
    }

    public enum ManeuverType
    {
        // Offensive
        LEAD_PURSUIT,
        PURE_PURSUIT,
        LAG_PURSUIT,
        HIGH_YO_YO,
        LOW_YO_YO,
        // Neutral
        LEAD_TURN,
        ENERGY_CLIMB,
        HEAD_ON_ENGAGE,
        // Defensive
        BREAK_TURN,
        DEFENSIVE_SPIRAL,
        FLAT_SCISSORS,
    }

    /// <summary>Snapshot of one aircraft for geometry / FSM evaluation (plain data).</summary>
    public class AircraftSnapshot
    {
        public Vec3d Position;
        public Vec3d Velocity;
        public Vec3d Forward;
        public Vec3d Up;
        public Vec3d Right;
        public double Altitude;
        public double Airspeed;
        /// <summary>Optimal turn speed (m/s).</summary>
        public double CornerVelocity;
        public double MaxG;
    }

    public struct TacticalGeometry
    {
        public double Range;
        /// <summary>Unit LOS from self → target.</summary>
        public Vec3d LosVector;
        /// <summary>Angle off target's tail (rad): 0 = dead six, π = head-on.</summary>
        public double Aot;
        /// <summary>Aspect of target on self (rad): 0 = enemy on our six. Alias of their tracking.</summary>
        public double Taa;
        /// <summary>Antenna train angle / nose-to-LOS (rad).</summary>
        public double Ata;
        /// <summary>Positive = closing (m/s).</summary>
        public double ClosureRate;
        /// <summary>Self Es − target Es (energy height, m).</summary>
        public double EnergyDelta;
        public double SelfEs;
        public double TargetEs;
    }

    /// <summary>
    /// High-level setpoints from the tactical FSM. The Flight Control Computer
    /// turns these into stick/throttle — tactics never write surfaces directly.
    /// </summary>
    public sealed class FlightCommand : IFlightSetpoint
    {
        public TacticalState StateName;
        public ManeuverType ManeuverName;
        /// <summary>World-space aim direction the nose should track.</summary>
        public Vec3d TargetDirection { get; set; }
        /// <summary>Desired airspeed (m/s).</summary>
        public double TargetSpeed { get; set; }
        /// <summary>Preferred load factor hint (g); FCC soft-limits against airframe.</summary>
        public double TargetGForce;
        /// <summary>When true, cut throttle hard (stand-in for speedbrakes).</summary>
        public bool UseAirbrakes { get; set; }
        public bool FireGuns;
        /// <summary>Allow the hard-turn pull when angular error is large.</summary>
        public bool AllowHardTurn { get; set; }
    }
}
