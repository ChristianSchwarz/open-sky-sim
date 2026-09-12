/** Screen-space error LOD policy and altitude helpers. */

import { COCKPIT_FAR, TERRAIN_VIEW_RANGE_M } from '../defs';
import { WGS84_A } from './geodesy';
import { approxTileEdgeMetres, TileKey } from './tiling';

/** Cap on mesh / camera range (m) — enough for LEO limb with margin. */
export const TERRAIN_VIEW_RANGE_MAX_M = 3_000_000;

/** Hide atmospheric sky billboard above this AGL (m). */
export const SPACE_SKY_ALTITUDE_M = 80_000;

/** Subtracted from the altitude zoom curve for inland / open-ocean tiles only. */
export const TERRAIN_ZOOM_OFFSET = 1;

/**
 * Target projected error in pixels before a tile is refined.
 *
 * Halved from 2, which refines each tile at twice the distance and brings the
 * finer level in well before it reaches the aircraft. At 2 px the mid-field sat
 * a level coarser than the altitude cap allowed, so terrain that could have
 * been drawn at z12 was drawn at z11 and read as flat blocks.
 *
 * This is the knob the frame-time governor scales against (see detailScaleFor),
 * so it is a target rather than a promise: if the frame budget cannot carry the
 * extra tiles the governor multiplies it back up and the detail recedes again.
 */
export const SSE_TARGET_PX = 1;

/**
 * How much earlier the leaf level comes in than screen-space error alone
 * would bring it.
 *
 * The leaf is the only level that carries the exact OSM landuse fills and
 * their outlines (tools/bake/buildTile.ts, LANDUSE_DETAIL_MIN_ZOOM); one
 * level up the same polygons are only a vote on the facet colour, so the
 * z11-to-z12 switch is where fields and towns pop into view. At 1 px of
 * error that switch sat close enough to the aircraft to read as a wave of
 * detail arriving just ahead of it. Multiplying the parent's error by this
 * moves the switch out by the same factor in distance, and touches nothing
 * else: no other level's cut moves, and the governor still scales on top.
 */
export const LEAF_REFINE_DISTANCE_SCALE = 1.5;
/** Range of the *Land-use detail reach* slider: 1 is no bias at all. */
export const LEAF_REFINE_DISTANCE_SCALE_MIN = 1;
export const LEAF_REFINE_DISTANCE_SCALE_MAX = 10;

export function clampLeafRefineScale(value: number): number {
    if (!Number.isFinite(value)) return LEAF_REFINE_DISTANCE_SCALE;
    return Math.min(LEAF_REFINE_DISTANCE_SCALE_MAX, Math.max(LEAF_REFINE_DISTANCE_SCALE_MIN, value));
}

/**
 * Distance (m) past which terrain is allowed to coarsen faster than screen
 * space alone would coarsen it.
 *
 * Screen-space error already falls with distance — a tile twice as far has half
 * the projected error — so the far field refines less than the near field
 * without any help. It still costs far more than it is worth: error falls
 * as 1/d while the *number* of tiles in a ring grows with d, so the ring at
 * 40 km carries more triangles than everything inside 10 km put together while
 * covering a few dozen rows of pixels above the horizon.
 *
 * Past this knee the error budget grows in proportion to distance, so the
 * allowed error goes as d² rather than d and each doubling of distance drops
 * one more level. Inside it nothing changes at all: this is a far-field knob
 * and it must not touch the ground the aircraft is actually over.
 *
 * The default is a compromise for a cockpit view; the *Terrain detail distance*
 * setting moves it, and the top of that slider is {@link DETAIL_DISTANCE_OFF}.
 */
export const TERRAIN_DETAIL_DISTANCE_DEFAULT_M = 12_000;
export const TERRAIN_DETAIL_DISTANCE_MIN_M = 2_000;
export const TERRAIN_DETAIL_DISTANCE_MAX_M = 40_000;

/**
 * Slider position meaning "no far-field falloff at all".
 *
 * A number rather than a null so the whole setting stays one scalar from the
 * options panel down to {@link detailFalloff}, which is the only place that
 * has to know this value is special.
 */
export const DETAIL_DISTANCE_OFF = Infinity;

/**
 * Extra error budget for a tile at `distanceM`, given the falloff knee.
 *
 * 1 inside the knee, growing linearly outside it. Multiplied into the same
 * detail scale the frame-time governor uses, so the two compose: a governor
 * that has backed off 2x and a tile 3 knees out is drawn to 6x the error.
 */
export function detailFalloff(distanceM: number, kneeM: number): number {
    if (!(kneeM > 0)) {
        return 1;
    }
    return Math.max(1, distanceM / kneeM);
}

/** Clamp a persisted or user-supplied detail distance onto the slider's range. */
export function clampDetailDistanceM(value: number): number {
    if (!Number.isFinite(value)) {
        return DETAIL_DISTANCE_OFF;
    }
    if (value >= TERRAIN_DETAIL_DISTANCE_MAX_M) {
        return DETAIL_DISTANCE_OFF;
    }
    return Math.max(TERRAIN_DETAIL_DISTANCE_MIN_M, value);
}

/** LOD reconcile cadence; rendering stays per-frame. */
export const RECONCILE_INTERVAL_MS = 100;

/** Frame-time target for the detail governor (~40 FPS). */
export const TARGET_FRAME_MS = 25;

export const DETAIL_SCALE_MIN = 1;

/**
 * Ceiling on how far the frame-time governor may back off.
 *
 * This is a *detail* knob, and past a point backing off further stops
 * buying frame time -- the draw list is already down to a few dozen tiles --
 * while the terrain visibly coarsens and then re-refines on every camera or
 * aircraft move. At 24 the governor could switch LOD off outright: the SSE
 * target became 48 px and ~37 tiles were drawn where ~114 belong, which reads
 * as terrain streaming in as you fly rather than simply being there.
 */
export const DETAIL_SCALE_MAX = 4;

/**
 * Hard ceiling on triangles actually added to the terrain draw group, applied
 * in the camera's own draw order (nearest first) after the SSE/detailScale
 * governor has already run.
 *
 * The governor bounds screen-space error, not total triangle count: over
 * sufficiently complex baked terrain (a mountainous coastline, say) even
 * DETAIL_SCALE_MAX backoff can still leave the draw list at a triangle count
 * no frame budget survives, because backing off the *error target* only
 * shrinks that terrain's tile count by a few dozen percent, not the order of
 * magnitude a pathological view needs. This is the safety valve underneath
 * it: once spent, the (already farthest, already least-refined) remainder of
 * the draw list for this frame is simply not added, trading a gap at the
 * view's far edge for keeping the frame anywhere near playable. Sized well
 * above what any ordinary flight profile draws (a few hundred K triangles),
 * so it is not expected to engage outside that kind of pathological case.
 */
export const TERRAIN_TRIANGLE_BUDGET = 600_000;
/** Range of the *Terrain triangle cap* slider. */
export const TERRAIN_TRIANGLE_BUDGET_MIN = 200_000;
export const TERRAIN_TRIANGLE_BUDGET_MAX = 4_000_000;

export function clampTriangleBudget(value: number): number {
    if (!Number.isFinite(value)) return TERRAIN_TRIANGLE_BUDGET;
    return Math.min(TERRAIN_TRIANGLE_BUDGET_MAX, Math.max(TERRAIN_TRIANGLE_BUDGET_MIN, Math.round(value)));
}

/**
 * Per-frame GPU upload budget. Tile sizes vary far too much for a fixed count
 * to mean anything, so the streamer paces by time instead.
 */
export const TILE_UPLOAD_BUDGET_MS = 4;

/** Adaptive fetch concurrency bounds. */
export const STREAM_CONCURRENCY_MIN = 6;
export const STREAM_CONCURRENCY_MAX = 32;

/** How far ahead along the camera's view direction to prefetch (seconds). */
export const PREFETCH_LOOKAHEAD_S = 4;

/**
 * Prefetch at least this far ahead, however slowly the camera is moving.
 * Without a floor a camera that only turns — an exterior view orbiting the
 * aircraft — would prefetch nothing at all.
 */
export const PREFETCH_MIN_DISTANCE_M = 3000;

/**
 * Fastest the view can swing, in rad/s. Matches the numpad orbit rate, which
 * is the quickest way to move the camera relative to the world.
 */
const MAX_VIEW_TURN_RATE_RAD_S = Math.PI;

/**
 * Angular slack added to the culling frustum.
 *
 * The draw list is rebuilt once per {@link RECONCILE_INTERVAL_MS} and culled
 * exactly to the frustum, so a camera that turns during that window sweeps
 * screen edges the last pass had no reason to keep -- and they render as
 * nothing until the next reconcile catches up. Widening the test by rather
 * more than one interval's worth of rotation means the rim is already drawn
 * when the edge reaches it. The extra band costs draw calls, so it is sized
 * from the actual worst-case turn rate rather than picked by eye.
 */
export const FRUSTUM_CULL_MARGIN_RAD =
    MAX_VIEW_TURN_RATE_RAD_S * (RECONCILE_INTERVAL_MS / 1000) * 1.2;

/** Precomputed, since it multiplies a distance on every node visit. */
export const FRUSTUM_CULL_MARGIN_TAN = Math.tan(FRUSTUM_CULL_MARGIN_RAD);

/** Mesh cache ceiling in bytes. Tiles are evicted least-recently-drawn first. */
export const MESH_CACHE_BYTES = 256 * 1024 * 1024;

/** Geometric horizon distance (m) for a spherical Earth of radius `radiusM`. */
export function geometricHorizonDistanceM(altitudeM: number, radiusM: number = WGS84_A): number {
    const h = Math.max(0, altitudeM);
    return Math.sqrt(Math.max(0, 2 * radiusM * h + h * h));
}

/** Terrain mesh / QT near-range for this camera altitude (m). */
export function terrainViewRangeM(altitudeM: number): number {
    const horizon = geometricHorizonDistanceM(altitudeM) * 1.15;
    return Math.min(TERRAIN_VIEW_RANGE_MAX_M, Math.max(TERRAIN_VIEW_RANGE_M, horizon));
}

/**
 * Raise the camera far plane with altitude so the planetary limb stays in
 * range. Floor is {@link COCKPIT_FAR}; ceiling matches the view-range cap.
 */
export function cameraFarForAltitudeM(altitudeM: number): number {
    return Math.max(COCKPIT_FAR, terrainViewRangeM(altitudeM) * 1.05);
}

/**
 * Dense altitude→zoom anchors used as a hard refinement cap on top of SSE.
 * Prevents the QT from exploding to native zoom when looking straight down
 * from LEO, where every tile's SSE looks large because d is large but the
 * screen footprint is tiny only after projection — the cap is the safety net.
 */
const ZOOM_ALTITUDE_ANCHORS_M: ReadonlyArray<readonly [number, number]> = [
    // Leaf tiles stay allowed to ~10 km (the curve rounds, so 11.5 is the
    // edge). They used to drop out above 2.5 km, which silently overrode the
    // land-use reach setting: the leaf is the only level with the exact
    // fills, and no distance bias can bring in a level the cap forbids. The
    // triangle budget and the governor bound the cost of the extra tiles.
    [0, 12],
    [6_000, 12],
    [15_000, 11],
    [22_000, 10],
    [35_000, 8],
    [55_000, 7],
    [80_000, 6],
    [120_000, 5],
    [200_000, 4.5],
    [400_000, 4],
];

export function terrainZoomCurveForAltitudeM(altitudeM: number): number {
    const h = Math.max(0, altitudeM);
    const anchors = ZOOM_ALTITUDE_ANCHORS_M;
    if (h <= anchors[0][0]) {
        return anchors[0][1];
    }
    for (let i = 1; i < anchors.length; i++) {
        const [h1, z1] = anchors[i - 1];
        const [h2, z2] = anchors[i];
        if (h <= h2) {
            const t = (h - h1) / (h2 - h1);
            return z1 + (z2 - z1) * t;
        }
    }
    return anchors[anchors.length - 1][1];
}

export function terrainMaxZoomForAltitudeM(
    altitudeM: number,
    absoluteMax: number,
    coastal: boolean = false,
): number {
    const z = Math.round(terrainZoomCurveForAltitudeM(altitudeM));
    const capped = Math.min(absoluteMax, Math.max(0, z));
    if (coastal) {
        return capped;
    }
    return Math.max(0, capped - TERRAIN_ZOOM_OFFSET);
}

/**
 * Climb faster than it recovers, but not by so much that a transient sticks.
 *
 * The old pair (+6% / -1.5%, recovering only below 0.82x target) was a 4x
 * asymmetry on top of a 24x range: a spike that took five seconds to build
 * took over twenty to unwind, and the dead band was wide enough that ordinary
 * frame-time jitter stalled recovery altogether. The governor therefore spent
 * most of its time backed off, which is a quality regression the frame budget
 * was never actually asking for.
 */
const DETAIL_CLIMB = 1.06;
const DETAIL_DECAY = 0.96;

export function adjustDetailScale(
    current: number,
    frameEmaMs: number,
    targetMs: number = TARGET_FRAME_MS,
): number {
    let next = current;
    if (frameEmaMs > targetMs * 1.08) {
        next = current * DETAIL_CLIMB;
    } else if (frameEmaMs < targetMs * 0.9) {
        next = current * DETAIL_DECAY;
    }
    return Math.min(DETAIL_SCALE_MAX, Math.max(DETAIL_SCALE_MIN, next));
}

/**
 * Ellipsoid sagitta (m) for a tile with no DEM: how far the chord between the
 * tile corners sits below the ellipsoid surface. Used as geometricError so the
 * globe stays round from orbit and stops subdividing over open ocean.
 */
export function ellipsoidSagittaM(id: TileKey): number {
    const arc = approxTileEdgeMetres(id);
    return (arc * arc) / (8 * WGS84_A);
}

/**
 * Projected screen-space error in pixels.
 * `geometricErrorM` is a world-space metres bound (tile geometric error or sagitta).
 */
export function screenSpaceErrorPx(
    geometricErrorM: number,
    distanceM: number,
    screenHeightPx: number,
    fovYDeg: number,
): number {
    const d = Math.max(1, distanceM);
    return geometricErrorM * screenHeightPx / (2 * d * Math.tan(fovYDeg * Math.PI / 360));
}

/** True when the tile should split into its four children. */
export function shouldRefine(
    geometricErrorM: number,
    distanceM: number,
    screenHeightPx: number,
    fovYDeg: number,
    detailScale: number = 1,
    targetPx: number = SSE_TARGET_PX,
): boolean {
    return screenSpaceErrorPx(geometricErrorM, distanceM, screenHeightPx, fovYDeg)
        > targetPx * detailScale;
}
