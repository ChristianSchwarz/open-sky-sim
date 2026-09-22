/**
 * RBR1 - the per-leaf-tile bridge and tunnel spans tools/bake_osm_roads.py
 * writes beside the .rvr: one record per mapped span, whole and unclipped,
 * filed under the tile holding its midpoint. Bake-time only; the runtime sees
 * the finished .pbr.
 *
 * Layout, zlib-compressed: 'RBR1', u16 count, then per span u8 structure,
 * i8 layer, f32 deckWidthM, f32 maxheightM, u8 cls (255 = none), u16 n,
 * n x (f32 lon, f32 lat).
 */

import { unzlibSync } from 'fflate';
import { Structure, STRUCTURES } from './bridges';
import { LonLat } from './lvr';

export const RBR_MAGIC = 0x31524252; // 'RBR1' little-endian

export interface BridgeRecord {
    structure: Structure;
    layer: number;
    deckWidthM: number;
    /** Tagged maxheight, 0 when untagged. Limit for vehicles ON the span. */
    maxHeightM: number;
    /**
     * The road class (RoadClass, tools/bake_osm_roads.py's ROAD_CLASSES) the
     * span itself carries, undefined when the way had no ordinary highway
     * class. The span's own tag, not a road that merely ends near an
     * abutment - see crossings.ts.
     */
    cls?: number;
    points: LonLat[];
}

export function decodeRbr(bytes: ArrayBuffer | Uint8Array): BridgeRecord[] {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const bare = raw.byteLength >= 4
        && raw[0] === 0x52 && raw[1] === 0x42 && raw[2] === 0x52 && raw[3] === 0x31;
    const payload = bare ? raw : unzlibSync(raw);
    if (payload.byteLength < 6) {
        throw new Error(`RBR too short: ${payload.byteLength}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (view.getUint32(0, true) !== RBR_MAGIC) {
        throw new Error(`Bad RBR magic: 0x${view.getUint32(0, true).toString(16)}`);
    }
    const count = view.getUint16(4, true);
    let off = 6;
    const out: BridgeRecord[] = [];
    for (let r = 0; r < count; r++) {
        if (off + 15 > payload.byteLength) {
            throw new Error(`RBR truncated at span ${r}`);
        }
        const structure = STRUCTURES[view.getUint8(off)];
        if (structure === undefined) {
            throw new Error(`RBR span ${r}: unknown structure byte ${view.getUint8(off)}`);
        }
        const layer = view.getInt8(off + 1);
        const deckWidthM = view.getFloat32(off + 2, true);
        const maxHeightM = view.getFloat32(off + 6, true);
        const clsByte = view.getUint8(off + 10);
        const n = view.getUint16(off + 11, true);
        off += 13;
        if (off + n * 8 > payload.byteLength) {
            throw new Error(`RBR truncated inside span ${r}`);
        }
        const points: LonLat[] = new Array(n);
        for (let i = 0; i < n; i++) {
            points[i] = { lon: view.getFloat32(off, true), lat: view.getFloat32(off + 4, true) };
            off += 8;
        }
        out.push({ structure, layer, deckWidthM, maxHeightM, cls: clsByte === 255 ? undefined : clsByte, points });
    }
    return out;
}
