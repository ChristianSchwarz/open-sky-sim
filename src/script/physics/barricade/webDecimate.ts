/**
 * Quadric-error edge collapse (Garland and Heckbert 1997) for the webbing's
 * collision mesh: a drawn airframe of 20–30k triangles down to 2–3k.
 *
 * Each vertex carries the summed planes of its faces (area-weighted) plus,
 * along open edges, planes standing on the edge, so the rims of the separate
 * panels a drawn model is made of keep their outline. A collapse goes to the
 * point that least moves those planes, and one that would fold a face over
 * is refused. Sharp edges — leading and trailing edges, wingtips — cost a
 * lot to cross, so they survive.
 */
import { buildTriangleBvh, bvhClosest, bvhClosestPoint } from '../collision/triangleBvh';
import { weldSoup } from './webCollider';

/** Open edges weigh this much more than faces in the error quadric. */
const BOUNDARY_WEIGHT = 100;
/** A collapse may not turn a face by more than this (cosine of the angle between old and new normal). */
const MIN_NORMAL_COS = 0.2;
/**
 * Faces meeting at more than this (cosine of the angle between normals) make
 * a crease whose outline is held like a rim: the top and bottom of a thin
 * tail are nearly one plane, so without it the tip slid inward 45 cm.
 */
const CREASE_COS = Math.cos((40 * Math.PI) / 180);
/**
 * Parts of at most this many triangles and at least this size (bounding
 * diagonal, m) are kept as drawn: a blade antenna or a vane a strap can
 * snag on. Smaller ones — a probe a few centimetres across — may go.
 */
const SMALL_PART_TRIS = 24;
const SMALL_PART_MIN_M = 0.3;

interface Candidate {
    cost: number;
    u: number;
    v: number;
    su: number;
    sv: number;
    x: number;
    y: number;
    z: number;
}

/** Decimate a soup to about `targetTris` triangles; returns a new soup. */
export function decimateSoup(tri: ArrayLike<number>, targetTris: number): Float32Array {
    const { pos, ids } = weldSoup(tri);
    const nv = pos.length / 3;
    const faces = ids.length / 3;
    const F = Int32Array.from(ids);
    const P = Float64Array.from(pos);
    const alive = new Uint8Array(faces);
    const Q = new Float64Array(10 * nv);
    const vf: number[][] = Array.from({ length: nv }, () => []);
    const edgeUse = new Map<number, number>();
    const ekey = (u: number, v: number) => (u < v ? u * nv + v : v * nv + u);
    const addPlane = (v: number, nx: number, ny: number, nz: number, d: number, w: number) => {
        const q = 10 * v;
        Q[q] += w * nx * nx; Q[q + 1] += w * nx * ny; Q[q + 2] += w * nx * nz; Q[q + 3] += w * nx * d;
        Q[q + 4] += w * ny * ny; Q[q + 5] += w * ny * nz; Q[q + 6] += w * ny * d;
        Q[q + 7] += w * nz * nz; Q[q + 8] += w * nz * d; Q[q + 9] += w * d * d;
    };
    let live = 0;
    const unitNormal = new Float64Array(3 * faces);
    for (let f = 0; f < faces; f++) {
        const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
        if (a === b || b === c || a === c) continue;
        const n = cross3(P, a, b, c);
        const l = Math.hypot(n[0], n[1], n[2]);
        if (l < 1e-14) continue;
        alive[f] = 1;
        live++;
        const nx = n[0] / l, ny = n[1] / l, nz = n[2] / l;
        unitNormal[3 * f] = nx; unitNormal[3 * f + 1] = ny; unitNormal[3 * f + 2] = nz;
        const d = -(nx * P[3 * a] + ny * P[3 * a + 1] + nz * P[3 * a + 2]);
        for (const v of [a, b, c]) {
            addPlane(v, nx, ny, nz, d, 1);
            vf[v].push(f);
        }
        for (const [u, v] of [[a, b], [b, c], [c, a]]) edgeUse.set(ekey(u, v), (edgeUse.get(ekey(u, v)) ?? 0) + 1);
    }
    // Faces on each edge, to tell rims and creases.
    const edgeFaces = new Map<number, number[]>();
    for (let f = 0; f < faces; f++) {
        if (!alive[f]) continue;
        const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            const key = ekey(u, v);
            const list = edgeFaces.get(key);
            if (list) list.push(f); else edgeFaces.set(key, [f]);
        }
    }
    const isOutline = (key: number) => {
        const list = edgeFaces.get(key)!;
        if (list.length !== 2) return true;
        const f = list[0], g = list[1];
        return unitNormal[3 * f] * unitNormal[3 * g] + unitNormal[3 * f + 1] * unitNormal[3 * g + 1]
            + unitNormal[3 * f + 2] * unitNormal[3 * g + 2] < CREASE_COS;
    };
    // Planes standing on the outline edges: open rims, edges of more than two faces, and sharp creases.
    for (let f = 0; f < faces; f++) {
        if (!alive[f]) continue;
        const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
        const fx = unitNormal[3 * f], fy = unitNormal[3 * f + 1], fz = unitNormal[3 * f + 2];
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
            if (!isOutline(ekey(u, v))) continue;
            const ex = P[3 * v] - P[3 * u], ey = P[3 * v + 1] - P[3 * u + 1], ez = P[3 * v + 2] - P[3 * u + 2];
            const el = Math.hypot(ex, ey, ez);
            if (el < 1e-12) continue;
            // In the face, across the edge.
            let px = ey * fz - ez * fy, py = ez * fx - ex * fz, pz = ex * fy - ey * fx;
            const pl = Math.hypot(px, py, pz);
            px /= pl; py /= pl; pz /= pl;
            const d = -(px * P[3 * u] + py * P[3 * u + 1] + pz * P[3 * u + 2]);
            const w = BOUNDARY_WEIGHT;
            addPlane(u, px, py, pz, d, w);
            addPlane(v, px, py, pz, d, w);
        }
    }

    // Small parts — a blade antenna, a gear door — are kept whole: their
    // collapses are cheap in absolute terms, so the heap ate them first.
    const locked = new Uint8Array(nv);
    {
        const parent = new Int32Array(nv);
        for (let v = 0; v < nv; v++) parent[v] = v;
        const find = (v: number): number => {
            while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
            return v;
        };
        for (let f = 0; f < faces; f++) {
            if (!alive[f]) continue;
            const a = find(F[3 * f]);
            parent[find(F[3 * f + 1])] = a;
            parent[find(F[3 * f + 2])] = a;
        }
        const size = new Map<number, number>();
        for (let f = 0; f < faces; f++) if (alive[f]) size.set(find(F[3 * f]), (size.get(find(F[3 * f])) ?? 0) + 1);
        const box = new Map<number, number[]>();
        for (let v = 0; v < nv; v++) {
            const r = find(v);
            let b = box.get(r);
            if (!b) box.set(r, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
            for (let k = 0; k < 3; k++) {
                b[k] = Math.min(b[k], P[3 * v + k]);
                b[k + 3] = Math.max(b[k + 3], P[3 * v + k]);
            }
        }
        for (let v = 0; v < nv; v++) {
            const r = find(v);
            const b = box.get(r)!;
            const n = size.get(r) ?? 0;
            if (n > 0 && n <= SMALL_PART_TRIS && Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) >= SMALL_PART_MIN_M) locked[v] = 1;
        }
    }
    const stamp = new Int32Array(nv);
    const dead = new Uint8Array(nv);
    const heap: Candidate[] = [];
    const push = (c: Candidate) => {
        heap.push(c);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p].cost <= heap[i].cost) break;
            const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
            i = p;
        }
    };
    const pop = (): Candidate => {
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1, r = l + 1;
                let m = i;
                if (l < heap.length && heap[l].cost < heap[m].cost) m = l;
                if (r < heap.length && heap[r].cost < heap[m].cost) m = r;
                if (m === i) break;
                const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
                i = m;
            }
        }
        return top;
    };
    const qs = new Float64Array(10);
    const qerr = (x: number, y: number, z: number) =>
        qs[0] * x * x + 2 * qs[1] * x * y + 2 * qs[2] * x * z + 2 * qs[3] * x
        + qs[4] * y * y + 2 * qs[5] * y * z + 2 * qs[6] * y + qs[7] * z * z + 2 * qs[8] * z + qs[9];
    const candidate = (u: number, v: number) => {
        for (let k = 0; k < 10; k++) qs[k] = Q[10 * u + k] + Q[10 * v + k];
        const a11 = qs[0], a12 = qs[1], a13 = qs[2], a22 = qs[4], a23 = qs[5], a33 = qs[7];
        const det = a11 * (a22 * a33 - a23 * a23) - a12 * (a12 * a33 - a23 * a13) + a13 * (a12 * a23 - a22 * a13);
        const scale = Math.abs(a11) + Math.abs(a22) + Math.abs(a33);
        let best = Infinity, bx = 0, by = 0, bz = 0;
        const len = Math.hypot(P[3 * u] - P[3 * v], P[3 * u + 1] - P[3 * v + 1], P[3 * u + 2] - P[3 * v + 2]);
        if (scale > 0 && Math.abs(det) > 1e-9 * scale * scale * scale) {
            const b1 = -qs[3], b2 = -qs[6], b3 = -qs[8];
            const x = (b1 * (a22 * a33 - a23 * a23) - a12 * (b2 * a33 - a23 * b3) + a13 * (b2 * a23 - a22 * b3)) / det;
            const y = (a11 * (b2 * a33 - a23 * b3) - b1 * (a12 * a33 - a23 * a13) + a13 * (a12 * b3 - b2 * a13)) / det;
            const z = (a11 * (a22 * b3 - b2 * a23) - a12 * (a12 * b3 - b2 * a13) + b1 * (a12 * a23 - a22 * a13)) / det;
            // Trusted only near the edge: far off it the system is close to singular.
            const mx = (P[3 * u] + P[3 * v]) / 2, my = (P[3 * u + 1] + P[3 * v + 1]) / 2, mz = (P[3 * u + 2] + P[3 * v + 2]) / 2;
            if (Math.hypot(x - mx, y - my, z - mz) < len) {
                best = qerr(x, y, z);
                bx = x; by = y; bz = z;
            }
        }
        for (const t of [0, 0.5, 1]) {
            const x = P[3 * u] + t * (P[3 * v] - P[3 * u]);
            const y = P[3 * u + 1] + t * (P[3 * v + 1] - P[3 * u + 1]);
            const z = P[3 * u + 2] + t * (P[3 * v + 2] - P[3 * u + 2]);
            const e = qerr(x, y, z);
            if (e < best) {
                best = e;
                bx = x; by = y; bz = z;
            }
        }
        push({ cost: Math.max(0, best), u, v, su: stamp[u], sv: stamp[v], x: bx, y: by, z: bz });
    };
    for (const key of edgeUse.keys()) {
        const u = Math.floor(key / nv), v = key % nv;
        if (!locked[u]) candidate(u, v);
    }

    /** Would moving both ends to (x, y, z) fold or flatten one of the faces that stay? */
    const folds = (keep: number, gone: number, x: number, y: number, z: number) => {
        for (const v of [keep, gone]) {
            for (const f of vf[v]) {
                if (!alive[f]) continue;
                const a = F[3 * f], b = F[3 * f + 1], c = F[3 * f + 2];
                const hasK = a === keep || b === keep || c === keep;
                const hasG = a === gone || b === gone || c === gone;
                if (hasK && hasG) continue;
                const n0 = cross3(P, a, b, c);
                const n1 = crossMoved(P, a, b, c, v, x, y, z);
                const l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
                if (l1 < 1e-14) return true;
                if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < MIN_NORMAL_COS * l0 * l1) return true;
            }
        }
        return false;
    };

    while (live > targetTris && heap.length > 0) {
        const c = pop();
        const { u, v } = c;
        if (dead[u] || dead[v] || c.su !== stamp[u] || c.sv !== stamp[v]) continue;
        if (folds(u, v, c.x, c.y, c.z)) continue;
        // v into u, at the candidate point.
        P[3 * u] = c.x; P[3 * u + 1] = c.y; P[3 * u + 2] = c.z;
        for (let k = 0; k < 10; k++) Q[10 * u + k] += Q[10 * v + k];
        dead[v] = 1;
        for (const f of vf[v]) {
            if (!alive[f]) continue;
            for (let k = 0; k < 3; k++) if (F[3 * f + k] === v) F[3 * f + k] = u;
            const a = F[3 * f], b = F[3 * f + 1], cc = F[3 * f + 2];
            if (a === b || b === cc || a === cc) {
                alive[f] = 0;
                live--;
            } else {
                vf[u].push(f);
            }
        }
        vf[v] = [];
        vf[u] = Array.from(new Set(vf[u].filter(f => alive[f])));
        // Every edge out of a moved or neighbouring vertex is stale now: requeue them.
        const ring = new Set<number>([u]);
        for (const f of vf[u]) for (let k = 0; k < 3; k++) ring.add(F[3 * f + k]);
        for (const w of ring) stamp[w]++;
        const seen = new Set<number>();
        for (const w of ring) {
            for (const f of vf[w]) {
                if (!alive[f]) continue;
                for (let k = 0; k < 3; k++) {
                    const o = F[3 * f + k];
                    if (o === w) continue;
                    const key = ekey(w, o);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    candidate(Math.min(w, o), Math.max(w, o));
                }
            }
        }
    }
    const kept: number[] = [];
    for (let f = 0; f < faces; f++) if (alive[f]) kept.push(f);
    inflate(P, F, kept, pos, ids);
    const out: number[] = [];
    for (const f of kept) {
        for (let k = 0; k < 3; k++) {
            const i = F[3 * f + k];
            out.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
        }
    }
    return Float32Array.from(out);
}

/** Furthest a collision vertex is pushed out to cover the drawn skin (m). */
const MAX_INFLATE_M = 0.1;
/**
 * How far the drawn skin may stand outside the collision skin before a
 * vertex is pushed out (m): webbing is held a 4 cm skin off the collider, so
 * up to half that does not bring it to the drawn surface.
 */
const INFLATE_TOLERANCE_M = 0.02;

/**
 * Make the decimated skin (nearly) enclose the drawn one: each drawn vertex
 * and face centre that lies more than the tolerance outside the nearest
 * decimated face (along its normal) pushes that face's corners out by the
 * excess, along their vertex normals.
 * A collider inside the drawn skin let webbing held a skin off it cut the
 * drawn surface where the two differ by more than the skin.
 */
function inflate(P: Float64Array, F: Int32Array, kept: number[], pos: Float64Array, ids: Int32Array): void {
    const soup = new Float32Array(9 * kept.length);
    kept.forEach((f, t) => {
        for (let k = 0; k < 3; k++) {
            const i = F[3 * f + k];
            soup[9 * t + 3 * k] = P[3 * i]; soup[9 * t + 3 * k + 1] = P[3 * i + 1]; soup[9 * t + 3 * k + 2] = P[3 * i + 2];
        }
    });
    const bvh = buildTriangleBvh(soup);
    const near = bvhClosest();
    const push = new Float64Array(P.length / 3);
    const sample = (x: number, y: number, z: number) => {
        if (!bvhClosestPoint(bvh, x, y, z, MAX_INFLATE_M, near)) return;
        const d = (x - near.x) * near.nx + (y - near.y) * near.ny + (z - near.z) * near.nz - INFLATE_TOLERANCE_M;
        if (d <= 0) return;
        const f = kept[near.tri];
        for (let k = 0; k < 3; k++) {
            const v = F[3 * f + k];
            if (d > push[v]) push[v] = d;
        }
    };
    for (let v = 0; v < pos.length / 3; v++) sample(pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]);
    for (let c = 0; c < ids.length; c += 3) {
        const a = 3 * ids[c], b = 3 * ids[c + 1], e = 3 * ids[c + 2];
        sample((pos[a] + pos[b] + pos[e]) / 3, (pos[a + 1] + pos[b + 1] + pos[e + 1]) / 3, (pos[a + 2] + pos[b + 2] + pos[e + 2]) / 3);
    }
    // Area-weighted vertex normals; a sheet's two sides cancel, and a sheet is not moved.
    const vn = new Float64Array(P.length);
    for (const f of kept) {
        const n = cross3(P, F[3 * f], F[3 * f + 1], F[3 * f + 2]);
        for (let k = 0; k < 3; k++) {
            const v = 3 * F[3 * f + k];
            vn[v] += n[0]; vn[v + 1] += n[1]; vn[v + 2] += n[2];
        }
    }
    for (let v = 0; v < push.length; v++) {
        if (push[v] <= 0) continue;
        const l = Math.hypot(vn[3 * v], vn[3 * v + 1], vn[3 * v + 2]);
        if (l < 1e-12) continue;
        const s = Math.min(push[v], MAX_INFLATE_M) / l;
        P[3 * v] += vn[3 * v] * s; P[3 * v + 1] += vn[3 * v + 1] * s; P[3 * v + 2] += vn[3 * v + 2] * s;
    }
}

function cross3(P: Float64Array, a: number, b: number, c: number): [number, number, number] {
    const e1x = P[3 * b] - P[3 * a], e1y = P[3 * b + 1] - P[3 * a + 1], e1z = P[3 * b + 2] - P[3 * a + 2];
    const e2x = P[3 * c] - P[3 * a], e2y = P[3 * c + 1] - P[3 * a + 1], e2z = P[3 * c + 2] - P[3 * a + 2];
    return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
}

/** Face normal (unnormalised) with vertex `moved` at (x, y, z). */
function crossMoved(P: Float64Array, a: number, b: number, c: number, moved: number,
    x: number, y: number, z: number): [number, number, number] {
    const px = (i: number) => (i === moved ? x : P[3 * i]);
    const py = (i: number) => (i === moved ? y : P[3 * i + 1]);
    const pz = (i: number) => (i === moved ? z : P[3 * i + 2]);
    const e1x = px(b) - px(a), e1y = py(b) - py(a), e1z = pz(b) - pz(a);
    const e2x = px(c) - px(a), e2y = py(c) - py(a), e2z = pz(c) - pz(a);
    return [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
}
