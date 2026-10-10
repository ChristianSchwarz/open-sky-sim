/**
 * Tile addressing fixtures: the Plate Carree quadtree (workstream A/B).
 * y increases SOUTH from lat +90; x increases east from lon -180.
 */
import {
    approxTileEdgeMetres, childrenOf, parentOf, rootTiles, tileAtLonLat, tileBounds,
    tileKeyString, tileRangeForBounds, xCount, yCount, TileKey,
} from '../../../src/script/terrain/tiling';
import { Rng, SuiteOutput } from '../lib';

export function tilingSuite(): SuiteOutput {
    const rng = new Rng(0x71135);

    const keys: TileKey[] = [];
    for (let z = 0; z <= 12; z++) {
        const xc = xCount(z), yc = yCount(z);
        const xs = new Set([0, xc - 1, xc >> 1, Math.min(xc - 1, 1)]);
        const ys = new Set([0, yc - 1, yc >> 1]);
        for (const x of xs) for (const y of ys) keys.push({ z, x, y });
        for (let i = 0; i < 3; i++) keys.push({ z, x: rng.int(0, xc - 1), y: rng.int(0, yc - 1) });
    }
    // The real tiles used elsewhere in the fixtures.
    keys.push({ z: 12, x: 3682, y: 1416 }, { z: 10, x: 1057, y: 213 }, { z: 11, x: 2114, y: 427 });

    const tiles = keys.map(k => {
        const b = tileBounds(k);
        return {
            key: k,
            keyString: tileKeyString(k),
            xCount: xCount(k.z),
            yCount: yCount(k.z),
            bounds: [b.west, b.south, b.east, b.north],
            parent: parentOf(k) ?? null,
            children: childrenOf(k),
            approxEdgeMetres: approxTileEdgeMetres(k),
        };
    });

    // Lon/lat lookups, including exact tile edges, the date line and the poles.
    const lonLats: Array<[number, number]> = [
        [-180, 90], [180, -90], [180, 90], [-180, -90], [0, 0], [-15.3937, 28.0015],
        [11.58, 48.14], [13.4, 52.52], [34.0, 44.5], [-179.999, 89.999], [179.999, -89.999],
        [-90, 45], [90, -45], [0.0000001, -0.0000001],
    ];
    for (let i = 0; i < 30; i++) lonLats.push([rng.range(-180, 180), rng.range(-90, 90)]);
    const lookups = [] as unknown[];
    for (const z of [0, 1, 4, 8, 10, 11, 12]) {
        for (const [lon, lat] of lonLats) {
            lookups.push({ z, lon, lat, tile: tileAtLonLat(z, lon, lat) });
        }
    }
    // Exactly on tile boundaries (floor semantics matter here).
    for (const z of [3, 9, 12]) {
        const span = 180 / (1 << z);
        for (const ix of [1, 5, 17]) {
            for (const iy of [1, 3, 11]) {
                const lon = -180 + ix * span;
                const lat = 90 - iy * span;
                lookups.push({ z, lon, lat, tile: tileAtLonLat(z, lon, lat) });
            }
        }
    }

    const boundsList = [
        { west: -15.9, south: 27.6, east: -15.3, north: 28.2 },
        { west: 5.8, south: 45.8, east: 17.2, north: 55.1 },
        { west: -180, south: -90, east: 180, north: 90 },
        { west: 33.0, south: 44.0, east: 36.0, north: 46.0 },
        { west: 11.0, south: 47.0, east: 11.0001, north: 47.0001 },
    ];
    const ranges = [] as unknown[];
    for (const z of [0, 4, 8, 11, 12]) {
        for (const b of boundsList) {
            ranges.push({ z, bounds: [b.west, b.south, b.east, b.north], range: tileRangeForBounds(z, b) });
        }
    }

    return {
        files: [{
            file: 'tiling.json',
            data: {
                suite: 'tiling',
                version: 1,
                source: 'src/script/terrain/tiling.ts',
                notes: [
                    'Level z has 2^(z+1) columns and 2^z rows. y increases south from lat +90.',
                    'tileAtLonLat clamps to the grid and uses floor(), so exact edges belong to the east/south tile.',
                    'Bounds are [west, south, east, north] in degrees.',
                ],
                tolerances: { degrees: 1e-12, metres: 1e-6 },
                roots: rootTiles(),
                tiles,
                lookups,
                ranges,
            },
        }],
    };
}
