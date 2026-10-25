/**
 * The airfields the bake found, as the runtime reads them.
 *
 * A file of its own rather than a block in the terrain manifest: the runways,
 * taxiways and aprons of every airfield in the pyramid come to 377 KB against
 * a 44 KB manifest, and the manifest is fetched before anything can be drawn.
 * This is fetched once the play area is known, and only if something is going
 * to draw it.
 *
 * Written by tools/bake_planet_mesh.ts, carried through from the block
 * tools/bake_osm_airports.py wrote into the DEM manifest.
 */

import { FlattenPadManifest } from './manifest';
import { LonLatBounds } from './tiling';

/**
 * `metal` is a carrier deck built on land (Saki's NITKA): drawn with the
 * airfield, never landed on, spawned at or based from - see sceneRunwaysOf.
 */
export type RunwaySurface = 'asphalt' | 'concrete' | 'grass' | 'gravel' | 'metal';

export interface AirfieldRunway {
    /** Painted designators, low end first: `03L/21R`. */
    ref: string;
    /** True bearing of the low designator's landing direction. */
    headingDeg: number;
    lengthM: number;
    widthM: number;
    surface: RunwaySurface;
    lit: boolean;
    /** Threshold-to-threshold midpoint. */
    lat: number;
    lon: number;
    /** `[lat, lon]` of each threshold, low designator first. */
    thresholds: number[][];
    /** True when OSM had no `ref` and the designators were derived. */
    refDerived?: boolean;
    /** The run-up to a ski-jump ramp: drawn, never landed on or spawned at. */
    skiJump?: boolean;
}

interface AirfieldTaxiway {
    widthM: number;
    /** `[lat, lon]` along the centreline. */
    points: number[][];
}

interface AirfieldApron {
    /** `[lat, lon]` ring, closed. */
    ring: number[][];
}

export interface AirfieldBuilding {
    kind: 'terminal' | 'hangar' | 'tower';
    lat: number;
    lon: number;
    /** Bearing of the footprint's long axis. */
    headingDeg: number;
    /** Across the long axis. */
    widthM: number;
    /** Along it. */
    depthM: number;
    /**
     * Height from OSM's `height` or `building:levels`, absent where it has
     * neither — which is almost always. The renderer infers one from the kind
     * and the footprint instead.
     */
    heightM?: number;
}

/** The single plane every part of one airfield is cut to. */
interface AirfieldPlane {
    heightMsl: number;
    /** Rise per metre along `headingDeg`. */
    gradient: number;
    headingDeg: number;
}

export interface Airfield {
    name: string;
    icao: string;
    iata: string;
    kind: string;
    /** Name of the baked area this one sits in. */
    area: string;
    /** Aerodrome reference point. */
    lat: number;
    lon: number;
    elevationM: number;
    plane: AirfieldPlane;
    runways: AirfieldRunway[];
    taxiways: AirfieldTaxiway[];
    aprons: AirfieldApron[];
    buildings: AirfieldBuilding[];
    pads: FlattenPadManifest[];
    /** OSM `barrier=cable_barrier`; absent on the fields that have none. */
    arrestingWires?: AirfieldArrestingWire[];
    /** Steel deck outlines (`area=yes surface=metal`); absent on the fields that have none. */
    decks?: AirfieldDeck[];
    /** Ski-jump ramps; absent on the fields that have none. */
    skiJumps?: AirfieldSkiJump[];
}

/** A ski-jump ramp at the end of its run-up (Saki's T2), as the bake placed it. */
export interface AirfieldSkiJump {
    name: string;
    /** `[lat, lon]` footprint, closed. */
    ring: number[][];
    /** Rise from base to lip. */
    heightM: number;
    /** Middle of the low end, where the run-up meets the ramp. */
    lat: number;
    lon: number;
    /** True bearing up the ramp. */
    headingDeg: number;
    lengthM: number;
    widthM: number;
    /** False when no runway was in reach and the uphill way is a guess. */
    runUpFound: boolean;
}

/** A carrier deck on land, drawn in rust from its own outline (Saki's NITKA). */
export interface AirfieldDeck {
    name: string;
    /** `[lat, lon]` ring, closed. */
    ring: number[][];
}

/** Arresting gear across a runway or deck (landArrestorWires.ts). */
export interface AirfieldArrestingWire {
    name: string;
    /** `[lat, lon]` along the wire; it spans the first to the last. */
    points: number[][];
}

export interface AirfieldsFile {
    source: string;
    coverage: LonLatBounds;
    items: Airfield[];
}


export const EMPTY_AIRFIELDS: AirfieldsFile = {
    source: 'none',
    coverage: { west: 0, south: 0, east: 0, north: 0 },
    items: [],
};

/**
 * Fetch the airfields beside a terrain manifest.
 *
 * Missing is not an error: a pyramid baked before airfields existed simply has
 * none, and the sim draws the world it always did.
 */
export async function loadAirfields(url: string): Promise<AirfieldsFile> {
    const res = await fetch(url);
    if (!res.ok) {
        return EMPTY_AIRFIELDS;
    }
    try {
        const file = await res.json() as AirfieldsFile;
        return Array.isArray(file?.items) ? file : EMPTY_AIRFIELDS;
    } catch {
        return EMPTY_AIRFIELDS;
    }
}

/** The airfields belonging to one baked area, best first. */
export function airfieldsInArea(file: AirfieldsFile, areaName: string): Airfield[] {
    return file.items.filter(a => a.area === areaName);
}

/**
 * Elevation of the airfield's platform plane, `distanceM` along `bearingDeg`
 * from the primary runway's centre.
 *
 * The plane belongs to the whole airfield and rises along its own bearing, so
 * a runway crossing it climbs only by the component along that — which is what
 * keeps both runways of a crossing pair on one surface instead of two that
 * meet at a ridge.
 */
export function planeElevationAt(
    airfield: Airfield, bearingDeg: number, distanceM: number,
): number {
    const angle = (bearingDeg - airfield.plane.headingDeg) * Math.PI / 180;
    return airfield.plane.heightMsl
        + airfield.plane.gradient * distanceM * Math.cos(angle);
}

/** Longest runway of an airfield, which is the one worth flying to. */
export function primaryRunway(airfield: Airfield): AirfieldRunway | undefined {
    let best: AirfieldRunway | undefined;
    for (const r of airfield.runways) {
        if (best === undefined || r.lengthM > best.lengthM) {
            best = r;
        }
    }
    return best;
}
