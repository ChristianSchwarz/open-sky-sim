/**
 * Smooths a road centreline into a centripetal Catmull-Rom curve, sampled
 * only as densely as its bends need.
 *
 * A road is mapped in OSM as a polyline, and a polyline drawn at its true
 * width shows every node as a corner once the aircraft is low enough. This
 * runs before the drape, in tile-local metres, so everything after it -
 * facet-crossing samples, the height simplifier, the stroke encoder - works
 * on the curve exactly as it did on the polyline.
 *
 * Three rules keep it honest:
 *
 *  - **Centripetal** parameterisation (alpha 0.5). The uniform variant
 *    overshoots and can loop where nodes are unevenly spaced, which OSM's
 *    are: a curve through a 5 m and a 300 m segment in a row bulges past the
 *    road. Centripetal provably does neither.
 *  - **Corners stay corners.** A turn sharper than `cornerDeg` at a node is
 *    a junction, a hairpin or a mapped right angle, not a sampled arc, and
 *    rounding it would put the road through a building. The line is split
 *    there and each piece is smoothed on its own.
 *  - **Never further from the mapped road than simplification could move it.**
 *    A span whose curve would leave its segment by more than
 *    `maxOffsetM` stays straight: OSM draws many roads as straight runs
 *    meeting at shallow angles, and a spline through their sparse nodes
 *    swings wide of both.
 *  - **Ends stay put, and so do their directions.** A piece's end tangent is
 *    its end segment's direction (a mirrored phantom node), so a road clipped
 *    at a tile border leaves along the clipped segment on both tiles and the
 *    two strokes meet without a kink.
 */

export interface XZ {
    x: number;
    z: number;
}

/** Turn, in degrees, at or above which a node is kept as a hard corner. */
export const ROAD_CORNER_DEG = 60;

/**
 * Largest distance, metres, the sampled polyline may stray from the curve.
 *
 * Measured on 60 German leaf tiles (1.5 m node simplification, offset cap on):
 * no spline 842 road triangles per tile; 1 m 904 (+7%), mean 0.16 m off the
 * mapped line; 0.5 m 1180 (+40%), 0.32 m. Half a metre rounds bends a little
 * further for six times the cost, so the metre.
 */
export const ROAD_SPLINE_TOLERANCE_M = 1.0;

/**
 * Largest distance, metres, a smoothed span may stray from its mapped
 * segment; a span that would stray further stays straight. The leaf road
 * bake keeps nodes to LEAF_SIMPLIFY_M (1.5 m, tools/bake_osm_roads.py), so a
 * real curve lies within that of the kept segments and anything past it is
 * the spline inventing a bend.
 */
export const ROAD_SPLINE_MAX_OFFSET_M = 1.5;

/** Probes along a span when measuring its offset from the mapped segment. */
const SPAN_OFFSET_PROBES = 8;

/** Subdivision depth per span: 2^8 samples, a backstop for a degenerate span. */
const MAX_DEPTH = 8;

/** Segments shorter than this are merged before smoothing: duplicate nodes. */
const MIN_SEGMENT_M = 0.05;

/**
 * The smoothed, adaptively sampled centreline. Every input node that
 * survives de-duplication is on the output, so the curve passes through
 * what OSM mapped.
 */
export function smoothRoad(
    points: readonly XZ[],
    toleranceM: number = ROAD_SPLINE_TOLERANCE_M,
    cornerDeg: number = ROAD_CORNER_DEG,
    maxOffsetM: number = ROAD_SPLINE_MAX_OFFSET_M,
): XZ[] {
    const pts = dedupe(points);
    if (pts.length < 3) {
        return pts;
    }
    const cosCorner = Math.cos((cornerDeg * Math.PI) / 180);
    const out: XZ[] = [pts[0]];
    let start = 0;
    for (let i = 1; i < pts.length; i++) {
        const last = i === pts.length - 1;
        if (last || isCorner(pts[i - 1], pts[i], pts[i + 1], cosCorner)) {
            appendPiece(pts, start, i, toleranceM, maxOffsetM, out);
            start = i;
        }
    }
    return out;
}

function dedupe(points: readonly XZ[]): XZ[] {
    const out: XZ[] = [];
    for (const p of points) {
        const prev = out[out.length - 1];
        if (prev === undefined || Math.hypot(p.x - prev.x, p.z - prev.z) >= MIN_SEGMENT_M) {
            out.push({ x: p.x, z: p.z });
        }
    }
    return out;
}

/** Whether the turn at b, coming from a and going to c, is at least the corner angle. */
function isCorner(a: XZ, b: XZ, c: XZ, cosCorner: number): boolean {
    const ux = b.x - a.x, uz = b.z - a.z;
    const vx = c.x - b.x, vz = c.z - b.z;
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    // The turn is the angle between the two directions: 0 straight on.
    return (ux * vx + uz * vz) / (lu * lv) <= cosCorner;
}

/** Append the smoothed nodes (start, end], sampled, to `out`; `out` already ends at `start`. */
function appendPiece(
    pts: readonly XZ[], start: number, end: number, tol: number, maxOffset: number, out: XZ[],
): void {
    const samples: XZ[] = [];
    for (let i = start; i < end; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];
        // Mirrored phantoms at the piece's ends: the tangent there is the end
        // segment's own direction.
        const p0 = i > start ? pts[i - 1] : { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z };
        const p3 = i + 1 < end ? pts[i + 2] : { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z };
        const span = makeSpan(p0, p1, p2, p3);
        samples.length = 0;
        subdivide(span, 0, 1, p1, p2, tol, 0, samples);
        // A span whose curve strays further from its mapped segment than the
        // simplifier could have moved the road is not a sampled arc: it is a
        // straight road meeting another at a real angle, under the corner
        // threshold, with the nodes far apart. Measured on Germany, letting
        // it curve cut such corners by up to 33 m. It stays straight.
        if (spanOffset(span, p1, p2) <= maxOffset) {
            for (const q of samples) {
                out.push(q);
            }
        }
        out.push(p2);
    }
}

/** Largest distance of the span's curve from the straight segment p1-p2. */
function spanOffset(s: Span, p1: XZ, p2: XZ): number {
    let worst = 0;
    for (let k = 1; k < SPAN_OFFSET_PROBES; k++) {
        worst = Math.max(worst, distToChord(evalSpan(s, k / SPAN_OFFSET_PROBES), p1, p2));
    }
    return worst;
}

interface Span {
    p0: XZ; p1: XZ; p2: XZ; p3: XZ;
    t0: number; t1: number; t2: number; t3: number;
}

function knot(t: number, a: XZ, b: XZ): number {
    // alpha 0.5: the square root of the chord length. A floor keeps two
    // coincident phantoms from producing a zero-length knot interval.
    return t + Math.max(1e-6, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
}

function makeSpan(p0: XZ, p1: XZ, p2: XZ, p3: XZ): Span {
    const t0 = 0;
    const t1 = knot(t0, p0, p1);
    const t2 = knot(t1, p1, p2);
    const t3 = knot(t2, p2, p3);
    return { p0, p1, p2, p3, t0, t1, t2, t3 };
}

/** The curve at u in [0, 1] across the span p1..p2 (Barry-Goldman pyramid). */
export function evalSpan(s: Span, u: number): XZ {
    const t = s.t1 + (s.t2 - s.t1) * u;
    const lerp = (a: XZ, b: XZ, ta: number, tb: number): XZ => {
        const w = (t - ta) / (tb - ta);
        return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
    };
    const a1 = lerp(s.p0, s.p1, s.t0, s.t1);
    const a2 = lerp(s.p1, s.p2, s.t1, s.t2);
    const a3 = lerp(s.p2, s.p3, s.t2, s.t3);
    const b1 = lerp(a1, a2, s.t0, s.t2);
    const b2 = lerp(a2, a3, s.t1, s.t3);
    return lerp(b1, b2, s.t1, s.t2);
}

function distToChord(p: XZ, a: XZ, b: XZ): number {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-12 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

/**
 * Push the samples strictly inside (ua, ub) that keep the chord from pa to
 * pb within `tol` of the curve. Tested at the quarter points as well as the
 * middle, so an S-bend whose midpoint happens to sit on the chord is not
 * mistaken for straight.
 */
function subdivide(s: Span, ua: number, ub: number, pa: XZ, pb: XZ, tol: number, depth: number, out: XZ[]): void {
    const um = (ua + ub) / 2;
    const pm = evalSpan(s, um);
    if (depth >= MAX_DEPTH) {
        return;
    }
    const q1 = evalSpan(s, (ua + um) / 2);
    const q3 = evalSpan(s, (um + ub) / 2);
    const worst = Math.max(distToChord(pm, pa, pb), distToChord(q1, pa, pb), distToChord(q3, pa, pb));
    if (worst <= tol) {
        return;
    }
    subdivide(s, ua, um, pa, pm, tol, depth + 1, out);
    out.push(pm);
    subdivide(s, um, ub, pm, pb, tol, depth + 1, out);
}
