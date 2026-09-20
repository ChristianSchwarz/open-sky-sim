/**
 * Per-tile work for the mesh bake, factored out of bake_planet_mesh.ts so it
 * can run identically on the main thread or inside a worker_thread.
 *
 * `processTile` is a pure function of its config and one tile id — it only
 * touches that tile's own input files and writes its own `.ptm` — so tiles
 * within a level can be processed in any order or in parallel. What is *not*
 * safe to parallelise is aggregating the results: bake_planet_mesh.ts folds
 * them back in the original z/x/y-sorted order so the swatch table and the
 * per-level maxima come out byte-identical to a serial bake regardless of
 * which worker finished first.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { decodePdm } from '../../src/script/terrain/demTile';
import { LanduseRegion, Watercourse, decodeLvr } from './lvr';
import { PLC_FLAG_REAL_IMAGERY, decodePlc } from './plc';
import { buildTile } from './buildTile';
import { conformBorders, Side } from './borderConform';
import { carveGrid, decodeRgr } from './roadGrade';
import { GroundMeans, groundColorAt } from './groundColor';
import { CoastPolygon, InlandPolygon, LonLatBounds } from './shoreline';
import { EnuBasis } from '../../src/script/terrain/geodesy';
import { FlattenPad } from '../../src/script/terrain/flattenPad';

export interface TileTask {
    z: number;
    x: number;
    y: number;
}

/** Everything a tile needs that does not vary per tile. Sent to each worker once. */
export interface MeshTileConfig {
    src: string;
    out: string;
    seaLevel: number;
    /** Finest zoom in the pyramid; see BuildTileInput.maxZoom. */
    maxZoom: number;
    budget: number;
    basis: EnuBasis;
    pads: Array<FlattenPad & { basis: EnuBasis; lat: number; lon: number }>;
    /** Regional ground colour cells; see groundColor.ts. Omit for none. */
    groundMeans?: GroundMeans;
}

export interface TileProcessResult {
    z: number;
    x: number;
    y: number;
    bytesGz: number;
    triangleCount: number;
    riverTriangles: number;
    minLeafSize: number;
    covered: boolean;
    imagery: boolean;
    inlandTile: boolean;
    inlandBodies: number;
    riverTile: boolean;
    landuseTile: boolean;
    landuseRegions: number;
    /** Only set for a tile with real imagery — the rest must not feed the swatch table. */
    landColors?: Uint8Array;
    skirtDepthM: number;
    /** The error bound written to the tile header. */
    geometricErrorM: number;
    /** Interior tolerance the budget search settled on. */
    maxErrorM: number;
    /** Vertices the coplanar collapse pass removed. */
    collapsedVertices: number;
    /** See BuildTileResult.meshTriangles. */
    meshTriangles: number;
    fillTriangles: number;
    wallTriangles: number;
    skirtTriangles: number;
    tallWallTriangles: number;
    borderWaterNodes: number;
    waterSheetTriangles: number;
    /** See BuildTileResult.openEdges. */
    openEdges: number;
    /** Watercourse and outline strokes: what is left of triangleCount. */
    strokeTriangles: number;
}

/** Geographic quadtree: level z has 2^(z+1) columns by 2^z rows. */
export function tileBounds(z: number, x: number, y: number): LonLatBounds {
    const span = 180 / (1 << z);
    const west = -180 + x * span;
    const north = 90 - y * span;
    return { west, south: north - span, east: west + span, north };
}

export function tileEdgeMetres(z: number, x: number, y: number): number {
    const b = tileBounds(z, x, y);
    const midLat = (b.south + b.north) / 2;
    return Math.max(
        (b.east - b.west) * 111320 * Math.cos(midLat * Math.PI / 180),
        (b.north - b.south) * 110540,
    );
}

/**
 * Skirt depth for one tile. The worst vertical mismatch across an LOD seam is
 * bounded by the *coarser* neighbour's geometric error, so the parent tile's
 * error is the right term; 2x is margin, and the edge-length term covers
 * ellipsoid sagitta at coarse levels where geometric error is small.
 */
export function skirtDepthForTile(parentErrM: number, edgeM: number): number {
    return Math.max(2 * Math.max(0, parentErrM), 0.01 * edgeM);
}

/**
 * How much deeper than {@link skirtDepthForTile} the skirt actually hangs.
 *
 * That figure covers a seam against a neighbour one level coarser: each side
 * holds its border to a quarter of it, so the seam stays inside half. The
 * cut is not restricted to one level, though. A z12 tile beside a z9 tile
 * meets a border that strayed a quarter of z9's depth - eight times z12's
 * own - and the crack between the two, wider than the finer skirt is deep,
 * shows the sky as a triangle up the slope. Depth is what closes it and is
 * free (a skirt hangs under the ground), so it is sized for a neighbour four
 * levels coarser: 2^4 / 4 + 1 / 4 of the base, rounded up.
 *
 * The border tolerance stays a quarter of the *base* depth; only the wall
 * is deeper. Tiles already baked are brought up by tools/deepen_skirts.ts.
 */
export const SKIRT_SEAM_FACTOR = 5;

/**
 * The tolerance a tile's border is held to, as a fraction of the base skirt.
 *
 * It was a quarter, which is right for a seam against one level coarser and
 * leaves a seam against a coarse neighbour up to a quarter of *its* depth off
 * (97 m at z9): a deep skirt closes that as a wall, not as ground. A sixteenth
 * puts the worst seam at a few metres to tens of metres; only border vertices
 * pay for it.
 */
export const BORDER_ERROR_FRACTION = 1 / 16;

/**
 * Where the deepening stops. A coarse tile's own skirt is already kilometres
 * deep, and the factor would make it ten; below the cut it gains nothing a
 * neighbour at that scale could show.
 */
export const SKIRT_DEEPEN_CAP_M = 2500;

/** The depth a tile whose seam-against-one-level-coarser figure is `baseM` hangs. */
export function deepenedSkirtM(baseM: number): number {
    return Math.max(baseM, Math.min(baseM * SKIRT_SEAM_FACTOR, SKIRT_DEEPEN_CAP_M));
}

/**
 * Floor on the interior tolerance, in cells. A tile is drawn from where
 * its cells are a few pixels wide, and a bump under a quarter of a cell
 * tall does not read at that range; before the floor a flat tile spent its
 * whole budget resolving one-metre noise in 30 m cells. Measured at z12 the
 * budget-bound tiles land near half a cell anyway (14 m on 30 m cells); the
 * floor only touches the tiles that had room to go finer than that.
 */
export const MIN_ERROR_CELLS = 0.25;

/**
 * Deepest zoom that is a *global* tile: the coarse pyramid that covers the whole
 * planet from ETOPO's 1.85 km grid, where a tile is seen whole from orbit rather
 * than studied from a cockpit.
 */
export const GLOBAL_MAX_ZOOM = 6;

/**
 * Ceiling on the interior tolerance of a global tile, metres.
 *
 * The rules below scale tolerance with the tile, which is right when tiles are
 * kilometres across and wrong at the top of the pyramid. A z3 cell is 9.8 km
 * wide, so the quarter-cell floor is 2.4 km, and a continent's relief is inside
 * that: the interior collapsed to a quad whose corners sit at sea level, the
 * quad was dropped as water, and every coarse tile over land came out as ocean.
 * A land tile has to keep its land, so relief above this is kept whatever the
 * tile's own error says. The triangle budget search still coarsens a tile that
 * cannot afford it, so this bounds the tolerance from above and nothing else.
 */
export const GLOBAL_MAX_ERROR_M = 100;

/**
 * Interior tolerance: half the tile's own geometric error, floored at a
 * metre so flats collapse and at MIN_ERROR_CELLS of the cell size so a
 * quiet tile does not buy detail nobody can see. A global tile (see
 * GLOBAL_MAX_ZOOM) is capped instead of floored, so its land survives.
 */
export function maxErrorForTile(tileErrM: number, cellM = 0, z = Infinity): number {
    if (z <= GLOBAL_MAX_ZOOM) {
        return Math.min(GLOBAL_MAX_ERROR_M, tileErrM <= 0 ? 1 : Math.max(1, tileErrM * 0.5));
    }
    const floor = Math.max(1, cellM * MIN_ERROR_CELLS);
    return tileErrM <= 0 ? floor : Math.max(floor, tileErrM * 0.5);
}

/**
 * Floor on the coastline's Douglas-Peucker tolerance, in cells, by zoom.
 *
 * The tolerance is otherwise the interior one over the cell size, and on a
 * coarse tile that is a fraction of a cell: z10 cells are 152 m and its
 * error a few tens of metres. Cut at that resolution a z10 coast costs as
 * much as a z12 one while being drawn from 25 km out, where a cell is under
 * seven pixels. The floor is what makes the shoreline cheaper with distance.
 */
export function coastSimplifyFloorCells(z: number): number {
    return z <= 10 ? 1 : z === 11 ? 0.5 : 0;
}

/** Ceiling on the coast simplify tolerance, in cells, whatever the zoom. */
const COAST_SIMPLIFY_MAX_CELLS = 2;

/**
 * The parent tile's geometric error, read from its .pdm header, for the
 * skirt depth. Falls back to the tile's own error when there is no parent
 * on disk (z0, or a pyramid trimmed from above).
 */
function parentErrorM(src: string, z: number, x: number, y: number, ownErrM: number): number {
    if (z === 0) {
        return ownErrM;
    }
    const p = path.join(src, String(z - 1), String(x >> 1), `${y >> 1}.pdm`);
    if (!fs.existsSync(p)) {
        return ownErrM;
    }
    return decodePdm(fs.readFileSync(p)).geometricErrorM;
}

const ancestorGrids = new Map<string, { size: number; heights: Float32Array } | null>();

/** One side of an ancestor's raw height grid; a few are read over and over, so they are kept. */
function ancestorBorder(src: string, z: number, x: number, y: number, side: Side): Float32Array | undefined {
    const key = `${src}|${z}/${x}/${y}`;
    let grid = ancestorGrids.get(key);
    if (grid === undefined) {
        const p = path.join(src, String(z), String(x), `${y}.pdm`);
        grid = fs.existsSync(p) ? decodePdm(fs.readFileSync(p)) : null;
        if (ancestorGrids.size > 64) {
            ancestorGrids.clear();
        }
        ancestorGrids.set(key, grid);
    }
    if (!grid) {
        return undefined;
    }
    const n = grid.size;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = grid.heights[side === 'W' ? i * n : side === 'E' ? i * n + n - 1
            : side === 'N' ? i : (n - 1) * n + i];
    }
    return out;
}

/** Reads one tile's inputs, builds it and writes its `.ptm`. Returns undefined if there is no DEM tile. */
export function processTile(cfg: MeshTileConfig, task: TileTask): TileProcessResult | undefined {
    const { z, x, y } = task;
    const stem = path.join(cfg.src, String(z), String(x), String(y));
    const pdmPath = `${stem}.pdm`;
    if (!fs.existsSync(pdmPath)) {
        return undefined;
    }
    const dem = decodePdm(fs.readFileSync(pdmPath));
    conformBorders(dem.heights, dem.size, z, x, y, cfg.seaLevel, {
        border: (az, ax, ay, side) => ancestorBorder(cfg.src, az, ax, ay, side),
    });

    // Motorway roadbeds (bake_planet_roadgrade.ts): embankment and cutting are
    // laid into the grid before anything is built from it. Leaf only: the
    // .rgr exists at the leaf level alone.
    const rgrPath = `${stem}.rgr`;
    if (fs.existsSync(rgrPath)) {
        const b = tileBounds(z, x, y);
        carveGrid(dem.heights, dem.size, b, decodeRgr(fs.readFileSync(rgrPath)), cfg.seaLevel);
    }

    let polygons: CoastPolygon[] | undefined;
    let inland: InlandPolygon[] | undefined;
    let watercourses: Watercourse[] | undefined;
    let regions: LanduseRegion[] | undefined;
    let inlandTile = false;
    let inlandBodies = 0;
    let riverTile = false;
    let landuseTile = false;
    let landuseRegions = 0;
    const lvrPath = `${stem}.lvr`;
    if (fs.existsSync(lvrPath)) {
        const vec = decodeLvr(fs.readFileSync(lvrPath));
        polygons = vec.polygons as CoastPolygon[];
        // Empty on an LVR1 tile, which is most of them.
        if (vec.inland.length > 0) {
            inland = vec.inland;
            inlandTile = true;
            inlandBodies = vec.inland.length;
        }
        // Empty below LVR3.
        if (vec.watercourses.length > 0) {
            watercourses = vec.watercourses;
            riverTile = true;
        }
        // Empty below LVR4 - most tiles below LANDUSE_REGION_MIN_ZOOM, and
        // every tile predating this feature.
        if (vec.regions.length > 0) {
            regions = vec.regions;
            landuseTile = true;
            landuseRegions = vec.regions.length;
        }
    }

    let cover: ReturnType<typeof decodePlc> | undefined;
    let covered = false;
    let imagery = false;
    const plcPath = `${stem}.plc`;
    if (fs.existsSync(plcPath)) {
        cover = decodePlc(fs.readFileSync(plcPath));
        covered = true;
        if (cover.flags & PLC_FLAG_REAL_IMAGERY) {
            imagery = true;
        }
    }

    const bounds = tileBounds(z, x, y);
    const edgeM = tileEdgeMetres(z, x, y);
    const baseSkirtM = skirtDepthForTile(parentErrorM(cfg.src, z, x, y, dem.geometricErrorM), edgeM);
    const skirtDepthM = deepenedSkirtM(baseSkirtM);
    const cellM = edgeM / (dem.size - 1);
    const maxErrorM = maxErrorForTile(dem.geometricErrorM, cellM, z);
    // Simplify the coast to roughly the interior tolerance, in cells, floored
    // by zoom so a coarse tile's shoreline is not cut at fine-tile cost.
    const simplifyCells = cellM > 0
        ? Math.min(COAST_SIMPLIFY_MAX_CELLS, Math.max(coastSimplifyFloorCells(z), maxErrorM / cellM))
        : 0;

    const r = buildTile({
        id: { z, x, y },
        bounds,
        heights: dem.heights,
        size: dem.size,
        seaLevel: cfg.seaLevel,
        maxErrorM,
        skirtDepthM,
        borderErrorM: baseSkirtM * BORDER_ERROR_FRACTION,
        skirtSeamFactor: SKIRT_SEAM_FACTOR,
        geometricErrorM: dem.geometricErrorM,
        maxZoom: cfg.maxZoom,
        basis: cfg.basis,
        polygons,
        inland,
        simplifyCells,
        triangleBudget: cfg.budget,
        pads: cfg.pads,
        cover,
        watercourses,
        regions,
        groundColorAt: cfg.groundMeans
            ? (lon, lat, cls) => groundColorAt(cfg.groundMeans!, lon, lat, cls)
            : undefined,
    });

    const outPath = path.join(cfg.out, String(z), String(x), `${y}.ptm`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const gz = zlib.gzipSync(r.bytes, { level: 9 });
    fs.writeFileSync(outPath, gz);

    return {
        z, x, y,
        bytesGz: gz.byteLength,
        triangleCount: r.triangleCount,
        riverTriangles: r.riverTriangles,
        minLeafSize: r.minLeafSize,
        geometricErrorM: r.geometricErrorM,
        maxErrorM: r.maxErrorM,
        collapsedVertices: r.collapsedVertices,
        meshTriangles: r.meshTriangles,
        fillTriangles: r.fillTriangles,
        wallTriangles: r.wallTriangles,
        skirtTriangles: r.skirtTriangles,
        tallWallTriangles: r.tallWallTriangles,
        borderWaterNodes: r.borderWaterNodes,
        waterSheetTriangles: r.waterSheetTriangles,
        openEdges: r.openEdges,
        strokeTriangles: r.triangleCount - r.landTriangles - r.waterTriangles,
        covered,
        imagery,
        inlandTile,
        inlandBodies,
        riverTile,
        landuseTile,
        landuseRegions,
        // Only tiles carrying real imagery feed the swatch table. A tile
        // without it is painted in ESA's landcover map colours - a scarlet
        // for built-up, a lemon for grassland - which are legible on a map
        // and absurd on terrain, and letting them into the table hands real
        // ground the nearest of *those*.
        landColors: (covered && imagery) ? r.landColors : undefined,
        skirtDepthM,
    };
}
