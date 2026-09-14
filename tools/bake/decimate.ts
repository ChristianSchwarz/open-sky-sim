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

import { Vec2, cutCell, cutCellRegions } from './marchingSquares';

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

interface Leaf {
    x: number;
    y: number;
    size: number;
    uniform: boolean;
    regionId: number;
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
        field: Float32Array, bx: number, by: number, s: number,
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
                const d = Math.abs(at(bx + x, by + y) - bilinear);
                if (d > worst) {
                    worst = d;
                }
            }
        }
        return worst;
    };

    const padHeights = input.padHeights;
    const padErrorM = input.padErrorM ?? maxErrorM;
    /** The pad's own condition, which the triangle budget may not relax. */
    const padFits = (bx: number, by: number, s: number): boolean =>
        padHeights === undefined || blockError(padHeights, bx, by, s) <= padErrorM;

    // --- 1. Top-down subdivision -------------------------------------------
    const leaves: Leaf[] = [];
    const subdivide = (bx: number, by: number, s: number): void => {
        if (s <= minLeafSize) {
            const uniform = blockUniform(bx, by, s);
            leaves.push({ x: bx, y: by, size: s, uniform, regionId: uniform ? regionIdAt(bx, by) : 0 });
            return;
        }
        const uniform = blockUniform(bx, by, s);
        if (uniform && s <= maxLeafSize && blockError(heights, bx, by, s) <= maxErrorM
            && padFits(bx, by, s) && coverUniform(bx, by, s)) {
            leaves.push({ x: bx, y: by, size: s, uniform: true, regionId: regionIdAt(bx, by) });
            return;
        }
        const half = s / 2;
        subdivide(bx, by, half);
        subdivide(bx + half, by, half);
        subdivide(bx, by + half, half);
        subdivide(bx + half, by + half, half);
    };
    subdivide(0, 0, cells);

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
            // Split this leaf into four and re-paint.
            const half = l.size / 2;
            const kids: Leaf[] = [
                { x: l.x, y: l.y, size: half, uniform: false, regionId: 0 },
                { x: l.x + half, y: l.y, size: half, uniform: false, regionId: 0 },
                { x: l.x, y: l.y + half, size: half, uniform: false, regionId: 0 },
                { x: l.x + half, y: l.y + half, size: half, uniform: false, regionId: 0 },
            ];
            for (const k of kids) {
                k.uniform = blockUniform(k.x, k.y, k.size);
                k.regionId = k.uniform ? regionIdAt(k.x, k.y) : 0;
            }
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

    const defaultCrossing = () => undefined;
    const edgeCrossing = input.edgeCrossing ?? defaultCrossing;

    for (const l of leaves) {
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
