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

    it('never moves a corner or shore vertex, and keeps the border straight', () => {
        const heights = grid(SIZE, () => 0);
        const before = ridgeTile(grid(SIZE, (x) => (x === 16 ? 50 : 0))).triangles;
        // Tag one interior vertex as shore by hand.
        const tagged = before.map(t => ({
            ...t,
            pts: t.pts.map(p => (p.x === 8 && p.y === 8 ? { ...p, shore: true } : p)) as GridTriangle['pts'],
        }));
        const r = collapse({ triangles: tagged, size: SIZE, heights, cellM: 30, maxErrorM: 1000, maxAngleDeg: 10 });
        const onBorder = (p: { x: number; y: number }) => p.x === 0 || p.y === 0 || p.x === 32 || p.y === 32;
        const borderBefore = new Set<string>();
        for (const t of before) {
            for (const p of t.pts) {
                if (onBorder(p)) {
                    borderBefore.add(`${p.x},${p.y}`);
                }
            }
        }
        const borderAfter = new Set<string>();
        let shoreKept = false;
        for (const t of r.triangles) {
            for (const p of t.pts) {
                if (onBorder(p)) {
                    borderAfter.add(`${p.x},${p.y}`);
                }
                if (p.x === 8 && p.y === 8 && p.shore) {
                    shoreKept = true;
                }
            }
            for (const p of t.pts) {
                assert.ok(p.x >= 0 && p.x <= 32 && p.y >= 0 && p.y <= 32, 'vertex inside the tile');
            }
        }
        assert.ok(shoreKept, 'shore vertex kept');
        // The flat plane lets the border go: fewer border vertices, all
        // four corners still there, and the tile still exactly covered.
        assert.ok(borderAfter.size < borderBefore.size, `${borderAfter.size} < ${borderBefore.size}`);
        for (const c of ['0,0', '32,0', '0,32', '32,32']) {
            assert.ok(borderAfter.has(c), `corner ${c} kept`);
        }
        assert.ok(Math.abs(totalArea(r.triangles) - 32 * 32) < 1e-6, 'covers the tile exactly');
    });

    it('keeps a border vertex the border profile needs', () => {
        // A step in the DEM along the west edge: the border vertex at the
        // step is the only thing keeping the edge within tolerance.
        const heights = grid(SIZE, (_x, y) => (y >= 16 ? 40 : 0));
        const before = ridgeTile(heights).triangles;
        const r = collapse({ triangles: before, size: SIZE, heights, cellM: 30, maxErrorM: 0.5, maxAngleDeg: 10 });
        const westBefore = new Set<number>();
        for (const t of before) for (const p of t.pts) if (p.x === 0) westBefore.add(p.y);
        const westAfter = new Set<number>();
        for (const t of r.triangles) for (const p of t.pts) if (p.x === 0) westAfter.add(p.y);
        assert.ok(westAfter.has(15) && westAfter.has(16), 'both sides of the step kept on the west edge');
        assert.ok(westAfter.size < westBefore.size, 'the flat runs either side of the step still collapse');
        assert.ok(Math.abs(totalArea(r.triangles) - 32 * 32) < 1e-6, 'covers the tile exactly');
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

    it('merges a level water sheet up to the shore, but keeps a shore facet inside the band', () => {
        // Region 0 is water on the left half, region 1 land on the right.
        // The water is level at 0 and the land a 100 m cliff, so a bilinear
        // sample at a shore crossing blends the two and every cut facet on
        // the water side reads as tilted. Told the water is flat, the pass
        // merges the sheet right up to the shore vertices, which stay put;
        // a shore facet the class function calls -1 (here: larger than a
        // band's worth of cells) is never produced.
        const heights = grid(SIZE, (x) => (x < 16 ? 0 : 100));
        const regionNodes = new Uint16Array(SIZE * SIZE);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                regionNodes[y * SIZE + x] = x < 16 ? 0 : 1;
            }
        }
        const before = decimate({
            size: SIZE, heights, regionNodes, maxErrorM: 0.5, isLandRegion: id => id === 1,
        }).triangles;
        const isLand = (t: GridTriangle) => t.regionId === 1;
        const water = (ts: GridTriangle[]) => ts.filter(t => !isLand(t));
        const shoreKeys = (ts: GridTriangle[]) =>
            new Set(ts.flatMap(t => t.pts.filter(p => p.shore).map(p => `${p.x},${p.y}`)));
        const BAND = 24;
        const common = { size: SIZE, heights, cellM: 30, maxErrorM: 0.5, maxAngleDeg: 2 };
        const plain = collapse({ ...common, triangles: before });
        const r = collapse({
            ...common,
            triangles: before,
            isLandTriangle: isLand,
            waterClassOf: t => (area(t) > BAND && t.pts.some(p => p.shore) ? -1 : 0),
            isFlatWater: () => true,
            waterPasses: 3,
        });
        assert.ok(shoreKeys(before).size > 0, 'the cut tagged shore vertices');
        assert.ok(
            water(r.triangles).length < water(plain.triangles).length / 2,
            `${water(r.triangles).length} water facets, ${water(plain.triangles).length} without the water rules`,
        );
        assert.ok(Math.abs(totalArea(r.triangles) - 32 * 32) < 1e-6, 'covers the tile exactly');
        assert.deepEqual(shoreKeys(r.triangles), shoreKeys(before), 'every shore vertex kept');
        for (const t of water(r.triangles)) {
            if (t.pts.some(p => p.shore)) {
                assert.ok(area(t) <= BAND, `shore facet of ${area(t)} cells² outgrew the band`);
            }
        }
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
