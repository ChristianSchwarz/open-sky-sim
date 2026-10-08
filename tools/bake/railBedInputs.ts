/**
 * A tile's grading input (railBed.ts RailBedInput), read from the baked tiles
 * on disk: what terrainEntity.ts assembled at runtime before the grading
 * moved into the bake (tools/bake_planet_grade.ts), field for field, so the
 * bake lays the same beds the browser did.
 *
 *   land      the .ptm's land soup, as baked (normals not yet leaned towards
 *             the tile edge: the runtime does that once, on load)
 *   pinned    the seam stitcher's border vertices
 *   up        the real vertical at the tile's centre
 *   bridges   the .pbr of the tile and its eight neighbours (leaf only): deck
 *             track ends, road deck ends, every triangle, road deck tops and their tiers, all
 *             deck tops, concrete, and the tile's own border ramps; a
 *             neighbour shifted by the difference of the two tiles' origins
 *   keep      the tile's water triangles and watercourse segments, and the
 *             bridges' triangles
 *   measured  the lines' lidar profiles (leaf only), from the lidar store
 *             (lidarStore.ts, tools/measure_lidar.py), when one is given
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EnuBasis, ecefToEnu, geodeticToEcef } from '../../src/script/terrain/geodesy';
import { BridgeRole, decodePbr, pbrRole, pbrTier } from '../../src/script/terrain/pbr';
import { PtmTile, borderEntryIndex, decodePtm } from '../../src/script/terrain/ptm';
import { PtrTile, decodePtr } from '../../src/script/terrain/ptr';
import { RailBedInput, deckTrackEnds } from '../../src/script/terrain/railBed';
import { TileKey, approxTileEdgeMetres, tileBounds } from '../../src/script/terrain/tiling';
import { LidarStore } from './lidarStore';
import { measuredProfiles } from './lidarProfiles';

export const tileFile = (dir: string, k: TileKey, ext: string) => path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

/** A tile file's bytes, inflated if gzipped; undefined when absent. */
export function readTileFile(dir: string, k: TileKey, ext: string): Uint8Array | undefined {
    const p = tileFile(dir, k, ext);
    if (!fs.existsSync(p)) {
        return undefined;
    }
    const raw = fs.readFileSync(p);
    const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
    // Typed-array views want a 4-byte-aligned start.
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** The tile's origin in the bake's ENU frame: its centre at its baked centre height. */
export function tileOriginEnu(basis: EnuBasis, tile: Pick<PtmTile, 'id' | 'centerHeightM'>) {
    const b = tileBounds(tile.id);
    return ecefToEnu(basis, geodeticToEcef((b.south + b.north) / 2, (b.west + b.east) / 2, tile.centerHeightM));
}

/** The real vertical at the tile's centre in its own axes (x east, y up, z south). */
export function tileUp(basis: EnuBasis, k: TileKey): [number, number, number] {
    const b = tileBounds(k);
    const lat = (b.south + b.north) / 2, lon = (b.west + b.east) / 2;
    const e0 = ecefToEnu(basis, geodeticToEcef(lat, lon, 0));
    const e1 = ecefToEnu(basis, geodeticToEcef(lat, lon, 1000));
    return [(e1.e - e0.e) / 1000, (e1.u - e0.u) / 1000, -(e1.n - e0.n) / 1000];
}

export interface TileGradeInput {
    input: RailBedInput;
    ptmBytes: Uint8Array;
    tile: PtmTile;
    ptr: PtrTile;
}

/**
 * Everything the grading of tile `k` takes, or undefined when it has no
 * strokes. `leafZoom` is the mesh's finest level: only a leaf refines the
 * land and has bridges and measured profiles, as at runtime. A neighbour's
 * origin needs its centre height: `centreHeightOf` gives it without opening
 * the neighbour's .ptm (another worker may be rewriting it); absent, the
 * .ptm is read. `lidar`, when given, measures the leaf's lines.
 */
export function railBedInputFor(
    dir: string, k: TileKey, basis: EnuBasis, leafZoom: number,
    centreHeightOf?: (k: TileKey) => number | undefined,
    lidar?: LidarStore,
): TileGradeInput | undefined {
    const ptmBytes = readTileFile(dir, k, '.ptm');
    const ptrBytes = readTileFile(dir, k, '.ptr');
    if (!ptmBytes || !ptrBytes) {
        return undefined;
    }
    const tile = decodePtm(ptmBytes);
    const ptr = decodePtr(ptrBytes);
    const leaf = k.z === leafZoom;
    const pinned = new Set<number>();
    for (const e of tile.border?.vertices ?? []) {
        pinned.add(borderEntryIndex(e));
    }
    const input: RailBedInput = {
        land: { positions: tile.landPositions.slice(), normals: tile.landNormals.slice(), attrs: tile.landAttrs.slice() },
        quantScale: tile.quantScale,
        strokes: ptr,
        up: tileUp(basis, k),
        liftM: 0.05 * approxTileEdgeMetres(k) / 256,
        pinned,
        scale: 2 ** Math.max(0, leafZoom - k.z),
        refine: leaf,
    };
    const keepTris: number[] = [];
    // Water: lakes and sea as triangles, watercourses as segments with their half widths.
    const q = tile.quantScale;
    for (let i = 0; i < tile.waterIndices.length; i++) {
        const v = tile.waterIndices[i];
        keepTris.push(tile.waterPositions[v * 3] * q, tile.waterPositions[v * 3 + 1] * q, tile.waterPositions[v * 3 + 2] * q);
    }
    const segs: number[] = [];
    const rp = tile.riverPositions, ri = tile.riverIndices, rh = tile.riverHalfWidths;
    const seen = new Set<number>();
    for (let i = 0; i + 2 < ri.length; i += 3) {
        for (let e = 0; e < 3; e++) {
            const a = ri[i + e], b = ri[i + (e + 1) % 3];
            const key = a < b ? a * 65536 + b : b * 65536 + a;
            if (seen.has(key) || (rp[a * 3] === rp[b * 3] && rp[a * 3 + 1] === rp[b * 3 + 1] && rp[a * 3 + 2] === rp[b * 3 + 2])) {
                continue;
            }
            seen.add(key);
            segs.push(rp[a * 3] * q, rp[a * 3 + 1] * q, rp[a * 3 + 2] * q,
                rp[b * 3] * q, rp[b * 3 + 1] * q, rp[b * 3 + 2] * q, Math.max(rh[a], rh[b]) / 10);
        }
    }
    if (leaf) {
        const own = tileOriginEnu(basis, tile);
        const ends: number[] = [], tris: number[] = [], roadDecks: number[] = [], roadDeckTiers: number[] = [], roadEnds: number[] = [];
        const deckTops: number[] = [], deckTopTiers: number[] = [], concrete: number[] = [];
        let ramps: Float64Array | undefined;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nb: TileKey = { z: k.z, x: k.x + dx, y: k.y + dy };
                const pbrBytes = readTileFile(dir, nb, '.pbr');
                if (!pbrBytes) {
                    continue;
                }
                const pbr = decodePbr(pbrBytes);
                let ox = 0, oy = 0, oz = 0;
                if (dx !== 0 || dy !== 0) {
                    let h = centreHeightOf?.(nb);
                    if (h === undefined && !centreHeightOf) {
                        const nbPtm = readTileFile(dir, nb, '.ptm');
                        h = nbPtm ? decodePtm(nbPtm).centerHeightM : undefined;
                    }
                    if (h === undefined) {
                        continue;
                    }
                    const theirs = tileOriginEnu(basis, { id: nb, centerHeightM: h });
                    ox = theirs.e - own.e;
                    oy = theirs.u - own.u;
                    oz = own.n - theirs.n;
                } else if (pbr.ramps) {
                    ramps = Float64Array.from(pbr.ramps);
                }
                for (let i = 0; pbr.roadEnds && i + 6 < pbr.roadEnds.length; i += 7) {
                    const R = pbr.roadEnds;
                    roadEnds.push(R[i] + ox, R[i + 1] + oy, R[i + 2] + oz, R[i + 3], R[i + 4] + ox, R[i + 5] + oy, R[i + 6] + oz);
                }
                if (pbr.indices.length === 0) {
                    continue;
                }
                if (pbr.track && pbr.track.indices.length > 0) {
                    const e = deckTrackEnds(pbr.track, pbr.quantScale);
                    for (let i = 0; i < e.length; i += 3) {
                        ends.push(e[i] + ox, e[i + 1] + oy, e[i + 2] + oz);
                    }
                }
                const pq = pbr.quantScale, P = pbr.positions;
                for (let j = 0; j < pbr.indices.length; j++) {
                    const vi = pbr.indices[j];
                    const x = P[vi * 3] * pq + ox, y = P[vi * 3 + 1] * pq + oy, z = P[vi * 3 + 2] * pq + oz;
                    tris.push(x, y, z);
                    const byte = pbr.normals[pbr.indices[j - j % 3] * 4 + 3];
                    const role = pbrRole(byte);
                    if (role === BridgeRole.Deck) {
                        roadDecks.push(x, y, z);
                        if (j % 3 === 0) {
                            roadDeckTiers.push(pbrTier(byte));
                        }
                    }
                    if (role === BridgeRole.Deck || role === BridgeRole.RailDeck) {
                        deckTops.push(x, y, z);
                        if (j % 3 === 0) {
                            deckTopTiers.push(pbrTier(byte));
                        }
                    } else if (role === BridgeRole.Concrete) {
                        concrete.push(x, y, z);
                    }
                }
            }
        }
        const f64 = (a: number[]) => (a.length > 0 ? Float64Array.from(a) : undefined);
        input.deckEnds = f64(ends);
        input.roadDeckEnds = f64(roadEnds);
        input.roadDecks = f64(roadDecks);
        input.roadDeckTiers = roadDeckTiers.length > 0 ? Int8Array.from(roadDeckTiers) : undefined;
        input.deckTops = f64(deckTops);
        input.deckTopTiers = deckTopTiers.length > 0 ? Int8Array.from(deckTopTiers) : undefined;
        input.deckConcrete = f64(concrete);
        input.borderRamps = ramps;
        // (A loop: spread, a city's bridges - hundreds of thousands of
        // coordinates - overflowed the call stack.)
        for (let i = 0; i < tris.length; i++) {
            keepTris.push(tris[i]);
        }
        if (lidar?.tile(k)) {
            const m = measuredProfiles(lidar, k, tile, ptr, basis);
            if (m.measured > 0) {
                input.measured = { segments: m.segments, mode: 'rel' };
            }
        }
    }
    input.keep = {
        tris: keepTris.length > 0 ? Float64Array.from(keepTris) : undefined,
        segs: segs.length > 0 ? Float64Array.from(segs) : undefined,
    };
    return { input, ptmBytes, tile, ptr };
}
