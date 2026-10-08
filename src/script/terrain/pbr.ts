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
 *    4  u8   version = 3        12  u32  y
 *    5  u8   z                  16  f32  quantScale
 *    6  u16  reserved           20  u16  vertCount   22  u16  triCount
 *
 *   payload, each section padded to a 4-byte boundary
 *     pos    i16 x3 per vertex   position / quantScale
 *     nrm    i8  x4 per vertex   unit face normal /127 + BridgeRole byte
 *     idx    u16 x3 per triangle
 *
 *   version 2 appends the track drawn on rail bridge decks, a stroke in the
 *   PTR1 layout (see ptr.ts) so the road strokes' rail material draws it:
 *     u16 trackVertCount, u16 trackTriCount
 *     pos    i16 x3 per vertex   centreline point, two vertices per point
 *     dir    i8  x4 per vertex   unit offset across the track + class byte
 *     half   u16 x1 per vertex   half the track bed's width, decimetres
 *     along  u16 x1 per vertex   ALONG_STEP_M units, wrapped
 *     idx    u16 x3 per triangle
 *
 *   version 3 appends the level-crossing furniture, as boxes in float32:
 *   a sign board is 2.4 cm thick, far below the quantisation step, and
 *   snapped to it the boxes came out kinked and torn.
 *     u32 boxCount
 *     box    f32 x16 per box     centre xyz (tile-local metres), three unit
 *                                axes xyz, half sizes along them, BridgeRole
 *
 *   version 4 appends the ramps across the tile's border: where a road or
 *   railway crosses its edge, how far off its drawn height the line is held
 *   there to climb onto a deck or dip under one on the far side (the bake
 *   walks the lines of both tiles, so both read the same; see railBed.ts).
 *     u32 rampCount
 *     ramp   f32 x4 per ramp     crossing point xyz (tile-local metres), dh
 *
 *   version 5 appends the road decks' ends: where each road span's deck ends,
 *   its top on the centreline there, so the grading holds the road arriving
 *   there to it (railBed.ts RailBedInput.roadDeckEnds) - as the rail decks'
 *   track ends hold a railway - rather than guessing its deck from what the
 *   triangles cover.
 *     u32 endCount
 *     end    f32 x7 per end      deck top at the end xyz (tile-local metres),
 *                                the span's tier, and the deck top 1 m in
 *                                from the end xyz (the way the span runs)
 *
 * Decode is typed-array views over the received buffer, no per-vertex pass.
 */

import { ALONG_STEP_M, ALONG_WRAP_M } from './ptr';
import { TileKey } from './tiling';

const PBR_MAGIC = 0x31524250; // 'PBR1' little-endian
const PBR_VERSION = 5;
/** Floats per border ramp: crossing point 3, height change 1. */
export const PBR_RAMP_FLOATS = 4;
/** Floats per road deck end: the end 3, the tier 1, a point 1 m in along the span 3. */
export const PBR_ROAD_END_FLOATS = 7;
/** Floats per furniture box: centre 3, axes 9, half sizes 3, role 1. */
export const PBR_BOX_FLOATS = 16;
const PBR_HEADER_BYTES = 24;
export const PBR_MAX_VERTS = 65535;

/**
 * The fourth byte of `nrm`: which material a face takes in its low four
 * bits (BridgeRole), and above them the bridge's line tier plus one
 * (railBed.ts BED_TIERS; 0 when unknown, as in files baked before it).
 */
export const PBR_ROLE_MASK = 0x0f;
export const PBR_TIER_SHIFT = 4;

/** A face's material, from the fourth byte of its first vertex's `nrm`. */
export function pbrRole(byte: number): BridgeRole {
    return (byte & PBR_ROLE_MASK) as BridgeRole;
}

/** The tier of the line a bridge carries (BED_TIERS index), or -1 when the file does not say. */
export function pbrTier(byte: number): number {
    return ((byte & 0xff) >> PBR_TIER_SHIFT) - 1;
}

export const enum BridgeRole {
    /** Road surface on top of a deck. */
    Deck = 0,
    /** Everything else: undersides, sides, parapets, piers, abutments. */
    Concrete = 1,
    /** Track bed on top of a rail bridge deck. */
    RailDeck = 2,
    /** Level-crossing furniture (tools/bake/crossingFurniture.ts): the red stripes, */
    SignRed = 3,
    /** the white ones and the barrier posts, */
    SignWhite = 4,
    /** and the grey post a St Andrew's cross stands on. */
    SignPost = 5,
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
    /** The track on rail decks, or absent. */
    track?: PbrTrackInput;
    /** Furniture boxes, PBR_BOX_FLOATS each, or absent. */
    boxes?: Float32Array;
    /** Border ramps, PBR_RAMP_FLOATS each, or absent. */
    ramps?: Float32Array;
    /** Road deck ends, PBR_ROAD_END_FLOATS each, or absent. */
    roadEnds?: Float32Array;
}

/** A track stroke, as ptr.ts's PtrEncodeInput has it. */
export interface PbrTrackInput {
    positions: Float32Array;
    directions: Float32Array;
    halfWidthsM: Float32Array;
    classes: Uint8Array;
    alongM: Float32Array;
    indices: Uint32Array;
}

/** A decoded track stroke: the PtrTile fields, bound the same way. */
export interface PbrTrack {
    positions: Int16Array;
    directions: Int8Array;
    halfWidths: Uint16Array;
    along: Uint16Array;
    indices: Uint16Array;
}

export interface PbrTile {
    id: TileKey;
    quantScale: number;
    /** Quantised; multiply by quantScale. */
    positions: Int16Array;
    /** Bind normalized: true, stride 4; the 4th byte is the BridgeRole. */
    normals: Int8Array;
    indices: Uint16Array;
    /** Version 2 with rail decks only. */
    track?: PbrTrack;
    /** Version 3: furniture boxes, PBR_BOX_FLOATS each, tile-local metres. */
    boxes?: Float32Array;
    /** Version 4: border ramps, PBR_RAMP_FLOATS each (crossing point in tile-local metres, height change). */
    ramps?: Float32Array;
    /** Version 5: road deck ends, PBR_ROAD_END_FLOATS each (tile-local metres). */
    roadEnds?: Float32Array;
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
    const track = input.track;
    const tVerts = track ? track.positions.length / 3 : 0;
    const tTris = track ? track.indices.length / 3 : 0;
    if (tVerts > PBR_MAX_VERTS || tTris > 0xffff) {
        throw new Error(`PBR1: track of ${tVerts} vertices / ${tTris} triangles is too big`);
    }
    const trackBytes = 4 + align4(tVerts * 6) + align4(tVerts * 4) + align4(tVerts * 2) * 2 + align4(tTris * 6);
    const boxFloats = input.boxes ? input.boxes.length : 0;
    const boxBytes = 4 + boxFloats * 4;
    const rampFloats = input.ramps ? input.ramps.length : 0;
    const rampBytes = 4 + rampFloats * 4;
    const endFloats = input.roadEnds ? input.roadEnds.length : 0;
    const endBytes = 4 + endFloats * 4;
    const out = new Uint8Array(PBR_HEADER_BYTES + posBytes + nrmBytes + idxBytes + trackBytes + boxBytes + rampBytes + endBytes);
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
    off += idxBytes;
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
    view.setUint16(off, tVerts, true);
    view.setUint16(off + 2, tTris, true);
    off += 4;
    if (track) {
        const tPos = new Int16Array(out.buffer, off, tVerts * 3);
        off += align4(tVerts * 6);
        const tDir = new Int8Array(out.buffer, off, tVerts * 4);
        off += align4(tVerts * 4);
        const tHalf = new Uint16Array(out.buffer, off, tVerts);
        off += align4(tVerts * 2);
        const tAlong = new Uint16Array(out.buffer, off, tVerts);
        off += align4(tVerts * 2);
        const tIdx = new Uint16Array(out.buffer, off, tTris * 3);
        for (let i = 0; i < tVerts; i++) {
            for (let c = 0; c < 3; c++) {
                tPos[i * 3 + c] = quantise(track.positions[i * 3 + c], q);
                tDir[i * 4 + c] = quantiseNormal(track.directions[i * 3 + c]);
            }
            tDir[i * 4 + 3] = track.classes[i];
            tHalf[i] = Math.round(Math.min(6553.5, Math.max(0, track.halfWidthsM[i])) * 10);
            const a = track.alongM[i] % ALONG_WRAP_M;
            tAlong[i] = Math.round((a < 0 ? a + ALONG_WRAP_M : a) / ALONG_STEP_M) & 0xffff;
        }
        tIdx.set(track.indices);
    }
    const boxAt = PBR_HEADER_BYTES + posBytes + nrmBytes + idxBytes + trackBytes;
    view.setUint32(boxAt, boxFloats / PBR_BOX_FLOATS, true);
    if (input.boxes) {
        new Float32Array(out.buffer, boxAt + 4, boxFloats).set(input.boxes);
    }
    const rampAt = boxAt + boxBytes;
    view.setUint32(rampAt, rampFloats / PBR_RAMP_FLOATS, true);
    if (input.ramps) {
        new Float32Array(out.buffer, rampAt + 4, rampFloats).set(input.ramps);
    }
    const endAt = rampAt + rampBytes;
    view.setUint32(endAt, endFloats / PBR_ROAD_END_FLOATS, true);
    if (input.roadEnds) {
        new Float32Array(out.buffer, endAt + 4, endFloats).set(input.roadEnds);
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
    if (version < 1 || version > PBR_VERSION) {
        throw new Error(`PBR1 version ${version}, expected 1 to ${PBR_VERSION}`);
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
    off += idxBytes;
    let track: PbrTrack | undefined;
    if (version >= 2 && off + 4 <= raw.byteOffset + raw.byteLength) {
        const tVerts = view.getUint16(off - raw.byteOffset, true);
        const tTris = view.getUint16(off - raw.byteOffset + 2, true);
        off += 4;
        const tNeed = align4(tVerts * 6) + align4(tVerts * 4) + align4(tVerts * 2) * 2 + align4(tTris * 6);
        if (off + tNeed > raw.byteOffset + raw.byteLength) {
            throw new Error(`PBR1 ${z}/${x}/${y}: track truncated`);
        }
        const trackEnd = off + tNeed;
        if (tVerts > 0 && tTris > 0) {
            const tPositions = new Int16Array(raw.buffer, off, tVerts * 3);
            off += align4(tVerts * 6);
            const tDirections = new Int8Array(raw.buffer, off, tVerts * 4);
            off += align4(tVerts * 4);
            const tHalf = new Uint16Array(raw.buffer, off, tVerts);
            off += align4(tVerts * 2);
            const tAlong = new Uint16Array(raw.buffer, off, tVerts);
            off += align4(tVerts * 2);
            const tIndices = new Uint16Array(raw.buffer, off, tTris * 3);
            track = { positions: tPositions, directions: tDirections, halfWidths: tHalf, along: tAlong, indices: tIndices };
        }
        off = trackEnd;
    }
    let boxes: Float32Array | undefined;
    if (version >= 3 && off + 4 <= raw.byteOffset + raw.byteLength) {
        const count = view.getUint32(off - raw.byteOffset, true);
        off += 4;
        if (off + count * PBR_BOX_FLOATS * 4 > raw.byteOffset + raw.byteLength) {
            throw new Error(`PBR1 ${z}/${x}/${y}: furniture truncated`);
        }
        if (count > 0) {
            boxes = new Float32Array(raw.buffer, off, count * PBR_BOX_FLOATS);
        }
        off += count * PBR_BOX_FLOATS * 4;
    }
    let ramps: Float32Array | undefined;
    if (version >= 4 && off + 4 <= raw.byteOffset + raw.byteLength) {
        const count = view.getUint32(off - raw.byteOffset, true);
        off += 4;
        if (off + count * PBR_RAMP_FLOATS * 4 > raw.byteOffset + raw.byteLength) {
            throw new Error(`PBR1 ${z}/${x}/${y}: ramps truncated`);
        }
        if (count > 0) {
            ramps = new Float32Array(raw.buffer, off, count * PBR_RAMP_FLOATS);
        }
        off += count * PBR_RAMP_FLOATS * 4;
    }
    let roadEnds: Float32Array | undefined;
    if (version >= 5 && off + 4 <= raw.byteOffset + raw.byteLength) {
        const count = view.getUint32(off - raw.byteOffset, true);
        off += 4;
        if (off + count * PBR_ROAD_END_FLOATS * 4 > raw.byteOffset + raw.byteLength) {
            throw new Error(`PBR1 ${z}/${x}/${y}: road deck ends truncated`);
        }
        if (count > 0) {
            roadEnds = new Float32Array(raw.buffer, off, count * PBR_ROAD_END_FLOATS);
        }
    }
    return { id: { z, x, y }, quantScale, positions, normals, indices, track, boxes, ramps, roadEnds };
}
