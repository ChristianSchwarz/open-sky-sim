import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    CLASS_COUNT, CLASS_TO_TONE, LAND_TONE_BASE, LAND_TONE_COUNT, TONE_COUNT,
    TerrainClass, TerrainTone, WORLDCOVER_TO_CLASS, isWaterTone,
} from './tones';

describe('terrain tones and classes', () => {
    it('maps every class the attribute nibble can hold', () => {
        // The class arrives as a raw nibble out of a baked file, so the shader
        // and this table have to answer for all sixteen values, not just the
        // ones the current bake happens to emit.
        assert.equal(CLASS_TO_TONE.length, CLASS_COUNT);
        for (let c = 0; c < CLASS_COUNT; c++) {
            const tone = CLASS_TO_TONE[c];
            assert.ok(
                tone >= LAND_TONE_BASE && tone < TONE_COUNT,
                `class ${c} maps to ${tone}, outside the land tones`,
            );
        }
    });

    it('never sends a land facet to a water tone', () => {
        // Water geometry is a separate stream with its own material. A land
        // facet resolving to a water tone would paint sea onto a hillside.
        for (let c = 0; c < CLASS_COUNT; c++) {
            assert.ok(!isWaterTone(CLASS_TO_TONE[c]), `class ${c}`);
        }
    });

    it('keeps water tones first, because they are draw-group indices', () => {
        assert.equal(TerrainTone.Water, 0);
        assert.equal(TerrainTone.ShallowWater, 1);
        assert.equal(LAND_TONE_BASE, TerrainTone.Sand);
        assert.equal(LAND_TONE_COUNT, TONE_COUNT - LAND_TONE_BASE);
    });

    it('gives the disputed classes the tone the bake relies on', () => {
        // Two rules the bake and the shader have to agree on: the coast vector
        // beats the raster about water, and beach is its own class.
        assert.equal(CLASS_TO_TONE[TerrainClass.Water], TerrainTone.Grass);
        assert.equal(CLASS_TO_TONE[TerrainClass.Sand], TerrainTone.Sand);
        assert.equal(CLASS_TO_TONE[TerrainClass.Unknown], TerrainTone.Grass);
    });

    it('compacts every WorldCover code into the nibble range', () => {
        const codes = Object.keys(WORLDCOVER_TO_CLASS).map(Number);
        assert.ok(codes.length >= 11, 'all eleven WorldCover classes');
        const seen = new Set<number>();
        for (const code of codes) {
            const cls = WORLDCOVER_TO_CLASS[code];
            assert.ok(cls > 0 && cls < CLASS_COUNT, `code ${code} -> ${cls}`);
            assert.ok(!seen.has(cls), `code ${code} collides on class ${cls}`);
            seen.add(cls);
        }
        // Sand is assigned by the bake from shore distance, not by the raster,
        // so no WorldCover code may claim it.
        assert.ok(!seen.has(TerrainClass.Sand));
    });
});
