/**
 * The building colour store tools/measure_buildings.py writes: per z12 leaf,
 * each building's roof colour as measured in an orthophoto, keyed by OSM id
 * (BCS1, data/imports/buildings/store/12/x/y.bcs). Bake-time only.
 *
 * Layout, zlib-compressed (see encode_bcs):
 *   'BCS1' | u8 version | u8 0 | u16 0 | u32 .bvr crc32 | u32 count |
 *   per building: i64 id | u8 r g b | u8 confidence (/255) | u8 source | u8 pixels / 8 |
 *     i8 shift east | i8 shift north (SHIFT_STEP_M)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzlibSync } from 'fflate';
import { TileKey } from './index';

const BCS_MAGIC = 0x31534342; // 'BCS1' little-endian
const HEAD_BYTES = 16;
const REC_BYTES = 16;
const SHIFT_STEP_M = 0.25;
/** 2: colours with the haze taken out (measure_buildings.py haze_veil). */
const BCS_VERSION = 2;

export const DEFAULT_COLOUR_STORE = 'data/imports/buildings/store';

export interface MeasuredRoof {
    /** 0xRRGGBB, sRGB, as measured. */
    rgb: number;
    /** 0..1. */
    confidence: number;
    source: number;
    pixels: number;
    /** How far the footprint was moved to sit on its roof in the image, metres east and north. */
    shiftE: number;
    shiftN: number;
}

export function decodeBcs(bytes: Uint8Array): { signature: number; roofs: Map<number, MeasuredRoof> } {
    const data = unzlibSync(bytes);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.byteLength < HEAD_BYTES || view.getUint32(0, true) !== BCS_MAGIC) {
        throw new Error('not a BCS1 file');
    }
    if (view.getUint8(4) !== BCS_VERSION) {
        throw new Error(`BCS1 version ${view.getUint8(4)}, expected ${BCS_VERSION}; re-run measure_buildings.py`);
    }
    const signature = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    const roofs = new Map<number, MeasuredRoof>();
    for (let i = 0; i < count; i++) {
        const o = HEAD_BYTES + i * REC_BYTES;
        roofs.set(Number(view.getBigInt64(o, true)), {
            rgb: (data[o + 8] << 16) | (data[o + 9] << 8) | data[o + 10],
            confidence: data[o + 11] / 255,
            source: data[o + 12],
            pixels: data[o + 13] * 8,
            shiftE: view.getInt8(o + 14) * SHIFT_STEP_M,
            shiftN: view.getInt8(o + 15) * SHIFT_STEP_M,
        });
    }
    return { signature, roofs };
}

/** The measured roofs of one leaf, or undefined when it was never measured. */
export function readMeasuredRoofs(storeDir: string, k: TileKey): Map<number, MeasuredRoof> | undefined {
    const file = path.join(storeDir, String(k.z), String(k.x), `${k.y}.bcs`);
    if (!fs.existsSync(file)) {
        return undefined;
    }
    return decodeBcs(fs.readFileSync(file)).roofs;
}

// --- haze ---------------------------------------------------------------------

const WHITE = [0.95047, 1, 1.08883];

function toLinear(c: number): number {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function toSrgb(v: number): number {
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export function rgbToLab(rgb: number): [number, number, number] {
    const r = toLinear((rgb >> 16) & 255), g = toLinear((rgb >> 8) & 255), b = toLinear(rgb & 255);
    const xyz = [
        (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0],
        0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
        (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WHITE[2],
    ];
    const f = xyz.map(t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116));
    return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

export function labToRgb([L, a, bb]: [number, number, number]): number {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const inv = (f: number) => (f ** 3 > 216 / 24389 ? f ** 3 : (116 * f - 16) / (24389 / 27));
    const x = inv(fx) * WHITE[0], y = inv(fy), z = inv(fz) * WHITE[2];
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const r = clamp(3.2404542 * x - 1.5371385 * y - 0.4985314 * z);
    const g = clamp(-0.9692660 * x + 1.8760108 * y + 0.0415560 * z);
    const b = clamp(0.0556434 * x - 0.2040259 * y + 1.0572252 * z);
    return (toSrgb(r) << 16) | (toSrgb(g) << 8) | toSrgb(b);
}

/**
 * A measured roof colour with its chroma scaled by `chroma` in CIELAB,
 * lightness kept. The haze itself comes out in the measurement (version 2
 * of the store); this is what is left for taste - 1 is as measured.
 */
export function dehazed(rgb: number, chroma = 1.0): number {
    const [L, a, b] = rgbToLab(rgb);
    return labToRgb([L, a * chroma, b * chroma]);
}
