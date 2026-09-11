import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GROUND_SAMPLE_ZOOM, GroundMeans, groundColorAt } from './groundColor';

const SPAN = 180 / (1 << GROUND_SAMPLE_ZOOM);
/** Lon/lat of a point `fx`, `fy` cells into the lattice (0.5 = a cell centre). */
const at = (fx: number, fy: number) => ({ lon: -180 + fx * SPAN, lat: 90 - fy * SPAN });

describe('groundColorAt', () => {
    const means: GroundMeans = {
        '100/50': [100, 100, 100],
        '101/50': [200, 100, 0],
        '100/51': [100, 200, 100],
        '101/51': [200, 200, 0],
    };

    it('returns a cell mean exactly at that cell centre', () => {
        const p = at(100.5, 50.5);
        assert.deepEqual(groundColorAt(means, p.lon, p.lat), [100, 100, 100]);
    });

    it('blends halfway between two centres, so a tile edge has no step', () => {
        const p = at(101, 50.5);
        assert.deepEqual(groundColorAt(means, p.lon, p.lat), [150, 100, 50]);
    });

    it('is continuous across a cell boundary', () => {
        const eps = 1e-6;
        const left = at(101 - eps, 50.8);
        const right = at(101 + eps, 50.8);
        const a = groundColorAt(means, left.lon, left.lat)!;
        const b = groundColorAt(means, right.lon, right.lat)!;
        for (let i = 0; i < 3; i++) {
            assert.ok(Math.abs(a[i] - b[i]) <= 1, `channel ${i}: ${a[i]} vs ${b[i]}`);
        }
    });

    it('drops a missing cell and renormalises over the rest', () => {
        const sparse: GroundMeans = { '100/50': [100, 100, 100] };
        const p = at(101, 51);
        assert.deepEqual(groundColorAt(sparse, p.lon, p.lat), [100, 100, 100]);
    });

    it('returns undefined with nothing nearby', () => {
        const p = at(10.5, 10.5);
        assert.equal(groundColorAt(means, p.lon, p.lat), undefined);
    });
});
