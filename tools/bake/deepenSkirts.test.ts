import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeEnuBasis } from '../../src/script/terrain/geodesy';
import { decodePtm } from '../../src/script/terrain/ptm';
import { buildTile } from './buildTile';
import { deepenSkirts } from './deepenSkirts';
import { deepenedSkirtM, SKIRT_DEEPEN_CAP_M, SKIRT_SEAM_FACTOR } from './meshTile';

const SIZE = 33;

function tile(skirtDepthM: number) {
    const heights = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            heights[y * SIZE + x] = 50 + Math.sin(x / 5) * 20 + Math.cos(y / 4) * 15;
        }
    }
    return buildTile({
        id: { z: 12, x: 3745, y: 1410 },
        bounds: { west: -15.40, east: -15.39, south: 28.00, north: 28.01 },
        heights, size: SIZE, seaLevel: 0, maxErrorM: 2, skirtDepthM, geometricErrorM: 0,
        basis: makeEnuBasis(28.0015, -15.3937, 0),
        // Land across the whole tile, so it has ground and four skirted borders.
        polygons: [{
            exterior: [
                { lon: -15.41, lat: 28.02 }, { lon: -15.38, lat: 28.02 },
                { lon: -15.38, lat: 27.99 }, { lon: -15.41, lat: 27.99 },
            ],
            holes: [],
        }],
    }).bytes;
}

describe('deepenSkirts', () => {
    it('hangs the skirt deeper, once, and leaves the ground where it was', () => {
        const raw = new Uint8Array(tile(25));
        const before = decodePtm(raw);
        const groundBefore = Array.from(before.landPositions).map(v => v * before.quantScale);

        const r = deepenSkirts(raw, deepenedSkirtM, SKIRT_SEAM_FACTOR);
        assert.ok(r.changed);
        assert.ok(r.bottoms > 0);
        const after = decodePtm(raw);
        assert.ok(Math.abs(after.skirtDepthM - 25 * SKIRT_SEAM_FACTOR) < 1e-3);

        // A vertex either held still, to a step, or is a skirt bottom that
        // moved the extra four skirts' depth; nothing in between.
        const step = 2 * after.quantScale;
        let moved = 0;
        for (let v = 0; v < groundBefore.length; v += 3) {
            const d = Math.hypot(
                after.landPositions[v] * after.quantScale - groundBefore[v],
                after.landPositions[v + 1] * after.quantScale - groundBefore[v + 1],
                after.landPositions[v + 2] * after.quantScale - groundBefore[v + 2],
            );
            if (d > step) {
                moved++;
                assert.ok(Math.abs(d - 25 * (SKIRT_SEAM_FACTOR - 1)) < 3, `a vertex moved ${d} m`);
            }
        }
        assert.ok(moved > 0);
        assert.ok(moved < groundBefore.length / 3 / 2, 'the ground itself moved');

        assert.equal(deepenSkirts(raw, deepenedSkirtM, SKIRT_SEAM_FACTOR).changed, false);
    });

    it('leaves a tile baked with the factor alone', () => {
        const raw = new Uint8Array(tile(25));
        new DataView(raw.buffer).setUint32(52, SKIRT_SEAM_FACTOR, true);
        assert.equal(deepenSkirts(raw, deepenedSkirtM, SKIRT_SEAM_FACTOR).changed, false);
    });
});

describe('deepenedSkirtM', () => {
    it('is the factor times the base, up to the cap, and never less than the base', () => {
        assert.equal(deepenedSkirtM(49), 49 * SKIRT_SEAM_FACTOR);
        assert.equal(deepenedSkirtM(1000), SKIRT_DEEPEN_CAP_M);
        assert.equal(deepenedSkirtM(4000), 4000);
    });
});
