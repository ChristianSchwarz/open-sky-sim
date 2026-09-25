import * as THREE from 'three';
import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { HDMidnightPalette } from '../../../config/palettes/hd-midnight';
import { HDNoonPalette } from '../../../config/palettes/hd-noon';
import { PaletteCategory, PaletteColor } from '../../../config/palettes/palette';
import { DisplayShading, FogQuality } from '../../../config/profiles/profile';
import { SceneMaterialManager } from '../../materials/materials';
import { DEFAULT_SUN_HOURS, setSunTime, SUN_DIRECTION, SUN_STATE } from '../../materials/shaders/sun';
import { paintSkyDome, SkyDome, SkyDomeModelLibBuilder, skyDomeOf } from './skyDomeModelBuilder';

afterEach(() => setSunTime(DEFAULT_SUN_HOURS));

function buildDome(): SkyDome {
    const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
    const dome = skyDomeOf(new SkyDomeModelLibBuilder('skyDome').build(materials));
    assert.ok(dome, 'builder produced no dome');
    return dome;
}

function colorsOf(dome: SkyDome): Float32Array {
    return dome.mesh.geometry.getAttribute('skyColor').array as Float32Array;
}

/** Paints the dome for `hours` and hands back its vertex colours. */
function paintAt(dome: SkyDome, hours: number): Float32Array {
    setSunTime(hours);
    paintSkyDome(dome, HDNoonPalette, HDMidnightPalette, SUN_STATE.nightMix, SUN_DIRECTION);
    return colorsOf(dome);
}

/** Index of the vertex nearest a given elevation and compass bearing (degrees). */
function vertexAt(dome: SkyDome, elevationDeg: number, bearingDeg: number): number {
    const target = new THREE.Vector3(
        Math.cos(elevationDeg * THREE.MathUtils.DEG2RAD) * Math.sin(bearingDeg * THREE.MathUtils.DEG2RAD),
        Math.sin(elevationDeg * THREE.MathUtils.DEG2RAD),
        Math.cos(elevationDeg * THREE.MathUtils.DEG2RAD) * Math.cos(bearingDeg * THREE.MathUtils.DEG2RAD));

    let best = 0;
    let bestDot = -Infinity;
    const d = dome.directions;
    for (let i = 0; i < d.length; i += 3) {
        const dot = d[i] * target.x + d[i + 1] * target.y + d[i + 2] * target.z;
        if (dot > bestDot) {
            bestDot = dot;
            best = i;
        }
    }
    return best;
}

/** Compass bearing of the sun, in degrees. */
function sunBearing(): number {
    return Math.atan2(SUN_DIRECTION.x, SUN_DIRECTION.z) * THREE.MathUtils.RAD2DEG;
}

/** Rec. 709 relative luminance of a vertex. */
function luminance(colors: Float32Array, i: number): number {
    return 0.2126 * colors[i] + 0.7152 * colors[i + 1] + 0.0722 * colors[i + 2];
}

/** How much redder than blue a vertex is; the sunset measure. */
function warmth(colors: Float32Array, i: number): number {
    return colors[i] - colors[i + 2];
}

function toSrgbHex(colors: Float32Array, i: number): string {
    const encode = (v: number) => {
        const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
        return Math.round(Math.max(0, Math.min(255, c * 255))).toString(16).padStart(2, '0');
    };
    return `#${encode(colors[i])}${encode(colors[i + 1])}${encode(colors[i + 2])}`;
}

describe('sky dome geometry', () => {

    it('covers the whole dome with unit directions', () => {
        const dome = buildDome();
        const d = dome.directions;
        assert.ok(d.length / 3 > 300, `only ${d.length / 3} vertices`);

        let lowest = Infinity;
        let highest = -Infinity;
        for (let i = 0; i < d.length; i += 3) {
            const length = Math.hypot(d[i], d[i + 1], d[i + 2]);
            assert.ok(Math.abs(length - 1) < 1e-5, `direction ${i / 3} has length ${length}`);
            lowest = Math.min(lowest, d[i + 1]);
            highest = Math.max(highest, d[i + 1]);
        }
        assert.ok(highest > 0.999, 'no zenith');
        // A skirt below the horizon, for the dip you get at altitude.
        assert.ok(lowest < -0.1, `skirt only reaches ${lowest}`);
    });

    it('carries one colour per vertex and a closed index buffer', () => {
        const dome = buildDome();
        const geometry = dome.mesh.geometry;
        const positions = geometry.getAttribute('position').count;
        assert.strictEqual(geometry.getAttribute('skyColor').count, positions);
        assert.strictEqual(dome.directions.length, positions * 3);

        const index = geometry.getIndex();
        assert.ok(index, 'no index buffer');
        assert.strictEqual(index.count % 3, 0);
        for (let i = 0; i < index.count; i++) {
            assert.ok(index.getX(i) < positions, `index ${i} out of range`);
        }
    });

    it('is wound so the camera at the centre sees it, not through it', () => {
        // The one that got away. Every other check passed - the mesh reached
        // the render list, its colours were right, no shader complained - and
        // the dome was culled to the last triangle every frame, because the
        // material said BackSide while the rings are wound front-facing from
        // inside. What showed instead was the flat background clear colour,
        // which looks the same whichever way you turn: exactly the symptom of
        // a sky dome that is not there at all.
        const dome = buildDome();
        const geometry = dome.mesh.geometry;
        const position = geometry.getAttribute('position');
        const index = geometry.getIndex()!;

        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
        const normal = new THREE.Vector3(), centroid = new THREE.Vector3();
        let facing = 0;
        let away = 0;
        for (let t = 0; t < index.count; t += 3) {
            a.fromBufferAttribute(position, index.getX(t));
            b.fromBufferAttribute(position, index.getX(t + 1));
            c.fromBufferAttribute(position, index.getX(t + 2));
            normal.crossVectors(b.clone().sub(a), c.clone().sub(a));
            centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
            // Negative dot: the right-hand normal points back down the line to
            // the origin, so the triangle is front-facing from in there.
            if (normal.dot(centroid) < 0) {
                facing++;
            } else if (normal.lengthSq() > 1e-6) {
                // Ignore the degenerate slivers where the rings meet at the zenith.
                away++;
            }
        }

        assert.ok(facing > 900, `only ${facing} triangles face the camera`);
        assert.strictEqual(away, 0, `${away} triangles are wound the other way`);
        assert.strictEqual((dome.mesh.material as THREE.Material).side, THREE.FrontSide,
            'material side does not match the winding, so the dome would be culled');
    });
});

describe('paintSkyDome', () => {

    it('reproduces the authored gradient at noon, all the way round', () => {
        // Noon is the elevation every gain is a ratio against, so the dome has
        // to come out as the plain authored zenith-to-horizon ramp with no
        // azimuthal variation at all.
        const dome = buildDome();
        const colors = paintAt(dome, 12);

        const horizon = PaletteColor(HDNoonPalette, PaletteCategory.FOG_SKY).toLowerCase();
        const zenith = PaletteColor(HDNoonPalette, PaletteCategory.SKY).toLowerCase();
        for (const bearing of [0, 60, 120, 180, 240, 300]) {
            assert.strictEqual(toSrgbHex(colors, vertexAt(dome, 0, bearing)), horizon, `bearing ${bearing}`);
        }
        assert.strictEqual(toSrgbHex(colors, vertexAt(dome, 90, 0)), zenith);
    });

    it('burns the sky towards the sun and leaves the far side cool', () => {
        // The whole reason for the dome. A single sky colour had to average
        // these two together and could show neither.
        //
        // Deliberately not asserted as a monotonic fall from the sun round to
        // the anti-solar point: it is not one, and should not be. The coolest
        // part of the ring is the quarter across from the sun, and the sky
        // directly opposite lifts slightly warm again - the Belt of Venus,
        // which the model produces on its own.
        const dome = buildDome();
        const colors = paintAt(dome, 18);
        const bearing = sunBearing();

        const towards = warmth(colors, vertexAt(dome, 1, bearing));
        const across = warmth(colors, vertexAt(dome, 1, bearing + 90));
        const away = warmth(colors, vertexAt(dome, 1, bearing + 180));

        assert.ok(towards > across + 0.15, `towards ${towards} vs across ${across}`);
        assert.ok(towards > away + 0.15, `towards ${towards} vs away ${away}`);
        assert.ok(across < 0 && away < 0, `both sides should stay cool: ${across}, ${away}`);
    });

    it('leaves the far side of a sunset dimmer, not just cooler', () => {
        // Physically the horizon towards a setting sun is around eight times the
        // radiance of the horizon away from it. Earlier versions carried the hue
        // difference but flattened the brightness - at one point the far side
        // came out fractionally *brighter* - so the whole ring glowed alike.
        const dome = buildDome();
        const colors = paintAt(dome, 18);
        const bearing = sunBearing();

        const towards = luminance(colors, vertexAt(dome, 1, bearing));
        const away = luminance(colors, vertexAt(dome, 1, bearing + 180));
        assert.ok(towards > 3 * away, `towards ${towards} vs away ${away}`);
    });

    it('leaves the far side of a sunset blue, not brown', () => {
        // The sky away from a setting sun is a greyish blue: it is still lit by
        // ordinary Rayleigh scattering, just far less of it. Getting this wrong
        // was not a matter of degree. The dome used to apply the atmosphere as
        // a *ratio* against noon, and the ratio between two blues - one faded
        // more than the other - is itself strongly red, so it overwhelmed a
        // near-neutral authored horizon and painted the far side brown-plum.
        // The hue is taken absolutely now, which is why this holds.
        const dome = buildDome();
        const colors = paintAt(dome, 18);
        const bearing = sunBearing();

        for (const offset of [90, 135, 180]) {
            const i = vertexAt(dome, 1, bearing + offset);
            assert.ok(colors[i + 2] > colors[i], `${offset} deg off the sun is not blue: ${toSrgbHex(colors, i)}`);
        }
        // ...while the sun's own side stays firmly warm.
        const towards = vertexAt(dome, 1, bearing);
        assert.ok(colors[towards] > colors[towards + 2],
            `towards the sun is not warm: ${toSrgbHex(colors, towards)}`);
    });

    it('keeps the sky blue overhead at every hour the sun is up', () => {
        // The authored palettes are stylised well down from a real sky, so
        // trusting the atmosphere's own saturation turned a mid-afternoon
        // zenith vivid periwinkle. It has to stay a believable sky blue.
        const dome = buildDome();
        for (const hours of [9, 12, 15, 16, 17]) {
            const colors = paintAt(dome, hours);
            const i = vertexAt(dome, 89, 0);
            assert.ok(colors[i + 2] > colors[i], `${hours}h zenith is not blue`);
            // Saturation, as distance from neutral across the three channels.
            const total = colors[i] + colors[i + 1] + colors[i + 2];
            const spread = total > 1e-6
                ? Math.abs(colors[i] / total - 1 / 3) + Math.abs(colors[i + 2] / total - 1 / 3)
                : 0;
            assert.ok(spread < 0.35, `${hours}h zenith is over-saturated: ${toSrgbHex(colors, i)}`);
        }
    });

    it('never lets the sky duck below the authored night', () => {
        // Physics says civil twilight is darker than the midnight palette, and
        // it is right, but that palette is an artistic endpoint rather than a
        // measurement. Without a floor at it, dusk came out darker than
        // midnight and the sky brightened as night fell.
        const dome = buildDome();
        const mean = (colors: Float32Array) => {
            let total = 0;
            for (let i = 0; i < colors.length; i += 3) {
                total += luminance(colors, i);
            }
            return total / (colors.length / 3);
        };
        let previous = Infinity;
        for (const hours of [16, 17, 17.5, 18, 18.5, 19, 20, 0]) {
            const now = mean(paintAt(dome, hours));
            assert.ok(now <= previous + 1e-9, `${hours}h rose to ${now} from ${previous}`);
            previous = now;
        }
    });

    it('swings the warm lobe round with the sun', () => {
        // Sunrise and sunset put the sun on opposite horizons, so the bright
        // side of the sky has to swap ends with it.
        const dome = buildDome();

        const sunset = paintAt(dome, 18);
        const westAtSunset = warmth(sunset, vertexAt(dome, 1, -90));
        const eastAtSunset = warmth(sunset, vertexAt(dome, 1, 90));
        assert.ok(westAtSunset > eastAtSunset, 'sunset should be brightest in the west');

        const sunrise = paintAt(dome, 6);
        const westAtSunrise = warmth(sunrise, vertexAt(dome, 1, -90));
        const eastAtSunrise = warmth(sunrise, vertexAt(dome, 1, 90));
        assert.ok(eastAtSunrise > westAtSunrise, 'sunrise should be brightest in the east');
    });

    it('keeps the zenith cooler than the horizon the sun is in', () => {
        // The dome's vertical contrast has to survive the sunset, not collapse
        // onto one orange the way a uniform tint did.
        const dome = buildDome();
        const colors = paintAt(dome, 18);
        const horizon = warmth(colors, vertexAt(dome, 1, sunBearing()));
        const zenith = warmth(colors, vertexAt(dome, 90, 0));
        assert.ok(horizon > zenith + 0.2, `horizon ${horizon} vs zenith ${zenith}`);
    });

    it('stays in gamut and finite at every hour', () => {
        const dome = buildDome();
        for (let hours = 0; hours < 24; hours += 0.5) {
            const colors = paintAt(dome, hours);
            for (let i = 0; i < colors.length; i++) {
                assert.ok(Number.isFinite(colors[i]) && colors[i] >= 0 && colors[i] <= 1,
                    `${hours}h vertex channel ${i} = ${colors[i]}`);
            }
        }
    });

});
