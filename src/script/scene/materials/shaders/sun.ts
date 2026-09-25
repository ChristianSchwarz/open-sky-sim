import * as THREE from 'three';
import { skyFor } from '../../atmosphere/skyModel';

/**
 * Latitude the sun is modelled at (~29°N, the Canaries). Combined with an
 * equinox declination of 0 this puts sunrise at 06:00 and sunset at 18:00
 * local solar time, and reproduces the old fixed 14:00 sun almost exactly.
 */
const SUN_LATITUDE_RAD: number = 29 * THREE.MathUtils.DEG2RAD;

/** Local solar hour the sim starts at; the sun the shaders were tuned against. */
export const DEFAULT_SUN_HOURS: number = 14;

/** Elevation (degrees) at which the direct sun term is fully off / fully on. */
const DAY_FACTOR_MIN_ELEVATION_DEG = -6; // civil twilight
const DAY_FACTOR_MAX_ELEVATION_DEG = 8;

/**
 * Elevations (degrees) across which cast shadows fade in.
 *
 * This band used to start at 3 and finish at 12, back when shadows came from a
 * depth map that biased along the sun ray and turned to acne once that ray lay
 * near-parallel to the ground. Stencil volumes have no map and no bias, so that
 * reason is gone - and it was costing the golden hour the longest, most
 * dramatic shadows of the day.
 *
 * What genuinely does break at a grazing sun is sweep length: the prism a
 * caster extrudes grows as 1/sin(elevation). That is a *per-caster* problem,
 * not a per-time-of-day one - a hangar roof 10 m up sweeps a manageable prism
 * at 1 degree while an aircraft 3 km up would sweep 170 km - so it is now
 * bounded per caster against ShadowSettings.sweepMax instead. This band only
 * has to cover the last degree, where even a caster on the ground runs away.
 */
const SHADOW_MIN_ELEVATION_DEG = 1;
const SHADOW_MAX_ELEVATION_DEG = 5;

/**
 * sin() of the shadow cutoff: the smallest divisor a sweep is worked out
 * against. Shared with the volume pass so the shader's floor and the elevation
 * the pass switches off at cannot drift apart - a floor above the cutoff would
 * freeze shadows at one length while the sun kept dropping, which is what the
 * old hard-coded 0.2 (11.5 degrees) did through the whole fade band.
 */
export const SHADOW_MIN_SUN_Y = Math.sin(SHADOW_MIN_ELEVATION_DEG * THREE.MathUtils.DEG2RAD);

/**
 * Direction *towards* the sun in world space (+X east, +Y up, +Z south).
 *
 * Mutated in place by {@link setSunTime}: it is handed to the shaders by
 * reference through {@link SUN_UNIFORMS} and read per frame by the shadow map
 * pass, so the cast shadows always agree with the surface shading.
 */
export const SUN_DIRECTION: THREE.Vector3 = new THREE.Vector3();

/**
 * Chromatic split of the light near the horizon: the direct beam reddens as it
 * crosses more air, while what fills the shadows is blue skylight.
 *
 * Both colours come from the scattering model rather than from constants here -
 * the beam's is its Beer-Lambert transmittance, the fill's is the sky's own
 * irradiance on a flat surface - and both are relative to a high sun and
 * normalised to luminance 1, so they shift hue only. How much light there is
 * stays the job of {@link SUN_SHADE_AMBIENT}'s weights.
 *
 * Getting that separation the right way round is the point: dusk used to tint
 * lit and shadowed faces identically warm, when a real low sun leaves shadows
 * distinctly cooler than the faces it strikes.
 */

/**
 * Ambient floor of the shaded lighting ramp (`shade = AMBIENT + (1 − AMBIENT) · N·L`)
 * with the sun high. A fragment in shadow is pulled back down to exactly this,
 * i.e. it keeps the palette base colour and loses only the direct sun term.
 *
 * As the sun sets the direct weight fades to zero and the ambient floor rises
 * to 1: at night everything is lit flat by the night palette instead of keeping
 * a noon-shaped N·L ramp.
 */
export const SUN_SHADE_AMBIENT = 0.55;

/**
 * Sun state derived from the current time of day. Read (not copied) by the
 * palette builder, the shadow pass and the renderer.
 */
export interface SunState {
    /** Local solar time, 0..24. */
    hours: number;
    /** Sun elevation above the horizon, degrees (negative at night). */
    elevationDeg: number;
    /** 0 below civil twilight, 1 with the sun well up; scales the direct light. */
    dayFactor: number;
    /**
     * 0 = the noon palette, 1 = the midnight one. Mirrors the sky model's own
     * crossover, which is the atmosphere's luminance falloff rather than a
     * ramp in elevation, and so lags {@link dayFactor} by a good margin.
     */
    nightMix: number;
    /** 0..1 weight for cast shadows; reaches 0 before the sun grazes the horizon. */
    shadowStrength: number;
}

export const SUN_STATE: SunState = {
    hours: DEFAULT_SUN_HOURS,
    elevationDeg: 0,
    dayFactor: 1,
    nightMix: 0,
    shadowStrength: 1,
};

/**
 * Sun uniforms shared *by reference* with every material the manager builds, so
 * moving the sun is a single in-place write rather than a walk of the material
 * list.
 *
 * `uSunShade` is the scalar (ambient, direct) pair the duotone thresholds are
 * cut against; `uSunAmbient` / `uSunDirect` are the same two weights carrying
 * the light's colour, for the shaded multiply. The scalar is kept rather than
 * derived from the colours so those thresholds stay exactly where they were
 * tuned, whatever the tints do.
 */
export const SUN_UNIFORMS = {
    uSunDir: { value: SUN_DIRECTION },
    uSunShade: { value: new THREE.Vector2(SUN_SHADE_AMBIENT, 1 - SUN_SHADE_AMBIENT) },
    uSunAmbient: { value: new THREE.Vector3(SUN_SHADE_AMBIENT, SUN_SHADE_AMBIENT, SUN_SHADE_AMBIENT) },
    uSunDirect: { value: new THREE.Vector3(1 - SUN_SHADE_AMBIENT, 1 - SUN_SHADE_AMBIENT, 1 - SUN_SHADE_AMBIENT) },
    /**
     * The beam's colour with its weight divided out, luminance 1.
     *
     * The rim light needs the sun's hue but not its strength: the direct weight
     * has all but gone by the time the sun is on the horizon, which is exactly
     * when a backlit subject most needs an edge to separate it from the sky.
     */
    uSunTint: { value: new THREE.Vector3(1, 1, 1) },
};

/**
 * How much of the sun's disc the viewer can see, 0 (wholly behind terrain) to 1
 * (wholly clear). Written per frame by the game from the skyline along the sun's
 * bearing; the clouds scale their direct light by it, since a cloud seen past a
 * ridge that hides the sun is not one the viewer sees lit.
 */
export const SUN_VISIBILITY = { value: 1 };

/**
 * Fraction of a sun disc `diameterDeg` wide that stands above a skyline at
 * `skylineDeg`, both in degrees of elevation. Linear in the height cleared, so
 * the light comes up evenly as the disc rises out from behind the ridge.
 */
export function sunVisibilityFor(sunElevationDeg: number, skylineDeg: number, diameterDeg: number): number {
    return THREE.MathUtils.clamp((sunElevationDeg - skylineDeg) / diameterDeg + 0.5, 0, 1);
}

/**
 * Writes the direction towards the sun at `hours` local solar time into `out`.
 * Equinox declination, so the day is symmetric around 12:00 and the sun rises
 * due east and sets due west.
 */
export function sunDirectionAt(hours: number, out: THREE.Vector3): THREE.Vector3 {
    const hourAngle = (hours - 12) * 15 * THREE.MathUtils.DEG2RAD;
    const sinElevation = THREE.MathUtils.clamp(Math.cos(SUN_LATITUDE_RAD) * Math.cos(hourAngle), -1, 1);
    const cosElevation = Math.sqrt(Math.max(0, 1 - sinElevation * sinElevation));

    // Azimuth measured clockwise from north; the afternoon half mirrors onto
    // the western side, which acos() cannot tell apart on its own. World z
    // runs south, so the northward component is negated on the way out —
    // without that the afternoon sun sits in the north-west instead of the
    // south-west. See `sceneFromEnu` in terrain/geodesy.ts.
    const cosAzimuth = cosElevation > 1e-6
        ? THREE.MathUtils.clamp(-sinElevation * Math.sin(SUN_LATITUDE_RAD) / (cosElevation * Math.cos(SUN_LATITUDE_RAD)), -1, 1)
        : -1;
    let azimuth = Math.acos(cosAzimuth);
    if (hours > 12) {
        azimuth = 2 * Math.PI - azimuth;
    }

    return out.set(
        cosElevation * Math.sin(azimuth),
        sinElevation,
        -cosElevation * Math.cos(azimuth));
}

/** Sun elevation in degrees at `hours` local solar time. */
export function sunElevationAt(hours: number): number {
    const hourAngle = (hours - 12) * 15 * THREE.MathUtils.DEG2RAD;
    const sinElevation = THREE.MathUtils.clamp(Math.cos(SUN_LATITUDE_RAD) * Math.cos(hourAngle), -1, 1);
    return Math.asin(sinElevation) * THREE.MathUtils.RAD2DEG;
}

/** Ramps 0 (night) to 1 (sun well up) across civil twilight. */
function dayFactorFor(elevationDeg: number): number {
    return THREE.MathUtils.smoothstep(elevationDeg, DAY_FACTOR_MIN_ELEVATION_DEG, DAY_FACTOR_MAX_ELEVATION_DEG);
}

/** Weight for cast shadows; see {@link SHADOW_MIN_ELEVATION_DEG}. */
function shadowStrengthFor(elevationDeg: number): number {
    return THREE.MathUtils.smoothstep(elevationDeg, SHADOW_MIN_ELEVATION_DEG, SHADOW_MAX_ELEVATION_DEG);
}

/**
 * Moves the sun to `hours` local solar time. Updates {@link SUN_DIRECTION},
 * {@link SUN_STATE} and the shared shader uniforms in place; the shadow map
 * pass rebuilds its light basis from SUN_DIRECTION on the next frame.
 */
export function setSunTime(hours: number): SunState {
    const wrapped = ((hours % 24) + 24) % 24;
    sunDirectionAt(wrapped, SUN_DIRECTION);

    SUN_STATE.hours = wrapped;
    SUN_STATE.elevationDeg = Math.asin(THREE.MathUtils.clamp(SUN_DIRECTION.y, -1, 1)) * THREE.MathUtils.RAD2DEG;
    SUN_STATE.dayFactor = dayFactorFor(SUN_STATE.elevationDeg);
    SUN_STATE.shadowStrength = shadowStrengthFor(SUN_STATE.elevationDeg);

    const direct = (1 - SUN_SHADE_AMBIENT) * SUN_STATE.dayFactor;
    SUN_UNIFORMS.uSunShade.value.set(1 - direct, direct);

    // Same two weights, now carrying the light's colour, straight from the
    // atmosphere. Both tints are neutral with the sun high and again once the
    // palette has reached night, so noon and midnight look exactly as they did.
    const sky = skyFor(SUN_STATE.elevationDeg);
    SUN_STATE.nightMix = sky.nightMix;
    SUN_UNIFORMS.uSunAmbient.value
        .set(sky.ambientTint[0], sky.ambientTint[1], sky.ambientTint[2])
        .multiplyScalar(1 - direct);
    SUN_UNIFORMS.uSunDirect.value
        .set(sky.directTint[0], sky.directTint[1], sky.directTint[2])
        .multiplyScalar(direct);
    SUN_UNIFORMS.uSunTint.value.set(sky.directTint[0], sky.directTint[1], sky.directTint[2]);

    return SUN_STATE;
}

setSunTime(DEFAULT_SUN_HOURS);

/** Formats a 0..24 hour value as `HH:MM`, for the settings readout. */
export function formatSunTime(hours: number): string {
    const wrapped = ((hours % 24) + 24) % 24;
    const totalMinutes = Math.round(wrapped * 60) % (24 * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}
