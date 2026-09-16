import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { SimAircraftSpawn, SimFlightModelKind } from './simTypes';
import { AC, AC_STRIDE } from './simSnapshotCodec';

/** The player's physics is picked per aircraft, and FM3 flies inside the combat sim like FM2. */

function simWith(model: SimFlightModelKind, spawn: SimAircraftSpawn): CombatSim {
    const sim = new CombatSim();
    sim.addAircraft({
        id: 'player',
        faction: Faction.PLAYER,
        control: 'external',
        model,
        aircraftConfig: defaultFm2Config,
        hitRadius: 10,
        maxHealth: 100,
        spawn,
        enabled: true,
    });
    return sim;
}

const AIRBORNE: SimAircraftSpawn = {
    position: [0, 3000, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 200],
    landed: false,
    throttle: 0.8,
    airborne: true,
};

function row(sim: CombatSim): Float32Array {
    const snapshot = sim.encodeSnapshotInto(undefined, undefined);
    const i = snapshot.ids.indexOf('player');
    assert.ok(i >= 0, 'player missing from the snapshot');
    return snapshot.aircraft.subarray(i * AC_STRIDE, (i + 1) * AC_STRIDE);
}

function fly(sim: CombatSim, seconds: number): void {
    for (let i = 0; i < seconds * 60; i++) sim.step(1 / 60, {});
}

describe('CombatSim with FM3', () => {
    it('flies an airborne FM3 player', () => {
        const sim = simWith('fm3', AIRBORNE);
        fly(sim, 5);
        const r = row(sim);
        for (let k = 0; k < 10; k++) assert.ok(Number.isFinite(r[k]), `row value ${k} went non-finite`);
        assert.equal(r[AC.crashed], 0);
        assert.ok(Math.abs(r[AC.posY] - 3000) < 400, `altitude ${r[AC.posY].toFixed(0)} m`);
        assert.ok(r[AC.posZ] > 700, `should have flown forward, z ${r[AC.posZ].toFixed(0)} m`);
    });

    it('rests an FM3 player on the ground', () => {
        const rest = fm2GroundRestHeight(defaultFm2Config);
        const sim = simWith('fm3', {
            position: [0, rest, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0],
            landed: true, throttle: 0, airborne: false,
        });
        fly(sim, 4);
        const r = row(sim);
        assert.equal(r[AC.crashed], 0);
        assert.equal(r[AC.landed], 1);
        assert.ok(Math.abs(r[AC.posY] - rest) < 0.4, `height ${r[AC.posY].toFixed(2)} vs rest ${rest}`);
    });

    it('swaps between FM2 and FM3 in flight, keeping the pose', () => {
        const sim = simWith('fm2', AIRBORNE);
        fly(sim, 1);
        const before = row(sim);
        const position = new THREE.Vector3(before[AC.posX], before[AC.posY], before[AC.posZ]);
        const quaternion = new THREE.Quaternion(before[AC.qx], before[AC.qy], before[AC.qz], before[AC.qw]);
        const velocity = new THREE.Vector3(before[AC.velX], before[AC.velY], before[AC.velZ]);

        sim.resetAircraft('player', position, quaternion, velocity, false, 0.8, 'fm3');
        sim.setAircraftConfig('player', defaultFm2Config, 'fm3');
        const swapped = row(sim);
        assert.ok(Math.abs(swapped[AC.posY] - position.y) < 1e-3, 'pose lost across the swap');

        fly(sim, 3);
        const after = row(sim);
        assert.equal(after[AC.crashed], 0);
        assert.ok(Math.abs(after[AC.posY] - position.y) < 400, `altitude ${after[AC.posY].toFixed(0)} m`);

        sim.resetAircraft('player', new THREE.Vector3(after[AC.posX], after[AC.posY], after[AC.posZ]),
            new THREE.Quaternion(after[AC.qx], after[AC.qy], after[AC.qz], after[AC.qw]),
            new THREE.Vector3(after[AC.velX], after[AC.velY], after[AC.velZ]), false, 0.8, 'fm2');
        fly(sim, 2);
        assert.equal(row(sim)[AC.crashed], 0);
    });
});
