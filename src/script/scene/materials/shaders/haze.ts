import * as THREE from 'three';
import {
    EARTH_ATMOSPHERE, miePhase, multipleScatteringAt, multipleScatteringTable, Rgb, rayleighPhase,
    skyRadiance, sunTransmittance,
} from '../../atmosphere/atmosphere';
import { ColourTweak, adjustColourInPlace, defaultColourTweak } from './colourAdjust';

/**
 * Aerial perspective: the air between the camera and everything it sees,
 * scattering sunlight in and taking the scene's own light out.
 *
 * The same atmosphere the sky is computed from (EARTH_ATMOSPHERE): Rayleigh
 * and Mie carried apart, with their own densities, height falloffs and phase
 * functions. Per fragment:
 *
 * - Extinction per channel. Rayleigh takes blue out of a beam 5.7 times as
 *   fast as red, so a far sunlit ridge yellows and reddens as well as fading.
 *   The optical depth is integrated between the camera's height and the
 *   fragment's (taken off the sphere, not the tangent plane), so the haze
 *   thins as you climb and a peak above the boundary layer stands clear.
 * - Inscatter by phase. Rayleigh's symmetric phase paints the air over far
 *   ground blue; Mie's forward lobe piles a pale glow onto everything lying
 *   towards a low sun and leaves the far side deep. The sunlight doing the
 *   scattering is the sun as seen from that height (uScatterSunT), reddened
 *   by its own path down - so at sunset the haze itself turns orange - plus
 *   the multiply-scattered skylight (uScatterMs).
 *
 * The integral is the analytic one for a homogeneous path, with the path's
 * mean density per species: inscatter = (scattering / extinction) * source
 * * (1 - transmittance). Cheap enough for every fragment, and exact in the
 * limit that matters here, the long saturated ray to the horizon.
 *
 * Exposure comes from the sky dome. The physics answers in units of solar
 * irradiance; the screen shows an authored palette. Per bearing from the sun,
 * uScatterGain is what turns this formula's saturated sea-level horizon into
 * the dome's horizon colour there, so a far ridge melts into exactly the sky
 * behind it while everything nearer keeps the physics' own shape. The
 * reference is the full sky march at the horizon (skyRadiance), brought to
 * the formula's level by their midday ratio, which holds steady at every
 * other sun height. The formula itself would be no reference at sunset: the
 * sea-level air is in the earth's shadow by then and it goes to nothing, so
 * the gain blew up and every lit hill above the shadow glowed. After dark
 * the authored night has no physics left to scale, and the far ground fades
 * into the dome's horizon instead (uScatterNight).
 *
 * The camera is at the origin (every list is drawn camera-relative), so a
 * fragment's camera-relative world position is the ray.
 */

const ATMOSPHERE = EARTH_ATMOSPHERE;

/**
 * How much further the air reaches than EARTH_ATMOSPHERE's own densities:
 * the ground's optical depth is divided by this. The sky keeps the full
 * atmosphere. Scaling both species alike leaves their ratio, and so the
 * saturated horizon the gain is calibrated on, exactly as it was; only how
 * far out it takes to get there changes. 1 is the sky's air (a hazy maritime
 * day, about 110 km visibility at sea level).
 */
export const SCATTER_DISTANCE_SCALE = 2.5;

/** Bearings from the sun the horizon is calibrated at, towards to away. */
export const HAZE_HORIZON_SAMPLES = 17;

/**
 * Altitudes the sun's transmittance and the skylight are tabulated at:
 * 500 * (2^k - 1) m, k = 0..7, so bunched low where the air is.
 */
export const SCATTER_ALTITUDE_BINS = 8;
const SCATTER_ALTITUDE_BASE_M = 500;

function altitudeOfBin(k: number): number {
    return SCATTER_ALTITUDE_BASE_M * (Math.pow(2, k) - 1);
}

const vec3s = (n: number) => Array.from({ length: n }, () => new THREE.Vector3());

/**
 * Shared by reference with every material that hazes, as SUN_UNIFORMS are.
 * uHazeStrength scales the optical depth: 1 in the air, falling to 0 as the
 * atmosphere shell takes over the aerial perspective in space (SPACE_FOG).
 */
export const HAZE_UNIFORMS = {
    uHazeStrength: { value: 1 },
    /** The camera's height above sea level, metres. */
    uHazeCameraAlt: { value: 0 },
    /** Unit vector towards the sun, scene axes. */
    uScatterSun: { value: new THREE.Vector3(0, 1, 0) },
    /** The sun's bearing as a horizontal unit vector (x, z); zero overhead. */
    uHazeSunXZ: { value: new THREE.Vector2(0, 1) },
    uScatterSunT: { value: vec3s(SCATTER_ALTITUDE_BINS) },
    uScatterMs: { value: vec3s(SCATTER_ALTITUDE_BINS) },
    uScatterGain: { value: vec3s(HAZE_HORIZON_SAMPLES) },
    /** The dome's horizon, for the night fade. */
    uHazeHorizon: { value: vec3s(HAZE_HORIZON_SAMPLES) },
    /** 0 by day, 1 once the authored night palette has taken over. */
    uScatterNight: { value: 0 },
};

const glsl = (x: number) => x.toExponential(6);
const glslRgb = (c: Rgb) => `vec3(${c.map(glsl).join(', ')})`;

export const HAZE_PARS_FRAGMENT = `
  uniform float uHazeStrength;
  uniform float uHazeCameraAlt;
  uniform vec3 uScatterSun;
  uniform vec2 uHazeSunXZ;
  uniform vec3 uScatterSunT[${SCATTER_ALTITUDE_BINS}];
  uniform vec3 uScatterMs[${SCATTER_ALTITUDE_BINS}];
  uniform vec3 uScatterGain[${HAZE_HORIZON_SAMPLES}];
  uniform vec3 uHazeHorizon[${HAZE_HORIZON_SAMPLES}];
  uniform float uScatterNight;

  const float HAZE_EARTH_R = 6371000.0;
  const vec3 SCATTER_RAYLEIGH = ${glslRgb(ATMOSPHERE.rayleighScattering)};
  const float SCATTER_RAYLEIGH_H = ${glsl(ATMOSPHERE.rayleighScaleHeight)};
  const float SCATTER_MIE = ${glsl(ATMOSPHERE.mieScattering)};
  const float SCATTER_MIE_EXT = ${glsl(ATMOSPHERE.mieExtinction)};
  const float SCATTER_MIE_H = ${glsl(ATMOSPHERE.mieScaleHeight)};
  const float SCATTER_MIE_G = ${glsl(ATMOSPHERE.mieG)};
  const float SCATTER_PI = 3.14159265;

  /**
   * Mean density over a straight climb from h0 to h1, relative to sea level,
   * for a layer of scale height H. Written as a difference of the two ends'
   * densities so that a ray from orbit cannot overflow the exponential.
   */
  float hazeLayer(float H, float h0, float h1) {
    float dh = h1 - h0;
    float e0 = exp(-h0 / H);
    if (abs(dh) < 1.0e-3 * H) {
      return e0 * (1.0 - 0.5 * dh / H);
    }
    return H * (e0 - exp(-h1 / H)) / dh;
  }

  /** A position into one of the bearing tables, towards the sun first. */
  float scatterBearing(vec3 dir) {
    vec2 across = dir.xz;
    float len = length(across);
    float towardSun = len > 1.0e-6 ? dot(across / len, uHazeSunXZ) : 0.0;
    return acos(clamp(towardSun, -1.0, 1.0)) * ${((HAZE_HORIZON_SAMPLES - 1) / Math.PI).toFixed(8)};
  }

  float scatterAltitude(float h) {
    return clamp(log2(1.0 + max(h, 0.0) / ${SCATTER_ALTITUDE_BASE_M.toFixed(1)}), 0.0, ${(SCATTER_ALTITUDE_BINS - 1).toFixed(1)} - 1.0e-3);
  }

  /**
   * colour seen along ray (camera to fragment, metres), through the air.
   * steps > 0 quantises the transmittance into that many bands, for the
   * retro shading modes the old fog was banded in.
   */
  vec3 applyHaze(vec3 colour, vec3 ray, float steps) {
    if (uHazeStrength <= 0.0) {
      return colour;
    }
    float dist = length(ray);
    vec3 dir = ray / max(dist, 1.0e-3);
    float h0 = max(uHazeCameraAlt, -500.0);
    float h1 = max(length(ray + vec3(0.0, HAZE_EARTH_R + h0, 0.0)) - HAZE_EARTH_R, -500.0);

    // Path-mean scattering and extinction, per metre.
    float s = uHazeStrength / ${SCATTER_DISTANCE_SCALE.toFixed(3)};
    vec3 rayleigh = SCATTER_RAYLEIGH * hazeLayer(SCATTER_RAYLEIGH_H, h0, h1) * s;
    float mieDensity = hazeLayer(SCATTER_MIE_H, h0, h1) * s;
    float mie = SCATTER_MIE * mieDensity;
    vec3 extinction = rayleigh + SCATTER_MIE_EXT * mieDensity;
    vec3 t = exp(-extinction * dist);
    if (steps > 0.0) {
      t = floor(t * steps + 0.5) / steps;
    }

    // Where the scattering happens: the dense end of a thin path, the
    // camera's end of a saturated one.
    float hLow = min(h0, h1);
    float hThin = hLow + 0.5 * min(abs(h1 - h0), SCATTER_MIE_H);
    float hScatter = mix(hThin, h0, smoothstep(1.0, 4.0, extinction.g * dist));
    float a = scatterAltitude(hScatter);
    int ai = int(a);
    vec3 sunT = mix(uScatterSunT[ai], uScatterSunT[ai + 1], a - float(ai));
    vec3 sky = mix(uScatterMs[ai], uScatterMs[ai + 1], a - float(ai));

    float mu = dot(dir, uScatterSun);
    float rayleighPhase = 3.0 / (16.0 * SCATTER_PI) * (1.0 + mu * mu);
    float gg = SCATTER_MIE_G * SCATTER_MIE_G;
    float miePhase = 3.0 * (1.0 - gg) * (1.0 + mu * mu)
        / (8.0 * SCATTER_PI * (2.0 + gg) * pow(max(1.0e-6, 1.0 + gg - 2.0 * SCATTER_MIE_G * mu), 1.5));
    vec3 source = (rayleigh * rayleighPhase + mie * miePhase) * sunT + (rayleigh + mie) * sky;

    float b = scatterBearing(dir);
    int bi = int(min(floor(b), ${(HAZE_HORIZON_SAMPLES - 2).toFixed(1)}));
    float bf = b - float(bi);
    vec3 gain = mix(uScatterGain[bi], uScatterGain[bi + 1], bf);
    vec3 inscatter = gain * source / max(extinction, vec3(1.0e-12)) * (1.0 - t);
    vec3 night = mix(uHazeHorizon[bi], uHazeHorizon[bi + 1], bf) * (1.0 - t);
    return colour * t + mix(inscatter, night, uScatterNight);
  }
`;

/**
 * The scene materials' call: no haze with the fog quality off (the map mode),
 * banded outside the smooth shading mode. Needs fogType and shadingType.
 */
export const HAZE_MATERIAL_PARS_FRAGMENT = `${HAZE_PARS_FRAGMENT}
  vec3 hazed(vec3 colour, vec3 ray) {
    return fogType == 0 ? colour : applyHaze(colour, ray, shadingType != 3 ? 24.0 : 0.0);
  }
`;

export const HAZE_PARS_VERTEX = `
  varying vec3 vHazeRay;
`;

/** The dome's horizon colours, before the player's sky adjustment. */
const rawHorizon = Array.from({ length: HAZE_HORIZON_SAMPLES }, () => new THREE.Color());
/** The formula's own saturated sea-level horizon, at the same bearings. */
const physicalHorizon: Rgb[] = Array.from({ length: HAZE_HORIZON_SAMPLES }, () => [0, 0, 0]);
let skyTweak: ColourTweak = defaultColourTweak();

/**
 * What applyHaze converges to along a horizontal ray at sea level, before the
 * gain: (scattering / extinction) * source, with the path fully saturated.
 * Must stay the shader's formula term for term, or the far ground and the
 * sky behind it part company.
 */
export function saturatedHorizon(dir: THREE.Vector3, sunDir: THREE.Vector3, sunT: Rgb, sky: Rgb, out: Rgb): Rgb {
    const mu = dir.dot(sunDir);
    const rp = rayleighPhase(mu);
    const mp = miePhase(mu, ATMOSPHERE.mieG);
    for (let c = 0; c < 3; c++) {
        const r = ATMOSPHERE.rayleighScattering[c];
        const m = ATMOSPHERE.mieScattering;
        out[c] = ((r * rp + m * mp) * sunT[c] + (r + m) * sky[c]) / (r + ATMOSPHERE.mieExtinction);
    }
    return out;
}

/** Sun elevation the ratio is taken at: the palettes' own noon (skyModel.ts). */
const RATIO_SUN_ELEVATION_DEG = 61;

let ratioCache: Rgb | undefined;

/**
 * The formula's saturated sea-level horizon over the full march's, per
 * channel, averaged round the compass with the sun at its authored noon.
 * About 0.7 / 0.65 / 0.5: the march's horizon ray climbs out of the haze, and
 * aerosol absorbs. It barely moves with the sun until the sea-level air goes
 * into shadow, which is exactly where the formula stops being a reference.
 */
export function formulaToMarch(): Rgb {
    if (ratioCache) {
        return ratioCache;
    }
    const r = RATIO_SUN_ELEVATION_DEG * Math.PI / 180;
    const sun: [number, number, number] = [Math.cos(r), Math.sin(r), 0];
    const sunVec = new THREE.Vector3(...sun);
    const ms = multipleScatteringTable(ATMOSPHERE, sun);
    const sunT = sunTransmittance(ATMOSPHERE, [0, ATMOSPHERE.groundRadius, 0], sun);
    const sky: Rgb = [0, 0, 0];
    multipleScatteringAt(ms, ATMOSPHERE, 0, sky);
    const sum: Rgb = [0, 0, 0];
    const bearings = 8;
    const dir = new THREE.Vector3();
    const f: Rgb = [0, 0, 0];
    for (let i = 0; i < bearings; i++) {
        const a = i / bearings * 2 * Math.PI;
        dir.set(Math.cos(a), 0, Math.sin(a));
        saturatedHorizon(dir, sunVec, sunT, sky, f);
        const m = skyRadiance(ATMOSPHERE, 0, [dir.x, dir.y, dir.z], sun, ms);
        for (let c = 0; c < 3; c++) {
            sum[c] += f[c] / m[c] / bearings;
        }
    }
    ratioCache = sum;
    return sum;
}

/**
 * Re-tabulates the atmosphere for the sun at `sunDir` (scene axes, y up) and
 * calibrates it against `paint` (a SkyPainter, already fitted to gamut by the
 * caller's wrapper). Call wherever the sky dome is repainted, so the two never
 * disagree.
 */
export function setScatterSun(
    paint: (x: number, y: number, z: number, out: [number, number, number]) => void,
    sunDir: THREE.Vector3,
    nightMix: number,
): void {
    const u = HAZE_UNIFORMS;
    u.uScatterSun.value.copy(sunDir).normalize();
    const sun: [number, number, number] = [u.uScatterSun.value.x, u.uScatterSun.value.y, u.uScatterSun.value.z];
    const flat = Math.hypot(sun[0], sun[2]);
    if (flat > 1e-6) {
        u.uHazeSunXZ.value.set(sun[0] / flat, sun[2] / flat);
    } else {
        u.uHazeSunXZ.value.set(0, 0);
    }
    u.uScatterNight.value = nightMix;

    const ms = multipleScatteringTable(ATMOSPHERE, sun);
    const scratch: Rgb = [0, 0, 0];
    for (let k = 0; k < SCATTER_ALTITUDE_BINS; k++) {
        const h = altitudeOfBin(k);
        const t = sunTransmittance(ATMOSPHERE, [0, ATMOSPHERE.groundRadius + h, 0], sun);
        u.uScatterSunT.value[k].set(t[0], t[1], t[2]);
        multipleScatteringAt(ms, ATMOSPHERE, h, scratch);
        u.uScatterMs.value[k].set(scratch[0], scratch[1], scratch[2]);
    }

    const sunBearing = Math.atan2(sun[0], sun[2]);
    const dir = new THREE.Vector3();
    const colour: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < HAZE_HORIZON_SAMPLES; i++) {
        const bearing = sunBearing + i / (HAZE_HORIZON_SAMPLES - 1) * Math.PI;
        dir.set(Math.sin(bearing), 0, Math.cos(bearing));
        paint(dir.x, dir.y, dir.z, colour);
        rawHorizon[i].setRGB(colour[0], colour[1], colour[2]);
        const marched = skyRadiance(ATMOSPHERE, 0, [dir.x, dir.y, dir.z], sun, ms);
        const ratio = formulaToMarch();
        for (let c = 0; c < 3; c++) {
            physicalHorizon[i][c] = marched[c] * ratio[c];
        }
    }
    refreshHorizon();
}

/** The player's sky colour adjustment, which the dome applies in its shader. */
export function setHazeSkyTweak(tweak: ColourTweak): void {
    skyTweak = { ...tweak };
    refreshHorizon();
}

const adjusted = new THREE.Color();

/** Below this the formula has nothing left to scale; the night fade covers it. */
const MIN_PHYSICAL = 1e-12;

function refreshHorizon(): void {
    const u = HAZE_UNIFORMS;
    for (let i = 0; i < HAZE_HORIZON_SAMPLES; i++) {
        adjustColourInPlace(adjusted.copy(rawHorizon[i]), skyTweak);
        const target = u.uHazeHorizon.value[i].set(
            THREE.MathUtils.clamp(adjusted.r, 0, 1),
            THREE.MathUtils.clamp(adjusted.g, 0, 1),
            THREE.MathUtils.clamp(adjusted.b, 0, 1));
        const p = physicalHorizon[i];
        u.uScatterGain.value[i].set(
            p[0] > MIN_PHYSICAL ? target.x / p[0] : 0,
            p[1] > MIN_PHYSICAL ? target.y / p[1] : 0,
            p[2] > MIN_PHYSICAL ? target.z / p[2] : 0);
    }
}
