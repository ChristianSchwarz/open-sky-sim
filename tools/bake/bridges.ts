/**
 * Procedural bridge plans: from a mapped span and the ground under it, the
 * deck's height profile and where its piers (Stützpfeiler) stand.
 *
 * Pure geometry in tile-local metres (x east, z south, y up) with the ground
 * injected as a sampler, so it is tested on synthetic valleys and the bake
 * hands it the drawn facets. Nothing here writes a file or builds a mesh;
 * the plan is what a mesh builder extrudes.
 *
 * Rules, in the order they bind:
 *  1. The deck starts and ends at the ground height under its two end
 *     nodes - the height of the road that meets it - and runs between them
 *     in one straight grade. It adapts to those heights; nothing lifts it into
 *     a hump over water or drops it into a ramp.
 *  2. Where the ground stands above that line the deck rides up over it, but
 *     by no more than RIDE_CAP_M; a mound taller than that is passed through,
 *     as a road cuts through a dyke. If the two end heights disagree by more
 *     than a road could climb (a tile-edge skirt read as ground), the end
 *     farther from the span's median ground is taken as bad and follows the
 *     other. It never sits in water (WATER_FREEBOARD_M above the
 *     surface), and clears another road it crosses by CLEARANCE_M when the
 *     caller knows of one. `maxheight` is never used - it limits vehicles on
 *     the bridge, not the space under it.
 *  3. Piers stand about every PIER_SPACING_M along the span, evenly, on the
 *     ground or river bed under them - in the water where the span crosses
 *     it - except where the deck is on an embankment (under PIER_MIN_HEIGHT_M
 *     over the ground).
 */

export const STRUCTURES = [
    'slab', 'beam', 'arch', 'truss', 'cable_stayed', 'suspension', 'floating', 'tunnel',
] as const;
export type Structure = typeof STRUCTURES[number];

export interface XZ {
    x: number;
    z: number;
}

export interface BridgeSpan {
    structure: Structure;
    deckWidthM: number;
    layer: number;
    /** Mapped centreline, tile-local metres, two points or more. */
    points: XZ[];
}

export interface BridgeGround {
    /** Ground height under (x, z). */
    groundY(x: number, z: number): number;
    /** Water surface height at (x, z), or undefined on land. */
    waterY?(x: number, z: number): number | undefined;
    /** Top of another road or rail the deck must pass over, or undefined. */
    obstacleY?(x: number, z: number): number | undefined;
}

export interface Station {
    /** Distance along the centreline, metres. */
    s: number;
    x: number;
    z: number;
    groundY: number;
    deckY: number;
    inWater: boolean;
}

export interface Pier {
    x: number;
    z: number;
    /** Underside of the deck structure. */
    topY: number;
    /** Footing bottom, sunk into the ground. */
    baseY: number;
    widthM: number;
    /** Centreline bearing at the pier, radians, so the pier lines up with the deck. */
    heading: number;
}

export interface BridgePlan {
    structure: Structure;
    deckWidthM: number;
    deckThicknessM: number;
    stations: Station[];
    piers: Pier[];
    lengthM: number;
    /** How far the deck end stands above the ground at each abutment, metres. */
    abutmentLiftM: [number, number];
    /** Stations where the deck ended up at or below ground; must be 0. */
    buried: number;
}

/** Metres between profile stations. */
export const STATION_STEP_M = 8;
/** Clearance over another road or rail the caller says the deck crosses. */
export const CLEARANCE_M = 5.5;
/** How far above the water surface a deck is kept, so it never sits in the water sheet. */
export const WATER_FREEBOARD_M = 0.3;
/** Most a deck rises over its straight line to ride over a mound in the ground. */
export const RIDE_CAP_M = 1.5;
/**
 * Two end heights further apart than this grade over the span, plus the
 * slack, are not a road: one of them is a bad read.
 */
export const MAX_END_GRADE = 0.15;
export const END_GRADE_SLACK_M = 2;
/** Supports stand about this far apart along a span (an even whole number of bays). */
export const PIER_SPACING_M = 50;
/** A joint where the deck is less than this over the ground is on an embankment: no pier. */
export const PIER_MIN_HEIGHT_M = 2;
export const FOOTING_M = 1.5;
/** A pier in water stands at least this far below the surface, whatever the mesh's bed says. */
export const WATER_PIER_DEPTH_M = 3;

const DECK_THICKNESS_M: Record<Structure, number> = {
    slab: 0.6, beam: 1.4, arch: 1.0, truss: 2.5,
    cable_stayed: 1.8, suspension: 1.8, floating: 0.8, tunnel: 0,
};

/**
 * Structures carried on intermediate piers. Cable-stayed and suspension spans
 * hang from towers that are not built, a floating bridge rides on pontoons and
 * a tunnel has no deck, so none of those get piers.
 */
const PIER_STRUCTURES: ReadonlySet<Structure> = new Set<Structure>(['slab', 'beam', 'arch', 'truss']);

/** Walk the polyline at a fixed step, returning positions and cumulative length. */
export function resample(points: readonly XZ[], step: number): { pts: XZ[]; s: number[]; headings: number[] } {
    const pts: XZ[] = [];
    const s: number[] = [];
    const headings: number[] = [];
    let total = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len === 0) {
            continue;
        }
        const heading = Math.atan2(b.x - a.x, -(b.z - a.z));
        const n = Math.max(1, Math.round(len / step));
        for (let k = 0; k < n; k++) {
            const t = k / n;
            pts.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
            s.push(total + len * t);
            headings.push(heading);
        }
        total += len;
    }
    const last = points[points.length - 1];
    pts.push({ x: last.x, z: last.z });
    s.push(total);
    headings.push(headings.length > 0 ? headings[headings.length - 1] : 0);
    return { pts, s, headings };
}

export function planBridge(span: BridgeSpan, ground: BridgeGround): BridgePlan | undefined {
    if (span.points.length < 2) {
        return undefined;
    }
    const { pts, s, headings } = resample(span.points, STATION_STEP_M);
    const n = pts.length;
    if (n < 2) {
        return undefined;
    }
    const g = pts.map(p => ground.groundY(p.x, p.z));
    const water = pts.map(p => ground.waterY?.(p.x, p.z));
    const obstacle = pts.map(p => ground.obstacleY?.(p.x, p.z));

    // The deck is the straight grade between the ground heights at its two
    // ends. The ends are abutments on the bank, so an end node that falls in
    // the shore's water facet still takes the ground height, not the water's.
    const total = s[n - 1];
    let start = g[0];
    let end = g[n - 1];
    if (Math.abs(end - start) > MAX_END_GRADE * total + END_GRADE_SLACK_M) {
        const sorted = [...g].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (Math.abs(start - median) <= Math.abs(end - median)) {
            end = start;
        } else {
            start = end;
        }
    }
    const deck = new Array<number>(n);
    deck[0] = start;
    deck[n - 1] = end;
    for (let i = 1; i < n - 1; i++) {
        const t = total > 0 ? s[i] / total : 0;
        const line = start + (end - start) * t;
        // Rides a mound up to the cap, never in the water, and over a road it is told of.
        let need = Math.min(Math.max(line, g[i]), line + RIDE_CAP_M);
        if (water[i] !== undefined) {
            need = Math.max(need, water[i]! + WATER_FREEBOARD_M);
        }
        if (obstacle[i] !== undefined) {
            need = Math.max(need, obstacle[i]! + CLEARANCE_M);
        }
        deck[i] = need;
    }

    const stations: Station[] = pts.map((p, i) => ({
        s: s[i], x: p.x, z: p.z, groundY: g[i], deckY: deck[i], inWater: water[i] !== undefined,
    }));
    const thickness = DECK_THICKNESS_M[span.structure];
    let buried = 0;
    for (const st of stations) {
        if (st.deckY < st.groundY - 1e-6) {
            buried++;
        }
    }

    return {
        structure: span.structure,
        deckWidthM: span.deckWidthM,
        deckThicknessM: thickness,
        stations,
        piers: span.structure === 'tunnel' ? [] : placePiers(span, stations, headings, thickness, ground),
        lengthM: total,
        abutmentLiftM: [deck[0] - g[0], deck[n - 1] - g[n - 1]],
        buried,
    };
}

/**
 * Supports at an even spacing of about PIER_SPACING_M along the span: the
 * span is split into the whole number of equal bays nearest that length, and
 * a pier stands at each joint between bays. Each takes the exact ground (or
 * river bed) height under it, and stands in the water where the span crosses
 * it. A joint where the deck is less than PIER_MIN_HEIGHT_M over the ground is
 * a deck on an embankment and gets none.
 */
function placePiers(
    span: BridgeSpan, stations: Station[], headings: number[], thickness: number, ground: BridgeGround,
): Pier[] {
    if (!PIER_STRUCTURES.has(span.structure)) {
        return [];
    }
    const total = stations[stations.length - 1].s;
    const bays = Math.round(total / PIER_SPACING_M);
    if (bays < 2) {
        return [];
    }
    const piers: Pier[] = [];
    const widthM = Math.min(Math.max(span.deckWidthM * 0.4, 1.2), 5);
    let k = 1;
    for (let j = 1; j < bays; j++) {
        const at = total * j / bays;
        while (k < stations.length - 1 && stations[k].s < at) {
            k++;
        }
        const a = stations[k - 1], b = stations[k];
        const t = b.s > a.s ? (at - a.s) / (b.s - a.s) : 0;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const deckY = a.deckY + (b.deckY - a.deckY) * t;
        // Over water the mesh often has only the water sheet and no bed under it,
        // so the "ground" there is the surface: a pier stands at least
        // WATER_PIER_DEPTH_M below the surface, or on the bed where that is deeper.
        const water = ground.waterY?.(x, z);
        const groundY = water === undefined
            ? ground.groundY(x, z)
            : Math.min(ground.groundY(x, z), water - WATER_PIER_DEPTH_M);
        if (deckY - groundY < PIER_MIN_HEIGHT_M) {
            continue;
        }
        piers.push({
            x, z,
            topY: deckY - thickness,
            baseY: groundY - FOOTING_M,
            widthM,
            heading: headings[k],
        });
    }
    return piers;
}
