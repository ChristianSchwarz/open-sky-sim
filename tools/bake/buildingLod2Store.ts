/**
 * The LoD2 store tools/import_lod2.py writes: per z12 leaf, the official
 * LoD2 building(s) standing on each OSM footprint - roof form, eave, ridge,
 * ridge direction - keyed by OSM id (BLS1,
 * data/imports/buildings/lod2/12/x/y.bls). Bake-time only.
 *
 * Layout, zlib-compressed (see encode_bls):
 *   'BLS1' | u8 version | u8 0 | u16 0 | u32 .bvr crc32 | u32 count |
 *   per building: i64 id | u8 RoofForm (0 = none of the six) | u8 match | u16 AdV roof type |
 *     u16 azimuth (0.01 deg, 0xFFFF = none) | u16 eave (cm) | u16 ridge (cm) | u8 LoD2 buildings
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzlibSync } from 'fflate';
import { RoofForm } from '../../src/script/terrain/pbh';
import { TileKey } from './index';

const BLS_MAGIC = 0x31534c42; // 'BLS1' little-endian
const BLS_VERSION = 1;
const HEAD_BYTES = 16;
const REC_BYTES = 19;
const NO_AZIMUTH = 0xffff;

export const DEFAULT_LOD2_STORE = 'data/imports/buildings/lod2';

/** One LoD2 building of about the footprint's area. */
export const LOD2_MATCH_ONE = 1;
/** Several LoD2 buildings adding up to the footprint (a terrace drawn as one outline). */
export const LOD2_MATCH_MERGED = 2;
/** LoD2 building(s) on the footprint but of a very different area: not used. */
export const LOD2_MATCH_PARTIAL = 3;

export interface Lod2Building {
    /** The runtime form, or undefined for an AdV type none of them is (mixed, other). */
    form: RoofForm | undefined;
    match: number;
    /** AdV roof type code (1000 flat, 3100 gabled, ...). */
    adv: number;
    /** Compass degrees of the ridge axis in the runtime's sense, undefined where there is none. */
    azimuthDeg: number | undefined;
    /** Lowest eave and ridge above the LoD2 ground, metres. */
    eaveM: number;
    ridgeM: number;
    parts: number;
}

export function decodeBls(bytes: Uint8Array): { signature: number; buildings: Map<number, Lod2Building> } {
    const data = unzlibSync(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < HEAD_BYTES || view.getUint32(0, true) !== BLS_MAGIC) {
        throw new Error('not a BLS1 file');
    }
    if (view.getUint8(4) !== BLS_VERSION) {
        throw new Error(`BLS1 version ${view.getUint8(4)}, expected ${BLS_VERSION}; re-run import_lod2.py`);
    }
    const signature = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    const buildings = new Map<number, Lod2Building>();
    for (let i = 0; i < count; i++) {
        const o = HEAD_BYTES + i * REC_BYTES;
        const form = data[o + 8];
        const az = view.getUint16(o + 12, true);
        buildings.set(Number(view.getBigInt64(o, true)), {
            form: form === 0 ? undefined : form as RoofForm,
            match: data[o + 9],
            adv: view.getUint16(o + 10, true),
            azimuthDeg: az === NO_AZIMUTH ? undefined : az / 100,
            eaveM: view.getUint16(o + 14, true) / 100,
            ridgeM: view.getUint16(o + 16, true) / 100,
            parts: data[o + 18],
        });
    }
    return { signature, buildings };
}

/** The LoD2 matches of one leaf, or undefined when it was never matched. */
export function readLod2(storeDir: string, k: TileKey): Map<number, Lod2Building> | undefined {
    const file = path.join(storeDir, String(k.z), String(k.x), `${k.y}.bls`);
    if (!fs.existsSync(file)) {
        return undefined;
    }
    return decodeBls(fs.readFileSync(file)).buildings;
}
