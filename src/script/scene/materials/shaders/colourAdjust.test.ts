import * as THREE from 'three';
import assert from 'node:assert';
import { describe, it } from 'node:test';
import { HDNoonPalette } from '../../../config/palettes/hd-noon';
import { PaletteCategory } from '../../../config/palettes/palette';
import { DisplayShading, FogQuality } from '../../../config/profiles/profile';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials';
import { adjustColourInPlace, clampColourAdjust, defaultColourAdjust } from './colourAdjust';

function luma(c: THREE.Color): number {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function near(a: number, b: number, eps = 1e-9): boolean {
    return Math.abs(a - b) < eps;
}

describe('colour adjust', () => {
    it('fills missing or unusable stored values with the authored look and clamps the rest', () => {
        assert.deepStrictEqual(clampColourAdjust(undefined), defaultColourAdjust());
        const adjust = clampColourAdjust({
            sky: { saturation: 5, brightness: 'x', hue: 400 },
            trees: { saturation: -1 },
        });
        assert.deepStrictEqual(adjust.sky, { hue: 180, saturation: 2, brightness: 1 });
        assert.deepStrictEqual(adjust.trees, { hue: 0, saturation: 0, brightness: 1 });
        assert.deepStrictEqual(adjust.water, { hue: 0, saturation: 1, brightness: 1 });
    });

    it('is the identity at the defaults, grey at 0% saturation, and scales with brightness', () => {
        const c = new THREE.Color(0.2, 0.5, 0.1);
        const same = adjustColourInPlace(c.clone(), { hue: 0, saturation: 1, brightness: 1 });
        assert.ok(same.toArray().every((v, i) => near(v, c.toArray()[i])));
        const grey = adjustColourInPlace(c.clone(), { hue: 0, saturation: 0, brightness: 1 });
        assert.ok(near(grey.r, grey.g) && near(grey.g, grey.b));
        assert.ok(near(luma(grey), luma(c)));
        const dim = adjustColourInPlace(c.clone(), { hue: 0, saturation: 1, brightness: 0.5 });
        assert.ok(near(dim.g, c.g * 0.5));
    });

    it('turns hue about the grey axis: a third of the wheel cycles the channels, grey stays grey', () => {
        const red = adjustColourInPlace(new THREE.Color(1, 0, 0), { hue: 120, saturation: 1, brightness: 1 });
        assert.ok(near(red.r, 0, 1e-6) && near(red.g, 1, 1e-6) && near(red.b, 0, 1e-6));
        const grey = adjustColourInPlace(new THREE.Color(0.4, 0.4, 0.4), { hue: 75, saturation: 1, brightness: 1 });
        assert.ok(near(grey.r, 0.4) && near(grey.g, 0.4) && near(grey.b, 0.4));
    });

    it('re-colours water materials, and only them, when the water tweak changes', () => {
        const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
        const build = (category: PaletteCategory) => materials.build({
            type: SceneMaterialPrimitiveType.MESH, category, depthWrite: true, shaded: false,
        }) as THREE.ShaderMaterial;
        const water = build(PaletteCategory.TERRAIN_WATER);
        const grass = build(PaletteCategory.TERRAIN_GRASS);
        const waterBefore = (water.uniforms.color.value as THREE.Color).clone();
        const grassBefore = (grass.uniforms.color.value as THREE.Color).clone();

        materials.setWaterTweak({ hue: 0, saturation: 1, brightness: 0.5 });
        assert.ok(near((water.uniforms.color.value as THREE.Color).b, waterBefore.b * 0.5, 1e-6));
        assert.deepStrictEqual((grass.uniforms.color.value as THREE.Color).toArray(), grassBefore.toArray());

        // A palette change (time of day) must keep the tweak, not wipe it.
        materials.setPalette(HDNoonPalette);
        assert.ok(near((water.uniforms.color.value as THREE.Color).b, waterBefore.b * 0.5, 1e-6));
    });
});
