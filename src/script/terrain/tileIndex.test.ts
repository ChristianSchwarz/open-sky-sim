import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TileIndex } from './tileIndex';
import { TileKey, tileKeyString } from './tiling';

const INDEX_MAGIC = 0x31584950; // 'PIX1'

/** The bytes tools/bake_planet_dem.py's pack_index writes, for a set of tiles. */
function encodeIndex(tiles: TileKey[], minZoom: number, maxZoom: number): Uint8Array {
    interface Level { minX: number; minY: number; w: number; h: number; bits: Uint8Array }
    const levels: Level[] = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        const keys = tiles.filter(t => t.z === z);
        if (keys.length === 0) {
            levels.push({ minX: 0, minY: 0, w: 0, h: 0, bits: new Uint8Array(0) });
            continue;
        }
        const minX = Math.min(...keys.map(k => k.x));
        const minY = Math.min(...keys.map(k => k.y));
        const w = Math.max(...keys.map(k => k.x)) - minX + 1;
        const h = Math.max(...keys.map(k => k.y)) - minY + 1;
        const bits = new Uint8Array(Math.ceil((w * h) / 8));
        for (const k of keys) {
            const i = (k.y - minY) * w + (k.x - minX);
            bits[i >> 3] |= 1 << (i & 7);
        }
        levels.push({ minX, minY, w, h, bits });
    }
    const total = 8 + levels.length * 16 + levels.reduce((n, l) => n + l.bits.byteLength, 0);
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

const keys = (ids: TileKey[]) => ids.map(tileKeyString).sort();

describe('TileIndex', () => {
    it('round-trips the tiles it was built from', () => {
        const tiles: TileKey[] = [
            { z: 5, x: 10, y: 20 },
            { z: 5, x: 12, y: 22 },
            { z: 6, x: 40, y: 80 },
        ];
        const idx = TileIndex.decode(encodeIndex(tiles, 5, 6));
        assert.deepEqual(keys(idx.tilesAt(5)), keys(tiles.filter(t => t.z === 5)));
        assert.deepEqual(keys(idx.tilesAt(6)), keys(tiles.filter(t => t.z === 6)));
    });

    it('agrees with has() on every tile it lists', () => {
        const tiles: TileKey[] = [
            { z: 4, x: 3, y: 1 }, { z: 4, x: 5, y: 1 }, { z: 4, x: 4, y: 3 },
        ];
        const idx = TileIndex.decode(encodeIndex(tiles, 4, 4));
        for (const id of idx.tilesAt(4)) {
            assert.equal(idx.has(id), true, `has() denies listed tile ${tileKeyString(id)}`);
        }
    });

    it('lists nothing on a level the index does not describe', () => {
        const idx = TileIndex.decode(encodeIndex([{ z: 3, x: 1, y: 1 }], 3, 3));
        assert.deepEqual(idx.tilesAt(2), []);
        assert.deepEqual(idx.tilesAt(9), []);
    });

    it('lists nothing for an empty level inside the range', () => {
        const idx = TileIndex.decode(encodeIndex(
            [{ z: 2, x: 1, y: 1 }, { z: 4, x: 8, y: 4 }], 2, 4,
        ));
        assert.deepEqual(idx.tilesAt(3), []);
        assert.equal(idx.tilesAt(2).length, 1);
        assert.equal(idx.tilesAt(4).length, 1);
    });

    it('reports the levels it describes', () => {
        const idx = TileIndex.decode(encodeIndex(
            [{ z: 2, x: 1, y: 1 }, { z: 4, x: 8, y: 4 }], 2, 4,
        ));
        assert.deepEqual(idx.levels, [2, 3, 4]);
    });

    it('lists only the baked tiles when two areas sit far apart', () => {
        // The case the enumeration exists for. A bounding box over these spans
        // 154 columns of the level; the index holds four tiles.
        const canaries: TileKey[] = [{ z: 7, x: 120, y: 42 }, { z: 7, x: 121, y: 42 }];
        const alps: TileKey[] = [{ z: 7, x: 133, y: 31 }, { z: 7, x: 134, y: 31 }];
        const idx = TileIndex.decode(encodeIndex([...canaries, ...alps], 7, 7));
        const listed = idx.tilesAt(7);
        assert.equal(listed.length, 4);
        assert.deepEqual(keys(listed), keys([...canaries, ...alps]));
        // Everything between the two clusters is inside the bounding rectangle
        // and must not be listed.
        assert.equal(idx.has({ z: 7, x: 127, y: 36 }), false);
    });

    it('rejects bytes that are not an index', () => {
        assert.throws(() => TileIndex.decode(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0])));
    });
});
