import * as THREE from 'three';
import { clamp, FORWARD, RIGHT, UP } from '../../utils/math';
import { PilotableAircraft } from '../aircraftControls';
import { WorldQuery } from '../worldQuery';
import {
    ballisticAimPoint, HEAD_ON_BREAK_S, HEAD_ON_SETUP_CONE, HEAD_ON_SETUP_RANGE, isHeadOnGunPass,
} from '../dogfightGeometry';

/**
 * Minimal structural shape {@link FlightControlComputer} actually consumes.
 * Any tactical FSM's command type (Shaw's `FlightCommand`, Aggressive's
 * `AggressiveFlightCommand`, ...) can be passed to {@link FlightControlComputer.applyCommand}
 * as long as it has these fields — the extra state/maneuver-label fields
 * those richer command types carry are for telemetry only and are ignored here.
 */
export interface FlightSetpoint {
    /** World-space aim direction the nose should track. */
    targetDirection: THREE.Vector3;
    /** Desired airspeed (m/s). */
    targetSpeed: number;
    /** When true, cut throttle hard (stand-in for speedbrakes). */
    useAirbrakes: boolean;
    /** Allow the full-g pull; when false the g is capped at {@link targetGForce}. */
    allowHardTurn: boolean;
    /** Load factor (g) the pull is capped at when {@link allowHardTurn} is false. */
    targetGForce?: number;
    /** The tactics decline the head-on gun pass this frame (e.g. a nose race they would lose). */
    noGunPass?: boolean;
}

// FM2-friendly gains, mirrored from AiPilot (see its commandTrack and
// docs/ai-dogfight-strategy.md "Merge bench").
const ROLL_KP = 2.2;
const ROLL_YAW_COORD = 0.05;
const PITCH_KP = 1.0;
const PITCH_KD = 0.35;
const PITCH_CMD_SLEW = 2.5;
const PITCH_MIN = -0.7;
const PITCH_MAX = 1.0;
const THROTTLE_KP = 0.04;
const RATE_EMA = 0.35;
const OVERSPEED_ELEV_GAIN = 0.01;
const OVERSPEED_ELEV_MAX = 0.35;
const OVERSPEED_IDLE_MARGIN = 15;
const TERRAIN_LOOKAHEAD_S = 4;
const GRAVITY = 9.81;
/**
 * Tracking law (AiPilot TRACK_GAIN): commanded lift = the aim's line-of-sight
 * rate x airspeed + this gain (1/s) x airspeed x aim error + 1 g. It replaced
 * a heading/elevation cascade (75 deg bank cap, 50 deg climb cap) and a hard
 * turn that rolled only toward the aim's compass bearing: on FM2 the nose
 * hunted degrees off the lead and the pilots chased each other up into the
 * vertical until both hung at 10 m/s.
 */
const TRACK_GAIN = 6;
const AIM_RATE_EMA = 0.2;
/** Damping (s) on the aim error (see AiPilot TRACK_DAMP_S). */
const TRACK_DAMP_S = 0.1;
/** Roll error (rad) past which the pull eases to {@link LIFT_ROLL_PULL} while the lift vector comes round ... */
const LIFT_ROLL_FIRST = 90 * Math.PI / 180;
/** ... and under which it pulls with everything. */
const LIFT_ROLL_ALIGNED = 30 * Math.PI / 180;
const LIFT_ROLL_PULL = 0.15;
/** Stick (negative) tracking may push for a small correction over the top rather than rolling inverted. */
const TRACK_PUSH_MAX = -0.4;
const TRACK_PUSH_G = 2.5;
/** ... and whatever the g with the nose this close (rad) to the aim (see AiPilot). */
const TRACK_PUSH_ANGLE = 10 * Math.PI / 180;
/** Above this (m AGL, over the hard deck) the pull may continue inverted (see AiPilot INVERTED_PULL_AGL). */
const INVERTED_PULL_AGL = 600;
/**
 * Below this airspeed (m/s) the steepest climb the aim may ask for falls from
 * FIGHT_CLIMB_MAX to FIGHT_CLIMB_FLOOR at FIGHT_UNLOAD_SPEED (AiPilot
 * capAimClimb): lift runs out long before the g limit on this airframe, so a
 * slow climb only ends in a hang.
 */
const FIGHT_SLOW_SPEED = 170;
const FIGHT_UNLOAD_SPEED = 110;
const FIGHT_CLIMB_MAX = 45 * Math.PI / 180;
const FIGHT_CLIMB_FLOOR = -15 * Math.PI / 180;
/** No commanded fight speed (m/s) below this, and no airbrake under it: below it the jet cannot turn. */
export const FIGHT_MIN_SPEED = 160;
/**
 * Airspeed (m/s) to turn-fight at (AiPilot CORNER_SPEED): g grows with speed
 * squared on this airframe (full stick 2.3 g at 120 m/s, 6.3 g at 240), so
 * turn rate rises right up to the overspeed cap and there is no slower corner.
 */
export const FIGHT_CORNER_SPEED = 238;
/** Look-ahead (s) and miss distance (m) under which a pass with the bandit would be a collision. */
const DECONFLICT_LOOKAHEAD_S = 4;
const DECONFLICT_MISS_M = 150;

function wrapPi(a: number): number {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

/** The bandit's state, for collision deconfliction at the merge. */
export interface FlightBandit {
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    /** Estimated acceleration, for the gun lead of a head-on pass. */
    acceleration?: THREE.Vector3;
}

const ZERO_ACCEL = new THREE.Vector3();

/**
 * Maps {@link FlightSetpoint}s into normalized stick/throttle for FM2 with the
 * classic pilot's gun tracking law (see {@link TRACK_GAIN}): roll the lift
 * vector onto the acceleration that brings the nose onto the aim and keeps it
 * there, and pull just the g that takes.
 */
export class FlightControlComputer {
    private readonly maxSpeed: number;
    private readonly hardDeck: number;
    private readonly pitchKp: number;
    private readonly pitchKd: number;
    private readonly pitchSlew: number;

    private throttleCmd = 0.5;
    private pitchCmdState = 0;
    private lastDelta = 1 / 60;
    private pullUpActive = false;
    private prevNosePitch = 0;
    private hasPrevAttitude = false;
    private pitchRateEst = 0;
    private hasPrevAim = false;

    private readonly pos = new THREE.Vector3();
    private readonly vel = new THREE.Vector3();
    private readonly quat = new THREE.Quaternion();
    private readonly fwd = new THREE.Vector3();
    private readonly right = new THREE.Vector3();
    private readonly up = new THREE.Vector3();
    private readonly aimDir = new THREE.Vector3();
    private readonly prevAimDir = new THREE.Vector3();
    private readonly prevFwd = new THREE.Vector3();
    private readonly noseRate = new THREE.Vector3();
    private readonly aimRate = new THREE.Vector3();
    private readonly liftDir = new THREE.Vector3();
    private readonly rel = new THREE.Vector3();
    private readonly bulletSpeed: number;
    private gunPassActive = false;
    private readonly headOnGunPass: boolean;
    private readonly headOnSetupRange: number;
    private readonly gunPassBrakes: boolean;
    private readonly relVel = new THREE.Vector3();
    private readonly probe = new THREE.Vector3();

    constructor(
        private readonly aircraft: PilotableAircraft,
        private readonly world: WorldQuery,
        options: {
            maxSpeed?: number;
            hardDeck?: number;
            pitchKp?: number;
            pitchKd?: number;
            pitchSlew?: number;
            bulletSpeed?: number;
            /** Take the head-on gun pass (default); false leaves the merge to the tactics. */
            headOnGunPass?: boolean;
            /** How far out (m) the gun pass takes the aim (default HEAD_ON_SETUP_RANGE). */
            headOnSetupRange?: number;
            /**
             * Over the speed cap in a gun pass, brake rather than pull the nose
             * off the aim (default false): the overspeed pull held a 250 m/s
             * jet's nose over the bandit through the whole pass.
             */
            gunPassBrakes?: boolean;
        } = {},
    ) {
        this.bulletSpeed = options.bulletSpeed ?? 1000;
        this.headOnGunPass = options.headOnGunPass ?? true;
        this.headOnSetupRange = options.headOnSetupRange ?? HEAD_ON_SETUP_RANGE;
        this.gunPassBrakes = options.gunPassBrakes ?? false;
        this.maxSpeed = options.maxSpeed ?? 240;
        this.hardDeck = options.hardDeck ?? 150;
        this.pitchKp = options.pitchKp ?? PITCH_KP;
        this.pitchKd = options.pitchKd ?? PITCH_KD;
        this.pitchSlew = options.pitchSlew ?? PITCH_CMD_SLEW;
    }

    /**
     * Apply a tactical command. With `bandit` the aim is pushed off a
     * collision course with it. Returns true if terrain pull-up pre-empted the
     * command this frame (caller should suppress firing).
     */
    applyCommand(command: FlightSetpoint, delta: number, bandit?: FlightBandit): boolean {
        this.readState(delta);
        this.aircraft.setLandingGearDeployed(false);
        this.aircraft.setFlapsExtended(false);
        this.aircraft.setWheelBrakes(false);

        if (this.updateTerrainAvoidance()) {
            this.aircraft.setAirbrakesExtended(false);
            this.hasPrevAim = false;
            return true;
        }

        this.aimDir.copy(command.targetDirection);
        if (this.aimDir.lengthSq() < 1e-9) {
            this.aimDir.copy(this.fwd);
        } else {
            this.aimDir.normalize();
        }
        // A bandit flying at us is shot at, whatever the tactics wanted: the
        // aim becomes its gun lead from HEAD_ON_SETUP_RANGE, so the nose is
        // on it when it comes into gun range (see isHeadOnGunPass).
        this.gunPassActive = bandit !== undefined && this.headOnGunPass && !command.noGunPass
            && isHeadOnGunPass(this.pos, this.vel, bandit.position, bandit.velocity,
                this.headOnSetupRange, HEAD_ON_SETUP_CONE);
        if (this.gunPassActive) {
            ballisticAimPoint(this.aimDir, this.pos, this.vel, bandit!.position, bandit!.velocity,
                bandit!.acceleration ?? ZERO_ACCEL, this.bulletSpeed);
            this.aimDir.sub(this.pos).normalize();
        }
        if (bandit) {
            this.deconflictAim(bandit, this.gunPassActive ? HEAD_ON_BREAK_S : DECONFLICT_LOOKAHEAD_S);
        }
        this.capAimClimb();

        const airspeed = this.aircraft.getAirspeed();
        const brakePass = this.gunPassActive && this.gunPassBrakes && airspeed > this.maxSpeed;
        const airbrakes = (command.useAirbrakes || brakePass) && airspeed > FIGHT_MIN_SPEED;
        this.aircraft.setAirbrakesExtended(airbrakes);
        let desiredSpeed = clamp(command.targetSpeed, FIGHT_MIN_SPEED, this.maxSpeed);
        if (airbrakes) {
            desiredSpeed = Math.min(desiredSpeed, airspeed * 0.85);
            this.throttleCmd = Math.min(this.throttleCmd, 0.15);
        }

        // A setpoint that does not allow the hard turn (a yo-yo) asks for its
        // own g; everything else may pull what the wing has.
        const maxG = command.allowHardTurn ? Infinity : Math.max(1.5, command.targetGForce ?? 3);
        this.commandTrack(delta, maxG);
        this.commandSpeed(desiredSpeed, delta);
        return false;
    }

    /** Whether the last command was overridden by a head-on gun pass. */
    get gunPass(): boolean {
        return this.gunPassActive;
    }

    private readState(delta: number): void {
        this.lastDelta = delta > 1e-4 ? delta : this.lastDelta;
        this.pos.copy(this.aircraft.getPosition());
        this.vel.copy(this.aircraft.getVelocity());
        this.quat.copy(this.aircraft.getQuaternion());
        this.fwd.copy(FORWARD).applyQuaternion(this.quat);
        this.right.copy(RIGHT).applyQuaternion(this.quat);
        this.up.copy(UP).applyQuaternion(this.quat);

        const nosePitch = Math.asin(clamp(this.fwd.y, -1, 1));
        if (this.hasPrevAttitude && delta > 1e-4) {
            const pitchRateRaw = (nosePitch - this.prevNosePitch) / delta;
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

    private get bank(): number {
        return Math.atan2(this.right.y, this.up.y);
    }

    private get nosePitch(): number {
        return Math.asin(clamp(this.fwd.y, -1, 1));
    }

    private commandBank(desiredBank: number): void {
        const rollCmd = clamp(wrapPi(desiredBank - this.bank) * ROLL_KP, -1, 1);
        this.aircraft.setRoll(rollCmd);
    }

    /**
     * Fly the nose onto `aimDir` and keep it there (AiPilot commandTrack). The
     * stick is a g command, 1 g at neutral and {@link maxStickG} at full aft;
     * `maxG` caps the g asked for.
     */
    private commandTrack(delta: number, maxG: number): void {
        if (this.hasPrevAim && delta > 1e-4) {
            this.liftDir.copy(this.aimDir).sub(this.prevAimDir).divideScalar(delta);
            this.aimRate.lerp(this.liftDir, AIM_RATE_EMA);
            this.liftDir.copy(this.fwd).sub(this.prevFwd).divideScalar(delta);
            this.noseRate.lerp(this.liftDir, AIM_RATE_EMA);
        } else {
            this.aimRate.set(0, 0, 0);
            this.noseRate.set(0, 0, 0);
        }
        this.prevAimDir.copy(this.aimDir);
        this.prevFwd.copy(this.fwd);
        this.hasPrevAim = true;

        const speed = Math.max(1, this.aircraft.getAirspeed());
        const aimAngle = Math.acos(clamp(this.fwd.dot(this.aimDir), -1, 1));
        // Aim error as an angle, pointing across the nose toward the aim.
        this.liftDir.copy(this.aimDir).addScaledVector(this.fwd, -this.fwd.dot(this.aimDir));
        if (this.liftDir.lengthSq() < 1e-8) {
            this.liftDir.copy(this.up); // dead astern: any way round, the way we pull now
        }
        this.liftDir.normalize().multiplyScalar(aimAngle * TRACK_GAIN * speed)
            .addScaledVector(this.aimRate, speed)
            .addScaledVector(this.aimRate, TRACK_DAMP_S * TRACK_GAIN * speed)
            .addScaledVector(this.noseRate, -TRACK_DAMP_S * TRACK_GAIN * speed);
        this.liftDir.y += GRAVITY;
        this.liftDir.addScaledVector(this.fwd, -this.fwd.dot(this.liftDir));
        const liftG = Math.min(maxG, this.liftDir.length() / GRAVITY);

        // Small corrections over the top are pushed, not rolled 180 deg for,
        // while upright (see AiPilot.commandTrack).
        let rollErr = Math.atan2(-this.liftDir.dot(this.right), this.liftDir.dot(this.up));
        let wantG = liftG;
        if (this.up.y > 0 && Math.abs(rollErr) > LIFT_ROLL_FIRST + Math.PI / 6
            && (liftG < TRACK_PUSH_G || aimAngle < TRACK_PUSH_ANGLE)) {
            rollErr = wrapPi(rollErr + Math.PI);
            wantG = -liftG;
        }
        this.aircraft.setRoll(liftG > 0.2 ? clamp(rollErr * ROLL_KP, -1, 1) : 0);
        this.aircraft.setYaw(clamp(this.bank * ROLL_YAW_COORD, -0.3, 0.3));

        let pull = clamp((wantG - 1) / (maxStickG(speed) - 1), TRACK_PUSH_MAX, PITCH_MAX);
        const rollT = clamp((Math.abs(rollErr) - LIFT_ROLL_ALIGNED) / (LIFT_ROLL_FIRST - LIFT_ROLL_ALIGNED), 0, 1);
        if (pull > LIFT_ROLL_PULL) {
            pull += (LIFT_ROLL_PULL - pull) * rollT;
        }
        const over = speed - this.maxSpeed;
        if (over > 0 && !(this.gunPassActive && this.gunPassBrakes)) {
            pull = Math.max(pull, clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX));
        }
        const agl = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        if (this.up.y < 0 && agl > this.hardDeck + INVERTED_PULL_AGL) {
            this.pitchCmdState = clamp(pull, PITCH_MIN, PITCH_MAX);
            this.aircraft.setPitch(this.pitchCmdState);
        } else {
            this.applyPitchImmediate(pull);
        }
    }

    /**
     * Hold `aimDir` below the climb this airspeed can still fly: unrestricted
     * from {@link FIGHT_SLOW_SPEED}, falling to nose-low at {@link FIGHT_UNLOAD_SPEED}.
     */
    private capAimClimb(): void {
        const t = clamp((this.aircraft.getAirspeed() - FIGHT_UNLOAD_SPEED) / (FIGHT_SLOW_SPEED - FIGHT_UNLOAD_SPEED), 0, 1);
        if (t >= 1) return;
        const limit = FIGHT_CLIMB_FLOOR + (FIGHT_CLIMB_MAX - FIGHT_CLIMB_FLOOR) * t;
        if (Math.asin(clamp(this.aimDir.y, -1, 1)) <= limit) return;
        const horiz = Math.hypot(this.aimDir.x, this.aimDir.z);
        const hx = horiz > 1e-6 ? this.aimDir.x / horiz : Math.sin(this.heading);
        const hz = horiz > 1e-6 ? this.aimDir.z / horiz : Math.cos(this.heading);
        this.aimDir.set(hx * Math.cos(limit), Math.sin(limit), hz * Math.cos(limit));
    }

    /**
     * Steer `aimDir` off a collision course with the bandit (AiPilot
     * deconflictAim): if the straight-line paths come within
     * {@link DECONFLICT_MISS_M} in the next few seconds, aim far enough aside
     * at the closest point to pass clear, left to left when dead on.
     */
    private deconflictAim(bandit: FlightBandit, lookahead: number): void {
        this.rel.copy(bandit.position).sub(this.pos);
        this.relVel.copy(bandit.velocity).sub(this.vel);
        const relSpeedSq = this.relVel.lengthSq();
        if (relSpeedSq < 1) return;
        const tc = -this.rel.dot(this.relVel) / relSpeedSq;
        if (tc <= 0 || tc > lookahead) return;
        this.rel.addScaledVector(this.relVel, tc);
        const miss = this.rel.length();
        if (miss >= DECONFLICT_MISS_M) return;
        // A gun pass passes beside it, never over or under (see AiPilot.deconflictAim).
        if (this.gunPassActive) {
            this.rel.y = 0;
        }
        const missSide = this.rel.length();
        if (missSide > 1) {
            this.rel.multiplyScalar(-1 / missSide);
        } else {
            this.rel.set(Math.cos(this.heading), 0, -Math.sin(this.heading));
        }
        // The aim must lean away at least as far as our own flight path pushed
        // aside to pass clear: a tactical aim well off the nose (a reversal, a
        // lead turn) can point into the other aircraft's path however it is
        // nudged, and two mirrored pilots then turn into the same point.
        const along = Math.max(50, Math.sqrt(relSpeedSq) * tc);
        this.liftDir.copy(this.vel).setLength(along).addScaledVector(this.rel, DECONFLICT_MISS_M - miss).normalize();
        const need = this.liftDir.dot(this.rel) - this.aimDir.dot(this.rel);
        if (need > 0) {
            this.aimDir.addScaledVector(this.rel, need).normalize();
        }
    }

    private applyPitch(raw: number): void {
        const target = this.limitPitchForAttitude(raw);
        const maxStep = this.pitchSlew * this.lastDelta;
        this.pitchCmdState += clamp(target - this.pitchCmdState, -maxStep, maxStep);
        this.aircraft.setPitch(this.pitchCmdState);
    }

    private applyPitchImmediate(raw: number): void {
        this.pitchCmdState = this.limitPitchForAttitude(raw);
        this.aircraft.setPitch(this.pitchCmdState);
    }

    private limitPitchForAttitude(pitch: number): number {
        if (this.up.y < 0) {
            return clamp(pitch, PITCH_MIN, 0.1);
        }
        return clamp(pitch, PITCH_MIN, PITCH_MAX);
    }

    private commandSpeed(desiredSpeed: number, delta: number): void {
        desiredSpeed = Math.min(desiredSpeed, this.maxSpeed);
        const airspeed = this.aircraft.getAirspeed();
        const speedErr = desiredSpeed - airspeed;
        this.throttleCmd = clamp(this.throttleCmd + speedErr * THROTTLE_KP * delta, 0, 1);
        if (airspeed > this.maxSpeed + OVERSPEED_IDLE_MARGIN) {
            this.throttleCmd = 0;
        }
        this.aircraft.setThrottle(this.throttleCmd);
    }

    private updateTerrainAvoidance(): boolean {
        let minClearance = Infinity;
        for (let t = 0.5; t <= TERRAIN_LOOKAHEAD_S; t += 0.5) {
            this.probe.copy(this.vel).multiplyScalar(t).add(this.pos);
            const g = this.world.groundHeightAt(this.probe.x, this.probe.z);
            minClearance = Math.min(minClearance, this.probe.y - g);
        }
        const nowClearance = this.pos.y - this.world.groundHeightAt(this.pos.x, this.pos.z);
        minClearance = Math.min(minClearance, nowClearance);

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

        this.commandBank(0);
        this.aircraft.setYaw(0);
        this.applyPitch(PITCH_MAX);
        this.throttleCmd = 1;
        this.aircraft.setThrottle(1);
        return true;
    }
}

/** The g full stick gives at `speed` (m/s), from the measured 2.3 g at 120 to 6.3 g at 240 (AiPilot maxStickG). */
function maxStickG(speed: number): number {
    return clamp(0.0333 * speed - 1.7, 1.2, 9);
}
