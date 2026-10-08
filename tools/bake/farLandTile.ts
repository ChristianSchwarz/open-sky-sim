/**
 * One leaf's far land: read its land, strokes and rivers, simplify the land
 * at each level's tolerance (farLand.ts), and write the .pfl sidecar - or
 * remove a stale one when the leaf has nothing worth simplifying.
 */

import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../../src/script/terrain/geodesy';
import { borderEntryIndex, decodePtm } from '../../src/script/terrain/ptm';
import { decodePtr } from '../../src/script/terrain/ptr';
import { encodePfl, landFingerprint, PflLevel } from '../../src/script/terrain/pfl';
import { regionSizes } from '../../src/script/terrain/tileMesh';
import { TileKey } from '../../src/script/terrain/tiling';
import { buildFarLand } from './farLand';
import { readTileFile, tileFile, tileUp } from './railBedInputs';

export const FAR_LAND_EXT = '.pfl';

/** A level is kept only if it has at most this share of the finer one's triangles. */
const MAX_LEVEL_SHARE = 0.8;

export interface FarLandConfig {
    dir: string;
    enuOrigin: { lat: number; lon: number; height: number };
    levelsM: number[];
}

export interface FarLandResult {
    key: string;
    /** Why nothing was written, if it was not. */
    skipped?: 'no-land' | 'no-saving';
    nearTris?: number;
    levelTris?: number[];
    bytes?: number;
    ms: number;
}

export function farLandOfTile(cfg: FarLandConfig, k: TileKey): FarLandResult {
    const t0 = performance.now();
    const key = `${k.z}/${k.x}/${k.y}`;
    const out = tileFile(cfg.dir, k, FAR_LAND_EXT);
    const ptmBytes = readTileFile(cfg.dir, k, '.ptm');
    const tile = ptmBytes ? decodePtm(ptmBytes) : undefined;
    const triCount = tile ? tile.landPositions.length / 9 : 0;
    const removeStale = () => {
        if (fs.existsSync(out)) {
            fs.unlinkSync(out);
        }
    };
    if (!tile || triCount === 0) {
        removeStale();
        return { key, skipped: 'no-land', ms: performance.now() - t0 };
    }
    const rs = regionSizes(tile.landPositions, tile.landAttrs, tile.quantScale);
    const fills = new Uint8Array(triCount);
    for (let t = 0; t < triCount; t++) {
        fills[t] = rs[t * 3] > 0 ? 1 : 0;
    }
    const points: number[] = [];
    const ptrBytes = readTileFile(cfg.dir, k, '.ptr');
    if (ptrBytes) {
        const ptr = decodePtr(ptrBytes);
        for (let i = 0; i < ptr.positions.length; i++) {
            points.push(ptr.positions[i] * ptr.quantScale);
        }
    }
    for (let i = 0; i < tile.riverPositions.length; i++) {
        points.push(tile.riverPositions[i] * tile.quantScale);
    }
    const basis = makeEnuBasis(cfg.enuOrigin.lat, cfg.enuOrigin.lon, cfg.enuOrigin.height ?? 0);
    const up = tileUp(basis, k);
    const borderSlots = Uint32Array.from(tile.border?.vertices ?? [], e => borderEntryIndex(e));
    const strokePoints = Float32Array.from(points);

    const levels: PflLevel[] = [];
    let finer = triCount;
    for (const toleranceM of cfg.levelsM) {
        const r = buildFarLand({
            positions: tile.landPositions, normals: tile.landNormals, attrs: tile.landAttrs,
            quantScale: tile.quantScale, fills, regionSizes: rs, borderSlots, up, toleranceM, strokePoints,
        });
        if (r.trianglesOut > finer * MAX_LEVEL_SHARE) {
            continue;
        }
        levels.push({
            toleranceM, positions: r.positions, normals: r.normals, attrs: r.attrs,
            regionSizes: r.regionSizes, borderMap: r.borderMap,
        });
        finer = r.trianglesOut;
    }
    if (levels.length === 0) {
        removeStale();
        return { key, skipped: 'no-saving', nearTris: triCount, ms: performance.now() - t0 };
    }
    const bytes = zlib.gzipSync(encodePfl({
        id: k, quantScale: tile.quantScale, nearTriangles: triCount,
        nearFingerprint: landFingerprint(tile.landPositions), levels,
    }));
    fs.writeFileSync(out, bytes);
    return {
        key, nearTris: triCount, levelTris: levels.map(l => l.positions.length / 9),
        bytes: bytes.byteLength, ms: performance.now() - t0,
    };
}
