using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// High-level Aggressive ("Berserker") posture. Unlike Shaw's
    /// Offensive/Neutral/Defensive matrix there is no defensive posture: a
    /// tracking threat is answered with SCISSORS_COUNTER (turn into the threat),
    /// never a break-away or disengage.
    /// </summary>
    public enum AggressiveState
    {
        ATTACK,
        MERGE,
        COUNTER,
    }

    public enum AggressiveManeuverType
    {
        // Attack (bandit roughly in front, in range)
        LEAD_PURSUIT,
        HIGH_YO_YO,
        // Merge (neutral / head-on)
        HEAD_ON_PRESS,
        POST_MERGE_REVERSAL,
        // Counter (bandit tracking us from the rear — never a break/extend)
        SCISSORS_COUNTER,
    }

    /// <summary>
    /// High-level setpoints from <see cref="AggressiveTacticalFSM"/>. Shares its field
    /// shape with Shaw's <see cref="FlightCommand"/> so it can be consumed by the
    /// same reused <see cref="FlightControlComputer"/>, but keeps its own
    /// state/maneuver enums since the Aggressive doctrine's states and maneuvers
    /// are distinct from Shaw's.
    /// </summary>
    public sealed class AggressiveFlightCommand : IFlightSetpoint
    {
        public AggressiveState StateName;
        public AggressiveManeuverType ManeuverName;
        /// <summary>World-space aim direction the nose should track.</summary>
        public Vec3d TargetDirection { get; set; }
        /// <summary>Desired airspeed (m/s).</summary>
        public double TargetSpeed { get; set; }
        /// <summary>Preferred load factor hint (g); FCC soft-limits against airframe.</summary>
        public double TargetGForce;
        /// <summary>When true, cut throttle hard (stand-in for speedbrakes). Aggressive never sets this.</summary>
        public bool UseAirbrakes { get; set; }
        public bool FireGuns;
        /// <summary>Allow the hard-turn pull when angular error is large.</summary>
        public bool AllowHardTurn { get; set; }
    }
}
