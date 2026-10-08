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
 *     in one straight grade, a fall at most. It adapts to those heights and
 *     is never humped or ramped inside the span.
 *  2. What the deck has to clear moves the whole line up in parallel, ends
 *     included: open water (WATER_FREEBOARD_M above the surface) and another
 *     road it crosses (CLEARANCE_M under the deck; see spanCrossings for
 *     what counts as crossing). Ground that stands above
 *     the line is not ridden over: the deck passes through it, as a road cuts
 *     through a dyke. If the two end heights disagree by more than a road
 *     could climb (a tile-edge skirt read as ground), the end farther from the
 *     span's median ground is taken as bad and follows the other. `maxheight`
 *     is never used - it limits vehicles on the bridge, not the space under it.
 *  3. Piers stand about every PIER_SPACING_M along the span, evenly, on the
 *     ground or river bed under them - in the water where the span crosses
 *     it - except where the deck is on an embankment (under PIER_MIN_HEIGHT_M
 *     over the ground). Never on a road or a track under the span: such a
 *     pier moves along the span to free ground, or is left out.
 *  4. The ends run parallel to the road or track the span crosses nearest
 *     each (endSkews): a skew bridge's abutments, not square to the deck. A
 *     pier beside a road or a track stands parallel to it too.
 */

import { BridgeRole } from '../../src/script/terrain/pbr';
import { bedRank } from '../../src/script/terrain/railBed';

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
    /**
     * Steepest the deck may run when its ends are lifted unevenly for
     * clearance (its line's tier, railBed.ts BED_TIERS); STREET_DECK_GRADE
     * when absent.
     */
    maxGrade?: number;
}

export interface BridgeGround {
    /** Ground height under (x, z). */
    groundY(x: number, z: number): number;
    /** Water surface height at (x, z), or undefined on land. */
    waterY?(x: number, z: number): number | undefined;
    /** Top of another road or rail the deck must pass over, or undefined. */
    obstacleY?(x: number, z: number): number | undefined;
    /**
     * Measured heights of the road at the two ends (lidar: the approach's
     * own embankment, which the 30 m ground under the end node does not
     * see), first point's end first; undefined where unmeasured. A measured
     * end is taken as it is, never as a bad read.
     */
    endY?: readonly [number | undefined, number | undefined];
    /**
     * Whether a footprint of radius `r` at (x, z) would stand on a road or a
     * track (another line under the span); no pier stands there.
     */
    onRoad?(x: number, z: number, r: number): boolean;
    /** The direction (unit, plan) of the road or track nearest (x, z) within `r`, if any: a pier there stands parallel to it. */
    roadDirAt?(x: number, z: number, r: number): [number, number] | undefined;
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
    /**
     * The line its width runs along, unit, plan: parallel to the road or
     * track beside it (alignedAcross). Square across the deck where absent.
     */
    across?: [number, number];
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
    /** What the deck top is drawn as; a road surface when absent. */
    deckRole?: BridgeRole;
    /** Piers moved along the span off a road under their joint, and left out for one. */
    piersOffRoads?: { moved: number; dropped: number };
    /**
     * The line each end (first station's, last's) runs along, unit, plan:
     * parallel to the road or track the span crosses nearest that end (a
     * skew bridge's abutment). Square across the deck where absent.
     */
    endSkew?: [[number, number] | undefined, [number, number] | undefined];
    /**
     * Stretches (distance along, metres) where a side - 1 the left (+across),
     * -1 the right - is joined to a bridge beside it and has no parapet
     * (bridgeJoin.ts).
     */
    openSides?: Array<{ side: 1 | -1; s0: number; s1: number }>;
}

/** Metres between profile stations. */
export const STATION_STEP_M = 8;
/**
 * Clear height, metres, between another road's surface and the underside of a
 * deck that crosses it. The deck's own thickness comes on top of this.
 */
export const CLEARANCE_M = 5;
/** How far above the water surface a deck is kept, so it never sits in the water sheet. */
export const WATER_FREEBOARD_M = 0.3;
/**
 * Two end heights further apart than this grade over the span, plus the
 * slack, are not a road: one of them is a bad read.
 */
export const MAX_END_GRADE = 0.15;
export const END_GRADE_SLACK_M = 2;
/** A span without a tier may be tilted to this grade for clearance (railBed.ts's street tier). */
export const STREET_DECK_GRADE = 0.10;
/**
 * Lifting a measured end costs this many times lifting an unmeasured one:
 * the lidar knows where that approach is, the other end is a guess.
 */
const MEASURED_END_COST = 10;
/** Supports stand about this far apart along a span (an even whole number of bays). */
export const PIER_SPACING_M = 50;
/** How far off a road's or a track's edge a pier keeps, metres. */
export const PIER_ROAD_CLEAR_M = 1;
/** A pier with a road's or a track's centreline this near stands parallel to it, metres. */
export const PIER_ALIGN_REACH_M = 15;
/** A pier on a road is moved along the span in these steps to find free ground, metres. */
const PIER_SHIFT_STEP_M = 1;
/** ... at most this share of a bay either way, so it never meets its neighbours. */
const PIER_SHIFT_SHARE = 0.4;
/** A joint where the deck is less than this over the ground is on an embankment: no pier. */
export const PIER_MIN_HEIGHT_M = 2;
export const FOOTING_M = 1.5;
/** A pier in water stands at least this far below the surface, whatever the mesh's bed says. */
export const WATER_PIER_DEPTH_M = 3;

export const DECK_THICKNESS_M: Record<Structure, number> = {
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
    const measuredA = ground.endY?.[0], measuredB = ground.endY?.[1];
    let start = measuredA ?? g[0];
    let end = measuredB ?? g[n - 1];
    if (measuredA !== undefined || measuredB !== undefined) {
        // An unmeasured end that disagrees with a measured one follows it.
        if (Math.abs(end - start) > MAX_END_GRADE * total + END_GRADE_SLACK_M) {
            if (measuredA === undefined) {
                start = end;
            } else if (measuredB === undefined) {
                end = start;
            }
        }
    } else if (Math.abs(end - start) > MAX_END_GRADE * total + END_GRADE_SLACK_M) {
        const sorted = [...g].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (Math.abs(start - median) <= Math.abs(end - median)) {
            end = start;
        } else {
            start = end;
        }
    }
    // A bridge is a straight deck, with at most a fall between its ends. What
    // the deck has to clear - open water, a road it crosses - lifts its ends
    // (an abutment on a fill), never a hump in the middle: as little as it
    // takes in all (liftEnds), tilting the deck within its grade rather than
    // raising the end that needs no help. A mound in the ground is not ridden
    // over: the deck passes through it.
    const thickness = DECK_THICKNESS_M[span.structure];
    const offRoads = { moved: 0, dropped: 0 };
    // Water is checked between the ends only: they are abutments on the
    // bank. A road under the deck at every station, ends included - a span
    // under 12 m has no other, and a 12 m bridge over a road was laid on it.
    const t = s.map(v => (total > 0 ? v / total : 0));
    const need = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
        const line = start + (end - start) * t[i];
        if (water[i] !== undefined && i > 0 && i < n - 1) {
            need[i] = Math.max(need[i], water[i]! + WATER_FREEBOARD_M - line);
        }
        if (obstacle[i] !== undefined) {
            need[i] = Math.max(need[i], obstacle[i]! + CLEARANCE_M + thickness - line);
        }
    }
    const [dA, dB] = liftEnds(t, need, end - start, (span.maxGrade ?? STREET_DECK_GRADE) * total, [
        measuredA !== undefined && measuredB === undefined ? MEASURED_END_COST : 1,
        measuredB !== undefined && measuredA === undefined ? MEASURED_END_COST : 1,
    ]);
    const deck = pts.map((_, i) => start + dA + (end + dB - start - dA) * t[i]);

    const stations: Station[] = pts.map((p, i) => ({
        s: s[i], x: p.x, z: p.z, groundY: g[i], deckY: deck[i], inWater: water[i] !== undefined,
    }));
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
        piers: span.structure === 'tunnel' ? [] : placePiers(span, stations, headings, thickness, ground, offRoads),
        lengthM: total,
        abutmentLiftM: [deck[0] - g[0], deck[n - 1] - g[n - 1]],
        buried,
        piersOffRoads: offRoads,
    };
}

/**
 * How far to lift a deck's two ends so the straight line between them clears
 * every station: `need[i]` is how far station i (at fraction `t[i]` along the
 * span) is short of what it must clear, and lifting the ends by (dA, dB)
 * raises it by dA (1 - t) + dB t. The cheapest lift by `cost` (per metre at
 * each end) whose deck still runs no steeper than `riseLimit` over the span
 * (or as steep as `rise`, the fall it already has, if that is more); a tie
 * goes to lifting both alike. Where no tilt fits the grade, the whole line
 * goes up in parallel.
 */
export function liftEnds(
    t: readonly number[], need: readonly number[], rise: number, riseLimit: number, cost: readonly [number, number],
): [number, number] {
    let parallel = 0, minA = 0, minB = 0, maxA = 0;
    for (let i = 0; i < t.length; i++) {
        if (need[i] <= 0) {
            continue;
        }
        parallel = Math.max(parallel, need[i]);
        if (t[i] <= 1e-9) {
            minA = Math.max(minA, need[i]);
        } else if (t[i] >= 1 - 1e-9) {
            minB = Math.max(minB, need[i]);
        }
        maxA = Math.max(maxA, need[i] / Math.max(1 - t[i], 1e-3));
    }
    if (parallel <= 0) {
        return [0, 0];
    }
    const allowed = Math.max(riseLimit, Math.abs(rise));
    // The least dB for a given dA: every station clear, the deck no steeper than allowed.
    const dBFor = (dA: number) => {
        let dB = Math.max(minB, dA - allowed - rise, 0);
        for (let i = 0; i < t.length; i++) {
            if (need[i] > 0 && t[i] > 1e-9) {
                dB = Math.max(dB, (need[i] - dA * (1 - t[i])) / t[i]);
            }
        }
        return dB;
    };
    const tooSteep = (dA: number, dB: number) => Math.max(0, rise + dB - dA - allowed);
    // Convex in dA (a max of linear pieces), so a ternary search finds the least.
    const total = (dA: number) => {
        const dB = dBFor(dA);
        return cost[0] * dA + cost[1] * dB + 1e3 * tooSteep(dA, dB);
    };
    let lo = minA, hi = Math.max(minA, Math.min(maxA, parallel + allowed + Math.abs(rise)));
    for (let k = 0; k < 100 && hi - lo > 1e-4; k++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (total(m1) <= total(m2)) {
            hi = m2;
        } else {
            lo = m1;
        }
    }
    // The least is often right at the bound (the start left alone): take it exactly.
    const found = (lo + hi) / 2;
    const dA = total(minA) <= total(found) + 1e-6 ? minA : found, dB = dBFor(dA);
    const parallelCost = (cost[0] + cost[1]) * parallel;
    if (tooSteep(dA, dB) > 1e-3 || cost[0] * dA + cost[1] * dB >= parallelCost - 1e-3) {
        return [parallel, parallel];
    }
    return [dA, dB];
}

/**
 * Supports at an even spacing of about PIER_SPACING_M along the span: the
 * span is split into the whole number of equal bays nearest that length, and
 * a pier stands at each joint between bays. Each takes the exact ground (or
 * river bed) height under it, and stands in the water where the span crosses
 * it. A joint where the deck is less than PIER_MIN_HEIGHT_M over the ground is
 * a deck on an embankment and gets none. A pier never stands on a road or a
 * track (BridgeGround.onRoad): one that would is moved along the span to the
 * nearest free ground within PIER_SHIFT_SHARE of a bay, or left out, the
 * deck spanning on.
 */
function placePiers(
    span: BridgeSpan, stations: Station[], headings: number[], thickness: number, ground: BridgeGround,
    offRoads: { moved: number; dropped: number },
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
    // Half the pier's diagonal: it stands square to the deck, widthM a side.
    const radius = widthM * Math.SQRT1_2 + PIER_ROAD_CLEAR_M;
    const where = (at: number) => {
        let k = 1;
        while (k < stations.length - 1 && stations[k].s < at) {
            k++;
        }
        const a = stations[k - 1], b = stations[k];
        const t = b.s > a.s ? (at - a.s) / (b.s - a.s) : 0;
        return { k, x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, deckY: a.deckY + (b.deckY - a.deckY) * t };
    };
    const shiftMax = (total / bays) * PIER_SHIFT_SHARE;
    for (let j = 1; j < bays; j++) {
        const joint = total * j / bays;
        let spot: ReturnType<typeof where> | undefined;
        for (let d = 0; d <= shiftMax && !spot; d += PIER_SHIFT_STEP_M) {
            for (const at of d === 0 ? [joint] : [joint - d, joint + d]) {
                const w = where(at);
                if (!ground.onRoad?.(w.x, w.z, radius)) {
                    spot = w;
                    break;
                }
            }
        }
        if (!spot) {
            offRoads.dropped++;
            continue;
        }
        if (spot.x !== where(joint).x || spot.z !== where(joint).z) {
            offRoads.moved++;
        }
        const { k, x, z, deckY } = spot;
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
        // Beside a road or a track it stands parallel to it, like the abutments.
        const dir = ground.roadDirAt?.(x, z, PIER_ALIGN_REACH_M);
        const across = dir ? alignedAcross(Math.sin(headings[k]), -Math.cos(headings[k]), dir, (MAX_SKEW_DEG * Math.PI) / 180) : undefined;
        piers.push({
            x, z,
            topY: deckY - thickness,
            baseY: groundY - FOOTING_M,
            widthM,
            heading: headings[k],
            ...(across ? { across } : {}),
        });
    }
    return piers;
}

/** Another road's centreline near a span, tile-local metres, and its half width. */
export interface NearbyRoad {
    points: readonly XZ[];
    half: number;
}

/**
 * Roads crossing a span this close to either of its ends are its own
 * junction with the ground, metres; a quarter of a shorter span, whose road
 * under it crosses in the middle (a 24 m bridge over a road had no middle
 * left at 12 m from each end).
 */
export const END_ZONE_M = 12;
const END_ZONE_SHARE = 0.25;
/** Spare width beyond a crossing road's half width in which the deck counts as over it, metres. */
export const CROSS_MARGIN_M = 1.5;
/** Shallower than this (sine of the angle) two lines are one line: no crossing point to speak of. */
const PARALLEL_SIN = 0.05;
/**
 * A road that stops just short of the span's centreline crosses it at no
 * shallower than this (about 20 degrees); shallower, it is a slip road
 * leaving the span's end.
 */
export const MIN_CROSSING_SIN = 0.34;
/**
 * Most of a span one crossing claims either side of where it crosses,
 * metres: a road crossing at 3 degrees is under the deck for 100 m, and the
 * deck is lifted over it whatever the length.
 */
const MAX_CROSSING_REACH_M = 60;
/**
 * Least, so a station always falls inside it: the profile is checked at
 * stations up to 1.5 STATION_STEP_M apart (a span segment under 12 m is one
 * step), its ends included.
 */
const MIN_CROSSING_REACH_M = 0.75 * STATION_STEP_M + 0.5;

/** Where a road passes under a span: along the span, the crossing point, and how far either side the deck is over it. */
export interface SpanCrossing {
    along: number;
    x: number;
    z: number;
    reach: number;
    /** The crossing road's direction there, unit, plan. */
    dir: [number, number];
}

/**
 * The roads a span crosses, away from its ends: those whose centreline cuts
 * the span's, at any angle - a road crossing at 17 degrees under a slip
 * road's bridge was once taken for an approach running along it, and the
 * deck lay on the ground across it; a slip road leaving the span's end meets
 * the centreline only at that end. And those that stop within their own half
 * width of it, at MIN_CROSSING_SIN or steeper: the stretch under a bridge is
 * often mapped as a way the road vectors leave out, so the road ends a few
 * metres short either side.
 */
export function spanCrossings(span: readonly XZ[], roads: readonly NearbyRoad[]): SpanCrossing[] {
    const out: SpanCrossing[] = [];
    const cum = [0];
    for (let j = 0; j + 1 < span.length; j++) {
        cum.push(cum[j] + Math.hypot(span[j + 1].x - span[j].x, span[j + 1].z - span[j].z));
    }
    const total = cum[cum.length - 1];
    const zone = Math.min(END_ZONE_M, END_ZONE_SHARE * total);
    for (const road of roads) {
        for (let i = 0; i + 1 < road.points.length; i++) {
            const a = road.points[i], b = road.points[i + 1];
            const rx = b.x - a.x, rz = b.z - a.z;
            const rl = Math.hypot(rx, rz);
            if (rl < 1e-6) {
                continue;
            }
            for (let j = 0; j + 1 < span.length; j++) {
                const c = span[j], d = span[j + 1];
                const sx = d.x - c.x, sz = d.z - c.z;
                const sl = cum[j + 1] - cum[j];
                if (sl < 1e-6) {
                    continue;
                }
                const den = rx * sz - rz * sx;
                const sin = Math.abs(den) / (rl * sl);
                if (sin < PARALLEL_SIN) {
                    continue;
                }
                const t = ((c.x - a.x) * sz - (c.z - a.z) * sx) / den;
                const u = ((c.x - a.x) * rz - (c.z - a.z) * rx) / den;
                if (t < 0 || t > 1 || u < 0 || u > 1) {
                    continue;
                }
                // A line cutting it is under the deck however near an end;
                // only one meeting it at the end itself is its junction.
                const along = cum[j] + u * sl;
                const cutZone = Math.min(zone, road.half + CROSS_MARGIN_M);
                if (along < cutZone || along > total - cutZone) {
                    continue;
                }
                out.push({
                    along, x: a.x + rx * t, z: a.z + rz * t,
                    reach: Math.min(MAX_CROSSING_REACH_M, Math.max(MIN_CROSSING_REACH_M, (road.half + CROSS_MARGIN_M) / sin)),
                    dir: [rx / rl, rz / rl],
                });
            }
        }
        // Its two ends, stopping short of the span.
        const n = road.points.length;
        for (const [p, q] of [[road.points[0], road.points[1]], [road.points[n - 1], road.points[n - 2]]]) {
            if (n < 2) {
                break;
            }
            const rl = Math.hypot(p.x - q.x, p.z - q.z);
            if (rl < 1e-6) {
                continue;
            }
            for (let j = 0; j + 1 < span.length; j++) {
                const c = span[j], d = span[j + 1];
                const sx = d.x - c.x, sz = d.z - c.z;
                const sl = cum[j + 1] - cum[j];
                if (sl < 1e-6) {
                    continue;
                }
                const u = Math.min(1, Math.max(0, ((p.x - c.x) * sx + (p.z - c.z) * sz) / (sl * sl)));
                const fx = c.x + sx * u, fz = c.z + sz * u;
                const sin = Math.abs((p.x - q.x) * sz - (p.z - q.z) * sx) / (rl * sl);
                const along = cum[j] + u * sl;
                if (Math.hypot(p.x - fx, p.z - fz) > road.half + CROSS_MARGIN_M || sin < MIN_CROSSING_SIN
                    || along < zone || along > total - zone) {
                    continue;
                }
                out.push({
                    along, x: fx, z: fz,
                    reach: Math.max(MIN_CROSSING_REACH_M, (road.half + CROSS_MARGIN_M) / sin),
                    dir: [(p.x - q.x) / rl, (p.z - q.z) / rl],
                });
            }
        }
    }
    return out;
}

/** An end this near square to the deck is built square, degrees. */
export const MIN_SKEW_DEG = 5;
/** Most an end is turned off square, degrees: past it the abutment runs on along the road. */
export const MAX_SKEW_DEG = 50;
/** Most a skewed end's corner may stand off its end station along the deck, as a share of the span. */
const MAX_SKEW_SHIFT_SHARE = 0.3;
/**
 * ... and in metres: the grading takes deck found past a road's end (within
 * its ROAD_DECK_AHEAD_M, 5 m) for a bridge the road ends under, and would not
 * put the road onto its own deck - a 9 m street's corner 5.4 m out left it
 * 4.7 m under the deck at Garmisch.
 */
const MAX_SKEW_SHIFT_M = 3;

/**
 * The line each end of a span runs along (BridgePlan.endSkew): parallel to
 * the road or track it crosses nearest that end - a skew bridge's abutments
 * stand parallel to the road under it, not square to the deck - turned no
 * further than MAX_SKEW_DEG off square, and no further than keeps the end's
 * corners within MAX_SKEW_SHIFT_SHARE of the span, and MAX_SKEW_SHIFT_M, from
 * its end station.
 * Square (undefined) where it crosses nothing, or nearly square already.
 */
export function endSkews(plan: BridgePlan, crossings: readonly SpanCrossing[]): BridgePlan['endSkew'] {
    const st = plan.stations;
    if (crossings.length === 0 || st.length < 2) {
        return undefined;
    }
    const half = plan.deckWidthM / 2;
    const out: [[number, number] | undefined, [number, number] | undefined] = [undefined, undefined];
    for (const end of [0, 1] as const) {
        const c = crossings.reduce((a, b) => ((end === 0 ? b.along < a.along : b.along > a.along) ? b : a));
        const i = end === 0 ? 0 : st.length - 1;
        const a = st[Math.max(0, i - 1)], b = st[Math.min(st.length - 1, i + 1)];
        const tl = Math.hypot(b.x - a.x, b.z - a.z);
        if (tl < 1e-9) {
            continue;
        }
        const tx = (b.x - a.x) / tl, tz = (b.z - a.z) / tl;
        const shift = Math.min(MAX_SKEW_SHIFT_SHARE * plan.lengthM, MAX_SKEW_SHIFT_M);
        const limit = Math.min((MAX_SKEW_DEG * Math.PI) / 180, Math.atan(shift / Math.max(half, 1e-6)));
        out[end] = alignedAcross(tx, tz, c.dir, limit);
    }
    return out[0] || out[1] ? out : undefined;
}

/**
 * A line across a deck heading (tx, tz) turned parallel to `dir` (a road's
 * line, unit, plan), pointing the way the deck's left side does: no further
 * than `limit` radians off square, and undefined - square - when it is
 * within MIN_SKEW_DEG of square already.
 */
export function alignedAcross(tx: number, tz: number, dir: readonly [number, number], limit: number): [number, number] | undefined {
    const px = -tz, pz = tx;
    let [ex, ez] = dir;
    if (ex * px + ez * pz < 0) {
        ex = -ex;
        ez = -ez;
    }
    // Its angle off square: towards the deck's own direction (+) or against it.
    let skew = Math.atan2(ex * tx + ez * tz, ex * px + ez * pz);
    if (Math.abs(skew) < (MIN_SKEW_DEG * Math.PI) / 180) {
        return undefined;
    }
    skew = Math.max(-limit, Math.min(limit, skew));
    return [px * Math.cos(skew) + tx * Math.sin(skew), pz * Math.cos(skew) + tz * Math.sin(skew)];
}

/**
 * BridgeGround.obstacleY for a span over some crossings: within a crossing's
 * reach along the span, the ground height where the road crosses.
 */
export function crossingObstacle(
    span: readonly XZ[], crossings: readonly SpanCrossing[], groundAt: (x: number, z: number) => number | undefined,
): ((x: number, z: number) => number | undefined) | undefined {
    if (crossings.length === 0) {
        return undefined;
    }
    const tops = crossings.map(c => groundAt(c.x, c.z));
    return (x, z) => {
        // Where along the span this point is.
        let bestD = Infinity, along = 0, run = 0;
        for (let i = 0; i + 1 < span.length; i++) {
            const a = span[i], b = span[i + 1];
            const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
            const l = Math.sqrt(l2);
            const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
            const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
            if (d < bestD) {
                bestD = d;
                along = run + t * l;
            }
            run += l;
        }
        let top: number | undefined;
        crossings.forEach((c, i) => {
            const h = tops[i];
            if (h !== undefined && Math.abs(along - c.along) <= c.reach && (top === undefined || h > top)) {
                top = h;
            }
        });
        return top;
    };
}

/**
 * Whose bridge lifts clear of whom where two lines cross, by tier
 * (BED_TIERS): a span clears the lines of its own rank or higher and leaves
 * the lower ones to dip under it. The grading's ranks (bedRank): railways
 * and Autobahns are peers, neither dug down under the other's bridge -
 * whichever one OSM has as the bridge goes over the other. Both outrank
 * highways and streets.
 */
export function bridgeRank(tier: number): number {
    return tier < 0 ? tier : bedRank(tier);
}

/** A deck end standing this far over a junction beyond it is checked for coming down to it in time, metres. */
export const JUNCTION_LIFT_M = 1.5;
/** A road's vertex this near another road's is the two meeting, metres. */
const JUNCTION_NODE_M = 1.5;
/** A road leaving a deck end within this angle of the span's line carries it on (not a junction there), degrees. */
const JUNCTION_ON_DEG = 30;

/** A junction beyond a span's end: how far along the road carrying it on, where, and which road meets it there (and at which of its vertices). */
export interface EndJunction {
    d: number;
    at: XZ;
    road: number;
    vertex: number;
}

/**
 * The junctions beyond each end of a span, up to `within` metres along the
 * road carrying it on: every vertex of that road another road shares (one
 * within JUNCTION_NODE_M), and - at 0 m - another road leaving the end itself
 * sideways. `span` and `roads` are plan polylines. Every road in the vectors
 * is at ground level, so each is a height the road must come down to: graded
 * to both, the road fell 4-5 m in 5-10 m beyond a Munich street's deck over a
 * trunk road (48.130, 11.529).
 */
export function endJunctions(
    span: readonly XZ[], roads: ReadonlyArray<readonly XZ[]>, within: number,
): [EndJunction[], EndJunction[]] {
    const CELL = 8;
    const grid = new Map<string, Array<[number, number]>>();
    roads.forEach((pts, ri) => pts.forEach((p, vi) => {
        const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push([ri, vi]);
    }));
    /** Roads with a vertex within `r` of (x, z), and which vertex. */
    const at = (x: number, z: number, r: number): Array<[number, number]> => {
        const out: Array<[number, number]> = [];
        for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
            for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
                for (const [ri, vi] of grid.get(`${cx},${cz}`) ?? []) {
                    const p = roads[ri][vi];
                    if (Math.hypot(p.x - x, p.z - z) <= r) {
                        out.push([ri, vi]);
                    }
                }
            }
        }
        return out;
    };
    const out: [EndJunction[], EndJunction[]] = [[], []];
    if (span.length < 2) {
        return out;
    }
    for (const e of [0, 1] as const) {
        const end = span[e === 0 ? 0 : span.length - 1], inner = span[e === 0 ? 1 : span.length - 2];
        const ol = Math.hypot(end.x - inner.x, end.z - inner.z) || 1;
        const ox = (end.x - inner.x) / ol, oz = (end.z - inner.z) / ol;
        // The roads leaving the end: on along the span's line, or off it (a junction right there).
        let carry: { ri: number; vi: number; dir: number } | undefined;
        for (const [ri, vi] of at(end.x, end.z, JUNCTION_NODE_M)) {
            const pts = roads[ri];
            for (const dir of [-1, 1]) {
                const nb = pts[vi + dir];
                if (!nb) {
                    continue;
                }
                const dl = Math.hypot(nb.x - pts[vi].x, nb.z - pts[vi].z) || 1;
                const cos = ((nb.x - pts[vi].x) * ox + (nb.z - pts[vi].z) * oz) / dl;
                if (cos >= Math.cos((JUNCTION_ON_DEG * Math.PI) / 180)) {
                    carry ??= { ri, vi, dir };
                } else if (cos > -0.5 && !out[e].some(j => j.road === ri)) {
                    // Another road leaving the deck's end sideways: a junction at the end itself.
                    out[e].push({ d: 0, at: end, road: ri, vertex: vi });
                }
            }
        }
        if (!carry) {
            continue;
        }
        // Along the carrying road, its vertices out to `within`: another road there is a junction.
        const pts = roads[carry.ri];
        let vi = carry.vi, run = 0;
        while (pts[vi + carry.dir]) {
            run += Math.hypot(pts[vi + carry.dir].x - pts[vi].x, pts[vi + carry.dir].z - pts[vi].z);
            vi += carry.dir;
            if (run > within) {
                break;
            }
            const other = at(pts[vi].x, pts[vi].z, JUNCTION_NODE_M).find(([o]) => o !== carry!.ri);
            if (other) {
                out[e].push({ d: run, at: pts[vi], road: other[0], vertex: other[1] });
            }
        }
    }
    return out;
}
