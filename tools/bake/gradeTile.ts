/**
 * One tile of the grading bake (tools/bake_planet_grade.ts): read its
 * grading input from disk (railBedInputs.ts), lay the beds (railBed.ts
 * layRailBeds, the code the browser used to run), and write back
 *
 *   .ptm  the land with the beds in it, PTM_FLAG_GRADED set
 *   .ptr  the strokes on their profiles, vertices inserted, PTR_TILE_GRADED
 *   .pbd  the beds (simplified) and the retaining walls, for collision, the
 *         trees and the walls' mesh (pbd.ts); removed when there are none
 *
 * Every file is written to a temporary name and renamed over the old, so a
 * neighbour's worker never reads half a file. A tile already graded is left
 * alone: grading it again would lay the beds on its own beds.
 */

import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../../src/script/terrain/geodesy';
import { decodePbd, encodePbd, simplifyBeds } from '../../src/script/terrain/pbd';
import { isPtmGraded, writePtmLand } from '../../src/script/terrain/ptm';
import { PTR_MAX_VERTS, PTR_TILE_GRADED, PtrTile, encodePtrRaw } from '../../src/script/terrain/ptr';
import { RAIL_BED_SEGMENT_FLOATS, layRailBeds } from '../../src/script/terrain/railBed';
import { TileKey } from '../../src/script/terrain/tiling';
import { LidarStore } from './lidarStore';
import { readTileFile, railBedInputFor, tileFile, tileOriginEnu } from './railBedInputs';

export interface GradeConfig {
    dir: string;
    enuOrigin: { lat: number; lon: number; height: number };
    leafZoom: number;
    /** Baked centre height of every tile a neighbour may be read from, by 'z/x/y'. */
    centreHeights: Record<string, number>;
    /**
     * Grade the leaves with their neighbours' beds and a free border
     * (railBed.ts RailBedInput.freeBorder): the first pass (bedsOfTile) has
     * written every leaf's beds to a .pbd1 for its neighbours to read.
     */
    freeBorder: boolean;
    /**
     * The lidar store (tools/measure_lidar.py) the leaves' lines are fitted
     * to, and the planet pyramid its signatures are checked against; absent,
     * the beds follow the land alone.
     */
    lidar?: { store: string; planet: string };
}

let lidarStore: LidarStore | undefined;

/** The worker's store, one per process: its leaves are shared between neighbouring tiles. */
function storeFor(cfg: GradeConfig): LidarStore | undefined {
    if (!cfg.lidar) {
        return undefined;
    }
    if (!lidarStore || lidarStore.dir !== cfg.lidar.store) {
        lidarStore = new LidarStore(cfg.lidar.store, cfg.lidar.planet);
    }
    return lidarStore;
}

/** The first pass's beds, for the neighbours: removed when the bake ends. */
export const PASS1_EXT = '.pbd1';

export interface GradeResult {
    key: string;
    z: number;
    skipped?: 'graded' | 'no-strokes';
    landTris?: number;
    trianglesAdded?: number;
    wallTriangles?: number;
    underpinTriangles?: number;
    spikesLowered?: number;
    overLimitM?: number;
    beds?: number;
    bedsWritten?: number;
    /** Bytes on disk (gzip) of .ptm + .ptr + .pbd, before and after. */
    bytesBefore?: number;
    bytesAfter?: number;
    ms?: number;
}

const sizeOf = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

/** Write `bytes` gzipped to `p` through a temporary file. */
function writeGz(p: string, bytes: Uint8Array): void {
    const tmp = `${p}.tmp${process.pid}`;
    fs.writeFileSync(tmp, zlib.gzipSync(bytes, { level: 9 }));
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(tmp, p);
            return;
        } catch (err) {
            // Windows refuses a rename over a file another process has open
            // for a moment (a neighbour's worker reading its .pbr is not this
            // file, but a virus scanner may be).
            if (attempt >= 20) {
                throw err;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}

/**
 * First pass: a leaf's beds only, written to its .pbd1 for the neighbours
 * (the beds do not depend on the land, only on the lines, the land under
 * them and the bridges). A tile graded already keeps its .pbd, which the
 * neighbours read instead.
 */
export function bedsOfTile(cfg: GradeConfig, k: TileKey): GradeResult {
    const key = `${k.z}/${k.x}/${k.y}`;
    const t0 = performance.now();
    const basis = makeEnuBasis(cfg.enuOrigin.lat, cfg.enuOrigin.lon, cfg.enuOrigin.height);
    const g = railBedInputFor(cfg.dir, k, basis, cfg.leafZoom, nb => cfg.centreHeights[`${nb.z}/${nb.x}/${nb.y}`], storeFor(cfg));
    if (!g) {
        return { key, z: k.z, skipped: 'no-strokes' };
    }
    if (isPtmGraded(g.tile)) {
        return { key, z: k.z, skipped: 'graded' };
    }
    const r = layRailBeds({ ...g.input, freeBorder: true, bedsOnly: true });
    const beds = r ? simplifyBeds(r.beds) : new Float64Array(0);
    writeGz(tileFile(cfg.dir, k, PASS1_EXT), encodePbd({ id: k, quantScale: g.tile.quantScale, beds }));
    return { key, z: k.z, beds: beds.length / RAIL_BED_SEGMENT_FLOATS, ms: performance.now() - t0 };
}

/** The eight neighbours' beds (first pass, or graded), moved into tile `k`'s frame. */
export function neighbourBeds(cfg: GradeConfig, k: TileKey, basis: ReturnType<typeof makeEnuBasis>, ownCentreH: number): Float64Array {
    const own = tileOriginEnu(basis, { id: k, centerHeightM: ownCentreH });
    const out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) {
                continue;
            }
            const nb: TileKey = { z: k.z, x: k.x + dx, y: k.y + dy };
            const h = cfg.centreHeights[`${nb.z}/${nb.x}/${nb.y}`];
            const bytes = readTileFile(cfg.dir, nb, PASS1_EXT) ?? readTileFile(cfg.dir, nb, '.pbd');
            if (h === undefined || !bytes) {
                continue;
            }
            const theirs = tileOriginEnu(basis, { id: nb, centerHeightM: h });
            const ox = theirs.e - own.e, oy = theirs.u - own.u, oz = own.n - theirs.n;
            const B = decodePbd(bytes).beds;
            for (let o = 0; o < B.length; o += RAIL_BED_SEGMENT_FLOATS) {
                out.push(B[o] + ox, B[o + 1] + oy, B[o + 2] + oz, B[o + 3] + ox, B[o + 4] + oy, B[o + 5] + oz,
                    ...B.subarray(o + 6, o + RAIL_BED_SEGMENT_FLOATS));
            }
        }
    }
    return Float64Array.from(out);
}

export function gradeTile(cfg: GradeConfig, k: TileKey): GradeResult {
    const key = `${k.z}/${k.x}/${k.y}`;
    const t0 = performance.now();
    const basis = makeEnuBasis(cfg.enuOrigin.lat, cfg.enuOrigin.lon, cfg.enuOrigin.height);
    const g = railBedInputFor(cfg.dir, k, basis, cfg.leafZoom, nb => cfg.centreHeights[`${nb.z}/${nb.x}/${nb.y}`], storeFor(cfg));
    if (!g) {
        return { key, z: k.z, skipped: 'no-strokes' };
    }
    if (isPtmGraded(g.tile) || ((g.ptr.tileFlags ?? 0) & PTR_TILE_GRADED) !== 0) {
        return { key, z: k.z, skipped: 'graded' };
    }
    const ptmPath = tileFile(cfg.dir, k, '.ptm'), ptrPath = tileFile(cfg.dir, k, '.ptr'), pbdPath = tileFile(cfg.dir, k, '.pbd');
    const bytesBefore = sizeOf(ptmPath) + sizeOf(ptrPath) + sizeOf(pbdPath);
    const leafFree = cfg.freeBorder && k.z === cfg.leafZoom;
    const r = layRailBeds(leafFree
        ? { ...g.input, freeBorder: true, neighbourBeds: neighbourBeds(cfg, k, basis, g.tile.centerHeightM) }
        : g.input);

    // The land, graded or as it was: either way the tile is now the
    // grading's, and the stages before it refuse it.
    const land = r?.land ?? { positions: g.tile.landPositions, normals: g.tile.landNormals, attrs: g.tile.landAttrs };
    writeGz(ptmPath, writePtmLand(g.ptmBytes, land));

    const strokes: PtrTile = r
        ? { ...g.ptr, ...(r.strokes ?? {}), positions: r.strokes?.positions ?? r.strokePositions }
        : g.ptr;
    if (strokes.positions.length / 3 > PTR_MAX_VERTS) {
        throw new Error(`${key}: ${strokes.positions.length / 3} stroke vertices after grading exceed ${PTR_MAX_VERTS}`);
    }
    const indices = strokes.indices instanceof Uint16Array ? strokes.indices : Uint16Array.from(strokes.indices);
    writeGz(ptrPath, encodePtrRaw({ ...strokes, indices }, PTR_TILE_GRADED));

    const beds = r ? simplifyBeds(r.beds) : new Float64Array(0);
    if (beds.length > 0 || r?.walls) {
        writeGz(pbdPath, encodePbd({ id: k, quantScale: g.tile.quantScale, beds, walls: r?.walls }));
    } else if (fs.existsSync(pbdPath)) {
        fs.unlinkSync(pbdPath);
    }
    return {
        key, z: k.z,
        landTris: land.positions.length / 9,
        trianglesAdded: r?.stats.trianglesAdded ?? 0,
        wallTriangles: r?.stats.wallTriangles ?? 0,
        underpinTriangles: r?.stats.underpinTriangles ?? 0,
        spikesLowered: r?.stats.spikesLowered ?? 0,
        overLimitM: r?.stats.overLimitM ?? 0,
        beds: r ? r.beds.length / RAIL_BED_SEGMENT_FLOATS : 0,
        bedsWritten: beds.length / RAIL_BED_SEGMENT_FLOATS,
        bytesBefore,
        bytesAfter: sizeOf(ptmPath) + sizeOf(ptrPath) + sizeOf(pbdPath),
        ms: performance.now() - t0,
    };
}
