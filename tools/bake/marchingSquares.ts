/**
 * Marching-squares cell cutting: split one grid cell into land and water
 * triangles along the shoreline.
 *
 * This replaces the constrained Delaunay triangulation the old runtime used.
 * Working one cell at a time makes the problem local and finite: there are 16
 * corner classifications, each with a known decomposition, so there is no
 * global solver, no sliver backstop heuristic, and no failure mode that needs
 * a whole-tile fallback.
 *
 * Corner and edge numbering, in cell-local coordinates where x runs east and
 * y runs south (matching the row-major DEM grid, v=0 at the north edge):
 *
 *      c0 (0,0) ---- e0 ---- c1 (1,0)
 *          |                    |
 *         e3                   e1
 *          |                    |
 *      c3 (0,1) ---- e2 ---- c2 (1,1)
 *
 * `edgeCrossings[i]` is where the shoreline crosses the edge leaving corner i,
 * as a parameter in [0, 1] along that edge. It is required whenever the two
 * corners of that edge differ in class, and ignored otherwise.
 *
 * Slivers are eliminated by construction rather than detected afterwards: a
 * crossing within `SNAP_EPS` of either end is snapped onto that corner, which
 * collapses the offending triangle to zero area so it is dropped.
 */

/**
 * A cell-local point. `shore` marks the ones that came from a shoreline
 * crossing rather than a cell corner.
 *
 * Land and water become separate meshes downstream, and they have to agree on
 * height exactly where they meet or the seam opens. Tagging the crossings here
 * is what lets the projection recognise them. Matching land against water
 * positions numerically instead is fragile: adjacent leaves compute the same
 * crossing independently and can disagree in the last decimal.
 */
export type Vec2 = { x: number; y: number; shore?: boolean };

/** A crossing closer than this (in cell fractions) collapses onto the corner. */
export const SNAP_EPS = 1e-3;

/** Triangles below this area (in cell fractions) are discarded as degenerate. */
export const MIN_AREA = 1e-9;

export interface CellCutInput {
    /** Land flag for c0..c3, in the order shown above. */
    corners: readonly [boolean, boolean, boolean, boolean];
    /** Crossing parameter in [0,1] along edge i (c_i -> c_{i+1}), or undefined. */
    edgeCrossings: readonly (number | undefined)[];
    /**
     * Only consulted for the two ambiguous saddle cases (land on one diagonal,
     * water on the other). True when the cell centre is land.
     */
    centreIsLand?: boolean;
    /**
     * Whether edge i's crossing (if any) is a genuine land/water transition,
     * worth a shore wall downstream, as opposed to two same-side regions this
     * cutter's own boolean `corners` collapses together (a landuse-only split
     * mapped onto true/false, say). Defaults to every edge being one, which
     * is what a caller working in real land/water terms wants; a caller that
     * synthesizes the boolean split from something coarser should pass this
     * explicitly. See {@link Vec2.shore}.
     */
    shoreEdges?: readonly boolean[];
}

export interface CellCutResult {
    /** Cell-local triangles, 3 points each, counter-clockwise in (x, y-down). */
    land: Vec2[][];
    water: Vec2[][];
}

const CORNERS: readonly Vec2[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
];

function lerpOnEdge(edge: number, t: number, shore = true): Vec2 {
    const a = CORNERS[edge];
    const b = CORNERS[(edge + 1) % 4];
    // Every point this produces lies on a cell boundary by construction; only
    // a genuine land/water crossing is tagged `shore` - see the callers.
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, shore };
}

function signedArea(p: Vec2[]): number {
    let s = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        s += (p[j].x * p[i].y) - (p[i].x * p[j].y);
    }
    return s / 2;
}

/**
 * Fan-triangulate a convex ring from a vertex no fan triangle is degenerate
 * at. A ring here runs along the cell's edges, so three of its consecutive
 * vertices can be collinear: a crossing snapped onto a corner leaves the
 * corner beside a crossing on the next edge (the midpoint default when no
 * geometry was supplied), and fanned from the corner before them, the
 * triangle through all three has no area. Dropping it dropped the crossing
 * from this cell's outline while the neighbour across the edge kept it - a
 * T-junction that the collapse pass later opens into a hole. Any convex
 * ring with area has an apex that fans cleanly; a ring without area is
 * nothing to draw.
 */
function fan(poly: Vec2[], out: Vec2[][]): void {
    if (poly.length < 3 || Math.abs(signedArea(poly)) <= MIN_AREA) {
        return;
    }
    const ccw = signedArea(poly) >= 0;
    const n = poly.length;
    for (let k = 0; k < n; k++) {
        const tris: Vec2[][] = [];
        let ok = true;
        for (let i = 1; i + 1 < n; i++) {
            const a = poly[(k + i) % n], b = poly[(k + i + 1) % n];
            const tri = ccw ? [poly[k], a, b] : [poly[k], b, a];
            if (Math.abs(signedArea(tri)) <= MIN_AREA) {
                ok = false;
                break;
            }
            tris.push(tri);
        }
        if (ok) {
            out.push(...tris);
            return;
        }
    }
    // Not reachable for a convex ring with area; keep the cell tiled anyway.
    for (let i = 1; i + 1 < n; i++) {
        const tri = ccw ? [poly[0], poly[i], poly[i + 1]] : [poly[0], poly[i + 1], poly[i]];
        if (Math.abs(signedArea(tri)) > MIN_AREA) {
            out.push(tri);
        }
    }
}

function dedupe(poly: Vec2[]): Vec2[] {
    const out: Vec2[] = [];
    for (const p of poly) {
        const last = out[out.length - 1];
        if (!last || Math.abs(last.x - p.x) > 1e-12 || Math.abs(last.y - p.y) > 1e-12) {
            out.push(p);
        }
    }
    while (out.length > 1) {
        const first = out[0];
        const last = out[out.length - 1];
        if (Math.abs(first.x - last.x) < 1e-12 && Math.abs(first.y - last.y) < 1e-12) {
            out.pop();
        } else {
            break;
        }
    }
    return out;
}

/**
 * Cut one cell. Returns land and water triangles that exactly tile the unit
 * cell: no gaps, no overlaps, every triangle tagged by the class of the region
 * it came from.
 */
export function cutCell(input: CellCutInput): CellCutResult {
    const { corners } = input;
    const land: Vec2[][] = [];
    const water: Vec2[][] = [];

    const nLand = corners.reduce((n, c) => n + (c ? 1 : 0), 0);

    // Uniform cell: no shoreline, split along a diagonal.
    if (nLand === 0 || nLand === 4) {
        const quad = [CORNERS[0], CORNERS[1], CORNERS[2], CORNERS[3]];
        fan(quad, nLand === 4 ? land : water);
        return { land, water };
    }

    // Snap crossings onto corners when they are within SNAP_EPS, so the
    // triangle that would have been a sliver collapses to zero area instead.
    const cross: (Vec2 | undefined)[] = [];
    for (let e = 0; e < 4; e++) {
        const a = corners[e];
        const b = corners[(e + 1) % 4];
        if (a === b) {
            cross.push(undefined);
            continue;
        }
        let t = input.edgeCrossings[e];
        if (t === undefined || !Number.isFinite(t)) {
            // No geometry supplied for a genuine crossing: fall back to the
            // edge midpoint so the cell still tiles rather than tearing.
            t = 0.5;
        }
        t = t < SNAP_EPS ? 0 : t > 1 - SNAP_EPS ? 1 : t;
        cross.push(lerpOnEdge(e, t, input.shoreEdges ? input.shoreEdges[e] : true));
    }

    const isSaddle = nLand === 2 && corners[0] === corners[2] && corners[1] === corners[3];

    if (!isSaddle) {
        // Exactly two crossings; they split the cell boundary into a land arc
        // and a water arc. Each arc plus the chord between the crossings is a
        // convex polygon.
        const landPoly: Vec2[] = [];
        const waterPoly: Vec2[] = [];
        for (let c = 0; c < 4; c++) {
            (corners[c] ? landPoly : waterPoly).push(CORNERS[c]);
            const x = cross[c];
            if (x) {
                landPoly.push(x);
                waterPoly.push(x);
            }
        }
        fan(dedupe(landPoly), land);
        fan(dedupe(waterPoly), water);
        return { land, water };
    }

    // Saddle: land occupies one diagonal, water the other, and all four edges
    // are crossed. Which pair joins through the middle is genuinely ambiguous
    // from the corners alone, so the caller samples the cell centre.
    const centreIsLand = input.centreIsLand ?? corners[0];
    const majorityIsLand = centreIsLand;

    // The two minority corners each become a corner triangle; the majority
    // takes the remaining hexagon.
    const minorityCorners = [0, 1, 2, 3].filter(c => corners[c] !== majorityIsLand);
    const minorityOut = majorityIsLand ? water : land;
    const majorityOut = majorityIsLand ? land : water;

    for (const c of minorityCorners) {
        const before = cross[(c + 3) % 4];
        const after = cross[c];
        if (before && after) {
            fan(dedupe([before, CORNERS[c], after]), minorityOut);
        }
    }

    const hex: Vec2[] = [];
    for (let c = 0; c < 4; c++) {
        if (corners[c] === majorityIsLand) {
            const before = cross[(c + 3) % 4];
            if (before) {
                hex.push(before);
            }
            hex.push(CORNERS[c]);
            const after = cross[c];
            if (after) {
                hex.push(after);
            }
        }
    }
    fan(dedupe(hex), majorityOut);

    return { land, water };
}

/**
 * Cut one cell into more than two regions at once — a real landuse boundary
 * crossing the same cell as the shoreline, or two landuse boundaries meeting
 * in one cell. `cutCell` above is kept untouched and unreachable-by-shoreline
 * paths keep calling it directly; this is additive.
 *
 * The construction generalizes `cutCell`'s own hex/corner-triangle split
 * rather than replacing it: every corner not belonging to the cell-centre's
 * region becomes its own small wedge, bounded only by the crossings just
 * before and after it — exactly `cutCell`'s minority corner triangles, just
 * allowed to span more than one corner. What is left after removing every
 * such wedge is, by construction, a single region around the centre point,
 * bounded by the *other* crossings plus whichever corners do belong to the
 * centre's region — fanned from the centre, this is `cutCell`'s majority hex,
 * generalized the same way. A region whose corner is not adjacent to any
 * other corner of its own colour can still appear more than once (e.g.
 * corners tagged A, B, A, C): each occurrence becomes its own wedge, which is
 * correct on its own — nothing about being the same class requires two
 * disconnected patches to share a triangle.
 */
export interface RegionCellCutInput {
    /** Region id for c0..c3, same corner order as {@link CellCutInput}. */
    corners: readonly [number, number, number, number];
    /** Crossing parameter on edge i, or undefined iff corners[i] === corners[(i+1)%4]. */
    edgeCrossings: readonly (number | undefined)[];
    /**
     * Region id at the cell centre (0.5, 0.5). Only load-bearing for a
     * genuinely ambiguous cell — one whose centre region does not already
     * follow from the corners alone (the direct generalization of `cutCell`'s
     * saddle case). Defaults to c0's region otherwise, same as `cutCell`.
     */
    centreRegion?: number;
    /**
     * Whether edge i's crossing (if any) is a genuine land/water transition
     * rather than two regions on the same side of it (a landuse edge, say).
     * Defaults to every edge being one. See {@link CellCutInput.shoreEdges}.
     */
    shoreEdges?: readonly boolean[];
}

export interface RegionCellCutResult {
    /** Cell-local triangles per region id, ccw in (x, y-down). */
    byRegion: Map<number, Vec2[][]>;
}

/** Fan a boundary ring from an external apex point, both directions handled. */
function fanFromCentre(centre: Vec2, ring: Vec2[], out: Vec2[][]): void {
    if (ring.length < 3) {
        return;
    }
    const ccw = signedArea(ring) >= 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        const tri = ccw ? [centre, a, b] : [centre, b, a];
        if (Math.abs(signedArea(tri)) > MIN_AREA) {
            out.push(tri);
        }
    }
}

export function cutCellRegions(input: RegionCellCutInput): RegionCellCutResult {
    const { corners } = input;
    const byRegion = new Map<number, Vec2[][]>();
    const add = (id: number, tris: Vec2[][]): void => {
        if (tris.length === 0) {
            return;
        }
        const existing = byRegion.get(id);
        if (existing) {
            existing.push(...tris);
        } else {
            byRegion.set(id, tris);
        }
    };

    if (new Set(corners).size === 1) {
        const tris: Vec2[][] = [];
        fan([CORNERS[0], CORNERS[1], CORNERS[2], CORNERS[3]], tris);
        add(corners[0], tris);
        return { byRegion };
    }

    // Snap crossings onto corners exactly as cutCell does, so a would-be
    // sliver collapses to zero area instead of surviving as a degenerate tri.
    const cross: (Vec2 | undefined)[] = [];
    for (let e = 0; e < 4; e++) {
        if (corners[e] === corners[(e + 1) % 4]) {
            cross.push(undefined);
            continue;
        }
        let t = input.edgeCrossings[e];
        if (t === undefined || !Number.isFinite(t)) {
            t = 0.5;
        }
        t = t < SNAP_EPS ? 0 : t > 1 - SNAP_EPS ? 1 : t;
        cross.push(lerpOnEdge(e, t, input.shoreEdges ? input.shoreEdges[e] : true));
    }

    const centreRegion = input.centreRegion !== undefined && corners.includes(input.centreRegion)
        ? input.centreRegion
        : corners[0];

    // The centre region claims every crossing — each one is a shared boundary
    // point between two runs, whichever of which may be the centre's own —
    // plus any corner that belongs to it.
    const reduced: Vec2[] = [];
    for (let c = 0; c < 4; c++) {
        if (corners[c] === centreRegion) {
            reduced.push(CORNERS[c]);
        }
        const x = cross[c];
        if (x) {
            reduced.push(x);
        }
    }
    const centreTris: Vec2[][] = [];
    fanFromCentre({ x: 0.5, y: 0.5 }, dedupe(reduced), centreTris);
    add(centreRegion, centreTris);

    // Every other run - a maximal sequence of consecutive corners sharing one
    // id, none of them the centre region - is bounded by the crossings just
    // before and after it, with no centre point of its own.
    for (let s = 0; s < 4; s++) {
        if (corners[s] === corners[(s + 3) % 4]) {
            continue; // not a run start
        }
        const runId = corners[s];
        if (runId === centreRegion) {
            continue;
        }
        const poly: Vec2[] = [];
        const before = cross[(s + 3) % 4];
        if (before) {
            poly.push(before);
        }
        let c = s;
        for (let k = 0; k < 4; k++) {
            poly.push(CORNERS[c]);
            const next = (c + 1) % 4;
            if (corners[next] !== runId) {
                const after = cross[c];
                if (after) {
                    poly.push(after);
                }
                break;
            }
            c = next;
        }
        const tris: Vec2[][] = [];
        fan(dedupe(poly), tris);
        add(runId, tris);
    }

    return { byRegion };
}
