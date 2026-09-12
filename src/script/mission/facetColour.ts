/**
 * `facetColor()` from the terrain vertex shader, on the CPU.
 *
 * The plan view is a chart of the world the player flies, so it has to be
 * painted the way the world is painted — the same landcover class, the same
 * satellite colour, the same palette tones, the same four modes. The data is
 * all there in the baked mesh; only the resolution of it lived in GLSL.
 *
 * This is a deliberate duplication of
 * [terrainVP.ts](../scene/materials/shaders/terrainVP.ts), and the risk that
 * comes with it is drift: change the shader and this silently keeps painting
 * the old colours. Two things hold them together — the inputs are the same
 * uniforms rather than a parallel set of constants, and
 * `facetColour.test.ts` pins each mode's behaviour against the same worked
 * examples the shader implements. The alternative was pointing a second camera
 * at the terrain mesh, which needs a projection refactor of the renderer's
 * hottest path and shares the mesh cache, so panning the map would evict
 * terrain from under the aircraft.
 *
 * Lighting is deliberately NOT applied. The shader multiplies by `uRawLight`,
 * which is a time-of-day term; a chart authored at midnight would otherwise be
 * black. This returns the unlit colour — what the facet *is*, not how it looks
 * at this hour.
 */

import { TERRAIN_COLOUR_MODE_INDEX, TerrainColours } from '../state/gameDefs';
import { CLASS_TO_TONE, LANDUSE_BLEND_DEFAULT, LAND_TONE_BASE, TerrainTone } from '../terrain/tones';
import type { TerrainColourMode } from '../terrain/tones';

/**
 * TerrainClass.Ground, spelled out: TerrainClass is a `const enum`, and the
 * tsx test runner leaves an imported const-enum binding undefined, so a
 * comparison against it would silently never match under test.
 */
const GROUND_CLASS = 13;

/**
 * The mode numbers, read from the runtime map rather than the enum.
 *
 * `TerrainColourMode` is a `const enum`: the webpack build inlines it, but the
 * transpile-only test runner leaves the imported binding undefined, so
 * comparing against it would silently match nothing under test and everything
 * would fall through to the landcover branch. This map is a real object and is
 * the same one the material uploads from.
 */
const MODE = TERRAIN_COLOUR_MODE_INDEX;

export interface Rgb { r: number; g: number; b: number }

/** The uniforms `facetColor` reads, as the CPU sees them. */
export interface FacetPalette {
    mode: TerrainColourMode;
    /** Palette colour per {@link TerrainTone}, 0..1 per channel. */
    toneColours: readonly Rgb[];
    /** The bake's derived colour table for SWATCH mode, 0..1 per channel. */
    swatches: readonly Rgb[];
    /** `uShadeSteps` — bands either side of the window centre. */
    shadeSteps: number;
    /** `uShadeRange` — how far a band may lighten or darken the tone. */
    shadeRange: number;
    /** `uShadeWindow.x` — the luminance this bake calls average. */
    shadeMid: number;
    /** `uShadeWindow.y` — half-width of the window, in luminance. */
    shadeSpread: number;
    /**
     * `uLanduseBlend` — Hybrid mode's share of palette tone against sampled
     * colour, 0..1. Omit for the shader's default.
     */
    landuseBlend?: number;
}

/** The shader's own defaults, for a caller that has no material to read. */
export const DEFAULT_FACET_SHADE = {
    shadeSteps: 5,
    shadeRange: 0.35,
    shadeMid: 0.5,
    shadeSpread: 0.2,
} as const;

/** Nearest table colour in plain RGB distance — `nearestSwatch` in the shader. */
function nearestSwatch(c: Rgb, swatches: readonly Rgb[]): Rgb {
    let best = c;
    let bestD = Infinity;
    for (const s of swatches) {
        const dr = s.r - c.r, dg = s.g - c.g, db = s.b - c.b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) {
            bestD = d;
            best = s;
        }
    }
    return best;
}

/** Relative luminance, the weighting the hybrid mode bands on. */
function luma(c: Rgb): number {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The colour a land facet is painted, given its baked attributes.
 *
 * `cover` is the mean satellite colour over the triangle's footprint and `cls`
 * its landcover class, both straight out of the tile's `landAttrs`. Channels in
 * and out are 0..1 sRGB — the shader converts to linear for the GPU, which is a
 * step a 2D canvas must not repeat.
 */
export function facetColour(cover: Rgb, cls: number, palette: FacetPalette): Rgb {
    if (palette.mode === MODE[TerrainColours.IMAGERY]) {
        return cover;
    }
    if (palette.mode === MODE[TerrainColours.SWATCH]) {
        // With no table baked there is nothing to snap to, and the raw colour
        // is a better answer than black.
        return palette.swatches.length === 0 ? cover : nearestSwatch(cover, palette.swatches);
    }

    // Unmapped ground on a landuse tile carries its own blended regional
    // colour; the shader paints it as it is, so the chart does too.
    if (cls === GROUND_CLASS) {
        return cover;
    }

    const tone = toneColour(CLASS_TO_TONE[cls] ?? TerrainTone.Grass, palette.toneColours);
    if (palette.mode !== MODE[TerrainColours.HYBRID]) {
        return tone;
    }
    // Hybrid, line for line with the shader: the palette keeps the hue and the
    // imagery only says how light this patch of that cover is against what the
    // bake calls average. Banded, so neighbouring facets share a step and the
    // result reads as terraced rather than as noise. Measured in sRGB against
    // `shadeMid`, not against mid-grey — in linear light real ground bunches
    // into the bottom of the range and every facet lands in the same band.
    const lum = luma(cover);
    const d = Math.max(-1, Math.min(1,
        (lum - palette.shadeMid) / Math.max(palette.shadeSpread, 0.001)));
    const band = Math.floor(d * palette.shadeSteps + 0.5) / Math.max(palette.shadeSteps, 1);
    const scale = 1 + band * palette.shadeRange;
    // Then mixed with the sampled colour by the player's land-use blend, as
    // the shader does. 1 is the banded tone alone, 0 the imagery alone.
    const t = palette.landuseBlend ?? LANDUSE_BLEND_DEFAULT;
    return {
        r: clamp01(cover.r + (tone.r * scale - cover.r) * t),
        g: clamp01(cover.g + (tone.g * scale - cover.g) * t),
        b: clamp01(cover.b + (tone.b * scale - cover.b) * t),
    };
}

/**
 * Palette colour for a tone. Water tones come first and are draw groups rather
 * than palette slots, so land tones index from {@link LAND_TONE_BASE} — the
 * same offset the shader's `uToneColor` upload uses.
 */
export function toneColour(tone: TerrainTone, toneColours: readonly Rgb[]): Rgb {
    return toneColours[tone] ?? toneColours[LAND_TONE_BASE] ?? { r: 0.4, g: 0.5, b: 0.35 };
}
