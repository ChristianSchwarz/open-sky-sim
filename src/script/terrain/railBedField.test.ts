import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemTile, decodePdm, encodePdmUncompressed } from './demTile';
import { makeEnuBasis } from './geodesy';
import { HeightField } from './heightField';
import { HeightFieldSender, MirroredHeightField } from './heightMirror';
import { TerrainManifest } from './manifest';
import { BED_OPEN_B, RAIL_BED_SEGMENT_FLOATS, buildRailBedExclusion } from './railBed';
import { RAIL_FIELD_SEGMENT_FLOATS, RailBedField } from './railBedField';
import { tileKeyString } from './tiling';
import { TileStore } from './tileStore';

const LAT = 47.5;
const LON = 11.1;
const M_PER_DEG_LON = 111_320 * Math.cos(LAT * Math.PI / 180);
const M_PER_DEG_LAT = 110_574;

/** One bed 400 m long, west to east through (LAT, LON), at `h`, half width 2 m. */
function bed(h: number): Float64Array {
    const segs = new Float64Array(RAIL_FIELD_SEGMENT_FLOATS);
    segs.set([LON - 200 / M_PER_DEG_LON, LAT, h, LON + 200 / M_PER_DEG_LON, LAT, h, 2]);
    return segs;
}

/** (LAT, LON) moved `north` metres. */
const north = (m: number) => LAT + m / M_PER_DEG_LAT;

describe('RailBedField', () => {
    it('puts the ground on the bed, and within the batter beside it', () => {
        const field = new RailBedField();
        field.set('12/1/1', bed(500));
        // On the bed and its shoulder: the design height, whatever the DEM says.
        assert.equal(field.clamp(LON, LAT, 480), 500);
        assert.equal(field.clamp(LON, north(2.5), 530), 500);
        // 10 m out: 10 - 2 - 0.8 = 7.2 m of batter, so within 3.6 m of the bed.
        assert.ok(Math.abs(field.clamp(LON, north(10), 480) - (500 - 3.6)) < 0.01);
        assert.ok(Math.abs(field.clamp(LON, north(10), 520) - (500 + 3.6)) < 0.01);
        // Ground the batter already allows is left alone.
        assert.equal(field.clamp(LON, north(10), 502), 502);
        // Past the batter's reach, nothing.
        assert.equal(field.clamp(LON, north(60), 400), 400);
    });

    it('stops square at an open end, so a bridge span keeps its ground', () => {
        const field = new RailBedField();
        const segs = bed(500);
        segs[7] = BED_OPEN_B;
        field.set('b', segs);
        const east = (m: number) => LON + m / M_PER_DEG_LON;
        // Just inside the east end: the bed. Past it, under the span: untouched.
        assert.equal(field.clamp(east(199), LAT, 480), 500);
        assert.equal(field.clamp(east(205), LAT, 480), 480);
        // The closed west end is still rounded off by its batter.
        assert.ok(field.clamp(LON - 205 / M_PER_DEG_LON, LAT, 480) > 480);
    });

    it('forgets a deleted tile and keeps a version for senders', () => {
        const field = new RailBedField();
        const v0 = field.version;
        field.set('a', bed(500));
        assert.ok(field.version > v0);
        field.delete('a');
        assert.equal(field.clamp(LON, LAT, 480), 480);
        assert.equal(field.size, 0);
    });
});

describe('rail beds in the collision mirror', () => {
    const ORIGIN = { lat: LAT, lon: LON, height: 0 };
    const TILE_SIZE = 65;

    function manifest(): TerrainManifest {
        return {
            version: 4, scheme: 'retro-terrain/1', ellipsoid: 'WGS84', seaLevel: 0,
            coverage: { west: 10.5, south: 47, east: 11.5, north: 48 },
            enuOrigin: ORIGIN,
            mesh: {
                path: '{z}/{x}/{y}.ptm', indexPath: 'i', minZoom: 0, maxZoom: 12,
                encoding: 'PTM1', triangleBudget: 6144, levelGeometricErrorM: [], levelSkirtDepthM: [],
            },
            height: {
                path: '{z}/{x}/{y}.pdm', indexPath: 'i', tileSize: TILE_SIZE,
                minZoom: 0, maxZoom: 11, queryZoom: 11, coarseZoom: 7,
            },
            flattenPads: [],
        };
    }

    it('carries the beds to the worker, and their removal', async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            const grid = new Float32Array(TILE_SIZE * TILE_SIZE).fill(700);
            const bytes = encodePdmUncompressed(grid, TILE_SIZE, 0);
            return {
                ok: true, status: 200,
                arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            } as Response;
        }) as typeof fetch;
        try {
            const store = new TileStore<DemTile>({
                baseUrl: 'b', url: (id) => `b/${tileKeyString(id)}.pdm`, decode: (buf) => decodePdm(buf),
                sizeOf: (t) => t.heights.byteLength, maxBytes: 50_000_000, retryBackoffMs: 1,
            });
            const basis = makeEnuBasis(LAT, LON, 0);
            const field = new HeightField({ manifest: manifest(), store, basis });
            await field.loadCoarse();
            await field.ensureLoadedAroundWorld(0, 0, 2000);
            const mirror = new MirroredHeightField();
            mirror.configure({ basis, seaLevel: 0, queryZoom: 11, coarseZoom: 7, pads: [] });
            const sender = new HeightFieldSender(field, u => mirror.applyTiles(u));
            sender.sendCoarse();
            sender.update([{ x: 0, z: 0 }], 2000);

            assert.ok(Math.abs(field.geodeticHeightAtWorld(0, 0) - 700) < 0.5, 'flat DEM first');
            field.railBeds.set('12/1/1', bed(704));
            assert.ok(Math.abs(field.geodeticHeightAtWorld(0, 0) - 704) < 0.01, 'the render thread sees the bed');
            sender.update([{ x: 0, z: 0 }], 2000);
            assert.equal(mirror.geodeticHeightAtWorld(0, 0), field.geodeticHeightAtWorld(0, 0), 'and so does the worker');
            assert.equal(mirror.heightAtWorld(0, 0), field.heightAtWorld(0, 0));

            field.railBeds.delete('12/1/1');
            sender.update([{ x: 0, z: 0 }], 2000);
            assert.ok(Math.abs(mirror.geodeticHeightAtWorld(0, 0) - 700) < 0.5, 'dropped in the worker too');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('buildRailBedExclusion', () => {
    it('keeps scatter off the bed and its batters, wider where the bed leaves the ground more', () => {
        // Two beds along x in a y-up tile frame: one level with the ground, one on a 4 m embankment.
        const beds = new Float64Array(2 * RAIL_BED_SEGMENT_FLOATS);
        beds.set([-100, 0, 0, 100, 0, 0, 2, 0], 0);
        beds.set([-100, 0, 500, 100, 0, 500, 2, 4], RAIL_BED_SEGMENT_FLOATS);
        const onBed = buildRailBedExclusion(beds, [0, 1, 0])!;
        assert.ok(onBed(0, 0, 0));
        assert.ok(onBed(0, 0, 5), 'within half + shoulder + margin of the level bed');
        assert.ok(!onBed(0, 0, 7), 'past it');
        // 4 m high: 8 m of batter on top of the 2.8 m bed and 3 m margin.
        assert.ok(onBed(0, 0, 513));
        assert.ok(!onBed(0, 0, 515));
        assert.equal(buildRailBedExclusion(new Float64Array(0), [0, 1, 0]), undefined);
    });
});
