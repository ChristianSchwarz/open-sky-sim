/**
 * PBH1 - "Planet Tile Buildings", the building sidecar of a z12 leaf.
 *
 * One record per building: its footprint, how high its walls and roof go and
 * what shape and colour the roof is - the parameters, not the triangles, so a
 * city leaf of 30 000 buildings stays a few hundred kilobytes and the runtime
 * can pick how much of it to build (see buildingRoofs.ts). Written by
 * tools/bake_planet_buildings.ts from the .bvr footprints and the finished
 * .ptm, which is what knows the ground each one stands on.
 *
 * Everything is in a true local frame of the tile (tools/bake/tileSurface.ts):
 * two horizontal axes `a`, `b` and `up`, given in the tile's own axes, so a
 * point (u, v, h) sits at u*a + v*b + h*up metres from the tile centre. The
 * tile's own y axis leans off the vertical by up to tens of degrees far from
 * the bake's ENU origin, and walls built along it would lean with it.
 *
 * Records are sorted most prominent first (see buildingProminence), so the
 * runtime draws a far tile as a prefix of its index buffer.
 *
 * Layout, little-endian:
 *
 *    0  u32  magic 'PBH1'        8  u32  x
 *    4  u8   version = 2        12  u32  y
 *    5  u8   z                  16  f32  a.x a.y a.z  b.x b.y b.z  up.x up.y up.z
 *    6  u16  reserved           52  u32  buildingCount   56  u32  ringCount   60  u32  vertCount
 *
 *   payload, each section padded to a 4-byte boundary
 *     building  20 bytes each:
 *       u32 firstRing | i16 base (dm, h of the walls' foot) | u16 eave (dm above base) |
 *       u16 ridge (dm above base) | u16 ridge angle (0..65536 = 0..2pi, from a toward b) |
 *       u8 RoofForm | u8 roof tone | u8 wall tone | u8 rings | u8 flags |
 *       u8 x3 roof sRGB (read when flags has PBH_FLAG_ROOF_RGB)
 *     The angle is a full turn because a skillion rises toward one side: its
 *     roof climbs toward the angle plus a quarter turn.
 *     Version 1 wrote zeros where the roof sRGB is and never set the flag.
 *     ring      u8 vertex count each; a building's first ring is its outline (counter-clockwise
 *               seen from up), the rest are courtyards (clockwise)
 *     vertex    i16 u, i16 v each, PBH_STEP_M units
 */

import { TileKey } from './tiling';

const PBH_MAGIC = 0x31484250; // 'PBH1' little-endian
const PBH_VERSION = 2;
const PBH_HEADER_BYTES = 64;
const PBH_BUILDING_BYTES = 20;

/** Footprint coordinate step: i16 covers +-8.2 km around the tile centre. */
export const PBH_STEP_M = 0.25;
/** Height step of base, eave and ridge. */
export const PBH_HEIGHT_STEP_M = 0.1;
/** Most vertices one ring may carry (the count is a byte). */
export const PBH_MAX_RING_VERTS = 255;

/**
 * What a building is, from its OSM tags. Keep in step with
 * tools/bake_osm_buildings.py KIND_*.
 */
export const enum BuildingKind {
    Yes = 0,
    House = 1,
    Residential = 2,
    Small = 3,
    Farm = 4,
    Greenhouse = 5,
    Industrial = 6,
    Commercial = 7,
    Civic = 8,
    Religious = 9,
    Roof = 10,
    Tower = 11,
    Tank = 12,
    Ruin = 13,
    /** Drawn by the airfield model; in the footprints only so the LoD2 import adds no twin. */
    Airfield = 14,
}

/**
 * The roof shapes the runtime builds. The values are the .bvr's OSM
 * roof:shape codes for the same shapes (bake_osm_buildings.py ROOF_SHAPES);
 * the bake maps the others onto these.
 */
export const enum RoofForm {
    Flat = 1,
    Gabled = 2,
    Hipped = 3,
    HalfHipped = 4,
    Skillion = 5,
    Pyramidal = 6,
}

/** Record flags. */
export const PBH_FLAG_NO_WALLS = 1; // a roof on posts: building=roof, carports, canopies
/** The roof's colour was measured in an orthophoto (tools/measure_buildings.py): `roofRgb` holds it. */
export const PBH_FLAG_ROOF_RGB = 2;

export interface PbhFrame {
    a: [number, number, number];
    b: [number, number, number];
    up: [number, number, number];
}

export interface PbhBuilding {
    /** Index of its first ring in `ringSizes`. */
    firstRing: number;
    ringCount: number;
    /** Index of its first vertex (pairs in `verts`). */
    firstVert: number;
    baseM: number;
    eaveM: number;
    ridgeM: number;
    form: RoofForm;
    /** Ridge direction, radians from `a` toward `b`, [0, 2pi). */
    ridgeAngle: number;
    roofTone: number;
    wallTone: number;
    flags: number;
    /** 0xRRGGBB sRGB, meaningful when flags has PBH_FLAG_ROOF_RGB. */
    roofRgb: number;
}

export interface PbhTile {
    id: TileKey;
    frame: PbhFrame;
    buildings: PbhBuilding[];
    ringSizes: Uint8Array;
    /** Footprint vertices as (u, v) metres. */
    verts: Float32Array;
}

export interface PbhEncodeBuilding {
    /** Outline first (counter-clockwise from up), then courtyards; open rings, (u, v) metres. */
    rings: Array<Array<[number, number]>>;
    baseM: number;
    eaveM: number;
    ridgeM: number;
    form: RoofForm;
    ridgeAngle: number;
    roofTone: number;
    wallTone: number;
    flags: number;
    /** 0xRRGGBB sRGB; sets PBH_FLAG_ROOF_RGB. Absent: the roof takes its tone. */
    roofRgb?: number;
}

const align4 = (n: number) => (n + 3) & ~3;

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
const clampU16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));

export function encodePbh(id: TileKey, frame: PbhFrame, buildings: readonly PbhEncodeBuilding[]): Uint8Array {
    let ringCount = 0;
    let vertCount = 0;
    for (const b of buildings) {
        if (b.rings.length > 255) {
            throw new Error(`PBH1: ${b.rings.length} rings in one building`);
        }
        ringCount += b.rings.length;
        for (const r of b.rings) {
            if (r.length > PBH_MAX_RING_VERTS) {
                throw new Error(`PBH1: ring of ${r.length} vertices`);
            }
            vertCount += r.length;
        }
    }
    const bBytes = align4(buildings.length * PBH_BUILDING_BYTES);
    const rBytes = align4(ringCount);
    const vBytes = align4(vertCount * 4);
    const out = new Uint8Array(PBH_HEADER_BYTES + bBytes + rBytes + vBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, PBH_MAGIC, true);
    view.setUint8(4, PBH_VERSION);
    view.setUint8(5, id.z);
    view.setUint32(8, id.x, true);
    view.setUint32(12, id.y, true);
    const axes = [...frame.a, ...frame.b, ...frame.up];
    for (let i = 0; i < 9; i++) {
        view.setFloat32(16 + i * 4, axes[i], true);
    }
    view.setUint32(52, buildings.length, true);
    view.setUint32(56, ringCount, true);
    view.setUint32(60, vertCount, true);
    let bo = PBH_HEADER_BYTES;
    let ro = PBH_HEADER_BYTES + bBytes;
    let vo = ro + rBytes;
    let ring = 0;
    for (const b of buildings) {
        view.setUint32(bo, ring, true);
        view.setInt16(bo + 4, clampI16(b.baseM / PBH_HEIGHT_STEP_M), true);
        view.setUint16(bo + 6, clampU16((b.eaveM - b.baseM) / PBH_HEIGHT_STEP_M), true);
        view.setUint16(bo + 8, clampU16((b.ridgeM - b.baseM) / PBH_HEIGHT_STEP_M), true);
        const turn = 2 * Math.PI;
        const angle = ((b.ridgeAngle % turn) + turn) % turn;
        view.setUint16(bo + 10, Math.round(angle / turn * 65536) & 0xffff, true);
        view.setUint8(bo + 12, b.form);
        view.setUint8(bo + 13, b.roofTone);
        view.setUint8(bo + 14, b.wallTone);
        view.setUint8(bo + 15, b.rings.length);
        view.setUint8(bo + 16, b.flags | (b.roofRgb !== undefined ? PBH_FLAG_ROOF_RGB : 0));
        if (b.roofRgb !== undefined) {
            view.setUint8(bo + 17, (b.roofRgb >> 16) & 255);
            view.setUint8(bo + 18, (b.roofRgb >> 8) & 255);
            view.setUint8(bo + 19, b.roofRgb & 255);
        }
        bo += PBH_BUILDING_BYTES;
        for (const r of b.rings) {
            out[ro++] = r.length;
            ring++;
            for (const [u, v] of r) {
                view.setInt16(vo, clampI16(u / PBH_STEP_M), true);
                view.setInt16(vo + 2, clampI16(v / PBH_STEP_M), true);
                vo += 4;
            }
        }
    }
    return out;
}

export function decodePbh(bytes: ArrayBuffer | Uint8Array): PbhTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (raw.byteLength < PBH_HEADER_BYTES) {
        throw new Error(`PBH1 too short: ${raw.byteLength}`);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PBH_MAGIC) {
        throw new Error(`Bad PBH1 magic: 0x${magic.toString(16)}`);
    }
    const version = view.getUint8(4);
    if (version < 1 || version > PBH_VERSION) {
        throw new Error(`PBH1 version ${version}, expected 1 to ${PBH_VERSION}`);
    }
    const id: TileKey = { z: view.getUint8(5), x: view.getUint32(8, true), y: view.getUint32(12, true) };
    const f = (i: number) => view.getFloat32(16 + i * 4, true);
    const frame: PbhFrame = { a: [f(0), f(1), f(2)], b: [f(3), f(4), f(5)], up: [f(6), f(7), f(8)] };
    const count = view.getUint32(52, true);
    const ringCount = view.getUint32(56, true);
    const vertCount = view.getUint32(60, true);
    const bBytes = align4(count * PBH_BUILDING_BYTES);
    const rBytes = align4(ringCount);
    const need = PBH_HEADER_BYTES + bBytes + rBytes + vertCount * 4;
    if (raw.byteLength < need) {
        throw new Error(`PBH1 ${id.z}/${id.x}/${id.y}: ${raw.byteLength} bytes, ${need} needed`);
    }
    const ringSizes = raw.slice(PBH_HEADER_BYTES + bBytes, PBH_HEADER_BYTES + bBytes + ringCount);
    const firstVertOfRing = new Uint32Array(ringCount + 1);
    for (let r = 0; r < ringCount; r++) {
        firstVertOfRing[r + 1] = firstVertOfRing[r] + ringSizes[r];
    }
    const verts = new Float32Array(vertCount * 2);
    const vo = PBH_HEADER_BYTES + bBytes + rBytes;
    for (let i = 0; i < vertCount; i++) {
        verts[i * 2] = view.getInt16(vo + i * 4, true) * PBH_STEP_M;
        verts[i * 2 + 1] = view.getInt16(vo + i * 4 + 2, true) * PBH_STEP_M;
    }
    const buildings: PbhBuilding[] = new Array(count);
    for (let i = 0; i < count; i++) {
        const o = PBH_HEADER_BYTES + i * PBH_BUILDING_BYTES;
        const firstRing = view.getUint32(o, true);
        const baseM = view.getInt16(o + 4, true) * PBH_HEIGHT_STEP_M;
        buildings[i] = {
            firstRing,
            ringCount: view.getUint8(o + 15),
            firstVert: firstVertOfRing[Math.min(firstRing, ringCount)],
            baseM,
            eaveM: baseM + view.getUint16(o + 6, true) * PBH_HEIGHT_STEP_M,
            ridgeM: baseM + view.getUint16(o + 8, true) * PBH_HEIGHT_STEP_M,
            form: view.getUint8(o + 12) as RoofForm,
            ridgeAngle: view.getUint16(o + 10, true) / 65536 * 2 * Math.PI,
            roofTone: view.getUint8(o + 13),
            wallTone: view.getUint8(o + 14),
            flags: view.getUint8(o + 16),
            roofRgb: (view.getUint8(o + 17) << 16) | (view.getUint8(o + 18) << 8) | view.getUint8(o + 19),
        };
    }
    return { id, frame, buildings, ringSizes, verts };
}

/** A building's rings as arrays of (u, v) pairs, outline first. */
export function pbhRings(tile: PbhTile, b: PbhBuilding): Array<Array<[number, number]>> {
    const rings: Array<Array<[number, number]>> = [];
    let v = b.firstVert;
    for (let r = 0; r < b.ringCount; r++) {
        const n = tile.ringSizes[b.firstRing + r];
        const ring: Array<[number, number]> = new Array(n);
        for (let k = 0; k < n; k++, v++) {
            ring[k] = [tile.verts[v * 2], tile.verts[v * 2 + 1]];
        }
        rings.push(ring);
    }
    return rings;
}

/**
 * How much a building stands out from the air, in metres: the larger of its
 * footprint's side and its height. The bake sorts by it and the runtime
 * cuts a far tile's list where it falls under a few pixels.
 */
export function buildingProminence(areaM2: number, heightM: number): number {
    return Math.max(Math.sqrt(Math.max(0, areaM2)), heightM);
}
