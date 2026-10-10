import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { SimFlightModelKind } from './simTypes';
import { AC, AC_STRIDE } from './simSnapshotCodec';

/** A belly landing with the real F/A-18C collision mesh (skipped when the imported mod is not in the checkout). */

const DIR = 'tools/mods/imports/';
const FILE = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).find(f => f.includes('a_18c_f_18c_mat') && f.endsWith('.aircraft.json'))
    : undefined;

const INPUT = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, landingGearDeployed: false, flapsExtended: false,
    airbrakesExtended: false, hookDeployed: false, wheelBrakesApplied: false, pitchLimiterMode: 0,
    limitersEnabled: true, wantForceVectors: false, firing: false,
};

function land(model: SimFlightModelKind, sink: number, speed: number, pitchDeg: number) {
    const mesh = JSON.parse(fs.readFileSync(DIR + FILE!, 'utf8')).collisionMesh;
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 6000, halfWidth: 200,
    }], [], [], []));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -pitchDeg * Math.PI / 180);
    sim.addAircraft({
        id: 'p', faction: Faction.PLAYER, control: 'external', model, aircraftConfig: defaultFm2Config,
        hitRadius: 10, maxHealth: 100, collision: mesh,
        spawn: {
            position: [0, 2.6, -400], quaternion: [q.x, q.y, q.z, q.w], velocity: [0, -sink, speed],
            landed: false, throttle: 0, airborne: true,
        },
        enabled: true,
    });
    const body = (sim as unknown as {
        aircraft: Map<string, { model: { velocityVector: THREE.Vector3 } }>;
    }).aircraft.get('p')!.model;
    let crashed = false;
    let health = 100;
    for (let i = 0; i < 40 * 60 && !crashed; i++) {
        sim.step(1 / 60, { p: INPUT });
        const snap = sim.encodeSnapshotInto(undefined, undefined);
        const r = snap.aircraft.subarray(0, AC_STRIDE);
        crashed = r[AC.crashed] !== 0;
        health = r[AC.health];
    }
    return { crashed, health, speed: body.velocityVector.length() };
}

describe('F/A-18C belly landing', { skip: FILE === undefined }, () => {
    for (const model of ['fm2', 'fm3'] as const) {
        it(`${model}: a level gear-up landing slides to a halt and the airframe survives`, () => {
            const r = land(model, 2.5, 70, 8);
            assert.equal(r.crashed, false);
            assert.ok(r.health > 80, `health ${r.health}`);
            assert.ok(r.speed < 1, `still moving at ${r.speed.toFixed(1)} m/s`);
        });
    }

    it('a steep gear-up impact is fatal', () => {
        assert.equal(land('fm2', 25, 70, 8).crashed, true);
    });
});
