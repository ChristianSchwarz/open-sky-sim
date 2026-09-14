/**
 * Coplanar vertex collapse over a decimated tile.
 *
 * `decimate` merges what fits a quadtree block; what it cannot merge is the
 * structure the quadtree imposes - the ladder of half-size leaves a single
 * steep feature forces across flat ground, and the midpoints that ladder
 * leaves behind. Measured on real tiles at the budget, 7-12% of interior
 * triangles sit in neighbourhoods where every facet agrees to within a
 * degree or two. This pass removes the vertices those facets share.
 *
 * A vertex goes when
 *
 *   1. it is interior: not on the tile border, not a shore vertex, and every
 *      triangle round it carries one region id (and one cover class, when a
 *      raster is given) - the boundaries the decimator refused to merge
 *      across are refused here the same way;
 *   2. the normals of its triangles agree within `maxAngleDeg`; and
 *   3. after collapsing it into a neighbour, every grid node under the new
 *      triangles still lies within `maxErrorM` of the DEM (and within
 *      `padErrorM` of the padded surface, when there is one).
 *
 * Condition 3 is what keeps the angle from lying. A large smooth hill has
 * half-degree steps between facets and metres of sagitta across them, and
 * dropping its crown shows in the silhouette; the height test is the same
 * bound `decimate` works to, so the tile's geometric error survives the
 * pass. The angle only says which vertices are worth trying.
 *
 * Everything is in grid coordinates, like `decimate`. Heights are metres and
 * `cellM` scales x and y to metres for the normals.
 */

import { GridTriangle } from './decimate';
import { MIN_AREA, Vec2 } from './marchingSquares';

export interface CollapseInput {
    triangles: GridTriangle[];
    /** Node count per side; the tile border is at 0 and `size - 1`. */
    size: number;
    /** Row-major heights, `size * size` - the surface the mesh is drawn at. */
    heights: Float32Array;
    /** Metres per grid cell, for the facet normals. */
    cellM: number;
    /** Vertical tolerance (m) the collapsed surface must keep. */
    maxErrorM: number;
    /** Largest normal deviation (deg) inside a vertex's ring worth trying. */
    maxAngleDeg: number;
    /** See DecimateInput.padHeights / padErrorM. */
    padHeights?: Float32Array;
    padErrorM?: number;
    /** See DecimateInput.coverClasses. */
    coverClasses?: Uint8Array;
    /**
     * Which triangles are land. Water rings are judged by `waterClassOf`
     * instead of the cover raster, and get `waterPasses` extra passes.
     */
    isLandTriangle?: (t: GridTriangle) => boolean;
    /**
     * Class of a water triangle - its tone, in practice, or -1 for a shape no
     * collapse may produce. A water vertex only goes when every triangle the
     * collapse leaves keeps the class it had, so the band a tone paints keeps
     * its outline while the sheet on either side merges. Water is drawn as a flat
     * sheet, so the cover raster under it - bathymetry, speckle, and the land
     * nodes a shore-side triangle's footprint reaches - says nothing about
     * whether two water facets may merge; measured on Madeira it kept three
     * quarters of the sheet at cell resolution along every coast.
     */
    waterClassOf?: (t: GridTriangle) => number;
    /**
     * Whether a water triangle is drawn as a level sheet - the sea, or a lake
     * at one measured height. Such a facet is judged flat and skips the
     * height test: `heights` is bilinear across the cell, so a shore crossing
     * between a wet node and a dry one reads a blend of the two, and every
     * facet the cutter left beside the coast came out tilted by that blend
     * and refused. A body that follows the DEM answers false and is judged
     * like ground.
     */
    isFlatWater?: (t: GridTriangle) => boolean;
    /**
     * Further passes over all-water rings after the first, until one removes
     * nothing. A flat sheet has no error to spend, so every pass is free; the
     * first stops early only because a ring grown by a neighbour's collapse is
     * not revisited. Default 0.
     */
    waterPasses?: number;
}

export interface CollapseResult {
    triangles: GridTriangle[];
    /** Vertices removed. */
    collapsed: number;
}

interface Vertex {
    p: Vec2;
    /** Indices into `tris`, live triangles only after a collapse. */
    tris: number[];
}

/** Bilinear DEM height at a grid point, clamped to the tile. */
function heightAt(field: Float32Array, size: number, x: number, y: number): number {
    const x0 = Math.min(size - 2, Math.max(0, Math.floor(x)));
    const y0 = Math.min(size - 2, Math.max(0, Math.floor(y)));
    const fx = x - x0;
    const fy = y - y0;
    const at = (xx: number, yy: number) => field[yy * size + xx];
    return at(x0, y0) * (1 - fx) * (1 - fy)
        + at(x0 + 1, y0) * fx * (1 - fy)
        + at(x0, y0 + 1) * (1 - fx) * fy
        + at(x0 + 1, y0 + 1) * fx * fy;
}

function signedArea(a: Vec2, b: Vec2, c: Vec2): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function collapse(input: CollapseInput): CollapseResult {
    const { size, heights, cellM, maxErrorM, coverClasses, isLandTriangle, waterClassOf } = input;
    const isWater = (t: GridTriangle): boolean =>
        isLandTriangle !== undefined && waterClassOf !== undefined && !isLandTriangle(t);
    const cells = size - 1;
    const cosMax = Math.cos(input.maxAngleDeg * Math.PI / 180);
    const padHeights = input.padHeights;
    const padErrorM = input.padErrorM ?? maxErrorM;

    // --- weld ---------------------------------------------------------------
    const tris: Array<GridTriangle | undefined> = input.triangles.slice();
    const verts: Vertex[] = [];
    const byKey = new Map<string, number>();
    const triVerts: number[][] = [];
    // A shore vertex is one *any* triangle tags: the cutter drops the tag
    // when a crossing lands on a cell corner, and the corner's other copies
    // come from uniform leaves that never had one.
    const shore: boolean[] = [];
    for (let ti = 0; ti < tris.length; ti++) {
        const t = tris[ti]!;
        const ids: number[] = [];
        for (const p of t.pts) {
            const key = `${p.x},${p.y}`;
            let vi = byKey.get(key);
            if (vi === undefined) {
                vi = verts.length;
                byKey.set(key, vi);
                verts.push({ p, tris: [] });
                shore.push(false);
            }
            if (p.shore) {
                shore[vi] = true;
            }
            verts[vi].tris.push(ti);
            ids.push(vi);
        }
        triVerts.push(ids);
    }

    // --- per-facet plane, in metres --------------------------------------
    const flat = (t: GridTriangle): boolean => isWater(t) && input.isFlatWater !== undefined && input.isFlatWater(t);
    const normalOf = (t: GridTriangle, out: number[]): void => {
        if (flat(t)) {
            out[0] = 0; out[1] = 0; out[2] = 1;
            return;
        }
        const [a, b, c] = t.pts;
        const ah = heightAt(heights, size, a.x, a.y);
        const bh = heightAt(heights, size, b.x, b.y);
        const ch = heightAt(heights, size, c.x, c.y);
        const ux = (b.x - a.x) * cellM, uy = (b.y - a.y) * cellM, uz = bh - ah;
        const vx = (c.x - a.x) * cellM, vy = (c.y - a.y) * cellM, vz = ch - ah;
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        if (nz < 0) {
            nx = -nx; ny = -ny; nz = -nz;
        }
        out[0] = nx; out[1] = ny; out[2] = nz;
    };

    const onBorder = (p: Vec2): boolean =>
        p.x === 0 || p.y === 0 || p.x === cells || p.y === cells;

    /** Class of the cover raster under a triangle's nodes, or -1 if mixed. */
    const coverOf = (t: GridTriangle): number => {
        if (!coverClasses) {
            return 0;
        }
        const xs = t.pts.map(p => p.x), ys = t.pts.map(p => p.y);
        const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs));
        const y0 = Math.floor(Math.min(...ys)), y1 = Math.ceil(Math.max(...ys));
        const first = coverClasses[y0 * size + x0];
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (coverClasses[y * size + x] !== first) {
                    return -1;
                }
            }
        }
        return first;
    };

    /** Height of the plane through a triangle's (grid, DEM) corners at a node. */
    const planeHeight = (t: GridTriangle, x: number, y: number): number | undefined => {
        const [a, b, c] = t.pts;
        const area = signedArea(a, b, c);
        if (Math.abs(area) < MIN_AREA) {
            return undefined;
        }
        const wa = signedArea({ x, y }, b, c) / area;
        const wb = signedArea(a, { x, y }, c) / area;
        const wc = 1 - wa - wb;
        const eps = -1e-9;
        if (wa < eps || wb < eps || wc < eps) {
            return undefined;
        }
        return wa * heightAt(heights, size, a.x, a.y)
            + wb * heightAt(heights, size, b.x, b.y)
            + wc * heightAt(heights, size, c.x, c.y);
    };

    /** Same plane, on the padded field. */
    const padPlaneHeight = (t: GridTriangle, x: number, y: number): number | undefined => {
        const [a, b, c] = t.pts;
        const area = signedArea(a, b, c);
        const wa = signedArea({ x, y }, b, c) / area;
        const wb = signedArea(a, { x, y }, c) / area;
        const wc = 1 - wa - wb;
        return wa * heightAt(padHeights!, size, a.x, a.y)
            + wb * heightAt(padHeights!, size, b.x, b.y)
            + wc * heightAt(padHeights!, size, c.x, c.y);
    };

    // --- candidates, flattest ring first ----------------------------------
    const n: number[] = [0, 0, 0];
    const mean: number[] = [0, 0, 0];
    const ringDeviation = (vi: number, waterOnly: boolean): number | undefined => {
        const v = verts[vi];
        if (v.tris.length === 0 || onBorder(v.p) || shore[vi]) {
            return undefined;
        }
        const first = tris[v.tris[0]]!;
        if (waterOnly && !isWater(first)) {
            return undefined;
        }
        const region = first.regionId;
        const water = isWater(first);
        const cover = water ? 0 : coverOf(first);
        if (cover === -1) {
            return undefined;
        }
        mean[0] = 0; mean[1] = 0; mean[2] = 0;
        for (const ti of v.tris) {
            const t = tris[ti]!;
            // The shoreline chords are between shore vertices, and those are
            // locked above; a cut triangle's other corners are ordinary
            // ground and may go, which is what lets the ladder of one- and
            // two-cell leaves beside the coast merge away.
            // A water ring may mix tones: the tone is per facet and the
            // collapse below keeps each facet's own, so the band's outline
            // slides along itself but never across a facet.
            if (t.regionId !== region || (!water && coverOf(t) !== cover)) {
                return undefined;
            }
            normalOf(t, n);
            mean[0] += n[0]; mean[1] += n[1]; mean[2] += n[2];
        }
        const len = Math.hypot(mean[0], mean[1], mean[2]) || 1;
        mean[0] /= len; mean[1] /= len; mean[2] /= len;
        let worst = 1;
        for (const ti of v.tris) {
            normalOf(tris[ti]!, n);
            const d = n[0] * mean[0] + n[1] * mean[1] + n[2] * mean[2];
            if (d < worst) {
                worst = d;
            }
        }
        return worst >= cosMax ? worst : undefined;
    };

    // --- collapse -----------------------------------------------------------
    let collapsed = 0;
    const pass = (waterOnly: boolean): number => {
        const order: Array<{ vi: number; d: number }> = [];
        for (let vi = 0; vi < verts.length; vi++) {
            const d = ringDeviation(vi, waterOnly);
            if (d !== undefined) {
                order.push({ vi, d });
            }
        }
        order.sort((a, b) => b.d - a.d);

        let removed = 0;
        for (const { vi } of order) {
            const v = verts[vi];
            // The ring may have changed under a neighbour's collapse; re-check.
            if (v.tris.length === 0 || ringDeviation(vi, waterOnly) === undefined) {
                continue;
            }
            const water = isWater(tris[v.tris[0]]!);
            const neighbours = new Set<number>();
            for (const ti of v.tris) {
                for (const u of triVerts[ti]) {
                    if (u !== vi) {
                        neighbours.add(u);
                    }
                }
            }
            for (const ui of neighbours) {
                const u = verts[ui];
                // Landing on a shore vertex would give some ring triangle an edge
                // with a shore vertex at both ends that is not a shoreline chord,
                // and downstream a wall hangs from every such edge.
                if (shore[ui]) {
                    continue;
                }
                // Triangles v and u share vanish; the rest have v moved onto u.
                const kept: Array<{ ti: number; tri: GridTriangle; ids: number[] }> = [];
                let ok = true;
                for (const ti of v.tris) {
                    const ids = triVerts[ti];
                    if (ids.includes(ui)) {
                        continue;
                    }
                    const old = tris[ti]!;
                    // Points are per-triangle objects; the weld was by coordinate.
                    const pts = old.pts.map(p => (p.x === v.p.x && p.y === v.p.y ? u.p : p)) as [Vec2, Vec2, Vec2];
                    const before = signedArea(old.pts[0], old.pts[1], old.pts[2]);
                    const after = signedArea(pts[0], pts[1], pts[2]);
                    if (Math.abs(after) < MIN_AREA || Math.sign(after) !== Math.sign(before)) {
                        ok = false;
                        break;
                    }
                    const tri: GridTriangle = { pts, regionId: old.regionId, cut: old.cut };
                    // A water facet that grew across the band's outline would
                    // paint the far tone up to the shore.
                    const cls = water ? waterClassOf!(tri) : 0;
                    if (water && (cls === -1 || cls !== waterClassOf!(old))) {
                        ok = false;
                        break;
                    }
                    kept.push({ ti, tri, ids: ids.map(id => (id === vi ? ui : id)) });
                }
                if (!ok) {
                    continue;
                }
                // Every node under the ring must stay within tolerance of the
                // DEM under whichever new triangle now covers it.
                let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
                for (const ti of v.tris) {
                    for (const p of tris[ti]!.pts) {
                        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
                        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
                    }
                }
                for (let y = Math.ceil(y0); y <= Math.floor(y1) && ok; y++) {
                    for (let x = Math.ceil(x0); x <= Math.floor(x1); x++) {
                        for (const k of kept) {
                            const h = planeHeight(k.tri, x, y);
                            if (h === undefined) {
                                continue;
                            }
                            if (flat(k.tri)) {
                                break;
                            }
                            if (Math.abs(h - heights[y * size + x]) > maxErrorM
                                || (padHeights !== undefined
                                    && Math.abs(padPlaneHeight(k.tri, x, y) - padHeights[y * size + x]) > padErrorM)) {
                                ok = false;
                            }
                            break;
                        }
                        if (!ok) {
                            break;
                        }
                    }
                }
                if (!ok) {
                    continue;
                }
                // Commit.
                for (const ti of v.tris) {
                    if (triVerts[ti].includes(ui)) {
                        tris[ti] = undefined;
                        for (const w of triVerts[ti]) {
                            if (w !== vi) {
                                const list = verts[w].tris;
                                list.splice(list.indexOf(ti), 1);
                            }
                        }
                    }
                }
                for (const k of kept) {
                    tris[k.ti] = k.tri;
                    triVerts[k.ti] = k.ids;
                    u.tris.push(k.ti);
                }
                v.tris = [];
                removed++;
                break;
            }
        }
        collapsed += removed;
        return removed;
    };

    pass(false);
    for (let i = 0; i < (input.waterPasses ?? 0); i++) {
        if (pass(true) === 0) {
            break;
        }
    }

    return {
        triangles: tris.filter((t): t is GridTriangle => t !== undefined),
        collapsed,
    };
}
