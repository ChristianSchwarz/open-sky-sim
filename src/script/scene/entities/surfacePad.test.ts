import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SurfacePadCollider, sampleSurfacePadY, sampleSurfacePadYMax } from './surfacePad';

describe('surface pad', () => {
    const pad: SurfacePadCollider = {
        centerX: 100,
        centerZ: -200,
        heading: 0,
        halfLength: 1500,
        halfWidth: 40,
        surfaceY: 51.5,
        baseY: 50,
        feather: 15,
    };

    it('returns the surface top everywhere inside the pad', () => {
        assert.equal(sampleSurfacePadY(100, -200, pad), 51.5);
        assert.equal(sampleSurfacePadY(100 + 40, -200 - 1500, pad), 51.5);
        assert.equal(sampleSurfacePadY(100 - 39, -200 + 1499, pad), 51.5);
    });

    it('ramps down to the base height across the feather skirt', () => {
        const midSkirt = sampleSurfacePadY(100 + 40 + 7.5, -200, pad);
        assert.ok(Math.abs(midSkirt - 50.75) < 1e-6, `expected mid-skirt blend, got ${midSkirt}`);
        const nearEdge = sampleSurfacePadY(100, -200 - 1500 - 14.99, pad);
        assert.ok(nearEdge > 50 && nearEdge < 50.1, 'skirt end approaches baseY');
    });

    it('returns -Infinity outside the footprint plus skirt', () => {
        assert.equal(sampleSurfacePadY(100 + 56, -200, pad), -Infinity);
        assert.equal(sampleSurfacePadY(100, -200 + 1516, pad), -Infinity);
    });

    it('respects the pad heading when rotating into local space', () => {
        const rotated: SurfacePadCollider = { ...pad, centerX: 0, centerZ: 0, heading: Math.PI / 2 };
        // Heading pi/2: pad long axis lies along world X.
        assert.equal(sampleSurfacePadY(1400, 0, rotated), 51.5);
        assert.equal(sampleSurfacePadY(0, 1400, rotated), -Infinity);
    });

    it('sampleSurfacePadYMax picks the highest overlapping pad', () => {
        const low: SurfacePadCollider = { ...pad, surfaceY: 50.5 };
        assert.equal(sampleSurfacePadYMax(100, -200, [low, pad]), 51.5);
        assert.equal(sampleSurfacePadYMax(0, 5000, [low, pad]), -Infinity);
        assert.equal(sampleSurfacePadYMax(0, 0, []), -Infinity);
    });
});

describe('sloping pads', () => {
    // A runway on a 0.8% grade: the terrain under it is cut to that slope, so
    // the gear has to rest on the same slope or it lands on an invisible shelf.
    const SLOPED: SurfacePadCollider = {
        centerX: 0, centerZ: 0, heading: 0,
        halfLength: 1500, halfWidth: 75,
        surfaceY: 100, baseY: 90, feather: 40, slope: 0.008,
    };

    it('rises along the pad axis', () => {
        assert.equal(sampleSurfacePadY(0, 0, SLOPED), 100);
        assert.equal(sampleSurfacePadY(0, 1000, SLOPED), 108);
        assert.equal(sampleSurfacePadY(0, -1000, SLOPED), 92);
    });

    it('is level across the pad', () => {
        assert.equal(sampleSurfacePadY(70, 500, SLOPED), sampleSurfacePadY(-70, 500, SLOPED));
    });

    it('turns the slope with the heading', () => {
        const turned = { ...SLOPED, heading: Math.PI / 2 };
        assert.ok(Math.abs(sampleSurfacePadY(1000, 0, turned) - 92) < 1e-9);
        assert.ok(Math.abs(sampleSurfacePadY(-1000, 0, turned) - 108) < 1e-9);
    });

    it('blends the feather from the height at that point, not the centre', () => {
        // Half way through the skirt at the high end. Blending toward the
        // centre height instead would drop the pavement 4 m at the threshold.
        const y = sampleSurfacePadY(0, 1520, SLOPED);
        const atEdge = 100 + 0.008 * 1520;
        assert.ok(Math.abs(y - (90 + (atEdge - 90) * 0.5)) < 1e-9, `blended to ${y}`);
    });

    it('is unchanged when no slope is given', () => {
        const level = { ...SLOPED, slope: undefined };
        assert.equal(sampleSurfacePadY(0, 1000, level), 100);
    });
});

describe('a building as a pad', () => {
    // An airport building is a box, and a box is an oriented rectangle at a
    // height — so it needs no triangle soup to be solid. A 40 x 60 m hangar
    // 12 m tall, standing on ground at 20 m.
    const HANGAR: SurfacePadCollider = {
        centerX: 0, centerZ: 0, heading: 0,
        halfLength: 30, halfWidth: 20,
        surfaceY: 32, baseY: 20, feather: 0.5,
    };

    it('puts solid ground on the roof', () => {
        assert.equal(sampleSurfacePadY(0, 0, HANGAR), 32);
        assert.equal(sampleSurfacePadY(19, 29, HANGAR), 32);
    });

    it('is not there at all beside it', () => {
        // -Infinity, so the terrain beside a hangar is the terrain.
        assert.equal(sampleSurfacePadY(25, 0, HANGAR), -Infinity);
        assert.equal(sampleSurfacePadY(0, 40, HANGAR), -Infinity);
    });

    it('is what makes it solid from the side', () => {
        // Flying into the wall at 25 m — below the 32 m roof — the ground under
        // the aircraft is suddenly the roof, so it is underground. That is the
        // same test that decides every other crash into terrain.
        const groundUnder = sampleSurfacePadY(0, 0, HANGAR);
        assert.ok(25 < groundUnder, 'an aircraft at 25 m is not inside the hangar');
    });

    it('has a wall, not a ramp', () => {
        // Half a metre of feather: the edge is soft enough not to be a
        // discontinuity and hard enough that nothing taxis up the side.
        const justInside = sampleSurfacePadY(20.2, 0, HANGAR);
        assert.ok(justInside > 20 && justInside < 32,
            `the edge blends to ${justInside}`);
        assert.equal(sampleSurfacePadY(20.6, 0, HANGAR), -Infinity);
    });

    it('loses to nothing it does not cover', () => {
        const runway = { ...HANGAR, centerX: 500, surfaceY: 21, baseY: 20 };
        // Over the runway, the hangar contributes nothing.
        assert.equal(sampleSurfacePadYMax(500, 0, [HANGAR, runway]), 21);
        // Over the hangar, the hangar wins.
        assert.equal(sampleSurfacePadYMax(0, 0, [HANGAR, runway]), 32);
    });
});
