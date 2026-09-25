import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemTile, decodePdm, encodePdmUncompressed } from './demTile';
import { makeEnuBasis } from './geodesy';
import { HeightField } from './heightField';
import { TerrainManifest } from './manifest';
import { TileKey, tileAtLonLat, tileBounds, tileKeyString } from './tiling';
import { TileIndex } from './tileIndex';
import { TileStore } from './tileStore';

const ORIGIN = { lat: 28.0015, lon: -15.3937, height: 0 };
const BASIS = makeEnuBasis(ORIGIN.lat, ORIGIN.lon, ORIGIN.height);
const QUERY_ZOOM = 11;
const COARSE_ZOOM = 7;
const TILE_SIZE = 33;

function manifest(over: Partial<TerrainManifest> = {}): TerrainManifest {
    return {
        version: 4,
        scheme: 'retro-terrain/1',
        ellipsoid: 'WGS84',
        seaLevel: 0,
        coverage: { west: -16, south: 27.5, east: -15, north: 28.5 },
        enuOrigin: ORIGIN,
        mesh: {
            path: '{z}/{x}/{y}.ptm', indexPath: 'i', minZoom: 0, maxZoom: 12,
            encoding: 'PTM1', triangleBudget: 6144,
            levelGeometricErrorM: [], levelSkirtDepthM: [],
        },
        height: {
            path: '{z}/{x}/{y}.pdm', indexPath: 'i', tileSize: TILE_SIZE,
            minZoom: 0, maxZoom: QUERY_ZOOM,
            queryZoom: QUERY_ZOOM, coarseZoom: COARSE_ZOOM,
        },
        flattenPads: [],
        ...over,
    };
}

/**
 * A store backed by a scripted set of tiles. `served` records what was asked
 * for so a test can assert the query never reached for anything else.
 */
function makeStore(heights: (id: TileKey) => number | undefined) {
    const served: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const key = String(input).replace('b/', '').replace('.pdm', '');
        served.push(key);
        const [z, x, y] = key.split('/').map(Number);
        const h = heights({ z, x, y });
        if (h === undefined) {
            return { ok: false, status: 404 } as Response;
        }
        const grid = new Float32Array(TILE_SIZE * TILE_SIZE).fill(h);
        const bytes = encodePdmUncompressed(grid, TILE_SIZE, 0);
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => bytes.buffer.slice(
                bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
            ),
        } as Response;
    }) as typeof fetch;

    const store = new TileStore<DemTile>({
        baseUrl: 'b',
        url: (id) => `b/${tileKeyString(id)}.pdm`,
        decode: (buf) => decodePdm(buf),
        sizeOf: (t) => t.heights.byteLength,
        maxBytes: 50_000_000,
        retryBackoffMs: 1,
    });
    return { store, served, restore: () => { globalThis.fetch = originalFetch; } };
}

/** A TileIndex over `tiles`, in the bytes the bake writes. */
function indexOf(tiles: TileKey[], z: number): TileIndex {
    const minX = Math.min(...tiles.map(t => t.x));
    const minY = Math.min(...tiles.map(t => t.y));
    const w = Math.max(...tiles.map(t => t.x)) - minX + 1;
    const h = Math.max(...tiles.map(t => t.y)) - minY + 1;
    const bits = new Uint8Array(Math.ceil((w * h) / 8));
    for (const t of tiles) {
        const i = (t.y - minY) * w + (t.x - minX);
        bits[i >> 3] |= 1 << (i & 7);
    }
    const out = new Uint8Array(8 + 16 + bits.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x31584950, true); // 'PIX1'
    view.setUint16(4, z, true);
    view.setUint16(6, z, true);
    view.setUint32(8, minX, true);
    view.setUint32(12, minY, true);
    view.setUint32(16, w, true);
    view.setUint32(20, h, true);
    out.set(bits, 24);
    return TileIndex.decode(out);
}

/** A lon/lat inside the coverage, and the ENU point matching it. */
const TEST_LON = -15.40;
const TEST_LAT = 28.00;

describe('HeightField', () => {
    it('samples the fine tier when it is resident', async () => {
        const fineId = tileAtLonLat(QUERY_ZOOM, TEST_LON, TEST_LAT);
        const h = makeStore(id => (id.z === QUERY_ZOOM && id.x === fineId.x && id.y === fineId.y
            ? 123 : undefined));
        try {
            const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
            await hf.ensureLoaded({
                west: TEST_LON, east: TEST_LON, south: TEST_LAT, north: TEST_LAT,
            });
            assert.equal(hf.heightAtLonLat(TEST_LON, TEST_LAT), 123);
        } finally {
            h.restore();
        }
    });

    it('falls back to the coarse tier with a reported resolution', async () => {
        const coarseId = tileAtLonLat(COARSE_ZOOM, TEST_LON, TEST_LAT);
        const h = makeStore(id => (id.z === COARSE_ZOOM && id.x === coarseId.x
            && id.y === coarseId.y ? 40 : undefined));
        try {
            const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
            await hf.loadCoarse();
            assert.equal(hf.heightAtLonLat(TEST_LON, TEST_LAT), 40);
        } finally {
            h.restore();
        }
    });

    it('loads only the tiles the index lists, not the whole coverage box', async () => {
        // Two areas far apart: the coverage box spans both and the sea between,
        // but only four coarse tiles were ever baked. Walking the box would ask
        // for every tile in it and 404 on almost all of them.
        const baked: TileKey[] = [
            { z: COARSE_ZOOM, x: 120, y: 42 }, { z: COARSE_ZOOM, x: 121, y: 42 },
            { z: COARSE_ZOOM, x: 133, y: 31 }, { z: COARSE_ZOOM, x: 134, y: 31 },
        ];
        const isBaked = (id: TileKey) => baked.some(
            b => b.z === id.z && b.x === id.x && b.y === id.y,
        );
        const h = makeStore(id => (isBaked(id) ? 55 : undefined));
        try {
            const hf = new HeightField({
                manifest: manifest({ coverage: { west: -19, south: 26, east: 9, north: 47 } }),
                store: h.store,
                basis: BASIS,
            });
            await hf.loadCoarse(indexOf(baked, COARSE_ZOOM));
            assert.equal(h.served.length, baked.length,
                `asked for ${h.served.length} tiles, only ${baked.length} exist`);
            assert.deepEqual(
                [...h.served].sort(), baked.map(tileKeyString).sort(),
            );
            assert.equal(hf.coarseTiles().length, baked.length);
        } finally {
            h.restore();
        }
    });

    it('still walks the coverage box when there is no index', async () => {
        // A pyramid whose index failed to fetch must keep booting, just less
        // efficiently — the box is the only other description of what exists.
        const coarseId = tileAtLonLat(COARSE_ZOOM, TEST_LON, TEST_LAT);
        const h = makeStore(id => (id.z === COARSE_ZOOM && id.x === coarseId.x
            && id.y === coarseId.y ? 40 : undefined));
        try {
            const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
            await hf.loadCoarse(undefined);
            assert.ok(h.served.length > 1, 'the box covers more than the one baked tile');
            assert.equal(hf.heightAtLonLat(TEST_LON, TEST_LAT), 40);
        } finally {
            h.restore();
        }
    });

    it('returns sea level when nothing covers the point', async () => {
        const h = makeStore(() => undefined);
        try {
            const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
            assert.equal(hf.heightAtLonLat(TEST_LON, TEST_LAT), 0);
        } finally {
            h.restore();
        }
    });

    describe('independence from renderer state (regression)', () => {
        it('returns the identical height no matter what else is cached', async () => {
            // The old bug: finestCached() walked maxZoom downwards through the
            // renderer's LRU, so loading a finer tile silently changed the
            // answer. Here the fine tier is pinned to queryZoom, so filling the
            // store with other zooms must change nothing.
            const fineId = tileAtLonLat(QUERY_ZOOM, TEST_LON, TEST_LAT);
            const h = makeStore(id => {
                if (id.z === QUERY_ZOOM && id.x === fineId.x && id.y === fineId.y) return 100;
                // Every other zoom reports a wildly different height.
                return 999;
            });
            try {
                const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
                await hf.ensureLoaded({
                    west: TEST_LON, east: TEST_LON, south: TEST_LAT, north: TEST_LAT,
                });
                const before = hf.heightAtLonLat(TEST_LON, TEST_LAT);
                assert.equal(before, 100);

                // Now load every other zoom over the same point, as a renderer
                // climbing and descending would.
                for (let z = 0; z <= 12; z++) {
                    if (z === QUERY_ZOOM) continue;
                    await h.store.request(tileAtLonLat(z, TEST_LON, TEST_LAT), 1);
                }
                assert.equal(
                    hf.heightAtLonLat(TEST_LON, TEST_LAT), before,
                    'render cache state leaked into a height query',
                );
            } finally {
                h.restore();
            }
        });

        it('only ever requests the query zoom for a fine lookup', async () => {
            const fineId = tileAtLonLat(QUERY_ZOOM, TEST_LON, TEST_LAT);
            const h = makeStore(() => 10);
            try {
                const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
                await hf.ensureLoaded({
                    west: TEST_LON, east: TEST_LON, south: TEST_LAT, north: TEST_LAT,
                });
                for (const key of h.served) {
                    assert.ok(
                        key.startsWith(`${QUERY_ZOOM}/`),
                        `fine lookup fetched ${key}, not zoom ${QUERY_ZOOM}`,
                    );
                }
                assert.ok(h.served.includes(tileKeyString(fineId)));
            } finally {
                h.restore();
            }
        });

        it('does not disturb cache recency, so queries cannot cause eviction', async () => {
            const h = makeStore(() => 5);
            try {
                const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
                await hf.ensureLoaded({
                    west: TEST_LON, east: TEST_LON, south: TEST_LAT, north: TEST_LAT,
                });
                const gen = h.store.nextGeneration();
                hf.heightAtLonLat(TEST_LON, TEST_LAT);
                assert.equal(h.store.nextGeneration(), gen + 1,
                    'a query should not advance or touch the draw generation');
            } finally {
                h.restore();
            }
        });
    });

    describe('resolution reporting', () => {
        it('reports fine, coarse and none correctly', async () => {
            const fineId = tileAtLonLat(QUERY_ZOOM, TEST_LON, TEST_LAT);
            const coarseId = tileAtLonLat(COARSE_ZOOM, TEST_LON, TEST_LAT);
            const h = makeStore(id => {
                if (id.z === QUERY_ZOOM && id.x === fineId.x && id.y === fineId.y) return 100;
                if (id.z === COARSE_ZOOM && id.x === coarseId.x && id.y === coarseId.y) return 20;
                return undefined;
            });
            try {
                const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
                assert.equal(hf.heightResolutionAtWorld(0, 0), 'none');
                await hf.loadCoarse();
                assert.equal(hf.heightResolutionAtWorld(0, 0), 'coarse');
                await hf.ensureLoadedAroundWorld(0, 0, 100);
                assert.equal(hf.heightResolutionAtWorld(0, 0), 'fine');
            } finally {
                h.restore();
            }
        });
    });

    describe('flatten pad', () => {
        const pad = {
            centerX: 0, centerZ: 0, halfW: 500, halfD: 2000,
            featherM: 80, heightMsl: 93.92,
        };

        it('flattens land inside the pad core to the baked height', async () => {
            const h = makeStore(() => 30);
            try {
                const hf = new HeightField({
                    manifest: manifest(), store: h.store, basis: BASIS, pads: [pad],
                });
                await hf.loadCoarse();
                await hf.ensureLoadedAroundWorld(0, 0, 3000);
                assert.ok(Math.abs(hf.heightAtWorld(0, 0) - 93.92) < 1e-6);
            } finally {
                h.restore();
            }
        });

        it('leaves ground outside the pad alone', async () => {
            const h = makeStore(() => 30);
            try {
                const hf = new HeightField({
                    manifest: manifest(), store: h.store, basis: BASIS, pads: [pad],
                });
                await hf.ensureLoadedAroundWorld(9000, 0, 2000);
                assert.equal(hf.geodeticHeightAtWorld(9000, 0), 30);
                // Scene Y is that elevation on the curved surface, ~6.3 m below
                // the tangent plane at 9 km out. See HeightSampler.heightAtEnu.
                const drop = 9000 ** 2 / (2 * 6378137);
                assert.ok(Math.abs(hf.heightAtWorld(9000, 0) - (30 - drop)) < 0.2);
            } finally {
                h.restore();
            }
        });

        it('never flattens water beyond the paved core', async () => {
            const h = makeStore(() => 0);
            try {
                const hf = new HeightField({
                    manifest: manifest(), store: h.store, basis: BASIS, pads: [pad],
                });
                await hf.ensureLoadedAroundWorld(0, 0, 3000);
                // Half way through the feather on the east edge: the platform
                // is blending into whatever is beside it, and here that is sea.
                // Compared as elevations rather than as scene Y, which carries
                // the curvature drop away from the origin as well.
                assert.equal(hf.geodeticHeightAtWorld(460, 0), 0,
                    'sea in the feather stays at sea level');
                assert.equal(hf.isLandAtWorld(460, 0), false);
                assert.equal(hf.geodeticHeightAtWorld(3000, 0), 0,
                    'sea outside the pad stays at sea level');
            } finally {
                h.restore();
            }
        });

        it('is solid ground over the paved core even where the DEM says sea', async () => {
            // Gran Canaria: the airport is built out onto the shore and part of
            // it reads as water. Left as sea, the aircraft falls through the
            // apron the mesh bake has already drawn as pavement.
            const h = makeStore(() => 0);
            try {
                const hf = new HeightField({
                    manifest: manifest(), store: h.store, basis: BASIS, pads: [pad],
                });
                await hf.ensureLoadedAroundWorld(0, 0, 1000);
                assert.ok(Math.abs(hf.geodeticHeightAtWorld(0, 0) - 93.92) < 1e-6);
                assert.equal(hf.isLandAtWorld(0, 0), true);
            } finally {
                h.restore();
            }
        });
    });

    it('classifies land and water by the sea-level epsilon', async () => {
        const h = makeStore(() => 40);
        try {
            const hf = new HeightField({ manifest: manifest(), store: h.store, basis: BASIS });
            await hf.ensureLoadedAroundWorld(0, 0, 500);
            assert.equal(hf.isLandAtWorld(0, 0), true);
        } finally {
            h.restore();
        }
    });

    it('sits on tile bounds consistently', () => {
        const id = tileAtLonLat(QUERY_ZOOM, TEST_LON, TEST_LAT);
        const b = tileBounds(id);
        assert.ok(TEST_LON >= b.west && TEST_LON <= b.east);
        assert.ok(TEST_LAT >= b.south && TEST_LAT <= b.north);
    });
});
