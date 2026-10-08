import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodePfl, encodePfl, landFingerprint } from '../../src/script/terrain/pfl';
import { buildFarLand } from './farLand';

const UP: [number, number, number] = [0, 1, 0];

/**
 * A grid of `n` x `n` cells over `size` metres, two triangles a cell, at
 * height `h(x, z)`: quantScale 0.1, so positions are decimetres.
 */
function grid(n: number, size: number, h: (x: number, z: number) => number, fill = 0) {
    const tris: number[][] = [];
    const step = size / n;
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            const p = (a: number, b: number) => [a * step, h(a * step, b * step), b * step];
            const [a, b, c, d] = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
            tris.push([...a, ...d, ...c], [...a, ...c, ...b]);
        }
    }
    const count = tris.length;
    const positions = new Int16Array(count * 9);
    tris.forEach((t, k) => t.forEach((v, m) => { positions[k * 9 + m] = Math.round(v * 10); }));
    const normals = new Int8Array(count * 12);
    const attrs = new Uint8Array(count * 12);
    for (let c = 0; c < count * 3; c++) {
        normals.set([0, 127, 0, 0], c * 4);
        attrs.set([90, 120, 60, 3], c * 4);
    }
    return { positions, normals, attrs, quantScale: 0.1, fills: new Uint8Array(count).fill(fill) };
}

/** Border slots: every corner on the grid's outer edge. */
function borderSlots(positions: Int16Array, sizeDm: number): Uint32Array {
    const out: number[] = [];
    for (let c = 0; c < positions.length / 3; c++) {
        const x = positions[c * 3], z = positions[c * 3 + 2];
        if (x === 0 || z === 0 || x === sizeDm || z === sizeDm) {
            out.push(c);
        }
    }
    return Uint32Array.from(out);
}

/** Height of the far land's surface under (x, z), metres, or NaN. */
function surfaceAt(positions: Int16Array, q: number, x: number, z: number): number {
    for (let t = 0; t < positions.length; t += 9) {
        const p = (k: number) => [positions[t + k * 3] * q, positions[t + k * 3 + 1] * q, positions[t + k * 3 + 2] * q];
        const [a, b, c] = [p(0), p(1), p(2)];
        const det = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
        const s = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / det;
        const r = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / det;
        if (s >= -1e-6 && r >= -1e-6 && s + r <= 1 + 1e-6) {
            return a[1] + s * (b[1] - a[1]) + r * (c[1] - a[1]);
        }
    }
    return NaN;
}

describe('far land', () => {
    it('reduces flat ground to almost nothing and keeps every border vertex', () => {
        const g = grid(10, 100, () => 5);
        const slots = borderSlots(g.positions, 1000);
        const r = buildFarLand({ ...g, borderSlots: slots, up: UP, toleranceM: 1 });
        assert.ok(r.trianglesOut < r.trianglesIn / 3, `${r.trianglesIn} -> ${r.trianglesOut}`);
        // Every border corner kept maps to a near slot at the same position.
        assert.ok(r.borderMap.length > 0);
        for (let i = 0; i < r.borderMap.length; i += 2) {
            const c = r.borderMap[i], s = r.borderMap[i + 1];
            assert.deepEqual([...r.positions.subarray(c * 3, c * 3 + 3)], [...g.positions.subarray(s * 3, s * 3 + 3)]);
        }
        // The outline of the tile is untouched: its corners and edge midpoints are still there.
        for (const [x, z] of [[0, 0], [1000, 1000], [0, 500], [500, 0]]) {
            let found = false;
            for (let c = 0; c < r.positions.length / 3 && !found; c++) {
                found = r.positions[c * 3] === x && r.positions[c * 3 + 2] === z;
            }
            assert.ok(found, `border vertex ${x},${z} gone`);
        }
    });

    it('never raises ground with a fill over it, and stays within tolerance', () => {
        // A ridge: ground above the chord along it, so dropping it would sink, never raise.
        const h = (x: number) => 10 - Math.abs(x - 50) * 0.05;
        const ground = grid(10, 100, h);
        const fill = grid(10, 100, x => h(x) + 0.38, 1);
        const join = <T extends Int16Array | Int8Array | Uint8Array>(a: T, b: T, C: new (n: number) => T) => {
            const o = new C(a.length + b.length);
            o.set(a);
            o.set(b, a.length);
            return o;
        };
        const input = {
            positions: join(ground.positions, fill.positions, Int16Array),
            normals: join(ground.normals, fill.normals, Int8Array),
            attrs: join(ground.attrs, fill.attrs, Uint8Array),
            quantScale: 0.1,
            fills: join(ground.fills, fill.fills, Uint8Array),
        };
        const r = buildFarLand({ ...input, borderSlots: borderSlots(input.positions, 1000), up: UP, toleranceM: 1 });
        // Split the output back into its layers by height: fills sit 0.38 m up.
        for (let x = 5; x < 100; x += 10) {
            for (let z = 5; z < 100; z += 10) {
                const orig = h(x);
                // Probe both layers: the lowest surface is the ground, the highest the fill.
                const heights: number[] = [];
                for (let t = 0; t < r.positions.length; t += 9) {
                    const one = surfaceAt(r.positions.subarray(t, t + 9), 0.1, x, z);
                    if (!Number.isNaN(one)) {
                        heights.push(one);
                    }
                }
                const lo = Math.min(...heights), hi = Math.max(...heights);
                assert.ok(lo <= orig + 0.03 && lo >= orig - 1.01, `ground ${lo} vs ${orig} at ${x},${z}`);
                assert.ok(hi >= lo, 'fill under ground');
                assert.ok(hi >= orig + 0.38 - 0.26 && hi <= orig + 0.38 + 1.01, `fill ${hi} at ${x},${z}`);
            }
        }
    });

    it('does not raise the land under a stroke', () => {
        // A shallow valley the chord would bridge 0.5 m above the floor - allowed for
        // free ground, but a road runs along the floor.
        const g = grid(8, 80, x => Math.abs(x - 40) * 0.0125);
        const road = new Float32Array([40, 0, 10, 40, 0, 40, 40, 0, 70]);
        const free = buildFarLand({ ...g, borderSlots: borderSlots(g.positions, 800), up: UP, toleranceM: 1 });
        const withRoad = buildFarLand({ ...g, borderSlots: borderSlots(g.positions, 800), up: UP, toleranceM: 1, strokePoints: road });
        // The road can only cost reduction, never add it.
        assert.ok(withRoad.trianglesOut >= free.trianglesOut);
        for (const z of [10, 40, 70]) {
            assert.ok(surfaceAt(withRoad.positions, 0.1, 40, z) <= 0.02 + 1e-6, `land over the road at z ${z}`);
        }
    });

    it('round-trips through PFL1 and fingerprints positions', () => {
        const g = grid(4, 40, () => 1);
        const r = buildFarLand({ ...g, borderSlots: borderSlots(g.positions, 400), up: UP, toleranceM: 1 });
        const tile = {
            id: { z: 12, x: 3, y: 4 }, quantScale: 0.1, nearTriangles: g.positions.length / 9,
            nearFingerprint: landFingerprint(g.positions),
            levels: [{ toleranceM: 1, positions: r.positions, normals: r.normals, attrs: r.attrs, regionSizes: r.regionSizes, borderMap: r.borderMap }],
        };
        const back = decodePfl(encodePfl(tile));
        assert.deepEqual(back.id, tile.id);
        assert.equal(back.nearFingerprint, tile.nearFingerprint);
        assert.deepEqual([...back.levels[0].positions], [...r.positions]);
        assert.deepEqual([...back.levels[0].borderMap], [...r.borderMap]);
        const moved = g.positions.slice();
        moved[4] += 1;
        assert.notEqual(landFingerprint(moved), tile.nearFingerprint);
    });
});
