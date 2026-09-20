import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    BridgeGround, BridgeSpan, CLEARANCE_M, FOOTING_M, PIER_MIN_HEIGHT_M, PIER_SPACING_M, RIDE_CAP_M,
    WATER_FREEBOARD_M, WATER_PIER_DEPTH_M, planBridge,
} from './bridges';

const line = (len: number) => [{ x: 0, z: 0 }, { x: len, z: 0 }];

const flat = (h = 100): BridgeGround => ({ groundY: () => h });

/** A V valley `depth` metres deep, its floor at x = len/2, banks at 100 m. */
const valley = (len: number, depth: number): BridgeGround => ({
    groundY: (x) => 100 - depth * (1 - Math.abs(x - len / 2) / (len / 2)),
});

const span = (structure: BridgeSpan['structure'], len: number, layer = 0): BridgeSpan => ({
    structure, deckWidthM: 12, layer, points: line(len),
});

describe('planBridge', () => {
    it('lies flat on flat ground with no piers', () => {
        const plan = planBridge(span('beam', 200), flat())!;
        assert.equal(plan.buried, 0);
        assert.equal(plan.piers.length, 0);
        assert.deepEqual(plan.abutmentLiftM, [0, 0]);
        assert.ok(Math.abs(plan.lengthM - 200) < 1e-6);
    });

    it('starts at the ground height under its first node and ends at the one under its last', () => {
        // Banks 3.6 m apart, as at the Havel bridge: -22.9 m at the start, -19.3 m at the end.
        const ground: BridgeGround = { groundY: (x) => (x < 1 ? -22.9 : x > 699 ? -19.3 : -25) };
        const plan = planBridge(span('beam', 700), ground)!;
        const st = plan.stations;
        assert.ok(Math.abs(st[0].deckY - -22.9) < 1e-9);
        assert.ok(Math.abs(st[st.length - 1].deckY - -19.3) < 1e-9);
        assert.deepEqual(plan.abutmentLiftM, [0, 0]);
    });

    it('runs between its ends in one straight grade, with no hump over water and no dip', () => {
        const ground: BridgeGround = {
            groundY: (x) => (x < 1 ? -22.9 : x > 699 ? -19.3 : -26),
            waterY: (x) => (x > 200 && x < 500 ? -26 : undefined),
        };
        const plan = planBridge(span('beam', 700), ground)!;
        const st = plan.stations;
        const first = st[0], last = st[st.length - 1];
        for (const p of st) {
            const line = first.deckY + (last.deckY - first.deckY) * (p.s / plan.lengthM);
            assert.ok(Math.abs(p.deckY - line) < 1e-6, `${p.s}: ${p.deckY} vs ${line}`);
        }
    });

    it('rides up over a small mound instead of sinking into it', () => {
        assert.equal(planBridge(span('beam', 400), valley(400, 60))!.buried, 0);
        const mound: BridgeGround = { groundY: (x) => (x > 150 && x < 250 ? 101 : 100) };
        const plan = planBridge(span('beam', 400), mound)!;
        assert.equal(plan.buried, 0);
        assert.ok(plan.stations.some(s => Math.abs(s.deckY - 101) < 1e-9));
    });

    it('passes through a mound taller than the ride cap instead of following it up', () => {
        const hill: BridgeGround = { groundY: (x) => (x > 150 && x < 250 ? 110 : 100) };
        const plan = planBridge(span('beam', 400), hill)!;
        assert.ok(Math.max(...plan.stations.map(s => s.deckY)) <= 100 + RIDE_CAP_M + 1e-9);
        assert.ok(plan.buried > 0);
    });

    it('distrusts an end that reads as a cliff and takes the other end height', () => {
        // A tile-edge skirt read as ground: 150 m below the rest of the span.
        const ground: BridgeGround = { groundY: (x) => (x < 1 ? -160 : -11) };
        const plan = planBridge(span('slab', 18), ground)!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - -11) < 1e-9));
        // Whichever end is bad: the other way round gives the same deck.
        const flipped: BridgeGround = { groundY: (x) => (x > 17 ? -160 : -11) };
        assert.ok(planBridge(span('slab', 18), flipped)!.stations.every(s => Math.abs(s.deckY - -11) < 1e-9));
    });

    it('keeps two end heights a road could join as they are', () => {
        const ground: BridgeGround = { groundY: (x) => (x < 1 ? -22.9 : x > 699 ? -19.3 : -26) };
        const plan = planBridge(span('beam', 700), ground)!;
        assert.ok(Math.abs(plan.stations[0].deckY - -22.9) < 1e-9);
    });

    it('stands piers about every 50 m, evenly, on the ground under them', () => {
        const plan = planBridge(span('beam', 400), valley(400, 60))!;
        // 400 m in 8 bays of 50 m: seven joints, minus any where the deck is on the bank.
        assert.ok(plan.piers.length >= 5);
        const g = valley(400, 60);
        for (let i = 0; i < plan.piers.length; i++) {
            const p = plan.piers[i];
            assert.ok(Math.abs(p.x % PIER_SPACING_M) < 1e-6 || Math.abs((p.x % PIER_SPACING_M) - PIER_SPACING_M) < 1e-6, `${p.x}`);
            assert.ok(Math.abs(p.baseY - (g.groundY(p.x, p.z) - FOOTING_M)) < 1e-6);
            const deck = plan.stations.reduce((a, b) => Math.abs(b.x - p.x) < Math.abs(a.x - p.x) ? b : a).deckY;
            assert.ok(deck - g.groundY(p.x, p.z) >= PIER_MIN_HEIGHT_M - 1e-6);
            assert.ok(p.topY < deck);
        }
    });

    it('splits a long span into whole equal bays near 50 m', () => {
        const plan = planBridge(span('beam', 706), { groundY: (x) => (x > 100 && x < 600 ? 90 : 100) })!;
        const xs = plan.piers.map(p => p.x);
        // 706 m -> 14 bays of 50.43 m, 13 joints; those over the low ground get a pier.
        assert.ok(xs.length >= 9);
        for (let i = 1; i < xs.length; i++) {
            const gap = xs[i] - xs[i - 1];
            assert.ok(Math.abs(gap - 706 / 14) < 1e-6 || Math.abs(gap / (706 / 14) - Math.round(gap / (706 / 14))) < 1e-6, `${gap}`);
        }
    });

    it('gives a span shorter than two bays no pier', () => {
        assert.equal(planBridge(span('beam', 70), valley(70, 30))!.piers.length, 0);
    });

    it('keeps the deck out of the water by the freeboard and no more', () => {
        // Water 2 m above the straight line between two 100 m banks.
        const ground: BridgeGround = {
            groundY: () => 100,
            waterY: (x) => (x > 90 && x < 110 ? 102 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        const over = plan.stations.find(s => s.inWater)!;
        assert.ok(Math.abs(over.deckY - (102 + WATER_FREEBOARD_M)) < 1e-9);
        assert.deepEqual(plan.abutmentLiftM, [0, 0]);
    });

    it('does not lift a deck over water that is below its line', () => {
        const ground: BridgeGround = {
            groundY: () => 100,
            waterY: (x) => (x > 90 && x < 110 ? 96 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - 100) < 1e-9));
    });

    it('clears a road it is told of by the clearance', () => {
        const ground: BridgeGround = {
            groundY: () => 100,
            obstacleY: (x) => (x > 90 && x < 110 ? 100 : undefined),
        };
        const plan = planBridge(span('beam', 200), ground)!;
        assert.ok(Math.max(...plan.stations.map(s => s.deckY)) >= 100 + CLEARANCE_M - 1e-9);
    });

    it('stands piers in the water, down to the river bed', () => {
        // A 100 m channel whose bed is 8 m under the banks, the water 2 m under them.
        const ground: BridgeGround = {
            groundY: (x) => (x > 150 && x < 250 ? 92 : 100),
            waterY: (x) => (x > 150 && x < 250 ? 98 : undefined),
        };
        const inChannel = planBridge(span('beam', 400), ground)!.piers.filter(p => p.x > 150 && p.x < 250);
        assert.ok(inChannel.length >= 1);
        for (const p of inChannel) {
            assert.ok(Math.abs(p.baseY - (92 - FOOTING_M)) < 1e-9);
        }
    });

    it('stands piers in water even when the mesh has no bed under it', () => {
        // Only the water sheet: the "ground" under the lake is its own surface.
        const ground: BridgeGround = {
            groundY: () => 100,
            waterY: (x) => (x > 100 && x < 600 ? 100 : undefined),
        };
        const piers = planBridge(span('beam', 700), ground)!.piers;
        const inLake = piers.filter(p => p.x > 100 && p.x < 600);
        assert.ok(inLake.length >= 8, `${inLake.length}`);
        for (const p of inLake) {
            assert.ok(Math.abs(p.baseY - (100 - WATER_PIER_DEPTH_M - FOOTING_M)) < 1e-9);
        }
        // Dry ground at deck level still gets none.
        assert.ok(piers.every(p => p.x > 100 && p.x < 600));
    });

    it('gives slab, beam, arch and truss spans piers, and hung, floating and tunnel spans none', () => {
        for (const s of ['slab', 'beam', 'arch', 'truss'] as const) {
            assert.ok(planBridge(span(s, 400), valley(400, 60))!.piers.length > 0, s);
        }
        for (const s of ['suspension', 'cable_stayed', 'floating', 'tunnel'] as const) {
            assert.equal(planBridge(span(s, 400), valley(400, 60))!.piers.length, 0, s);
        }
    });

    it('gives a deck on an embankment no pier', () => {
        assert.equal(planBridge(span('beam', 400), flat())!.piers.length, 0);
    });

    it('does not lift a layer-2 span: it adapts to its end heights like any other', () => {
        const plan = planBridge(span('beam', 200, 2), flat())!;
        assert.ok(plan.stations.every(s => Math.abs(s.deckY - 100) < 1e-9));
    });

    it('refuses a one-point span', () => {
        assert.equal(planBridge({ ...span('beam', 10), points: [{ x: 0, z: 0 }] }, flat()), undefined);
    });
});
