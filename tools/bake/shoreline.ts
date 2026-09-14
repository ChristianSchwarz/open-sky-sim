/**
 * Turns OSM land polygons into the two things the decimator needs: a land flag
 * per grid node, and the exact position where the shoreline crosses each cell
 * edge.
 *
 * Polygons arrive in lon/lat and are converted to tile grid coordinates first,
 * so everything downstream works in one space. Rings are simplified with
 * Douglas-Peucker *before* cutting, which is what stops a convoluted coastline
 * from driving triangle count without bound.
 *
 * Classification uses a scanline fill rather than per-node point-in-polygon:
 * a 257x257 tile is 66,049 nodes and testing each against every ring edge is
 * needlessly quadratic.
 */

export interface LonLat {
    lon: number;
    lat: number;
}

export interface CoastPolygon {
    exterior: LonLat[];
    holes: LonLat[][];
}

export interface LonLatBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/**
 * One inland water body: a lake, a reservoir, or a stretch of wide river.
 *
 * `surfaceHeightM` is undefined for flowing water and for any body the coast
 * bake could not measure. Undefined means "follow the DEM", never "sea level" —
 * dropping inland water to the sea datum is exactly the bug this layer exists
 * to fix.
 */
export interface InlandPolygon {
    exterior: LonLat[];
    holes: LonLat[][];
    surfaceHeightM?: number;
}

export interface ShorelineInput {
    polygons: CoastPolygon[];
    /** Inland bodies for this tile. Omit and every non-land node is ocean. */
    inland?: InlandPolygon[];
    bounds: LonLatBounds;
    /** Node count per side. */
    size: number;
    /** Douglas-Peucker tolerance, in grid cells. 0 disables simplification. */
    simplifyCells?: number;
    /**
     * True where an airfield platform is cut flat, in lon/lat.
     *
     * A node inside one is land whatever the coast vector says. Gran Canaria
     * is the case: the airport is built out onto the shore, part of its apron
     * falls outside the OSM coastline, and those nodes would otherwise stay at
     * sea level inside a platform flattened to 13 m — a notch of open ocean
     * punched through the middle of an airfield.
     *
     * Only consulted for nodes that are not already land, so on a tile with no
     * water, or no pads, it costs nothing.
     */
    paved?: (lon: number, lat: number) => boolean;
    /**
     * DEM heights per node, row-major `size * size`, NaN for nodata. Given,
     * an unclaimed patch that never comes within INLAND_SEA_MIN_M of
     * `seaLevel` is inland water following the terrain rather than sea.
     */
    heights?: Float32Array;
    seaLevel?: number;
}

export interface Shoreline {
    /** 1 = land, per node, row-major `size * size`. */
    landNodes: Uint8Array;
    /** 1 = inland water, per node. Land and open ocean are both 0. */
    inlandNodes: Uint8Array;
    /**
     * Surface height per inland node, NaN where the body follows the DEM.
     *
     * Only meaningful where `inlandNodes` is 1.
     */
    inlandHeights: Float32Array;
    /** True when any node differs from any other. */
    mixed: boolean;
    /** Crossing parameter along a cell edge, or undefined if none recorded. */
    edgeCrossing(ax: number, ay: number, bx: number, by: number): number | undefined;
    /** True when the centre of a block is inside land. */
    centreIsLand(x: number, y: number, size: number): boolean;
}

interface Ring {
    /** Flat grid coords: x0, y0, x1, y1, ... implicitly closed. */
    pts: Float64Array;
}

const NO_CROSSING = -1;

/** Perpendicular distance from p to the segment ab, in grid units. */
function pointSegDistance(
    px: number, py: number, ax: number, ay: number, bx: number, by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Douglas-Peucker on an open polyline given as flat xy pairs.
 * Returns the indices to keep, always including the first and last.
 */
function douglasPeucker(pts: Float64Array, epsilon: number): number[] {
    const n = pts.length / 2;
    if (n <= 2 || epsilon <= 0) {
        return Array.from({ length: n }, (_, i) => i);
    }
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: Array<[number, number]> = [[0, n - 1]];
    while (stack.length > 0) {
        const [lo, hi] = stack.pop()!;
        if (hi - lo < 2) {
            continue;
        }
        let worst = -1;
        let worstIdx = -1;
        for (let i = lo + 1; i < hi; i++) {
            const d = pointSegDistance(
                pts[i * 2], pts[i * 2 + 1],
                pts[lo * 2], pts[lo * 2 + 1],
                pts[hi * 2], pts[hi * 2 + 1],
            );
            if (d > worst) {
                worst = d;
                worstIdx = i;
            }
        }
        if (worst > epsilon && worstIdx > 0) {
            keep[worstIdx] = 1;
            stack.push([lo, worstIdx], [worstIdx, hi]);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
        if (keep[i]) {
            out.push(i);
        }
    }
    return out;
}

/** Douglas-Peucker on a closed ring of flat xy pairs; keeps at least a triangle. */
export function simplifyRing(pts: Float64Array, epsilon: number): Float64Array {
    const n = pts.length / 2;
    if (n < 4 || epsilon <= 0) {
        return pts;
    }
    // Treat the ring as a closed polyline by repeating the first point, so the
    // start vertex is not privileged into a corner that survives simplification.
    const closed = new Float64Array((n + 1) * 2);
    closed.set(pts);
    closed[n * 2] = pts[0];
    closed[n * 2 + 1] = pts[1];
    const keep = douglasPeucker(closed, epsilon);
    // Drop the duplicated closing vertex.
    const idx = keep.filter(i => i < n);
    if (idx.length < 3) {
        return pts;
    }
    const out = new Float64Array(idx.length * 2);
    for (let i = 0; i < idx.length; i++) {
        out[i * 2] = pts[idx[i] * 2];
        out[i * 2 + 1] = pts[idx[i] * 2 + 1];
    }
    return out;
}

/**
 * A ring vertex this close to a tile edge, in cells, is moved onto it.
 *
 * The scanline fill below claims `ceil(x0) .. floor(x1)` per row, so a ring
 * edge that runs along the tile border but sits a hair inside it leaves the
 * border column (or row) to the open-ocean default. Measured on 12/4285/991:
 * the land ring left the east edge at x = 255.922, 1.5 m inside, and 165
 * border nodes came out as sea, with a 2.5 km wall from the Alps down to
 * them. Across the pyramid the snap reclassifies ~63k such nodes on ~700
 * tiles. A quarter cell is 5 m at z12 and 20 m at z10; a vertex genuinely
 * that close to the edge moves that far, which nothing can see.
 */
export const BORDER_SNAP_CELLS = 0.25;

/** Pulls the last scanline row inside the grid; see `scanline` below. */
const LAST_ROW_EPS = 1e-6;

/**
 * `v` snapped onto 0 or `cells` when within `tolerance` (default
 * {@link BORDER_SNAP_CELLS}).
 *
 * The shoreline passes its simplification tolerance when that is larger:
 * Douglas-Peucker treats any vertex within it as noise, and a border vertex
 * it drops next to an inset one turns the whole edge into a chord that runs
 * inside the tile. 11/2133/494 had a 0.38-cell spur on its west edge; at
 * 0.5 cells the two border vertices beside it went and the entire west
 * column came out as sea.
 */
export function snapToBorder(v: number, cells: number, tolerance = BORDER_SNAP_CELLS): number {
    if (Math.abs(v) < tolerance) {
        return 0;
    }
    if (Math.abs(v - cells) < tolerance) {
        return cells;
    }
    return v;
}

/**
 * Open water this far above the sea datum, in metres, is not the sea.
 *
 * A node the rings leave unclaimed defaults to open ocean. Where that is
 * wrong - a river arm thinner than a cell subtracted from the land with no
 * body ring covering the node, or a ring inset from the tile edge by more
 * than the snap - the node is baked at sea level under a mountain and gets
 * a wall down to it. A real sea component always reaches the shore, where
 * the DEM is within a few metres of the datum (SRTM carries buildings, so
 * not zero); a component whose lowest node is this high has no shore.
 */
export const INLAND_SEA_MIN_M = 50;

export function buildShoreline(input: ShorelineInput): Shoreline {
    const { polygons, bounds, size } = input;
    const cells = size - 1;
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;

    const simplify = input.simplifyCells ?? 0;

    // lon/lat -> grid. y runs south, matching the row-major DEM layout.
    // Snapped to the border: see BORDER_SNAP_CELLS and snapToBorder.
    const snapCells = Math.max(BORDER_SNAP_CELLS, simplify);
    const toGridX = (lon: number) => snapToBorder(((lon - bounds.west) / lonSpan) * cells, cells, snapCells);
    const toGridY = (lat: number) => snapToBorder(((bounds.north - lat) / latSpan) * cells, cells, snapCells);
    const rings: Ring[] = [];
    const outerRings: Ring[] = [];
    const holeRings: Ring[] = [];
    for (const poly of polygons) {
        const push = (src: LonLat[], into: Ring[]) => {
            if (src.length < 3) {
                return;
            }
            const raw = new Float64Array(src.length * 2);
            for (let i = 0; i < src.length; i++) {
                raw[i * 2] = toGridX(src[i].lon);
                raw[i * 2 + 1] = toGridY(src[i].lat);
            }
            const ring: Ring = { pts: simplifyRing(raw, simplify) };
            into.push(ring);
            rings.push(ring);
        };
        push(poly.exterior, outerRings);
        for (const hole of poly.holes) {
            push(hole, holeRings);
        }
    }

    // --- classification: even-odd scanline over all rings ------------------
    const landNodes = new Uint8Array(size * size);
    const pointInRings = (px: number, py: number, src: Ring[]): boolean => {
        let inside = false;
        for (const r of src) {
            const p = r.pts;
            const n = p.length / 2;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                const yi = p[i * 2 + 1];
                const yj = p[j * 2 + 1];
                if ((yi > py) !== (yj > py)) {
                    const xi = p[i * 2];
                    const xj = p[j * 2];
                    if (px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
                        inside = !inside;
                    }
                }
            }
        }
        return inside;
    };
    const insideAt = (px: number, py: number) => pointInRings(px, py, rings);

    // Scanline: for each node row, collect ring crossings once and fill spans.
    const xs: number[] = [];
    const scanline = (src: Ring[], onSpan: (row: number, from: number, to: number) => void) => {
        for (let row = 0; row < size; row++) {
            // The crossing test below only fires where some part of the ring
            // has y strictly greater than the row, which nothing has for the
            // last row: a ring running exactly along the south edge would
            // leave that whole row unclaimed. Same fix as regions.ts.
            const py = row === cells ? row - LAST_ROW_EPS : row;
            xs.length = 0;
            for (const r of src) {
                const p = r.pts;
                const n = p.length / 2;
                for (let i = 0, j = n - 1; i < n; j = i++) {
                    const yi = p[i * 2 + 1];
                    const yj = p[j * 2 + 1];
                    if ((yi > py) !== (yj > py)) {
                        const xi = p[i * 2];
                        const xj = p[j * 2];
                        xs.push((xj - xi) * (py - yi) / (yj - yi) + xi);
                    }
                }
            }
            if (xs.length === 0) {
                continue;
            }
            xs.sort((a, b) => a - b);
            // Even-odd: fill between alternating pairs.
            for (let k = 0; k + 1 < xs.length; k += 2) {
                const from = Math.max(0, Math.ceil(xs[k]));
                const to = Math.min(size - 1, Math.floor(xs[k + 1]));
                if (from <= to) {
                    onSpan(row, from, to);
                }
            }
        }
    };

    scanline(rings, (row, from, to) => {
        for (let col = from; col <= to; col++) {
            landNodes[row * size + col] = 1;
        }
    });

    // --- inland water: the same fill, but one body at a time ---------------
    //
    // Per body, not over their union: each carries its own surface height, and
    // an even-odd fill across all of them at once would let two overlapping
    // bodies cancel each other out into dry land.
    //
    // These rings are NOT simplified, unlike the land rings above.
    //
    // Simplifying both looks symmetrical and is the opposite of it. The land
    // polygons already have inland water subtracted, so a lake's shore appears
    // twice — once as a hole in the land ring, once as this body's exterior —
    // and running Douglas-Peucker over each independently moves them apart.
    // Nodes in the band between land off, water off. They belong to neither,
    // fall through to the open-ocean default, and get baked at sea level: a
    // river at 750 m breaks into segments with 750 m holes between them.
    //
    // Measured on the Colorado, tile 12/1545/1226, at simplifyCells 2: 187
    // nodes moved out of the water and 69 of them were inside the OSM polygon.
    //
    // Simplification buys nothing here anyway. The land rings are simplified
    // because the decimator cuts against them and the triangle budget depends
    // on it; this pass only answers "how high is the water", which costs the
    // same at any vertex count.
    const inlandNodes = new Uint8Array(size * size);
    const inlandHeights = new Float32Array(size * size).fill(NaN);
    const inlandRings: Ring[] = [];
    /**
     * Each body's rings kept together, with the grid-space box they occupy.
     *
     * Grouped per body because holes may only cancel their own exterior, and
     * boxed because `centreIsLand` is called per leaf inside the decimator's
     * budget search — on a tile carrying 548 bodies, testing every ring on
     * every call would dominate the bake.
     */
    const inlandRegions: Array<{
        rings: Ring[]; minX: number; minY: number; maxX: number; maxY: number;
    }> = [];
    for (const body of input.inland ?? []) {
        const bodyRings: Ring[] = [];
        const pushBodyRing = (src: LonLat[]) => {
            if (src.length < 3) {
                return;
            }
            const raw = new Float64Array(src.length * 2);
            for (let i = 0; i < src.length; i++) {
                raw[i * 2] = toGridX(src[i].lon);
                raw[i * 2 + 1] = toGridY(src[i].lat);
            }
            const ring: Ring = { pts: raw };
            bodyRings.push(ring);
            inlandRings.push(ring);
        };
        pushBodyRing(body.exterior);
        for (const hole of body.holes) {
            pushBodyRing(hole);
        }
        if (bodyRings.length === 0) {
            continue;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const r of bodyRings) {
            for (let i = 0; i < r.pts.length; i += 2) {
                if (r.pts[i] < minX) minX = r.pts[i];
                if (r.pts[i] > maxX) maxX = r.pts[i];
                if (r.pts[i + 1] < minY) minY = r.pts[i + 1];
                if (r.pts[i + 1] > maxY) maxY = r.pts[i + 1];
            }
        }
        inlandRegions.push({ rings: bodyRings, minX, minY, maxX, maxY });
        const surface = body.surfaceHeightM ?? NaN;
        scanline(bodyRings, (row, from, to) => {
            for (let col = from; col <= to; col++) {
                inlandNodes[row * size + col] = 1;
                inlandHeights[row * size + col] = surface;
            }
        });
    }

    // Inland water wins over land.
    //
    // The land rings are simplified, and simplifying a *hole* shrinks it: bands
    // of a lake or river get swallowed back into the land polygon, and where
    // that happens the tile grows no water at all and the terrain shows through
    // the middle of the body. Measured on the Colorado, tile 12/1545/1226, at
    // the simplifyCells 2 the mesh bake actually uses: 194 of 1183 nodes inside
    // the OSM polygon came back as land — 16% of the river, in bands across it.
    //
    // This was survivable only while inland water sat at sea level, where the
    // gaps were lost inside a 750 m slot. Once the water is at its own height
    // the body reads as chopped into pieces, so the exact ring has to win.
    for (let i = 0; i < landNodes.length; i++) {
        if (inlandNodes[i]) {
            landNodes[i] = 0;
        }
    }

    // Close whatever band the land rings' own simplification still leaves.
    //
    // Dropping the simplification above fixes this pass's half of the
    // disagreement, not the land pass's half: the land hole is still a
    // simplified ring and can sit inside the body it was cut from. So any node
    // that is not land and touches inland water is adopted into that body.
    //
    // The alternative — leaving it — is not neutral. An unclaimed node defaults
    // to open ocean, so the cost of guessing wrong here is one node of lake
    // where there should be sea, against a sea-level hole punched through a
    // mountain river. One pass, because the band is a fraction of a cell wide.
    //
    // Read from a snapshot so the fill cannot cascade across the tile within
    // this pass, which would walk a lake's height out over open water.
    const seed = inlandNodes.slice();
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const i = row * size + col;
            if (landNodes[i] || seed[i]) {
                continue;
            }
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const x = col + dx;
                    const y = row + dy;
                    if (x < 0 || y < 0 || x >= size || y >= size) {
                        continue;
                    }
                    const j = y * size + x;
                    if (seed[j]) {
                        inlandNodes[i] = 1;
                        inlandHeights[i] = inlandHeights[j];
                        dy = 2;
                        break;
                    }
                }
            }
        }
    }

    // An airfield platform is land, whatever the coast vector says. Done after
    // the inland passes so a body that reaches the apron is overridden too, and
    // before `mixed` so a tile that is all sea except for a runway still knows
    // it has both.
    if (input.paved) {
        for (let row = 0; row < size; row++) {
            const lat = bounds.north - (row / cells) * latSpan;
            for (let col = 0; col < size; col++) {
                const i = row * size + col;
                if (landNodes[i]) {
                    continue;
                }
                if (input.paved(bounds.west + (col / cells) * lonSpan, lat)) {
                    landNodes[i] = 1;
                    inlandNodes[i] = 0;
                }
            }
        }
    }

    // Unclaimed patches with no shore are not the sea; see INLAND_SEA_MIN_M.
    // Each 4-connected component of unclaimed nodes is taken together, so a
    // real sea that reaches a high cliff keeps the cliff. The patch becomes
    // inland water with no surface height, which the mesh drapes on the
    // terrain: no water sheet at the datum, no wall down to it.
    if (input.heights) {
        const heights = input.heights;
        const seaLevel = input.seaLevel ?? 0;
        const seen = new Uint8Array(size * size);
        const stack: number[] = [];
        for (let start = 0; start < size * size; start++) {
            if (seen[start] || landNodes[start] || inlandNodes[start]) {
                continue;
            }
            const component: number[] = [];
            let lowest = Infinity;
            stack.push(start);
            seen[start] = 1;
            while (stack.length > 0) {
                const i = stack.pop()!;
                component.push(i);
                const h = heights[i];
                if (Number.isFinite(h) && h < lowest) {
                    lowest = h;
                }
                const col = i % size;
                if (col > 0 && !seen[i - 1] && !landNodes[i - 1] && !inlandNodes[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
                if (col < cells && !seen[i + 1] && !landNodes[i + 1] && !inlandNodes[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
                if (i >= size && !seen[i - size] && !landNodes[i - size] && !inlandNodes[i - size]) { seen[i - size] = 1; stack.push(i - size); }
                if (i + size < size * size && !seen[i + size] && !landNodes[i + size] && !inlandNodes[i + size]) { seen[i + size] = 1; stack.push(i + size); }
            }
            // No finite height at all (a nodata patch) stays sea: there is
            // nothing to say otherwise, and open ocean is what nodata is.
            if (lowest !== Infinity && lowest > seaLevel + INLAND_SEA_MIN_M) {
                for (const i of component) {
                    inlandNodes[i] = 1;
                    inlandHeights[i] = NaN;
                }
            }
        }
    }

    let mixed = false;
    for (let i = 1; i < landNodes.length; i++) {
        if (landNodes[i] !== landNodes[0]) {
            mixed = true;
            break;
        }
    }

    // --- crossings: walk each ring segment against the grid lines ----------
    // hCross[row * size + col]: crossing on the cell edge (col,row)-(col+1,row).
    // vCross[row * size + col]: crossing on the cell edge (col,row)-(col,row+1).
    const hCross = new Float32Array(size * size).fill(NO_CROSSING);
    const vCross = new Float32Array(size * size).fill(NO_CROSSING);

    const recordH = (row: number, x: number) => {
        if (row < 0 || row >= size) {
            return;
        }
        let col = Math.floor(x);
        let t = x - col;
        if (col === cells && t === 0) {
            col = cells - 1;
            t = 1;
        }
        if (col < 0 || col >= cells) {
            return;
        }
        // Prefer the crossing nearest the edge midpoint when several land on
        // the same edge; it is the most stable choice and the error is bounded
        // by the cell size either way.
        const prev = hCross[row * size + col];
        if (prev === NO_CROSSING || Math.abs(t - 0.5) < Math.abs(prev - 0.5)) {
            hCross[row * size + col] = t;
        }
    };
    const recordV = (col: number, y: number) => {
        if (col < 0 || col >= size) {
            return;
        }
        let row = Math.floor(y);
        let t = y - row;
        if (row === cells && t === 0) {
            row = cells - 1;
            t = 1;
        }
        if (row < 0 || row >= cells) {
            return;
        }
        const prev = vCross[row * size + col];
        if (prev === NO_CROSSING || Math.abs(t - 0.5) < Math.abs(prev - 0.5)) {
            vCross[row * size + col] = t;
        }
    };

    // Inland rings are walked too, not just the land rings. They are now part
    // of the land/water boundary — the block above lets them cut into land — so
    // without their crossings the marching-squares cutter would have to place
    // those shoreline vertices blind.
    for (const r of [...rings, ...inlandRings]) {
        const p = r.pts;
        const n = p.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const ax = p[j * 2];
            const ay = p[j * 2 + 1];
            const bx = p[i * 2];
            const by = p[i * 2 + 1];
            // Horizontal grid lines (constant y) -> crossings on H edges.
            if (ay !== by) {
                const lo = Math.ceil(Math.min(ay, by));
                const hi = Math.floor(Math.max(ay, by));
                for (let row = lo; row <= hi; row++) {
                    const t = (row - ay) / (by - ay);
                    if (t >= 0 && t <= 1) {
                        recordH(row, ax + (bx - ax) * t);
                    }
                }
            }
            // Vertical grid lines (constant x) -> crossings on V edges.
            if (ax !== bx) {
                const lo = Math.ceil(Math.min(ax, bx));
                const hi = Math.floor(Math.max(ax, bx));
                for (let col = lo; col <= hi; col++) {
                    const t = (col - ax) / (bx - ax);
                    if (t >= 0 && t <= 1) {
                        recordV(col, ay + (by - ay) * t);
                    }
                }
            }
        }
    }

    const edgeCrossing = (ax: number, ay: number, bx: number, by: number): number | undefined => {
        if (ay === by) {
            const row = ay;
            const from = Math.min(ax, bx);
            const to = Math.max(ax, bx);
            const span = to - from;
            let best: number | undefined;
            let bestScore = Infinity;
            for (let col = from; col < to; col++) {
                const t = hCross[row * size + col];
                if (t === NO_CROSSING) {
                    continue;
                }
                const along = (col - from + t) / span;
                const score = Math.abs(along - 0.5);
                if (score < bestScore) {
                    bestScore = score;
                    best = along;
                }
            }
            if (best === undefined) {
                return undefined;
            }
            return ax <= bx ? best : 1 - best;
        }
        if (ax === bx) {
            const col = ax;
            const from = Math.min(ay, by);
            const to = Math.max(ay, by);
            const span = to - from;
            let best: number | undefined;
            let bestScore = Infinity;
            for (let row = from; row < to; row++) {
                const t = vCross[row * size + col];
                if (t === NO_CROSSING) {
                    continue;
                }
                const along = (row - from + t) / span;
                const score = Math.abs(along - 0.5);
                if (score < bestScore) {
                    bestScore = score;
                    best = along;
                }
            }
            if (best === undefined) {
                return undefined;
            }
            return ay <= by ? best : 1 - best;
        }
        return undefined;
    };

    /**
     * True when a body of inland water covers this point.
     *
     * Tested per body: a hole may only cancel the exterior it belongs to, so
     * pooling every ring into one even-odd pass would let one lake's island
     * punch a hole in a neighbouring lake.
     */
    const insideInland = (px: number, py: number): boolean => {
        for (const region of inlandRegions) {
            if (px < region.minX || px > region.maxX
                || py < region.minY || py > region.maxY) {
                continue;
            }
            if (pointInRings(px, py, region.rings)) {
                return true;
            }
        }
        return false;
    };

    /**
     * Which side a block's centre falls on, for resolving a saddle cell.
     *
     * Inland water subtracts, exactly as it does for `landNodes` above. The two
     * have to agree: the node grid says a lake is water while this said the
     * block over it was land, and the decimator uses this one to break the tie
     * on ambiguous cells — so a shoreline could be cut against the answer the
     * classification had already rejected.
     *
     * Note this reads the land rings, which are simplified, while the inland
     * rings are not. That asymmetry is deliberate and matches the node pass:
     * where the two disagree, the water wins.
     */
    const centreIsLand = (x: number, y: number, blockSize: number): boolean => {
        const px = x + blockSize / 2;
        const py = y + blockSize / 2;
        return insideAt(px, py) && !insideInland(px, py);
    };

    return { landNodes, inlandNodes, inlandHeights, mixed, edgeCrossing, centreIsLand };
}

export const __testing = { douglasPeucker, simplifyRing, pointSegDistance };
