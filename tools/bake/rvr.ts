/**
 * RVR1 - the per-tile road vectors tools/bake_osm_roads.py writes into the
 * planet pyramid: OSM highway runs clipped to the tile, each with its class
 * byte and true width. Bake-time only; the runtime sees the draped .ptr.
 *
 * Layout, zlib-compressed: 'RVR1', u16 count, then per road u8 class,
 * f32 widthM, u16 n, n x (f32 lon, f32 lat).
 */

import { unzlibSync } from 'fflate';
import { LonLat } from './lvr';

export const RVR_MAGIC = 0x31525652; // 'RVR1' little-endian
/** RVR2: points as f32 offsets from an f64 origin (see encode_rvr in bake_osm_roads.py). */
export const RVR2_MAGIC = 0x32525652; // 'RVR2' little-endian

export interface RoadLine {
    /** A RoadClass byte (see src/script/terrain/ptr.ts). */
    cls: number;
    /** True carriageway width, metres. */
    widthM: number;
    /** Centreline, clipped to the tile. Two points or more. */
    points: LonLat[];
}

export function decodeRvr(bytes: ArrayBuffer | Uint8Array): RoadLine[] {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const bare = raw.byteLength >= 4
        && raw[0] === 0x52 && raw[1] === 0x56 && raw[2] === 0x52 && (raw[3] === 0x31 || raw[3] === 0x32);
    const payload = bare ? raw : unzlibSync(raw);
    if (payload.byteLength < 6) {
        throw new Error(`RVR too short: ${payload.byteLength}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const magic = view.getUint32(0, true);
    let lon0 = 0, lat0 = 0, count: number, off: number;
    if (magic === RVR2_MAGIC) {
        lon0 = view.getFloat64(4, true);
        lat0 = view.getFloat64(12, true);
        count = view.getUint16(20, true);
        off = 22;
    } else if (magic === RVR_MAGIC) {
        count = view.getUint16(4, true);
        off = 6;
    } else {
        throw new Error(`Bad RVR magic: 0x${magic.toString(16)}`);
    }
    const out: RoadLine[] = [];
    for (let r = 0; r < count; r++) {
        if (off + 7 > payload.byteLength) {
            throw new Error(`RVR truncated at road ${r}`);
        }
        const cls = view.getUint8(off);
        const widthM = view.getFloat32(off + 1, true);
        const n = view.getUint16(off + 5, true);
        off += 7;
        if (off + n * 8 > payload.byteLength) {
            throw new Error(`RVR truncated inside road ${r}`);
        }
        const points: LonLat[] = new Array(n);
        for (let i = 0; i < n; i++) {
            points[i] = { lon: lon0 + view.getFloat32(off, true), lat: lat0 + view.getFloat32(off + 4, true) };
            off += 8;
        }
        out.push({ cls, widthM, points });
    }
    return out;
}
