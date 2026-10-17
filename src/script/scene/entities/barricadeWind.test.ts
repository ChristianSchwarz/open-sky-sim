import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { BARRICADE_DECK_Y, BARRICADE_HEIGHT_M } from './barricadeSpec';
import { flutterStraps } from './barricadeWind';
import { buildBarricadeShape } from './barricadeWrap';

const rigged = buildBarricadeShape(1, true);

describe('barricade wind', () => {
    it('keeps both sewn ends where they are', () => {
        const blown = flutterStraps(rigged.verticals, rigged.slung, 3.7);
        blown.forEach((v, j) => {
            const src = rigged.verticals[j];
            assert.ok(v[0].distanceTo(src[0]) < 1e-9, `strap ${j} top moved`);
            assert.ok(v[v.length - 1].distanceTo(src[src.length - 1]) < 1e-9, `strap ${j} foot moved`);
        });
    });

    it('bellies the straps downwind, a little, and never through the deck', () => {
        for (const t of [0, 0.7, 2.2, 5.1]) {
            const blown = flutterStraps(rigged.verticals, rigged.slung, t);
            for (const v of blown) {
                assert.ok(v.length >= 10, 'strap cannot bend');
                const mid = v[Math.floor(v.length / 2)];
                const off = mid.z - rigged.verticals[0][0].z;
                assert.ok(off > 0 && off < 0.6, `belly ${off.toFixed(2)} m`);
                for (const p of v) assert.ok(p.y >= BARRICADE_DECK_Y && p.y <= BARRICADE_DECK_Y + BARRICADE_HEIGHT_M + 0.01);
            }
        }
    });

    it('moves with time, and no two straps alike', () => {
        const a = flutterStraps(rigged.verticals, rigged.slung, 1.0);
        const b = flutterStraps(rigged.verticals, rigged.slung, 1.4);
        const mid = (v: THREE.Vector3[]) => v[Math.floor(v.length / 2)];
        assert.ok(mid(a[3]).distanceTo(mid(b[3])) > 0.01, 'frozen');
        assert.ok(Math.abs(mid(a[3]).z - mid(a[4]).z) > 0.005, 'two straps in lockstep');
    });

    it('leaves a strap the wing holds alone', () => {
        const held = rigged.verticals.map((_, j) => j === 5);
        const blown = flutterStraps(rigged.verticals, held, 2.0);
        assert.equal(blown[5], rigged.verticals[5]);
    });
});
