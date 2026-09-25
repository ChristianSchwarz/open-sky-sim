import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RegionPolygon, buildRegionField, regionFieldFromShoreline } from './regions';
import { buildShoreline } from './shoreline';

const BOUNDS = { west: 0, south: 0, east: 1, north: 1 };
const SIZE = 5; // 4 cells a side

describe('buildRegionField', () => {
    it('splits a tile into two side-by-side regions along a straight boundary', () => {
        const west: RegionPolygon = {
            exterior: [
                { lon: 0, lat: 0 }, { lon: 0.5, lat: 0 }, { lon: 0.5, lat: 1 }, { lon: 0, lat: 1 },
            ],
            holes: [],
            isLand: true,
            landuseClass: 1,
        };
        const east: RegionPolygon = {
            exterior: [
                { lon: 0.5, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0.5, lat: 1 },
            ],
            holes: [],
            isLand: true,
            landuseClass: 3,
        };
        const field = buildRegionField({ regions: [west, east], bounds: BOUNDS, size: SIZE });
        assert.equal(field.regionTable.length, 2);
        assert.equal(field.regionTable[0].landuseClass, 1);
        assert.equal(field.regionTable[1].landuseClass, 3);

        // Node grid is 5x5 over a 4-cell tile; column 2 sits exactly on the
        // 0.5 boundary, so it is the edge case - everything strictly west of
        // it must read region 0, strictly east must read region 1.
        for (let row = 0; row < SIZE; row++) {
            assert.equal(field.regionNodes[row * SIZE + 0], 0, 'far west node is region 0');
            assert.equal(field.regionNodes[row * SIZE + 4], 1, 'far east node is region 1');
        }

        // A vertical cell edge straddling the boundary records a crossing at
        // its true grid-space position (x=2, halfway across the tile).
        const t = field.edgeCrossing(2, 1, 2, 2);
        assert.equal(t, undefined, 'a vertical edge running along the boundary has no single crossing point');

        // A horizontal edge crossing from region 0 into region 1 records
        // where along it the boundary sits.
        const crossing = field.edgeCrossing(1, 2, 3, 2);
        assert.ok(crossing !== undefined);
        assert.ok(Math.abs((crossing as number) - 0.5) < 1e-6, `expected the midpoint, got ${crossing}`);
    });

    it('regionAt resolves an interior point to the region that contains it', () => {
        const west: RegionPolygon = {
            exterior: [
                { lon: 0, lat: 0 }, { lon: 0.5, lat: 0 }, { lon: 0.5, lat: 1 }, { lon: 0, lat: 1 },
            ],
            holes: [],
            isLand: true,
            landuseClass: undefined,
        };
        const east: RegionPolygon = {
            exterior: [
                { lon: 0.5, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 1 }, { lon: 0.5, lat: 1 },
            ],
            holes: [],
            isLand: false,
            landuseClass: undefined,
        };
        const field = buildRegionField({ regions: [west, east], bounds: BOUNDS, size: SIZE });
        assert.equal(field.regionAt(1, 2), 0);
        assert.equal(field.regionAt(3, 2), 1);
    });

    it('classifies the grid\'s own last row, not just its first', () => {
        // Two regions stacked north/south, each clipped exactly to the tile
        // bounds along the shared edge and the two outer edges - the routine
        // shape every real region touching a tile edge has, since Python
        // clips every region to the tile box. If the south row fell back to
        // the region-0 default instead of being genuinely classified, this
        // would not catch it - so the south region is index 1, not 0.
        const north: RegionPolygon = {
            exterior: [
                { lon: 0, lat: 0.5 }, { lon: 1, lat: 0.5 }, { lon: 1, lat: 1 }, { lon: 0, lat: 1 },
            ],
            holes: [],
            isLand: true,
            landuseClass: 5,
        };
        const south: RegionPolygon = {
            exterior: [
                { lon: 0, lat: 0 }, { lon: 1, lat: 0 }, { lon: 1, lat: 0.5 }, { lon: 0, lat: 0.5 },
            ],
            holes: [],
            isLand: true,
            landuseClass: 9,
        };
        const field = buildRegionField({ regions: [north, south], bounds: BOUNDS, size: SIZE });
        for (let col = 0; col < SIZE; col++) {
            assert.equal(field.regionNodes[0 * SIZE + col], 0, `row 0 (tile north edge) col ${col}`);
            assert.equal(
                field.regionNodes[(SIZE - 1) * SIZE + col], 1,
                `last row (tile south edge) col ${col} - must read the south region, not fall back`,
            );
        }
    });

    it('falls back to region 0 for a point no region ring actually covers', () => {
        const field = buildRegionField({ regions: [], bounds: BOUNDS, size: SIZE });
        assert.equal(field.regionAt(2, 2), 0);
        assert.equal(field.regionNodes[2 * SIZE + 2], 0);
    });
});

describe('regionFieldFromShoreline', () => {
    it('reinterprets a 0/1 land mask as a 2-entry region table', () => {
        const poly = {
            exterior: [
                { lon: 0, lat: 0 }, { lon: 0.5, lat: 0 }, { lon: 0.5, lat: 1 }, { lon: 0, lat: 1 },
            ],
            holes: [],
        };
        const shoreline = buildShoreline({ polygons: [poly], bounds: BOUNDS, size: SIZE });
        const field = regionFieldFromShoreline(shoreline);
        assert.equal(field.regionTable[0].isLand, false);
        assert.equal(field.regionTable[1].isLand, true);
        for (let i = 0; i < shoreline.landNodes.length; i++) {
            assert.equal(field.regionNodes[i], shoreline.landNodes[i]);
        }
        // regionAt is given an exact point, unlike Shoreline.centreIsLand's
        // own block-origin convention - this is the thing the adapter has to
        // translate between.
        assert.equal(field.regionAt(1, 2), 1, 'inside the land polygon');
        assert.equal(field.regionAt(3, 2), 0, 'outside it, still water');
    });
});
