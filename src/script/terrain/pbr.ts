/**
 * PBR1 - "Planet Tile Bridges", the bridge geometry sidecar of a mesh tile.
 *
 * Flat-shaded triangles: the decks, parapets, piers and abutments a leaf
 * tile's bridges are built from, in the tile's own frame, axes and
 * quantisation step so the runtime binds them into the tile's group
 * untouched. Written by tools/bake_planet_bridges.ts from the .rbr spans and
 * the finished .ptm, which is the only thing that knows the surface a pier
 * has to stand on.
 *
 * Layout, little-endian, 24-byte header:
 *
 *    0  u32  magic 'PBR1'        8  u32  x
 *    4  u8   version = 1        12  u32  y
 *    5  u8   z                  16  f32  quantScale
 *    6  u16  reserved           20  u16  vertCount   22  u16  triCount
 *
 *   payload, each section padded to a 4-byte boundary
 *     pos    i16 x3 per vertex   position / quantScale
 *     nrm    i8  x4 per vertex   unit face normal /127 + BridgeRole byte
 *     idx    u16 x3 per triangle
 *
 * Decode is typed-array views over the received buffer, no per-vertex pass.
 */

import { TileKey } from './tiling';

const PBR_MAGIC = 0x31524250; // 'PBR1' little-endian
const PBR_VERSION = 1;
const PBR_HEADER_BYTES = 24;
export const PBR_MAX_VERTS = 65535;

/** The fourth byte of `nrm`: which material a face takes. */
export const enum BridgeRole {
    /** Road surface on top of a deck. */
    Deck = 0,
    /** Everything else: undersides, sides, parapets, piers, abutments. */
    Concrete = 1,
}

export interface PbrEncodeInput {
    id: TileKey;
    quantScale: number;
    /** 3 floats per vertex, tile-local metres. */
    positions: Float32Array;
    /** 3 floats per vertex, unit. */
    normals: Float32Array;
    /** 1 byte per vertex, a BridgeRole. */
    roles: Uint8Array;
    /** 3 indices per triangle. */
    indices: Uint32Array;
}

export interface PbrTile {
    id: TileKey;
    quantScale: number;
    /** Quantised; multiply by quantScale. */
    positions: Int16Array;
    /** Bind normalized: true, stride 4; the 4th byte is the BridgeRole. */
    normals: Int8Array;
    indices: Uint16Array;
}

const align4 = (n: number) => (n + 3) & ~3;

function quantise(v: number, scale: number): number {
    const q = Math.round(v / scale);
    return q > 32767 ? 32767 : q < -32768 ? -32768 : q;
}

function quantiseNormal(v: number): number {
    const q = Math.round(v * 127);
    return q > 127 ? 127 : q < -127 ? -127 : q;
}

export function encodePbr(input: PbrEncodeInput): Uint8Array {
    const vertCount = input.positions.length / 3;
    const triCount = input.indices.length / 3;
    if (vertCount > PBR_MAX_VERTS) {
        throw new Error(`PBR1: ${vertCount} vertices exceed ${PBR_MAX_VERTS}`);
    }
    if (triCount > 0xffff) {
        throw new Error(`PBR1: ${triCount} triangles exceed 65535`);
    }
    const posBytes = align4(vertCount * 6);
    const nrmBytes = align4(vertCount * 4);
    const idxBytes = align4(triCount * 6);
    const out = new Uint8Array(PBR_HEADER_BYTES + posBytes + nrmBytes + idxBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, PBR_MAGIC, true);
    view.setUint8(4, PBR_VERSION);
    view.setUint8(5, input.id.z);
    view.setUint32(8, input.id.x, true);
    view.setUint32(12, input.id.y, true);
    view.setFloat32(16, input.quantScale, true);
    view.setUint16(20, vertCount, true);
    view.setUint16(22, triCount, true);

    let off = PBR_HEADER_BYTES;
    const pos = new Int16Array(out.buffer, off, vertCount * 3);
    off += posBytes;
    const nrm = new Int8Array(out.buffer, off, vertCount * 4);
    off += nrmBytes;
    const idx = new Uint16Array(out.buffer, off, triCount * 3);
    const q = input.quantScale;
    for (let i = 0; i < vertCount; i++) {
        pos[i * 3] = quantise(input.positions[i * 3], q);
        pos[i * 3 + 1] = quantise(input.positions[i * 3 + 1], q);
        pos[i * 3 + 2] = quantise(input.positions[i * 3 + 2], q);
        nrm[i * 4] = quantiseNormal(input.normals[i * 3]);
        nrm[i * 4 + 1] = quantiseNormal(input.normals[i * 3 + 1]);
        nrm[i * 4 + 2] = quantiseNormal(input.normals[i * 3 + 2]);
        nrm[i * 4 + 3] = input.roles[i];
    }
    for (let i = 0; i < triCount * 3; i++) {
        idx[i] = input.indices[i];
    }
    return out;
}

export function decodePbr(bytes: ArrayBuffer | Uint8Array): PbrTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteLength < PBR_HEADER_BYTES) {
        throw new Error(`PBR1 too short: ${raw.byteLength}`);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PBR_MAGIC) {
        throw new Error(`Bad PBR1 magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint8(4);
    if (version !== PBR_VERSION) {
        throw new Error(`PBR1 version ${version}, expected ${PBR_VERSION}`);
    }
    const z = view.getUint8(5);
    const x = view.getUint32(8, true);
    const y = view.getUint32(12, true);
    const quantScale = view.getFloat32(16, true);
    const vertCount = view.getUint16(20, true);
    const triCount = view.getUint16(22, true);
    const posBytes = align4(vertCount * 6);
    const nrmBytes = align4(vertCount * 4);
    const idxBytes = align4(triCount * 6);
    const need = PBR_HEADER_BYTES + posBytes + nrmBytes + idxBytes;
    if (raw.byteLength < need) {
        throw new Error(`PBR1 ${z}/${x}/${y}: ${raw.byteLength} bytes, ${need} needed`);
    }
    let off = raw.byteOffset + PBR_HEADER_BYTES;
    const positions = new Int16Array(raw.buffer, off, vertCount * 3);
    off += posBytes;
    const normals = new Int8Array(raw.buffer, off, vertCount * 4);
    off += nrmBytes;
    const indices = new Uint16Array(raw.buffer, off, triCount * 3);
    return { id: { z, x, y }, quantScale, positions, normals, indices };
}
