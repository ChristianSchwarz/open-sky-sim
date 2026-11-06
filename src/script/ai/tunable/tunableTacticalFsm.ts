import * as THREE from 'three';
import { gunLeadDirection } from '../shaw/gunSolution';
import { computeTacticalGeometry } from '../shaw/shawGeometry';
import { AircraftSnapshot, TacticalGeometry } from '../shaw/shawTypes';
import { PersonalityTuning } from './aiPersonality';

export type TunableState = 'ATTACK' | 'NEUTRAL' | 'DEFEND' | 'EXTEND' | 'ZOOM';

export type TunableManeuver =
    | 'LEAD_PURSUIT' | 'PURE_PURSUIT' | 'LAG_PURSUIT' | 'HIGH_YO_YO' | 'LOW_YO_YO' | 'SLASH' | 'REVERSAL'
    | 'MERGE' | 'LEAD_TURN'
    | 'BREAK' | 'JINK'
    | 'EXTEND' | 'ZOOM';

/** A {@link FlightSetpoint} with the labels the pilot reports. */
export interface TunableCommand {
    stateName: TunableState;
    maneuverName: TunableManeuver;
    targetDirection: THREE.Vector3;
    targetSpeed: number;
    useAirbrakes: boolean;
    allowHardTurn: boolean;
    targetGForce: number;
    noGunPass: boolean;
}

const DEG = Math.PI / 180;
/** Range (m) inside which an attack flies the gun lead. */
const LEAD_RANGE_MULT = 1.3;
/** Past this range (m) an energy fighter slashes from above instead of chasing. */
const SLASH_RANGE = 1800;
/** Leave EXTEND past this range (m), whatever the energy. */
const EXTEND_MAX_RANGE = 7000;
/** ZOOM only this far (m) out; closer, it fights with what it has. */
const ZOOM_MIN_RANGE = 3000;
/** Climb angle of a zoom. */
const ZOOM_CLIMB = 30 * DEG;
/** A bandit pointing this close (rad) at us, inside this range (m), is a head-on shot coming. */
const HEAD_ON_THREAT_TAA = 12 * DEG;
const HEAD_ON_THREAT_RANGE = 1800;
/** The bandit this far (rad) off our nose is behind us: reverse (see TunableTacticalFSM.reversal). */
const REVERSAL_ATA = 110 * DEG;
/** Climb in the reversal (y of the aim before normalising): bleeds speed over the cap into height. */
const REVERSAL_CLIMB = 0.15;
/**
 * A break this much slower (m/s) than the fight speed, the bandit beyond this
 * range (m), dives with this much down in the aim (about 40 deg).
 */
const BREAK_UNLOAD_DEFICIT = 15;
const BREAK_UNLOAD_RANGE = 1100;
const BREAK_UNLOAD_DIVE = 2;
/** A bandit pointing this close (rad) at us is in a nose race with us. */
const NOSE_RACE_TAA = 20 * DEG;
/** Below this height over the hard deck (m) neither yo-yos nor breaks go nose-low. */
const LOW_ALTITUDE = 800;
/**
 * Steepest dive (rad) the aim may ask for, reached this high (m) over the
 * hard deck and falling to level at it: a 300 m/s dive needs over a
 * kilometre to pull out of, more than the controller's terrain look-ahead.
 */
const DIVE_MAX = 60 * DEG;
const DIVE_FULL_HEIGHT = 3000;
/** Over the speed cap the dive is held to this (rad), to stop it running away. */
const DIVE_OVERSPEED = 10 * DEG;

/**
 * The TUNABLE pilot's tactics: five postures, entered on geometry and the
 * {@link PersonalityTuning} thresholds, and held for its reaction time
 * before the pilot acts on a change. Outputs setpoints for the shared
 * FlightControlComputer only. Aims are built on flight-path axes (the
 * snapshot's `right` / `up`, see setFlightPathAxes).
 */
export class TunableTacticalFSM {
    private state: TunableState = 'NEUTRAL';
    private pending: TunableState = 'NEUTRAL';
    private pendingFor = 0;
    private stateFor = 0;
    private jinkTimer = 0;
    private jinkSign = 1;
    private breakSign = 0;
    private agl = Infinity;

    private readonly _dir = new THREE.Vector3();
    private readonly _tmp = new THREE.Vector3();

    constructor(
        private readonly tune: PersonalityTuning,
        private readonly options: { gunRange: number; maxSpeed: number; hardDeck: number; bulletSpeed: number },
    ) { }

    getState(): TunableState {
        return this.state;
    }

    /** `agl`: our height (m) over the ground below. */
    update(self: AircraftSnapshot, target: AircraftSnapshot, delta: number, agl: number): TunableCommand {
        this.agl = agl;
        const geom = computeTacticalGeometry(self, target);
        this.advanceState(this.desiredState(self, geom), delta);
        let command: TunableCommand;
        switch (this.state) {
            case 'DEFEND': command = this.defend(self, geom, delta); break;
            case 'EXTEND': command = this.extend(self, geom); break;
            case 'ZOOM': command = this.zoom(self, geom); break;
            case 'ATTACK': command = this.attack(self, target, geom); break;
            default: command = this.neutral(self, target, geom);
        }
        this.capDive(command.targetDirection, self);
        return command;
    }

    private capDive(dir: THREE.Vector3, self: AircraftSnapshot): void {
        const height = this.agl - this.options.hardDeck;
        let limit = DIVE_MAX * Math.min(1, Math.max(0, height / DIVE_FULL_HEIGHT));
        if (self.airspeed > this.options.maxSpeed) limit = Math.min(limit, DIVE_OVERSPEED);
        if (Math.asin(Math.max(-1, Math.min(1, dir.y))) >= -limit) return;
        const horiz = Math.hypot(dir.x, dir.z);
        const hx = horiz > 1e-6 ? dir.x / horiz : self.forward.x;
        const hz = horiz > 1e-6 ? dir.z / horiz : self.forward.z;
        const h = Math.hypot(hx, hz) || 1;
        dir.set(hx / h * Math.cos(limit), -Math.sin(limit), hz / h * Math.cos(limit));
    }

    /** Hold a new posture for the reaction time before taking it; DEFEND is left only after its hold. */
    private advanceState(desired: TunableState, delta: number): void {
        this.stateFor += delta;
        if (desired === this.state) {
            this.pending = desired;
            this.pendingFor = 0;
            return;
        }
        if (desired !== this.pending) {
            this.pending = desired;
            this.pendingFor = 0;
        }
        this.pendingFor += delta;
        const hold = this.state === 'DEFEND' ? this.tune.defendHold : 0;
        if (this.pendingFor >= this.tune.reactTime && this.stateFor >= hold) {
            this.state = desired;
            this.stateFor = 0;
            this.pendingFor = 0;
            this.breakSign = 0;
        }
    }

    private desiredState(self: AircraftSnapshot, geom: TacticalGeometry): TunableState {
        // Its nose on us, from far enough aft and close enough to matter.
        const threatened = geom.taa < this.tune.threatCone && geom.ata > this.tune.threatAta
            && geom.range < this.tune.threatRange;
        // A pilot that will not trade head-on shots gets out of the way of one.
        const headOnShot = !this.tune.headOnPass && geom.taa < HEAD_ON_THREAT_TAA
            && geom.range < HEAD_ON_THREAT_RANGE && geom.closureRate > 0;
        // Its nose on us first, ours too far off to win the race to a head-on shot.
        const lostRace = geom.taa < NOSE_RACE_TAA && geom.range < this.tune.headOnSetupRange
            && geom.closureRate > 0 && geom.ata > geom.taa + this.tune.noseRaceMargin;
        if (threatened || headOnShot || lostRace) return 'DEFEND';

        if (this.state === 'EXTEND') {
            const rebuilt = geom.energyDelta > -this.tune.extendDeficit * 0.3 && geom.range > ZOOM_MIN_RANGE;
            if (!rebuilt && geom.range < EXTEND_MAX_RANGE) return 'EXTEND';
        } else if (geom.energyDelta < -this.tune.extendDeficit && geom.aot > 60 * DEG) {
            return 'EXTEND';
        }

        if (this.state === 'ZOOM') {
            if (geom.energyDelta < this.tune.altitudeAdvantage && geom.range > ZOOM_MIN_RANGE * 0.8) return 'ZOOM';
        } else if (this.tune.altitudeAdvantage > 0 && geom.energyDelta < this.tune.altitudeAdvantage - 400
            && geom.range > ZOOM_MIN_RANGE && self.airspeed > 180) {
            return 'ZOOM';
        }

        return geom.aot < 90 * DEG ? 'ATTACK' : 'NEUTRAL';
    }

    private command(
        stateName: TunableState, maneuverName: TunableManeuver, speed: number, g = this.tune.gCap,
    ): TunableCommand {
        return {
            stateName, maneuverName,
            targetDirection: this._dir.clone(),
            targetSpeed: Math.min(speed, this.options.maxSpeed),
            useAirbrakes: false,
            allowHardTurn: false,
            targetGForce: Math.min(g, this.tune.gCap),
            noGunPass: stateName === 'DEFEND',
        };
    }

    private highEnough(self: AircraftSnapshot): boolean {
        return this.agl > this.options.hardDeck + LOW_ALTITUDE;
    }

    /**
     * Turn back toward a bandit well behind (after a pass) level and a little
     * nose-up, on its side. Aimed straight at it, the aim is dead astern, the
     * pull goes whichever way it happens to be (down, mostly), and the jet
     * split-S'd 1000 m into the speed cap while the bandit kept its height.
     */
    private reversal(self: AircraftSnapshot, geom: TacticalGeometry, state: TunableState): TunableCommand | undefined {
        if (geom.ata < REVERSAL_ATA) return undefined;
        this._tmp.copy(geom.losVector).setY(0);
        if (this._tmp.lengthSq() < 1e-6) this._tmp.copy(self.right);
        this._tmp.normalize();
        // Square to the nose on the bandit's side, so the roll has a side to go to.
        const side = self.right.dot(this._tmp) >= 0 ? 1 : -1;
        this._dir.copy(self.right).multiplyScalar(side).addScaledVector(this._tmp, 0.5).normalize();
        // Up toward a bandit above, as steep as the line of sight: aimed level,
        // a reversal out of a diving pass held the nose 40 deg down at 85 deg
        // of bank and spiralled 650 m under a Shaw that climbed away above it.
        this._dir.y = Math.max(REVERSAL_CLIMB, geom.losVector.y);
        this._dir.normalize();
        return this.command(state, 'REVERSAL', this.tune.combatSpeed);
    }

    private attack(self: AircraftSnapshot, target: AircraftSnapshot, geom: TacticalGeometry): TunableCommand {
        const speed = this.tune.combatSpeed;
        const reversal = this.tune.reversal ? this.reversal(self, geom, 'ATTACK') : undefined;
        if (reversal) return reversal;
        if (geom.closureRate > this.tune.overshootVc && geom.range < 1200) {
            this._dir.copy(geom.losVector).addScaledVector(self.up, 0.7).normalize();
            return this.command('ATTACK', 'HIGH_YO_YO', speed * 0.9, 3);
        }
        if (geom.range <= this.options.gunRange * LEAD_RANGE_MULT) {
            gunLeadDirection(this._dir, self, target, this.options.bulletSpeed);
            this._dir.normalize();
            return this.command('ATTACK', 'LEAD_PURSUIT', speed);
        }
        if (this.tune.altitudeAdvantage > 600 && geom.range > SLASH_RANGE && geom.energyDelta > 0) {
            // Come down on it from above, keeping the height to zoom off after.
            this._dir.copy(geom.losVector).addScaledVector(self.up, 0.25).normalize();
            return this.command('ATTACK', 'SLASH', this.options.maxSpeed);
        }
        if (geom.ata > this.tune.lagAngle) {
            this._dir.copy(geom.losVector).addScaledVector(target.forward, -0.3).normalize();
            return this.command('ATTACK', 'LAG_PURSUIT', speed);
        }
        if (this.tune.altitudeAdvantage < 400 && geom.range > 1500 && geom.range < 3000 && this.highEnough(self)) {
            this._dir.copy(geom.losVector).addScaledVector(self.up, -0.4).normalize();
            return this.command('ATTACK', 'LOW_YO_YO', speed * 1.05);
        }
        this._dir.copy(geom.losVector);
        return this.command('ATTACK', 'PURE_PURSUIT', speed);
    }

    private neutral(self: AircraftSnapshot, target: AircraftSnapshot, geom: TacticalGeometry): TunableCommand {
        const speed = this.tune.combatSpeed;
        const reversal = this.tune.reversal ? this.reversal(self, geom, 'NEUTRAL') : undefined;
        if (reversal) return reversal;
        if (!this.tune.headOnPass && geom.range < 2500 && geom.aot > 120 * DEG) {
            // Turns aside rather than trading head-on shots: lead-turn toward
            // the side the bandit passes on, to arrive behind its wing line.
            const side = self.right.dot(geom.losVector) >= 0 ? 1 : -1;
            this._dir.copy(geom.losVector).addScaledVector(self.right, side * 0.9).normalize();
            return this.command('NEUTRAL', 'LEAD_TURN', speed);
        }
        if (geom.range <= this.options.gunRange * LEAD_RANGE_MULT) {
            gunLeadDirection(this._dir, self, target, this.options.bulletSpeed);
            this._dir.normalize();
        } else {
            this._dir.copy(geom.losVector);
            if (this.tune.altitudeAdvantage > 600 && self.airspeed > 200) {
                this._dir.addScaledVector(self.up, 0.3).normalize();
            }
        }
        return this.command('NEUTRAL', 'MERGE', speed);
    }

    private defend(self: AircraftSnapshot, geom: TacticalGeometry, delta: number): TunableCommand {
        // Break toward the bandit's side, so it has to pull more lead than it
        // can; the side is latched, or the break reverses as the bandit
        // crosses our tail.
        if (this.breakSign === 0) {
            this.breakSign = self.right.dot(geom.losVector) >= 0 ? 1 : -1;
        }
        // On the level heading, not the nose: a break built on a diving nose dives on with it.
        this._dir.copy(self.forward).setY(0);
        if (this._dir.lengthSq() < 1e-6) this._dir.crossVectors(self.right, self.up).setY(0);
        this._dir.normalize().addScaledVector(self.right, this.breakSign * 2);
        if (self.airspeed < this.tune.combatSpeed && this.highEnough(self)) {
            // Turn rate rises with speed on this airframe, so a slow jet broken
            // in a circle is out-turned by the faster one behind it: a skilled
            // pilot dives for speed first, while the bandit is still out of guns.
            const unload = this.tune.reversal && geom.range > BREAK_UNLOAD_RANGE
                && self.airspeed < this.tune.combatSpeed - BREAK_UNLOAD_DEFICIT;
            this._dir.addScaledVector(self.up, unload ? -BREAK_UNLOAD_DIVE : -0.3);
        }
        let maneuver: TunableManeuver = 'BREAK';
        // A bandit with its nose on us in gun range: move out of the plane of its shot.
        if (geom.range < 1100 && geom.taa < 15 * DEG && Number.isFinite(this.tune.jinkPeriod)) {
            this.jinkTimer += delta;
            if (this.jinkTimer >= this.tune.jinkPeriod) {
                this.jinkTimer = 0;
                this.jinkSign = -this.jinkSign;
                if (Math.random() < 0.5) this.breakSign = -this.breakSign;
            }
            this._dir.addScaledVector(self.up, this.jinkSign * (this.highEnough(self) ? 1 : 0.5) * 1.2);
            maneuver = 'JINK';
        } else {
            this.jinkTimer = 0;
        }
        this._dir.normalize();
        return this.command('DEFEND', maneuver, this.tune.combatSpeed, this.tune.gCap * this.tune.breakG);
    }

    private extend(self: AircraftSnapshot, geom: TacticalGeometry): TunableCommand {
        // Away from the bandit, level and a little nose-low: full power, light g.
        this._tmp.copy(geom.losVector).setY(0);
        if (this._tmp.lengthSq() < 1e-6) this._tmp.copy(self.forward).setY(0);
        this._dir.copy(this._tmp).normalize().negate();
        this._dir.y = this.highEnough(self) ? -0.1 : 0.05;
        this._dir.normalize();
        return this.command('EXTEND', 'EXTEND', this.options.maxSpeed, 2.5);
    }

    private zoom(self: AircraftSnapshot, geom: TacticalGeometry): TunableCommand {
        // Climb out across the bandit's line of sight, keeping it in view.
        this._tmp.copy(geom.losVector).setY(0);
        if (this._tmp.lengthSq() < 1e-6) this._tmp.copy(self.forward).setY(0);
        this._tmp.normalize();
        const side = self.right.dot(this._tmp) >= 0 ? 1 : -1;
        this._dir.set(-this._tmp.z * side, 0, this._tmp.x * side).addScaledVector(this._tmp, 0.5).normalize()
            .multiplyScalar(Math.cos(ZOOM_CLIMB));
        this._dir.y = Math.sin(ZOOM_CLIMB);
        return this.command('ZOOM', 'ZOOM', this.options.maxSpeed, 3);
    }
}
