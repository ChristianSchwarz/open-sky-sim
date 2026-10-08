/**
 * PBD1 - "Planet Bed Data", what the bake's grading left besides the land and
 * the strokes (tools/bake_planet_grade.ts): the beds the lines were laid on,
 * which the collision field clamps to and the trees and stones keep off
 * (railBed.ts buildRailBedExclusion, railBedField.ts), and the retaining walls.
 * One per graded tile that has a bed, z8 up.
 *
 * Layout, little-endian, 32-byte header:
 *
 *    0  u32  magic 'PBD1'        8  u32  x       20  u32  bed count
 *    4  u8   version = 1        12  u32  y       24  u32  wall vertex count
 *    5  u8   z                  16  f32  quantScale   28  u32  wall index count
 *    6  u16  reserved
 *
 *   beds, 20 bytes each: i16 x3 end A, i16 x3 end B (tile frame, quantised
 *   like the tile), u16 half width cm, u16 lift cm, u8 open (BED_OPEN_*),
 *   u8 tier, u16 batter reach cm - railBed.ts RailBedResult.beds, quantised
 *   walls: i16 x3 per vertex (padded to 4), i8 x4 normal per vertex, u32 indices
 */

import { BED_OPEN_A, BED_OPEN_B, RAIL_BED_SEGMENT_FLOATS, RailWalls } from './railBed';
import { TileKey } from './tiling';

const PBD_MAGIC = 0x31444250; // 'PBD1'
const PBD_VERSION = 1;
const PBD_HEADER_BYTES = 32;
const BED_BYTES = 20;

export interface PbdTile {
    id: TileKey;
    quantScale: number;
    /** RAIL_BED_SEGMENT_FLOATS per bed, the tile's frame, metres (railBed.ts RailBedResult.beds). */
    beds: Float64Array;
    /** Retaining walls, tile frame, metres. */
    walls?: RailWalls;
}

const align4 = (n: number) => (n + 3) & ~3;
const q16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
const cm = (v: number) => Math.max(0, Math.min(65535, Math.round(v * 100)));

export function encodePbd(t: PbdTile): Uint8Array {
    const n = t.beds.length / RAIL_BED_SEGMENT_FLOATS;
    const wv = t.walls ? t.walls.positions.length / 3 : 0;
    const wi = t.walls ? t.walls.indices.length : 0;
    const out = new Uint8Array(PBD_HEADER_BYTES + n * BED_BYTES + align4(wv * 6) + wv * 4 + wi * 4);
    const view = new DataView(out.buffer);
    view.setUint32(0, PBD_MAGIC, true);
    view.setUint8(4, PBD_VERSION);
    view.setUint8(5, t.id.z);
    view.setUint32(8, t.id.x, true);
    view.setUint32(12, t.id.y, true);
    view.setFloat32(16, t.quantScale, true);
    view.setUint32(20, n, true);
    view.setUint32(24, wv, true);
    view.setUint32(28, wi, true);
    const q = t.quantScale;
    let o = PBD_HEADER_BYTES;
    for (let i = 0; i < n; i++, o += BED_BYTES) {
        const b = i * RAIL_BED_SEGMENT_FLOATS;
        for (let k = 0; k < 6; k++) {
            view.setInt16(o + k * 2, q16(t.beds[b + k] / q), true);
        }
        view.setUint16(o + 12, cm(t.beds[b + 6]), true);
        view.setUint16(o + 14, cm(t.beds[b + 7]), true);
        view.setUint8(o + 16, t.beds[b + 8]);
        view.setUint8(o + 17, t.beds[b + 9]);
        view.setUint16(o + 18, cm(t.beds[b + 10]), true);
    }
    if (t.walls) {
        const w = t.walls;
        for (let i = 0; i < wv * 3; i++) {
            view.setInt16(o + i * 2, q16(w.positions[i] / q), true);
        }
        o += align4(wv * 6);
        for (let i = 0; i < wv; i++) {
            for (let k = 0; k < 3; k++) {
                view.setInt8(o + i * 4 + k, Math.max(-127, Math.min(127, Math.round(w.normals[i * 3 + k] * 127))));
            }
        }
        o += wv * 4;
        for (let i = 0; i < wi; i++) {
            view.setUint32(o + i * 4, w.indices[i], true);
        }
    }
    return out;
}

export function decodePbd(bytes: ArrayBuffer | Uint8Array): PbdTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw.byteLength < PBD_HEADER_BYTES || view.getUint32(0, true) !== PBD_MAGIC || view.getUint8(4) !== PBD_VERSION) {
        throw new Error('not a PBD1 v1 file');
    }
    const q = view.getFloat32(16, true);
    const n = view.getUint32(20, true), wv = view.getUint32(24, true), wi = view.getUint32(28, true);
    const beds = new Float64Array(n * RAIL_BED_SEGMENT_FLOATS);
    let o = PBD_HEADER_BYTES;
    for (let i = 0; i < n; i++, o += BED_BYTES) {
        const b = i * RAIL_BED_SEGMENT_FLOATS;
        for (let k = 0; k < 6; k++) {
            beds[b + k] = view.getInt16(o + k * 2, true) * q;
        }
        beds[b + 6] = view.getUint16(o + 12, true) / 100;
        beds[b + 7] = view.getUint16(o + 14, true) / 100;
        beds[b + 8] = view.getUint8(o + 16);
        beds[b + 9] = view.getUint8(o + 17);
        beds[b + 10] = view.getUint16(o + 18, true) / 100;
    }
    let walls: RailWalls | undefined;
    if (wv > 0 && wi > 0) {
        const positions = new Float32Array(wv * 3), normals = new Float32Array(wv * 3), indices = new Uint32Array(wi);
        for (let i = 0; i < wv * 3; i++) {
            positions[i] = view.getInt16(o + i * 2, true) * q;
        }
        o += align4(wv * 6);
        for (let i = 0; i < wv; i++) {
            for (let k = 0; k < 3; k++) {
                normals[i * 3 + k] = view.getInt8(o + i * 4 + k) / 127;
            }
        }
        o += wv * 4;
        for (let i = 0; i < wi; i++) {
            indices[i] = view.getUint32(o + i * 4, true);
        }
        walls = { positions, normals, indices };
    }
    return { id: { z: view.getUint8(5), x: view.getUint32(8, true), y: view.getUint32(12, true) }, quantScale: q, beds, walls };
}

/**
 * Beds with the runs that lie on one straight line merged: a profile is
 * sampled every 5 m, so a long straight grade is dozens of segments that say
 * the same thing. Consecutive segments merge where they join end to end, have
 * the same tier, width and no open end between them, and every joint dropped
 * lies within `toleranceM` of the merged line (3D, so both its plan and its
 * height). The merged lift and reach are the largest of the run's: the
 * batter they describe can only grow.
 */
export function simplifyBeds(beds: Float64Array, toleranceM = 0.05): Float64Array {
    const F = RAIL_BED_SEGMENT_FLOATS;
    const n = beds.length / F;
    const out: number[] = [];
    const at = (i: number, k: number) => beds[i * F + k];
    const joins = (i: number, j: number) => at(i, 9) === at(j, 9) && Math.abs(at(i, 6) - at(j, 6)) < 1e-6
        && (at(i, 8) & BED_OPEN_B) === 0 && (at(j, 8) & BED_OPEN_A) === 0
        && Math.abs(at(i, 3) - at(j, 0)) < 1e-6 && Math.abs(at(i, 4) - at(j, 1)) < 1e-6 && Math.abs(at(i, 5) - at(j, 2)) < 1e-6;
    const offLine = (s: number, e: number): boolean => {
        // Every joint between segments s..e against the line from s's A to e's B.
        const ax = at(s, 0), ay = at(s, 1), az = at(s, 2);
        const dx = at(e, 3) - ax, dy = at(e, 4) - ay, dz = at(e, 5) - az;
        const l2 = dx * dx + dy * dy + dz * dz || 1;
        for (let k = s; k < e; k++) {
            const px = at(k, 3) - ax, py = at(k, 4) - ay, pz = at(k, 5) - az;
            const t = Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / l2));
            if (Math.hypot(px - dx * t, py - dy * t, pz - dz * t) > toleranceM) {
                return true;
            }
        }
        return false;
    };
    let i = 0;
    while (i < n) {
        let e = i;
        while (e + 1 < n && joins(e, e + 1) && !offLine(i, e + 1)) {
            e++;
        }
        let lift = 0, reach = 0;
        for (let k = i; k <= e; k++) {
            lift = Math.max(lift, at(k, 7));
            reach = Math.max(reach, at(k, 10));
        }
        out.push(at(i, 0), at(i, 1), at(i, 2), at(e, 3), at(e, 4), at(e, 5), at(i, 6), lift, (at(i, 8) & BED_OPEN_A) | (at(e, 8) & BED_OPEN_B), at(i, 9), reach);
        i = e + 1;
    }
    return Float64Array.from(out);
}
