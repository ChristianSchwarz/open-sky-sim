import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    STERN_WAKE_LENGTH_M,
    STERN_WAKE_SEGMENT_COUNT,
    STERN_WAKE_SEGMENT_LENGTH_M,
    sternWakeAlphaAt,
    sternWakeHalfWidthAt,
} from './sternWake';

/** Fraction of pixels a 4x4 Bayer stipple keeps at the given dither opacity. */
function ditherLevels(alpha: number): number {
    let kept = 0;
    for (let v = 0; v < 16; v++) {
        if (alpha + (v / 16 - 0.5) >= 0.5) {
            kept++;
        }
    }
    return kept;
}

describe('sternWake', () => {
    it('covers exactly 2 km', () => {
        assert.equal(STERN_WAKE_LENGTH_M, 2000);
        assert.equal(STERN_WAKE_SEGMENT_COUNT * STERN_WAKE_SEGMENT_LENGTH_M, STERN_WAKE_LENGTH_M);
    });

    it('fades linearly with distance astern', () => {
        const head = sternWakeAlphaAt(0);
        const tail = sternWakeAlphaAt(STERN_WAKE_LENGTH_M);
        assert.ok(head > tail);
        for (let d = 0; d <= STERN_WAKE_LENGTH_M; d += 100) {
            const expected = head + (tail - head) * (d / STERN_WAKE_LENGTH_M);
            assert.ok(Math.abs(sternWakeAlphaAt(d) - expected) < 1e-9, `alpha at ${d} m`);
        }
    });

    it('stays visible over the whole 2 km', () => {
        // A ramp to alpha 0 would keep no pixels well before the far end; every
        // segment mid must still light at least one Bayer level.
        for (let i = 0; i < STERN_WAKE_SEGMENT_COUNT; i++) {
            const mid = (i + 0.5) * STERN_WAKE_SEGMENT_LENGTH_M;
            assert.ok(ditherLevels(sternWakeAlphaAt(mid)) >= 1, `segment ${i} renders nothing`);
        }
    });

    it('clamps outside the trail', () => {
        assert.equal(sternWakeAlphaAt(-10), sternWakeAlphaAt(0));
        assert.equal(sternWakeAlphaAt(STERN_WAKE_LENGTH_M * 2), sternWakeAlphaAt(STERN_WAKE_LENGTH_M));
        assert.equal(sternWakeHalfWidthAt(-10), sternWakeHalfWidthAt(0));
    });

    it('fans out astern', () => {
        const stern = sternWakeHalfWidthAt(0);
        const tail = sternWakeHalfWidthAt(STERN_WAKE_LENGTH_M);
        assert.ok(tail > stern);
        assert.ok(sternWakeHalfWidthAt(STERN_WAKE_LENGTH_M * 0.5) > sternWakeHalfWidthAt(0));
        // Spread stays inside the Kelvin envelope (19.47 deg half-angle).
        const halfAngleDeg = Math.atan2(tail - stern, STERN_WAKE_LENGTH_M) * 180 / Math.PI;
        assert.ok(halfAngleDeg < 19.47, `spread ${halfAngleDeg} deg`);
    });
});
