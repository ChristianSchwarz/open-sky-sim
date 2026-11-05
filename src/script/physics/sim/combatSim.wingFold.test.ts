import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { WING_FOLD_KEY } from '../../input/keyboardLayouts';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { serializeWorld } from './serializedWorld';
import { AC, AC_STRIDE } from './simSnapshotCodec';

/** The R key folds a carrier aircraft's wings: parked only, and they spread again for takeoff. */

function sim(airborne: boolean): CombatSim {
    const s = new CombatSim();
    s.setWorld(serializeWorld([], [], [{
        center: new THREE.Vector3(0, 0, 0), heading: 0, halfLength: 5000, halfWidth: 200,
    }], [], [], []));
    s.addAircraft({
        id: 'player', faction: Faction.PLAYER, control: 'external', model: 'fm2', aircraftConfig: defaultFm2Config,
        hitRadius: 10, maxHealth: 100,
        spawn: airborne
            ? { position: [0, 1500, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 150], landed: false, throttle: 0.8, airborne: true }
            : { position: [0, 2.5, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], landed: true, throttle: 0, airborne: false },
        enabled: true,
    });
    return s;
}

function run(s: CombatSim, seconds: number): void {
    for (let i = 0; i < seconds * 60; i++) {
        s.step(1 / 60, {});
    }
}

function folded(s: CombatSim): boolean {
    const snap = s.encodeSnapshotInto(undefined, undefined);
    const k = snap.ids.indexOf('player');
    return snap.aircraft.subarray(k * AC_STRIDE, (k + 1) * AC_STRIDE)[AC.wingsFolded] !== 0;
}

function press(s: CombatSim, key: string): void {
    s.keyDown('player', key, false);
    s.keyUp('player', key);
}

describe('wing fold (R)', () => {
    it('folds parked on the ground and spreads on a second press', () => {
        const s = sim(false);
        run(s, 1);
        assert.equal(folded(s), false);
        press(s, WING_FOLD_KEY);
        run(s, 0.1);
        assert.equal(folded(s), true);
        press(s, WING_FOLD_KEY);
        run(s, 0.1);
        assert.equal(folded(s), false);
    });

    it('will not fold in the air', () => {
        const s = sim(true);
        run(s, 0.5);
        press(s, WING_FOLD_KEY);
        run(s, 0.1);
        assert.equal(folded(s), false);
    });

    it('spreads by itself on takeoff power', () => {
        const s = sim(false);
        run(s, 1);
        press(s, WING_FOLD_KEY);
        run(s, 0.1);
        assert.equal(folded(s), true);
        s.syncEffectiveThrottle('player', 1);
        run(s, 0.1);
        assert.equal(folded(s), false);
    });
});
