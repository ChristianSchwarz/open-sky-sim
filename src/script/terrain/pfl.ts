/**
 * PFL1: a leaf tile's far land, the sidecar the far levels of its land mesh
 * travel in (see tools/bake/farLand.ts for how they are made, and
 * TerrainEntity for when they are drawn).
 *
 * Each level is the leaf's land at a vertical tolerance, laid out like the
 * PTM's land - non-indexed, quantised in the leaf's own step - plus each
 * corner's land-use region width (the near tile's, so reveal by size behaves
 * the same) and the corners on the tile border with the near slot each must
 * follow when the seam stitcher moves the border.
 *
 * The header carries a fingerprint of the near land it was made from. A leaf
 * re-meshed or re-graded since no longer matches, and its sidecar is ignored
 * rather than drawn with borders that point at the wrong slots.
 *
 *   0  u32 magic 'PFL1'     4  u8 version, u8 z, u8 levels, u8 pad
 *   8  u32 x               12  u32 y
 *  16  f32 quantScale      20  u32 near triangle count
 *  24  u32 near fingerprint 28 u32 reserved
 *  then per level: f32 tolerance, u32 triangles, u32 border pairs, u32 pad,
 *  positions i16 x9/tri, normals i8 x12/tri, attrs u8 x12/tri,
 *  region widths u16 x3/tri, border map u32 x2/pair, each section 4-aligned.
 */

export const PFL_MAGIC = 0x314c4650; // 'PFL1' little-endian
export const PFL_VERSION = 1;
const HEADER_BYTES = 32;
const LEVEL_HEADER_BYTES = 16;

export interface PflLevel {
    toleranceM: number;
    positions: Int16Array;
    normals: Int8Array;
    attrs: Uint8Array;
    regionSizes: Uint16Array;
    /** Pairs: a corner of this level, and the near land slot it follows. */
    borderMap: Uint32Array;
}

export interface PflTile {
    id: { z: number; x: number; y: number };
    quantScale: number;
    nearTriangles: number;
    nearFingerprint: number;
    /** Finest first. */
    levels: PflLevel[];
}

function align4(n: number): number {
    return (n + 3) & ~3;
}

/**
 * A cheap, order-sensitive checksum of a land position array: enough to tell
 * a re-baked leaf from the one a sidecar was made from.
 */
export function landFingerprint(positions: Int16Array): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < positions.length; i++) {
        h = Math.imul(h ^ (positions[i] & 0xffff), 0x01000193);
    }
    return h >>> 0;
}

export function encodePfl(tile: PflTile): Uint8Array {
    let size = HEADER_BYTES;
    for (const l of tile.levels) {
        const tris = l.positions.length / 9;
        size += LEVEL_HEADER_BYTES + align4(tris * 18) + tris * 12 + tris * 12 + align4(tris * 6) + l.borderMap.byteLength;
    }
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, PFL_MAGIC, true);
    view.setUint8(4, PFL_VERSION);
    view.setUint8(5, tile.id.z);
    view.setUint8(6, tile.levels.length);
    view.setUint32(8, tile.id.x, true);
    view.setUint32(12, tile.id.y, true);
    view.setFloat32(16, tile.quantScale, true);
    view.setUint32(20, tile.nearTriangles, true);
    view.setUint32(24, tile.nearFingerprint, true);
    let off = HEADER_BYTES;
    const put = (bytes: ArrayBufferView) => {
        out.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), off);
        off = align4(off + bytes.byteLength);
    };
    for (const l of tile.levels) {
        const tris = l.positions.length / 9;
        view.setFloat32(off, l.toleranceM, true);
        view.setUint32(off + 4, tris, true);
        view.setUint32(off + 8, l.borderMap.length / 2, true);
        off += LEVEL_HEADER_BYTES;
        put(l.positions);
        put(l.normals);
        put(l.attrs);
        put(l.regionSizes);
        put(l.borderMap);
    }
    return out;
}

export function decodePfl(bytes: ArrayBuffer | Uint8Array): PflTile {
    let raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteOffset % 4 !== 0) {
        raw = new Uint8Array(raw);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw.byteLength < HEADER_BYTES || view.getUint32(0, true) !== PFL_MAGIC) {
        throw new Error('Not a PFL1 tile');
    }
    const version = view.getUint8(4);
    if (version !== PFL_VERSION) {
        throw new Error(`PFL1 version ${version}, expected ${PFL_VERSION}`);
    }
    const levelCount = view.getUint8(6);
    const tile: PflTile = {
        id: { z: view.getUint8(5), x: view.getUint32(8, true), y: view.getUint32(12, true) },
        quantScale: view.getFloat32(16, true),
        nearTriangles: view.getUint32(20, true),
        nearFingerprint: view.getUint32(24, true),
        levels: [],
    };
    let off = HEADER_BYTES;
    const take = <T>(ctor: new (b: ArrayBufferLike, o: number, n: number) => T, count: number, bytesPer: number): T => {
        const need = count * bytesPer;
        if (off + need > raw.byteLength) {
            throw new Error('PFL1 truncated');
        }
        const v = new ctor(raw.buffer, raw.byteOffset + off, count);
        off = align4(off + need);
        return v;
    };
    for (let i = 0; i < levelCount; i++) {
        if (off + LEVEL_HEADER_BYTES > raw.byteLength) {
            throw new Error('PFL1 truncated');
        }
        const toleranceM = view.getFloat32(off, true);
        const tris = view.getUint32(off + 4, true);
        const pairs = view.getUint32(off + 8, true);
        off += LEVEL_HEADER_BYTES;
        tile.levels.push({
            toleranceM,
            positions: take(Int16Array, tris * 9, 2),
            normals: take(Int8Array, tris * 12, 1),
            attrs: take(Uint8Array, tris * 12, 1),
            regionSizes: take(Uint16Array, tris * 3, 2),
            borderMap: take(Uint32Array, pairs * 2, 4),
        });
    }
    return tile;
}
