/**
 * Level-crossing furniture: a St Andrew's cross on a post and a half
 * barrier on each approach to every level crossing, as boxes for the bridge
 * sidecar (see bridgeMesh.ts buildBoxMesh).
 *
 * The crossings come from the leaf .rvr, as TRACK_CROSSING_CLASS polylines
 * along the track (tools/bake_osm_roads.py crossing_parts), one per track. A
 * road over three tracks is one crossing with one pair of barriers, so they
 * are grouped by the road they lie on first. Everything is placed in the
 * tile's true local frame (tileSurface.ts): x and z horizontal, y up the
 * real vertical, so a post stands straight however far the tile's axes lean.
 *
 * Traffic keeps right: the cross and the barrier stand at the right-hand
 * edge of the road facing the traffic that meets them. The barriers are
 * drawn raised - open, the state a crossing is in nearly all the time.
 */

import { BridgeRole } from '../../src/script/terrain/pbr';
import { RoadClass } from '../../src/script/terrain/ptr';
import { RoadLine } from './rvr';

type XZ = { x: number; z: number };
type P = [number, number, number];

/** A box in the true local frame: centre (x, h, z), three unit axes, half sizes along them. */
export interface FurnitureBox {
    centre: P;
    axes: [P, P, P];
    half: [number, number, number];
    role: BridgeRole;
}

export interface CrossingSurface {
    toXZ(lon: number, lat: number): XZ;
    landH(x: number, z: number): number | undefined;
}

/**
 * A stretch of drawn stroke centreline (the .ptr, in the true local frame)
 * and how far furniture must keep from it: the leaf draws roads and track as
 * splines that can stray from their mapped nodes by more than a metre, and
 * a barrier placed against the nodes stood on the road as drawn.
 */
export interface DrawnSegment {
    a: XZ;
    b: XZ;
    clearance: number;
    /** Heights of the drawn stroke at a and b, along up, lift included; roads only. */
    ha?: number;
    hb?: number;
}

/** Clearance from a drawn road's centreline: half its width plus this, metres. */
export const DRAWN_ROAD_MARGIN_M = 0.9;
/** Clearance from a drawn track's centreline, metres. */
export const DRAWN_TRACK_CLEARANCE_M = 3.2;

/** A road this close to a crossing's midpoint is the road it carries, metres. */
const ROAD_MATCH_M = 3;
/**
 * Tracks crossing one road with less than this between neighbours, along
 * the road, are one crossing with one pair of barriers, metres.
 */
const GROUP_GAP_M = 20;
/** Furniture keeps this far from the centreline of any track, metres. */
const TRACK_CLEARANCE_M = 3.2;
/** How far it may be moved along the road to find that clearance, metres. */
const CLEARANCE_SEARCH_M = 12;
/** Half the track bed each crossing's track takes along the road, before the crossing angle, metres. */
const TRACK_BED_HALF_M = 2.5;
/** Barrier this far before the outermost track bed's edge, metres. */
const BARRIER_SETBACK_M = 2.5;
/** The cross this far before the barrier, metres. */
const CROSS_SETBACK_M = 1.5;
/** Both stand this far outside the road's edge, metres. */
const KERB_M = 0.9;
/** Furniture keeps this far outside any road's edge, metres. */
const ROAD_CLEARANCE_M = 0.5;

const CROSS_POST_HALF: [number, number, number] = [0.05, 1.2, 0.05];
const CROSS_BOARD_HALF_LENGTH = 0.6;
const CROSS_BOARD_HALF_WIDTH = 0.075;
const CROSS_BOARD_HALF_THICK = 0.012;
const CROSS_BOARD_SEGMENTS = 5;
const CROSS_CENTRE_H = 2.05;
const BARRIER_POST_HALF: [number, number, number] = [0.18, 0.5, 0.18];
const BARRIER_ARM_HALF_THICK = 0.05;
const BARRIER_STRIPE_M = 0.5;

const UP: P = [0, 1, 0];

export interface CrossingFurnitureStats {
    crossings: number;
    sides: number;
}

/**
 * The boxes for every level crossing among `parts` (a leaf tile's .rvr),
 * on `surface`. Crossings whose road cannot be found, or whose ground has no
 * height, are left bare.
 */
export function planCrossingFurniture(
    parts: readonly RoadLine[], surface: CrossingSurface, stats?: CrossingFurnitureStats,
    /**
     * How far the road and track strokes float over the ground
     * (drapeRoads.ts strokeLiftM): the furniture stands on that level, or
     * its foot looks sunk inside the road and the track bed beside it.
     */
    liftM: number = 0,
    /** The drawn strokes to keep clear of, when the tile has them. */
    drawn: readonly DrawnSegment[] = [],
): FurnitureBox[] {
    const crossings = parts.filter(p => p.cls === RoadClass.Crossing && p.points.length >= 2);
    if (crossings.length === 0) {
        return [];
    }
    const roads = parts.filter(p => p.cls < RoadClass.Rail && p.points.length >= 2)
        .map(r => ({ widthM: r.widthM, pts: r.points.map(q => surface.toXZ(q.lon, q.lat)) }));
    const handed = handedness(surface, parts);

    // Each crossing: its midpoint on the track, the track's direction, the road it lies on.
    const found: { mid: XZ; track: XZ; road: number; seg: number }[] = [];
    for (const c of crossings) {
        const pts = c.points.map(q => surface.toXZ(q.lon, q.lat));
        const mid = along(pts, length(pts) / 2);
        const track = unit(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].z - pts[0].z);
        let best = -1, bestSeg = -1, bestD = ROAD_MATCH_M;
        roads.forEach((r, ri) => {
            for (let i = 0; i + 1 < r.pts.length; i++) {
                const d = segDist(mid, r.pts[i], r.pts[i + 1]);
                if (d < bestD) {
                    bestD = d; best = ri; bestSeg = i;
                }
            }
        });
        if (best >= 0 && track) {
            found.push({ mid, track, road: best, seg: bestSeg });
        }
    }

    const boxes: FurnitureBox[] = [];
    const tracks = parts.filter(p => (p.cls === RoadClass.Rail || p.cls === RoadClass.RailService) && p.points.length >= 2)
        .map(t => t.points.map(q => surface.toXZ(q.lon, q.lat)));
    const clear = (p: XZ) => tracks.every(t => {
        for (let i = 0; i + 1 < t.length; i++) {
            if (segDist(p, t[i], t[i + 1]) < TRACK_CLEARANCE_M) {
                return false;
            }
        }
        return true;
    }) && roads.every(r => {
        // Off every road too: a junction or a road alongside the track.
        for (let i = 0; i + 1 < r.pts.length; i++) {
            if (segDist(p, r.pts[i], r.pts[i + 1]) < r.widthM / 2 + ROAD_CLEARANCE_M) {
                return false;
            }
        }
        return true;
    });

    // Group by road, then chain along it: neighbouring tracks closer than
    // GROUP_GAP_M share one crossing however many there are.
    const byRoad = new Map<number, typeof found>();
    for (const f of found) {
        const list = byRoad.get(f.road) ?? [];
        list.push(f);
        byRoad.set(f.road, list);
    }
    const groups: { members: typeof found; r: XZ; origin: XZ }[] = [];
    for (const list of byRoad.values()) {
        const road = roads[list[0].road];
        const a = road.pts[list[0].seg], b = road.pts[list[0].seg + 1];
        const r = unit(b.x - a.x, b.z - a.z);
        if (!r) {
            continue;
        }
        const origin = list[0].mid;
        const sOf = (f: (typeof found)[number]) => (f.mid.x - origin.x) * r.x + (f.mid.z - origin.z) * r.z;
        const sorted = [...list].sort((p, q) => sOf(p) - sOf(q));
        let current = [sorted[0]];
        for (let i = 1; i < sorted.length; i++) {
            if (sOf(sorted[i]) - sOf(sorted[i - 1]) < GROUP_GAP_M) {
                current.push(sorted[i]);
            } else {
                groups.push({ members: current, r, origin });
                current = [sorted[i]];
            }
        }
        groups.push({ members: current, r, origin });
    }

    for (const { members: group, r, origin } of groups) {
        const road = roads[group[0].road];
        // Where along the road each track lies, and how much of the road its bed takes.
        let lo = Infinity, hi = -Infinity;
        for (const g of group) {
            const s = (g.mid.x - origin.x) * r.x + (g.mid.z - origin.z) * r.z;
            const sin = Math.max(Math.abs(g.track.x * r.z - g.track.z * r.x), Math.sin(20 * Math.PI / 180));
            lo = Math.min(lo, s - TRACK_BED_HALF_M / sin);
            hi = Math.max(hi, s + TRACK_BED_HALF_M / sin);
        }
        stats && stats.crossings++;
        for (const side of [-1, 1]) {
            // Traffic meeting the crossing from this side travels toward it.
            const edge = side < 0 ? lo : hi;
            const lateral = road.widthM / 2 + KERB_M;
            // Along the road's own line, not the straight one at the
            // crossing: roads often bend to meet a track square, and 10 m on
            // along a straight line can land back on the road.
            const base = arcPosition(road.pts, origin);
            const place = (setback: number): { at: XZ; dir: XZ; right: XZ } => {
                const { p, t } = pointAlong(road.pts, base + edge + side * setback);
                const dir = { x: -side * t.x, z: -side * t.z };
                const right = { x: handed * dir.z, z: -handed * dir.x };
                return { at: { x: p.x + right.x * lateral, z: p.z + right.z * lateral }, dir, right };
            };
            const at = (setback: number): XZ => place(setback).at;
            // Moved out along the road, away from the crossing, until both
            // stand clear of every track: a siding a few metres off the
            // crossing must not get a barrier planted on it.
            let extra = 0;
            while (extra <= CLEARANCE_SEARCH_M
                && !(clear(at(BARRIER_SETBACK_M + extra)) && clear(at(BARRIER_SETBACK_M + CROSS_SETBACK_M + extra)))) {
                extra += 0.5;
            }
            if (extra > CLEARANCE_SEARCH_M) {
                continue;
            }
            const barrier = pushClear(at(BARRIER_SETBACK_M + extra), drawn);
            const crossAt = place(BARRIER_SETBACK_M + CROSS_SETBACK_M + extra);
            const cross = pushClear(crossAt.at, drawn);
            // Stand on the road as drawn: its height beside the post, where
            // the tile has strokes. The highest terrain facet under the post
            // can sit a metre or more above the surface the strokes are draped
            // on, and furniture floating that high looks, from above, as if
            // it stood inside the road.
            const ground = (p: XZ): number | undefined => {
                const drawnH = roadHeightNear(p, drawn);
                if (drawnH !== undefined) {
                    return drawnH;
                }
                const h = surface.landH(p.x, p.z);
                return h === undefined ? undefined : h + liftM;
            };
            const hb = ground(barrier), hc = ground(cross);
            if (hb === undefined || hc === undefined) {
                continue;
            }
            stats && stats.sides++;
            addCross(boxes, cross, hc, crossAt.dir, crossAt.right);
            addBarrier(boxes, barrier, hb, road.widthM);
        }
    }
    return boxes;
}

function addCross(boxes: FurnitureBox[], at: XZ, ground: number, dir: XZ, right: XZ): void {
    const along: P = [dir.x, 0, dir.z];
    const side: P = [right.x, 0, right.z];
    boxes.push({
        centre: [at.x, ground + CROSS_POST_HALF[1], at.z],
        axes: [side, UP, along], half: CROSS_POST_HALF, role: BridgeRole.SignPost,
    });
    // The two boards cross at right angles, each 45 degrees off the vertical,
    // a hair in front of the post toward the traffic that reads them.
    const c: P = [
        at.x - dir.x * (CROSS_POST_HALF[2] + CROSS_BOARD_HALF_THICK + 0.005),
        ground + CROSS_CENTRE_H,
        at.z - dir.z * (CROSS_POST_HALF[2] + CROSS_BOARD_HALF_THICK + 0.005),
    ];
    const k = Math.SQRT1_2;
    for (const s of [1, -1]) {
        const long: P = [side[0] * k * s, k, side[2] * k * s];
        const wide = cross3(along, long);
        const seg = (2 * CROSS_BOARD_HALF_LENGTH) / CROSS_BOARD_SEGMENTS;
        for (let i = 0; i < CROSS_BOARD_SEGMENTS; i++) {
            const t = -CROSS_BOARD_HALF_LENGTH + seg * (i + 0.5);
            boxes.push({
                centre: [c[0] + long[0] * t, c[1] + long[1] * t, c[2] + long[2] * t],
                axes: [long, wide, along],
                half: [seg / 2, CROSS_BOARD_HALF_WIDTH, CROSS_BOARD_HALF_THICK],
                role: i % 2 === 0 ? BridgeRole.SignRed : BridgeRole.SignWhite,
            });
        }
    }
}

function addBarrier(boxes: FurnitureBox[], at: XZ, ground: number, roadWidthM: number): void {
    const xAxis: P = [1, 0, 0], zAxis: P = [0, 0, 1];
    boxes.push({
        centre: [at.x, ground + BARRIER_POST_HALF[1], at.z],
        axes: [xAxis, UP, zAxis], half: BARRIER_POST_HALF, role: BridgeRole.SignWhite,
    });
    // The arm, raised: long enough to close the near half of the road.
    const length = roadWidthM / 2 + 1;
    const stripes = Math.max(2, Math.round(length / BARRIER_STRIPE_M));
    const seg = length / stripes;
    const base = ground + 2 * BARRIER_POST_HALF[1];
    for (let i = 0; i < stripes; i++) {
        boxes.push({
            centre: [at.x, base + seg * (i + 0.5), at.z],
            axes: [xAxis, UP, zAxis],
            half: [BARRIER_ARM_HALF_THICK, seg / 2, BARRIER_ARM_HALF_THICK],
            role: i % 2 === 0 ? BridgeRole.SignRed : BridgeRole.SignWhite,
        });
    }
}

/**
 * +1 when the frame's x and z turn east into north counterclockwise (as
 * plain x/y axes do), -1 when mirrored: which way "right" is.
 */
function handedness(surface: CrossingSurface, parts: readonly RoadLine[]): number {
    const p = parts[0].points[0];
    const o = surface.toXZ(p.lon, p.lat);
    const e = surface.toXZ(p.lon + 1e-4, p.lat);
    const n = surface.toXZ(p.lon, p.lat + 1e-4);
    const ex = e.x - o.x, ez = e.z - o.z, nx = n.x - o.x, nz = n.z - o.z;
    return ex * nz - ez * nx >= 0 ? 1 : -1;
}

/** The drawn road's height at the centreline point nearest `p`, within 10 m, or undefined. */
function roadHeightNear(p: XZ, drawn: readonly DrawnSegment[]): number | undefined {
    let best = 10, h: number | undefined;
    for (const s of drawn) {
        if (s.ha === undefined || s.hb === undefined) {
            continue;
        }
        const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((p.x - s.a.x) * dx + (p.z - s.a.z) * dz) / l2)) : 0;
        const d = Math.hypot(p.x - s.a.x - dx * t, p.z - s.a.z - dz * t);
        if (d < best) {
            best = d;
            h = s.ha + (s.hb - s.ha) * t;
        }
    }
    return h;
}

/**
 * `p` moved straight away from every drawn centreline it is closer to than
 * that stroke's clearance, a few rounds so a push off one does not leave it
 * on another.
 */
export function pushClear(p: XZ, drawn: readonly DrawnSegment[]): XZ {
    let q = { ...p };
    for (let round = 0; round < 6; round++) {
        let moved = false;
        for (const s of drawn) {
            const dx = s.b.x - s.a.x, dz = s.b.z - s.a.z;
            const l2 = dx * dx + dz * dz;
            const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((q.x - s.a.x) * dx + (q.z - s.a.z) * dz) / l2)) : 0;
            const nx = q.x - (s.a.x + dx * t), nz = q.z - (s.a.z + dz * t);
            const d = Math.hypot(nx, nz);
            if (d >= s.clearance) {
                continue;
            }
            // Straight out from the nearest point; dead on the line, square to it.
            let ux = nx, uz = nz;
            if (d < 1e-6) {
                const l = Math.sqrt(l2) || 1;
                ux = -dz / l; uz = dx / l;
            } else {
                ux /= d; uz /= d;
            }
            q = { x: q.x + ux * (s.clearance - d + 0.01), z: q.z + uz * (s.clearance - d + 0.01) };
            moved = true;
        }
        if (!moved) {
            break;
        }
    }
    return q;
}

/** Distance along a polyline to the point on it nearest `p`. */
function arcPosition(pts: readonly XZ[], p: XZ): number {
    let best = Infinity, at = 0, run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        const t = len > 1e-9 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (len * len))) : 0;
        const d = Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
        if (d < best) {
            best = d;
            at = run + t * len;
        }
        run += len;
    }
    return at;
}

/**
 * The point `s` metres along a polyline and its unit direction there;
 * past either end, straight on along the end segment.
 */
function pointAlong(pts: readonly XZ[], s: number): { p: XZ; t: XZ } {
    let run = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len < 1e-9) {
            continue;
        }
        const last = i + 2 === pts.length;
        if (s <= run + len || last || (i === 0 && s < 0)) {
            const k = (s - run) / len;
            const t = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
            return { p: { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }, t };
        }
        run += len;
    }
    return { p: pts[0], t: { x: 1, z: 0 } };
}

function cross3(a: P, b: P): P {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(x: number, z: number): XZ | undefined {
    const n = Math.hypot(x, z);
    return n > 1e-9 ? { x: x / n, z: z / n } : undefined;
}

function length(pts: readonly XZ[]): number {
    let n = 0;
    for (let i = 1; i < pts.length; i++) {
        n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    }
    return n;
}

function along(pts: readonly XZ[], s: number): XZ {
    let run = 0;
    for (let i = 1; i < pts.length; i++) {
        const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        if (run + seg >= s && seg > 0) {
            const t = (s - run) / seg;
            return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t };
        }
        run += seg;
    }
    return pts[pts.length - 1];
}

function segDist(p: XZ, a: XZ, b: XZ): number {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

