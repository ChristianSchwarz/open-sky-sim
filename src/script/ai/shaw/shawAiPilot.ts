import * as THREE from 'three';
import { FORWARD, RIGHT, UP } from '../../utils/math';
import { Combatant } from '../../weapons/combatant';
import { AiFlightPhase, AiPilot, AiPilotOptions } from '../aiPilot';
import { AiPilotController } from '../aiPilotController';
import { PilotableAircraft } from '../aircraftControls';
import { WorldQuery } from '../worldQuery';
import { FighterTacticalFSM } from './fighterTacticalFsm';
import { FlightControlComputer } from './flightControlComputer';
import { AircraftSnapshot } from './shawTypes';

/**
 * Shaw Fighter Combat AI pilot model. During ENGAGE it runs the doctrinal
 * tactical FSM → Flight Control Computer pipeline; all other mission phases
 * delegate to a classic {@link AiPilot} so takeoff/RTB/nav stay shared.
 */
export class ShawAiPilot implements AiPilotController {
    private readonly classic: AiPilot;
    private readonly fsm: FighterTacticalFSM;
    private readonly fcc: FlightControlComputer;

    private phase: AiFlightPhase = AiFlightPhase.NAVIGATE;
    private target: Combatant | undefined;
    private firing = false;
    private lastManeuver = 'SHAW';

    private readonly selfSnap: AircraftSnapshot;
    private readonly tgtSnap: AircraftSnapshot;
    private readonly _tpos = new THREE.Vector3();
    private readonly _tvel = new THREE.Vector3();
    private readonly _fwd = new THREE.Vector3();
    private readonly _right = new THREE.Vector3();
    private readonly _up = new THREE.Vector3();
    private readonly _quat = new THREE.Quaternion();

    constructor(
        private readonly aircraft: PilotableAircraft,
        world: WorldQuery,
        options: AiPilotOptions = {},
    ) {
        this.classic = new AiPilot(aircraft, world, options);
        this.fsm = new FighterTacticalFSM({
            gunRange: options.gunRange ?? 900,
            combatSpeed: options.combatSpeed ?? 200,
            maxSpeed: options.maxSpeed ?? 240,
            overshootVc: 80,
        });
        this.fcc = new FlightControlComputer(aircraft, world, {
            maxSpeed: options.maxSpeed ?? 240,
            hardDeck: options.hardDeck ?? 150,
            pitchKp: options.pitchKp,
            pitchKd: options.pitchKd,
            pitchSlew: options.pitchSlew,
        });

        const corner = options.combatSpeed ?? 200;
        this.selfSnap = {
            position: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            forward: new THREE.Vector3(),
            up: new THREE.Vector3(),
            right: new THREE.Vector3(),
            altitude: 0,
            airspeed: 0,
            cornerVelocity: corner,
            maxG: 9,
        };
        this.tgtSnap = {
            position: new THREE.Vector3(),
            velocity: new THREE.Vector3(),
            forward: new THREE.Vector3(),
            up: new THREE.Vector3(0, 1, 0),
            right: new THREE.Vector3(1, 0, 0),
            altitude: 0,
            airspeed: 0,
            cornerVelocity: corner,
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
        return `SHAW:${this.lastManeuver}`;
    }

    /** Test hook: current Shaw tactical posture while engaging. */
    getShawStateLabel(): string {
        return this.fsm.getState();
    }

    update(delta: number): void {
        this.firing = false;
        if (this.aircraft.isCrashed()) {
            this.aircraft.setThrottle(0);
            this.aircraft.setWheelBrakes(true);
            return;
        }

        // Non-combat phases: classic takeoff / nav / RTB / landing.
        if (this.phase !== AiFlightPhase.ENGAGE || !this.target || !this.target.isAlive()) {
            this.classic.setPhase(this.phase);
            this.classic.setTarget(this.target);
            this.classic.update(delta);
            this.phase = this.classic.getPhase();
            this.firing = this.classic.isFiring;
            this.lastManeuver = this.classic.getManeuverLabel();
            return;
        }

        this.fillSnapshots();
        const command = this.fsm.update(this.selfSnap, this.tgtSnap, delta);
        this.lastManeuver = command.maneuverName;
        const preempted = this.fcc.applyCommand(command, delta);
        this.firing = !preempted && command.fireGuns;
    }

    private fillSnapshots(): void {
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
        if (this._tvel.lengthSq() > 1e-6) {
            this.tgtSnap.forward.copy(this._tvel).normalize();
        } else {
            this.tgtSnap.forward.set(0, 0, 1);
        }
        // Approximate target body axes from velocity for scissors / lead-turn.
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
