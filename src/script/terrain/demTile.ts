/** PDM1 height-tile decode + sampling. */

import { unzlibSync } from 'fflate';

const PDM_MAGIC = 0x314D4450; // 'PDM1' little-endian
const PDM_NODATA = 0xFFFF;
const PDM_HEADER_BYTES = 24;

export interface DemTile {
    size: number;
    flags: number;
    minH: number;
    maxH: number;
    quantScale: number;
    geometricErrorM: number;
    /** Row-major heights (metres); NaN marks nodata. */
    heights: Float32Array;
}

/**
 * Decode a zlib-compressed PDM1 blob into a DemTile.
 * Accepts either the raw compressed bytes or an already-inflated payload.
 */
export function decodePdm(bytes: ArrayBuffer | Uint8Array): DemTile {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let payload: Uint8Array;
    if (raw.byteLength >= 4
        && raw[0] === 0x50 && raw[1] === 0x44 && raw[2] === 0x4d && raw[3] === 0x31) {
        payload = raw;
    } else {
        payload = unzlibSync(raw);
    }
    if (payload.byteLength < PDM_HEADER_BYTES) {
        throw new Error(`PDM1 too short: ${payload.byteLength}`);
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== PDM_MAGIC) {
        throw new Error(`Bad PDM1 magic: 0x${magic.toString(16)}`);
    }
    const size = view.getUint16(4, true);
    const flags = view.getUint8(6);
    const minH = view.getFloat32(8, true);
    const maxH = view.getFloat32(12, true);
    const quantScale = view.getFloat32(16, true);
    const geometricErrorM = view.getFloat32(20, true);
    const expected = PDM_HEADER_BYTES + size * size * 2;
    if (payload.byteLength < expected) {
        throw new Error(`PDM1 truncated: ${payload.byteLength} < ${expected}`);
    }
    const heights = new Float32Array(size * size);
    let o = PDM_HEADER_BYTES;
    for (let i = 0; i < heights.length; i++, o += 2) {
        const q = view.getUint16(o, true);
        heights[i] = q === PDM_NODATA ? Number.NaN : minH + q * quantScale;
    }
    return { size, flags, minH, maxH, quantScale, geometricErrorM, heights };
}

/** Encode an uncompressed PDM1 payload (used by tests). */
export function encodePdmUncompressed(
    heights: Float32Array,
    size: number,
    geometricErrorM: number = 0,
): Uint8Array {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (!Number.isFinite(h)) {
            continue;
        }
        if (h < lo) {
            lo = h;
        }
        if (h > hi) {
            hi = h;
        }
    }
    if (!Number.isFinite(lo)) {
        lo = 0;
        hi = 0;
    }
    const scale = hi > lo ? (hi - lo) / 0xFFFE : 1;
    const out = new Uint8Array(PDM_HEADER_BYTES + size * size * 2);
    const view = new DataView(out.buffer);
    view.setUint32(0, PDM_MAGIC, true);
    view.setUint16(4, size, true);
    view.setUint8(6, 0);
    view.setUint8(7, 0);
    view.setFloat32(8, lo, true);
    view.setFloat32(12, hi, true);
    view.setFloat32(16, scale, true);
    view.setFloat32(20, geometricErrorM, true);
    let o = PDM_HEADER_BYTES;
    for (let i = 0; i < heights.length; i++, o += 2) {
        const h = heights[i];
        if (!Number.isFinite(h)) {
            view.setUint16(o, PDM_NODATA, true);
        } else if (hi <= lo) {
            view.setUint16(o, 0, true);
        } else {
            const q = Math.max(0, Math.min(0xFFFE, Math.round((h - lo) / scale)));
            view.setUint16(o, q, true);
        }
    }
    return out;
}

/** Nearest-neighbour sample; returns NaN for out-of-range / nodata. */
export function sampleNearest(tile: DemTile, u: number, v: number): number {
    const n = tile.size;
    const ix = Math.round(u * (n - 1));
    const iy = Math.round(v * (n - 1));
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) {
        return Number.NaN;
    }
    return tile.heights[iy * n + ix];
}

/**
 * Bilinear sample in normalised tile UV ([0,1]×[0,1], v=0 at north edge).
 * Nodata neighbours are skipped; returns NaN when no finite samples contribute.
 */
export function sampleBilinear(tile: DemTile, u: number, v: number): number {
    const n = tile.size;
    const fx = u * (n - 1);
    const fy = v * (n - 1);
    if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) {
        return Number.NaN;
    }
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(n - 1, x0 + 1);
    const y1 = Math.min(n - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const h00 = tile.heights[y0 * n + x0];
    const h10 = tile.heights[y0 * n + x1];
    const h01 = tile.heights[y1 * n + x0];
    const h11 = tile.heights[y1 * n + x1];
    let sum = 0;
    let w = 0;
    const add = (h: number, weight: number) => {
        if (Number.isFinite(h) && weight > 0) {
            sum += h * weight;
            w += weight;
        }
    };
    add(h00, (1 - tx) * (1 - ty));
    add(h10, tx * (1 - ty));
    add(h01, (1 - tx) * ty);
    add(h11, tx * ty);
    return w > 0 ? sum / w : Number.NaN;
}

