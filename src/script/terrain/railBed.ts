/**
 * Railway beds laid into the terrain at runtime: no track steeper than
 * RAIL_MAX_GRADE.
 *
 * A track stroke is draped over the drawn mesh, so it climbs every bump the
 * DEM has: in the Alps a third of the track came out steeper than 3 % and
 * some of it past 100 %. A railway is not built like that. It runs on a
 * graded bed, on an embankment where the ground falls away below that line
 * and in a cutting where it rises above it.
 *
 * When a tile and its track strokes are both resident, this (in a worker,
 * see railBedWorker.ts):
 *
 *   1. reads each track out of the stroke sidecar as a chain of points;
 *   2. fits it a profile no steeper than the limit, staying as close to the
 *      tile's ground as that allows (a dynamic programme over quantised
 *      heights; the ends and level crossings held to the ground, so tile
 *      borders, bridge ends and roads still meet it);
 *   3. refines the terrain triangles that profile has to move - only those,
 *      by conforming longest-edge bisection, so no crack opens - finer in
 *      the bed than on the slopes beside it;
 *   4. moves their vertices onto the bed and its 1:2 batters, and the track
 *      stroke onto the profile.
 *
 * The land mesh is a triangle soup. Triangles that are not refined keep
 * their slot (a refined one becomes degenerate in place, its pieces go on
 * the end), and triangles holding a border vertex are never touched, so the
 * seam stitcher's vertex indices stay good. Pure: nothing here knows about
 * three.js.
 *
 * Every length here is for a z12 leaf; a coarser tile scales them by its
 * size (RailBedInput.scale), so its profile has as many samples per tile
 * edge and it refines no finer than its own detail shows.
 */

import {
    PtrTile, ROAD_CLASS_MASK, TRACK_FLAG_CROSSING, isRailClass, isZoneClass,
} from './ptr';

/** Steepest a railway may climb. */
export const RAIL_MAX_GRADE = 0.03;
/** Spacing of the profile samples, metres. */
const PROFILE_STEP_M = 5;
/** Height quantum of the profile, metres: 3 quanta per step is exactly 3 %. */
const PROFILE_QUANT_M = 0.05;
/** Bed beyond the track's own half width that stays at track height, metres. */
export const RAIL_SHOULDER_M = 0.8;
/** Batter: metres of height per metre sideways (1:2). */
export const RAIL_BATTER = 0.5;
/** Farthest a batter is carried from the bed's edge, metres. */
export const RAIL_BATTER_REACH_M = 30;
const SHOULDER_M = RAIL_SHOULDER_M;
const BATTER = RAIL_BATTER;
const BATTER_REACH_M = RAIL_BATTER_REACH_M;
/**
 * How far the land may miss its bed target between vertices, metres, at
 * least; FIT_TOLERANCE_LIFT of the strokes' lift when that is more. The
 * strokes float strokeLiftM (about 1.8 m at z12) over the facets, so this
 * much never shows on the track; any tighter costs triangles fast (0.3 m
 * tripled the land of a tile with track up a valley side).
 */
const FIT_TOLERANCE_M = 0.75;
const FIT_TOLERANCE_LIFT = 0.4;
/** Spacing of the points a triangle's fit is checked at, metres. */
const FIT_SAMPLE_M = 2;
/** Edges this short are never split, metres. */
const MIN_EDGE_M = 1.5;
/** Weight of the held samples (chain ends, level crossings) in the fit. */
const HOLD_WEIGHT = 1e4;
/** A drawn track this far off the land is not on it, metres. */
const OFF_LAND_M = 2;
/** Deepest cutting or highest embankment a bed may need, metres. */
const MAX_EARTHWORK_M = 6;
/** Half length of the vertical curve a grade break is rounded into, metres. */
const CURVE_RADIUS_M = 80;
/**
 * Cost of climbing a metre past the limit, against a squared metre of
 * earthworks at one sample: high, so the grade only gives way where the
 * earthworks cap forces it.
 */
const STEEP_COST = 2000;
/** Most triangles one tile may gain. */
const MAX_NEW_TRIANGLES = 120000;
/** Most cells (samples x height states) one profile's programme may hold; past it the quantum grows. */
const MAX_PROFILE_CELLS = 8_000_000;
/** A track end this close to a deck track's end (plan, metres) belongs to that bridge. */
const DECK_SNAP_M = 6;
/** Floats per bed segment in RailBedResult.beds. */
export const RAIL_BED_SEGMENT_FLOATS = 9;

type V3 = [number, number, number];

export interface LandSoup {
    /** Quantised, 3 per vertex, 3 vertices per triangle. */
    positions: Int16Array;
    /** Unit normal / 127 + pad, 4 per vertex. */
    normals: Int8Array;
    /** Cover colour + class, 4 per vertex. */
    attrs: Uint8Array;
}

export interface RailBedInput {
    land: LandSoup;
    /** Metres per quantum of the land and the strokes alike. */
    quantScale: number;
    strokes: PtrTile;
    /** The real vertical, in the tile's axes. */
    up: V3;
    /** How far the strokes float over the surface (drapeRoads.ts strokeLiftM), metres. */
    liftM: number;
    /** Land vertex indices that must not move: the seam stitcher's border. */
    pinned: ReadonlySet<number>;
    /**
     * The tile's size against a z12 leaf's (2^(12 - z)): profile spacing,
     * edge lengths and cells grow by it. 1 when absent.
     */
    scale?: number;
    /**
     * Whether triangles may be split to follow the beds. Off, only the
     * vertices already there move: what a coarse tile wants, seen from
     * kilometres off, where a cutting is a few pixels and every triangle
     * counts against the terrain budget. On when absent.
     */
    refine?: boolean;
    /**
     * The ends of the track drawn on bridge decks (pbr.ts) - this tile's and
     * its neighbours', a deck often starting just across the border from
     * its approach - 3 per end, in this tile's frame, metres (see
     * deckTrackEnds). A track ending at one is held to the deck's height,
     * not the ground's, and its last point put on the deck's first: a deck
     * clears what it crosses, often 4 m above where the approach was
     * draped, and the approach climbs to it on an embankment instead of
     * running into the abutment.
     */
    deckEnds?: Float64Array;
}

export interface RailBedStats {
    chains: number;
    /** Track length, and how much of it was steeper than the limit before, metres. */
    trackM: number;
    steepM: number;
    /** Track left steeper than the limit, where meeting it would take more earthworks than allowed, metres. */
    overLimitM: number;
    trianglesAdded: number;
    verticesMoved: number;
}

export interface RailBedResult {
    /** The land with the beds laid; undefined when no vertex had to move. */
    land?: LandSoup;
    /** The strokes' positions with the track on its profiles (the input is left alone). */
    strokePositions: Int16Array;
    /**
     * The beds, RAIL_BED_SEGMENT_FLOATS per segment: both ends in the tile's
     * own frame at design height (metres), the half width out to where the
     * shoulder starts, the most the bed leaves the ground at either end, and
     * which ends are open (BED_OPEN_A | BED_OPEN_B).
     */
    beds: Float64Array;
    stats: RailBedStats;
}

interface Sample {
    u: number;
    v: number;
    ground: number;
    weight: number;
    h: number;
    /** Drawn well off the land: held, and no bed. */
    off: boolean;
}

/**
 * Lay the beds of every track in `input.strokes` into `input.land`, and put
 * the strokes' rail vertices onto their profiles (in a copy). Undefined when
 * the tile has no track to grade.
 */
export function layRailBeds(input: RailBedInput): RailBedResult | undefined {
    const { land, quantScale: q, strokes, up, liftM } = input;
    const f = Math.max(1, input.scale ?? 1);
    const dims: Dims = {
        step: PROFILE_STEP_M * f,
        quant: PROFILE_QUANT_M * f,
        tolerance: Math.max(FIT_TOLERANCE_M * f, FIT_TOLERANCE_LIFT * liftM),
        sample: FIT_SAMPLE_M * f,
        minEdge: MIN_EDGE_M * f,
        cell: CELL_M * f,
        offLand: Math.max(OFF_LAND_M * f, liftM),
    };
    const frame = planFrame(up);
    const chains = railChains(strokes);
    if (chains.length === 0) {
        return undefined;
    }
    const strokePositions = strokes.positions.slice();
    const decks = deckEnds(input.deckEnds, strokes.quantScale, frame);
    const triCount = land.positions.length / 9;
    const ground = new GroundIndex(land.positions, q, frame, dims.cell);

    // --- profiles ------------------------------------------------------------
    const stats: RailBedStats = { chains: chains.length, trackM: 0, steepM: 0, overLimitM: 0, trianglesAdded: 0, verticesMoved: 0 };
    const beds: BedSegment[] = [];
    const sq = strokes.quantScale;
    for (const chain of chains) {
        const pts = chain.map(vi => {
            const p: V3 = [strokes.positions[vi * 3] * sq, strokes.positions[vi * 3 + 1] * sq, strokes.positions[vi * 3 + 2] * sq];
            const [u, v, h] = frame.toPlan(p);
            return { vi, u, v, h: h - liftM, half: strokes.halfWidths[vi] / 10, hold: (strokes.flags[vi] & TRACK_FLAG_CROSSING) !== 0 };
        });
        for (let i = 1; i < pts.length; i++) {
            const run = Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v);
            stats.trackM += run;
            if (run > 0.5 && Math.abs(pts[i].h - pts[i - 1].h) / run > RAIL_MAX_GRADE + 1e-3) {
                stats.steepM += run;
            }
        }
        // Resampled along the plan length, with the ground under each sample.
        const cum = [0];
        for (let i = 1; i < pts.length; i++) {
            cum.push(cum[i - 1] + Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v));
        }
        const length = cum[cum.length - 1];
        if (length < dims.step) {
            continue;
        }
        const n = Math.max(2, Math.round(length / dims.step) + 1);
        const samples: Sample[] = [];
        let seg = 0;
        for (let k = 0; k < n; k++) {
            const s = (length * k) / (n - 1);
            while (seg < pts.length - 2 && cum[seg + 1] < s) {
                seg++;
            }
            const span = cum[seg + 1] - cum[seg];
            const t = span > 1e-9 ? (s - cum[seg]) / span : 0;
            const a = pts[seg], b = pts[seg + 1];
            const u = a.u + (b.u - a.u) * t, v = a.v + (b.v - a.v) * t;
            const draped = a.h + (b.h - a.h) * t;
            const land = ground.at(u, v) ?? draped;
            // Track not on the land - a viaduct's approach, a stroke over a
            // cliff - stays where it was drawn, with no bed.
            const off = Math.abs(land - draped) > dims.offLand;
            const hold = off || k === 0 || k === n - 1 || (t < 0.5 ? a.hold : b.hold);
            samples.push({ u, v, ground: off ? draped : land, weight: hold ? HOLD_WEIGHT : 1, h: 0, off });
        }
        // The limit, unless that takes more earthworks than a real line
        // would move: a rack railway or a line up a mountainside climbs
        // steeper than 3 %, and there the profile stays within
        // MAX_EARTHWORK_M of the ground, as gentle as that allows.
        const step = length / (n - 1);
        const weights = samples.map(s => s.weight);
        // A track ending on a bridge: held at the deck's height.
        const anchors = [0, pts.length - 1].map(i => nearestDeckEnd(decks, pts[i].u, pts[i].v));
        anchors.forEach((a, end) => {
            if (a) {
                const s = samples[end === 0 ? 0 : n - 1];
                s.ground = a.h - liftM;
                s.weight = HOLD_WEIGHT;
                s.off = false;
            }
        });
        const groundH = samples.map(s => s.ground);
        const graded = gradeProfileWeighted(groundH, weights,
            (RAIL_MAX_GRADE * step) / dims.quant, MAX_EARTHWORK_M, STEEP_COST, groundH, dims.quant);
        // The grade breaks rounded into vertical curves, the dips under
        // them filled and the crests cut as embankments and cuttings. A moving average
        // never steepens a line, so the limit still holds, and the held
        // samples keep their heights. It may take the earthworks a little
        // past their cap; clamping them back would put the kinks back.
        const design = roundGradeBreaks(graded, weights, CURVE_RADIUS_M / step);
        for (let k = 1; k < n; k++) {
            if (Math.abs(design[k] - design[k - 1]) > RAIL_MAX_GRADE * step + dims.quant / 2) {
                stats.overLimitM += step;
            }
        }
        samples.forEach((s, k) => { s.h = design[k]; });
        // The stroke onto its profile, every vertex of the pair.
        for (let i = 0; i < pts.length; i++) {
            const k = Math.min(n - 2, Math.floor((cum[i] / length) * (n - 1)));
            const t = Math.min(1, Math.max(0, (cum[i] / length) * (n - 1) - k));
            const h = samples[k].h + (samples[k + 1].h - samples[k].h) * t;
            const dh = (h - pts[i].h) / sq;
            for (const vi of [pts[i].vi, pts[i].vi + 1]) {
                strokePositions[vi * 3] = clampI16(strokePositions[vi * 3] + up[0] * dh);
                strokePositions[vi * 3 + 1] = clampI16(strokePositions[vi * 3 + 1] + up[1] * dh);
                strokePositions[vi * 3 + 2] = clampI16(strokePositions[vi * 3 + 2] + up[2] * dh);
            }
        }
        // ... and its last point on the deck track's first.
        anchors.forEach((a, end) => {
            if (a) {
                const vi = pts[end === 0 ? 0 : pts.length - 1].vi;
                for (const v of [vi, vi + 1]) {
                    strokePositions.set(a.q, v * 3);
                }
            }
        });
        const half = Math.max(...pts.map(p => p.half));
        for (let k = 0; k + 1 < samples.length; k++) {
            if (samples[k].off || samples[k + 1].off) {
                continue;
            }
            // A bed ends square at a bridge's abutment: rounded, its batter
            // ran on under the span and buried what the bridge crosses.
            const open = (k === 0 && anchors[0] ? BED_OPEN_A : 0)
                | (k + 2 === samples.length && anchors[1] ? BED_OPEN_B : 0);
            beds.push({ a: samples[k], b: samples[k + 1], half, open });
        }
    }
    const bedFloats = bedSegmentFloats(beds, frame);
    if (beds.length === 0) {
        return { strokePositions, beds: bedFloats, stats };
    }
    const bedIndex = new BedIndex(beds, dims.cell);

    // --- the mesh, deduplicated by position for adjacency ---------------------
    const mesh = new SoupMesh(land, q, frame, input.pinned, triCount, dims);
    // Roads keep their ground: a road is drawn on the land as it was baked,
    // so an embankment spilling onto one (beside a bridge's abutment, along
    // a road that follows the line) would bury it. Each road is a band of
    // its own, at its own ground height, and the earthworks slope down to
    // it at 1:2 rather than stopping in a cliff the refinement would chase.
    const roads = new RoadIndex(strokes, frame, dims.cell, ground);
    // Where the two disagree - a road beside a bridge's abutment - the
    // road wins.
    const band = { lo: 0, hi: 0 };
    const target = (u: number, v: number, h: number): number => {
        if (!bedIndex.band(u, v, band)) {
            return h;
        }
        const bed = band.lo > band.hi ? (band.lo + band.hi) / 2 : Math.min(band.hi, Math.max(band.lo, h));
        band.lo = -Infinity;
        band.hi = Infinity;
        roads.narrow(u, v, band);
        return Math.min(band.hi, Math.max(band.lo, bed));
    };

    // --- refine where the bed moves the ground -------------------------------
    const queue: number[] = [];
    for (let t = 0; t < mesh.tris.length; t++) {
        queue.push(t);
    }
    while (input.refine !== false && queue.length > 0 && mesh.added < MAX_NEW_TRIANGLES) {
        const t = queue.pop()!;
        const tri = mesh.tris[t];
        if (!tri.alive || tri.pinned) {
            continue;
        }
        if (!mesh.needsSplit(t, target, bedIndex)) {
            continue;
        }
        const made = mesh.refine(t);
        for (const c of made) {
            queue.push(c);
        }
    }

    // --- move the vertices -----------------------------------------------------
    const moved = mesh.displace(target);
    if (moved === 0) {
        return { strokePositions, beds: bedFloats, stats };
    }
    stats.trianglesAdded = mesh.added;
    stats.verticesMoved = moved;
    return { land: mesh.toSoup(), strokePositions, beds: bedFloats, stats };
}

interface DeckEnd {
    u: number;
    v: number;
    /** Height of the deck track, as drawn. */
    h: number;
    /** The quantised position, as drawn. */
    q: Int16Array;
}

/**
 * The ends of the track on one tile's bridge decks, 3 per end in that
 * tile's frame, metres: what RailBedInput.deckEnds is built from.
 */
export function deckTrackEnds(
    track: { positions: Int16Array; directions: Int8Array; indices: Uint16Array }, quantScale: number,
): Float64Array {
    const chains = railChains(track);
    const out = new Float64Array(chains.length * 6);
    chains.forEach((chain, i) => {
        [chain[0], chain[chain.length - 1]].forEach((vi, k) => {
            for (let j = 0; j < 3; j++) {
                out[i * 6 + k * 3 + j] = track.positions[vi * 3 + j] * quantScale;
            }
        });
    });
    return out;
}

/** The deck ends in plan, with where a stroke point goes to sit on one. */
function deckEnds(ends: Float64Array | undefined, q: number, frame: PlanFrame): DeckEnd[] {
    const out: DeckEnd[] = [];
    for (let i = 0; ends && i + 2 < ends.length; i += 3) {
        const p: V3 = [ends[i], ends[i + 1], ends[i + 2]];
        const [u, v, h] = frame.toPlan(p);
        out.push({ u, v, h, q: Int16Array.from(p, x => clampI16(x / q)) });
    }
    return out;
}

function nearestDeckEnd(decks: readonly DeckEnd[], u: number, v: number): DeckEnd | undefined {
    let best: DeckEnd | undefined;
    let bestD = DECK_SNAP_M;
    for (const d of decks) {
        const dist = Math.hypot(d.u - u, d.v - v);
        if (dist < bestD) {
            best = d;
            bestD = dist;
        }
    }
    return best;
}

/** The lengths one tile works in; see layRailBeds. */
interface Dims {
    step: number;
    quant: number;
    tolerance: number;
    sample: number;
    minEdge: number;
    cell: number;
    offLand: number;
}

/** The bed segments for RailBedResult.beds: plan back to the tile's frame. */
function bedSegmentFloats(beds: readonly BedSegment[], frame: PlanFrame): Float64Array {
    const out = new Float64Array(beds.length * RAIL_BED_SEGMENT_FLOATS);
    const { a, b, up } = frame;
    beds.forEach((s, i) => {
        const o = i * RAIL_BED_SEGMENT_FLOATS;
        [s.a, s.b].forEach((p, k) => {
            out[o + k * 3] = p.u * a[0] + p.v * b[0] + p.h * up[0];
            out[o + k * 3 + 1] = p.u * a[1] + p.v * b[1] + p.h * up[1];
            out[o + k * 3 + 2] = p.u * a[2] + p.v * b[2] + p.h * up[2];
        });
        out[o + 6] = s.half;
        out[o + 7] = Math.max(Math.abs(s.a.h - s.a.ground), Math.abs(s.b.h - s.b.ground));
        out[o + 8] = s.open;
    });
    return out;
}

/** Tracks in a stroke sidecar (or a deck's track) as chains of the even (positive-side) vertex of each pair. */
export function railChains(t: Pick<PtrTile, 'indices' | 'directions'>): number[][] {
    const next = new Map<number, number>();
    const hasPrev = new Set<number>();
    for (let i = 0; i + 5 < t.indices.length; i += 6) {
        const a = t.indices[i], b = t.indices[i + 5];
        if (!isRailClass(t.directions[a * 4 + 3] & ROAD_CLASS_MASK)) {
            continue;
        }
        next.set(a, b);
        hasPrev.add(b);
    }
    const chains: number[][] = [];
    for (const start of next.keys()) {
        if (hasPrev.has(start)) {
            continue;
        }
        const chain = [start];
        let v = start;
        while (next.has(v) && chain.length < 100000) {
            v = next.get(v)!;
            chain.push(v);
        }
        chains.push(chain);
    }
    return chains;
}

/**
 * Heights for `ground` (one per sample) no two neighbours of which differ by
 * more than `maxSteps` quanta, closest to the ground in weighted least
 * squares: the bake's road-grade programme, with weights and any step.
 *
 * With `band`, no height is more than that many metres off its ground, and
 * a step may then exceed `maxSteps` at `steepCost` per metre of excess: the
 * grade gives way only where the band forces it.
 */
export function gradeProfileWeighted(
    ground: readonly number[], weight: readonly number[], maxSteps: number,
    band = Infinity, steepCost = Infinity, bandCentre: readonly number[] = ground,
    quantM = PROFILE_QUANT_M,
): number[] {
    const n = ground.length;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
        lo = Math.min(lo, ground[i], bandCentre[i]);
        hi = Math.max(hi, ground[i], bandCentre[i]);
    }
    // A long chain over a big climb would want more memory than a tile is
    // worth: coarsen the quantum, keeping the slope a step allows.
    let quant = quantM;
    let stepsQ = maxSteps;
    while (n * ((hi - lo) / quant + 2) > MAX_PROFILE_CELLS) {
        quant *= 2;
        stepsQ /= 2;
    }
    const steps = Math.max(0, Math.floor(stepsQ + 1e-9));
    const base = Math.floor(lo / quant);
    const states = Math.ceil(hi / quant) - base + 1;
    let cost = new Float64Array(states);
    let nextCost = new Float64Array(states);
    const from = new Int32Array(n * states);
    const fit = (i: number, s: number): number => {
        const h = (base + s) * quant;
        const d = h - ground[i];
        return Math.abs(h - bandCentre[i]) > band ? Infinity : weight[i] * d * d;
    };
    for (let s = 0; s < states; s++) {
        cost[s] = fit(0, s);
    }
    const stepCost = steepCost * quant;
    const best = new Float64Array(states);
    const bestArg = new Int32Array(states);
    // A sliding-window minimum over the previous costs keeps it linear in
    // the states whatever the step.
    const dq = new Int32Array(states);
    for (let i = 1; i < n; i++) {
        let head = 0, tail = 0, next = 0;
        for (let s = 0; s < states; s++) {
            const hiIdx = Math.min(states - 1, s + steps);
            while (next <= hiIdx) {
                while (tail > head && cost[dq[tail - 1]] >= cost[next]) {
                    tail--;
                }
                dq[tail++] = next++;
            }
            while (dq[head] < s - steps) {
                head++;
            }
            best[s] = cost[dq[head]];
            bestArg[s] = dq[head];
        }
        // Past the window, each further quantum costs stepCost: an L1
        // distance transform of the window minimum.
        if (stepCost < Infinity) {
            for (let s = 1; s < states; s++) {
                if (best[s - 1] + stepCost < best[s]) {
                    best[s] = best[s - 1] + stepCost;
                    bestArg[s] = bestArg[s - 1];
                }
            }
            for (let s = states - 2; s >= 0; s--) {
                if (best[s + 1] + stepCost < best[s]) {
                    best[s] = best[s + 1] + stepCost;
                    bestArg[s] = bestArg[s + 1];
                }
            }
        }
        for (let s = 0; s < states; s++) {
            nextCost[s] = best[s] + fit(i, s);
            from[i * states + s] = bestArg[s];
        }
        [cost, nextCost] = [nextCost, cost];
    }
    let s = 0;
    for (let k = 1; k < states; k++) {
        if (cost[k] < cost[s]) {
            s = k;
        }
    }
    const out = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
        out[i] = (base + s) * quant;
        if (i > 0) {
            s = from[i * states + s];
        }
    }
    return out;
}

/**
 * `profile` with a moving average of 2 `radius` + 1 samples, held samples
 * (weight above 1) put back where they were with the difference tapered
 * out over the radius on either side.
 */
export function roundGradeBreaks(profile: readonly number[], weight: readonly number[], radius: number): number[] {
    const n = profile.length;
    const r = Math.max(0, Math.round(radius));
    if (r === 0 || n < 3) {
        return profile.slice();
    }
    const prefix = [0];
    for (const h of profile) {
        prefix.push(prefix[prefix.length - 1] + h);
    }
    const out = profile.map((_, i) => {
        // Shrunk at the ends so the window stays centred.
        const w = Math.min(r, i, n - 1 - i);
        return (prefix[i + w + 1] - prefix[i - w]) / (2 * w + 1);
    });
    const fix = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
        if (weight[i] <= 1) {
            continue;
        }
        const d = profile[i] - out[i];
        for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
            const t = 1 - Math.abs(j - i) / (r + 1);
            if (Math.abs(d * t) > Math.abs(fix[j])) {
                fix[j] = d * t;
            }
        }
    }
    return out.map((h, i) => h + fix[i]);
}

// --- geometry helpers ---------------------------------------------------------

interface PlanFrame {
    up: V3;
    a: V3;
    b: V3;
    toPlan(p: V3): V3;
}

function planFrame(up: V3): PlanFrame {
    const n = Math.hypot(up[0], up[1], up[2]);
    const u: V3 = [up[0] / n, up[1] / n, up[2] / n];
    const helper: V3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const d = helper[0] * u[0] + helper[1] * u[1] + helper[2] * u[2];
    let a: V3 = [helper[0] - u[0] * d, helper[1] - u[1] * d, helper[2] - u[2] * d];
    const al = Math.hypot(a[0], a[1], a[2]);
    a = [a[0] / al, a[1] / al, a[2] / al];
    const b: V3 = [u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]];
    return {
        up: u, a, b,
        toPlan: p => [
            p[0] * a[0] + p[1] * a[1] + p[2] * a[2],
            p[0] * b[0] + p[1] * b[1] + p[2] * b[2],
            p[0] * u[0] + p[1] * u[1] + p[2] * u[2],
        ],
    };
}

function clampI16(v: number): number {
    const r = Math.round(v);
    return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}

const CELL_M = 32;

/** The highest land facet over a plan point, from the soup as given. */
class GroundIndex {
    private readonly cells = new Map<number, number[]>();
    private readonly tri: Float64Array;

    constructor(positions: Int16Array, q: number, frame: PlanFrame, private readonly cell: number) {
        const n = positions.length / 9;
        this.tri = new Float64Array(n * 9);
        for (let t = 0; t < n; t++) {
            let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
            for (let k = 0; k < 3; k++) {
                const o = t * 9 + k * 3;
                const p = frame.toPlan([positions[o] * q, positions[o + 1] * q, positions[o + 2] * q]);
                this.tri[o] = p[0]; this.tri[o + 1] = p[1]; this.tri[o + 2] = p[2];
                u0 = Math.min(u0, p[0]); u1 = Math.max(u1, p[0]); v0 = Math.min(v0, p[1]); v1 = Math.max(v1, p[1]);
            }
            for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
                for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(t);
                    } else {
                        this.cells.set(key, [t]);
                    }
                }
            }
        }
    }

    at(u: number, v: number): number | undefined {
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return undefined;
        }
        let best: number | undefined;
        for (const t of list) {
            const o = t * 9, T = this.tri;
            const h = barycentricHeight(u, v, T[o], T[o + 1], T[o + 2], T[o + 3], T[o + 4], T[o + 5], T[o + 6], T[o + 7], T[o + 8]);
            if (h !== undefined && (best === undefined || h > best)) {
                best = h;
            }
        }
        return best;
    }
}

function cellKey(cu: number, cv: number): number {
    return (cu + 32768) * 65536 + (cv + 32768);
}

function barycentricHeight(
    u: number, v: number,
    u0: number, v0: number, h0: number, u1: number, v1: number, h1: number, u2: number, v2: number, h2: number,
): number | undefined {
    const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(det) < 1e-9) {
        return undefined;
    }
    const l0 = ((v1 - v2) * (u - u2) + (u2 - u1) * (v - v2)) / det;
    const l1 = ((v2 - v0) * (u - u2) + (u0 - u2) * (v - v2)) / det;
    const l2 = 1 - l0 - l1;
    const eps = -1e-6;
    if (l0 < eps || l1 < eps || l2 < eps) {
        return undefined;
    }
    return l0 * h0 + l1 * h1 + l2 * h2;
}

interface BedSegment {
    a: Sample;
    b: Sample;
    half: number;
    /** BED_OPEN_A / BED_OPEN_B: that end stops square rather than rounded. */
    open: number;
}

/** A bed segment's first end is open: nothing past it belongs to the bed. */
export const BED_OPEN_A = 1;
/** Its second end is. */
export const BED_OPEN_B = 2;

/**
 * Where along a bed segment a point projects, clamped to it, or undefined
 * when it falls past an open end. `open` is BED_OPEN_A | BED_OPEN_B.
 */
export function bedSegmentParam(
    pu: number, pv: number, du: number, dv: number, open: number,
): number | undefined {
    const l2 = du * du + dv * dv;
    if (l2 <= 1e-12) {
        return open ? undefined : 0;
    }
    const t = (pu * du + pv * dv) / l2;
    if ((t < 0 && (open & BED_OPEN_A)) || (t > 1 && (open & BED_OPEN_B))) {
        return undefined;
    }
    return Math.min(1, Math.max(0, t));
}

/** Road clear of the bed's earthworks beyond a road's own half width, metres. */
const ROAD_KEEP_MARGIN_M = 0.5;

/** The tile's roads (every stroke not a track), answering "is this on a road". */
class RoadIndex {
    private readonly cells = new Map<number, number[]>();
    private readonly segs: number[] = []; // ua, va, ha, ub, vb, hb, half

    constructor(t: PtrTile, frame: PlanFrame, private readonly cell: number, ground: GroundIndex) {
        const q = t.quantScale;
        const at = (vi: number) => frame.toPlan([t.positions[vi * 3] * q, t.positions[vi * 3 + 1] * q, t.positions[vi * 3 + 2] * q]);
        for (let i = 0; i + 5 < t.indices.length; i += 6) {
            const a = t.indices[i], b = t.indices[i + 5];
            const cls = t.directions[a * 4 + 3] & ROAD_CLASS_MASK;
            if (isRailClass(cls) || isZoneClass(cls)) {
                continue;
            }
            const pa = at(a), pb = at(b);
            const half = Math.max(t.halfWidths[a], t.halfWidths[b]) / 10 + ROAD_KEEP_MARGIN_M;
            const ha = ground.at(pa[0], pa[1]), hb = ground.at(pb[0], pb[1]);
            if (ha === undefined || hb === undefined) {
                continue;
            }
            const reach = half + BATTER_REACH_M;
            const k = this.segs.length / 7;
            this.segs.push(pa[0], pa[1], ha, pb[0], pb[1], hb, half);
            const u0 = Math.floor((Math.min(pa[0], pb[0]) - reach) / cell), u1 = Math.floor((Math.max(pa[0], pb[0]) + reach) / cell);
            const v0 = Math.floor((Math.min(pa[1], pb[1]) - reach) / cell), v1 = Math.floor((Math.max(pa[1], pb[1]) + reach) / cell);
            for (let cu = u0; cu <= u1; cu++) {
                for (let cv = v0; cv <= v1; cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(k);
                    } else {
                        this.cells.set(key, [k]);
                    }
                }
            }
        }
    }

    /** Narrows `band` to every road band reaching (u, v): on a road its ground, beside it 1:2. */
    narrow(u: number, v: number, band: { lo: number; hi: number }): void {
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return;
        }
        for (const k of list) {
            const o = k * 7, s = this.segs;
            const du = s[o + 3] - s[o], dv = s[o + 4] - s[o + 1];
            const l2 = du * du + dv * dv;
            const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((u - s[o]) * du + (v - s[o + 1]) * dv) / l2)) : 0;
            const excess = Math.max(0, Math.hypot(u - s[o] - du * t, v - s[o + 1] - dv * t) - s[o + 6]);
            if (excess > BATTER_REACH_M) {
                continue;
            }
            const road = s[o + 2] + (s[o + 5] - s[o + 2]) * t;
            band.lo = Math.max(band.lo, road - excess * BATTER);
            band.hi = Math.min(band.hi, road + excess * BATTER);
        }
    }
}

/** The bed segments, bucketed, answering "how far from the nearest bed, and at what design height". */
class BedIndex {
    private readonly cells = new Map<number, number[]>();
    private readonly reach: number;

    constructor(private readonly segs: readonly BedSegment[], private readonly cell: number) {
        this.reach = Math.max(...segs.map(s => s.half)) + SHOULDER_M + BATTER_REACH_M;
        segs.forEach((s, i) => {
            const u0 = Math.min(s.a.u, s.b.u) - this.reach, u1 = Math.max(s.a.u, s.b.u) + this.reach;
            const v0 = Math.min(s.a.v, s.b.v) - this.reach, v1 = Math.max(s.a.v, s.b.v) + this.reach;
            for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
                for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                    const key = cellKey(cu, cv);
                    const list = this.cells.get(key);
                    if (list) {
                        list.push(i);
                    } else {
                        this.cells.set(key, [i]);
                    }
                }
            }
        });
    }

    /** Whether any bed reaches into the plan box. */
    anyNear(u0: number, v0: number, u1: number, v1: number): boolean {
        for (let cu = Math.floor(u0 / this.cell); cu <= Math.floor(u1 / this.cell); cu++) {
            for (let cv = Math.floor(v0 / this.cell); cv <= Math.floor(v1 / this.cell); cv++) {
                if (this.cells.has(cellKey(cu, cv))) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * The ground height `h` brought within every bed's reach: on a bed, its
     * design height; beside it, no farther off that than the batter allows.
     * Each bed bounds the ground to a band that widens 1:2 from its
     * shoulder, and the ground is clamped into the bands' overlap, which -
     * unlike the nearest bed's band - is continuous where tracks of
     * different profiles run side by side, so the land has no step to chase
     * between them. Where the bands miss each other, the middle of the gap.
     */
    clamp(u: number, v: number, h: number): number {
        const band = { lo: 0, hi: 0 };
        if (!this.band(u, v, band)) {
            return h;
        }
        return band.lo > band.hi ? (band.lo + band.hi) / 2 : Math.min(band.hi, Math.max(band.lo, h));
    }

    /** The overlap of every bed band reaching (u, v), into `out`; false when none does. */
    band(u: number, v: number, out: { lo: number; hi: number }): boolean {
        const list = this.cells.get(cellKey(Math.floor(u / this.cell), Math.floor(v / this.cell)));
        if (!list) {
            return false;
        }
        let lo = -Infinity, hi = Infinity;
        for (const i of list) {
            const s = this.segs[i];
            const du = s.b.u - s.a.u, dv = s.b.v - s.a.v;
            const t = bedSegmentParam(u - s.a.u, v - s.a.v, du, dv, s.open);
            if (t === undefined) {
                continue;
            }
            const excess = Math.max(0, Math.hypot(u - s.a.u - du * t, v - s.a.v - dv * t) - s.half - SHOULDER_M);
            if (excess > BATTER_REACH_M) {
                continue;
            }
            const bed = s.a.h + (s.b.h - s.a.h) * t;
            lo = Math.max(lo, bed - excess * BATTER);
            hi = Math.min(hi, bed + excess * BATTER);
        }
        out.lo = lo;
        out.hi = hi;
        return lo !== -Infinity;
    }
}

interface Tri {
    /** Position ids of the three corners. */
    c: [number, number, number];
    /** Soup vertex each corner takes its normal and attributes from. */
    s: [number, number, number];
    alive: boolean;
    pinned: boolean;
    /** Original soup triangle, or -1 for a piece. */
    orig: number;
    /** Touched by a split or a move: its normal is recomputed. */
    dirty: boolean;
}

/** The soup as shared positions and triangles, for conforming bisection. */
class SoupMesh {
    /** Plan coordinates (u, v, h) per position id. */
    readonly pos: number[] = [];
    readonly tris: Tri[] = [];
    added = 0;
    private readonly edges = new Map<string, number[]>();
    private readonly mids = new Map<string, number>();
    private readonly pinnedPos = new Set<number>();

    constructor(
        private readonly land: LandSoup, private readonly q: number,
        private readonly frame: PlanFrame, pinnedVerts: ReadonlySet<number>, triCount: number,
        private readonly dims: Dims,
    ) {
        const ids = new Map<string, number>();
        const P = land.positions;
        for (let t = 0; t < triCount; t++) {
            const c: number[] = [];
            let pinned = false;
            for (let k = 0; k < 3; k++) {
                const vi = t * 3 + k;
                const key = `${P[vi * 3]},${P[vi * 3 + 1]},${P[vi * 3 + 2]}`;
                let id = ids.get(key);
                if (id === undefined) {
                    id = this.pos.length / 3;
                    const p = frame.toPlan([P[vi * 3] * q, P[vi * 3 + 1] * q, P[vi * 3 + 2] * q]);
                    this.pos.push(p[0], p[1], p[2]);
                    ids.set(key, id);
                }
                c.push(id);
                if (pinnedVerts.has(vi)) {
                    pinned = true;
                }
            }
            const tri: Tri = {
                c: c as [number, number, number], s: [t * 3, t * 3 + 1, t * 3 + 2],
                alive: true, pinned, orig: t, dirty: false,
            };
            this.tris.push(tri);
            if (pinned) {
                for (const id of c) {
                    this.pinnedPos.add(id);
                }
            }
            this.link(t);
        }
    }

    private edgeKey(a: number, b: number): string {
        return a < b ? `${a}_${b}` : `${b}_${a}`;
    }

    private link(t: number): void {
        const c = this.tris[t].c;
        for (let k = 0; k < 3; k++) {
            const key = this.edgeKey(c[k], c[(k + 1) % 3]);
            const list = this.edges.get(key);
            if (list) {
                list.push(t);
            } else {
                this.edges.set(key, [t]);
            }
        }
    }

    private unlink(t: number): void {
        const c = this.tris[t].c;
        for (let k = 0; k < 3; k++) {
            const key = this.edgeKey(c[k], c[(k + 1) % 3]);
            const list = this.edges.get(key);
            if (list) {
                const i = list.indexOf(t);
                if (i >= 0) {
                    list.splice(i, 1);
                }
            }
        }
    }

    longestEdge(t: number): { k: number; len: number } {
        const c = this.tris[t].c;
        let best = { k: 0, len: -1 };
        for (let k = 0; k < 3; k++) {
            const a = c[k] * 3, b = c[(k + 1) % 3] * 3;
            const len = Math.hypot(this.pos[a] - this.pos[b], this.pos[a + 1] - this.pos[b + 1]);
            if (len > best.len) {
                best = { k, len };
            }
        }
        return best;
    }

    /**
     * Whether `t` must be split to follow the bed: some point of it would
     * land more than the tile tolerance off its target if only its corners
     * moved. Error-driven rather than a fixed edge length, so the
     * refinement goes into the bed's creases (its edges, the batter toes)
     * and where the bed really leaves the ground, not into every triangle
     * the track passes.
     */
    needsSplit(t: number, target: (u: number, v: number, h: number) => number, beds: BedIndex): boolean {
        const c = this.tris[t].c;
        const P = c.map(id => [this.pos[id * 3], this.pos[id * 3 + 1], this.pos[id * 3 + 2]]);
        const longest = this.longestEdge(t).len;
        if (longest <= this.dims.minEdge) {
            return false;
        }
        const u0 = Math.min(P[0][0], P[1][0], P[2][0]), u1 = Math.max(P[0][0], P[1][0], P[2][0]);
        const v0 = Math.min(P[0][1], P[1][1], P[2][1]), v1 = Math.max(P[0][1], P[1][1], P[2][1]);
        if (!beds.anyNear(u0, v0, u1, v1)) {
            return false;
        }
        const d = P.map(([u, v, h]) => target(u, v, h) - h);
        const n = Math.min(32, Math.max(2, Math.ceil(longest / this.dims.sample)));
        for (let i = 0; i <= n; i++) {
            for (let j = 0; i + j <= n; j++) {
                const a = i / n, b = j / n, w = 1 - a - b;
                const u = P[0][0] * w + P[1][0] * a + P[2][0] * b;
                const v = P[0][1] * w + P[1][1] * a + P[2][1] * b;
                const h = P[0][2] * w + P[1][2] * a + P[2][2] * b;
                const fit = d[0] * w + d[1] * a + d[2] * b;
                if (Math.abs(target(u, v, h) - h - fit) > this.dims.tolerance) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Conforming longest-edge bisection of `t`; returns the triangles made. */
    refine(t: number, depth = 0): number[] {
        const made: number[] = [];
        if (depth > 40) {
            return made;
        }
        for (let guard = 0; guard < 8 && this.tris[t].alive; guard++) {
            const { k } = this.longestEdge(t);
            const c = this.tris[t].c;
            const a = c[k], b = c[(k + 1) % 3];
            const across = (this.edges.get(this.edgeKey(a, b)) ?? []).filter(o => o !== t && this.tris[o].alive);
            if (across.length > 1) {
                return made;
            }
            if (across.length === 0) {
                made.push(...this.bisect(t, a, b));
                return made;
            }
            const n = across[0];
            if (this.tris[n].pinned) {
                return made;
            }
            const nk = this.longestEdge(n).k;
            const nc = this.tris[n].c;
            const na = nc[nk], nb = nc[(nk + 1) % 3];
            if ((na === a && nb === b) || (na === b && nb === a)) {
                made.push(...this.bisect(t, a, b), ...this.bisect(n, a, b));
                return made;
            }
            // The neighbour's own longest edge first, then try again; if
            // that is blocked (a pinned triangle further on), so is this.
            const sub = this.refine(n, depth + 1);
            if (sub.length === 0) {
                return made;
            }
            made.push(...sub);
        }
        return made;
    }

    private bisect(t: number, a: number, b: number): number[] {
        const tri = this.tris[t];
        const key = this.edgeKey(a, b);
        let m = this.mids.get(key);
        if (m === undefined) {
            m = this.pos.length / 3;
            this.pos.push(
                (this.pos[a * 3] + this.pos[b * 3]) / 2,
                (this.pos[a * 3 + 1] + this.pos[b * 3 + 1]) / 2,
                (this.pos[a * 3 + 2] + this.pos[b * 3 + 2]) / 2,
            );
            this.mids.set(key, m);
        }
        // Rotate so the split edge is corners 0-1, keeping the winding.
        let r = 0;
        while (!(tri.c[r] === a && tri.c[(r + 1) % 3] === b) && !(tri.c[r] === b && tri.c[(r + 1) % 3] === a)) {
            r++;
        }
        const c0 = tri.c[r], c1 = tri.c[(r + 1) % 3], c2 = tri.c[(r + 2) % 3];
        const s0 = tri.s[r], s1 = tri.s[(r + 1) % 3], s2 = tri.s[(r + 2) % 3];
        this.unlink(t);
        tri.alive = false;
        const kids: Tri[] = [
            { c: [c0, m, c2], s: [s0, s0, s2], alive: true, pinned: false, orig: -1, dirty: true },
            { c: [m, c1, c2], s: [s0, s1, s2], alive: true, pinned: false, orig: -1, dirty: true },
        ];
        const out: number[] = [];
        for (const kid of kids) {
            const id = this.tris.length;
            this.tris.push(kid);
            this.link(id);
            out.push(id);
        }
        this.added += 1;
        return out;
    }

    /** Every movable position onto its target; returns how many moved. */
    displace(target: (u: number, v: number, h: number) => number): number {
        const used = new Uint8Array(this.pos.length / 3);
        for (const tri of this.tris) {
            if (tri.alive) {
                for (const id of tri.c) {
                    used[id] = 1;
                }
            }
        }
        let moved = 0;
        const movedIds = new Set<number>();
        for (let id = 0; id < used.length; id++) {
            if (!used[id] || this.pinnedPos.has(id)) {
                continue;
            }
            const h = this.pos[id * 3 + 2];
            const t = target(this.pos[id * 3], this.pos[id * 3 + 1], h);
            if (Math.abs(t - h) > 0.01) {
                this.pos[id * 3 + 2] = t;
                movedIds.add(id);
                moved++;
            }
        }
        for (const tri of this.tris) {
            if (tri.alive && (movedIds.has(tri.c[0]) || movedIds.has(tri.c[1]) || movedIds.has(tri.c[2]))) {
                tri.dirty = true;
            }
        }
        return moved;
    }

    /** The mesh as a soup again: original slots first, pieces after. */
    toSoup(): LandSoup {
        const pieces = this.tris.filter(t => t.alive && t.orig < 0);
        const total = this.tris.filter(t => t.orig >= 0).length + pieces.length;
        const positions = new Int16Array(total * 9);
        const normals = new Int8Array(total * 12);
        const attrs = new Uint8Array(total * 12);
        const { a, b, up } = this.frame;
        const q = this.q;
        const write = (slot: number, tri: Tri, degenerate: boolean) => {
            const corners = tri.c.map(id => {
                const u = this.pos[id * 3], v = this.pos[id * 3 + 1], h = this.pos[id * 3 + 2];
                return [
                    u * a[0] + v * b[0] + h * up[0],
                    u * a[1] + v * b[1] + h * up[1],
                    u * a[2] + v * b[2] + h * up[2],
                ];
            });
            let nrm: number[] | undefined;
            if (tri.dirty && !degenerate) {
                const e1 = [corners[1][0] - corners[0][0], corners[1][1] - corners[0][1], corners[1][2] - corners[0][2]];
                const e2 = [corners[2][0] - corners[0][0], corners[2][1] - corners[0][1], corners[2][2] - corners[0][2]];
                nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
                const len = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
                nrm = nrm.map(x => x / len);
                // Face the same way as the triangle it came from.
                const so = tri.s[0] * 4;
                const ref = [this.land.normals[so], this.land.normals[so + 1], this.land.normals[so + 2]];
                if (nrm[0] * ref[0] + nrm[1] * ref[1] + nrm[2] * ref[2] < 0) {
                    nrm = nrm.map(x => -x);
                }
            }
            for (let k = 0; k < 3; k++) {
                const vo = (slot * 3 + k);
                const p = degenerate ? corners[0] : corners[k];
                positions[vo * 3] = clampI16(p[0] / q);
                positions[vo * 3 + 1] = clampI16(p[1] / q);
                positions[vo * 3 + 2] = clampI16(p[2] / q);
                const src = tri.s[k] * 4;
                if (nrm) {
                    normals[vo * 4] = Math.round(nrm[0] * 127);
                    normals[vo * 4 + 1] = Math.round(nrm[1] * 127);
                    normals[vo * 4 + 2] = Math.round(nrm[2] * 127);
                    normals[vo * 4 + 3] = this.land.normals[src + 3];
                } else {
                    for (let j = 0; j < 4; j++) {
                        normals[vo * 4 + j] = this.land.normals[src + j];
                    }
                }
                for (let j = 0; j < 4; j++) {
                    attrs[vo * 4 + j] = this.land.attrs[src + j];
                }
            }
        };
        for (const tri of this.tris) {
            if (tri.orig >= 0) {
                if (tri.alive && !tri.dirty && !tri.pinned) {
                    // Untouched: bytes as they were, nothing recomputed.
                    for (let k = 0; k < 3; k++) {
                        const vo = tri.orig * 3 + k;
                        positions.set(this.land.positions.subarray(vo * 3, vo * 3 + 3), vo * 3);
                        normals.set(this.land.normals.subarray(vo * 4, vo * 4 + 4), vo * 4);
                        attrs.set(this.land.attrs.subarray(vo * 4, vo * 4 + 4), vo * 4);
                    }
                } else if (tri.pinned) {
                    for (let k = 0; k < 3; k++) {
                        const vo = tri.orig * 3 + k;
                        positions.set(this.land.positions.subarray(vo * 3, vo * 3 + 3), vo * 3);
                        normals.set(this.land.normals.subarray(vo * 4, vo * 4 + 4), vo * 4);
                        attrs.set(this.land.attrs.subarray(vo * 4, vo * 4 + 4), vo * 4);
                    }
                } else {
                    write(tri.orig, tri, !tri.alive);
                }
            }
        }
        let slot = this.tris.filter(t => t.orig >= 0).length;
        for (const tri of pieces) {
            write(slot++, tri, false);
        }
        return { positions, normals, attrs };
    }
}

/** Clear ground kept past a bed's batter toe for scattered trees and rocks, metres. */
const SCATTER_MARGIN_M = 3;

/**
 * Whether a scatter point (tile frame, metres, as RailBedResult.beds) is on a
 * bed or its batters: the ground there is not where the tile's own facets
 * put it, so a tree would float or sink, and a railway keeps its cess clear
 * anyway. Undefined when there are no beds.
 */
export function buildRailBedExclusion(
    beds: Float64Array, up: V3, cellM = CELL_M,
): ((x: number, y: number, z: number) => boolean) | undefined {
    const n = beds.length / RAIL_BED_SEGMENT_FLOATS;
    if (n === 0) {
        return undefined;
    }
    const frame = planFrame(up);
    const segs = new Float64Array(n * 6); // ua, va, ub, vb, reach, open
    const cells = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
        const o = i * RAIL_BED_SEGMENT_FLOATS;
        const a = frame.toPlan([beds[o], beds[o + 1], beds[o + 2]]);
        const b = frame.toPlan([beds[o + 3], beds[o + 4], beds[o + 5]]);
        // The batter runs out where it has made up the bed's height difference.
        const reach = beds[o + 6] + SHOULDER_M + Math.min(BATTER_REACH_M, beds[o + 7] / BATTER) + SCATTER_MARGIN_M;
        segs.set([a[0], a[1], b[0], b[1], reach, beds[o + 8]], i * 6);
        const u0 = Math.floor((Math.min(a[0], b[0]) - reach) / cellM), u1 = Math.floor((Math.max(a[0], b[0]) + reach) / cellM);
        const v0 = Math.floor((Math.min(a[1], b[1]) - reach) / cellM), v1 = Math.floor((Math.max(a[1], b[1]) + reach) / cellM);
        for (let cu = u0; cu <= u1; cu++) {
            for (let cv = v0; cv <= v1; cv++) {
                const key = cellKey(cu, cv);
                const list = cells.get(key);
                if (list) {
                    list.push(i);
                } else {
                    cells.set(key, [i]);
                }
            }
        }
    }
    return (x, y, z) => {
        const [u, v] = frame.toPlan([x, y, z]);
        const list = cells.get(cellKey(Math.floor(u / cellM), Math.floor(v / cellM)));
        if (!list) {
            return false;
        }
        for (const i of list) {
            const o = i * 6;
            const du = segs[o + 2] - segs[o], dv = segs[o + 3] - segs[o + 1];
            const t = bedSegmentParam(u - segs[o], v - segs[o + 1], du, dv, segs[o + 5]);
            if (t !== undefined && Math.hypot(u - segs[o] - du * t, v - segs[o + 1] - dv * t) < segs[o + 4]) {
                return true;
            }
        }
        return false;
    };
}
