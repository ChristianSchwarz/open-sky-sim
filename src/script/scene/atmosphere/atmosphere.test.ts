import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
    EARTH_ATMOSPHERE, miePhase, rayleighPhase, Rgb, sampleAtmosphere, skyRadiance,
    sunTransmittance,
} from './atmosphere';

const luminance = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** Fraction of a colour's total energy in each channel. */
function chroma(c: Rgb): Rgb {
    const total = c[0] + c[1] + c[2];
    return total > 0 ? [c[0] / total, c[1] / total, c[2] / total] : [0, 0, 0];
}

describe('Rayleigh scattering', () => {

    it('scatters blue far harder than red', () => {
        // The lambda^-4 law, as it reaches the model: the three coefficients.
        const [r, , b] = EARTH_ATMOSPHERE.rayleighScattering;
        assert.ok(b / r > 5 && b / r < 6, `blue/red is ${b / r}`);
    });

    it('makes the zenith blue with the sun high', () => {
        const [r, g, b] = chroma(sampleAtmosphere(60).zenith);
        assert.ok(b > 0.6, `blue fraction ${b}`);
        assert.ok(b > g && g > r, `not blue-dominant: ${r}/${g}/${b}`);
    });

    it('has a phase function symmetric front to back', () => {
        assert.ok(Math.abs(rayleighPhase(1) - rayleighPhase(-1)) < 1e-12);
        // ...with its minimum across the sky at 90 degrees from the sun.
        assert.ok(rayleighPhase(0) < rayleighPhase(1));
        assert.ok(rayleighPhase(0) < rayleighPhase(-1));
    });

    it('integrates to 1 over the sphere', () => {
        // A phase function redistributes light; it must not create any.
        let total = 0;
        const steps = 2000;
        for (let i = 0; i < steps; i++) {
            const theta = Math.PI * (i + 0.5) / steps;
            total += rayleighPhase(Math.cos(theta)) * Math.sin(theta) * (Math.PI / steps);
        }
        assert.ok(Math.abs(2 * Math.PI * total - 1) < 1e-3, `${2 * Math.PI * total}`);
    });
});

describe('Mie scattering', () => {

    it('throws light forward, hard', () => {
        const g = EARTH_ATMOSPHERE.mieG;
        assert.ok(miePhase(1, g) > 30 * miePhase(0, g), 'forward vs sideways');
        assert.ok(miePhase(1, g) > miePhase(-1, g), 'forward vs back');
    });

    it('collapses to the Rayleigh phase with no asymmetry', () => {
        // Cornette-Shanks, not plain Henyey-Greenstein: it carries the same
        // (1 + cos^2) term Rayleigh does, so g = 0 lands exactly on Rayleigh
        // rather than on the 1/4pi a bare HG lobe would give. That term is
        // why it stays well-behaved away from the forward spike, which is the
        // reason to prefer it here.
        for (const cosTheta of [-1, -0.3, 0, 0.5, 1]) {
            assert.ok(Math.abs(miePhase(cosTheta, 0) - rayleighPhase(cosTheta)) < 1e-12, `${cosTheta}`);
        }
    });

    it('integrates to 1 over the sphere', () => {
        let total = 0;
        const steps = 20000;
        for (let i = 0; i < steps; i++) {
            const theta = Math.PI * (i + 0.5) / steps;
            total += miePhase(Math.cos(theta), EARTH_ATMOSPHERE.mieG) * Math.sin(theta) * (Math.PI / steps);
        }
        assert.ok(Math.abs(2 * Math.PI * total - 1) < 1e-2, `${2 * Math.PI * total}`);
    });

    it('whitens the sky around the sun', () => {
        // Aerosols are wavelength-independent, so where their forward lobe
        // dominates the sky loses the blue cast Rayleigh gives it everywhere
        // else. That is the washed-out aureole, and it is why the sun's corona
        // is drawn in the sun's own colour rather than a hue of its own.
        //
        // Sampled the way the dome samples it - a direction a few degrees off
        // the sun - rather than through a dedicated field on AtmosphereSample,
        // which nothing but this test was left reading.
        const elevation = 30 * Math.PI / 180;
        const sunDir: [number, number, number] = [Math.cos(elevation), Math.sin(elevation), 0];
        const offset = (30 + 6) * Math.PI / 180;

        const halo = chroma(skyRadiance(
            EARTH_ATMOSPHERE, 0, [Math.cos(offset), Math.sin(offset), 0], sunDir));
        const zenith = chroma(skyRadiance(EARTH_ATMOSPHERE, 0, [0, 1, 0], sunDir));

        assert.ok(halo[2] < zenith[2], `halo blue ${halo[2]} vs zenith ${zenith[2]}`);
        assert.ok(halo[0] > zenith[0], `halo red ${halo[0]} vs zenith ${zenith[0]}`);
    });
});

describe('extinction and transmittance', () => {

    it('reddens the beam as the path lengthens', () => {
        // Beer-Lambert against a lambda^-4 coefficient: the low sun loses its
        // blue first, then its green, which is the whole reason a sunset is red.
        const high = chroma(sampleAtmosphere(60).sunDisc);
        const low = chroma(sampleAtmosphere(2).sunDisc);
        assert.ok(low[0] > high[0], `red fraction ${low[0]} vs ${high[0]}`);
        assert.ok(low[2] < high[2], `blue fraction ${low[2]} vs ${high[2]}`);
        assert.ok(low[0] > 0.6, `not red enough: ${low[0]}`);
    });

    it('attenuates monotonically as the sun drops', () => {
        let previous = Infinity;
        for (const elevation of [80, 60, 40, 20, 10, 5, 2, 0.5]) {
            const now = luminance(sampleAtmosphere(elevation).sunDisc);
            assert.ok(now < previous, `${elevation} deg: ${now} vs ${previous}`);
            previous = now;
        }
    });

    it('never gains energy along a path', () => {
        const params = EARTH_ATMOSPHERE;
        for (const elevation of [90, 45, 10, 1]) {
            const angle = elevation * Math.PI / 180;
            const t = sunTransmittance(
                params, [0, params.groundRadius, 0], [Math.cos(angle), Math.sin(angle), 0]);
            for (const channel of t) {
                assert.ok(channel > 0 && channel <= 1, `${elevation} deg: ${channel}`);
            }
        }
    });

    it('blocks the beam once the planet is in the way', () => {
        const params = EARTH_ATMOSPHERE;
        const below = sunTransmittance(params, [0, params.groundRadius, 0], [Math.cos(-0.2), Math.sin(-0.2), 0]);
        assert.deepStrictEqual(below, [0, 0, 0]);
    });
});

describe('multiple scattering', () => {

    it('keeps the sky lit where the sun does not reach directly', () => {
        // With the sun under the horizon nothing at ground level is in direct
        // sunlight at all. Single scattering alone would leave the dome black;
        // what is actually there is light that has already bounced.
        const dusk = sampleAtmosphere(-3);
        assert.ok(luminance(dusk.zenith) > 0, 'zenith went black at dusk');
        assert.ok(luminance(dusk.skyIrradiance) > 0, 'no fill light left at dusk');
    });

    it('adds light rather than removing it', () => {
        // A brighter ground bounces more back up, so the sky over it is
        // brighter - never darker.
        const dark = sampleAtmosphere(30, 0, { ...EARTH_ATMOSPHERE, groundAlbedo: [0, 0, 0] });
        const bright = sampleAtmosphere(30, 0, { ...EARTH_ATMOSPHERE, groundAlbedo: [0.8, 0.8, 0.8] });
        assert.ok(luminance(bright.zenith) > luminance(dark.zenith), 'albedo did not brighten the zenith');
        assert.ok(luminance(bright.skyIrradiance) > luminance(dark.skyIrradiance));
    });
});

describe('sampleAtmosphere', () => {

    it('leaves the sky bluer away from the sun than towards it', () => {
        // The spec's two halves at once: Rayleigh keeps the anti-solar side
        // deep blue while Mie forward-scattering washes the solar side out.
        for (const elevation of [10, 2, 0, -4]) {
            const sample = sampleAtmosphere(elevation);
            const sunward = chroma(sample.horizonSunward);
            const opposite = chroma(sample.horizonOpposite);
            assert.ok(opposite[2] > sunward[2],
                `${elevation} deg: opposite blue ${opposite[2]} vs sunward ${sunward[2]}`);
        }
    });

    it('darkens the whole sky as the sun sets', () => {
        let previous = Infinity;
        for (const elevation of [60, 30, 10, 2, 0, -3, -6, -10]) {
            const now = luminance(sampleAtmosphere(elevation).zenith);
            assert.ok(now < previous, `${elevation} deg: ${now} vs ${previous}`);
            previous = now;
        }
    });

    it('gives every channel a finite, non-negative radiance', () => {
        for (const elevation of [90, 45, 0, -10, -30, -90]) {
            const sample = sampleAtmosphere(elevation);
            for (const [name, value] of Object.entries(sample)) {
                if (typeof value === 'number') {
                    continue;
                }
                for (const channel of value as Rgb) {
                    assert.ok(Number.isFinite(channel) && channel >= 0,
                        `${elevation} deg, ${name}: ${channel}`);
                }
            }
        }
    });

    it('is deterministic', () => {
        // The direction sets are a Fibonacci spiral, not a random draw: the
        // same sun has to produce the same sky every time it is asked.
        assert.deepStrictEqual(sampleAtmosphere(7), sampleAtmosphere(7));
    });
});
