/**
 * One parent of the far-tile texture bake's leaves (tools/bake_planet_tex.ts):
 * its four children read, the leaves among them painted with their water,
 * roads and airfield pavement (the cached raster holds ground and buildings
 * only), the leaves with buildings shipped as their own .ptx, and the four
 * folded into the parent's .ptx. This is where the bake spends its time, so it
 * runs on the tile pool's workers and satellites (tilePool.ts, kind
 * 'texfold'). The coarser levels, a quarter as many tiles each, are folded on
 * the bake's own thread from these.
 *
 * It only writes: an empty parent comes back as `emptied`, and the bake
 * removes a stale one, as it does every leaf .ptx not shipped. A satellite
 * then need not be sent the old textures just to delete them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EnuBasis, makeEnuBasis } from '../../src/script/terrain/geodesy';
import { decodePtm } from '../../src/script/terrain/ptm';
import { LeafZoomArea, isLeafTile, leafZoomOf } from '../../src/script/terrain/leafZoom';
import { TileKey } from '../../src/script/terrain/tiling';
import {
    PTX_FLAG_WATER, PTX_HEADER_BYTES, boundsOf, decodePtx, emptyRaster, encodePtx, isEmptyRaster,
    mergeQuadrant, paintWater, quadrantOf, shrinkTo,
} from './coverTex';
import { decodeRvr } from './rvr';
import { Pavement, overlapsBounds, paintPavement, roadPavement } from './pavementTex';

export interface Raster {
    texels: Uint8Array;
    size: number;
}

export interface TexFoldConfig {
    /** The mesh tree: .ptm, .pbh in; .ptx out. */
    dir: string;
    /** The leaf raster cache. */
    cache: string;
    /** The planet pyramid: the leaves' .rvr road vectors. */
    src: string;
    enuOrigin: { lat: number; lon: number; height: number };
    /** The tree's leaf zoom and the areas capped short of it (leafZoom.ts). */
    leafZoom: number;
    areas?: LeafZoomArea[];
    /** Texels across a parent: `nearSize` from `nearZoom` up, `size` below. */
    size: number;
    nearSize: number;
    nearZoom: number;
    /** Ship the leaves that have a .pbh. */
    buildings: boolean;
    roads: boolean;
    /** Airfield pavement; a satellite is sent only the fields over its tile. */
    pavements: Pavement[];
}

/** What painting a leaf found, for the bake's summary. */
export interface PaintCounts {
    water: number;
    roads: number;
    airfields: number;
}

export interface TexFoldResult {
    key: string;
    /** The parent's .ptx bytes, or 0 when it came out empty (`emptied`). */
    gz: number;
    raw: number;
    emptied: boolean;
    /** The leaf children it considered: shipped below, or to have no .ptx. */
    leaves: string[];
    shipped: Array<{ key: string; gz: number }>;
    counts: PaintCounts;
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
export const tilePath = (dir: string, k: TileKey, ext: string) => path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

export function readPtx(p: string): Raster | undefined {
    if (!fs.existsSync(p)) {
        return undefined;
    }
    const { texels, size } = decodePtx(zlib.gunzipSync(fs.readFileSync(p)));
    return { texels, size };
}

/** A shipped raster: every one carries the leaves' water (paintedLeaf paints it in). */
export function writePtx(p: string, id: TileKey, size: number, texels: Uint8Array): number {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const gz = zlib.gzipSync(encodePtx(id, size, texels, PTX_FLAG_WATER), { level: 9 });
    fs.writeFileSync(p, gz);
    return gz.byteLength;
}

/**
 * A leaf's cached raster with its water, roads and airfields painted on, in
 * that order (a runway is not crossed by a road), or undefined when it is not
 * in the cache.
 */
export function paintedLeaf(
    dirs: { dir: string; cache: string; src: string }, basis: EnuBasis, k: TileKey,
    roads: boolean, pavements: readonly Pavement[], counts: PaintCounts,
): Raster | undefined {
    const p = tilePath(dirs.cache, k, '.ptx');
    if (!fs.existsSync(p)) {
        return undefined;
    }
    const bytes = fs.readFileSync(p);
    // A cache written before it was compressed is still readable.
    const { texels, size } = decodePtx(bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes);
    const ptmPath = tilePath(dirs.dir, k, '.ptm');
    if (fs.existsSync(ptmPath)) {
        if (paintWater(texels, size, decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath))), basis) > 0) {
            counts.water++;
        }
    }
    const kb = boundsOf(k);
    const rvrPath = tilePath(dirs.src, k, '.rvr');
    if (roads && fs.existsSync(rvrPath)) {
        const r = roadPavement(decodeRvr(fs.readFileSync(rvrPath)), kb);
        if (r !== undefined && paintPavement(texels, size, kb, [r]) > 0) {
            counts.roads++;
        }
    }
    const near = pavements.filter(pv => overlapsBounds(pv.bounds, kb));
    if (near.length > 0 && paintPavement(texels, size, kb, near) > 0) {
        counts.airfields++;
    }
    return { texels, size };
}

/** The four children of `k`. */
export function childrenOf(k: TileKey): TileKey[] {
    const out: TileKey[] = [];
    for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
            out.push({ z: k.z + 1, x: k.x * 2 + dx, y: k.y * 2 + dy });
        }
    }
    return out;
}

const leafZoomCache = new Map<string, ReturnType<typeof leafZoomOf>>();

/** Whether `child` is a leaf of the tree `cfg` describes. */
export function isFoldLeaf(cfg: Pick<TexFoldConfig, 'leafZoom' | 'areas'>, child: TileKey): boolean {
    const sig = `${cfg.leafZoom}|${JSON.stringify(cfg.areas ?? [])}`;
    let at = leafZoomCache.get(sig);
    if (!at) {
        leafZoomCache.set(sig, at = leafZoomOf(cfg.areas, cfg.leafZoom));
    }
    return isLeafTile(at, child);
}

let basisCache: { origin: string; basis: EnuBasis } | undefined;

export function texFold(cfg: TexFoldConfig, k: TileKey): TexFoldResult {
    const origin = `${cfg.enuOrigin.lat},${cfg.enuOrigin.lon},${cfg.enuOrigin.height}`;
    if (basisCache?.origin !== origin) {
        basisCache = { origin, basis: makeEnuBasis(cfg.enuOrigin.lat, cfg.enuOrigin.lon, cfg.enuOrigin.height) };
    }
    const basis = basisCache.basis;
    const size = k.z >= cfg.nearZoom ? cfg.nearSize : cfg.size;
    const parent = emptyRaster(size);
    const counts: PaintCounts = { water: 0, roads: 0, airfields: 0 };
    const leaves: string[] = [];
    const shipped: TexFoldResult['shipped'] = [];
    for (const child of childrenOf(k)) {
        let raster: Raster | undefined;
        if (isFoldLeaf(cfg, child)) {
            raster = paintedLeaf(cfg, basis, child, cfg.roads, cfg.pavements, counts);
            leaves.push(keyOf(child));
            // Leaves that carry buildings ship their raster too: their own
            // facets and houses cover the near field, this the far field.
            if (raster !== undefined && cfg.buildings && fs.existsSync(tilePath(cfg.dir, child, '.pbh')) && !isEmptyRaster(raster.texels)) {
                shipped.push({ key: keyOf(child), gz: writePtx(tilePath(cfg.dir, child, '.ptx'), child, raster.size, raster.texels) });
            }
        } else {
            // A capped area's leaf beside a finer child: that child's own
            // parent was folded a level below.
            raster = readPtx(tilePath(cfg.dir, child, '.ptx'));
        }
        if (raster === undefined) {
            continue;
        }
        const { qx, qy } = quadrantOf(child);
        mergeQuadrant(parent, size, shrinkTo(raster.texels, raster.size, size / 2), qx, qy);
    }
    const key = keyOf(k);
    if (isEmptyRaster(parent)) {
        return { key, gz: 0, raw: 0, emptied: true, leaves, shipped, counts };
    }
    const gz = writePtx(tilePath(cfg.dir, k, '.ptx'), k, size, parent);
    return { key, gz, raw: PTX_HEADER_BYTES + parent.byteLength, emptied: false, leaves, shipped, counts };
}
