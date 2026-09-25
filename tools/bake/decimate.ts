/**
 * Restricted-quadtree decimation of a tile's height grid.
 *
 * A tile arrives as `size x size` height nodes (so `size - 1` cells per side).
 * We build a quadtree over the cells and merge a block into a single leaf while
 * four conditions hold:
 *
 *   1. the block's heights stay within `maxErrorM` of the bilinear surface
 *      through its four corners,
 *   2. the block does not straddle a region boundary - the shoreline, a real
 *      landuse edge, or both at once, wherever they cross the same cell,
 *   3. the same holds of the *padded* heights, against a tolerance the
 *      triangle budget is not allowed to relax - see `padHeights`, and
 *   4. the block does not straddle a landcover-class boundary, when one is
 *      given - see `coverClasses`.
 *
 * Condition 2 is what keeps every boundary crisp: any block containing a
 * region transition is refused, so a boundary block always bottoms out at
 * `minLeafSize` and gets handed to the marching-squares cutter at that scale
 * - `cutCell` for the ordinary two-region case, `cutCellRegions` wherever
 * three or four regions meet in one cell (a landuse edge crossing the coast,
 * for instance). Condition 4 is a coarser-grained backstop for a boundary
 * that exists only in the raster `.plc` cover and was never resolved into
 * real region geometry: refusing the merge is enough there; nothing needs to
 * know *where* through the block that boundary runs, since it never feeds
 * `Leaf.uniform` and is never handed to either cutter.
 *
 * The tree is then *balanced* so neighbouring leaves differ by at most one
 * level. That bounds T-junctions to a single midpoint per edge, which the
 * triangulation absorbs by fanning the leaf from its centre through a ring that
 * includes the midpoint wherever the neighbour is finer. Nothing is finer than
 * `minLeafSize`, so a boundary leaf never needs a midpoint of its own and the
 * cutter's output can be used verbatim.
 *
 * Everything here works in grid coordinates: x east, y south, matching the
 * row-major DEM layout with v=0 at the north edge.
 */

import { MIN_AREA, SNAP_EPS, Vec2, cutCell, cutCellRegions } from './marchingSquares';

export interface DecimateInput {
    /** Node count per side; cells per side is `size - 1`. */
    size: number;
    /** Row-major heights, `size * size`. */
    heights: Float32Array;
    /**
     * Row-major region index per *node*, `size * size`. A region is the
     * finest thing this file distinguishes geometrically: land vs water on a
     * tile with no landuse data, or one of several combined land/landuse
     * pieces on a tile that has it. Two different ids always means two
     * different regions; nothing here needs to know what they mean.
     */
    regionNodes: Uint16Array;
    /** Vertical tolerance (m) for merging a block. */
    maxErrorM: number;
    /**
     * Tighter tolerance (m) for a block touching the tile border. The triangle
     * budget can push `maxErrorM` to the relief of the whole tile, and a
     * border decimated that far is a chord hundreds of metres off the ground
     * that the neighbour, cut on its own terms, still follows. The skirt seals
     * a seam only up to its own depth, so the border must stay within a
     * fraction of it whatever the interior costs. Omit for no extra limit.
     */
    borderErrorM?: number;
    /**
     * Row-major TerrainClass per *node*, `size * size` — the same `.plc`
     * cover raster `classify()` samples later, one node per DEM node, no
     * finer. Omit for a tile with no cover data (or none baked yet): every
     * block is then free to merge purely on height/region terms, exactly
     * today's behaviour. Given, a block also refuses to merge while it spans
     * more than one class - see condition 4 above.
     */
    coverClasses?: Uint8Array;
    /**
     * The same heights with the flatten pads applied — the surface the tile
     * will actually be drawn at. Omit where no pad reaches the tile.
     *
     * A third merge condition, and a *hard* one: `maxErrorM` is what the
     * triangle budget negotiates with, and on a busy coastal tile it is raised
     * until the interior merges no matter what is in it. An airfield platform
     * cannot be traded away like that. It is cut into the terrain to carry the
     * pavement, the pavement is draped on a height query that already knows
     * about it, and a leaf that spans its rim leaves the two on different
     * surfaces — at Gran Canaria, a 407 m leaf ran between one corner cut down
     * to the 9 m apron and one left up on 24 m of hillside, and buried aprons
     * lying 150 m inside the flat core under five to six metres of ground.
     *
     * So the pad gets its own tolerance, which nothing relaxes. It costs only
     * the rim: inside the core the padded surface is an exact plane, so a
     * block there merges as freely as it ever did.
     */
    padHeights?: Float32Array;
    /**
     * Restricts the padHeights check to the nodes flagged here. A road corridor
     * cut into the terrain (roadGrade.ts) is protected the same way an airfield
     * pad is, but only along the road: checked tile-wide it would hold the whole
     * tile to the pad's tolerance.
     */
    padMask?: Uint8Array;
    /** Tolerance (m) for {@link padHeights}. Never coarsened by the budget. */
    padErrorM?: number;
    /**
     * Finest leaf, in cells. Raising it coarsens every region boundary as
     * well as the interior, which is the lever the triangle budget turns.
     */
    minLeafSize?: number;
    /** Largest leaf, in cells. Caps how flat a region may be drawn. */
    maxLeafSize?: number;
    /**
     * Crossing parameter along the cell edge from node `a` to node `b`, in
     * [0, 1]. Supplied by the region geometry; defaults to the midpoint.
     */
    edgeCrossing?: (ax: number, ay: number, bx: number, by: number) => number | undefined;
    /**
     * Region id at an arbitrary interior point, in grid coordinates. Only
     * consulted for a genuinely ambiguous cell - the two-region saddle case,
     * or any cell with three or four regions on it - where the corners alone
     * do not settle which region owns the centre. Defaults to the first
     * corner's region otherwise, same as `cutCell`/`cutCellRegions`.
     */
    regionAt?: (x: number, y: number) => number;
    /**
     * Which regions are land, for deciding which cut vertices are a genuine
     * shore - worth a wall down to the water surface downstream - as opposed
     * to a landuse-only edge between two regions on the same side of it, land
     * or water alike. Omit and every cut vertex is treated as a shore, which
     * is exactly correct for a tile with no landuse regions at all: every
     * `regionNodes` transition there really is land meeting water.
     */
    isLandRegion?: (regionId: number) => boolean;
}

export interface GridTriangle {
    /** Grid-space corners; may be fractional where a region boundary cuts a cell. */
    pts: [Vec2, Vec2, Vec2];
    regionId: number;
    /**
     * From a boundary leaf, cut by marching squares. Only such a triangle can
     * have a shoreline chord for an edge, so only such a triangle grows a
     * shore wall downstream. A uniform leaf's diagonal can join two corners
     * that happen to sit at shore positions, and a wall hung from it would
     * lie buried inside the land, costing budget for nothing.
     */
    cut?: boolean;
}

export interface DecimateResult {
    triangles: GridTriangle[];
    /** Leaf count by size, for diagnostics and budget search. */
    leafCount: number;
    shorelineLeafCount: number;
}

/**
 * A boundary block the shoreline crosses exactly once, as a straight chord
 * between two crossings on its boundary. See `simpleChord`.
 */
interface Chord {
    /** The two crossings, each on one boundary edge of the block. */
    a: ChordCrossing;
    b: ChordCrossing;
    /** Whether the chord is a genuine shore (land meets water). */
    shore: boolean;
}

interface ChordCrossing {
    x: number;
    y: number;
    /** Boundary edge, 0 top, 1 right, 2 bottom, 3 left, clockwise. */
    edge: number;
    /** Position along that edge in [0, 1], in the edge's ring direction. */
    t: number;
}

interface Leaf {
    x: number;
    y: number;
    size: number;
    uniform: boolean;
    regionId: number;
    /** Set on a boundary leaf larger than minLeafSize; see Chord. */
    chord?: Chord;
}

/**
 * Largest simple-chord boundary leaf, in cells. The water fan beside the
 * chord is painted one tone from its distance to the shore and the land
 * fan one cover from its footprint, so a chord leaf the size of a tile
 * would paint the whole sea shallow. Four cells is 120 m at z12, about
 * the shallow band (SHALLOW_WATER_COAST_M), and already a sixteenth of
 * the cut cells.
 */
const CHORD_MAX_LEAF_SIZE = 4;

/**
 * Fans a convex ring from a vertex no fan triangle is degenerate at.
 *
 * The ring of a chord polygon runs along the square's edges, so two of its
 * consecutive vertices can be collinear with a third on the same edge: a
 * shore crossing, the midpoint a finer neighbour asks for, and the corner
 * beyond it. Fanned from that crossing, the triangle through the midpoint
 * has no area; skipping it drops the midpoint from this side of the edge
 * while the neighbour keeps it, and the T-junction that leaves is a gap
 * once the collapse pass moves either vertex. A vertex is a safe apex when
 * none of the ring's other consecutive pairs lies on its own edge, and one
 * always exists: a run of vertices on one edge is at most a corner, a
 * midpoint and a crossing, whose middle vertex is safe.
 */
function fanConvexRing(ring: Vec2[]): Array<[Vec2, Vec2, Vec2]> {
    const n = ring.length;
    for (let k = 0; k < n; k++) {
        const apex = ring[k];
        const out: Array<[Vec2, Vec2, Vec2]> = [];
        let ok = true;
        for (let i = 1; i + 1 < n; i++) {
            const a = ring[(k + i) % n], b = ring[(k + i + 1) % n];
            const area = (a.x - apex.x) * (b.y - apex.y) - (a.y - apex.y) * (b.x - apex.x);
            if (Math.abs(area) / 2 < MIN_AREA) {
                ok = false;
                break;
            }
            out.push([apex, a, b]);
        }
        if (ok) {
            return out;
        }
    }
    throw new Error(`decimate: no apex fans the ring ${JSON.stringify(ring)} without a degenerate triangle`);
}

function isPow2(n: number): boolean {
    return n > 0 && (n & (n - 1)) === 0;
}

export function decimate(input: DecimateInput): DecimateResult {
    const { size, heights, regionNodes, coverClasses, maxErrorM } = input;
    const cells = size - 1;
    if (!isPow2(cells)) {
        throw new Error(`decimate: ${size} nodes gives ${cells} cells, which is not a power of two`);
    }
    const minLeafSize = input.minLeafSize ?? 1;
    const maxLeafSize = input.maxLeafSize ?? cells;
    if (!isPow2(minLeafSize) || !isPow2(maxLeafSize)) {
        throw new Error('decimate: minLeafSize and maxLeafSize must be powers of two');
    }

    const regionIdAt = (x: number, y: number) => regionNodes[y * size + x];

    /** True when every node of the block shares one region. */
    const blockUniform = (bx: number, by: number, s: number): boolean => {
        const first = regionIdAt(bx, by);
        for (let y = by; y <= by + s; y++) {
            for (let x = bx; x <= bx + s; x++) {
                if (regionIdAt(x, y) !== first) {
                    return false;
                }
            }
        }
        return true;
    };

    /**
     * True when every node of the block shares one landcover class, or no
     * cover data was given at all.
     *
     * Deliberately separate from `blockUniform` above rather than folded into
     * it: that flag also decides whether a leaf is triangulated as a plain
     * fan or handed to a marching-squares cutter, which knows only region
     * ids, not cover classes. A cover-class difference must never be mistaken
     * for a region boundary - it only ever blocks a merge, here, never
     * anything downstream.
     */
    const coverUniform = (bx: number, by: number, s: number): boolean => {
        if (!coverClasses) {
            return true;
        }
        const first = coverClasses[by * size + bx];
        for (let y = by; y <= by + s; y++) {
            for (let x = bx; x <= bx + s; x++) {
                if (coverClasses[y * size + x] !== first) {
                    return false;
                }
            }
        }
        return true;
    };

    /** Max |height - bilinear(corners)| over the block, for one height field. */
    const blockError = (
        field: Float32Array, bx: number, by: number, s: number, mask?: Uint8Array,
    ): number => {
        const at = (x: number, y: number) => field[y * size + x];
        const h00 = at(bx, by);
        const h10 = at(bx + s, by);
        const h01 = at(bx, by + s);
        const h11 = at(bx + s, by + s);
        let worst = 0;
        for (let y = 0; y <= s; y++) {
            const v = y / s;
            for (let x = 0; x <= s; x++) {
                const u = x / s;
                const bilinear = h00 * (1 - u) * (1 - v)
                    + h10 * u * (1 - v)
                    + h01 * (1 - u) * v
                    + h11 * u * v;
                if (mask !== undefined && mask[(by + y) * size + bx + x] === 0) {
                    continue;
                }
                const d = Math.abs(at(bx + x, by + y) - bilinear);
                if (d > worst) {
                    worst = d;
                }
            }
        }
        return worst;
    };

    const borderErrorM = Math.min(maxErrorM, input.borderErrorM ?? Infinity);
    const touchesBorder = (bx: number, by: number, s: number): boolean =>
        bx === 0 || by === 0 || bx + s === cells || by + s === cells;

    const padHeights = input.padHeights;
    const padErrorM = input.padErrorM ?? maxErrorM;
    const padMask = input.padMask;
    /** The pad's own condition, which the triangle budget may not relax. */
    const padFits = (bx: number, by: number, s: number): boolean =>
        padHeights === undefined || blockError(padHeights, bx, by, s, padMask) <= padErrorM;

    const defaultCrossing = () => undefined;
    const edgeCrossing = input.edgeCrossing ?? defaultCrossing;
    const isLandRegion = input.isLandRegion;

    /**
     * The block's boundary nodes in ring order, clockwise from its top-left
     * corner, as (x, y, edge, t) where t runs along the edge.
     */
    /**
     * The block's boundary nodes at `step` cells, in ring order. The step is
     * the cut leaf's size: a cut leaf beside this block asks the crossing
     * of its whole edge, and the two must ask the same question or they
     * answer with different points on the shared edge.
     */
    const ringNodes = (bx: number, by: number, s: number, step: number): Array<{ x: number; y: number; edge: number; t: number }> => {
        const out: Array<{ x: number; y: number; edge: number; t: number }> = [];
        for (let k = 0; k < s; k += step) out.push({ x: bx + k, y: by, edge: 0, t: k / s });
        for (let k = 0; k < s; k += step) out.push({ x: bx + s, y: by + k, edge: 1, t: k / s });
        for (let k = 0; k < s; k += step) out.push({ x: bx + s - k, y: by + s, edge: 2, t: k / s });
        for (let k = 0; k < s; k += step) out.push({ x: bx, y: by + s - k, edge: 3, t: k / s });
        return out;
    };

    /**
     * Whether a boundary block can be one leaf: two regions, the boundary
     * between them crossing the block's edge exactly twice, every node on
     * the side of the straight chord its region says, and the two fans the
     * chord makes within tolerance of the drawn heights.
     *
     * The chord *is* the shore that gets drawn, so a node on the wrong side
     * of it would be drawn as the wrong ground; that is why the second
     * test is strict. Crossings are solved on the one-cell sub-edge where
     * the region changes, so a finer neighbour on that edge lands on the
     * same point and there is no crack.
     */
    const simpleChord = (bx: number, by: number, s: number): Chord | undefined => {
        if (s > maxLeafSize || s > CHORD_MAX_LEAF_SIZE || !coverUniform(bx, by, s)) {
            return undefined;
        }
        const ring = ringNodes(bx, by, s, 1);
        const changes: ChordCrossing[] = [];
        const idA = regionIdAt(ring[0].x, ring[0].y);
        let idB = -1;
        for (let i = 0; i < ring.length; i++) {
            const n0 = ring[i];
            const n1 = ring[(i + 1) % ring.length];
            const r0 = regionIdAt(n0.x, n0.y);
            const r1 = regionIdAt(n1.x, n1.y);
            if (r0 !== idA) {
                if (idB === -1) idB = r0;
                else if (r0 !== idB) return undefined;
            }
            if (r0 === r1) {
                continue;
            }
            if (changes.length === 2) {
                return undefined;
            }
            // Solved over the minLeafSize-aligned sub-edge holding this
            // node pair, and snapped, exactly as cutCell does for the cut
            // leaf that may sit across it: the two must ask the same
            // question or they answer with different points on the edge.
            const m = minLeafSize;
            const k0 = Math.floor(i % s / m) * m;
            const e0 = ring[i - (i % s) + k0];
            const ex = n0.x + (n1.x - n0.x) * (k0 + m - i % s), ey = n0.y + (n1.y - n0.y) * (k0 + m - i % s);
            let t = edgeCrossing(e0.x, e0.y, ex, ey) ?? 0.5;
            t = t < SNAP_EPS ? 0 : t > 1 - SNAP_EPS ? 1 : t;
            changes.push({
                x: e0.x + (ex - e0.x) * t,
                y: e0.y + (ey - e0.y) * t,
                edge: n0.edge,
                t: e0.t + (t * m) / s,
            });
        }
        if (changes.length !== 2 || idB === -1) {
            return undefined;
        }
        const [a, b] = changes;
        // Both crossings on one edge is a boundary running along that edge,
        // not a chord across the block: the polygon between them has no
        // area, and the finer neighbour beyond the edge cuts round the nodes
        // this side would then skip. A crossing sitting on a corner is a
        // zero-length ring edge. The cutter handles both.
        const cornerEps = 1e-9;
        if (a.edge === b.edge || a.t < cornerEps || a.t > 1 - cornerEps || b.t < cornerEps || b.t > 1 - cornerEps) {
            return undefined;
        }
        // Every node of the block, interior included, on the side of the
        // chord its region says.
        const cx = b.x - a.x, cy = b.y - a.y;
        let signA = 0;
        for (let y = by; y <= by + s; y++) {
            for (let x = bx; x <= bx + s; x++) {
                const id = regionIdAt(x, y);
                if (id !== idA && id !== idB) {
                    return undefined;
                }
                const side = cx * (y - a.y) - cy * (x - a.x);
                if (Math.abs(side) < 1e-9) {
                    continue;
                }
                const want = id === idA ? 1 : -1;
                if (signA === 0) {
                    signA = Math.sign(side) * want;
                } else if (Math.sign(side) * want !== signA) {
                    return undefined;
                }
            }
        }
        const shore = isLandRegion ? isLandRegion(idA) !== isLandRegion(idB) : true;
        const chord: Chord = { a, b, shore };
        // Height test on the fans the chord will make, without midpoints:
        // the drawn surface inside a fan is planar per triangle.
        const polys = chordPolygons(bx, by, s, chord, [false, false, false, false]);
        for (const poly of polys) {
            const region = poly.regionId;
            // A chord shaving a corner by a hair leaves a polygon of no area
            // on that side, which no apex can fan; the cutter draws it.
            let polyArea = 0;
            for (let j = 1; j + 1 < poly.ring.length; j++) {
                const t0 = poly.ring[0], t1 = poly.ring[j], t2 = poly.ring[j + 1];
                polyArea += (t1.x - t0.x) * (t2.y - t0.y) - (t1.y - t0.y) * (t2.x - t0.x);
            }
            if (Math.abs(polyArea) / 2 < MIN_AREA) {
                return undefined;
            }
            for (let j = 1; j + 1 < poly.ring.length; j++) {
                const t0 = poly.ring[0], t1 = poly.ring[j], t2 = poly.ring[j + 1];
                const det = (t1.y - t2.y) * (t0.x - t2.x) + (t2.x - t1.x) * (t0.y - t2.y);
                if (Math.abs(det) < MIN_AREA) {
                    continue;
                }
                const h0 = heightAt(heights, t0), h1 = heightAt(heights, t1), h2 = heightAt(heights, t2);
                const p0 = padHeights && heightAt(padHeights, t0);
                const p1 = padHeights && heightAt(padHeights, t1);
                const p2 = padHeights && heightAt(padHeights, t2);
                const minX = Math.ceil(Math.min(t0.x, t1.x, t2.x)), maxX = Math.floor(Math.max(t0.x, t1.x, t2.x));
                const minY = Math.ceil(Math.min(t0.y, t1.y, t2.y)), maxY = Math.floor(Math.max(t0.y, t1.y, t2.y));
                for (let y = minY; y <= maxY; y++) {
                    for (let x = minX; x <= maxX; x++) {
                        if (regionIdAt(x, y) !== region) {
                            continue;
                        }
                        const l0 = ((t1.y - t2.y) * (x - t2.x) + (t2.x - t1.x) * (y - t2.y)) / det;
                        const l1 = ((t2.y - t0.y) * (x - t2.x) + (t0.x - t2.x) * (y - t2.y)) / det;
                        const l2 = 1 - l0 - l1;
                        if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) {
                            continue;
                        }
                        if (Math.abs(h0 * l0 + h1 * l1 + h2 * l2 - heights[y * size + x]) > maxErrorM) {
                            return undefined;
                        }
                        if (padHeights && (!padMask || padMask[y * size + x] !== 0)
                            && Math.abs(p0! * l0 + p1! * l1 + p2! * l2 - padHeights[y * size + x]) > padErrorM) {
                            return undefined;
                        }
                    }
                }
            }
        }
        return chord;
    };

    /** Bilinear height at a grid point that may be fractional. */
    function heightAt(field: Float32Array, p: { x: number; y: number }): number {
        const x0 = Math.min(size - 2, Math.max(0, Math.floor(p.x)));
        const y0 = Math.min(size - 2, Math.max(0, Math.floor(p.y)));
        const fx = p.x - x0, fy = p.y - y0;
        return field[y0 * size + x0] * (1 - fx) * (1 - fy)
            + field[y0 * size + x0 + 1] * fx * (1 - fy)
            + field[(y0 + 1) * size + x0] * (1 - fx) * fy
            + field[(y0 + 1) * size + x0 + 1] * fx * fy;
    }

    /**
     * The two polygons a chord cuts a block into: the boundary ring -
     * corners, a midpoint on each edge flagged in `needMid`, and the two
     * crossings, in order along each edge - split at the crossings. Each
     * starts at a crossing, so a fan from its first point has the chord as
     * an edge. Both are convex: a straight cut through a square.
     */
    function chordPolygons(
        bx: number, by: number, s: number, chord: Chord, needMid: boolean[],
    ): Array<{ ring: Vec2[]; regionId: number }> {
        const corners: Vec2[] = [
            { x: bx, y: by }, { x: bx + s, y: by }, { x: bx + s, y: by + s }, { x: bx, y: by + s },
        ];
        const ring: Vec2[] = [];
        const crossingAt: number[] = [];
        for (let e = 0; e < 4; e++) {
            ring.push(corners[e]);
            const along: Array<{ t: number; p: Vec2; crossing: boolean }> = [];
            if (needMid[e]) {
                const a = corners[e], b = corners[(e + 1) % 4];
                along.push({ t: 0.5, p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, crossing: false });
            }
            for (const c of [chord.a, chord.b]) {
                if (c.edge === e) {
                    along.push({ t: c.t, p: { x: c.x, y: c.y, shore: chord.shore }, crossing: true });
                }
            }
            along.sort((p, q) => p.t - q.t);
            for (let i = 0; i < along.length; i++) {
                // A crossing exactly on the midpoint is the midpoint.
                if (i > 0 && Math.abs(along[i].t - along[i - 1].t) < 1e-9) {
                    if (along[i].crossing) {
                        ring[ring.length - 1] = along[i].p;
                        crossingAt.push(ring.length - 1);
                    }
                    continue;
                }
                if (along[i].crossing) {
                    crossingAt.push(ring.length);
                }
                ring.push(along[i].p);
            }
        }
        const [i1, i2] = crossingAt;
        const polyA = ring.slice(i1, i2 + 1);
        const polyB = [...ring.slice(i2), ...ring.slice(0, i1 + 1)];
        const regionOf = (poly: Vec2[]): number => {
            for (const p of poly) {
                if (p.shore === undefined && Number.isInteger(p.x) && Number.isInteger(p.y)) {
                    return regionIdAt(p.x, p.y);
                }
            }
            return regionIdAt(bx, by);
        };
        return [
            { ring: polyA, regionId: regionOf(polyA) },
            { ring: polyB, regionId: regionOf(polyB) },
        ];
    }

    // --- 1. Top-down subdivision -------------------------------------------
    const leaves: Leaf[] = [];
    /** Leaves for a block, given that nothing above it merged. */
    const subdivideInto = (out: Leaf[], bx: number, by: number, s: number, mergeUniform: boolean): void => {
        if (s <= minLeafSize) {
            const uniform = blockUniform(bx, by, s);
            out.push({ x: bx, y: by, size: s, uniform, regionId: uniform ? regionIdAt(bx, by) : 0 });
            return;
        }
        const uniform = blockUniform(bx, by, s);
        if (uniform) {
            if (!mergeUniform || (s <= maxLeafSize && blockError(heights, bx, by, s) <= (touchesBorder(bx, by, s) ? borderErrorM : maxErrorM)
                && padFits(bx, by, s) && coverUniform(bx, by, s))) {
                out.push({ x: bx, y: by, size: s, uniform: true, regionId: regionIdAt(bx, by) });
                return;
            }
        } else {
            const chord = simpleChord(bx, by, s);
            if (chord !== undefined) {
                out.push({ x: bx, y: by, size: s, uniform: false, regionId: 0, chord });
                return;
            }
        }
        const half = s / 2;
        subdivideInto(out, bx, by, half, mergeUniform);
        subdivideInto(out, bx + half, by, half, mergeUniform);
        subdivideInto(out, bx, by + half, half, mergeUniform);
        subdivideInto(out, bx + half, by + half, half, mergeUniform);
    };
    subdivideInto(leaves, 0, 0, cells, true);

    // --- 2. Balance so neighbours differ by at most one level ---------------
    // `owner[cell]` is the index of the leaf covering that cell.
    const owner = new Int32Array(cells * cells).fill(-1);
    const paint = (leafIndex: number) => {
        const l = leaves[leafIndex];
        for (let y = l.y; y < l.y + l.size; y++) {
            for (let x = l.x; x < l.x + l.size; x++) {
                owner[y * cells + x] = leafIndex;
            }
        }
    };
    for (let i = 0; i < leaves.length; i++) {
        paint(i);
    }

    const neighbourSizes = (l: Leaf): number[] => {
        const out: number[] = [];
        const probe = (x: number, y: number) => {
            if (x < 0 || y < 0 || x >= cells || y >= cells) {
                return;
            }
            const idx = owner[y * cells + x];
            if (idx >= 0) {
                out.push(leaves[idx].size);
            }
        };
        for (let k = 0; k < l.size; k++) {
            probe(l.x + k, l.y - 1);
            probe(l.x + k, l.y + l.size);
            probe(l.x - 1, l.y + k);
            probe(l.x + l.size, l.y + k);
        }
        return out;
    };

    let changed = true;
    let guard = 0;
    while (changed) {
        changed = false;
        if (++guard > 64) {
            throw new Error('decimate: balance did not converge');
        }
        for (let i = 0; i < leaves.length; i++) {
            const l = leaves[i];
            if (l.size <= minLeafSize) {
                continue;
            }
            const finest = Math.min(...neighbourSizes(l), l.size);
            if (finest >= l.size / 2) {
                continue;
            }
            // Split this leaf into four and re-paint. A uniform child is a
            // leaf whatever its error, as it always was; a boundary child
            // keeps its chord if it still has one, and is cut down to
            // minLeafSize otherwise.
            const half = l.size / 2;
            const kids: Leaf[] = [];
            subdivideInto(kids, l.x, l.y, half, false);
            subdivideInto(kids, l.x + half, l.y, half, false);
            subdivideInto(kids, l.x, l.y + half, half, false);
            subdivideInto(kids, l.x + half, l.y + half, half, false);
            leaves[i] = kids[0];
            paint(i);
            for (let j = 1; j < kids.length; j++) {
                leaves.push(kids[j]);
                paint(leaves.length - 1);
            }
            changed = true;
        }
    }

    // --- 3. Triangulate ----------------------------------------------------
    const triangles: GridTriangle[] = [];
    let shorelineLeafCount = 0;

    const neighbourSizeAt = (x: number, y: number): number => {
        if (x < 0 || y < 0 || x >= cells || y >= cells) {
            return Number.POSITIVE_INFINITY;
        }
        const idx = owner[y * cells + x];
        return idx >= 0 ? leaves[idx].size : Number.POSITIVE_INFINITY;
    };

    for (const l of leaves) {
        if (!l.uniform && l.chord !== undefined) {
            shorelineLeafCount++;
            // A simple-chord leaf: two convex polygons, each fanned from
            // the crossing it starts at, so both carry the chord as an edge.
            const s = l.size;
            const needMid = [
                neighbourSizeAt(l.x, l.y - 1) < s || neighbourSizeAt(l.x + s - 1, l.y - 1) < s,
                neighbourSizeAt(l.x + s, l.y) < s || neighbourSizeAt(l.x + s, l.y + s - 1) < s,
                neighbourSizeAt(l.x, l.y + s) < s || neighbourSizeAt(l.x + s - 1, l.y + s) < s,
                neighbourSizeAt(l.x - 1, l.y) < s || neighbourSizeAt(l.x - 1, l.y + s - 1) < s,
            ];
            for (const poly of chordPolygons(l.x, l.y, s, l.chord, needMid)) {
                for (const t of fanConvexRing(poly.ring)) {
                    triangles.push({ pts: t, regionId: poly.regionId, cut: true });
                }
            }
            continue;
        }
        if (!l.uniform) {
            shorelineLeafCount++;
            // Boundary leaf: cut it with marching squares. Nothing is finer
            // than minLeafSize, so no T-junction midpoint can be required here.
            const c: [number, number, number, number] = [
                regionIdAt(l.x, l.y),
                regionIdAt(l.x + l.size, l.y),
                regionIdAt(l.x + l.size, l.y + l.size),
                regionIdAt(l.x, l.y + l.size),
            ];
            const nodes: Vec2[] = [
                { x: l.x, y: l.y },
                { x: l.x + l.size, y: l.y },
                { x: l.x + l.size, y: l.y + l.size },
                { x: l.x, y: l.y + l.size },
            ];
            const crossings: (number | undefined)[] = [];
            const shoreEdges: boolean[] = [];
            for (let e = 0; e < 4; e++) {
                const a = nodes[e];
                const b = nodes[(e + 1) % 4];
                const idA = c[e];
                const idB = c[(e + 1) % 4];
                crossings.push(idA === idB ? undefined : edgeCrossing(a.x, a.y, b.x, b.y));
                shoreEdges.push(input.isLandRegion ? input.isLandRegion(idA) !== input.isLandRegion(idB) : true);
            }
            // Carry the shoreline tag through: the projection needs to know
            // which vertices land and water share.
            const lift = (p: Vec2): Vec2 => ({
                x: l.x + p.x * l.size,
                y: l.y + p.y * l.size,
                shore: p.shore,
            });

            const distinctIds = new Set(c);
            if (distinctIds.size <= 2) {
                // The ordinary case, including the plain shoreline-only path
                // every existing tile still takes: at most two regions on
                // this cell, so the well-tested boolean cutter handles it
                // exactly as it always has.
                const idA = c[0];
                const boolCorners: [boolean, boolean, boolean, boolean] = [
                    c[0] === idA, c[1] === idA, c[2] === idA, c[3] === idA,
                ];
                const cx = l.x + l.size / 2;
                const cy = l.y + l.size / 2;
                const centreIsLand = input.regionAt ? input.regionAt(cx, cy) === idA : undefined;
                const cut = cutCell({ corners: boolCorners, edgeCrossings: crossings, centreIsLand, shoreEdges });
                const idB = c.find(id => id !== idA) ?? idA;
                for (const t of cut.land) {
                    triangles.push({ pts: [lift(t[0]), lift(t[1]), lift(t[2])], regionId: idA, cut: true });
                }
                for (const t of cut.water) {
                    triangles.push({ pts: [lift(t[0]), lift(t[1]), lift(t[2])], regionId: idB, cut: true });
                }
            } else {
                // Three or four regions on one cell - a real landuse edge
                // crossing the coast, or two landuse edges meeting at once.
                const cx = l.x + l.size / 2;
                const cy = l.y + l.size / 2;
                const centreRegion = input.regionAt ? input.regionAt(cx, cy) : undefined;
                const cut = cutCellRegions({ corners: c, edgeCrossings: crossings, centreRegion, shoreEdges });
                for (const [regionId, tris] of cut.byRegion) {
                    for (const t of tris) {
                        triangles.push({ pts: [lift(t[0]), lift(t[1]), lift(t[2])], regionId, cut: true });
                    }
                }
            }
            continue;
        }

        // Uniform leaf: ring of corners plus a midpoint on any edge whose
        // neighbour is one level finer, fanned from one *corner*.
        //
        // It used to fan from the leaf centre, which costs `4 + k` triangles
        // for `k` midpoints against `2 + k` from a corner. Measured on 60 real
        // z12 tiles at the budget, fan leaves were a quarter of the leaves and
        // half of the interior triangles, so the centre vertex was 17-19% of
        // the tile. It bought nothing the merge test had not already paid
        // for: the leaf merged because every node in it, the centre included,
        // lies within maxErrorM of the surface through its corners.
        const s = l.size;
        const needMid = [
            neighbourSizeAt(l.x, l.y - 1) < s || neighbourSizeAt(l.x + s - 1, l.y - 1) < s,
            neighbourSizeAt(l.x + s, l.y) < s || neighbourSizeAt(l.x + s, l.y + s - 1) < s,
            neighbourSizeAt(l.x, l.y + s) < s || neighbourSizeAt(l.x + s - 1, l.y + s) < s,
            neighbourSizeAt(l.x - 1, l.y) < s || neighbourSizeAt(l.x - 1, l.y + s - 1) < s,
        ];
        const corners: Vec2[] = [
            { x: l.x, y: l.y },
            { x: l.x + s, y: l.y },
            { x: l.x + s, y: l.y + s },
            { x: l.x, y: l.y + s },
        ];
        const ring: Vec2[] = [];
        for (let e = 0; e < 4; e++) {
            ring.push(corners[e]);
            if (needMid[e]) {
                const a = corners[e];
                const b = corners[(e + 1) % 4];
                ring.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            }
        }
        // Fan from a corner with no midpoint on either of its edges when there
        // is one, so no fan triangle is a sliver between a corner and the
        // midpoint next to it; any corner is a valid triangulation of the
        // ring otherwise.
        let apexCorner = 0;
        for (let c = 0; c < 4; c++) {
            if (!needMid[c] && !needMid[(c + 3) % 4]) {
                apexCorner = c;
                break;
            }
        }
        const apexAt = ring.findIndex(p => p === corners[apexCorner]);
        const apex = ring[apexAt];
        for (let i = 1; i + 1 < ring.length; i++) {
            const a = ring[(apexAt + i) % ring.length];
            const b = ring[(apexAt + i + 1) % ring.length];
            triangles.push({ pts: [apex, a, b], regionId: l.regionId });
        }
    }

    return { triangles, leafCount: leaves.length, shorelineLeafCount };
}
