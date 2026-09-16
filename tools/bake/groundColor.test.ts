import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GROUND_SAMPLE_ZOOM, GroundMeans, MIN_CLASS_NODES, Rgb, cellMeansOf, groundColorAt } from './groundColor';

const SPAN = 180 / (1 << GROUND_SAMPLE_ZOOM);
/** Lon/lat of a point `fx`, `fy` cells into the lattice (0.5 = a cell centre). */
const at = (fx: number, fy: number) => ({ lon: -180 + fx * SPAN, lat: 90 - fy * SPAN });

/** A cell with an all-dry mean and, optionally, per-class means. */
const cell = (all: Rgb, byClass: Record<number, Rgb> = {}) => ({ all, byClass });

describe('groundColorAt', () => {
    const TREE = 1;
    const CROP = 4;
    const means: GroundMeans = {
        '100/50': cell([100, 100, 100], { [TREE]: [10, 50, 10] }),
        '101/50': cell([200, 100, 0], { [TREE]: [30, 70, 30], [CROP]: [200, 180, 80] }),
        '100/51': cell([100, 200, 100], { [TREE]: [10, 50, 10] }),
        '101/51': cell([200, 200, 0], { [TREE]: [30, 70, 30] }),
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
        const sparse: GroundMeans = { '100/50': cell([100, 100, 100]) };
        const p = at(101, 51);
        assert.deepEqual(groundColorAt(sparse, p.lon, p.lat), [100, 100, 100]);
    });

    it('returns undefined with nothing nearby', () => {
        const p = at(10.5, 10.5);
        assert.equal(groundColorAt(means, p.lon, p.lat), undefined);
    });

    it('blends a class across the cells that have it, so a polygon has no tile seam', () => {
        const p = at(101, 50.5);
        assert.deepEqual(groundColorAt(means, p.lon, p.lat, TREE), [20, 60, 20]);
    });

    it('drops the cells without the class and renormalises', () => {
        // Only one of the four cells has any Crop: its mean, wherever the point is.
        const p = at(101, 51);
        assert.deepEqual(groundColorAt(means, p.lon, p.lat, CROP), [200, 180, 80]);
    });

    it('is undefined for a class no nearby cell has, leaving the fallback to the caller', () => {
        const p = at(101, 51);
        assert.equal(groundColorAt(means, p.lon, p.lat, 9), undefined);
    });
});

describe('cellMeansOf', () => {
    const TREE = 1;
    const CROP = 4;
    const WATER = 8;

    it('keeps a class mean only from enough nodes, and leaves water out of everything', () => {
        const n = MIN_CLASS_NODES * 2 + 3;
        const classes = new Uint8Array(n);
        const colors = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
            const cls = i < MIN_CLASS_NODES * 2 ? TREE : i === n - 1 ? WATER : CROP;
            classes[i] = cls;
            const c = cls === TREE ? [10, 50, 10] : cls === CROP ? [200, 180, 80] : [0, 0, 255];
            colors.set(c, i * 3);
        }
        const m = cellMeansOf(classes, colors)!;
        assert.deepEqual(m.byClass[TREE], [10, 50, 10]);
        assert.equal(m.byClass[CROP], undefined, 'two crop nodes are a stray, not a mean');
        assert.equal(m.byClass[WATER], undefined);
        const dry = MIN_CLASS_NODES * 2 + 2;
        assert.ok(Math.abs(m.all[2] - (10 * MIN_CLASS_NODES * 2 + 80 * 2) / dry) < 1e-9, 'all-dry mean excludes water');
    });

    it('is undefined for a cell that is all water', () => {
        assert.equal(cellMeansOf(new Uint8Array([WATER, WATER]), new Uint8Array(6)), undefined);
    });
});
