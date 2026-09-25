/**
 * PIX1 "tile exists" bitmask writer.
 *
 * Same bytes the existing tools/bake_planet_dem.py emits and
 * src/script/planet/tileIndex.ts reads, so the runtime gate is unchanged. The
 * mesh bake writes its own copy as a record of exactly which .ptm files it
 * produced: "not in the index" then unambiguously means "ocean, generate a
 * patch", and a partial bake is detectable instead of showing up as holes.
 */

export const INDEX_MAGIC = 0x31584950; // 'PIX1' little-endian

export interface TileKey {
    z: number;
    x: number;
    y: number;
}

/**
 * Read a PIX1 index back into its keys.
 *
 * `TileIndex` in src/script/terrain answers "is this tile present"; a bake
 * adding an area to an existing tree needs the other question, "which tiles
 * were present", so it can union its own output with them instead of writing
 * an index that silently unlists everything it did not touch this run.
 */
export function decodeTileIndex(bytes: Uint8Array): TileKey[] {
    if (bytes.byteLength < 8) {
        throw new Error('index too short to hold a PIX1 header');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== INDEX_MAGIC) {
        throw new Error('bad tile index magic');
    }
    const minZoom = view.getUint16(4, true);
    const maxZoom = view.getUint16(6, true);
    const out: TileKey[] = [];
    if (maxZoom < minZoom) {
        return out;
    }
    const count = maxZoom - minZoom + 1;
    const headers: Array<{ z: number; minX: number; minY: number; w: number; h: number }> = [];
    let o = 8;
    for (let i = 0; i < count; i++) {
        headers.push({
            z: minZoom + i,
            minX: view.getUint32(o, true),
            minY: view.getUint32(o + 4, true),
            w: view.getUint32(o + 8, true),
            h: view.getUint32(o + 12, true),
        });
        o += 16;
    }
    for (const h of headers) {
        const byteCount = Math.ceil((h.w * h.h) / 8);
        const bits = bytes.subarray(o, o + byteCount);
        o += byteCount;
        for (let i = 0; i < h.w * h.h; i++) {
            if (bits[i >> 3] & (1 << (i & 7))) {
                out.push({ z: h.z, x: h.minX + (i % h.w), y: h.minY + Math.floor(i / h.w) });
            }
        }
    }
    return out;
}

export function encodeTileIndex(
    present: Iterable<TileKey>,
    minZoom: number,
    maxZoom: number,
): Uint8Array {
    const byLevel = new Map<number, TileKey[]>();
    for (let z = minZoom; z <= maxZoom; z++) {
        byLevel.set(z, []);
    }
    for (const k of present) {
        const list = byLevel.get(k.z);
        if (list) {
            list.push(k);
        }
    }

    interface Level {
        minX: number;
        minY: number;
        w: number;
        h: number;
        bits: Uint8Array;
    }
    const levels: Level[] = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        const keys = byLevel.get(z)!;
        if (keys.length === 0) {
            levels.push({ minX: 0, minY: 0, w: 0, h: 0, bits: new Uint8Array(0) });
            continue;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const k of keys) {
            if (k.x < minX) minX = k.x;
            if (k.y < minY) minY = k.y;
            if (k.x > maxX) maxX = k.x;
            if (k.y > maxY) maxY = k.y;
        }
        const w = maxX - minX + 1;
        const h = maxY - minY + 1;
        const bits = new Uint8Array(Math.ceil((w * h) / 8));
        for (const k of keys) {
            const i = (k.y - minY) * w + (k.x - minX);
            bits[i >> 3] |= 1 << (i & 7);
        }
        levels.push({ minX, minY, w, h, bits });
    }

    let total = 8 + levels.length * 16;
    for (const l of levels) {
        total += l.bits.byteLength;
    }
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, INDEX_MAGIC, true);
    view.setUint16(4, minZoom, true);
    view.setUint16(6, maxZoom, true);
    let o = 8;
    for (const l of levels) {
        view.setUint32(o, l.minX, true);
        view.setUint32(o + 4, l.minY, true);
        view.setUint32(o + 8, l.w, true);
        view.setUint32(o + 12, l.h, true);
        o += 16;
    }
    for (const l of levels) {
        out.set(l.bits, o);
        o += l.bits.byteLength;
    }
    return out;
}
