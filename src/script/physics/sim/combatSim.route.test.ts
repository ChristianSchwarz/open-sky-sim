import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { AiFlightPhase, AiRoute } from '../../ai/aiPilot';
import { AiPilotController } from '../../ai/aiPilotController';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { SimAircraftSpawn } from './simTypes';

/**
 * The waypoint editor's routes (AiFlightPhase.WAYPOINT) on the real FM2
 * airframe, through the worker API the game drives: off one runway, round the
 * waypoints at their altitudes and speeds, and down on the route's runway.
 */

const ID = 'mf0';
const HALF_LENGTH = 1500;
const HALF_WIDTH = 30;
const FAR_Z = 30_000;

type Internals = {
    pilot: AiPilotController;
    route: AiRoute | undefined;
    isLanded(): boolean;
    isCrashed(): boolean;
    getPosition(): THREE.Vector3;
    getAirspeed(): number;
};

function sim(): CombatSim {
    const s = new CombatSim();
    // The home runway at the origin and the destination well up the +Z axis.
    s.setWorld(serializeWorld([], [], [
        { center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH },
        { center: new THREE.Vector3(0, 0, FAR_Z), heading: 0, halfLength: HALF_LENGTH, halfWidth: HALF_WIDTH },
    ], [], [], []));
    return s;
}

function add(s: CombatSim, spawn: SimAircraftSpawn): Internals {
    s.addAircraft({
        id: ID,
        faction: Faction.PLAYER,
        control: 'ai',
        kinematic: false,
        aircraftConfig: defaultFm2Config,
        pilotOptions: { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150 },
        hitRadius: 10,
        maxHealth: 100,
        spawn,
        enabled: true,
    });
    return (s as unknown as { aircraft: Map<string, Internals> }).aircraft.get(ID)!;
}

/** Step at 60 Hz until `until` holds or `seconds` run out; the phases flown, in order. */
function fly(s: CombatSim, a: Internals, seconds: number, until: () => boolean): AiFlightPhase[] {
    const phases: AiFlightPhase[] = [];
    for (let i = 0; i < seconds * 60 && !until(); i++) {
        s.step(1 / 60, {});
        const phase = a.pilot.getPhase();
        if (phases[phases.length - 1] !== phase) {
            phases.push(phase);
        }
        if (a.isCrashed()) {
            break;
        }
    }
    return phases;
}

const names = (phases: AiFlightPhase[]): string => phases.map(p => AiFlightPhase[p]).join(' > ');

describe('AI waypoint routes', () => {
    it('takes off, flies the waypoints and lands on the route runway', () => {
        const s = sim();
        const a = add(s, {
            position: [0, fm2GroundRestHeight(defaultFm2Config), -HALF_LENGTH + 100],
            quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false,
        });
        s.setRoute(ID, {
            points: [
                { x: 8000, y: 1500, z: 8000, speed: 200 },
                { x: 0, y: 1200, z: 16_000, speed: 180 },
            ],
            next: 0,
            land: { x: 0, z: FAR_Z },
        });
        s.setPhase(ID, AiFlightPhase.TAKEOFF_ROLL);
        let airborne = false;
        const phases = fly(s, a, 900, () => {
            airborne ||= !a.isLanded();
            return airborne && a.isLanded() && a.getAirspeed() < 5;
        });
        const p = a.getPosition();
        assert.equal(a.isCrashed(), false, `crashed at ${p.toArray()}: ${names(phases)}`);
        assert.ok(phases.includes(AiFlightPhase.WAYPOINT), `never flew the route: ${names(phases)}`);
        assert.equal(a.route?.next, 2, `stopped at waypoint ${a.route?.next}: ${names(phases)}`);
        assert.ok(a.isLanded() && a.getAirspeed() < 5, `not stopped on the ground: ${names(phases)}`);
        assert.ok(Math.abs(p.x) < HALF_WIDTH && Math.abs(p.z - FAR_Z) < HALF_LENGTH,
            `landed at ${p.toArray().map(v => v.toFixed(0))}, not on the route runway: ${names(phases)}`);
    });

    it('holds the leg altitude and speed, and circles the last waypoint without a runway', () => {
        const s = sim();
        const a = add(s, {
            position: [0, 2000, 2000], quaternion: [0, 0, 0, 1], velocity: [0, 0, 200],
            landed: false, throttle: 0.8, airborne: true,
        });
        s.setRoute(ID, { points: [{ x: 0, y: 2500, z: 60_000, speed: 160 }], next: 0 });
        s.setPhase(ID, AiFlightPhase.WAYPOINT);
        fly(s, a, 120, () => false);
        assert.ok(Math.abs(a.getPosition().y - 2500) < 100, `at ${a.getPosition().y.toFixed(0)} m, not 2500`);
        assert.ok(Math.abs(a.getAirspeed() - 160) < 15, `at ${a.getAirspeed().toFixed(0)} m/s, not 160`);
        // Past the only waypoint: it stays in the phase, round that point.
        fly(s, a, 420, () => false);
        assert.equal(a.pilot.getPhase(), AiFlightPhase.WAYPOINT);
        const p = a.getPosition();
        assert.ok(Math.hypot(p.x, p.z - 60_000) < 8000, `${Math.hypot(p.x, p.z - 60_000).toFixed(0)} m from it`);
    });

    it('lands on the end the route names, the runway turned round', () => {
        const s = sim();
        const a = add(s, {
            position: [0, 1500, 8000], quaternion: [0, 0, 0, 1], velocity: [0, 0, 180],
            landed: false, throttle: 0.6, airborne: true,
        });
        // Landing heading PI: from the far side, against the world's listing of it.
        s.setRoute(ID, { points: [{ x: 0, y: 1200, z: 16_000, speed: 180 }], next: 0, land: { x: 0, z: FAR_Z, heading: Math.PI } });
        s.setPhase(ID, AiFlightPhase.WAYPOINT);
        const track: number[] = [];
        const phases = fly(s, a, 900, () => {
            if (a.pilot.getPhase() === AiFlightPhase.ROLLOUT) {
                track.push((a as unknown as { getVelocity(): THREE.Vector3 }).getVelocity().z);
            }
            return a.isLanded() && a.getAirspeed() < 5;
        });
        const p = a.getPosition();
        assert.equal(a.isCrashed(), false, `crashed at ${p.toArray()}: ${names(phases)}`);
        assert.ok(a.isLanded() && Math.abs(p.z - FAR_Z) < HALF_LENGTH && Math.abs(p.x) < HALF_WIDTH,
            `not stopped on the route runway (${p.toArray().map(v => v.toFixed(0))}): ${names(phases)}`);
        assert.ok(track.length > 0 && track[0] < -20, `rolled out at vz ${track[0]?.toFixed(0)}, not toward -Z`);
    });

    it('keeps the route when the pilot is rebuilt', () => {
        const s = sim();
        const a = add(s, {
            position: [0, 2000, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 200],
            landed: false, throttle: 0.8, airborne: true,
        });
        s.setRoute(ID, { points: [{ x: 0, y: 2000, z: 20_000, speed: 200 }], next: 0 });
        s.setPilotOptions(ID, { cruiseAltitude: 3000, cruiseSpeed: 200, hardDeck: 150 });
        s.setPhase(ID, AiFlightPhase.WAYPOINT);
        fly(s, a, 30, () => false);
        assert.ok((a.pilot as unknown as { route?: AiRoute }).route === a.route && a.route, 'route lost');
        assert.ok(a.getPosition().z > 4000, 'not flying toward the waypoint');
    });
});
