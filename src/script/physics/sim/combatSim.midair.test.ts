import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { SimControlInputs, SimFlightModelKind } from './simTypes';
import { AC, AC_STRIDE } from './simSnapshotCodec';

/** Mid-air collisions between two aircraft. */

const INPUT: SimControlInputs = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0.5, landingGearDeployed: false, flapsExtended: false,
    airbrakesExtended: false, hookDeployed: false, wheelBrakesApplied: false, pitchLimiterMode: 0,
    limitersEnabled: true, wantForceVectors: false, firing: false,
};

/** A box fuselage, 2 x 2 x 14 m, as a baked collision mesh in the body frame (nose at +Z). */
function boxMesh() {
    const tris: number[] = [];
    const v = (x: number, y: number, z: number) => [x, y, z * 7];
    const quad = (a: number[], b: number[], c: number[], d: number[]) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
    quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1));
    quad(v(-1, 1, -1), v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1));
    quad(v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1), v(1, -1, -1));
    quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1));
    quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1));
    quad(v(1, -1, -1), v(1, 1, -1), v(1, 1, 1), v(1, -1, 1));
    return { triangles: tris, aabb: { min: [-1, -1, -7] as [number, number, number], max: [1, 1, 7] as [number, number, number] } };
}

interface Plane {
    x: number;
    z: number;
    speed: number;
    /** Heading: 0 = +Z, PI = -Z. */
    heading: number;
}

function meet(a: Plane, b: Plane, seconds: number, model: SimFlightModelKind = 'fm2') {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 1000, halfWidth: 30,
    }], [], [], []));
    const add = (id: string, p: Plane) => {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.heading);
        const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(p.speed);
        sim.addAircraft({
            id, faction: Faction.PLAYER, control: 'external', model, aircraftConfig: defaultFm2Config,
            hitRadius: 10, maxHealth: 100, collision: boxMesh(),
            spawn: {
                position: [p.x, 3000, p.z], quaternion: [q.x, q.y, q.z, q.w], velocity: [dir.x, dir.y, dir.z],
                landed: false, throttle: 0.5, airborne: true,
            },
            enabled: true,
        });
    };
    add('a', a);
    add('b', b);
    let hits = 0;
    const out = { a: { health: 100, crashed: false }, b: { health: 100, crashed: false } };
    for (let i = 0; i < seconds * 60; i++) {
        sim.step(1 / 60, { a: INPUT, b: INPUT });
        const snap = sim.encodeSnapshotInto(undefined, undefined);
        hits += snap.hits.filter(h => h.severity !== undefined).length;
        for (const id of ['a', 'b'] as const) {
            const k = snap.ids.indexOf(id);
            const r = snap.aircraft.subarray(k * AC_STRIDE, (k + 1) * AC_STRIDE);
            out[id] = { health: r[AC.health], crashed: r[AC.crashed] !== 0 };
        }
    }
    return { ...out, hits };
}

describe('mid-air collisions', () => {
    it('two aircraft passing well clear of each other do not touch', () => {
        const r = meet(
            { x: 0, z: -200, speed: 100, heading: 0 }, { x: 60, z: 200, speed: 100, heading: Math.PI }, 5);
        assert.equal(r.a.health, 100);
        assert.equal(r.b.health, 100);
        assert.equal(r.hits, 0);
    });

    it('a head-on at combat speeds destroys both', () => {
        const r = meet(
            { x: 0, z: -150, speed: 120, heading: 0 }, { x: 0, z: 150, speed: 120, heading: Math.PI }, 5);
        assert.equal(r.a.crashed, true);
        assert.equal(r.b.crashed, true);
        assert.ok(r.hits >= 2);
    });

    it('a slower meeting damages both by the speed, less than a head-on', () => {
        const r = meet(
            { x: 0, z: -80, speed: 60, heading: 0 }, { x: 0, z: 80, speed: 60, heading: Math.PI }, 4);
        // Relative speed 120 m/s is fatal; 60 m/s relative (one at 30, one at 30) is not.
        const slow = meet(
            { x: 0, z: -60, speed: 30, heading: 0 }, { x: 0, z: 60, speed: 30, heading: Math.PI }, 4);
        assert.equal(r.a.crashed, true);
        assert.equal(slow.a.crashed, false);
        assert.ok(slow.a.health < 100 && slow.a.health > 0, `health ${slow.a.health}`);
        assert.ok(Math.abs(slow.a.health - slow.b.health) < 1, 'both take the same blow');
    });

    it('a brush at a few m/s is no damage, and they are not left overlapping', () => {
        const r = meet(
            { x: 0, z: -40, speed: 62, heading: 0 }, { x: 0, z: 0, speed: 60, heading: 0 }, 6);
        assert.equal(r.a.health, 100);
        assert.equal(r.b.health, 100);
    });
});
