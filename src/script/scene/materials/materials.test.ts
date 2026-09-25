import * as THREE from 'three';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { daytimePalette } from '../../config/palettes/daytimePalette';
import { HDMidnightPalette } from '../../config/palettes/hd-midnight';
import { HDNoonPalette } from '../../config/palettes/hd-noon';
import { PaletteCategory, PaletteColor } from '../../config/palettes/palette';
import { DisplayShading, FogQuality } from '../../config/profiles/profile';
import { DEFAULT_SUN_HOURS, setSunTime } from './shaders/sun';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from './materials';

afterEach(() => setSunTime(DEFAULT_SUN_HOURS));

/** Rec. 709 luminance of a linear-light colour, which is what a uniform holds. */
function luma(c: THREE.Color): number {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function colorOf(material: THREE.Material): THREE.Color {
    return (material as THREE.ShaderMaterial).uniforms.color.value as THREE.Color;
}

describe('SceneMaterialManager and the time of day', () => {

    /**
     * A mod's own camo blue and the stock airframe grey, side by side.
     *
     * The camo arrives as a raw `#rrggbb` glTF material name, so it bypasses
     * the palette entirely; the grey is a palette category. They have to
     * darken together, which they did not before Palette.light existed.
     */
    function twoPlanes() {
        const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
        const raw = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.VEHICLE_PLANE_GREY,
            rawColor: '#7ab8d8',
            shaded: true,
            depthWrite: true,
        });
        const stock = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.VEHICLE_PLANE_GREY,
            shaded: true,
            depthWrite: true,
        });
        return { materials, raw, stock };
    }

    function at(hours: number) {
        const { materials, raw, stock } = twoPlanes();
        setSunTime(hours);
        materials.setPalette(daytimePalette(HDNoonPalette, HDMidnightPalette));
        return { raw: luma(colorOf(raw)), stock: luma(colorOf(stock)) };
    }

    it('darkens a raw-colour plane into the night along with a palette one', () => {
        // The bug this covers: setPalette skipped raw colours outright, so a
        // mod aircraft kept its noon camo over black midnight terrain and read
        // as lit from nowhere.
        const noon = at(12);
        const night = at(22);

        assert.ok(night.raw < noon.raw / 10,
            `raw went ${noon.raw.toFixed(4)} -> ${night.raw.toFixed(4)}, barely dimmer`);
        // ...and by roughly the same factor the palette applied to its own.
        const rawDrop = night.raw / noon.raw;
        const stockDrop = night.stock / noon.stock;
        assert.ok(rawDrop / stockDrop > 0.6 && rawDrop / stockDrop < 1.7,
            `raw fell ${rawDrop.toFixed(4)}x against the palette's ${stockDrop.toFixed(4)}x`);
    });

    it('leaves a raw colour exactly as authored at noon', () => {
        // Nothing about this may cost the authored look at midday: the gain is
        // neutral there and the colour has to survive the round trip untouched.
        const { materials, raw } = twoPlanes();
        setSunTime(12);
        materials.setPalette(daytimePalette(HDNoonPalette, HDMidnightPalette));

        const expected = new THREE.Color('#7ab8d8');
        const actual = colorOf(raw);
        for (const channel of ['r', 'g', 'b'] as const) {
            assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-6,
                `${channel}: ${actual[channel]} vs ${expected[channel]}`);
        }
    });

    it('keeps darkening a raw colour monotonically from noon into the night', () => {
        const curve = [12, 16, 18, 19, 22].map(h => at(h).raw);
        for (let i = 1; i < curve.length; i++) {
            // A plateau is fine once the palette has reached night; a rise is
            // not, and would read as the aircraft lighting up after sunset.
            assert.ok(curve[i] <= curve[i - 1] * 1.35,
                `${curve[i]} brightened against ${curve[i - 1]}: ${curve}`);
        }
        assert.ok(curve[curve.length - 1] < curve[0], 'it never darkened at all');
    });

    it('still repaints palette-driven materials from the palette', () => {
        // The raw branch is an else-if, so it must not have stolen the path
        // every other material in the scene depends on.
        const { materials, stock } = twoPlanes();
        setSunTime(22);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        materials.setPalette(palette);

        const expected = new THREE.Color(
            PaletteColor(palette, PaletteCategory.VEHICLE_PLANE_GREY) as string);
        assert.ok(Math.abs(luma(colorOf(stock)) - luma(expected)) < 1e-6,
            'the palette colour did not reach the uniform');
    });
});
