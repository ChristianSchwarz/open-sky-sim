import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Faction } from '../../weapons/combatant';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { CombatSim } from './combatSim';
import { SIM_SHARED_MAX_AIRCRAFT } from './simSharedState';
import { AC_STRIDE } from './simSnapshotCodec';

/**
 * The aircraft row budget, proven rather than assumed.
 *
 * `encodeSnapshotInto` builds its id list from `this.order` with no `enabled`
 * filter and throws above the bank size. The throw lands inside the worker's
 * step handler, comes back to the client as `{type:'error'}`, and the sim then
 * stalls with `busy` cleared and nothing published — so in the app the symptom
 * is a frozen world, with no exception anyone sees. That is far too quiet a
 * failure to discover by adding a fourteenth aircraft and flying around, which
 * is why the limit is pinned here instead.
 *
 * Note the bank only exists on the SharedArrayBuffer path, which the dev server
 * enables via COOP/COEP and a plain static host does not. So an over-budget
 * mission fails under `npm start` and passes on a static build — the opposite
 * of the usual direction, and another reason to catch it in a test.
 */

function simWith(count: number): CombatSim {
    const sim = new CombatSim();
    for (let i = 0; i < count; i++) {
        sim.addAircraft({
            id: `ac${i}`,
            faction: Faction.ENEMY,
            control: 'external',
            kinematic: true,
            aircraftConfig: defaultFm2Config,
            hitRadius: 10,
            maxHealth: 100,
            spawn: {
                position: [i * 500, 3000, 0],
                quaternion: [0, 0, 0, 1],
                velocity: [0, 0, 200],
                landed: false,
                throttle: 0.7,
                airborne: true,
            },
            enabled: true,
        });
    }
    return sim;
}

/** A bank the exact size the worker allocates. */
function bank(): Float32Array {
    return new Float32Array(SIM_SHARED_MAX_AIRCRAFT * AC_STRIDE);
}

describe('CombatSim shared-bank aircraft ceiling', () => {
    it(`encodes a full bank of ${SIM_SHARED_MAX_AIRCRAFT} aircraft`, () => {
        const sim = simWith(SIM_SHARED_MAX_AIRCRAFT);
        const snapshot = sim.encodeSnapshotInto(bank(), undefined);
        assert.equal(snapshot.ids.length, SIM_SHARED_MAX_AIRCRAFT);
    });

    it('throws on one aircraft past the bank rather than writing out of range', () => {
        const sim = simWith(SIM_SHARED_MAX_AIRCRAFT + 1);
        assert.throws(
            () => sim.encodeSnapshotInto(bank(), undefined),
            /exceeds shared bank/);
    });

    it('counts disabled aircraft against the bank too', () => {
        // The id list is built with no `enabled` filter, so a pool built
        // disabled at boot still occupies its rows for the whole session. Any
        // budget that assumes otherwise is wrong by however many it pooled.
        const sim = simWith(SIM_SHARED_MAX_AIRCRAFT + 1);
        for (let i = 0; i < SIM_SHARED_MAX_AIRCRAFT + 1; i++) {
            sim.setEnabled(`ac${i}`, false);
        }
        assert.throws(
            () => sim.encodeSnapshotInto(bank(), undefined),
            /exceeds shared bank/);
    });

    it('does not throw when there is no bank, which is the static-host path', () => {
        const sim = simWith(SIM_SHARED_MAX_AIRCRAFT + 1);
        const snapshot = sim.encodeSnapshotInto(undefined, undefined);
        assert.equal(snapshot.ids.length, SIM_SHARED_MAX_AIRCRAFT + 1);
    });
});
