/**
 * BVR1 - the per-leaf building footprints tools/bake_osm_buildings.py writes
 * into the planet pyramid: each OSM building whole, filed under the leaf
 * holding its centroid, with the tags that say how it looks parsed to
 * numbers. Bake-time only; the runtime sees the .pbh.
 *
 * Layout, zlib-compressed (see encode_bvr in bake_osm_buildings.py):
 *   'BVR1' | f64 lon0 | f64 lat0 | u32 count |
 *   per building: i64 id | u8 kind | u8 roof shape | u8 roof orientation | u8 rings |
 *     f32 height, min_height, levels, roof height, roof levels, roof direction |
 *     i32 roof colour | i32 wall colour |
 *     per ring: u16 n | n x (f32 lon - lon0, f32 lat - lat0)
 */

import { unzlibSync } from 'fflate';

const BVR_MAGIC = 0x31525642; // 'BVR1' little-endian

export const ORIENTATION_ALONG = 1;
export const ORIENTATION_ACROSS = 2;

export interface BvrBuilding {
    /** OSM way id, or minus the relation id. */
    id: number;
    /** BuildingKind (src/script/terrain/pbh.ts). */
    kind: number;
    /** OSM roof:shape code, 0 = untagged (bake_osm_buildings.py ROOF_SHAPES). */
    roofShape: number;
    roofOrientation: number;
    /** Metres; NaN where untagged. */
    height: number;
    minHeight: number;
    levels: number;
    roofHeight: number;
    roofLevels: number;
    /** Compass degrees the roof slope faces; NaN where untagged. */
    roofDirection: number;
    /** 0xRRGGBB, or -1 where untagged. */
    roofColour: number;
    wallColour: number;
    /** Outline first, then courtyards; open rings of [lon, lat]. */
    rings: Array<Array<[number, number]>>;
}

export function decodeBvr(bytes: ArrayBuffer | Uint8Array): BvrBuilding[] {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const bare = raw.byteLength >= 4 && raw[0] === 0x42 && raw[1] === 0x56 && raw[2] === 0x52 && raw[3] === 0x31;
    const data = bare ? raw : unzlibSync(raw);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < 24 || view.getUint32(0, true) !== BVR_MAGIC) {
        throw new Error('not a BVR1 file');
    }
    const lon0 = view.getFloat64(4, true);
    const lat0 = view.getFloat64(12, true);
    const count = view.getUint32(20, true);
    let off = 24;
    const out: BvrBuilding[] = new Array(count);
    for (let i = 0; i < count; i++) {
        if (off + 44 > data.byteLength) {
            throw new Error(`BVR1 truncated at building ${i}`);
        }
        const id = Number(view.getBigInt64(off, true));
        const kind = view.getUint8(off + 8);
        const roofShape = view.getUint8(off + 9);
        const roofOrientation = view.getUint8(off + 10);
        const ringCount = view.getUint8(off + 11);
        const f = (k: number) => view.getFloat32(off + 12 + k * 4, true);
        const b: BvrBuilding = {
            id, kind, roofShape, roofOrientation,
            height: f(0), minHeight: f(1), levels: f(2), roofHeight: f(3), roofLevels: f(4), roofDirection: f(5),
            roofColour: view.getInt32(off + 36, true),
            wallColour: view.getInt32(off + 40, true),
            rings: [],
        };
        off += 44;
        for (let r = 0; r < ringCount; r++) {
            const n = view.getUint16(off, true);
            off += 2;
            if (off + n * 8 > data.byteLength) {
                throw new Error(`BVR1 truncated inside building ${i}`);
            }
            const ring: Array<[number, number]> = new Array(n);
            for (let k = 0; k < n; k++) {
                ring[k] = [lon0 + view.getFloat32(off, true), lat0 + view.getFloat32(off + 4, true)];
                off += 8;
            }
            b.rings.push(ring);
        }
        out[i] = b;
    }
    return out;
}
