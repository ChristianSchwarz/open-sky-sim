import * as THREE from 'three';
import { gunLeadDirection } from '../shaw/gunSolution';
import { computeTacticalGeometry } from '../shaw/shawGeometry';
import { AircraftSnapshot, TacticalGeometry } from '../shaw/shawTypes';
import { AggressiveFlightCommand, AggressiveManeuverType, AggressiveState } from './aggressiveTypes';

// --- Side-selection latch --------------------------------------------------
// Picking which way to reverse after a merge (POST_MERGE_REVERSAL) is a
// binary left/right choice driven by the sign of a dot product that
// naturally sits near zero while the two aircraft rotate relative to each
// other. Without hysteresis that sign flips almost every frame, which reads
// as the aircraft snap-rolling left/right/left instead of committing to one
// direction — the same class of bug the heading-error turn latches elsewhere
// in the codebase (e.g. AiPilot's TURN_LATCH_ENTER/RELEASE) exist to prevent.
// (SCISSORS_COUNTER has no such choice: it always turns straight at the
// bandit's bearing — see {@link executeCounter}.)
const SIDE_LATCH_DEADBAND = 0.25;

// --- Tactical-state hysteresis ----------------------------------------------
// Enter/exit thresholds are offset so geometry sitting right at a boundary
// doesn't flicker the state (and therefore the aim-direction *method* —
// e.g. lead-pursuit intercept vs. raw LOS) every frame.
const ATTACK_ENTER_AOT = 75 * Math.PI / 180;
const ATTACK_EXIT_AOT = 90 * Math.PI / 180;
const ATTACK_ENTER_RANGE = 5000;
const ATTACK_EXIT_RANGE = 5500;
const COUNTER_ENTER_TAA = 60 * Math.PI / 180;
const COUNTER_EXIT_TAA = 75 * Math.PI / 180;
const COUNTER_ENTER_ATA = 120 * Math.PI / 180;
const COUNTER_EXIT_ATA = 105 * Math.PI / 180;
const COUNTER_ENTER_RANGE = 2500;
const COUNTER_EXIT_RANGE = 2750;

/**
 * "Berserker" tactical FSM: a maximally aggressive fighter doctrine, reusing
 * the same geometry (`computeTacticalGeometry`) and flight-control pipeline
 * as {@link FighterTacticalFSM} (Shaw) but with a very different philosophy.
 *
 * Unlike the balanced BFM `AiPilot` (which disengages via `EXTEND` to rebuild
 * energy and breaks defensively off a tracking threat) or Shaw's fair
 * doctrinal Offensive/Neutral/Defensive matrix, this model:
 * - Never disengages/extends to rebuild energy — it always presses the attack
 *   regardless of energy state.
 * - Never breaks defensively away from a threat — a bandit tracking us from
 *   the rear is answered with a scissors counter-attack turned *into* the
 *   threat, not a break turn or defensive spiral away from it.
 * - Commits to head-on gunfights on a neutral merge instead of a cautious
 *   lead turn / energy climb.
 * - Fires with a wider tracking-angle cone and out to a longer range than
 *   Shaw/Classic, trading accuracy for constant pressure (snap-shooting).
 */
export class AggressiveTacticalFSM {
    private currentState: AggressiveState = 'MERGE';
    private latchedManeuver: AggressiveManeuverType = 'HEAD_ON_PRESS';
    /** Latched reversal direction for POST_MERGE_REVERSAL (-1/0/1). */
    private mergeReversalSide = 0;

    private readonly gunMaxRange: number;
    /** Snap-shoot beyond the "clean" gun range: trades accuracy for pressure. */
    private readonly snapShotRange: number;
    private readonly overshootVc: number;
    private readonly combatSpeed: number;
    private readonly maxSpeed: number;
    private readonly bulletSpeed: number;

    private readonly _dir = new THREE.Vector3();

    constructor(options: {
        gunRange?: number;
        overshootVc?: number;
        combatSpeed?: number;
        maxSpeed?: number;
        bulletSpeed?: number;
    } = {}) {
        this.gunMaxRange = options.gunRange ?? 900;
        this.snapShotRange = this.gunMaxRange * 1.2;
        // Looser than Shaw's default (80): tolerates more closure before
        // yo-yo-ing away, staying nose-on/close far longer.
        this.overshootVc = options.overshootVc ?? 110;
        this.combatSpeed = options.combatSpeed ?? 210;
        this.maxSpeed = options.maxSpeed ?? 240;
        this.bulletSpeed = options.bulletSpeed ?? 1000;
    }

    getState(): AggressiveState {
        return this.currentState;
    }

    getManeuverLabel(): string {
        return this.latchedManeuver;
    }

    update(self: AircraftSnapshot, target: AircraftSnapshot, _delta: number): AggressiveFlightCommand {
        const geom = computeTacticalGeometry(self, target);
        const nextState = this.evaluateState(geom);
        // Reset the reversal-side latch whenever we're not in MERGE, so the
        // *next* time we enter it picks a fresh side from the current
        // geometry instead of inheriting a stale one.
        if (nextState !== 'MERGE') this.mergeReversalSide = 0;
        this.currentState = nextState;

        switch (this.currentState) {
            case 'COUNTER': return this.executeCounter(self, target, geom);
            case 'ATTACK': return this.executeAttack(self, target, geom);
            case 'MERGE':
            default: return this.executeMerge(self, target, geom);
        }
    }

    /**
     * Threat detection mirrors the doctrinal models' geometry (bandit
     * tracking us from our rear hemisphere, in range) but the *response*
     * never disengages — see {@link executeCounter}. Offense is judged more
     * generously (wider cone, longer range) than Shaw/Classic, matching the
     * doctrine of always pressing rather than holding out for a clean shot.
     * Thresholds widen once already in a state (hysteresis) so geometry
     * sitting right at a boundary doesn't flicker the state every frame.
     */
    private evaluateState(geom: TacticalGeometry): AggressiveState {
        const counterTaa = this.currentState === 'COUNTER' ? COUNTER_EXIT_TAA : COUNTER_ENTER_TAA;
        const counterAta = this.currentState === 'COUNTER' ? COUNTER_EXIT_ATA : COUNTER_ENTER_ATA;
        const counterRange = this.currentState === 'COUNTER' ? COUNTER_EXIT_RANGE : COUNTER_ENTER_RANGE;
        if (geom.taa < counterTaa && geom.ata > counterAta && geom.range < counterRange) {
            return 'COUNTER';
        }
        const attackAot = this.currentState === 'ATTACK' ? ATTACK_EXIT_AOT : ATTACK_ENTER_AOT;
        const attackRange = this.currentState === 'ATTACK' ? ATTACK_EXIT_RANGE : ATTACK_ENTER_RANGE;
        if (geom.aot < attackAot && geom.range < attackRange) {
            return 'ATTACK';
        }
        return 'MERGE';
    }

    /**
     * Latch a binary left/right choice with hysteresis around a dot product
     * that naturally sits near zero (see {@link SIDE_LATCH_DEADBAND}) so the
     * chosen side only flips once the geometry has clearly crossed over,
     * instead of chattering every frame.
     */
    private resolveSide(current: number, dot: number): number {
        if (current === 0) {
            return dot >= 0 ? 1 : -1;
        }
        if (current > 0 && dot < -SIDE_LATCH_DEADBAND) return -1;
        if (current < 0 && dot > SIDE_LATCH_DEADBAND) return 1;
        return current;
    }

    private executeAttack(
        self: AircraftSnapshot,
        target: AircraftSnapshot,
        geom: TacticalGeometry,
    ): AggressiveFlightCommand {
        let maneuver: AggressiveManeuverType = 'LEAD_PURSUIT';
        let targetSpeed = Math.min(this.maxSpeed, this.combatSpeed * 1.05);
        let allowHardTurn = true;

        // High yo-yo only when an overshoot is truly imminent at knife-fight
        // range — no low-yo-yo/lag-pursuit caution otherwise, it just muscles
        // the lead-pursuit turn at max-G.
        if (geom.closureRate > this.overshootVc && geom.range < 700) {
            maneuver = 'HIGH_YO_YO';
            this._dir.copy(geom.losVector).addScaledVector(self.up, 0.55).normalize();
            targetSpeed = this.combatSpeed * 0.9;
            allowHardTurn = false;
        } else {
            gunLeadDirection(this._dir, self, target, this.bulletSpeed);
            this._dir.normalize();
        }

        this.latchedManeuver = maneuver;
        const fireGuns = geom.range <= this.snapShotRange && geom.ata < 14 * Math.PI / 180;
        return {
            stateName: 'ATTACK',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed,
            targetGForce: self.maxG,
            useAirbrakes: false,
            fireGuns,
            allowHardTurn,
        };
    }

    private executeMerge(
        self: AircraftSnapshot,
        target: AircraftSnapshot,
        geom: TacticalGeometry,
    ): AggressiveFlightCommand {
        // No lead turn / energy climb finesse: drive nose-to-nose and take
        // the gunfight if it's in range, then commit to the tightest
        // possible reversal to regain an offensive angle right after the pass.
        let maneuver: AggressiveManeuverType = 'HEAD_ON_PRESS';
        this._dir.copy(geom.losVector);
        const targetSpeed = Math.min(this.maxSpeed, this.combatSpeed * 1.1);

        if (geom.range < 1500 && geom.closureRate > 0) {
            maneuver = 'POST_MERGE_REVERSAL';
            this.mergeReversalSide = this.resolveSide(this.mergeReversalSide, self.right.dot(target.velocity));
            this._dir.copy(self.forward).addScaledVector(self.right, this.mergeReversalSide * 1.4).normalize();
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'MERGE',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed,
            targetGForce: self.maxG,
            useAirbrakes: false,
            fireGuns: geom.range <= this.snapShotRange && geom.ata < 10 * Math.PI / 180,
            allowHardTurn: true,
        };
    }

    private executeCounter(
        self: AircraftSnapshot,
        _target: AircraftSnapshot,
        geom: TacticalGeometry,
    ): AggressiveFlightCommand {
        // Never break away: always turn straight at the bandit's current
        // bearing — not away from it, and not toward some computed
        // lateral "cut" that can point somewhere else entirely — closing the
        // angle as fast as possible forces an overshoot instead of extending
        // range to escape. This is the core "never flees" trait. A slight
        // upward bias keeps it a scissoring pull rather than a flat, literal
        // collision course (mirrors AiPilot's alwaysEngage scissors-into-threat).
        const maneuver: AggressiveManeuverType = 'SCISSORS_COUNTER';
        this._dir.copy(geom.losVector).addScaledVector(self.up, 0.12).normalize();

        this.latchedManeuver = maneuver;
        return {
            stateName: 'COUNTER',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed: Math.min(this.maxSpeed, self.cornerVelocity * 1.05),
            targetGForce: self.maxG,
            useAirbrakes: false,
            fireGuns: geom.range <= this.snapShotRange && geom.ata < 14 * Math.PI / 180,
            allowHardTurn: true,
        };
    }
}
