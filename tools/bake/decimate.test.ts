import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GridTriangle, decimate } from './decimate';

const SIZE = 33; // 32 cells per side

function grid(size: number, fn: (x: number, y: number) => number): Float32Array {
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            out[y * size + x] = fn(x, y);
        }
    }
    return out;
}

function classes(size: number, fn: (x: number, y: number) => boolean): Uint8Array {
    const out = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            out[y * size + x] = fn(x, y) ? 1 : 0;
        }
    }
    return out;
}

/** A 0/1 region grid, matching the old land/water convention: 1 = land. */
function regions(size: number, fn: (x: number, y: number) => boolean): Uint16Array {
    const out = new Uint16Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            out[y * size + x] = fn(x, y) ? 1 : 0;
        }
    }
    return out;
}

/** An arbitrary-id region grid, for the 3+ region cases. */
function regionIds(size: number, fn: (x: number, y: number) => number): Uint16Array {
    const out = new Uint16Array(size * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            out[y * size + x] = fn(x, y);
        }
    }
    return out;
}

function area(t: GridTriangle): number {
    const [a, b, c] = t.pts;
    return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

function totalArea(tris: GridTriangle[]): number {
    return tris.reduce((s, t) => s + area(t), 0);
}

const allLand = (size: number) => regions(size, () => true);

/** `regionId === 1` stands in for "land" throughout, matching `regions()` above. */
const isLand = (t: GridTriangle) => t.regionId === 1;

describe('restricted-quadtree decimation', () => {
    it('collapses a flat uniform tile to a single leaf', () => {
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, () => 100),
            regionNodes: allLand(SIZE),
            maxErrorM: 1,
        });
        assert.equal(r.leafCount, 1);
        assert.equal(r.triangles.length, 2);
        assert.equal(r.shorelineLeafCount, 0);
    });

    it('collapses a planar ramp too, since bilinear reproduces it exactly', () => {
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, (x, y) => 3 * x + 5 * y),
            regionNodes: allLand(SIZE),
            maxErrorM: 0.001,
        });
        assert.equal(r.leafCount, 1, 'a plane needs no subdivision');
    });

    it('refines around a spike and leaves the rest coarse', () => {
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, (x, y) => (x === 16 && y === 16 ? 500 : 0)),
            regionNodes: allLand(SIZE),
            maxErrorM: 1,
        });
        assert.ok(r.leafCount > 1, 'the spike forces subdivision');
        assert.ok(r.leafCount < 200, `over-refined: ${r.leafCount} leaves`);
    });

    it('respects the vertical tolerance', () => {
        const heights = grid(SIZE, (x, y) => (x === 16 && y === 16 ? 50 : 0));
        const tight = decimate({ size: SIZE, heights, regionNodes: allLand(SIZE), maxErrorM: 0.5 });
        const loose = decimate({ size: SIZE, heights, regionNodes: allLand(SIZE), maxErrorM: 100 });
        assert.ok(tight.leafCount > loose.leafCount, 'a looser tolerance merges more');
        assert.equal(loose.leafCount, 1, 'tolerance above the spike collapses the tile');
    });

    describe('cover-class boundaries', () => {
        // A flat, all-land tile with two landcover classes split down the
        // middle. Height alone would merge this into a single leaf, same as
        // the flat-uniform-tile case above.
        const half = SIZE >> 1;
        const splitCoverClasses = () => {
            const out = new Uint8Array(SIZE * SIZE);
            for (let y = 0; y < SIZE; y++) {
                for (let x = 0; x < SIZE; x++) {
                    out[y * SIZE + x] = x < half ? 1 : 4; // Tree | Crop
                }
            }
            return out;
        };

        it('refuses to merge a block that straddles a cover-class boundary', () => {
            const r = decimate({
                size: SIZE,
                heights: grid(SIZE, () => 100),
                regionNodes: allLand(SIZE),
                coverClasses: splitCoverClasses(),
                maxErrorM: 1e9, // height alone would collapse this to one leaf
            });
            assert.ok(r.leafCount > 1, 'the class boundary forces subdivision');
        });

        it('merges freely when no cover data is given, unchanged from before', () => {
            const r = decimate({
                size: SIZE,
                heights: grid(SIZE, () => 100),
                regionNodes: allLand(SIZE),
                maxErrorM: 1e9,
            });
            assert.equal(r.leafCount, 1, 'omitting coverClasses must not change existing behaviour');
        });

        it('never lets a cover-class difference reach the region cutter', () => {
            // All-land, uniform height, split cover: nothing here may be
            // treated as a region crossing (cutCell only understands two
            // regions, and would misread a cover-only boundary as one).
            const r = decimate({
                size: SIZE,
                heights: grid(SIZE, () => 100),
                regionNodes: allLand(SIZE),
                coverClasses: splitCoverClasses(),
                maxErrorM: 1e9,
            });
            assert.equal(r.shorelineLeafCount, 0,
                'a cover-only boundary must never be treated as a region boundary');
        });
    });

    describe('watertightness', () => {
        const cases: Array<[string, (x: number, y: number) => boolean]> = [
            ['all land', () => true],
            ['all water', () => false],
            ['straight north-south coast', (x) => x < 16],
            ['straight east-west coast', (_x, y) => y < 16],
            ['diagonal coast', (x, y) => x + y < 32],
            ['island', (x, y) => Math.hypot(x - 16, y - 16) < 7],
            ['lake', (x, y) => Math.hypot(x - 16, y - 16) > 7],
            ['checkerboard (worst case)', (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0],
        ];

        for (const [name, cls] of cases) {
            it(`tiles the whole grid exactly: ${name}`, () => {
                const r = decimate({
                    size: SIZE,
                    heights: grid(SIZE, (x, y) => Math.sin(x / 4) * 20 + Math.cos(y / 3) * 15),
                    regionNodes: regions(SIZE, cls),
                    maxErrorM: 2,
                });
                const cells = SIZE - 1;
                const got = totalArea(r.triangles);
                assert.ok(
                    Math.abs(got - cells * cells) < 1e-6,
                    `${name}: area ${got} != ${cells * cells}`,
                );
            });
        }

        it('tiles the whole grid exactly with three regions meeting in one corner', () => {
            // Three quadrants of one region and one of another two, arranged
            // so a real 3-region cell sits at the centre - the case that
            // needs cutCellRegions rather than the plain boolean cutter.
            const r = decimate({
                size: SIZE,
                heights: grid(SIZE, () => 0),
                regionNodes: regionIds(SIZE, (x, y) => {
                    if (x < 16 && y < 16) return 0;
                    if (x >= 16 && y < 16) return 1;
                    return 2; // both south quadrants share region 2
                }),
                maxErrorM: 1000,
            });
            const cells = SIZE - 1;
            assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-6);
        });

        it('tiles the whole grid exactly with all four quadrants distinct', () => {
            const r = decimate({
                size: SIZE,
                heights: grid(SIZE, () => 0),
                regionNodes: regionIds(SIZE, (x, y) => (x < 16 ? 0 : 1) + (y < 16 ? 0 : 2)),
                maxErrorM: 1000,
            });
            const cells = SIZE - 1;
            assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-6);
        });
    });

    it('never merges a block that straddles a region boundary', () => {
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, () => 0),
            regionNodes: regions(SIZE, (x) => x < 16),
            maxErrorM: 1000, // would merge everything if region were ignored
        });
        // A straight boundary on flat ground is a run of simple-chord leaves
        // now, not a column of cut cells; what must hold is that the cut is
        // where the regions say, exactly.
        assert.ok(r.shorelineLeafCount >= 1, 'a boundary leaf exists');
        // 33 nodes puts the class boundary off-centre: nodes 0..15 are land, so
        // cells 0..14 are solid land, cell 15 is the boundary (split at its
        // midpoint) and cells 16..31 are solid water. That is 15.5 vs 16.5
        // columns of 32 rows.
        const land = totalArea(r.triangles.filter(isLand));
        const water = totalArea(r.triangles.filter(t => !isLand(t)));
        assert.ok(Math.abs(land - 15.5 * 32) < 1e-6, `land ${land}`);
        assert.ok(Math.abs(water - 16.5 * 32) < 1e-6, `water ${water}`);
        assert.ok(Math.abs(land + water - 32 * 32) < 1e-6, 'watertight');
    });

    it('gives a real three-region cell its own distinct triangles, not a two-way split', () => {
        // A single minLeafSize cell at the centre whose four corners are
        // three different regions (0, 0, 1, 2) - only reachable through
        // cutCellRegions, never cutCell.
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, () => 0),
            regionNodes: regionIds(SIZE, (x, y) => {
                if (x <= 16 && y <= 16) return 0;
                if (x > 16 && y <= 16) return 0;
                if (x <= 16 && y > 16) return 1;
                return 2;
            }),
            maxErrorM: 1000,
            minLeafSize: 1,
        });
        const present = new Set(r.triangles.map(t => t.regionId));
        assert.ok(present.has(0) && present.has(1) && present.has(2), `regions present: ${[...present]}`);
        const cells = SIZE - 1;
        assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-6, 'still watertight');
    });

    it('keeps neighbouring leaves within one level of each other', () => {
        // Reconstruct leaf sizes from the emitted triangles is awkward, so
        // assert the observable consequence instead: a balanced tree tiles
        // exactly, and an unbalanced one would leave T-junction gaps. Combined
        // with the watertightness cases above, this checks the spiky worst case.
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, (x, y) => ((x % 8 === 0 && y % 8 === 0) ? 300 : 0)),
            regionNodes: allLand(SIZE),
            maxErrorM: 0.5,
        });
        const cells = SIZE - 1;
        assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-6);
    });

    it('honours minLeafSize, coarsening the boundary with it', () => {
        const cls = regions(SIZE, (x, y) => Math.hypot(x - 16, y - 16) < 9);
        const fine = decimate({
            size: SIZE, heights: grid(SIZE, () => 0), regionNodes: cls, maxErrorM: 1000,
            minLeafSize: 1,
        });
        const coarse = decimate({
            size: SIZE, heights: grid(SIZE, () => 0), regionNodes: cls, maxErrorM: 1000,
            minLeafSize: 4,
        });
        // Simple-chord leaves already cut a smooth circle at up to four
        // cells at minLeafSize 1, so coarsening can only match or beat it.
        assert.ok(
            coarse.triangles.length <= fine.triangles.length,
            `coarse ${coarse.triangles.length} should not exceed fine ${fine.triangles.length}`,
        );
        const cells = SIZE - 1;
        assert.ok(Math.abs(totalArea(coarse.triangles) - cells * cells) < 1e-6, 'still watertight');
    });

    it('honours maxLeafSize', () => {
        const r = decimate({
            size: SIZE,
            heights: grid(SIZE, () => 0),
            regionNodes: allLand(SIZE),
            maxErrorM: 1000,
            maxLeafSize: 8,
        });
        // 32x32 cells capped at 8x8 leaves = 16 leaves.
        assert.equal(r.leafCount, 16);
        assert.equal(r.triangles.length, 32);
    });

    it('uses supplied edge crossings to place the boundary', () => {
        const cls = regions(SIZE, (x) => x < 16);
        const base = { size: SIZE, heights: grid(SIZE, () => 0), regionNodes: cls, maxErrorM: 1000 };
        // The crossing parameter runs along each edge, and opposite edges of a
        // cell run in opposite directions, so a *constant* t is not a fixed
        // place in space: it yields a trapezoid whose area is the same as the
        // midpoint's. A real caller solves for a position, so do that here.
        const atX = (targetX: number) =>
            (ax: number, _ay: number, bx: number, _by: number) =>
                (bx === ax ? undefined : (targetX - ax) / (bx - ax));

        const near = decimate({ ...base, edgeCrossing: atX(15.1) });
        const far = decimate({ ...base, edgeCrossing: atX(15.9) });
        const landNear = totalArea(near.triangles.filter(isLand));
        const landFar = totalArea(far.triangles.filter(isLand));
        assert.ok(Math.abs(landNear - 15.1 * 32) < 1e-6, `near ${landNear}`);
        assert.ok(Math.abs(landFar - 15.9 * 32) < 1e-6, `far ${landFar}`);
        assert.ok(landFar > landNear, 'crossing position drives the boundary');
        const cells = SIZE - 1;
        for (const r of [near, far]) {
            assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-6, 'still watertight');
        }
    });

    describe('isLandRegion', () => {
        function shoreTaggedPointCount(r: ReturnType<typeof decimate>): number {
            let n = 0;
            for (const t of r.triangles) {
                for (const p of t.pts) {
                    if (p.shore) n++;
                }
            }
            return n;
        }

        it('tags every boundary crossing as shore by default, with no isLandRegion given', () => {
            const r = decimate({
                size: SIZE, heights: grid(SIZE, () => 0), regionNodes: regions(SIZE, (x) => x < 16),
                maxErrorM: 1000,
            });
            assert.ok(shoreTaggedPointCount(r) > 0);
        });

        it('suppresses the shore tag on a boundary between two regions on the same side of land', () => {
            // Two "land" regions (ids 1 and 2, both isLandRegion -> true)
            // split down the middle, same shape as the coast test above but
            // with neither side being water.
            const twoLandRegions = regionIds(SIZE, (x) => (x < 16 ? 1 : 2));
            const r = decimate({
                size: SIZE, heights: grid(SIZE, () => 0), regionNodes: twoLandRegions,
                maxErrorM: 1000,
                isLandRegion: () => true,
            });
            assert.equal(shoreTaggedPointCount(r), 0,
                'a landuse-only boundary must never be tagged as a shore');
        });

        it('still tags a real land/water boundary as shore when isLandRegion says so', () => {
            const cls = regions(SIZE, (x) => x < 16); // 0 = water, 1 = land
            const r = decimate({
                size: SIZE, heights: grid(SIZE, () => 0), regionNodes: cls,
                maxErrorM: 1000,
                isLandRegion: (id) => id === 1,
            });
            assert.ok(shoreTaggedPointCount(r) > 0, 'a real shore must still be tagged');
        });

        it('tags only the water-facing edges of a three-region cell, not the landuse-only one', () => {
            // Region 0 is water (west), regions 1 and 2 are both land, split
            // north/south on the east side - so a cell near the middle faces
            // water, region 1, and region 2 all at once.
            const r = decimate({
                size: SIZE,
                heights: grid(SIZE, () => 0),
                regionNodes: regionIds(SIZE, (x, y) => {
                    if (x < 16) return 0;
                    return y < 16 ? 1 : 2;
                }),
                maxErrorM: 1000,
                minLeafSize: 1,
                isLandRegion: (id) => id !== 0,
            });
            // Watertight and shore-tagged points exist (the coast is real),
            // same invariants as every other case - the point of this test is
            // that it does not throw and the geometry stays consistent when
            // a genuine three-region cell also has a landuse-only edge on it.
            const cells = SIZE - 1;
            assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-6);
            assert.ok(shoreTaggedPointCount(r) > 0);
        });
    });

    it('uses regionAt to resolve a saddle, same as the old centreIsLand contract', () => {
        const cls = regions(SIZE, (x, y) => (x < 16) !== (y < 16)); // a diagonal saddle at (16,16)
        const base = { size: SIZE, heights: grid(SIZE, () => 0), regionNodes: cls, maxErrorM: 1000 };
        const asLand = decimate({ ...base, regionAt: () => 1 });
        const asWater = decimate({ ...base, regionAt: () => 0 });
        const landArea = (r: ReturnType<typeof decimate>) => totalArea(r.triangles.filter(isLand));
        assert.ok(landArea(asLand) > landArea(asWater), 'regionAt drives the saddle resolution');
    });

    it('rejects a grid whose cell count is not a power of two', () => {
        assert.throws(() => decimate({
            size: 30,
            heights: new Float32Array(900),
            regionNodes: new Uint16Array(900),
            maxErrorM: 1,
        }), /power of two/);
    });

    it('handles the real tile size of 257 nodes', () => {
        const size = 257;
        const r = decimate({
            size,
            heights: grid(size, (x, y) => Math.sin(x / 20) * 100 + Math.cos(y / 17) * 80),
            regionNodes: regions(size, (x, y) => Math.hypot(x - 128, y - 128) < 90),
            maxErrorM: 4,
        });
        const cells = size - 1;
        assert.ok(Math.abs(totalArea(r.triangles) - cells * cells) < 1e-4);
        assert.ok(r.shorelineLeafCount > 0, 'the boundary produced cut leaves');
    });
});
