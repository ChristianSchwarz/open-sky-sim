import * as THREE from 'three';
import { clamp } from '../../utils/math';
import { computeTacticalGeometry } from './shawGeometry';
import {
    AircraftSnapshot, FlightCommand, ManeuverType, TacticalGeometry, TacticalState,
} from './shawTypes';

/**
 * Shaw Fighter Combat tactical FSM: Offensive / Neutral / Defensive postures
 * with pursuit curves, yo-yos, lead turn, scissors, and defensive spiral.
 * Outputs {@link FlightCommand} setpoints only — never stick inputs.
 */
export class FighterTacticalFSM {
    private currentState: TacticalState = 'NEUTRAL';
    private maneuverTimer = 0;
    private latchedManeuver: ManeuverType | undefined;

    private readonly gunMaxRange: number;
    private readonly overshootVc: number;
    private readonly combatSpeed: number;
    private readonly maxSpeed: number;

    private readonly _dir = new THREE.Vector3();
    private readonly _tmp = new THREE.Vector3();
    private readonly _lead = new THREE.Vector3();

    constructor(options: {
        gunRange?: number;
        overshootVc?: number;
        combatSpeed?: number;
        maxSpeed?: number;
    } = {}) {
        this.gunMaxRange = options.gunRange ?? 900;
        this.overshootVc = options.overshootVc ?? 80;
        this.combatSpeed = options.combatSpeed ?? 200;
        this.maxSpeed = options.maxSpeed ?? 240;
    }

    getState(): TacticalState {
        return this.currentState;
    }

    getManeuverLabel(): string {
        return this.latchedManeuver ?? this.currentState;
    }

    update(self: AircraftSnapshot, target: AircraftSnapshot, delta: number): FlightCommand {
        const geom = computeTacticalGeometry(self, target);
        this.currentState = this.evaluateState(geom);
        this.maneuverTimer += delta;

        switch (this.currentState) {
            case 'OFFENSIVE':
                return this.executeOffensive(self, target, geom);
            case 'DEFENSIVE':
                return this.executeDefensive(self, target, geom);
            case 'NEUTRAL':
            default:
                return this.executeNeutral(self, target, geom);
        }
    }

    private evaluateState(geom: TacticalGeometry): TacticalState {
        // Defensive: bandit is in our rear hemisphere AND tracking us.
        // (TAA alone is also small in a head-on pass — require ATA > 120° so
        // the threat is actually on our six, not merging from the front.)
        if (geom.taa < 60 * Math.PI / 180
            && geom.ata > 120 * Math.PI / 180
            && geom.range < 2500) {
            return 'DEFENSIVE';
        }
        // Offensive: we are on their six inside engagement range.
        if (geom.aot < 60 * Math.PI / 180 && geom.range < 4000) {
            return 'OFFENSIVE';
        }
        return 'NEUTRAL';
    }

    private executeOffensive(
        self: AircraftSnapshot,
        target: AircraftSnapshot,
        geom: TacticalGeometry,
    ): FlightCommand {
        let maneuver: ManeuverType = 'PURE_PURSUIT';
        this._dir.copy(geom.losVector);
        let throttleSpeed = this.combatSpeed;
        let useAirbrakes = false;
        let targetG = self.maxG;
        let allowHardTurn = true;

        // High Yo-Yo: imminent overshoot (Shaw p. 71).
        if (geom.closureRate > this.overshootVc && geom.range < 1200) {
            maneuver = 'HIGH_YO_YO';
            this._dir.copy(geom.losVector).addScaledVector(self.up, 0.7).normalize();
            throttleSpeed = this.combatSpeed * 0.85;
            allowHardTurn = false;
        }
        // Low Yo-Yo: close distance while cutting the circle (Shaw p. 73).
        else if (geom.range > 1500 && geom.range < 3000 && geom.energyDelta > -200) {
            maneuver = 'LOW_YO_YO';
            this._dir.copy(geom.losVector).addScaledVector(self.up, -0.5).normalize();
            throttleSpeed = Math.min(this.maxSpeed, this.combatSpeed * 1.1);
            targetG = 2.0;
            allowHardTurn = false;
        }
        // Guns: lead pursuit.
        else if (geom.range <= this.gunMaxRange) {
            maneuver = 'LEAD_PURSUIT';
            const tof = geom.range / 800;
            this._lead.copy(target.position).addScaledVector(target.velocity, tof);
            this._dir.copy(this._lead).sub(self.position).normalize();
        }
        // Lag when ATA is large to avoid overshoot.
        else if (geom.ata > 30 * Math.PI / 180) {
            maneuver = 'LAG_PURSUIT';
            this._dir.copy(geom.losVector)
                .addScaledVector(target.forward, -0.3)
                .normalize();
        }

        this.latchedManeuver = maneuver;
        const fireGuns = geom.range <= this.gunMaxRange && geom.ata < 8 * Math.PI / 180
            && (maneuver === 'LEAD_PURSUIT' || maneuver === 'PURE_PURSUIT');

        return {
            stateName: 'OFFENSIVE',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed: throttleSpeed,
            targetGForce: targetG,
            useAirbrakes,
            fireGuns,
            allowHardTurn,
        };
    }

    private executeNeutral(
        self: AircraftSnapshot,
        target: AircraftSnapshot,
        geom: TacticalGeometry,
    ): FlightCommand {
        let maneuver: ManeuverType = 'HEAD_ON_ENGAGE';
        this._dir.copy(geom.losVector);
        let throttleSpeed = this.combatSpeed;

        // Lead turn before the merge (Shaw p. 74).
        if (geom.range < 2000 && geom.aot > 120 * Math.PI / 180) {
            maneuver = 'LEAD_TURN';
            const side = self.airspeed > target.airspeed ? 1 : -1;
            this._dir.copy(geom.losVector).addScaledVector(target.right, side).normalize();
        } else if (geom.energyDelta < -500) {
            maneuver = 'ENERGY_CLIMB';
            this._dir.copy(geom.losVector).add(new THREE.Vector3(0, 0.5, 0)).normalize();
            throttleSpeed = Math.min(this.maxSpeed, this.combatSpeed * 1.05);
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'NEUTRAL',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed: throttleSpeed,
            targetGForce: self.maxG * 0.8,
            useAirbrakes: false,
            fireGuns: geom.range <= this.gunMaxRange && geom.ata < 5 * Math.PI / 180,
            allowHardTurn: true,
        };
    }

    private executeDefensive(
        self: AircraftSnapshot,
        target: AircraftSnapshot,
        geom: TacticalGeometry,
    ): FlightCommand {
        let maneuver: ManeuverType = 'BREAK_TURN';
        let throttleSpeed = this.combatSpeed;
        let useAirbrakes = false;

        if (geom.range < 1200) {
            maneuver = 'BREAK_TURN';
            const breakRight = self.right.dot(geom.losVector) > 0;
            this._tmp.copy(self.right).multiplyScalar(breakRight ? 1 : -1);
            this._dir.copy(self.forward).addScaledVector(this._tmp, 2.0).normalize();
            throttleSpeed = this.combatSpeed;
        } else if (self.airspeed < self.cornerVelocity && self.altitude > 1000) {
            maneuver = 'DEFENSIVE_SPIRAL';
            this._dir.set(0, -0.8, 0).addScaledVector(self.right, 0.5);
            this._dir.add(self.forward).normalize();
            throttleSpeed = Math.min(this.maxSpeed, this.combatSpeed * 1.1);
        } else {
            // Flat scissors (Shaw pp. 82–92): cut speed to force bandit ahead.
            maneuver = 'FLAT_SCISSORS';
            useAirbrakes = self.airspeed > target.airspeed;
            throttleSpeed = useAirbrakes ? self.cornerVelocity * 0.7 : self.cornerVelocity;
            const reverse = self.right.dot(target.forward) > 0
                ? this._tmp.copy(self.right).negate()
                : this._tmp.copy(self.right);
            this._dir.copy(self.forward).add(reverse).normalize();
        }

        this.latchedManeuver = maneuver;
        return {
            stateName: 'DEFENSIVE',
            maneuverName: maneuver,
            targetDirection: this._dir.clone(),
            targetSpeed: throttleSpeed,
            targetGForce: self.maxG,
            useAirbrakes,
            fireGuns: false,
            allowHardTurn: true,
        };
    }
}

/** Convenience for unit tests that only need state classification. */
export function classifyTacticalState(geom: TacticalGeometry): TacticalState {
    if (geom.taa < 60 * Math.PI / 180
        && geom.ata > 120 * Math.PI / 180
        && geom.range < 2500) {
        return 'DEFENSIVE';
    }
    if (geom.aot < 60 * Math.PI / 180 && geom.range < 4000) {
        return 'OFFENSIVE';
    }
    return 'NEUTRAL';
}

function clampSpeed(speed: number, max: number): number {
    return clamp(speed, 40, max);
}
