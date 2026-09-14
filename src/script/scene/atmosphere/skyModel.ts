import {
    AtmosphereSample, EARTH_ATMOSPHERE, multipleScatteringTable, Rgb, sampleAtmosphere, skyRadiance,
} from './atmosphere';

/**
 * Turns the atmosphere's radiances into the handful of numbers the retro
 * renderer can actually use.
 *
 * The pipeline this feeds is a flat-shaded, palette-driven, 320x200 one: a
 * single sky billboard fogged towards a single horizon colour, two authored
 * palettes, and an ordered dither. It cannot show a per-pixel sky. What it can
 * show is *which* colours those slots hold, and that is what the atmosphere
 * decides here.
 *
 * The split of responsibility is deliberate:
 *
 * - The authored noon palette stays the artistic anchor: it is the look with
 *   the sun high, exactly as drawn.
 * - The atmosphere owns everything that *changes* as the sun moves. Each slot
 *   is scaled by the ratio of its own radiance now to its radiance at noon, so
 *   what lands in the palette is the physical change applied to the authored
 *   colour rather than a hand-picked tint.
 *
 * That is why the gains below are ratios and not absolute radiances: mapping
 * ~1e-2 W/sr of real sky radiance onto a 90s palette would need an exposure
 * curve and a tone mapper, and would throw away the authored look in the
 * process. A ratio needs neither and keeps noon pixel-identical.
 */

/**
 * Sun elevation the palettes are taken to have been authored against.
 *
 * Local solar noon at the modelled latitude, which for an equinox declination
 * is just 90 - latitude: 61 degrees at the ~29N of shaders/sun.ts. It has to be
 * exactly that, not merely near it, because it is what makes every gain come
 * out at 1 at midday and so keeps the authored noon palette reproduced to the
 * byte. sun.test.ts holds the two in step.
 */
export const REFERENCE_SUN_ELEVATION_DEG = 61;

/**
 * Elevation quantum for the sample cache, in degrees. A sample costs a couple
 * of milliseconds and the sky changes smoothly, so this keeps the sun slider
 * responsive without anyone seeing the steps: a quarter of a degree is about a
 * minute of solar motion.
 */
const CACHE_QUANTUM_DEG = 0.25;

/**
 * Decades of zenith-luminance falloff below noon that count as full night.
 *
 * The palette crossover used to be a hand-drawn ramp in elevation. It is the
 * atmosphere's own falloff now: sky luminance drops roughly exponentially as
 * the sun sinks, so the natural measure is orders of magnitude, and ~6 of them
 * is where what is left stops reading as sky at all. That lands the halfway
 * point around 5 degrees below the horizon - civil twilight, which is when
 * street lighting really does come on.
 */
const NIGHT_DECADES = 7.5;

/**
 * How far a slot's *brightness* may move, relative to the frame as a whole.
 *
 * The physical numbers here are enormous: the horizon looking towards a low sun
 * is genuinely three times its noon radiance. The authored palette has nowhere
 * to put that - #c8e4f8 is already all but white - so applying it raw clipped
 * the whole afternoon horizon to #ffffff.
 *
 * The hue is taken from physics in full, because that is what a sunset reads
 * as and the palette has plenty of room for it. Only the brightness is bounded,
 * and it is bounded per slot: the sky has almost no headroom left, the ground
 * has a great deal, and the ground genuinely does fall away far faster than the
 * sky at dusk once the cosine on a near-flat surface takes hold.
 */
const SKY_BRIGHTNESS_RANGE: [number, number] = [0.75, 1.15];
/**
 * The dome's own, far wider range.
 *
 * A slot has to hold for the whole sky at once, so it can only ever carry the
 * average and has nowhere to put a big swing. A dome vertex answers for one
 * direction, and the swing across directions is the entire point: at sunset the
 * horizon towards the sun is genuinely eight times the radiance of the horizon
 * away from it. Squeezing that into the slots' 1.5x left the far side of the
 * sky glowing just as hard as the near side.
 *
 * The ceiling sits near 1 rather than above it because the authored horizon is
 * a pale noon haze with no headroom left. A sunset that tried to be *brighter*
 * than it had to spend its saturation getting back into gamut and came out
 * washed pink; letting the whole ring darken from there instead leaves the
 * room a saturated orange needs.
 */
/**
 * The disc, and the corona that is the same light spread around it.
 *
 * Floored high: the sun is the light source, and it has to read as one. Allowed
 * to dim like everything else it came out at 1.5x the sky beside it, which
 * after the tone curve meant both clipped together and the sun was a pale blob
 * pasted on the haze. It is dimmer at sunset in absolute terms - that is why
 * you can look at it - but never dim *relative to the sky it is lighting*.
 */
const SUN_BRIGHTNESS_RANGE: [number, number] = [0.85, 1.5];

/**
 * Cloud decks, which need to fall much further than the sky behind them.
 *
 * A cloud is lit by the beam plus the sky, and at sunset the beam has all but
 * gone - so a deck goes from the brightest thing in the frame at noon to
 * something the sun picks out in colour rather than in brightness. Held to the
 * sky's own narrow range they stayed near white, blew straight through the top
 * of the tone curve, and arrived as daylight cotton wool pasted onto a sunset.
 */
const CLOUD_BRIGHTNESS_RANGE: [number, number] = [0.22, 1.15];
/**
 * Lit surfaces. The floor is low because backlit land really is that dark:
 * with the sun on the horizon the cosine on near-flat ground goes to nothing
 * and all that is left is skylight, about a seventh of what the sky itself
 * still radiates. Floored at 0.4 the land came out five times too bright
 * against the sky, and no tone curve can rescue a range that is already
 * collapsed - measured against a photograph the whole scene spanned 5.6x where
 * the real thing spans 43x.
 */
const GROUND_BRIGHTNESS_RANGE: [number, number] = [0.12, 1.25];

/**
 * The dome's own range, split in two.
 *
 * A slot has to hold for the whole sky at once, so it can only ever carry the
 * average and has nowhere to put a big swing. A dome vertex answers for one
 * direction, and the swing across directions is the entire point: at sunset the
 * horizon towards the sun is genuinely eight times the radiance of the horizon
 * away from it.
 */
/**
 * How far a dome vertex may depart from its authored brightness.
 *
 * The ceiling is exactly 1: no direction may ask to be brighter than the
 * authored sky. Towards a sun still well up the real sky *is* brighter than the
 * noon horizon, but the authored horizon is a pale near-white with nothing
 * above it, so a request to exceed it could only be met by spending saturation
 * on the gamut fit - which arrived, repeatedly, as a white patch at the sun's
 * bearing. Capped, that direction simply sits at full and everything else falls
 * away below it, which is the same picture and one the palette can hold.
 *
 * The floor is very low so twilight keeps its ordering: by civil twilight the
 * sky towards the sun is still many times the sky away from it, and a floor
 * anywhere near the daytime range clamped both to the same value and left the
 * ring flat exactly where it should have been at its most lopsided.
 *
 * Between the two the ratio is used raw, against the same direction at noon and
 * nothing else. Three normalising statistics were tried in here first - the
 * dome's mean, its peak, then a high percentile - and each one traded the
 * sunset away to keep the daylight in gamut. They were all answering a question
 * the ceiling answers on its own.
 */
const DOME_GAIN_RANGE: [number, number] = [0.0005, 1.0];

function luminance(c: Rgb): number {
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * The mean of the sunward and anti-solar horizon.
 *
 * The fog colour this becomes is view-independent - one uniform for the whole
 * frame - so a single azimuth would be wrong in half of it. Looking at a low
 * sun the horizon blazes; looking away it stays blue. Averaging is the honest
 * answer available to a single slot, and {@link SkySample.horizonSunward} is
 * kept alongside for whatever can eventually vary by heading.
 */
function horizonMean(sample: AtmosphereSample): Rgb {
    return [
        (sample.horizonSunward[0] + sample.horizonOpposite[0]) / 2,
        (sample.horizonSunward[1] + sample.horizonOpposite[1]) / 2,
        (sample.horizonSunward[2] + sample.horizonOpposite[2]) / 2,
    ];
}

/**
 * What lights a cloud deck: overwhelmingly the beam, with a little skylight.
 *
 * A cloud is optically thick, so what you see off it is very largely the direct
 * sun it caught, and the beam is the part of the lighting that collapses
 * hardest as the sun goes down. Counting skylight equally kept the deck almost
 * as bright at sunset as at noon, which drove it clean through the top of the
 * tone curve - and a colour that clips has no colour left. They came out as
 * daylight cotton wool against an orange sky instead of catching any of it.
 */
const CLOUD_BEAM_SHARE = 0.85;

function cloudIllumination(sample: AtmosphereSample): Rgb {
    const out: Rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        out[c] = sample.directIrradiance[c] * CLOUD_BEAM_SHARE
            + sample.skyIrradiance[c] * (1 - CLOUD_BEAM_SHARE);
    }
    return out;
}

/**
 * What lights the ground: the same two sources, with the beam weighted for a
 * surface that is not square to it. A flat-ish landscape under a low sun gets
 * far less of the beam than its transmittance alone suggests, and that is what
 * lets the blue sky fill take over the colour balance at dusk.
 */
function groundIllumination(sample: AtmosphereSample, sunElevationDeg: number): Rgb {
    const cosine = Math.max(0, Math.sin(sunElevationDeg * Math.PI / 180));
    return [
        sample.directIrradiance[0] * cosine + sample.skyIrradiance[0],
        sample.directIrradiance[1] * cosine + sample.skyIrradiance[1],
        sample.directIrradiance[2] * cosine + sample.skyIrradiance[2],
    ];
}

/**
 * What a water surface shows: mostly the sky it reflects, with a little of the
 * light on the bed beneath it. Weighted the opposite way round from haze.
 */
const WATER_SKY_SHARE = 0.75;

/**
 * How much of the sunset's hue shift a water surface is allowed to take, versus
 * darkening on the spot.
 *
 * A mirror-flat authored base could take it in full like the horizon does, but
 * the authored water is a saturated teal, and the sunward glow this gain
 * carries loses blue far faster than it loses green. Applied whole, a teal
 * rotates through olive to green instead of deepening towards navy - the sea
 * never actually does that; the warm glint sits in a small sunward patch while
 * the rest of the water only dims. Trusting a fraction of the hue keeps the
 * darkening and enough of the warmth to read as sunset without the rotation.
 */
const WATER_HUE_TRUST = 0.35;

function waterIllumination(sample: AtmosphereSample, sunElevationDeg: number): Rgb {
    const horizon = horizonMean(sample);
    const ground = groundIllumination(sample, sunElevationDeg);
    const out: Rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        out[c] = ground[c] + (horizon[c] - ground[c]) * WATER_SKY_SHARE;
    }
    return out;
}

/**
 * What distant terrain fades into: mostly the light on the ground it is drawn
 * over, with a minority share of the horizon's glow mixed in.
 *
 * Weighted this way round, and given the ground's brightness range rather than
 * the sky's, because both halves of that matter. An even blend against the
 * sky's range could not darken below three quarters, so far ridges at sunset
 * came out *brighter* than at noon - a slab of glowing orange lying across the
 * middle of the frame. Aerial perspective washes distant land towards the light
 * between you and it; it does not make land outshine the ground it sits on.
 */
const HAZE_HORIZON_SHARE = 0.08;

function hazeIllumination(sample: AtmosphereSample, sunElevationDeg: number): Rgb {
    const horizon = horizonMean(sample);
    const ground = groundIllumination(sample, sunElevationDeg);
    const out: Rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        out[c] = ground[c] + (horizon[c] - ground[c]) * HAZE_HORIZON_SHARE;
    }
    return out;
}

/**
 * Ratio of `now` to `reference`, divided through by `common` so that whatever
 * darkening the night mix already applies is not applied twice.
 *
 * What survives is the *relative* change: how much redder, or how much brighter
 * against the rest of the frame, this slot has become. At sunset that is what
 * makes the horizon stand out from the zenith instead of the two sinking
 * together, which is the thing a uniform tint could never express.
 */
function gain(now: Rgb, reference: Rgb, common: number, range: [number, number], hueTrust = 1): Rgb {
    const raw: Rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        raw[c] = reference[c] > 1e-12 ? (now[c] / reference[c]) / common : 1;
    }
    // Split the ratio into "what colour" and "how bright", keep the first
    // whole, and bound the second to what the authored slot can hold.
    const brightness = luminance(raw);
    if (brightness <= 1e-9) {
        return [1, 1, 1];
    }
    // Blend the colour part towards neutral before it is applied. A near-white
    // or already-warm authored base (horizon, ground) can take the sunset's hue
    // in full: multiplying warm onto warm just deepens it. A saturated base like
    // water cannot - the sunward glow this ratio carries loses blue far faster
    // than it loses green, and a cyan multiplied by that rotates to green
    // instead of darkening towards blue, which is not what a sunset sea does.
    // Trusting only part of the hue keeps the darkening without the rotation.
    const tinted: Rgb = hueTrust >= 1 ? raw : [
        brightness + (raw[0] - brightness) * hueTrust,
        brightness + (raw[1] - brightness) * hueTrust,
        brightness + (raw[2] - brightness) * hueTrust,
    ];
    const bounded = Math.min(range[1], Math.max(range[0], brightness));
    const scale = bounded / brightness;
    return [tinted[0] * scale, tinted[1] * scale, tinted[2] * scale];
}

/** Per-slot linear-RGB gains, plus the night crossover, for one sun position. */
export interface SkySample {
    /** Sun elevation this was sampled at, in degrees. */
    elevationDeg: number;
    /** 0 = the authored noon palette, 1 = the authored midnight one. */
    nightMix: number;
    /** Overhead. */
    zenith: Rgb;
    /** The clear colour and the fog colours: the horizon band. */
    horizon: Rgb;
    /** Kept for whatever can eventually vary the horizon by heading. */
    horizonSunward: Rgb;
    /**
     * Aerial perspective over land: the haze distant terrain fades into.
     *
     * Not the same thing as the horizon sky, though it used to share a slot
     * with it. The sky at the horizon is the whole atmospheric path out to
     * space; the haze in front of a hillside is the air between you and the
     * hillside, with dark ground behind it rather than more sky. Given the
     * horizon's colour outright it turned every distant ridge at sunset into a
     * slab of glowing orange brighter than the land had any business being.
     */
    haze: Rgb;
    /** Cloud decks. */
    cloud: Rgb;
    /**
     * The solar disc and the corona around it.
     *
     * Taken from the *sky beside the sun* rather than from the beam that
     * reaches the viewer. Those are different colours - the beam is what
     * survives the path, the aureole is what the path scattered out - and using
     * the beam put an orange sun in a pink sky with a seam where they met. The
     * disc is driven past white by its material anyway (see the overbright in
     * sunModelBuilder), so what this actually decides is the colour of the
     * bloom, which has to be the sky's or it is a sticker.
     */
    sunDisc: Rgb;
    /** Lit surfaces. */
    ground: Rgb;
    /**
     * Water, which is a mirror rather than a diffuse surface.
     *
     * Fresnel reflectance goes to 1 at grazing incidence, so a sea seen from
     * anywhere near its own plane shows the sky rather than itself - which is
     * why a sunset sea is one of the brightest things in the frame while the
     * land beside it is a silhouette. Lit like ground it came out *darker* than
     * the land, which is backwards.
     */
    water: Rgb;
    /** Colour of the direct beam, normalised to luminance 1 (hue only). */
    directTint: Rgb;
    /** Colour of the sky's fill light, normalised to luminance 1 (hue only). */
    ambientTint: Rgb;
}

/**
 * How `now` differs in hue from `reference`, as a multiplier of luminance 1.
 *
 * Carries no brightness at all: how much light there is is the shaded ramp's
 * job (see SUN_SHADE_AMBIENT), and this only says what colour it is.
 */
function relativeTint(now: Rgb, reference: Rgb): Rgb {
    const raw: Rgb = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        raw[c] = reference[c] > 1e-12 && now[c] > 0 ? now[c] / reference[c] : 1;
    }
    const l = luminance(raw);
    if (l <= 1e-12) {
        return [1, 1, 1];
    }
    return [raw[0] / l, raw[1] / l, raw[2] / l];
}

let referenceSample: AtmosphereSample | undefined;

function reference(): AtmosphereSample {
    if (referenceSample === undefined) {
        referenceSample = sampleAtmosphere(REFERENCE_SUN_ELEVATION_DEG);
    }
    return referenceSample;
}

const cache: Map<number, SkySample> = new Map();

function build(elevationDeg: number): SkySample {
    const now = sampleAtmosphere(elevationDeg);
    const ref = reference();

    // How far the sky as a whole has fallen, in decades of zenith luminance.
    // Everything else is measured against this, so the slots carry only their
    // differences from the overall darkening.
    const zenithRatio = luminance(now.zenith) / Math.max(1e-30, luminance(ref.zenith));
    const decades = -Math.log10(Math.max(1e-30, zenithRatio));
    const t = Math.min(1, Math.max(0, decades / NIGHT_DECADES));
    const nightMix = t * t * (3 - 2 * t);

    // The night palette is authored, not derived, so once the mix has arrived
    // there the gains must be neutral or they would tint it too. The same goes
    // for the light: what little the sky still radiates deep in twilight is a
    // strongly red residue, and left alone it would light the night world red.
    const common = zenithRatio;
    const fade = 1 - nightMix;
    const settle = (g: Rgb): Rgb => [
        1 + (g[0] - 1) * fade,
        1 + (g[1] - 1) * fade,
        1 + (g[2] - 1) * fade,
    ];

    const groundNow = groundIllumination(now, elevationDeg);
    const groundRef = groundIllumination(ref, REFERENCE_SUN_ELEVATION_DEG);

    return {
        elevationDeg,
        nightMix,
        zenith: settle(gain(now.zenith, ref.zenith, common, SKY_BRIGHTNESS_RANGE)),
        horizon: settle(gain(horizonMean(now), horizonMean(ref), common, SKY_BRIGHTNESS_RANGE)),
        horizonSunward: settle(gain(now.horizonSunward, ref.horizonSunward, common, SKY_BRIGHTNESS_RANGE)),
        haze: settle(gain(
            hazeIllumination(now, elevationDeg), hazeIllumination(ref, REFERENCE_SUN_ELEVATION_DEG),
            common, GROUND_BRIGHTNESS_RANGE)),
        cloud: settle(gain(cloudIllumination(now), cloudIllumination(ref), common, CLOUD_BRIGHTNESS_RANGE)),
        sunDisc: settle(gain(now.sunward, ref.sunward, common, SUN_BRIGHTNESS_RANGE)),
        ground: settle(gain(groundNow, groundRef, common, GROUND_BRIGHTNESS_RANGE)),
        water: settle(gain(
            waterIllumination(now, elevationDeg), waterIllumination(ref, REFERENCE_SUN_ELEVATION_DEG),
            common, SKY_BRIGHTNESS_RANGE, WATER_HUE_TRUST)),
        // Relative to the reference sun, not absolute. Skylight is intensely
        // blue at every hour, so an absolute tint would wash the whole world
        // blue at noon - when the authored palette already *is* what noon
        // looks like. What matters is only how the light has changed since.
        directTint: settle(relativeTint(now.directIrradiance, ref.directIrradiance)),
        ambientTint: settle(relativeTint(now.skyIrradiance, ref.skyIrradiance)),
    };
}

/**
 * The sky for a sun at `elevationDeg`, cached per {@link CACHE_QUANTUM_DEG}.
 *
 * Sampling costs a couple of milliseconds, which is nothing when the time of
 * day is a setting rather than a running clock - but it is far too much to
 * repeat per frame, and the cache is what makes dragging the sun slider cheap.
 */
export function skyFor(elevationDeg: number): SkySample {
    const key = Math.round(elevationDeg / CACHE_QUANTUM_DEG);
    let sample = cache.get(key);
    if (sample === undefined) {
        sample = build(key * CACHE_QUANTUM_DEG);
        cache.set(key, sample);
    }
    return sample;
}

/**
 * The dome grid: view elevations and azimuths-from-the-sun the sky is sampled
 * at, in degrees.
 *
 * Elevations are bunched near the horizon because that is where the sky changes
 * fastest - the whole sunset happens in the bottom fifteen degrees, while
 * everything above forty is nearly flat. Azimuth only needs half a turn: the
 * atmosphere is mirror-symmetric about the plane through the sun, so 170 to the
 * left of it looks exactly like 170 to the right.
 *
 * These are the *gain* grid, not the geometry. Gains vary smoothly enough to
 * interpolate, so the dome can carry several hundred vertices while the
 * scattering model is only asked about eighty-odd directions.
 */
const DOME_ELEVATIONS_DEG = [0.3, 1.5, 4, 8, 15, 26, 42, 62, 90];
const DOME_AZIMUTHS_DEG = [0, 20, 40, 60, 90, 120, 150, 180];

/** Sky gains across the dome, indexed [elevation][azimuth-from-sun]. */
export type DomeGrid = Rgb[][];

function buildDomeGrid(sunElevationDeg: number): DomeGrid {
    const sunAngle = sunElevationDeg * Math.PI / 180;
    const sunDir: [number, number, number] = [Math.cos(sunAngle), Math.sin(sunAngle), 0];
    // One multiple-scattering table serves the whole grid: it depends on the
    // sun and the altitude, not on which way you are looking. Building it once
    // is most of what makes sampling seventy-odd directions affordable.
    const msTable = multipleScatteringTable(EARTH_ATMOSPHERE, sunDir);
    return DOME_ELEVATIONS_DEG.map(elevation => DOME_AZIMUTHS_DEG.map(azimuth => {
        const e = elevation * Math.PI / 180;
        const a = azimuth * Math.PI / 180;
        // The sun sits at azimuth 0 in the model's own frame.
        const view: [number, number, number] = [
            Math.cos(e) * Math.cos(a),
            Math.sin(e),
            Math.cos(e) * Math.sin(a),
        ];
        return skyRadiance(EARTH_ATMOSPHERE, 0, view, sunDir, msTable);
    }));
}

interface DomeSample {
    grid: DomeGrid;
    reference: DomeGrid;
}

let domeReference: DomeGrid | undefined;
const domeCache: Map<number, DomeGrid> = new Map();

function domeGridFor(elevationDeg: number): DomeSample {
    if (domeReference === undefined) {
        domeReference = buildDomeGrid(REFERENCE_SUN_ELEVATION_DEG);
    }
    const key = Math.round(elevationDeg / CACHE_QUANTUM_DEG);
    let grid = domeCache.get(key);
    if (grid === undefined) {
        grid = buildDomeGrid(key * CACHE_QUANTUM_DEG);
        domeCache.set(key, grid);
    }
    return { grid, reference: domeReference };
}

/** Index and blend weight of `value` within an ascending `stops` table. */
function locate(stops: number[], value: number): [number, number, number] {
    if (value <= stops[0]) {
        return [0, 0, 0];
    }
    for (let i = 1; i < stops.length; i++) {
        if (value <= stops[i]) {
            return [i - 1, i, (value - stops[i - 1]) / (stops[i] - stops[i - 1])];
        }
    }
    const last = stops.length - 1;
    return [last, last, 0];
}

/**
 * Per-direction sky gain: how the sky in this direction has changed since the
 * sun was high, as a linear-RGB multiplier on the authored gradient.
 *
 * This is the whole point of the dome. Every slot-based colour before it had to
 * answer for the entire sky at once, so the model's directional half - the deep
 * blue opposite a setting sun, the washed-out Mie halo around it - averaged
 * itself away. Here each vertex asks about its own direction.
 *
 * `azimuthFromSunDeg` is the angle between the view's compass bearing and the
 * sun's, 0..180; which side of the sun it is on does not matter.
 */
/** What the sky is doing in one direction: its hue, and how bright it is. */
export interface DomeShade {
    /** Absolute chromaticity of the sky there. Sums to 1. */
    chroma: Rgb;
    /**
     * How far to trust that chroma over the authored one, 0..1.
     *
     * 0 with the sun at the reference elevation, where the authored palette is
     * the answer by definition, and rising as the real sky's hue departs from
     * its own hue at that elevation.
     */
    hueWeight: number;
    /** Luminance relative to the same direction at the reference sun, bounded. */
    brightness: number;
}

/** Chromaticity of a linear-RGB colour: the three channels, normalised to sum 1. */
function chromaOf(c: Rgb): Rgb {
    const total = c[0] + c[1] + c[2];
    return total > 1e-30 ? [c[0] / total, c[1] / total, c[2] / total] : [1 / 3, 1 / 3, 1 / 3];
}

/**
 * Elevations across which the sky's own hue takes over from the authored one.
 *
 * Driven by where the sun is, not by how far the hue has moved. Chroma distance
 * was the obvious measure and it was wrong: the real sky is far more saturated
 * than any of these palettes at *every* hour, so a mid-afternoon sky already
 * sits a long way from the authored one and got dragged most of the way to a
 * vivid periwinkle. Sun elevation says the thing actually meant - that the
 * authored palette is the answer while the sun is high, and the atmosphere's
 * own colour is the answer once it is on the horizon.
 */
const HUE_TRUST_START_ELEVATION_DEG = 12;
const HUE_TRUST_FULL_ELEVATION_DEG = 0;

/**
 * Ceiling on that trust. Some of the authored colour survives even at sunset,
 * which keeps a little of the palette's own green in the horizon band: the
 * model, with standard ozone coefficients, puts green slightly *below* blue
 * there, and taken neat that reads as pink rather than as the deep orange-red
 * a sunset is supposed to be.
 */
const HUE_TRUST_MAX = 0.8;

/**
 * What the sky looks like in one direction, for the dome to paint.
 *
 * Returns the sky's *absolute* hue rather than a ratio against noon, which is
 * the one thing that took several tries to get right. A ratio is the natural
 * way to keep the authored palette as the anchor, and it is what every other
 * slot in this file uses - but it cannot carry a hue. At sunset the sky away
 * from the sun and the same sky at noon are both blue; the ratio between them
 * is strongly red, because the blue has faded more than the red has. Multiply a
 * near-neutral authored horizon by that and the ratio's hue wins outright: the
 * anti-solar sky came out brown-plum when the physics behind it says it is a
 * greyish blue.
 *
 * So the hue is handed over as itself, with a weight saying how far it has moved
 * since the reference sun. At noon it has not moved, the weight is zero, and the
 * authored colour stands untouched; by sunset it has moved a long way and the
 * sky's own colour takes over. Brightness stays a ratio, where ratios work.
 */
export function domeShade(
    sunElevationDeg: number, viewElevationDeg: number, azimuthFromSunDeg: number,
): DomeShade {
    const { grid, reference } = domeGridFor(sunElevationDeg);
    const elevation = Math.max(DOME_ELEVATIONS_DEG[0], viewElevationDeg);
    const [e0, e1, ew] = locate(DOME_ELEVATIONS_DEG, elevation);
    const [a0, a1, aw] = locate(DOME_AZIMUTHS_DEG, Math.abs(azimuthFromSunDeg));

    const bilinear = (g: DomeGrid): Rgb => {
        const out: Rgb = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            const low = g[e0][a0][c] + (g[e0][a1][c] - g[e0][a0][c]) * aw;
            const high = g[e1][a0][c] + (g[e1][a1][c] - g[e1][a0][c]) * aw;
            out[c] = low + (high - low) * ew;
        }
        return out;
    };

    const now = bilinear(grid);
    const then = bilinear(reference);

    const t = Math.min(1, Math.max(0,
        (sunElevationDeg - HUE_TRUST_FULL_ELEVATION_DEG)
        / (HUE_TRUST_START_ELEVATION_DEG - HUE_TRUST_FULL_ELEVATION_DEG)));
    const eased = t * t * (3 - 2 * t);

    const ratio = luminance(then) > 1e-30 ? luminance(now) / luminance(then) : 1;
    return {
        chroma: chromaOf(now),
        hueWeight: HUE_TRUST_MAX * (1 - eased),
        brightness: Math.min(DOME_GAIN_RANGE[1], Math.max(DOME_GAIN_RANGE[0], ratio)),
    };
}
