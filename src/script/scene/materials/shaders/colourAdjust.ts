import * as THREE from 'three';

/**
 * Player-set hue, saturation and brightness, per kind of scenery.
 *
 * Applied at the very end of each group's own colour decision - after the
 * palette, the imagery and the time of day have had their say, before light
 * and fog - so the defaults are exactly the look as authored and the sliders
 * only ever lean on it. Hue turns the colour about the grey axis, which keeps
 * a grey grey and leaves the channel sum alone; saturation pulls towards (0)
 * or pushes away from (above 1) the colour's own grey; brightness scales it.
 */

/** The groups the Graphics tab offers sliders for, in display order. */
export const COLOUR_ADJUST_GROUPS = ['trees', 'terrain', 'water', 'sky'] as const;
export type ColourAdjustGroup = typeof COLOUR_ADJUST_GROUPS[number];

export interface ColourTweak {
    /** Degrees around the colour wheel, -180..180; 0 is as authored. */
    hue: number;
    saturation: number;
    brightness: number;
}

export type ColourAdjust = Record<ColourAdjustGroup, ColourTweak>;

/** Saturation and brightness range; 1 is as authored. */
export const COLOUR_TWEAK_MIN = 0;
export const COLOUR_TWEAK_MAX = 2;
export const COLOUR_HUE_MAX_DEG = 180;

export function defaultColourTweak(): ColourTweak {
    return { hue: 0, saturation: 1, brightness: 1 };
}

export function defaultColourAdjust(): ColourAdjust {
    return {
        trees: defaultColourTweak(),
        terrain: defaultColourTweak(),
        water: defaultColourTweak(),
        sky: defaultColourTweak(),
    };
}

function clampTo(value: unknown, min: number, max: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, value));
}

/** Anything stored or typed, made whole: a missing or unusable entry is as authored. */
export function clampColourAdjust(value: unknown): ColourAdjust {
    const out = defaultColourAdjust();
    if (typeof value !== 'object' || value === null) {
        return out;
    }
    const source = value as Partial<Record<ColourAdjustGroup, Partial<ColourTweak>>>;
    for (const group of COLOUR_ADJUST_GROUPS) {
        const tweak = source[group];
        if (typeof tweak === 'object' && tweak !== null) {
            out[group] = {
                hue: clampTo(tweak.hue, -COLOUR_HUE_MAX_DEG, COLOUR_HUE_MAX_DEG, 0),
                saturation: clampTo(tweak.saturation, COLOUR_TWEAK_MIN, COLOUR_TWEAK_MAX, 1),
                brightness: clampTo(tweak.brightness, COLOUR_TWEAK_MIN, COLOUR_TWEAK_MAX, 1),
            };
        }
    }
    return out;
}

/**
 * The shader side: x = saturation, y = brightness, z = hue in radians.
 * Shared by reference with every material that reads them, as SUN_UNIFORMS
 * are, so a slider is one write here. Water has none - it is a flat palette
 * colour, adjusted on the CPU by the material manager instead of in the
 * shader every mesh shares.
 */
export const COLOUR_ADJUST_UNIFORMS = {
    uAdjTrees: { value: new THREE.Vector3(1, 1, 0) },
    uAdjTerrain: { value: new THREE.Vector3(1, 1, 0) },
    uAdjSky: { value: new THREE.Vector3(1, 1, 0) },
};

function setTweakUniform(target: THREE.Vector3, tweak: ColourTweak): void {
    target.set(tweak.saturation, tweak.brightness, tweak.hue * THREE.MathUtils.DEG2RAD);
}

export function setColourAdjustUniforms(adjust: ColourAdjust): void {
    setTweakUniform(COLOUR_ADJUST_UNIFORMS.uAdjTrees.value, adjust.trees);
    setTweakUniform(COLOUR_ADJUST_UNIFORMS.uAdjTerrain.value, adjust.terrain);
    setTweakUniform(COLOUR_ADJUST_UNIFORMS.uAdjSky.value, adjust.sky);
}

const LUMA = [0.2126, 0.7152, 0.0722];
const INV_SQRT3 = 1 / Math.sqrt(3);

/** The same adjustment as the GLSL below, in place on a linear colour. */
export function adjustColourInPlace(color: THREE.Color, tweak: ColourTweak): THREE.Color {
    // Rodrigues rotation about the grey axis (1,1,1)/sqrt(3).
    const a = tweak.hue * THREE.MathUtils.DEG2RAD;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const { r, g, b } = color;
    const mean = (r + g + b) / 3 * (1 - cos);
    const hr = r * cos + (b - g) * INV_SQRT3 * sin + mean;
    const hg = g * cos + (r - b) * INV_SQRT3 * sin + mean;
    const hb = b * cos + (g - r) * INV_SQRT3 * sin + mean;

    const l = LUMA[0] * hr + LUMA[1] * hg + LUMA[2] * hb;
    const channel = (c: number) => Math.max(0, l + (c - l) * tweak.saturation) * tweak.brightness;
    return color.setRGB(channel(hr), channel(hg), channel(hb));
}

/** `adjustColour(c, uAdjX)`: one group's hue, saturation and brightness on a linear colour. */
export const COLOUR_ADJUST_PARS = `
  vec3 adjustColour(vec3 c, vec3 tweak) {
    float cosH = cos(tweak.z);
    float sinH = sin(tweak.z);
    vec3 turned = c * cosH
        + vec3(c.b - c.g, c.r - c.b, c.g - c.r) * (${INV_SQRT3} * sinH)
        + vec3((c.r + c.g + c.b) / 3.0 * (1.0 - cosH));
    float l = dot(turned, vec3(${LUMA.join(', ')}));
    return max(mix(vec3(l), turned, tweak.x), 0.0) * tweak.y;
  }
`;
