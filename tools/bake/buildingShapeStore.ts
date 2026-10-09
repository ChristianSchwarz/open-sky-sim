/**
 * The building shape store tools/measure_roof_shapes.py writes: per z12
 * leaf, each building's roof form, eave and ridge height above the ground
 * and ridge azimuth, fitted to a surface model, keyed by OSM id (BHS1,
 * data/imports/buildings/shape/12/x/y.bhs). Bake-time only.
 *
 * Layout, zlib-compressed (see encode_bhs):
 *   'BHS1' | u8 version | u8 0 | u16 0 | u32 .bvr crc32 | u32 count |
 *   per building: i64 id | u8 RoofForm | u8 flags | u16 azimuth (0.01 deg) | u16 eave (cm) |
 *     u16 ridge (cm) | u16 rmse (cm) | u8 confidence (/255) | u16 points
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzlibSync } from 'fflate';
import { RoofForm } from '../../src/script/terrain/pbh';
import { TileKey } from './index';

const BHS_MAGIC = 0x31534842; // 'BHS1' little-endian
const BHS_VERSION = 1;
const HEAD_BYTES = 16;
const REC_BYTES = 21;
/** The surface model shows no building on this footprint (gone, or built since it was flown). */
export const SHAPE_ABSENT = 1;
/** The fitted form clearly beat every other form; without it only the heights are trusted. */
export const SHAPE_FORM_SURE = 2;

export const DEFAULT_SHAPE_STORE = 'data/imports/buildings/shape';

export interface MeasuredShape {
    form: RoofForm;
    flags: number;
    /**
     * Compass degrees of the ridge axis; for a skillion, the axis whose
     * quarter turn counter-clockwise (seen from above) points uphill - the
     * runtime's ridge angle, in compass terms.
     */
    azimuthDeg: number;
    /** Above the ground under the footprint, metres. */
    eaveM: number;
    ridgeM: number;
    rmseM: number;
    /** Of the heights; the form's certainty is SHAPE_FORM_SURE. */
    confidence: number;
    points: number;
}

export function decodeBhs(bytes: Uint8Array): { signature: number; shapes: Map<number, MeasuredShape> } {
    const data = unzlibSync(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < HEAD_BYTES || view.getUint32(0, true) !== BHS_MAGIC) {
        throw new Error('not a BHS1 file');
    }
    if (view.getUint8(4) !== BHS_VERSION) {
        throw new Error(`BHS1 version ${view.getUint8(4)}, expected ${BHS_VERSION}; re-run measure_roof_shapes.py`);
    }
    const signature = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    const shapes = new Map<number, MeasuredShape>();
    for (let i = 0; i < count; i++) {
        const o = HEAD_BYTES + i * REC_BYTES;
        shapes.set(Number(view.getBigInt64(o, true)), {
            form: data[o + 8] as RoofForm,
            flags: data[o + 9],
            azimuthDeg: view.getUint16(o + 10, true) / 100,
            eaveM: view.getUint16(o + 12, true) / 100,
            ridgeM: view.getUint16(o + 14, true) / 100,
            rmseM: view.getUint16(o + 16, true) / 100,
            confidence: data[o + 18] / 255,
            points: view.getUint16(o + 19, true),
        });
    }
    return { signature, shapes };
}

/** The measured shapes of one leaf, or undefined when it was never measured. */
export function readMeasuredShapes(storeDir: string, k: TileKey): Map<number, MeasuredShape> | undefined {
    const file = path.join(storeDir, String(k.z), String(k.x), `${k.y}.bhs`);
    if (!fs.existsSync(file)) {
        return undefined;
    }
    return decodeBhs(fs.readFileSync(file)).shapes;
}
