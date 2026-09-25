import * as THREE from 'three';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import {
    DEFAULT_SUN_HOURS, formatSunTime, setSunTime, SHADOW_MIN_SUN_Y, sunDirectionAt,
    sunElevationAt, SUN_DIRECTION, SUN_SHADE_AMBIENT, SUN_STATE, SUN_UNIFORMS,
} from './sun';
import { REFERENCE_SUN_ELEVATION_DEG } from '../../atmosphere/skyModel';

/** Rec. 709 relative luminance. */
function luminance(v: THREE.Vector3): number {
    return 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z;
}

/**
 * The fixed sun this module replaced; the 14:00 solar position must still match
 * it. Its z is negated against the constant as it was written, because that was
 * authored back when world +z was taken for north: the afternoon sun it stands
 * for is in the south-west either way. See `sceneFromEnu` in terrain/geodesy.ts.
 */
const LEGACY_SUN = new THREE.Vector3(-0.47, 0.76, 0.45).normalize();

// The sun is module-global state; leave it where the rest of the app expects it.
afterEach(() => setSunTime(DEFAULT_SUN_HOURS));

describe('sun position', () => {

    it('reproduces the fixed 14:00 sun the shading was tuned against', () => {
        const dir = sunDirectionAt(14, new THREE.Vector3());
        assert.ok(dir.dot(LEGACY_SUN) > 0.999, `dot ${dir.dot(LEGACY_SUN)}`);
    });

    it('rises due east and sets due west at the equinox', () => {
        const sunrise = sunDirectionAt(6, new THREE.Vector3());
        assert.ok(Math.abs(sunrise.x - 1) < 1e-6, `sunrise east ${sunrise.x}`);
        assert.ok(Math.abs(sunrise.y) < 1e-6, `sunrise on horizon ${sunrise.y}`);

        const sunset = sunDirectionAt(18, new THREE.Vector3());
        assert.ok(Math.abs(sunset.x + 1) < 1e-6, `sunset west ${sunset.x}`);
        assert.ok(Math.abs(sunset.y) < 1e-6, `sunset on horizon ${sunset.y}`);
    });

    it('keeps the sun south of the zenith through the day and below the horizon at night', () => {
        for (let hours = 6.5; hours <= 17.5; hours += 0.5) {
            const dir = sunDirectionAt(hours, new THREE.Vector3());
            assert.ok(dir.y > 0, `${hours}h elevation ${dir.y}`);
            // World z runs south, so a sun south of the zenith has z > 0.
            assert.ok(dir.z > 0, `${hours}h should look south, z ${dir.z}`);
        }
        for (const hours of [0, 2, 4, 20, 22]) {
            assert.ok(sunElevationAt(hours) < 0, `${hours}h elevation ${sunElevationAt(hours)}`);
        }
    });

    it('is a unit vector at every time of day', () => {
        for (let hours = 0; hours < 24; hours += 0.25) {
            const dir = sunDirectionAt(hours, new THREE.Vector3());
            assert.ok(Math.abs(dir.length() - 1) < 1e-9, `${hours}h length ${dir.length()}`);
        }
    });
});

describe('setSunTime', () => {

    it('fades the direct shading term out across dusk and back in at dawn', () => {
        setSunTime(12);
        assert.strictEqual(SUN_STATE.dayFactor, 1);
        assert.ok(Math.abs(SUN_UNIFORMS.uSunShade.value.x - SUN_SHADE_AMBIENT) < 1e-6);
        assert.ok(Math.abs(SUN_UNIFORMS.uSunShade.value.y - (1 - SUN_SHADE_AMBIENT)) < 1e-6);

        setSunTime(0);
        assert.strictEqual(SUN_STATE.dayFactor, 0);
        // Night is lit flat: all ambient, no directional term to shape or shadow.
        assert.strictEqual(SUN_UNIFORMS.uSunShade.value.x, 1);
        assert.strictEqual(SUN_UNIFORMS.uSunShade.value.y, 0);
    });


    it('runs the palette past the light: still lit at sunset, dark by astronomical twilight', () => {
        setSunTime(18);
        assert.ok(SUN_STATE.nightMix < 0.3, `sunset nightMix ${SUN_STATE.nightMix}`);
        // Civil twilight kills the direct light but not the sky.
        setSunTime(18.5);
        assert.strictEqual(SUN_STATE.dayFactor, 0);
        assert.ok(SUN_STATE.nightMix < 0.8, `civil nightMix ${SUN_STATE.nightMix}`);
        setSunTime(20);
        assert.ok(SUN_STATE.nightMix > 0.99, `night nightMix ${SUN_STATE.nightMix}`);
    });

    it('splits the light warm-on-direct, cool-on-ambient near the horizon', () => {
        // Straight from the scattering model: the beam's colour is its own
        // Beer-Lambert transmittance, the fill's is the sky's irradiance.
        setSunTime(18);
        const direct = SUN_UNIFORMS.uSunDirect.value;
        const ambient = SUN_UNIFORMS.uSunAmbient.value;

        // Both tints are relative to a high sun, and at sunset the whole sky
        // has warmed, so both move warm. What has to hold is the *separation*:
        // the beam has crossed far more air than the skylight filling the
        // shadows, so it is dramatically the redder of the two.
        const warmth = (v: THREE.Vector3) => v.x / Math.max(1e-6, v.z);
        assert.ok(warmth(direct) > 4 * warmth(ambient),
            `direct ${direct.toArray()} vs ambient ${ambient.toArray()}`);
    });

    it('spends no brightness on the tint, only hue', () => {
        // The tints are luminance-normalised, so the coloured light has to add
        // up to exactly the scalar ramp the duotone thresholds are cut against.
        for (const hours of [6, 9, 12, 17.5, 18, 21]) {
            setSunTime(hours);
            const { uSunShade, uSunAmbient, uSunDirect } = SUN_UNIFORMS;
            assert.ok(Math.abs(luminance(uSunAmbient.value) - uSunShade.value.x) < 1e-6,
                `${hours}h ambient ${luminance(uSunAmbient.value)} vs ${uSunShade.value.x}`);
            assert.ok(Math.abs(luminance(uSunDirect.value) - uSunShade.value.y) < 1e-6,
                `${hours}h direct ${luminance(uSunDirect.value)} vs ${uSunShade.value.y}`);
        }
    });

    it('leaves a high sun and every night colourless', () => {
        // Neutral tints mean the noon look and the flat night look are byte-for
        // byte what they were before the light carried colour at all.
        for (const hours of [12, 0]) {
            setSunTime(hours);
            const { uSunAmbient, uSunDirect } = SUN_UNIFORMS;
            for (const v of [uSunAmbient.value, uSunDirect.value]) {
                const spread = Math.max(v.x, v.y, v.z) - Math.min(v.x, v.y, v.z);
                assert.ok(spread <= Math.max(v.x, v.y, v.z) * 1e-6, `${hours}h ${v.toArray()}`);
            }
        }
    });

    it('holds cast shadows through the golden hour and drops them at the horizon', () => {
        setSunTime(12);
        assert.strictEqual(SUN_STATE.shadowStrength, 1);

        // The longest, most dramatic shadows of the day are the low-sun ones,
        // and they used to be gone by 17:20. What actually breaks at a grazing
        // sun is per-caster sweep length, bounded in the volume pass, so this
        // ramp only has to cover the last degree.
        setSunTime(17.5);
        assert.ok(SUN_STATE.elevationDeg < 7, `still low: ${SUN_STATE.elevationDeg}`);
        assert.strictEqual(SUN_STATE.shadowStrength, 1);

        // Right on the horizon there is no caster low enough to sweep sanely.
        setSunTime(18);
        assert.ok(SUN_STATE.dayFactor > 0, `dayFactor ${SUN_STATE.dayFactor}`);
        assert.strictEqual(SUN_STATE.shadowStrength, 0);

        setSunTime(17);
        assert.ok(SUN_STATE.shadowStrength > 0.9, `17h ${SUN_STATE.shadowStrength}`);
        setSunTime(0);
        assert.strictEqual(SUN_STATE.shadowStrength, 0);
    });

    it('never sweeps against a sun lower than the one it still draws', () => {
        // The shader floors its 1/sin(elevation) divisor at SHADOW_MIN_SUN_Y.
        // If that floor sat above the cutoff, shadows would freeze at one
        // length while the sun kept dropping - which is what a hard-coded 0.2
        // (11.5 degrees) did across the whole of the old fade band.
        let lowest = Infinity;
        for (let hours = 0; hours < 24; hours += 5 / 60) {
            setSunTime(hours);
            if (SUN_STATE.shadowStrength > 0) {
                lowest = Math.min(lowest, Math.sin(SUN_STATE.elevationDeg * THREE.MathUtils.DEG2RAD));
            }
        }
        assert.ok(lowest >= SHADOW_MIN_SUN_Y - 1e-9, `drew at sunY ${lowest}, floor ${SHADOW_MIN_SUN_Y}`);
    });

    it('updates the shared uniform vector in place so live materials follow', () => {
        const shared = SUN_UNIFORMS.uSunDir.value;
        assert.strictEqual(shared, SUN_DIRECTION);
        setSunTime(9);
        assert.ok(shared.dot(sunDirectionAt(9, new THREE.Vector3())) > 0.999);
    });

    it('wraps hours outside 0..24', () => {
        setSunTime(26);
        const wrapped = SUN_DIRECTION.clone();
        setSunTime(2);
        assert.ok(wrapped.dot(SUN_DIRECTION) > 0.999);
    });
});

describe('the sky model reference', () => {

    it('is local solar noon for the sim latitude, so midday reproduces the palette exactly', () => {
        // Every gain in skyModel.ts is a ratio against this elevation. Drift
        // between the two and noon stops being the authored palette.
        assert.ok(Math.abs(sunElevationAt(12) - REFERENCE_SUN_ELEVATION_DEG) < 1e-9,
            `noon is ${sunElevationAt(12)}, reference is ${REFERENCE_SUN_ELEVATION_DEG}`);
    });
});

describe('formatSunTime', () => {

    it('renders the slider value as HH:MM', () => {
        assert.strictEqual(formatSunTime(0), '00:00');
        assert.strictEqual(formatSunTime(6.5), '06:30');
        assert.strictEqual(formatSunTime(14), '14:00');
        assert.strictEqual(formatSunTime(23.75), '23:45');
        assert.strictEqual(formatSunTime(24), '00:00');
    });
});
