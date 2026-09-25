import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FlattenPad, applyFlattenPad, padAxisFromHeading, padAxisTowards, padBlendWeight,
    padGradientFromHeading, padLocal, padReachM, padSurfaceHeight,
} from './flattenPad';

/** The pad the Canaries airbase has always used: 1000 x 4000 m, due north. */
const NORTH: FlattenPad = {
    centerX: 0, centerZ: 0, halfW: 500, halfD: 2000, featherM: 80, heightMsl: 41.7,
};

function turned(headingDeg: number, extra: Partial<FlattenPad> = {}): FlattenPad {
    const axis = padAxisFromHeading(headingDeg);
    return { ...NORTH, axisE: axis.e, axisN: axis.n, ...extra };
}

describe('flatten pad', () => {

    describe('the axis-aligned level pad is unchanged', () => {
        // A pad with no axis and no gradient is every pad baked before pads
        // could turn. These numbers are the old implementation's, so a
        // regression here is a re-bake of every area that already exists.

        it('is fully inside the core', () => {
            assert.equal(padBlendWeight(0, 0, NORTH), 1);
            assert.equal(padBlendWeight(419, 1919, NORTH), 1);
        });

        it('is zero outside the footprint', () => {
            assert.equal(padBlendWeight(500, 0, NORTH), 0);
            assert.equal(padBlendWeight(0, 2000, NORTH), 0);
            assert.equal(padBlendWeight(-1000, 0, NORTH), 0);
        });

        it('smoothsteps across the feather', () => {
            // Half way through the 80 m feather on the east edge.
            assert.equal(padBlendWeight(460, 0, NORTH), 0.5);
            assert.equal(padBlendWeight(0, 1960, NORTH), 0.5);
        });

        it('holds the ground at one height', () => {
            assert.equal(applyFlattenPad(12, 0, 0, NORTH), 41.7);
            assert.equal(applyFlattenPad(12, 0, 1500, NORTH), 41.7);
        });

        it('leaves ground outside it alone', () => {
            assert.equal(applyFlattenPad(12, 5000, 0, NORTH), 12);
        });
    });

    describe('orientation', () => {

        it('reads a compass bearing as an ENU direction', () => {
            const north = padAxisFromHeading(0);
            assert.ok(Math.abs(north.e) < 1e-12);
            assert.equal(north.n, 1);
            const east = padAxisFromHeading(90);
            assert.equal(east.e, 1);
            assert.ok(Math.abs(east.n) < 1e-12);
            const south = padAxisFromHeading(180);
            assert.ok(Math.abs(south.e) < 1e-12);
            assert.equal(south.n, -1);
        });

        it('measures along and across the runway, not east and north', () => {
            const pad = turned(90);
            const at = padLocal(1500, 0, pad);
            assert.ok(Math.abs(at.along - 1500) < 1e-9, `along ${at.along}`);
            assert.ok(Math.abs(at.across) < 1e-9, `across ${at.across}`);
        });

        it('puts across on the right-hand side of the runway', () => {
            // Facing 000, the point 100 m east is 100 m to the right.
            const at = padLocal(100, 0, turned(0));
            assert.ok(Math.abs(at.across - 100) < 1e-9);
        });

        it('turns the footprint with the axis', () => {
            const pad = turned(90);
            // 1900 m east is inside the length; 1900 m north is well outside
            // the width. The unturned pad says exactly the opposite.
            assert.equal(padBlendWeight(1900, 0, pad), 1);
            assert.equal(padBlendWeight(0, 1900, pad), 0);
            assert.equal(padBlendWeight(1900, 0, NORTH), 0);
            assert.equal(padBlendWeight(0, 1900, NORTH), 1);
        });

        it('feathers the same however it is turned', () => {
            for (const heading of [0, 32, 90, 187, 341]) {
                const pad = turned(heading);
                const axis = padAxisFromHeading(heading);
                // 460 m out across the axis: half way through the feather.
                const e = axis.n * 460;
                const n = -axis.e * 460;
                assert.ok(Math.abs(padBlendWeight(e, n, pad) - 0.5) < 1e-9,
                    `heading ${heading} gave ${padBlendWeight(e, n, pad)}`);
            }
        });

        it('falls back to north rather than collapsing on a degenerate axis', () => {
            // A zero axis would make every point local (0,0) — inside the core
            // — and flatten the whole neighbourhood to the pad height.
            const axis = padAxisTowards(10, 20, 10, 20);
            assert.deepEqual(axis, { e: 0, n: 1 });
        });

        it('derives an axis from a point ahead of the pad', () => {
            const axis = padAxisTowards(1000, 1000, 1000 + 300, 1000 + 400);
            assert.ok(Math.abs(axis.e - 0.6) < 1e-9);
            assert.ok(Math.abs(axis.n - 0.8) < 1e-9);
        });
    });

    describe('gradient', () => {

        function sloping(footprintDeg: number, gradient: number, riseDeg: number) {
            const g = padGradientFromHeading(gradient, riseDeg);
            return { ...turned(footprintDeg), gradE: g.e, gradN: g.n };
        }

        it('rises along the direction it was given', () => {
            const pad = sloping(0, 0.008, 0);
            assert.ok(Math.abs(padSurfaceHeight(0, 1000, pad) - (41.7 + 8)) < 1e-9);
            assert.ok(Math.abs(padSurfaceHeight(0, -1000, pad) - (41.7 - 8)) < 1e-9);
            // Square to it the plane is level: the transverse camber of a real
            // runway is a third of a metre and well under one DEM post.
            assert.ok(Math.abs(padSurfaceHeight(400, 0, pad) - 41.7) < 1e-9);
        });

        it('slopes the same way whichever way the footprint points', () => {
            // A crossing runway is turned 90 degrees against the platform and
            // still gets cut to the platform's plane, not to its own.
            const along = sloping(0, 0.008, 0);
            const across = sloping(90, 0.008, 0);
            for (const [e, n] of [[0, 1000], [300, -700], [-250, 250]]) {
                assert.ok(Math.abs(padSurfaceHeight(e, n, along)
                    - padSurfaceHeight(e, n, across)) < 1e-9);
            }
        });

        it('blends the ground toward the sloping plane, not the centre height', () => {
            // Inside the core the ground becomes the plane exactly.
            const pad = sloping(0, 0.01, 0);
            assert.ok(Math.abs(applyFlattenPad(5, 0, 1500, pad) - (41.7 + 15)) < 1e-9);
            // Half way through the feather it is half of the way there — from
            // the plane at *that* point, which is what stops a sloping pad
            // stepping down to its centre height at the edges.
            const blended = applyFlattenPad(5, 0, 1960, pad);
            const plane = 41.7 + 19.6;
            assert.ok(Math.abs(blended - (5 + (plane - 5) * 0.5)) < 1e-9,
                `feather blended to ${blended}, wanted ${5 + (plane - 5) * 0.5}`);
        });

        it('is level when absent, which is what an old manifest is', () => {
            assert.equal(padSurfaceHeight(0, 1900, NORTH), 41.7);
        });
    });

    describe('a feather wider than the pad', () => {

        it('still leaves a flat core rather than a ridge', () => {
            // The airports bake sized runway pads at 75 m half-width with an
            // 80 m feather, which is a core of zero: full weight only along the
            // centreline, and the pavement edge half way to the raw DEM.
            const thin: FlattenPad = { ...NORTH, halfW: 75, featherM: 80 };
            assert.equal(padBlendWeight(0, 0, thin), 1);
            assert.equal(padBlendWeight(37, 0, thin), 1, 'the pavement edge is not flat');
            assert.equal(padBlendWeight(80, 0, thin), 0, 'the pad grew past its own edge');
        });
    });

    describe('reach', () => {

        it('contains the pad whichever way it is turned', () => {
            const reach = padReachM(NORTH);
            // The far corner of the feathered rectangle, which is the worst
            // case a rotated pad can present to an axis-aligned reject.
            assert.ok(reach >= Math.hypot(2080, 580) - 1e-9);
            for (const heading of [0, 45, 90, 213]) {
                const pad = turned(heading);
                assert.equal(padBlendWeight(reach + 1, 0, pad), 0);
                assert.equal(padBlendWeight(0, reach + 1, pad), 0);
            }
        });
    });
});
