import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CoastPolygon, LonLatBounds, __testing, buildShoreline } from './shoreline';
import { decimate } from './decimate';
import { regionFieldFromShoreline } from './regions';

const BOUNDS: LonLatBounds = { west: 0, south: 0, east: 1, north: 1 };
const SIZE = 33; // 32 cells

/** Build a polygon from grid-space points, converting back to lon/lat. */
function ringFromGrid(pts: Array<[number, number]>): CoastPolygon {
    const cells = SIZE - 1;
    return {
        exterior: pts.map(([gx, gy]) => ({
            lon: BOUNDS.west + (gx / cells) * (BOUNDS.east - BOUNDS.west),
            lat: BOUNDS.north - (gy / cells) * (BOUNDS.north - BOUNDS.south),
        })),
        holes: [],
    };
}

function countLand(landNodes: Uint8Array): number {
    return landNodes.reduce((n, v) => n + v, 0);
}

describe('Douglas-Peucker simplification', () => {
    it('keeps the endpoints of a polyline', () => {
        const pts = new Float64Array([0, 0, 1, 0.001, 2, 0, 3, 0.002, 4, 0]);
        const keep = __testing.douglasPeucker(pts, 0.01);
        assert.equal(keep[0], 0);
        assert.equal(keep[keep.length - 1], 4);
    });

    it('collapses a nearly straight line to its endpoints', () => {
        const n = 50;
        const pts = new Float64Array(n * 2);
        for (let i = 0; i < n; i++) {
            pts[i * 2] = i;
            pts[i * 2 + 1] = Math.sin(i) * 1e-6;
        }
        assert.deepEqual(__testing.douglasPeucker(pts, 0.01), [0, n - 1]);
    });

    it('keeps a corner that exceeds the tolerance', () => {
        const pts = new Float64Array([0, 0, 5, 5, 10, 0]);
        const keep = __testing.douglasPeucker(pts, 1);
        assert.deepEqual(keep, [0, 1, 2]);
    });

    it('is a no-op at zero tolerance', () => {
        const pts = new Float64Array([0, 0, 1, 1, 2, 0, 3, 3]);
        assert.deepEqual(__testing.douglasPeucker(pts, 0), [0, 1, 2, 3]);
    });

    it('never reduces a ring below a triangle', () => {
        const square = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
        const out = __testing.simplifyRing(square, 1000);
        assert.ok(out.length / 2 >= 3, `got ${out.length / 2} vertices`);
    });

    it('drops redundant collinear ring vertices', () => {
        // A square whose edges are subdivided; simplification should recover
        // roughly the four corners.
        const pts: number[] = [];
        for (let i = 0; i < 10; i++) pts.push(i, 0);
        for (let i = 0; i < 10; i++) pts.push(10, i);
        for (let i = 10; i > 0; i--) pts.push(i, 10);
        for (let i = 10; i > 0; i--) pts.push(0, i);
        const out = __testing.simplifyRing(new Float64Array(pts), 0.5);
        assert.ok(out.length / 2 <= 6, `expected ~4 corners, got ${out.length / 2}`);
        assert.ok(out.length / 2 >= 4);
    });
});

describe('shoreline classification', () => {
    it('marks nodes inside a polygon as land', () => {
        // Square covering grid x,y in [8, 24].
        const poly = ringFromGrid([[8, 8], [24, 8], [24, 24], [8, 24]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        assert.ok(s.mixed);
        assert.equal(s.landNodes[16 * SIZE + 16], 1, 'centre is land');
        assert.equal(s.landNodes[0], 0, 'corner is water');
        // Nodes lying exactly on the ring are decided by the standard
        // half-open scanline rule, which counts a crossing only when the two
        // endpoints straddle the scanline. That includes the northern boundary
        // row and excludes the southern one, so rows 8..23 fill and row 24 does
        // not, while columns 8..24 fill inclusively. The rule has to be
        // half-open or an edge shared by two rings would be counted twice; the
        // exact boundary only matters when a coast lands precisely on a node,
        // and the visible shoreline comes from edgeCrossing regardless.
        assert.equal(countLand(s.landNodes), 16 * 17);
        assert.equal(s.landNodes[8 * SIZE + 16], 1, 'northern boundary row is land');
        assert.equal(s.landNodes[24 * SIZE + 16], 0, 'southern boundary row is not');
    });

    it('reports an all-water tile as unmixed', () => {
        const s = buildShoreline({ polygons: [], bounds: BOUNDS, size: SIZE });
        assert.equal(s.mixed, false);
        assert.equal(countLand(s.landNodes), 0);
    });

    it('subtracts holes from land', () => {
        const cells = SIZE - 1;
        const g = (gx: number, gy: number) => ({
            lon: (gx / cells), lat: 1 - (gy / cells),
        });
        const poly: CoastPolygon = {
            exterior: [g(4, 4), g(28, 4), g(28, 28), g(4, 28)],
            holes: [[g(12, 12), g(20, 12), g(20, 20), g(12, 20)]],
        };
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        assert.equal(s.landNodes[16 * SIZE + 16], 0, 'the lake centre is water');
        assert.equal(s.landNodes[6 * SIZE + 6], 1, 'the surrounding land is land');
    });

    it('samples the block centre for saddle resolution', () => {
        const poly = ringFromGrid([[8, 8], [24, 8], [24, 24], [8, 24]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        assert.equal(s.centreIsLand(12, 12, 4), true);
        assert.equal(s.centreIsLand(0, 0, 2), false);
    });
});

describe('shoreline edge crossings', () => {
    it('places a crossing where the polygon actually cuts the edge', () => {
        // Vertical coast at grid x = 10.25: land to the left.
        const poly = ringFromGrid([[-5, -5], [10.25, -5], [10.25, 40], [-5, 40]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        // Horizontal cell edge from node (10, 5) to (11, 5) is cut at t = 0.25.
        const t = s.edgeCrossing(10, 5, 11, 5);
        assert.ok(t !== undefined, 'crossing recorded');
        assert.ok(Math.abs(t! - 0.25) < 1e-3, `t = ${t}`);
    });

    it('reverses the parameter when the edge is traversed backwards', () => {
        const poly = ringFromGrid([[-5, -5], [10.25, -5], [10.25, 40], [-5, 40]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        const fwd = s.edgeCrossing(10, 5, 11, 5)!;
        const rev = s.edgeCrossing(11, 5, 10, 5)!;
        assert.ok(Math.abs(fwd + rev - 1) < 1e-6, `fwd ${fwd} rev ${rev}`);
    });

    it('records crossings on vertical edges too', () => {
        // Horizontal coast at grid y = 7.5.
        const poly = ringFromGrid([[-5, -5], [40, -5], [40, 7.5], [-5, 7.5]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        const t = s.edgeCrossing(5, 7, 5, 8);
        assert.ok(t !== undefined);
        assert.ok(Math.abs(t! - 0.5) < 1e-3, `t = ${t}`);
    });

    it('returns undefined on an edge the shoreline misses', () => {
        const poly = ringFromGrid([[8, 8], [24, 8], [24, 24], [8, 24]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        assert.equal(s.edgeCrossing(0, 0, 1, 0), undefined);
    });

    it('spans a multi-cell edge, reporting the parameter over the whole span', () => {
        const poly = ringFromGrid([[-5, -5], [10.25, -5], [10.25, 40], [-5, 40]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        // A 4-cell edge from x=8 to x=12 cut at 10.25 -> (10.25-8)/4 = 0.5625.
        const t = s.edgeCrossing(8, 5, 12, 5);
        assert.ok(t !== undefined);
        assert.ok(Math.abs(t! - 0.5625) < 1e-3, `t = ${t}`);
    });
});

describe('shoreline feeding the decimator', () => {
    const flat = new Float32Array(SIZE * SIZE);

    it('produces a watertight mesh for an island', () => {
        const poly = ringFromGrid([[8, 6], [25, 9], [23, 26], [7, 22]]);
        const s = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        const field = regionFieldFromShoreline(s);
        const r = decimate({
            size: SIZE,
            heights: flat,
            regionNodes: field.regionNodes,
            maxErrorM: 1000,
            edgeCrossing: field.edgeCrossing,
            regionAt: field.regionAt,
        });
        const cells = SIZE - 1;
        const total = r.triangles.reduce((acc, t) => {
            const [a, b, c] = t.pts;
            return acc + Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
        }, 0);
        assert.ok(Math.abs(total - cells * cells) < 1e-6, `area ${total}`);
        assert.ok(r.triangles.some(t => t.regionId === 1), 'some land');
        assert.ok(r.triangles.some(t => t.regionId === 0), 'some water');
    });

    it('cuts fewer cells once the ring is simplified', () => {
        // A deliberately wiggly coast.
        const pts: Array<[number, number]> = [];
        for (let i = 0; i <= 32; i++) {
            pts.push([i, 16 + (i % 2 === 0 ? 0.9 : -0.9)]);
        }
        pts.push([32, 40], [0, 40]);
        const poly = ringFromGrid(pts);
        const raw = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        const simplified = buildShoreline({
            polygons: [poly], bounds: BOUNDS, size: SIZE, simplifyCells: 2,
        });
        const run = (s: ReturnType<typeof buildShoreline>) => {
            const field = regionFieldFromShoreline(s);
            return decimate({
                size: SIZE,
                heights: flat,
                regionNodes: field.regionNodes,
                maxErrorM: 1000,
                edgeCrossing: field.edgeCrossing,
                regionAt: field.regionAt,
            });
        };
        const a = run(raw);
        const b = run(simplified);
        assert.ok(
            b.shorelineLeafCount <= a.shorelineLeafCount,
            `simplified ${b.shorelineLeafCount} vs raw ${a.shorelineLeafCount}`,
        );
        const cells = SIZE - 1;
        for (const r of [a, b]) {
            const total = r.triangles.reduce((acc, t) => {
                const [p, q, s2] = t.pts;
                return acc + Math.abs((q.x - p.x) * (s2.y - p.y) - (s2.x - p.x) * (q.y - p.y)) / 2;
            }, 0);
            assert.ok(Math.abs(total - cells * cells) < 1e-6, `area ${total}`);
        }
    });
});

describe('inland water classification', () => {
    /** A rectangle in grid space, as an inland body at the given height. */
    function inlandRect(
        x0: number, y0: number, x1: number, y1: number, surfaceHeightM?: number,
    ) {
        const { exterior } = ringFromGrid([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        return { exterior, holes: [], surfaceHeightM };
    }

    it('marks nodes inside a body, and leaves everything else alone', () => {
        const s = buildShoreline({
            polygons: [],
            inland: [inlandRect(8, 8, 16, 16, 912.5)],
            bounds: BOUNDS,
            size: SIZE,
        });
        const wet = s.inlandNodes.reduce((n, v) => n + v, 0);
        assert.ok(wet > 0, 'no nodes classified as inland water');
        // Interior of the rect is wet; a corner of the tile is not.
        assert.equal(s.inlandNodes[12 * SIZE + 12], 1);
        assert.equal(s.inlandNodes[0], 0);
        assert.equal(s.inlandHeights[12 * SIZE + 12], 912.5);
    });

    it('gives a body with no measured height a NaN surface, not zero', () => {
        // NaN is what tells the mesh bake to follow the terrain. Zero would be
        // sea level, which is the bug this layer exists to fix.
        const s = buildShoreline({
            polygons: [],
            inland: [inlandRect(8, 8, 16, 16)],
            bounds: BOUNDS,
            size: SIZE,
        });
        assert.equal(s.inlandNodes[12 * SIZE + 12], 1);
        assert.ok(Number.isNaN(s.inlandHeights[12 * SIZE + 12]));
    });

    it('keeps two bodies at their own heights instead of merging them', () => {
        const s = buildShoreline({
            polygons: [],
            inland: [inlandRect(2, 2, 10, 10, 100), inlandRect(20, 20, 30, 30, 500)],
            bounds: BOUNDS,
            size: SIZE,
        });
        assert.equal(s.inlandHeights[6 * SIZE + 6], 100);
        assert.equal(s.inlandHeights[25 * SIZE + 25], 500);
    });

    it('reports no inland water when none is supplied', () => {
        const s = buildShoreline({ polygons: [], bounds: BOUNDS, size: SIZE });
        assert.equal(s.inlandNodes.reduce((n, v) => n + v, 0), 0);
    });
});

describe('inland water against a simplified land ring', () => {
    /**
     * A many-sided circle in grid space, as lon/lat.
     *
     * `n` and `phase` exist so the same shore can be produced as two different
     * vertex lists. That is what the real bake hands us: the land ring's hole
     * comes out of a shapely difference and the body's exterior comes straight
     * off OSM, so they describe one boundary with different vertices — and
     * Douglas-Peucker then moves them apart.
     */
    function circle(cx: number, cy: number, r: number, n = 64, phase = 0) {
        const cells = SIZE - 1;
        return Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2 + phase;
            const gx = cx + Math.cos(a) * r;
            const gy = cy + Math.sin(a) * r;
            return {
                lon: BOUNDS.west + (gx / cells) * (BOUNDS.east - BOUNDS.west),
                lat: BOUNDS.north - (gy / cells) * (BOUNDS.north - BOUNDS.south),
            };
        });
    }

    it('leaves no node inside the body unclaimed when the rings are simplified', () => {
        // The regression this guards. A lake's shore reaches buildShoreline
        // twice — as a hole in the land ring and as the body's own exterior.
        // Simplifying both independently moved them apart, and every node in
        // the band between fell through to the open-ocean default and was baked
        // at sea level. On the Colorado that split a 750 m river into segments
        // with 750 m holes between them.
        const lake = circle(16, 16, 8, 64);
        // The same circle, discretised differently — as the two stages do.
        const lakeAsHole = circle(16, 16, 8, 51, 0.03);
        const land: CoastPolygon = {
            exterior: [
                { lon: BOUNDS.west - 1, lat: BOUNDS.north + 1 },
                { lon: BOUNDS.east + 1, lat: BOUNDS.north + 1 },
                { lon: BOUNDS.east + 1, lat: BOUNDS.south - 1 },
                { lon: BOUNDS.west - 1, lat: BOUNDS.south - 1 },
            ],
            holes: [lakeAsHole],
        };
        const s = buildShoreline({
            polygons: [land],
            inland: [{ exterior: lake, holes: [], surfaceHeightM: 800 }],
            bounds: BOUNDS,
            size: SIZE,
            simplifyCells: 2,
        });
        let unclaimed = 0;
        for (let i = 0; i < SIZE * SIZE; i++) {
            if (!s.landNodes[i] && !s.inlandNodes[i]) {
                unclaimed++;
            }
        }
        assert.equal(unclaimed, 0,
            `${unclaimed} nodes are neither land nor inland water; each one bakes at sea level`);
    });

    it('keeps water where a simplified land ring swallowed it', () => {
        // Simplifying a *hole* shrinks it, so bands of a lake get taken back
        // into the land polygon and the tile grows no water there at all. While
        // inland water sat at sea level this hid inside a 750 m slot; at its
        // own height the body reads as chopped into pieces by terrain.
        const lake = circle(16, 16, 8, 64);
        const lakeAsHole = circle(16, 16, 8, 51, 0.03);
        const s = buildShoreline({
            polygons: [{
                exterior: [
                    { lon: BOUNDS.west - 1, lat: BOUNDS.north + 1 },
                    { lon: BOUNDS.east + 1, lat: BOUNDS.north + 1 },
                    { lon: BOUNDS.east + 1, lat: BOUNDS.south - 1 },
                    { lon: BOUNDS.west - 1, lat: BOUNDS.south - 1 },
                ],
                holes: [lakeAsHole],
            }],
            inland: [{ exterior: lake, holes: [], surfaceHeightM: 800 }],
            bounds: BOUNDS,
            size: SIZE,
            simplifyCells: 2,
        });
        // Every node the body claims must be water, or the mesh has a hole in
        // the lake that the terrain shows through.
        let claimedButLand = 0;
        for (let i = 0; i < SIZE * SIZE; i++) {
            if (s.inlandNodes[i] && s.landNodes[i]) {
                claimedButLand++;
            }
        }
        assert.equal(claimedButLand, 0,
            `${claimedButLand} inland-water nodes are also land; each one is a gap in the body`);
    });

    it('still gives every claimed node the body height', () => {
        const lake = circle(16, 16, 8);
        const s = buildShoreline({
            polygons: [{
                exterior: [
                    { lon: BOUNDS.west - 1, lat: BOUNDS.north + 1 },
                    { lon: BOUNDS.east + 1, lat: BOUNDS.north + 1 },
                    { lon: BOUNDS.east + 1, lat: BOUNDS.south - 1 },
                    { lon: BOUNDS.west - 1, lat: BOUNDS.south - 1 },
                ],
                holes: [lake],
            }],
            inland: [{ exterior: lake, holes: [], surfaceHeightM: 800 }],
            bounds: BOUNDS,
            size: SIZE,
            simplifyCells: 2,
        });
        for (let i = 0; i < SIZE * SIZE; i++) {
            if (s.inlandNodes[i]) {
                assert.equal(s.inlandHeights[i], 800);
            }
        }
    });

    it('resolves a block centred on a lake as water, not land', () => {
        // The land ring here has no hole at all — the state the simplification
        // leaves behind when it swallows a small body. The node grid says water
        // and centreIsLand must agree, because the decimator uses it to break
        // the tie on saddle cells and would otherwise cut the shoreline against
        // the answer the classification already rejected.
        const lake = circle(16, 16, 6);
        const s = buildShoreline({
            polygons: [{
                exterior: [
                    { lon: BOUNDS.west - 1, lat: BOUNDS.north + 1 },
                    { lon: BOUNDS.east + 1, lat: BOUNDS.north + 1 },
                    { lon: BOUNDS.east + 1, lat: BOUNDS.south - 1 },
                    { lon: BOUNDS.west - 1, lat: BOUNDS.south - 1 },
                ],
                holes: [],
            }],
            inland: [{ exterior: lake, holes: [], surfaceHeightM: 800 }],
            bounds: BOUNDS,
            size: SIZE,
            simplifyCells: 2,
        });
        // Block (14,14) of size 4 has its centre exactly on the lake centre.
        assert.equal(s.centreIsLand(14, 14, 4), false);
        // ...and dry ground well away from it is still land.
        assert.equal(s.centreIsLand(1, 1, 2), true);
    });

    it('does not walk a lake height out across open water', () => {
        // The gap fill reads from a snapshot, so it cannot cascade. An ocean
        // tile with one lake in it must stay mostly ocean.
        const lake = circle(16, 16, 4);
        const s = buildShoreline({
            polygons: [],
            inland: [{ exterior: lake, holes: [], surfaceHeightM: 800 }],
            bounds: BOUNDS,
            size: SIZE,
            simplifyCells: 2,
        });
        const wet = s.inlandNodes.reduce((n, v) => n + v, 0);
        assert.ok(wet < SIZE * SIZE / 4,
            `${wet} of ${SIZE * SIZE} nodes claimed by one small lake; the fill cascaded`);
    });
});

describe('border snap', () => {
    // 12/4285/991 in miniature: the land ring leaves the east edge a hair
    // inside the tile and runs back to the corner from there, so every row
    // between had its right crossing under `cells` and the border column
    // fell through to open ocean.
    const eastInset = (inset: number) => ringFromGrid([
        [32, 0], [32 - inset, 20], [28, 20], [28, 25], [32, 25], [32, 32], [0, 32], [0, 0],
    ]);
    const eastColumn = (landNodes: Uint8Array, rows: number[]) =>
        rows.map(r => landNodes[r * SIZE + 32]);

    it('claims the border column when the ring is inset by less than the snap distance', () => {
        const sh = buildShoreline({ polygons: [eastInset(0.08)], bounds: BOUNDS, size: SIZE });
        assert.deepEqual(eastColumn(sh.landNodes, [1, 10, 19]), [1, 1, 1]);
        // The notch between rows 20 and 25 is genuinely water.
        assert.deepEqual(eastColumn(sh.landNodes, [22]), [0]);
    });

    it('leaves a ring that really sits inside the edge alone', () => {
        const sh = buildShoreline({ polygons: [eastInset(1.5)], bounds: BOUNDS, size: SIZE });
        assert.deepEqual(eastColumn(sh.landNodes, [10]), [0]);
    });
});
