import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collapse } from './collapse';
import { GridTriangle, decimate } from './decimate';

const SIZE = 33;

function grid(size: number, fn: (x: number, y: number) => number): Float32Array {
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            out[y * size + x] = fn(x, y);
        }
    }
    return out;
}

function area(t: GridTriangle): number {
    const [a, b, c] = t.pts;
    return Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
}

function totalArea(tris: GridTriangle[]): number {
    return tris.reduce((s, t) => s + area(t), 0);
}

/** Decimate with a tight tolerance so a ridge forces a ladder of small leaves. */
function ridgeTile(heights: Float32Array) {
    return decimate({
        size: SIZE,
        heights,
        regionNodes: new Uint16Array(SIZE * SIZE).fill(1),
        maxErrorM: 0.5,
    });
}

describe('coplanar vertex collapse', () => {
    it('removes the balance ladder on a plane beside a ridge', () => {
        // Flat plane with one sharp ridge column: the quadtree keeps the
        // ridge at single cells and ripples half-size leaves out across the
        // plane, none of which the plane needs.
        const heights = grid(SIZE, (x) => (x === 16 ? 50 : 0));
        const before = ridgeTile(heights).triangles;
        const r = collapse({
            triangles: before, size: SIZE, heights, cellM: 30, maxErrorM: 0.5, maxAngleDeg: 2,
        });
        assert.ok(r.collapsed > 0, 'something collapsed');
        assert.ok(r.triangles.length < before.length, `${r.triangles.length} < ${before.length}`);
        assert.ok(Math.abs(totalArea(r.triangles) - 32 * 32) < 1e-6, 'covers the tile exactly');
        // Every node still within tolerance of the mesh: the ridge survives.
        assert.ok(r.triangles.some(t => t.pts.some(p => p.x === 16)), 'ridge vertices kept');
    });

    it('never moves a border or shore vertex', () => {
        const heights = grid(SIZE, () => 0);
        const before = ridgeTile(grid(SIZE, (x) => (x === 16 ? 50 : 0))).triangles;
        // Tag one interior vertex as shore by hand.
        const tagged = before.map(t => ({
            ...t,
            pts: t.pts.map(p => (p.x === 8 && p.y === 8 ? { ...p, shore: true } : p)) as GridTriangle['pts'],
        }));
        const r = collapse({ triangles: tagged, size: SIZE, heights, cellM: 30, maxErrorM: 1000, maxAngleDeg: 10 });
        const borderBefore = new Set<string>();
        for (const t of before) {
            for (const p of t.pts) {
                if (p.x === 0 || p.y === 0 || p.x === 32 || p.y === 32) {
                    borderBefore.add(`${p.x},${p.y}`);
                }
            }
        }
        const borderAfter = new Set<string>();
        let shoreKept = false;
        for (const t of r.triangles) {
            for (const p of t.pts) {
                if (p.x === 0 || p.y === 0 || p.x === 32 || p.y === 32) {
                    borderAfter.add(`${p.x},${p.y}`);
                }
                if (p.x === 8 && p.y === 8 && p.shore) {
                    shoreKept = true;
                }
            }
        }
        assert.deepEqual([...borderAfter].sort(), [...borderBefore].sort());
        assert.ok(shoreKept, 'shore vertex kept');
    });

    it('keeps a smooth hill whose facets agree in angle but not in height', () => {
        // A wide paraboloid: adjacent facets differ by a fraction of a degree,
        // but dropping a crown vertex would put the surface metres off.
        const heights = grid(SIZE, (x, y) => 200 - ((x - 16) ** 2 + (y - 16) ** 2) * 0.3);
        const d = decimate({
            size: SIZE, heights, regionNodes: new Uint16Array(SIZE * SIZE).fill(1), maxErrorM: 0.3,
        });
        const r = collapse({
            triangles: d.triangles, size: SIZE, heights, cellM: 300, maxErrorM: 0.3, maxAngleDeg: 4,
        });
        // Whatever collapsed, every node is still within tolerance.
        let worst = 0;
        for (const t of r.triangles) {
            const [a, b, c] = t.pts;
            const A = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
            const h = (p: { x: number; y: number }) => heights[p.y * SIZE + p.x];
            for (let y = Math.ceil(Math.min(a.y, b.y, c.y)); y <= Math.floor(Math.max(a.y, b.y, c.y)); y++) {
                for (let x = Math.ceil(Math.min(a.x, b.x, c.x)); x <= Math.floor(Math.max(a.x, b.x, c.x)); x++) {
                    const wa = ((b.x - x) * (c.y - y) - (b.y - y) * (c.x - x)) / A;
                    const wb = ((x - a.x) * (c.y - a.y) - (y - a.y) * (c.x - a.x)) / A;
                    const wc = 1 - wa - wb;
                    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
                    const mesh = wa * h(a) + wb * h(b) + wc * h(c);
                    worst = Math.max(worst, Math.abs(mesh - heights[y * SIZE + x]));
                }
            }
        }
        assert.ok(worst <= 0.3 + 1e-6, `worst error ${worst}`);
    });

    it('refuses to merge across a region or cover boundary', () => {
        const heights = grid(SIZE, () => 0);
        const regions = new Uint16Array(SIZE * SIZE);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                regions[y * SIZE + x] = x < 16 ? 1 : 2;
            }
        }
        const d = decimate({ size: SIZE, heights, regionNodes: regions, maxErrorM: 1000 });
        const r = collapse({ triangles: d.triangles, size: SIZE, heights, cellM: 30, maxErrorM: 1000, maxAngleDeg: 10 });
        const area1 = totalArea(r.triangles.filter(t => t.regionId === 1));
        // Nodes 0..15 are region 1, so the cut runs at 15.5.
        assert.ok(Math.abs(area1 - 15.5 * 32) < 1e-6, `region 1 area ${area1}`);
        assert.ok(r.triangles.every(t => t.pts.every(p => t.regionId === 1 ? p.x <= 15.5 : p.x >= 15.5)));
    });
});
