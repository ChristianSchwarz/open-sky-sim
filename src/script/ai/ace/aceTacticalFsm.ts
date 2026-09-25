import * as THREE from 'three';
import { ballisticAimPoint } from '../dogfightGeometry';
import { computeTacticalGeometry } from '../shaw/shawGeometry';
import { TacticalGeometry } from '../shaw/shawTypes';
import { AceFlightCommand, AceManeuverType, AceSnapshot, AceState } from './aceTypes';

const DEG = Math.PI / 180;

// --- Tactical-state hysteresis ----------------------------------------------
// Enter/exit thresholds are offset (as in the Shaw and Aggressive FSMs) so
// geometry sitting right on a boundary doesn't flicker the state — and with it
// the aim-direction *method* — every frame.
const CONTROL_ENTER_AOT = 70 * DEG;
const CONTROL_EXIT_AOT = 85 * DEG;
const CONTROL_ENTER_RANGE = 3500;
const CONTROL_EXIT_RANGE = 4000;
const EVADE_ENTER_TAA = 45 * DEG;
const EVADE_EXIT_TAA = 60 * DEG;
const EVADE_ENTER_ATA = 110 * DEG;
const EVADE_EXIT_ATA = 95 * DEG;
const EVADE_ENTER_RANGE = 2000;
const EVADE_EXIT_RANGE = 2400;

// --- Energy discipline ------------------------------------------------------
// Energy height deficit (m) at which the ace stops fighting for angles and
// buys energy back instead. Exiting well before parity keeps it from
// oscillating in and out of RESET around the threshold.
const RESET_ENTER_DEFICIT = 900;
const RESET_EXIT_DEFICIT = 250;
/** Below this range the fight is too close to safely turn tail and extend. */
const RESET_MIN_RANGE = 1200;
/** A bandit pointing this close at us keeps us in the fight regardless of energy. */
const RESET_MAX_TAA = 70 * DEG;

// --- Break/reversal side latch ----------------------------------------------
// Break and scissors direction is a binary left/right choice driven by a dot
// product that naturally sits near zero, so it needs the same hysteresis the
// Aggressive FSM uses for its post-merge reversal, or the aircraft snap-rolls
// left/right/left instead of committing to one side.
const SIDE_LATCH_DEADBAND = 0.25;

/** Rolling-scissors barrel rate (rad/s) around the line of sight. */
const SCISSORS_RATE = 1.6;

/** Bandit closing this fast (m/s) means an overshoot is developing. */
const DEFAULT_OVERSHOOT_VC = 90;
/** Lag-pursuit aim point sits this far (m) behind the bandit. */
const LAG_DISTANCE = 260;

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * "Ace" tactical FSM: an elite dogfighter that fights in the vertical, manages
 * energy deliberately, and finishes with post-stall maneuvers.
 *
 * It reuses the same geometry (`computeTacticalGeometry`) and
 * `FlightControlComputer` pipeline as the Shaw and Aggressive models, but
 * differs from both:
 * - vs. **Aggressive** (never disengages): the ace *does* extend and zoom-climb
 *   ({@link AceState} `RESET`) once it is decisively down on energy, then
 *   re-enters from above rather than grinding out a losing turn circle.
 * - vs. **Shaw** (fair doctrinal BFM): every neutral pass is answered in the
 *   vertical, overshoots are killed with a barrel-roll attack instead of a
 *   plain lag pursuit, and a bandit that reaches guns range on our six is met
 *   with a Cobra or Kulbit — a signature post-stall reversal — rather than
 *   only a break turn or defensive spiral.
 * - vs. **both**: the gun envelope here is only *permission* to shoot. The aim
 *   direction is the full ballistic lead solution (round inherits our own
 *   velocity, target acceleration extrapolated, gravity drop held over), and
 *   the pilot layer additionally requires a predicted hit before firing.
 */
export class AceTacticalFSM {
    private currentState: AceState = 'MERGE';
    private latchedManeuver: AceManeuverType = 'LEAD_TURN';
    /** Latched break/scissors direction (-1/0/1). */
    private breakSide = 0;
    /** Rolling-scissors barrel phase (rad). */
    private scissorsPhase = 0;

    private readonly gunMaxRange: number;
    private readonly bulletSpeed: number;
    private readonly overshootVc: number;
    private readonly combatSpeed: number;
    private readonly maxSpeed: number;

    private readonly _dir = new THREE.Vector3();
    private readonly _aim = new THREE.Vector3();
    private readonly _tmp = new THREE.Vector3();

    constructor(options: {
        gunRange?: number;
        bulletSpeed?: number;
        overshootVc?: number;
        combatSpeed?: number;
        maxSpeed?: number;
    } = {}) {
        this.gunMaxRange = options.gunRange ?? 900;
        this.bulletSpeed = options.bulletSpeed ?? 1000;
        this.overshootVc = options.overshootVc ?? DEFAULT_OVERSHOOT_VC;
        this.combatSpeed = options.combatSpeed ?? 200;
        this.maxSpeed = options.maxSpeed ?? 240;
    }

    getState(): AceState {
        return this.currentState;
    }

    getManeuverLabel(): string {
        return this.latchedManeuver;
    }

    update(self: AceSnapshot, target: AceSnapshot, delta: number): AceFlightCommand {
        const geom = computeTacticalGeometry(self, target);
        const nextState = this.evaluateState(geom);
        // The barrel phase only accumulates while actually scissoring, so each
        // new rolling scissors starts from the geometry it entered on.
        if (nextState === 'EVADE') {
            this.scissorsPhase += SCISSORS_RATE * delta;
        } else {
            this.scissorsPhase = 0;
        }
        // Drop the side latch on every state change so the next break/scissors
        // picks a fresh side instead of inheriting a stale one.
        if (nextState !== this.currentState) {
            this.breakSide = 0;
        }
        this.currentState = nextState;

        switch (this.currentState) {
            case 'CONTROL': return this.executeControl(self, target, geom);
            case 'EVADE': return this.executeEvade(self, geom);
            case 'RESET': return this.executeReset(self, geom);
            case 'MERGE':
            default: return this.executeMerge(self, target, geom);
        }
    }

    /**
     * Priority: survive first (EVADE), then refuse to fight on from a hopeless
     * energy state (RESET), then press the angles we have (CONTROL), else work
     * the merge. RESET is deliberately gated on *not* being threatened —
     * extending in front of a bandit already pointing at us is how aircraft
     * die.
     */
    private evaluateState(geom: TacticalGeometry): AceState {
        const evadeTaa = this.currentState === 'EVADE' ? EVADE_EXIT_TAA : EVADE_ENTER_TAA;
        const evadeAta = this.currentState === 'EVADE' ? EVADE_EXIT_ATA : EVADE_ENTER_ATA;
        const evadeRange = this.currentState === 'EVADE' ? EVADE_EXIT_RANGE : EVADE_ENTER_RANGE;
        if (geom.taa < evadeTaa && geom.ata > evadeAta && geom.range < evadeRange) {
            return 'EVADE';
        }

        const resetDeficit = this.currentState === 'RESET' ? RESET_EXIT_DEFICIT : RESET_ENTER_DEFICIT;
        if (geom.energyDelta < -resetDeficit && geom.range > RESET_MIN_RANGE && geom.taa > RESET_MAX_TAA) {
            return 'RESET';
        }

        const controlAot = this.currentState === 'CONTROL' ? CONTROL_EXIT_AOT : CONTROL_ENTER_AOT;
        const controlRange = this.currentState === 'CONTROL' ? CONTROL_EXIT_RANGE : CONTROL_ENTER_RANGE;
        if (geom.aot < controlAot && geom.range < controlRange) {
            return 'CONTROL';
        }
        return 'MERGE';
    }

    /**
     * Latch a binary left/right choice with hysteresis around a dot product
     * that naturally sits near zero (see {@link SIDE_LATCH_DEADBAND}).
     */
    private resolveSide(current: number, dot: number): number {
        if (current === 0) {
            return dot >= 0 ? 1 : -1;
        }
        if (current > 0 && dot < -SIDE_LATCH_DEADBAND) return -1;
        if (current < 0 && dot > SIDE_LATCH_DEADBAND) return 1;
        return current;
    }

    /**
     * Full ballistic lead solution into {@link _aim}; the aim *direction* is
     * what the nose must track for the round to arrive where the bandit will
     * be. Falls back to raw LOS if the solution degenerates at zero range.
     */
    private ballisticDirection(self: AceSnapshot, target: AceSnapshot, geom: TacticalGeometry): void {
        ballisticAimPoint(
            this._aim,
            self.position, self.velocity,
            target.position, target.velocity, target.acceleration,
            this.bulletSpeed,
        );
        this._dir.copy(this._aim).sub(self.position);
        if (this._dir.lengthSq() < 1e-9) {
            this._dir.copy(geom.losVector);
        } else {
            this._dir.normalize();
        }
    }

    private executeControl(self: AceSnapshot, target: AceSnapshot, geom: TacticalGeometry): AceFlightCommand {
        let maneuver: AceManeuverType = 'LEAD_PURSUIT';
        let targetSpeed = Math.min(this.maxSpeed, self.cornerVelocity * 1.05);
        let useAirbrakes = false;
        let allowHardTurn = true;

        const overshooting = geom.closureRate > this.overshootVc;

        if (overshooting && geom.range < 500) {
            // Knife-fight overshoot: barrel-roll around the bandit's flight
            // path. Rolling out of plane stretches our flight path (and so
            // bleeds forward velocity toward theirs) without ever pointing the
            // nose away, which a plain lag pursuit would.
            maneuver = 'BARREL_ROLL_ATTACK';
            this.breakSide = this.resolveSide(this.breakSide, self.right.dot(geom.losVector));
            this._dir.copy(geom.losVector)
                .addScaledVector(self.up, 0.85)
                .addScaledVector(self.right, this.breakSide * 0.85)
                .normalize();
            targetSpeed = self.cornerVelocity * 0.85;
            useAirbrakes = true;
        } else if (overshooting && geom.energyDelta > 0) {
            // Energy to spare: trade the excess closure for altitude and come
            // back down with the angles preserved.
            maneuver = 'HIGH_YO_YO';
            this._dir.copy(geom.losVector).addScaledVector(self.up, 0.6).normalize();
            targetSpeed = self.cornerVelocity;
            allowHardTurn = false;
        } else if (overshooting) {
            // No energy to yo-yo with: pull to a point behind the bandit and
            // let the range stabilise there.
            maneuver = 'LAG_PURSUIT';
            this._tmp.copy(target.position).addScaledVector(target.forward, -LAG_DISTANCE);
            this._dir.copy(this._tmp).sub(self.position).normalize();
            targetSpeed = self.cornerVelocity;
        } else if (self.airspeed < self.cornerVelocity * 0.85 && geom.range > 700) {
            // Slow and not yet in guns: unload downhill to get back to corner
            // speed while cutting across the inside of the bandit's turn.
            maneuver = 'LOW_YO_YO';
            this._dir.copy(geom.losVector).addScaledVector(self.up, -0.45).normalize();
            targetSpeed = this.maxSpeed;
        } else {
            this.ballisticDirection(self, target, geom);
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'CONTROL',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed,
            targetGForce: self.maxG,
            useAirbrakes,
            fireGuns: geom.range <= this.gunMaxRange && geom.ata < 8 * DEG,
            allowHardTurn,
        };
    }

    private executeMerge(self: AceSnapshot, target: AceSnapshot, geom: TacticalGeometry): AceFlightCommand {
        let maneuver: AceManeuverType = 'LEAD_TURN';
        let targetSpeed = this.maxSpeed;
        let fireGuns = false;

        if (geom.range <= this.gunMaxRange && geom.ata < 6 * DEG) {
            // A head-on pass is a fleeting shot: take it on the full ballistic
            // solution, and don't wander off the aim line for it.
            maneuver = 'HEAD_ON_SNAPSHOT';
            this.ballisticDirection(self, target, geom);
            fireGuns = true;
        } else if (geom.range < 1200 && geom.closureRate > 0) {
            // The ace answer to a merge is the vertical: pull up through the
            // pass so the fight starts with us on top of the bandit's turn
            // circle. The aim sits far enough off the nose that the FCC's
            // hard-turn path takes it as a max-G pull.
            maneuver = 'VERTICAL_REPOSITION';
            this._dir.copy(self.forward).addScaledVector(self.up, 1.6).normalize();
        } else {
            // Lead turn onto where the bandit will be, biased high so the
            // merge is entered with an altitude advantage.
            const tof = geom.range / Math.max(1, this.bulletSpeed * 0.35);
            this._tmp.copy(target.position).addScaledVector(target.velocity, tof);
            this._dir.copy(this._tmp).sub(self.position).normalize()
                .addScaledVector(WORLD_UP, 0.25).normalize();
            targetSpeed = Math.min(this.maxSpeed, Math.max(this.combatSpeed, self.cornerVelocity * 1.1));
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'MERGE',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed,
            targetGForce: self.maxG,
            useAirbrakes: false,
            fireGuns,
            allowHardTurn: true,
        };
    }

    private executeEvade(self: AceSnapshot, geom: TacticalGeometry): AceFlightCommand {
        let maneuver: AceManeuverType;
        let targetSpeed = Math.min(this.maxSpeed, self.cornerVelocity);
        let useAirbrakes = false;
        let postStall: AceFlightCommand['postStall'];
        let fireGuns = false;

        if (geom.range < 550 && geom.closureRate > this.overshootVc * 0.5) {
            // Guns-range bandit closing fast: brake out from in front of their
            // gun solution. The pilot vetoes this if there is no room for it.
            maneuver = 'COBRA_BRAKE';
            postStall = 'COBRA';
            this._dir.copy(self.forward).addScaledVector(self.up, 1.2).normalize();
            targetSpeed = self.cornerVelocity * 0.6;
            useAirbrakes = true;
        } else if (geom.range < 800 && geom.closureRate < -10) {
            // They slid past: flip the nose straight back onto them before the
            // separation lets them re-enter.
            maneuver = 'KULBIT';
            postStall = 'KULBIT';
            this._dir.copy(geom.losVector);
            fireGuns = geom.ata < 12 * DEG && geom.range <= this.gunMaxRange;
        } else if (geom.range < 900) {
            // Rolling scissors: barrel out of plane around the line of sight so
            // the bandit's tracking solution never settles and their own
            // closure forces the overshoot for us.
            maneuver = 'ROLLING_SCISSORS';
            this.breakSide = this.resolveSide(this.breakSide, self.right.dot(geom.losVector));
            const c = Math.cos(this.scissorsPhase);
            const s = Math.sin(this.scissorsPhase);
            this._dir.copy(geom.losVector)
                .addScaledVector(self.right, this.breakSide * c * 0.9)
                .addScaledVector(self.up, s * 0.9)
                .normalize();
            fireGuns = geom.ata < 10 * DEG && geom.range <= this.gunMaxRange;
        } else if (self.altitude > 1500 && geom.energyDelta > -RESET_ENTER_DEFICIT) {
            // Descending max-rate spiral: the turn is tighter and gravity pays
            // for the G, so the bandit has to match it while bleeding.
            maneuver = 'DEFENSIVE_SPIRAL';
            this.breakSide = this.resolveSide(this.breakSide, self.right.dot(geom.losVector));
            this._dir.copy(self.right).multiplyScalar(this.breakSide)
                .addScaledVector(geom.losVector, 0.7)
                .addScaledVector(self.up, -0.5)
                .normalize();
            targetSpeed = this.maxSpeed;
        } else {
            // Plain max-G break into the threat: the shortest path out of their
            // gun envelope, and the start of every angles fight.
            maneuver = 'BREAK_TURN';
            this.breakSide = this.resolveSide(this.breakSide, self.right.dot(geom.losVector));
            this._dir.copy(self.right).multiplyScalar(this.breakSide)
                .addScaledVector(geom.losVector, 0.5)
                .normalize();
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'EVADE',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed,
            targetGForce: self.maxG,
            useAirbrakes,
            fireGuns,
            allowHardTurn: true,
            postStall,
        };
    }

    private executeReset(self: AceSnapshot, geom: TacticalGeometry): AceFlightCommand {
        let maneuver: AceManeuverType;

        if (self.altitude > 2500 && self.airspeed < self.cornerVelocity) {
            // Altitude in the bank but no speed: sell the altitude back for
            // corner speed while the nose comes around onto the bandit.
            maneuver = 'SPLIT_S';
            this._dir.copy(geom.losVector).addScaledVector(self.up, -1.1).normalize();
        } else {
            // Extend away and zoom: the separation buys the seconds the climb
            // needs, and the re-entry then comes from above.
            maneuver = 'ZOOM_CLIMB';
            this._dir.copy(geom.losVector).multiplyScalar(-1).addScaledVector(self.up, 0.7).normalize();
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'RESET',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed: this.maxSpeed,
            targetGForce: self.maxG * 0.6,
            useAirbrakes: false,
            // Never spend a trigger pull while deliberately not pointing at them.
            fireGuns: false,
            allowHardTurn: true,
        };
    }
}
