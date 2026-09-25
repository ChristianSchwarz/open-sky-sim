import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zlibSync } from 'fflate';
import { CLASS_COUNT, TerrainClass } from '../../src/script/terrain/tones';
import {
    PLC_FLAG_REAL_IMAGERY, PLC_HEADER_BYTES, CoverTile, decodePlc, encodePlc,
} from './plc';

const SIZE = 5;

function sample(flags = PLC_FLAG_REAL_IMAGERY): CoverTile {
    const nodes = SIZE * SIZE;
    const classes = new Uint8Array(nodes);
    const colors = new Uint8Array(nodes * 3);
    for (let i = 0; i < nodes; i++) {
        classes[i] = i % CLASS_COUNT;
        colors[i * 3] = i * 7 & 0xff;
        colors[i * 3 + 1] = i * 11 & 0xff;
        colors[i * 3 + 2] = i * 13 & 0xff;
    }
    return { size: SIZE, flags, classes, colors };
}

describe('PLC1 codec', () => {
    it('round-trips classes and colours byte for byte', () => {
        const src = sample();
        const tile = decodePlc(encodePlc(src));
        assert.equal(tile.size, SIZE);
        assert.equal(tile.flags, PLC_FLAG_REAL_IMAGERY);
        assert.deepEqual(Array.from(tile.classes), Array.from(src.classes));
        assert.deepEqual(Array.from(tile.colors), Array.from(src.colors));
    });

    it('accepts the zlib-compressed form the Python baker writes', () => {
        const src = sample(0);
        const tile = decodePlc(zlibSync(encodePlc(src)));
        assert.equal(tile.flags, 0);
        assert.deepEqual(Array.from(tile.classes), Array.from(src.classes));
    });

    it('rejects a class the mesh format could not carry', () => {
        // The class travels as a nibble in PTM1. Catching it here, against the
        // file that produced it, beats catching it a stage later against a
        // mesh that has already been built.
        const bad = sample();
        bad.classes[3] = CLASS_COUNT;
        assert.throws(() => decodePlc(encodePlc(bad)), /class 16/);
    });

    it('throws on bad magic, a future version and a short payload', () => {
        const bytes = encodePlc(sample());

        // Through the compressed path: corrupting the magic on a raw payload
        // only defeats the "already inflated?" sniff, which then fails as bad
        // zlib instead. Compressed, the check is reached.
        const badMagic = encodePlc(sample());
        badMagic[0] ^= 0xff;
        assert.throws(() => decodePlc(zlibSync(badMagic)), /magic/);

        const badVersion = bytes.slice();
        badVersion[4] = 99;
        assert.throws(() => decodePlc(badVersion), /version 99/);

        assert.throws(() => decodePlc(bytes.slice(0, PLC_HEADER_BYTES - 1)), /too short/);
        assert.throws(() => decodePlc(bytes.slice(0, bytes.byteLength - 4)), /truncated/);
    });

    it('rejects payloads whose length disagrees with the declared size', () => {
        const src = sample();
        assert.throws(
            () => encodePlc({ ...src, classes: new Uint8Array(3) }),
            /classes 3/,
        );
        assert.throws(
            () => encodePlc({ ...src, colors: new Uint8Array(3) }),
            /colors 3/,
        );
    });

    it('hands back arrays that outlive the inflate buffer', () => {
        // Unlike PTM1 this is bake-time code, so it copies rather than views:
        // the caller keeps the arrays and nothing guarantees the source blob
        // stays around.
        const bytes = zlibSync(encodePlc(sample()));
        const tile = decodePlc(bytes);
        assert.notEqual(tile.classes.buffer, bytes.buffer);
        assert.equal(tile.classes[0], TerrainClass.Unknown);
    });
});
