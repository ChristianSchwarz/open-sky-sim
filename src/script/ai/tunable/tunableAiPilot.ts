import * as THREE from 'three';
import { FORWARD, RIGHT } from '../../utils/math';
import { Combatant } from '../../weapons/combatant';
import { AiFlightPhase, AiPilot, AiPilotOptions } from '../aiPilot';
import { AiPilotController } from '../aiPilotController';
import { PilotableAircraft } from '../aircraftControls';
import { WorldQuery } from '../worldQuery';
import { FlightControlComputer } from '../shaw/flightControlComputer';
import { gunMissDistance, TargetAccelEstimator } from '../shaw/gunSolution';
import { setFlightPathAxes } from '../shaw/shawGeometry';
import { AircraftSnapshot } from '../shaw/shawTypes';
import { AiPersonality, clampAiPersonality, personalityTuning, PersonalityTuning } from './aiPersonality';
import { TunableTacticalFSM } from './tunableTacticalFsm';

/** Paths passing this close (m) this soon (s) end the gun pass (see TunableAiPilot.collisionAhead). */
const COLLISION_MISS_M = 100;
const COLLISION_LOOKAHEAD_S = 2.5;
/**
 * ... when at least this share of the closing speed is vertical. Measured, not
 * derived: always vetoing cost the Ace preset 22 wins (every pass looks like a
 * collision until its break), 0.5 still collided, and 0.4 collided elsewhere.
 */
const COLLISION_VERTICAL = 0.45;

/** Standard normal sample (Box-Muller) from Math.random, which the merge bench seeds. */
function gaussian(): number {
    const u = Math.max(1e-12, Math.random());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

/**
 * The TUNABLE pilot model: an opponent set by an {@link AiPersonality}
 * (aggression, defensiveness, skill, energy fighting, gun discipline, g
 * limit) rather than fixed doctrine. During ENGAGE it runs
 * {@link TunableTacticalFSM} through the shared FlightControlComputer; every
 * other phase is the classic pilot's, as for the other models.
 */
export class TunableAiPilot implements AiPilotController {
    private readonly classic: AiPilot;
    private readonly fsm: TunableTacticalFSM;
    private readonly fcc: FlightControlComputer;
    readonly personality: AiPersonality;
    private readonly tune: PersonalityTuning;

    private phase: AiFlightPhase = AiFlightPhase.NAVIGATE;
    private target: Combatant | undefined;
    private firing = false;
    private readonly gunRange: number;
    private readonly bulletSpeed: number;
    private lastManeuver = 'TUNABLE';
    private readonly targetAccel = new TargetAccelEstimator();
    /**
     * Aim wander (rad), an Ornstein-Uhlenbeck walk on two axes square to the
     * nose. It is where the pilot *believes* the nose points: the trigger is
     * judged on it, so the rounds miss by it. It does not steer the jet: a
     * wandering aim read as a passing miss at the merge, so the collision
     * break came too late (midairs head-on).
     */
    private noiseX = 0;
    private noiseY = 0;
    private readonly judgedSnap: AircraftSnapshot;

    private readonly selfSnap: AircraftSnapshot;
    private readonly tgtSnap: AircraftSnapshot;
    private readonly _quat = new THREE.Quaternion();
    private readonly _right = new THREE.Vector3();
    private readonly _rel = new THREE.Vector3();
    private readonly _relVel = new THREE.Vector3();

    constructor(
        private readonly aircraft: PilotableAircraft,
        private readonly world: WorldQuery,
        options: AiPilotOptions = {},
    ) {
        this.classic = new AiPilot(aircraft, world, options);
        this.personality = clampAiPersonality(options.personality);
        this.tune = personalityTuning(this.personality);
        this.bulletSpeed = options.bulletSpeed ?? 1000;
        this.gunRange = (options.gunRange ?? 900) * this.tune.gunRangeMult;
        const maxSpeed = options.maxSpeed ?? 240;
        const hardDeck = options.hardDeck ?? 150;
        this.fsm = new TunableTacticalFSM(this.tune, {
            gunRange: options.gunRange ?? 900, maxSpeed, hardDeck, bulletSpeed: this.bulletSpeed,
        });
        this.fcc = new FlightControlComputer(aircraft, world, {
            maxSpeed, hardDeck, bulletSpeed: this.bulletSpeed,
            pitchKp: options.pitchKp, pitchKd: options.pitchKd, pitchSlew: options.pitchSlew,
            headOnGunPass: this.tune.headOnPass,
            headOnSetupRange: this.tune.headOnSetupRange,
            gunPassBrakes: this.tune.gunPassBrakes,
        });
        const snap = (): AircraftSnapshot => ({
            position: new THREE.Vector3(), velocity: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1),
            up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0),
            altitude: 0, airspeed: 0, cornerVelocity: this.tune.combatSpeed, maxG: this.tune.gCap,
        });
        this.selfSnap = snap();
        this.tgtSnap = { ...snap(), acceleration: new THREE.Vector3() };
        this.judgedSnap = snap();
    }

    getPhase(): AiFlightPhase {
        return this.phase;
    }

    setPhase(phase: AiFlightPhase): void {
        this.phase = phase;
        this.classic.setPhase(phase);
    }

    setTarget(target: Combatant | undefined): void {
        if (target !== this.target) this.targetAccel.reset();
        this.target = target;
        this.classic.setTarget(target);
    }

    setFormationLead(lead: Combatant | undefined): void {
        this.classic.setFormationLead(lead);
    }

    seedPitchStick(stick: number): void {
        this.classic.seedPitchStick(stick);
    }

    get isFiring(): boolean {
        return this.firing;
    }

    getManeuverLabel(): string {
        return this.phase === AiFlightPhase.ENGAGE ? `TUNABLE:${this.lastManeuver}` : this.classic.getManeuverLabel();
    }

    /** Test hook: the tactical posture while engaging. */
    getTunableStateLabel(): string {
        return this.fsm.getState();
    }

    update(delta: number): void {
        this.firing = false;
        if (this.aircraft.isCrashed()) {
            this.aircraft.setThrottle(0);
            this.aircraft.setWheelBrakes(true);
            return;
        }
        if (this.phase !== AiFlightPhase.ENGAGE || !this.target || !this.target.isAlive()) {
            this.classic.setPhase(this.phase);
            this.classic.setTarget(this.target);
            this.classic.update(delta);
            this.phase = this.classic.getPhase();
            this.firing = this.classic.isFiring;
            this.lastManeuver = this.classic.getManeuverLabel();
            return;
        }

        this.fillSnapshots(delta);
        const pos = this.selfSnap.position;
        const command = this.fsm.update(this.selfSnap, this.tgtSnap, delta, pos.y - this.world.groundHeightAt(pos.x, pos.z));
        this.lastManeuver = command.maneuverName;
        if (this.collisionAhead()) command.noGunPass = true;
        const preempted = this.fcc.applyCommand(command, delta, this.tgtSnap);
        if (this.fcc.gunPass) this.lastManeuver = 'GUN_PASS';

        // The wander walks every frame, whether or not there is a shot to judge.
        const judged = this.judgedNose(delta);
        const maxRange = this.fcc.gunPass ? this.tune.headOnFireRange : this.gunRange;
        this.firing = !preempted
            && this.selfSnap.position.distanceTo(this.tgtSnap.position) <= maxRange
            && gunMissDistance(judged, this.tgtSnap, this.bulletSpeed)
                <= (this.target.getHitRadius() * this.tune.missMult + this.tune.missSlack) * (this.fcc.gunPass ? this.tune.headOnMissMult : 1);
    }

    /**
     * Whether the straight-line paths pass within {@link COLLISION_MISS_M}
     * inside {@link COLLISION_LOOKAHEAD_S}. The gun pass then gives way to the
     * controller's full deconfliction: its own break is sideways only and
     * late, and two pilots both in a pass, one climbing and one diving, flew
     * into each other.
     */
    private collisionAhead(): boolean {
        const rel = this._rel.copy(this.tgtSnap.position).sub(this.selfSnap.position);
        const relVel = this._relVel.copy(this.tgtSnap.velocity).sub(this.selfSnap.velocity);
        const v2 = relVel.lengthSq();
        if (v2 < 1) return false;
        const tc = -rel.dot(relVel) / v2;
        if (tc <= 0 || tc > COLLISION_LOOKAHEAD_S) return false;
        // Closing mostly level, the pass's own sideways break clears it.
        if (Math.abs(relVel.y) < COLLISION_VERTICAL * Math.sqrt(v2)) return false;
        return rel.addScaledVector(relVel, tc).length() < COLLISION_MISS_M;
    }

    /** Our snapshot with the nose where the pilot believes it is (see {@link noiseX}). */
    private judgedNose(delta: number): AircraftSnapshot {
        if (this.tune.aimNoise <= 0) return this.selfSnap;
        const a = Math.min(1, delta / this.tune.aimNoiseTau);
        const s = this.tune.aimNoise * Math.sqrt(2 * a);
        this.noiseX += -this.noiseX * a + s * gaussian();
        this.noiseY += -this.noiseY * a + s * gaussian();
        const j = this.judgedSnap;
        j.position.copy(this.selfSnap.position);
        j.velocity.copy(this.selfSnap.velocity);
        j.forward.copy(this.selfSnap.forward)
            .addScaledVector(this.selfSnap.right, this.noiseX)
            .addScaledVector(this.selfSnap.up, this.noiseY).normalize();
        return j;
    }

    private fillSnapshots(delta: number): void {
        const ac = this.aircraft;
        const self = this.selfSnap;
        self.position.copy(ac.getPosition());
        self.velocity.copy(ac.getVelocity());
        this._quat.copy(ac.getQuaternion());
        self.forward.copy(FORWARD).applyQuaternion(this._quat);
        this._right.copy(RIGHT).applyQuaternion(this._quat);
        setFlightPathAxes(self, this._right);
        self.altitude = ac.getAltitude();
        self.airspeed = ac.getAirspeed();

        const tgt = this.tgtSnap;
        this.target!.readPosition(tgt.position);
        this.target!.readVelocity(tgt.velocity);
        tgt.altitude = tgt.position.y;
        tgt.airspeed = tgt.velocity.length();
        this.targetAccel.update(tgt.acceleration!, tgt.velocity, delta);
        if (tgt.airspeed > 1e-3) {
            tgt.forward.copy(tgt.velocity).divideScalar(tgt.airspeed);
        }
        setFlightPathAxes(tgt, tgt.right);
    }
}
