/**
 * Exact vector fill for OSM landuse polygons, laid over finished land facets.
 *
 * The polygons used to be cut into the terrain mesh itself, at grid
 * resolution. That cannot put an edge where OSM has it: the cut only sees the
 * node grid, and the triangle budget then coarsens it to two or four cells, so
 * a polygon's filled area came out tens of metres off its own outline - up to
 * 16% of a polygon's area on the wrong side, measured on Gran Canaria z10-z12.
 *
 * So the mesh is left alone and each polygon is triangulated and clipped
 * against the land facets it overlaps. Both are triangles, so a convex clip is
 * enough, and every piece lies inside exactly one facet: the caller can place
 * it on that facet's plane and it follows the drawn surface exactly.
 *
 * Grid coordinates throughout: x east, y south, 0..cells.
 */

import { ShapeUtils, Vector2 } from 'three';

export interface GridPoint {
    x: number;
    y: number;
}

export type GridTri = readonly [GridPoint, GridPoint, GridPoint];

export interface FillRegion {
    exterior: GridPoint[];
    holes: GridPoint[][];
}

export interface FillPiece {
    /** Index into the `facets` passed in; the piece lies inside this facet. */
    facet: number;
    /** Index into the `regions` passed in. */
    region: number;
    pts: [GridPoint, GridPoint, GridPoint];
}

/** Below this, in square cells, a clipped sliver is dropped. */
const MIN_PIECE_AREA = 1e-7;

function signedArea(pts: readonly GridPoint[]): number {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    return a / 2;
}

/** Where segment p-q crosses the infinite line through a-b. */
function intersect(p: GridPoint, q: GridPoint, a: GridPoint, b: GridPoint): GridPoint {
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const denom = ex * dy - ey * dx;
    if (Math.abs(denom) < 1e-15) {
        return { x: p.x, y: p.y };
    }
    const t = -(ex * (p.y - a.y) - ey * (p.x - a.x)) / denom;
    return { x: p.x + dx * t, y: p.y + dy * t };
}

/** Sutherland-Hodgman: `subject` clipped to the convex triangle `clip`. */
export function clipToTriangle(subject: readonly GridPoint[], clip: GridTri): GridPoint[] {
    const sign = signedArea(clip) >= 0 ? 1 : -1;
    let out: GridPoint[] = [...subject];
    for (let e = 0; e < 3 && out.length > 0; e++) {
        const a = clip[e];
        const b = clip[(e + 1) % 3];
        const inside = (p: GridPoint) =>
            sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) >= -1e-12;
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i];
            const prev = input[(i + input.length - 1) % input.length];
            const curIn = inside(cur);
            const prevIn = inside(prev);
            if (curIn) {
                if (!prevIn) {
                    out.push(intersect(prev, cur, a, b));
                }
                out.push(cur);
            } else if (prevIn) {
                out.push(intersect(prev, cur, a, b));
            }
        }
    }
    return out;
}

/**
 * Triangulates every region and clips it to the facets it overlaps.
 *
 * `facets` should be land facets only: a piece is always placed on the facet
 * it came from, so handing in water would lay landuse over the sea.
 */
export function landuseFill(
    facets: readonly GridTri[],
    regions: readonly FillRegion[],
    cells: number,
): FillPiece[] {
    // Facets bucketed by grid cell, so each region triangle only tests the
    // handful of facets under it rather than all several thousand.
    const buckets = new Map<number, number[]>();
    const cellOf = (v: number) => Math.min(cells - 1, Math.max(0, Math.floor(v)));
    for (let f = 0; f < facets.length; f++) {
        const [a, b, c] = facets[f];
        const x0 = cellOf(Math.min(a.x, b.x, c.x));
        const x1 = cellOf(Math.max(a.x, b.x, c.x));
        const y0 = cellOf(Math.min(a.y, b.y, c.y));
        const y1 = cellOf(Math.max(a.y, b.y, c.y));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const key = y * cells + x;
                const list = buckets.get(key);
                if (list) {
                    list.push(f);
                } else {
                    buckets.set(key, [f]);
                }
            }
        }
    }

    const pieces: FillPiece[] = [];
    // Last region triangle that tested each facet, so a facet spanning many
    // cells is clipped once per triangle rather than once per shared cell.
    const stamp = new Int32Array(facets.length).fill(-1);
    let triSerial = 0;

    for (let r = 0; r < regions.length; r++) {
        // triangulateShape drops a repeated closing point from the arrays it is
        // given, so the vertex list is read back from those same arrays after.
        const contour = regions[r].exterior.map(p => new Vector2(p.x, p.y));
        const holes = regions[r].holes.map(h => h.map(p => new Vector2(p.x, p.y)));
        if (contour.length < 3) {
            continue;
        }
        let faces: number[][];
        try {
            faces = ShapeUtils.triangulateShape(contour, holes);
        } catch {
            continue;
        }
        const verts: GridPoint[] = [...contour, ...holes.flat()].map(v => ({ x: v.x, y: v.y }));

        for (const face of faces) {
            const tri = [verts[face[0]], verts[face[1]], verts[face[2]]] as const;
            if (tri.some(p => p === undefined) || Math.abs(signedArea(tri)) < MIN_PIECE_AREA) {
                continue;
            }
            const serial = triSerial++;
            const minX = Math.min(tri[0].x, tri[1].x, tri[2].x);
            const maxX = Math.max(tri[0].x, tri[1].x, tri[2].x);
            const minY = Math.min(tri[0].y, tri[1].y, tri[2].y);
            const maxY = Math.max(tri[0].y, tri[1].y, tri[2].y);
            for (let y = cellOf(minY); y <= cellOf(maxY); y++) {
                for (let x = cellOf(minX); x <= cellOf(maxX); x++) {
                    const list = buckets.get(y * cells + x);
                    if (!list) {
                        continue;
                    }
                    for (const f of list) {
                        if (stamp[f] === serial) {
                            continue;
                        }
                        stamp[f] = serial;
                        const facet = facets[f];
                        if (Math.max(facet[0].x, facet[1].x, facet[2].x) < minX
                            || Math.min(facet[0].x, facet[1].x, facet[2].x) > maxX
                            || Math.max(facet[0].y, facet[1].y, facet[2].y) < minY
                            || Math.min(facet[0].y, facet[1].y, facet[2].y) > maxY) {
                            continue;
                        }
                        const poly = clipToTriangle(tri, facet);
                        if (poly.length < 3 || Math.abs(signedArea(poly)) < MIN_PIECE_AREA) {
                            continue;
                        }
                        for (let i = 1; i + 1 < poly.length; i++) {
                            const pts: [GridPoint, GridPoint, GridPoint] = [poly[0], poly[i], poly[i + 1]];
                            if (Math.abs(signedArea(pts)) >= MIN_PIECE_AREA) {
                                pieces.push({ facet: f, region: r, pts });
                            }
                        }
                    }
                }
            }
        }
    }
    return mergePieces(pieces, facets);
}

/**
 * Snap tolerance for matching piece edges, in cells. Two region triangles
 * sharing a diagonal clip it against the same facet edge from opposite
 * ends, and the two intersections differ in the last bits.
 */
const MERGE_SNAP = 1e-7;

/** Below this, a loop vertex is collinear with its neighbours and dropped. */
const COLLINEAR_EPS = 1e-9;

/**
 * Merges the fragments one region left on one facet back into a single
 * outline, re-triangulated.
 *
 * Clipping the region's *triangles* to the facet leaves a facet lying wholly
 * inside a forest cut into as many pieces as triangulation diagonals cross
 * it, and a facet on the forest's edge into a fan of slivers per diagonal.
 * Measured on Madeira z12: 22.6k pieces per tile over 5.1k facets, of which
 * 1.8k facets were fully covered and cost 7.9k pieces, and 1.8k partly
 * covered cost 14.7k. The union of the fragments is the region clipped to
 * the facet, which is what was wanted all along: one triangle for a covered
 * facet, and n - 2 for an outline of n corners.
 *
 * The union is found by cancelling shared edges. Any group whose boundary
 * does not close into exactly one loop - a region touching the facet in two
 * places, or a hole inside it - keeps its fragments as they were.
 */
export function mergePieces(pieces: FillPiece[], facets: readonly GridTri[]): FillPiece[] {
    const groups = new Map<number, FillPiece[]>();
    for (const piece of pieces) {
        const key = piece.facet * 65536 + piece.region;
        const list = groups.get(key);
        if (list) {
            list.push(piece);
        } else {
            groups.set(key, [piece]);
        }
    }
    const out: FillPiece[] = [];
    for (const group of groups.values()) {
        const merged = group.length > 1 ? mergeGroup(group, facets[group[0].facet]) : undefined;
        for (const piece of merged ?? group) {
            out.push(piece);
        }
    }
    return out;
}

function mergeGroup(group: FillPiece[], facet: GridTri): FillPiece[] | undefined {
    // Snap every corner to a shared vertex id.
    const verts: GridPoint[] = [];
    const idOf = (p: GridPoint): number => {
        for (let i = 0; i < verts.length; i++) {
            if (Math.abs(verts[i].x - p.x) <= MERGE_SNAP && Math.abs(verts[i].y - p.y) <= MERGE_SNAP) {
                return i;
            }
        }
        verts.push(p);
        return verts.length - 1;
    };
    // Directed edges, with every fragment wound the facet's way first.
    const sign = signedArea(facet) >= 0 ? 1 : -1;
    const EDGE_BASE = 1048576;
    const count = new Map<number, number>();
    let area = 0;
    for (const piece of group) {
        const a = signedArea(piece.pts);
        area += Math.abs(a);
        const pts = a * sign >= 0 ? piece.pts : [piece.pts[0], piece.pts[2], piece.pts[1]];
        const ids = pts.map(idOf);
        for (let e = 0; e < 3; e++) {
            const u = ids[e];
            const v = ids[(e + 1) % 3];
            if (u === v) {
                continue;
            }
            const k = u * EDGE_BASE + v;
            count.set(k, (count.get(k) ?? 0) + 1);
        }
    }
    // A boundary edge has no twin. An edge seen twice in the same direction
    // means overlapping fragments, which no union describes.
    const next = new Map<number, number>();
    let boundary = 0;
    for (const [k, n] of count) {
        if (n !== 1) {
            return undefined;
        }
        const u = Math.floor(k / EDGE_BASE);
        const v = k % EDGE_BASE;
        if (count.has(v * EDGE_BASE + u)) {
            continue;
        }
        if (next.has(u)) {
            return undefined;
        }
        next.set(u, v);
        boundary++;
    }
    if (boundary < 3) {
        return undefined;
    }
    // Walk what must be a single loop.
    const start = next.keys().next().value as number;
    const loop: number[] = [];
    let cur = start;
    do {
        loop.push(cur);
        const n = next.get(cur);
        if (n === undefined) {
            return undefined;
        }
        cur = n;
    } while (cur !== start && loop.length <= boundary);
    if (cur !== start || loop.length !== boundary) {
        return undefined;
    }
    // Drop collinear corners: a facet edge crossed by many diagonals carries
    // a vertex per crossing, and each would cost a triangle.
    const ring: GridPoint[] = [];
    for (let i = 0; i < loop.length; i++) {
        const p = verts[loop[(i + loop.length - 1) % loop.length]];
        const q = verts[loop[i]];
        const r = verts[loop[(i + 1) % loop.length]];
        const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
        if (Math.abs(cross) > COLLINEAR_EPS) {
            ring.push(q);
        }
    }
    if (ring.length < 3) {
        return undefined;
    }
    let faces: number[][];
    if (ring.length === 3) {
        faces = [[0, 1, 2]];
    } else {
        try {
            faces = ShapeUtils.triangulateShape(ring.map(p => new Vector2(p.x, p.y)), []);
        } catch {
            return undefined;
        }
    }
    const merged: FillPiece[] = [];
    let mergedArea = 0;
    for (const f of faces) {
        const pts: [GridPoint, GridPoint, GridPoint] = [ring[f[0]], ring[f[1]], ring[f[2]]];
        const a = Math.abs(signedArea(pts));
        if (a >= MIN_PIECE_AREA) {
            merged.push({ facet: group[0].facet, region: group[0].region, pts });
            mergedArea += a;
        }
    }
    // The union must cover exactly what the fragments did, and be cheaper.
    if (Math.abs(mergedArea - area) > 1e-6 * Math.max(1, area) || merged.length >= group.length) {
        return undefined;
    }
    return merged;
}
