using System;
using System.Collections.Generic;
using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    /// <summary>
    /// Hierarchical flight phases. Mission logic sets high-level setpoints (heading,
    /// altitude, speed); a shared inner controller layer turns those into normalized
    /// stick/throttle. A terrain/obstacle safety layer can pre-empt any airborne
    /// phase (see <see cref="AiPilot.Update"/>).
    /// </summary>
    public enum AiFlightPhase
    {
        GROUND_IDLE,
        TAKEOFF_ROLL,
        CLIMB_OUT,
        NAVIGATE,
        /// <summary>Hold current heading/altitude/speed until mission logic promotes to ENGAGE.</summary>
        STRAIGHT,
        ENGAGE,
        RTB,
        APPROACH,
        FLARE,
        ROLLOUT,
        /// <summary>
        /// Fly formation on the lead set by <see cref="AiPilot.SetFormationLead"/> — the
        /// wingman phase. Rejoins from any separation, holds a wing slot once
        /// settled, and peels off into ENGAGE the moment a live target is assigned
        /// (returning here when that target is gone).
        ///
        /// Appended last on purpose: the phase crosses the worker boundary as a raw
        /// ordinal, so existing values must not shift.
        /// </summary>
        FORMATION,
    }

    public sealed class AiPilotOptions
    {
        /// <summary>Cruise/patrol altitude (m).</summary>
        public double? CruiseAltitude;
        /// <summary>Cruise/patrol speed (m/s).</summary>
        public double? CruiseSpeed;
        /// <summary>Combat speed target (m/s).</summary>
        public double? CombatSpeed;
        /// <summary>Hard speed ceiling (m/s) the AI keeps below to avoid the transonic ring.</summary>
        public double? MaxSpeed;
        /// <summary>Muzzle velocity used for the gun lead solution (m/s).</summary>
        public double? BulletSpeed;
        /// <summary>Max slant range at which the AI opens fire (m).</summary>
        public double? GunRange;
        /// <summary>Minimum altitude above local terrain the AI will let itself get to (m).</summary>
        public double? HardDeck;
        /// <summary>Optional pitch-loop tuning overrides (see the PITCH_* constants).</summary>
        public double? PitchKp;
        public double? PitchKd;
        public double? PitchSlew;
        /// <summary>Dogfight skill tier: reaction time, energy discipline, firing accuracy. Defaults to ACE.</summary>
        public AiSkillLevel? Skill;
        /// <summary>When true, the AI never disengages to rebuild energy (no EXTEND): it stays relentlessly on the attack.</summary>
        public bool? AlwaysEngage;
        /// <summary>
        /// Which AI pilot model to instantiate. Defaults to CLASSIC. Applied when the
        /// in-worker pilot is (re)built — typically on opponent spawn.
        /// </summary>
        public AiPilotModels? Model;
    }

    /// <summary>
    /// Dogfight skill tier. There is no other difficulty concept in the game, so
    /// this single knob is what makes an opponent easier or harder to beat: it
    /// scales how fast the AI notices a threat on its tail, how readily it bails
    /// out of a losing energy state instead of fighting on, and how tight its
    /// firing discipline is.
    /// </summary>
    public enum AiSkillLevel
    {
        ROOKIE,
        VETERAN,
        ACE,
    }

    /// <summary>
    /// Sub-states the <see cref="AiPilot"/> cycles through while in the ENGAGE phase.
    /// DoEngage() does not always fly a straight lead-pursuit intercept: it picks
    /// one of these each frame based on the current dogfight geometry (see
    /// UpdateDogfightMode).
    /// </summary>
    public enum DogfightMode
    {
        /// <summary>Lead-pursuit intercept — the common case when the geometry is flyable.</summary>
        PURSUE,
        /// <summary>Blended lead/lag aimpoint used when angle-off is too large for a clean lead turn.</summary>
        LAG_PURSUE,
        /// <summary>Pull above the flight path to bleed excess closure without losing energy.</summary>
        HIGH_YOYO,
        /// <summary>Trade altitude for turn rate/closure when energy allows cutting the corner.</summary>
        LOW_YOYO,
        /// <summary>Hard break turn into a tracking threat; not aiming at the target.</summary>
        DEFENSIVE_BREAK,
        /// <summary>Disengage on a clear heading to rebuild energy before re-engaging.</summary>
        EXTEND,
    }

    /// <summary>
    /// Echelon-right wing slot, measured in the lead's horizontal frame: aft, out to
    /// the side, and stacked slightly low so the wingman is visible from the lead's
    /// cockpit and its wake stays clear of the lead. Public so a wingman can be
    /// *spawned* onto the same slot its pilot will then fly.
    /// </summary>
    public static class FormationSlot
    {
        /// <summary>Metres behind the lead.</summary>
        public const double Trail = 70;
        /// <summary>Metres to the lead's right.</summary>
        public const double Side = 45;
        /// <summary>Metres above the lead (negative = stacked low).</summary>
        public const double Stack = -12;
    }

    /// <summary>Classic BFM AI pilot (port of ai/aiPilot.ts).</summary>
    public sealed class AiPilot : IAiPilotController
    {
        private readonly struct SkillTuning
        {
            /// <summary>Seconds a threat must be sustained before the AI reacts with a break turn.</summary>
            public readonly double DefensiveReactTime;
            /// <summary>Energy-height deficit (m) vs. the target that triggers an extend/disengage.</summary>
            public readonly double ExtendEnergyDeficit;
            /// <summary>
            /// Multiplier on the allowed predicted miss distance before pulling the
            /// trigger. ACE only fires when the round will pass within roughly the
            /// target's hit sphere (tight, lethal bursts); lower tiers spray at
            /// solutions that mostly miss.
            /// </summary>
            public readonly double MissAllowanceMult;

            public SkillTuning(double defensiveReactTime, double extendEnergyDeficit, double missAllowanceMult)
            {
                DefensiveReactTime = defensiveReactTime;
                ExtendEnergyDeficit = extendEnergyDeficit;
                MissAllowanceMult = missAllowanceMult;
            }
        }

        private static readonly Dictionary<AiSkillLevel, SkillTuning> SKILL_TUNING = new Dictionary<AiSkillLevel, SkillTuning>
        {
            [AiSkillLevel.ROOKIE] = new SkillTuning(1.2, 650, 2.5),
            [AiSkillLevel.VETERAN] = new SkillTuning(0.6, 450, 1.5),
            [AiSkillLevel.ACE] = new SkillTuning(0.25, 300, 1.0),
        };

        // --- Controller gains / limits -------------------------------------------------
        // The FM2 roll axis is rate-commanded (stick position sets roll RATE), so the
        // bank-hold loop is proportional only: rollCmd = K * bankError drives the bank
        // error to zero as a stable first-order response. (A derivative term here fights
        // the plant's own integrator and produces a bang-bang limit cycle.)
        private const double ROLL_KP = 2.2;                 // bank error (rad) -> roll command (snappy combat rolls)
        private const double ROLL_YAW_COORD = 0.05;         // coordinating rudder as a fraction of bank
        private const double BANK_PER_HEADING = 2.5;        // heading error (rad) -> desired bank (rad); hit max bank ~34° off
        private const double HEADING_DEADBAND = 1.0 * Math.PI / 180;  // ignore sub-degree heading error
        // Near +/-180 deg the shortest-turn sign chatters frame-to-frame, which makes
        // the bank command flip and the aircraft rock instead of committing to the
        // reversal. Latch a turn direction on entry and release once well clear.
        private const double TURN_LATCH_ENTER = 150 * Math.PI / 180;
        private const double TURN_LATCH_RELEASE = 110 * Math.PI / 180;
        private const double RATE_EMA = 0.35;               // low-pass factor for finite-difference attitude rates
        // Keep the nose out of the near-vertical regime where heading/bank (derived from
        // the body axes' vertical components) go singular and the roll loop thrashes.
        private const double MAX_ELEV_CMD = 55 * Math.PI / 180;
        private const double MAX_BANK_NAV = 45 * Math.PI / 180;
        private const double MAX_BANK_COMBAT = 85 * Math.PI / 180;  // near knife-edge for min turn radius
        private const double MAX_BANK_APPROACH = 25 * Math.PI / 180;
        /// <summary>Best sustained-turn airspeed (m/s). Faster = huge circles the player can sit in.</summary>
        private const double CORNER_SPEED = 180;
        /// <summary>Angle-off above which pursuit bleeds toward corner speed for a tighter turn.</summary>
        private const double CORNER_SPEED_AO = 35 * Math.PI / 180;

        private const double PITCH_KP = 1.0;                // pitch-angle error (rad) -> pitch command
        // No AI pitch-RATE damping by default: the FM2 FCS already damps the short period
        // internally, and feeding back a laggy finite-difference attitude rate here only
        // adds phase lag that turns into a pilot-induced pitch oscillation. Left tunable
        // for airframes/configs that need a little extra.
        private const double PITCH_KD = 0;                  // pitch rate (rad/s) -> pitch command (damping)
        // Slew-rate limit the pitch command (per second) so the AI cannot inject inputs
        // near the airframe's short-period frequency (a PIO guard).
        private const double PITCH_CMD_SLEW = 3.0;          // max change in pitch command per second
        private const double VS_TO_PITCH = 0.02;            // vertical-speed error (m/s) -> pitch command
        private const double VS_PER_ALT = 0.06;             // altitude error (m) -> desired vertical speed (m/s)
        private const double MAX_VS = 120;                  // clamp on commanded vertical speed (m/s)
        private const double PITCH_MIN = -0.6;
        private const double PITCH_MAX = 0.9;

        private const double THROTTLE_KP = 0.02;            // speed error (m/s) -> throttle rate (1/s)
        // Overspeed protection. The FM2 airframe develops a lightly-damped transonic
        // short-period that goes into a violent load-factor limit cycle (it rings even
        // hands-off) above ~Mach 0.8, so the AI actively keeps its energy below that
        // regime: it caps commanded speed, snaps the throttle to idle when fast, and —
        // crucially, since throttle alone cannot arrest a dive — refuses to hold the nose
        // down while overspeeding so the climb bleeds the excess speed back off. This is
        // a mitigation for an airframe/aero characteristic, not a flight-model fix.
        private const double MAX_SPEED = 240;               // speed ceiling (m/s); ring onset is ~250+ m/s
        private const double OVERSPEED_IDLE_MARGIN = 8;     // hard-idle the throttle this far over the cap
        private const double OVERSPEED_ELEV_GAIN = 0.02;    // overspeed (m/s) -> min nose-up angle (rad)
        private const double OVERSPEED_ELEV_MAX = 0.4;      // cap on the overspeed nose-up floor (rad)

        private const double ROTATE_SPEED = 90;             // takeoff rotation speed (m/s)
        private const double GEAR_UP_ALT = 40;              // retract gear above this AGL (m)
        private const double FLAPS_UP_SPEED = 150;          // retract flaps above this speed (m/s)

        private const double FIRE_MISS_SLACK_M = 3;
        private const double TERRAIN_LOOKAHEAD_S = 8;       // predictive GPWS horizon (s)

        // --- Max-performance turn ("hard turn") -----------------------------------------
        // The heading/elevation cascade is a cruise autopilot (~2 g). Whenever the aim
        // point is far off the nose the AI flies a proper BFM turn instead: roll toward
        // max bank, pull near the pitch limit, hand back to fine tracking once aligned.
        private const double HARD_TURN_ENTER = 8 * Math.PI / 180;
        private const double HARD_TURN_EXIT = 5 * Math.PI / 180;
        private const double HARD_TURN_FULL_PULL_ANGLE = 45 * Math.PI / 180;
        private const double HARD_TURN_MIN_PULL = 0.45;
        private const double HARD_TURN_BANK_GAIN = 5.5;
        private const double REVERSAL_LATCH_ENTER = 150 * Math.PI / 180;
        private const double REVERSAL_LATCH_RELEASE = 110 * Math.PI / 180;

        // --- Gun lead / target prediction ------------------------------------------------
        private const double TARGET_ACCEL_CAP = 90;         // ~9 g (m/s^2)
        private const double TARGET_ACCEL_EMA = 0.25;

        // --- Dogfight mode thresholds --------------------------------------------------
        // A tracking threat is them pointed at us from our rear hemisphere. Without the
        // rear-hemisphere gate a head-on merge reads as a threat and the AI breaks
        // away, donating its six on every neutral merge.
        private const double DEFENSIVE_AOT_THRESHOLD = 35 * Math.PI / 180;
        private const double DEFENSIVE_CLEAR_AOT = 55 * Math.PI / 180;
        private const double DEFENSIVE_REAR_HEMISPHERE = 90 * Math.PI / 180;
        private const double DEFENSIVE_REAR_CLEAR = 75 * Math.PI / 180;
        private const double DEFENSIVE_RANGE_MULT = 1.2;
        private const double DEFENSIVE_CLEAR_RANGE_MULT = 1.5;

        private const double YOYO_RANGE_TRIGGER = 350;
        private const double YOYO_CLOSURE_TRIGGER = 90;
        private const double HIGH_YOYO_PITCH_BONUS = 25 * Math.PI / 180;  // extra nose-up bias during a high yo-yo
        private const double HIGH_YOYO_DURATION = 3.0;              // s, runs to completion once triggered
        private const double HIGH_YOYO_MAX_BANK_MULT = 0.6;         // reduced bank during a high yo-yo (repositioning, not tracking)

        private const double LOW_YOYO_ANGLE_OFF_TRIGGER = 130 * Math.PI / 180;  // angle-off beyond which a lead turn is unflyable
        private const double LOW_YOYO_ENERGY_EDGE = 150;            // need at least this much of an energy edge (m) to spend it
        private const double LOW_YOYO_PITCH_DROP = 15 * Math.PI / 180;    // nose-down bias to cut across the turn circle
        private const double LOW_YOYO_DURATION = 2.5;               // s

        // Stay in aggressive lead pursuit longer — lag pursuit was flying large circles
        // instead of cutting inside to get guns on. Only lag when the lead point is truly
        // unflyable (near reverse).
        private const double LAG_ANGLE_OFF_TRIGGER = 125 * Math.PI / 180;
        private const double LAG_BLEND_MAX = 0.55;

        private const double EXTEND_MIN_DURATION = 2.0;             // s, avoids instantly flip-flopping back into a losing fight
        private const double EXTEND_RECOVER_MARGIN = 150;           // resume pursuit once within this much of the target's energy (m)

        // --- Formation (wingman) -------------------------------------------------------
        // Rejoin (fly *at* the slot) vs. station-keeping (fly the lead's heading and
        // trim out the residual offsets). Hysteresis, or the controller switches
        // steering law every frame while sitting on the boundary.
        private const double FORMATION_REJOIN_ENTER_M = 600;
        private const double FORMATION_REJOIN_RELEASE_M = 350;
        /// <summary>Overtake speed allowed while closing on the slot (m/s over the lead).</summary>
        private const double FORMATION_REJOIN_OVERTAKE = 60;
        /// <summary>Cross-track error (m) -> heading offset from the lead's heading (rad/m).</summary>
        private const double FORMATION_HEADING_PER_CROSS = 0.0016;
        private const double FORMATION_MAX_HEADING_OFFSET = 20 * Math.PI / 180;
        /// <summary>
        /// Along-track station keeping: proportional on the position error, damped by the
        /// closing rate. The damping term is not optional — the inner speed loop (throttle
        /// integrator + airframe) lags the position loop badly, and a P-only outer loop
        /// limit-cycles: it overshoots the slot, brakes, sinks, accelerates, climbs, and
        /// repeats with a ~45 s period that never settles.
        /// </summary>
        private const double FORMATION_SPEED_PER_ALONG = 0.20;
        private const double FORMATION_SPEED_PER_CLOSURE = 0.8;
        private const double FORMATION_SPEED_TRIM = 25;
        private const double FORMATION_MAX_BANK = 60 * Math.PI / 180;
        /// <summary>
        /// Below this lead speed (m/s) there is no formation to fly — the lead is parked
        /// or rolling out. Hold overhead instead of descending to sit on a stationary
        /// slot.
        /// </summary>
        private const double FORMATION_LEAD_MIN_SPEED = 50;
        /// <summary>Beyond this, holding overhead first closes the distance to the lead.</summary>
        private const double FORMATION_HOLD_RECENTER_M = 2500;
        /// <summary>
        /// Speedbrake thresholds (m/s over the commanded speed) for station keeping.
        /// Idle thrust alone does not slow a clean airframe down at altitude — without
        /// the brake the wingman creeps forward past the slot, and once it is ahead the
        /// heading loop cannot recover the along-track error. Hysteresis so the boards
        /// don't cycle in and out every frame.
        /// </summary>
        private const double FORMATION_AIRBRAKE_ENTER = 8;
        private const double FORMATION_AIRBRAKE_RELEASE = 3;
        /// <summary>
        /// Integral trim (m) on the commanded slot altitude. The shared altitude hold
        /// ends in a proportional-only pitch-attitude loop, which droops: a standing
        /// climb demand settles with the nose short of the commanded angle and the
        /// aircraft stabilises ~150 m below its target. Every phase lives with that, but
        /// on a wing slot it reads as the wingman flying visibly low, so formation
        /// integrates the residual away. Bounded for anti-windup.
        /// </summary>
        private const double FORMATION_ALT_TRIM_RATE = 0.03;
        private const double FORMATION_ALT_TRIM_MAX = 400;

        private readonly IPilotableAircraft aircraft;
        private readonly IWorldQuery world;

        private AiFlightPhase phase = AiFlightPhase.NAVIGATE;
        /// <summary>The runway this pilot committed to; see <see cref="HomeRunway"/>.</summary>
        private Runway runwayChoice;
        private ICombatant target;

        private readonly double cruiseAltitude;
        private readonly double cruiseSpeed;
        private readonly double combatSpeed;
        private readonly double maxSpeed;
        private readonly double bulletSpeed;
        private readonly double gunRange;
        private readonly double hardDeck;
        private readonly double pitchKp;
        private readonly double pitchKd;
        private readonly double pitchSlew;
        private readonly AiSkillLevel skill;
        private readonly SkillTuning skillTuning;
        /// <summary>When true, the AI never enters EXTEND (never turns tail to rebuild energy).</summary>
        private readonly bool alwaysEngage;

        /// <summary>Latest throttle command (integrated by the speed controller).</summary>
        private double throttleCmd = 0.5;
        /// <summary>Set true by the engage phase when a valid gun solution exists this frame.</summary>
        private bool firing;
        /// <summary>Previous frame had a valid gun solution (used to gate HIGH_YOYO).</summary>
        private bool hadSolution;
        /// <summary>Hard-turn latch: stay in max-performance turn until nearly aligned.</summary>
        private bool hardTurnActive;
        /// <summary>Reversal direction latch for near-180 deg turn commits.</summary>
        private double reversalDir;
        /// <summary>Pull-up override latch to add hysteresis to the GPWS.</summary>
        private bool pullUpActive;
        /// <summary>Latched turn direction (+1/-1/0) to resolve the +/-180 deg heading ambiguity.</summary>
        private double turnDir;

        /// <summary>Heading held while in STRAIGHT.</summary>
        private double straightHeading;
        private bool straightHeadingLatched;

        // --- Formation sub-state (FORMATION phase only) ---------------------------
        /// <summary>Aircraft whose wing this pilot flies, when acting as a wingman.</summary>
        private ICombatant formationLead;
        /// <summary>Latched rejoin/station-keeping mode (see FORMATION_REJOIN_* thresholds).</summary>
        private bool formationRejoining = true;
        /// <summary>Latched speedbrake state while holding a slot (see FORMATION_AIRBRAKE_*).</summary>
        private bool formationAirbrakes;
        /// <summary>Integral trim on the commanded slot altitude (see FORMATION_ALT_TRIM_*).</summary>
        private double formationAltTrim;

        // --- Dogfight sub-state (ENGAGE phase only) -------------------------------
        private DogfightMode dogfightMode = DogfightMode.PURSUE;
        /// <summary>Seconds the target has had a sustained tracking angle on us.</summary>
        private double threatTimer;
        /// <summary>Seconds spent in the current timed maneuver (HIGH_YOYO/LOW_YOYO/EXTEND).</summary>
        private double maneuverTimer;
        /// <summary>Low-passed target acceleration for gun-lead prediction.</summary>
        private Vec3d targetAcc;
        private Vec3d prevTvel;
        private bool hasPrevTvel;
        /// <summary>Last ballistic time-of-flight from the most recent aim computation (s).</summary>
        private double lastTof;

        // Pitch-rate estimate (finite-differenced, low-passed) for pitch-loop damping.
        private double prevNosePitch;
        private bool hasPrevAttitude;
        private double pitchRateEst;
        // Slew-limited pitch command state (see PITCH_CMD_SLEW).
        private double pitchCmdState;
        private double lastDelta = 1.0 / 60;

        // Per-frame state (the TypeScript's scratch vectors).
        private Vec3d pos;
        private Vec3d vel;
        private Quatd quat;
        private Vec3d fwd;
        private Vec3d right;
        private Vec3d up;
        private Vec3d tpos;
        private Vec3d tvel;
        private Vec3d aim;
        private Vec3d probe;
        private Vec3d toPoint;
        private Vec3d bulletVel;
        private Vec3d aimDir;
        private Vec3d lpos;
        private Vec3d lvel;
        private Vec3d slot;
        private Vec3d leadFwd;
        private Vec3d leadRight;
        private Vec3d toSlot;

        public AiPilot(IPilotableAircraft aircraft, IWorldQuery world, AiPilotOptions options = null)
        {
            options ??= new AiPilotOptions();
            this.aircraft = aircraft;
            this.world = world;
            cruiseAltitude = options.CruiseAltitude ?? 3000;
            cruiseSpeed = options.CruiseSpeed ?? 220;
            // Default stays near corner speed so pursuit doesn't open into huge circles.
            combatSpeed = options.CombatSpeed ?? 220;
            maxSpeed = options.MaxSpeed ?? MAX_SPEED;
            bulletSpeed = options.BulletSpeed ?? 1000;
            gunRange = options.GunRange ?? 900;
            hardDeck = options.HardDeck ?? 150;
            pitchKp = options.PitchKp ?? PITCH_KP;
            pitchKd = options.PitchKd ?? PITCH_KD;
            pitchSlew = options.PitchSlew ?? PITCH_CMD_SLEW;
            skill = options.Skill ?? AiSkillLevel.ACE;
            skillTuning = SKILL_TUNING[skill];
            alwaysEngage = options.AlwaysEngage ?? false;
        }

        public AiFlightPhase GetPhase() => phase;

        /// <summary>Current dogfight maneuver sub-state (only meaningful during ENGAGE).</summary>
        public DogfightMode GetDogfightMode() => dogfightMode;

        public string GetManeuverLabel()
        {
            if (phase != AiFlightPhase.ENGAGE)
            {
                return phase.ToString();
            }
            return dogfightMode.ToString();
        }

        public void SetPhase(AiFlightPhase phase)
        {
            this.phase = phase;
            if (phase == AiFlightPhase.STRAIGHT)
            {
                straightHeadingLatched = false;
            }
            if (phase == AiFlightPhase.RTB)
            {
                // Turning for home is the moment to decide where home is: by now
                // the aircraft may be a long way from where it took off, and the
                // nearest field is the one it should be going to.
                runwayChoice = null;
            }
            if (phase == AiFlightPhase.FORMATION)
            {
                // Enter via the rejoin law: a fresh formation assignment is almost
                // always from a separation, and it releases on its own once close.
                formationRejoining = true;
                formationAltTrim = 0;
            }
        }

        public void SetTarget(ICombatant target)
        {
            this.target = target;
        }

        public void SetFormationLead(ICombatant lead)
        {
            formationLead = lead;
        }

        /// <summary>True while a firing solution exists this frame (read after update).</summary>
        public bool IsFiring => firing;

        /// <summary>Begin an autonomous takeoff from the current runway.</summary>
        public void StartTakeoff()
        {
            phase = AiFlightPhase.TAKEOFF_ROLL;
        }

        // -------------------------------------------------------------------------

        public void Update(double delta)
        {
            firing = false;
            IPilotableAircraft ac = aircraft;
            if (ac.IsCrashed())
            {
                ac.SetThrottle(0);
                ac.SetWheelBrakes(true);
                return;
            }

            ReadState(delta);

            // Safety layer: predictive terrain/ground pull-up pre-empts any airborne
            // mission phase (but not deliberate ground contact near the runway).
            bool groundPhase = phase == AiFlightPhase.GROUND_IDLE
                || phase == AiFlightPhase.TAKEOFF_ROLL
                || phase == AiFlightPhase.FLARE
                || phase == AiFlightPhase.ROLLOUT;
            if (!groundPhase && UpdateTerrainAvoidance(delta))
            {
                return;
            }

            switch (phase)
            {
                case AiFlightPhase.GROUND_IDLE: DoGroundIdle(); break;
                case AiFlightPhase.TAKEOFF_ROLL: DoTakeoff(delta); break;
                case AiFlightPhase.CLIMB_OUT: DoClimbOut(delta); break;
                case AiFlightPhase.NAVIGATE: DoNavigate(delta); break;
                case AiFlightPhase.STRAIGHT: DoStraight(delta); break;
                case AiFlightPhase.FORMATION: DoFormation(delta); break;
                case AiFlightPhase.ENGAGE: DoEngage(delta); break;
                case AiFlightPhase.RTB: DoRtb(delta); break;
                case AiFlightPhase.APPROACH: DoApproach(delta); break;
                case AiFlightPhase.FLARE: DoFlare(delta); break;
                case AiFlightPhase.ROLLOUT: DoRollout(); break;
            }
        }

        // --- State ---------------------------------------------------------------

        private void ReadState(double delta)
        {
            lastDelta = delta > 1e-4 ? delta : lastDelta;
            pos = aircraft.GetPosition();
            vel = aircraft.GetVelocity();
            quat = aircraft.GetQuaternion();
            fwd = SimConstants.Forward.Rotate(quat);
            right = SimConstants.Right.Rotate(quat);
            up = SimConstants.Up.Rotate(quat);

            // Finite-difference attitude rates for loop damping (guard first frame /
            // tiny dt, and wrap the bank difference across the +/-pi seam).
            double nosePitch = NosePitch;
            if (hasPrevAttitude && delta > 1e-4)
            {
                double pitchRateRaw = (nosePitch - prevNosePitch) / delta;
                // Low-pass the finite-difference rate so the pitch damping term does
                // not chatter on the discrete-time signal.
                pitchRateEst += (pitchRateRaw - pitchRateEst) * RATE_EMA;
            }
            else
            {
                pitchRateEst = 0;
            }
            prevNosePitch = nosePitch;
            hasPrevAttitude = true;
        }

        private double Heading => JsTrig.Atan2(fwd.X, fwd.Z);

        /// <summary>
        /// Bank angle, +right (rad), full +/-pi range. Using atan2 (rather than asin)
        /// of the body-right and body-up vertical components resolves the upright vs
        /// inverted ambiguity, so the roll controller recovers instead of diverging.
        /// </summary>
        private double Bank => JsTrig.Atan2(right.Y, up.Y);

        /// <summary>Nose pitch angle above horizon (rad).</summary>
        private double NosePitch => JsTrig.Asin(JsMath.Clamp(fwd.Y, -1, 1));

        // --- Inner controllers ---------------------------------------------------

        /// <summary>Roll toward a desired bank. Proportional on the rate-commanded roll axis.</summary>
        private double CommandBank(double desiredBank)
        {
            double rollCmd = JsMath.Clamp((desiredBank - Bank) * ROLL_KP, -1, 1);
            aircraft.SetRoll(rollCmd);
            return rollCmd;
        }

        /// <summary>Bank-to-turn toward a heading, with mild coordinating yaw.</summary>
        private void CommandHeading(double desiredHeading, double maxBank)
        {
            double hErr = WrapPi(desiredHeading - Heading);
            // Commit to a single turn direction through the +/-180 ambiguity so the
            // bank command does not chatter and the reversal actually completes. The
            // latch engages past ENTER and stays applied until the error shrinks
            // below RELEASE (hysteresis), covering the whole ambiguous band.
            if (turnDir != 0)
            {
                if (Math.Abs(hErr) < TURN_LATCH_RELEASE)
                {
                    turnDir = 0;
                }
                else
                {
                    hErr = turnDir * Math.Abs(hErr);
                }
            }
            else if (Math.Abs(hErr) > TURN_LATCH_ENTER)
            {
                turnDir = hErr >= 0 ? 1 : -1;
                hErr = turnDir * Math.Abs(hErr);
            }
            if (Math.Abs(hErr) < HEADING_DEADBAND)
            {
                hErr = 0;
            }
            // Positive bank yields a negative heading rate in this frame convention,
            // so a positive heading error needs a negative (opposite) bank.
            double desiredBank = JsMath.Clamp(-hErr * BANK_PER_HEADING, -maxBank, maxBank);
            CommandBank(desiredBank);
            // A touch of into-turn rudder, proportional to bank (not the raw roll
            // command) so a hard rollout does not slam the rudder and induce PIO.
            aircraft.SetYaw(JsMath.Clamp(Bank * ROLL_YAW_COORD, -0.3, 0.3));
        }

        /// <summary>Hold/seek an altitude via a vertical-speed inner loop.</summary>
        private void CommandAltitude(double desiredAlt)
        {
            double altErr = desiredAlt - pos.Y;
            double desiredVs = JsMath.Clamp(altErr * VS_PER_ALT, -MAX_VS, MAX_VS);
            CommandVerticalSpeed(desiredVs);
        }

        private void CommandVerticalSpeed(double desiredVs)
        {
            // Cascade the climb request through the pitch-ATTITUDE loop instead of
            // mapping vertical-speed error straight to a stick/g command. A single
            // high-gain P term from vs-error to g has no phase margin at high dynamic
            // pressure and drives a ~2 s phugoid PIO (nose + load factor ringing while
            // altitude barely tracks). Converting the target climb rate into a target
            // flight-path/nose angle and holding that with CommandElevation (P on
            // pitch error + pitch-rate damping) gives a well-damped inner loop.
            double speed = Math.Max(30, aircraft.GetAirspeed());
            double gamma = JsTrig.Asin(JsMath.Clamp(desiredVs / speed, -0.4, 0.4));
            // Small proportional trim on the residual vs-error keeps the achieved
            // climb honest despite the (unmodelled) angle-of-attack offset, but with a
            // gentle gain so it cannot dominate the attitude loop.
            double desiredNose = gamma + JsMath.Clamp((desiredVs - vel.Y) * VS_TO_PITCH, -0.1, 0.1);
            CommandElevation(desiredNose);
        }

        /// <summary>Point the nose at a target elevation angle (used to aim at a 3D point).</summary>
        private void CommandElevation(double desiredElev)
        {
            desiredElev = JsMath.Clamp(desiredElev, -MAX_ELEV_CMD, MAX_ELEV_CMD);
            // Overspeed guard (common funnel for every airborne pitch command): while
            // faster than the ceiling, raise the floor on the commanded nose angle so
            // the AI cannot hold a dive that drives deeper into the transonic
            // limit-cycle regime — the shallower/climbing nose bleeds the speed off.
            double over = aircraft.GetAirspeed() - maxSpeed;
            if (over > 0)
            {
                desiredElev = Math.Max(desiredElev, JsMath.Clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX));
            }
            double pitchErr = desiredElev - NosePitch;
            double raw = pitchErr * pitchKp + BankPitchComp() - pitchRateEst * pitchKd;
            ApplyPitch(raw);
        }

        /// <summary>
        /// Clamp, then slew-rate limit the pitch command before it reaches the model.
        /// The rate limit is the key PIO suppressor: it stops the controller from
        /// injecting inputs near the airframe's lightly-damped short-period frequency.
        /// </summary>
        private void ApplyPitch(double raw)
        {
            double target = LimitPitchForAttitude(raw);
            double maxStep = pitchSlew * lastDelta;
            pitchCmdState += JsMath.Clamp(target - pitchCmdState, -maxStep, maxStep);
            aircraft.SetPitch(pitchCmdState);
        }

        /// <summary>Immediate pitch command without slew limiting — used for max-g hard turns.</summary>
        private void ApplyPitchImmediate(double raw)
        {
            pitchCmdState = LimitPitchForAttitude(raw);
            aircraft.SetPitch(pitchCmdState);
        }

        /// <summary>
        /// Max-performance turn toward a world-space direction: roll hard toward the
        /// aim bearing and pull near the pitch limit, easing off as the nose closes.
        /// Returns true while the hard turn is active this frame.
        /// </summary>
        private bool CommandHardTurn(Vec3d aimDirection, double delta, double desiredSpeed)
        {
            aimDir = aimDirection;
            if (aimDir.LengthSquared < 1e-9)
            {
                return false;
            }
            aimDir = Normalize(aimDir);

            double aimAngle = JsTrig.Acos(JsMath.Clamp(Vec3d.Dot(fwd, aimDir), -1, 1));
            if (hardTurnActive)
            {
                if (aimAngle < HARD_TURN_EXIT)
                {
                    hardTurnActive = false;
                }
            }
            else if (aimAngle > HARD_TURN_ENTER)
            {
                hardTurnActive = true;
            }
            if (!hardTurnActive)
            {
                return false;
            }

            double desiredHeading = JsTrig.Atan2(aimDir.X, aimDir.Z);
            desiredHeading = AvoidObstacles(desiredHeading);
            double hErr = WrapPi(desiredHeading - Heading);
            if (reversalDir != 0)
            {
                if (Math.Abs(hErr) < REVERSAL_LATCH_RELEASE)
                {
                    reversalDir = 0;
                }
                else
                {
                    hErr = reversalDir * Math.Abs(hErr);
                }
            }
            else if (Math.Abs(hErr) > REVERSAL_LATCH_ENTER)
            {
                reversalDir = hErr >= 0 ? 1 : -1;
                hErr = reversalDir * Math.Abs(hErr);
            }
            double desiredBank = JsMath.Clamp(-hErr * HARD_TURN_BANK_GAIN, -MAX_BANK_COMBAT, MAX_BANK_COMBAT);
            CommandBank(desiredBank);
            aircraft.SetYaw(JsMath.Clamp(Bank * ROLL_YAW_COORD, -0.3, 0.3));

            double pullT = JsMath.Clamp(aimAngle / HARD_TURN_FULL_PULL_ANGLE, 0, 1);
            double pull = HARD_TURN_MIN_PULL + pullT * (PITCH_MAX - HARD_TURN_MIN_PULL);
            ApplyPitchImmediate(pull);

            // Overspeed guard still applies during hard turns.
            double over = aircraft.GetAirspeed() - maxSpeed;
            if (over > 0)
            {
                double floor = JsMath.Clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX);
                ApplyPitchImmediate(Math.Max(pull, floor));
            }

            CommandSpeed(desiredSpeed, delta);
            return true;
        }

        /// <summary>
        /// Clamp a raw pitch command. While inverted (body up points down) a nose-up
        /// elevator command pulls the nose toward the ground, so we suppress aft stick
        /// and let the roll loop bring the aircraft upright first.
        /// </summary>
        private double LimitPitchForAttitude(double pitch)
        {
            if (up.Y < 0)
            {
                return JsMath.Clamp(pitch, PITCH_MIN, 0.1);
            }
            return JsMath.Clamp(pitch, PITCH_MIN, PITCH_MAX);
        }

        /// <summary>Extra back-pressure to hold the nose up while banked (upright only).</summary>
        private double BankPitchComp()
        {
            // No benefit past knife-edge: adding aft stick there deepens a dive.
            if (up.Y <= 0) return 0;
            double c = JsTrig.Cos(JsMath.Clamp(Bank, -1.4, 1.4));
            if (c <= 0.05) return 0.35;
            return JsMath.Clamp((1 / c - 1) * 0.25, 0, 0.5);
        }

        private void CommandSpeed(double desiredSpeed, double delta)
        {
            // Never target a speed inside the transonic ring, and snap to idle when
            // clearly overspeeding so the slow throttle integrator stops feeding energy
            // into a dive (throttle alone cannot arrest it — see the elevation guard).
            desiredSpeed = Math.Min(desiredSpeed, maxSpeed);
            double airspeed = aircraft.GetAirspeed();
            double speedErr = desiredSpeed - airspeed;
            throttleCmd = JsMath.Clamp(throttleCmd + speedErr * THROTTLE_KP * delta, 0, 1);
            if (airspeed > maxSpeed + OVERSPEED_IDLE_MARGIN)
            {
                throttleCmd = 0;
            }
            aircraft.SetThrottle(throttleCmd);
        }

        private void WingsLevel()
        {
            CommandBank(0);
            aircraft.SetYaw(0);
        }

        // --- Safety layer --------------------------------------------------------

        /// <summary>
        /// Predictive ground-proximity warning: sample terrain along the projected
        /// flight path and pull up if the aircraft would bust its hard deck. Returns
        /// true when the pull-up override is engaged this frame.
        /// </summary>
        private bool UpdateTerrainAvoidance(double delta)
        {
            double minClearance = double.PositiveInfinity;
            // Probe points from now to the look-ahead horizon.
            for (double t = 0.5; t <= TERRAIN_LOOKAHEAD_S; t += 0.5)
            {
                probe = vel * t + pos;
                double g = world.GroundHeightAt(probe.X, probe.Z);
                double clearance = probe.Y - g;
                if (clearance < minClearance)
                {
                    minClearance = clearance;
                }
            }
            // Also consider the current instantaneous clearance.
            double nowClearance = pos.Y - world.GroundHeightAt(pos.X, pos.Z);
            minClearance = Math.Min(minClearance, nowClearance);

            // Hysteresis: engage below the deck, release once comfortably above it.
            if (pullUpActive)
            {
                if (minClearance > hardDeck * 2.0 && nowClearance > hardDeck)
                {
                    pullUpActive = false;
                }
            }
            else if (minClearance < hardDeck)
            {
                pullUpActive = true;
            }

            if (!pullUpActive)
            {
                return false;
            }

            // Wings level + hard nose-up + full power until clear.
            WingsLevel();
            ApplyPitch(PITCH_MAX);
            throttleCmd = 1;
            aircraft.SetThrottle(1);
            aircraft.SetLandingGearDeployed(false);
            return true;
        }

        /// <summary>Adjust a desired heading to steer around a nearby static obstacle.</summary>
        private double AvoidObstacles(double desiredHeading)
        {
            if (!(world is ISceneObstacleQuery sceneWorld))
            {
                return desiredHeading;
            }
            double horizon = Math.Max(400, aircraft.GetAirspeed() * 4);
            Obstacle o = sceneWorld.NearestObstacleWithin(pos.X, pos.Z, horizon);
            if (o == null)
            {
                return desiredHeading;
            }
            // Only worry about obstacles roughly ahead and tall enough to matter.
            if (pos.Y > o.Position.Y + o.Height + hardDeck)
            {
                return desiredHeading;
            }
            toPoint = new Vec3d(o.Position.X - pos.X, 0, o.Position.Z - pos.Z);
            double bearing = JsTrig.Atan2(toPoint.X, toPoint.Z);
            double off = WrapPi(bearing - Heading);
            if (Math.Abs(off) > Math.PI / 3)
            {
                return desiredHeading; // obstacle not in our path
            }
            // Steer away from the side the obstacle is on.
            double avoid = Heading - JsMath.Sign(OrOne(off)) * (Math.PI / 4);
            return avoid;
        }

        // --- Phases --------------------------------------------------------------

        private void DoGroundIdle()
        {
            aircraft.SetThrottle(0);
            throttleCmd = 0;
            aircraft.SetWheelBrakes(true);
            ApplyPitch(0);
            WingsLevel();
            aircraft.SetLandingGearDeployed(true);
        }

        /// <summary>
        /// The runway this pilot is working, chosen once.
        ///
        /// Picked by proximity the first time it is asked for — which on the ground
        /// is the one under the aircraft, and airborne is the nearest field — and
        /// then held. Re-deciding per frame would hand an aircraft off to a
        /// different runway the moment one drifted closer, halfway down an approach
        /// to the first.
        ///
        /// Re-picked when the pilot turns for home, because by then it may be a
        /// long way from where it started and the nearest field is the right one.
        /// </summary>
        private Runway HomeRunway()
        {
            if (runwayChoice == null)
            {
                runwayChoice = world.NearestRunway(pos.X, pos.Z);
            }
            return runwayChoice;
        }

        private void DoTakeoff(double delta)
        {
            Runway rwy = HomeRunway();
            aircraft.SetLandingGearDeployed(true);
            aircraft.SetFlapsExtended(true);
            aircraft.SetWheelBrakes(false);
            throttleCmd = 1;
            aircraft.SetThrottle(1);

            // Ground steering: hold heading and centreline with the nosewheel (yaw).
            double rightX = JsTrig.Cos(rwy.Heading);
            double rightZ = -JsTrig.Sin(rwy.Heading);
            double lateral = (pos.X - rwy.Center.X) * rightX + (pos.Z - rwy.Center.Z) * rightZ;
            double headingErr = WrapPi(rwy.Heading - Heading);
            aircraft.SetYaw(JsMath.Clamp(headingErr * 1.5 - lateral * 0.01, -1, 1));
            WingsLevel();

            double airspeed = aircraft.GetAirspeed();
            if (airspeed >= ROTATE_SPEED)
            {
                ApplyPitch(0.5); // rotate
            }
            else
            {
                ApplyPitch(0);
            }

            double agl = pos.Y - world.GroundHeightAt(pos.X, pos.Z);
            if (agl > 15 && vel.Y > 2)
            {
                phase = AiFlightPhase.CLIMB_OUT;
            }
        }

        private void DoClimbOut(double delta)
        {
            Runway rwy = HomeRunway();
            double agl = pos.Y - world.GroundHeightAt(pos.X, pos.Z);
            double airspeed = aircraft.GetAirspeed();
            aircraft.SetLandingGearDeployed(agl < GEAR_UP_ALT);
            aircraft.SetFlapsExtended(airspeed < FLAPS_UP_SPEED);
            aircraft.SetWheelBrakes(false);

            CommandHeading(rwy.Heading, MAX_BANK_NAV);
            CommandVerticalSpeed(80);
            CommandSpeed(cruiseSpeed, delta);

            if (pos.Y >= cruiseAltitude * 0.7)
            {
                phase = AiFlightPhase.NAVIGATE;
            }
        }

        private void DoNavigate(double delta)
        {
            if (target != null && target.IsAlive())
            {
                phase = AiFlightPhase.ENGAGE;
                return;
            }
            aircraft.SetLandingGearDeployed(false);
            aircraft.SetFlapsExtended(false);
            // Gentle loitering turn holding cruise altitude/speed.
            double desiredHeading = AvoidObstacles(Heading + 0.4);
            CommandHeading(desiredHeading, MAX_BANK_NAV);
            CommandAltitudeClamped(cruiseAltitude);
            CommandSpeed(cruiseSpeed, delta);
        }

        /// <summary>Fly wings-level on a latched heading; does not auto-engage even with a target.</summary>
        private void DoStraight(double delta)
        {
            if (!straightHeadingLatched)
            {
                straightHeading = Heading;
                straightHeadingLatched = true;
            }
            aircraft.SetLandingGearDeployed(false);
            aircraft.SetFlapsExtended(false);
            CommandHeading(AvoidObstacles(straightHeading), MAX_BANK_NAV);
            CommandAltitudeClamped(cruiseAltitude);
            CommandSpeed(cruiseSpeed, delta);
        }

        /// <summary>
        /// Wingman phase: fly the lead's wing, and hand off to ENGAGE the moment a
        /// live target is assigned. Two steering laws with hysteresis between them —
        /// rejoin (fly *at* the slot with overtake speed) and station-keeping (fly
        /// the lead's heading, trimming out the residual offsets). Flying at the slot
        /// the whole time would work at range but goes singular on top of it, where
        /// the bearing to a slot metres away swings wildly.
        /// </summary>
        private void DoFormation(double delta)
        {
            ICombatant lead = formationLead;
            if (lead == null || !lead.IsAlive())
            {
                phase = AiFlightPhase.NAVIGATE;
                return;
            }
            // A bandit outranks the rejoin: peel off and fight.
            if (target != null && target.IsAlive())
            {
                phase = AiFlightPhase.ENGAGE;
                return;
            }

            aircraft.SetLandingGearDeployed(false);
            aircraft.SetFlapsExtended(false);

            lpos = lead.ReadPosition();
            lvel = lead.ReadVelocity();
            double leadSpeed = lvel.Length;
            if (leadSpeed < FORMATION_LEAD_MIN_SPEED)
            {
                // Lead is parked or rolling out — there is no slot to fly. Wait
                // overhead instead of descending onto a stationary point.
                DoHoldOverhead(delta);
                return;
            }

            double leadHeading = JsTrig.Atan2(lvel.X, lvel.Z);
            leadFwd = new Vec3d(JsTrig.Sin(leadHeading), 0, JsTrig.Cos(leadHeading));
            leadRight = new Vec3d(JsTrig.Cos(leadHeading), 0, -JsTrig.Sin(leadHeading));
            slot = lpos
                .AddScaled(leadFwd, -FormationSlot.Trail)
                .AddScaled(leadRight, FormationSlot.Side);
            slot.Y += FormationSlot.Stack;

            toSlot = slot - pos;
            double slotRange = toSlot.Length;
            if (formationRejoining)
            {
                if (slotRange < FORMATION_REJOIN_RELEASE_M) formationRejoining = false;
            }
            else if (slotRange > FORMATION_REJOIN_ENTER_M)
            {
                formationRejoining = true;
            }

            if (formationRejoining)
            {
                // No integral trim while closing: the altitude error here is the
                // rejoin geometry, not loop droop, and integrating it would wind up.
                formationAltTrim = 0;
                double desiredHeading = JsTrig.Atan2(toSlot.X, toSlot.Z);
                CommandHeading(AvoidObstacles(desiredHeading), FORMATION_MAX_BANK);
                CommandAltitudeClamped(slot.Y);
                CommandFormationSpeed(Math.Min(maxSpeed, leadSpeed + FORMATION_REJOIN_OVERTAKE), delta);
                return;
            }

            // Station keeping: hold the lead's heading, steering only by the
            // cross-track error and trimming speed on the along-track error.
            double alongErr = Vec3d.Dot(toSlot, leadFwd);
            double crossErr = Vec3d.Dot(toSlot, leadRight);
            // Closing rate along the lead's axis (+ = falling behind the slot).
            toPoint = lvel - vel;
            double alongRate = Vec3d.Dot(toPoint, leadFwd);
            double headingOffset = JsMath.Clamp(
                crossErr * FORMATION_HEADING_PER_CROSS,
                -FORMATION_MAX_HEADING_OFFSET, FORMATION_MAX_HEADING_OFFSET);
            CommandHeading(AvoidObstacles(leadHeading + headingOffset), FORMATION_MAX_BANK);
            formationAltTrim = JsMath.Clamp(
                formationAltTrim + (slot.Y - pos.Y) * FORMATION_ALT_TRIM_RATE * delta,
                -FORMATION_ALT_TRIM_MAX, FORMATION_ALT_TRIM_MAX);
            CommandAltitudeClamped(slot.Y + formationAltTrim);
            double speedTrim = JsMath.Clamp(
                alongErr * FORMATION_SPEED_PER_ALONG + alongRate * FORMATION_SPEED_PER_CLOSURE,
                -FORMATION_SPEED_TRIM, FORMATION_SPEED_TRIM);
            CommandFormationSpeed(leadSpeed + speedTrim, delta);
        }

        /// <summary>
        /// Speed hold with the speedbrake as the deceleration authority: the throttle
        /// integrator bottoms out at idle long before a clean airframe has actually
        /// slowed down, which is not enough to hold a slot behind a slower lead.
        /// </summary>
        private void CommandFormationSpeed(double desiredSpeed, double delta)
        {
            double airspeed = aircraft.GetAirspeed();
            if (formationAirbrakes)
            {
                if (airspeed < desiredSpeed + FORMATION_AIRBRAKE_RELEASE) formationAirbrakes = false;
            }
            else if (airspeed > desiredSpeed + FORMATION_AIRBRAKE_ENTER)
            {
                formationAirbrakes = true;
            }
            aircraft.SetAirbrakesExtended(formationAirbrakes);
            CommandSpeed(desiredSpeed, delta);
        }

        /// <summary>Loiter at cruise altitude near the lead, closing back in if it drifts off.</summary>
        private void DoHoldOverhead(double delta)
        {
            formationAltTrim = 0;
            formationAirbrakes = false;
            aircraft.SetAirbrakesExtended(false);
            toPoint = new Vec3d(lpos.X - pos.X, 0, lpos.Z - pos.Z);
            double desiredHeading = toPoint.Length > FORMATION_HOLD_RECENTER_M
                ? JsTrig.Atan2(toPoint.X, toPoint.Z)
                : Heading + 0.4;
            CommandHeading(AvoidObstacles(desiredHeading), MAX_BANK_NAV);
            CommandAltitudeClamped(cruiseAltitude);
            CommandSpeed(cruiseSpeed, delta);
        }

        private void DoEngage(double delta)
        {
            if (target == null || !target.IsAlive())
            {
                // A wingman rejoins its lead when the fight is over; a lone fighter
                // has nothing to rejoin and goes back to its patrol.
                phase = formationLead != null && formationLead.IsAlive()
                    ? AiFlightPhase.FORMATION
                    : AiFlightPhase.NAVIGATE;
                return;
            }
            aircraft.SetLandingGearDeployed(false);
            aircraft.SetFlapsExtended(false);

            tpos = target.ReadPosition();
            tvel = target.ReadVelocity();
            UpdateTargetAcceleration(delta);
            toPoint = tpos - pos;
            double range = toPoint.Length;

            // Shared per-frame BFM geometry (see DogfightGeometry for definitions).
            double closure = DogfightGeometry.ClosureRate(pos, vel, tpos, tvel);
            double theirTrackingAngle = DogfightGeometry.TrackingAngle(tpos, tvel, pos);
            double myAspectOnTarget = DogfightGeometry.TrackingAngle(pos, vel, tpos);
            double ao = DogfightGeometry.AngleOff(vel, tvel);
            double myEnergy = DogfightGeometry.SpecificEnergyHeight(pos.Y, vel.Length);
            double theirEnergy = DogfightGeometry.SpecificEnergyHeight(tpos.Y, tvel.Length);
            double energyDeficit = theirEnergy - myEnergy;

            UpdateDogfightMode(delta, range, closure, ao, theirTrackingAngle, myAspectOnTarget, energyDeficit);

            switch (dogfightMode)
            {
                case DogfightMode.DEFENSIVE_BREAK: DoDefensiveBreak(delta); break;
                case DogfightMode.EXTEND: DoExtend(delta); break;
                case DogfightMode.HIGH_YOYO: DoHighYoYo(delta, range); break;
                case DogfightMode.LOW_YOYO: DoLowYoYo(delta, range); break;
                case DogfightMode.LAG_PURSUE: DoLagPursue(delta, range, ao); break;
                case DogfightMode.PURSUE:
                default: DoPursue(delta, range, ao); break;
            }

            // Only PURSUE/LAG_PURSUE actually aim at the target this frame; every
            // other mode is repositioning or evading, so never let a coincidental
            // nose-on-target moment squeeze off a burst.
            if (dogfightMode != DogfightMode.PURSUE && dogfightMode != DogfightMode.LAG_PURSUE)
            {
                firing = false;
            }
            hadSolution = firing;
        }

        /// <summary>
        /// Decide which <see cref="DogfightMode"/> to fly this frame. Priority order:
        /// a sustained threat on our own tail always wins (defend first), then an
        /// energy deficit (rebuild before fighting on), then the timed vertical
        /// repositioning maneuvers, then the steady-state pursuit style.
        /// </summary>
        private void UpdateDogfightMode(
            double delta, double range, double closure, double ao,
            double theirTrackingAngle, double myAspectOnTarget, double energyDeficit)
        {
            double theirThreatRange = gunRange * DEFENSIVE_RANGE_MULT;
            double theirClearRange = gunRange * DEFENSIVE_CLEAR_RANGE_MULT;
            bool targetInRearHemisphere = myAspectOnTarget >= DEFENSIVE_REAR_HEMISPHERE;
            bool underThreat = targetInRearHemisphere
                && theirTrackingAngle <= DEFENSIVE_AOT_THRESHOLD
                && range <= theirThreatRange;
            threatTimer = underThreat ? threatTimer + delta : 0;

            if (dogfightMode == DogfightMode.DEFENSIVE_BREAK)
            {
                if (theirTrackingAngle > DEFENSIVE_CLEAR_AOT
                    || range > theirClearRange
                    || myAspectOnTarget < DEFENSIVE_REAR_CLEAR)
                {
                    SetDogfightMode(DogfightMode.PURSUE);
                }
                return;
            }
            if (threatTimer >= skillTuning.DefensiveReactTime)
            {
                // Relentless opponents press the attack even under mild pressure; only
                // break when the bandit is clearly on their six, not on a neutral merge.
                if (!alwaysEngage || myAspectOnTarget >= 120 * Math.PI / 180)
                {
                    SetDogfightMode(DogfightMode.DEFENSIVE_BREAK);
                }
                return;
            }

            // Energy-deficit disengage: skipped for an always-engage opponent so it
            // never turns tail to rebuild energy.
            if (!alwaysEngage)
            {
                if (dogfightMode == DogfightMode.EXTEND)
                {
                    maneuverTimer += delta;
                    if (maneuverTimer >= EXTEND_MIN_DURATION && energyDeficit <= EXTEND_RECOVER_MARGIN)
                    {
                        SetDogfightMode(DogfightMode.PURSUE);
                    }
                    return;
                }
                if (energyDeficit >= skillTuning.ExtendEnergyDeficit)
                {
                    SetDogfightMode(DogfightMode.EXTEND);
                    return;
                }
            }

            if (dogfightMode == DogfightMode.HIGH_YOYO || dogfightMode == DogfightMode.LOW_YOYO)
            {
                if (alwaysEngage)
                {
                    SetDogfightMode(DogfightMode.PURSUE);
                    return;
                }
                maneuverTimer += delta;
                double duration = dogfightMode == DogfightMode.HIGH_YOYO ? HIGH_YOYO_DURATION : LOW_YOYO_DURATION;
                if (maneuverTimer >= duration)
                {
                    SetDogfightMode(DogfightMode.PURSUE);
                }
                return;
            }
            if (!alwaysEngage && range <= YOYO_RANGE_TRIGGER && closure >= YOYO_CLOSURE_TRIGGER && !hadSolution)
            {
                // Closing fast at short range: about to blow past the target. Bleed
                // the overtake in the vertical rather than tightening the turn —
                // but not if we already have a guns solution this pass.
                SetDogfightMode(DogfightMode.HIGH_YOYO);
                return;
            }
            // Energy edge and a turn too tight to lead-pursue: dive across the
            // circle instead of trying (and failing) to out-turn them level.
            if (!alwaysEngage && -energyDeficit >= LOW_YOYO_ENERGY_EDGE && ao >= LOW_YOYO_ANGLE_OFF_TRIGGER)
            {
                SetDogfightMode(DogfightMode.LOW_YOYO);
                return;
            }

            // Steady-state pursuit style: lag behind the pure lead point once the
            // angle-off is too wide for a lead turn to be flyable.
            SetDogfightMode(ao >= LAG_ANGLE_OFF_TRIGGER ? DogfightMode.LAG_PURSUE : DogfightMode.PURSUE);
        }

        /// <summary>Reset the per-maneuver timer whenever the mode actually changes.</summary>
        private void SetDogfightMode(DogfightMode mode)
        {
            if (dogfightMode != mode)
            {
                dogfightMode = mode;
                maneuverTimer = 0;
            }
        }

        /// <summary>Never aim below the terrain safety floor while computing an aimpoint.</summary>
        private void ClampAimToHardDeck()
        {
            double deck = world.GroundHeightAt(aim.X, aim.Z) + hardDeck;
            if (aim.Y < deck)
            {
                aim.Y = deck;
            }
        }

        /// <summary>Finite-difference + low-pass the target's acceleration for lead prediction.</summary>
        private void UpdateTargetAcceleration(double delta)
        {
            if (hasPrevTvel && delta > 1e-4)
            {
                double ax = (tvel.X - prevTvel.X) / delta;
                double ay = (tvel.Y - prevTvel.Y) / delta;
                double az = (tvel.Z - prevTvel.Z) / delta;
                double mag = JsMath.Hypot(ax, ay, az);
                double scale = mag > TARGET_ACCEL_CAP ? TARGET_ACCEL_CAP / mag : 1;
                targetAcc.X += (ax * scale - targetAcc.X) * TARGET_ACCEL_EMA;
                targetAcc.Y += (ay * scale - targetAcc.Y) * TARGET_ACCEL_EMA;
                targetAcc.Z += (az * scale - targetAcc.Z) * TARGET_ACCEL_EMA;
            }
            else
            {
                targetAcc = new Vec3d(0, 0, 0);
            }
            prevTvel = tvel;
            hasPrevTvel = true;
        }

        /// <summary>Compute a ballistic gun-lead aim point into <c>aim</c>; returns tof (s).</summary>
        private double ComputeBallisticAim()
        {
            lastTof = DogfightGeometry.BallisticAimPoint(out aim, pos, vel, tpos, tvel, targetAcc, bulletSpeed);
            ClampAimToHardDeck();
            return lastTof;
        }

        /// <summary>Would the current nose direction produce a hit at <paramref name="range"/>?</summary>
        private bool EvaluateFireSolution(double range)
        {
            if (target == null || range > gunRange || range < 1)
            {
                return false;
            }
            bulletVel = fwd * bulletSpeed + vel;
            double miss = DogfightGeometry.PredictedMissDistance(pos, bulletVel, tpos, tvel, targetAcc, lastTof);
            double allowance = target.GetHitRadius() * skillTuning.MissAllowanceMult + FIRE_MISS_SLACK_M;
            double aggressiveSlack = alwaysEngage ? allowance * 1.35 : allowance;
            return miss <= aggressiveSlack;
        }

        /// <summary>
        /// Pick a pursuit airspeed that keeps turn radius tight. High combat speed
        /// with small bank changes is what produced the easy-to-trail lazy circles.
        /// </summary>
        private double CombatTurnSpeed(double range, double ao)
        {
            if (alwaysEngage)
            {
                if (range < 500 || ao >= 25 * Math.PI / 180)
                {
                    return Math.Min(CORNER_SPEED, combatSpeed > CORNER_SPEED ? CORNER_SPEED : combatSpeed * 0.95);
                }
            }
            if (range < 250)
            {
                return Math.Min(combatSpeed * 0.65, CORNER_SPEED);
            }
            if (ao >= CORNER_SPEED_AO)
            {
                double t = JsMath.Clamp((ao - CORNER_SPEED_AO) / (Math.PI / 2 - CORNER_SPEED_AO), 0, 1);
                return combatSpeed + (CORNER_SPEED - combatSpeed) * t;
            }
            return combatSpeed;
        }

        /// <summary>Turn/pitch toward <c>aim</c>, hold <paramref name="desiredSpeed"/>, and fire on a predicted hit.</summary>
        private void SteerAtAimAndFire(double delta, double range, double desiredSpeed, double maxBank = MAX_BANK_COMBAT)
        {
            toPoint = aim - pos;
            double aimDist = toPoint.Length;
            if (aimDist < 1e-3)
            {
                firing = false;
                return;
            }
            aimDir = toPoint / aimDist;

            double turnSpeed = desiredSpeed;
            double aimAngle = JsTrig.Acos(JsMath.Clamp(Vec3d.Dot(fwd, aimDir), -1, 1));
            if (alwaysEngage && aimAngle > 3 * Math.PI / 180)
            {
                hardTurnActive = true;
            }
            if (!CommandHardTurn(aimDir, delta, turnSpeed))
            {
                double horiz = JsMath.Hypot(toPoint.X, toPoint.Z);
                double desiredHeading = JsTrig.Atan2(toPoint.X, toPoint.Z);
                desiredHeading = AvoidObstacles(desiredHeading);
                double desiredElev = JsTrig.Atan2(toPoint.Y, horiz);

                CommandHeading(desiredHeading, maxBank);
                CommandElevation(desiredElev);
                CommandSpeed(desiredSpeed, delta);
            }

            firing = EvaluateFireSolution(range);
        }

        /// <summary>Straight lead-pursuit intercept — the default, common case.</summary>
        private void DoPursue(double delta, double range, double ao)
        {
            ComputeBallisticAim();
            SteerAtAimAndFire(delta, range, CombatTurnSpeed(range, ao));
        }

        /// <summary>
        /// Blend the aimpoint from the pure lead point toward the target's actual
        /// position as angle-off grows, so the AI isn't forced to fly a turn
        /// radius the airframe can't sustain just to keep pointing at an
        /// unreachable lead point.
        /// </summary>
        private void DoLagPursue(double delta, double range, double ao)
        {
            ComputeBallisticAim();

            double span = Math.Max(1e-3, Math.PI - LAG_ANGLE_OFF_TRIGGER);
            double blend = JsMath.Clamp((ao - LAG_ANGLE_OFF_TRIGGER) / span, 0, LAG_BLEND_MAX);
            aim = Lerp(aim, tpos, blend);
            ClampAimToHardDeck();

            SteerAtAimAndFire(delta, range, CombatTurnSpeed(range, ao));
        }

        /// <summary>
        /// Pull the nose above the flight path so a fast overtake is bled off as
        /// altitude rather than continuing to tighten the turn into an overshoot.
        /// Does not track/fire — this is a repositioning maneuver.
        /// </summary>
        private void DoHighYoYo(double delta, double range)
        {
            ComputeBallisticAim();

            toPoint = aim - pos;
            double horiz = JsMath.Hypot(toPoint.X, toPoint.Z);
            double desiredHeading = JsTrig.Atan2(toPoint.X, toPoint.Z);
            desiredHeading = AvoidObstacles(desiredHeading);
            double desiredElev = JsTrig.Atan2(toPoint.Y, horiz) + HIGH_YOYO_PITCH_BONUS;

            double aimDist = toPoint.Length;
            if (aimDist > 1e-3)
            {
                aimDir = toPoint / aimDist;
                // Bias the hard-turn direction slightly above the aim for the yo-yo.
                aimDir.Y += JsTrig.Sin(HIGH_YOYO_PITCH_BONUS) * 0.3;
                aimDir = Normalize(aimDir);
                if (!CommandHardTurn(aimDir, delta, combatSpeed))
                {
                    CommandHeading(desiredHeading, MAX_BANK_COMBAT * HIGH_YOYO_MAX_BANK_MULT);
                    CommandElevation(desiredElev);
                    CommandSpeed(combatSpeed, delta);
                }
            }
        }

        /// <summary>
        /// Trade some altitude for turn rate/closure, cutting inside the target's
        /// turn circle rather than trying (and failing) to out-turn them level.
        /// Does not track/fire — this is a repositioning maneuver.
        /// </summary>
        private void DoLowYoYo(double delta, double range)
        {
            ComputeBallisticAim();

            toPoint = aim - pos;
            double horiz = JsMath.Hypot(toPoint.X, toPoint.Z);
            double desiredHeading = JsTrig.Atan2(toPoint.X, toPoint.Z);
            desiredHeading = AvoidObstacles(desiredHeading);
            double desiredElev = JsTrig.Atan2(toPoint.Y, horiz) - LOW_YOYO_PITCH_DROP;

            double aimDist = toPoint.Length;
            if (aimDist > 1e-3)
            {
                aimDir = toPoint / aimDist;
                if (!CommandHardTurn(aimDir, delta, maxSpeed))
                {
                    CommandHeading(desiredHeading, MAX_BANK_COMBAT);
                    CommandElevation(desiredElev);
                    CommandSpeed(maxSpeed, delta);
                }
            }
        }

        /// <summary>
        /// Hard break turn into a tracking threat: turning toward the bearing of
        /// the attacker closes the angle fastest, forcing them to either overshoot
        /// or commit to a lead they likely can't sustain. Not a tracking maneuver.
        /// </summary>
        private void DoDefensiveBreak(double delta)
        {
            toPoint = tpos - pos;
            double bearing = JsTrig.Atan2(toPoint.X, toPoint.Z);
            double bearingOff = WrapPi(bearing - Heading);

            if (alwaysEngage)
            {
                // Scissors into the threat instead of breaking 90° away — stay offensive.
                aimDir = Normalize(new Vec3d(JsTrig.Sin(bearing), 0.12, JsTrig.Cos(bearing)));
                if (!CommandHardTurn(aimDir, delta, CORNER_SPEED))
                {
                    CommandHeading(bearing, MAX_BANK_COMBAT);
                    CommandElevation(15 * Math.PI / 180);
                    CommandSpeed(CORNER_SPEED, delta);
                }
                return;
            }

            double breakHeading = Heading + JsMath.Sign(OrOne(bearingOff)) * (Math.PI / 2);

            // Hard break into the threat: roll and pull for max instantaneous turn rate.
            aimDir = Normalize(new Vec3d(JsTrig.Sin(breakHeading), 0.15, JsTrig.Cos(breakHeading)));
            if (!CommandHardTurn(aimDir, delta, CORNER_SPEED))
            {
                CommandHeading(breakHeading, MAX_BANK_COMBAT);
                CommandElevation(12 * Math.PI / 180);
                CommandSpeed(CORNER_SPEED, delta);
            }
        }

        /// <summary>
        /// Disengage on a heading away from the target, unloaded and at full
        /// power, to rebuild the energy needed to fight on. Not a tracking
        /// maneuver — this deliberately accepts pointing off the target.
        /// </summary>
        private void DoExtend(double delta)
        {
            toPoint = pos - tpos;
            double desiredHeading = JsTrig.Atan2(toPoint.X, toPoint.Z);
            desiredHeading = AvoidObstacles(desiredHeading);

            CommandHeading(desiredHeading, MAX_BANK_NAV);
            CommandElevation(-0.05); // shallow nose-down: unloaded, minimum-drag extend
            CommandSpeed(maxSpeed, delta);
        }

        private void DoRtb(double delta)
        {
            Runway rwy = HomeRunway();
            // Fly to an initial approach fix on the extended centreline, then hand
            // off to the approach controller.
            double fwdX = JsTrig.Sin(rwy.Heading);
            double fwdZ = JsTrig.Cos(rwy.Heading);
            double iafDist = rwy.HalfLength + 8000;
            aim = new Vec3d(
                rwy.Center.X - fwdX * iafDist,
                cruiseAltitude * 0.4,
                rwy.Center.Z - fwdZ * iafDist);
            toPoint = aim - pos;
            double desiredHeading = AvoidObstacles(JsTrig.Atan2(toPoint.X, toPoint.Z));
            CommandHeading(desiredHeading, MAX_BANK_NAV);
            CommandAltitudeClamped(aim.Y);
            CommandSpeed(cruiseSpeed, delta);

            if (JsMath.Hypot(toPoint.X, toPoint.Z) < 2500)
            {
                phase = AiFlightPhase.APPROACH;
            }
        }

        private void DoApproach(double delta)
        {
            Runway rwy = HomeRunway();
            double fwdX = JsTrig.Sin(rwy.Heading);
            double fwdZ = JsTrig.Cos(rwy.Heading);
            double rightX = JsTrig.Cos(rwy.Heading);
            double rightZ = -JsTrig.Sin(rwy.Heading);

            if (aircraft.IsLanded())
            {
                phase = AiFlightPhase.ROLLOUT;
                return;
            }

            // Touchdown ~300 m past the approach threshold.
            double touchdownDist = rwy.HalfLength - 300;
            double tdX = rwy.Center.X - fwdX * touchdownDist;
            double tdZ = rwy.Center.Z - fwdZ * touchdownDist;
            double along = (pos.X - tdX) * fwdX + (pos.Z - tdZ) * fwdZ;
            double distToTouchdown = -along; // positive on approach

            double lateral = (pos.X - rwy.Center.X) * rightX + (pos.Z - rwy.Center.Z) * rightZ;
            // Roll to null the lateral offset, blended with a heading hold.
            double headingErr = WrapPi(rwy.Heading - Heading);
            // Same convention as CommandHeading: a positive heading/offset error needs
            // the opposite bank to correct it.
            double desiredBank = JsMath.Clamp(lateral * 0.01 - headingErr * 1.0, -MAX_BANK_APPROACH, MAX_BANK_APPROACH);
            CommandBank(desiredBank);
            aircraft.SetYaw(JsMath.Clamp(-lateral * 0.002, -0.3, 0.3));

            // 3-degree glideslope.
            double groundY = world.GroundHeightAt(pos.X, pos.Z);
            double targetAlt = groundY + Math.Max(2, distToTouchdown * 0.052);
            CommandAltitude(targetAlt);
            CommandSpeed(150, delta);

            // Configure for landing on final.
            double agl = pos.Y - groundY;
            aircraft.SetLandingGearDeployed(agl < 500);
            aircraft.SetFlapsExtended(agl < 500);

            if (agl < 15 && distToTouchdown < 400)
            {
                phase = AiFlightPhase.FLARE;
            }
        }

        private void DoFlare(double delta)
        {
            if (aircraft.IsLanded())
            {
                phase = AiFlightPhase.ROLLOUT;
                return;
            }
            aircraft.SetThrottle(0);
            throttleCmd = 0;
            ApplyPitch(0.15);
            WingsLevel();
            aircraft.SetLandingGearDeployed(true);
            aircraft.SetFlapsExtended(true);
        }

        private void DoRollout()
        {
            Runway rwy = HomeRunway();
            aircraft.SetThrottle(0);
            throttleCmd = 0;
            aircraft.SetWheelBrakes(true);
            ApplyPitch(0);
            // Keep straight on the centreline.
            double headingErr = WrapPi(rwy.Heading - Heading);
            aircraft.SetYaw(JsMath.Clamp(headingErr * 1.5, -1, 1));
            WingsLevel();
            if (aircraft.GetAirspeed() < 2)
            {
                phase = AiFlightPhase.GROUND_IDLE;
            }
        }

        /// <summary>Altitude hold that never commands below the local terrain hard deck.</summary>
        private void CommandAltitudeClamped(double desiredAlt)
        {
            double floor = world.GroundHeightAt(pos.X, pos.Z) + hardDeck;
            CommandAltitude(Math.Max(desiredAlt, floor));
        }
    }
}
