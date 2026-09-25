import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { Rgb } from '../../scene/atmosphere/atmosphere';
import { skyFor, SkySample } from '../../scene/atmosphere/skyModel';
import { DEFAULT_SUN_HOURS, setSunTime } from '../../scene/materials/shaders/sun';
import { blendPalettes, daytimePalette, LAND_TERRAIN_CATEGORIES } from './daytimePalette';
import { HDMidnightPalette } from './hd-midnight';
import { HDNoonPalette } from './hd-noon';
import { Palette, PaletteCategory, PaletteColor, PaletteTime } from './palette';

afterEach(() => setSunTime(DEFAULT_SUN_HOURS));

const NEUTRAL: Rgb = [1, 1, 1];

/** A sky that tints nothing, for exercising the blend on its own. */
function plainSky(nightMix: number): SkySample {
    return {
        elevationDeg: 0,
        nightMix,
        zenith: NEUTRAL,
        horizon: NEUTRAL,
        horizonSunward: NEUTRAL,
        haze: NEUTRAL,
        cloud: NEUTRAL,
        sunDisc: NEUTRAL,
        ground: NEUTRAL,
        water: NEUTRAL,
        directTint: NEUTRAL,
        ambientTint: NEUTRAL,
    };
}

describe('blendPalettes', () => {

    it('reproduces the authored palettes at both endpoints', () => {
        const noon = blendPalettes(HDNoonPalette, HDMidnightPalette, plainSky(0));
        const midnight = blendPalettes(HDNoonPalette, HDMidnightPalette, plainSky(1));

        for (const category of Object.values(PaletteCategory)) {
            if (!LAND_TERRAIN_CATEGORIES.has(category)) {
                assert.deepStrictEqual(
                    lower(noon.colors[category]), lower(HDNoonPalette.colors[category]), category);
            }
            assert.deepStrictEqual(
                lower(midnight.colors[category]), lower(HDMidnightPalette.colors[category]), category);
        }
        assert.deepStrictEqual(noon.values, HDNoonPalette.values);
        assert.deepStrictEqual(midnight.values, HDMidnightPalette.values);
    });

    it('lands the halfway sky between the two authored skies, in linear light', () => {
        const half = PaletteColor(
            blendPalettes(HDNoonPalette, HDMidnightPalette, plainSky(0.5)), PaletteCategory.SKY);
        // #7aa3c4 / #182028 mixed as light, not as gamma-encoded bytes. Brighter
        // than the componentwise sRGB midpoint (#496276) would be, which is the
        // point: half the light left is not half the encoded value.
        assert.strictEqual(half, '#5a7992');
    });

    it('switches HUD colours instead of interpolating them', () => {
        // The canvas painter pre-renders glyphs per colour, so HUD text has to
        // stay one of the literal palette entries at every time of day.
        // The HD palettes share one HUD colour, so give the night palette its own.
        const nightPalette: Palette = {
            ...HDMidnightPalette,
            colors: { ...HDMidnightPalette.colors, [PaletteCategory.HUD_TEXT]: '#FFAA00' },
        };
        const day = PaletteColor(HDNoonPalette, PaletteCategory.HUD_TEXT);
        const night = PaletteColor(nightPalette, PaletteCategory.HUD_TEXT);
        assert.notStrictEqual(day, night);

        for (const mix of [0, 0.25, 0.49, 0.5, 0.75, 1]) {
            const sky = { ...plainSky(mix), ground: [3, 0.2, 0.2] as Rgb };
            const blended = PaletteColor(
                blendPalettes(HDNoonPalette, nightPalette, sky), PaletteCategory.HUD_TEXT);
            assert.ok(blended === day || blended === night, `mix ${mix} gave ${blended}`);
        }
    });

    it('applies each slot its own gain', () => {
        const sky: SkySample = { ...plainSky(0), zenith: [1, 1, 0.5], horizon: [1, 0.5, 1] };
        const palette = blendPalettes(HDNoonPalette, HDMidnightPalette, sky);

        // Only the blue of the zenith and the green of the horizon should move.
        const zenith = channels(PaletteColor(palette, PaletteCategory.SKY));
        const authoredZenith = channels(PaletteColor(HDNoonPalette, PaletteCategory.SKY));
        assert.strictEqual(zenith[0], authoredZenith[0]);
        assert.ok(zenith[2] < authoredZenith[2], 'zenith blue should have dropped');

        const horizon = channels(PaletteColor(palette, PaletteCategory.FOG_SKY));
        const authoredHorizon = channels(PaletteColor(HDNoonPalette, PaletteCategory.FOG_SKY));
        assert.strictEqual(horizon[2], authoredHorizon[2]);
        assert.ok(horizon[1] < authoredHorizon[1], 'horizon green should have dropped');
    });

    it('flips to the night model set once the night mix passes halfway', () => {
        assert.strictEqual(blendPalettes(HDNoonPalette, HDMidnightPalette, plainSky(0.4)).time, PaletteTime.DAY);
        assert.strictEqual(blendPalettes(HDNoonPalette, HDMidnightPalette, plainSky(0.6)).time, PaletteTime.NIGHT);
    });
});

describe('light, for colours the palette does not own', () => {

    // A raw-colour material - a mod's own #rrggbb material name - never goes
    // through the palette at all, so nothing here could reach it. Before this
    // existed a mod's camo sat at noon brightness against a midnight
    // landscape: a glowing aeroplane over black terrain.

    const LIT = PaletteCategory.VEHICLE_PLANE_GREY;

    function toLinear(v: number): number {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    /** A palette colour as the linear-light triple a material uniform holds. */
    function linear(css: string): Rgb {
        const n = parseInt(css.slice(1), 16);
        return [toLinear((n >> 16) & 0xff), toLinear((n >> 8) & 0xff), toLinear(n & 0xff)];
    }

    const relLuma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

    const lightAt = (hours: number) => {
        setSunTime(hours);
        return daytimePalette(HDNoonPalette, HDMidnightPalette).light!;
    };

    it('is neutral at noon, so an authored colour is left exactly as authored', () => {
        const light = lightAt(12);
        assert.ok(light, 'a blended palette must carry one');
        for (const channel of light) {
            assert.ok(Math.abs(channel - 1) < 1e-6, `noon is not neutral: ${light}`);
        }
    });

    it('is absent from an authored palette, which means neutral', () => {
        // The noon palette *is* noon; there is nothing to apply to it. Callers
        // read it as optional rather than having to special-case a value.
        assert.strictEqual(HDNoonPalette.light, undefined);
        assert.strictEqual(HDMidnightPalette.light, undefined);
    });

    it('lands a raw colour where its palette equivalent lands', () => {
        // The whole point: a mod plane and a stock plane have to agree. Feed it
        // the very colour the palette authored for airframes and it should come
        // out close to what the palette made of that colour.
        for (const hours of [12, 16, 18, 22]) {
            const light = lightAt(hours);
            const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);

            const authored = linear(HDNoonPalette.colors[LIT] as string);
            const asRaw = authored.map((v, i) => v * light[i]);
            const asPalette = linear(PaletteColor(palette, LIT) as string);

            // Not equal: the authored night colour carries a hue of its own,
            // and this takes only its level so a camo keeps its colour. The
            // brightness is what has to match.
            const ratio = relLuma(asRaw) / Math.max(relLuma(asPalette), 1e-9);
            assert.ok(ratio > 0.75 && ratio < 1.33,
                `${hours}h: raw is ${ratio.toFixed(2)}x its palette equivalent`);
        }
    });

    it('darkens a raw colour by more than an order of magnitude by night', () => {
        const noon = relLuma(lightAt(12));
        const night = relLuma(lightAt(22));
        assert.ok(night < noon / 10, `night ${night} is not far enough below noon ${noon}`);
        assert.ok(night > 0, 'a raw colour must not go absolutely black');
    });

    it('carries the light colour, not just its level', () => {
        // A sunset is warm, and a raw colour standing in it has to be warm too
        // or a mod plane reads as a cut-out against the sky behind it.
        setSunTime(18);
        const light = daytimePalette(HDNoonPalette, HDMidnightPalette).light!;
        assert.notStrictEqual(light[0], light[2], 'the light is colourless at sunset');
    });
});

describe('daytimePalette', () => {

    it('reproduces the authored palettes at noon and in the small hours', () => {
        // Noon is the elevation every gain is a ratio against, so it has to
        // come back untouched; deep night is past where any of them still bite.
        setSunTime(12);
        for (const category of [PaletteCategory.SKY, PaletteCategory.FOG_SKY]) {
            assert.strictEqual(
                PaletteColor(daytimePalette(HDNoonPalette, HDMidnightPalette), category),
                PaletteColor(HDNoonPalette, category).toLowerCase(), `noon ${category}`);
        }

        setSunTime(0);
        for (const category of [PaletteCategory.SKY, PaletteCategory.FOG_SKY, PaletteCategory.TERRAIN_GRASS]) {
            assert.strictEqual(
                PaletteColor(daytimePalette(HDNoonPalette, HDMidnightPalette), category),
                PaletteColor(HDMidnightPalette, category).toLowerCase(), `midnight ${category}`);
        }
    });

    it('reddens the horizon into sunset while the zenith stays cool', () => {
        // Rayleigh has taken the blue out of the long horizon path, and the
        // short one overhead still has it. The two ends of the dome part
        // company rather than sinking onto the same orange together.
        setSunTime(18);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        const zenith = PaletteColor(palette, PaletteCategory.SKY);
        const horizon = PaletteColor(palette, PaletteCategory.FOG_SKY);
        assert.ok(redShift(zenith, horizon) > 40, `zenith ${zenith} horizon ${horizon}`);
    });

    it('keeps the haze over land well below the sky it fades into', () => {
        // The reported bug: FOG_TERRAIN shared a slot with the sky's horizon,
        // so at sunset every distant ridge became a slab of glowing orange
        // brighter than the land had any business being. Aerial perspective
        // washes distant land towards the light between you and it; it does not
        // make land outshine the ground it sits on.
        setSunTime(18);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        const haze = luma(PaletteColor(palette, PaletteCategory.FOG_TERRAIN));
        const sky = luma(PaletteColor(palette, PaletteCategory.FOG_SKY));
        assert.ok(haze < sky * 0.75, `haze ${haze} vs sky ${sky}`);
    });

    it('still fades distant land into the plain sky at noon', () => {
        // ...while leaving ordinary aerial perspective exactly as authored.
        setSunTime(12);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        assert.strictEqual(
            PaletteColor(palette, PaletteCategory.FOG_TERRAIN),
            PaletteColor(HDNoonPalette, PaletteCategory.FOG_TERRAIN).toLowerCase());
    });

    it('keeps the sun in step with the sky it is lighting', () => {
        // SKY_SUN used to be the beam's own colour - what survives the path -
        // which at sunset is far redder than the sky around it. That put an
        // orange sun in a pink sky with a visible seam. It is the aureole's
        // colour now, so it has to sit near the sky rather than run past it;
        // the disc gets its brightness from its material, not from here.
        setSunTime(18);
        const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
        const sun = PaletteColor(palette, PaletteCategory.SKY_SUN);
        const sky = PaletteColor(palette, PaletteCategory.FOG_SKY);
        assert.ok(Math.abs(redShift(sky, sun)) < 90, `sun ${sun} has left the sky ${sky}`);
        // Still warmer than it was at noon, and warmer than the sky overhead.
        assert.ok(redShift(PaletteColor(palette, PaletteCategory.SKY), sun) > 0,
            `sun ${sun} vs zenith ${PaletteColor(palette, PaletteCategory.SKY)}`);
    });

    it('is warmer at sunset than an hour before it', () => {
        assert.ok(redShift('#000000', horizonAt(18)) > redShift('#000000', horizonAt(17)));
    });

    it('still has a lit sky at sunset instead of a half-black one', () => {
        // Sunset is the brightest, most colourful moment of the cycle, so the
        // palette must not already be most of the way to midnight by then.
        const horizon = luma(horizonAt(18));
        assert.ok(horizon > luma(horizonAt(12)) * 0.35, 'sunset vs noon');
        assert.ok(horizon > luma(horizonAt(0)) * 8, 'sunset vs midnight');
    });

    it('keeps darkening through nautical twilight, well past sunset', () => {
        // Only ever downwards. It levels off rather than stopping dead - once
        // the night mix has arrived the authored midnight palette is the
        // answer and there is nothing left to fade - so this allows a plateau
        // at the bottom but never a rise.
        const dusk = [18, 18.5, 19, 19.5].map(h => luma(horizonAt(h)));
        for (let i = 1; i < dusk.length; i++) {
            assert.ok(dusk[i] <= dusk[i - 1] + 1e-9, `${dusk[i]} is brighter than ${dusk[i - 1]}`);
        }
        assert.ok(dusk[dusk.length - 1] < dusk[0], 'dusk did not darken at all');
        assert.ok(dusk[1] > luma(horizonAt(0)) * 3, 'civil twilight should still be lit');
    });

    it('lights the night models around civil twilight, not before sunset', () => {
        setSunTime(17.9);
        assert.strictEqual(daytimePalette(HDNoonPalette, HDMidnightPalette).time, PaletteTime.DAY);
        setSunTime(18.9);
        assert.strictEqual(daytimePalette(HDNoonPalette, HDMidnightPalette).time, PaletteTime.NIGHT);
    });

    it('no longer renders ten hours of the day identically', () => {
        // The original complaint: every factor was pinned from 07:30 to 16:30
        // and the sky came out bit-for-bit the same. Air mass varies all day,
        // so the sky has to as well.
        const skies = [9, 11, 12, 14, 16, 17].map(h => {
            setSunTime(h);
            const palette = daytimePalette(HDNoonPalette, HDMidnightPalette);
            return `${PaletteColor(palette, PaletteCategory.SKY)}/${PaletteColor(palette, PaletteCategory.FOG_SKY)}`;
        });
        assert.strictEqual(new Set(skies).size, skies.length, `repeats in ${skies}`);
    });

    it('darkens the ground into dusk rather than brightening it', () => {
        // The cosine on a near-flat surface kills the beam long before the sky
        // stops glowing, which is why a sunset landscape goes dark under a lit
        // sky. Pulling the palette towards a bright orange used to do the
        // opposite and leave the ground brighter at sunset than at noon.
        const ground = (hours: number) => {
            setSunTime(hours);
            return luma(PaletteColor(daytimePalette(HDNoonPalette, HDMidnightPalette), PaletteCategory.TERRAIN_GRASS));
        };
        const noon = ground(12);
        for (const hours of [16, 17, 17.5, 18]) {
            assert.ok(ground(hours) < noon, `${hours}h is brighter than noon`);
        }
    });
});

function horizonAt(hours: number): string {
    setSunTime(hours);
    return PaletteColor(daytimePalette(HDNoonPalette, HDMidnightPalette), PaletteCategory.FOG_SKY);
}

function lower(entry: string | [string, string]): string | [string, string] {
    return typeof entry === 'string' ? entry.toLowerCase() : [entry[0].toLowerCase(), entry[1].toLowerCase()];
}

/** How much redder `b` is than `a`, as red minus blue. */
function redShift(a: string, b: string): number {
    const [ar, , ab] = channels(a);
    const [br, , bb] = channels(b);
    return (br - bb) - (ar - ab);
}

/** Rec. 709 relative luminance, in linear light. */
function luma(css: string): number {
    const [r, g, b] = channels(css).map(v => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function channels(css: string): [number, number, number] {
    const n = parseInt(css.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
