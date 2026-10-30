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

import { PadGrid, applyFlattenPad, padFromRecord } from './flattenPad';
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
    /** Laid in concrete plates (OSM `surface=concrete:plates`); the joints are drawn. */
    plates?: boolean;
    /** The OSM way this runway came from. */
    osmId?: number;
    /** True bearing minus what `ref` implies - mostly magnetic declination. */
    refDeltaDeg?: number | null;
    /** True when the runway was mapped as an area and `widthM` was measured off it. */
    widthMeasured?: boolean;
    /** OSM's own `length` tag, where it has one. Not used for placement. */
    lengthTagM?: number | null;
    /** True when OSM's `width` was too narrow to believe and the class default was used. */
    widthImplausible?: boolean;
}

interface AirfieldTaxiway {
    widthM: number;
    /** `[lat, lon]` along the centreline. */
    points: number[][];
    /** OSM `surface`, where tagged. */
    surface?: string;
    /** Mapped as `aeroway=taxilane`: a taxiway's path across an apron to the stands. */
    taxilane?: boolean;
}

interface AirfieldApron {
    /** `[lat, lon]` ring, closed. */
    ring: number[][];
    /** OSM `surface`, where tagged. */
    surface?: string;
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
     * Height from OSM's `height` or `building:levels`, null where it has
     * neither — which is almost always. The renderer infers one from the kind
     * and the footprint instead.
     */
    heightM?: number | null;
    /**
     * The outline as mapped, closed `[lat, lon]`, which is what is drawn;
     * the box above stays for the colliders and the height rules. Absent on
     * fields baked before outlines were kept, which are drawn as the box.
     */
    ring?: number[][];
}

/**
 * A summary of the primary runway: its centre height and its end-to-end
 * slope. Every runway, taxiway and apron is laid on a surface of its own (see
 * {@link airfieldSurface}); this is for what wants one number for the field.
 */
interface AirfieldPlane {
    heightMsl: number;
    /** Rise per metre along `headingDeg`, threshold to threshold. */
    gradient: number;
    headingDeg: number;
}

/** What grading did to one strip (`airfield_grade.grade_profile`). */
export interface AirfieldStripReport {
    /** `steep` is a strip kept as steep as it really is; `suspect` moved a lot of earth. */
    status: 'ok' | 'graded' | 'steep' | 'suspect';
    /** Name of the limits it was graded to, `runway code 1/2` and the like. */
    limits: string;
    naturalOverall: number;
    naturalLocal: number;
    overall: number;
    local: number;
    /** Tightest vertical curve; null where the profile is straight. */
    minRadiusM: number | null;
    /** Largest cut or fill between the ground and the profile. */
    earthworkM: number;
    /** Fraction of stations the DEM had a height for. */
    measured: number;
}

/** What grading did to an apron (`airfield_grade.fit_apron_plane`). */
export interface AirfieldApronReport {
    status: 'ok' | 'graded';
    naturalGradient: number;
    gradient: number;
    earthworkM: number;
}

/** The bake's per-element grading reports; diagnostics, nothing at runtime reads them. */
export interface AirfieldFit {
    runways: (AirfieldStripReport & { ref: string })[];
    aprons: AirfieldApronReport[];
    taxiways: {
        count: number;
        /** Taxiway count per {@link AirfieldStripReport.status}. */
        status: Partial<Record<AirfieldStripReport['status'], number>>;
        /** Taxiways that leave the ground by more than the pad tolerance. */
        padded: number;
        pads: number;
        earthworkMaxM: number;
        localMax: number;
    };
    earthworkMaxM: number;
}

/** The single-plane fit airfields baked before per-element grading still carry. */
export interface AirfieldPlaneFit {
    heightMsl: number;
    gradient: number;
    gradientRaw: number;
    clamped: boolean;
    samples: number;
    samplesTrimmed: number;
    residualRmsM: number;
    residualMaxM: number;
    outlierMaxM: number;
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
    /** What OSM's `ele` says, beside the DEM-fitted `elevationM`; null where untagged. */
    eleTagM?: number | null;
    /** The OSM aerodrome element (or runway way, for a field with none). */
    osmId?: number;
    plane: AirfieldPlane;
    /** How the bake graded it; null where it was not graded. */
    fit?: AirfieldFit | AirfieldPlaneFit | null;
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
    /** OSM `man_made=embankment`; absent on the fields that have none. */
    embankments?: AirfieldEmbankment[];
    /**
     * The aerodrome polygon's outer ring, `[lat, lon]`; absent on a node-only
     * aerodrome. The cover bake paints the ground inside it from the land around it.
     */
    perimeter?: number[][];
    /** OSM `aeroway=helipad`; absent on the fields that have none. */
    helipads?: AirfieldHelipad[];
    /** OSM `aeroway=holding_position`, each as the bar across its taxiway. */
    holdingPositions?: AirfieldHoldingPosition[];
    /** OSM `aeroway=parking_position`: stands, as lead-in lines or points. */
    parkingPositions?: AirfieldParkingPosition[];
    /** OSM `aeroway=gate`: boarding gates. Data only; nothing draws them. */
    gates?: AirfieldPoint[];
    /** OSM `aeroway=jet_bridge`. */
    jetBridges?: AirfieldJetBridge[];
    /** OSM `aeroway=windsock`. */
    windsocks?: AirfieldWindsock[];
    /** OSM `aeroway=navigationaid`: PAPI, APAPI and VASI. */
    navigationAids?: AirfieldNavigationAid[];
    /** OSM `aeroway=fuel`. Data only; nothing draws them. */
    fuel?: AirfieldPoint[];
}

/** A tagged point on a field: a gate, a fuel stand. */
export interface AirfieldPoint {
    lat: number;
    lon: number;
    ref?: string;
}

/** A helipad as an oriented rectangle, from its outline or a default square about its point. */
export interface AirfieldHelipad {
    lat: number;
    lon: number;
    /** Bearing of the `depthM` side. */
    headingDeg: number;
    widthM: number;
    depthM: number;
    ref?: string;
    /** OSM `surface`, where tagged. */
    surface?: string;
}

/** Where an aircraft stops short of a runway: a bar across the taxiway. */
export interface AirfieldHoldingPosition {
    /** `[lat, lon]` from one taxiway edge to the other. */
    points: number[][];
    /** OSM `holding_position:type`; `runway` where untagged. */
    kind: string;
    ref?: string;
}

/** A stand: its lead-in line where mapped as a way, else its point. */
export interface AirfieldParkingPosition {
    /** `[lat, lon]` along the lead-in line. */
    points?: number[][];
    lat?: number;
    lon?: number;
    ref?: string;
}

export interface AirfieldJetBridge {
    /** `[lat, lon]` along the tube, terminal end first as OSM draws it. */
    points: number[][];
    widthM: number;
}

export interface AirfieldWindsock {
    lat: number;
    lon: number;
    lit: boolean;
}

export interface AirfieldNavigationAid {
    lat: number;
    lon: number;
    /** OSM `navigationaid`, lower case: only the slope indicators, `papi`, `apapi` and `vasi`, are baked. */
    type: string;
    /** The runway it serves and that runway's heading; absent beside none. */
    runway?: string;
    headingDeg?: number;
}

/** An earth bank - a revetment round a hardstand, a blast wall - drawn as a berm. */
export interface AirfieldEmbankment {
    /** `[lat, lon]` along the crest; a closed ring repeats its first point. */
    points: number[][];
    /** OSM `height`, where tagged believably; the renderer has a default. */
    heightM?: number;
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
 * The airfield's pavement surface: height above MSL at an (e, n) point of the
 * frame `toEnu` maps into, built from the airfield's own pads.
 *
 * The same pads the terrain was laid on (each runway and taxiway on its own
 * graded profile, each apron on its own plane), folded in the order the
 * terrain applies them, so a runway drawn or made solid on this is on the
 * ground under it by construction. Outside every pad it is the primary
 * runway's centre height.
 */
export function airfieldSurface(
    airfield: Airfield, toEnu: (lat: number, lon: number) => { e: number; n: number },
): (e: number, n: number) => number {
    const pads = airfield.pads.map(p => padFromRecord(p, toEnu));
    const grid = new PadGrid(pads);
    return (e, n) => {
        let h = NaN;
        for (const pad of grid.at(e, n) ?? []) {
            h = applyFlattenPad(h, e, n, pad);
        }
        return Number.isFinite(h) ? h : airfield.plane.heightMsl;
    };
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
