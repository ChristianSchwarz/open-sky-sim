import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { SimControlInputs, SimFlightModelKind } from './simTypes';
import { AC, AC_STRIDE } from './simSnapshotCodec';

/** A gear-up (belly) landing in the combined sim: it must be possible, slide to a halt, and cost some health. */

const GEAR_UP: SimControlInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, landingGearDeployed: false, flapsExtended: false,
    airbrakesExtended: false, hookDeployed: false, wheelBrakesApplied: false, pitchLimiterMode: 0,
    limitersEnabled: true, wantForceVectors: false, firing: false,
};

function land(model: SimFlightModelKind, sinkMps: number, speedMps: number, seconds: number) {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 5000, halfWidth: 200,
    }], [], [], []));
    sim.addAircraft({
        id: 'player', faction: Faction.PLAYER, control: 'external', model, aircraftConfig: defaultFm2Config,
        hitRadius: 10, maxHealth: 100,
        spawn: {
            position: [0, 4.2, -600], quaternion: [0, 0, 0, 1], velocity: [0, -sinkMps, speedMps],
            landed: false, throttle: 0, airborne: true,
        },
        enabled: true,
    });
    let crashed = false;
    let health = 100;
    let z = 0;
    let zBefore = 0;
    const steps = seconds * 60;
    for (let i = 0; i < steps && !crashed; i++) {
        sim.step(1 / 60, { player: GEAR_UP });
        if (i === steps - 301) {
            zBefore = z;
        }
        const snap = sim.encodeSnapshotInto(undefined, undefined);
        const k = snap.ids.indexOf('player');
        const r = snap.aircraft.subarray(k * AC_STRIDE, (k + 1) * AC_STRIDE);
        crashed = r[AC.crashed] !== 0;
        health = r[AC.health];
        z = r[AC.posZ];
    }
    return { crashed, health, z, movedInLast5s: z - zBefore };
}

describe('belly landing in the combat sim', () => {
    for (const model of ['fm2', 'fm3'] as const) {
        it(`${model}: a level gear-up landing survives and slides to a halt`, () => {
            const r = land(model, 3, 70, 50);
            assert.equal(r.crashed, false);
            assert.ok(r.health > 80, `health ${r.health}`);
            assert.ok(Math.abs(r.movedInLast5s) < 5, `still moving: ${r.movedInLast5s.toFixed(1)} m in 5 s`);
            assert.ok(r.z < 2500, `slid too far: ${r.z.toFixed(0)} m`);
        });
    }

    it('a clean belly landing is no damage at all: full health, nothing to bend or tear', () => {
        const events: number[] = [];
        for (const model of ['fm2', 'fm3'] as const) {
            const r = land(model, 4, 70, 40);
            assert.equal(r.crashed, false);
            assert.equal(r.health, 100, `${model} lost health: ${r.health}`);
            events.push(r.health);
        }
        assert.equal(events.length, 2);
    });

    it('a rougher belly landing is damage, not the end', () => {
        const r = land('fm2', 9, 70, 25);
        assert.equal(r.crashed, false);
        assert.ok(r.health < 99);
    });

    it('a steep gear-up impact is fatal', () => {
        assert.equal(land('fm2', 18, 70, 10).crashed, true);
    });
});

/** A box fuselage, 2 x 2 x 14 m, as a baked collision mesh in the body frame (nose at +Z). */
function boxMesh() {
    const tris: number[] = [];
    const hx = 1, hy = 1, hz = 7;
    const v = (x: number, y: number, z: number) => [x * hx, y * hy, z * hz];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
    quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1));
    quad(v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1));
    quad(v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1));
    quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1));
    quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1));
    quad(v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1));
    return { triangles: tris, aabb: { min: [-1, -1, -7] as [number, number, number], max: [1, 1, 7] as [number, number, number] } };
}

describe('rigid body on the ground', () => {
    /** Stand the box aircraft on one end (+pitch: nose down, - nose up) with that end just touching the ground. */
    function stand(model: SimFlightModelKind, pitchRad: number, seconds: number) {
        const sim = new CombatSim();
        sim.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 5000, halfWidth: 200,
        }], [], [], []));
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitchRad);
        const a = Math.abs(pitchRad);
        sim.addAircraft({
            id: 'player', faction: Faction.PLAYER, control: 'external', model, aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100, collision: boxMesh(),
            spawn: {
                position: [0, 7 * Math.sin(a) + 1.0 * Math.cos(a) + 0.1, 0],
                quaternion: [q.x, q.y, q.z, q.w], velocity: [0, 0, 0],
                landed: false, throttle: 0, airborne: true,
            },
            enabled: true,
        });
        const body = () => (sim as unknown as {
            aircraft: Map<string, { model: { quaternion: THREE.Quaternion; position: THREE.Vector3; isCrashed(): boolean } }>;
        }).aircraft.get('player')!.model;
        const noseY = () => new THREE.Vector3(0, 0, 1).applyQuaternion(body().quaternion).y;
        const before = noseY();
        for (let i = 0; i < seconds * 60; i++) {
            sim.step(1 / 60, { player: GEAR_UP });
        }
        return { before, after: noseY(), crashed: body().isCrashed(), y: body().position.y };
    }

    for (const model of ['fm2', 'fm3'] as const) {
        it(`${model}: standing on its tail, nose up, it tips over onto its belly instead of standing there`, () => {
            const r = stand(model, -50 * Math.PI / 180, 10);
            assert.ok(r.before > 0.7, 'it starts well nose-up');
            assert.ok(Math.abs(r.after) < 0.25, `still tilted: ${r.after.toFixed(2)}`);
            assert.ok(r.y < 3.5, `not resting on the ground: y ${r.y.toFixed(1)}`);
        });

        it(`${model}: standing on its nose it falls over too`, () => {
            const r = stand(model, 70 * Math.PI / 180, 12);
            assert.ok(r.before < -0.7, 'it starts well nose-down');
            assert.ok(Math.abs(r.after) < 0.3, `still on its nose: ${r.after.toFixed(2)}`);
        });
    }
});

describe('sparks and dust on a sliding belly', () => {
    it('a belly sliding along the ground reports its rubbing contact points, no damage', () => {
        const sim = new CombatSim();
        sim.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 5000, halfWidth: 200,
        }], [], [], []));
        sim.addAircraft({
            id: 'player', faction: Faction.PLAYER, control: 'external', model: 'fm2', aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100, collision: boxMesh(),
            spawn: {
                position: [0, 1.15, -300], quaternion: [0, 0, 0, 1], velocity: [0, 0, 60],
                landed: false, throttle: 0, airborne: true,
            },
            enabled: true,
        });
        let slides = 0;
        let other = 0;
        for (let i = 0; i < 6 * 60; i++) {
            sim.step(1 / 60, { player: GEAR_UP });
            for (const h of sim.encodeSnapshotInto(undefined, undefined).hits) {
                if (h.slide) {
                    slides++;
                    assert.equal(h.damage, 0);
                    assert.equal(h.impactSpeed, undefined);
                    assert.ok(h.position[1] < 1, `contact point not at the ground: ${h.position[1]}`);
                } else {
                    other++;
                }
            }
        }
        assert.ok(slides > 20, `too few sliding contacts: ${slides}`);
        assert.equal(other, 0);
    });
});

describe('damage grows linearly with the sink rate', () => {
    /** Health lost touching down on its belly at this sink rate (the box aircraft, mesh and all). */
    function healthLost(sink: number): { lost: number; crashed: boolean } {
        const sim = new CombatSim();
        sim.setWorld(serializeWorld([], [], [{
            center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 5000, halfWidth: 200,
        }], [], [], []));
        sim.addAircraft({
            id: 'player', faction: Faction.PLAYER, control: 'external', model: 'fm2', aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100, collision: boxMesh(),
            spawn: {
                position: [0, 1.0 + 0.05 + 0.2, 0], quaternion: [0, 0, 0, 1], velocity: [0, -sink, 60],
                landed: false, throttle: 0, airborne: true,
            },
            enabled: true,
        });
        let health = 100;
        let crashed = false;
        for (let i = 0; i < 4 * 60 && !crashed; i++) {
            sim.step(1 / 60, { player: GEAR_UP });
            const r = sim.encodeSnapshotInto(undefined, undefined).aircraft.subarray(0, AC_STRIDE);
            health = r[AC.health];
            crashed = r[AC.crashed] !== 0;
        }
        return { lost: 100 - health, crashed };
    }

    it('is none up to the clean limit, then rises steadily to the airframe destroyed at the fatal one', () => {
        assert.equal(healthLost(5).lost, 0);
        const sinks = [7, 8, 9, 10];
        const lost = sinks.map(s => healthLost(s).lost);
        for (let i = 1; i < lost.length; i++) {
            assert.ok(lost[i] > lost[i - 1], `not rising: ${lost.join(', ')}`);
        }
        // Linear: the steps between neighbouring sink rates are about equal.
        const steps = lost.slice(1).map((v, i) => v - lost[i]);
        const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
        for (const st of steps) {
            assert.ok(Math.abs(st - mean) < 0.35 * mean, `steps ${steps.join(', ')}`);
        }
        assert.equal(healthLost(12).crashed, true);
    });
});
