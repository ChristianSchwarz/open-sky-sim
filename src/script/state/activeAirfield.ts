/**
 * The airfields of the play area, as the rest of the sim needs them: in scene
 * space, with a heading you can fly.
 *
 * The manifest records an airfield geodetically — that is what survives moving
 * the play origin. Everything downstream of here wants world XZ and a scene
 * heading instead: where to put the aircraft, which way to point it, where the
 * ILS beam comes from, where an AI turns final.
 *
 * A scene heading is *not* a compass bearing. Scene axes are x east, y up,
 * z south, so a runway on 021 true has a scene heading of 159. Converting once,
 * here, is what stops that showing up as a sign error somewhere downstream.
 */

import * as THREE from 'three';
import { Airfield, AirfieldRunway, RunwaySurface, airfieldSurface, primaryRunway } from '../terrain/airfields';
import { ecefToEnu, EnuBasis, geodeticToEcef, sceneFromEnu } from '../terrain/geodesy';

export interface SceneRunway {
    /** Threshold-to-threshold midpoint, scene space, on the pavement. */
    center: THREE.Vector3;
    /** Scene heading (rad) landing on the low designator; 0 faces +Z. */
    heading: number;
    halfLength: number;
    halfWidth: number;
    /** Rise in scene Y per metre along `heading`, threshold to threshold. */
    slope: number;
    /**
     * Rise above the line through the centre at `slope`, metres, at evenly
     * spaced stations from -halfLength to +halfLength along `heading`: the
     * runway follows its own graded ground (see SurfacePadCollider.profile).
     */
    profile?: number[];
    /** Painted designators, low end first. */
    ref: string;
    surface: RunwaySurface;
    icao: string;
    /** Airfield name, for the spawn menu and the target label. */
    name: string;
    /** True when this is the longest runway of its airfield. */
    primary: boolean;
    /**
     * A place to start from and nothing else: a steel deck (Saki's NITKA) or
     * a ski-jump run-up (its T2). Offered in the picker under {@link label};
     * never landed on, never where the AI or the opponents are based.
     */
    startOnly?: boolean;
    /** What a start-only runway is called in the picker: the deck's or the ramp's name. */
    label?: string;
}

/**
 * What the picker and the session's preferred airfield call a runway: the
 * airfield's ICAO (or name), and for a start-only one that plus its label.
 */
export function runwayKey(r: Pick<SceneRunway, 'icao' | 'name' | 'startOnly' | 'label'>): string {
    const field = r.icao || r.name;
    return r.startOnly ? `${field}#${r.label ?? ''}` : field;
}

/** The nearest of some named `[lat, lon]` places to a runway's middle. */
function nearestName(
    runway: AirfieldRunway, places: ReadonlyArray<{ name: string; lat: number; lon: number }>,
): { name: string; lat: number; lon: number } | undefined {
    let best: { name: string; lat: number; lon: number } | undefined;
    let bestD = Infinity;
    for (const p of places) {
        const d = (p.lat - runway.lat) ** 2 + ((p.lon - runway.lon) * Math.cos(runway.lat * Math.PI / 180)) ** 2;
        if (d < bestD) {
            bestD = d;
            best = p;
        }
    }
    return best;
}

/** The middle of a closed `[lat, lon]` ring, as a point to measure to. */
function ringCentre(name: string, ring: number[][]): { name: string; lat: number; lon: number } {
    const n = Math.max(1, ring.length);
    return {
        name,
        lat: ring.reduce((s, p) => s + p[0], 0) / n,
        lon: ring.reduce((s, p) => s + p[1], 0) / n,
    };
}

/** Metres per degree, good enough to step a kilometre along a runway. */
function metresPerDegree(latDeg: number): { lat: number; lon: number } {
    const lat = latDeg * Math.PI / 180;
    return {
        lat: 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat),
        lon: Math.max(1, 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat)),
    };
}

/** Spacing of a scene runway's profile stations, metres. */
const RUNWAY_PROFILE_STEP_M = 20;

/** Each airfield's surface in its own local frame (see airfieldSurfaceSceneAt). */
const surfaces = new WeakMap<Airfield, { lat0: number; lon0: number; perDeg: { lat: number; lon: number }; at: (e: number, n: number) => number }>();

/**
 * Scene position of a point on an airfield's pavement surface, `liftM` above
 * it.
 *
 * The surface is the one the terrain was laid on (airfieldSurface: every
 * runway and taxiway on its own graded profile, every apron on its plane), so
 * anything standing on the pavement - an arresting wire, the foot of a
 * ski-jump, the runway's own collider - belongs on it.
 */
export function airfieldSurfaceSceneAt(
    airfield: Airfield, basis: EnuBasis, lat: number, lon: number, liftM = 0,
): THREE.Vector3 {
    let s = surfaces.get(airfield);
    if (s === undefined) {
        const primary = primaryRunway(airfield);
        const lat0 = primary?.lat ?? airfield.lat;
        const lon0 = primary?.lon ?? airfield.lon;
        const perDeg = metresPerDegree(lat0);
        const at = airfieldSurface(airfield, (la, lo) => ({ e: (lo - lon0) * perDeg.lon, n: (la - lat0) * perDeg.lat }));
        s = { lat0, lon0, perDeg, at };
        surfaces.set(airfield, s);
    }
    const height = s.at((lon - s.lon0) * s.perDeg.lon, (lat - s.lat0) * s.perDeg.lat) + liftM;
    return sceneFromEnu(ecefToEnu(basis, geodeticToEcef(lat, lon, height)));
}

/**
 * One runway in scene space.
 *
 * Built by sampling the pavement at both thresholds and the middle rather than
 * by trigonometry on the bearing, so the heading, the slope and the centre all
 * come from the same three points the geometry and the collider were built
 * from. It also folds in the first-order curvature of the earth falling away
 * from the play origin, which over a 3 km runway is metres of scene Y.
 */
export function sceneRunwayOf(
    airfield: Airfield, runway: AirfieldRunway, basis: EnuBasis, surfaceEpsM: number,
): SceneRunway {
    const perDeg = metresPerDegree(runway.lat);
    const r = runway.headingDeg * Math.PI / 180;
    // On the surface where this runway really is, measured at this runway's
    // own points: Saki's NITKA deck, 1.8 km from the primary, was once solid
    // 8.5 m above the deck drawn for it because its height was read as if it
    // were the primary's.
    const at = (along: number): THREE.Vector3 => airfieldSurfaceSceneAt(
        airfield, basis,
        runway.lat + (along * Math.cos(r)) / perDeg.lat,
        runway.lon + (along * Math.sin(r)) / perDeg.lon,
        surfaceEpsM);

    const half = runway.lengthM / 2;
    const centre = at(0);
    const ahead = at(half);
    const behind = at(-half);
    const slope = (ahead.y - behind.y) / runway.lengthM;
    // The bends in it, as rises over the straight line threshold to threshold.
    const stations = Math.max(2, Math.ceil(runway.lengthM / RUNWAY_PROFILE_STEP_M) + 1);
    const profile: number[] = [];
    for (let i = 0; i < stations; i++) {
        const along = -half + (2 * half * i) / (stations - 1);
        profile.push(at(along).y - (centre.y + slope * along));
    }
    return {
        center: centre,
        heading: Math.atan2(ahead.x - behind.x, ahead.z - behind.z),
        halfLength: half,
        halfWidth: runway.widthM / 2,
        slope,
        profile: profile.some(v => Math.abs(v) > 0.005) ? profile : undefined,
        ref: runway.ref,
        surface: runway.surface,
        icao: airfield.icao,
        name: airfield.name,
        primary: false,
    };
}

/** Every runway of every airfield here, longest first. */
export function sceneRunwaysOf(
    airfields: readonly Airfield[], basis: EnuBasis, surfaceEpsM: number,
): SceneRunway[] {
    const out: SceneRunway[] = [];
    for (const airfield of airfields) {
        let longest: SceneRunway | undefined;
        for (const runway of airfield.runways) {
            const scene = sceneRunwayOf(airfield, runway, basis, surfaceEpsM);
            // A deck or a ski-jump run-up is a couple of hundred metres: a
            // start point, never the airfield's runway (see SceneRunway.startOnly).
            if (runway.surface === 'metal' || runway.skiJump) {
                scene.startOnly = true;
                if (runway.skiJump) {
                    const ramp = nearestName(runway, airfield.skiJumps ?? []);
                    scene.label = ramp?.name || 'ski-jump';
                    if (ramp !== undefined) {
                        // Lined up to roll onto the ramp, whichever end the
                        // designators put first.
                        const at = sceneFromEnu(ecefToEnu(basis, geodeticToEcef(ramp.lat, ramp.lon, 0)));
                        const fwd = headingForward(scene.heading);
                        if ((at.x - scene.center.x) * fwd.x + (at.z - scene.center.z) * fwd.z < 0) {
                            scene.heading = Math.atan2(-fwd.x, -fwd.z);
                            scene.slope = -scene.slope;
                            scene.profile?.reverse();
                        }
                    }
                } else {
                    scene.label = nearestName(runway,
                        (airfield.decks ?? []).map(d => ringCentre(d.name, d.ring)))?.name || 'deck';
                }
                out.push(scene);
                continue;
            }
            out.push(scene);
            if (longest === undefined || scene.halfLength > longest.halfLength) {
                longest = scene;
            }
        }
        if (longest !== undefined) {
            longest.primary = true;
        }
    }
    return out.sort((a, b) => b.halfLength - a.halfLength);
}

/** Below this an airfield is somewhere to visit, not somewhere to be based. */
const MIN_BASE_RUNWAY_M = 1500;

/**
 * The runway a session should start on.
 *
 * The nearest usable airfield to the play origin, not the longest in the area.
 * The origin is where the world is centred — where the authored scenario sits,
 * where the carrier is, and where float32 vertices are finest — and an area
 * three degrees across can easily have its longest runway a hundred
 * kilometres away across open water. Measured in the Canaries: ranking by
 * length alone based every session at Tenerife Norte, 110 km from the play
 * origin and from everything built around it.
 *
 * Usable means paved and long enough to be a base. Failing that, any primary,
 * and failing that anything at all — a grass strip is still somewhere to
 * start, and an area should not come up with no airfield when it has one.
 *
 * `preferIcao` picks a named one when the player has chosen it, and is ignored
 * rather than honoured-as-nothing when that airfield is not in this area.
 * `homeIcao` is the area's own base where it has one (regionalHomeBase), ahead
 * of the nearest-field rule but behind the player's choice.
 */
export function pickStartRunway(
    runways: readonly SceneRunway[], preferIcao?: string, homeIcao?: string,
): SceneRunway | undefined {
    if (runways.length === 0) {
        return undefined;
    }
    if (homeIcao && !preferIcao) {
        const home = runways.find(r => r.primary && runwayKey(r) === homeIcao);
        if (home !== undefined) {
            return home;
        }
    }
    if (preferIcao) {
        // Keyed the same way the picker offered it: `icao || name`. An airfield
        // with no ICAO — most of the small US strips and unnamed ones — would
        // otherwise never match here, since `r.icao` alone is `''` and falls
        // through to the general ranking silently, ignoring what was chosen.
        const named = runways.find(r => r.primary && runwayKey(r) === preferIcao)
            ?? runways.find(r => runwayKey(r) === preferIcao);
        if (named !== undefined) {
            return named;
        }
    }
    const primaries = runways.filter(r => r.primary);
    const paved = primaries.filter(
        r => r.surface === 'asphalt' || r.surface === 'concrete');
    // Real bases first, and among those the nearest one. Below that the tiers
    // fall through by what is left of an airfield — pavement, then anything —
    // and are settled by *length* rather than by distance: proximity is about
    // staying near the scenario at the origin, which only matters once there
    // is more than one place worth being based at. In an area of small fields
    // there is not, and the best strip in it wins.
    const based = paved.filter(r => r.halfLength * 2 >= MIN_BASE_RUNWAY_M);
    if (based.length > 0) {
        // The play origin is scene (0, 0) by construction.
        return nearestSceneRunway(based, 0, 0);
    }
    // `runways` arrives sorted longest first, and filtering preserves that.
    return firstNonEmpty(paved, primaries, runways)[0];
}

function firstNonEmpty<T>(...tiers: ReadonlyArray<readonly T[]>): readonly T[] {
    for (const tier of tiers) {
        if (tier.length > 0) {
            return tier;
        }
    }
    return [];
}

/** Closest runway centre to a point, or undefined when there are none. */
export function nearestSceneRunway(
    runways: readonly SceneRunway[], x: number, z: number,
): SceneRunway | undefined {
    let best: SceneRunway | undefined;
    let bestSq = Infinity;
    for (const runway of runways) {
        const dx = runway.center.x - x;
        const dz = runway.center.z - z;
        const d = dx * dx + dz * dz;
        if (d < bestSq) {
            bestSq = d;
            best = runway;
        }
    }
    return best;
}

/**
 * Airfields a region is based at, instead of the long runway nearest the
 * middle of its box. A box drawn round a coastline puts its middle wherever
 * the coast happens to bend - Krim's is closest to Kirovske - and a region
 * with a famous base should start there.
 *
 * Found by position, like homeArea, so renaming an area cannot strand it.
 */
export const REGIONAL_HOME_BASES: ReadonlyArray<{ icao: string; lat: number; lon: number }> = [
    // Krim: Saki, the naval aviation field with the NITKA deck and the T2 ski-jump.
    { icao: 'URFI', lat: 45.0918, lon: 33.6048 },
];

/** The home base of the area with these bounds, if it has one. */
export function regionalHomeBase(
    area: { west: number; south: number; east: number; north: number },
): string | undefined {
    return REGIONAL_HOME_BASES.find(b =>
        b.lon >= area.west && b.lon <= area.east && b.lat >= area.south && b.lat <= area.north)?.icao;
}

/** Unit forward vector along a scene heading. */
export function headingForward(heading: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(heading), 0, Math.cos(heading));
}

/**
 * One airfield entry per ICAO, for a picker. Longest runway decides the order.
 * An airfield's start-only runways (a deck, a ski-jump run-up) follow it as
 * entries of their own.
 */
export function airfieldChoices(
    runways: readonly SceneRunway[],
): Array<{ icao: string; name: string; ref: string; lengthM: number; key: string; label?: string }> {
    const seen = new Set<string>();
    const out: Array<{ icao: string; name: string; ref: string; lengthM: number; key: string; label?: string }> = [];
    for (const runway of runways) {
        if (!runway.primary) {
            continue;
        }
        // A field with no ICAO is keyed by its name; two unnamed airstrips in
        // one area would otherwise collapse into one menu entry.
        const key = runwayKey(runway);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({
            icao: runway.icao,
            name: runway.name,
            ref: runway.ref,
            lengthM: runway.halfLength * 2,
            key,
        });
        for (const start of runways) {
            if (start.startOnly && start.icao === runway.icao && start.name === runway.name
                && !seen.has(runwayKey(start))) {
                seen.add(runwayKey(start));
                out.push({
                    icao: start.icao,
                    name: start.name,
                    ref: start.ref,
                    lengthM: start.halfLength * 2,
                    key: runwayKey(start),
                    label: start.label,
                });
            }
        }
    }
    return out;
}

