import { Rgb } from "../../scene/atmosphere/atmosphere";
import { skyFor, SkySample } from "../../scene/atmosphere/skyModel";
import { SUN_STATE } from "../../scene/materials/shaders/sun";
import { Palette, PaletteCategory, PaletteColors, PaletteTime, PaletteValues } from "./palette";

/**
 * Builds the palette for a given sun position by blending a profile's noon and
 * midnight palettes and applying what the atmosphere is actually doing.
 *
 * The two authored palettes stay the endpoints: noon is exactly the noon
 * palette, midnight exactly the midnight one, and everything in between is
 * interpolated, so a new tech profile only has to author those two.
 *
 * Between them, the colours come from a scattering model rather than from
 * hand-picked tints - see atmosphere/skyModel.ts. Each slot gets the linear-RGB
 * ratio of its own radiance now to its radiance with the sun high, so a sunset
 * horizon is orange because Rayleigh scattering has taken the blue out of a
 * long path, not because someone chose #ff6a28.
 *
 * All mixing happens in linear light, not in the 8-bit sRGB the palettes are
 * authored in. Lerping gamma-encoded channels is what used to turn the orange
 * cast over a blue sky into flat grey an hour before sunset, and the sunset
 * itself into brown: complementary hues cancel in gamma space instead of
 * passing through a saturated midpoint.
 */

/**
 * Which part of the sky, or of the lit world, each palette category stands in.
 *
 * The atmosphere is sampled once per slot rather than once for the frame,
 * because a real low sun does not tint the dome uniformly: the horizon band
 * burns orange while the zenith deepens into blue, so the sky's top-to-bottom
 * contrast *increases* through sunset. One shared tint collapsed the whole dome
 * onto the same orange, and left the zenith warmer than the horizon once the
 * sun was well down.
 */
enum SkySlot {
    /** The band the sun sets into: the clear colour and the sky's own fog. */
    HORIZON = 'HORIZON',
    /** Aerial perspective over land, which is darker than that band. */
    HAZE = 'HAZE',
    /** Overhead, plus the canopy glass authored to match it. */
    ZENITH = 'ZENITH',
    /** Cloud decks, lit by the beam that reaches them plus the sky around. */
    CLOUD = 'CLOUD',
    /** The solar disc and its corona: Beer-Lambert reddening of the beam. */
    SUN = 'SUN',
    /** Open water, which mirrors the sky instead of diffusing the sun. */
    WATER = 'WATER',
    /** Everything the sun lands on. */
    GROUND = 'GROUND',
}

/**
 * Land terrain categories that should read brighter under daylight. Water is
 * excluded because it already gets its brightness from the sky's mirrored
 * reflection, not from this ground gain.
 */
export const LAND_TERRAIN_CATEGORIES: ReadonlySet<PaletteCategory> = new Set([
    PaletteCategory.TERRAIN_DEFAULT,
    PaletteCategory.TERRAIN_SAND,
    PaletteCategory.TERRAIN_BARE,
    PaletteCategory.TERRAIN_GRASS,
    PaletteCategory.TERRAIN_FOREST,
    PaletteCategory.TERRAIN_SCRUB,
    PaletteCategory.TERRAIN_CROP,
    PaletteCategory.TERRAIN_URBAN,
    PaletteCategory.TERRAIN_SNOW,
    PaletteCategory.TERRAIN_WETLAND,
    PaletteCategory.SCENERY_MOUNTAIN_GRASS,
    PaletteCategory.SCENERY_MOUNTAIN_BARE,
]);

/** How much brighter land terrain is at full daylight; fades out with nightMix. */
const DAYTIME_TERRAIN_BOOST = 0.2;

const SLOT_BY_CATEGORY: ReadonlyMap<PaletteCategory, SkySlot> = new Map([
    [PaletteCategory.BACKGROUND, SkySlot.HORIZON],
    [PaletteCategory.FOG_SKY, SkySlot.HORIZON],
    [PaletteCategory.FOG_TERRAIN, SkySlot.HAZE],
    [PaletteCategory.FOG_LIGHT, SkySlot.HORIZON],
    [PaletteCategory.SKY, SkySlot.ZENITH],
    [PaletteCategory.GLASS, SkySlot.ZENITH],
    [PaletteCategory.SKY_CLOUD, SkySlot.CLOUD],
    [PaletteCategory.SKY_SUN, SkySlot.SUN],
    [PaletteCategory.TERRAIN_WATER, SkySlot.WATER],
    [PaletteCategory.TERRAIN_SHALLOW_WATER, SkySlot.WATER],
]);

function gainForSlot(sky: SkySample, slot: SkySlot): Rgb {
    switch (slot) {
        case SkySlot.HORIZON: return sky.horizon;
        case SkySlot.HAZE: return sky.haze;
        case SkySlot.ZENITH: return sky.zenith;
        case SkySlot.CLOUD: return sky.cloud;
        case SkySlot.SUN: return sky.sunDisc;
        case SkySlot.WATER: return sky.water;
        case SkySlot.GROUND: return sky.ground;
    }
}

/**
 * Categories whose colour is an instrument reading or its own light source
 * (HUD, cockpit gauges, nav lights, fire and smoke). These are emissive or
 * symbolic, so the sun neither tints nor darkens them: they switch between the
 * two authored colours rather than interpolating. HUD text in particular must
 * stay one of the literal palette colours, because the canvas painter
 * pre-renders its glyphs per colour (see Game.getTextColors).
 */
const UNLIT_PREFIXES: readonly string[] = ['HUD', 'COCKPIT', 'LIGHT_', 'FX'];

/**
 * Night mix at which the world flips to the night model set (lit windows, nav
 * beacons). Models are tagged day-only / night-only, so this is a hard switch
 * however smoothly the colours themselves cross over. On the palette's own
 * night ramp this lands around 5 degrees below the horizon, i.e. roughly when
 * real street lighting comes on; on the old ramp it fired 1 degree *above* it.
 */
const NIGHT_MODELS_THRESHOLD = 0.5;

function parseHex(css: string): Rgb {
    const n = parseInt(css.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex(rgb: Rgb): string {
    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    return '#' + ((clamp(rgb[0]) << 16) | (clamp(rgb[1]) << 8) | clamp(rgb[2])).toString(16).padStart(6, '0');
}

/** sRGB 0..255 to linear 0..1. Exact enough to round-trip every byte value. */
function toLinear(rgb: Rgb): Rgb {
    const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return [channel(rgb[0]), channel(rgb[1]), channel(rgb[2])];
}

/** Linear 0..1 back to sRGB 0..255. */
function toSrgb(rgb: Rgb): Rgb {
    const channel = (v: number) => {
        const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return c * 255;
    };
    return [channel(rgb[0]), channel(rgb[1]), channel(rgb[2])];
}

/** Parsed straight to linear; the tints are constants, so this is worth caching. */
const linearCache: Map<string, Rgb> = new Map();

function linearOf(css: string): Rgb {
    let rgb = linearCache.get(css);
    if (rgb === undefined) {
        rgb = toLinear(parseHex(css));
        linearCache.set(css, rgb);
    }
    return rgb;
}

/** Rec. 709 relative luminance of a linear-light colour. */
function luma(rgb: Rgb): number {
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
    return [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ];
}

function isUnlit(category: PaletteCategory): boolean {
    return UNLIT_PREFIXES.some(prefix => (category as string).startsWith(prefix));
}

/**
 * The category whose day-to-night travel stands for every lit surface.
 *
 * Airframe grey, because it is what the raw colours this is for are: a neutral
 * mid-grey with no hue of its own to skew the ratio, authored at both ends.
 */
const LIT_REFERENCE = PaletteCategory.VEHICLE_PLANE_GREY;

/** A dither pair's first tone, or the colour itself. */
function firstTone(entry: string | [string, string]): string {
    return typeof entry === 'string' ? entry : entry[0];
}

/**
 * What a colour the palette does not own must be multiplied by to sit in the
 * same light as one it does. See {@link Palette.light}.
 *
 * Two parts, matching what a palette entry itself gets. The authored travel
 * from day to night is taken as a scalar - the reference category's luminance
 * ratio - rather than as a colour, because a raw colour has no authored night
 * counterpart to blend towards and pulling it towards the reference's grey
 * would drain a mod's camo to nothing. The atmosphere's own gain then goes on
 * top in full colour, so the light stays warm through a sunset.
 */
function lightFor(day: Palette, night: Palette, sky: SkySample): Rgb {
    const dayLuma = luma(linearOf(firstTone(day.colors[LIT_REFERENCE])));
    const nightLuma = luma(linearOf(firstTone(night.colors[LIT_REFERENCE])));
    const level = dayLuma > 1e-6
        ? 1 + (nightLuma / dayLuma - 1) * sky.nightMix
        : 1;
    const gain = gainForSlot(sky, SkySlot.GROUND);
    return [gain[0] * level, gain[1] * level, gain[2] * level];
}

function blendColor(dayCss: string, nightCss: string, nightMix: number, gain: Rgb): string {
    const base = mix(linearOf(dayCss), linearOf(nightCss), nightMix);
    return toHex(toSrgb([base[0] * gain[0], base[1] * gain[1], base[2] * gain[2]]));
}

/**
 * Blends the two authored palettes at `sky.nightMix` and applies the
 * atmosphere's per-slot gains on top.
 */
export function blendPalettes(day: Palette, night: Palette, sky: SkySample): Palette {
    const colors = {} as PaletteColors;
    const nightMix = sky.nightMix;

    for (const category of Object.values(PaletteCategory)) {
        const dayEntry = day.colors[category];
        const nightEntry = night.colors[category];
        if (isUnlit(category)) {
            colors[category] = nightMix < NIGHT_MODELS_THRESHOLD ? dayEntry : nightEntry;
            continue;
        }

        let gain = gainForSlot(sky, SLOT_BY_CATEGORY.get(category) ?? SkySlot.GROUND);
        if (LAND_TERRAIN_CATEGORIES.has(category)) {
            const boost = 1 + DAYTIME_TERRAIN_BOOST * (1 - nightMix);
            gain = [gain[0] * boost, gain[1] * boost, gain[2] * boost];
        }

        if (typeof dayEntry === 'string' && typeof nightEntry === 'string') {
            colors[category] = blendColor(dayEntry, nightEntry, nightMix, gain);
        } else {
            // One of the two authored a dither pair; blend both tones, falling
            // back to the flat colour for whichever side has only one.
            const [dayA, dayB] = typeof dayEntry === 'string' ? [dayEntry, dayEntry] : dayEntry;
            const [nightA, nightB] = typeof nightEntry === 'string' ? [nightEntry, nightEntry] : nightEntry;
            colors[category] = [
                blendColor(dayA, nightA, nightMix, gain),
                blendColor(dayB, nightB, nightMix, gain),
            ];
        }
    }

    const values = {} as PaletteValues;
    for (const key of Object.keys(day.values) as (keyof PaletteValues)[]) {
        values[key] = day.values[key] + (night.values[key] - day.values[key]) * nightMix;
    }

    return {
        colors,
        values,
        time: nightMix < NIGHT_MODELS_THRESHOLD ? PaletteTime.DAY : PaletteTime.NIGHT,
        light: lightFor(day, night, sky),
    };
}

/**
 * The palette for the sun as {@link setSunTime} last left it. Call after moving
 * the sun; the caller owns pushing the result to the renderer.
 */
export function daytimePalette(day: Palette, night: Palette): Palette {
    return blendPalettes(day, night, skyFor(SUN_STATE.elevationDeg));
}
