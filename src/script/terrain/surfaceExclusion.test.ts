import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSurfaceExclusion } from './surfaceExclusion';
import { SurfacePadCollider } from '../scene/entities/surfacePad';

/** A 200 x 40 m pad far from the origin, turned 90 degrees so its long axis runs east. */
const PAD: SurfacePadCollider = {
    centerX: 12000, centerZ: -8000, heading: Math.PI / 2,
    halfLength: 100, halfWidth: 20, surfaceY: 5, baseY: 4, feather: 2,
};

describe('buildSurfaceExclusion', () => {
    it('is undefined with no pads', () => {
        assert.equal(buildSurfaceExclusion([]), undefined);
    });

    it('excludes the pad and its skirt, at its heading, and nothing past it', () => {
        const test = buildSurfaceExclusion([PAD])!;
        assert.equal(test(12000, -8000), true);
        // Along the long axis (east), inside the length but far outside the width.
        assert.equal(test(12090, -8000), true);
        assert.equal(test(12101, -8000), true, 'skirt');
        assert.equal(test(12103, -8000), false);
        // Across it, past the half-width plus skirt.
        assert.equal(test(12000, -8023), false);
        assert.equal(test(0, 0), false);
    });

    it('keeps answering where the pads were when they are later moved in place', () => {
        const pad = { ...PAD };
        const test = buildSurfaceExclusion([pad])!;
        // What a re-base does to the game's own copy.
        pad.centerX -= 20_000;
        pad.centerZ += 5_000;
        assert.equal(test(12000, -8000), true);
        assert.equal(test(-8000, -3000), false);
    });
});
