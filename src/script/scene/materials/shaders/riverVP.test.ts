import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HighpFlatVertProgram } from './flatVP';
import { RIVER_MAX_STRETCH, RIVER_MIN_HALF_PIXELS, RiverVertProgram } from './riverVP';

/**
 * Source-level checks, in the style of particlesMesh.test.ts: neither tsc nor a
 * headless run can execute a vertex program, but both of the bugs these guard
 * against are visible in the source and neither is visible in a still frame.
 */
describe('river vertex program', () => {
    it('assigns gl_Position straight from a projection', () => {
        // The stroke is widened in view space and projected once. Dividing by
        // the widened corner's own w and rebuilding a clip position around a
        // different w — which is how the whole stroke was given the
        // centreline's depth — breaks the homogeneous coordinate the near-plane
        // clip depends on. A vertex behind the eye then keeps a positive w and
        // lands somewhere arbitrary on screen instead of being clipped, and the
        // stroke flashes across the entire frame, sky included, whenever a
        // river passes under the aircraft.
        const assignments = [...RiverVertProgram.matchAll(/gl_Position\s*=([^;]*);/g)];
        assert.equal(assignments.length, 1, 'gl_Position is assigned more than once');
        assert.match(assignments[0][1].trim(), /^projectionMatrix\s*\*/);
    });

    it('divides by w only where w has been tested', () => {
        // Every perspective divide has to sit inside the guard that checked the
        // vertex is in front of the eye; the pixel measurement is the only
        // place one belongs at all.
        const guard = RiverVertProgram.indexOf('centreClip.w > ');
        assert.ok(guard > 0, 'the w guard is gone');
        const end = RiverVertProgram.indexOf('gl_Position');
        for (const m of RiverVertProgram.matchAll(/\/\s*\w+\.w\b/g)) {
            assert.ok(m.index! > guard && m.index! < end,
                `perspective divide outside the guard: ${m[0]}`);
        }
    });

    it('does not snap the stroke to the resolution grid', () => {
        // Water is built `highp` for the same reason. Snapping both banks of a
        // two-pixel ribbon to the pixel grid independently collapses it on some
        // frames and opens it on others, which reads as the river flickering.
        assert.doesNotMatch(RiverVertProgram, /floor\(/);
        assert.doesNotMatch(HighpFlatVertProgram, /floor\(/);
    });

    it('declares what it binds', () => {
        for (const name of ['riverDir', 'riverHalf']) {
            assert.match(RiverVertProgram, new RegExp(`attribute\\s+\\w+\\s+${name}\\s*;`));
        }
        for (const name of ['uMinHalfPixels', 'uMaxStretch', 'halfWidth', 'halfHeight']) {
            assert.match(RiverVertProgram, new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`));
        }
    });

    it('holds a floor wide enough to survive, and caps the stretch', () => {
        // Two of these across, so under ~0.5 the stroke is a sub-pixel line
        // again and the whole pass buys nothing.
        assert.ok(RIVER_MIN_HALF_PIXELS >= 0.5, `floor ${RIVER_MIN_HALF_PIXELS}`);
        // A cap below 1 would *narrow* a stroke that is already wide enough.
        assert.ok(RIVER_MAX_STRETCH >= 1, `cap ${RIVER_MAX_STRETCH}`);
    });
});
