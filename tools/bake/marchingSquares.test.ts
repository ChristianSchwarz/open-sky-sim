import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN_AREA, SNAP_EPS, Vec2, cutCell, cutCellRegions } from './marchingSquares';

function area(tri: Vec2[]): number {
    return Math.abs(
        (tri[1].x - tri[0].x) * (tri[2].y - tri[0].y)
        - (tri[2].x - tri[0].x) * (tri[1].y - tri[0].y),
    ) / 2;
}

function total(tris: Vec2[][]): number {
    return tris.reduce((s, t) => s + area(t), 0);
}

function cornersOf(mask: number): readonly [boolean, boolean, boolean, boolean] {
    return [
        (mask & 1) !== 0,
        (mask & 2) !== 0,
        (mask & 4) !== 0,
        (mask & 8) !== 0,
    ];
}

/** Crossings at the edge midpoints, the geometry-free reference case. */
const MIDPOINTS = [0.5, 0.5, 0.5, 0.5];

describe('marching-squares cell cutting', () => {
    it('tiles the cell exactly in all 16 corner cases', () => {
        for (let mask = 0; mask < 16; mask++) {
            for (const centreIsLand of [true, false]) {
                const r = cutCell({
                    corners: cornersOf(mask),
                    edgeCrossings: MIDPOINTS,
                    centreIsLand,
                });
                const sum = total(r.land) + total(r.water);
                assert.ok(
                    Math.abs(sum - 1) < 1e-9,
                    `mask ${mask} centre=${centreIsLand}: area ${sum} != 1`,
                );
            }
        }
    });

    it('keeps every vertex inside the cell in all 16 cases', () => {
        for (let mask = 0; mask < 16; mask++) {
            const r = cutCell({ corners: cornersOf(mask), edgeCrossings: MIDPOINTS });
            for (const tri of [...r.land, ...r.water]) {
                for (const p of tri) {
                    assert.ok(p.x >= -1e-12 && p.x <= 1 + 1e-12, `mask ${mask} x=${p.x}`);
                    assert.ok(p.y >= -1e-12 && p.y <= 1 + 1e-12, `mask ${mask} y=${p.y}`);
                }
            }
        }
    });

    it('emits no degenerate triangles in any case', () => {
        for (let mask = 0; mask < 16; mask++) {
            const r = cutCell({ corners: cornersOf(mask), edgeCrossings: MIDPOINTS });
            for (const tri of [...r.land, ...r.water]) {
                assert.ok(area(tri) > MIN_AREA, `mask ${mask} degenerate ${JSON.stringify(tri)}`);
            }
        }
    });

    it('tags a uniform cell entirely as one class, as two triangles', () => {
        const allWater = cutCell({ corners: cornersOf(0), edgeCrossings: [] });
        assert.equal(allWater.land.length, 0);
        assert.equal(allWater.water.length, 2);
        assert.ok(Math.abs(total(allWater.water) - 1) < 1e-12);

        const allLand = cutCell({ corners: cornersOf(15), edgeCrossings: [] });
        assert.equal(allLand.water.length, 0);
        assert.equal(allLand.land.length, 2);
        assert.ok(Math.abs(total(allLand.land) - 1) < 1e-12);
    });

    it('gives a single land corner a triangle and the rest to water', () => {
        // c0 land only.
        const r = cutCell({ corners: cornersOf(1), edgeCrossings: MIDPOINTS });
        assert.equal(r.land.length, 1, 'one land triangle');
        assert.ok(Math.abs(total(r.land) - 0.125) < 1e-12, `land area ${total(r.land)}`);
        assert.ok(Math.abs(total(r.water) - 0.875) < 1e-12);
    });

    it('keeps a defaulted crossing on the outline when the other snaps to the corner', () => {
        // c3 water only, its edge-2 crossing on the corner itself (t = 1) and
        // no geometry for edge 3, so that one defaults to the midpoint. The
        // water piece has no area; the land ring is the whole cell plus the
        // midpoint (0, 0.5), and the neighbour across x = 0 has that vertex
        // too. Fanned from c0 the triangle c0, c3, midpoint is collinear and
        // used to be dropped, which dropped the midpoint from this cell's
        // outline: a T-junction (2026-09-15).
        const r = cutCell({ corners: cornersOf(1 | 2 | 4), edgeCrossings: [undefined, undefined, 1, undefined] });
        assert.ok(Math.abs(total(r.land) - 1) < 1e-12, `land ${total(r.land)}`);
        assert.equal(r.water.length, 0);
        const onOutline = r.land.some(t => t.some(p => Math.abs(p.x) < 1e-12 && Math.abs(p.y - 0.5) < 1e-12));
        assert.ok(onOutline, 'the midpoint on edge 3 is a vertex of the land outline');
    });

    it('splits an edge-adjacent land pair down the middle', () => {
        // c0 + c1 land: the shoreline runs across the cell, halving it.
        const r = cutCell({ corners: cornersOf(1 | 2), edgeCrossings: MIDPOINTS });
        assert.ok(Math.abs(total(r.land) - 0.5) < 1e-12, `land ${total(r.land)}`);
        assert.ok(Math.abs(total(r.water) - 0.5) < 1e-12);
    });

    describe('saddle cases', () => {
        const saddleLandDiagonal = 1 | 4; // c0 + c2 land, c1 + c3 water

        it('joins the land diagonal when the centre is land', () => {
            const r = cutCell({
                corners: cornersOf(saddleLandDiagonal),
                edgeCrossings: MIDPOINTS,
                centreIsLand: true,
            });
            // Water becomes two isolated corner triangles; land takes the rest.
            assert.equal(r.water.length, 2, 'two isolated water corners');
            assert.ok(Math.abs(total(r.water) - 0.25) < 1e-12, `water ${total(r.water)}`);
            assert.ok(Math.abs(total(r.land) - 0.75) < 1e-12, `land ${total(r.land)}`);
        });

        it('joins the water diagonal when the centre is water', () => {
            const r = cutCell({
                corners: cornersOf(saddleLandDiagonal),
                edgeCrossings: MIDPOINTS,
                centreIsLand: false,
            });
            assert.equal(r.land.length, 2, 'two isolated land corners');
            assert.ok(Math.abs(total(r.land) - 0.25) < 1e-12, `land ${total(r.land)}`);
            assert.ok(Math.abs(total(r.water) - 0.75) < 1e-12, `water ${total(r.water)}`);
        });

        it('resolves both saddle orientations consistently', () => {
            for (const mask of [1 | 4, 2 | 8]) {
                for (const centreIsLand of [true, false]) {
                    const r = cutCell({
                        corners: cornersOf(mask),
                        edgeCrossings: MIDPOINTS,
                        centreIsLand,
                    });
                    const majority = centreIsLand ? r.land : r.water;
                    const minority = centreIsLand ? r.water : r.land;
                    assert.equal(minority.length, 2, `mask ${mask} centre=${centreIsLand}`);
                    assert.ok(total(majority) > total(minority));
                    assert.ok(Math.abs(total(majority) + total(minority) - 1) < 1e-9);
                }
            }
        });

        it('defaults to the c0 class when no centre sample is supplied', () => {
            const r = cutCell({ corners: cornersOf(1 | 4), edgeCrossings: MIDPOINTS });
            // c0 is land, so land takes the majority.
            assert.equal(r.water.length, 2);
            assert.ok(total(r.land) > total(r.water));
        });
    });

    describe('corner snapping', () => {
        it('drops the sliver when a crossing sits on a corner', () => {
            // c0 land; both crossings collapse onto c0 itself.
            const r = cutCell({
                corners: cornersOf(1),
                edgeCrossings: [SNAP_EPS / 2, undefined, undefined, 1 - SNAP_EPS / 2],
            });
            assert.equal(r.land.length, 0, 'the degenerate land corner is dropped');
            assert.ok(Math.abs(total(r.water) - 1) < 1e-9, `water ${total(r.water)}`);
        });

        it('still tiles exactly when a crossing snaps to a corner', () => {
            for (const t of [0, SNAP_EPS / 2, 1 - SNAP_EPS / 2, 1]) {
                const r = cutCell({
                    corners: cornersOf(1 | 2),
                    edgeCrossings: [undefined, t, undefined, t],
                });
                const sum = total(r.land) + total(r.water);
                assert.ok(Math.abs(sum - 1) < 1e-9, `t=${t} area ${sum}`);
            }
        });

        it('never emits a triangle below the minimum area', () => {
            for (let mask = 1; mask < 15; mask++) {
                for (const t of [0, SNAP_EPS / 2, 0.5, 1 - SNAP_EPS / 2, 1]) {
                    const r = cutCell({
                        corners: cornersOf(mask),
                        edgeCrossings: [t, t, t, t],
                    });
                    for (const tri of [...r.land, ...r.water]) {
                        assert.ok(area(tri) > MIN_AREA, `mask ${mask} t=${t}`);
                    }
                }
            }
        });
    });

    it('falls back to the edge midpoint when a crossing is missing', () => {
        const r = cutCell({ corners: cornersOf(1), edgeCrossings: [] });
        const sum = total(r.land) + total(r.water);
        assert.ok(Math.abs(sum - 1) < 1e-9, `area ${sum}`);
        assert.ok(Math.abs(total(r.land) - 0.125) < 1e-12);
    });

    it('places the shoreline where the crossing says, not at the midpoint', () => {
        // c0 land, crossings pushed far along both edges: land grows.
        const near = cutCell({ corners: cornersOf(1), edgeCrossings: [0.1, undefined, undefined, 0.9] });
        const far = cutCell({ corners: cornersOf(1), edgeCrossings: [0.9, undefined, undefined, 0.1] });
        assert.ok(total(far.land) > total(near.land), 'crossing position drives the split');
        assert.ok(Math.abs(total(near.land) - 0.005) < 1e-9, `near ${total(near.land)}`);
        assert.ok(Math.abs(total(far.land) - 0.405) < 1e-9, `far ${total(far.land)}`);
    });

    describe('shoreEdges', () => {
        it('tags every crossing as shore by default', () => {
            const r = cutCell({ corners: cornersOf(1 | 2), edgeCrossings: MIDPOINTS });
            const crossing = [...r.land, ...r.water].flat().find(p => p.shore);
            assert.ok(crossing, 'expected a shore-tagged vertex');
        });

        it('suppresses the shore tag on an edge marked as not one', () => {
            // c0+c1 land, c2+c3 water: the split runs along edge 1 (c1->c2)
            // and edge 3 (c3->c0). Mark both as landuse-only, not real shore.
            const r = cutCell({
                corners: cornersOf(1 | 2),
                edgeCrossings: MIDPOINTS,
                shoreEdges: [true, false, true, false],
            });
            const anyShore = [...r.land, ...r.water].flat().some(p => p.shore);
            assert.equal(anyShore, false, 'no crossing point should be tagged shore');
            // The geometry itself is unaffected - only the tag changes.
            assert.ok(Math.abs(total(r.land) - 0.5) < 1e-12);
            assert.ok(Math.abs(total(r.water) - 0.5) < 1e-12);
        });
    });
});

function totalOf(byRegion: Map<number, Vec2[][]>): number {
    let sum = 0;
    for (const tris of byRegion.values()) {
        sum += total(tris);
    }
    return sum;
}

describe('N-ary region cell cutting', () => {
    const MID4 = [0.5, 0.5, 0.5, 0.5];

    it('tiles the cell exactly for every 1..4-region corner pattern, with and without a centre id', () => {
        const patterns: Array<readonly [number, number, number, number]> = [
            [0, 0, 0, 0],       // k=1
            [0, 0, 1, 1],       // k=2, adjacent pair
            [0, 1, 0, 1],       // k=2, saddle
            [0, 1, 0, 2],       // k=3, one id repeated on a diagonal
            [0, 0, 1, 2],       // k=3, one id spans two adjacent corners
            [0, 1, 2, 0],       // k=3, the repeated id wraps around corner 0
            [0, 1, 2, 3],       // k=4, every corner distinct
        ];
        for (const corners of patterns) {
            const ids = [...new Set(corners)];
            for (const centreRegion of [...ids, undefined]) {
                const r = cutCellRegions({ corners, edgeCrossings: MID4, centreRegion });
                const sum = totalOf(r.byRegion);
                assert.ok(
                    Math.abs(sum - 1) < 1e-9,
                    `corners ${corners} centre=${centreRegion}: area ${sum} != 1`,
                );
            }
        }
    });

    it('keeps every vertex inside the cell and drops no region below MIN_AREA', () => {
        const r = cutCellRegions({ corners: [0, 1, 2, 3], edgeCrossings: MID4, centreRegion: 1 });
        for (const tris of r.byRegion.values()) {
            for (const tri of tris) {
                assert.ok(area(tri) > MIN_AREA);
                for (const p of tri) {
                    assert.ok(p.x >= -1e-12 && p.x <= 1 + 1e-12);
                    assert.ok(p.y >= -1e-12 && p.y <= 1 + 1e-12);
                }
            }
        }
    });

    it('matches cutCell exactly for a non-saddle 2-region split', () => {
        const bool = cutCell({ corners: [false, false, true, true], edgeCrossings: MID4 });
        const region = cutCellRegions({ corners: [0, 0, 1, 1], edgeCrossings: MID4, centreRegion: 0 });
        assert.ok(Math.abs(total(region.byRegion.get(0)!) - total(bool.water)) < 1e-9);
        assert.ok(Math.abs(total(region.byRegion.get(1)!) - total(bool.land)) < 1e-9);
    });

    it('matches cutCell exactly for a saddle, for both centre resolutions', () => {
        for (const [centreIsLand, centreRegion] of [[true, 0], [false, 1]] as const) {
            const bool = cutCell({ corners: [true, false, true, false], edgeCrossings: MID4, centreIsLand });
            const region = cutCellRegions({
                corners: [0, 1, 0, 1], edgeCrossings: MID4, centreRegion,
            });
            assert.ok(Math.abs(total(region.byRegion.get(0)!) - total(bool.land)) < 1e-9);
            assert.ok(Math.abs(total(region.byRegion.get(1)!) - total(bool.water)) < 1e-9);
        }
    });

    it('gives a region two disjoint corners its own two separate wedges, not one shared triangle', () => {
        // corners 0 and 2 are the same id (A) but diagonal, not adjacent; the
        // centre is a third id (C) touching only corner 3.
        const r = cutCellRegions({ corners: [0, 1, 0, 2], edgeCrossings: MID4, centreRegion: 2 });
        assert.equal(r.byRegion.get(0)!.length, 2, 'two disconnected corner-0 and corner-2 wedges');
        assert.equal(r.byRegion.get(1)!.length, 1);
        assert.ok(Math.abs(total(r.byRegion.get(0)!) - 0.25) < 1e-9);
        assert.ok(Math.abs(total(r.byRegion.get(1)!) - 0.125) < 1e-9);
        assert.ok(Math.abs(total(r.byRegion.get(2)!) - 0.625) < 1e-9, 'the centre region takes the rest');
    });

    it('falls back to the c0 region when no centre id, or an id absent from every corner, is supplied', () => {
        const noCentre = cutCellRegions({ corners: [0, 1, 2, 0], edgeCrossings: MID4 });
        const badCentre = cutCellRegions({ corners: [0, 1, 2, 0], edgeCrossings: MID4, centreRegion: 99 });
        assert.ok(Math.abs(totalOf(noCentre.byRegion) - 1) < 1e-9);
        assert.ok(Math.abs(totalOf(badCentre.byRegion) - 1) < 1e-9);
        for (const r of [noCentre, badCentre]) {
            assert.ok(r.byRegion.has(0), 'falls back to corner 0\'s id');
        }
    });

    it('never puts two ids\' triangles on top of each other', () => {
        const r = cutCellRegions({ corners: [0, 1, 2, 3], edgeCrossings: MID4, centreRegion: 2 });
        assert.equal(r.byRegion.size, 4, 'all four ids present with 4 distinct corners');
    });

    it('suppresses the shore tag on edges marked as not a real shore', () => {
        // A dual-boundary cell: id 0 is water, ids 1 and 2 are both land
        // (a landuse edge between them). Only the edges bordering water (0)
        // are a real shore; the edge between 1 and 2 (edge 1, c1->c2, whose
        // MID4 crossing lands at grid point (1, 0.5)) is not - only that one
        // crossing should lose its tag.
        const r = cutCellRegions({
            corners: [0, 1, 2, 0], edgeCrossings: MID4, centreRegion: 0,
            shoreEdges: [true, false, true, true],
        });
        const allPts = [...r.byRegion.values()].flat().flat();
        const at = (x: number, y: number) => allPts.find(p => Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
        assert.equal(at(0.5, 0)?.shore, true, 'edge 0 (water/region-1) is a real shore');
        assert.equal(at(1, 0.5)?.shore, false, 'edge 1 (region-1/region-2) is landuse-only');
        assert.equal(at(0.5, 1)?.shore, true, 'edge 2 (region-2/water) is a real shore');
    });
});
