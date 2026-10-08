import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PtrTile, ROAD_SIDE_BIT } from './ptr';
import { ROAD_LOD_TOLERANCES_M, RoadLevels, roadLevelFor, roadLevels } from './roadLod';

const UP: [number, number, number] = [0, 1, 0];
const CLASS = 5;

/**
 * One stroke along x through `points` (metres, quantScale 1): a pair per
 * point, two triangles per segment wound as the bake winds them.
 */
function stroke(points: Array<[number, number, number]>, halfDm: (i: number) => number = () => 40): PtrTile {
    const n = points.length;
    const positions = new Int16Array(n * 2 * 3);
    const directions = new Int8Array(n * 2 * 4);
    const halfWidths = new Uint16Array(n * 2);
    points.forEach(([x, y, z], i) => {
        for (const side of [0, 1]) {
            const v = i * 2 + side;
            positions.set([x, y, z], v * 3);
            directions.set([0, 0, side ? -127 : 127, CLASS | (side ? ROAD_SIDE_BIT : 0)], v * 4);
            halfWidths[v] = halfDm(i);
        }
    });
    const indices: number[] = [];
    for (let i = 0; i + 1 < n; i++) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    return {
        id: { z: 12, x: 0, y: 0 }, quantScale: 1, positions, directions, halfWidths,
        along: new Uint16Array(n * 2), flags: new Uint8Array(n * 2), indices: Uint16Array.from(indices),
    };
}

/** Sign of each triangle's winding seen from above (+y). */
function windings(tile: PtrTile, indices: Uint16Array): number[] {
    const p = tile.positions;
    const out: number[] = [];
    for (let t = 0; t < indices.length; t += 3) {
        const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
        // Banks share a position, so judge by the across direction instead.
        const side = (v: number) => (tile.directions[v * 4 + 3] & ROAD_SIDE_BIT ? -1 : 1);
        const ax = p[a * 3], bx = p[b * 3], cx = p[c * 3];
        out.push(Math.sign((bx - ax) * (side(c) - side(a)) - (cx - ax) * (side(b) - side(a))));
    }
    return out;
}

const line = (n: number, y: (x: number) => number): Array<[number, number, number]> =>
    Array.from({ length: n }, (_, i) => [i * 10, y(i * 10), 0]);

describe('road levels', () => {
    it('joins a straight run on flat ground into one segment, wound as before', () => {
        const tile = stroke(line(21, () => 0));
        const levels = roadLevels(tile, tile.indices, UP);
        assert.equal(levels[0], tile.indices);
        assert.equal(levels[1].length, 6);
        assert.deepEqual(new Set(windings(tile, levels[1])), new Set(windings(tile, tile.indices)));
    });

    it('keeps a crest, where the chord would run under the land', () => {
        const tile = stroke(line(21, x => 50 - Math.abs(x - 100) * 0.5));
        const coarsest = roadLevels(tile, tile.indices, UP).at(-1)!;
        // The crest at x = 100 (point 10) survives, so at least two segments.
        const used = new Set(Array.from(coarsest, v => tile.positions[v * 3]));
        assert.ok(used.has(100), `crest dropped: ${[...used].sort((a, b) => a - b)}`);
    });

    it('drops a valley point only once its level tolerates the lift', () => {
        // The chord over the valley floor runs 1 m above it.
        const tile = stroke(line(3, x => Math.abs(x - 10) * 0.1));
        const levels = roadLevels(tile, tile.indices, UP);
        const tol = (l: number) => ROAD_LOD_TOLERANCES_M[l - 1];
        for (let l = 1; l < levels.length; l++) {
            assert.equal(levels[l].length, tol(l) >= 1 ? 6 : 12, `level ${l}`);
        }
    });

    it('keeps the points either side of a width change', () => {
        // Points 4 and 5 differ in width: runs 0-4, 4-5 and 5-10.
        const tile = stroke(line(11, () => 0), i => (i < 5 ? 40 : 60));
        const coarsest = roadLevels(tile, tile.indices, UP).at(-1)!;
        assert.equal(coarsest.length, 18);
    });

    it('builds a level on demand and serves the finest built one meanwhile', () => {
        const tile = stroke(line(21, () => 0));
        const levels = new RoadLevels(tile, tile.indices, UP);
        assert.equal(levels.get(3), tile.indices);
        assert.ok(!levels.has(3));
        levels.build(3);
        assert.ok(levels.has(3) && !levels.has(2));
        assert.equal(levels.get(3).length, 6);
        assert.equal(levels.get(4), levels.get(3), 'a coarser level not built yet falls back');
        assert.equal(levels.get(2), tile.indices);
    });

    it('picks the coarsest level under half a pixel', () => {
        assert.equal(roadLevelFor(0), 0);
        assert.equal(roadLevelFor(0.49), 0);
        assert.equal(roadLevelFor(0.5), 1);
        assert.equal(roadLevelFor(2), 2);
        assert.equal(roadLevelFor(1e6), ROAD_LOD_TOLERANCES_M.length);
    });
});
