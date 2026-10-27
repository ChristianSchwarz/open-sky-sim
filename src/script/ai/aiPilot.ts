import * as THREE from 'three';
import { clamp, FORWARD, RIGHT, UP } from '../utils/math';
import { AiPilotModels } from '../state/gameDefs';
import { PilotableAircraft } from './aircraftControls';
import { AiPilotController } from './aiPilotController';
import { approachSpeed } from './airfield/airframePerformance';
import { arcHeading, fromRunwayFrame, lineHeading, runwayFrame, turnRadius } from './airfield/patternGuidance';
import { Runway, SceneWorldQuery, WorldQuery } from './worldQuery';
import { Combatant } from '../weapons/combatant';
import { angleOff, ballisticAimPoint, closureRate, predictedMissDistance, specificEnergyHeight, trackingAngle } from './dogfightGeometry';

/**
 * Hierarchical flight phases. Mission logic sets high-level setpoints (heading,
 * altitude, speed); a shared inner controller layer turns those into normalized
 * stick/throttle. A terrain/obstacle safety layer can pre-empt any airborne
 * phase (see {@link AiPilot.update}).
 */
export enum AiFlightPhase {
    GROUND_IDLE,
    TAKEOFF_ROLL,
    CLIMB_OUT,
    NAVIGATE,
    /** Hold current heading/altitude/speed until mission logic promotes to ENGAGE. */
    STRAIGHT,
    ENGAGE,
    RTB,
    APPROACH,
    FLARE,
    ROLLOUT,
    /**
     * Fly formation on the lead set by {@link AiPilot.setFormationLead} — the
     * wingman phase. Rejoins from any separation, holds a wing slot once
     * settled, and peels off into {@link AiFlightPhase.ENGAGE} the moment a live
     * target is assigned (returning here when that target is gone).
     *
     * Appended last on purpose: the phase crosses the worker boundary as a raw
     * ordinal (`{ type: 'setPhase'; phase: number }`), so existing values must
     * not shift.
     */
    FORMATION,
    /**
     * Abandon an approach: full power, climb straight ahead on the runway
     * heading, clean up, then come back round through {@link RTB}. Entered
     * from APPROACH / FLARE / ROLLOUT when the approach is unstable at the
     * gate, the flare floats too long, or the touchdown bounces. After
     * {@link MAX_GO_AROUNDS} the pilot diverts to another runway.
     *
     * Appended for the same reason as FORMATION.
     */
    GO_AROUND,
    /**
     * Fly the route set by {@link AiPilot.setRoute} (the waypoint editor's
     * missions): each leg at its waypoint's altitude and speed, then RTB to
     * the route's landing runway, or circle the last waypoint when it has none.
     * Entered from CLIMB_OUT when a route is set. Appended like FORMATION.
     */
    WAYPOINT,
}

/**
 * A route in world space, shared with the sim, which keeps it across pilot
 * rebuilds and re-bases it with the scene; `next` is the progress along it.
 */
export interface AiRoute {
    /** `y` is the altitude to hold on the leg to the point; speed in m/s. */
    points: Array<{ x: number; y: number; z: number; speed: number }>;
    next: number;
    /**
     * Where the landing runway is: the one nearest this point, landed on along
     * `heading` (scene, 0 = +Z) when given - the world lists each runway once,
     * along its low designator, and the other end is that turned round.
     */
    land?: { x: number; z: number; heading?: number };
}

export interface AiPilotOptions {
    /** Cruise/patrol altitude (m). */
    cruiseAltitude?: number;
    /** Cruise/patrol speed (m/s). */
    cruiseSpeed?: number;
    /** Combat speed target (m/s). */
    combatSpeed?: number;
    /** Hard speed ceiling (m/s) the AI keeps below to avoid the transonic ring. */
    maxSpeed?: number;
    /** Muzzle velocity used for the gun lead solution (m/s). */
    bulletSpeed?: number;
    /** Max slant range at which the AI opens fire (m). */
    gunRange?: number;
    /** Minimum altitude above local terrain the AI will let itself get to (m). */
    hardDeck?: number;
    /** Optional pitch-loop tuning overrides (see the PITCH_* constants). */
    pitchKp?: number;
    pitchKd?: number;
    pitchSlew?: number;
    /** Dogfight skill tier: reaction time, energy discipline, firing accuracy. Defaults to ACE. */
    skill?: AiSkillLevel;
    /** When true, the AI never disengages to rebuild energy (no EXTEND): it stays relentlessly on the attack. */
    alwaysEngage?: boolean;
    /**
     * Which AI pilot model to instantiate. Defaults to CLASSIC. Applied when the
     * in-worker pilot is (re)built — typically on opponent spawn.
     */
    model?: AiPilotModels;
}

/**
 * Dogfight skill tier. There is no other difficulty concept in the game, so
 * this single knob is what makes an opponent easier or harder to beat: it
 * scales how fast the AI notices a threat on its tail, how readily it bails
 * out of a losing energy state instead of fighting on, and how tight its
 * firing discipline is.
 */
export enum AiSkillLevel {
    ROOKIE,
    VETERAN,
    ACE,
}

interface SkillTuning {
    /** Seconds a threat must be sustained before the AI reacts with a break turn. */
    defensiveReactTime: number;
    /** Energy-height deficit (m) vs. the target that triggers an extend/disengage. */
    extendEnergyDeficit: number;
    /**
     * Multiplier on the allowed predicted miss distance before pulling the
     * trigger. ACE only fires when the round will pass within roughly the
     * target's hit sphere (tight, lethal bursts); lower tiers spray at
     * solutions that mostly miss.
     */
    missAllowanceMult: number;
}

const SKILL_TUNING: Record<AiSkillLevel, SkillTuning> = {
    [AiSkillLevel.ROOKIE]: { defensiveReactTime: 1.2, extendEnergyDeficit: 650, missAllowanceMult: 2.5 },
    [AiSkillLevel.VETERAN]: { defensiveReactTime: 0.6, extendEnergyDeficit: 450, missAllowanceMult: 1.5 },
    [AiSkillLevel.ACE]: { defensiveReactTime: 0.25, extendEnergyDeficit: 300, missAllowanceMult: 1.0 },
};

/**
 * Sub-states the {@link AiPilot} cycles through while in the ENGAGE phase.
 * `doEngage()` no longer always flies a straight lead-pursuit intercept: it
 * picks one of these each frame based on the current dogfight geometry (see
 * {@link AiPilot.updateDogfightMode}).
 */
/** The leg of the way round to final being flown in RTB; see AiPilot.doRtb. */
enum RtbLeg {
    /** Not chosen yet: decided on the next frame from where the aircraft is. */
    PLAN,
    /** Intercepting the extended centreline. */
    DIRECT,
    /** Outbound on a leg parallel to the runway. */
    DOWNWIND,
    /** The 180 from downwind onto the centreline. */
    BASE,
}

export enum DogfightMode {
    /** Lead-pursuit intercept — the common case when the geometry is flyable. */
    PURSUE,
    /** Blended lead/lag aimpoint used when angle-off is too large for a clean lead turn. */
    LAG_PURSUE,
    /** Pull above the flight path to bleed excess closure without losing energy. */
    HIGH_YOYO,
    /** Trade altitude for turn rate/closure when energy allows cutting the corner. */
    LOW_YOYO,
    /** Hard break turn into a tracking threat; not aiming at the target. */
    DEFENSIVE_BREAK,
    /** Disengage on a clear heading to rebuild energy before re-engaging. */
    EXTEND,
}

// --- Controller gains / limits -------------------------------------------------
// The FM2 roll axis is rate-commanded (stick position sets roll RATE), so the
// bank-hold loop is proportional only: rollCmd = K * bankError drives the bank
// error to zero as a stable first-order response. (A derivative term here fights
// the plant's own integrator and produces a bang-bang limit cycle.)
const ROLL_KP = 2.2;                 // bank error (rad) -> roll command (snappy combat rolls)
const ROLL_YAW_COORD = 0.05;         // coordinating rudder as a fraction of bank
const BANK_PER_HEADING = 2.5;        // heading error (rad) -> desired bank (rad); hit max bank ~34° off
const HEADING_DEADBAND = 1.0 * Math.PI / 180;  // ignore sub-degree heading error
// Near +/-180 deg the shortest-turn sign chatters frame-to-frame, which makes
// the bank command flip and the aircraft rock instead of committing to the
// reversal. Latch a turn direction on entry and release once well clear.
const TURN_LATCH_ENTER = 150 * Math.PI / 180;
const TURN_LATCH_RELEASE = 110 * Math.PI / 180;
const RATE_EMA = 0.35;               // low-pass factor for finite-difference attitude rates
const PATH_OFFSET_EMA = 0.05;        // low-pass factor (per frame) for the nose-to-path angle
const PITCH_TRIM_KI = 0.4;           // nose error (rad) -> integral stick rate (1/s), path-hold only
const PITCH_TRIM_KI_FLARE = 4;       // ... in the flare: seconds, not tens of seconds, to find the stick
const PITCH_TRIM_MAX = 0.6;          // clamp on that integral (stick)
const PITCH_TRIM_MAX_FLARE = 0.8;    // ... and in the flare, which needs the stick (more on final starts a phugoid)
const PITCH_GAIN_REF_SPEED = 200;     // speed (m/s) the pitch gains are tuned at, for scheduling them slow
const PITCH_GAIN_MAX_SCALE = 3;       // cap on that scheduling
const PITCH_GAIN_MAX_SCALE_FLARE = 6; // ... in the flare, a few seconds that need a firm pull
// Keep the nose out of the near-vertical regime where heading/bank (derived from
// the body axes' vertical components) go singular and the roll loop thrashes.
const MAX_ELEV_CMD = 55 * Math.PI / 180;
const MAX_BANK_NAV = 45 * Math.PI / 180;
const MAX_BANK_COMBAT = 85 * Math.PI / 180;  // near knife-edge for min turn radius
const MAX_BANK_APPROACH = 25 * Math.PI / 180;
const GLIDESLOPE = Math.tan(3 * Math.PI / 180);
/** Centreline offset (m) -> intercept angle toward it (rad/m). Big enough that a few metres
 * off clears the heading loop's 1 deg deadband: at 0.001 it settled 17 m to one side. */
const APPROACH_INTERCEPT_PER_M = 0.003;
const APPROACH_MAX_INTERCEPT = 30 * Math.PI / 180;
/** Share of the glidepath's height above the terrain the approach terrain guard keeps. */
const APPROACH_DECK_FRACTION = 0.4;
const APPROACH_ALT_TRIM_RATE = 0.05;
const APPROACH_ALT_TRIM_MAX = 150;
/** Flare time constant (s): commanded sink = height / tau. */
const FLARE_TAU = 3;
/** Sink rate (m/s) the flare settles at for touchdown. */
const FLARE_MIN_SINK = 0.6;
/** Bounds (m) on the flare height FLARE_TAU * sink rate. */
const FLARE_MIN_HEIGHT = 4;
const FLARE_MAX_HEIGHT = 25;
/** No flaring more than this far (m) before the touchdown point, however low: that is the approach lights. */
const FLARE_MAX_EARLY = 800;
/** Height (m) under which the flare takes the throttle to idle. */
const FLARE_IDLE_HEIGHT = 4;
/** The flare starts this many seconds of sink above the runway. */
const FLARE_GATE_TAU = 5;
/** Least throttle held in the flare above FLARE_IDLE_HEIGHT. */
const FLARE_POWER = 0.3;
/** Extra flare attitude (rad) per m/s sunk faster than the flare schedule (less when slower: a balloon). */
const FLARE_SINK_TO_PITCH = 0.03;
/** Bank allowed for centreline corrections in the flare: a wingtip is metres off the runway. */
const MAX_BANK_FLARE = 5 * Math.PI / 180;
/** The RTB speed ramp reaches its floor this far (m) out from the IAF. */
const RTB_SLOWED_BY_M = 3000;
/** Commanded speed per metre beyond that (m/s per m): 100 m/s off over 12.5 km. */
const RTB_SPEED_PER_M = 0.008;
/** Speed (m/s) over Vref the IAF is crossed at; final takes off the rest. */
const RTB_IAF_SPEED_MARGIN = 10;
/** Gear and flaps go down below this multiple of Vref. */
const CONFIGURE_SPEED_FACTOR = 1.5;

// --- Pattern (RTB legs) ------------------------------------------------------
/** Distance (m) before touchdown by which the aircraft is established on final. */
const JOIN_DISTANCE = 8000;
/** Downwind and base are flown at this multiple of Vref, configured. */
const PATTERN_SPEED_FACTOR = 1.3;
/** Bank (rad) the pattern geometry is laid out for; the heading loop may use more. */
const PATTERN_BANK = 30 * Math.PI / 180;
/** Downwind runs this far (m) past the join point before the base turn. */
const PATTERN_EXTENSION = 1500;
/** Downwind is extended until the speed is within this (m/s) of pattern speed. */
const PATTERN_TURN_SPEED_MARGIN = 20;
/** DIRECT with less room than 2 radii only when this nearly lined up already (rad). */
const DIRECT_MAX_HEADING_ERROR = 60 * Math.PI / 180;
/** Largest angle (rad) the centreline or downwind is intercepted at. */
const INTERCEPT_MAX = 45 * Math.PI / 180;
/** Capture distance of the intercepts, in turn radii: the offset at which the intercept is half its largest. */
const CAPTURE_RADII = 0.5;
/** Established on final: within this (m) of the centreline ... */
const ESTABLISHED_LATERAL = 150;
/** ... and this (rad) of the runway heading. */
const ESTABLISHED_HEADING_ERROR = 15 * Math.PI / 180;
/** Established DIRECT hands over to the approach up to this far (m) before the join point. */
const JOIN_HANDOFF_EARLY = 3000;
/** Distance (m) before touchdown the approach is down to Vref by. */
const VREF_BY_DISTANCE = 4000;
/** DIRECT gives up for the pattern if not established this far (m) inside the join point. */
const JOIN_LATE_MARGIN = 2000;
/** The base turn hands back to DIRECT within this (rad) of the runway heading. */
const BASE_ROLLOUT_HEADING_ERROR = 30 * Math.PI / 180;

/** Pattern minimum safe altitude: this far (m) above the highest ground ... */
const PATTERN_MSA_CLEARANCE = 300;
/** ... within this distance (m) ahead. */
const PATTERN_MSA_LOOKAHEAD = 6000;
/** Terrain scans sample every this many metres ... */
const TERRAIN_SCAN_STEP = 250;
/** ... across a swath this far (m) either side. */
const TERRAIN_SWATH_HALF_WIDTH = 800;
/** Downwind sides whose highest ground is within this (m) of each other count as equal. */
const PATTERN_SIDE_TERRAIN_TIE = 100;
/** On the final: never below the ground ahead + this (m) ... */
const APPROACH_TERRAIN_CLEARANCE = 150;
/** ... or this share of the glidepath's height over the runway, if less ... */
const APPROACH_TERRAIN_CLEARANCE_SHARE = 0.5;
/** ... looking this far (m) ahead ... */
const APPROACH_TERRAIN_LOOKAHEAD = 3000;
/** ... but not at the last this many metres before touchdown (the runway). */
const APPROACH_TERRAIN_CLEAR_OF_RUNWAY = 1500;
/** Sink (m/s) beyond the glidepath's own allowed in getting down to it from above. */
const APPROACH_MAX_EXTRA_SINK = 6;
/** The approach altitude trim only integrates within this (m) of the target. */
const APPROACH_TRIM_BAND = 40;
/** Approach height error (m) -> vertical speed correction (m/s per m). */
const APPROACH_VS_PER_ALT = 0.1;

// --- Stabilised approach and go-around --------------------------------------
/** Height (m above the runway) from which the approach must be stable. */
const GATE_HEIGHT = 150;
const GATE_MAX_LATERAL = 60;
const GATE_MAX_HEADING_ERROR = 15 * Math.PI / 180;
const GATE_MAX_HEIGHT_ERROR = 50;
/** Speed band (m/s) about Vref. */
const GATE_MAX_FAST = 15;
const GATE_MAX_SLOW = 10;
/** Distance (m) past the touchdown point the approach may get without flaring. */
const APPROACH_MAX_OVERRUN = 300;
/** Flare only with the wheels this far (m) inside the runway edge. */
const FLARE_EDGE_MARGIN = 5;
/** Distance (m) past the touchdown point the flare may float. */
const FLARE_MAX_FLOAT = 900;
/** Back in the air this high (m) after touching down is a bounce. */
const BOUNCE_HEIGHT = 3;
/** The approach aims this far (m) past the threshold ... */
const TOUCHDOWN_FROM_THRESHOLD = 300;
/** ... unless something stands this far (m) above the runway surface ... */
const RUNWAY_OBSTRUCTION_M = 1;
/** ... within this far (m) beyond it, which moves the aim this far (m) past that. */
const TOUCHDOWN_OBSTRUCTION_REACH = 500;
const TOUCHDOWN_PAST_OBSTRUCTION = 600;
/** Rollout: nose pitch (rad) -> forward stick, to put the nosewheel down ... */
const ROLLOUT_DEROTATE_GAIN = 3;
/** ... up to this much push. */
const ROLLOUT_MAX_PUSH = 0.5;
/** Highest nose attitude (rad) in the flare: a tail-scrape margin for a fighter on its main gear. */
const MAX_FLARE_PITCH = 14 * Math.PI / 180;
/** Go-around climb rate (m/s). */
const GO_AROUND_CLIMB_RATE = 12;
/** The go-around is over this high (m) above the runway, and the pattern flown again. */
const GO_AROUND_HEIGHT = 300;
/** Below this (m AGL) the go-around climbs without the terrain guard. */
const GO_AROUND_GUARD_AGL = 100;
/** Go-arounds on one runway before diverting to another. */
const MAX_GO_AROUNDS = 2;
/** Best sustained-turn airspeed (m/s). Faster = huge circles the player can sit in. */
const CORNER_SPEED = 180;
/** Angle-off above which pursuit bleeds toward corner speed for a tighter turn. */
const CORNER_SPEED_AO = 35 * Math.PI / 180;

const PITCH_KP = 1.0;                // pitch-angle error (rad) -> pitch command
// No AI pitch-RATE damping by default: the FM2 FCS already damps the short period
// internally, and feeding back a laggy finite-difference attitude rate here only
// adds phase lag that turns into a pilot-induced pitch oscillation. Left tunable
// for airframes/configs that need a little extra.
const PITCH_KD = 0;                  // pitch rate (rad/s) -> pitch command (damping)
// Slew-rate limit the pitch command (per second) so the AI cannot inject inputs
// near the airframe's short-period frequency (a PIO guard).
const PITCH_CMD_SLEW = 3.0;          // max change in pitch command per second
const VS_TO_PITCH = 0.02;            // vertical-speed error (m/s) -> pitch command
const VS_PER_ALT = 0.06;             // altitude error (m) -> desired vertical speed (m/s)
const MAX_VS = 120;                  // clamp on commanded vertical speed (m/s)
const PITCH_MIN = -0.6;
const PITCH_MAX = 0.9;

const THROTTLE_KP = 0.02;            // speed error (m/s) -> throttle rate (1/s)
const AIRFIELD_THROTTLE_KP = 0.04;   // speed error (m/s) -> throttle, proportional, in the airfield phases
// Overspeed protection. The FM2 airframe develops a lightly-damped transonic
// short-period that goes into a violent load-factor limit cycle (it rings even
// hands-off) above ~Mach 0.8, so the AI actively keeps its energy below that
// regime: it caps commanded speed, snaps the throttle to idle when fast, and —
// crucially, since throttle alone cannot arrest a dive — refuses to hold the nose
// down while overspeeding so the climb bleeds the excess speed back off. This is
// a mitigation for an airframe/aero characteristic, not a flight-model fix.
const MAX_SPEED = 240;               // speed ceiling (m/s); ring onset is ~250+ m/s
const OVERSPEED_IDLE_MARGIN = 8;     // hard-idle the throttle this far over the cap
const OVERSPEED_ELEV_GAIN = 0.02;    // overspeed (m/s) -> min nose-up angle (rad)
const OVERSPEED_ELEV_MAX = 0.4;      // cap on the overspeed nose-up floor (rad)

const ROTATE_SPEED = 90;             // takeoff rotation speed (m/s)
const GEAR_UP_ALT = 40;              // retract gear above this AGL (m)
const FLAPS_UP_SPEED = 150;          // retract flaps above this speed (m/s)
/** Keep the takeoff line this far (m) inside the runway edge. */
const TAKEOFF_EDGE_MARGIN = 6;
/** A takeoff starting this far (m) past a runway end still counts as on it. */
const RUNWAY_UNDER_SLACK = 100;
/** From a standstill, a takeoff holds the brakes at full power this long (s) first. */
const TAKEOFF_SPOOL_S = 4;
/** Aft stick the takeoff rotates with, and holds once off the wheels until climb-out. */
const TAKEOFF_ROTATE_STICK = 0.5;
/** Climb-out hands over to formation / the fight above this (m AGL), cleaned up. */
const CLIMB_OUT_HANDOFF_AGL = 300;
/** A parked wingman scrambles when its lead is within this range (m) ... */
const SCRAMBLE_LEAD_RANGE = 3000;
/** ... and height (m) of it - on the same field - ... */
const SCRAMBLE_LEAD_HEIGHT = 30;
/** ... and rolling faster than this (m/s). */
const SCRAMBLE_LEAD_SPEED = 15;

const FIRE_MISS_SLACK_M = 3;
const TERRAIN_LOOKAHEAD_S = 8;               // predictive GPWS horizon (s)

// --- Max-performance turn ("hard turn") -----------------------------------------
// The heading/elevation cascade is a cruise autopilot (~2 g). Whenever the aim
// point is far off the nose the AI flies a proper BFM turn instead: roll toward
// max bank, pull near the pitch limit, hand back to fine tracking once aligned.
const HARD_TURN_ENTER = 8 * Math.PI / 180;
const HARD_TURN_EXIT = 5 * Math.PI / 180;
const HARD_TURN_FULL_PULL_ANGLE = 45 * Math.PI / 180;
const HARD_TURN_MIN_PULL = 0.45;
const HARD_TURN_BANK_GAIN = 5.5;
const REVERSAL_LATCH_ENTER = 150 * Math.PI / 180;
const REVERSAL_LATCH_RELEASE = 110 * Math.PI / 180;

// --- Gun lead / target prediction ------------------------------------------------
const TARGET_ACCEL_CAP = 90;                 // ~9 g (m/s^2)
const TARGET_ACCEL_EMA = 0.25;

// --- Dogfight mode thresholds --------------------------------------------------
// A tracking threat is them pointed at us from our rear hemisphere. Without the
// rear-hemisphere gate a head-on merge reads as a threat and the AI breaks
// away, donating its six on every neutral merge.
const DEFENSIVE_AOT_THRESHOLD = 35 * Math.PI / 180;
const DEFENSIVE_CLEAR_AOT = 55 * Math.PI / 180;
const DEFENSIVE_REAR_HEMISPHERE = 90 * Math.PI / 180;
const DEFENSIVE_REAR_CLEAR = 75 * Math.PI / 180;
const DEFENSIVE_RANGE_MULT = 1.2;
const DEFENSIVE_CLEAR_RANGE_MULT = 1.5;

const YOYO_RANGE_TRIGGER = 350;
const YOYO_CLOSURE_TRIGGER = 90;
const HIGH_YOYO_PITCH_BONUS = 25 * Math.PI / 180;  // extra nose-up bias during a high yo-yo
const HIGH_YOYO_DURATION = 3.0;              // s, runs to completion once triggered
const HIGH_YOYO_MAX_BANK_MULT = 0.6;         // reduced bank during a high yo-yo (repositioning, not tracking)

const LOW_YOYO_ANGLE_OFF_TRIGGER = 130 * Math.PI / 180;  // angle-off beyond which a lead turn is unflyable
const LOW_YOYO_ENERGY_EDGE = 150;            // need at least this much of an energy edge (m) to spend it
const LOW_YOYO_PITCH_DROP = 15 * Math.PI / 180;    // nose-down bias to cut across the turn circle
const LOW_YOYO_DURATION = 2.5;               // s

// Stay in aggressive lead pursuit longer — lag pursuit was flying large circles
// instead of cutting inside to get guns on. Only lag when the lead point is truly
// unflyable (near reverse).
const LAG_ANGLE_OFF_TRIGGER = 125 * Math.PI / 180;
const LAG_BLEND_MAX = 0.55;

const EXTEND_MIN_DURATION = 2.0;             // s, avoids instantly flip-flopping back into a losing fight
const EXTEND_RECOVER_MARGIN = 150;           // resume pursuit once within this much of the target's energy (m)

// --- Formation (wingman) -------------------------------------------------------
/**
 * Echelon-right wing slot, measured in the lead's horizontal frame: aft, out to
 * the side, and stacked slightly low so the wingman is visible from the lead's
 * cockpit and its wake stays clear of the lead. Exported so a wingman can be
 * *spawned* onto the same slot its pilot will then fly.
 */
export const FORMATION_SLOT = {
    /** Metres behind the lead. */
    trail: 70,
    /** Metres to the lead's right. */
    side: 45,
    /** Metres above the lead (negative = stacked low). */
    stack: -12,
} as const;
// Rejoin (fly *at* the slot) vs. station-keeping (fly the lead's heading and
// trim out the residual offsets). Hysteresis, or the controller switches
// steering law every frame while sitting on the boundary.
const FORMATION_REJOIN_ENTER_M = 600;
const FORMATION_REJOIN_RELEASE_M = 350;
/** Overtake speed allowed while closing on the slot (m/s over the lead). */
const FORMATION_REJOIN_OVERTAKE = 60;
/** Cross-track error (m) -> heading offset from the lead's heading (rad/m). */
const FORMATION_HEADING_PER_CROSS = 0.0016;
const FORMATION_MAX_HEADING_OFFSET = 20 * Math.PI / 180;
/**
 * Along-track station keeping: proportional on the position error, damped by the
 * closing rate. The damping term is not optional — the inner speed loop (throttle
 * integrator + airframe) lags the position loop badly, and a P-only outer loop
 * limit-cycles: it overshoots the slot, brakes, sinks, accelerates, climbs, and
 * repeats with a ~45 s period that never settles.
 */
const FORMATION_SPEED_PER_ALONG = 0.20;
const FORMATION_SPEED_PER_CLOSURE = 0.8;
const FORMATION_SPEED_TRIM = 25;
const FORMATION_MAX_BANK = 60 * Math.PI / 180;
/**
 * Below this lead speed (m/s) there is no formation to fly — the lead is parked
 * or rolling out. Hold overhead instead of descending to sit on a stationary
 * slot.
 */
const FORMATION_LEAD_MIN_SPEED = 50;
/** Beyond this, holding overhead first closes the distance to the lead. */
const FORMATION_HOLD_RECENTER_M = 2500;
/**
 * Speedbrake thresholds (m/s over the commanded speed) for station keeping
 * and for slowing down to land. Idle thrust alone does not slow a clean airframe down at altitude — without
 * the brake the wingman creeps forward past the slot, and once it is ahead the
 * heading loop cannot recover the along-track error. Hysteresis so the boards
 * don't cycle in and out every frame.
 */
const AIRBRAKE_ENTER = 8;
const AIRBRAKE_RELEASE = 3;
/**
 * Integral trim (m) on the commanded slot altitude. The shared altitude hold
 * ends in a proportional-only pitch-attitude loop, which droops: a standing
 * climb demand settles with the nose short of the commanded angle and the
 * aircraft stabilises ~150 m below its target. Every phase lives with that, but
 * on a wing slot it reads as the wingman flying visibly low, so formation
 * integrates the residual away. Bounded for anti-windup.
 */
const FORMATION_ALT_TRIM_RATE = 0.03;
const FORMATION_ALT_TRIM_MAX = 400;

export class AiPilot implements AiPilotController {

    private phase: AiFlightPhase = AiFlightPhase.NAVIGATE;
    private route: AiRoute | undefined;
    /** Each runway turned round, kept so its per-runway caches stay warm. */
    private readonly reversed = new WeakMap<Runway, Runway>();
    /** The runway this pilot committed to; see {@link homeRunway}. */
    private runwayChoice: Runway | undefined;
    /** Per runway, see {@link touchdownFromThreshold}. */
    private readonly touchdownDistances = new WeakMap<Runway, { aim: number; clearFrom: number }>();
    /** Scratch for {@link touchdownPoint}. */
    private readonly touchdown = { x: 0, y: 0, z: 0, heading: 0 };
    private target: Combatant | undefined;

    private readonly cruiseAltitude: number;
    private readonly cruiseSpeed: number;
    private readonly combatSpeed: number;
    private readonly maxSpeed: number;
    private readonly bulletSpeed: number;
    private readonly gunRange: number;
    private readonly hardDeck: number;
    private readonly pitchKp: number;
    private readonly pitchKd: number;
    private readonly pitchSlew: number;
    private readonly skill: AiSkillLevel;
    private readonly skillTuning: SkillTuning;
    /** When true, the AI never enters EXTEND (never turns tail to rebuild energy). */
    private readonly alwaysEngage: boolean;

    /** Latest throttle command (integrated by the speed controller). */
    private throttleCmd = 0.5;
    /** Set true by the engage phase when a valid gun solution exists this frame. */
    private firing = false;
    /** Previous frame had a valid gun solution (used to gate HIGH_YOYO). */
    private hadSolution = false;
    /** Hard-turn latch: stay in max-performance turn until nearly aligned. */
    private hardTurnActive = false;
    /** Reversal direction latch for near-180 deg turn commits. */
    private reversalDir = 0;
    /** Pull-up override latch to add hysteresis to the GPWS. */
    private pullUpActive = false;
    /** Latched turn direction (+1/-1/0) to resolve the +/-180 deg heading ambiguity. */
    private turnDir = 0;

    /** Heading held while in {@link AiFlightPhase.STRAIGHT}. */
    private straightHeading = 0;
    private straightHeadingLatched = false;

    // --- Formation sub-state (FORMATION phase only) ---------------------------
    /** Aircraft whose wing this pilot flies, when acting as a wingman. */
    private formationLead: Combatant | undefined;
    /** Latched rejoin/station-keeping mode (see FORMATION_REJOIN_* thresholds). */
    private formationRejoining = true;
    /** Latched speedbrake state of {@link commandSpeedWithAirbrakes} (see AIRBRAKE_*). */
    private airbrakesLatched = false;
    /** Integral trim on the commanded slot altitude (see FORMATION_ALT_TRIM_*). */
    private formationAltTrim = 0;
    /** Integral trim on the glidepath height (see APPROACH_ALT_TRIM_*). */
    private approachAltTrim = 0;
    /** Low-passed nose-above-flight-path angle (rad); see commandVerticalSpeed's holdPath. */
    private pathOffsetEst = 0;
    /** Integral pitch stick of commandElevation's integrate mode. */
    private pitchTrimI = 0;
    /** Vertical-speed bias carried from the glidepath into the flare (m/s). */
    private flareVsBias = 0;
    /** Height (m AGL) the flare started at, for fading out {@link flareVsBias}. */
    private flareEntryHeight = 1;
    /** Nose pitch (rad) at the flare gate, where the flare's attitude ramp starts. */
    private flareEntryNose = 0;
    /** Direction (rad) and line (m off the centreline) the takeoff holds; see lineUp. */
    private takeoffHeading = 0;
    private takeoffLateral = 0;
    /** Line up on the next takeoff frame; see setPhase. */
    private lineUpPending = false;
    /** Seconds left holding the brakes at full power before the roll; see doTakeoff. */
    private spoolTimer = 0;
    /** Lowest height (m AGL) since touchdown: the CG on its wheels, for the bounce check. */
    private rolloutRestAgl = Infinity;
    /** Leg of the way round to final being flown in RTB (see {@link doRtb}). */
    private rtbLeg = RtbLeg.PLAN;
    /** Side of the centreline the downwind and base turn are on: +1 along (cos h, -sin h), -1 the other. */
    private patternSide: 1 | -1 = 1;
    /** Turn radius (m) the pattern was laid out with. */
    private patternRadius = 2000;
    /** Centre of the base turn, world XZ. */
    private readonly baseCentre = { x: 0, z: 0 };
    /** Go-arounds flown on the current runway; see MAX_GO_AROUNDS. */
    private goArounds = 0;
    /** Why the last go-around was flown, for the maneuver label. */
    private goAroundReason = '';

    // --- Dogfight sub-state (ENGAGE phase only) -------------------------------
    private dogfightMode: DogfightMode = DogfightMode.PURSUE;
    /** Seconds the target has had a sustained tracking angle on us. */
    private threatTimer = 0;
    /** Seconds spent in the current timed maneuver (HIGH_YOYO/LOW_YOYO/EXTEND). */
    private maneuverTimer = 0;
    /** Low-passed target acceleration for gun-lead prediction. */
    private readonly targetAcc = new THREE.Vector3();
    private readonly prevTvel = new THREE.Vector3();
    private hasPrevTvel = false;
    /** Last ballistic time-of-flight from the most recent aim computation (s). */
    private lastTof = 0;

    // Pitch-rate estimate (finite-differenced, low-passed) for pitch-loop damping.
    private prevNosePitch = 0;
    private hasPrevAttitude = false;
    private pitchRateEst = 0;
    // Slew-limited pitch command state (see PITCH_CMD_SLEW).
    private pitchCmdState = 0;
    private lastDelta = 1 / 60;

    // Scratch vectors (avoid per-frame allocation).
    private readonly pos = new THREE.Vector3();
    private readonly vel = new THREE.Vector3();
    private readonly quat = new THREE.Quaternion();
    private readonly fwd = new THREE.Vector3();
    private readonly right = new THREE.Vector3();
    private readonly up = new THREE.Vector3();
    private readonly tpos = new THREE.Vector3();
    private readonly tvel = new THREE.Vector3();
    private readonly aim = new THREE.Vector3();
    private readonly probe = new THREE.Vector3();
    private readonly toPoint = new THREE.Vector3();
    private readonly bulletVel = new THREE.Vector3();
    private readonly aimDir = new THREE.Vector3();
    private readonly lpos = new THREE.Vector3();
    private readonly lvel = new THREE.Vector3();
    private readonly slot = new THREE.Vector3();
    private readonly leadFwd = new THREE.Vector3();
    private readonly leadRight = new THREE.Vector3();
    private readonly toSlot = new THREE.Vector3();

    constructor(
        private readonly aircraft: PilotableAircraft,
        private readonly world: WorldQuery,
        options: AiPilotOptions = {},
    ) {
        this.cruiseAltitude = options.cruiseAltitude ?? 3000;
        this.cruiseSpeed = options.cruiseSpeed ?? 220;
        // Default stays near corner speed so pursuit doesn't open into huge circles.
        this.combatSpeed = options.combatSpeed ?? 220;
        this.maxSpeed = options.maxSpeed ?? MAX_SPEED;
        this.bulletSpeed = options.bulletSpeed ?? 1000;
        this.gunRange = options.gunRange ?? 900;
        this.hardDeck = options.hardDeck ?? 150;
        this.pitchKp = options.pitchKp ?? PITCH_KP;
        this.pitchKd = options.pitchKd ?? PITCH_KD;
        this.pitchSlew = options.pitchSlew ?? PITCH_CMD_SLEW;
        this.skill = options.skill ?? AiSkillLevel.ACE;
        this.skillTuning = SKILL_TUNING[this.skill];
        this.alwaysEngage = options.alwaysEngage ?? false;
    }

    getPhase(): AiFlightPhase {
        return this.phase;
    }

    /** Current dogfight maneuver sub-state (only meaningful during ENGAGE). */
    getDogfightMode(): DogfightMode {
        return this.dogfightMode;
    }

    getManeuverLabel(): string {
        if (this.phase !== AiFlightPhase.ENGAGE) {
            if (this.phase === AiFlightPhase.GO_AROUND) {
                return `GO_AROUND:${this.goAroundReason}`;
            }
            if (this.phase === AiFlightPhase.RTB && this.rtbLeg !== RtbLeg.PLAN) {
                return `RTB:${RtbLeg[this.rtbLeg]}`;
            }
            return AiFlightPhase[this.phase] ?? 'CLASSIC';
        }
        return DogfightMode[this.dogfightMode] ?? 'PURSUE';
    }

    setPhase(phase: AiFlightPhase): void {
        // Entry side effects run on a change only. Shaw / Aggressive / Ace hand
        // every non-ENGAGE frame to this pilot through setPhase, so without the
        // guard each phase would be re-entered - and its state re-armed - every
        // tick.
        if (phase === this.phase) {
            return;
        }
        this.phase = phase;
        if (phase === AiFlightPhase.STRAIGHT) {
            this.straightHeadingLatched = false;
        }
        if (phase === AiFlightPhase.RTB) {
            // Turning for home is the moment to decide where home is: by now
            // the aircraft may be a long way from where it took off, and the
            // nearest field is the one it should be going to.
            this.runwayChoice = undefined;
            this.rtbLeg = RtbLeg.PLAN;
            this.goArounds = 0;
        }
        if (phase === AiFlightPhase.APPROACH) {
            this.approachAltTrim = 0;
        }
        if (phase === AiFlightPhase.TAKEOFF_ROLL) {
            // On the first takeoff frame, not here: between frames the pilot's
            // picture of where it is can be stale - for the player's autopilot
            // it is wherever it last flew - and lining up from that picked
            // GCLP's parallel runway and steered off the side of its own.
            this.lineUpPending = true;
        }
        if (phase === AiFlightPhase.FORMATION) {
            // Enter via the rejoin law: a fresh formation assignment is almost
            // always from a separation, and it releases on its own once close.
            this.formationRejoining = true;
            this.formationAltTrim = 0;
        }
    }

    setTarget(target: Combatant | undefined): void {
        this.target = target;
    }

    setFormationLead(lead: Combatant | undefined): void {
        this.formationLead = lead;
    }

    setRoute(route: AiRoute | undefined): void {
        this.route = route;
    }

    /** True while a firing solution exists this frame (read after update). */
    get isFiring(): boolean {
        return this.firing;
    }

    /** Begin an autonomous takeoff from the current runway. */
    startTakeoff(): void {
        this.setPhase(AiFlightPhase.TAKEOFF_ROLL);
    }

    /**
     * Line up for a takeoff from where the aircraft stands: the runway under
     * it, flown the way the nose already points (not its landing direction,
     * which could mean a U-turn on the runway), along the line it is on - so
     * a wingman parked beside the lead rolls beside it, not into it.
     */
    private lineUp(): void {
        const rwy = this.runwayUnder();
        this.runwayChoice = rwy;
        const reciprocal = Math.abs(wrapPi(rwy.heading - this.heading)) > Math.PI / 2;
        this.takeoffHeading = reciprocal ? wrapPi(rwy.heading + Math.PI) : rwy.heading;
        this.takeoffLateral = clamp(this.takeoffOffset(rwy), -(rwy.halfWidth - TAKEOFF_EDGE_MARGIN),
            rwy.halfWidth - TAKEOFF_EDGE_MARGIN);
    }

    /**
     * The runway the aircraft is standing on: within its length, least far
     * off its centreline. Not the nearest by centre, which beside a parallel
     * pair (GCLP's 03L/03R) can be the other one - the takeoff then steered
     * for a line on the neighbouring runway and ran off the side of its own.
     */
    private runwayUnder(): Runway {
        let best: Runway | undefined;
        let bestOff = Infinity;
        for (const r of this.world.runways()) {
            const dx = this.pos.x - r.center.x;
            const dz = this.pos.z - r.center.z;
            const along = dx * Math.sin(r.heading) + dz * Math.cos(r.heading);
            const off = Math.abs(dx * Math.cos(r.heading) - dz * Math.sin(r.heading));
            if (Math.abs(along) <= r.halfLength + RUNWAY_UNDER_SLACK && off < bestOff) {
                bestOff = off;
                best = r;
            }
        }
        return best ?? this.world.nearestRunway(this.pos.x, this.pos.z);
    }

    /** Offset (m) from the runway centreline along the takeoff direction's (cos h, -sin h). */
    private takeoffOffset(rwy: Runway): number {
        const h = this.takeoffHeading;
        return (this.pos.x - rwy.center.x) * Math.cos(h) - (this.pos.z - rwy.center.z) * Math.sin(h);
    }

    // -------------------------------------------------------------------------

    update(delta: number): void {
        this.firing = false;
        const ac = this.aircraft;
        if (ac.isCrashed()) {
            ac.setThrottle(0);
            ac.setWheelBrakes(true);
            return;
        }

        this.readState(delta);

        // Safety layer: predictive terrain/ground pull-up pre-empts any airborne
        // mission phase (but not deliberate ground contact near the runway).
        const groundPhase = this.phase === AiFlightPhase.GROUND_IDLE
            || this.phase === AiFlightPhase.TAKEOFF_ROLL
            || this.phase === AiFlightPhase.FLARE
            || this.phase === AiFlightPhase.ROLLOUT;
        // A go-around starts at flare height, sinking: the look-ahead would see
        // the runway and pull a max-g pull-up at approach speed. It is a climb
        // at full power anyway; the guard takes over once it is clear of the
        // ground.
        const climbingAway = this.phase === AiFlightPhase.GO_AROUND
            && this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z) < GO_AROUND_GUARD_AGL;
        // Inside the stabilised-approach gate the look-ahead only ever sees the
        // runway coming up, and a sink a little over nominal read as terrain:
        // a full-power pull-up at 30 m that ballooned the flare. The gate has
        // just checked the approach, and the go-around covers it from there.
        const insideGate = this.phase === AiFlightPhase.APPROACH
            && this.pos.y - this.touchdownPoint(this.homeRunway()).y < GATE_HEIGHT;
        if (!groundPhase && !climbingAway && !insideGate && this.updateTerrainAvoidance(delta)) {
            return;
        }

        switch (this.phase) {
            case AiFlightPhase.GROUND_IDLE: this.doGroundIdle(); break;
            case AiFlightPhase.TAKEOFF_ROLL: this.doTakeoff(delta); break;
            case AiFlightPhase.CLIMB_OUT: this.doClimbOut(delta); break;
            case AiFlightPhase.NAVIGATE: this.doNavigate(delta); break;
            case AiFlightPhase.STRAIGHT: this.doStraight(delta); break;
            case AiFlightPhase.FORMATION: this.doFormation(delta); break;
            case AiFlightPhase.ENGAGE: this.doEngage(delta); break;
            case AiFlightPhase.RTB: this.doRtb(delta); break;
            case AiFlightPhase.APPROACH: this.doApproach(delta); break;
            case AiFlightPhase.FLARE: this.doFlare(delta); break;
            case AiFlightPhase.ROLLOUT: this.doRollout(); break;
            case AiFlightPhase.GO_AROUND: this.doGoAround(delta); break;
            case AiFlightPhase.WAYPOINT: this.doWaypoint(delta); break;
        }
    }

    // --- State ---------------------------------------------------------------

    private readState(delta: number): void {
        this.lastDelta = delta > 1e-4 ? delta : this.lastDelta;
        this.pos.copy(this.aircraft.getPosition());
        this.vel.copy(this.aircraft.getVelocity());
        this.quat.copy(this.aircraft.getQuaternion());
        this.fwd.copy(FORWARD).applyQuaternion(this.quat);
        this.right.copy(RIGHT).applyQuaternion(this.quat);
        this.up.copy(UP).applyQuaternion(this.quat);

        // Finite-difference attitude rates for loop damping (guard first frame /
        // tiny dt, and wrap the bank difference across the +/-pi seam).
        const nosePitch = this.nosePitch;
        if (this.hasPrevAttitude && delta > 1e-4) {
            const pitchRateRaw = (nosePitch - this.prevNosePitch) / delta;
            // Low-pass the finite-difference rate so the pitch damping term does
            // not chatter on the discrete-time signal.
            this.pitchRateEst += (pitchRateRaw - this.pitchRateEst) * RATE_EMA;
        } else {
            this.pitchRateEst = 0;
        }
        this.prevNosePitch = nosePitch;
        this.hasPrevAttitude = true;

        // Nose above the flight path: the angle of attack, seen in the vertical
        // plane, which is the part a climb-rate command has to add.
        // Held through the flare: there the nose is meant to come up while the
        // path follows a beat later, and an estimate that tracked it would
        // chase the nose back down.
        const speed = this.vel.length();
        if (speed > 1 && this.phase !== AiFlightPhase.FLARE) {
            const offset = nosePitch - Math.asin(clamp(this.vel.y / speed, -1, 1));
            this.pathOffsetEst += (clamp(offset, -0.4, 0.4) - this.pathOffsetEst) * PATH_OFFSET_EMA;
        }
    }

    private get heading(): number {
        return Math.atan2(this.fwd.x, this.fwd.z);
    }

    /**
     * Bank angle, +right (rad), full +/-pi range. Using atan2 (rather than asin)
     * of the body-right and body-up vertical components resolves the upright vs
     * inverted ambiguity, so the roll controller recovers instead of diverging.
     */
    private get bank(): number {
        return Math.atan2(this.right.y, this.up.y);
    }

    /** Nose pitch angle above horizon (rad). */
    private get nosePitch(): number {
        return Math.asin(clamp(this.fwd.y, -1, 1));
    }

    // --- Inner controllers ---------------------------------------------------

    /** Roll toward a desired bank. Proportional on the rate-commanded roll axis. */
    private commandBank(desiredBank: number): number {
        const rollCmd = clamp((desiredBank - this.bank) * ROLL_KP, -1, 1);
        this.aircraft.setRoll(rollCmd);
        return rollCmd;
    }

    /** Bank-to-turn toward a heading, with mild coordinating yaw. */
    private commandHeading(desiredHeading: number, maxBank: number): void {
        let hErr = wrapPi(desiredHeading - this.heading);
        // Commit to a single turn direction through the +/-180 ambiguity so the
        // bank command does not chatter and the reversal actually completes. The
        // latch engages past ENTER and stays applied until the error shrinks
        // below RELEASE (hysteresis), covering the whole ambiguous band.
        if (this.turnDir !== 0) {
            if (Math.abs(hErr) < TURN_LATCH_RELEASE) {
                this.turnDir = 0;
            } else {
                hErr = this.turnDir * Math.abs(hErr);
            }
        } else if (Math.abs(hErr) > TURN_LATCH_ENTER) {
            this.turnDir = hErr >= 0 ? 1 : -1;
            hErr = this.turnDir * Math.abs(hErr);
        }
        if (Math.abs(hErr) < HEADING_DEADBAND) {
            hErr = 0;
        }
        // Positive bank yields a negative heading rate in this frame convention,
        // so a positive heading error needs a negative (opposite) bank.
        const desiredBank = clamp(-hErr * BANK_PER_HEADING, -maxBank, maxBank);
        this.commandBank(desiredBank);
        // A touch of into-turn rudder, proportional to bank (not the raw roll
        // command) so a hard rollout does not slam the rudder and induce PIO.
        this.aircraft.setYaw(clamp(this.bank * ROLL_YAW_COORD, -0.3, 0.3));
    }

    /** Hold/seek an altitude via a vertical-speed inner loop. */
    private commandAltitude(desiredAlt: number): void {
        const altErr = desiredAlt - this.pos.y;
        const desiredVs = clamp(altErr * VS_PER_ALT, -MAX_VS, MAX_VS);
        this.commandVerticalSpeed(desiredVs);
    }

    /**
     * @param holdPath Add the angle of attack to the nose target, so the
     * flight path rather than the nose is what gets held. Slow and dirty that
     * angle is large: without it a level-off at approach speed settles 200 m
     * low, and a glidepath porpoises into the terrain guard. Used by the
     * airfield phases only; the others are tuned without it.
     */
    private commandVerticalSpeed(desiredVs: number, holdPath = false): void {
        // Cascade the climb request through the pitch-ATTITUDE loop instead of
        // mapping vertical-speed error straight to a stick/g command. A single
        // high-gain P term from vs-error to g has no phase margin at high dynamic
        // pressure and drives a ~2 s phugoid PIO (nose + load factor ringing while
        // altitude barely tracks). Converting the target climb rate into a target
        // flight-path/nose angle and holding that with commandElevation (P on
        // pitch error + pitch-rate damping) gives a well-damped inner loop.
        const speed = Math.max(30, this.aircraft.getAirspeed());
        const gamma = Math.asin(clamp(desiredVs / speed, -0.4, 0.4));
        // Small proportional trim on the residual vs-error keeps the achieved
        // climb honest despite the (unmodelled) angle-of-attack offset, but with a
        // gentle gain so it cannot dominate the attitude loop.
        let desiredNose = gamma + clamp((desiredVs - this.vel.y) * VS_TO_PITCH, -0.1, 0.1)
            + (holdPath ? this.pathOffsetEst : 0);
        if (this.phase === AiFlightPhase.FLARE) {
            // The tail is on the ground past this; better a firmer arrival.
            desiredNose = Math.min(desiredNose, MAX_FLARE_PITCH);
        }
        this.commandElevation(desiredNose, holdPath);
    }

    /**
     * Point the nose at a target elevation angle (used to aim at a 3D point).
     *
     * @param integrate Add an integral term on the nose error. The proportional
     * gain is tuned for fighting speeds; at approach speed the same stick moves
     * the nose far less, and P alone settled 14 deg short of the target with the
     * aircraft sinking away under it. Any call without it clears the integral.
     */
    private commandElevation(desiredElev: number, integrate = false): void {
        desiredElev = clamp(desiredElev, -MAX_ELEV_CMD, MAX_ELEV_CMD);
        // Overspeed guard (common funnel for every airborne pitch command): while
        // faster than the ceiling, raise the floor on the commanded nose angle so
        // the AI cannot hold a dive that drives deeper into the transonic
        // limit-cycle regime — the shallower/climbing nose bleeds the speed off.
        const over = this.aircraft.getAirspeed() - this.maxSpeed;
        if (over > 0) {
            desiredElev = Math.max(desiredElev, clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX));
        }
        const pitchErr = desiredElev - this.nosePitch;
        const flare = this.phase === AiFlightPhase.FLARE;
        const trimMax = flare ? PITCH_TRIM_MAX_FLARE : PITCH_TRIM_MAX;
        const trimKi = flare ? PITCH_TRIM_KI_FLARE : PITCH_TRIM_KI;
        this.pitchTrimI = integrate
            ? clamp(this.pitchTrimI + pitchErr * trimKi * this.lastDelta, -trimMax, trimMax)
            : 0;
        // The gains are tuned at fighting speeds, where a little stick moves the
        // nose a long way. Slow, the same stick does a fraction of that, so in
        // integrate mode (the airfield phases) they are scheduled up with the
        // fall in dynamic pressure.
        const gain = integrate
            ? clamp((PITCH_GAIN_REF_SPEED / Math.max(1, this.aircraft.getAirspeed())) ** 2, 1,
                this.phase === AiFlightPhase.FLARE ? PITCH_GAIN_MAX_SCALE_FLARE : PITCH_GAIN_MAX_SCALE)
            : 1;
        const raw = gain * (pitchErr * this.pitchKp - this.pitchRateEst * this.pitchKd)
            + this.bankPitchComp() + this.pitchTrimI;
        this.applyPitch(raw);
    }

    /**
     * Clamp, then slew-rate limit the pitch command before it reaches the model.
     * The rate limit is the key PIO suppressor: it stops the controller from
     * injecting inputs near the airframe's lightly-damped short-period frequency.
     */
    private applyPitch(raw: number): void {
        const target = this.limitPitchForAttitude(raw);
        const maxStep = this.pitchSlew * this.lastDelta;
        this.pitchCmdState += clamp(target - this.pitchCmdState, -maxStep, maxStep);
        this.aircraft.setPitch(this.pitchCmdState);
    }

    /** Immediate pitch command without slew limiting — used for max-g hard turns. */
    private applyPitchImmediate(raw: number): void {
        this.pitchCmdState = this.limitPitchForAttitude(raw);
        this.aircraft.setPitch(this.pitchCmdState);
    }

    /**
     * Max-performance turn toward a world-space direction: roll hard toward the
     * aim bearing and pull near the pitch limit, easing off as the nose closes.
     * Returns true while the hard turn is active this frame.
     */
    private commandHardTurn(aimDirection: THREE.Vector3, delta: number, desiredSpeed: number): boolean {
        this.aimDir.copy(aimDirection);
        if (this.aimDir.lengthSq() < 1e-9) {
            return false;
        }
        this.aimDir.normalize();

        const aimAngle = Math.acos(clamp(this.fwd.dot(this.aimDir), -1, 1));
        if (this.hardTurnActive) {
            if (aimAngle < HARD_TURN_EXIT) {
                this.hardTurnActive = false;
            }
        } else if (aimAngle > HARD_TURN_ENTER) {
            this.hardTurnActive = true;
        }
        if (!this.hardTurnActive) {
            return false;
        }

        let desiredHeading = Math.atan2(this.aimDir.x, this.aimDir.z);
        desiredHeading = this.avoidObstacles(desiredHeading);
        let hErr = wrapPi(desiredHeading - this.heading);
        if (this.reversalDir !== 0) {
            if (Math.abs(hErr) < REVERSAL_LATCH_RELEASE) {
                this.reversalDir = 0;
            } else {
                hErr = this.reversalDir * Math.abs(hErr);
            }
        } else if (Math.abs(hErr) > REVERSAL_LATCH_ENTER) {
            this.reversalDir = hErr >= 0 ? 1 : -1;
            hErr = this.reversalDir * Math.abs(hErr);
        }
        const desiredBank = clamp(-hErr * HARD_TURN_BANK_GAIN, -MAX_BANK_COMBAT, MAX_BANK_COMBAT);
        this.commandBank(desiredBank);
        this.aircraft.setYaw(clamp(this.bank * ROLL_YAW_COORD, -0.3, 0.3));

        const pullT = clamp(aimAngle / HARD_TURN_FULL_PULL_ANGLE, 0, 1);
        const pull = HARD_TURN_MIN_PULL + pullT * (PITCH_MAX - HARD_TURN_MIN_PULL);
        this.applyPitchImmediate(pull);

        // Overspeed guard still applies during hard turns.
        const over = this.aircraft.getAirspeed() - this.maxSpeed;
        if (over > 0) {
            const floor = clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX);
            this.applyPitchImmediate(Math.max(pull, floor));
        }

        this.commandSpeed(desiredSpeed, delta);
        return true;
    }

    /**
     * Clamp a raw pitch command. While inverted (body up points down) a nose-up
     * elevator command pulls the nose toward the ground, so we suppress aft stick
     * and let the roll loop bring the aircraft upright first.
     */
    private limitPitchForAttitude(pitch: number): number {
        if (this.up.y < 0) {
            return clamp(pitch, PITCH_MIN, 0.1);
        }
        return clamp(pitch, PITCH_MIN, PITCH_MAX);
    }

    /** Extra back-pressure to hold the nose up while banked (upright only). */
    private bankPitchComp(): number {
        // No benefit past knife-edge: adding aft stick there deepens a dive.
        if (this.up.y <= 0) return 0;
        const c = Math.cos(clamp(this.bank, -1.4, 1.4));
        if (c <= 0.05) return 0.35;
        return clamp((1 / c - 1) * 0.25, 0, 0.5);
    }

    /**
     * @param kp Proportional throttle per m/s of speed error, on top of the
     * integrator. The airfield phases use it: holding a path slow with the
     * integrator alone traded speed against path in a 25 s oscillation (75-100
     * m/s, AoA 7-21 deg) the go-around gate kept catching.
     */
    private commandSpeed(desiredSpeed: number, delta: number, kp = 0): void {
        // Never target a speed inside the transonic ring, and snap to idle when
        // clearly overspeeding so the slow throttle integrator stops feeding energy
        // into a dive (throttle alone cannot arrest it — see the elevation guard).
        desiredSpeed = Math.min(desiredSpeed, this.maxSpeed);
        const airspeed = this.aircraft.getAirspeed();
        const speedErr = desiredSpeed - airspeed;
        this.throttleCmd = clamp(this.throttleCmd + speedErr * THROTTLE_KP * delta, 0, 1);
        if (airspeed > this.maxSpeed + OVERSPEED_IDLE_MARGIN) {
            this.throttleCmd = 0;
        }
        this.aircraft.setThrottle(clamp(this.throttleCmd + speedErr * kp, 0, 1));
    }

    private wingsLevel(): void {
        this.commandBank(0);
        this.aircraft.setYaw(0);
    }

    // --- Safety layer --------------------------------------------------------

    /**
     * Predictive ground-proximity warning: sample terrain along the projected
     * flight path and pull up if the aircraft would bust its hard deck. Returns
     * true when the pull-up override is engaged this frame.
     */
    private updateTerrainAvoidance(delta: number): boolean {
        let minClearance = Infinity;
        // Probe points from now to the look-ahead horizon.
        // Clearance is measured against the deck at each point, not the deck
        // here: on an approach the deck shrinks to nothing at the runway.
        let minMargin = Infinity;
        for (let t = 0.5; t <= TERRAIN_LOOKAHEAD_S; t += 0.5) {
            this.probe.copy(this.vel).multiplyScalar(t).add(this.pos);
            const deck = this.terrainDeckAt(this.probe.x, this.probe.z);
            if (deck < 0) {
                continue;
            }
            const g = this.world.groundHeightAt(this.probe.x, this.probe.z);
            const margin = this.probe.y - g - deck;
            if (margin < minMargin) {
                minMargin = margin;
            }
        }
        // Also consider the current instantaneous clearance.
        const nowDeck = Math.max(0, this.terrainDeckAt(this.pos.x, this.pos.z));
        const nowMargin = this.terrainDeckAt(this.pos.x, this.pos.z) < 0
            ? Infinity
            : this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z) - nowDeck;
        minMargin = Math.min(minMargin, nowMargin);

        // Hysteresis: engage below the deck, release once comfortably above it.
        if (this.pullUpActive) {
            if (minMargin > nowDeck && nowMargin > 0) {
                this.pullUpActive = false;
            }
        } else if (minMargin < 0) {
            this.pullUpActive = true;
        }

        if (!this.pullUpActive) {
            return false;
        }

        // Wings level + hard nose-up + full power until clear.
        this.wingsLevel();
        this.applyPitch(PITCH_MAX);
        this.throttleCmd = 1;
        this.aircraft.setThrottle(1);
        // Cleaning up on an approach would leave it to come back round with
        // the gear still up.
        if (this.phase !== AiFlightPhase.APPROACH) {
            this.aircraft.setLandingGearDeployed(false);
        }
        return true;
    }

    /**
     * How far above the ground at (x, z) the terrain guard insists on being.
     *
     * The hard deck, except on an approach: there the aircraft is meant to go
     * below it, all the way to the runway, so the deck follows the glidepath
     * down and is a fraction of the height the glidepath has at that point.
     * Terrain still trips it when it rises into the approach, and near the
     * runway, where the glidepath is at the ground, it is gone.
     *
     * Negative past the touchdown point: the ground there is the runway being
     * landed on, and a look-ahead that reached it would pull up off every
     * correctly flown final.
     */
    private terrainDeckAt(x: number, z: number): number {
        if (this.phase !== AiFlightPhase.APPROACH) {
            return this.hardDeck;
        }
        const td = this.touchdownPoint(this.homeRunway());
        const fwdX = Math.sin(td.heading);
        const fwdZ = Math.cos(td.heading);
        const distToTouchdown = -((x - td.x) * fwdX + (z - td.z) * fwdZ);
        if (distToTouchdown <= 0) {
            return -1;
        }
        const glidepathHeight = td.y + distToTouchdown * GLIDESLOPE - this.world.groundHeightAt(x, z);
        return clamp(glidepathHeight * APPROACH_DECK_FRACTION, 0, this.hardDeck);
    }

    /** Adjust a desired heading to steer around a nearby static obstacle. */
    private avoidObstacles(desiredHeading: number): number {
        const world = this.world;
        if (!(world instanceof SceneWorldQuery)) {
            return desiredHeading;
        }
        const horizon = Math.max(400, this.aircraft.getAirspeed() * 4);
        const o = world.nearestObstacleWithin(this.pos.x, this.pos.z, horizon);
        if (!o) {
            return desiredHeading;
        }
        // Only worry about obstacles roughly ahead and tall enough to matter.
        if (this.pos.y > o.position.y + o.height + this.hardDeck) {
            return desiredHeading;
        }
        this.toPoint.set(o.position.x - this.pos.x, 0, o.position.z - this.pos.z);
        const bearing = Math.atan2(this.toPoint.x, this.toPoint.z);
        const off = wrapPi(bearing - this.heading);
        if (Math.abs(off) > Math.PI / 3) {
            return desiredHeading; // obstacle not in our path
        }
        // Steer away from the side the obstacle is on.
        const avoid = this.heading - Math.sign(off || 1) * (Math.PI / 4);
        return avoid;
    }

    // --- Phases --------------------------------------------------------------

    private doGroundIdle(): void {
        this.aircraft.setThrottle(0);
        this.throttleCmd = 0;
        this.aircraft.setWheelBrakes(true);
        this.applyPitch(0);
        this.wingsLevel();
        this.aircraft.setLandingGearDeployed(true);
        // A wingman parked on the lead's runway scrambles when the lead rolls:
        // the lead on the ground near by, and moving. Not a lead overhead - a
        // wingman that has landed stays down.
        const lead = this.formationLead;
        if (lead && lead.isAlive() && !this.aircraft.isCrashed()) {
            lead.readPosition(this.lpos);
            lead.readVelocity(this.lvel);
            const nearBy = this.lpos.distanceTo(this.pos) < SCRAMBLE_LEAD_RANGE
                && Math.abs(this.lpos.y - this.pos.y) < SCRAMBLE_LEAD_HEIGHT;
            if (nearBy && this.lvel.length() > SCRAMBLE_LEAD_SPEED) {
                this.setPhase(AiFlightPhase.TAKEOFF_ROLL);
            }
        }
    }

    /**
     * The runway this pilot is working, chosen once.
     *
     * Picked by proximity the first time it is asked for — which on the ground
     * is the one under the aircraft, and airborne is the nearest field — and
     * then held. Re-deciding per frame would hand an aircraft off to a
     * different runway the moment one drifted closer, halfway down an approach
     * to the first.
     *
     * Re-picked when the pilot turns for home, because by then it may be a
     * long way from where it started and the nearest field is the right one.
     */
    private homeRunway(): Runway {
        // A route's runway, by where it is and not by where the aircraft is:
        // asked again every time, so it is the right one once its airfield
        // has streamed in, and steady while nothing new arrives near it.
        const land = this.route?.land;
        if (land) {
            const r = this.world.nearestRunway(land.x, land.z);
            if (land.heading === undefined || Math.abs(wrapPi(land.heading - r.heading)) < Math.PI / 2) {
                return r;
            }
            let back = this.reversed.get(r);
            if (!back) {
                back = { ...r, heading: wrapPi(r.heading + Math.PI) };
                this.reversed.set(r, back);
            }
            return back;
        }
        if (this.runwayChoice === undefined) {
            this.runwayChoice = this.world.nearestRunway(this.pos.x, this.pos.z);
        }
        return this.runwayChoice;
    }

    private doTakeoff(delta: number): void {
        if (this.lineUpPending) {
            this.lineUpPending = false;
            this.lineUp();
            this.spoolTimer = this.aircraft.isLanded() && this.aircraft.getAirspeed() < 5 ? TAKEOFF_SPOOL_S : 0;
        }
        const rwy = this.homeRunway();
        this.aircraft.setLandingGearDeployed(true);
        this.aircraft.setFlapsExtended(true);
        // From a standstill, hold the brakes while the engine spools up: every
        // metre counts on a runway with the home base's ski jump 90 m ahead
        // of the start, which launched an aircraft still spooling at 40 m/s
        // - too slow to fly - where one released at full thrust reaches it
        // at ~55.
        this.spoolTimer = Math.max(0, this.spoolTimer - delta);
        this.aircraft.setWheelBrakes(this.spoolTimer > 0);
        // Still out from the rollout of the last landing, if there was one.
        this.airbrakesLatched = false;
        this.aircraft.setAirbrakesExtended(false);
        this.throttleCmd = 1;
        this.aircraft.setThrottle(1);

        const airspeed = this.aircraft.getAirspeed();
        if (!this.aircraft.isLanded()) {
            // Off the wheels - rotated, or thrown up by the home base's ski
            // jump - it is flown, not steered like a car: wings level, rudder
            // neutral (nosewheel steering on the rudder veered it off in the
            // game), and the rotate pull held until climb-out takes over. A
            // held attitude (10-15 deg) was too little pull off a ramp tip in
            // the game: it sank back onto the runway at 93 m/s.
            this.wingsLevel();
            this.applyPitch(TAKEOFF_ROTATE_STICK);
        } else {
            // Ground steering: hold the lined-up heading and line (see
            // lineUp) with the nosewheel (yaw).
            const lateral = this.takeoffOffset(rwy) - this.takeoffLateral;
            const headingErr = wrapPi(this.takeoffHeading - this.heading);
            this.aircraft.setYaw(clamp(headingErr * 1.5 - lateral * 0.01, -1, 1));
            this.wingsLevel();
            this.applyPitch(airspeed >= ROTATE_SPEED ? TAKEOFF_ROTATE_STICK : 0); // rotate at Vr
        }

        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        if (agl > 15 && this.vel.y > 2) {
            this.phase = AiFlightPhase.CLIMB_OUT;
        }
    }

    private doClimbOut(delta: number): void {
        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        const airspeed = this.aircraft.getAirspeed();
        this.aircraft.setLandingGearDeployed(agl < GEAR_UP_ALT);
        this.aircraft.setFlapsExtended(airspeed < FLAPS_UP_SPEED);
        this.aircraft.setWheelBrakes(false);

        this.commandHeading(this.takeoffHeading, MAX_BANK_NAV);
        this.commandVerticalSpeed(80);
        this.commandSpeed(this.cruiseSpeed, delta);

        // Clear of the ground and cleaned up, a wingman goes to its lead and
        // a fighter with a target goes to it; otherwise climb on to patrol.
        if (agl > CLIMB_OUT_HANDOFF_AGL && !this.aircraft.isGearDeployed()) {
            if (this.route) {
                this.setPhase(AiFlightPhase.WAYPOINT);
                return;
            }
            if (this.formationLead && this.formationLead.isAlive()) {
                this.setPhase(AiFlightPhase.FORMATION);
                return;
            }
            if (this.target && this.target.isAlive()) {
                this.setPhase(AiFlightPhase.ENGAGE);
                return;
            }
        }
        if (this.pos.y >= this.cruiseAltitude * 0.7) {
            this.phase = AiFlightPhase.NAVIGATE;
        }
    }

    private doNavigate(delta: number): void {
        if (this.target && this.target.isAlive()) {
            this.phase = AiFlightPhase.ENGAGE;
            return;
        }
        this.aircraft.setLandingGearDeployed(false);
        this.aircraft.setFlapsExtended(false);
        // Gentle loitering turn holding cruise altitude/speed.
        const desiredHeading = this.avoidObstacles(this.heading + 0.4);
        this.commandHeading(desiredHeading, MAX_BANK_NAV);
        this.commandAltitudeClamped(this.cruiseAltitude);
        this.commandSpeed(this.cruiseSpeed, delta);
    }

    /**
     * Fly the route: at each point's altitude and speed, on to the next once
     * within a turn's radius of it, so a corner is cut rather than overshot
     * and circled back to. Past the last point, land or circle it.
     */
    private doWaypoint(delta: number): void {
        const route = this.route;
        if (!route || route.points.length === 0) {
            this.setPhase(route?.land ? AiFlightPhase.RTB : AiFlightPhase.NAVIGATE);
            return;
        }
        if (route.next >= route.points.length && route.land) {
            this.setPhase(AiFlightPhase.RTB);
            return;
        }
        const last = route.next >= route.points.length;
        const p = route.points[Math.min(route.next, route.points.length - 1)];
        const dx = p.x - this.pos.x;
        const dz = p.z - this.pos.z;
        const speed = Math.max(this.aircraft.getAirspeed(), 50);
        // Half the radius of a MAX_BANK_NAV turn, not under 400 m.
        const capture = Math.max(400, 0.5 * speed * speed / (9.81 * Math.tan(MAX_BANK_NAV)));
        if (!last && dx * dx + dz * dz < capture * capture) {
            route.next++;
            return;
        }
        this.aircraft.setLandingGearDeployed(false);
        this.aircraft.setFlapsExtended(false);
        this.commandHeading(this.avoidObstacles(Math.atan2(dx, dz)), MAX_BANK_NAV);
        // Holding the path, as the airfield phases do: a leg can be flown far
        // slower than the cruise the plain loop is tuned at, and there it
        // levelled off hundreds of metres low.
        const alt = Math.max(p.y, this.world.groundHeightAt(this.pos.x, this.pos.z) + this.hardDeck);
        this.commandVerticalSpeed(clamp((alt - this.pos.y) * VS_PER_ALT, -MAX_VS, MAX_VS), true);
        this.commandSpeed(p.speed, delta);
    }

    /** Fly wings-level on a latched heading; does not auto-engage even with a target. */
    private doStraight(delta: number): void {
        if (!this.straightHeadingLatched) {
            this.straightHeading = this.heading;
            this.straightHeadingLatched = true;
        }
        this.aircraft.setLandingGearDeployed(false);
        this.aircraft.setFlapsExtended(false);
        this.commandHeading(this.avoidObstacles(this.straightHeading), MAX_BANK_NAV);
        this.commandAltitudeClamped(this.cruiseAltitude);
        this.commandSpeed(this.cruiseSpeed, delta);
    }

    /**
     * Wingman phase: fly the lead's wing, and hand off to ENGAGE the moment a
     * live target is assigned. Two steering laws with hysteresis between them —
     * rejoin (fly *at* the slot with overtake speed) and station-keeping (fly
     * the lead's heading, trimming out the residual offsets). Flying at the slot
     * the whole time would work at range but goes singular on top of it, where
     * the bearing to a slot metres away swings wildly.
     */
    private doFormation(delta: number): void {
        const lead = this.formationLead;
        if (!lead || !lead.isAlive()) {
            this.phase = AiFlightPhase.NAVIGATE;
            return;
        }
        // A bandit outranks the rejoin: peel off and fight.
        if (this.target && this.target.isAlive()) {
            this.phase = AiFlightPhase.ENGAGE;
            return;
        }

        this.aircraft.setLandingGearDeployed(false);
        this.aircraft.setFlapsExtended(false);

        lead.readPosition(this.lpos);
        lead.readVelocity(this.lvel);
        const leadSpeed = this.lvel.length();
        if (leadSpeed < FORMATION_LEAD_MIN_SPEED) {
            // Lead is parked or rolling out — there is no slot to fly. Wait
            // overhead instead of descending onto a stationary point.
            this.doHoldOverhead(delta);
            return;
        }

        const leadHeading = Math.atan2(this.lvel.x, this.lvel.z);
        this.leadFwd.set(Math.sin(leadHeading), 0, Math.cos(leadHeading));
        this.leadRight.set(Math.cos(leadHeading), 0, -Math.sin(leadHeading));
        this.slot.copy(this.lpos)
            .addScaledVector(this.leadFwd, -FORMATION_SLOT.trail)
            .addScaledVector(this.leadRight, FORMATION_SLOT.side);
        this.slot.y += FORMATION_SLOT.stack;

        this.toSlot.copy(this.slot).sub(this.pos);
        const slotRange = this.toSlot.length();
        if (this.formationRejoining) {
            if (slotRange < FORMATION_REJOIN_RELEASE_M) this.formationRejoining = false;
        } else if (slotRange > FORMATION_REJOIN_ENTER_M) {
            this.formationRejoining = true;
        }

        if (this.formationRejoining) {
            // No integral trim while closing: the altitude error here is the
            // rejoin geometry, not loop droop, and integrating it would wind up.
            this.formationAltTrim = 0;
            const desiredHeading = Math.atan2(this.toSlot.x, this.toSlot.z);
            this.commandHeading(this.avoidObstacles(desiredHeading), FORMATION_MAX_BANK);
            this.commandAltitudeClamped(this.slot.y);
            this.commandSpeedWithAirbrakes(Math.min(this.maxSpeed, leadSpeed + FORMATION_REJOIN_OVERTAKE), delta);
            return;
        }

        // Station keeping: hold the lead's heading, steering only by the
        // cross-track error and trimming speed on the along-track error.
        const alongErr = this.toSlot.dot(this.leadFwd);
        const crossErr = this.toSlot.dot(this.leadRight);
        // Closing rate along the lead's axis (+ = falling behind the slot).
        this.toPoint.copy(this.lvel).sub(this.vel);
        const alongRate = this.toPoint.dot(this.leadFwd);
        const headingOffset = clamp(
            crossErr * FORMATION_HEADING_PER_CROSS,
            -FORMATION_MAX_HEADING_OFFSET, FORMATION_MAX_HEADING_OFFSET);
        this.commandHeading(this.avoidObstacles(leadHeading + headingOffset), FORMATION_MAX_BANK);
        this.formationAltTrim = clamp(
            this.formationAltTrim + (this.slot.y - this.pos.y) * FORMATION_ALT_TRIM_RATE * delta,
            -FORMATION_ALT_TRIM_MAX, FORMATION_ALT_TRIM_MAX);
        this.commandAltitudeClamped(this.slot.y + this.formationAltTrim);
        const speedTrim = clamp(
            alongErr * FORMATION_SPEED_PER_ALONG + alongRate * FORMATION_SPEED_PER_CLOSURE,
            -FORMATION_SPEED_TRIM, FORMATION_SPEED_TRIM);
        this.commandSpeedWithAirbrakes(leadSpeed + speedTrim, delta);
    }

    /**
     * Speed hold with the speedbrake as the deceleration authority: the throttle
     * integrator bottoms out at idle long before a clean airframe has actually
     * slowed down: not enough to hold a slot behind a slower lead, nor to get
     * down to approach speed on the way in to land.
     */
    private commandSpeedWithAirbrakes(desiredSpeed: number, delta: number, kp = 0): void {
        const airspeed = this.aircraft.getAirspeed();
        if (this.airbrakesLatched) {
            if (airspeed < desiredSpeed + AIRBRAKE_RELEASE) this.airbrakesLatched = false;
        } else if (airspeed > desiredSpeed + AIRBRAKE_ENTER) {
            this.airbrakesLatched = true;
        }
        this.aircraft.setAirbrakesExtended(this.airbrakesLatched);
        this.commandSpeed(desiredSpeed, delta, kp);
    }

    /** Loiter at cruise altitude near the lead, closing back in if it drifts off. */
    private doHoldOverhead(delta: number): void {
        this.formationAltTrim = 0;
        this.airbrakesLatched = false;
        this.aircraft.setAirbrakesExtended(false);
        this.toPoint.set(this.lpos.x - this.pos.x, 0, this.lpos.z - this.pos.z);
        const desiredHeading = this.toPoint.length() > FORMATION_HOLD_RECENTER_M
            ? Math.atan2(this.toPoint.x, this.toPoint.z)
            : this.heading + 0.4;
        this.commandHeading(this.avoidObstacles(desiredHeading), MAX_BANK_NAV);
        this.commandAltitudeClamped(this.cruiseAltitude);
        this.commandSpeed(this.cruiseSpeed, delta);
    }

    private doEngage(delta: number): void {
        if (!this.target || !this.target.isAlive()) {
            // A wingman rejoins its lead when the fight is over; a lone fighter
            // has nothing to rejoin and goes back to its patrol.
            this.phase = this.formationLead && this.formationLead.isAlive()
                ? AiFlightPhase.FORMATION
                : AiFlightPhase.NAVIGATE;
            return;
        }
        this.aircraft.setLandingGearDeployed(false);
        this.aircraft.setFlapsExtended(false);

        this.target.readPosition(this.tpos);
        this.target.readVelocity(this.tvel);
        this.updateTargetAcceleration(delta);
        this.toPoint.copy(this.tpos).sub(this.pos);
        const range = this.toPoint.length();

        // Shared per-frame BFM geometry (see dogfightGeometry.ts for definitions).
        const closure = closureRate(this.pos, this.vel, this.tpos, this.tvel);
        const theirTrackingAngle = trackingAngle(this.tpos, this.tvel, this.pos);
        const myAspectOnTarget = trackingAngle(this.pos, this.vel, this.tpos);
        const ao = angleOff(this.vel, this.tvel);
        const myEnergy = specificEnergyHeight(this.pos.y, this.vel.length());
        const theirEnergy = specificEnergyHeight(this.tpos.y, this.tvel.length());
        const energyDeficit = theirEnergy - myEnergy;

        this.updateDogfightMode(delta, range, closure, ao, theirTrackingAngle, myAspectOnTarget, energyDeficit);

        switch (this.dogfightMode) {
            case DogfightMode.DEFENSIVE_BREAK: this.doDefensiveBreak(delta); break;
            case DogfightMode.EXTEND: this.doExtend(delta); break;
            case DogfightMode.HIGH_YOYO: this.doHighYoYo(delta, range); break;
            case DogfightMode.LOW_YOYO: this.doLowYoYo(delta, range); break;
            case DogfightMode.LAG_PURSUE: this.doLagPursue(delta, range, ao); break;
            case DogfightMode.PURSUE: default: this.doPursue(delta, range, ao); break;
        }

        // Only PURSUE/LAG_PURSUE actually aim at the target this frame; every
        // other mode is repositioning or evading, so never let a coincidental
        // nose-on-target moment squeeze off a burst.
        if (this.dogfightMode !== DogfightMode.PURSUE && this.dogfightMode !== DogfightMode.LAG_PURSUE) {
            this.firing = false;
        }
        this.hadSolution = this.firing;
    }

    /**
     * Decide which {@link DogfightMode} to fly this frame. Priority order:
     * a sustained threat on our own tail always wins (defend first), then an
     * energy deficit (rebuild before fighting on), then the timed vertical
     * repositioning maneuvers, then the steady-state pursuit style.
     */
    private updateDogfightMode(
        delta: number, range: number, closure: number, ao: number,
        theirTrackingAngle: number, myAspectOnTarget: number, energyDeficit: number,
    ): void {
        const theirThreatRange = this.gunRange * DEFENSIVE_RANGE_MULT;
        const theirClearRange = this.gunRange * DEFENSIVE_CLEAR_RANGE_MULT;
        const targetInRearHemisphere = myAspectOnTarget >= DEFENSIVE_REAR_HEMISPHERE;
        const underThreat = targetInRearHemisphere
            && theirTrackingAngle <= DEFENSIVE_AOT_THRESHOLD
            && range <= theirThreatRange;
        this.threatTimer = underThreat ? this.threatTimer + delta : 0;

        if (this.dogfightMode === DogfightMode.DEFENSIVE_BREAK) {
            if (theirTrackingAngle > DEFENSIVE_CLEAR_AOT
                || range > theirClearRange
                || myAspectOnTarget < DEFENSIVE_REAR_CLEAR) {
                this.setDogfightMode(DogfightMode.PURSUE);
            }
            return;
        }
        if (this.threatTimer >= this.skillTuning.defensiveReactTime) {
            // Relentless opponents press the attack even under mild pressure; only
            // break when the bandit is clearly on their six, not on a neutral merge.
            if (!this.alwaysEngage || myAspectOnTarget >= 120 * Math.PI / 180) {
                this.setDogfightMode(DogfightMode.DEFENSIVE_BREAK);
            }
            return;
        }

        // Energy-deficit disengage: skipped for an always-engage opponent so it
        // never turns tail to rebuild energy.
        if (!this.alwaysEngage) {
            if (this.dogfightMode === DogfightMode.EXTEND) {
                this.maneuverTimer += delta;
                if (this.maneuverTimer >= EXTEND_MIN_DURATION && energyDeficit <= EXTEND_RECOVER_MARGIN) {
                    this.setDogfightMode(DogfightMode.PURSUE);
                }
                return;
            }
            if (energyDeficit >= this.skillTuning.extendEnergyDeficit) {
                this.setDogfightMode(DogfightMode.EXTEND);
                return;
            }
        }

        if (this.dogfightMode === DogfightMode.HIGH_YOYO || this.dogfightMode === DogfightMode.LOW_YOYO) {
            if (this.alwaysEngage) {
                this.setDogfightMode(DogfightMode.PURSUE);
                return;
            }
            this.maneuverTimer += delta;
            const duration = this.dogfightMode === DogfightMode.HIGH_YOYO ? HIGH_YOYO_DURATION : LOW_YOYO_DURATION;
            if (this.maneuverTimer >= duration) {
                this.setDogfightMode(DogfightMode.PURSUE);
            }
            return;
        }
        if (!this.alwaysEngage && range <= YOYO_RANGE_TRIGGER && closure >= YOYO_CLOSURE_TRIGGER && !this.hadSolution) {
            // Closing fast at short range: about to blow past the target. Bleed
            // the overtake in the vertical rather than tightening the turn —
            // but not if we already have a guns solution this pass.
            this.setDogfightMode(DogfightMode.HIGH_YOYO);
            return;
        }
        // Energy edge and a turn too tight to lead-pursue: dive across the
        // circle instead of trying (and failing) to out-turn them level.
        if (!this.alwaysEngage && -energyDeficit >= LOW_YOYO_ENERGY_EDGE && ao >= LOW_YOYO_ANGLE_OFF_TRIGGER) {
            this.setDogfightMode(DogfightMode.LOW_YOYO);
            return;
        }

        // Steady-state pursuit style: lag behind the pure lead point once the
        // angle-off is too wide for a lead turn to be flyable.
        this.setDogfightMode(ao >= LAG_ANGLE_OFF_TRIGGER ? DogfightMode.LAG_PURSUE : DogfightMode.PURSUE);
    }

    /** Reset the per-maneuver timer whenever the mode actually changes. */
    private setDogfightMode(mode: DogfightMode): void {
        if (this.dogfightMode !== mode) {
            this.dogfightMode = mode;
            this.maneuverTimer = 0;
        }
    }

    /** Never aim below the terrain safety floor while computing an aimpoint. */
    private clampAimToHardDeck(): void {
        const deck = this.world.groundHeightAt(this.aim.x, this.aim.z) + this.hardDeck;
        if (this.aim.y < deck) {
            this.aim.y = deck;
        }
    }

    /** Finite-difference + low-pass the target's acceleration for lead prediction. */
    private updateTargetAcceleration(delta: number): void {
        if (this.hasPrevTvel && delta > 1e-4) {
            const ax = (this.tvel.x - this.prevTvel.x) / delta;
            const ay = (this.tvel.y - this.prevTvel.y) / delta;
            const az = (this.tvel.z - this.prevTvel.z) / delta;
            const mag = Math.hypot(ax, ay, az);
            const scale = mag > TARGET_ACCEL_CAP ? TARGET_ACCEL_CAP / mag : 1;
            this.targetAcc.x += (ax * scale - this.targetAcc.x) * TARGET_ACCEL_EMA;
            this.targetAcc.y += (ay * scale - this.targetAcc.y) * TARGET_ACCEL_EMA;
            this.targetAcc.z += (az * scale - this.targetAcc.z) * TARGET_ACCEL_EMA;
        } else {
            this.targetAcc.set(0, 0, 0);
        }
        this.prevTvel.copy(this.tvel);
        this.hasPrevTvel = true;
    }

    /** Compute a ballistic gun-lead aim point into `this.aim`; returns tof (s). */
    private computeBallisticAim(): number {
        this.lastTof = ballisticAimPoint(
            this.aim, this.pos, this.vel, this.tpos, this.tvel, this.targetAcc, this.bulletSpeed,
        );
        this.clampAimToHardDeck();
        return this.lastTof;
    }

    /** Would the current nose direction produce a hit at `range`? */
    private evaluateFireSolution(range: number): boolean {
        if (!this.target || range > this.gunRange || range < 1) {
            return false;
        }
        this.bulletVel.copy(this.fwd).multiplyScalar(this.bulletSpeed).add(this.vel);
        const miss = predictedMissDistance(
            this.pos, this.bulletVel, this.tpos, this.tvel, this.targetAcc, this.lastTof,
        );
        const allowance = this.target.getHitRadius() * this.skillTuning.missAllowanceMult + FIRE_MISS_SLACK_M;
        const aggressiveSlack = this.alwaysEngage ? allowance * 1.35 : allowance;
        return miss <= aggressiveSlack;
    }

    /**
     * Pick a pursuit airspeed that keeps turn radius tight. High combat speed
     * with small bank changes is what produced the easy-to-trail lazy circles.
     */
    private combatTurnSpeed(range: number, ao: number): number {
        if (this.alwaysEngage) {
            if (range < 500 || ao >= 25 * Math.PI / 180) {
                return Math.min(CORNER_SPEED, this.combatSpeed > CORNER_SPEED ? CORNER_SPEED : this.combatSpeed * 0.95);
            }
        }
        if (range < 250) {
            return Math.min(this.combatSpeed * 0.65, CORNER_SPEED);
        }
        if (ao >= CORNER_SPEED_AO) {
            const t = clamp((ao - CORNER_SPEED_AO) / (Math.PI / 2 - CORNER_SPEED_AO), 0, 1);
            return this.combatSpeed + (CORNER_SPEED - this.combatSpeed) * t;
        }
        return this.combatSpeed;
    }

    /** Turn/pitch toward `this.aim`, hold `desiredSpeed`, and fire on a predicted hit. */
    private steerAtAimAndFire(delta: number, range: number, desiredSpeed: number, maxBank: number = MAX_BANK_COMBAT): void {
        this.toPoint.copy(this.aim).sub(this.pos);
        const aimDist = this.toPoint.length();
        if (aimDist < 1e-3) {
            this.firing = false;
            return;
        }
        this.aimDir.copy(this.toPoint).divideScalar(aimDist);

        const turnSpeed = desiredSpeed;
        const aimAngle = Math.acos(clamp(this.fwd.dot(this.aimDir), -1, 1));
        if (this.alwaysEngage && aimAngle > 3 * Math.PI / 180) {
            this.hardTurnActive = true;
        }
        if (!this.commandHardTurn(this.aimDir, delta, turnSpeed)) {
            const horiz = Math.hypot(this.toPoint.x, this.toPoint.z);
            let desiredHeading = Math.atan2(this.toPoint.x, this.toPoint.z);
            desiredHeading = this.avoidObstacles(desiredHeading);
            const desiredElev = Math.atan2(this.toPoint.y, horiz);

            this.commandHeading(desiredHeading, maxBank);
            this.commandElevation(desiredElev);
            this.commandSpeed(desiredSpeed, delta);
        }

        this.firing = this.evaluateFireSolution(range);
    }

    /** Straight lead-pursuit intercept — the default, common case. */
    private doPursue(delta: number, range: number, ao: number): void {
        this.computeBallisticAim();
        this.steerAtAimAndFire(delta, range, this.combatTurnSpeed(range, ao));
    }

    /**
     * Blend the aimpoint from the pure lead point toward the target's actual
     * position as angle-off grows, so the AI isn't forced to fly a turn
     * radius the airframe can't sustain just to keep pointing at an
     * unreachable lead point.
     */
    private doLagPursue(delta: number, range: number, ao: number): void {
        this.computeBallisticAim();

        const span = Math.max(1e-3, Math.PI - LAG_ANGLE_OFF_TRIGGER);
        const blend = clamp((ao - LAG_ANGLE_OFF_TRIGGER) / span, 0, LAG_BLEND_MAX);
        this.aim.lerp(this.tpos, blend);
        this.clampAimToHardDeck();

        this.steerAtAimAndFire(delta, range, this.combatTurnSpeed(range, ao));
    }

    /**
     * Pull the nose above the flight path so a fast overtake is bled off as
     * altitude rather than continuing to tighten the turn into an overshoot.
     * Does not track/fire — this is a repositioning maneuver.
     */
    private doHighYoYo(delta: number, range: number): void {
        this.computeBallisticAim();

        this.toPoint.copy(this.aim).sub(this.pos);
        const horiz = Math.hypot(this.toPoint.x, this.toPoint.z);
        let desiredHeading = Math.atan2(this.toPoint.x, this.toPoint.z);
        desiredHeading = this.avoidObstacles(desiredHeading);
        const desiredElev = Math.atan2(this.toPoint.y, horiz) + HIGH_YOYO_PITCH_BONUS;

        const aimDist = this.toPoint.length();
        if (aimDist > 1e-3) {
            this.aimDir.copy(this.toPoint).divideScalar(aimDist);
            // Bias the hard-turn direction slightly above the aim for the yo-yo.
            this.aimDir.y += Math.sin(HIGH_YOYO_PITCH_BONUS) * 0.3;
            this.aimDir.normalize();
            if (!this.commandHardTurn(this.aimDir, delta, this.combatSpeed)) {
                this.commandHeading(desiredHeading, MAX_BANK_COMBAT * HIGH_YOYO_MAX_BANK_MULT);
                this.commandElevation(desiredElev);
                this.commandSpeed(this.combatSpeed, delta);
            }
        }
    }

    /**
     * Trade some altitude for turn rate/closure, cutting inside the target's
     * turn circle rather than trying (and failing) to out-turn them level.
     * Does not track/fire — this is a repositioning maneuver.
     */
    private doLowYoYo(delta: number, range: number): void {
        this.computeBallisticAim();

        this.toPoint.copy(this.aim).sub(this.pos);
        const horiz = Math.hypot(this.toPoint.x, this.toPoint.z);
        let desiredHeading = Math.atan2(this.toPoint.x, this.toPoint.z);
        desiredHeading = this.avoidObstacles(desiredHeading);
        const desiredElev = Math.atan2(this.toPoint.y, horiz) - LOW_YOYO_PITCH_DROP;

        const aimDist = this.toPoint.length();
        if (aimDist > 1e-3) {
            this.aimDir.copy(this.toPoint).divideScalar(aimDist);
            if (!this.commandHardTurn(this.aimDir, delta, this.maxSpeed)) {
                this.commandHeading(desiredHeading, MAX_BANK_COMBAT);
                this.commandElevation(desiredElev);
                this.commandSpeed(this.maxSpeed, delta);
            }
        }
    }

    /**
     * Hard break turn into a tracking threat: turning toward the bearing of
     * the attacker closes the angle fastest, forcing them to either overshoot
     * or commit to a lead they likely can't sustain. Not a tracking maneuver.
     */
    private doDefensiveBreak(delta: number): void {
        this.toPoint.copy(this.tpos).sub(this.pos);
        const bearing = Math.atan2(this.toPoint.x, this.toPoint.z);
        const bearingOff = wrapPi(bearing - this.heading);

        if (this.alwaysEngage) {
            // Scissors into the threat instead of breaking 90° away — stay offensive.
            this.aimDir.set(Math.sin(bearing), 0.12, Math.cos(bearing)).normalize();
            if (!this.commandHardTurn(this.aimDir, delta, CORNER_SPEED)) {
                this.commandHeading(bearing, MAX_BANK_COMBAT);
                this.commandElevation(15 * Math.PI / 180);
                this.commandSpeed(CORNER_SPEED, delta);
            }
            return;
        }

        const breakHeading = this.heading + Math.sign(bearingOff || 1) * (Math.PI / 2);

        // Hard break into the threat: roll and pull for max instantaneous turn rate.
        this.aimDir.set(Math.sin(breakHeading), 0.15, Math.cos(breakHeading)).normalize();
        if (!this.commandHardTurn(this.aimDir, delta, CORNER_SPEED)) {
            this.commandHeading(breakHeading, MAX_BANK_COMBAT);
            this.commandElevation(12 * Math.PI / 180);
            this.commandSpeed(CORNER_SPEED, delta);
        }
    }

    /**
     * Disengage on a heading away from the target, unloaded and at full
     * power, to rebuild the energy needed to fight on. Not a tracking
     * maneuver — this deliberately accepts pointing off the target.
     */
    private doExtend(delta: number): void {
        this.toPoint.copy(this.pos).sub(this.tpos);
        let desiredHeading = Math.atan2(this.toPoint.x, this.toPoint.z);
        desiredHeading = this.avoidObstacles(desiredHeading);

        this.commandHeading(desiredHeading, MAX_BANK_NAV);
        this.commandElevation(-0.05); // shallow nose-down: unloaded, minimum-drag extend
        this.commandSpeed(this.maxSpeed, delta);
    }

    /**
     * Where on {@link rwy} the approach aims: ~300 m past the approach
     * threshold, at the height of the runway surface there. `y` is the
     * runway's, never the ground under the aircraft - a glidepath measured
     * from that rises and falls with every ridge and valley on the way in.
     */
    private touchdownPoint(rwy: Runway): { x: number; y: number; z: number; heading: number } {
        const fwdX = Math.sin(rwy.heading);
        const fwdZ = Math.cos(rwy.heading);
        const touchdownDist = rwy.halfLength - this.touchdownFromThreshold(rwy);
        const x = rwy.center.x - fwdX * touchdownDist;
        const z = rwy.center.z - fwdZ * touchdownDist;
        const td = this.touchdown;
        td.x = x;
        td.z = z;
        td.y = this.world.groundHeightAt(x, z);
        td.heading = rwy.heading;
        return td;
    }

    /**
     * How far (m) past the approach threshold the approach aims:
     * TOUCHDOWN_FROM_THRESHOLD, unless something stands on the runway in or
     * just beyond that zone - then TOUCHDOWN_PAST_OBSTRUCTION beyond it.
     * Gran Canaria's runway has a 12 m ski jump right at the usual aim point,
     * and every autopilot landing was launched off it. "On the runway" is
     * above the plane through both thresholds, which a runway surface is.
     * Worked out once per runway.
     */
    private touchdownFromThreshold(rwy: Runway): number {
        return this.runwayLayout(rwy).aim;
    }

    /**
     * The aim point (m past the approach threshold) and where the runway is
     * clear from - just past the last obstruction before the aim, -Infinity if
     * none:
     * the flare may not start before it, or a final flown a little low
     * floats down onto the thing it was moved past.
     */
    private runwayLayout(rwy: Runway): { aim: number; clearFrom: number } {
        const cached = this.touchdownDistances.get(rwy);
        if (cached !== undefined) {
            return cached;
        }
        const fwdX = Math.sin(rwy.heading);
        const fwdZ = Math.cos(rwy.heading);
        const length = 2 * rwy.halfLength;
        const x0 = rwy.center.x - fwdX * rwy.halfLength;
        const z0 = rwy.center.z - fwdZ * rwy.halfLength;
        const h0 = this.world.groundHeightAt(x0, z0);
        const h1 = this.world.groundHeightAt(x0 + fwdX * length, z0 + fwdZ * length);
        let distance = Math.min(TOUCHDOWN_FROM_THRESHOLD, 0.25 * length);
        let clearFrom = -Infinity;
        for (let s = 0; s <= Math.min(0.6 * length, distance + TOUCHDOWN_OBSTRUCTION_REACH); s += 10) {
            const above = this.world.groundHeightAt(x0 + fwdX * s, z0 + fwdZ * s) - (h0 + (h1 - h0) * s / length);
            if (above > RUNWAY_OBSTRUCTION_M) {
                distance = Math.max(distance, s + TOUCHDOWN_PAST_OBSTRUCTION);
                clearFrom = s + 10;
            }
        }
        const layout = { aim: Math.min(distance, 0.5 * length), clearFrom };
        this.touchdownDistances.set(rwy, layout);
        return layout;
    }

    /**
     * Get round to the extended centreline, established on it by the join
     * point ({@link JOIN_DISTANCE} before touchdown), then hand off to the
     * approach. From where the aircraft is, that is one of:
     *
     * - DIRECT: there is room ahead of the join point to turn onto the
     *   centreline, so intercept it.
     * - DOWNWIND then BASE: there is not - too close, too far off to the side,
     *   past the runway, or pointing the wrong way. Fly a leg parallel to the
     *   runway, two turn radii out, outbound past the join point, then a 180
     *   that rolls out on the centreline, and intercept from there.
     *
     * Flown at the glidepath's height at the join point, so the approach
     * starts on the glidepath, slowing all the way: the approach has no room
     * to lose 100+ m/s while also going down the slope.
     */
    private doRtb(delta: number): void {
        const rwy = this.homeRunway();
        const td = this.touchdownPoint(rwy);
        const f = runwayFrame(td.x, td.z, rwy.heading, this.pos.x, this.pos.z, this.heading);
        const vref = approachSpeed(this.aircraft.getSlowSpeeds());
        const patternSpeed = vref * PATTERN_SPEED_FACTOR;

        if (this.rtbLeg === RtbLeg.PLAN) {
            this.patternRadius = turnRadius(patternSpeed, PATTERN_BANK);
            const room = f.toTouchdown - JOIN_DISTANCE;
            const r = this.patternRadius;
            const direct = room > 2 * r + Math.abs(f.lateral)
                || (room > r + Math.abs(f.lateral) && Math.abs(f.headingError) < DIRECT_MAX_HEADING_ERROR);
            this.rtbLeg = direct ? RtbLeg.DIRECT : RtbLeg.DOWNWIND;
            this.patternSide = this.patternSideFor(rwy, f.lateral);
        }

        const r = this.patternRadius;
        let desiredHeading: number;
        let desiredSpeed: number;
        if (this.rtbLeg === RtbLeg.DIRECT) {
            desiredHeading = lineHeading(rwy.heading, f.lateral, CAPTURE_RADII * r, INTERCEPT_MAX);
            // Speed ramps down with distance to the join point.
            const join = Math.hypot(f.toTouchdown - JOIN_DISTANCE, f.lateral);
            desiredSpeed = vref + RTB_IAF_SPEED_MARGIN + Math.max(0, join - RTB_SLOWED_BY_M) * RTB_SPEED_PER_M;
            const established = Math.abs(f.lateral) < ESTABLISHED_LATERAL
                && Math.abs(f.headingError) < ESTABLISHED_HEADING_ERROR;
            if (established && f.toTouchdown < JOIN_DISTANCE + JOIN_HANDOFF_EARLY) {
                this.phase = AiFlightPhase.APPROACH;
                this.approachAltTrim = 0;
            } else if (!established && f.toTouchdown < JOIN_DISTANCE - JOIN_LATE_MARGIN) {
                // Not going to make it: go round the pattern instead.
                this.rtbLeg = RtbLeg.DOWNWIND;
                this.patternSide = this.patternSideFor(rwy, f.lateral);
            }
        } else if (this.rtbLeg === RtbLeg.DOWNWIND) {
            const outbound = rwy.heading + Math.PI;
            // The leg's own lateral axis points the other way from the runway's.
            const crossTrack = -(f.lateral - this.patternSide * 2 * r);
            desiredHeading = lineHeading(outbound, crossTrack, CAPTURE_RADII * r, INTERCEPT_MAX);
            desiredSpeed = patternSpeed;
            const onLeg = Math.abs(crossTrack) < 0.5 * r && Math.abs(wrapPi(outbound - this.heading)) < 0.5;
            if (onLeg && f.toTouchdown > JOIN_DISTANCE + PATTERN_EXTENSION
                && this.aircraft.getAirspeed() < patternSpeed + PATTERN_TURN_SPEED_MARGIN) {
                // Turn about a centre one radius off the centreline, so the 180
                // ends on it wherever on the leg it started; the arc law takes
                // out the difference.
                const c = fromRunwayFrame(td.x, td.z, rwy.heading, f.toTouchdown, this.patternSide * r);
                this.baseCentre.x = c.x;
                this.baseCentre.z = c.z;
                this.rtbLeg = RtbLeg.BASE;
            }
        } else {
            desiredHeading = arcHeading(this.baseCentre.x, this.baseCentre.z, r, this.patternSide, this.pos.x, this.pos.z);
            desiredSpeed = patternSpeed;
            if (Math.abs(f.headingError) < BASE_ROLLOUT_HEADING_ERROR) {
                this.rtbLeg = RtbLeg.DIRECT;
            }
        }

        this.commandHeading(this.avoidObstacles(desiredHeading), MAX_BANK_NAV);
        // The pattern is flown at the glidepath's height at the join point,
        // or a minimum safe altitude over the terrain ahead, whichever is
        // higher - along the track being flown and the one being turned to.
        // At the join height alone, among GCXO's hills, the terrain guard
        // kept taking over with wings-level pull-ups and the pattern never
        // closed.
        const joinHeight = td.y + JOIN_DISTANCE * GLIDESLOPE;
        const safe = Math.max(this.terrainAhead(this.heading, PATTERN_MSA_LOOKAHEAD),
            this.terrainAhead(desiredHeading, PATTERN_MSA_LOOKAHEAD)) + PATTERN_MSA_CLEARANCE;
        this.commandVerticalSpeed(clamp((Math.max(joinHeight, safe) - this.pos.y) * VS_PER_ALT, -MAX_VS, MAX_VS), true);
        this.commandSpeedWithAirbrakes(clamp(desiredSpeed, vref, Math.max(vref, this.cruiseSpeed)), delta, AIRFIELD_THROTTLE_KP);
        const configured = this.aircraft.getAirspeed() < vref * CONFIGURE_SPEED_FACTOR;
        this.aircraft.setLandingGearDeployed(configured);
        this.aircraft.setFlapsExtended(configured);
    }

    /**
     * Highest ground (m) in a swath TERRAIN_SWATH_HALF_WIDTH either side of a
     * line from the aircraft along `heading`, `distance` m long.
     */
    private terrainAhead(heading: number, distance: number): number {
        const fx = Math.sin(heading);
        const fz = Math.cos(heading);
        let highest = -Infinity;
        for (let d = 0; d <= distance; d += TERRAIN_SCAN_STEP) {
            for (let o = -TERRAIN_SWATH_HALF_WIDTH; o <= TERRAIN_SWATH_HALF_WIDTH; o += TERRAIN_SWATH_HALF_WIDTH) {
                highest = Math.max(highest, this.world.groundHeightAt(
                    this.pos.x + fx * d + fz * o, this.pos.z + fz * d - fx * o));
            }
        }
        return highest;
    }

    /**
     * Which side of the centreline to fly the downwind and base turn on: the
     * one over lower ground, by its highest point, so the pattern is not
     * flown over a mountainside when the other side is valley or sea. Within
     * PATTERN_SIDE_TERRAIN_TIE of each other, the side the aircraft is on.
     */
    private patternSideFor(rwy: Runway, lateral: number): 1 | -1 {
        const td = this.touchdownPoint(rwy);
        const r = this.patternRadius;
        const highest = (side: 1 | -1): number => {
            let h = -Infinity;
            for (let s = -2 * r; s <= JOIN_DISTANCE + PATTERN_EXTENSION + 2 * r; s += TERRAIN_SCAN_STEP) {
                for (const off of [r, 2 * r, 3 * r]) {
                    const p = fromRunwayFrame(td.x, td.z, rwy.heading, s, side * off);
                    h = Math.max(h, this.world.groundHeightAt(p.x, p.z));
                }
            }
            return h;
        };
        const own: 1 | -1 = lateral >= 0 ? 1 : -1;
        const ownHigh = highest(own);
        const otherHigh = highest(-own as 1 | -1);
        return otherHigh < ownHigh - PATTERN_SIDE_TERRAIN_TIE ? (-own as 1 | -1) : own;
    }

    /**
     * Abandon the approach and come back round: see {@link AiFlightPhase.GO_AROUND}.
     * Counted here, so a bounce and an unstable gate both count.
     */
    private goAround(reason: string): void {
        this.phase = AiFlightPhase.GO_AROUND;
        this.goAroundReason = reason;
        this.goArounds++;
        this.aircraft.setWheelBrakes(false);
    }

    private doGoAround(delta: number): void {
        const rwy = this.homeRunway();
        const td = this.touchdownPoint(rwy);
        const vref = approachSpeed(this.aircraft.getSlowSpeeds());
        this.throttleCmd = 1;
        this.aircraft.setThrottle(1);
        this.airbrakesLatched = false;
        this.aircraft.setAirbrakesExtended(false);
        this.aircraft.setWheelBrakes(false);
        this.commandHeading(rwy.heading, MAX_BANK_APPROACH);
        this.commandVerticalSpeed(GO_AROUND_CLIMB_RATE, true);
        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        // Gear up on a positive climb, flaps once there is speed to lose them.
        if (this.vel.y > 2 && agl > 15) {
            this.aircraft.setLandingGearDeployed(false);
        }
        if (this.aircraft.getAirspeed() > vref * PATTERN_SPEED_FACTOR) {
            this.aircraft.setFlapsExtended(false);
        }
        if (this.pos.y - td.y > GO_AROUND_HEIGHT) {
            if (this.goArounds >= MAX_GO_AROUNDS) {
                this.divert();
            }
            this.phase = AiFlightPhase.RTB;
            this.rtbLeg = RtbLeg.PLAN;
        }
    }

    /**
     * Give up on this runway for the nearest other one. With only the one
     * runway there is nowhere else: it keeps trying, but from a fresh count.
     */
    private divert(): void {
        const current = this.homeRunway();
        let best: Runway | undefined;
        let bestSq = Infinity;
        for (const r of this.world.runways()) {
            if (r === current) continue;
            const d = (r.center.x - this.pos.x) ** 2 + (r.center.z - this.pos.z) ** 2;
            if (d < bestSq) {
                bestSq = d;
                best = r;
            }
        }
        if (best) {
            this.runwayChoice = best;
        }
        this.goArounds = 0;
    }

    private doApproach(delta: number): void {
        const rwy = this.homeRunway();
        const fwdX = Math.sin(rwy.heading);
        const fwdZ = Math.cos(rwy.heading);
        const rightX = Math.cos(rwy.heading);
        const rightZ = -Math.sin(rwy.heading);

        if (this.aircraft.isLanded()) {
            this.enterRollout();
            return;
        }

        const td = this.touchdownPoint(rwy);
        const along = (this.pos.x - td.x) * fwdX + (this.pos.z - td.z) * fwdZ;
        const distToTouchdown = -along; // positive on approach

        const lateral = (this.pos.x - rwy.center.x) * rightX + (this.pos.z - rwy.center.z) * rightZ;
        // Fly a heading that converges on the centreline, cut at an intercept
        // angle. Rolling on the raw offset instead saturates the bank anywhere
        // more than a few hundred metres out: the aircraft crosses the
        // centreline at right angles and never settles on it.
        const intercept = clamp(lateral * APPROACH_INTERCEPT_PER_M, -APPROACH_MAX_INTERCEPT, APPROACH_MAX_INTERCEPT);
        this.commandHeading(rwy.heading - intercept, MAX_BANK_APPROACH);

        // 3-degree glideslope down to the runway surface at the touchdown point.
        // The path is a ramp, so the sink rate it needs is fed forward; the
        // proportional altitude loop alone trails it ~140 m high and levels
        // off just above the flare gate. The integral trim takes out what the
        // feed-forward leaves, as on a formation slot.
        const groundY = this.world.groundHeightAt(this.pos.x, this.pos.z);
        const glidepath = td.y + Math.max(2, distToTouchdown * GLIDESLOPE);
        // Never below the terrain ahead on the final: a ridge under the
        // approach is crossed above it, and the glidepath taken from above
        // once past. The look-ahead shrinks to nothing short of the runway.
        const ahead = clamp(distToTouchdown - APPROACH_TERRAIN_CLEAR_OF_RUNWAY, 0, APPROACH_TERRAIN_LOOKAHEAD);
        // The clearance shrinks with the glidepath's own height, or over flat
        // ground it would sit above the glidepath on the last few kilometres.
        const clearance = Math.min(APPROACH_TERRAIN_CLEARANCE, APPROACH_TERRAIN_CLEARANCE_SHARE * (glidepath - td.y));
        const terrainFloor = ahead > 0 ? this.terrainAhead(rwy.heading, ahead) + clearance : -Infinity;
        const targetAlt = Math.max(glidepath, terrainFloor);
        const onGlidepath = targetAlt === glidepath;
        // The trim is for the small standing sag of the altitude loop; it
        // would wind up over a ridge and drive the jet that far under the
        // glidepath once past.
        if (onGlidepath && Math.abs(targetAlt - this.pos.y) < APPROACH_TRIM_BAND) {
            this.approachAltTrim = clamp(
                this.approachAltTrim + (targetAlt - this.pos.y) * APPROACH_ALT_TRIM_RATE * delta,
                -APPROACH_ALT_TRIM_MAX, APPROACH_ALT_TRIM_MAX);
        }
        const groundSpeed = Math.hypot(this.vel.x, this.vel.z);
        const pathVs = distToTouchdown > 0 && onGlidepath ? -groundSpeed * GLIDESLOPE : 0;
        // High, it comes down to the glidepath at a limited extra sink rather
        // than diving at it.
        const vsCmd = clamp(
            pathVs + (targetAlt + this.approachAltTrim - this.pos.y) * APPROACH_VS_PER_ALT,
            pathVs - APPROACH_MAX_EXTRA_SINK, MAX_VS);
        this.commandVerticalSpeed(vsCmd, true);
        // Vref from the airframe, reached by VREF_BY_DISTANCE: the RTB speed
        // ramp carries on down the slope rather than stepping to Vref, which
        // undershot it and sank off the glidepath. The speedbrake holds it
        // there, where idle alone lets a clean-winged jet run away.
        const vrefNow = approachSpeed(this.aircraft.getSlowSpeeds());
        this.commandSpeedWithAirbrakes(
            vrefNow + clamp((distToTouchdown - VREF_BY_DISTANCE) * RTB_SPEED_PER_M, 0, RTB_IAF_SPEED_MARGIN), delta, AIRFIELD_THROTTLE_KP);

        const agl = this.pos.y - groundY;
        this.aircraft.setLandingGearDeployed(true);
        this.aircraft.setFlapsExtended(true);

        // Flare in proportion to the sink rate: the nose comes up slowly at
        // approach speed, so it needs FLARE_GATE_TAU seconds of height. A fixed
        // 15 m gate left a fast-sinking final no time and it arrived at 6 m/s.
        const flareHeight = clamp(FLARE_GATE_TAU * Math.max(0, -this.vel.y), FLARE_MIN_HEIGHT, FLARE_MAX_HEIGHT);

        // Stabilised by the gate or go round: on the centreline, lined up, on
        // the glidepath and at Vref. Below it nothing is corrected any more,
        // only flown down; a landing from outside these is a guess.
        const vref = approachSpeed(this.aircraft.getSlowSpeeds());
        const airspeed = this.aircraft.getAirspeed();
        // Height above the runway, not the ground below: over a valley short of
        // the field the gate would otherwise only be checked once over it.
        const aboveRunway = this.pos.y - td.y;
        if (aboveRunway < GATE_HEIGHT && agl > flareHeight) {
            const unstable = Math.abs(lateral) > GATE_MAX_LATERAL ? 'LATERAL'
                : Math.abs(wrapPi(rwy.heading - this.heading)) > GATE_MAX_HEADING_ERROR ? 'HEADING'
                    : Math.abs(this.pos.y - targetAlt) > GATE_MAX_HEIGHT_ERROR ? 'GLIDEPATH'
                        : airspeed > vref + GATE_MAX_FAST ? 'FAST'
                            : airspeed < vref - GATE_MAX_SLOW ? 'SLOW' : undefined;
            if (unstable) {
                this.goAround(unstable);
                return;
            }
        }
        // Past the touchdown point without having flared: high, long or both.
        if (distToTouchdown < -APPROACH_MAX_OVERRUN) {
            this.goAround('LONG');
            return;
        }

        const pastObstructions = this.runwayLayout(rwy).aim - distToTouchdown > this.runwayLayout(rwy).clearFrom;
        if (agl < flareHeight && distToTouchdown < FLARE_MAX_EARLY && pastObstructions) {
            if (Math.abs(lateral) > rwy.halfWidth - FLARE_EDGE_MARGIN) {
                // About to flare onto the grass.
                this.goAround('EDGE');
                return;
            }
            this.phase = AiFlightPhase.FLARE;
            // The flare's first command is what the glidepath was asking for,
            // so there is no step in it (a step down pushed the nose onto the
            // runway); the difference fades out with height, leaving the
            // flare's own law at the wheels.
            this.flareVsBias = vsCmd - flareSinkCommand(agl);
            this.flareEntryHeight = Math.max(1, agl);
            this.flareEntryNose = Math.min(this.nosePitch, MAX_FLARE_PITCH);
        }
    }

    private doFlare(delta: number): void {
        if (this.aircraft.isLanded()) {
            this.enterRollout();
            return;
        }
        // Sink rate in proportion to height, so it bleeds off exponentially
        // and the wheels arrive at FLARE_MIN_SINK. A fixed nose-up stick here
        // ballooned a fast approach hundreds of metres back into the air.
        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        // FLARE_POWER is held, when slow, until the last metres:
        // chopping it as the flare starts - or arriving at idle off a final
        // still slowing down - takes away the lift the nose-up is meant to add.
        // (Not when fast: then the power only floats it down the runway.)
        const slow = this.aircraft.getAirspeed() <= approachSpeed(this.aircraft.getSlowSpeeds());
        this.throttleCmd = agl < FLARE_IDLE_HEIGHT || !slow ? 0 : FLARE_POWER;
        this.aircraft.setThrottle(this.throttleCmd);
        this.airbrakesLatched = false;
        this.aircraft.setAirbrakesExtended(false);
        // Attitude, not climb rate: the nose ramps from where it was at the
        // gate up to MAX_FLARE_PITCH as the height runs out, plus more for
        // sinking faster than the flare's own schedule. Steering the climb
        // rate through the path-hold loop stopped a degree short of the
        // attitude it needed and put the wheels on at 4-6 m/s.
        const progress = 1 - clamp(agl / this.flareEntryHeight, 0, 1);
        const biasShare = 1 - progress;
        const sinkExcess = (flareSinkCommand(agl) + this.flareVsBias * biasShare) - this.vel.y;
        const nose = this.flareEntryNose + (MAX_FLARE_PITCH - this.flareEntryNose) * progress
            + sinkExcess * FLARE_SINK_TO_PITCH;
        this.commandElevation(Math.min(nose, MAX_FLARE_PITCH), true);
        // Keep tracking the centreline, gently: wings held level drift off it
        // over a long float.
        const rwy = this.homeRunway();
        const td = this.touchdownPoint(rwy);
        const f = runwayFrame(td.x, td.z, rwy.heading, this.pos.x, this.pos.z, this.heading);
        const intercept = clamp(f.lateral * APPROACH_INTERCEPT_PER_M, -APPROACH_MAX_INTERCEPT, APPROACH_MAX_INTERCEPT);
        this.commandHeading(rwy.heading - intercept, MAX_BANK_FLARE);
        this.aircraft.setLandingGearDeployed(true);
        this.aircraft.setFlapsExtended(true);
        // Floating down the runway eats the room needed to stop.
        if (-f.toTouchdown > FLARE_MAX_FLOAT) {
            this.goAround('FLOAT');
        }
    }

    private enterRollout(): void {
        this.phase = AiFlightPhase.ROLLOUT;
        this.rolloutRestAgl = Infinity;
    }

    private doRollout(): void {
        const rwy = this.homeRunway();
        // Bounced back into the air: power up and go round rather than come
        // down again further along, nose high and slower. Measured from how
        // high the aircraft sits on its wheels here, not from the ground: the
        // CG rides ~2 m up on the gear, and a runway a metre off the ground
        // height read every landing in the game as a bounce.
        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        this.rolloutRestAgl = Math.min(this.rolloutRestAgl, agl);
        if (!this.aircraft.isLanded() && agl - this.rolloutRestAgl > BOUNCE_HEIGHT) {
            this.goAround('BOUNCE');
            return;
        }
        this.aircraft.setThrottle(0);
        this.throttleCmd = 0;
        this.aircraft.setWheelBrakes(true);
        // Derotate and dump the lift. Neutral stick asks the fly-by-wire for
        // 1 g, which at touchdown speed with the nose still up from the flare
        // flew the aircraft off the runway again (seen in the game, a BOUNCE
        // go-around on every landing); so push the nose down onto the wheel,
        // and put the speedbrakes out.
        this.applyPitch(clamp(-this.nosePitch * ROLLOUT_DEROTATE_GAIN, -ROLLOUT_MAX_PUSH, 0));
        this.airbrakesLatched = true;
        this.aircraft.setAirbrakesExtended(true);
        // Keep straight on the centreline.
        const headingErr = wrapPi(rwy.heading - this.heading);
        this.aircraft.setYaw(clamp(headingErr * 1.5, -1, 1));
        this.wingsLevel();
        if (this.aircraft.getAirspeed() < 2) {
            this.phase = AiFlightPhase.GROUND_IDLE;
        }
    }

    /** Altitude hold that never commands below the local terrain hard deck. */
    private commandAltitudeClamped(desiredAlt: number): void {
        const floor = this.world.groundHeightAt(this.pos.x, this.pos.z) + this.hardDeck;
        this.commandAltitude(Math.max(desiredAlt, floor));
    }
}

/** Vertical speed (m/s) the flare asks for at a height: sink in proportion to it, down to FLARE_MIN_SINK. */
function flareSinkCommand(agl: number): number {
    return -Math.max(FLARE_MIN_SINK, agl / FLARE_TAU);
}

/** Wrap an angle to [-pi, pi]. */
function wrapPi(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}
