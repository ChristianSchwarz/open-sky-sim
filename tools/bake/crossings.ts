/**
 * Where a bridge crosses another road, the smaller of the two gives way.
 *
 * The rule: the bigger road (lower class byte) is never changed at a
 * crossing; the smaller one takes the difference, at no more than
 * CROSSING_GRADE.
 *
 *  - The bridge is the smaller road (or they are equal): the deck is straight,
 *    so it is lifted whole, and its approaches climb onto a fill, a Damm, so
 *    the deck clears the road under it by CLEARANCE_M over its own thickness.
 *    Ramps run outward from both abutments.
 *  - The bridge is the bigger road: the road under it sinks into a cutting,
 *    a Senke, so it passes beneath the deck with the same clearance.
 *
 * Both come out as roadbed lines (GradeLine, see roadGrade.ts) that the mesh
 * bake lays into the height grid, exactly as a motorway's profile is. Pure
 * planning: the ground and the height of the road at a point come in through
 * `env`.
 */

import { CLEARANCE_M, DECK_THICKNESS_M, Structure } from './bridges';
import { GRADE_STEP_M, GradeLine, GradePoint } from './roadGrade';
import { LonLat } from './lvr';

/** Grade of a motorway ramp or cutting. Under the 5 % limit. */
export const CROSSING_GRADE_MOTORWAY = 0.045;
/** Any other road: 5 %. */
export const CROSSING_GRADE_OTHER = 0.05;
/** The steepest grade a crossing ramp or cutting of a road of class `cls` may have. */
export const crossingGrade = (cls: number): number => (cls === 0 ? CROSSING_GRADE_MOTORWAY : CROSSING_GRADE_OTHER);
/** A road within this of a span's ends is its own junction with the ground, not something it crosses. */
export const END_ZONE_M = 12;
/** A crossing at less than this angle (sine) runs along the span: an approach, not a crossing. */
export const MIN_CROSSING_SIN = 0.34;
/** Deepest cut or highest fill worth building, metres. */
export const MAX_CROSSING_WORK_M = 30;
/**
 * How far a ramp or cutting stretches, metres: 500. A crossing changes the
 * smaller road by a few metres, and it does that over half a kilometre, so it
 * reads as a rise in the road and never as a wall. The grade limit only lengthens
 * it, for a change too big for 500 m.
 */
export const RAMP_LENGTH_M = 200;
/** Longest ramp or cutting walked from a crossing, metres. */
const MAX_WALK_M = 1200;
/** Approach road ends this close to a span's end are that span's approach, metres. */
const APPROACH_JOIN_M = 4;
/** A road that adds nothing is not written: heights within this of the ground. */
const NEGLIGIBLE_M = 0.05;

export interface RoadPiece {
    cls: number;
    halfM: number;
    points: LonLat[];
}

export interface CrossingSpan {
    structure: Structure;
    points: LonLat[];
}

export interface CrossingEnv {
    /** Natural ground at a point. */
    ground(lon: number, lat: number): number;
    /** Height of the road surface at a point: a motorway's design height, else the ground. */
    roadH(lon: number, lat: number): number;
}

export interface CrossingStats {
    crossings: number;
    dips: number;
    fills: number;
    skipped: number;
}

interface Frame {
    lon0: number;
    lat0: number;
    kx: number;
    ky: number;
}

const frameAt = (lon0: number, lat0: number): Frame => ({
    lon0, lat0, kx: 111320 * Math.cos((lat0 * Math.PI) / 180), ky: 111320,
});
const xy = (f: Frame, p: LonLat): { x: number; y: number } => ({ x: (p.lon - f.lon0) * f.kx, y: (p.lat - f.lat0) * f.ky });

/** Cumulative length along a polyline, metres. */
function cumulative(f: Frame, pts: readonly LonLat[]): number[] {
    const s = [0];
    for (let i = 1; i < pts.length; i++) {
        const a = xy(f, pts[i - 1]), b = xy(f, pts[i]);
        s.push(s[i - 1] + Math.hypot(b.x - a.x, b.y - a.y));
    }
    return s;
}

/** The point at distance `d` along a polyline (clamped). */
function pointAt(pts: readonly LonLat[], s: readonly number[], d: number): LonLat {
    if (d <= 0) return pts[0];
    if (d >= s[s.length - 1]) return pts[pts.length - 1];
    let i = 1;
    while (s[i] < d) i++;
    const t = (d - s[i - 1]) / Math.max(1e-9, s[i] - s[i - 1]);
    return { lon: pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t, lat: pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t };
}

/** A polyline, oriented to start at its end `end`, with the road's own points. */
function oriented(piece: RoadPiece, end: 0 | 1): LonLat[] {
    return end === 0 ? piece.points : [...piece.points].reverse();
}

interface Approach {
    piece: RoadPiece;
    /** Which end of the piece meets the span. */
    end: 0 | 1;
}

/** Ends this close (metres) are one node cut by a tile border. */
const JOIN_M = 1.5;

/**
 * Roads of one class that meet end to end at exactly one other's end are one
 * road: the leaf tiles cut every road at their borders, and a 500 m ramp
 * has to run across them.
 */
export function mergeRoads(roads: readonly RoadPiece[]): RoadPiece[] {
    const cell = (v: number) => Math.round(v * 1e5);
    const endPt = (r: RoadPiece, end: 0 | 1) => r.points[end === 0 ? 0 : r.points.length - 1];
    const ends = new Map<string, Array<{ i: number; end: 0 | 1 }>>();
    roads.forEach((r, i) => ([0, 1] as const).forEach(end => {
        const p = endPt(r, end);
        const k = `${cell(p.lon)},${cell(p.lat)}`;
        (ends.get(k) ?? ends.set(k, []).get(k)!).push({ i, end });
    }));
    const partner = new Map<string, { i: number; end: 0 | 1 }>();
    roads.forEach((r, i) => ([0, 1] as const).forEach(end => {
        const p = endPt(r, end);
        const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
        const found: Array<{ i: number; end: 0 | 1 }> = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const e of ends.get(`${cell(p.lon) + dx},${cell(p.lat) + dy}`) ?? []) {
                    if (e.i === i && e.end === end) continue;
                    const q = endPt(roads[e.i], e.end);
                    if (Math.hypot((q.lon - p.lon) * kx, (q.lat - p.lat) * 111320) <= JOIN_M) found.push(e);
                }
            }
        }
        if (found.length === 1 && found[0].i !== i && roads[found[0].i].cls === r.cls) {
            partner.set(`${i}:${end}`, found[0]);
        }
    }));
    const used = new Uint8Array(roads.length);
    const out: RoadPiece[] = [];
    const walk = (start: number, startEnd: 0 | 1) => {
        const pts: LonLat[] = [];
        let half = 0, count = 0, i = start, entered: 0 | 1 = startEnd;
        for (;;) {
            used[i] = 1;
            const seg = entered === 0 ? roads[i].points : [...roads[i].points].reverse();
            pts.push(...(pts.length ? seg.slice(1) : seg));
            half += roads[i].halfM; count++;
            const nxt = partner.get(`${i}:${entered === 0 ? 1 : 0}`);
            if (!nxt || used[nxt.i]) break;
            i = nxt.i; entered = nxt.end;
        }
        out.push({ cls: roads[start].cls, halfM: half / count, points: pts });
    };
    roads.forEach((_, i) => {
        if (used[i]) return;
        if (!partner.has(`${i}:0`)) walk(i, 0);
        else if (!partner.has(`${i}:1`)) walk(i, 1);
    });
    roads.forEach((_, i) => { if (!used[i]) walk(i, 0); });
    return out;
}

export function planCrossings(
    spans: readonly CrossingSpan[], roadPieces: readonly RoadPiece[], env: CrossingEnv, stats?: CrossingStats,
): GradeLine[] {
    const out: GradeLine[] = [];
    const roads = mergeRoads(roadPieces);
    const bbox = roads.map(r => {
        let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
        for (const p of r.points) {
            w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat);
        }
        return { w, e, s, n };
    });

    for (const span of spans) {
        if (span.structure === 'tunnel' || span.points.length < 2) continue;
        const f = frameAt(span.points[0].lon, span.points[0].lat);
        const sp = span.points;
        const cum = cumulative(f, sp);
        const len = cum[cum.length - 1];
        if (len < 2 * END_ZONE_M + 4) continue;
        const thickness = DECK_THICKNESS_M[span.structure];
        const first = sp[0], last = sp[sp.length - 1];
        const g0 = env.roadH(first.lon, first.lat), g1 = env.roadH(last.lon, last.lat);
        const deckAt = (along: number) => g0 + (g1 - g0) * (along / len);

        // The roads that meet the span's ends, and the class the span itself is.
        const approaches: [Approach[], Approach[]] = [[], []];
        let classB = Infinity;
        const near = (a: LonLat, b: LonLat) => {
            const p = xy(f, a), q = xy(f, b);
            return Math.hypot(p.x - q.x, p.y - q.y) <= APPROACH_JOIN_M;
        };
        for (const r of roads) {
            for (const end of [0, 1] as const) {
                const p = r.points[end === 0 ? 0 : r.points.length - 1];
                if (near(p, first)) { approaches[0].push({ piece: r, end }); classB = Math.min(classB, r.cls); }
                if (near(p, last)) { approaches[1].push({ piece: r, end }); classB = Math.min(classB, r.cls); }
            }
        }
        if (!Number.isFinite(classB)) classB = 4;

        const spanBox = {
            w: Math.min(...sp.map(p => p.lon)), e: Math.max(...sp.map(p => p.lon)),
            s: Math.min(...sp.map(p => p.lat)), n: Math.max(...sp.map(p => p.lat)),
        };
        const pad = 0.0006;
        let shift = 0;

        roads.forEach((r, ri) => {
            const bb = bbox[ri];
            if (bb.e < spanBox.w - pad || bb.w > spanBox.e + pad || bb.n < spanBox.s - pad || bb.s > spanBox.n + pad) return;
            if (approaches[0].some(a => a.piece === r) || approaches[1].some(a => a.piece === r)) return;
            const rs = cumulative(f, r.points);
            for (let i = 0; i + 1 < r.points.length; i++) {
                const c = xy(f, r.points[i]), d = xy(f, r.points[i + 1]);
                for (let k = 0; k + 1 < sp.length; k++) {
                    const a = xy(f, sp[k]), b = xy(f, sp[k + 1]);
                    const ux = b.x - a.x, uy = b.y - a.y, vx = d.x - c.x, vy = d.y - c.y;
                    const den = ux * vy - uy * vx;
                    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
                    if (lu < 1e-6 || lv < 1e-6 || Math.abs(den) / (lu * lv) < MIN_CROSSING_SIN) continue;
                    const t = ((c.x - a.x) * vy - (c.y - a.y) * vx) / den;
                    const u = ((c.x - a.x) * uy - (c.y - a.y) * ux) / den;
                    if (t < 0 || t > 1 || u < 0 || u > 1) continue;
                    const along = cum[k] + t * lu;
                    if (along < END_ZONE_M || along > len - END_ZONE_M) continue;
                    const hit = { lon: sp[k].lon + (sp[k + 1].lon - sp[k].lon) * t, lat: sp[k].lat + (sp[k + 1].lat - sp[k].lat) * t };
                    const hR = env.roadH(hit.lon, hit.lat);
                    const under = deckAt(along) - thickness;
                    if (stats) stats.crossings++;
                    if (under - hR >= CLEARANCE_M) continue;
                    if (classB < r.cls) {
                        // The bridge is the bigger road: the smaller one sinks.
                        const cap = under - CLEARANCE_M;
                        if (hR - cap > MAX_CROSSING_WORK_M) { if (stats) stats.skipped++; continue; }
                        const line = senke(r, rs, i, u, cap, env);
                        if (line) { out.push({ ...line, priority: 1 }); if (stats) stats.dips++; }
                    } else {
                        shift = Math.max(shift, hR + CLEARANCE_M + thickness - deckAt(along));
                    }
                }
            }
        });

        if (shift <= NEGLIGIBLE_M) continue;
        // The smaller road rises: the deck is straight, so the whole line goes up
        // by `shift` and each abutment stands that much higher. The approaches
        // climb to it on a ramp out of each end.
        for (const which of [0, 1] as const) {
            for (const ap of approaches[which]) {
                const poly = oriented(ap.piece, ap.end);
                const ps = cumulative(f, poly);
                const endTop = (which === 0 ? g0 : g1) + shift;
                const endGround = env.ground(poly[0].lon, poly[0].lat);
                const grade = Math.min(crossingGrade(classB), Math.max(0, endTop - endGround) / RAMP_LENGTH_M);
                const cone = (s: number) => endTop - grade * s;
                const pts: GradePoint[] = [];
                let settled = 0, worst = 0;
                const total = Math.min(ps[ps.length - 1], MAX_WALK_M);
                for (let s = 0; s <= total + 1e-6; s += GRADE_STEP_M) {
                    const p = pointAt(poly, ps, s);
                    const g = env.ground(p.lon, p.lat);
                    const d = Math.max(g, cone(s));
                    worst = Math.max(worst, d - g);
                    pts.push({ lon: p.lon, lat: p.lat, h: d });
                    if (d - g <= NEGLIGIBLE_M) { if (++settled >= 2) break; } else settled = 0;
                }
                if (worst > MAX_CROSSING_WORK_M) { if (stats) stats.skipped++; continue; }
                if (worst > NEGLIGIBLE_M && pts.length >= 2) {
                    out.push({ halfM: ap.piece.halfM, points: pts, priority: 1 });
                    if (stats) stats.fills++;
                    // A street that joins the ramp partway up (a T-junction) is not
                    // itself part of it - mergeRoads only fuses one class end to
                    // end - but its own junction point now stands at the ramp's
                    // height, so it needs the same climb, tapered back to ground
                    // over its own RAMP_LENGTH_M.
                    const rampLen = pts.length > 1
                        ? Math.hypot(xy(f, pts[pts.length - 1]).x - xy(f, pts[0]).x, xy(f, pts[pts.length - 1]).y - xy(f, pts[0]).y)
                        : 0;
                    const rampHeightAt = (s: number) => Math.max(env.ground(pointAt(poly, ps, s).lon, pointAt(poly, ps, s).lat), cone(s));
                    adjustJunctions(f, poly, ps, Math.min(total, rampLen), rampHeightAt, roads, ap.piece, env, out);
                }
            }
        }
    }
    return out;
}

/** Streets that meet a ramp partway along it: lifted to the ramp's height there, tapered back to ground. */
function adjustJunctions(
    f: Frame, poly: readonly LonLat[], ps: readonly number[], rampLen: number, rampHeightAt: (s: number) => number,
    roads: readonly RoadPiece[], rampPiece: RoadPiece, env: CrossingEnv, out: GradeLine[],
): void {
    for (const r2 of roads) {
        if (r2 === rampPiece) continue;
        for (const end of [0, 1] as const) {
            const p = r2.points[end === 0 ? 0 : r2.points.length - 1];
            const pxy = xy(f, p);
            // Closest point of the endpoint's projection onto the ramp's own line.
            let bestS = -1, bestD = APPROACH_JOIN_M;
            for (let i = 0; i + 1 < poly.length; i++) {
                const a = xy(f, poly[i]), b = xy(f, poly[i + 1]);
                const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
                const t = len2 > 1e-9 ? Math.min(1, Math.max(0, ((pxy.x - a.x) * dx + (pxy.y - a.y) * dy) / len2)) : 0;
                const s = ps[i] + t * Math.sqrt(len2);
                if (s > ps[ps.length - 1] || s > rampLen + 1e-6) continue;
                const d = Math.hypot(a.x + dx * t - pxy.x, a.y + dy * t - pxy.y);
                if (d < bestD) { bestD = d; bestS = s; }
            }
            // s = 0 is the bridge abutment itself, already the ramp's own end.
            if (bestS <= NEGLIGIBLE_M) continue;
            // An unmerged continuation of the ramp's own road (a piece
            // mergeRoads missed - a class change, a stitch mergeRoads did not
            // make) lands its endpoint right on the ramp's own line too, at
            // zero angle. That is not a junction; it is the same road, which
            // already has its own general profile and needs no lift here. A
            // real side street crosses at an angle.
            const dir2 = xy(f, r2.points[end === 0 ? 1 : r2.points.length - 2]);
            const dx2 = dir2.x - pxy.x, dy2 = dir2.y - pxy.y;
            const len2m = Math.hypot(dx2, dy2);
            if (len2m > 1e-6) {
                let i = 0;
                while (i + 1 < poly.length && ps[i + 1] < bestS) i++;
                const a = xy(f, poly[i]), b = xy(f, poly[Math.min(i + 1, poly.length - 1)]);
                const rampLenXY = Math.hypot(b.x - a.x, b.y - a.y);
                if (rampLenXY > 1e-6) {
                    const sin = Math.abs((dx2 * (b.y - a.y) - dy2 * (b.x - a.x)) / (len2m * rampLenXY));
                    if (sin < MIN_CROSSING_SIN) continue;
                }
            }
            const junctionH = rampHeightAt(bestS);
            const poly2 = oriented(r2, end);
            const ps2 = cumulative(f, poly2);
            const g0 = env.ground(poly2[0].lon, poly2[0].lat);
            const total = Math.min(ps2[ps2.length - 1], MAX_WALK_M);
            const grade = Math.min(crossingGrade(r2.cls), Math.max(0, junctionH - g0) / Math.min(RAMP_LENGTH_M, total));
            const pts2: GradePoint[] = [];
            let settled = 0, worst = 0;
            for (let s = 0; s <= total + 1e-6; s += GRADE_STEP_M) {
                const q = pointAt(poly2, ps2, s);
                const g = env.ground(q.lon, q.lat);
                const d = Math.max(g, junctionH - grade * s);
                worst = Math.max(worst, d - g);
                pts2.push({ lon: q.lon, lat: q.lat, h: d });
                if (d - g <= NEGLIGIBLE_M) { if (++settled >= 2) break; } else settled = 0;
            }
            if (worst > NEGLIGIBLE_M && worst <= MAX_CROSSING_WORK_M && pts2.length >= 2) {
                out.push({ halfM: r2.halfM, points: pts2, priority: 1 });
            }
        }
    }
}

/** The cutting a smaller road sinks into under a bridge: ground, clipped by a cone stretched over RAMP_LENGTH_M. */
function senke(
    road: RoadPiece, rs: readonly number[], seg: number, u: number, cap: number, env: CrossingEnv,
): GradeLine | undefined {
    const hitS = rs[seg] + u * (rs[seg + 1] - rs[seg]);
    const hit = pointAt(road.points, rs, hitS);
    const depth = env.ground(hit.lon, hit.lat) - cap;
    if (depth <= NEGLIGIBLE_M) return undefined;
    const grade = Math.min(crossingGrade(road.cls), depth / RAMP_LENGTH_M);
    const reach = Math.min(MAX_WALK_M, depth / grade + 60);
    const from = Math.max(0, hitS - reach), to = Math.min(rs[rs.length - 1], hitS + reach);
    const pts: GradePoint[] = [];
    // The crossing itself is a sample, so the cutting's floor is exact.
    const at: number[] = [];
    for (let s = from; s <= to + 1e-6; s += GRADE_STEP_M) at.push(s);
    at.push(hitS);
    at.sort((a, b) => a - b);
    for (const s of at) {
        const p = pointAt(road.points, rs, s);
        const g = env.ground(p.lon, p.lat);
        pts.push({ lon: p.lon, lat: p.lat, h: Math.min(g, cap + grade * Math.abs(s - hitS)) });
    }
    return pts.length >= 2 ? { halfM: road.halfM, points: pts } : undefined;
}
