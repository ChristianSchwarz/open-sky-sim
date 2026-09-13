/**
 * PTX1 - "Planet Tile teXture", the far-tile cover texture.
 *
 * One raster per coarse tile, `size` texels across its lon/lat box, row 0 at
 * the north edge and column 0 at the west edge. Every texel is the same four
 * bytes a land vertex carries - `r, g, b, TerrainClass` - so the fragment
 * program resolves it through the same palette code as a facet and the four
 * colour modes stay a uniform write. Alpha {@link PTX_NO_DATA} marks a texel
 * that carries nothing (sea, or ground never baked to the leaf zoom); the
 * shader falls back to the facet colour there.
 *
 * Layout, little-endian, 16-byte header then raw RGBA8, `size * size * 4`:
 *
 *    0  u32  magic 'PTX1'      8  u16  x
 *    4  u8   version = 1      10  u16  y
 *    5  u8   z                12  u16  size
 *    6  u16  reserved         14  u16  reserved
 *
 * Decode is a typed-array view over the received buffer, the same rule PTM1
 * lives by: no per-texel pass at load time. Written by
 * tools/bake_planet_tex.ts; see docs/terrain-far-textures.md.
 */

import { TileKey } from './tiling';

export const PTX_MAGIC = 0x31585450; // 'PTX1' little-endian
export const PTX_VERSION = 1;
export const PTX_HEADER_BYTES = 16;
/** The alpha (class) byte that marks a texel as carrying nothing. */
export const PTX_NO_DATA = 255;

export interface PtxTile {
    id: TileKey;
    size: number;
    /** RGBA8, `size * size * 4`, row 0 north, column 0 west. */
    texels: Uint8Array;
}

export function encodePtx(id: TileKey, size: number, texels: Uint8Array): Uint8Array {
    if (texels.byteLength !== size * size * 4) {
        throw new Error(`PTX1: ${texels.byteLength} bytes is not ${size}x${size} RGBA`);
    }
    if (size > 0xffff || id.x > 0xffff || id.y > 0xffff || id.z > 0xff) {
        throw new Error(`PTX1: ${id.z}/${id.x}/${id.y} @ ${size} does not fit the header`);
    }
    const out = new Uint8Array(PTX_HEADER_BYTES + texels.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, PTX_MAGIC, true);
    view.setUint8(4, PTX_VERSION);
    view.setUint8(5, id.z);
    view.setUint16(8, id.x, true);
    view.setUint16(10, id.y, true);
    view.setUint16(12, size, true);
    out.set(texels, PTX_HEADER_BYTES);
    return out;
}

export function decodePtx(bytes: ArrayBuffer | Uint8Array): PtxTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteLength < PTX_HEADER_BYTES) {
        throw new Error(`PTX1 too short: ${raw.byteLength}`);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PTX_MAGIC) {
        throw new Error(`Bad PTX1 magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint8(4);
    if (version !== PTX_VERSION) {
        throw new Error(`PTX1 version ${version}, expected ${PTX_VERSION}`);
    }
    const z = view.getUint8(5);
    const x = view.getUint16(8, true);
    const y = view.getUint16(10, true);
    const size = view.getUint16(12, true);
    const byteCount = size * size * 4;
    if (raw.byteLength < PTX_HEADER_BYTES + byteCount) {
        throw new Error(`PTX1 ${z}/${x}/${y}: ${raw.byteLength} bytes for a ${size}x${size} raster`);
    }
    return {
        id: { z, x, y },
        size,
        texels: raw.subarray(PTX_HEADER_BYTES, PTX_HEADER_BYTES + byteCount),
    };
}
