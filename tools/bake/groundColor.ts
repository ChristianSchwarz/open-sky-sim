/**
 * Regional colour lattice: for land no landuse polygon claims, and for the
 * polygons themselves.
 *
 * Painting untagged ground with its own facet's raster sample brings back
 * exactly the WorldCover blobs the landuse fill was meant to replace, and a
 * single flat colour per tile steps at every tile edge. So the colour is
 * averaged over a whole zoom-12 tile - about 4.9 km a side, ~25 km² - and each
 * vertex blends between the four nearest tile centres. The lattice is global,
 * so neighbouring tiles and every zoom level sample the same values: no seam
 * at a tile edge, and no colour pop when LOD swaps a tile for its parent.
 *
 * A landuse polygon has the same problem one level up: the partition is
 * assembled per tile, so a forest crossing a tile edge is two pieces, and a
 * mean over each piece's own nodes steps at the edge by whatever the two
 * footprints differ by - 40 sRGB levels between two Chamonix leaves. So each
 * cell also keeps one mean per TerrainClass, and a polygon's vertex blends
 * the four nearest cells' means *of its class*: forest-looking pixels for a
 * forest, so the fill still reads as its cover, but continuous across every
 * edge and zoom.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLASS_COUNT } from '../../src/script/terrain/tones';

// TerrainClass.Water spelled out: it is a `const enum`, and the tsx test
// runner leaves an imported const-enum binding undefined (see tileMesh.ts).
const WATER_CLASS = 8;
import { decodePlc } from './plc';

/** The zoom whose tiles are the averaging cells. */
export const GROUND_SAMPLE_ZOOM = 12;

export type Rgb = readonly [number, number, number];

/**
 * One sampling cell: the mean over every dry node, and the mean over the dry
 * nodes of each TerrainClass that has at least MIN_CLASS_NODES of them there.
 */
export interface CellMeans {
    all: Rgb;
    byClass: Record<number, Rgb>;
}

/** Means per sampling cell, keyed `${x}/${y}` at GROUND_SAMPLE_ZOOM. */
export type GroundMeans = Record<string, CellMeans>;

/**
 * Nodes of a class a cell needs before its mean counts. A z12 cover tile is
 * 256² nodes; a class with fewer than this is a stray pixel or two, and a
 * mean of those would colour every polygon of that class nearby after them.
 */
export const MIN_CLASS_NODES = 16;

/**
 * Sidecar holding the per-cell means beside the tiles they colour.
 *
 * A cell's mean depends only on its own .plc, so it is cached per cell and
 * keyed by that file's size and mtime. A scoped bake then decodes just the
 * cells whose cover changed since the last bake instead of every z12 tile in
 * the pyramid - and still hands the workers the complete lattice, which the
 * coarse tiles need: a z4 tile overlapping one area has vertices over every
 * other area under it.
 */
export const GROUND_MEANS_FILE = 'ground_means.json';

/** `mean` is null for a cell with no dry node, so it is not re-decoded every run. */
interface CachedCell {
    size: number;
    mtimeMs: number;
    mean: CellMeans | null;
}

/** Version 2 added the per-class means; a v1 sidecar is simply rebuilt. */
interface GroundMeansCache {
    version: 2;
    zoom: number;
    cells: Record<string, CachedCell>;
}

function loadCache(cachePath: string | undefined): GroundMeansCache['cells'] {
    if (cachePath === undefined || !fs.existsSync(cachePath)) {
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as GroundMeansCache;
        if (parsed.version !== 2 || parsed.zoom !== GROUND_SAMPLE_ZOOM
            || typeof parsed.cells !== 'object' || parsed.cells === null) {
            return {};
        }
        return parsed.cells;
    } catch {
        return {};
    }
}

/** Mean dry-ground colours of one cover tile, or undefined if it has no dry node. */
function cellMean(plcPath: string): CellMeans | undefined {
    const cover = decodePlc(fs.readFileSync(plcPath));
    return cellMeansOf(cover.classes, cover.colors);
}

/** The means behind {@link cellMean}, over raw class and colour arrays. */
export function cellMeansOf(classes: Uint8Array, colors: Uint8Array): CellMeans | undefined {
    const sums = new Float64Array(CLASS_COUNT * 4);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < classes.length; i++) {
        const cls = classes[i];
        if (cls === WATER_CLASS) {
            continue;
        }
        const cr = colors[i * 3];
        const cg = colors[i * 3 + 1];
        const cb = colors[i * 3 + 2];
        r += cr;
        g += cg;
        b += cb;
        n++;
        sums[cls * 4] += cr;
        sums[cls * 4 + 1] += cg;
        sums[cls * 4 + 2] += cb;
        sums[cls * 4 + 3]++;
    }
    if (n === 0) {
        return undefined;
    }
    const byClass: Record<number, Rgb> = {};
    for (let cls = 0; cls < CLASS_COUNT; cls++) {
        const k = sums[cls * 4 + 3];
        if (k >= MIN_CLASS_NODES) {
            byClass[cls] = [sums[cls * 4] / k, sums[cls * 4 + 1] / k, sums[cls * 4 + 2] / k];
        }
    }
    return { all: [r / n, g / n, b / n], byClass };
}

/**
 * Mean dry-ground colour of every GROUND_SAMPLE_ZOOM cover tile under `src`.
 * A tile with no dry node (open water, or no cover) is left out, so the
 * sampler blends across it from its neighbours instead of dragging sea blue
 * onto the coast.
 *
 * With `cachePath`, cells whose .plc is unchanged (same size and mtime) are
 * taken from the sidecar and the sidecar is rewritten afterwards. Cells whose
 * .plc has gone are dropped, so a deleted area does not linger in the lattice.
 */
export function regionalGroundMeans(src: string, cachePath?: string): GroundMeans {
    const means: GroundMeans = {};
    const zoomDir = path.join(src, String(GROUND_SAMPLE_ZOOM));
    if (!fs.existsSync(zoomDir)) {
        return means;
    }
    const cached = loadCache(cachePath);
    const fresh: GroundMeansCache['cells'] = {};
    let reused = 0;
    let decoded = 0;
    for (const xName of fs.readdirSync(zoomDir)) {
        const xDir = path.join(zoomDir, xName);
        if (!fs.statSync(xDir).isDirectory()) {
            continue;
        }
        for (const file of fs.readdirSync(xDir)) {
            if (!file.endsWith('.plc')) {
                continue;
            }
            const key = `${xName}/${file.slice(0, -4)}`;
            const plcPath = path.join(xDir, file);
            const st = fs.statSync(plcPath);
            const hit = cached[key];
            let mean: CellMeans | undefined;
            if (hit !== undefined && hit.size === st.size && hit.mtimeMs === st.mtimeMs
                && (hit.mean === null || (typeof hit.mean === 'object' && Array.isArray(hit.mean.all)))) {
                mean = hit.mean ?? undefined;
                reused++;
            } else {
                mean = cellMean(plcPath);
                decoded++;
            }
            if (mean !== undefined) {
                means[key] = mean;
            }
            fresh[key] = { size: st.size, mtimeMs: st.mtimeMs, mean: mean ?? null };
        }
    }
    if (cachePath !== undefined) {
        const out: GroundMeansCache = { version: 2, zoom: GROUND_SAMPLE_ZOOM, cells: fresh };
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, `${JSON.stringify(out)}
`);
        console.log(`ground means: ${reused} cells from cache, ${decoded} decoded`);
    }
    return means;
}

/**
 * Bilinear blend of the four sampling-cell centres around a point: of their
 * all-dry means, or with `cls`, of their means of that class.
 *
 * Cells with no value drop out and the rest are renormalised, so a vertex by
 * the sea takes the land colour beside it, and a forest vertex beside a cell
 * with no forest takes the forest colour of the cells that have some.
 * Undefined only when all four are missing - a caller asking for a class
 * then falls back to the all-dry blend, then to whatever it has of its own.
 */
export function groundColorAt(
    means: GroundMeans, lon: number, lat: number, cls?: number,
): [number, number, number] | undefined {
    const span = 180 / (1 << GROUND_SAMPLE_ZOOM);
    // Continuous cell coordinates, shifted so integers land on cell centres.
    const fx = (lon + 180) / span - 0.5;
    const fy = (90 - lat) / span - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (const [dx, dy, weight] of [
        [0, 0, (1 - tx) * (1 - ty)],
        [1, 0, tx * (1 - ty)],
        [0, 1, (1 - tx) * ty],
        [1, 1, tx * ty],
    ] as const) {
        const cell = means[`${x0 + dx}/${y0 + dy}`];
        const c = cell === undefined ? undefined : cls === undefined ? cell.all : cell.byClass[cls];
        if (!c || weight <= 0) {
            continue;
        }
        r += c[0] * weight;
        g += c[1] * weight;
        b += c[2] * weight;
        w += weight;
    }
    if (w <= 0) {
        return undefined;
    }
    return [Math.round(r / w), Math.round(g / w), Math.round(b / w)];
}
