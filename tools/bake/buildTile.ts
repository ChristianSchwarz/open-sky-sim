/**
 * Composes one baked tile: DEM heights + OSM polygons in, PTM1 bytes out.
 *
 * Pipeline, in order:
 *   1. classify nodes and locate shoreline crossings   (shoreline.ts)
 *   2. decimate into a restricted quadtree and cut the coast  (decimate.ts),
 *      holding the *padded* heights to a tolerance of their own alongside the
 *      raw DEM's (see padNodeHeights)
 *   3. enforce the triangle budget by coarsening and retrying
 *   4. project grid space -> geodetic -> ECEF -> tile-local scene axes
 *   5. apply the airbase flatten pad, the water surface and the depth bias
 *   6. sample the cover raster per facet, build skirts, split the streams
 *   7. encode                                              (ptm.ts)
 *
 * Everything the output depends on is fixed at build time, which is the whole
 * point: there is no runtime equivalent of this file, and no fallback path.
 *
 * Step 4 lands in *scene* axes, not raw ENU: x = east, y = up, z = **south**.
 * The runtime binds these vertices to the GPU untouched, so the frame they are
 * written in is the frame they are drawn in, and a left-handed one would draw
 * the whole planet as its own mirror image. See `sceneFromEnu` in geodesy.ts.
 */

import {
    EnuBasis, Ecef, Enu, ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef,
} from '../../src/script/terrain/geodesy';
import {
    FlattenPad, applyFlattenPad, padBlendWeight, padReachM,
} from '../../src/script/terrain/flattenPad';
import { CLASS_TO_TONE, TerrainClass, TerrainTone } from '../../src/script/terrain/tones';
import {
    PTM_MAX_RIVER_VERTS, PTM_STROKE_KIND_OUTLINE, PTM_STROKE_KIND_WATER, PtmTileId, encodePtm,
} from '../../src/script/terrain/ptm';
import { GridTriangle, decimate } from './decimate';
import { collapse } from './collapse';
import {
    CoastPolygon, InlandPolygon, LonLat, LonLatBounds, buildShoreline, simplifyRing,
} from './shoreline';
import { Watercourse } from './lvr';
import { RegionPolygon, buildRegionField, regionFieldFromShoreline } from './regions';
import { GridPoint, landuseFill } from './landuseFill';

/** Heights at or below seaLevel + this are open water. Matches the old bake. */
export const WATER_HEIGHT_EPS_M = 0.5;

/**
 * Open water is dropped this far so a coastal land/water edge cannot z-fight
 * into sky-coloured sparkles along the beach line.
 */
export const WATER_DEPTH_BIAS_M = 0.5;

/**
 * How far the drawn ground may stray from the flattened platform.
 *
 * Held to a third of AIRFIELD_SURFACE_EPS_M, which is the clearance the
 * pavement is drawn at over the ground it is draped on. Anything looser and
 * the platform's rim can eat into that clearance and surface through the
 * taxiways; anything tighter buys nothing the runtime could see.
 */
export const PAD_ERROR_M = 0.5;

/** Water within this distance of the shore is painted as the shallow tone. */
export const SHALLOW_WATER_COAST_M = 80;

/**
 * Bare ground within this distance of the shore is beach, not rock.
 *
 * WorldCover has no sand class - dune, ash flat and lava field are all class
 * 60 - so the distinction has to come from geometry the raster does not carry.
 * Wider than the shallow-water band on purpose: a beach reads as a band from
 * the air, and 80 m of it disappears at altitude.
 */
export const SHORE_SAND_M = 160;

/** Facet colour where the bake has no imagery to sample: honest mid grey. */
const NO_COVER_RGB: readonly [number, number, number] = [128, 128, 128];

/**
 * How far past a facet to look for dry ground when every node under it reads
 * as water. Wide enough to clear the coastline disagreement strip, narrow
 * enough that the colour still belongs to this stretch of shore.
 */
const DRY_SEARCH_CELLS = 4;

/** Skirt tops sit this far below the surface so they cannot z-fight it. */
export const SKIRT_TOP_EPS_M = 0.05;

/**
 * How far past the triangle budget the shoreline - and, since cover-class
 * boundaries are refused a merge the same way, real landcover edges too -
 * may push before coarsening.
 */
export const COAST_BUDGET_CEILING = 3;
/**
 * The same ceiling on a tile coarser than {@link COAST_FULL_DETAIL_MIN_ZOOM}.
 * The 3x overspend exists to keep inland river polygons from dashing, and on
 * a coarse tile those are under a cell wide and stroked instead - there is
 * nothing left to protect at that price.
 */
export const COAST_BUDGET_CEILING_COARSE = 1.5;
/** Zoom from which the coast may claim the full {@link COAST_BUDGET_CEILING}. */
export const COAST_FULL_DETAIL_MIN_ZOOM = 11;

/**
 * Zoom from which landuse polygons are laid over the mesh as exact fills and
 * their edges stroked. Coarser tiles vote the polygon's class onto the facet
 * instead, at no triangle cost.
 *
 * The leaf only. A z11 tile is drawn from ~25 km at the nearest, where one of
 * its 76 m cells is a few pixels and an exact polygon edge is under one, and
 * an exact fill there cost a mean 35k triangles per tile over Berlin - six
 * times the mesh budget, for edges no distance could show. Measured on a z9
 * tile before any gate: 73k fill and 16k outline triangles.
 */
export const LANDUSE_DETAIL_MIN_ZOOM = 12;

/**
 * Douglas-Peucker tolerance for landuse rings, in cells, below the leaf
 * zoom. OSM rings carry many vertices per cell, and every one costs a clip
 * against the facets under it; half a cell is under four pixels at the
 * nearest a z11 tile is ever drawn from. The leaf level keeps every vertex.
 */
export const LANDUSE_SIMPLIFY_CELLS = 0.5;
/**
 * Douglas-Peucker tolerance for a landuse ring at the leaf level, in cells.
 * The leaf used to keep every OSM vertex, and the fill and the outline
 * strokes are both bounded by the ring's vertex count. A tenth of a cell is
 * 3 m at z12, inside the outline stroke's own half-width, so nothing an
 * edge does at that scale can show.
 */
export const LANDUSE_LEAF_SIMPLIFY_CELLS = 0.25;
/** A landuse ring smaller than this, in cells^2, is not worth a fill. */
export const LANDUSE_MIN_RING_AREA_CELLS = 1;

/**
 * A watercourse narrower than this fraction of a cell is not stroked. The
 * stroke has a pixel floor, so from 50 km every ditch would read as a river;
 * at z10 this drops courses under 7.6 m and keeps a 12 m canal, at z8 the
 * cut is 30 m.
 */
export const WATERCOURSE_MIN_WIDTH_CELLS = 0.05;

/**
 * Spacing, in grid cells, at which a watercourse centreline is resampled
 * before it is draped.
 *
 * One cell, because that is the finest the terrain under it can vary: sampling
 * closer buys nothing the surface can show, and sampling coarser lets the
 * stroke cut a chord across a valley the river actually goes round.
 */
const RIVER_SAMPLE_CELLS = 1;

/**
 * Cap on the subdivisions one OSM segment may produce.
 *
 * A backstop, not a budget: a way with two nodes a degree apart would
 * otherwise resample into tens of thousands of points on a coarse tile.
 */
const RIVER_MAX_SUBDIVISIONS = 512;

/** How far a watercourse stroke floats above the surface, in grid cells. */
const RIVER_LIFT_CELLS = 0.05;

/**
 * Half the true width of a landuse outline stroke, metres. Thin on purpose:
 * RiverVertProgram's pixel floor is what keeps it visible from altitude, and
 * the baked width only matters once the edge is close enough to outgrow it.
 */
export const OUTLINE_HALF_WIDTH_M = 2;

/**
 * Largest normal deviation (deg) inside a vertex's ring that the coplanar
 * collapse pass will try to remove; see collapse.ts. Two degrees: the pool
 * roughly doubles at four, but the facets that survive are what the
 * fixed-sun shading paints, and a four-degree kink merged away is a visible
 * tone step in FACETED mode.
 */
export const COLLAPSE_MAX_ANGLE_DEG = 2;

/**
 * Observed ground cover on the tile's own grid, written by
 * tools/bake_planet_cover.py and decoded by tools/bake/plc.ts.
 *
 * Same `size * size` row-major layout as the heights, so a grid coordinate
 * indexes both without a second projection.
 */
export interface TileCover {
    size: number;
    /** One {@link TerrainClass} per node. */
    classes: Uint8Array;
    /** Three sRGB bytes per node. */
    colors: Uint8Array;
}

export interface BuildTileInput {
    id: PtmTileId;
    bounds: LonLatBounds;
    /** Row-major heights, `size * size`. */
    heights: Float32Array;
    size: number;
    seaLevel: number;
    /** Vertical tolerance for interior decimation. */
    maxErrorM: number;
    skirtDepthM: number;
    /**
     * The DEM's own geometric error for this tile - what its children hold
     * that it does not - straight from the .pdm header; 0 on a leaf.
     */
    geometricErrorM: number;
    /**
     * The pyramid's finest zoom. A leaf tile keeps every landuse vertex and
     * may fill the stroke stream; anything coarser is drawn from far enough
     * away to be simplified and capped. Omit to treat this tile as a leaf.
     */
    maxZoom?: number;
    basis: EnuBasis;
    polygons?: CoastPolygon[];
    /**
     * Inland water for this tile. Omit and every non-land node is open ocean,
     * which is what the bake did before lakes and rivers had a height of their
     * own — and what still happens for an LVR1 tile.
     */
    inland?: InlandPolygon[];
    /** Douglas-Peucker tolerance in grid cells. */
    simplifyCells?: number;
    minLeafSize?: number;
    /** Coarsen and retry until the tile fits. Omit to disable. */
    triangleBudget?: number;
    /**
     * Baked flatten pads, heightMsl included, each with the ENU frame it is
     * laid out in. A pad is an oriented box in ENU and ENU axes turn with
     * position, so a pad far from the bake's origin has to be measured in its
     * own frame or it sits skewed against the local north the runtime uses.
     */
    pads?: Array<FlattenPad & { basis: EnuBasis; lat: number; lon: number }>;
    /** Observed cover. Omit and every land facet falls back to plain grass. */
    cover?: TileCover;
    /**
     * Watercourse centrelines for this tile, at true width.
     *
     * Drawn as a stroke over the finished surface rather than cut into it —
     * see section 6b — which is what lets a canal far narrower than a grid
     * cell reach the screen at all.
     */
    watercourses?: Watercourse[];
    /**
     * A combined land/water + landuse partition for this tile, already
     * resolved into non-overlapping pieces (see tools/osm_regions.py). Omit
     * and every facet's colour and class comes from the raster cover vote
     * alone, exactly as before — this is what every tile below
     * LANDUSE_REGION_MIN_ZOOM, and every tile predating this feature, still
     * does.
     */
    regions?: RegionPolygon[];
    /**
     * Regional ground colour at a point (see groundColor.ts), for land no
     * landuse polygon claims on a tile that has `regions`. Given, that land is
     * baked as TerrainClass.Ground with this colour per vertex, so it blends
     * smoothly into neighbouring tiles. Omit to keep the facet's own sample.
     */
    groundColorAt?: (lon: number, lat: number) => readonly [number, number, number] | undefined;
}

export interface BuildTileResult {
    bytes: Uint8Array;
    triangleCount: number;
    landTriangles: number;
    waterTriangles: number;
    riverTriangles: number;
    /** Landuse polygon fill pieces laid over the land facets. */
    fillTriangles: number;
    /** Shore walls between land and water. */
    wallTriangles: number;
    /** Border skirts, land and water together. */
    skirtTriangles: number;
    /** The water surface itself, before its skirts. */
    waterSheetTriangles: number;
    /** Tolerance actually used after any budget coarsening. */
    maxErrorM: number;
    /** Error bound written to the header; see PtmEncodeInput.geometricErrorM. */
    geometricErrorM: number;
    minLeafSize: number;
    /** How many budget retries were needed. */
    attempts: number;
    /** Vertices the coplanar collapse pass removed from the final mesh. */
    collapsedVertices: number;
    /**
     * Triangles in the decimated surface itself, before walls, skirts, the
     * landuse fill and the water sheet. The budget governs this number; the
     * fill can be several times it on a tile dense with OSM polygons.
     */
    meshTriangles: number;
    centerHeightM: number;
    /** Three sRGB bytes per land triangle, for the bake's swatch histogram. */
    landColors: Uint8Array;
}

const _ecef: Ecef = { x: 0, y: 0, z: 0 };
const _enu: Enu = { e: 0, n: 0, u: 0 };
const _padEnu: Enu = { e: 0, n: 0, u: 0 };

/**
 * Offsets around a node, nearest first, as flat x,y pairs.
 *
 * Used to find the inland body a shoreline vertex belongs to. One ring is
 * enough: a crossing is always on an edge of the cell it was cut from, so the
 * body it borders is never more than one node away.
 */
const NEIGHBOURHOOD = [
    0, 0,
    1, 0, -1, 0, 0, 1, 0, -1,
    1, 1, 1, -1, -1, 1, -1, -1,
];

/**
 * Half-spans of a pad in degrees, with a margin.
 *
 * Only used to reject nodes nowhere near a pad before converting frames, so it
 * wants to be generous rather than exact - the pad's own blend does the real
 * work. The longitude span widens with latitude because a degree of longitude
 * is shorter there.
 */
// The cheap reject boxes below are sized from the pad's reach — the radius that
// holds it whichever way it is turned — rather than from halfD and halfW
// separately, which only bound a pad pointing due north. A pad at 032 with the
// old spans would have had its corners rejected and come out with two of them
// unflattened.
function padLatSpan(pad: FlattenPad): number {
    return padReachM(pad) / 110540 + 1e-4;
}

function padLonSpan(pad: FlattenPad & { lat: number }): number {
    const shrink = Math.max(0.05, Math.cos(pad.lat * Math.PI / 180));
    return padReachM(pad) / (111320 * shrink) + 1e-4;
}

/** A pad with its reject box precomputed, for the per-node loops. */
type NearPad = {
    pad: NonNullable<BuildTileInput['pads']>[number];
    latSpan: number;
    lonSpan: number;
};

/**
 * The pads whose reach touches the tile, with their reject spans worked out
 * once. The manifest carries every pad of every baked area - 193 across 40
 * airfields once a few areas are in - and the per-node loops used to test
 * all of them for every land node, recomputing each pad's reach (a hypot
 * and a cosine) on every test. Measured on Madeira, which has two
 * airfields: 29% of the whole mesh bake. Almost every tile has no pad near
 * it at all, and one that does has one or two.
 */
function padsNearTile(pads: BuildTileInput['pads'], bounds: LonLatBounds): NearPad[] {
    if (pads === undefined || pads.length === 0) {
        return [];
    }
    const near: NearPad[] = [];
    for (const pad of pads) {
        const latSpan = padLatSpan(pad);
        const lonSpan = padLonSpan(pad);
        if (pad.lat + latSpan >= bounds.south && pad.lat - latSpan <= bounds.north
            && pad.lon + lonSpan >= bounds.west && pad.lon - lonSpan <= bounds.east) {
            near.push({ pad, latSpan, lonSpan });
        }
    }
    return near;
}

/**
 * Node heights with the flatten pads already applied — the surface that will
 * actually be drawn.
 *
 * The decimator has to measure its error against this rather than against the
 * raw DEM, because the pad is applied per *vertex*, down in `project`. A leaf
 * merged on the raw heights therefore meets the platform only at its corners,
 * and interpolates straight across everything between them.
 *
 * Measured at Gran Canaria: a 407 m leaf straddling the platform's rim ran
 * between one corner cut down to the 9 m apron and one left up on 24 m of
 * hillside, and carried the drawn ground five to six metres over aprons lying
 * 150 m *inside* the pad's flat core. The pavement is draped on the height
 * query, which does see the pad, so it was drawn buried.
 *
 * Handing these to the decimator alongside the raw heights makes the rim a
 * feature it can see, so it subdivides there as it does anywhere else the
 * ground turns, and the platform reaches the surface across its whole
 * footprint instead of only where a leaf corner happened to land. They go
 * *alongside* rather than instead, because the pad's tolerance is the one
 * thing the triangle budget may not negotiate away - see
 * DecimateInput.padHeights.
 *
 * Returns the input array untouched when no pad comes near the tile, which is
 * almost every tile of a planet.
 */
function padNodeHeights(
    heights: Float32Array, size: number, bounds: LonLatBounds,
    pads: BuildTileInput['pads'],
): Float32Array {
    if (pads === undefined || pads.length === 0) {
        return heights;
    }
    const near = pads.filter(p =>
        p.lat + padLatSpan(p) >= bounds.south && p.lat - padLatSpan(p) <= bounds.north
        && p.lon + padLonSpan(p) >= bounds.west && p.lon - padLonSpan(p) <= bounds.east);
    if (near.length === 0) {
        return heights;
    }
    const cells = size - 1;
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;
    const out = Float32Array.from(heights);
    for (let gy = 0; gy < size; gy++) {
        const lat = bounds.north - (gy / cells) * latSpan;
        for (let gx = 0; gx < size; gx++) {
            let h = heights[gy * size + gx];
            if (!Number.isFinite(h)) {
                continue;
            }
            const lon = bounds.west + (gx / cells) * lonSpan;
            for (const pad of near) {
                if (Math.abs(lat - pad.lat) > padLatSpan(pad)
                    || Math.abs(lon - pad.lon) > padLonSpan(pad)) {
                    continue;
                }
                geodeticToEcef(lat, lon, h, _ecef);
                ecefToEnu(pad.basis, _ecef, _padEnu);
                h = applyFlattenPad(h, _padEnu.e, _padEnu.n, pad);
            }
            out[gy * size + gx] = h;
        }
    }
    return out;
}

/**
 * Multi-source chamfer distance (in cells) from every seeded node.
 *
 * Seeded on land it says how far out to sea a point is, which decides the
 * shallow-water tone; seeded on water it says how far inland, which decides
 * where bare ground is beach.
 */
function chamferDistanceCells(
    seeds: Uint8Array, size: number, seedWhen: number,
): Float32Array {
    const INF = 1e9;
    const d = new Float32Array(size * size).fill(INF);
    for (let i = 0; i < d.length; i++) {
        if ((seeds[i] ? 1 : 0) === seedWhen) {
            d[i] = 0;
        }
    }
    const relax = (i: number, j: number, w: number) => {
        const v = d[j] + w;
        if (v < d[i]) {
            d[i] = v;
        }
    };
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const i = y * size + x;
            if (x > 0) relax(i, i - 1, 1);
            if (y > 0) relax(i, i - size, 1);
            if (x > 0 && y > 0) relax(i, i - size - 1, Math.SQRT2);
            if (x + 1 < size && y > 0) relax(i, i - size + 1, Math.SQRT2);
        }
    }
    for (let y = size - 1; y >= 0; y--) {
        for (let x = size - 1; x >= 0; x--) {
            const i = y * size + x;
            if (x + 1 < size) relax(i, i + 1, 1);
            if (y + 1 < size) relax(i, i + size, 1);
            if (x + 1 < size && y + 1 < size) relax(i, i + size + 1, Math.SQRT2);
            if (x > 0 && y + 1 < size) relax(i, i + size - 1, Math.SQRT2);
        }
    }
    return d;
}

/**
 * Triangles a mesh will cost once skirts are added. Every triangle edge lying
 * on the tile border belongs to exactly one triangle and becomes a skirt quad,
 * so the budget has to include them or a tile silently lands over budget.
 */
function costWithSkirts(tris: GridTriangle[], cells: number, isLand: (t: GridTriangle) => boolean): number {
    // The same position rule the wall pass uses below: the cutter drops the
    // shore tag when a crossing lands exactly on a cell corner, so a chord
    // endpoint is a shore vertex if *any* triangle tags that position.
    const shore = shorePositionsOf(tris);
    let quads = 0;
    for (const t of tris) {
        for (let e = 0; e < 3; e++) {
            const a = t.pts[e];
            const b = t.pts[(e + 1) % 3];
            // Tile-border edge -> skirt quad.
            if ((a.x === 0 && b.x === 0) || (a.x === cells && b.x === cells)
                || (a.y === 0 && b.y === 0) || (a.y === cells && b.y === cells)) {
                quads++;
            }
            // Land edge along the shore chord -> shore wall quad.
            if (canWall(t, a, b) && isLand(t) && shore.has(gridKey(a.x, a.y)) && shore.has(gridKey(b.x, b.y))) {
                quads++;
            }
        }
    }
    return tris.length + quads * 2;
}

/**
 * Whether a land edge between two shore positions is one a shore wall may
 * hang from. Any edge of a cut triangle can be a chord. A uniform leaf's
 * edges lie on grid lines and can carry the coast when it runs along one,
 * but its diagonal never can: both corners can sit on the shore with the
 * whole leaf on land, and a wall from that diagonal lies buried inside the
 * ground, costing budget for nothing. The corner fan makes many more such
 * diagonals than the centre fan did, which is how they were noticed.
 */
function canWall(t: GridTriangle, a: Vec2, b: Vec2): boolean {
    return t.cut === true || a.x === b.x || a.y === b.y;
}

function gridKey(gx: number, gy: number): string {
    return `${gx.toFixed(4)},${gy.toFixed(4)}`;
}

/** Every grid position some triangle tags as shore; see costWithSkirts. */
function shorePositionsOf(tris: GridTriangle[]): Set<string> {
    const out = new Set<string>();
    for (const t of tris) {
        for (const p of t.pts) {
            if (p.shore) {
                out.add(gridKey(p.x, p.y));
            }
        }
    }
    return out;
}

export function buildTile(input: BuildTileInput): BuildTileResult {
    const { size, heights, bounds, seaLevel, basis } = input;
    const cells = size - 1;

    // A point the pads have already levelled is ground, so the shoreline pass
    // below must not leave it as sea. Only the pad *core* counts: the feather
    // is where the platform blends into whatever is around it, and if that is
    // the sea then blending into the sea is right.
    const nearPads = padsNearTile(input.pads, bounds);
    const paved = nearPads.length > 0
        ? (lon: number, lat: number): boolean => {
            for (const { pad, latSpan, lonSpan } of nearPads) {
                if (Math.abs(lat - pad.lat) > latSpan || Math.abs(lon - pad.lon) > lonSpan) {
                    continue;
                }
                geodeticToEcef(lat, lon, 0, _ecef);
                ecefToEnu(pad.basis, _ecef, _padEnu);
                if (padBlendWeight(_padEnu.e, _padEnu.n, pad) >= 1) {
                    return true;
                }
            }
            return false;
        }
        : undefined;

    const shoreline = buildShoreline({
        polygons: input.polygons ?? [],
        inland: input.inland,
        bounds,
        size,
        simplifyCells: input.simplifyCells,
        paved,
    });

    // A combined land/landuse partition, when this tile has one — see
    // tools/bake/regions.ts. The common case (no LVR4 data at this zoom, or
    // at all yet) falls back to the plain land/water Shoreline reinterpreted
    // as a 2-entry table, so decimate() always sees a region field and the
    // rest of this function never needs to branch on whether one was given.
    // The mesh itself is only ever cut at the shoreline. Landuse polygons used
    // to be cut into it too, but a grid cut coarsened by the triangle budget
    // put their edges tens of metres off - up to 16% of a polygon's area on
    // the wrong side, measured on Gran Canaria - so they are laid over the
    // finished land facets as exact vector fill instead; see landuseFill.ts.
    const regionField = regionFieldFromShoreline(shoreline);
    const hasRegions = input.regions !== undefined && input.regions.length > 0;
    const leafZoom = input.id.z >= (input.maxZoom ?? input.id.z);
    /** Exact fills and outlines; below this the polygons only colour facets. */
    const landuseDetail = hasRegions && input.id.z >= LANDUSE_DETAIL_MIN_ZOOM;
    /** Node-level landuse classification, used only to average each polygon's colour. */
    const landuseField = hasRegions
        ? buildRegionField({ regions: input.regions!, bounds, size })
        : undefined;
    const isLandTriangle = (t: GridTriangle): boolean => regionField.regionTable[t.regionId].isLand;

    // --- 3. budget-constrained decimation ---------------------------------
    //
    // Two knobs pull in different directions. Raising maxErrorM coarsens the
    // interior but does nothing for the coast, because shoreline blocks are
    // pinned to minLeafSize whatever the height error. Raising minLeafSize is
    // the only thing that reduces coastline cost, and it is the visible one:
    // measured on real Canary tiles the coast alone runs 12k-20k triangles at
    // minLeafSize 1 and roughly halves per doubling.
    //
    // So: buy the finest coast that fits, then spend whatever is left on
    // interior detail. Doing it the other way round wastes budget, and the
    // naive "alternate doubling both" lands far under the budget with a much
    // coarser coast than it needed to.
    const HUGE_ERROR_M = 1e9;
    /** Fraction of the budget the coast may claim before interior detail. */
    const COAST_SHARE = 0.8;
    /*
     * How far past the budget the shoreline may push before it is coarsened.
     *
     * The cut is worth overspending on - coarsening it is what turned rivers
     * into dashed lines - but not without limit. The runtime governs frame time
     * by coarsening LOD globally (TARGET_FRAME_MS, DETAIL_SCALE_MAX) and paces
     * uploads by time rather than count (TILE_UPLOAD_BUDGET_MS), so one
     * enormous tile does not merely cost itself: it coarsens the whole scene
     * around it and slows everything into view behind it.
     *
     * Unbounded, a Crimea bake put a tile at 60386 triangles, ten times the
     * budget. At 3x, every river tile measured (11970-15439) keeps its full
     * resolution cut and only the pathological ones give way.
     */

    // The pads are what `project` will do to these heights, so the decimator
    // has to see them — and against a tolerance the budget search below cannot
    // relax, which is why they go in beside the raw heights rather than
    // replacing them. See padNodeHeights and DecimateInput.padHeights.
    const drawnHeights = padNodeHeights(heights, size, bounds, input.pads);

    // Forces the decimator to refuse a merge across a real cover-class
    // boundary the same way it already refuses one across the coast - see
    // DecimateInput.coverClasses. Checked here, ahead of every use below,
    // rather than where `classify()` reads `input.cover` again further down:
    // a mismatched cover raster must fail before decimation runs on it, not
    // after.
    if (input.cover && input.cover.size !== size) {
        throw new Error(`cover size ${input.cover.size} != DEM size ${size}`);
    }
    // On a tile with OSM landuse regions the polygons decide what the ground
    // is, not the raster. Letting raster class edges refuse merges as well
    // cut the mesh along WorldCover's stairsteps, and those stairsteps are
    // what got painted - the polygons only showed where they happened to
    // disagree with the raster.
    const coverClasses = hasRegions ? undefined : input.cover?.classes;

    // One colour per landuse polygon: the mean observed colour over the dry
    // nodes it covers, so a polygon fills evenly instead of varying facet by
    // facet with the raster underneath. Untagged ground gets one tile-wide mean
    // the same way, for the land between polygons. A polygon too small to own
    // a node falls back to the facet's own sample.
    let regionColors: Array<readonly [number, number, number] | undefined> | undefined;
    let baseColor: readonly [number, number, number] | undefined;
    if (landuseField && input.cover) {
        const cover = input.cover;
        const sums = landuseField.regionTable.map(() => [0, 0, 0, 0]);
        const untagged = [0, 0, 0, 0];
        for (let i = 0; i < size * size; i++) {
            if (cover.classes[i] === TerrainClass.Water) {
                continue;
            }
            const id = landuseField.regionNodes[i];
            const s = landuseField.regionTable[id].landuseClass === undefined ? untagged : sums[id];
            s[0] += cover.colors[i * 3];
            s[1] += cover.colors[i * 3 + 1];
            s[2] += cover.colors[i * 3 + 2];
            s[3]++;
        }
        const mean = (s: number[]) => (s[3] > 0
            ? [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])] as const
            : undefined);
        regionColors = sums.map(mean);
        baseColor = mean(untagged);
    }

    // Water is not drawn at the DEM height, so it must not be decimated
    // against it. Open sea is a flat sheet at the datum, but the DEM out there
    // carries bathymetry, void fill and speckle, and the landcover raster
    // flickers between classes over it - either one refused merges and cut
    // empty ocean down to single cells. Measure water nodes against the
    // surface `project` will actually give them, and call them all one class.
    // Land nodes are untouched, and a block is only merged when every node
    // shares a region, so no land merge can see a flattened node.
    const waterFlattened = (field: Float32Array): Float32Array => {
        const out = new Float32Array(field);
        for (let i = 0; i < size * size; i++) {
            if (regionField.regionTable[regionField.regionNodes[i]].isLand) {
                continue;
            }
            if (!shoreline.inlandNodes[i]) {
                out[i] = seaLevel;
            } else if (Number.isFinite(shoreline.inlandHeights[i])) {
                out[i] = shoreline.inlandHeights[i];
            }
            // A body that follows the DEM keeps the DEM heights.
        }
        return out;
    };
    const meshHeights = waterFlattened(heights);
    const meshPadHeights = drawnHeights === heights ? undefined : waterFlattened(drawnHeights);
    let meshCoverClasses = coverClasses;
    if (coverClasses) {
        meshCoverClasses = new Uint8Array(coverClasses);
        for (let i = 0; i < size * size; i++) {
            if (!regionField.regionTable[regionField.regionNodes[i]].isLand) {
                meshCoverClasses[i] = TerrainClass.Water;
            }
        }
    }

    let attempts = 0;
    let collapsedVertices = 0;
    const collapseCellM = ((bounds.north - bounds.south) / cells) * 110540;
    const run = (err: number, leaf: number) => {
        attempts++;
        const d = decimate({
            size,
            heights: meshHeights,
            padHeights: meshPadHeights,
            padErrorM: PAD_ERROR_M,
            regionNodes: regionField.regionNodes,
            coverClasses: meshCoverClasses,
            maxErrorM: err,
            minLeafSize: leaf,
            edgeCrossing: regionField.edgeCrossing,
            regionAt: regionField.regionAt,
            isLandRegion: (id: number) => regionField.regionTable[id].isLand,
        });
        return d;
    };

    let maxErrorM = input.maxErrorM;
    let minLeafSize = input.minLeafSize ?? 1;
    const budget = input.triangleBudget;
    let tris: GridTriangle[];

    if (!budget) {
        tris = run(maxErrorM, minLeafSize).triangles;
    } else {
        // 1. The shoreline - and any real cover-class boundary, which refuses
        //    a merge the same unconditional way (DecimateInput.coverClasses) -
        //    is cut at full resolution, at every zoom level, and the budget is
        //    met out of the interior alone. `coastOnly` below is named for the
        //    original, larger cost driver, but at HUGE_ERROR_M every height-
        //    driven merge is already free to happen, so what is left refusing
        //    to merge is exactly the shoreline plus any cover boundary.
        //
        //    It used to coarsen the leaf size here until the coast fitted, and
        //    that is what broke the rivers. A watercourse two or three nodes
        //    across sits inside a four- or eight-cell leaf without reaching its
        //    corners, so `cutCell` resolves the leaf as land and the river comes
        //    out as a dashed line. Measured on Crimea: the classification is
        //    perfect at every level - 100% of every river's nodes wet, one piece
        //    per body - and it is decimation alone that breaks it, into a mean
        //    of 5.5 pieces with 52% of the area drawn.
        //
        //    Widening the rivers cannot fix that, and made it worse: the extra
        //    shoreline bought more coarsening, so the rivers came out in more
        //    pieces than before. The cut is the thing that has to survive.
        //
        //    A tile whose shoreline alone exceeds the budget goes over it
        //    rather than dropping detail the water needs - up to
        //    COAST_BUDGET_CEILING, past which even the cut has to give way.
        let coastOnly = run(HUGE_ERROR_M, minLeafSize);
        const coastCeiling = input.id.z >= COAST_FULL_DETAIL_MIN_ZOOM
            ? COAST_BUDGET_CEILING
            : COAST_BUDGET_CEILING_COARSE;
        while (costWithSkirts(coastOnly.triangles, cells, isLandTriangle) > budget * coastCeiling
            && minLeafSize < cells) {
            minLeafSize *= 2;
            coastOnly = run(HUGE_ERROR_M, minLeafSize);
        }

        // 2. Finest interior that still fits. Exponential search up from the
        //    requested tolerance, then bisect.
        let best = coastOnly;
        let fine = run(maxErrorM, minLeafSize);
        if (costWithSkirts(fine.triangles, cells, isLandTriangle) <= budget) {
            best = fine;
        } else {
            let lo = maxErrorM;          // too fine
            let hi = maxErrorM > 0 ? maxErrorM : 1;
            let hiFits = false;
            for (let i = 0; i < 24 && !hiFits; i++) {
                hi *= 2;
                fine = run(hi, minLeafSize);
                hiFits = costWithSkirts(fine.triangles, cells, isLandTriangle) <= budget;
            }
            if (!hiFits) {
                best = coastOnly;
                hi = HUGE_ERROR_M;
            } else {
                best = fine;
            }
            for (let i = 0; i < 8; i++) {
                const mid = Math.sqrt(lo * hi) || (lo + hi) / 2;
                const r = run(mid, minLeafSize);
                if (costWithSkirts(r.triangles, cells, isLandTriangle) <= budget) {
                    hi = mid;
                    best = r;
                } else {
                    lo = mid;
                }
            }
            maxErrorM = hi;
        }
        // Spend whatever the interior did not need back on the coast.
        //
        // COAST_SHARE is a *reservation*, not a cap, and treating it as a cap
        // wastes the budget wherever the terrain is flat and the water complex.
        // Measured on a Berlin lake tile: the coast fits at a 4-cell leaf for
        // 5794 triangles, but that is over the 80% gate, so it was cut at an
        // 8-cell leaf instead — a 96 m shoreline on 12 m cells — and the tile
        // came out at 2942 triangles, using 48% of the budget it was given.
        //
        // So: having reserved room for the interior, walk back down as long as
        // the *total* still fits. The shoreline is the visible half.
        while (minLeafSize > 1) {
            const finer = minLeafSize / 2;
            const candidate = run(maxErrorM, finer);
            if (costWithSkirts(candidate.triangles, cells, isLandTriangle) <= budget) {
                best = candidate;
                minLeafSize = finer;
                continue;
            }
            // The interior cannot come along at this tolerance. Coarsen it
            // until it can rather than dropping it: on mountainous coast the
            // height detail is worth something, and going straight to a
            // coast-only tile would throw all of it away for one step of
            // shoreline.
            let err = maxErrorM > 0 && Number.isFinite(maxErrorM) ? maxErrorM : 1;
            let fitted: ReturnType<typeof run> | undefined;
            for (let i = 0; i < 24 && !fitted; i++) {
                err *= 2;
                const r = run(err, finer);
                if (costWithSkirts(r.triangles, cells, isLandTriangle) <= budget) {
                    fitted = r;
                }
            }
            if (fitted) {
                best = fitted;
                minLeafSize = finer;
                maxErrorM = err;
                continue;
            }
            break;
        }
        tris = best.triangles;
    }

    // --- 3b. coplanar collapse --------------------------------------------
    //
    // Once, on the mesh the search settled on, not inside the search. Run
    // per attempt it made the bake four times slower, and it would only have
    // handed the saving straight back to the tolerance: the search coarsens
    // until the tile fits, so a cheaper mesh fits at a finer error and comes
    // out the same size. Here the saving stays a saving. A collapse can only
    // remove triangles, so the budget still holds; the one thing it can add
    // is a wall on a new grid-aligned edge between two shore positions,
    // which is rare and a quad.
    const collapsed = collapse({
        triangles: tris,
        size,
        heights: meshHeights,
        cellM: collapseCellM,
        maxErrorM: Number.isFinite(maxErrorM) ? maxErrorM : input.maxErrorM,
        maxAngleDeg: COLLAPSE_MAX_ANGLE_DEG,
        padHeights: meshPadHeights,
        padErrorM: PAD_ERROR_M,
        coverClasses: meshCoverClasses,
    });
    tris = collapsed.triangles;
    collapsedVertices = collapsed.collapsed;
    const meshTriangles = tris.length;

    // --- 4/5. projection, pad, depth bias ---------------------------------
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;
    const distCells = chamferDistanceCells(shoreline.landNodes, size, 1);
    // The mirror of the above: how far *inland* a point is, which is what the
    // beach rule needs. A tile with no water at all seeds nothing, and every
    // node correctly comes back at the infinity the fill starts from.
    const inlandCells = chamferDistanceCells(shoreline.landNodes, size, 0);
    // Metres per cell, for the shallow-water distance test. Latitude spacing
    // is used because it does not shrink with longitude towards the poles.
    const metresPerCell = Math.max(1e-6, (latSpan / cells) * 110540);

    const sampleHeight = (gx: number, gy: number): number => {
        const fx = Math.min(cells, Math.max(0, gx));
        const fy = Math.min(cells, Math.max(0, gy));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = Math.min(cells, x0 + 1);
        const y1 = Math.min(cells, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const h00 = heights[y0 * size + x0];
        const h10 = heights[y0 * size + x1];
        const h01 = heights[y1 * size + x0];
        const h11 = heights[y1 * size + x1];
        let sum = 0;
        let w = 0;
        const add = (h: number, weight: number) => {
            if (Number.isFinite(h) && weight > 0) {
                sum += h * weight;
                w += weight;
            }
        };
        add(h00, (1 - tx) * (1 - ty));
        add(h10, tx * (1 - ty));
        add(h01, (1 - tx) * ty);
        add(h11, tx * ty);
        return w > 0 ? sum / w : seaLevel;
    };

    const sampleDist = (gx: number, gy: number): number => {
        const x = Math.min(size - 1, Math.max(0, Math.round(gx)));
        const y = Math.min(size - 1, Math.max(0, Math.round(gy)));
        return distCells[y * size + x] * metresPerCell;
    };

    const sampleInland = (gx: number, gy: number): number => {
        const x = Math.min(size - 1, Math.max(0, Math.round(gx)));
        const y = Math.min(size - 1, Math.max(0, Math.round(gy)));
        return inlandCells[y * size + x] * metresPerCell;
    };

    /**
     * The inland body under a grid point, given as its surface height.
     *
     * undefined where there is no inland water; NaN where there is a body that
     * follows the DEM rather than sitting at one height.
     *
     * Searched over the nodes *around* the point, nearest first, rather than at
     * the point itself. A water vertex is either an interior node - which
     * answers for itself - or a shoreline crossing sitting on a cell edge
     * between a wet node and a dry one. Crossings within SNAP_EPS of a corner
     * are snapped onto it, and that corner can be the dry one, on the far side
     * of the body from any wet node the cell contains. Looking only at the cell
     * would then answer "no inland water here" and drop the rim of the lake to
     * sea level - which is the exact bug this code exists to remove.
     *
     * Nearest first so that a vertex between two bodies takes the height of the
     * one it is actually on.
     */
    const inlandSurfaceAt = (gx: number, gy: number): number | undefined => {
        const cx = Math.min(size - 1, Math.max(0, Math.round(gx)));
        const cy = Math.min(size - 1, Math.max(0, Math.round(gy)));
        for (let k = 0; k < NEIGHBOURHOOD.length; k += 2) {
            const x = cx + NEIGHBOURHOOD[k];
            const y = cy + NEIGHBOURHOOD[k + 1];
            if (x < 0 || y < 0 || x >= size || y >= size) {
                continue;
            }
            const i = y * size + x;
            if (shoreline.inlandNodes[i]) {
                return shoreline.inlandHeights[i];
            }
        }
        return undefined;
    };

    /**
     * Height of the water surface at a grid point.
     *
     * Open ocean is the sea datum, as it always was. Inland water is either a
     * measured flat surface — a lake sits at one elevation, and water that is
     * not level reads as broken from the air — or, where the bake had no single
     * height to give, the terrain itself. Never sea level: dropping a lake at
     * 900 m to the sea datum punches a slot through the world, which is the
     * whole reason this exists.
     *
     * At the shoreline a flat body is clamped down to the ground it meets. The
     * height is chosen to sit under the lowest part of the body's own shore,
     * but "lowest" is a percentile over the whole perimeter, so a little of
     * that shore still comes out below the water. Clamping costs the rim its
     * flatness and buys the one thing that must never happen: water standing
     * above the ground beside it.
     */
    const waterSurfaceAt = (gx: number, gy: number, onShore: boolean): number => {
        const surface = inlandSurfaceAt(gx, gy);
        if (surface === undefined) {
            return seaLevel;
        }
        if (!Number.isFinite(surface)) {
            return sampleHeight(gx, gy);
        }
        return onShore ? Math.min(surface, sampleHeight(gx, gy)) : surface;
    };

    /** Grid -> ENU (absolute), including the pad and the water rules. */

    /**
     * Land and water become separate meshes with their own vertices, so
     * wherever they meet they must agree on height or the seam opens into a
     * wall you can see straight through. They meet at the marching-squares
     * crossing points, which the cutter tags as `shore`.
     *
     * They did not agree: land took the DEM sample there while water sat at
     * sea level, and OSM coastlines do not follow the DEM's zero contour. On
     * real Canary tiles that was 48 m of mismatch on average and up to 815 m.
     *
     * Both sides now use the same water surface at a tagged point — sea level
     * on the coast, the body's own height inland — and the depth bias is
     * skipped there so it cannot reopen the gap by half a metre.
     */
    /**
     * Positions of every tagged shoreline vertex.
     *
     * The tag alone is not quite enough. When the coast passes within SNAP_EPS
     * of a grid node the crossing snaps onto that corner, so one polygon gets
     * the tagged snapped point and the other the plain, untagged corner at the
     * same place. Those positions are integers, so matching them is exact; it
     * is only true crossings, computed independently by adjacent leaves, that
     * cannot be compared numerically. So: trust the tag, fall back to position.
     *
     * The tag itself is only ever set on a genuine land/water crossing, never
     * a landuse-only one between two regions on the same side of it — see
     * DecimateInput.isLandRegion — so nothing here needs to re-derive that
     * distinction.
     */
    const shorePositions = shorePositionsOf(tris);
    const isShore = (gx: number, gy: number, tagged?: boolean) =>
        tagged === true || shorePositions.has(gridKey(gx, gy));

    /**
     * Land keeps its DEM height everywhere, including at the shoreline.
     *
     * Forcing it to sea level there to close the seam was far too blunt: OSM
     * coastlines and the DEM disagree about where the shore is — the vector
     * often runs along the foot of a cliff whose DEM pixel reads the top — so
     * it dragged real mountainside down. Measured on Canary tiles that hit 453
     * vertices dropped by as much as 1360 m, tearing the terrain open.
     *
     * The seam is closed with geometry instead: a wall along the shore chord,
     * built below. Only the water side changes here, skipping its depth bias at
     * the shoreline so the wall has a single height to meet.
     */
    const project = (
        gx: number, gy: number, land: boolean, tagged = false, dropM = 0,
    ): Enu => {
        const onShore = isShore(gx, gy, tagged);
        const lon = bounds.west + (gx / cells) * lonSpan;
        const lat = bounds.north - (gy / cells) * latSpan;
        let h = land ? sampleHeight(gx, gy) : waterSurfaceAt(gx, gy, onShore);
        if (!Number.isFinite(h)) {
            h = seaLevel;
        }
        if (land) {
            // The pad blend is in ENU, so we need a first ENU pass to know
            // where we are before we can decide how much to flatten.
            if (nearPads.length > 0) {
                for (const { pad, latSpan, lonSpan } of nearPads) {
                    // Cheap geodetic reject first: a pad is a kilometre or two
                    // across, so almost every node is outside almost every
                    // pad and must not pay for a frame conversion to find
                    // that out.
                    if (Math.abs(lat - pad.lat) > latSpan || Math.abs(lon - pad.lon) > lonSpan) {
                        continue;
                    }
                    geodeticToEcef(lat, lon, h, _ecef);
                    ecefToEnu(pad.basis, _ecef, _padEnu);
                    h = applyFlattenPad(h, _padEnu.e, _padEnu.n, pad);
                }
            }
        } else if (!onShore) {
            h -= WATER_DEPTH_BIAS_M;
        }
        // Dropped *before* the projection, so the vertex falls along the local
        // ellipsoid normal. Subtracting from the resulting ENU u instead only
        // means "down" near the frame's own origin — see the skirt loop.
        h -= dropM;
        geodeticToEcef(lat, lon, h, _ecef);
        ecefToEnu(basis, _ecef, _enu);
        return { e: _enu.e, n: _enu.n, u: _enu.u };
    };

    /**
     * Water-surface ENU at a grid point: the foot of a shore wall.
     *
     * Walls are built along shore chords, so this asks for the shoreline
     * height — the same clamped value the water vertex at that point gets, and
     * with the depth bias skipped on both sides, which is what lets the wall
     * and the water meet exactly instead of leaving a half-metre crack.
     */
    const projectWaterSurface = (gx: number, gy: number): Enu => {
        const lon = bounds.west + (gx / cells) * lonSpan;
        const lat = bounds.north - (gy / cells) * latSpan;
        geodeticToEcef(lat, lon, waterSurfaceAt(gx, gy, true), _ecef);
        ecefToEnu(basis, _ecef, _enu);
        return { e: _enu.e, n: _enu.n, u: _enu.u };
    };

    // Tile centre, which is what the runtime will place the mesh at.
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < heights.length; i++) {
        const h = heights[i];
        if (Number.isFinite(h)) {
            if (h < minH) minH = h;
            if (h > maxH) maxH = h;
        }
    }
    if (!Number.isFinite(minH)) {
        minH = seaLevel;
        maxH = seaLevel;
    }
    const centerHeightM = (minH + maxH) / 2;
    const centreLon = (bounds.west + bounds.east) / 2;
    const centreLat = (bounds.south + bounds.north) / 2;
    geodeticToEcef(centreLat, centreLon, centerHeightM, _ecef);
    const centre = ecefToEnu(basis, _ecef, { e: 0, n: 0, u: 0 });

    // Local up, in this tile's own axes.
    //
    // The frame's y axis is the u of an ENU basis centred once at the play
    // origin, and u is the vertical only near that origin: Berlin is 3400 km
    // away, where it is ~31 deg off, and the Grand Canyon 9000 km, where it is
    // ~81 deg off and the sign of y says almost nothing about which way is up.
    // Orienting normals on that sign turned a large share of them into the
    // ground, and the fixed-sun shading went with them.
    //
    // One direction per tile: across a few kilometres the vertical turns by a
    // fraction of a degree, far below anything the shading can show.
    const upAbove = ecefToEnu(
        basis,
        geodeticToEcef(centreLat, centreLon, centerHeightM + 1000, { x: 0, y: 0, z: 0 }),
        { e: 0, n: 0, u: 0 },
    );
    const upXRaw = upAbove.e - centre.e;
    const upYRaw = upAbove.u - centre.u;
    const upZRaw = centre.n - upAbove.n;
    const upLen = Math.hypot(upXRaw, upYRaw, upZRaw) || 1;
    const localUpX = upXRaw / upLen;
    const localUpY = upYRaw / upLen;
    const localUpZ = upZRaw / upLen;

    // --- 6. cover, streams, skirts ----------------------------------------
    //
    // A facet's colour is whatever the cover raster says over the ground the
    // facet actually covers, not what it says at one point: a single centroid
    // sample turns a coarse-zoom triangle spanning a whole valley into
    // whichever pixel happened to sit under its middle, and the result
    // flickers between LOD levels. So: walk the facet's grid footprint, take
    // the majority class and the mean colour.
    // Already validated against `size` where `coverClasses` was pulled out
    // for the decimator, above.
    const cover = input.cover;

    // One histogram for the whole tile, cleared per facet. Allocating it
    // inside classify meant a kilobyte per triangle across five thousand
    // triangles a tile and fourteen hundred tiles, which measurably dominated
    // the bake; clearing 256 entries does not.
    const histogram = new Uint32Array(256);

    /** Facet cover: [class, r, g, b]. */
    const classify = (
        p0: { x: number; y: number },
        p1: { x: number; y: number },
        p2: { x: number; y: number },
    ): [number, number, number, number] => {
        if (!cover) {
            return [TerrainClass.Unknown, ...NO_COVER_RGB] as [number, number, number, number];
        }
        histogram.fill(0);
        let rs = 0;
        let gs = 0;
        let bs = 0;
        let n = 0;
        // Colour is accumulated twice: once over every node, once over the dry
        // ones only. A facet the coast vector kept as land still overlaps water
        // nodes near the shore, and averaging the sea into it paints a blue
        // fringe along every beach.
        let dryRs = 0;
        let dryGs = 0;
        let dryBs = 0;
        let dryN = 0;
        const add = (x: number, y: number) => {
            const i = y * size + x;
            const cls = cover.classes[i];
            const r = cover.colors[i * 3];
            const g = cover.colors[i * 3 + 1];
            const b = cover.colors[i * 3 + 2];
            histogram[cls]++;
            rs += r;
            gs += g;
            bs += b;
            n++;
            if (cls !== TerrainClass.Water) {
                dryRs += r;
                dryGs += g;
                dryBs += b;
                dryN++;
            }
        };

        // Edge functions, once per facet. Sign-agnostic so winding does not
        // matter: a node is inside when all three have the same sign as the
        // facet's own area.
        const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
        const sign = area >= 0 ? 1 : -1;
        const x0 = Math.max(0, Math.ceil(Math.min(p0.x, p1.x, p2.x)));
        const x1 = Math.min(size - 1, Math.floor(Math.max(p0.x, p1.x, p2.x)));
        const y0 = Math.max(0, Math.ceil(Math.min(p0.y, p1.y, p2.y)));
        const y1 = Math.min(size - 1, Math.floor(Math.max(p0.y, p1.y, p2.y)));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const e0 = ((p1.x - p0.x) * (y - p0.y) - (x - p0.x) * (p1.y - p0.y)) * sign;
                const e1 = ((p2.x - p1.x) * (y - p1.y) - (x - p1.x) * (p2.y - p1.y)) * sign;
                const e2 = ((p0.x - p2.x) * (y - p2.y) - (x - p2.x) * (p0.y - p2.y)) * sign;
                if (e0 >= 0 && e1 >= 0 && e2 >= 0) {
                    add(x, y);
                }
            }
        }
        // A facet smaller than a cell can enclose no node at all. Its centroid
        // is inside it by definition, so that is the honest single sample.
        if (n === 0) {
            add(
                Math.min(size - 1, Math.max(0, Math.round((p0.x + p1.x + p2.x) / 3))),
                Math.min(size - 1, Math.max(0, Math.round((p0.y + p1.y + p2.y) / 3))),
            );
        }

        let best = TerrainClass.Unknown as number;
        let bestCount = -1;
        for (let c = 0; c < histogram.length; c++) {
            if (histogram[c] > bestCount) {
                bestCount = histogram[c];
                best = c;
            }
        }
        // The OSM coast vector already decided this facet is land, so a
        // landcover raster calling it open water is a disagreement between two
        // sources about where the shore is - not a reason to paint sea inland.
        if (best === TerrainClass.Water) {
            best = TerrainClass.Grass;
        }
        // WorldCover cannot tell dune from lava field. Proximity to the coast
        // can, and it is the one that reads from the air.
        if (best === TerrainClass.Bare) {
            const inland = Math.min(
                sampleInland(p0.x, p0.y), sampleInland(p1.x, p1.y), sampleInland(p2.x, p2.y),
            );
            if (inland <= SHORE_SAND_M) {
                best = TerrainClass.Sand;
            }
        }
        // A facet can be land by the coast vector and yet cover nothing but
        // water nodes - that is precisely the strip the two sources disagree
        // over, and it runs the length of every coastline. There is no dry
        // colour inside it to average, so widen the search rather than paint
        // the sea onto land.
        if (dryN === 0) {
            const bx0 = Math.max(0, x0 - DRY_SEARCH_CELLS);
            const bx1 = Math.min(size - 1, x1 + DRY_SEARCH_CELLS);
            const by0 = Math.max(0, y0 - DRY_SEARCH_CELLS);
            const by1 = Math.min(size - 1, y1 + DRY_SEARCH_CELLS);
            for (let y = by0; y <= by1; y++) {
                for (let x = bx0; x <= bx1; x++) {
                    const i = y * size + x;
                    if (cover.classes[i] === TerrainClass.Water) {
                        continue;
                    }
                    dryRs += cover.colors[i * 3];
                    dryGs += cover.colors[i * 3 + 1];
                    dryBs += cover.colors[i * 3 + 2];
                    dryN++;
                }
            }
        }
        const cr = dryN > 0 ? dryRs / dryN : rs / n;
        const cg = dryN > 0 ? dryGs / dryN : gs / n;
        const cb = dryN > 0 ? dryBs / dryN : bs / n;
        return [best, Math.round(cr), Math.round(cg), Math.round(cb)];
    };

    // Shore walls and skirts ask for the same facet's cover as the surface
    // triangle they hang from, once per edge. Resolve each triangle once.
    const facetCovers = new Map<GridTriangle, readonly [number, number, number, number]>();
    const coverOf = (t: GridTriangle): readonly [number, number, number, number] => {
        let c = facetCovers.get(t);
        if (!c) {
            c = classify(t.pts[0], t.pts[1], t.pts[2]);
            facetCovers.set(t, c);
        }
        return c;
    };

    const landPos: number[] = [];
    const landNrm: number[] = [];
    const landClass: number[] = [];
    const landColor: number[] = [];
    /** 9 per triangle; only encoded when regional ground colour is in use. */
    const landVertColor: number[] = [];

    const waterPos: number[] = [];
    const waterIdx: number[] = [];
    const waterTone: number[] = [];
    const waterKey = new Map<string, number>();

    const waterVertex = (gx: number, gy: number, tagged = false): number => {
        const key = gridKey(gx, gy);
        let idx = waterKey.get(key);
        if (idx !== undefined) {
            return idx;
        }
        const p = project(gx, gy, false, tagged);
        idx = waterPos.length / 3;
        waterPos.push(p.e - centre.e, p.u - centre.u, centre.n - p.n);
        waterKey.set(key, idx);
        return idx;
    };

    /**
     * `cover` is [class, r, g, b], as returned by classify. `t` is the source
     * facet, whose region may carry a real vector-cut landuse class that
     * overrides the raster vote in `facet[0]` - the colour still comes from
     * the raster either way, since the region layer carries no colour of its
     * own.
     */
    const pushLandTriangle = (
        a: Enu, b: Enu, c: Enu, facet: readonly [number, number, number, number], t: GridTriangle,
    ) => {
        const ax = a.e - centre.e, ay = a.u - centre.u, az = centre.n - a.n;
        const bx = b.e - centre.e, by = b.u - centre.u, bz = centre.n - b.n;
        const cx = c.e - centre.e, cy = c.u - centre.u, cz = centre.n - c.n;
        let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
        let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
        const len = Math.hypot(nx, ny, nz);
        if (len > 0) {
            nx /= len; ny /= len; nz /= len;
        } else {
            nx = 0; ny = 1; nz = 0;
        }
        // Terrain is drawn double-sided, but keep normals pointing up so the
        // fixed-sun shading is stable. "Up" is the tile's local vertical, not
        // the frame's y axis — see localUp above.
        if (nx * localUpX + ny * localUpY + nz * localUpZ < 0) {
            nx = -nx; ny = -ny; nz = -nz;
        }
        landPos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        landNrm.push(nx, ny, nz);
        // With regions, the mesh is untagged ground: the polygons are laid over
        // it below, so the raster's own class must not show between them.
        // With a regional sampler too, that ground is Ground, coloured per
        // vertex from the blended ~25 km² lattice so it has no tile seams.
        const ground = hasRegions && input.groundColorAt !== undefined;
        landClass.push(ground ? TerrainClass.Ground : hasRegions ? TerrainClass.Unknown : facet[0]);
        const flat: readonly [number, number, number] = hasRegions && baseColor
            ? baseColor
            : [facet[1], facet[2], facet[3]];
        landColor.push(flat[0], flat[1], flat[2]);
        for (const p of [a, b, c]) {
            let rgb = flat;
            if (ground) {
                const ecef = enuToEcef(basis, p);
                const geo = ecefToGeodetic(ecef.x, ecef.y, ecef.z);
                rgb = input.groundColorAt!(geo.lon, geo.lat) ?? flat;
            }
            landVertColor.push(rgb[0], rgb[1], rgb[2]);
        }
    };

    /**
     * The tagged landuse region owning most of a facet's nodes, on a tile too
     * coarse for exact fills. Undefined when the winner is untagged.
     *
     * Same node walk as `classify`: every node inside the facet, or its
     * centroid when it encloses none. The polygons are still what colour the
     * ground here - only their edges give way, to the facet grid.
     */
    const landuseVote = (t: GridTriangle): number | undefined => {
        if (!landuseField || landuseDetail) {
            return undefined;
        }
        const [p0, p1, p2] = t.pts;
        const votes = new Map<number, number>();
        const add = (x: number, y: number) => {
            const id = landuseField.regionNodes[y * size + x];
            votes.set(id, (votes.get(id) ?? 0) + 1);
        };
        const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
        const sign = area >= 0 ? 1 : -1;
        const x0 = Math.max(0, Math.ceil(Math.min(p0.x, p1.x, p2.x)));
        const x1 = Math.min(size - 1, Math.floor(Math.max(p0.x, p1.x, p2.x)));
        const y0 = Math.max(0, Math.ceil(Math.min(p0.y, p1.y, p2.y)));
        const y1 = Math.min(size - 1, Math.floor(Math.max(p0.y, p1.y, p2.y)));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const e0 = ((p1.x - p0.x) * (y - p0.y) - (x - p0.x) * (p1.y - p0.y)) * sign;
                const e1 = ((p2.x - p1.x) * (y - p1.y) - (x - p1.x) * (p2.y - p1.y)) * sign;
                const e2 = ((p0.x - p2.x) * (y - p2.y) - (x - p2.x) * (p0.y - p2.y)) * sign;
                if (e0 >= 0 && e1 >= 0 && e2 >= 0) {
                    add(x, y);
                }
            }
        }
        if (votes.size === 0) {
            add(
                Math.min(size - 1, Math.max(0, Math.round((p0.x + p1.x + p2.x) / 3))),
                Math.min(size - 1, Math.max(0, Math.round((p0.y + p1.y + p2.y) / 3))),
            );
        }
        let best = -1;
        let bestN = 0;
        for (const [id, n] of votes) {
            if (n > bestN) {
                best = id;
                bestN = n;
            }
        }
        return best >= 0 && landuseField.regionTable[best].landuseClass !== undefined ? best : undefined;
    };

    for (const t of tris) {
        const [p0, p1, p2] = t.pts;
        if (isLandTriangle(t)) {
            const cover = coverOf(t);
            pushLandTriangle(
                project(p0.x, p0.y, true, p0.shore),
                project(p1.x, p1.y, true, p1.shore),
                project(p2.x, p2.y, true, p2.shore),
                cover,
                t,
            );
            const voted = landuseVote(t);
            if (voted !== undefined) {
                // Coarse tile: the polygon colours the whole facet, as the
                // fill would have at a finer zoom.
                landClass[landClass.length - 1] = landuseField!.regionTable[voted].landuseClass!;
                const rgb = regionColors?.[voted] ?? [cover[1], cover[2], cover[3]];
                landColor.splice(landColor.length - 3, 3, rgb[0], rgb[1], rgb[2]);
                landVertColor.splice(landVertColor.length - 9, 9,
                    rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
            }
        } else {
            const shore = Math.min(
                sampleDist(p0.x, p0.y),
                sampleDist(p1.x, p1.y),
                sampleDist(p2.x, p2.y),
            );
            waterIdx.push(
                waterVertex(p0.x, p0.y, p0.shore),
                waterVertex(p1.x, p1.y, p1.shore),
                waterVertex(p2.x, p2.y, p2.shore),
            );
            waterTone.push(
                shore <= SHALLOW_WATER_COAST_M ? TerrainTone.ShallowWater : TerrainTone.Water,
            );
        }
    }

    /**
     * A landuse ring in grid space, simplified for this zoom. Undefined when
     * it is too small to draw at all.
     */
    const landuseRing = (ring: LonLat[]): GridPoint[] | undefined => {
        const flat = new Float64Array(ring.length * 2);
        for (let i = 0; i < ring.length; i++) {
            flat[i * 2] = ((ring[i].lon - bounds.west) / lonSpan) * cells;
            flat[i * 2 + 1] = ((bounds.north - ring[i].lat) / latSpan) * cells;
        }
        const pts = simplifyRing(flat, leafZoom ? LANDUSE_LEAF_SIMPLIFY_CELLS : LANDUSE_SIMPLIFY_CELLS);
        const n = pts.length / 2;
        let area2 = 0;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            area2 += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
        }
        if (Math.abs(area2) / 2 < LANDUSE_MIN_RING_AREA_CELLS) {
            return undefined;
        }
        const out: GridPoint[] = [];
        for (let i = 0; i < n; i++) {
            out.push({ x: pts[i * 2], y: pts[i * 2 + 1] });
        }
        return out;
    };

    // Landuse fill: each tagged polygon clipped to the land facets it lies on
    // and lifted a hair off them, so it follows the drawn surface exactly and
    // its edge sits where OSM has it. See landuseFill.ts.
    const surfaceLandTriangles = landClass.length;
    if (landuseDetail) {
        // Below the strokes' own lift (RIVER_LIFT_CELLS), so an outline or a
        // river crossing a field still draws over the fill. The fill is
        // appended after the facets it covers, so it also wins any depth tie.
        const FILL_LIFT_CELLS = 0.02;
        const liftM = metresPerCell * FILL_LIFT_CELLS;
        const tagged = input.regions!
            .map((region, index) => ({ region, index }))
            .filter(({ region }) => region.isLand && region.landuseClass !== undefined);
        const landTris = tris.filter(isLandTriangle);
        const pieces = landuseFill(
            landTris.map(t => t.pts),
            tagged.map(({ region }) => ({
                exterior: landuseRing(region.exterior) ?? [],
                holes: region.holes.map(landuseRing).filter((h): h is GridPoint[] => h !== undefined),
            })),
            cells,
        );
        for (const piece of pieces) {
            const facet = landTris[piece.facet];
            const [f0, f1, f2] = facet.pts;
            const det = (f1.y - f2.y) * (f0.x - f2.x) + (f2.x - f1.x) * (f0.y - f2.y);
            if (Math.abs(det) < 1e-12) {
                continue;
            }
            const e0 = project(f0.x, f0.y, true, f0.shore);
            const e1 = project(f1.x, f1.y, true, f1.shore);
            const e2 = project(f2.x, f2.y, true, f2.shore);
            // On the facet's own plane, then up along the tile's vertical. The
            // tile writes n reversed (z = centre.n - n), hence the minus.
            const onFacet = (p: GridPoint): Enu => {
                const l0 = ((f1.y - f2.y) * (p.x - f2.x) + (f2.x - f1.x) * (p.y - f2.y)) / det;
                const l1 = ((f2.y - f0.y) * (p.x - f2.x) + (f0.x - f2.x) * (p.y - f2.y)) / det;
                const l2 = 1 - l0 - l1;
                return {
                    e: e0.e * l0 + e1.e * l1 + e2.e * l2 + localUpX * liftM,
                    u: e0.u * l0 + e1.u * l1 + e2.u * l2 + localUpY * liftM,
                    n: e0.n * l0 + e1.n * l1 + e2.n * l2 - localUpZ * liftM,
                };
            };
            const { region, index } = tagged[piece.region];
            const cover = coverOf(facet);
            pushLandTriangle(onFacet(piece.pts[0]), onFacet(piece.pts[1]), onFacet(piece.pts[2]), cover, facet);
            // pushLandTriangle painted it as untagged ground; this is the polygon.
            landClass[landClass.length - 1] = region.landuseClass!;
            const rgb = regionColors?.[index] ?? [cover[1], cover[2], cover[3]];
            landColor.splice(landColor.length - 3, 3, rgb[0], rgb[1], rgb[2]);
            // A polygon fills evenly: its own colour at every vertex, not the
            // regional ground blend pushLandTriangle sampled for it.
            landVertColor.splice(landVertColor.length - 9, 9,
                rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
        }
    }

    const fillTriangles = landClass.length - surfaceLandTriangles;

    // Skirts: every triangle edge lying on the tile border belongs to exactly
    // one triangle, so each becomes one skirt quad hanging below the surface.
    const onBorder = (p: { x: number; y: number }) =>
        p.x === 0 || p.y === 0 || p.x === cells || p.y === cells;
    const sameBorder = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        (a.x === 0 && b.x === 0) || (a.x === cells && b.x === cells)
        || (a.y === 0 && b.y === 0) || (a.y === cells && b.y === cells);

    // Shore walls. Land keeps its DEM height while water sits on its own
    // surface, so wherever they meet there is a vertical step — often large,
    // because OSM coastlines and the DEM disagree about where the shore is.
    // Closing it by moving terrain destroys real geography; closing it with a
    // wall does not.
    //
    // A land triangle edge whose *both* ends are shoreline points is exactly a
    // shore chord, so drop a quad from it to the water surface below. Inland
    // that step is usually small — a lake is measured against its own shore —
    // and the "nothing to close" test below drops the wall entirely.
    for (const t of tris) {
        if (!isLandTriangle(t)) {
            continue;
        }
        for (let e = 0; e < 3; e++) {
            const a = t.pts[e];
            const b = t.pts[(e + 1) % 3];
            if (!canWall(t, a, b) || !isShore(a.x, a.y, a.shore) || !isShore(b.x, b.y, b.shore)) {
                continue;
            }
            const topA = project(a.x, a.y, true, a.shore);
            const topB = project(b.x, b.y, true, b.shore);
            const botA = projectWaterSurface(a.x, a.y);
            const botB = projectWaterSurface(b.x, b.y);
            // Nothing to close where the land already meets the water.
            if (Math.abs(topA.u - botA.u) < 0.1 && Math.abs(topB.u - botB.u) < 0.1) {
                continue;
            }
            // A wall is the cut face of the facet above it, so it wears that
            // facet's cover rather than a colour of its own.
            const facet = coverOf(t);
            pushLandTriangle(topA, topB, botB, facet, t);
            pushLandTriangle(topA, botB, botA, facet, t);
        }
    }

    const wallTriangles = landClass.length - surfaceLandTriangles - fillTriangles;
    const waterBeforeSkirts = waterTone.length;

    // Skirts hang along the local vertical, which means re-projecting the
    // vertex at a lower geodetic height — not subtracting from its ENU u.
    //
    // The ENU frame is built once, at the play origin, and the whole planet is
    // laid out in it. Its u axis is local up only near that origin. Measured on
    // a Grand Canyon tile, 9000 km away, subtracting skirtDepthM from u moved
    // the vertex 34 m down and 174 m sideways — the skirt was flung across nine
    // cells of terrain instead of hanging under the tile edge it seals.
    const skirt = input.skirtDepthM;
    for (const t of tris) {
        for (let e = 0; e < 3; e++) {
            const a = t.pts[e];
            const b = t.pts[(e + 1) % 3];
            if (!onBorder(a) || !onBorder(b) || !sameBorder(a, b)) {
                continue;
            }
            if (isLandTriangle(t)) {
                const topA = project(a.x, a.y, true, false, SKIRT_TOP_EPS_M);
                const topB = project(b.x, b.y, true, false, SKIRT_TOP_EPS_M);
                const botA = project(a.x, a.y, true, false, skirt);
                const botB = project(b.x, b.y, true, false, skirt);
                const facet = coverOf(t);
                pushLandTriangle(topA, topB, botB, facet, t);
                pushLandTriangle(topA, botB, botA, facet, t);
            } else {
                const ia = waterVertex(a.x, a.y);
                const ib = waterVertex(b.x, b.y);
                const key = (gx: number, gy: number) => `skirt:${gx.toFixed(4)},${gy.toFixed(4)}`;
                const bottom = (gx: number, gy: number): number => {
                    const k = key(gx, gy);
                    let idx = waterKey.get(k);
                    if (idx !== undefined) {
                        return idx;
                    }
                    const p = project(gx, gy, false, false, skirt);
                    idx = waterPos.length / 3;
                    // z is South, not North — see the PTM1 layout in ptm.ts.
                    waterPos.push(p.e - centre.e, p.u - centre.u, centre.n - p.n);
                    waterKey.set(k, idx);
                    return idx;
                };
                const ja = bottom(a.x, a.y);
                const jb = bottom(b.x, b.y);
                const shore = Math.min(sampleDist(a.x, a.y), sampleDist(b.x, b.y));
                const tone = shore <= SHALLOW_WATER_COAST_M
                    ? TerrainTone.ShallowWater
                    : TerrainTone.Water;
                waterIdx.push(ia, ib, jb);
                waterTone.push(tone);
                waterIdx.push(ia, jb, ja);
                waterTone.push(tone);
            }
        }
    }

    const skirtTriangles = landClass.length - surfaceLandTriangles - fillTriangles - wallTriangles
        + waterTone.length - waterBeforeSkirts;
    const waterSheetTriangles = waterBeforeSkirts;

    // --- 6b. watercourse strokes ------------------------------------------
    //
    // Rivers and canals are drawn as a stroke over the surface rather than cut
    // into it, because a cut cannot carry them: the shoreline cut samples the
    // node grid, and a 12 m canal is under one cell at Potsdam z12 and a fifth
    // of one at z10. Widening it until the grid could hold it was tried and is
    // the wrong trade — a canal has to read from 20 km and be no wider than it
    // is from 200 m, and no single width in metres is both.
    //
    // So the geometry baked here is the *true* width, and the minimum is left
    // to the renderer, which knows how many pixels the offset came out as. See
    // RiverVertProgram.
    //
    // Two vertices per centreline point, sharing a position and carrying
    // opposite unit offsets: the shader is what turns them into a ribbon, so
    // the ribbon's width is not baked into the positions at all.
    const riverPos: number[] = [];
    const riverDir: number[] = [];
    const riverHalf: number[] = [];
    const riverIdx: number[] = [];
    /** PTM_STROKE_KIND_* per vertex: watercourse or landuse outline. */
    const riverKind: number[] = [];

    /**
     * The finished triangles, bucketed by grid cell.
     *
     * A stroke has to sit on the surface that is *drawn*, not on the DEM it
     * came from, and those are not the same surface: the interior is decimated
     * to a vertical tolerance which is 1 m at z12 and 529 m at z10. Draped on
     * the DEM, a stroke would be buried under half a kilometre of simplified
     * hillside on a coarse tile.
     *
     * Built only for a tile that has a watercourse on it, which is a small
     * minority of them.
     */
    const surfaceBuckets = new Map<number, number[]>();
    // Only a tagged land region has an edge worth drawing: untagged land is
    // just "not mapped", and water already has a shoreline of its own.
    const outlineRegions = landuseDetail
        ? (input.regions ?? []).filter(r => r.isLand && r.landuseClass !== undefined)
        : [];
    if ((input.watercourses?.length ?? 0) > 0 || outlineRegions.length > 0) {
        for (let t = 0; t < tris.length; t++) {
            const [a, b, c] = tris[t].pts;
            const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
            const x1 = Math.min(cells - 1, Math.floor(Math.max(a.x, b.x, c.x)));
            const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
            const y1 = Math.min(cells - 1, Math.floor(Math.max(a.y, b.y, c.y)));
            for (let row = y0; row <= y1; row++) {
                for (let col = x0; col <= x1; col++) {
                    const key = row * cells + col;
                    const list = surfaceBuckets.get(key);
                    if (list) {
                        list.push(t);
                    } else {
                        surfaceBuckets.set(key, [t]);
                    }
                }
            }
        }
    }

    /**
     * The drawn surface at a grid point, or undefined where nothing covers it.
     *
     * The highest of the triangles containing the point, because land and water
     * overlap along the shoreline and a stroke crossing it belongs on top of
     * whichever is uppermost — a canal running into a lake must not dive under
     * the lake's surface at the join.
     */
    const surfaceAt = (gx: number, gy: number): Enu | undefined => {
        const col = Math.min(cells - 1, Math.max(0, Math.floor(gx)));
        const row = Math.min(cells - 1, Math.max(0, Math.floor(gy)));
        // The cell the point is in, then its neighbours. Defensive rather
        // than measured — the Potsdam bake misses none — but a miss is not a
        // cheap failure: it drops the stroke back onto the DEM, which on a
        // coarse tile is hundreds of metres under the surface being drawn. The
        // ring is what covers a centreline clipped to the tile border, where
        // the conversion back into grid space can land outside the cell that
        // holds the triangle.
        const candidates: number[] = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const cx = col + dx;
                const cy = row + dy;
                if (cx < 0 || cy < 0 || cx >= cells || cy >= cells) {
                    continue;
                }
                const list = surfaceBuckets.get(cy * cells + cx);
                if (list !== undefined) {
                    candidates.push(...list);
                }
            }
        }
        if (candidates.length === 0) {
            return undefined;
        }
        let best: Enu | undefined;
        let bestUp = -Infinity;
        // Generous on the barycentric test for the same reason: a point a
        // rounding error outside its triangle belongs on it, not under it.
        const EDGE_EPS = 1e-4;
        for (const t of candidates) {
            const tri = tris[t];
            const [p0, p1, p2] = tri.pts;
            const det = (p1.y - p2.y) * (p0.x - p2.x) + (p2.x - p1.x) * (p0.y - p2.y);
            if (Math.abs(det) < 1e-12) {
                continue;
            }
            const l0 = ((p1.y - p2.y) * (gx - p2.x) + (p2.x - p1.x) * (gy - p2.y)) / det;
            const l1 = ((p2.y - p0.y) * (gx - p2.x) + (p0.x - p2.x) * (gy - p2.y)) / det;
            const l2 = 1 - l0 - l1;
            if (l0 < -EDGE_EPS || l1 < -EDGE_EPS || l2 < -EDGE_EPS) {
                continue;
            }
            const triIsLand = isLandTriangle(tri);
            const a = project(p0.x, p0.y, triIsLand, p0.shore);
            const b = project(p1.x, p1.y, triIsLand, p1.shore);
            const c = project(p2.x, p2.y, triIsLand, p2.shore);
            const hit = {
                e: a.e * l0 + b.e * l1 + c.e * l2,
                n: a.n * l0 + b.n * l1 + c.n * l2,
                u: a.u * l0 + b.u * l1 + c.u * l2,
            };
            // "Highest" along the tile's own vertical, not the frame's y: see
            // localUp above for why the two part company far from the origin.
            const up = (hit.e - centre.e) * localUpX
                + (hit.u - centre.u) * localUpY
                + (centre.n - hit.n) * localUpZ;
            if (up > bestUp) {
                bestUp = up;
                best = hit;
            }
        }
        return best;
    };

    // How far a stroke floats above the surface it lies on.
    //
    // Coplanar is not good enough: the stroke and the facet under it are
    // projected by different vertex programs, so their depths differ by noise
    // and the pair speckles. A twentieth of a cell is far below anything
    // visible at the scale the tile is drawn at and far above that noise.
    const riverLiftM = metresPerCell * RIVER_LIFT_CELLS;

    type GridPoint = { x: number; y: number };
    // Clamped: a line was clipped to the tile in degrees, and the conversion
    // back can leave an endpoint a rounding error outside the grid it has to
    // be looked up in.
    const clampGrid = (v: number) => (v < 0 ? 0 : v > cells ? cells : v);
    const toGrid = (pt: { lon: number; lat: number }): GridPoint => ({
        x: clampGrid(((pt.lon - bounds.west) / lonSpan) * cells),
        y: clampGrid(((bounds.north - pt.lat) / latSpan) * cells),
    });
    // Resampled so the stroke follows the terrain. An OSM way can run straight
    // for kilometres between vertices, and a stroke hung off those two points
    // alone would fly over every valley in between.
    // Last segment that tested each facet, so a facet bucketed under many
    // cells is tested once per segment.
    const crossingStamp = new Int32Array(tris.length);
    let crossingSerial = 0;
    /** Every parameter in (0, 1) at which segment a-b crosses a facet edge. */
    const facetCrossings = (a: GridPoint, b: GridPoint): number[] | undefined => {
        const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x)));
        const x1 = Math.min(cells - 1, Math.floor(Math.max(a.x, b.x)));
        const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y)));
        const y1 = Math.min(cells - 1, Math.floor(Math.max(a.y, b.y)));
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > RIVER_MAX_SUBDIVISIONS) {
            return undefined;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
        const ts: number[] = [];
        const serial = ++crossingSerial;
        for (let row = y0; row <= y1; row++) {
            for (let col = x0; col <= x1; col++) {
                const list = surfaceBuckets.get(row * cells + col);
                if (list === undefined) {
                    continue;
                }
                for (const t of list) {
                    if (crossingStamp[t] === serial) {
                        continue;
                    }
                    crossingStamp[t] = serial;
                    const q = tris[t].pts;
                    if (Math.min(q[0].x, q[1].x, q[2].x) > maxX || Math.max(q[0].x, q[1].x, q[2].x) < minX
                        || Math.min(q[0].y, q[1].y, q[2].y) > maxY || Math.max(q[0].y, q[1].y, q[2].y) < minY) {
                        continue;
                    }
                    for (let e = 0; e < 3; e++) {
                        const q0 = q[e];
                        const q1 = q[(e + 1) % 3];
                        const ex = q1.x - q0.x;
                        const ey = q1.y - q0.y;
                        const denom = dx * ey - dy * ex;
                        if (Math.abs(denom) < 1e-12) {
                            continue;
                        }
                        const u = ((q0.x - a.x) * ey - (q0.y - a.y) * ex) / denom;
                        const v = ((q0.x - a.x) * dy - (q0.y - a.y) * dx) / denom;
                        if (u > 1e-6 && u < 1 - 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) {
                            ts.push(u);
                        }
                    }
                }
            }
        }
        ts.sort((p, q) => p - q);
        const out: number[] = [];
        for (const u of ts) {
            if (out.length === 0 || u - out[out.length - 1] > 1e-6) {
                out.push(u);
            }
        }
        return out;
    };

    /**
     * Samples a polyline where it crosses from one facet to the next.
     *
     * A stroke is draped on the drawn surface, and that surface is planar
     * inside a facet, so a straight segment needs a vertex only where it
     * leaves one facet for another: sampled there it lies on the surface
     * exactly. It used to be resampled every cell instead, which on Madeira
     * z12 turned 2.5k outline points per tile into 7.3k and 14k stroke
     * triangles - half the tile. Falls back to one sample per cell for a
     * segment too long to search, or a tile with no facets bucketed.
     */
    const resample = (pts: readonly GridPoint[]): GridPoint[] => {
        const grid: GridPoint[] = [];
        for (const p of pts) {
            const prev = grid[grid.length - 1];
            if (prev === undefined) {
                grid.push(p);
                continue;
            }
            const crossings = surfaceBuckets.size > 0 ? facetCrossings(prev, p) : undefined;
            if (crossings !== undefined) {
                for (const t of crossings) {
                    grid.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
                }
                grid.push(p);
                continue;
            }
            const steps = Math.min(
                RIVER_MAX_SUBDIVISIONS,
                Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / RIVER_SAMPLE_CELLS),
            );
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                grid.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t });
            }
        }
        return grid;
    };

    // Strokes are laid over the finished mesh and never counted against its
    // budget. The leaf level may fill the stream; a coarser tile is drawn from
    // far enough away that its strokes get the budget's worth of vertices and
    // no more, so a river-laced z9 tile cannot cost a z12's worth of ribbon.
    // Watercourses are pushed before outlines, so outlines are what give way.
    const strokeVertexCap = leafZoom
        ? PTM_MAX_RIVER_VERTS
        : Math.min(PTM_MAX_RIVER_VERTS, input.triangleBudget ?? PTM_MAX_RIVER_VERTS);
    /** Appends one stroke; false when it is degenerate or the stream is full. */
    const pushStroke = (grid: readonly GridPoint[], halfWidthM: number, kind: number): boolean => {
        if (grid.length < 2 || riverHalf.length + grid.length * 2 > strokeVertexCap) {
            return false;
        }
        const base = riverHalf.length;
        for (let i = 0; i < grid.length; i++) {
            // Tangent from the neighbours, so a bend gets the average of the
            // two segments meeting there and the ribbon does not kink open.
            const a = grid[Math.max(0, i - 1)];
            const b = grid[Math.min(grid.length - 1, i + 1)];
            const pa = project(a.x, a.y, true);
            const pb = project(b.x, b.y, true);
            let tx = (pb.e - pa.e);
            let ty = (pb.u - pa.u);
            let tz = (pa.n - pb.n);
            // Perpendicular in the tile's local horizontal plane: across the
            // flow, never up it, so the stroke lies on the ground.
            let px = ty * localUpZ - tz * localUpY;
            let py = tz * localUpX - tx * localUpZ;
            let pz = tx * localUpY - ty * localUpX;
            const plen = Math.hypot(px, py, pz);
            if (!(plen > 1e-6)) {
                // A zero-length segment: two OSM nodes at the same place.
                px = 1; py = 0; pz = 0;
            } else {
                px /= plen; py /= plen; pz /= plen;
            }
            const p = surfaceAt(grid[i].x, grid[i].y)
                ?? project(grid[i].x, grid[i].y, true);
            const ex = p.e - centre.e + localUpX * riverLiftM;
            const ey = p.u - centre.u + localUpY * riverLiftM;
            const ez = centre.n - p.n + localUpZ * riverLiftM;
            riverPos.push(ex, ey, ez, ex, ey, ez);
            riverDir.push(px, py, pz, -px, -py, -pz);
            riverHalf.push(halfWidthM, halfWidthM);
            riverKind.push(kind, kind);
        }
        for (let i = 0; i + 1 < grid.length; i++) {
            const l0 = base + i * 2;
            const r0 = l0 + 1;
            const l1 = l0 + 2;
            const r1 = l0 + 3;
            riverIdx.push(l0, r0, r1, l0, r1, l1);
        }
        return true;
    };

    let waterStrokeTriangles = 0;
    for (const course of input.watercourses ?? []) {
        if (course.widthM < WATERCOURSE_MIN_WIDTH_CELLS * metresPerCell) {
            continue;
        }
        const grid = resample(course.points.map(toGrid));
        if (pushStroke(grid, Math.max(0.5, course.widthM / 2), PTM_STROKE_KIND_WATER)) {
            waterStrokeTriangles += (grid.length - 1) * 2;
        }
    }

    // Landuse outlines, after every watercourse so a full stream drops field
    // edges rather than rivers. A ring is clipped to the tile, so part of it
    // runs along the tile border; stroking that would draw a grid of lines
    // over the world at every tile edge, so a run breaks wherever both ends of
    // a segment sit on the same border.
    const BORDER_EPS = 1e-6;
    const onSameBorder = (a: GridPoint, b: GridPoint): boolean =>
        (a.x <= BORDER_EPS && b.x <= BORDER_EPS)
        || (a.x >= cells - BORDER_EPS && b.x >= cells - BORDER_EPS)
        || (a.y <= BORDER_EPS && b.y <= BORDER_EPS)
        || (a.y >= cells - BORDER_EPS && b.y >= cells - BORDER_EPS);
    for (const region of outlineRegions) {
        for (const ring of [region.exterior, ...region.holes]) {
            const pts = landuseRing(ring);
            if (pts === undefined || pts.length < 2) {
                continue;
            }
            const first = pts[0];
            const last = pts[pts.length - 1];
            if (first.x !== last.x || first.y !== last.y) {
                pts.push(first);
            }
            let run: GridPoint[] = [pts[0]];
            for (let i = 1; i < pts.length; i++) {
                if (onSameBorder(pts[i - 1], pts[i])) {
                    pushStroke(resample(run), OUTLINE_HALF_WIDTH_M, PTM_STROKE_KIND_OUTLINE);
                    run = [pts[i]];
                } else {
                    run.push(pts[i]);
                }
            }
            pushStroke(resample(run), OUTLINE_HALF_WIDTH_M, PTM_STROKE_KIND_OUTLINE);
        }
    }

    // --- 7. encode ---------------------------------------------------------
    const tileHalfWidthM = Math.max(
        1,
        (lonSpan * 111320 * Math.cos(centreLat * Math.PI / 180)) / 2,
        (latSpan * 110540) / 2,
    );

    // What refining this tile would gain: the DEM's own child-detail loss
    // plus whatever the decimator gave up. The tolerance can be HUGE_ERROR_M
    // when only the coast fitted the budget, so it is clamped to the relief
    // actually present - nothing can be further off than that.
    const interiorErrM = Math.min(
        Number.isFinite(maxErrorM) ? maxErrorM : Infinity,
        maxH - minH,
    );
    const geometricErrorM = input.geometricErrorM + Math.max(0, interiorErrM);

    const bytes = encodePtm({
        id: input.id,
        centerHeightM,
        tileHalfWidthM,
        skirtDepthM: skirt,
        geometricErrorM,
        land: {
            positions: new Float32Array(landPos),
            faceNormals: new Float32Array(landNrm),
            classes: new Uint8Array(landClass),
            colors: new Uint8Array(landColor),
            vertexColors: hasRegions && input.groundColorAt ? new Uint8Array(landVertColor) : undefined,
        },
        water: {
            positions: new Float32Array(waterPos),
            indices: new Uint32Array(waterIdx),
            tones: new Uint8Array(waterTone),
        },
        rivers: {
            positions: new Float32Array(riverPos),
            directions: new Float32Array(riverDir),
            halfWidthsM: new Float32Array(riverHalf),
            indices: new Uint32Array(riverIdx),
            kinds: new Uint8Array(riverKind),
        },
    });

    return {
        bytes,
        triangleCount: landClass.length + waterTone.length + riverIdx.length / 3,
        landTriangles: landClass.length,
        waterTriangles: waterTone.length,
        riverTriangles: waterStrokeTriangles,
        fillTriangles,
        wallTriangles,
        skirtTriangles,
        waterSheetTriangles,
        maxErrorM,
        geometricErrorM,
        minLeafSize,
        attempts,
        collapsedVertices,
        meshTriangles,
        centerHeightM,
        landColors: new Uint8Array(landColor),
    };
}
