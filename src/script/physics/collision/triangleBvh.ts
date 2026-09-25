/**
 * Bounding-volume hierarchy over a body-frame triangle soup.
 *
 * The barricade solver drives a few hundred webbing particles against an
 * airframe every substep, which is a different shape of query from the handful
 * of bullet and crash tests in {@link ../sim/aircraftCollision}: that walks the
 * whole soup linearly, which is fine a few times a frame and hopeless a few
 * thousand times.
 *
 * The tree is built in *body* space and never rebuilt. The hull is rigid, so a
 * moving aircraft is handled by transforming the query into body space rather
 * than the mesh into world space — which is also what lets one tree be cached
 * per collision mesh and shared by every aircraft flying that airframe.
 *
 * Everything is flat typed arrays and scalar arithmetic: this runs inside the
 * sim worker's substep loop, so it allocates nothing after the build.
 */
import { AircraftCollisionMesh } from '../../scene/entities/aircraftDef';

/** Triangles in a leaf before it stops splitting. */
const LEAF_TRIS = 4;

/** Hard cap on tree depth; also bounds the traversal stack below. */
const MAX_DEPTH = 32;

const EPS = 1e-9;

/**
 * Flat BVH over a triangle soup.
 *
 * Nodes live in one array with children allocated as adjacent pairs, so an
 * internal node needs one child index rather than two.
 */
export interface TriangleBvh {
    /** The source soup, 9 floats per triangle, in the mesh's own frame. */
    readonly tri: Float32Array;
    /** Triangle numbers in leaf order; a leaf owns a contiguous run of these. */
    readonly triIndex: Uint32Array;
    /** Node AABBs, 6 floats per node: min xyz then max xyz. */
    readonly bounds: Float32Array;
    /** Leaf: first slot in {@link triIndex}. Internal: left child; right is left + 1. */
    readonly leftFirst: Int32Array;
    /** Triangles in a leaf; 0 marks an internal node. */
    readonly triCount: Int32Array;
    /** Nodes actually used in {@link bounds}. */
    readonly nodeCount: number;
}

/** Nearest point on the hull surface to a query point. */
export interface BvhClosest {
    /** Squared distance from the query point to {@link x},{@link y},{@link z}. */
    distSq: number;
    /** Triangle number in the source soup, or -1 when nothing was in range. */
    tri: number;
    /** The surface point itself. */
    x: number;
    y: number;
    z: number;
    /** Unit face normal of the winning triangle (source winding). */
    nx: number;
    ny: number;
    nz: number;
}

/** Where a segment first enters the hull. */
export interface BvhHit {
    /** Fraction along the segment, 0..1. */
    t: number;
    /** Triangle number in the source soup, or -1 when the segment missed. */
    tri: number;
    /** Impact point. */
    x: number;
    y: number;
    z: number;
    /** Unit face normal of the struck triangle (source winding). */
    nx: number;
    ny: number;
    nz: number;
}

/** Allocate a result object for {@link bvhClosestPoint}. */
export function bvhClosest(): BvhClosest {
    return { distSq: Infinity, tri: -1, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
}

/** Allocate a result object for {@link bvhSegmentHit}. */
export function bvhHit(): BvhHit {
    return { t: 1, tri: -1, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
}

const bvhCache = new WeakMap<AircraftCollisionMesh, TriangleBvh>();

/** The tree for a collision mesh, built once and cached against the mesh. */
export function triangleBvhFor(mesh: AircraftCollisionMesh): TriangleBvh {
    const cached = bvhCache.get(mesh);
    if (cached) return cached;
    const built = buildTriangleBvh(mesh.triangles);
    bvhCache.set(mesh, built);
    return built;
}

/** Centroid of each triangle; only used while splitting. */
let _cent = new Float32Array(0);

/**
 * Build a tree over a flat triangle soup (9 floats per triangle).
 *
 * Splits at the midpoint of the longest axis of the centroid bounds, which is
 * cheap and good enough for hulls of a few thousand triangles. A split that
 * puts everything on one side — coplanar or coincident centroids — falls back
 * to halving the run, which costs some overlap but keeps the tree valid.
 */
export function buildTriangleBvh(triangles: ArrayLike<number>): TriangleBvh {
    const total = Math.floor(triangles.length / 9);
    const tri = new Float32Array(total * 9);
    for (let i = 0; i < tri.length; i++) tri[i] = triangles[i];

    const triIndex = new Uint32Array(total);
    for (let i = 0; i < total; i++) triIndex[i] = i;

    if (_cent.length < total * 3) _cent = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
        const o = i * 9;
        _cent[i * 3] = (tri[o] + tri[o + 3] + tri[o + 6]) / 3;
        _cent[i * 3 + 1] = (tri[o + 1] + tri[o + 4] + tri[o + 7]) / 3;
        _cent[i * 3 + 2] = (tri[o + 2] + tri[o + 5] + tri[o + 8]) / 3;
    }

    // A binary tree whose leaves hold at least one triangle has at most 2n - 1
    // nodes; the empty mesh still needs its root.
    const maxNodes = Math.max(1, total * 2);
    const scratch: TriangleBvh = {
        tri,
        triIndex,
        bounds: new Float32Array(maxNodes * 6),
        leftFirst: new Int32Array(maxNodes),
        triCount: new Int32Array(maxNodes),
        nodeCount: 1,
    };
    let used = 1;
    if (total > 0) {
        used = subdivide(scratch, 0, 0, total, 1, 0);
    } else {
        scratch.leftFirst[0] = 0;
        scratch.triCount[0] = 0;
    }
    return { ...scratch, nodeCount: used };
}

/** Bounds of the triangles in `[first, first + count)`, written to `node`. */
function nodeBounds(bvh: TriangleBvh, node: number, first: number, count: number): void {
    const { tri, triIndex, bounds } = bvh;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = first; i < first + count; i++) {
        const o = triIndex[i] * 9;
        for (let v = 0; v < 9; v += 3) {
            const x = tri[o + v];
            const y = tri[o + v + 1];
            const z = tri[o + v + 2];
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
    }
    const b = node * 6;
    bounds[b] = minX; bounds[b + 1] = minY; bounds[b + 2] = minZ;
    bounds[b + 3] = maxX; bounds[b + 4] = maxY; bounds[b + 5] = maxZ;
}

/**
 * Fill `node` from the triangles in `[first, first + count)`, allocating
 * children from `nextNode` upward. Returns the first unused node index.
 */
function subdivide(
    bvh: TriangleBvh,
    node: number,
    first: number,
    count: number,
    nextNode: number,
    depth: number,
): number {
    nodeBounds(bvh, node, first, count);
    if (count <= LEAF_TRIS || depth >= MAX_DEPTH) {
        bvh.leftFirst[node] = first;
        bvh.triCount[node] = count;
        return nextNode;
    }

    // Longest axis of the *centroid* bounds, not the triangle bounds: a few
    // long triangles must not decide where the population actually splits.
    let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
    let cMaxX = -Infinity, cMaxY = -Infinity, cMaxZ = -Infinity;
    for (let i = first; i < first + count; i++) {
        const c = bvh.triIndex[i] * 3;
        const x = _cent[c], y = _cent[c + 1], z = _cent[c + 2];
        if (x < cMinX) cMinX = x;
        if (y < cMinY) cMinY = y;
        if (z < cMinZ) cMinZ = z;
        if (x > cMaxX) cMaxX = x;
        if (y > cMaxY) cMaxY = y;
        if (z > cMaxZ) cMaxZ = z;
    }
    const ex = cMaxX - cMinX, ey = cMaxY - cMinY, ez = cMaxZ - cMinZ;
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const split = axis === 0
        ? (cMinX + cMaxX) * 0.5
        : axis === 1 ? (cMinY + cMaxY) * 0.5 : (cMinZ + cMaxZ) * 0.5;

    // In-place partition of this run of triIndex around the split plane.
    let lo = first;
    let hi = first + count - 1;
    while (lo <= hi) {
        if (_cent[bvh.triIndex[lo] * 3 + axis] < split) {
            lo++;
        } else {
            const t = bvh.triIndex[lo];
            bvh.triIndex[lo] = bvh.triIndex[hi];
            bvh.triIndex[hi] = t;
            hi--;
        }
    }
    let leftCount = lo - first;
    // Coplanar or coincident centroids give a one-sided split, which would
    // recurse forever on the same run. Halving instead costs overlap, not
    // correctness.
    if (leftCount === 0 || leftCount === count) leftCount = count >> 1;

    const left = nextNode;
    bvh.leftFirst[node] = left;
    bvh.triCount[node] = 0;
    let after = subdivide(bvh, left, first, leftCount, nextNode + 2, depth + 1);
    after = subdivide(bvh, left + 1, first + leftCount, count - leftCount, after, depth + 1);
    return after;
}

/** Squared distance from a point to a node's AABB; 0 when inside it. */
function nodeDistSq(bvh: TriangleBvh, node: number, px: number, py: number, pz: number): number {
    const b = bvh.bounds;
    const o = node * 6;
    const dx = px < b[o] ? b[o] - px : px > b[o + 3] ? px - b[o + 3] : 0;
    const dy = py < b[o + 1] ? b[o + 1] - py : py > b[o + 4] ? py - b[o + 4] : 0;
    const dz = pz < b[o + 2] ? b[o + 2] - pz : pz > b[o + 5] ? pz - b[o + 5] : 0;
    return dx * dx + dy * dy + dz * dz;
}

/** Closest point on the triangle last tested, in module scratch. */
let _cpX = 0, _cpY = 0, _cpZ = 0;

/**
 * Closest point on a triangle to `p` (Ericson, *Real-Time Collision Detection*
 * 5.1.5): the Voronoi-region tests pick vertex, edge or face directly, so the
 * result is never a projection that has fallen outside the triangle.
 */
function closestOnTriangle(
    px: number, py: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): void {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) {
        _cpX = ax; _cpY = ay; _cpZ = az;
        return;
    }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) {
        _cpX = bx; _cpY = by; _cpZ = bz;
        return;
    }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        _cpX = ax + abx * v; _cpY = ay + aby * v; _cpZ = az + abz * v;
        return;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) {
        _cpX = cx; _cpY = cy; _cpZ = cz;
        return;
    }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        _cpX = ax + acx * w; _cpY = ay + acy * w; _cpZ = az + acz * w;
        return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        _cpX = bx + (cx - bx) * w; _cpY = by + (cy - by) * w; _cpZ = bz + (cz - bz) * w;
        return;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    _cpX = ax + abx * v + acx * w;
    _cpY = ay + aby * v + acy * w;
    _cpZ = az + abz * v + acz * w;
}

/** Unit face normal of triangle `t`, written into `out`. */
function faceNormal(
    bvh: TriangleBvh,
    t: number,
    out: { nx: number; ny: number; nz: number },
): void {
    const o = t * 9;
    const tri = bvh.tri;
    const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
    const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    if (len < EPS) {
        out.nx = 0; out.ny = 1; out.nz = 0;
        return;
    }
    out.nx = nx / len; out.ny = ny / len; out.nz = nz / len;
}

/** Traversal stack; the tree is depth-bounded, so one fixed buffer serves. */
const _stack = new Int32Array(MAX_DEPTH * 2 + 8);

/**
 * Nearest surface point to `(px, py, pz)` within `maxDist`.
 *
 * Returns false and leaves `out.tri` at -1 when nothing is in range, so a
 * particle well clear of the airframe costs one root-AABB test.
 */
export function bvhClosestPoint(
    bvh: TriangleBvh,
    px: number, py: number, pz: number,
    maxDist: number,
    out: BvhClosest,
): boolean {
    out.distSq = maxDist * maxDist;
    out.tri = -1;
    if (bvh.triIndex.length === 0) return false;

    let sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
        const node = _stack[--sp];
        if (nodeDistSq(bvh, node, px, py, pz) >= out.distSq) continue;
        const count = bvh.triCount[node];
        if (count > 0) {
            const first = bvh.leftFirst[node];
            const tri = bvh.tri;
            for (let i = first; i < first + count; i++) {
                const t = bvh.triIndex[i];
                const o = t * 9;
                closestOnTriangle(
                    px, py, pz,
                    tri[o], tri[o + 1], tri[o + 2],
                    tri[o + 3], tri[o + 4], tri[o + 5],
                    tri[o + 6], tri[o + 7], tri[o + 8],
                );
                const dx = px - _cpX, dy = py - _cpY, dz = pz - _cpZ;
                const dSq = dx * dx + dy * dy + dz * dz;
                if (dSq < out.distSq) {
                    out.distSq = dSq;
                    out.tri = t;
                    out.x = _cpX; out.y = _cpY; out.z = _cpZ;
                }
            }
            continue;
        }
        // Descend the nearer child first so the far one is usually pruned.
        const l = bvh.leftFirst[node];
        const r = l + 1;
        const dl = nodeDistSq(bvh, l, px, py, pz);
        const dr = nodeDistSq(bvh, r, px, py, pz);
        if (dl < dr) {
            if (dr < out.distSq) _stack[sp++] = r;
            if (dl < out.distSq) _stack[sp++] = l;
        } else {
            if (dl < out.distSq) _stack[sp++] = l;
            if (dr < out.distSq) _stack[sp++] = r;
        }
    }
    if (out.tri < 0) return false;
    faceNormal(bvh, out.tri, out);
    return true;
}

/** Segment vs node AABB (slab test), capped at the best hit so far. */
function nodeSegHit(
    bvh: TriangleBvh, node: number,
    ax: number, ay: number, az: number,
    dx: number, dy: number, dz: number,
    tmax: number,
): boolean {
    const b = bvh.bounds;
    const o = node * 6;
    let t0 = 0;
    let t1 = tmax;
    for (let i = 0; i < 3; i++) {
        const s = i === 0 ? ax : i === 1 ? ay : az;
        const d = i === 0 ? dx : i === 1 ? dy : dz;
        const mn = b[o + i];
        const mx = b[o + 3 + i];
        if (Math.abs(d) < EPS) {
            if (s < mn || s > mx) return false;
            continue;
        }
        const inv = 1 / d;
        let n = (mn - s) * inv;
        let f = (mx - s) * inv;
        if (n > f) {
            const tmp = n; n = f; f = tmp;
        }
        if (n > t0) t0 = n;
        if (f < t1) t1 = f;
        if (t0 > t1) return false;
    }
    return true;
}

/**
 * Barycentric coordinates of the last hit reported by {@link segmentTriangle}.
 *
 * Only {@link bvhContainsPoint} reads them, to spot a ray that has gone through
 * a shared edge — where the parity count is meaningless.
 */
let _triU = 0, _triV = 0;

/**
 * Möller–Trumbore, returning the fraction along `d` or -1.
 *
 * Two-sided by design: a webbing particle can be on either side of a skin
 * panel and must still be stopped by it, so a back-facing hit counts.
 */
function segmentTriangle(
    ax: number, ay: number, az: number,
    dx: number, dy: number, dz: number,
    v0x: number, v0y: number, v0z: number,
    v1x: number, v1y: number, v1z: number,
    v2x: number, v2y: number, v2z: number,
    tmax: number,
): number {
    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < EPS) return -1;
    const inv = 1 / det;
    const tx = ax - v0x, ty = ay - v0y, tz = az - v0z;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return -1;
    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return -1;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t < 0 || t > tmax) return -1;
    _triU = u;
    _triV = v;
    return t;
}

/**
 * First intersection of the segment `a → b` with the hull.
 *
 * This is the continuous test that keeps webbing out of an airframe closing at
 * landing speed: a static push-out alone tunnels straight through a wing
 * whenever the relative motion in one substep exceeds the skin thickness.
 */
export function bvhSegmentHit(
    bvh: TriangleBvh,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    out: BvhHit,
): boolean {
    out.t = 1;
    out.tri = -1;
    if (bvh.triIndex.length === 0) return false;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    if (dx === 0 && dy === 0 && dz === 0) return false;

    let best = 1;
    let sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
        const node = _stack[--sp];
        if (!nodeSegHit(bvh, node, ax, ay, az, dx, dy, dz, best)) continue;
        const count = bvh.triCount[node];
        if (count > 0) {
            const first = bvh.leftFirst[node];
            const tri = bvh.tri;
            for (let i = first; i < first + count; i++) {
                const t = bvh.triIndex[i];
                const o = t * 9;
                const hit = segmentTriangle(
                    ax, ay, az, dx, dy, dz,
                    tri[o], tri[o + 1], tri[o + 2],
                    tri[o + 3], tri[o + 4], tri[o + 5],
                    tri[o + 6], tri[o + 7], tri[o + 8],
                    best,
                );
                if (hit >= 0 && hit < best) {
                    best = hit;
                    out.t = hit;
                    out.tri = t;
                }
            }
            continue;
        }
        _stack[sp++] = bvh.leftFirst[node];
        _stack[sp++] = bvh.leftFirst[node] + 1;
    }
    if (out.tri < 0) return false;
    out.x = ax + dx * out.t;
    out.y = ay + dy * out.t;
    out.z = az + dz * out.t;
    faceNormal(bvh, out.tri, out);
    return true;
}

/**
 * How close to a triangle's boundary a crossing may land before the parity
 * count stops meaning anything.
 *
 * A ray straight through a shared edge is counted by both neighbouring
 * triangles or by neither, and either way the parity flips — which is how an
 * axis-aligned ray from the centre of a box reports the centre as *outside*.
 */
const PARITY_EDGE_EPS = 1e-6;

/**
 * Ray directions tried by {@link bvhContainsPoint}, in order.
 *
 * Deliberately off-axis, because hull colliders are full of axis-aligned and
 * diagonally-split quads that a cardinal ray runs exactly along. Fixed, not
 * random: the sim has to give the same answer every run.
 */
const PARITY_DIRS = [
    0.99856, 0.04361, 0.03078,
    0.04127, 0.99798, -0.04801,
    -0.03694, 0.05122, 0.99800,
];

/**
 * Crossings of the ray `p + t·d`, or -1 when one of them landed on a triangle
 * boundary and the count cannot be trusted.
 */
function parityCrossings(
    bvh: TriangleBvh,
    px: number, py: number, pz: number,
    dx: number, dy: number, dz: number,
): number {
    let crossings = 0;
    let sp = 0;
    _stack[sp++] = 0;
    while (sp > 0) {
        const node = _stack[--sp];
        if (!nodeSegHit(bvh, node, px, py, pz, dx, dy, dz, 1)) continue;
        const count = bvh.triCount[node];
        if (count > 0) {
            const first = bvh.leftFirst[node];
            const tri = bvh.tri;
            for (let i = first; i < first + count; i++) {
                const t = bvh.triIndex[i];
                const to = t * 9;
                const hit = segmentTriangle(
                    px, py, pz, dx, dy, dz,
                    tri[to], tri[to + 1], tri[to + 2],
                    tri[to + 3], tri[to + 4], tri[to + 5],
                    tri[to + 6], tri[to + 7], tri[to + 8],
                    1,
                );
                if (hit <= EPS) continue;
                if (_triU < PARITY_EDGE_EPS || _triV < PARITY_EDGE_EPS
                    || 1 - _triU - _triV < PARITY_EDGE_EPS) {
                    return -1;
                }
                crossings++;
            }
            continue;
        }
        _stack[sp++] = bvh.leftFirst[node];
        _stack[sp++] = bvh.leftFirst[node] + 1;
    }
    return crossings;
}

/**
 * Is the point inside the hull?
 *
 * Parity of the crossings on a ray out of the point. Assumes the soup is
 * closed, which a hull collider baked from a mod's glTF generally is; an open
 * mesh gives an arbitrary answer for points behind the hole, so this is the
 * safety net for particles that have somehow escaped, not the primary contact
 * test — that is {@link bvhSegmentHit}.
 */
export function bvhContainsPoint(
    bvh: TriangleBvh,
    px: number, py: number, pz: number,
): boolean {
    if (bvh.triIndex.length === 0) return false;
    const b = bvh.bounds;
    if (px < b[0] || px > b[3] || py < b[1] || py > b[4] || pz < b[2] || pz > b[5]) {
        return false;
    }

    // Long enough to leave the root box from anywhere inside it, so the
    // segment tests above stand in for an infinite ray.
    const reach = 2 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) + 1;
    let crossings = -1;
    for (let d = 0; d < PARITY_DIRS.length && crossings < 0; d += 3) {
        crossings = parityCrossings(
            bvh, px, py, pz,
            PARITY_DIRS[d] * reach, PARITY_DIRS[d + 1] * reach, PARITY_DIRS[d + 2] * reach,
        );
    }
    // Every direction hit an edge — vanishingly unlikely, and "outside" is the
    // safe answer: the solver leaves the particle where it is instead of
    // teleporting it through the skin.
    return crossings > 0 && (crossings & 1) === 1;
}
