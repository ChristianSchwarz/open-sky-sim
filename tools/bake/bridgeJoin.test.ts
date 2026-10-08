import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildJoinMesh, findJoins, openJoinedSides } from './bridgeJoin';
import { IDENTITY_FRAME, buildBridgeMesh } from './bridgeMesh';
import { BridgePlan } from './bridges';

/** A straight deck along x from x0 to x1 at z, its top at `top` over ground at 90. */
function deck(z: number, top: number, width = 8, x0 = 0, x1 = 80, alongZ = false): BridgePlan {
    const stations = [];
    for (let s = 0; s <= x1 - x0; s += 8) {
        stations.push({ s, x: alongZ ? z : x0 + s, z: alongZ ? x0 + s : z, groundY: 90, deckY: top, inWater: false });
    }
    return {
        structure: 'beam', deckWidthM: width, deckThicknessM: 1.2, stations, piers: [], lengthM: x1 - x0,
        abutmentLiftM: [0, 0], buried: 0,
    };
}

/** Parapet triangles: concrete faces above the deck top. */
function parapetHeightAt(plan: BridgePlan, z: number): number {
    const m = buildBridgeMesh(plan, IDENTITY_FRAME);
    let n = 0;
    for (let v = 0; v < m.vertexCount; v++) {
        if (m.positions[v * 3 + 1] > plan.stations[0].deckY + 0.5 && Math.abs(m.positions[v * 3 + 2] - z) < 0.5) {
            n++;
        }
    }
    return n;
}

describe('bridgeJoin', () => {
    it('joins two decks side by side: the facing parapets go, a slab closes the gap', () => {
        const plans = [deck(0, 100), deck(11, 100.4)];
        const joins = findJoins(plans);
        assert.equal(joins.length, 1);
        openJoinedSides(plans, joins);
        // a's left (+z) side and b's right face each other.
        assert.equal(parapetHeightAt(plans[0], 4), 0, 'no parapet on a facing b');
        assert.ok(parapetHeightAt(plans[0], -4) > 0, 'a keeps its outer parapet');
        assert.equal(parapetHeightAt(plans[1], 7), 0, 'no parapet on b facing a');
        const slab = buildJoinMesh(plans, joins[0], IDENTITY_FRAME);
        assert.ok(slab.triangleCount > 0);
        // The slab fills z 4..7, its top between the two decks' heights.
        let lo = Infinity, hi = -Infinity, top = -Infinity;
        for (let v = 0; v < slab.vertexCount; v++) {
            lo = Math.min(lo, slab.positions[v * 3 + 2]);
            hi = Math.max(hi, slab.positions[v * 3 + 2]);
            top = Math.max(top, slab.positions[v * 3 + 1]);
        }
        assert.ok(Math.abs(lo - 4) < 0.01 && Math.abs(hi - 7) < 0.01, `slab from z ${lo} to ${hi}`);
        assert.ok(top <= 100.4 + 1e-3, `slab top ${top}`);
    });

    it('leaves decks apart that are far apart, one over the other, or crossing', () => {
        assert.equal(findJoins([deck(0, 100), deck(20, 100)]).length, 0, '12 m between edges');
        assert.equal(findJoins([deck(0, 100), deck(10, 106)]).length, 0, '6 m apart in height');
        assert.equal(findJoins([deck(0, 100), deck(40, 100, 8, -40, 40, true)]).length, 0, 'crossing');
    });

    it('joins only the stretch they run side by side', () => {
        const plans = [deck(0, 100, 8, 0, 160), deck(10, 100, 8, 80, 160)];
        const joins = findJoins(plans);
        assert.equal(joins.length, 1);
        openJoinedSides(plans, joins);
        const open = plans[0].openSides![0];
        assert.ok(open.s0 >= 72 && open.s1 >= 152, `a open from ${open.s0} to ${open.s1}`);
    });

    it('joins decks on two levels, the higher keeping its parapet over the drop', () => {
        const plans = [deck(0, 100), deck(11, 103)];
        const joins = findJoins(plans);
        assert.equal(joins.length, 1);
        openJoinedSides(plans, joins);
        assert.equal(parapetHeightAt(plans[0], 4), 0, 'the lower deck opens to the join');
        assert.equal(plans[1].openSides, undefined, 'the higher keeps its parapet');
    });
});
