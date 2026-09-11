import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TERRAIN_COLOUR_MODE_INDEX, TerrainColours } from '../state/gameDefs';
import { CLASS_TO_TONE, TerrainClass, TerrainTone } from '../terrain/tones';
import {
    DEFAULT_FACET_SHADE, FacetPalette, Rgb, facetColour, toneColour,
} from './facetColour';

/**
 * The CPU port against the shader's own arithmetic. These cases exist because
 * the two copies can drift: each one restates what
 * `facetColor()` in terrainVP.ts does, so a change there that is not made here
 * fails rather than silently painting the chart the old way.
 */

const GRASS: Rgb = { r: 0.30, g: 0.45, b: 0.20 };
const FOREST: Rgb = { r: 0.12, g: 0.30, b: 0.14 };
const SAND: Rgb = { r: 0.76, g: 0.70, b: 0.50 };

function palette(over: Partial<FacetPalette> = {}): FacetPalette {
    const tones: Rgb[] = [];
    tones[TerrainTone.Water] = { r: 0.1, g: 0.2, b: 0.4 };
    tones[TerrainTone.ShallowWater] = { r: 0.2, g: 0.4, b: 0.5 };
    tones[TerrainTone.Sand] = SAND;
    tones[TerrainTone.Grass] = GRASS;
    tones[TerrainTone.Bare] = { r: 0.5, g: 0.45, b: 0.4 };
    tones[TerrainTone.Forest] = FOREST;
    tones[TerrainTone.Scrub] = { r: 0.4, g: 0.44, b: 0.26 };
    tones[TerrainTone.Crop] = { r: 0.55, g: 0.55, b: 0.25 };
    tones[TerrainTone.Urban] = { r: 0.45, g: 0.44, b: 0.43 };
    tones[TerrainTone.Snow] = { r: 0.92, g: 0.94, b: 0.96 };
    tones[TerrainTone.Wetland] = { r: 0.3, g: 0.4, b: 0.35 };
    return {
        mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.LANDCOVER],
        toneColours: tones,
        swatches: [],
        ...DEFAULT_FACET_SHADE,
        ...over,
    };
}

function near(a: Rgb, b: Rgb, eps = 1e-9): boolean {
    return Math.abs(a.r - b.r) < eps && Math.abs(a.g - b.g) < eps && Math.abs(a.b - b.b) < eps;
}

describe('facetColour — IMAGERY', () => {
    it('returns the satellite colour untouched', () => {
        const cover = { r: 0.4, g: 0.55, b: 0.3 };
        const c = facetColour(cover, TerrainClass.Tree, palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.IMAGERY] }));
        assert.ok(near(c, cover), JSON.stringify(c));
    });

    it('ignores the landcover class entirely', () => {
        const cover = { r: 0.4, g: 0.55, b: 0.3 };
        const p = palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.IMAGERY] });
        assert.deepEqual(
            facetColour(cover, TerrainClass.Tree, p),
            facetColour(cover, TerrainClass.Built, p));
    });
});

describe('facetColour — SWATCH', () => {
    it('snaps to the nearest table colour', () => {
        const swatches = [
            { r: 0, g: 0, b: 0 },
            { r: 0.5, g: 0.5, b: 0.5 },
            { r: 1, g: 1, b: 1 },
        ];
        const p = palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.SWATCH], swatches });
        assert.ok(near(facetColour({ r: 0.9, g: 0.9, b: 0.9 }, 0, p), swatches[2]));
        assert.ok(near(facetColour({ r: 0.45, g: 0.5, b: 0.55 }, 0, p), swatches[1]));
        assert.ok(near(facetColour({ r: 0.05, g: 0.02, b: 0.01 }, 0, p), swatches[0]));
    });

    it('returns the raw colour when no table was baked, not black', () => {
        const cover = { r: 0.4, g: 0.55, b: 0.3 };
        const c = facetColour(cover, 0, palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.SWATCH], swatches: [] }));
        assert.ok(near(c, cover), JSON.stringify(c));
    });
});

describe('facetColour — LANDCOVER', () => {
    it('paints a class with its palette tone, ignoring the imagery', () => {
        const p = palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.LANDCOVER] });
        assert.ok(near(facetColour({ r: 0.9, g: 0.1, b: 0.9 }, TerrainClass.Tree, p), FOREST));
        assert.ok(near(facetColour({ r: 0.1, g: 0.9, b: 0.1 }, TerrainClass.Grass, p), GRASS));
    });

    it('routes every class through the same map the shader uploads', () => {
        const p = palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.LANDCOVER] });
        for (let cls = 0; cls < CLASS_TO_TONE.length; cls++) {
            if (cls === 13) {
                // TerrainClass.Ground paints its own baked colour, not a tone;
                // covered by the test below.
                continue;
            }
            assert.ok(
                near(facetColour({ r: 0.5, g: 0.5, b: 0.5 }, cls, p),
                    toneColour(CLASS_TO_TONE[cls], p.toneColours)),
                `class ${cls} did not resolve through CLASS_TO_TONE`);
        }
    });

    it('paints unmapped ground with its own blended colour in every mode, like the shader', () => {
        const cover = { r: 0.35, g: 0.3, b: 0.2 };
        for (const mode of [TerrainColours.LANDCOVER, TerrainColours.HYBRID, TerrainColours.IMAGERY]) {
            const c = facetColour(cover, 13, palette({ mode: TERRAIN_COLOUR_MODE_INDEX[mode] }));
            assert.ok(near(c, cover), `${mode}: ${JSON.stringify(c)}`);
        }
    });

    it('falls back to grass for a class with no tone', () => {
        const p = palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.LANDCOVER] });
        assert.ok(near(facetColour({ r: 0.5, g: 0.5, b: 0.5 }, 250, p), GRASS));
    });
});

describe('facetColour — HYBRID', () => {
    const p = palette({ mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.HYBRID] });

    /** The shader's arithmetic, restated independently. */
    function expected(cover: Rgb, cls: number): Rgb {
        const tone = toneColour(CLASS_TO_TONE[cls], p.toneColours);
        const lum = 0.2126 * cover.r + 0.7152 * cover.g + 0.0722 * cover.b;
        const d = Math.max(-1, Math.min(1, (lum - p.shadeMid) / Math.max(p.shadeSpread, 0.001)));
        const band = Math.floor(d * p.shadeSteps + 0.5) / Math.max(p.shadeSteps, 1);
        const s = 1 + band * p.shadeRange;
        return { r: tone.r * s, g: tone.g * s, b: tone.b * s };
    }

    it('keeps the tone hue and takes only its shade from the imagery', () => {
        for (const cover of [
            { r: 0.1, g: 0.1, b: 0.1 },
            { r: 0.5, g: 0.5, b: 0.5 },
            { r: 0.9, g: 0.9, b: 0.9 },
        ]) {
            const c = facetColour(cover, TerrainClass.Tree, p);
            const e = expected(cover, TerrainClass.Tree);
            assert.ok(near(c, e, 1e-9), `${JSON.stringify(c)} != ${JSON.stringify(e)}`);
        }
    });

    it('is neutral at the window centre', () => {
        // A facet of exactly average luminance gets the tone unmodified.
        const mid = { r: p.shadeMid, g: p.shadeMid, b: p.shadeMid };
        assert.ok(near(facetColour(mid, TerrainClass.Grass, p), GRASS, 1e-9));
    });

    it('bands rather than smearing: luminances inside one step share a colour', () => {
        // A band is shadeSpread/shadeSteps = 0.04 of luminance wide. These two
        // sit inside one; 0.60 is deliberately avoided because it falls exactly
        // on a boundary, where floating point decides which side it lands.
        const a = facetColour({ r: 0.615, g: 0.615, b: 0.615 }, TerrainClass.Grass, p);
        const b = facetColour({ r: 0.625, g: 0.625, b: 0.625 }, TerrainClass.Grass, p);
        assert.ok(near(a, b, 1e-9), 'two facets within one band got different colours');
    });

    it('does change colour across a band boundary', () => {
        // The other half of the claim: without this, a function that returned a
        // constant would pass the test above.
        const low = facetColour({ r: 0.42, g: 0.42, b: 0.42 }, TerrainClass.Grass, p);
        const high = facetColour({ r: 0.62, g: 0.62, b: 0.62 }, TerrainClass.Grass, p);
        assert.ok(!near(low, high, 1e-6), 'shade did not vary with luminance at all');
        assert.ok(high.g > low.g, 'brighter imagery produced a darker facet');
    });

    it('clamps at the ends of the window instead of running away', () => {
        const dark = facetColour({ r: 0, g: 0, b: 0 }, TerrainClass.Grass, p);
        const darker = facetColour({ r: -5, g: -5, b: -5 } as Rgb, TerrainClass.Grass, p);
        assert.ok(near(dark, darker, 1e-9), 'luminance below the window kept darkening');
        const bright = facetColour({ r: 1, g: 1, b: 1 }, TerrainClass.Grass, p);
        const brighter = facetColour({ r: 5, g: 5, b: 5 } as Rgb, TerrainClass.Grass, p);
        assert.ok(near(bright, brighter, 1e-9), 'luminance above the window kept lightening');
    });

    it('never produces a channel outside 0..1', () => {
        const white = palette({
            mode: TERRAIN_COLOUR_MODE_INDEX[TerrainColours.HYBRID],
            toneColours: Array(11).fill({ r: 1, g: 1, b: 1 }),
        });
        const c = facetColour({ r: 1, g: 1, b: 1 }, TerrainClass.Snow, white);
        for (const v of [c.r, c.g, c.b]) {
            assert.ok(v >= 0 && v <= 1, `channel out of range: ${v}`);
        }
    });
});
