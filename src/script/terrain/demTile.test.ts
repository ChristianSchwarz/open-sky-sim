import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zlibSync } from 'fflate';
import {
    decodePdm, encodePdmUncompressed, sampleBilinear, sampleNearest,
} from './demTile';

describe('demTile', () => {
    it('round-trips uncompressed PDM1', () => {
        const size = 5;
        const heights = new Float32Array(size * size);
        for (let i = 0; i < heights.length; i++) {
            heights[i] = i * 3.5 - 10;
        }
        const raw = encodePdmUncompressed(heights, size, 12.5);
        const tile = decodePdm(raw);
        assert.equal(tile.size, size);
        assert.equal(tile.geometricErrorM, 12.5);
        for (let i = 0; i < heights.length; i++) {
            assert.ok(Math.abs(tile.heights[i] - heights[i]) < 0.1, `i=${i}`);
        }
    });

    it('round-trips zlib-compressed PDM1', () => {
        const size = 9;
        const heights = new Float32Array(size * size).fill(42);
        heights[0] = 100;
        heights[size * size - 1] = -5;
        const raw = encodePdmUncompressed(heights, size, 0);
        const compressed = zlibSync(raw, { level: 6 });
        const tile = decodePdm(compressed);
        assert.equal(tile.size, size);
        assert.ok(Math.abs(tile.heights[0] - 100) < 0.2);
        assert.ok(Math.abs(tile.heights[size * size - 1] - (-5)) < 0.2);
    });

    it('samples bilinear at the centre of a ramp', () => {
        const size = 3;
        const heights = new Float32Array([
            0, 0, 0,
            0, 100, 0,
            0, 0, 0,
        ]);
        const tile = decodePdm(encodePdmUncompressed(heights, size));
        const h = sampleBilinear(tile, 0.5, 0.5);
        assert.ok(Math.abs(h - 100) < 1);
        assert.ok(Math.abs(sampleNearest(tile, 0, 0) - 0) < 1);
    });
});
