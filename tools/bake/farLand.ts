/**
 * A lighter copy of a leaf tile's land, for drawing it from far off.
 *
 * A graded leaf carries 60-70 thousand triangles and half of them are under
 * 25 m^2: the grading's refinement round its road and rail beds, the road
 * caps, the fills cut back from carriageways. From a few kilometres a pixel
 * spans metres and none of that shows, but every triangle is still paid for.
 * This removes vertices by collapsing each into a neighbour while the surface
 * stays within `toleranceM` of the original at every point it has absorbed,
 * and the runtime draws the result once that tolerance is under half a pixel.
 *
 * What may not change, because the eye or another part of the drawing
 * depends on it:
 *
 *  - Border vertices (the PTM border table): the seam stitcher moves them by
 *    slot, and the far copy maps its border corners onto the same slots.
 *  - The ground's outline (the shore, which the water meets vertex for
 *    vertex) and every steep face; a fill's outline only slides along
 *    itself, within the tolerance. Nor does a vertex go whose triangles are
 *    not all ground or all one land-use fill, or not all of one cover class
 *    and near enough one colour, or any of whose triangles is a wall or skirt.
 *  - Order between layers. The ground under a fill may only sink, and a
 *    fill may sink by less than it floats over the ground (FILL_SINK_M), so
 *    the ground never shows through a field. Ground with no fill over it
 *    moves either way.
 *  - Anything drawn on the land. Road and river stroke points are absorbed
 *    like any other point but the land under them may only sink, so a stroke
 *    is never buried (strokes are depth-tested and win only exact ties).
 *
 * A half-edge collapse moves a vertex onto one of its neighbours, so every
 * position in the result is a position of the original, quantised as it was.
 */

/** Pass the tile's own axes: x east, y up-ish, z south; `up` is the true vertical in them. */
export interface FarLandInput {
    /** Quantised corners, 9 per triangle (non-indexed, as in the PTM). */
    positions: Int16Array;
    /** Per corner, stride 4, the face normal. */
    normals: Int8Array;
    /** Per corner, stride 4: sRGB and the cover class. */
    attrs: Uint8Array;
    quantScale: number;
    /** 1 per triangle that is a lifted land-use fill, 0 for ground. */
    fills: Uint8Array;
    /** Per corner, the near land's region width (see regionSizes); copied to the corners kept. */
    regionSizes?: Uint16Array;
    /** Land vertex slots (corner indices) the seam stitcher moves; side bits already stripped. */
    borderSlots: Uint32Array;
    up: readonly [number, number, number];
    toleranceM: number;
    /** Stroke points drawn on the land (roads, rivers), metres in tile axes, 3 per point. */
    strokePoints?: Float32Array;
    /** Largest per-channel colour step a removable vertex may hide (0..255). */
    maxColourStep?: number;
    /** Faces closer to vertical than this (|n.up|) are walls or skirts and stay. */
    minUpDot?: number;
}

export interface FarLand {
    positions: Int16Array;
    normals: Int8Array;
    attrs: Uint8Array;
    /** Per corner, from the near corner it came from. */
    regionSizes: Uint16Array;
    /** Pairs: a corner of this copy and the near slot it must follow when stitched. */
    borderMap: Uint32Array;
    trianglesIn: number;
    trianglesOut: number;
}

/** Ground with a fill over it: may only sink. */
const POINT_GROUND = 0;
const POINT_FILL = 1;
const POINT_STROKE = 2;
/** Ground with nothing drawn over it. */
const POINT_GROUND_FREE = 3;

/**
 * How far a fill may sink, metres. The bake lifts fills 0.38 m over the
 * ground at the leaf, and the ground under them only ever sinks, so this
 * keeps a fill above what it covers.
 */
const FILL_SINK_M = 0.25;

/** How far a layer may move the wrong way, metres: rounding, nothing more. */
const WRONG_WAY_M = 0.02;
/** Smallest plan area (m^2) a triangle may be left with. */
const MIN_PLAN_AREA = 0.05;
const MAX_PASSES = 8;

export function buildFarLand(input: FarLandInput): FarLand {
    const { positions, normals, attrs, quantScale: q, fills, up, toleranceM } = input;
    const maxStep = input.maxColourStep ?? 24;
    const minUpDot = input.minUpDot ?? 0.35;
    const triCount = positions.length / 9;

    // Plan axes perpendicular to the vertical.
    const [ux, uy, uz] = up;
    let ax = 1, ay = 0, az = 0;
    if (Math.abs(ux) > 0.9) {
        ax = 0;
        ay = 0;
        az = 1;
    }
    const d0 = ax * ux + ay * uy + az * uz;
    ax -= d0 * ux;
    ay -= d0 * uy;
    az -= d0 * uz;
    const al = Math.hypot(ax, ay, az);
    ax /= al;
    ay /= al;
    az /= al;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;

    // Weld corners into vertices by quantised position.
    const vertexOf = new Int32Array(triCount * 3);
    const byKey = new Map<number, number>();
    const vp: number[] = []; // plan a, plan b, height, per vertex
    const vq: number[] = []; // first corner, for the quantised position
    for (let c = 0; c < triCount * 3; c++) {
        const x = positions[c * 3], y = positions[c * 3 + 1], z = positions[c * 3 + 2];
        const key = ((x + 32768) * 65536 + (y + 32768)) * 65536 + (z + 32768);
        let v = byKey.get(key);
        if (v === undefined) {
            v = vq.length;
            byKey.set(key, v);
            vq.push(c);
            const mx = x * q, my = y * q, mz = z * q;
            vp.push(mx * ax + my * ay + mz * az, mx * bx + my * by + mz * bz, mx * ux + my * uy + mz * uz);
        }
        vertexOf[c] = v;
    }
    const V = vq.length;
    const P = Float64Array.from(vp);

    // Triangles as vertex triples, live or not.
    const tv = new Int32Array(triCount * 3);
    tv.set(vertexOf);
    const alive = new Uint8Array(triCount).fill(1);
    const incident: number[][] = Array.from({ length: V }, () => []);
    for (let t = 0; t < triCount; t++) {
        for (let k = 0; k < 3; k++) {
            incident[tv[t * 3 + k]].push(t);
        }
    }

    const fixed = new Uint8Array(V);
    const borderSlotOf = new Int32Array(V).fill(-1);
    for (const slot of input.borderSlots) {
        if (slot < triCount * 3) {
            const v = vertexOf[slot];
            fixed[v] = 1;
            if (borderSlotOf[v] < 0) {
                borderSlotOf[v] = slot;
            }
        }
    }

    const faceUpDot = (t: number) => {
        const n = t * 3 * 4;
        const nx = normals[n], ny = normals[n + 1], nz = normals[n + 2];
        const l = Math.hypot(nx, ny, nz) || 1;
        return (nx * ux + ny * uy + nz * uz) / l;
    };

    // Which vertices may go at all.
    for (let v = 0; v < V; v++) {
        if (fixed[v]) {
            continue;
        }
        const tris = incident[v];
        const t0 = tris[0];
        const layer = fills[t0];
        const cls = attrs[t0 * 12 + 3];
        let lo = [255, 255, 255], hi = [0, 0, 0];
        for (const t of tris) {
            if (fills[t] !== layer || attrs[t * 12 + 3] !== cls || Math.abs(faceUpDot(t)) < minUpDot) {
                fixed[v] = 1;
                break;
            }
            const k = tv[t * 3] === v ? 0 : tv[t * 3 + 1] === v ? 1 : 2;
            const a = (t * 3 + k) * 4;
            lo = [Math.min(lo[0], attrs[a]), Math.min(lo[1], attrs[a + 1]), Math.min(lo[2], attrs[a + 2])];
            hi = [Math.max(hi[0], attrs[a]), Math.max(hi[1], attrs[a + 1]), Math.max(hi[2], attrs[a + 2])];
        }
        if (!fixed[v] && (hi[0] - lo[0] > maxStep || hi[1] - lo[1] > maxStep || hi[2] - lo[2] > maxStep)) {
            fixed[v] = 1;
        }
    }
    // Outlines: the open edges round each layer (a fill's polygon, the
    // ground's edge at a wall). A vertex on exactly one run of them may slide
    // along it (see tryCollapse); one where outlines meet, or on an edge
    // shared by more than two triangles, stays.
    const edgeCount = new Map<number, number>();
    const edgeKey = (a: number, b: number) => (a < b ? a * V + b : b * V + a);
    for (let t = 0; t < triCount; t++) {
        for (let k = 0; k < 3; k++) {
            const key = edgeKey(tv[t * 3 + k], tv[t * 3 + (k + 1) % 3]);
            edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
        }
    }
    const openNbrs: number[][] = Array.from({ length: V }, () => []);
    for (const [key, n] of edgeCount) {
        const a = Math.floor(key / V), b = key % V;
        if (n > 2) {
            fixed[a] = 1;
            fixed[b] = 1;
        } else if (n === 1) {
            openNbrs[a].push(b);
            openNbrs[b].push(a);
        }
    }
    for (let v = 0; v < V; v++) {
        if (openNbrs[v].length !== 0 && openNbrs[v].length !== 2) {
            fixed[v] = 1;
        }
        // Only a fill's outline may slide: the ground is under it. The
        // ground's own outline is the shore, which the water sheet meets
        // vertex for vertex, so a moved one opens a crack to the sky.
        if (openNbrs[v].length === 2 && !fills[incident[v][0]]) {
            fixed[v] = 1;
        }
    }
    /** How far each outline edge already strays from the outline it replaced, metres. */
    const outlineErr = new Map<number, number>();

    // Absorbed points: what each live triangle has to stay close to.
    const pts: number[] = []; // plan a, plan b, height, kind
    const absorbed: number[][] = Array.from({ length: triCount }, () => []);
    const addPoint = (a: number, b: number, h: number, kind: number): number => {
        pts.push(a, b, h, kind);
        return pts.length / 4 - 1;
    };
    const planArea = (t: number, p0: number, p1: number, p2: number) =>
        (P[p1 * 3] - P[p0 * 3]) * (P[p2 * 3 + 1] - P[p0 * 3 + 1])
        - (P[p2 * 3] - P[p0 * 3]) * (P[p1 * 3 + 1] - P[p0 * 3 + 1]);
    // Height of triangle (p0, p1, p2) over plan point (a, b), or NaN outside it.
    const heightAt = (p0: number, p1: number, p2: number, a: number, b: number, slack: number): number => {
        const x0 = P[p0 * 3], y0 = P[p0 * 3 + 1];
        const x1 = P[p1 * 3] - x0, y1 = P[p1 * 3 + 1] - y0;
        const x2 = P[p2 * 3] - x0, y2 = P[p2 * 3 + 1] - y0;
        const px = a - x0, py = b - y0;
        const det = x1 * y2 - x2 * y1;
        if (Math.abs(det) < 1e-12) {
            return NaN;
        }
        const s = (px * y2 - x2 * py) / det;
        const r = (x1 * py - px * y1) / det;
        if (s < -slack || r < -slack || s + r > 1 + slack) {
            return NaN;
        }
        return P[p0 * 3 + 2] + s * (P[p1 * 3 + 2] - P[p0 * 3 + 2]) + r * (P[p2 * 3 + 2] - P[p0 * 3 + 2]);
    };

    // As heightAt, but a point up to `reach` metres outside the triangle in
    // plan reads the height at the nearest point of it: an outline that moved
    // may leave what it covered just outside.
    const heightNear = (p0: number, p1: number, p2: number, a: number, b: number, reach: number): number => {
        const inside = heightAt(p0, p1, p2, a, b, 1e-6);
        if (!Number.isNaN(inside) || reach <= 0) {
            return inside;
        }
        let best = Infinity, bh = NaN;
        for (const [i, j] of [[p0, p1], [p1, p2], [p2, p0]]) {
            const xi = P[i * 3], yi = P[i * 3 + 1], dx = P[j * 3] - xi, dy = P[j * 3 + 1] - yi;
            const len2 = dx * dx + dy * dy;
            const s = len2 > 0 ? Math.max(0, Math.min(1, ((a - xi) * dx + (b - yi) * dy) / len2)) : 0;
            const d = Math.hypot(a - (xi + s * dx), b - (yi + s * dy));
            if (d < best) {
                best = d;
                bh = P[i * 3 + 2] + s * (P[j * 3 + 2] - P[i * 3 + 2]);
            }
        }
        return best <= reach ? bh : NaN;
    };

    // Which ground has a fill over it, by plan position: a grid of the fills.
    const fillCell = 50;
    const fillGrid = new Map<number, number[]>();
    const fk = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
    for (let t = 0; t < triCount; t++) {
        if (!fills[t]) {
            continue;
        }
        const vs = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
        const minA = Math.min(...vs.map(v => P[v * 3])), maxA = Math.max(...vs.map(v => P[v * 3]));
        const minB = Math.min(...vs.map(v => P[v * 3 + 1])), maxB = Math.max(...vs.map(v => P[v * 3 + 1]));
        for (let i = Math.floor(minA / fillCell); i <= Math.floor(maxA / fillCell); i++) {
            for (let j = Math.floor(minB / fillCell); j <= Math.floor(maxB / fillCell); j++) {
                const list = fillGrid.get(fk(i, j));
                if (list) {
                    list.push(t);
                } else {
                    fillGrid.set(fk(i, j), [t]);
                }
            }
        }
    }
    // Fills keep their original vertices for this test: a fill's own
    // collapse never sinks it below the ground anyway.
    const fillOver = (a: number, b: number): boolean => {
        for (const t of fillGrid.get(fk(Math.floor(a / fillCell), Math.floor(b / fillCell))) ?? []) {
            if (!Number.isNaN(heightAt(vertexOf[t * 3], vertexOf[t * 3 + 1], vertexOf[t * 3 + 2], a, b, 0.01))) {
                return true;
            }
        }
        return false;
    };

    if (input.strokePoints) {
        // Plan grid over the triangles, to find the one under each stroke point.
        const sp = input.strokePoints;
        const cell = 50;
        const grid = new Map<number, number[]>();
        const gk = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
        for (let t = 0; t < triCount; t++) {
            if (Math.abs(faceUpDot(t)) < minUpDot) {
                continue;
            }
            const vs = [tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]];
            const minA = Math.min(...vs.map(v => P[v * 3])), maxA = Math.max(...vs.map(v => P[v * 3]));
            const minB = Math.min(...vs.map(v => P[v * 3 + 1])), maxB = Math.max(...vs.map(v => P[v * 3 + 1]));
            for (let i = Math.floor(minA / cell); i <= Math.floor(maxA / cell); i++) {
                for (let j = Math.floor(minB / cell); j <= Math.floor(maxB / cell); j++) {
                    const list = grid.get(gk(i, j));
                    if (list) {
                        list.push(t);
                    } else {
                        grid.set(gk(i, j), [t]);
                    }
                }
            }
        }
        for (let i = 0; i < sp.length; i += 3) {
            const a = sp[i] * ax + sp[i + 1] * ay + sp[i + 2] * az;
            const b = sp[i] * bx + sp[i + 1] * by + sp[i + 2] * bz;
            for (const t of grid.get(gk(Math.floor(a / cell), Math.floor(b / cell))) ?? []) {
                // Every layer under it: a field reaching over a road must not
                // rise through it either.
                const h = heightAt(tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2], a, b, 1e-6);
                if (!Number.isNaN(h)) {
                    absorbed[t].push(addPoint(a, b, h, POINT_STROKE));
                }
            }
        }
    }

    // Try to move u onto v; commit and answer true if every rule holds.
    const tryCollapse = (u: number, v: number): boolean => {
        const keep: number[] = [];
        const drop: number[] = [];
        for (const t of incident[u]) {
            if (tv[t * 3] === v || tv[t * 3 + 1] === v || tv[t * 3 + 2] === v) {
                drop.push(t);
            } else {
                keep.push(t);
            }
        }
        const onOutline = openNbrs[u].length === 2;
        if (onOutline && !openNbrs[u].includes(v)) {
            return false;
        }
        if (drop.length !== (onOutline ? 1 : 2)) {
            return false;
        }
        // Along an outline: u must lie within tolerance of the edge that
        // replaces its two, on top of what those two already strayed.
        let outlineKey = -1, outlineStray = 0;
        let w = -1;
        if (onOutline) {
            w = openNbrs[u][0] === v ? openNbrs[u][1] : openNbrs[u][0];
            if (w === v) {
                return false;
            }
            const xw = P[w * 3], yw = P[w * 3 + 1], dx = P[v * 3] - xw, dy = P[v * 3 + 1] - yw;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-9) {
                return false;
            }
            const s = Math.max(0, Math.min(1, ((P[u * 3] - xw) * dx + (P[u * 3 + 1] - yw) * dy) / len2));
            const d = Math.hypot(P[u * 3] - (xw + s * dx), P[u * 3 + 1] - (yw + s * dy));
            outlineStray = d + Math.max(outlineErr.get(edgeKey(w, u)) ?? 0, outlineErr.get(edgeKey(u, v)) ?? 0);
            if (outlineStray > toleranceM) {
                return false;
            }
            outlineKey = edgeKey(w, v);
        }
        // Link condition: u and v may share only the two vertices of the
        // triangles that vanish, or the collapse folds the mesh onto itself.
        const nbU = new Set<number>();
        for (const t of incident[u]) {
            for (let k = 0; k < 3; k++) {
                nbU.add(tv[t * 3 + k]);
            }
        }
        let shared = 0;
        const seenV = new Set<number>();
        for (const t of incident[v]) {
            for (let k = 0; k < 3; k++) {
                const w = tv[t * 3 + k];
                if (w !== u && w !== v && !seenV.has(w)) {
                    seenV.add(w);
                    if (nbU.has(w)) {
                        shared++;
                    }
                }
            }
        }
        if (shared !== (onOutline ? 1 : 2)) {
            return false;
        }
        const repl = (t: number, k: number) => (tv[t * 3 + k] === u ? v : tv[t * 3 + k]);
        for (const t of keep) {
            const p0 = repl(t, 0), p1 = repl(t, 1), p2 = repl(t, 2);
            const before = planArea(t, tv[t * 3], tv[t * 3 + 1], tv[t * 3 + 2]);
            const after = planArea(t, p0, p1, p2);
            if (Math.sign(before) !== Math.sign(after) || Math.abs(after) < 2 * MIN_PLAN_AREA) {
                return false;
            }
        }
        // Every absorbed point, and u itself, must land in a kept triangle
        // within its layer's allowance.
        const layerKind = fills[incident[u][0]]
            ? POINT_FILL
            : fillOver(P[u * 3], P[u * 3 + 1]) ? POINT_GROUND : POINT_GROUND_FREE;
        const own = [P[u * 3], P[u * 3 + 1], P[u * 3 + 2], layerKind];
        const owners: Array<[number, number[]]> = [];
        const reach = onOutline ? outlineStray : 0;
        const check = (a: number, b: number, h: number, kind: number): number => {
            for (const t of keep) {
                const z = heightNear(repl(t, 0), repl(t, 1), repl(t, 2), a, b, reach);
                if (Number.isNaN(z)) {
                    continue;
                }
                const d = z - h;
                const ok = kind === POINT_FILL
                    ? d >= -FILL_SINK_M && d <= toleranceM
                    : kind === POINT_GROUND_FREE
                        ? Math.abs(d) <= toleranceM
                        : d <= WRONG_WAY_M && d >= -toleranceM;
                return ok ? t : -1;
            }
            return -1;
        };
        const ownT = check(own[0], own[1], own[2], own[3]);
        if (ownT < 0) {
            return false;
        }
        const moved = new Map<number, number[]>();
        for (const t of incident[u]) {
            for (const p of absorbed[t]) {
                const owner = check(pts[p * 4], pts[p * 4 + 1], pts[p * 4 + 2], pts[p * 4 + 3]);
                if (owner < 0) {
                    return false;
                }
                const list = moved.get(owner);
                if (list) {
                    list.push(p);
                } else {
                    moved.set(owner, [p]);
                }
            }
        }
        // Commit.
        const pu = addPoint(own[0], own[1], own[2], own[3]);
        for (const t of incident[u]) {
            absorbed[t] = [];
        }
        for (const [t, list] of moved) {
            absorbed[t] = list;
        }
        absorbed[ownT].push(pu);
        for (const t of drop) {
            alive[t] = 0;
            for (let k = 0; k < 3; k++) {
                const w = tv[t * 3 + k];
                if (w !== u) {
                    const inc = incident[w];
                    inc.splice(inc.indexOf(t), 1);
                }
            }
        }
        for (const t of keep) {
            for (let k = 0; k < 3; k++) {
                if (tv[t * 3 + k] === u) {
                    tv[t * 3 + k] = v;
                }
            }
            incident[v].push(t);
        }
        incident[u] = [];
        fixed[u] = 1;
        if (onOutline) {
            openNbrs[w][openNbrs[w].indexOf(u)] = v;
            openNbrs[v][openNbrs[v].indexOf(u)] = w;
            outlineErr.set(outlineKey, outlineStray);
            openNbrs[u] = [];
        }
        return true;
    };

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let removed = 0;
        for (let u = 0; u < V; u++) {
            if (fixed[u] || incident[u].length === 0) {
                continue;
            }
            const nbrs = new Set<number>();
            for (const t of incident[u]) {
                for (let k = 0; k < 3; k++) {
                    const w = tv[t * 3 + k];
                    if (w !== u) {
                        nbrs.add(w);
                    }
                }
            }
            const order = [...nbrs].sort((x, y) =>
                Math.hypot(P[x * 3] - P[u * 3], P[x * 3 + 1] - P[u * 3 + 1])
                - Math.hypot(P[y * 3] - P[u * 3], P[y * 3 + 1] - P[u * 3 + 1]));
            for (const v of order) {
                if (tryCollapse(u, v)) {
                    removed++;
                    break;
                }
            }
        }
        if (removed < V * 0.005) {
            break;
        }
    }

    // Write out the live triangles, corners from their original slots.
    let outTris = 0;
    for (let t = 0; t < triCount; t++) {
        outTris += alive[t];
    }
    const outPos = new Int16Array(outTris * 9);
    const outNrm = new Int8Array(outTris * 12);
    const outAttr = new Uint8Array(outTris * 12);
    const outRegion = new Uint16Array(outTris * 3);
    const borderMap: number[] = [];
    let o = 0;
    for (let t = 0; t < triCount; t++) {
        if (!alive[t]) {
            continue;
        }
        let changed = false;
        for (let k = 0; k < 3; k++) {
            const v = tv[t * 3 + k];
            const src = vq[v];
            outPos.set(positions.subarray(src * 3, src * 3 + 3), (o * 3 + k) * 3);
            outAttr.set(attrs.subarray((t * 3 + k) * 4, (t * 3 + k) * 4 + 4), (o * 3 + k) * 4);
            outRegion[o * 3 + k] = input.regionSizes?.[t * 3 + k] ?? 0;
            if (v !== vertexOf[t * 3 + k]) {
                changed = true;
            }
            if (borderSlotOf[v] >= 0) {
                borderMap.push(o * 3 + k, borderSlotOf[v]);
            }
        }
        // A reshaped facet gets its own normal; the rest keep theirs.
        let nx = normals[t * 12], ny = normals[t * 12 + 1], nz = normals[t * 12 + 2];
        if (changed) {
            const c0 = (o * 3) * 3, c1 = c0 + 3, c2 = c0 + 6;
            const e1 = [outPos[c1] - outPos[c0], outPos[c1 + 1] - outPos[c0 + 1], outPos[c1 + 2] - outPos[c0 + 2]];
            const e2 = [outPos[c2] - outPos[c0], outPos[c2 + 1] - outPos[c0 + 1], outPos[c2 + 2] - outPos[c0 + 2]];
            let cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
            const l = Math.hypot(cx, cy, cz) || 1;
            // Same side as the baked normal, whatever the winding convention.
            if (cx * nx + cy * ny + cz * nz < 0) {
                cx = -cx;
                cy = -cy;
                cz = -cz;
            }
            nx = Math.round(cx / l * 127);
            ny = Math.round(cy / l * 127);
            nz = Math.round(cz / l * 127);
        }
        for (let k = 0; k < 3; k++) {
            outNrm.set([nx, ny, nz, 0], (o * 3 + k) * 4);
        }
        o++;
    }
    return {
        positions: outPos, normals: outNrm, attrs: outAttr, regionSizes: outRegion,
        borderMap: Uint32Array.from(borderMap),
        trianglesIn: triCount, trianglesOut: outTris,
    };
}
