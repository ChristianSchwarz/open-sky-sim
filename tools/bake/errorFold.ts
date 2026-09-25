/**
 * The monotone fold of per-tile geometric error, and the sidecar that keeps
 * every tile's figures between bakes.
 *
 * A tile's own `geometricErrorM` (PTM v6) is what drawing its children
 * instead would gain: the DEM's child-detail loss plus what the decimator gave
 * up. That is a bound against the *next* level only, and it is not monotone:
 * a z10 tile whose four children happen to average out its relief can carry
 * 47 m while the z11 tile under it carries 500 m. The runtime refines a node
 * on its own figure alone - it cannot see a child's until the child is
 * resident, and a parent that believes it is 47 m off never asks for one - so
 * such a tile stayed coarse while its neighbour, with an honest figure, went
 * on to the leaves at the same distance. Porto Santo drew half at z10 and half
 * at z12, with the seam through the middle of the island (2026-09-15).
 *
 * So after the pyramid is written the figures are folded upward: a tile's
 * drawn error is the largest of its own and every tile beneath it, and that
 * is what its header carries. A parent then always refines at least as
 * eagerly as anything under it, which is the property the screen-space error
 * governor assumes. The fold is the maximum rather than the sum: the sum is
 * the rigorous bound on the departure from the finest surface, but errors
 * roughly double per level so the maximum is most of it, and the sum would
 * refine every coarse tile as if it were its own mountain.
 *
 * The sidecar remembers both the own figure and the one written to the
 * header, so a scoped re-bake re-folds the whole tree without decoding it and
 * only rewrites the headers whose figure moved.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
    readPtmGeometricError, writePtmGeometricError,
} from '../../src/script/terrain/ptm';

/** What the bake keeps per tile between runs; see {@link INDEX_META_FILE}. */
export interface TileMeta {
    /** The tile's own figure, as buildTile computed it. */
    geometricErrorM: number;
    skirtDepthM: number;
    /**
     * What the tile's header holds on disk: the folded figure once
     * {@link foldPtmErrors} has run. Absent in a sidecar written before the
     * fold existed, when the header held the own figure.
     */
    headerErrorM?: number;
}

/**
 * The bake writes every tile's header figures beside the index, keyed
 * `z/x/y`, so a scoped bake can carry the untouched tiles' figures into the
 * manifest and the fold without gunzipping and decoding hundreds of tiles.
 * A tile the sidecar does not know is still decoded.
 */
export const INDEX_META_FILE = 'index_meta.json';

interface IndexMeta {
    version: 1;
    tiles: Record<string, TileMeta>;
}

export function loadIndexMeta(dir: string): Record<string, TileMeta> {
    const p = path.join(dir, INDEX_META_FILE);
    if (!fs.existsSync(p)) {
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as IndexMeta;
        if (parsed.version !== 1 || typeof parsed.tiles !== 'object' || parsed.tiles === null) {
            console.warn(`  ignoring ${INDEX_META_FILE}: unknown layout`);
            return {};
        }
        return parsed.tiles;
    } catch (err) {
        console.warn(`  ignoring ${INDEX_META_FILE}: ${(err as Error).message}`);
        return {};
    }
}

export function saveIndexMeta(dir: string, tiles: Record<string, TileMeta>): void {
    const meta: IndexMeta = { version: 1, tiles };
    fs.writeFileSync(path.join(dir, INDEX_META_FILE), `${JSON.stringify(meta)}\n`);
}

export function tileMetaKey(z: number, x: number, y: number): string {
    return `${z}/${x}/${y}`;
}

/** The `z/x/y` key of the tile above this one, or undefined at the root. */
export function parentTileKey(key: string): string | undefined {
    const [z, x, y] = key.split('/').map(Number);
    if (!(z > 0)) {
        return undefined;
    }
    return tileMetaKey(z - 1, x >> 1, y >> 1);
}

/**
 * Fold own figures into drawn ones: each tile's is the largest of its own
 * and every present descendant's. Tiles are visited deepest first, so a
 * child's folded figure is final before its parent reads it. A parent the
 * pyramid lacks (a trimmed top, or a child under a tile that was never
 * baked) simply ends the chain.
 */
export function propagateGeometricErrors(
    own: Readonly<Record<string, number>>,
): Map<string, number> {
    const keys = Object.keys(own).sort((a, b) => Number(b.split('/')[0]) - Number(a.split('/')[0]));
    const drawn = new Map<string, number>();
    for (const key of keys) {
        const v = Math.max(own[key], drawn.get(key) ?? 0);
        drawn.set(key, v);
        const parent = parentTileKey(key);
        if (parent !== undefined && parent in own) {
            drawn.set(parent, Math.max(drawn.get(parent) ?? 0, v));
        }
    }
    return drawn;
}

export interface ErrorFoldStats {
    /** Tiles whose header figure rose above the own figure. */
    raised: number;
    /** Tiles whose header was rewritten this run. */
    rewritten: number;
    maxRaiseM: number;
    /** Per zoom: tiles raised there. */
    raisedByZoom: Map<number, number>;
}

/**
 * Fold the pyramid's errors and bring every `.ptm` header in `dir` up to its
 * folded figure. `tileMeta` is updated in place: `headerErrorM` becomes what
 * the header now holds. Returns the folded figures, for the manifest's
 * per-level maxima.
 */
export function foldPtmErrors(
    dir: string,
    tileMeta: Record<string, TileMeta>,
    stats?: ErrorFoldStats,
): Map<string, number> {
    const own: Record<string, number> = {};
    for (const [key, meta] of Object.entries(tileMeta)) {
        own[key] = meta.geometricErrorM;
    }
    const drawn = propagateGeometricErrors(own);
    for (const [key, meta] of Object.entries(tileMeta)) {
        const target = drawn.get(key)!;
        const z = Number(key.split('/')[0]);
        if (target > meta.geometricErrorM && stats) {
            stats.raised++;
            stats.maxRaiseM = Math.max(stats.maxRaiseM, target - meta.geometricErrorM);
            stats.raisedByZoom.set(z, (stats.raisedByZoom.get(z) ?? 0) + 1);
        }
        const held = meta.headerErrorM ?? meta.geometricErrorM;
        if (held === target) {
            continue;
        }
        const [, x, y] = key.split('/');
        const ptmPath = path.join(dir, String(z), x, `${y}.ptm`);
        const raw = zlib.gunzipSync(fs.readFileSync(ptmPath));
        writePtmGeometricError(raw, target);
        fs.writeFileSync(ptmPath, zlib.gzipSync(raw, { level: 9 }));
        meta.headerErrorM = target;
        if (stats) {
            stats.rewritten++;
        }
    }
    return drawn;
}

export function newErrorFoldStats(): ErrorFoldStats {
    return { raised: 0, rewritten: 0, maxRaiseM: 0, raisedByZoom: new Map() };
}

/**
 * The figure a tile's header holds on disk, for a tile the sidecar does not
 * know. Only the header is looked at; the rest of the tile is not decoded.
 */
export function readPtmHeaderError(ptmPath: string): number {
    return readPtmGeometricError(zlib.gunzipSync(fs.readFileSync(ptmPath)));
}
