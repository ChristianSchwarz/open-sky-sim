/**
 * Atmospheric scattering: what the sky actually radiates, for a given sun.
 *
 * A single-scattering ray march through a spherical, layered atmosphere, with a
 * multiple-scattering term folded in and the ground acting as a secondary
 * source. Rayleigh and Mie are carried separately - they have different
 * densities, different height falloffs and, crucially, different phase
 * functions, which is what makes the sky blue away from the sun and white
 * around it at the same moment.
 *
 * This runs on the CPU, not per pixel. It is asked for a handful of directions
 * whenever the time of day changes, and its answers become palette colours and
 * light uniforms (see skyModel.ts). That is why it marches directly rather than
 * baking the usual transmittance / multiscatter LUTs: at this call rate the
 * marches are cheaper than the tables would be, and they keep full precision
 * near the horizon, which is exactly where a coarsely-sampled LUT goes wrong
 * and exactly the direction a sunset is made of.
 *
 * Coefficients are the standard Earth set (Bruneton & Neyret; Hillaire 2020),
 * in units of 1/m, already reduced to RGB at roughly 680 / 550 / 440 nm.
 */

export type Rgb = [number, number, number];
type Vec3 = [number, number, number];

export interface AtmosphereParams {
    /** Sea level, metres from the planet centre. */
    groundRadius: number;
    /** Top of the atmosphere, metres from the planet centre. */
    topRadius: number;
    /**
     * Rayleigh scattering at sea level, per metre, per channel.
     *
     * The lambda^-4 wavelength dependence is already in these three numbers:
     * blue scatters 5.7x as strongly as red, which is the whole reason the sky
     * is blue overhead and the sun is red through a long path.
     */
    rayleighScattering: Rgb;
    /** Rayleigh density falls off exponentially with this scale height (m). */
    rayleighScaleHeight: number;
    /**
     * Mie scattering at sea level, per metre. Grey on purpose: aerosols are
     * large compared with the wavelength, so they scatter every channel alike,
     * which is what makes their haze white rather than coloured.
     */
    mieScattering: number;
    /** Mie extinction = scattering + absorption; aerosols absorb a little. */
    mieExtinction: number;
    mieScaleHeight: number;
    /**
     * Mie phase asymmetry, 0..1. High values throw most of the light forward,
     * which is the bright washed-out halo you see looking towards a low sun.
     */
    mieG: number;
    /**
     * Ozone absorption at the layer peak, per metre, per channel. It scatters
     * nothing and only absorbs, mostly in the green-yellow, and it is what
     * keeps a twilight sky blue instead of letting it slide through grey into
     * brown - the long horizon paths cross the layer twice.
     */
    ozoneAbsorption: Rgb;
    /** Ozone is a tent, not an exponential: peak altitude and half-width (m). */
    ozoneCentre: number;
    ozoneHalfWidth: number;
    /**
     * Ground reflectance. Light that reaches the surface bounces back up and
     * scatters again, so the ground is a secondary source lighting the sky.
     * ~0.2 is a reasonable ocean-and-arid-island average.
     */
    groundAlbedo: Rgb;
}

/**
 * Aerosol load, as a multiple of the clean-air Mie coefficients.
 *
 * The textbook figures describe an exceptionally clear day, and a clear day is
 * not what a memorable sunset looks like. Haze scatters every wavelength alike,
 * so what it spreads around a low sun is the beam's own deep orange - which is
 * what turns the aureole gold, widens it, and roughly doubles its brightness.
 * Left at 1 the sky beside the sun came out pink, because with so little
 * aerosol the Rayleigh blue still outweighs what little green survives the
 * path, and the sun sat on it as an obvious sticker.
 *
 * Around 5 is a hazy maritime atmosphere, which is what this sim flies over.
 * It costs nothing at midday: every gain in skyModel.ts is a ratio against a
 * reference sampled from this same atmosphere, so noon reproduces the authored
 * palette whatever this is set to. What it changes is the journey.
 */
const TURBIDITY = 5;

export const EARTH_ATMOSPHERE: AtmosphereParams = {
    groundRadius: 6_360_000,
    topRadius: 6_420_000,
    rayleighScattering: [5.802e-6, 13.558e-6, 33.1e-6],
    rayleighScaleHeight: 8_000,
    mieScattering: 3.996e-6 * TURBIDITY,
    mieExtinction: 4.40e-6 * TURBIDITY,
    mieScaleHeight: 1_200,
    mieG: 0.8,
    ozoneAbsorption: [0.650e-6, 1.881e-6, 0.085e-6],
    ozoneCentre: 25_000,
    ozoneHalfWidth: 15_000,
    groundAlbedo: [0.2, 0.2, 0.2],
};

/**
 * Step counts. Everything here is a low-frequency quantity sampled a few dozen
 * times per time-of-day change, so these are set for a clean answer rather than
 * for a frame budget; the whole sample lands well under a millisecond.
 */
const VIEW_STEPS = 32;
const SUN_STEPS = 16;
/** Multiple scattering is smooth in every argument, so it can be cruder. */
const MS_ALTITUDE_BINS = 6;
const MS_DIRECTIONS = 24;
const MS_STEPS = 10;
const MS_SUN_STEPS = 8;
/** Hemisphere samples for the sky's own irradiance on a flat surface. */
const IRRADIANCE_DIRECTIONS = 32;

const FOUR_PI = 4 * Math.PI;

function dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lengthOf(v: Vec3): number {
    return Math.sqrt(dot(v, v));
}

/**
 * Self-intersection guard, in metres. A ray leaving a point that sits exactly
 * on a sphere solves that sphere at t = 0, so without this a viewer at sea
 * level reads as occluded by the ground in every direction, including straight
 * up, and the whole sky comes back black.
 */
const RAY_EPSILON = 1e-3;

/**
 * Nearest t greater than {@link RAY_EPSILON} with |origin + t * dir| == radius,
 * or -1 when the ray misses. `dir` must be normalised.
 */
function raySphere(origin: Vec3, dir: Vec3, radius: number): number {
    const b = dot(origin, dir);
    const c = dot(origin, origin) - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) {
        return -1;
    }
    const root = Math.sqrt(discriminant);
    const near = -b - root;
    if (near > RAY_EPSILON) {
        return near;
    }
    const far = -b + root;
    return far > RAY_EPSILON ? far : -1;
}

/** Densities at `altitude` (m), relative to their sea-level / peak values. */
function densities(params: AtmosphereParams, altitude: number): [number, number, number] {
    const h = Math.max(altitude, 0);
    const rayleigh = Math.exp(-h / params.rayleighScaleHeight);
    const mie = Math.exp(-h / params.mieScaleHeight);
    const ozone = Math.max(0, 1 - Math.abs(h - params.ozoneCentre) / params.ozoneHalfWidth);
    return [rayleigh, mie, ozone];
}

/**
 * Total extinction at `altitude`, per metre, per channel: everything that takes
 * light out of a beam, whether by scattering it elsewhere or absorbing it.
 */
function extinction(params: AtmosphereParams, altitude: number, out: Rgb): Rgb {
    const [rayleigh, mie, ozone] = densities(params, altitude);
    for (let i = 0; i < 3; i++) {
        out[i] = params.rayleighScattering[i] * rayleigh
            + params.mieExtinction * mie
            + params.ozoneAbsorption[i] * ozone;
    }
    return out;
}

const scratchExtinction: Rgb = [0, 0, 0];

/**
 * Beer-Lambert transmittance along `distance` metres of `dir` from `origin`:
 * exp(-optical depth), integrated with the midpoint rule.
 */
function transmittance(params: AtmosphereParams, origin: Vec3, dir: Vec3, distance: number, steps: number): Rgb {
    const dt = distance / steps;
    let depthR = 0;
    let depthG = 0;
    let depthB = 0;
    for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * dt;
        const altitude = lengthOf([
            origin[0] + dir[0] * t,
            origin[1] + dir[1] * t,
            origin[2] + dir[2] * t,
        ]) - params.groundRadius;
        extinction(params, altitude, scratchExtinction);
        depthR += scratchExtinction[0] * dt;
        depthG += scratchExtinction[1] * dt;
        depthB += scratchExtinction[2] * dt;
    }
    return [Math.exp(-depthR), Math.exp(-depthG), Math.exp(-depthB)];
}

/**
 * Transmittance from `position` to the top of the atmosphere along `sunDir`,
 * or black when the planet itself is in the way.
 *
 * That occlusion test is what puts the earth's shadow into the sky: after
 * sunset the low air along the horizon is already in darkness while the air
 * overhead is still lit, which is the blue hour rather than an arbitrary tint.
 */
export function sunTransmittance(
    params: AtmosphereParams, position: Vec3, sunDir: Vec3, steps: number = SUN_STEPS,
): Rgb {
    if (raySphere(position, sunDir, params.groundRadius) >= 0) {
        return [0, 0, 0];
    }
    const toTop = raySphere(position, sunDir, params.topRadius);
    if (toTop < 0) {
        return [1, 1, 1];
    }
    return transmittance(params, position, sunDir, toTop, steps);
}

/**
 * Rayleigh phase: symmetric forwards and backwards, with a shallow minimum
 * across the sky at 90 degrees from the sun. This is the term responsible for
 * the deep blue on the side away from the sun.
 */
export function rayleighPhase(cosTheta: number): number {
    return 3 / (16 * Math.PI) * (1 + cosTheta * cosTheta);
}

/**
 * Mie phase, Cornette-Shanks: the Henyey-Greenstein lobe with the Rayleigh-like
 * (1 + cos^2) correction, which keeps it well-behaved away from the forward
 * direction while preserving the sharp forward spike HG is used for. At g = 0.8
 * it puts an order of magnitude more light within a few degrees of the sun than
 * anywhere else, which draws the halo.
 */
export function miePhase(cosTheta: number, g: number): number {
    const gg = g * g;
    const denominator = Math.pow(Math.max(1e-6, 1 + gg - 2 * g * cosTheta), 1.5);
    return 3 * (1 - gg) * (1 + cosTheta * cosTheta)
        / (8 * Math.PI * (2 + gg) * denominator);
}

/**
 * `count` roughly-even directions on the unit sphere, by the Fibonacci spiral.
 * Deterministic, which matters: a stochastic set would make the same sun render
 * a slightly different sky each time it was asked.
 */
function sphereDirections(count: number): Vec3[] {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const out: Vec3[] = [];
    for (let i = 0; i < count; i++) {
        const y = 1 - (2 * i + 1) / count;
        const radius = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        out.push([Math.cos(theta) * radius, y, Math.sin(theta) * radius]);
    }
    return out;
}

/** The upper half of {@link sphereDirections}, for hemisphere integrals. */
function hemisphereDirections(count: number): Vec3[] {
    return sphereDirections(2 * count).filter(d => d[1] > 0);
}

/**
 * Multiple scattering, per altitude bin, for one sun direction.
 *
 * Single scattering alone leaves the sky black wherever the sun does not reach
 * directly - shadowed air, and the whole dome after sunset. Real air is lit by
 * light that has already bounced, so this estimates that.
 *
 * The method is Hillaire's: march the sphere of directions with an *isotropic*
 * phase function to get both the second-order radiance arriving at the point
 * and `fms`, the fraction of light the air around it scatters back. Orders
 * three and up are then the same bounce again and again, so their sum is the
 * geometric series 1 / (1 - fms). Treating the higher orders as isotropic is
 * the approximation, and it is a good one: by the second bounce the light has
 * lost nearly all memory of the direction it came from.
 */
export function multipleScatteringTable(params: AtmosphereParams, sunDir: Vec3): Rgb[] {
    const directions = sphereDirections(MS_DIRECTIONS);
    const topAltitude = params.topRadius - params.groundRadius;
    const table: Rgb[] = [];

    for (let bin = 0; bin < MS_ALTITUDE_BINS; bin++) {
        const altitude = topAltitude * bin / (MS_ALTITUDE_BINS - 1);
        const origin: Vec3 = [0, params.groundRadius + altitude, 0];

        const second: Rgb = [0, 0, 0];
        const fms: Rgb = [0, 0, 0];

        for (const dir of directions) {
            const ground = raySphere(origin, dir, params.groundRadius);
            const top = raySphere(origin, dir, params.topRadius);
            const distance = ground >= 0 ? ground : top;
            if (distance <= 0) {
                continue;
            }
            const dt = distance / MS_STEPS;
            let viewR = 1;
            let viewG = 1;
            let viewB = 1;

            for (let step = 0; step < MS_STEPS; step++) {
                const t = (step + 0.5) * dt;
                const sample: Vec3 = [
                    origin[0] + dir[0] * t,
                    origin[1] + dir[1] * t,
                    origin[2] + dir[2] * t,
                ];
                const sampleAltitude = lengthOf(sample) - params.groundRadius;
                const [rayleighDensity, mieDensity] = densities(params, sampleAltitude);
                const sun = sunTransmittance(params, sample, sunDir, MS_SUN_STEPS);
                extinction(params, sampleAltitude, scratchExtinction);

                for (let c = 0; c < 3; c++) {
                    const scattering = params.rayleighScattering[c] * rayleighDensity
                        + params.mieScattering * mieDensity;
                    const view = c === 0 ? viewR : c === 1 ? viewG : viewB;
                    // Isotropic phase: 1 / 4pi in every direction.
                    second[c] += view * scattering * sun[c] / FOUR_PI * dt;
                    fms[c] += view * scattering / FOUR_PI * dt;
                }

                viewR *= Math.exp(-scratchExtinction[0] * dt);
                viewG *= Math.exp(-scratchExtinction[1] * dt);
                viewB *= Math.exp(-scratchExtinction[2] * dt);
            }

            // Ground albedo: what the surface bounces back up is a source for
            // the air above it, so the sky over bright ground is brighter.
            if (ground >= 0) {
                const hit: Vec3 = [
                    origin[0] + dir[0] * ground,
                    origin[1] + dir[1] * ground,
                    origin[2] + dir[2] * ground,
                ];
                const normal: Vec3 = [hit[0], hit[1], hit[2]];
                const inverse = 1 / lengthOf(normal);
                normal[0] *= inverse; normal[1] *= inverse; normal[2] *= inverse;
                const cosSun = Math.max(0, dot(normal, sunDir));
                if (cosSun > 0) {
                    const sun = sunTransmittance(params, hit, sunDir, MS_SUN_STEPS);
                    for (let c = 0; c < 3; c++) {
                        const view = c === 0 ? viewR : c === 1 ? viewG : viewB;
                        second[c] += view * params.groundAlbedo[c] / Math.PI * cosSun * sun[c];
                    }
                }
            }
        }

        const weight = FOUR_PI / directions.length;
        const psi: Rgb = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const l2 = second[c] * weight / FOUR_PI;
            const f = Math.min(0.95, fms[c] * weight / FOUR_PI);
            psi[c] = l2 / (1 - f);
        }
        table.push(psi);
    }
    return table;
}

/** Linear lookup into {@link multipleScatteringTable}'s altitude bins. */
function multipleScatteringAt(table: Rgb[], params: AtmosphereParams, altitude: number, out: Rgb): Rgb {
    const topAltitude = params.topRadius - params.groundRadius;
    const position = Math.min(1, Math.max(0, altitude / topAltitude)) * (table.length - 1);
    const low = Math.floor(position);
    const high = Math.min(table.length - 1, low + 1);
    const blend = position - low;
    for (let c = 0; c < 3; c++) {
        out[c] = table[low][c] + (table[high][c] - table[low][c]) * blend;
    }
    return out;
}

const scratchMs: Rgb = [0, 0, 0];

/**
 * Radiance arriving from `viewDir` at a viewer `altitude` metres up, with the
 * sun at `sunDir`. Units are relative to a solar irradiance of 1.
 *
 * The march accumulates, at each step: the light the sun still delivers there
 * (its transmittance down the sun ray), scattered towards the viewer by the
 * two phase functions, plus the multiple-scattering term, all attenuated by the
 * transmittance back along the view ray.
 */
export function skyRadiance(
    params: AtmosphereParams, altitude: number, viewDir: Vec3, sunDir: Vec3,
    msTable: Rgb[] = multipleScatteringTable(params, sunDir),
): Rgb {
    const origin: Vec3 = [0, params.groundRadius + altitude, 0];
    const ground = raySphere(origin, viewDir, params.groundRadius);
    const top = raySphere(origin, viewDir, params.topRadius);
    const distance = ground >= 0 ? ground : top;
    if (distance <= 0) {
        return [0, 0, 0];
    }

    const cosTheta = dot(viewDir, sunDir);
    const rayleighWeight = rayleighPhase(cosTheta);
    const mieWeight = miePhase(cosTheta, params.mieG);

    const dt = distance / VIEW_STEPS;
    const radiance: Rgb = [0, 0, 0];
    const view: Rgb = [1, 1, 1];

    for (let step = 0; step < VIEW_STEPS; step++) {
        const t = (step + 0.5) * dt;
        const sample: Vec3 = [
            origin[0] + viewDir[0] * t,
            origin[1] + viewDir[1] * t,
            origin[2] + viewDir[2] * t,
        ];
        const sampleAltitude = lengthOf(sample) - params.groundRadius;
        const [rayleighDensity, mieDensity] = densities(params, sampleAltitude);
        const sun = sunTransmittance(params, sample, sunDir);
        multipleScatteringAt(msTable, params, sampleAltitude, scratchMs);
        extinction(params, sampleAltitude, scratchExtinction);

        for (let c = 0; c < 3; c++) {
            const rayleigh = params.rayleighScattering[c] * rayleighDensity;
            const mie = params.mieScattering * mieDensity;
            const single = (rayleigh * rayleighWeight + mie * mieWeight) * sun[c];
            const multiple = (rayleigh + mie) * scratchMs[c];
            radiance[c] += view[c] * (single + multiple) * dt;
            view[c] *= Math.exp(-scratchExtinction[c] * dt);
        }
    }

    return radiance;
}

/** Everything the renderer wants to know about the sky for one sun position. */
export interface AtmosphereSample {
    /** Radiance looking straight up. */
    zenith: Rgb;
    /** Radiance just above the horizon, on the sun's side. */
    horizonSunward: Rgb;
    /** Radiance just above the horizon, opposite the sun. */
    horizonOpposite: Rgb;
    /** What is left of the solar beam by the time it reaches the viewer. */
    sunDisc: Rgb;
    /**
     * The sky a few degrees off the sun - the aureole the disc sits in.
     *
     * Scattered light, not the beam, and the two are not the same colour: the
     * beam is what survives a long path (deep red, almost no blue left), while
     * the sky beside it is what that path scattered *out* (red, but with the
     * blue put back by Rayleigh and the green eaten by ozone). Colouring the
     * disc by the beam put an orange sun on a pink sky with a visible seam
     * where the two met.
     */
    sunward: Rgb;
    /** Irradiance on a surface square to the sun: the direct light's colour. */
    directIrradiance: Rgb;
    /** Irradiance the sky alone puts on a flat surface: the fill in shadow. */
    skyIrradiance: Rgb;
}

/** How far off the sun the aureole is sampled, in degrees. */
const SUNWARD_SAMPLE_ANGLE_DEG = 5;

/** Elevation, in degrees, of the ring sampled as "the horizon". */
const HORIZON_SAMPLE_ELEVATION_DEG = 0.5;
const DEG2RAD = Math.PI / 180;

/** A direction at `elevationDeg` above the horizon, in the sun's plane. */
function inSunPlane(elevationDeg: number, sunward: boolean): Vec3 {
    const a = elevationDeg * DEG2RAD;
    return [Math.cos(a) * (sunward ? 1 : -1), Math.sin(a), 0];
}

/**
 * Samples the atmosphere for a sun at `sunElevationDeg`.
 *
 * The sun is placed in the XZ=0 plane; the model is radially symmetric, so only
 * the angle between a view direction and the sun matters and the sun's compass
 * bearing never enters. Callers rotate the answers into place themselves.
 */
export function sampleAtmosphere(
    sunElevationDeg: number,
    altitude: number = 0,
    params: AtmosphereParams = EARTH_ATMOSPHERE,
): AtmosphereSample {
    const sunAngle = sunElevationDeg * DEG2RAD;
    const sunDir: Vec3 = [Math.cos(sunAngle), Math.sin(sunAngle), 0];
    const msTable = multipleScatteringTable(params, sunDir);
    const origin: Vec3 = [0, params.groundRadius + altitude, 0];

    const sky = (dir: Vec3) => skyRadiance(params, altitude, dir, sunDir, msTable);

    const sunDisc = sunTransmittance(params, origin, sunDir);
    // Just above the sun, so it stays sky even with the disc on the horizon.
    const sunwardAngle = (sunElevationDeg + SUNWARD_SAMPLE_ANGLE_DEG) * DEG2RAD;

    const skyIrradiance: Rgb = [0, 0, 0];
    const hemisphere = hemisphereDirections(IRRADIANCE_DIRECTIONS);
    for (const dir of hemisphere) {
        const radiance = sky(dir);
        // Cosine-weighted, and 2pi/N for the solid angle each sample stands for.
        const cosine = dir[1];
        for (let c = 0; c < 3; c++) {
            skyIrradiance[c] += radiance[c] * cosine;
        }
    }
    const solidAngle = 2 * Math.PI / hemisphere.length;
    for (let c = 0; c < 3; c++) {
        skyIrradiance[c] *= solidAngle;
    }

    return {
        zenith: sky([0, 1, 0]),
        horizonSunward: sky(inSunPlane(HORIZON_SAMPLE_ELEVATION_DEG, true)),
        horizonOpposite: sky(inSunPlane(HORIZON_SAMPLE_ELEVATION_DEG, false)),
        sunDisc,
        sunward: sky([Math.cos(sunwardAngle), Math.sin(sunwardAngle), 0]),
        // Irradiance on a surface square to the beam is just what survives the
        // path; the N.L cosine is the shaded ramp's job, not the atmosphere's.
        directIrradiance: sunDisc,
        skyIrradiance,
    };
}
