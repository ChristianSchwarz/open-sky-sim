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
import { Airfield, AirfieldRunway, RunwaySurface, planeElevationAt } from '../terrain/airfields';
import { ecefToEnu, EnuBasis, geodeticToEcef, sceneFromEnu } from '../terrain/geodesy';

export interface SceneRunway {
    /** Threshold-to-threshold midpoint, scene space, on the pavement. */
    center: THREE.Vector3;
    /** Scene heading (rad) landing on the low designator; 0 faces +Z. */
    heading: number;
    halfLength: number;
    halfWidth: number;
    /** Rise in scene Y per metre along `heading`. */
    slope: number;
    /** Painted designators, low end first. */
    ref: string;
    surface: RunwaySurface;
    icao: string;
    /** Airfield name, for the spawn menu and the target label. */
    name: string;
    /** True when this is the longest runway of its airfield. */
    primary: boolean;
}

/** Metres per degree, good enough to step a kilometre along a runway. */
function metresPerDegree(latDeg: number): { lat: number; lon: number } {
    const lat = latDeg * Math.PI / 180;
    return {
        lat: 111132.92 - 559.82 * Math.cos(2 * lat) + 1.175 * Math.cos(4 * lat),
        lon: Math.max(1, 111412.84 * Math.cos(lat) - 93.5 * Math.cos(3 * lat)),
    };
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
    const at = (along: number): THREE.Vector3 => {
        const lat = runway.lat + (along * Math.cos(r)) / perDeg.lat;
        const lon = runway.lon + (along * Math.sin(r)) / perDeg.lon;
        const elevation = planeElevationAt(airfield, runway.headingDeg, along) + surfaceEpsM;
        return sceneFromEnu(ecefToEnu(basis, geodeticToEcef(lat, lon, elevation)));
    };

    const half = runway.lengthM / 2;
    const centre = at(0);
    const ahead = at(half);
    const behind = at(-half);
    return {
        center: centre,
        heading: Math.atan2(ahead.x - behind.x, ahead.z - behind.z),
        halfLength: half,
        halfWidth: runway.widthM / 2,
        slope: (ahead.y - behind.y) / runway.lengthM,
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
 */
export function pickStartRunway(
    runways: readonly SceneRunway[], preferIcao?: string,
): SceneRunway | undefined {
    if (runways.length === 0) {
        return undefined;
    }
    if (preferIcao) {
        // Keyed the same way the picker offered it: `icao || name`. An airfield
        // with no ICAO — most of the small US strips and unnamed ones — would
        // otherwise never match here, since `r.icao` alone is `''` and falls
        // through to the general ranking silently, ignoring what was chosen.
        const key = (r: SceneRunway) => r.icao || r.name;
        const named = runways.find(r => r.primary && key(r) === preferIcao)
            ?? runways.find(r => key(r) === preferIcao);
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

/** Unit forward vector along a scene heading. */
export function headingForward(heading: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.sin(heading), 0, Math.cos(heading));
}

/** One airfield entry per ICAO, for a picker. Longest runway decides the order. */
export function airfieldChoices(
    runways: readonly SceneRunway[],
): Array<{ icao: string; name: string; ref: string; lengthM: number }> {
    const seen = new Set<string>();
    const out: Array<{ icao: string; name: string; ref: string; lengthM: number }> = [];
    for (const runway of runways) {
        if (!runway.primary) {
            continue;
        }
        // A field with no ICAO is keyed by its name; two unnamed airstrips in
        // one area would otherwise collapse into one menu entry.
        const key = runway.icao || runway.name;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push({
            icao: runway.icao,
            name: runway.name,
            ref: runway.ref,
            lengthM: runway.halfLength * 2,
        });
    }
    return out;
}
