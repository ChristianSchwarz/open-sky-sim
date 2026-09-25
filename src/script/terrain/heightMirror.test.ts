import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemTile, decodePdm, encodePdmUncompressed } from './demTile';
import { makeEnuBasis } from './geodesy';
import { HeightField } from './heightField';
import {
    HeightFieldSender, HeightTileUpdate, MirroredHeightField,
} from './heightMirror';
import { TerrainManifest } from './manifest';
import { TileKey, tileKeyString } from './tiling';
import { TileStore } from './tileStore';

const ORIGIN = { lat: 28.0015, lon: -15.3937, height: 0 };
const QUERY_ZOOM = 11;
const COARSE_ZOOM = 7;
const TILE_SIZE = 65;

function manifest(): TerrainManifest {
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
    };
}

/**
 * Tiles carrying steep relief: ridges and barrancos a few samples apart, which
 * is what a lattice coarser than the DEM smooths into phantom ground.
 */
function makeStore() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const key = String(input).replace('b/', '').replace('.pdm', '');
        const [z, x, y] = key.split('/').map(Number);
        const grid = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let j = 0; j < TILE_SIZE; j++) {
            for (let i = 0; i < TILE_SIZE; i++) {
                grid[j * TILE_SIZE + i] = 800
                    + 700 * Math.sin((i + x) * 0.9)
                    + 500 * Math.cos((j + y) * 1.1)
                    + (z === COARSE_ZOOM ? 137 : 0);
            }
        }
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
    return { store, restore: () => { globalThis.fetch = originalFetch; } };
}

async function makeMirror() {
    const { store, restore } = makeStore();
    const m = manifest();
    const field = new HeightField({
        manifest: m, store, basis: makeEnuBasis(ORIGIN.lat, ORIGIN.lon, 0),
    });
    await field.loadCoarse();

    const mirror = new MirroredHeightField();
    mirror.configure({
        basis: makeEnuBasis(ORIGIN.lat, ORIGIN.lon, 0),
        seaLevel: m.seaLevel,
        queryZoom: m.height.queryZoom,
        coarseZoom: m.height.coarseZoom,
        pads: [...field.flattenPads],
    });
    const sent: HeightTileUpdate[] = [];
    const sender = new HeightFieldSender(field, u => {
        sent.push(u);
        mirror.applyTiles(u);
    });
    return { field, mirror, sender, sent, restore };
}

describe('height field mirror', () => {

    it('reproduces the render thread\'s ground height exactly', async () => {
        const { field, mirror, sender, restore } = await makeMirror();
        try {
            sender.sendCoarse();
            await field.ensureLoadedAroundWorld(0, 0, 6000);
            sender.update([{ x: 0, z: 0 }], 6000);

            let checked = 0;
            for (let z = -4000; z <= 4000; z += 137) {
                for (let x = -4000; x <= 4000; x += 149) {
                    assert.equal(mirror.tierAtWorld(x, z), 'fine');
                    assert.equal(
                        mirror.heightAtWorld(x, z), field.heightAtWorld(x, z),
                        `mismatch at ${x},${z}`,
                    );
                    checked++;
                }
            }
            assert.ok(checked > 3000);
        } finally {
            restore();
        }
    });

    it('answers from the coarse tier until the fine tiles arrive', async () => {
        const { field, mirror, sender, restore } = await makeMirror();
        try {
            sender.sendCoarse();
            await field.ensureLoadedAroundWorld(0, 0, 3000);

            // The render thread is on the fine tier; the mirror has not been
            // given those tiles yet, so it still answers coarse — and the coarse
            // tier is deliberately offset here, so the two disagree. This is the
            // state the sim must refuse to kill anyone in.
            assert.equal(field.heightResolutionAtWorld(0, 0), 'fine');
            assert.equal(mirror.tierAtWorld(0, 0), 'coarse');
            assert.notEqual(mirror.heightAtWorld(0, 0), field.heightAtWorld(0, 0));

            sender.update([{ x: 0, z: 0 }], 3000);
            assert.equal(mirror.tierAtWorld(0, 0), 'fine');
            assert.equal(mirror.heightAtWorld(0, 0), field.heightAtWorld(0, 0));
        } finally {
            restore();
        }
    });

    it('sends each tile once and drops the ones left behind', async () => {
        const { field, mirror, sender, sent, restore } = await makeMirror();
        try {
            await field.ensureLoadedAroundWorld(0, 0, 3000);
            sender.update([{ x: 0, z: 0 }], 3000);
            const first = [...mirror.fineKeys()].sort();
            assert.ok(first.length > 0);

            // Same focus again: nothing new to say.
            const before = sent.length;
            sender.update([{ x: 0, z: 0 }], 3000);
            assert.equal(sent.length, before);

            // Move two fine tiles east; the old ones are dropped.
            const far = 40000;
            await field.ensureLoadedAroundWorld(far, 0, 3000);
            sender.update([{ x: far, z: 0 }], 3000);
            const now = new Set(mirror.fineKeys());
            assert.ok(first.some(k => !now.has(k)), 'expected stale tiles dropped');
            assert.ok([...now].some(k => !first.includes(k)), 'expected new tiles added');
        } finally {
            restore();
        }
    });

    it('does not resolve a tile the sender has not shipped', async () => {
        const { mirror, restore } = await makeMirror();
        try {
            assert.equal(mirror.tierAtWorld(0, 0), 'none');
            assert.ok(Math.abs(mirror.heightAtWorld(0, 0)) < 1e-6);
            assert.equal(mirror.isAuthoritativeAt(0, 0), false);
        } finally {
            restore();
        }
    });

    it('treats a fine tile that will never arrive as final', async () => {
        const { field, mirror, sender, restore } = await makeMirror();
        try {
            sender.sendCoarse();
            // Nothing baked at this zoom here, so the store reports it absent.
            const gapSender = new HeightFieldSender({
                seaLevel: field.seaLevel,
                queryZoom: field.queryZoom,
                coarseZoom: field.coarseZoom,
                coarseTiles: () => field.coarseTiles(),
                fineTileIdsAroundWorld: (x, z, r) => field.fineTileIdsAroundWorld(x, z, r),
                peekFine: () => undefined,
                isFineAbsent: () => true,
                ensureLoadedAroundWorld: async () => { },
            }, u => mirror.applyTiles(u));
            gapSender.update([{ x: 0, z: 0 }], 3000);

            assert.equal(mirror.tierAtWorld(0, 0), 'coarse');
            assert.equal(
                mirror.isAuthoritativeAt(0, 0), true,
                'coarse is all anyone has here, so it stands',
            );
        } finally {
            restore();
        }
    });
});

describe('scene Y versus elevation', () => {

    it('places ground on the curved surface, not the tangent plane', async () => {
        const { field, restore } = await makeMirror();
        try {
            await field.ensureLoadedAroundWorld(0, 0, 6000);
            await field.ensureLoadedAroundWorld(25000, 0, 3000);

            // Directly under the origin the two agree.
            assert.ok(Math.abs(
                field.heightAtWorld(0, 0) - field.geodeticHeightAtWorld(0, 0),
            ) < 1e-6);

            // 25 km out the surface has fallen away by d^2/2R — which is what
            // the terrain mesh is drawn at, and what the sim must collide with.
            const drop = field.geodeticHeightAtWorld(25000, 0) - field.heightAtWorld(25000, 0);
            const expected = 25000 ** 2 / (2 * 6378137);
            assert.ok(
                Math.abs(drop - expected) < 2,
                `expected ~${expected.toFixed(0)} m of curvature drop, got ${drop.toFixed(1)}`,
            );
        } finally {
            restore();
        }
    });

    it('classifies land and water by elevation, not by scene Y', async () => {
        const { field, restore } = await makeMirror();
        try {
            // Far enough out that the curvature drop exceeds any sea-level
            // epsilon: land here must not read as water.
            await field.ensureLoadedAroundWorld(25000, 0, 3000);
            assert.ok(field.geodeticHeightAtWorld(25000, 0) > 1, 'fixture should be land');
            assert.ok(field.heightAtWorld(25000, 0) < field.geodeticHeightAtWorld(25000, 0));
            assert.equal(field.isLandAtWorld(25000, 0), true);
        } finally {
            restore();
        }
    });
});

/**
 * The regression this whole mirror exists for: the worker used to sample a
 * lattice far coarser than the DEM, which over steep relief sits well above the
 * real surface — the aircraft exploded against ground that was not there.
 */
describe('a lattice coarser than the DEM', () => {

    it('invents ground metres above the real surface', async () => {
        const { field, restore } = await makeMirror();
        try {
            await field.ensureLoadedAroundWorld(0, 0, 6000);

            const CELL = 500;
            const N = 21;
            const lattice = new Float32Array(N * N);
            for (let r = 0; r < N; r++) {
                for (let c = 0; c < N; c++) {
                    lattice[r * N + c] = field.heightAtWorld(
                        (c - (N - 1) / 2) * CELL, (r - (N - 1) / 2) * CELL,
                    );
                }
            }
            const latticeAt = (x: number, z: number) => {
                const u = x / CELL + (N - 1) / 2;
                const v = z / CELL + (N - 1) / 2;
                const x0 = Math.floor(u);
                const z0 = Math.floor(v);
                const tx = u - x0;
                const tz = v - z0;
                return lattice[z0 * N + x0] * (1 - tx) * (1 - tz)
                    + lattice[z0 * N + x0 + 1] * tx * (1 - tz)
                    + lattice[(z0 + 1) * N + x0] * (1 - tx) * tz
                    + lattice[(z0 + 1) * N + x0 + 1] * tx * tz;
            };

            let worst = 0;
            for (let z = -4000; z <= 4000; z += 50) {
                for (let x = -4000; x <= 4000; x += 50) {
                    worst = Math.max(worst, latticeAt(x, z) - field.heightAtWorld(x, z));
                }
            }
            // Well past the sim's instant-wreck penetration (3.5 m).
            assert.ok(worst > 100, `expected phantom ground, got ${worst.toFixed(1)} m`);
        } finally {
            restore();
        }
    });
});
