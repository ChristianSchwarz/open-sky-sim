import * as THREE from 'three';
import { clamp, FORWARD, RIGHT, UP } from '../utils/math';
import { AiPilotModels } from '../state/gameDefs';
import { PilotableAircraft } from './aircraftControls';
import { AiPilotController } from './aiPilotController';
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
// Keep the nose out of the near-vertical regime where heading/bank (derived from
// the body axes' vertical components) go singular and the roll loop thrashes.
const MAX_ELEV_CMD = 55 * Math.PI / 180;
const MAX_BANK_NAV = 45 * Math.PI / 180;
const MAX_BANK_COMBAT = 85 * Math.PI / 180;  // near knife-edge for min turn radius
const MAX_BANK_APPROACH = 25 * Math.PI / 180;
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
 * Speedbrake thresholds (m/s over the commanded speed) for station keeping.
 * Idle thrust alone does not slow a clean airframe down at altitude — without
 * the brake the wingman creeps forward past the slot, and once it is ahead the
 * heading loop cannot recover the along-track error. Hysteresis so the boards
 * don't cycle in and out every frame.
 */
const FORMATION_AIRBRAKE_ENTER = 8;
const FORMATION_AIRBRAKE_RELEASE = 3;
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
    /** The runway this pilot committed to; see {@link homeRunway}. */
    private runwayChoice: Runway | undefined;
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
    /** Latched speedbrake state while holding a slot (see FORMATION_AIRBRAKE_*). */
    private formationAirbrakes = false;
    /** Integral trim on the commanded slot altitude (see FORMATION_ALT_TRIM_*). */
    private formationAltTrim = 0;

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
            return AiFlightPhase[this.phase] ?? 'CLASSIC';
        }
        return DogfightMode[this.dogfightMode] ?? 'PURSUE';
    }

    setPhase(phase: AiFlightPhase): void {
        this.phase = phase;
        if (phase === AiFlightPhase.STRAIGHT) {
            this.straightHeadingLatched = false;
        }
        if (phase === AiFlightPhase.RTB) {
            // Turning for home is the moment to decide where home is: by now
            // the aircraft may be a long way from where it took off, and the
            // nearest field is the one it should be going to.
            this.runwayChoice = undefined;
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

    /** True while a firing solution exists this frame (read after update). */
    get isFiring(): boolean {
        return this.firing;
    }

    /** Begin an autonomous takeoff from the current runway. */
    startTakeoff(): void {
        this.phase = AiFlightPhase.TAKEOFF_ROLL;
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
        if (!groundPhase && this.updateTerrainAvoidance(delta)) {
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

    private commandVerticalSpeed(desiredVs: number): void {
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
        const desiredNose = gamma + clamp((desiredVs - this.vel.y) * VS_TO_PITCH, -0.1, 0.1);
        this.commandElevation(desiredNose);
    }

    /** Point the nose at a target elevation angle (used to aim at a 3D point). */
    private commandElevation(desiredElev: number): void {
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
        const raw = pitchErr * this.pitchKp + this.bankPitchComp() - this.pitchRateEst * this.pitchKd;
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

    private commandSpeed(desiredSpeed: number, delta: number): void {
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
        this.aircraft.setThrottle(this.throttleCmd);
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
        const speed = Math.max(1, this.aircraft.getAirspeed());
        let minClearance = Infinity;
        // Probe points from now to the look-ahead horizon.
        for (let t = 0.5; t <= TERRAIN_LOOKAHEAD_S; t += 0.5) {
            this.probe.copy(this.vel).multiplyScalar(t).add(this.pos);
            const g = this.world.groundHeightAt(this.probe.x, this.probe.z);
            const clearance = this.probe.y - g;
            if (clearance < minClearance) {
                minClearance = clearance;
            }
        }
        // Also consider the current instantaneous clearance.
        const nowClearance = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        minClearance = Math.min(minClearance, nowClearance);

        // Hysteresis: engage below the deck, release once comfortably above it.
        if (this.pullUpActive) {
            if (minClearance > this.hardDeck * 2.0 && nowClearance > this.hardDeck) {
                this.pullUpActive = false;
            }
        } else if (minClearance < this.hardDeck) {
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
        this.aircraft.setLandingGearDeployed(false);
        return true;
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
        if (this.runwayChoice === undefined) {
            this.runwayChoice = this.world.nearestRunway(this.pos.x, this.pos.z);
        }
        return this.runwayChoice;
    }

    private doTakeoff(delta: number): void {
        const rwy = this.homeRunway();
        this.aircraft.setLandingGearDeployed(true);
        this.aircraft.setFlapsExtended(true);
        this.aircraft.setWheelBrakes(false);
        this.throttleCmd = 1;
        this.aircraft.setThrottle(1);

        // Ground steering: hold heading and centreline with the nosewheel (yaw).
        const rightX = Math.cos(rwy.heading);
        const rightZ = -Math.sin(rwy.heading);
        const lateral = (this.pos.x - rwy.center.x) * rightX + (this.pos.z - rwy.center.z) * rightZ;
        const headingErr = wrapPi(rwy.heading - this.heading);
        this.aircraft.setYaw(clamp(headingErr * 1.5 - lateral * 0.01, -1, 1));
        this.wingsLevel();

        const airspeed = this.aircraft.getAirspeed();
        if (airspeed >= ROTATE_SPEED) {
            this.applyPitch(0.5); // rotate
        } else {
            this.applyPitch(0);
        }

        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        if (agl > 15 && this.vel.y > 2) {
            this.phase = AiFlightPhase.CLIMB_OUT;
        }
    }

    private doClimbOut(delta: number): void {
        const rwy = this.homeRunway();
        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        const airspeed = this.aircraft.getAirspeed();
        this.aircraft.setLandingGearDeployed(agl < GEAR_UP_ALT);
        this.aircraft.setFlapsExtended(airspeed < FLAPS_UP_SPEED);
        this.aircraft.setWheelBrakes(false);

        this.commandHeading(rwy.heading, MAX_BANK_NAV);
        this.commandVerticalSpeed(80);
        this.commandSpeed(this.cruiseSpeed, delta);

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
            this.commandFormationSpeed(Math.min(this.maxSpeed, leadSpeed + FORMATION_REJOIN_OVERTAKE), delta);
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
        this.commandFormationSpeed(leadSpeed + speedTrim, delta);
    }

    /**
     * Speed hold with the speedbrake as the deceleration authority: the throttle
     * integrator bottoms out at idle long before a clean airframe has actually
     * slowed down, which is not enough to hold a slot behind a slower lead.
     */
    private commandFormationSpeed(desiredSpeed: number, delta: number): void {
        const airspeed = this.aircraft.getAirspeed();
        if (this.formationAirbrakes) {
            if (airspeed < desiredSpeed + FORMATION_AIRBRAKE_RELEASE) this.formationAirbrakes = false;
        } else if (airspeed > desiredSpeed + FORMATION_AIRBRAKE_ENTER) {
            this.formationAirbrakes = true;
        }
        this.aircraft.setAirbrakesExtended(this.formationAirbrakes);
        this.commandSpeed(desiredSpeed, delta);
    }

    /** Loiter at cruise altitude near the lead, closing back in if it drifts off. */
    private doHoldOverhead(delta: number): void {
        this.formationAltTrim = 0;
        this.formationAirbrakes = false;
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

    private doRtb(delta: number): void {
        const rwy = this.homeRunway();
        // Fly to an initial approach fix on the extended centreline, then hand
        // off to the approach controller.
        const fwdX = Math.sin(rwy.heading);
        const fwdZ = Math.cos(rwy.heading);
        const iafDist = rwy.halfLength + 8000;
        this.aim.set(
            rwy.center.x - fwdX * iafDist,
            this.cruiseAltitude * 0.4,
            rwy.center.z - fwdZ * iafDist,
        );
        this.toPoint.copy(this.aim).sub(this.pos);
        const desiredHeading = this.avoidObstacles(Math.atan2(this.toPoint.x, this.toPoint.z));
        this.commandHeading(desiredHeading, MAX_BANK_NAV);
        this.commandAltitudeClamped(this.aim.y);
        this.commandSpeed(this.cruiseSpeed, delta);

        if (Math.hypot(this.toPoint.x, this.toPoint.z) < 2500) {
            this.phase = AiFlightPhase.APPROACH;
        }
    }

    private doApproach(delta: number): void {
        const rwy = this.homeRunway();
        const fwdX = Math.sin(rwy.heading);
        const fwdZ = Math.cos(rwy.heading);
        const rightX = Math.cos(rwy.heading);
        const rightZ = -Math.sin(rwy.heading);

        if (this.aircraft.isLanded()) {
            this.phase = AiFlightPhase.ROLLOUT;
            return;
        }

        // Touchdown ~300 m past the approach threshold.
        const touchdownDist = rwy.halfLength - 300;
        const tdX = rwy.center.x - fwdX * touchdownDist;
        const tdZ = rwy.center.z - fwdZ * touchdownDist;
        const along = (this.pos.x - tdX) * fwdX + (this.pos.z - tdZ) * fwdZ;
        const distToTouchdown = -along; // positive on approach

        const lateral = (this.pos.x - rwy.center.x) * rightX + (this.pos.z - rwy.center.z) * rightZ;
        // Roll to null the lateral offset, blended with a heading hold.
        const headingErr = wrapPi(rwy.heading - this.heading);
        // Same convention as commandHeading: a positive heading/​offset error needs
        // the opposite bank to correct it.
        const desiredBank = clamp(lateral * 0.01 - headingErr * 1.0, -MAX_BANK_APPROACH, MAX_BANK_APPROACH);
        this.commandBank(desiredBank);
        this.aircraft.setYaw(clamp(-lateral * 0.002, -0.3, 0.3));

        // 3-degree glideslope.
        const groundY = this.world.groundHeightAt(this.pos.x, this.pos.z);
        const targetAlt = groundY + Math.max(2, distToTouchdown * 0.052);
        this.commandAltitude(targetAlt);
        this.commandSpeed(150, delta);

        // Configure for landing on final.
        const agl = this.pos.y - groundY;
        this.aircraft.setLandingGearDeployed(agl < 500);
        this.aircraft.setFlapsExtended(agl < 500);

        if (agl < 15 && distToTouchdown < 400) {
            this.phase = AiFlightPhase.FLARE;
        }
    }

    private doFlare(delta: number): void {
        if (this.aircraft.isLanded()) {
            this.phase = AiFlightPhase.ROLLOUT;
            return;
        }
        this.aircraft.setThrottle(0);
        this.throttleCmd = 0;
        this.applyPitch(0.15);
        this.wingsLevel();
        this.aircraft.setLandingGearDeployed(true);
        this.aircraft.setFlapsExtended(true);
    }

    private doRollout(): void {
        const rwy = this.homeRunway();
        this.aircraft.setThrottle(0);
        this.throttleCmd = 0;
        this.aircraft.setWheelBrakes(true);
        this.applyPitch(0);
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

/** Wrap an angle to [-pi, pi]. */
function wrapPi(a: number): number {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}
