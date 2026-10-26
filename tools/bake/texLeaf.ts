/**
 * One leaf of the far-tile texture bake (tools/bake_planet_tex.ts): its land
 * facets, and its buildings' footprints when it has them, rasterised top-down
 * into the leaf cache. A pure function of the leaf's .ptm and .pbh, so leaves
 * run on the tile pool's workers and satellites (tilePool.ts); the cache's
 * meta, the fold up the pyramid and the index stay with the bake.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EnuBasis, makeEnuBasis } from '../../src/script/terrain/geodesy';
import { decodePtm } from '../../src/script/terrain/ptm';
import { decodePbh } from '../../src/script/terrain/pbh';
import { encodePtx, rasterizeLeaf } from './coverTex';
import { TileKey } from '../../src/script/terrain/tiling';

export interface TexLeafConfig {
    /** The mesh tree. */
    dir: string;
    /** The leaf raster cache. */
    cache: string;
    enuOrigin: { lat: number; lon: number; height: number };
    /** Texels across a leaf raster. */
    leafSize: number;
    supersample: number;
    /** Paint the .pbh footprints in. */
    buildings: boolean;
}

export interface TexLeafResult {
    key: string;
    /** False when the leaf has no .ptm (listed in the index but absent). */
    rasterised: boolean;
}

const tilePath = (dir: string, k: TileKey, ext: string) => path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

let basis: { origin: string; basis: EnuBasis } | undefined;

export function texLeaf(cfg: TexLeafConfig, k: TileKey): TexLeafResult {
    const key = `${k.z}/${k.x}/${k.y}`;
    const ptmPath = tilePath(cfg.dir, k, '.ptm');
    if (!fs.existsSync(ptmPath)) {
        return { key, rasterised: false };
    }
    const origin = `${cfg.enuOrigin.lat},${cfg.enuOrigin.lon},${cfg.enuOrigin.height}`;
    if (basis?.origin !== origin) {
        basis = { origin, basis: makeEnuBasis(cfg.enuOrigin.lat, cfg.enuOrigin.lon, cfg.enuOrigin.height) };
    }
    const pbhPath = tilePath(cfg.dir, k, '.pbh');
    const pbh = cfg.buildings && fs.existsSync(pbhPath) ? decodePbh(zlib.gunzipSync(fs.readFileSync(pbhPath))) : undefined;
    const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
    const raster = rasterizeLeaf(tile, basis.basis, cfg.leafSize, pbh, cfg.supersample);
    const cachePath = tilePath(cfg.cache, k, '.ptx');
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // Lightly compressed: a megabyte of mostly flat colour per leaf shrinks
    // twentyfold, and the cache holds thousands of them.
    fs.writeFileSync(cachePath, zlib.gzipSync(encodePtx(k, cfg.leafSize, raster), { level: 1 }));
    return { key, rasterised: true };
}
