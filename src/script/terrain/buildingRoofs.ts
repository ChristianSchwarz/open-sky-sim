/**
 * A building's walls and roof as triangles, from its PBH1 parameters.
 *
 * Every roof here is the lowest of a few planes over the footprint: flat is
 * one level plane, a skillion one sloped plane, a gable two planes meeting
 * at the ridge, a hip roof those two and one more at each end, and so on.
 * That one rule covers every shape the bake asks for and every footprint,
 * not only rectangles: each plane's face is the footprint clipped to where
 * that plane is the lowest (a few half-plane clips), and each wall's top
 * follows the roof along its edge, so a gable end comes out as the wall
 * rising to a point with no separate gable triangle to place. An L-shaped
 * house gets one ridge along its long axis and the arm is cut by the same
 * planes - not what a carpenter would build, but it reads as a pitched roof
 * from the air, which is what phase 1 of docs/terrain-buildings.md asks.
 *
 * The planes are set up on the footprint's extent along and across the
 * ridge: half-length L along it, half-width W across, so a gable's two
 * planes reach the eave exactly at the outermost points of the outline.
 *
 * Works in the PBH1 local frame (u, v horizontal, h up, right-handed); the
 * caller puts the triangles into the tile's axes.
 */

import * as THREE from 'three';
import { RoofForm } from './pbh';

/** h = a*s + b*t + c, with s along the ridge and t across it, centred on the footprint. */
interface Plane {
    a: number;
    b: number;
    c: number;
}

export interface BuildingShape {
    /** Outline first, then courtyards; open rings of (u, v) metres, any winding. */
    rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
    baseM: number;
    eaveM: number;
    ridgeM: number;
    form: RoofForm;
    /** Ridge direction, radians from u toward v. */
    ridgeAngle: number;
    /** A roof on posts: no walls. */
    noWalls?: boolean;
}

/**
 * Receives one triangle: three points as (u, v, h), wound counter-clockwise
 * seen from the side `normal` points to, and whether it belongs to the roof.
 */
export type TriangleSink = (
    p: readonly [number, number, number, number, number, number, number, number, number],
    normal: readonly [number, number, number],
    roof: boolean,
) => void;

const EPS = 1e-6;
/** Wall pieces and roof faces thinner than this are skipped. */
const MIN_EDGE_M = 0.01;
/** Neither extent of a pitched roof goes below this, so the slopes stay finite. */
const MIN_HALF_EXTENT_M = 0.5;

function signedArea(ring: ReadonlyArray<readonly [number, number]>): number {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return a / 2;
}

/** Counter-clockwise copy of a ring (seen from up), or clockwise with `clockwise`. */
function wound(ring: ReadonlyArray<readonly [number, number]>, clockwise: boolean): Array<[number, number]> {
    const out = ring.map(p => [p[0], p[1]] as [number, number]);
    if ((signedArea(out) < 0) !== clockwise) {
        out.reverse();
    }
    return out;
}

export function roofPlanes(form: RoofForm, halfLength: number, halfWidth: number, eave: number, ridge: number): Plane[] {
    const L = Math.max(halfLength, MIN_HALF_EXTENT_M);
    const W = Math.max(halfWidth, MIN_HALF_EXTENT_M);
    const rise = Math.max(0, ridge - eave);
    if (form === RoofForm.Flat || rise < 0.05) {
        return [{ a: 0, b: 0, c: Math.max(eave, ridge) }];
    }
    const k = rise / W;
    const gable: Plane[] = [{ a: 0, b: -k, c: ridge }, { a: 0, b: k, c: ridge }];
    switch (form) {
        case RoofForm.Skillion:
            // Up toward +t: the eave on one long side, the top on the other.
            return [{ a: 0, b: rise / (2 * W), c: eave + rise / 2 }];
        case RoofForm.Gabled:
            return gable;
        case RoofForm.Hipped:
            // The ends at the same pitch as the sides; on a footprint wider
            // than it is long they meet below the ridge, which the minimum
            // turns into a pyramid by itself.
            return [...gable, { a: -k, b: 0, c: eave + k * L }, { a: k, b: 0, c: eave + k * L }];
        case RoofForm.HalfHipped: {
            // Gable walls up to half the rise, then a steeper hip above.
            const k2 = 2 * k;
            const c = eave + rise / 2 + k2 * L;
            return [...gable, { a: -k2, b: 0, c }, { a: k2, b: 0, c }];
        }
        case RoofForm.Pyramidal:
            return [...gable, { a: -rise / L, b: 0, c: ridge }, { a: rise / L, b: 0, c: ridge }];
        default:
            return gable;
    }
}

function lowest(planes: readonly Plane[], s: number, t: number): number {
    let h = Infinity;
    for (const p of planes) {
        h = Math.min(h, p.a * s + p.b * t + p.c);
    }
    return h;
}

function isConvex(ring: ReadonlyArray<readonly [number, number]>): boolean {
    let sign = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
        const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if (Math.abs(cross) < 1e-9) {
            continue;
        }
        if (sign === 0) {
            sign = Math.sign(cross);
        } else if (Math.sign(cross) !== sign) {
            return false;
        }
    }
    return true;
}

/** Sutherland-Hodgman against the half-plane da*s + db*t + dc <= 0. */
function clipHalfPlane(poly: Array<[number, number]>, da: number, db: number, dc: number): Array<[number, number]> {
    if (poly.length === 0) {
        return poly;
    }
    const out: Array<[number, number]> = [];
    const f = (p: [number, number]) => da * p[0] + db * p[1] + dc;
    for (let i = 0; i < poly.length; i++) {
        const cur = poly[i];
        const prev = poly[(i + poly.length - 1) % poly.length];
        const fc = f(cur);
        const fp = f(prev);
        if (fc <= EPS) {
            if (fp > EPS) {
                const k = fp / (fp - fc);
                out.push([prev[0] + (cur[0] - prev[0]) * k, prev[1] + (cur[1] - prev[1]) * k]);
            }
            out.push(cur);
        } else if (fp <= EPS) {
            const k = fp / (fp - fc);
            out.push([prev[0] + (cur[0] - prev[0]) * k, prev[1] + (cur[1] - prev[1]) * k]);
        }
    }
    // Clipping a concave outline can leave repeated points; earcut wants none.
    const clean: Array<[number, number]> = [];
    for (const p of out) {
        const q = clean[clean.length - 1];
        if (!q || Math.abs(q[0] - p[0]) > 1e-5 || Math.abs(q[1] - p[1]) > 1e-5) {
            clean.push(p);
        }
    }
    while (clean.length > 1
        && Math.abs(clean[0][0] - clean[clean.length - 1][0]) <= 1e-5
        && Math.abs(clean[0][1] - clean[clean.length - 1][1]) <= 1e-5) {
        clean.pop();
    }
    return clean;
}

/**
 * Emits the triangles of one building and returns how many there were.
 * Pitched forms on a footprint with courtyards are drawn flat.
 */
export function buildingTriangles(shape: BuildingShape, emit: TriangleSink): number {
    if (shape.rings.length === 0 || shape.rings[0].length < 3) {
        return 0;
    }
    const outer = wound(shape.rings[0], false);
    const holes = shape.rings.slice(1).filter(r => r.length >= 3).map(r => wound(r, true));
    const form = holes.length > 0 ? RoofForm.Flat : shape.form;

    // The ridge frame: s along the ridge, t across it, centred on the outline's extent.
    const dx = Math.cos(shape.ridgeAngle), dy = Math.sin(shape.ridgeAngle);
    let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (const [u, v] of outer) {
        const s = u * dx + v * dy, t = -u * dy + v * dx;
        sMin = Math.min(sMin, s); sMax = Math.max(sMax, s);
        tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
    }
    const sc = (sMin + sMax) / 2, tc = (tMin + tMax) / 2;
    const toST = (p: readonly [number, number]): [number, number] =>
        [p[0] * dx + p[1] * dy - sc, -p[0] * dy + p[1] * dx - tc];
    const toUV = (s: number, t: number): [number, number] =>
        [(s + sc) * dx - (t + tc) * dy, (s + sc) * dy + (t + tc) * dx];
    const planes = roofPlanes(form, (sMax - sMin) / 2, (tMax - tMin) / 2, shape.eaveM, shape.ridgeM);

    let tris = 0;
    const put = (p0: number[], p1: number[], p2: number[], n: readonly [number, number, number], roof: boolean) => {
        const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
        const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
        const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        const along = cx * n[0] + cy * n[1] + cz * n[2];
        if (Math.abs(along) < 1e-8) {
            return; // degenerate
        }
        const [a, b] = along > 0 ? [p1, p2] : [p2, p1];
        emit([p0[0], p0[1], p0[2], a[0], a[1], a[2], b[0], b[1], b[2]], n, roof);
        tris++;
    };

    // Roof faces. A face is the footprint clipped to where its plane is the
    // lowest, a convex region, so it is clipped exactly piece by piece: the
    // outline whole when it is convex, else each triangle of it - clipping a
    // concave polygon in one go leaves bridging edges along the cut that the
    // triangulation then fills.
    const outerST = outer.map(toST);
    const holesST = holes.map(h => h.map(toST));
    const pieces: Array<Array<[number, number]>> = [];
    if (planes.length > 1 && !isConvex(outerST)) {
        const contour = outerST.map(p => new THREE.Vector2(p[0], p[1]));
        for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
            pieces.push([outerST[a], outerST[b], outerST[c]]);
        }
    } else {
        pieces.push(outerST);
    }
    for (let i = 0; i < planes.length; i++) {
        const pl = planes[i];
        // Normal of h = a*s + b*t + c is (-a, -b, 1) in (s, t, h); back to (u, v, h).
        const ns = -pl.a, nt = -pl.b;
        const nu = ns * dx - nt * dy, nv = ns * dy + nt * dx;
        const len = Math.hypot(nu, nv, 1);
        const normal: [number, number, number] = [nu / len, nv / len, 1 / len];
        const lift = (p: readonly [number, number]) => {
            const [u, v] = toUV(p[0], p[1]);
            return [u, v, pl.a * p[0] + pl.b * p[1] + pl.c];
        };
        if (planes.length === 1) {
            // One plane (flat or skillion): the outline as it is, courtyards and all.
            const contour = outerST.map(p => new THREE.Vector2(p[0], p[1]));
            const holeVecs = holesST.map(h => h.map(p => new THREE.Vector2(p[0], p[1])));
            const all = [...outerST, ...holesST.flat()];
            for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holeVecs)) {
                put(lift(all[a]), lift(all[b]), lift(all[c]), normal, true);
            }
            continue;
        }
        for (const piece of pieces) {
            let face = piece;
            for (let j = 0; j < planes.length && face.length >= 3; j++) {
                if (j === i) {
                    continue;
                }
                const da = pl.a - planes[j].a, db = pl.b - planes[j].b, dc = pl.c - planes[j].c;
                if (Math.abs(da) < EPS && Math.abs(db) < EPS) {
                    if (dc > EPS) {
                        face = []; // plane j lies wholly under plane i
                    }
                    continue;
                }
                face = clipHalfPlane(face, da, db, dc);
            }
            if (face.length < 3 || Math.abs(signedArea(face)) < MIN_EDGE_M * MIN_EDGE_M) {
                continue;
            }
            // Convex: a fan.
            const p0 = lift(face[0]);
            for (let k = 1; k + 1 < face.length; k++) {
                put(p0, lift(face[k]), lift(face[k + 1]), normal, true);
            }
        }
    }

    if (shape.noWalls) {
        return tris;
    }

    // Walls: each edge from the base up to the roof, split where the lowest
    // plane changes so a gable end rises to its ridge.
    const base = shape.baseM;
    for (const ring of [outer, ...holes]) {
        for (let i = 0; i < ring.length; i++) {
            const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
            const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
            const len = Math.hypot(ex, ey);
            if (len < MIN_EDGE_M) {
                continue;
            }
            // Outward: right of a counter-clockwise outline's edges, and of a
            // clockwise courtyard's, which faces into the courtyard.
            const normal: [number, number, number] = [ey / len, -ex / len, 0];
            const s0 = toST(p0), s1 = toST(p1);
            const cuts = [0, 1];
            for (let a = 0; a < planes.length; a++) {
                for (let b = a + 1; b < planes.length; b++) {
                    const d = (p: [number, number]) =>
                        (planes[a].a - planes[b].a) * p[0] + (planes[a].b - planes[b].b) * p[1] + (planes[a].c - planes[b].c);
                    const d0 = d(s0), d1 = d(s1);
                    if ((d0 > EPS && d1 < -EPS) || (d0 < -EPS && d1 > EPS)) {
                        cuts.push(d0 / (d0 - d1));
                    }
                }
            }
            cuts.sort((x, y) => x - y);
            for (let k = 0; k + 1 < cuts.length; k++) {
                const ta = cuts[k], tb = cuts[k + 1];
                if ((tb - ta) * len < MIN_EDGE_M) {
                    continue;
                }
                const qa = [p0[0] + ex * ta, p0[1] + ey * ta];
                const qb = [p0[0] + ex * tb, p0[1] + ey * tb];
                const ha = lowest(planes, s0[0] + (s1[0] - s0[0]) * ta, s0[1] + (s1[1] - s0[1]) * ta);
                const hb = lowest(planes, s0[0] + (s1[0] - s0[0]) * tb, s0[1] + (s1[1] - s0[1]) * tb);
                if (ha <= base + MIN_EDGE_M && hb <= base + MIN_EDGE_M) {
                    continue;
                }
                const a0 = [qa[0], qa[1], base], b0 = [qb[0], qb[1], base];
                const a1 = [qa[0], qa[1], Math.max(base, ha)], b1 = [qb[0], qb[1], Math.max(base, hb)];
                put(a0, b0, b1, normal, false);
                put(a0, b1, a1, normal, false);
            }
        }
    }
    return tris;
}
