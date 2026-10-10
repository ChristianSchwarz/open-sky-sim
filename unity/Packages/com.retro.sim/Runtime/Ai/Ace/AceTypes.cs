using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// Ace engagement posture. Unlike Shaw's fair Offensive/Neutral/Defensive
    /// matrix or Aggressive's never-retreat Attack/Merge/Counter, the Ace doctrine
    /// adds a deliberate RESET: a true ace *does* trade angles for energy when it
    /// is losing the energy fight, then comes back down on the bandit from above
    /// instead of grinding out a losing low-speed turn circle.
    /// </summary>
    public enum AceState
    {
        /// <summary>We own the angles: bandit in front, inside our control zone.</summary>
        CONTROL,
        /// <summary>Neutral / head-on / out of the control zone.</summary>
        MERGE,
        /// <summary>Bandit is tracking us from the rear hemisphere in range.</summary>
        EVADE,
        /// <summary>Deliberate energy rebuild — extend/zoom, then re-attack from above.</summary>
        RESET,
    }

    public enum AceManeuverType
    {
        // CONTROL — converting angles into a gun solution without overshooting.
        LEAD_PURSUIT,
        LAG_PURSUIT,
        HIGH_YO_YO,
        LOW_YO_YO,
        BARREL_ROLL_ATTACK,
        // MERGE — the ace answer to a neutral pass is always the vertical.
        LEAD_TURN,
        VERTICAL_REPOSITION,
        HEAD_ON_SNAPSHOT,
        // EVADE — defeat the tracking solution, ideally by making them overshoot.
        BREAK_TURN,
        DEFENSIVE_SPIRAL,
        ROLLING_SCISSORS,
        COBRA_BRAKE,
        KULBIT,
        // RESET — buy back energy height, keeping the bandit in sight.
        ZOOM_CLIMB,
        SPLIT_S,
    }

    /// <summary>
    /// Post-stall maneuver ("PSM") request. These are the signature moves of the
    /// genre's ace pilots and cannot be expressed as an <see cref="IFlightSetpoint"/>:
    /// they are open-loop, timed, deliberately-departed-from-controlled-flight
    /// sequences that the <see cref="FlightControlComputer"/> closed loops would
    /// immediately fight. The FSM only *requests* one; the pilot vetoes it on
    /// altitude / airspeed / cooldown grounds (see <see cref="AceAiPilot"/>).
    /// </summary>
    public enum PostStallRequest
    {
        /// <summary>Pugachev's Cobra: airbrake + full aft stick to bleed speed and make a closing bandit overshoot.</summary>
        COBRA,
        /// <summary>Kulbit: a full max-G backflip in place, snapping the nose back onto a bandit that just slid past.</summary>
        KULBIT,
    }

    /// <summary>Snapshot plus the target acceleration the ballistic gun solution needs.</summary>
    public sealed class AceSnapshot : AircraftSnapshot
    {
        /// <summary>World-frame acceleration (m/s^2), estimated by finite difference.</summary>
        public Vec3d Acceleration;
    }

    /// <summary>
    /// High-level setpoints from <see cref="AceTacticalFSM"/>. Field-compatible with
    /// Shaw's <see cref="FlightCommand"/> and Aggressive's
    /// <see cref="AggressiveFlightCommand"/> so the same <see cref="FlightControlComputer"/>
    /// consumes it, plus <see cref="PostStall"/>, which only the Ace pilot knows how to fly.
    /// </summary>
    public sealed class AceFlightCommand : IFlightSetpoint
    {
        public AceState StateName;
        public AceManeuverType ManeuverName;
        /// <summary>World-space aim direction the nose should track.</summary>
        public Vec3d TargetDirection { get; set; }
        /// <summary>Desired airspeed (m/s).</summary>
        public double TargetSpeed { get; set; }
        /// <summary>Preferred load factor hint (g); FCC soft-limits against airframe.</summary>
        public double TargetGForce;
        /// <summary>When true, cut throttle hard (stand-in for speedbrakes).</summary>
        public bool UseAirbrakes { get; set; }
        /// <summary>Gun envelope per tactical geometry; the pilot still needs a ballistic solution to shoot.</summary>
        public bool FireGuns;
        /// <summary>Allow the hard-turn pull when angular error is large.</summary>
        public bool AllowHardTurn { get; set; }
        /// <summary>Requested post-stall maneuver, subject to the pilot's veto.</summary>
        public PostStallRequest? PostStall;
    }
}
