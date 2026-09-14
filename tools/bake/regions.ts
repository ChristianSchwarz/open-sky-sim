/**
 * Turns a combined land/water + landuse partition - already resolved into
 * non-overlapping, tagged pieces before this ever runs - into what the
 * decimator needs: a region id per grid node, and the exact position where a
 * region boundary crosses each cell edge.
 *
 * This generalizes shoreline.ts's classify-plus-crossing machinery from one
 * land/water boundary to an arbitrary number of region boundaries at once,
 * but is deliberately a sibling file rather than a rewrite of it: a tile with
 * no landuse data builds its RegionField straight from the existing
 * Shoreline output instead (see regionFieldFromShoreline below), so the
 * well-tested coastline-only path is completely unaffected by anything here.
 *
 * Unlike shoreline.ts's land rings, region rings are not Douglas-Peucker
 * simplified here. Two regions sharing a boundary would otherwise simplify
 * that shared edge independently and disagree about where it sits - the same
 * failure shoreline.ts documents for inland water and avoids by leaving those
 * rings untouched. The bake already applies one consistent simplification to
 * the land/water edge before the landuse overlay ever runs (see
 * tools/osm_regions.py), so every ring handed to this module is already at
 * its final vertex count.
 */

import { LonLat, LonLatBounds, Shoreline, snapToBorder } from './shoreline';

export interface RegionPolygon {
    exterior: LonLat[];
    holes: LonLat[][];
    isLand: boolean;
    landuseClass: number | undefined;
}

export interface RegionMeta {
    isLand: boolean;
    landuseClass: number | undefined;
}

export interface RegionField {
    /** Row-major region index per node, `size * size`. Indexes regionTable. */
    regionNodes: Uint16Array;
    regionTable: RegionMeta[];
    /** Crossing parameter along a cell edge, or undefined if none recorded. */
    edgeCrossing(ax: number, ay: number, bx: number, by: number): number | undefined;
    /** Region index at an arbitrary interior point, in grid coordinates. */
    regionAt(x: number, y: number): number;
}

export interface RegionFieldInput {
    regions: RegionPolygon[];
    bounds: LonLatBounds;
    /** Node count per side. */
    size: number;
}

interface Ring {
    /** Flat grid coords: x0, y0, x1, y1, ... implicitly closed. */
    pts: Float64Array;
}

const NO_CROSSING = -1;

/**
 * The even-odd crossing test below (`yi > py !== yj > py`) is biased: a row
 * only registers a crossing where some part of the ring has y strictly
 * greater than it. That holds for row 0, because every real region has some
 * extent south of the tile's north edge — but it can never hold for the
 * grid's own last row, since nothing has y greater than `cells` to trigger
 * it. A region whose ring runs exactly along the tile's south edge, which
 * every region touching that edge does, since Python clips to the tile box,
 * would otherwise leave that entire row unclaimed by any region and stuck at
 * the region-0 fallback.
 *
 * Sampled a hair north of the true row instead: still inside whichever
 * region actually reaches the edge, and far too small to cross any real
 * boundary within the same grid cell.
 */
const LAST_ROW_EPS = 1e-6;

export function buildRegionField(input: RegionFieldInput): RegionField {
    const { regions, bounds, size } = input;
    const cells = size - 1;
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;
    // Snapped to the border the same way the shoreline is, so the landuse
    // partition and the land/water cut agree at the tile edge.
    const toGridX = (lon: number) => snapToBorder(((lon - bounds.west) / lonSpan) * cells, cells);
    const toGridY = (lat: number) => snapToBorder(((bounds.north - lat) / latSpan) * cells, cells);

    const regionTable: RegionMeta[] = regions.map(r => (
        { isLand: r.isLand, landuseClass: r.landuseClass }
    ));

    // Per-region rings, kept together with the bbox they occupy - the same
    // shape shoreline.ts uses for inland bodies, and for the same reason:
    // regionAt is called once per non-uniform leaf during the triangle-budget
    // search, so testing every ring of every region on every call would
    // dominate a tile carrying hundreds of them.
    const perRegion: Array<{
        rings: Ring[]; minX: number; minY: number; maxX: number; maxY: number;
    }> = [];
    const allRings: Ring[] = [];

    for (const region of regions) {
        const bodyRings: Ring[] = [];
        const push = (src: LonLat[]) => {
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
            allRings.push(ring);
        };
        push(region.exterior);
        for (const hole of region.holes) {
            push(hole);
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
        perRegion.push({ rings: bodyRings, minX, minY, maxX, maxY });
    }

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

    // --- classification: one region at a time, later entries win any pixel
    // more than one claims --------------------------------------------------
    //
    // The regions arrive already non-overlapping - Python resolved every real
    // OSM overlap before this ever reaches the bake, largest-first - so
    // "later wins" here is only a defensive tie-break for floating-point
    // noise at a shared edge, never a real priority decision.
    const regionNodes = new Uint16Array(size * size);
    const xs: number[] = [];
    for (let idx = 0; idx < perRegion.length; idx++) {
        const { rings } = perRegion[idx];
        if (rings.length === 0) {
            continue;
        }
        for (let row = 0; row < size; row++) {
            const py = row === cells ? cells - LAST_ROW_EPS : row;
            xs.length = 0;
            for (const r of rings) {
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
            for (let k = 0; k + 1 < xs.length; k += 2) {
                const from = Math.max(0, Math.ceil(xs[k]));
                const to = Math.min(size - 1, Math.floor(xs[k + 1]));
                for (let col = from; col <= to; col++) {
                    regionNodes[row * size + col] = idx;
                }
            }
        }
    }

    // --- crossings: walk every region's rings against the grid lines, same
    // "nearest to the edge midpoint wins" tie-break as shoreline.ts --------
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

    for (const r of allRings) {
        const p = r.pts;
        const n = p.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const ax = p[j * 2];
            const ay = p[j * 2 + 1];
            const bx = p[i * 2];
            const by = p[i * 2 + 1];
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

    /** Falls back to region 0, matching cutCellRegions' own c0 fallback. */
    const regionAt = (x: number, y: number): number => {
        for (let idx = perRegion.length - 1; idx >= 0; idx--) {
            const region = perRegion[idx];
            if (x < region.minX || x > region.maxX || y < region.minY || y > region.maxY) {
                continue;
            }
            if (pointInRings(x, y, region.rings)) {
                return idx;
            }
        }
        return 0;
    };

    return { regionNodes, regionTable, edgeCrossing, regionAt };
}

/**
 * The common case: no LVR4 layer on this tile, so the region field is just
 * the existing land/water Shoreline reinterpreted as a 2-entry table. Region
 * 0 is water, region 1 is land, matching Shoreline.landNodes' own 0/1
 * convention exactly. shoreline.ts stays completely untouched - this is the
 * only place that reaches into it for region purposes.
 */
export function regionFieldFromShoreline(shoreline: Shoreline): RegionField {
    const regionTable: RegionMeta[] = [
        { isLand: false, landuseClass: undefined },
        { isLand: true, landuseClass: undefined },
    ];
    return {
        regionNodes: new Uint16Array(shoreline.landNodes),
        regionTable,
        edgeCrossing: shoreline.edgeCrossing,
        // blockSize 0: x, y here are already the exact point to query, not a
        // block origin needing shoreline.ts's own +blockSize/2 offset.
        regionAt: (x, y) => (shoreline.centreIsLand(x, y, 0) ? 1 : 0),
    };
}
