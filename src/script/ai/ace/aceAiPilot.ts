import * as THREE from 'three';
import { clamp, FORWARD, RIGHT, UP } from '../../utils/math';
import { Combatant } from '../../weapons/combatant';
import { AiFlightPhase, AiPilot, AiPilotOptions } from '../aiPilot';
import { AiPilotController } from '../aiPilotController';
import { PilotableAircraft } from '../aircraftControls';
import { ballisticAimPoint, predictedMissDistance } from '../dogfightGeometry';
import { FlightControlComputer } from '../shaw/flightControlComputer';
import { WorldQuery } from '../worldQuery';
import { AceTacticalFSM } from './aceTacticalFsm';
import { AceSnapshot, PostStallRequest } from './aceTypes';

/** Post-stall maneuver durations (s). */
const COBRA_DURATION = 1.5;
const KULBIT_DURATION = 2.0;
/** Fraction of the maneuver flown at idle before slamming the throttle back in. */
const COBRA_IDLE_FRACTION = 0.65;
const KULBIT_IDLE_FRACTION = 0.7;
/** Seconds before another post-stall maneuver may be entered. */
const PSM_COOLDOWN = 8;
/**
 * Height above local terrain (m) required to *enter* a post-stall maneuver.
 * While departed, the FCC's terrain-avoidance loop is not running, so the
 * altitude to recover in has to be bought up front.
 */
const PSM_MIN_AGL = 800;
/** Below this AGL an in-progress maneuver is abandoned back to the FCC. */
const PSM_ABORT_AGL = 400;
/** Airspeed windows (m/s) in which each maneuver actually works. */
const COBRA_SPEED_RANGE: readonly [number, number] = [140, 330];
const KULBIT_SPEED_RANGE: readonly [number, number] = [110, 270];

/** Roll gain used to hold wings level through a post-stall maneuver. */
const PSM_ROLL_KP = 2.2;

/** Smoothing on the finite-difference target-acceleration estimate. */
const TARGET_ACC_EMA = 0.25;

/**
 * How far outside the target's hit radius the ballistic solution may miss and
 * still be worth a trigger pull. Tight — this model shoots when the round
 * connects, not to apply pressure.
 */
const ACCURACY_MARGIN = 1.6;

/**
 * "Ace" AI pilot model: an elite dogfighter built on the same
 * FSM -> command -> {@link FlightControlComputer} pipeline as
 * {@link import('../shaw/shawAiPilot').ShawAiPilot} and
 * {@link import('../aggressive/aggressiveAiPilot').AggressiveAiPilot}, with two
 * capabilities neither of those has:
 *
 * 1. **Post-stall maneuvers.** `COBRA_BRAKE` and `KULBIT` are open-loop, timed
 *    departures from controlled flight; the FCC's closed loops would fight
 *    them, so this pilot flies them directly on the stick (see
 *    {@link updatePostStall}). It vetoes the FSM's request when there is not
 *    enough height or the airspeed is outside the window, and abandons one in
 *    progress if the ground comes up.
 * 2. **Ballistic trigger discipline.** The FSM's gun envelope is only
 *    permission; the shot is taken only when the predicted miss distance puts
 *    the round inside the target's hit radius (see {@link hasGunSolution}).
 *
 * All non-ENGAGE mission phases delegate to a classic {@link AiPilot} so
 * takeoff/RTB/nav stay shared across every model.
 */
export class AceAiPilot implements AiPilotController {
    private readonly classic: AiPilot;
    private readonly fsm: AceTacticalFSM;
    private readonly fcc: FlightControlComputer;

    private phase: AiFlightPhase = AiFlightPhase.NAVIGATE;
    private target: Combatant | undefined;
    private firing = false;
    private lastManeuver = 'ACE';

    private readonly gunRange: number;
    private readonly bulletSpeed: number;

    /** Post-stall maneuver in progress, if any. */
    private psmActive: PostStallRequest | undefined;
    private psmElapsed = 0;
    private psmCooldown = 0;

    private hasPrevTargetVel = false;
    private readonly prevTargetVel = new THREE.Vector3();

    private readonly selfSnap: AceSnapshot;
    private readonly tgtSnap: AceSnapshot;
    private readonly _tpos = new THREE.Vector3();
    private readonly _tvel = new THREE.Vector3();
    private readonly _acc = new THREE.Vector3();
    private readonly _fwd = new THREE.Vector3();
    private readonly _right = new THREE.Vector3();
    private readonly _up = new THREE.Vector3();
    private readonly _quat = new THREE.Quaternion();
    private readonly _aim = new THREE.Vector3();
    private readonly _bulletVel = new THREE.Vector3();

    constructor(
        private readonly aircraft: PilotableAircraft,
        private readonly world: WorldQuery,
        options: AiPilotOptions = {},
    ) {
        this.classic = new AiPilot(aircraft, world, options);
        this.gunRange = options.gunRange ?? 900;
        this.bulletSpeed = options.bulletSpeed ?? 1000;
        this.fsm = new AceTacticalFSM({
            gunRange: this.gunRange,
            bulletSpeed: this.bulletSpeed,
            combatSpeed: options.combatSpeed ?? 200,
            maxSpeed: options.maxSpeed ?? 240,
        });
        this.fcc = new FlightControlComputer(aircraft, world, {
            maxSpeed: options.maxSpeed ?? 240,
            hardDeck: options.hardDeck ?? 150,
            pitchKp: options.pitchKp,
            pitchKd: options.pitchKd,
            pitchSlew: options.pitchSlew,
        });

        const corner = options.combatSpeed ?? 200;
        this.selfSnap = this.makeSnapshot(corner);
        this.tgtSnap = this.makeSnapshot(corner);
    }

    private makeSnapshot(cornerVelocity: number): AceSnapshot {
        return {
            position: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            forward: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0),
            right: new THREE.Vector3(1, 0, 0),
            acceleration: new THREE.Vector3(),
            altitude: 0,
            airspeed: 0,
            cornerVelocity,
            maxG: 9,
        };
    }

    getPhase(): AiFlightPhase {
        return this.phase;
    }

    setPhase(phase: AiFlightPhase): void {
        this.phase = phase;
        this.classic.setPhase(phase);
    }

    setTarget(target: Combatant | undefined): void {
        if (target !== this.target) {
            // The acceleration estimate is a finite difference on one target's
            // velocity; carrying it across a target swap would inject a bogus
            // spike into the next gun solution.
            this.hasPrevTargetVel = false;
        }
        this.target = target;
        this.classic.setTarget(target);
    }

    setFormationLead(lead: Combatant | undefined): void {
        // Formation is a non-ENGAGE phase, flown by the delegated classic pilot.
        this.classic.setFormationLead(lead);
    }

    get isFiring(): boolean {
        return this.firing;
    }

    getManeuverLabel(): string {
        if (this.phase !== AiFlightPhase.ENGAGE) {
            return this.classic.getManeuverLabel();
        }
        return `ACE:${this.lastManeuver}`;
    }

    /** Test hook: current Ace tactical posture while engaging. */
    getAceStateLabel(): string {
        return this.fsm.getState();
    }

    /** Test hook: post-stall maneuver in progress, if any. */
    getPostStallManeuver(): PostStallRequest | undefined {
        return this.psmActive;
    }

    update(delta: number): void {
        this.firing = false;
        this.psmCooldown = Math.max(0, this.psmCooldown - delta);

        if (this.aircraft.isCrashed()) {
            this.psmActive = undefined;
            this.aircraft.setThrottle(0);
            this.aircraft.setWheelBrakes(true);
            return;
        }

        // Non-combat phases: classic takeoff / nav / RTB / landing.
        if (this.phase !== AiFlightPhase.ENGAGE || !this.target || !this.target.isAlive()) {
            this.psmActive = undefined;
            this.classic.setPhase(this.phase);
            this.classic.setTarget(this.target);
            this.classic.update(delta);
            this.phase = this.classic.getPhase();
            this.firing = this.classic.isFiring;
            this.lastManeuver = this.classic.getManeuverLabel();
            return;
        }

        this.fillSnapshots(delta);

        // A maneuver already in progress owns the stick until it finishes.
        if (this.psmActive !== undefined) {
            this.updatePostStall(delta);
            return;
        }

        const command = this.fsm.update(this.selfSnap, this.tgtSnap, delta);
        this.lastManeuver = command.maneuverName;

        if (command.postStall !== undefined && this.canEnterPostStall(command.postStall)) {
            this.psmActive = command.postStall;
            this.psmElapsed = 0;
            this.updatePostStall(delta);
            return;
        }

        const preempted = this.fcc.applyCommand(command, delta);
        this.firing = !preempted && command.fireGuns && this.hasGunSolution();
    }

    /** Height above the terrain directly below (m). */
    private agl(): number {
        const p = this.selfSnap.position;
        return p.y - this.world.groundHeightAt(p.x, p.z);
    }

    private canEnterPostStall(kind: PostStallRequest): boolean {
        if (this.psmCooldown > 0) return false;
        if (this.agl() < PSM_MIN_AGL) return false;
        const [min, max] = kind === 'COBRA' ? COBRA_SPEED_RANGE : KULBIT_SPEED_RANGE;
        const v = this.selfSnap.airspeed;
        return v >= min && v <= max;
    }

    /**
     * Fly the timed post-stall maneuver directly: full aft stick, wings held
     * level, throttle cut for the departure and slammed back in for the
     * recovery. Bypassing the FCC also bypasses its terrain-avoidance loop,
     * hence the AGL abort.
     */
    private updatePostStall(delta: number): void {
        const kind = this.psmActive;
        if (kind === undefined) return;

        this.psmElapsed += delta;
        const duration = kind === 'COBRA' ? COBRA_DURATION : KULBIT_DURATION;

        if (this.psmElapsed >= duration || this.agl() < PSM_ABORT_AGL) {
            this.endPostStall();
            return;
        }

        const t = this.psmElapsed / duration;
        const idleFraction = kind === 'COBRA' ? COBRA_IDLE_FRACTION : KULBIT_IDLE_FRACTION;

        const ac = this.aircraft;
        ac.setLandingGearDeployed(false);
        ac.setFlapsExtended(false);
        ac.setWheelBrakes(false);
        // The Cobra is a braking maneuver; the Kulbit needs the thrust to carry
        // the nose over the top.
        ac.setAirbrakesExtended(kind === 'COBRA' && t < idleFraction);
        ac.setThrottle(t < idleFraction ? (kind === 'COBRA' ? 0 : 0.35) : 1);
        ac.setPitch(1);
        ac.setRoll(clamp(-this.bank() * PSM_ROLL_KP, -1, 1));
        ac.setYaw(0);

        // The nose sweeps through the bandit during both maneuvers — take the
        // shot if the solution is there as it passes.
        this.firing = this.hasGunSolution();
    }

    private endPostStall(): void {
        this.psmActive = undefined;
        this.psmElapsed = 0;
        this.psmCooldown = PSM_COOLDOWN;
    }

    /** Bank angle (rad, + right) from the cached body axes. */
    private bank(): number {
        return Math.atan2(this._right.y, this._up.y);
    }

    /**
     * True when the ballistic solution predicts the round passing inside the
     * target's hit radius (with {@link ACCURACY_MARGIN} slack). Unlike a fixed
     * angular cone this accounts for range, the round inheriting our own
     * velocity, the target's acceleration and the gravity drop.
     */
    private hasGunSolution(): boolean {
        const target = this.target;
        if (target === undefined || !target.isAlive()) return false;

        const self = this.selfSnap;
        const tgt = this.tgtSnap;
        if (self.position.distanceTo(tgt.position) > this.gunRange) return false;

        const tof = ballisticAimPoint(
            this._aim,
            self.position, self.velocity,
            tgt.position, tgt.velocity, tgt.acceleration,
            this.bulletSpeed,
        );
        this._bulletVel.copy(self.forward).multiplyScalar(this.bulletSpeed).add(self.velocity);
        const miss = predictedMissDistance(
            self.position, this._bulletVel,
            tgt.position, tgt.velocity, tgt.acceleration,
            tof,
        );
        return miss <= target.getHitRadius() * ACCURACY_MARGIN;
    }

    private fillSnapshots(delta: number): void {
        const ac = this.aircraft;
        this.selfSnap.position.copy(ac.getPosition());
        this.selfSnap.velocity.copy(ac.getVelocity());
        this._quat.copy(ac.getQuaternion());
        this._fwd.copy(FORWARD).applyQuaternion(this._quat);
        this._right.copy(RIGHT).applyQuaternion(this._quat);
        this._up.copy(UP).applyQuaternion(this._quat);
        this.selfSnap.forward.copy(this._fwd);
        this.selfSnap.right.copy(this._right);
        this.selfSnap.up.copy(this._up);
        this.selfSnap.altitude = ac.getAltitude();
        this.selfSnap.airspeed = ac.getAirspeed();

        this.target!.readPosition(this._tpos);
        this.target!.readVelocity(this._tvel);
        this.tgtSnap.position.copy(this._tpos);
        this.tgtSnap.velocity.copy(this._tvel);
        this.tgtSnap.altitude = this._tpos.y;
        this.tgtSnap.airspeed = this._tvel.length();

        // Finite-difference target acceleration, smoothed: the gun solution
        // extrapolates the bandit through its turn rather than along a straight
        // line, which is the difference between tracking a hard-turning target
        // and shooting behind it.
        if (this.hasPrevTargetVel && delta > 1e-4) {
            this._acc.copy(this._tvel).sub(this.prevTargetVel).divideScalar(delta);
            this.tgtSnap.acceleration.lerp(this._acc, TARGET_ACC_EMA);
        } else {
            this.tgtSnap.acceleration.set(0, 0, 0);
        }
        this.prevTargetVel.copy(this._tvel);
        this.hasPrevTargetVel = true;

        if (this._tvel.lengthSq() > 1e-6) {
            this.tgtSnap.forward.copy(this._tvel).normalize();
        } else {
            this.tgtSnap.forward.set(0, 0, 1);
        }
        // Approximate target body axes from velocity for the scissors geometry.
        this.tgtSnap.up.set(0, 1, 0);
        this.tgtSnap.right.crossVectors(this.tgtSnap.up, this.tgtSnap.forward);
        if (this.tgtSnap.right.lengthSq() < 1e-6) {
            this.tgtSnap.right.set(1, 0, 0);
        } else {
            this.tgtSnap.right.normalize();
        }
        this.tgtSnap.up.crossVectors(this.tgtSnap.forward, this.tgtSnap.right).normalize();
    }
}
