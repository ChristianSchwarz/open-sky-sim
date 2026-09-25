/**
 * Unit tests for the body-frame triangle BVH.
 *
 * The tree is an acceleration structure, so most of these check it against a
 * brute-force sweep of the same soup: the answer must not depend on how the
 * triangles were partitioned, and a pruning bug shows up as a query that
 * silently misses geometry a linear walk finds.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    bvhClosest,
    bvhClosestPoint,
    bvhContainsPoint,
    bvhHit,
    bvhSegmentHit,
    buildTriangleBvh,
    triangleBvhFor,
    TriangleBvh,
} from './triangleBvh';

/** Deterministic PRNG — the sim must not depend on wall-clock randomness. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Closed axis-aligned box, 12 triangles, wound so face normals point out. */
function boxSoup(
    min: [number, number, number],
    max: [number, number, number],
): number[] {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    return [
        // +Y (top)
        x0, y1, z0, x0, y1, z1, x1, y1, z1,
        x0, y1, z0, x1, y1, z1, x1, y1, z0,
        // -Y (bottom)
        x0, y0, z0, x1, y0, z0, x1, y0, z1,
        x0, y0, z0, x1, y0, z1, x0, y0, z1,
        // +X
        x1, y0, z0, x1, y1, z0, x1, y1, z1,
        x1, y0, z0, x1, y1, z1, x1, y0, z1,
        // -X
        x0, y0, z0, x0, y0, z1, x0, y1, z1,
        x0, y0, z0, x0, y1, z1, x0, y1, z0,
        // +Z
        x0, y0, z1, x1, y0, z1, x1, y1, z1,
        x0, y0, z1, x1, y1, z1, x0, y1, z1,
        // -Z
        x0, y0, z0, x0, y1, z0, x1, y1, z0,
        x0, y0, z0, x1, y1, z0, x1, y0, z0,
    ];
}

/** Closed UV sphere; enough triangles that the tree is more than one leaf. */
function sphereSoup(radius: number, slices: number, stacks: number): number[] {
    const vertex = (i: number, j: number): [number, number, number] => {
        const phi = (Math.PI * i) / stacks;
        const theta = (2 * Math.PI * j) / slices;
        return [
            radius * Math.sin(phi) * Math.cos(theta),
            radius * Math.cos(phi),
            radius * Math.sin(phi) * Math.sin(theta),
        ];
    };
    const t: number[] = [];
    for (let i = 0; i < stacks; i++) {
        for (let j = 0; j < slices; j++) {
            const a = vertex(i, j);
            const b = vertex(i, (j + 1) % slices);
            const c = vertex(i + 1, (j + 1) % slices);
            const d = vertex(i + 1, j);
            // The pole rows would give a degenerate triangle apiece; skip them.
            if (i > 0) t.push(...a, ...b, ...c);
            if (i < stacks - 1) t.push(...a, ...c, ...d);
        }
    }
    return t;
}

/**
 * Closest point on one triangle, by plane projection with an edge fallback.
 *
 * Deliberately a different formulation from the Voronoi-region routine the BVH
 * uses, so the two agreeing is worth something.
 */
function refClosestOnTriangle(
    p: readonly [number, number, number],
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
): [number, number, number] {
    const sub = (u: readonly number[], v: readonly number[]) =>
        [u[0] - v[0], u[1] - v[1], u[2] - v[2]] as [number, number, number];
    const dot = (u: readonly number[], v: readonly number[]) =>
        u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const cross = (u: readonly number[], v: readonly number[]) =>
        [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ] as [number, number, number];

    const ab = sub(b, a);
    const ac = sub(c, a);
    const n = cross(ab, ac);
    const nn = dot(n, n);
    if (nn > 1e-18) {
        // Project onto the plane, then read barycentrics off the sub-areas.
        const t = dot(sub(p, a), n) / nn;
        const q: [number, number, number] = [
            p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t,
        ];
        const u = dot(cross(sub(b, q), sub(c, q)), n) / nn;
        const v = dot(cross(sub(c, q), sub(a, q)), n) / nn;
        const w = dot(cross(sub(a, q), sub(b, q)), n) / nn;
        if (u >= 0 && v >= 0 && w >= 0) return q;
    }
    // Outside the face (or degenerate): the nearest point is on an edge.
    let best: [number, number, number] = [a[0], a[1], a[2]];
    let bestD = Infinity;
    for (const [s, e] of [[a, b], [b, c], [c, a]] as const) {
        const se = sub(e, s);
        const len = dot(se, se);
        const t = len > 1e-18
            ? Math.max(0, Math.min(1, dot(sub(p, s), se) / len))
            : 0;
        const q: [number, number, number] = [
            s[0] + se[0] * t, s[1] + se[1] * t, s[2] + se[2] * t,
        ];
        const d = dot(sub(p, q), sub(p, q));
        if (d < bestD) {
            bestD = d;
            best = q;
        }
    }
    return best;
}

/** Linear sweep for the nearest surface point; the reference for the tree. */
function refClosest(
    soup: readonly number[],
    p: readonly [number, number, number],
): { distSq: number; point: [number, number, number] } {
    let distSq = Infinity;
    let point: [number, number, number] = [0, 0, 0];
    for (let i = 0; i + 8 < soup.length; i += 9) {
        const q = refClosestOnTriangle(
            p,
            [soup[i], soup[i + 1], soup[i + 2]],
            [soup[i + 3], soup[i + 4], soup[i + 5]],
            [soup[i + 6], soup[i + 7], soup[i + 8]],
        );
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < distSq) {
            distSq = d;
            point = q;
        }
    }
    return { distSq, point };
}

/**
 * Linear sweep for the earliest segment hit, by plane crossing plus a
 * barycentric containment test — again a different route to the same answer.
 */
function refSegmentHit(
    soup: readonly number[],
    a: readonly [number, number, number],
    b: readonly [number, number, number],
): number {
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let best = Infinity;
    for (let i = 0; i + 8 < soup.length; i += 9) {
        const v0 = [soup[i], soup[i + 1], soup[i + 2]];
        const v1 = [soup[i + 3], soup[i + 4], soup[i + 5]];
        const v2 = [soup[i + 6], soup[i + 7], soup[i + 8]];
        const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        const n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const denom = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
        if (Math.abs(denom) < 1e-12) continue;
        const t = (n[0] * (v0[0] - a[0]) + n[1] * (v0[1] - a[1]) + n[2] * (v0[2] - a[2])) / denom;
        if (t < 0 || t > 1 || t >= best) continue;
        const p: [number, number, number] = [
            a[0] + dir[0] * t, a[1] + dir[1] * t, a[2] + dir[2] * t,
        ];
        // Inside the triangle when all three sub-triangle normals agree with n.
        let inside = true;
        for (const [s, e] of [[v0, v1], [v1, v2], [v2, v0]] as const) {
            const es = [e[0] - s[0], e[1] - s[1], e[2] - s[2]];
            const ps = [p[0] - s[0], p[1] - s[1], p[2] - s[2]];
            const c = [
                es[1] * ps[2] - es[2] * ps[1],
                es[2] * ps[0] - es[0] * ps[2],
                es[0] * ps[1] - es[1] * ps[0],
            ];
            if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < -1e-9) {
                inside = false;
                break;
            }
        }
        if (inside) best = t;
    }
    return best;
}

/** Walk the tree, asserting the structural invariants a traversal relies on. */
function checkTree(bvh: TriangleBvh, triCount: number): void {
    const seen = new Uint8Array(triCount);
    const visit = (node: number): [number, number, number, number, number, number] => {
        const o = node * 6;
        const b: [number, number, number, number, number, number] = [
            bvh.bounds[o], bvh.bounds[o + 1], bvh.bounds[o + 2],
            bvh.bounds[o + 3], bvh.bounds[o + 4], bvh.bounds[o + 5],
        ];
        const count = bvh.triCount[node];
        if (count > 0) {
            const first = bvh.leftFirst[node];
            for (let i = first; i < first + count; i++) {
                const t = bvh.triIndex[i];
                assert.equal(seen[t], 0, `triangle ${t} in two leaves`);
                seen[t] = 1;
                // Every vertex of an owned triangle is inside the leaf's box.
                for (let v = 0; v < 9; v += 3) {
                    for (let k = 0; k < 3; k++) {
                        const c = bvh.tri[t * 9 + v + k];
                        assert.ok(c >= b[k] - 1e-5 && c <= b[k + 3] + 1e-5,
                            `triangle ${t} pokes out of its leaf bounds`);
                    }
                }
            }
            return b;
        }
        const l = bvh.leftFirst[node];
        assert.ok(l > node && l + 1 < bvh.nodeCount, `bad child index at node ${node}`);
        for (const child of [visit(l), visit(l + 1)]) {
            for (let k = 0; k < 3; k++) {
                assert.ok(child[k] >= b[k] - 1e-5, 'child box escapes its parent');
                assert.ok(child[k + 3] <= b[k + 3] + 1e-5, 'child box escapes its parent');
            }
        }
        return b;
    };
    visit(0);
    for (let i = 0; i < triCount; i++) {
        assert.equal(seen[i], 1, `triangle ${i} is in no leaf`);
    }
}

describe('triangle BVH build', () => {

    it('puts every triangle in exactly one leaf, nested in its parent', () => {
        const soup = sphereSoup(3, 16, 8);
        const bvh = buildTriangleBvh(soup);
        assert.equal(bvh.tri.length, soup.length);
        checkTree(bvh, soup.length / 9);
    });

    it('handles a box small enough to stay one leaf', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        checkTree(bvh, 12);
        assert.ok(bvh.nodeCount >= 1);
    });

    it('survives coincident centroids, where the midpoint split degenerates', () => {
        // Fifty copies of the same triangle: no split plane separates them, so
        // this exercises the halving fallback rather than the partition.
        const soup: number[] = [];
        for (let i = 0; i < 50; i++) soup.push(0, 0, 0, 1, 0, 0, 0, 1, 0);
        const bvh = buildTriangleBvh(soup);
        checkTree(bvh, 50);

        const out = bvhClosest();
        assert.equal(bvhClosestPoint(bvh, 0.25, 0.25, 2, 10, out), true);
        assert.ok(Math.abs(out.distSq - 4) < 1e-6);
    });

    it('builds an empty tree for an empty mesh and answers every query false', () => {
        const bvh = buildTriangleBvh([]);
        assert.equal(bvh.nodeCount, 1);
        assert.equal(bvhClosestPoint(bvh, 0, 0, 0, 100, bvhClosest()), false);
        assert.equal(bvhSegmentHit(bvh, -1, 0, 0, 1, 0, 0, bvhHit()), false);
        assert.equal(bvhContainsPoint(bvh, 0, 0, 0), false);
    });

    it('keeps leaves small and the node count linear on a big hull', () => {
        // The whole point of the tree: a query must not degenerate into the
        // linear walk it replaced.
        const soup = sphereSoup(5, 64, 32);
        const triCount = soup.length / 9;
        assert.ok(triCount > 3000, `expected a big mesh, got ${triCount} triangles`);
        const bvh = buildTriangleBvh(soup);
        let maxLeaf = 0;
        for (let n = 0; n < bvh.nodeCount; n++) {
            if (bvh.triCount[n] > maxLeaf) maxLeaf = bvh.triCount[n];
        }
        assert.ok(maxLeaf <= 4, `leaf holds ${maxLeaf} triangles`);
        assert.ok(bvh.nodeCount <= triCount * 2, `${bvh.nodeCount} nodes for ${triCount} triangles`);
    });

    it('works on a hull nowhere near the origin', () => {
        // Carrier-local coordinates put the airframe tens of metres out; the
        // tree must not assume bounds straddling zero.
        const bvh = buildTriangleBvh(boxSoup([100, 200, -300], [102, 201, -298]));
        const out = bvhClosest();
        assert.equal(bvhClosestPoint(bvh, 101, 204, -299, 10, out), true);
        assert.ok(Math.abs(out.distSq - 9) < 1e-6);
        assert.equal(bvhContainsPoint(bvh, 101, 200.5, -299), true);
        assert.equal(bvhContainsPoint(bvh, 101, 205, -299), false);
    });

    it('caches one tree per collision mesh', () => {
        const mesh = { triangles: boxSoup([-1, -1, -1], [1, 1, 1]), aabb: { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] } };
        assert.equal(triangleBvhFor(mesh), triangleBvhFor(mesh));
    });
});

describe('BVH closest point', () => {

    it('finds the face, edge and vertex regions of a box', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhClosest();

        // Straight above the top face.
        assert.equal(bvhClosestPoint(bvh, 0, 3, 0, 10, out), true);
        assert.ok(Math.abs(out.distSq - 4) < 1e-6);
        assert.ok(Math.abs(out.y - 1) < 1e-6);

        // Off a top edge: nearest point is on the edge, not either face.
        assert.equal(bvhClosestPoint(bvh, 0, 2, 2, 10, out), true);
        assert.ok(Math.abs(out.distSq - 2) < 1e-6);
        assert.ok(Math.abs(out.y - 1) < 1e-6 && Math.abs(out.z - 1) < 1e-6);

        // Past a corner.
        assert.equal(bvhClosestPoint(bvh, 2, 2, 2, 10, out), true);
        assert.ok(Math.abs(out.distSq - 3) < 1e-6);
    });

    it('reports zero distance for a point on the surface', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhClosest();
        assert.equal(bvhClosestPoint(bvh, 0.3, 1, -0.2, 10, out), true);
        assert.ok(out.distSq < 1e-9);
    });

    it('returns a unit normal, pointing out of the hull', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhClosest();
        assert.equal(bvhClosestPoint(bvh, 0, 3, 0, 10, out), true);
        assert.ok(Math.abs(Math.hypot(out.nx, out.ny, out.nz) - 1) < 1e-6);
        assert.ok(out.ny > 0.99, 'top face normal should point up');

        assert.equal(bvhClosestPoint(bvh, 0, -3, 0, 10, out), true);
        assert.ok(out.ny < -0.99, 'bottom face normal should point down');
    });

    it('culls at maxDist so a particle clear of the airframe costs nothing', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhClosest();
        assert.equal(bvhClosestPoint(bvh, 0, 50, 0, 10, out), false);
        assert.equal(out.tri, -1);
        assert.equal(bvhClosestPoint(bvh, 0, 50, 0, 60, out), true);
    });

    it('agrees with a linear sweep over a whole sphere of query points', () => {
        const soup = sphereSoup(4, 20, 10);
        const bvh = buildTriangleBvh(soup);
        const out = bvhClosest();
        const rnd = mulberry32(0x5EED);
        for (let i = 0; i < 300; i++) {
            const p: [number, number, number] = [
                (rnd() - 0.5) * 14, (rnd() - 0.5) * 14, (rnd() - 0.5) * 14,
            ];
            const ref = refClosest(soup, p);
            assert.equal(bvhClosestPoint(bvh, p[0], p[1], p[2], 100, out), true);
            assert.ok(Math.abs(out.distSq - ref.distSq) < 1e-4,
                `distSq ${out.distSq} vs ${ref.distSq} at ${p}`);
        }
    });
});

describe('BVH segment hit', () => {

    it('stops at the near wall of a box, not the far one', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhHit();
        assert.equal(bvhSegmentHit(bvh, 0, 5, 0, 0, -5, 0, out), true);
        // 5 -> -5 crosses y = 1 four tenths of the way along.
        assert.ok(Math.abs(out.t - 0.4) < 1e-6);
        assert.ok(Math.abs(out.y - 1) < 1e-6);
        assert.ok(out.ny > 0.99);
    });

    it('catches back faces, so a particle already inside is still stopped', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhHit();
        assert.equal(bvhSegmentHit(bvh, 0, 0, 0, 0, 5, 0, out), true);
        assert.ok(Math.abs(out.y - 1) < 1e-6);
    });

    it('misses cleanly, and refuses a zero-length segment', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        const out = bvhHit();
        assert.equal(bvhSegmentHit(bvh, 5, 5, 5, 5, 5, -5, out), false);
        assert.equal(out.tri, -1);
        assert.equal(bvhSegmentHit(bvh, 0, 3, 0, 0, 3, 0, out), false);
    });

    it('catches a thin panel a static push-out would tunnel through', () => {
        // A trailing edge is a few centimetres thick; one substep of closure at
        // landing speed is tens of centimetres. Only the swept test sees it.
        const bvh = buildTriangleBvh(boxSoup([-4, -0.025, -1], [4, 0.025, 1]));
        const out = bvhHit();
        assert.equal(bvhSegmentHit(bvh, 0, 0.5, 0, 0, -0.5, 0, out), true);
        assert.ok(Math.abs(out.y - 0.025) < 1e-6);
    });

    it('agrees with a linear sweep over random segments', () => {
        const soup = sphereSoup(4, 20, 10);
        const bvh = buildTriangleBvh(soup);
        const out = bvhHit();
        const rnd = mulberry32(0xC0FFEE);
        let hits = 0;
        for (let i = 0; i < 300; i++) {
            const a: [number, number, number] = [
                (rnd() - 0.5) * 16, (rnd() - 0.5) * 16, (rnd() - 0.5) * 16,
            ];
            const b: [number, number, number] = [
                (rnd() - 0.5) * 16, (rnd() - 0.5) * 16, (rnd() - 0.5) * 16,
            ];
            const ref = refSegmentHit(soup, a, b);
            const got = bvhSegmentHit(bvh, a[0], a[1], a[2], b[0], b[1], b[2], out);
            if (ref === Infinity) {
                assert.equal(got, false, `spurious hit on segment ${i}`);
                continue;
            }
            hits++;
            assert.equal(got, true, `missed hit on segment ${i}`);
            assert.ok(Math.abs(out.t - ref) < 1e-5, `t ${out.t} vs ${ref} on segment ${i}`);
        }
        assert.ok(hits > 30, `only ${hits} of 300 segments hit — test is not exercising much`);
    });
});

describe('BVH point containment', () => {

    it('separates inside from outside a box', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        assert.equal(bvhContainsPoint(bvh, 0, 0, 0), true);
        assert.equal(bvhContainsPoint(bvh, 0.9, -0.9, 0.5), true);
        assert.equal(bvhContainsPoint(bvh, 1.5, 0, 0), false);
        assert.equal(bvhContainsPoint(bvh, 0, 0, -3), false);
    });

    it('is not fooled by rays running along the quads\' shared diagonals', () => {
        // A cardinal ray from anywhere on the box's centre planes leaves through
        // the seam where two face triangles meet, and gets counted twice or not
        // at all. Every one of these points reported "outside" before the ray
        // went off-axis.
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        for (const p of [
            [0, 0, 0], [0.5, 0.5, 0.5], [-0.5, -0.5, -0.5],
            [0, 0.5, 0], [0.5, 0, 0], [0, 0, 0.5], [0.25, 0.25, -0.25],
        ] as const) {
            assert.equal(bvhContainsPoint(bvh, p[0], p[1], p[2]), true, `inside at ${p}`);
        }
        for (const p of [
            [1.5, 1.5, 1.5], [0, 1.5, 0], [-1.5, 0, 0], [0, 0, 1.5],
        ] as const) {
            assert.equal(bvhContainsPoint(bvh, p[0], p[1], p[2]), false, `outside at ${p}`);
        }
    });

    it('rejects points outside the root box without traversing', () => {
        const bvh = buildTriangleBvh(boxSoup([-1, -1, -1], [1, 1, 1]));
        assert.equal(bvhContainsPoint(bvh, 0, 100, 0), false);
        assert.equal(bvhContainsPoint(bvh, 100, 0, 0), false);
    });

    it('separates inside from outside a sphere', () => {
        const bvh = buildTriangleBvh(sphereSoup(4, 20, 10));
        const rnd = mulberry32(0xBEEF);
        for (let i = 0; i < 200; i++) {
            const dir = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
            const len = Math.hypot(dir[0], dir[1], dir[2]);
            if (len < 1e-6) continue;
            // Well inside and well outside; the facetted skin makes the shell
            // itself ambiguous, which is exactly why the swept test leads.
            for (const [r, want] of [[2, true], [6, false]] as const) {
                const s = r / len;
                assert.equal(
                    bvhContainsPoint(bvh, dir[0] * s, dir[1] * s, dir[2] * s),
                    want,
                    `radius ${r} sample ${i}`,
                );
            }
        }
    });
});
