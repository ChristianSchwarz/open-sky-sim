/** Packed "tile exists" bitmask produced by tools/bake_planet_dem.py. */

import { TileKey } from './tiling';

const INDEX_MAGIC = 0x31584950; // 'PIX1' little-endian

interface LevelIndex {
    minX: number;
    minY: number;
    w: number;
    h: number;
    bits: Uint8Array;
}

export class TileIndex {
    private readonly levels_ = new Map<number, LevelIndex>();
    readonly minZoom: number;
    readonly maxZoom: number;

    private constructor(minZoom: number, maxZoom: number) {
        this.minZoom = minZoom;
        this.maxZoom = maxZoom;
    }

    static decode(bytes: ArrayBuffer | Uint8Array): TileIndex {
        const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (raw.byteLength < 8 || view.getUint32(0, true) !== INDEX_MAGIC) {
            throw new Error('Bad planet index.bin magic');
        }
        const minZoom = view.getUint16(4, true);
        const maxZoom = view.getUint16(6, true);
        const idx = new TileIndex(minZoom, maxZoom);
        const levelCount = maxZoom - minZoom + 1;
        let o = 8;
        const headers: { z: number; minX: number; minY: number; w: number; h: number }[] = [];
        for (let i = 0; i < levelCount; i++) {
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
            const bits = raw.subarray(o, o + byteCount);
            o += byteCount;
            idx.levels_.set(h.z, {
                minX: h.minX,
                minY: h.minY,
                w: h.w,
                h: h.h,
                bits: bits.slice(),
            });
        }
        return idx;
    }

    /** Levels the index describes, ascending. */
    get levels(): number[] {
        return [...this.levels_.keys()].sort((a, b) => a - b);
    }

    /**
     * Every tile the index holds at `z`.
     *
     * `has` answers "is this one there", which is all the streamer needs
     * because it starts from a camera and descends. Loading a tier in full
     * needs the other direction: the tiles themselves, rather than a box to
     * guess them from. A box works only while the baked area is one blob —
     * once a second area is added the box spans the gap between them, and
     * walking it asks for hundreds of tiles that were never baked.
     */
    tilesAt(z: number): TileKey[] {
        const level = this.levels_.get(z);
        if (!level) {
            return [];
        }
        const out: TileKey[] = [];
        for (let i = 0; i < level.w * level.h; i++) {
            if (level.bits[i >> 3] & (1 << (i & 7))) {
                out.push({
                    z,
                    x: level.minX + (i % level.w),
                    y: level.minY + Math.floor(i / level.w),
                });
            }
        }
        return out;
    }

    /** True when a baked land tile exists for `key`. Missing → sea ellipsoid. */
    has(key: TileKey): boolean {
        const level = this.levels_.get(key.z);
        if (!level) {
            return false;
        }
        const lx = key.x - level.minX;
        const ly = key.y - level.minY;
        if (lx < 0 || ly < 0 || lx >= level.w || ly >= level.h) {
            return false;
        }
        const i = ly * level.w + lx;
        return (level.bits[i >> 3] & (1 << (i & 7))) !== 0;
    }
}
