/**
 * The airframe as the webbing collides with it: the triangle tree for point
 * contacts, and the edges a strap can be caught on — leading and trailing
 * edges, wingtips, fin and intake lips — in a tree of their own for
 * link-against-edge contacts.
 *
 * A link (two webbing particles 0.3 m apart) can lie across a thin wing
 * with both ends clear of it: no point test sees that, and a swept particle
 * test does not either. What catches the strap is the edge, so the edges are
 * tested against the links directly.
 *
 * Everything is in the body frame and built once per airframe.
 */
import { buildTriangleBvh, bvhSegmentHit, TriangleBvh } from '../collision/triangleBvh';

/** Edges whose faces meet at more than this (convex) are edges a strap can catch on (rad). */
const FEATURE_ANGLE = (15 * Math.PI) / 180;
/** Vertices this close are one vertex when the soup is welded (m). */
const WELD_M = 1e-3;
/** Edges in a leaf of the edge tree. */
const EDGE_LEAF = 4;

export interface WebCollider {
    readonly bvh: TriangleBvh;
    /** Feature edges, 6 floats each (two endpoints, body frame). */
    readonly edges: Float32Array;
    /** Edge tree: node bounds (6 per node), left child or first slot, edge count (0 = internal), slot order. */
    readonly edgeBounds: Float32Array;
    readonly edgeLeftFirst: Int32Array;
    readonly edgeCount: Int32Array;
    readonly edgeIndex: Uint32Array;
    readonly triangleCount: number;
}

/** Weld a soup: vertex positions and per-corner vertex ids. */
export function weldSoup(tri: ArrayLike<number>): { pos: Float64Array; ids: Int32Array } {
    const corners = Math.floor(tri.length / 3);
    const map = new Map<string, number>();
    const pos: number[] = [];
    const ids = new Int32Array(corners);
    const q = 1 / WELD_M;
    for (let c = 0; c < corners; c++) {
        const x = tri[3 * c], y = tri[3 * c + 1], z = tri[3 * c + 2];
        const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
        let v = map.get(key);
        if (v === undefined) {
            v = pos.length / 3;
            map.set(key, v);
            pos.push(x, y, z);
        }
        ids[c] = v;
    }
    return { pos: Float64Array.from(pos), ids };
}

/**
 * Edges a strap can catch on: open edges (a panel's rim, a sheet fin's
 * edge), edges shared by more than two faces, and convex edges sharper than
 * {@link FEATURE_ANGLE}.
 */
export function featureEdges(tri: ArrayLike<number>): Float32Array {
    const { pos, ids } = weldSoup(tri);
    const faces = ids.length / 3;
    const normal = new Float64Array(3 * faces);
    for (let f = 0; f < faces; f++) {
        const a = 3 * ids[3 * f], b = 3 * ids[3 * f + 1], c = 3 * ids[3 * f + 2];
        const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
        const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const l = Math.hypot(nx, ny, nz) || 1;
        normal[3 * f] = nx / l; normal[3 * f + 1] = ny / l; normal[3 * f + 2] = nz / l;
    }
    // Faces on each undirected edge, with the vertex opposite it.
    const edgeFaces = new Map<number, number[]>();
    const nv = pos.length / 3;
    for (let f = 0; f < faces; f++) {
        for (let e = 0; e < 3; e++) {
            const u = ids[3 * f + e], v = ids[3 * f + ((e + 1) % 3)];
            if (u === v) continue;
            const key = u < v ? u * nv + v : v * nv + u;
            let list = edgeFaces.get(key);
            if (!list) edgeFaces.set(key, list = []);
            list.push(f, ids[3 * f + ((e + 2) % 3)]);
        }
    }
    const out: number[] = [];
    const cosMax = Math.cos(FEATURE_ANGLE);
    for (const [key, list] of edgeFaces) {
        const u = Math.floor(key / nv), v = key % nv;
        let keep = list.length !== 4;
        if (!keep) {
            const f1 = list[0], f2 = list[2], opp2 = list[3];
            const c = normal[3 * f1] * normal[3 * f2] + normal[3 * f1 + 1] * normal[3 * f2 + 1] + normal[3 * f1 + 2] * normal[3 * f2 + 2];
            // Convex: the second face's far vertex lies behind the first face.
            const o = 3 * opp2, a = 3 * u;
            const behind = normal[3 * f1] * (pos[o] - pos[a]) + normal[3 * f1 + 1] * (pos[o + 1] - pos[a + 1])
                + normal[3 * f1 + 2] * (pos[o + 2] - pos[a + 2]) < 0;
            // Faces folded back on each other are the rim of a sheet (decimation flattens
            // a thin door to one): the far vertex lies on the plane, not behind it.
            keep = c < cosMax && (behind || c < -0.9);
        }
        if (keep) out.push(pos[3 * u], pos[3 * u + 1], pos[3 * u + 2], pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
    }
    return Float32Array.from(out);
}

/**
 * Generalised winding number of a soup about a point: about 1 inside a
 * closed part, 0 outside, a half on its surface.
 */
export function windingNumber(t: ArrayLike<number>, px: number, py: number, pz: number): number {
    let s = 0;
    for (let o = 0; o + 8 < t.length; o += 9) {
        const ax = t[o] - px, ay = t[o + 1] - py, az = t[o + 2] - pz;
        const bx = t[o + 3] - px, by = t[o + 4] - py, bz = t[o + 5] - pz;
        const cx = t[o + 6] - px, cy = t[o + 7] - py, cz = t[o + 8] - pz;
        const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
        const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
        const den = la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la
            + (cx * ax + cy * ay + cz * az) * lb;
        s += 2 * Math.atan2(det, den);
    }
    return s / (4 * Math.PI);
}

export function buildWebCollider(triangles: ArrayLike<number>): WebCollider {
    const bvh = buildTriangleBvh(triangles);
    const edges = featureEdges(triangles);
    const n = edges.length / 6;
    const edgeIndex = new Uint32Array(n);
    for (let i = 0; i < n; i++) edgeIndex[i] = i;
    const maxNodes = Math.max(1, 2 * n);
    const bounds = new Float32Array(6 * maxNodes);
    const leftFirst = new Int32Array(maxNodes);
    const count = new Int32Array(maxNodes);
    let used = 1;
    const mid = (e: number, axis: number) => (edges[6 * e + axis] + edges[6 * e + 3 + axis]) / 2;
    const build = (node: number, first: number, cnt: number) => {
        let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
        let cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
        for (let k = first; k < first + cnt; k++) {
            const o = 6 * edgeIndex[k];
            for (const p of [o, o + 3]) {
                mnx = Math.min(mnx, edges[p]); mny = Math.min(mny, edges[p + 1]); mnz = Math.min(mnz, edges[p + 2]);
                mxx = Math.max(mxx, edges[p]); mxy = Math.max(mxy, edges[p + 1]); mxz = Math.max(mxz, edges[p + 2]);
            }
            for (let a = 0; a < 3; a++) {
                const m = mid(edgeIndex[k], a);
                cmn[a] = Math.min(cmn[a], m); cmx[a] = Math.max(cmx[a], m);
            }
        }
        bounds.set([mnx, mny, mnz, mxx, mxy, mxz], 6 * node);
        if (cnt <= EDGE_LEAF) {
            leftFirst[node] = first;
            count[node] = cnt;
            return;
        }
        const ext = [cmx[0] - cmn[0], cmx[1] - cmn[1], cmx[2] - cmn[2]];
        const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
        const split = (cmn[axis] + cmx[axis]) / 2;
        let lo = first, hi = first + cnt - 1;
        while (lo <= hi) {
            if (mid(edgeIndex[lo], axis) < split) lo++;
            else { const t = edgeIndex[lo]; edgeIndex[lo] = edgeIndex[hi]; edgeIndex[hi] = t; hi--; }
        }
        let left = lo - first;
        if (left === 0 || left === cnt) left = cnt >> 1;
        const l = used;
        used += 2;
        leftFirst[node] = l;
        count[node] = 0;
        build(l, first, left);
        build(l + 1, first + left, cnt - left);
    };
    if (n > 0) build(0, 0, n);
    return {
        bvh, edges, edgeBounds: bounds, edgeLeftFirst: leftFirst, edgeCount: count, edgeIndex,
        triangleCount: Math.floor(triangles.length / 9),
    };
}

const _stack = new Int32Array(128);

/** Edges whose boxes overlap the box; returns how many were written to `out`. */
export function queryEdges(c: WebCollider, mnx: number, mny: number, mnz: number,
    mxx: number, mxy: number, mxz: number, out: Int32Array): number {
    if (c.edges.length === 0) return 0;
    const b = c.edgeBounds;
    let sp = 0, found = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
        const node = _stack[--sp];
        const o = 6 * node;
        if (b[o] > mxx || b[o + 3] < mnx || b[o + 1] > mxy || b[o + 4] < mny || b[o + 2] > mxz || b[o + 5] < mnz) continue;
        const cnt = c.edgeCount[node];
        if (cnt > 0) {
            const first = c.edgeLeftFirst[node];
            for (let k = first; k < first + cnt && found < out.length; k++) {
                const e = 6 * c.edgeIndex[k];
                const ed = c.edges;
                if (Math.min(ed[e], ed[e + 3]) > mxx || Math.max(ed[e], ed[e + 3]) < mnx
                    || Math.min(ed[e + 1], ed[e + 4]) > mxy || Math.max(ed[e + 1], ed[e + 4]) < mny
                    || Math.min(ed[e + 2], ed[e + 5]) > mxz || Math.max(ed[e + 2], ed[e + 5]) < mnz) continue;
                out[found++] = c.edgeIndex[k];
            }
            continue;
        }
        _stack[sp++] = c.edgeLeftFirst[node];
        _stack[sp++] = c.edgeLeftFirst[node] + 1;
    }
    return found;
}

/**
 * Triangles whose boxes come within `r` of the point; returns how many were
 * written to `out`, or -1 when there were more than it holds.
 */
export function queryTriangles(c: WebCollider, px: number, py: number, pz: number, r: number, out: Int32Array): number {
    const bvh = c.bvh;
    if (bvh.triIndex.length === 0) return 0;
    const b = bvh.bounds;
    const r2 = r * r;
    let sp = 0, found = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
        const node = _stack[--sp];
        const o = 6 * node;
        const dx = px < b[o] ? b[o] - px : px > b[o + 3] ? px - b[o + 3] : 0;
        const dy = py < b[o + 1] ? b[o + 1] - py : py > b[o + 4] ? py - b[o + 4] : 0;
        const dz = pz < b[o + 2] ? b[o + 2] - pz : pz > b[o + 5] ? pz - b[o + 5] : 0;
        if (dx * dx + dy * dy + dz * dz > r2) continue;
        const cnt = bvh.triCount[node];
        if (cnt > 0) {
            const first = bvh.leftFirst[node];
            for (let k = first; k < first + cnt; k++) {
                if (found === out.length) return -1;
                out[found++] = bvh.triIndex[k];
            }
            continue;
        }
        _stack[sp++] = bvh.leftFirst[node];
        _stack[sp++] = bvh.leftFirst[node] + 1;
    }
    return found;
}

/** Closest point of the last {@link closestOnTriangle}. */
export const closest = { x: 0, y: 0, z: 0 };

/**
 * Closest point on triangle `t` of the soup to a point (Ericson, Real-Time
 * Collision Detection 5.1.5), into {@link closest}; returns its squared distance.
 */
export function closestOnTriangle(tri: Float32Array, t: number, px: number, py: number, pz: number): number {
    const o = 9 * t;
    const ax = tri[o], ay = tri[o + 1], az = tri[o + 2];
    const abx = tri[o + 3] - ax, aby = tri[o + 4] - ay, abz = tri[o + 5] - az;
    const acx = tri[o + 6] - ax, acy = tri[o + 7] - ay, acz = tri[o + 8] - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    let cx: number, cy: number, cz: number;
    if (d1 <= 0 && d2 <= 0) {
        cx = ax; cy = ay; cz = az;
    } else {
        const bpx = apx - abx, bpy = apy - aby, bpz = apz - abz;
        const d3 = abx * bpx + aby * bpy + abz * bpz;
        const d4 = acx * bpx + acy * bpy + acz * bpz;
        const cpx = apx - acx, cpy = apy - acy, cpz = apz - acz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        const vc = d1 * d4 - d3 * d2;
        const vb = d5 * d2 - d1 * d6;
        const va = d3 * d6 - d5 * d4;
        if (d3 >= 0 && d4 <= d3) {
            cx = ax + abx; cy = ay + aby; cz = az + abz;
        } else if (vc <= 0 && d1 >= 0 && d3 <= 0) {
            const v = d1 / (d1 - d3);
            cx = ax + abx * v; cy = ay + aby * v; cz = az + abz * v;
        } else if (d6 >= 0 && d5 <= d6) {
            cx = ax + acx; cy = ay + acy; cz = az + acz;
        } else if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            cx = ax + acx * w; cy = ay + acy * w; cz = az + acz * w;
        } else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
            const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
            cx = ax + abx + (acx - abx) * w; cy = ay + aby + (acy - aby) * w; cz = az + abz + (acz - abz) * w;
        } else {
            const den = 1 / (va + vb + vc);
            const v = vb * den, w = vc * den;
            cx = ax + abx * v + acx * w; cy = ay + aby * v + acy * w; cz = az + abz * v + acz * w;
        }
    }
    closest.x = cx; closest.y = cy; closest.z = cz;
    return (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
}

/** Gaps above a part standing on the deck up to this tall (m) are closed by a strut. */
const MAX_GEAR_GAP_M = 1;
/** A gear part whose bottom is this close above the deck (m) but not on it is let down to it. */
const MAX_WHEEL_LIFT_M = 0.3;
/** Only a part at least this tall (a wheel, a leg) is let down; fragments of a leg are not (m). */
const MIN_WHEEL_M = 0.25;
/** Hanging wheels closer than this side by side (m) share an axle. */
const TWIN_GAP_M = 0.4;
/** Narrowest strut a closed gap gets (m). */
const MIN_STRUT_M = 0.08;

/**
 * Close the gap between a landing-gear part and the airframe above it.
 * Low-detail drawn models float a wheel or leg under the fuselage (the
 * F-22's nose gear stops 34 cm short of it); the lower belt slid through
 * that gap instead of bearing on the strut, and the whole lower-belt load
 * went into two straps. A part that stands on the deck (within 10 cm of
 * the lowest point) and has airframe within a metre straight above its top
 * gets a box from its top up to that surface; one hanging up to 30 cm
 * clear of the deck gets a box down to it. Returns a new soup (the input
 * when nothing needed closing).
 */
export function closeGearGaps(tri: Float32Array): Float32Array {
    const { pos, ids } = weldSoup(tri);
    const nv = pos.length / 3;
    const faces = ids.length / 3;
    const parent = new Int32Array(nv);
    for (let v = 0; v < nv; v++) parent[v] = v;
    const find = (v: number): number => {
        while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
        return v;
    };
    for (let f = 0; f < faces; f++) {
        const r = find(ids[3 * f]);
        parent[find(ids[3 * f + 1])] = r;
        parent[find(ids[3 * f + 2])] = r;
    }
    let minY = Infinity;
    for (let v = 0; v < nv; v++) minY = Math.min(minY, pos[3 * v + 1]);
    const box = new Map<number, number[]>();
    for (let v = 0; v < nv; v++) {
        const r = find(v);
        let b = box.get(r);
        if (!b) box.set(r, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
        for (let k = 0; k < 3; k++) {
            b[k] = Math.min(b[k], pos[3 * v + k]);
            b[k + 3] = Math.max(b[k + 3], pos[3 * v + k]);
        }
    }
    const bvh = buildTriangleBvh(tri);
    const hit = { t: 1, tri: -1, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
    const extra: number[] = [];
    // A wheel hanging just clear of the deck (the airframe rests on its other gear): the
    // lower belt slid under it. Wheels stand on the deck, so that gap is closed too, for
    // wheels side by side on one axle (a twin nose gear) as one: between the two the belt
    // wedged in the slot instead of resting on the axle.
    const hanging = [...box.values()].filter(b => b[1] > minY + 0.02 && b[1] < minY + MAX_WHEEL_LIFT_M
        && b[4] - b[1] >= MIN_WHEEL_M && b[4] - b[1] < 1.5).map(b => b.slice());
    for (let i = 0; i < hanging.length; i++) {
        for (let j = i + 1; j < hanging.length; j++) {
            const a = hanging[i], c = hanging[j];
            if (a[2] > c[5] || c[2] > a[5] || Math.max(a[0], c[0]) - Math.min(a[3], c[3]) > TWIN_GAP_M) continue;
            for (let k = 0; k < 3; k++) { a[k] = Math.min(a[k], c[k]); a[k + 3] = Math.max(a[k + 3], c[k + 3]); }
            hanging.splice(j, 1);
            j = i;
        }
    }
    for (const b of hanging) {
        const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
        const hx = Math.max(MIN_STRUT_M, b[3] - b[0]) / 2, hz = Math.max(MIN_STRUT_M, Math.min(0.3, b[5] - b[2])) / 2;
        pushBox(extra, cx - hx, minY, cz - hz, cx + hx, b[1] + 0.02, cz + hz);
    }
    for (const b of box.values()) {
        const cx = (b[0] + b[3]) / 2, cz = (b[2] + b[5]) / 2;
        if (b[1] > minY + MAX_WHEEL_LIFT_M) continue;
        const top = b[4];
        if (!bvhSegmentHitAbove(bvh, cx, top + 1e-3, cz, MAX_GEAR_GAP_M, hit)) continue;
        const gap = hit.y - top;
        if (gap < 0.02) continue;
        const hx = Math.max(MIN_STRUT_M, b[3] - b[0]) / 2, hz = Math.max(MIN_STRUT_M, Math.min(0.3, b[5] - b[2])) / 2;
        pushBox(extra, cx - hx, top - 0.02, cz - hz, cx + hx, hit.y + 0.02, cz + hz);
    }
    if (extra.length === 0) return tri;
    const out = new Float32Array(tri.length + extra.length);
    out.set(tri);
    out.set(extra, tri.length);
    return out;
}

function bvhSegmentHitAbove(bvh: TriangleBvh, x: number, y: number, z: number, reach: number, out: { t: number; tri: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }): boolean {
    return bvhSegmentHit(bvh, x, y, z, x, y + reach, z, out);
}

/** Twelve outward-wound triangles of an axis-aligned box. */
function pushBox(out: number[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]];
    for (const [a, b, d, e] of quads) {
        for (const v of [a, b, d, a, d, e]) out.push(c[v][0], c[v][1], c[v][2]);
    }
}
