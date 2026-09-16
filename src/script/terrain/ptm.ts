/**
 * PTM1 - "Planet Tile Mesh", the baked, draw-ready terrain tile format.
 *
 * The whole point of this format is that decoding is O(1): every section is
 * 4-byte aligned and already in its final element type, so decodePtm reads a
 * 72-byte header and hands back typed-array *views* over the received buffer.
 * There is no per-vertex loop and no dequantisation pass - quantised int16
 * positions are bound to the GPU directly and scaled by the mesh transform,
 * int8 normals are bound with normalized: true.
 *
 * Keep it that way. Any change that forces a per-vertex pass at load time
 * gives up the property this format exists for.
 *
 * Layout, little-endian:
 *
 *   header, 72 bytes
 *     0  u32  magic 'PTM1'          32  u32  landVertCount   (multiple of 3)
 *     4  u8   version = 6           36  u32  waterVertCount
 *     5  u8   z                     40  u32  waterIndexCount
 *     6  u16  flags                 44  u32  riverVertCount
 *     8  u32  x                     48  u32  riverIndexCount
 *    12  u32  y                     52  u32  reserved
 *    16  f32  centerHeightM         56  u32  waterDeepIdx     | = waterIndexCount
 *    20  f32  quantScale            60  u32  waterShallowIdx  |
 *    24  u32  reserved              64  f32  skirtDepthM
 *    28  f32  boundingRadiusM       68  u32  reserved
 *
 *   payload, each section padded to a 4-byte boundary
 *     landPos    i16 x3 per vertex   tile-local (x=E, y=U, z=S)
 *     landNrm    i8  x4 per vertex   xyz + pad, /127
 *     landAttr   u8  x4 per vertex   r, g, b, TerrainClass
 *     waterPos   i16 x3 per vertex
 *     waterTone  u8  x1 per vertex   0..1
 *     waterIdx   u16 x3 per triangle deep range, then shallow range
 *     riverPos   i16 x3 per vertex   centreline point, two vertices per point
 *     riverDir   i8  x4 per vertex   unit cross-flow offset + pad, /127
 *     riverHalf  u16 x1 per vertex   half the true width, decimetres
 *     riverIdx   u16 x3 per triangle
 *
 * The river section is a stroke, not a surface: its two vertices per centreline
 * point sit at the *same* place and carry opposite unit offsets, and the width
 * is applied in the vertex program. That is deliberate. A watercourse thinner
 * than a grid cell — a 12 m canal is under one at Potsdam z12 — cannot be cut
 * into the terrain at all, and widening it until it could was tried and traded
 * one wrong picture for another. Baking the centreline instead leaves the
 * minimum width to the only place that can know it in pixels.
 *
 * landAttr is what makes a tile's colour a runtime choice rather than a bake
 * one: the observed landcover class and the observed satellite colour both
 * travel with every facet, and the shader decides which of them (or which
 * blend) to paint with. Land is therefore a single draw group - there is no
 * tone bucketing left to do here.
 *
 * The tile's centre lon/lat is derived from (z, x, y) and is deliberately not
 * stored. Positions are tile-local; the loader places the tile by translation
 * only, never rotation, because the shaded vertex program treats normals as
 * world-space in the STATIC/DUOTONE shading paths.
 *
 * Version 4 flipped the z axis from north to south. Nothing about the layout
 * changed, but a v3 tile drawn as v4 is a mirror image of the place it
 * describes, which is precisely the kind of silently-wrong that the version
 * byte exists to stop. See `sceneFromEnu` in geodesy.ts.
 *
 * Version 6 fills the last reserved header word with the tile's own geometric
 * error - the bound on what drawing its children instead would gain. The
 * runtime used to refine on one figure per zoom level for the whole planet,
 * a monotone max that a mountain baked years ago pinned at 1.6 km for z4-z10,
 * so a flat sea tile at z10 refined as eagerly as the Alps. Per tile, the LOD
 * cut follows the terrain: sea stays coarse, relief refines.
 */

import { CLASS_COUNT, TerrainTone } from './tones';

export const PTM_MAGIC = 0x314d5450; // 'PTM1' little-endian
export const PTM_VERSION = 6;
export const PTM_HEADER_BYTES = 72;
/** Byte offset of the header's `geometricErrorM` float; see {@link writePtmGeometricError}. */
export const PTM_GEOMETRIC_ERROR_OFFSET = 68;

export const PTM_FLAG_HAS_LAND = 1 << 0;
export const PTM_FLAG_HAS_WATER = 1 << 1;
export const PTM_FLAG_HAS_RIVERS = 1 << 2;

/** Water indices are u16, so a tile may not exceed this many water vertices. */
export const PTM_MAX_WATER_VERTS = 65536;

/** Same u16 index limit for the river stroke. */
export const PTM_MAX_RIVER_VERTS = 65536;

/** riverHalf is stored in decimetres, so this is the widest stroke it holds. */
export const PTM_MAX_RIVER_HALF_M = 6553.5;

const I16_MAX = 32767;

export interface PtmTileId {
    z: number;
    x: number;
    y: number;
}

/**
 * Land input: non-indexed triangles, each with one face normal, one observed
 * landcover class and one observed colour.
 */
export interface PtmLandInput {
    /** 9 floats per triangle (3 verts x xyz), tile-local metres. */
    positions: Float32Array;
    /** 3 floats per triangle: the unit face normal. */
    faceNormals: Float32Array;
    /** 1 byte per triangle: a {@link TerrainClass}, 0..15. */
    classes: Uint8Array;
    /** 3 bytes per triangle: mean sRGB over the triangle's ground footprint. */
    colors: Uint8Array;
    /**
     * 9 bytes per triangle (sRGB per vertex), overriding `colors` where given.
     * The wire format already stores colour per vertex, so this changes
     * nothing about the tile layout - it only lets a colour vary across a
     * facet, for the smoothly blended regional ground colour.
     */
    vertexColors?: Uint8Array;
}

/** Water input: shared vertices, indexed triangles, one tone each. */
export interface PtmWaterInput {
    /** 3 floats per vertex, tile-local metres. */
    positions: Float32Array;
    /** 3 indices per triangle. */
    indices: Uint32Array;
    /** 1 byte per triangle: Water | ShallowWater. */
    tones: Uint8Array;
}

/**
 * River input: the centreline, doubled.
 *
 * Two vertices per centreline point at the same position, with `directions`
 * holding opposite unit vectors across the flow. The vertex program turns them
 * into a ribbon, which is what lets the drawn width be a screen decision.
 */
export interface PtmRiverInput {
    /** 3 floats per vertex, tile-local metres — the centreline point. */
    positions: Float32Array;
    /** 3 floats per vertex: unit offset across the flow, tile-local. */
    directions: Float32Array;
    /** 1 float per vertex: half the watercourse's true width, metres. */
    halfWidthsM: Float32Array;
    /** 3 indices per triangle. */
    indices: Uint32Array;
    /**
     * 1 byte per vertex, a PTM_STROKE_KIND_*. Stored in riverDir's padding
     * byte, which every tile before this field wrote as 0 - so an older tile
     * reads back as all water, and the format needs no version bump. Omit for
     * all water.
     */
    kinds?: Uint8Array;
}

/** A watercourse: drawn in the water colour. */
export const PTM_STROKE_KIND_WATER = 0;
/** The edge of an OSM landuse region: drawn in the outline colour. */
export const PTM_STROKE_KIND_OUTLINE = 1;

export interface PtmEncodeInput {
    id: PtmTileId;
    /** Geodetic height (m) of the tile-local frame origin. */
    centerHeightM: number;
    /** Half the tile's ground width (m); the floor for the quantisation step. */
    tileHalfWidthM: number;
    skirtDepthM: number;
    /**
     * World-space error bound (m) the runtime refines on: what drawing this
     * tile's children instead of it would gain. The DEM's own child-detail
     * loss plus whatever the decimator dropped.
     */
    geometricErrorM: number;
    land: PtmLandInput;
    water: PtmWaterInput;
    /** Omit for a tile with no watercourse on it, which is most of them. */
    rivers?: PtmRiverInput;
}

export interface PtmTile {
    id: PtmTileId;
    version: number;
    flags: number;
    centerHeightM: number;
    /**
     * Metres per quantised unit, the same on all three axes.
     *
     * It has to be uniform. The mesh transform carries this as its scale, and
     * the shaded vertex program builds normalModelMatrix from matrixWorld with
     * getNormalMatrix (inverse transpose). A non-uniform scale therefore skews
     * the baked world-space normals — measured at 5-10 degrees mean and up to
     * 50 degrees worst case, biased toward vertical, which flattens n.sun and
     * destroys the per-facet shading the bake went to the trouble of creating.
     * A uniform scale normalises back to the original normal exactly.
     */
    quantScale: number;
    boundingRadiusM: number;
    skirtDepthM: number;
    /** See {@link PtmEncodeInput.geometricErrorM}. */
    geometricErrorM: number;
    /** Quantised, ready to bind. Multiply by quantScale. */
    landPositions: Int16Array;
    /** Bind with normalized: true. Stride 4; the 4th byte is padding. */
    landNormals: Int8Array;
    /**
     * Stride 4: rgb at 0..2 (bind normalized), {@link TerrainClass} at 3 (bind
     * raw). Two interleaved views over the one buffer, because the two halves
     * want different normalisation.
     */
    landAttrs: Uint8Array;
    waterPositions: Int16Array;
    waterTones: Uint8Array;
    waterIndices: Uint16Array;
    /** [start, count] into waterIndices for tones 0..1. */
    waterGroups: ReadonlyArray<readonly [number, number]>;
    /** Quantised centreline points, two per point. Multiply by quantScale. */
    riverPositions: Int16Array;
    /** Bind with normalized: true. Stride 4; the 4th byte is padding. */
    riverDirections: Int8Array;
    /** Half-width in decimetres. Bind raw and multiply by 0.1 for metres. */
    riverHalfWidths: Uint16Array;
    riverIndices: Uint16Array;
}

function align4(n: number): number {
    return (n + 3) & ~3;
}

function quantise(v: number, scale: number): number {
    if (!(scale > 0)) {
        return 0;
    }
    const q = Math.round(v / scale);
    return q < -I16_MAX ? -I16_MAX : q > I16_MAX ? I16_MAX : q;
}

function quantiseNormal(v: number): number {
    const q = Math.round(v * 127);
    return q < -127 ? -127 : q > 127 ? 127 : q;
}

/**
 * Encode a tile. Land triangles keep their input order - they are one draw
 * group - while water triangles are bucketed by tone so each decoded group is
 * contiguous and can be drawn as a single range with one material.
 */
export function encodePtm(input: PtmEncodeInput): Uint8Array {
    const { land, water } = input;
    const rivers = input.rivers;
    const landTriCount = land.classes.length;
    const waterTriCount = water.tones.length;
    const riverVertCount = rivers ? rivers.halfWidthsM.length : 0;
    const riverIndexCount = rivers ? rivers.indices.length : 0;
    if (rivers) {
        if (rivers.positions.length !== riverVertCount * 3) {
            throw new Error(
                `PTM1: river positions ${rivers.positions.length} != ${riverVertCount * 3}`);
        }
        if (rivers.directions.length !== riverVertCount * 3) {
            throw new Error(
                `PTM1: river directions ${rivers.directions.length} != ${riverVertCount * 3}`);
        }
        if (riverIndexCount % 3 !== 0) {
            throw new Error(`PTM1: riverIndexCount ${riverIndexCount} is not a multiple of 3`);
        }
        if (riverVertCount > PTM_MAX_RIVER_VERTS) {
            throw new Error(
                `PTM1: ${riverVertCount} river vertices exceeds the u16 index limit`);
        }
    }

    if (land.positions.length !== landTriCount * 9) {
        throw new Error(`PTM1: land positions ${land.positions.length} != ${landTriCount * 9}`);
    }
    if (land.faceNormals.length !== landTriCount * 3) {
        throw new Error(`PTM1: land normals ${land.faceNormals.length} != ${landTriCount * 3}`);
    }
    if (land.colors.length !== landTriCount * 3) {
        throw new Error(`PTM1: land colors ${land.colors.length} != ${landTriCount * 3}`);
    }
    if (land.vertexColors && land.vertexColors.length !== landTriCount * 9) {
        throw new Error(`PTM1: land vertex colors ${land.vertexColors.length} != ${landTriCount * 9}`);
    }
    if (water.indices.length !== waterTriCount * 3) {
        throw new Error(`PTM1: water indices ${water.indices.length} != ${waterTriCount * 3}`);
    }
    for (let t = 0; t < landTriCount; t++) {
        if (land.classes[t] >= CLASS_COUNT) {
            throw new Error(
                `PTM1: land triangle ${t} has class ${land.classes[t]} >= ${CLASS_COUNT}`);
        }
    }

    // Water: a vertex carries exactly one tone, so a vertex shared between a
    // deep and a shallow triangle must be duplicated. That boundary is a 1-D
    // curve through a 2-D mesh, so the duplication is negligible.
    const waterOrder: number[][] = [[], []];
    for (let t = 0; t < waterTriCount; t++) {
        const tone = water.tones[t];
        if (tone !== TerrainTone.Water && tone !== TerrainTone.ShallowWater) {
            throw new Error(`PTM1: water triangle ${t} has non-water tone ${tone}`);
        }
        waterOrder[tone].push(t);
    }
    const remap = new Map<number, number>();
    const outWaterPos: number[] = [];
    const outWaterTone: number[] = [];
    const outWaterIdx: number[] = [];
    for (let tone = 0; tone < 2; tone++) {
        for (const t of waterOrder[tone]) {
            for (let k = 0; k < 3; k++) {
                const src = water.indices[t * 3 + k];
                const key = src * 2 + tone;
                let dst = remap.get(key);
                if (dst === undefined) {
                    dst = outWaterTone.length;
                    remap.set(key, dst);
                    outWaterPos.push(
                        water.positions[src * 3],
                        water.positions[src * 3 + 1],
                        water.positions[src * 3 + 2],
                    );
                    outWaterTone.push(tone);
                }
                outWaterIdx.push(dst);
            }
        }
    }
    const waterVertCount = outWaterTone.length;
    if (waterVertCount > PTM_MAX_WATER_VERTS) {
        throw new Error(`PTM1: ${waterVertCount} water vertices exceeds the u16 index limit`);
    }

    const landVertCount = landTriCount * 3;
    const waterIndexCount = outWaterIdx.length;

    // Horizontal scale comes from the tile size, so tile-edge vertices land on
    // exactly representable coordinates and same-LOD seams cannot crack from
    // rounding. Vertical scale comes from the tile's actual extent.
    // One scale for all axes: see PtmTile.quantScale for why it may not be
    // per-axis.
    //
    // The tile half-width keeps tile-edge vertices exactly representable, so
    // same-LOD seams cannot crack from rounding. But it is only a *floor*: at
    // coarse zooms the tangent-plane ENU projection stretches a tile past its
    // nominal ground width, and sizing from the nominal figure alone clamped
    // real geometry onto +-32767 — distinct points collapsing onto the tile
    // border. Take the actual extent on every axis as well.
    let maxAbs = 0;
    for (let i = 0; i < land.positions.length; i++) {
        const a = Math.abs(land.positions[i]);
        if (a > maxAbs) maxAbs = a;
    }
    for (let i = 0; i < outWaterPos.length; i++) {
        const a = Math.abs(outWaterPos[i]);
        if (a > maxAbs) maxAbs = a;
    }
    if (rivers) {
        for (let i = 0; i < rivers.positions.length; i++) {
            const a = Math.abs(rivers.positions[i]);
            if (a > maxAbs) maxAbs = a;
        }
    }
    const quantScale = Math.max(input.tileHalfWidthM, maxAbs, 1) / I16_MAX;

    let maxRadiusSq = 0;
    const trackRadius = (x: number, y: number, z: number) => {
        const d = x * x + y * y + z * z;
        if (d > maxRadiusSq) maxRadiusSq = d;
    };

    const landPosBytes = align4(landVertCount * 6);
    const landNrmBytes = align4(landVertCount * 4);
    const landAttrBytes = align4(landVertCount * 4);
    const waterPosBytes = align4(waterVertCount * 6);
    const waterToneBytes = align4(waterVertCount);
    const waterIdxBytes = align4(waterIndexCount * 2);
    const riverPosBytes = align4(riverVertCount * 6);
    const riverDirBytes = align4(riverVertCount * 4);
    const riverHalfBytes = align4(riverVertCount * 2);
    const riverIdxBytes = align4(riverIndexCount * 2);

    const total = PTM_HEADER_BYTES + landPosBytes + landNrmBytes + landAttrBytes
        + waterPosBytes + waterToneBytes + waterIdxBytes
        + riverPosBytes + riverDirBytes + riverHalfBytes + riverIdxBytes;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);

    let off = PTM_HEADER_BYTES;
    const landPos = new Int16Array(out.buffer, off, landVertCount * 3);
    off += landPosBytes;
    const landNrm = new Int8Array(out.buffer, off, landVertCount * 4);
    off += landNrmBytes;
    const landAttr = new Uint8Array(out.buffer, off, landVertCount * 4);
    off += landAttrBytes;
    const waterPos = new Int16Array(out.buffer, off, waterVertCount * 3);
    off += waterPosBytes;
    const waterTone = new Uint8Array(out.buffer, off, waterVertCount);
    off += waterToneBytes;
    const waterIdx = new Uint16Array(out.buffer, off, waterIndexCount);
    off += waterIdxBytes;
    const riverPos = new Int16Array(out.buffer, off, riverVertCount * 3);
    off += riverPosBytes;
    const riverDir = new Int8Array(out.buffer, off, riverVertCount * 4);
    off += riverDirBytes;
    const riverHalf = new Uint16Array(out.buffer, off, riverVertCount);
    off += riverHalfBytes;
    const riverIdx = new Uint16Array(out.buffer, off, riverIndexCount);

    let v = 0;
    for (let t = 0; t < landTriCount; t++) {
        const nx = land.faceNormals[t * 3];
        const ny = land.faceNormals[t * 3 + 1];
        const nz = land.faceNormals[t * 3 + 2];
        const cr = land.colors[t * 3];
        const cg = land.colors[t * 3 + 1];
        const cb = land.colors[t * 3 + 2];
        const cls = land.classes[t];
        for (let k = 0; k < 3; k++) {
            const px = land.positions[t * 9 + k * 3];
            const py = land.positions[t * 9 + k * 3 + 1];
            const pz = land.positions[t * 9 + k * 3 + 2];
            trackRadius(px, py, pz);
            landPos[v * 3] = quantise(px, quantScale);
            landPos[v * 3 + 1] = quantise(py, quantScale);
            landPos[v * 3 + 2] = quantise(pz, quantScale);
            landNrm[v * 4] = quantiseNormal(nx);
            landNrm[v * 4 + 1] = quantiseNormal(ny);
            landNrm[v * 4 + 2] = quantiseNormal(nz);
            landNrm[v * 4 + 3] = 0;
            const vc = land.vertexColors;
            landAttr[v * 4] = vc ? vc[t * 9 + k * 3] : cr;
            landAttr[v * 4 + 1] = vc ? vc[t * 9 + k * 3 + 1] : cg;
            landAttr[v * 4 + 2] = vc ? vc[t * 9 + k * 3 + 2] : cb;
            landAttr[v * 4 + 3] = cls;
            v++;
        }
    }

    for (let i = 0; i < waterVertCount; i++) {
        const px = outWaterPos[i * 3];
        const py = outWaterPos[i * 3 + 1];
        const pz = outWaterPos[i * 3 + 2];
        trackRadius(px, py, pz);
        waterPos[i * 3] = quantise(px, quantScale);
        waterPos[i * 3 + 1] = quantise(py, quantScale);
        waterPos[i * 3 + 2] = quantise(pz, quantScale);
        waterTone[i] = outWaterTone[i];
    }
    for (let i = 0; i < waterIndexCount; i++) {
        waterIdx[i] = outWaterIdx[i];
    }

    if (rivers) {
        for (let i = 0; i < riverVertCount; i++) {
            const px = rivers.positions[i * 3];
            const py = rivers.positions[i * 3 + 1];
            const pz = rivers.positions[i * 3 + 2];
            trackRadius(px, py, pz);
            riverPos[i * 3] = quantise(px, quantScale);
            riverPos[i * 3 + 1] = quantise(py, quantScale);
            riverPos[i * 3 + 2] = quantise(pz, quantScale);
            riverDir[i * 4] = quantiseNormal(rivers.directions[i * 3]);
            riverDir[i * 4 + 1] = quantiseNormal(rivers.directions[i * 3 + 1]);
            riverDir[i * 4 + 2] = quantiseNormal(rivers.directions[i * 3 + 2]);
            riverDir[i * 4 + 3] = rivers.kinds ? rivers.kinds[i] : PTM_STROKE_KIND_WATER;
            // Decimetres: a half-width is metres to a couple of significant
            // figures and the stroke is a couple of pixels wide most of the
            // time, so anything finer would be storing noise.
            const half = Math.min(PTM_MAX_RIVER_HALF_M, Math.max(0, rivers.halfWidthsM[i]));
            riverHalf[i] = Math.round(half * 10);
        }
        for (let i = 0; i < riverIndexCount; i++) {
            riverIdx[i] = rivers.indices[i];
        }
    }

    let flags = 0;
    if (landVertCount > 0) {
        flags |= PTM_FLAG_HAS_LAND;
    }
    if (waterVertCount > 0) {
        flags |= PTM_FLAG_HAS_WATER;
    }
    if (riverVertCount > 0) {
        flags |= PTM_FLAG_HAS_RIVERS;
    }

    view.setUint32(0, PTM_MAGIC, true);
    view.setUint8(4, PTM_VERSION);
    view.setUint8(5, input.id.z);
    view.setUint16(6, flags, true);
    view.setUint32(8, input.id.x, true);
    view.setUint32(12, input.id.y, true);
    view.setFloat32(16, input.centerHeightM, true);
    view.setFloat32(20, quantScale, true);
    view.setUint32(24, 0, true);
    view.setFloat32(28, Math.sqrt(maxRadiusSq), true);
    view.setUint32(32, landVertCount, true);
    view.setUint32(36, waterVertCount, true);
    view.setUint32(40, waterIndexCount, true);
    view.setUint32(44, riverVertCount, true);
    view.setUint32(48, riverIndexCount, true);
    view.setUint32(52, 0, true);
    view.setUint32(56, waterOrder[TerrainTone.Water].length * 3, true);
    view.setUint32(60, waterOrder[TerrainTone.ShallowWater].length * 3, true);
    view.setFloat32(64, input.skirtDepthM, true);
    view.setFloat32(PTM_GEOMETRIC_ERROR_OFFSET, input.geometricErrorM, true);

    return out;
}

/**
 * The header's geometric error, without decoding the tile. The bake folds
 * every tile's own figure into a monotone one - a parent is at least as far
 * off as any tile beneath it - after the pyramid is written, and patches the
 * headers in place rather than re-encoding; see tools/bake/errorFold.ts.
 */
export function readPtmGeometricError(bytes: Uint8Array): number {
    checkPtmHeader(bytes);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .getFloat32(PTM_GEOMETRIC_ERROR_OFFSET, true);
}

/** Overwrite the header's geometric error in place. */
export function writePtmGeometricError(bytes: Uint8Array, geometricErrorM: number): void {
    checkPtmHeader(bytes);
    if (!Number.isFinite(geometricErrorM) || geometricErrorM < 0) {
        throw new Error(`PTM1: geometric error ${geometricErrorM} is not a finite non-negative metre figure`);
    }
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .setFloat32(PTM_GEOMETRIC_ERROR_OFFSET, geometricErrorM, true);
}

function checkPtmHeader(bytes: Uint8Array): void {
    if (bytes.byteLength < PTM_HEADER_BYTES) {
        throw new Error(`PTM1 too short: ${bytes.byteLength}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PTM_MAGIC) {
        throw new Error(`Bad PTM1 magic: 0x${magic.toString(16)}`);
    }
}

/**
 * Decode a tile. Returns views over `bytes` - no copying, no per-vertex work.
 * The caller must not mutate or detach the underlying buffer afterwards.
 */
export function decodePtm(bytes: ArrayBuffer | Uint8Array): PtmTile {
    let raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Typed-array views need their offsets aligned relative to the buffer
    // start, so a misaligned slice has to be copied once.
    if (raw.byteOffset % 4 !== 0) {
        raw = new Uint8Array(raw);
    }
    if (raw.byteLength < PTM_HEADER_BYTES) {
        throw new Error(`PTM1 too short: ${raw.byteLength}`);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PTM_MAGIC) {
        throw new Error(`Bad PTM1 magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint8(4);
    if (version !== PTM_VERSION) {
        throw new Error(
            `Unsupported PTM1 version ${version}, expected ${PTM_VERSION}. `
            + 'The terrain pyramid is a build product - re-run `npm run bake:mesh`.');
    }
    const z = view.getUint8(5);
    const flags = view.getUint16(6, true);
    const x = view.getUint32(8, true);
    const y = view.getUint32(12, true);
    const centerHeightM = view.getFloat32(16, true);
    const quantScale = view.getFloat32(20, true);
    const boundingRadiusM = view.getFloat32(28, true);
    const landVertCount = view.getUint32(32, true);
    const waterVertCount = view.getUint32(36, true);
    const waterIndexCount = view.getUint32(40, true);
    const riverVertCount = view.getUint32(44, true);
    const riverIndexCount = view.getUint32(48, true);
    const waterDeep = view.getUint32(56, true);
    const waterShallow = view.getUint32(60, true);
    const skirtDepthM = view.getFloat32(64, true);
    const geometricErrorM = view.getFloat32(PTM_GEOMETRIC_ERROR_OFFSET, true);

    if (landVertCount % 3 !== 0) {
        throw new Error(`PTM1: landVertCount ${landVertCount} is not a multiple of 3`);
    }
    if (waterDeep + waterShallow !== waterIndexCount) {
        throw new Error('PTM1: water group counts do not sum to waterIndexCount');
    }

    const landPosBytes = align4(landVertCount * 6);
    const landNrmBytes = align4(landVertCount * 4);
    const landAttrBytes = align4(landVertCount * 4);
    const waterPosBytes = align4(waterVertCount * 6);
    const waterToneBytes = align4(waterVertCount);
    const waterIdxBytes = align4(waterIndexCount * 2);
    const riverPosBytes = align4(riverVertCount * 6);
    const riverDirBytes = align4(riverVertCount * 4);
    const riverHalfBytes = align4(riverVertCount * 2);
    const riverIdxBytes = align4(riverIndexCount * 2);
    const expected = PTM_HEADER_BYTES + landPosBytes + landNrmBytes + landAttrBytes
        + waterPosBytes + waterToneBytes + waterIdxBytes
        + riverPosBytes + riverDirBytes + riverHalfBytes + riverIdxBytes;
    if (raw.byteLength < expected) {
        throw new Error(`PTM1 truncated: ${raw.byteLength} < ${expected}`);
    }

    let off = raw.byteOffset + PTM_HEADER_BYTES;
    const landPositions = new Int16Array(raw.buffer, off, landVertCount * 3);
    off += landPosBytes;
    const landNormals = new Int8Array(raw.buffer, off, landVertCount * 4);
    off += landNrmBytes;
    const landAttrs = new Uint8Array(raw.buffer, off, landVertCount * 4);
    off += landAttrBytes;
    const waterPositions = new Int16Array(raw.buffer, off, waterVertCount * 3);
    off += waterPosBytes;
    const waterTones = new Uint8Array(raw.buffer, off, waterVertCount);
    off += waterToneBytes;
    const waterIndices = new Uint16Array(raw.buffer, off, waterIndexCount);
    off += waterIdxBytes;
    const riverPositions = new Int16Array(raw.buffer, off, riverVertCount * 3);
    off += riverPosBytes;
    const riverDirections = new Int8Array(raw.buffer, off, riverVertCount * 4);
    off += riverDirBytes;
    const riverHalfWidths = new Uint16Array(raw.buffer, off, riverVertCount);
    off += riverHalfBytes;
    const riverIndices = new Uint16Array(raw.buffer, off, riverIndexCount);

    return {
        id: { z, x, y },
        version,
        flags,
        centerHeightM,
        quantScale,
        boundingRadiusM,
        skirtDepthM,
        geometricErrorM,
        landPositions,
        landNormals,
        landAttrs,
        waterPositions,
        waterTones,
        waterIndices,
        waterGroups: [
            [0, waterDeep],
            [waterDeep, waterShallow],
        ],
        riverPositions,
        riverDirections,
        riverHalfWidths,
        riverIndices,
    };
}
