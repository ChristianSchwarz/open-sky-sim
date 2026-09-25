/**
 * PLC1 - "Planet Land Cover", the per-tile observed-cover raster.
 *
 * Bake-time only, exactly like LVR1: the runtime never reads cover rasters,
 * because every facet's class and colour is resolved once in buildTile and
 * baked into the mesh. This exists so that resolution happens against the same
 * grid the heights use, without every bake run having to reproject a global
 * raster.
 *
 * Written by tools/bake_planet_cover.py, one file per DEM tile, on the same
 * `size * size` row-major geographic grid as the matching `.pdm`.
 *
 * Layout, little-endian, zlib-compressed:
 *
 *   header, 16 bytes
 *     0  u32  magic 'PLC1'
 *     4  u8   version = 1
 *     5  u8   flags
 *     6  u16  size
 *     8  u32  reserved
 *    12  u32  reserved
 *
 *   payload
 *     classes  u8    size*size      TerrainClass, 0..15
 *     colors   u8 x3 size*size      sRGB
 *
 * Both sections are always present. A bake with no imagery still writes
 * colours - the landcover class's own map colour - so a tile is never half
 * populated and the mesh bake never needs to know which sources were around.
 */

import { unzlibSync } from 'fflate';
import { CLASS_COUNT } from '../../src/script/terrain/tones';

export const PLC_MAGIC = 0x31434c50; // 'PLC1' little-endian
export const PLC_VERSION = 1;
export const PLC_HEADER_BYTES = 16;

/** Colours came from real imagery rather than from the class colour table. */
export const PLC_FLAG_REAL_IMAGERY = 1 << 0;

export interface CoverTile {
    size: number;
    flags: number;
    /** One {@link TerrainClass} per node, row-major. */
    classes: Uint8Array;
    /** Three sRGB bytes per node, row-major. */
    colors: Uint8Array;
}

/**
 * Decode a zlib-compressed PLC1 blob into a CoverTile.
 * Accepts either the raw compressed bytes or an already-inflated payload.
 */
export function decodePlc(bytes: ArrayBuffer | Uint8Array): CoverTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let payload: Uint8Array;
    if (raw.byteLength >= 4
        && raw[0] === 0x50 && raw[1] === 0x4c && raw[2] === 0x43 && raw[3] === 0x31) {
        payload = raw;
    } else {
        payload = unzlibSync(raw);
    }
    if (payload.byteLength < PLC_HEADER_BYTES) {
        throw new Error(`PLC1 too short: ${payload.byteLength}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PLC_MAGIC) {
        throw new Error(`Bad PLC1 magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint8(4);
    if (version !== PLC_VERSION) {
        throw new Error(`Unsupported PLC1 version ${version}, expected ${PLC_VERSION}`);
    }
    const flags = view.getUint8(5);
    const size = view.getUint16(6, true);
    const nodes = size * size;
    const expected = PLC_HEADER_BYTES + nodes * 4;
    if (payload.byteLength < expected) {
        throw new Error(`PLC1 truncated: ${payload.byteLength} < ${expected}`);
    }

    // Copied, not viewed: the caller keeps these past the life of the inflate
    // buffer, and unlike PTM1 this is bake-time code where a copy of a quarter
    // of a megabyte costs nothing worth optimising.
    const classes = payload.slice(PLC_HEADER_BYTES, PLC_HEADER_BYTES + nodes);
    const colors = payload.slice(PLC_HEADER_BYTES + nodes, expected);
    for (let i = 0; i < classes.length; i++) {
        if (classes[i] >= CLASS_COUNT) {
            throw new Error(`PLC1: node ${i} has class ${classes[i]} >= ${CLASS_COUNT}`);
        }
    }
    return { size, flags, classes, colors };
}

/** Encode an uncompressed PLC1 payload (used by tests). */
export function encodePlc(tile: CoverTile): Uint8Array {
    const nodes = tile.size * tile.size;
    if (tile.classes.length !== nodes) {
        throw new Error(`PLC1: classes ${tile.classes.length} != ${nodes}`);
    }
    if (tile.colors.length !== nodes * 3) {
        throw new Error(`PLC1: colors ${tile.colors.length} != ${nodes * 3}`);
    }
    const out = new Uint8Array(PLC_HEADER_BYTES + nodes * 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, PLC_MAGIC, true);
    view.setUint8(4, PLC_VERSION);
    view.setUint8(5, tile.flags);
    view.setUint16(6, tile.size, true);
    out.set(tile.classes, PLC_HEADER_BYTES);
    out.set(tile.colors, PLC_HEADER_BYTES + nodes);
    return out;
}
