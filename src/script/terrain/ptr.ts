/**
 * PTR1 - "Planet Tile Roads", the road stroke sidecar of a mesh tile.
 *
 * The same stroke the .ptm carries for a watercourse - a centreline doubled,
 * each vertex pair at one position with opposite unit offsets across the
 * road, and the true half-width for the vertex program to widen in pixels
 * (see RiverVertProgram) - but in a file of its own beside the mesh. Roads
 * are a layer a player can switch off and a bake can re-tune without
 * touching a mesh: the widths, the class cut per zoom and the vertex cap all
 * change more often than the terrain does, and a re-bake of every .ptm to
 * move a road width is the wrong price. Written by tools/bake_planet_roads.ts
 * from the finished .ptm, which is the only thing that knows the drawn
 * surface a stroke has to lie on.
 *
 * Positions are quantised offsets from the tile centre in the same frame,
 * axes and quantisation step as the .ptm, so the runtime binds them into the
 * tile's own group untouched; the header carries the step so a sidecar that
 * disagrees with its tile can be caught rather than drawn at the wrong scale.
 *
 * Layout, little-endian, 24-byte header:
 *
 *    0  u32  magic 'PTR1'        8  u32  x
 *    4  u8   version = 1        12  u32  y
 *    5  u8   z                  16  f32  quantScale
 *    6  u16  reserved           20  u16  vertCount   22  u16  indexCount / 3
 *
 *   payload, each section padded to a 4-byte boundary
 *     pos    i16 x3 per vertex   centreline point, two vertices per point
 *     dir    i8  x4 per vertex   unit cross-road offset + ROAD_CLASS byte, /127
 *     half   u16 x1 per vertex   half the true width, decimetres
 *     idx    u16 x3 per triangle
 *
 * Decode is typed-array views over the received buffer, no per-vertex pass,
 * the rule every tile format here lives by.
 */

import { TileKey } from './tiling';

export const PTR_MAGIC = 0x31525450; // 'PTR1' little-endian
export const PTR_VERSION = 1;
export const PTR_HEADER_BYTES = 24;
/** Two per centreline point, and u16 indices. */
export const PTR_MAX_VERTS = 65534;
export const PTR_MAX_HALF_M = 6553.5;

/**
 * Road classes, most important first, as the fourth byte of `dir`. The
 * same table as ROAD_CLASSES in tools/bake_osm_roads.py, which is where the
 * byte is first assigned; links fold into their parent class there.
 */
export const enum RoadClass {
    Motorway = 0,
    Trunk = 1,
    Primary = 2,
    Secondary = 3,
    Tertiary = 4,
    Unclassified = 5,
    Residential = 6,
}
export const ROAD_CLASS_COUNT = 7;

/**
 * The coarsest class drawn as a major road: the ones that read from
 * altitude and survive the "major only" setting. Everything past it is a
 * minor road, drawn in the secondary road colour and only close up.
 */
export const ROAD_MAJOR_MAX_CLASS = RoadClass.Secondary;

export interface PtrEncodeInput {
    id: TileKey;
    quantScale: number;
    /** 3 floats per vertex, tile-local metres, two vertices per point. */
    positions: Float32Array;
    /** 3 floats per vertex: unit offset across the road, tile-local. */
    directions: Float32Array;
    /** 1 float per vertex: half the road's true width, metres. */
    halfWidthsM: Float32Array;
    /** 1 byte per vertex, a RoadClass. */
    classes: Uint8Array;
    /** 3 indices per triangle. */
    indices: Uint32Array;
}

export interface PtrTile {
    id: TileKey;
    quantScale: number;
    /** Quantised; multiply by quantScale. */
    positions: Int16Array;
    /** Bind with normalized: true, stride 4; the 4th byte is the RoadClass. */
    directions: Int8Array;
    /** Decimetres. Bind raw and multiply by 0.1 for metres. */
    halfWidths: Uint16Array;
    indices: Uint16Array;
}

function align4(n: number): number {
    return (n + 3) & ~3;
}

function quantise(v: number, scale: number): number {
    const q = Math.round(v / scale);
    return q > 32767 ? 32767 : q < -32768 ? -32768 : q;
}

function quantiseNormal(v: number): number {
    const q = Math.round(v * 127);
    return q > 127 ? 127 : q < -127 ? -127 : q;
}

export function encodePtr(input: PtrEncodeInput): Uint8Array {
    const vertCount = input.positions.length / 3;
    const triCount = input.indices.length / 3;
    if (vertCount > PTR_MAX_VERTS) {
        throw new Error(`PTR1: ${vertCount} vertices exceed ${PTR_MAX_VERTS}`);
    }
    if (triCount > 0xffff) {
        throw new Error(`PTR1: ${triCount} triangles exceed 65535`);
    }
    if (input.id.x > 0xffffffff || input.id.y > 0xffffffff || input.id.z > 0xff) {
        throw new Error(`PTR1: ${input.id.z}/${input.id.x}/${input.id.y} does not fit the header`);
    }
    const posBytes = align4(vertCount * 6);
    const dirBytes = align4(vertCount * 4);
    const halfBytes = align4(vertCount * 2);
    const idxBytes = align4(triCount * 6);
    const out = new Uint8Array(PTR_HEADER_BYTES + posBytes + dirBytes + halfBytes + idxBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, PTR_MAGIC, true);
    view.setUint8(4, PTR_VERSION);
    view.setUint8(5, input.id.z);
    view.setUint32(8, input.id.x, true);
    view.setUint32(12, input.id.y, true);
    view.setFloat32(16, input.quantScale, true);
    view.setUint16(20, vertCount, true);
    view.setUint16(22, triCount, true);

    let off = PTR_HEADER_BYTES;
    const pos = new Int16Array(out.buffer, off, vertCount * 3);
    off += posBytes;
    const dir = new Int8Array(out.buffer, off, vertCount * 4);
    off += dirBytes;
    const half = new Uint16Array(out.buffer, off, vertCount);
    off += halfBytes;
    const idx = new Uint16Array(out.buffer, off, triCount * 3);

    const q = input.quantScale;
    for (let i = 0; i < vertCount; i++) {
        pos[i * 3] = quantise(input.positions[i * 3], q);
        pos[i * 3 + 1] = quantise(input.positions[i * 3 + 1], q);
        pos[i * 3 + 2] = quantise(input.positions[i * 3 + 2], q);
        dir[i * 4] = quantiseNormal(input.directions[i * 3]);
        dir[i * 4 + 1] = quantiseNormal(input.directions[i * 3 + 1]);
        dir[i * 4 + 2] = quantiseNormal(input.directions[i * 3 + 2]);
        dir[i * 4 + 3] = input.classes[i];
        half[i] = Math.round(Math.min(PTR_MAX_HALF_M, Math.max(0, input.halfWidthsM[i])) * 10);
    }
    for (let i = 0; i < triCount * 3; i++) {
        idx[i] = input.indices[i];
    }
    return out;
}

export function decodePtr(bytes: ArrayBuffer | Uint8Array): PtrTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteLength < PTR_HEADER_BYTES) {
        throw new Error(`PTR1 too short: ${raw.byteLength}`);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PTR_MAGIC) {
        throw new Error(`Bad PTR1 magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint8(4);
    if (version !== PTR_VERSION) {
        throw new Error(`PTR1 version ${version}, expected ${PTR_VERSION}`);
    }
    const z = view.getUint8(5);
    const x = view.getUint32(8, true);
    const y = view.getUint32(12, true);
    const quantScale = view.getFloat32(16, true);
    const vertCount = view.getUint16(20, true);
    const triCount = view.getUint16(22, true);
    const posBytes = align4(vertCount * 6);
    const dirBytes = align4(vertCount * 4);
    const halfBytes = align4(vertCount * 2);
    const idxBytes = align4(triCount * 6);
    const need = PTR_HEADER_BYTES + posBytes + dirBytes + halfBytes + idxBytes;
    if (raw.byteLength < need) {
        throw new Error(`PTR1 ${z}/${x}/${y}: ${raw.byteLength} bytes, ${need} needed`);
    }
    // Sections are 4-byte aligned from a 24-byte header, so the views land
    // aligned as long as the buffer itself is; a received ArrayBuffer is.
    let off = raw.byteOffset + PTR_HEADER_BYTES;
    const positions = new Int16Array(raw.buffer, off, vertCount * 3);
    off += posBytes;
    const directions = new Int8Array(raw.buffer, off, vertCount * 4);
    off += dirBytes;
    const halfWidths = new Uint16Array(raw.buffer, off, vertCount);
    off += halfBytes;
    const indices = new Uint16Array(raw.buffer, off, triCount * 3);
    return { id: { z, x, y }, quantScale, positions, directions, halfWidths, indices };
}
