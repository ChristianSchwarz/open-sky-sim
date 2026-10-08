/**
 * Bake bridge geometry sidecars (.pbr) from the finished mesh tree and the
 * bridge spans tools/bake_osm_roads.py wrote.
 *
 * For every leaf mesh tile that has a .rbr beside its .pdm, reads the .ptm,
 * plans each span's deck and piers over the drawn surface
 * (tools/bake/bridges.ts), builds the triangles (tools/bake/bridgeMesh.ts)
 * and writes one gzip-compressed PBR1 beside the mesh, plus
 * index_bridges.bin and a `bridges` block in the manifest. A tile with no
 * spans gets no sidecar, and a stale one is dropped.
 *
 * Runs after the mesh bake and the road bake and reads only what they wrote,
 * so like the road strokes it can be re-tuned without touching a mesh.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_bridges.ts [options]
 *
 *     --dir DIR        the mesh tree, read and written   (default assets/terrain)
 *     --src DIR        the planet pyramid with the .rbr  (default assets/planet)
 *     --bbox w,s,e,n   only tiles in this box; the index is merged with what
 *                      is there
 *     --lidar-store DIR the lidar store (default data/imports/lidar/store,
 *                      tools/measure_lidar.py): a span's ends stand at the
 *                      approaches measured there, where it has them
 *     --no-lidar       ignore the store
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef, makeEnuBasis } from '../src/script/terrain/geodesy';
import { assertUngradedPtm, decodePtm, isPtmGraded } from '../src/script/terrain/ptm';

let warnedGraded = false;
import { tileBounds } from '../src/script/terrain/tiling';
import { BridgeRole, PBR_BOX_FLOATS, PBR_MAX_VERTS, PBR_RAMP_FLOATS, PBR_TIER_SHIFT, encodePbr, PBR_ROAD_END_FLOATS } from '../src/script/terrain/pbr';
import { ROAD_SIDE_BIT, RoadClass, isRailClass, isZoneClass } from '../src/script/terrain/ptr';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { boundsOf } from './bake/coverTex';
import { buildJoinMesh, findJoins, openJoinedSides } from './bake/bridgeJoin';
import { ABUTMENT_DEPTH_M, BridgeFrame, BridgeMesh, TrackStroke, buildBridgeMesh, buildTrackStroke, concatTracks } from './bake/bridgeMesh';
import {
    CrossingFurnitureStats, DRAWN_ROAD_MARGIN_M, DRAWN_TRACK_CLEARANCE_M, DrawnSegment, FurnitureBox,
    planCrossingFurniture,
} from './bake/crossingFurniture';
import { decodePtr, ROAD_CLASS_MASK } from '../src/script/terrain/ptr';
import { strokeLiftM } from './bake/drapeRoads';

/**
 * The tile's drawn road and track centrelines from its .ptr, in the true
 * local frame, with the clearance furniture keeps from each. Empty without one.
 */
function drawnSegments(ptrPath: string, surface: ReturnType<typeof tileSurface>): DrawnSegment[] {
    if (!fs.existsSync(ptrPath)) {
        return [];
    }
    const t = decodePtr(zlib.gunzipSync(fs.readFileSync(ptrPath)));
    const q = t.quantScale;
    const at = (v: number) => surface.localToXZ(t.positions[v * 3] * q, t.positions[v * 3 + 1] * q, t.positions[v * 3 + 2] * q);
    const hAt = (v: number) => surface.localToH(t.positions[v * 3] * q, t.positions[v * 3 + 1] * q, t.positions[v * 3 + 2] * q);
    const out: DrawnSegment[] = [];
    // Each quad is (l0, l0+1, l0+3) (l0, l0+3, l0+2): its centreline runs l0 -> l0+2.
    for (let i = 0; i + 5 < t.indices.length; i += 6) {
        const a = t.indices[i], b = t.indices[i + 5];
        const cls = t.directions[a * 4 + 3] & ROAD_CLASS_MASK;
        if (isZoneClass(cls)) {
            continue;
        }
        const rail = isRailClass(cls);
        const clearance = rail ? DRAWN_TRACK_CLEARANCE_M : t.halfWidths[a] / 10 + DRAWN_ROAD_MARGIN_M;
        out.push(rail ? { a: at(a), b: at(b), clearance } : { a: at(a), b: at(b), clearance, ha: hAt(a), hb: hAt(b) });
    }
    return out;
}

/**
 * Plan boxes (true frame: u, h, v) into the tile's own axes, as the PBR
 * furniture section's float records: centre, three axes, half sizes, role.
 */
function boxesInTileAxes(boxes: readonly FurnitureBox[], frame: BridgeFrame): Float32Array | undefined {
    if (boxes.length === 0) {
        return undefined;
    }
    const { a, b, up } = frame;
    const real = (p: readonly number[]) => [
        p[0] * a[0] + p[2] * b[0] + p[1] * up[0],
        p[0] * a[1] + p[2] * b[1] + p[1] * up[1],
        p[0] * a[2] + p[2] * b[2] + p[1] * up[2],
    ];
    const out = new Float32Array(boxes.length * PBR_BOX_FLOATS);
    boxes.forEach((box, i) => {
        const o = i * PBR_BOX_FLOATS;
        out.set(real(box.centre), o);
        out.set(real(box.axes[0]), o + 3);
        out.set(real(box.axes[1]), o + 6);
        out.set(real(box.axes[2]), o + 9);
        out.set(box.half, o + 12);
        out[o + 15] = box.role;
    });
    return out;
}
import {
    BridgePlan, CLEARANCE_M, NearbyRoad, PIER_SPACING_M, STREET_DECK_GRADE, SpanCrossing, XZ, bridgeRank, crossingObstacle, endSkews,
    JUNCTION_LIFT_M, endJunctions, planBridge, spanCrossings,
} from './bake/bridges';
import { BridgeRecord, decodeRbr } from './bake/rbr';
import { decodeRvr } from './bake/rvr';
import { LonLatBounds } from './bake/shoreline';
import { tileSurface } from './bake/tileSurface';
import { LIDAR_STORE_DIR, LidarStore } from './bake/lidarStore';
import { BED_TIERS, bedTierOf } from '../src/script/terrain/railBed';

/** Parapets and walkways either side of a rail deck's track bed: RAIL_DECK_MARGIN_M in bake_osm_roads.py. */
const RAIL_DECK_MARGIN_M = 2.0;

/**
 * An abutment block taller than this reads as a pier, not an abutment. Smaller
 * lifts are the deck holding a road-like grade over falling ground, which the
 * block under the end hides; short slabs on 10-40% DEM slopes are most spans.
 */
const TALL_ABUTMENT_M = 6;

const rvrCache = new Map<string, ReturnType<typeof decodeRvr>>();

/** Every road in the tile and its eight neighbours (a span is filed by midpoint, never clipped). */
function nearbyRoads(src: string, k: TileKey): ReturnType<typeof decodeRvr> {
    const out: ReturnType<typeof decodeRvr> = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const key = `${k.x + dx}/${k.y + dy}`;
            let roads = rvrCache.get(key);
            if (roads === undefined) {
                const p = path.join(src, String(k.z), String(k.x + dx), `${k.y + dy}.rvr`);
                roads = fs.existsSync(p) ? decodeRvr(fs.readFileSync(p)).filter(r => !isZoneClass(r.cls)) : [];
                if (rvrCache.size > 64) {
                    rvrCache.clear();
                }
                rvrCache.set(key, roads);
            }
            out.push(...roads);
        }
    }
    return out;
}

interface Args {
    dir: string;
    src: string;
    bbox?: LonLatBounds;
    /** The lidar store (tools/measure_lidar.py): decks end at the measured approaches. */
    lidarStore: string;
    lidar: boolean;
}

function parseBbox(text: string): LonLatBounds {
    const parts = text.split(',').map(Number);
    if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
        throw new Error(`--bbox wants west,south,east,north, got ${text}`);
    }
    const [west, south, east, north] = parts;
    if (west >= east || south >= north) {
        throw new Error(`--bbox is inside out: ${text}`);
    }
    return { west, south, east, north };
}

function overlaps(a: LonLatBounds, b: LonLatBounds): boolean {
    return !(a.east <= b.west || a.west >= b.east || a.north <= b.south || a.south >= b.north);
}

function parseArgs(argv: string[]): Args {
    const a: Args = { dir: 'assets/terrain', src: 'assets/planet', lidarStore: LIDAR_STORE_DIR, lidar: true };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--src') a.src = next();
        else if (k === '--bbox') a.bbox = parseBbox(next());
        else if (k === '--lidar-store') a.lidarStore = next();
        else if (k === '--no-lidar') a.lidar = false;
        else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

interface TerrainManifestFile {
    enuOrigin: { lat: number; lon: number; height: number };
    mesh: { indexPath: string; minZoom: number; maxZoom: number };
    bridges?: unknown;
    [key: string]: unknown;
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const tilePath = (dir: string, k: TileKey, ext: string) =>
    path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

/** Meshes joined into one, indices offset. */
function concat(meshes: readonly BridgeMesh[]): BridgeMesh {
    const verts = meshes.reduce((n, m) => n + m.vertexCount, 0);
    const idx = meshes.reduce((n, m) => n + m.indices.length, 0);
    const out: BridgeMesh = {
        positions: new Float32Array(verts * 3), normals: new Float32Array(verts * 3),
        roles: new Uint8Array(verts), indices: new Uint32Array(idx),
        vertexCount: verts, triangleCount: idx / 3,
    };
    let v = 0, i = 0;
    for (const m of meshes) {
        out.positions.set(m.positions, v * 3);
        out.normals.set(m.normals, v * 3);
        out.roles.set(m.roles, v);
        for (let k = 0; k < m.indices.length; k++) {
            out.indices[i + k] = m.indices[k] + v;
        }
        v += m.vertexCount;
        i += m.indices.length;
    }
    return out;
}

/** A road a span crosses and gives way to (bridgeRank), with its tier and its points in lon/lat. */
interface LowerRoad extends NearbyRoad {
    tier: number;
    ll: ReadonlyArray<{ lon: number; lat: number }>;
}

/**
 * A span planned over the ground of its tile: the deck lifted clear of the
 * water and of the roads it crosses of its own priority or higher - and of
 * the lower ones `liftOver` names (by index in `lower`) - and the lower
 * roads near it, which it otherwise leaves to dip under it.
 */
function planSpan(
    src: string, k: TileKey, surface: ReturnType<typeof tileSurface>, rec: BridgeRecord, span: number,
    liftOver: ReadonlySet<number> = new Set(),
    /** Heights (the tile's planner frame) an end must stand at, over its measured one: a node shared with the next span. */
    endAt?: readonly [number | undefined, number | undefined],
    /**
     * The span stays on the ground over every highway and street it crosses,
     * whatever its rank, and leaves them to dip under it: its end meets a
     * junction at ground level too near to come down from a lift
     * (staysDownAtJunction). Never over a railway (never lowered under a
     * deck) or an Autobahn: dug 5 m down under a street, a Munich Autobahn's
     * long measured profile was left under the land for 850 m.
     */
    stayDown = false,
): { points: XZ[]; plan: BridgePlan | undefined; crossings: SpanCrossing[]; lower: LowerRoad[] } {
    const points = rec.points.map(p => surface.toXZ(p.lon, p.lat));
    let lastGround = 0;
    const groundY = (x: number, z: number): number => {
        const y = surface.landH(x, z) ?? surface.waterH(x, z);
        if (y === undefined) {
            return lastGround;
        }
        lastGround = y;
        return y;
    };
    // Seed the fallback with the first height that exists, so a span
    // that starts off the mesh does not read as sea level.
    for (const p of points) {
        const y = surface.landH(p.x, p.z) ?? surface.waterH(p.x, p.z);
        if (y !== undefined) {
            lastGround = y;
            break;
        }
    }
    // Roads the deck crosses, for its clearance: other roads whose
    // centrelines cut the span's away from its two ends. Only those of its
    // own rank or higher (bridgeRank): a railway bridge over a street stays
    // on the ground, and the grading lowers the street under it.
    const ownTier = bedTierOf(rec.cls);
    const xs = points.map(p => p.x), zs = points.map(p => p.z);
    const pad = 40;
    const bx0 = Math.min(...xs) - pad, bx1 = Math.max(...xs) + pad;
    const bz0 = Math.min(...zs) - pad, bz1 = Math.max(...zs) + pad;
    const near: NearbyRoad[] = [];
    const lower: LowerRoad[] = [];
    // Every road and track under or beside the span, whatever its priority:
    // no pier stands on one.
    const under: NearbyRoad[] = [];
    for (const road of nearbyRoads(src, k)) {
        const tier = bedTierOf(road.cls);
        const xz = road.points.map(p => surface.toXZ(p.lon, p.lat));
        const overlaps = xz.some((p, i) => i > 0
            && Math.max(p.x, xz[i - 1].x) >= bx0 && Math.min(p.x, xz[i - 1].x) <= bx1
            && Math.max(p.z, xz[i - 1].z) >= bz0 && Math.min(p.z, xz[i - 1].z) <= bz1);
        if (!overlaps) {
            continue;
        }
        under.push({ points: xz, half: road.widthM / 2 });
        if (ownTier >= 0 && (bridgeRank(tier) > bridgeRank(ownTier) || (stayDown && tier >= STAY_DOWN_TIER))) {
            if (liftOver.has(lower.length)) {
                near.push({ points: xz, half: road.widthM / 2 });
            }
            lower.push({ points: xz, half: road.widthM / 2, tier, ll: road.points });
        } else {
            near.push({ points: xz, half: road.widthM / 2 });
        }
    }
    const crossings = spanCrossings(points, near);
    const obstacleY = crossingObstacle(points, crossings, groundY);
    const plan = planBridge({
        structure: rec.structure, deckWidthM: rec.deckWidthM, layer: rec.layer, points,
        maxGrade: ownTier >= 0 ? BED_TIERS[ownTier].maxGrade : undefined,
    }, {
        groundY,
        obstacleY,
        endY: withEnds(lidar ? measuredEnds(k, span, rec, points, surface) : undefined, endAt),
        // A river is water drawn above its own bed.
        waterY: (x, z) => {
            const w = surface.waterH(x, z);
            const l = surface.landH(x, z);
            return w !== undefined && (l === undefined || w > l - 1e-3) ? w : undefined;
        },
        onRoad: (x, z, r) => under.some(road => distanceToLine(road.points, x, z) < road.half + r),
        roadDirAt: (x, z, r) => nearestDirection(under, x, z, r),
    });
    if (plan) {
        // A skew bridge's abutments run parallel to the road under it.
        plan.endSkew = endSkews(plan, crossings);
    }
    return { points, plan, crossings, lower };
}

/**
 * A road span's two deck ends for the grading (pbr.ts version 5, tile axes):
 * the deck top on the centreline at each end, the span's tier, and the deck
 * top 1 m in, so a road arriving there is known to arrive along the span.
 */
function roadDeckEnds(plan: BridgePlan, frame: { a: number[]; b: number[]; up: number[] }, tier: number): number[] | undefined {
    if (tier < 0 || plan.stations.length < 2) {
        return undefined;
    }
    const st = plan.stations;
    const tile = (u: number, v: number, h: number) => [0, 1, 2].map(c => u * frame.a[c] + v * frame.b[c] + h * frame.up[c]);
    const at = (s: number) => {
        let k = 1;
        while (k < st.length - 1 && st[k].s < s) {
            k++;
        }
        const a = st[k - 1], b = st[k];
        const t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
        return tile(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, a.deckY + (b.deckY - a.deckY) * t);
    };
    const total = st[st.length - 1].s;
    const inward = Math.min(1, total / 2);
    return [
        ...at(0), tier, ...at(inward),
        ...at(total), tier, ...at(total - inward),
    ];
}

/** The direction (unit) of the road segment nearest (x, z) within `r`, if any. */
function nearestDirection(roads: readonly NearbyRoad[], x: number, z: number, r: number): [number, number] | undefined {
    let best: [number, number] | undefined, bestD = r;
    for (const road of roads) {
        for (let i = 1; i < road.points.length; i++) {
            const a = road.points[i - 1], b = road.points[i];
            const dx = b.x - a.x, dz = b.z - a.z;
            const l2 = dx * dx + dz * dz;
            if (l2 < 1e-12) {
                continue;
            }
            const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
            const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
            if (d < bestD) {
                bestD = d;
                const l = Math.sqrt(l2);
                best = [dx / l, dz / l];
            }
        }
    }
    return best;
}

/** Plan distance from (x, z) to a polyline, metres. */
function distanceToLine(points: readonly XZ[], x: number, z: number): number {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t));
    }
    return best;
}

/** The lidar store (tools/measure_lidar.py), unless --no-lidar or there is none. */
let lidar: LidarStore | undefined;
/**
 * Most a measured approach may stand above the ground beside it, metres.
 * Below it only as deep as the line's earthworks cap lets its approach go:
 * read on a valley side, the "ground beside" a bank was the slope above it,
 * and decks sunk all the way to match passed through the land (84 stations
 * against 21 on the Garmisch tiles).
 */
const LIDAR_LIFT_MAX_M = 15;
/** Two spans' ends at one node this close in height stand as they are, metres. */
const SHARED_NODE_SLACK_M = 0.05;

/**
 * Span ends this near each other are one joint, metres: the spans of one
 * bridge meet at a node, or a few metres apart with a stub of road between
 * (Kitzbühel, 3.2 m, a metre apart in height); twin carriageways' bridges
 * stand further apart than this.
 */
const SHARED_NODE_M = 4;

/** Grid cell (1e-4 degrees, about 11 x 7 m) of a span end, offset by (dy, dx) cells. */
function nodeCell(p: { lat: number; lon: number }, dy: number, dx: number): string {
    return `${Math.floor(p.lat * 1e4) + dy},${Math.floor(p.lon * 1e4) + dx}`;
}

/** The highest deck end within SHARED_NODE_M of a span end (its own included), above the ellipsoid. */
function sharedTop(ends: ReadonlyMap<string, ReadonlyArray<{ lat: number; lon: number; top: number }>>, p: { lat: number; lon: number }): number | undefined {
    const kx = 111412.84 * Math.cos((p.lat * Math.PI) / 180);
    let best: number | undefined;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            for (const e of ends.get(nodeCell(p, dy, dx)) ?? []) {
                if (Math.hypot((e.lon - p.lon) * kx, (e.lat - p.lat) * 111132.92) <= SHARED_NODE_M) {
                    best = best === undefined ? e.top : Math.max(best, e.top);
                }
            }
        }
    }
    return best;
}

/** Measured end heights with the forced ones laid over them. */
function withEnds(
    measured: [number | undefined, number | undefined] | undefined, forced: readonly [number | undefined, number | undefined] | undefined,
): [number | undefined, number | undefined] | undefined {
    if (!forced) {
        return measured;
    }
    return [forced[0] ?? measured?.[0], forced[1] ?? measured?.[1]];
}

/** Where beyond a span's end its approach was read in the lidar (tools/measure_lidar.py APPROACH_STATIONS_M), metres. */
const APPROACH_STATIONS_M = [2, 4, 6, 8, 10, 12];
const lidarStat = { ends: 0, measured: 0, offTile: 0, noLidar: 0, sumDelta: 0, maxDelta: 0 };

/**
 * A span's two end heights from the lidar: the ground under the end node plus
 * how far the approach just beyond it stands above the ground beside it (the
 * store's measurement, span `span` of the tile's .rbr) - the same rule the
 * grading lays the approach by (railBed.ts RailBedInput.measured, 'rel'), so
 * the ramp meets the deck.
 */
function measuredEnds(
    k: TileKey, span: number, rec: BridgeRecord, points: readonly XZ[], surface: ReturnType<typeof tileSurface>,
): [number | undefined, number | undefined] {
    const last = rec.points.length - 1;
    return ([0, 1] as const).map(e => {
        const i = e === 0 ? 0 : last, step = e === 0 ? 1 : -1;
        lidarStat.ends++;
        // An end across the tile border (spans are filed by their midpoint)
        // has no land of its own here: the ground nearest it along the span
        // stands in. Left unmeasured, it fell to the bare ground and a rail
        // deck over the B2 at Garmisch sank to the road at that end.
        let land: number | undefined;
        for (let k = i; land === undefined && k >= 0 && k <= last; k += step) {
            land = surface.landH(points[k].x, points[k].z);
        }
        if (surface.landH(points[i].x, points[i].z) === undefined) {
            lidarStat.offTile++;
        }
        // The lift was read on the approach, APPROACH_STATIONS_M beyond the
        // end: it stands on the land there, not on the land under the end
        // node. On a gully's edge or a steep bank the two differ by metres -
        // a street at Garmisch climbed 4 m in the 5 m off a deck set on the
        // land under its node, one at Kitzbühel fell 10 m.
        let j = i + step;
        while (j + step >= 0 && j + step <= last && Math.hypot(points[j].x - points[i].x, points[j].z - points[i].z) < 2) {
            j += step;
        }
        const ox = points[i].x - points[j].x, oz = points[i].z - points[j].z, ol = Math.hypot(ox, oz);
        if (ol > 0.5) {
            const under: number[] = [];
            for (const d of APPROACH_STATIONS_M) {
                const h = surface.landH(points[i].x + (ox / ol) * d, points[i].z + (oz / ol) * d);
                if (h !== undefined) {
                    under.push(h);
                }
            }
            if (under.length > 0) {
                under.sort((x, y) => x - y);
                land = under[under.length >> 1];
            }
        }
        const lift = lidar!.bridgeEndLift(k, span, e);
        if (land === undefined || lift === undefined) {
            lidarStat.noLidar++;
            return undefined;
        }
        // No deeper than its approach can follow - the line's earthworks
        // cap: a street in a gully the 30 m land does not have, measured
        // 12 m under the ground beside it, is cut its 1.5 m into the land,
        // and a deck end left on the land stood 1.7 m over it.
        const tier = bedTierOf(rec.cls);
        const clamped = Math.max(tier >= 0 ? -BED_TIERS[tier].maxEarthworkM : 0, Math.min(LIDAR_LIFT_MAX_M, lift));
        lidarStat.measured++;
        lidarStat.sumDelta += Math.abs(clamped);
        lidarStat.maxDelta = Math.max(lidarStat.maxDelta, Math.abs(clamped));
        return land + clamped;
    }) as [number | undefined, number | undefined];
}

/**
 * Heights above the ellipsoid of points in a tile's planner frame (u, v, h):
 * each tile plans in its own frame, whose up leans and whose origin moves
 * tile to tile, so heights from two tiles compare only like this. Measured
 * on its own ground, a Munich ramp across a border missed the 1.5 m the
 * ground rose to its deck.
 */
function absHeights(tile: ReturnType<typeof decodePtm>, surface: ReturnType<typeof tileSurface>, basis: ReturnType<typeof makeEnuBasis>) {
    const bb = tileBounds(tile.id);
    const c = ecefToEnu(basis, geodeticToEcef((bb.south + bb.north) / 2, (bb.west + bb.east) / 2, tile.centerHeightM));
    const { a, b, up } = surface.frame;
    return (u: number, v: number, h: number): number => {
        const x = u * a[0] + v * b[0] + h * up[0];
        const y = u * a[1] + v * b[1] + h * up[1];
        const z = u * a[2] + v * b[2] + h * up[2];
        const e = enuToEcef(basis, { e: c.e + x, n: c.n - z, u: c.u + y });
        return ecefToGeodetic(e.x, e.y, e.z).height;
    };
}

/** Neighbouring tiles' surfaces, loaded once for the spans that reach onto them. */
const neighbourSurfaces = new Map<string, { surface: ReturnType<typeof tileSurface>; abs: ReturnType<typeof absHeights> } | null>();
const NEIGHBOUR_SURFACES_KEPT = 48;

function neighbourSurface(dir: string, n: TileKey, basis: ReturnType<typeof makeEnuBasis>) {
    const key = keyOf(n);
    if (neighbourSurfaces.has(key)) {
        const hit = neighbourSurfaces.get(key)!;
        neighbourSurfaces.delete(key);
        neighbourSurfaces.set(key, hit);
        return hit;
    }
    const p = tilePath(dir, n, '.ptm');
    let out: { surface: ReturnType<typeof tileSurface>; abs: ReturnType<typeof absHeights> } | null = null;
    if (fs.existsSync(p)) {
        const t = decodePtm(zlib.gunzipSync(fs.readFileSync(p)));
        const surface = tileSurface(t, basis);
        out = { surface, abs: absHeights(t, surface, basis) };
    }
    neighbourSurfaces.set(key, out);
    if (neighbourSurfaces.size > NEIGHBOUR_SURFACES_KEPT) {
        neighbourSurfaces.delete(neighbourSurfaces.keys().next().value!);
    }
    return out;
}

/**
 * A tile's surface whose land and water reach onto its neighbours: a span is
 * filed in the tile its middle is in, and a viaduct running on across the
 * border read no ground past it - with more than half its stations there,
 * it was dropped as off the mesh (an A7 carriageway, while its twin, filed
 * next door, stood alone).
 */
function extendSurface(
    dir: string, k: TileKey, tile: ReturnType<typeof decodePtm>, surface: ReturnType<typeof tileSurface>,
    basis: ReturnType<typeof makeEnuBasis>,
): ReturnType<typeof tileSurface> {
    const geo = geodeticOf(tile, surface, basis);
    const abs = absHeights(tile, surface, basis);
    const span = 180 / 2 ** k.z;
    const beyond = (x: number, z: number, water: boolean): number | undefined => {
        const g = geo(x, z, 0);
        const n = { z: k.z, x: Math.floor((g.lon + 180) / span), y: Math.floor((90 - g.lat) / span) };
        if (n.x === k.x && n.y === k.y) {
            return undefined;
        }
        const other = neighbourSurface(dir, n, basis);
        if (!other) {
            return undefined;
        }
        const p = other.surface.toXZ(g.lon, g.lat);
        const h = water ? other.surface.waterH(p.x, p.z) : other.surface.landH(p.x, p.z);
        return h === undefined ? undefined : other.abs(p.x, p.z, h) - abs(x, z, 0);
    };
    return {
        ...surface,
        landH: (x, z) => surface.landH(x, z) ?? beyond(x, z, false),
        waterH: (x, z) => surface.waterH(x, z) ?? beyond(x, z, true),
    };
}

/** The highest tier a span that stays down lets dip under it (BED_TIERS: highway). */
const STAY_DOWN_TIER = BED_TIERS.findIndex(t => t.name === 'highway');
/**
 * Whether `plan` is to stay on the ground: a deck end lifted JUNCTION_LIFT_M
 * or more over its ground has a junction beyond it (bridges.ts
 * endJunctions) nearer than the lift takes to come down at the line's grade.
 * Every road in the vectors meets the others on the ground.
 */
function staysDownAtJunction(
    plan: BridgePlan, rec: BridgeRecord, roads: ReturnType<typeof decodeRvr>, surface: ReturnType<typeof tileSurface>,
): boolean {
    const tier = bedTierOf(rec.cls);
    const grade = tier >= 0 ? BED_TIERS[tier].maxGrade : STREET_DECK_GRADE;
    const lift = plan.abutmentLiftM;
    if (!(Math.max(lift[0], lift[1]) >= JUNCTION_LIFT_M)) {
        return false;
    }
    const found = endJunctions(
        rec.points.map(p => surface.toXZ(p.lon, p.lat)), roads.map(r => r.points.map(p => surface.toXZ(p.lon, p.lat))),
        Math.max(lift[0], lift[1]) / grade,
    );
    return ([0, 1] as const).some(e => lift[e] >= JUNCTION_LIFT_M && found[e].some(j => j.d <= lift[e] / grade));
}

/** An abutment's footprint keeps this far off another road's carriageway, metres (as a pier's). */
const ABUTMENT_CLEAR_M = 1;
/**
 * Farthest a span's end runs on to clear its abutment off a road, metres:
 * the line's own stroke ends at the old end, now on the deck, and the
 * grading finds the deck's end from there - a road's within ROAD_END_ON_M
 * or its own deck (5 m), a track's back along its line (railBed.ts
 * DECK_SNAP_ALONG_M, 10 m; the railway over the B2 at Garmisch, crossing it
 * at 20 degrees, needed 7 m).
 */
const END_EXTEND_MAX_M = 5;
const END_EXTEND_RAIL_MAX_M = 9;
/** Steps the end is moved on by while looking for a clear place, metres. */
const END_EXTEND_STEP_M = 0.5;
/** Two spans' end nodes this near are one node, metres. */
const END_NODE_SAME_M = 0.5;
/** A road with a vertex this near a span's end node leaves from it (the line carried on, a junction), metres. */
const END_ROAD_NODE_M = 1.5;
/** A road of the span's class at its end, at least this aligned with it (cosine), is the line it carries. */
const END_ALONG_COS = 0.9;

/**
 * The span with each end run on, along its last segment, until its
 * abutment's footprint (ABUTMENT_DEPTH_M along, the deck's width across)
 * stands ABUTMENT_CLEAR_M clear of every other road - not the line carried
 * on past the end, nor a road meeting it there (a vertex at the end node).
 * An end shared with another span of the bridge stays; so does one that
 * finds no clear place within END_EXTEND_MAX_M. At the B2 at Garmisch, a
 * railway bridge OSM ends 2 m short of the carriageway it crosses had its
 * abutment over the road's edge, and the embankment ended in a 5 m needle.
 */
function clearAbutments(
    rec: BridgeRecord, siblings: readonly BridgeRecord[], roads: ReturnType<typeof decodeRvr>, surface: ReturnType<typeof tileSurface>,
): { rec: BridgeRecord; extended: number } {
    const pts = rec.points.map(p => surface.toXZ(p.lon, p.lat));
    const last = pts.length - 1;
    if (last < 1 || rec.structure === 'tunnel') {
        return { rec, extended: 0 };
    }
    const half = rec.deckWidthM / 2, d2 = ABUTMENT_DEPTH_M / 2;
    const xzRoads = roads.map(r => ({ pts: r.points.map(p => surface.toXZ(p.lon, p.lat)), half: r.widthM / 2, cls: r.cls }));
    const out = rec.points.slice();
    let extended = 0;
    for (const e of [0, 1] as const) {
        const i = e === 0 ? 0 : last, j = e === 0 ? 1 : last - 1;
        const end = pts[i];
        const shared = siblings.some(o => o !== rec && [o.points[0], o.points[o.points.length - 1]].some(n => {
            const x = surface.toXZ(n.lon, n.lat);
            return Math.hypot(x.x - end.x, x.z - end.z) < END_NODE_SAME_M;
        }));
        if (shared) {
            continue;
        }
        const len = Math.hypot(end.x - pts[j].x, end.z - pts[j].z);
        if (len < 1e-3) {
            continue;
        }
        const tx = (end.x - pts[j].x) / len, tz = (end.z - pts[j].z) / len;
        // In the way: every road but those leaving the end node itself, and
        // the line the span carries drawn a little off it (its own class,
        // along the span, through the deck's end: a street 1.8 m off its
        // slab's end node had both ends of the slab run on 3.5 m).
        const own = (r: typeof xzRoads[number]) => {
            if (r.cls !== rec.cls || distanceToLine(r.pts, end.x, end.z) > half + r.half) {
                return false;
            }
            let best = Infinity, cos = 0;
            for (let k = 1; k < r.pts.length; k++) {
                const a = r.pts[k - 1], b = r.pts[k];
                const d = distanceToLine([a, b], end.x, end.z);
                if (d < best) {
                    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
                    best = d;
                    cos = Math.abs(((b.x - a.x) * tx + (b.z - a.z) * tz) / l);
                }
            }
            return cos >= END_ALONG_COS;
        };
        const others = xzRoads.filter(r => !r.pts.some(p => Math.hypot(p.x - end.x, p.z - end.z) < END_ROAD_NODE_M) && !own(r));
        const clear = (cx: number, cz: number) => {
            for (const a of [-d2, 0, d2]) {
                for (const c of [-half, 0, half]) {
                    const x = cx + tx * a - tz * c, z = cz + tz * a + tx * c;
                    if (others.some(r => distanceToLine(r.pts, x, z) < r.half + ABUTMENT_CLEAR_M)) {
                        return false;
                    }
                }
            }
            return true;
        };
        if (clear(end.x, end.z)) {
            continue;
        }
        const most = rec.cls !== undefined && isRailClass(rec.cls) ? END_EXTEND_RAIL_MAX_M : END_EXTEND_MAX_M;
        for (let d = END_EXTEND_STEP_M; d <= most + 1e-9; d += END_EXTEND_STEP_M) {
            if (clear(end.x + tx * d, end.z + tz * d)) {
                // On in lon/lat along the same segment: a few metres, straight.
                const a = rec.points[i], b = rec.points[j], f = d / len;
                out[i] = { lon: a.lon + (a.lon - b.lon) * f, lat: a.lat + (a.lat - b.lat) * f };
                extended++;
                break;
            }
        }
    }
    return extended > 0 ? { rec: { ...rec, points: out }, extended } : { rec, extended: 0 };
}

/** A span planned on its tile, with what its mesh needs, and an id stable from tile to tile. */
interface PendingSpan {
    plan: BridgePlan;
    tier: number;
    track?: TrackStroke;
    id: string;
}

/** A span's deck above the ellipsoid, for a neighbouring tile to read in its own frame. */
interface GeoPlan {
    id: string;
    plan: BridgePlan;
    stations: Array<{ lat: number; lon: number; top: number; ground: number }>;
}

/** Latitude, longitude and height above the ellipsoid of a point in a tile's planner frame (u, v, h). */
function geodeticOf(tile: ReturnType<typeof decodePtm>, surface: ReturnType<typeof tileSurface>, basis: ReturnType<typeof makeEnuBasis>) {
    const bb = tileBounds(tile.id);
    const c = ecefToEnu(basis, geodeticToEcef((bb.south + bb.north) / 2, (bb.west + bb.east) / 2, tile.centerHeightM));
    const { a, b, up } = surface.frame;
    return (u: number, v: number, h: number) => {
        const x = u * a[0] + v * b[0] + h * up[0];
        const y = u * a[1] + v * b[1] + h * up[1];
        const z = u * a[2] + v * b[2] + h * up[2];
        const e = enuToEcef(basis, { e: c.e + x, n: c.n - z, u: c.u + y });
        return ecefToGeodetic(e.x, e.y, e.z);
    };
}

function toGeo(p: PendingSpan, geo: ReturnType<typeof geodeticOf>): GeoPlan {
    return {
        id: p.id, plan: p.plan,
        stations: p.plan.stations.map(st => {
            const top = geo(st.x, st.z, st.deckY), ground = geo(st.x, st.z, st.groundY);
            return { lat: top.lat, lon: top.lon, top: top.height, ground: ground.height };
        }),
    };
}

/** A neighbour's span in this tile's planner frame: a copy, its deck and ground at their heights, no piers. */
function inFrame(g: GeoPlan, surface: ReturnType<typeof tileSurface>, abs: (u: number, v: number, h: number) => number): BridgePlan {
    return {
        ...g.plan,
        piers: [],
        openSides: undefined,
        stations: g.plan.stations.map((st, i) => {
            const at = surface.toXZ(g.stations[i].lon, g.stations[i].lat);
            const zero = abs(at.x, at.z, 0);
            return { ...st, x: at.x, z: at.z, deckY: g.stations[i].top - zero, groundY: g.stations[i].ground - zero };
        }),
    };
}

/** A deck end standing at least this far over its ground is one a road must climb to, metres. */
const RAISED_END_M = 0.5;
/** Farthest along a road a raised deck end is looked for from where it dips under a bridge, metres. */
const NEIGHBOUR_REACH_M = 400;
/** A raised end this near a road's centreline is that road's own, metres. */
const ON_ROAD_M = 3;
/** A road ending this near another's centreline joins it, metres. */
const JOIN_M = 2;
/** Spacing of the points a road is checked at for passing under a deck, metres. */
const UNDER_STEP_M = 2;
/**
 * Share of a road's grade the bake allows itself between a dip and a
 * neighbouring deck: the runtime rounds the grade breaks into vertical
 * curves, which take some of the length.
 */
const GRADE_SHARE = 0.8;

/** A raised deck end: where, how far over its ground, its height above the ellipsoid, and the tier of the line on the deck. */
interface RaisedEnd {
    lon: number;
    lat: number;
    lift: number;
    top: number;
    tier: number;
}

/** The raised deck ends of a tile and its eight neighbours, in this tile's plan. */
function raisedNear(
    raised: ReadonlyMap<string, RaisedEnd[]>, k: TileKey, surface: ReturnType<typeof tileSurface>,
): Array<{ x: number; z: number; lift: number; tier: number }> {
    const out: Array<{ x: number; z: number; lift: number; tier: number }> = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (const e of raised.get(keyOf({ z: k.z, x: k.x + dx, y: k.y + dy })) ?? []) {
                out.push({ ...surface.toXZ(e.lon, e.lat), lift: e.lift, tier: e.tier });
            }
        }
    }
    return out;
}

/** Where along a polyline a point projects, metres, and how far off it it is. */
function onPolyline(line: readonly XZ[], x: number, z: number): { s: number; d: number } {
    let best = { s: 0, d: Infinity };
    let run = 0;
    for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i], b = line[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
        const l = Math.sqrt(l2);
        const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
        const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
        if (d < best.d) {
            best = { s: run + t * l, d };
        }
        run += l;
    }
    return best;
}

/**
 * How far along the road network a point is from where `road` passes under
 * a deck (`at`, along it): on the road itself, or on a road of its tier
 * that joins it at one of its ends (the approach to a bridge is often a way
 * of its own). Undefined when the point is on neither.
 */
function runTo(road: LowerRoad, at: number, x: number, z: number, others: readonly LowerRoad[]): number | undefined {
    const on = onPolyline(road.points, x, z);
    let best = on.d <= ON_ROAD_M ? Math.abs(on.s - at) : undefined;
    for (const other of others) {
        if (other === road || other.tier !== road.tier) {
            continue;
        }
        const onOther = onPolyline(other.points, x, z);
        if (onOther.d > ON_ROAD_M) {
            continue;
        }
        let length = 0;
        for (let i = 1; i < other.points.length; i++) {
            length += Math.hypot(other.points[i].x - other.points[i - 1].x, other.points[i].z - other.points[i - 1].z);
        }
        for (const end of [{ p: other.points[0], s: 0 }, { p: other.points[other.points.length - 1], s: length }]) {
            const join = onPolyline(road.points, end.p.x, end.p.z);
            if (join.d <= JOIN_M) {
                const run = Math.abs(onOther.s - end.s) + Math.abs(join.s - at);
                best = best === undefined ? run : Math.min(best, run);
            }
        }
    }
    return best;
}

/**
 * Where a road passes under a deck, as the runtime grading sees it: any
 * point of it within the deck's half width (and its own) of the span's
 * centreline, between the span's ends - not only where it cuts the
 * centreline; a slip road under one edge of a railway bridge does not.
 * Every UNDER_STEP_M along the road; `along` the span, `s` along the road.
 */
function underDeck(points: readonly XZ[], deckWidthM: number, road: LowerRoad): Array<{ along: number; s: number }> {
    const out: Array<{ along: number; s: number }> = [];
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    }
    const reach = deckWidthM / 2 + road.half;
    let run = 0;
    for (let i = 0; i + 1 < road.points.length; i++) {
        const a = road.points[i], b = road.points[i + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        for (let d = 0; d <= l; d += UNDER_STEP_M) {
            const f = l > 0 ? d / l : 0;
            const on = onPolyline(points, a.x + (b.x - a.x) * f, a.z + (b.z - a.z) * f);
            if (on.d <= reach && on.s > 0 && on.s < total) {
                out.push({ along: on.s, s: run + d });
            }
        }
        run += l;
    }
    return out;
}

/**
 * Whether a lower road a span crosses could not dip under it within its
 * grade: from where it would pass under the deck (CLEARANCE_M under the
 * underside) to a raised deck end of its own tier along it, the dip and the
 * climb together take more than its grade allows over the distance between.
 */
function cannotDipUnder(
    plan: BridgePlan, points: readonly XZ[], road: LowerRoad, lower: readonly LowerRoad[],
    raised: ReadonlyArray<{ x: number; z: number; lift: number; tier: number }>,
): boolean {
    const grade = BED_TIERS[road.tier]?.maxGrade;
    if (grade === undefined) {
        return false;
    }
    for (const c of underDeck(points, plan.deckWidthM, road)) {
        // How far down the road must go there: the deck's underside, and
        // the clearance under it, below the ground the road is drawn on.
        let st = plan.stations[0];
        for (const x of plan.stations) {
            if (Math.abs(x.s - c.along) < Math.abs(st.s - c.along)) {
                st = x;
            }
        }
        const dip = Math.max(0, st.deckY - st.groundY) + plan.deckThicknessM + CLEARANCE_M;
        const at = c.s;
        for (const e of raised) {
            if (e.tier !== road.tier) {
                continue;
            }
            const run = runTo(road, at, e.x, e.z, lower);
            if (run === undefined || run > NEIGHBOUR_REACH_M || run < 1) {
                continue;
            }
            if (dip + e.lift > grade * GRADE_SHARE * run) {
                return true;
            }
        }
    }
    return false;
}

/** A spot where a lower road must dip under a bridge left on the ground: where, how far down, the height it must get to (above the ellipsoid), its tier. */
interface DipPoint {
    lon: number;
    lat: number;
    depth: number;
    need: number;
    tier: number;
}

/**
 * The dips under a span's deck of the lower roads it crosses, for the border
 * ramps: every point of the road under the deck (UNDER_STEP_M apart), each
 * with the height it must get to there. One point per road - where it dips
 * deepest under the ground - missed a deck running along the road and
 * sloping down towards the border: at Garmisch the B2 had to be 1 m lower
 * 14 m from the border than at that point 48 m from it, and climbed 13.5 %
 * to the border's drawn height.
 */
function spanDips(
    plan: BridgePlan, points: readonly XZ[], lower: readonly LowerRoad[], abs: (u: number, v: number, h: number) => number,
): DipPoint[] {
    const out: DipPoint[] = [];
    for (const road of lower) {
        for (const c of underDeck(points, plan.deckWidthM, road)) {
            let st = plan.stations[0];
            for (const x of plan.stations) {
                if (Math.abs(x.s - c.along) < Math.abs(st.s - c.along)) {
                    st = x;
                }
            }
            const depth = Math.max(0, st.deckY - st.groundY) + plan.deckThicknessM + CLEARANCE_M;
            const p = lonLatAt(road, c.s);
            out.push({ lon: p.lon, lat: p.lat, depth, need: abs(st.x, st.z, st.deckY - plan.deckThicknessM - CLEARANCE_M), tier: road.tier });
        }
    }
    return out;
}

/** The lon/lat `s` metres along a road's polyline (its xz lengths). */
function lonLatAt(road: LowerRoad, s: number): { lon: number; lat: number } {
    let run = 0;
    for (let i = 0; i + 1 < road.points.length; i++) {
        const a = road.points[i], b = road.points[i + 1];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (run + l >= s || i + 2 === road.points.length) {
            const f = l > 0 ? Math.min(1, Math.max(0, (s - run) / l)) : 0;
            return { lon: road.ll[i].lon + (road.ll[i + 1].lon - road.ll[i].lon) * f, lat: road.ll[i].lat + (road.ll[i + 1].lat - road.ll[i].lat) * f };
        }
        run += l;
    }
    return road.ll[0];
}

/** Share of a line's grade a ramp across a tile border is planned at: the vertical curves take some. */
const RAMP_GRADE_SHARE = 0.85;
/** Most a line is held off its drawn height where it crosses a tile border, metres. */
const RAMP_MAX_M = 12;
/** Farthest a deck or dip is looked for along the lines from a border crossing, metres. */
const RAMP_REACH_M = 500;
/** A deck end or dip this near a line is on it, metres. */
const RAMP_ON_LINE_M = 3;
/** Line ends this near each other join, metres. */
const RAMP_JOIN_M = 1.5;
/** How far inside the tile along the line a crossing's ground is read, metres. */
const RAMP_GROUND_IN_M = 0.5;
/** A crossing held less than this off its drawn height is left out, metres. */
const RAMP_MIN_M = 0.1;
/** A line end this near the tile's edge, in degrees per tile span, crosses it (the .rvr clips at the edge). */
const RAMP_ON_EDGE = 0.0002;

/**
 * The tile's border ramps (pbr.ts version 4, crossing points in the tile's
 * own axes like the decks): for every road or railway
 * crossing its edge, how far off its drawn height it must be there - raised
 * to climb onto a deck end of its own tier along it, lowered to pass under a
 * bridge it gives way to - within RAMP_GRADE_SHARE of its grade over the way
 * between. The way is walked along the lines of its tier, joined end to end,
 * in this tile and its neighbours, so the tile across, walking the same
 * lines from the same point, holds it to the same height. Held where drawn,
 * a flyover's ramp had only its own side of the border: 58-131 m where 3 %
 * needs 190 m.
 */
function borderRamps(
    k: TileKey, surface: ReturnType<typeof tileSurface>, abs: (u: number, v: number, h: number) => number,
    ownRoads: ReturnType<typeof decodeRvr>,
    lines: ReturnType<typeof decodeRvr>, raised: ReadonlyMap<string, RaisedEnd[]>, dips: ReadonlyMap<string, DipPoint[]>,
): Float32Array | undefined {
    const b = boundsOf(k);
    const span = b.east - b.west;
    const near3 = <T>(m: ReadonlyMap<string, T[]>): T[] => {
        const out: T[] = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                out.push(...(m.get(keyOf({ z: k.z, x: k.x + dx, y: k.y + dy })) ?? []));
            }
        }
        return out;
    };
    const ends = near3(raised).map(e => ({ ...surface.toXZ(e.lon, e.lat), top: e.top, tier: e.tier }));
    const sinks = near3(dips).map(e => ({ ...surface.toXZ(e.lon, e.lat), need: e.need, tier: e.tier }));
    if (ends.length === 0 && sinks.length === 0) {
        return undefined;
    }
    const graded = lines
        .map(l => ({ tier: bedTierOf(l.cls), pts: l.points.map(p => surface.toXZ(p.lon, p.lat)) }))
        .filter(l => l.tier >= 0 && l.pts.length >= 2);
    const joinKey = (p: XZ) => `${Math.round(p.x / RAMP_JOIN_M)},${Math.round(p.z / RAMP_JOIN_M)}`;
    // Every vertex of every line, so lines join wherever they meet - a
    // track joining another partway along it, not only end to end.
    const byVertex = new Map<string, Array<[number, number]>>();
    graded.forEach((l, i) => {
        l.pts.forEach((p, j) => {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    const key = `${Math.round(p.x / RAMP_JOIN_M) + dx},${Math.round(p.z / RAMP_JOIN_M) + dz}`;
                    const list = byVertex.get(key);
                    if (list) {
                        list.push([i, j]);
                    } else {
                        byVertex.set(key, [[i, j]]);
                    }
                }
            }
        });
    });
    const out: number[] = [];
    const done = new Set<string>();
    for (const own of ownRoads) {
        const tier = bedTierOf(own.cls);
        if (tier < 0 || own.points.length < 2) {
            continue;
        }
        for (const ll of [own.points[0], own.points[own.points.length - 1]]) {
            const fx = (ll.lon - b.west) / span, fy = (b.north - ll.lat) / (b.north - b.south);
            const onEdge = Math.min(Math.abs(fx), Math.abs(fx - 1), Math.abs(fy), Math.abs(fy - 1)) < RAMP_ON_EDGE;
            const X = surface.toXZ(ll.lon, ll.lat);
            const key = `${tier}:${joinKey(X)}`;
            if (!onEdge || done.has(key)) {
                continue;
            }
            done.add(key);
            const g = BED_TIERS[tier].maxGrade * RAMP_GRADE_SHARE;
            const reach = Math.min(RAMP_REACH_M, RAMP_MAX_M / g);
            // Its ground there, above the ellipsoid, as the deck ends and
            // dips are: the ground between may rise or fall. Read a little
            // inside the tile along the line: on the edge itself the read
            // finds the skirt or nothing, and every crossing was skipped.
            // A line running along the edge may leave it back outwards (the
            // B2 at Garmisch, 3 m over 43 m): then straight in towards the
            // tile's middle. Skipped, the tile beyond held a crossing 3.8 m
            // lower than this one.
            const next = ll === own.points[0] ? own.points[1] : own.points[own.points.length - 2];
            const Y = surface.toXZ(next.lon, next.lat);
            const mid = surface.toXZ((b.west + b.east) / 2, (b.south + b.north) / 2);
            let gx = X.x, gz = X.z, groundX: number | undefined;
            for (const T of [Y, mid]) {
                const inward = Math.hypot(T.x - X.x, T.z - X.z);
                const f = inward > 1e-6 ? Math.min(1, RAMP_GROUND_IN_M / inward) : 0;
                gx = X.x + (T.x - X.x) * f;
                gz = X.z + (T.z - X.z) * f;
                groundX = surface.landH(gx, gz);
                if (groundX !== undefined) {
                    break;
                }
            }
            if (groundX === undefined) {
                continue;
            }
            const baseX = abs(gx, gz, groundX);
            let lo = -Infinity, hi = Infinity;
            // Every line of its tier from the crossing on, joined wherever two
            // meet, both ways along each.
            const seen = new Set<string>();
            const stack: Array<{ line: number; at: number; step: number; dist: number }> = [];
            const joinAt = (p: XZ, dist: number) => {
                for (const [i, j] of byVertex.get(joinKey(p)) ?? []) {
                    const l = graded[i];
                    if (l.tier !== tier || Math.hypot(l.pts[j].x - p.x, l.pts[j].z - p.z) > RAMP_JOIN_M || seen.has(`${i}:${j}`)) {
                        continue;
                    }
                    seen.add(`${i}:${j}`);
                    stack.push({ line: i, at: j, step: 1, dist }, { line: i, at: j, step: -1, dist });
                }
            };
            joinAt(X, 0);
            while (stack.length > 0) {
                // Nearest first: a vertex is walked once, by its shortest way.
                let near = 0;
                for (let q = 1; q < stack.length; q++) {
                    if (stack[q].dist < stack[near].dist) {
                        near = q;
                    }
                }
                const { line, at, step, dist } = stack.splice(near, 1)[0];
                const pts = graded[line].pts;
                let run = dist;
                for (let i = at; i + step >= 0 && i + step < pts.length && run <= reach; i += step) {
                    const a = pts[i], c = pts[i + step];
                    const l = Math.hypot(c.x - a.x, c.z - a.z);
                    const onSeg = (x: number, z: number) => {
                        const t = l > 0 ? Math.min(1, Math.max(0, ((x - a.x) * (c.x - a.x) + (z - a.z) * (c.z - a.z)) / (l * l))) : 0;
                        return Math.hypot(x - a.x - (c.x - a.x) * t, z - a.z - (c.z - a.z) * t) <= RAMP_ON_LINE_M ? run + t * l : undefined;
                    };
                    for (const e of ends) {
                        const d = e.tier === tier ? onSeg(e.x, e.z) : undefined;
                        if (d !== undefined) {
                            lo = Math.max(lo, e.top - g * d - baseX);
                        }
                    }
                    for (const e of sinks) {
                        const d = e.tier === tier ? onSeg(e.x, e.z) : undefined;
                        if (d !== undefined) {
                            hi = Math.min(hi, e.need + g * d - baseX);
                        }
                    }
                    run += l;
                    seen.add(`${line}:${i + step}`);
                    if (run <= reach) {
                        joinAt(c, run);
                    }
                }
            }
            const dh = Math.min(hi, Math.max(lo, 0));
            if (Math.abs(dh) >= RAMP_MIN_M && Number.isFinite(dh)) {
                // In the tile's own axes, as the decks are (u, v, h in the
                // planner's true-vertical frame).
                const { a, b: fb, up } = surface.frame;
                const h = groundX;
                out.push(
                    X.x * a[0] + X.z * fb[0] + h * up[0],
                    X.x * a[1] + X.z * fb[1] + h * up[1],
                    X.x * a[2] + X.z * fb[2] + h * up[2],
                    Math.max(-RAMP_MAX_M, Math.min(RAMP_MAX_M, dh)));
            }
        }
    }
    return out.length > 0 ? Float32Array.from(out) : undefined;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();

    const manifestPath = path.join(args.dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`error: no manifest at ${manifestPath}; run npm run bake:mesh first`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TerrainManifestFile;
    const leafZoom = manifest.mesh.maxZoom;
    const basis = makeEnuBasis(manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height);
    lidar = args.lidar && fs.existsSync(args.lidarStore) ? new LidarStore(args.lidarStore, args.src) : undefined;
    console.log(lidar ? `lidar: deck ends at the approaches measured in ${args.lidarStore}` : 'lidar: none');
    const meshTiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.mesh.indexPath ?? 'index_mesh.bin')));
    const tiles = meshTiles.filter(k => k.z === leafZoom
        && (args.bbox === undefined || overlaps(boundsOf(k), args.bbox)));
    console.log(`bake_planet_bridges: ${tiles.length} leaf tiles z${leafZoom}${args.bbox ? ' (scoped)' : ''}`);

    const written: TileKey[] = [];
    const emptied: TileKey[] = [];
    const stat = {
        spans: 0, planned: 0, tunnels: 0, dropped: 0, offMesh: 0, buried: 0,
        piers: 0, joints: 0, piersMoved: 0, piersDropped: 0, piersAligned: 0, skewedEnds: 0, roadEnds: 0, sharedNodes: 0, joins: 0, joinsAcross: 0, stayedDown: 0, endsExtended: 0, long: 0, rail: 0, overRoads: 0, givesWay: 0, forNeighbours: 0, ramps: 0, liftedEnds: 0, tris: 0, gz: 0, humps2: 0, humps4: 0, humpMax: 0,
    };
    let lastLine = 0;
    const furniture: CrossingFurnitureStats & { tris: number } = { crossings: 0, sides: 0, tris: 0 };
    // First every span as it would stand on its own: where its deck ends
    // stand raised. A road that dips under a bridge it gives way to may have
    // one of these on it a few metres on, in this tile or the next.
    const raised = new Map<string, RaisedEnd[]>();
    const dips = new Map<string, DipPoint[]>();
    // The highest deck end at each span-end node, above the ellipsoid: the
    // spans of one bridge meeting there, planned apart, stand at one height.
    const nodeTop = new Map<string, Array<{ lat: number; lon: number; top: number }>>();
    const firstScope = new Set<string>();
    for (const k of tiles) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                firstScope.add(keyOf({ z: k.z, x: k.x + dx, y: k.y + dy }));
            }
        }
    }
    for (const key of firstScope) {
        const [z, x, y] = key.split('/').map(Number);
        const k = { z, x, y };
        const rbrPath = tilePath(args.src, k, '.rbr');
        const ptmPath = tilePath(args.dir, k, '.ptm');
        if (!fs.existsSync(rbrPath) || !fs.existsSync(ptmPath)) {
            continue;
        }
        const ptm = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
        if (isPtmGraded(ptm) && !warnedGraded) {
            // A neighbour outside the box, graded already: its raised deck ends are read off
            // the graded land. Close enough for the ramps they feed; the box itself must not be.
            warnedGraded = true;
            console.warn(`warning: graded neighbour tiles (${key} and maybe more) are read for raised deck ends`);
        }
        const surface = extendSurface(args.dir, k, ptm, tileSurface(ptm, basis), basis);
        const abs = absHeights(ptm, surface, basis);
        const ends: RaisedEnd[] = [];
        const records = decodeRbr(fs.readFileSync(rbrPath));
        for (const [si, baked] of records.entries()) {
            if (baked.structure === 'tunnel' || baked.points.length < 2) {
                continue;
            }
            const rec = clearAbutments(baked, records, nearbyRoads(args.src, k), surface).rec;
            let { plan, points, lower } = planSpan(args.src, k, surface, rec, si);
            if (plan && staysDownAtJunction(plan, rec, nearbyRoads(args.src, k), surface)) {
                ({ plan, points, lower } = planSpan(args.src, k, surface, rec, si, new Set(), undefined, true));
            }
            if (!plan) {
                continue;
            }
            const sunk = spanDips(plan, points, lower, abs);
            if (sunk.length > 0) {
                dips.set(key, [...(dips.get(key) ?? []), ...sunk]);
            }
            [0, rec.points.length - 1].forEach((pi, e) => {
                const at = plan.stations[e === 0 ? 0 : plan.stations.length - 1];
                const p = rec.points[pi];
                const cell = nodeCell(p, 0, 0);
                (nodeTop.get(cell) ?? nodeTop.set(cell, []).get(cell)!).push({ lat: p.lat, lon: p.lon, top: abs(at.x, at.z, at.deckY) });
                if (plan.abutmentLiftM[e] >= RAISED_END_M) {
                    const st = plan.stations[e === 0 ? 0 : plan.stations.length - 1];
                    ends.push({
                        lon: rec.points[pi].lon, lat: rec.points[pi].lat, lift: plan.abutmentLiftM[e],
                        top: abs(st.x, st.z, st.deckY), tier: bedTierOf(rec.cls),
                    });
                }
            });
        }
        if (ends.length > 0) {
            raised.set(key, ends);
        }
    }
    console.log(`raised ends  ${[...raised.values()].reduce((n, e) => n + e.length, 0)} on ${raised.size} tiles (first pass, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    // Every tile's spans planned first, so a tile can join its own to a
    // neighbour's beside them across the border (bridgeJoin.ts); kept above
    // the ellipsoid for the neighbour to read in its own frame.
    const plansOf = new Map<string, { pending: PendingSpan[]; geo: GeoPlan[] }>();
    for (let i = 0; i < tiles.length; i++) {
        const k = tiles[i];
        const rbrPath = tilePath(args.src, k, '.rbr');
        const ptmPath = tilePath(args.dir, k, '.ptm');
        if (!fs.existsSync(rbrPath) || !fs.existsSync(ptmPath)) {
            continue;
        }
        const spans = decodeRbr(fs.readFileSync(rbrPath));
        const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
        assertUngradedPtm(tile, 'bake_planet_bridges');
        const surface = extendSurface(args.dir, k, tile, tileSurface(tile, basis), basis);
        const absMain = absHeights(tile, surface, basis);
        const pending: PendingSpan[] = [];
            for (const [si, baked] of spans.entries()) {
                stat.spans++;
                if (baked.structure === 'tunnel') {
                    stat.tunnels++;
                    continue;
                }
                // An abutment standing on a road beside the end: the span runs on past it.
                const cleared = clearAbutments(baked, spans, nearbyRoads(args.src, k), surface);
                const rec = cleared.rec;
                stat.endsExtended += cleared.extended;
                let { points, plan, crossings, lower } = planSpan(args.src, k, surface, rec, si);
                // A deck end lifted where the road it carries meets another at
                // ground level a few metres on: no room to come down. It stays
                // on the ground, and what it crosses goes under it.
                const stayDown = plan !== undefined && staysDownAtJunction(plan, rec, nearbyRoads(args.src, k), surface);
                if (stayDown) {
                    stat.stayedDown++;
                    ({ points, plan, crossings, lower } = planSpan(args.src, k, surface, rec, si, new Set(), undefined, true));
                }
                // An end shared with another span of the bridge stands at the
                // higher of their two heights: planned apart, two spans of one
                // bridge met a metre apart in height at the node between them.
                const sharedEnds = (p: BridgePlan | undefined): [number | undefined, number | undefined] | undefined => {
                    if (!p) {
                        return undefined;
                    }
                    const out = ([0, rec.points.length - 1] as const).map((pi, e) => {
                        const at = p.stations[e === 0 ? 0 : p.stations.length - 1];
                        const top = sharedTop(nodeTop, rec.points[pi]);
                        const mine = absMain(at.x, at.z, at.deckY);
                        return top !== undefined && top > mine + SHARED_NODE_SLACK_M ? at.deckY + (top - mine) : undefined;
                    }) as [number | undefined, number | undefined];
                    return out[0] !== undefined || out[1] !== undefined ? out : undefined;
                };
                const shared = sharedEnds(plan);
                if (shared) {
                    stat.sharedNodes++;
                    ({ points, plan, crossings, lower } = planSpan(args.src, k, surface, rec, si, new Set(), shared, stayDown));
                }
                // Over a road it gives way to, it stays on the ground - unless
                // that road has a raised deck of its own too near on: dipping
                // under this one and climbing onto that, it could not keep its
                // grade. Then this one is lifted over it after all.
                if (plan) {
                    const over = new Set<number>();
                    const ends = raisedNear(raised, k, surface);
                    lower.forEach((road, li) => {
                        if (cannotDipUnder(plan!, points, road, lower, ends)) {
                            over.add(li);
                        }
                    });
                    if (over.size > 0) {
                        stat.forNeighbours++;
                        ({ points, plan, crossings, lower } = planSpan(args.src, k, surface, rec, si, over, shared, stayDown));
                    }
                }
                // Judged on the span's own stations: the ramp planner probes past the
                // ends, and off the mesh there is no reason to drop a span that fits.
                const offMesh = plan === undefined ? 0 : plan.stations.filter(
                    st => surface.landH(st.x, st.z) === undefined && surface.waterH(st.x, st.z) === undefined).length;
                if (!plan || offMesh * 2 > plan.stations.length) {
                    stat.offMesh++;
                    continue;
                }
                stat.planned++;
                if (crossings.length > 0) {
                    stat.overRoads++;
                } else if (spanCrossings(points, lower).length > 0) {
                    stat.givesWay++;
                }
                // How far the deck rises above the straight line between its ends: a
                // hill in the road, which reads as a rollercoaster when nothing under
                // the span needs it.
                {
                    const a = plan.stations[0], b = plan.stations[plan.stations.length - 1];
                    let hump = 0;
                    for (const st of plan.stations) {
                        const t = b.s > a.s ? (st.s - a.s) / (b.s - a.s) : 0;
                        hump = Math.max(hump, st.deckY - (a.deckY + (b.deckY - a.deckY) * t));
                    }
                    if (hump > 2) stat.humps2++;
                    if (hump > 4) stat.humps4++;
                    stat.humpMax = Math.max(stat.humpMax, hump);
                }
                stat.buried += plan.buried;
                stat.piers += plan.piers.length;
                stat.piersMoved += plan.piersOffRoads?.moved ?? 0;
                stat.piersDropped += plan.piersOffRoads?.dropped ?? 0;
                stat.skewedEnds += (plan.endSkew ?? []).filter(Boolean).length;
                stat.piersAligned += plan.piers.filter(p => p.across).length;
                {
                    // Joints a pier could stand at: whole bays of PIER_SPACING_M, less one.
                    const bays = Math.round(plan.lengthM / PIER_SPACING_M);
                    if (['slab', 'beam', 'arch', 'truss'].includes(plan.structure) && bays >= 2) {
                        stat.joints += bays - 1;
                        stat.long++;
                    }
                }
                if (plan.abutmentLiftM[0] > TALL_ABUTMENT_M || plan.abutmentLiftM[1] > TALL_ABUTMENT_M) {
                    stat.liftedEnds++;
                    if (process.env.DIAG_TALL) console.log(`tall end ${rec.points[0].lat.toFixed(5)},${rec.points[0].lon.toFixed(5)} -> ${rec.points[rec.points.length-1].lat.toFixed(5)},${rec.points[rec.points.length-1].lon.toFixed(5)} lift ${plan.abutmentLiftM.map(v=>v.toFixed(1))}`);
                }
                let track: TrackStroke | undefined;
                if (rec.cls !== undefined && isRailClass(rec.cls)) {
                    plan.deckRole = BridgeRole.RailDeck;
                    stat.rail++;
                    // The sleepers and rails carry on across the deck.
                    track = buildTrackStroke(plan, surface.frame,
                        Math.max(0.5, (rec.deckWidthM - RAIL_DECK_MARGIN_M) / 2), rec.cls, ROAD_SIDE_BIT);
                }
                pending.push({ plan, tier: bedTierOf(rec.cls), track, id: `${keyOf(k)}#${si}` });
            }
        const geo = geodeticOf(tile, surface, basis);
        plansOf.set(keyOf(k), { pending, geo: pending.map(p => toGeo(p, geo)) });
        if (Date.now() - lastLine > 500 || i === tiles.length - 1) {
            process.stdout.write(`\r  planning ${i + 1}/${tiles.length}`);
            lastLine = Date.now();
        }
    }
    process.stdout.write('\n');
    for (let i = 0; i < tiles.length; i++) {
        const k = tiles[i];
        const outPath = tilePath(args.dir, k, '.pbr');
        const rbrPath = tilePath(args.src, k, '.rbr');
        const ptmPath = tilePath(args.dir, k, '.ptm');
        let bytes: Uint8Array | undefined;
        // The tile's own road vectors, unfiltered: its level crossings are there.
        const rvrPath = tilePath(args.src, k, '.rvr');
        const ownRoads = fs.existsSync(rvrPath) ? decodeRvr(fs.readFileSync(rvrPath)) : [];
        const hasCrossings = ownRoads.some(r => r.cls === RoadClass.Crossing);
        // A tile with no bridge of its own may still have a line crossing
        // its edge to climb onto a neighbour's deck.
        const rampsNear = [-1, 0, 1].some(dx => [-1, 0, 1].some(dy => {
            const nk = keyOf({ z: k.z, x: k.x + dx, y: k.y + dy });
            return raised.has(nk) || dips.has(nk);
        }));
        if ((fs.existsSync(rbrPath) || hasCrossings || rampsNear) && fs.existsSync(ptmPath)) {
            const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
            const surface = extendSurface(args.dir, k, tile, tileSurface(tile, basis), basis);
            const built: { mesh: BridgeMesh; plan: BridgePlan; lengthM: number; track?: TrackStroke; ends?: number[] }[] = [];
            const pending = plansOf.get(keyOf(k))?.pending ?? [];
            // Bridges side by side made one: their facing parapets left out
            // and the gap between their decks closed (bridgeJoin.ts).
            // The neighbours' spans too, in this tile's frame: a join across
            // the border opens this tile's side of it, and its slab is built
            // by the tile whose span is the longer (findJoins' a).
            const absHere = absHeights(tile, surface, basis);
            const foreign: GeoPlan[] = [];
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx !== 0 || dy !== 0) {
                        foreign.push(...(plansOf.get(keyOf({ z: k.z, x: k.x + dx, y: k.y + dy }))?.geo ?? []));
                    }
                }
            }
            const all = [...pending.map(p => p.plan), ...foreign.map(g => inFrame(g, surface, absHere))];
            const ids = [...pending.map(p => p.id), ...foreign.map(g => g.id)];
            const joins = findJoins(all, ids).filter(j => j.a < pending.length || j.b < pending.length);
            openJoinedSides(all, joins);
            stat.joins += joins.filter(j => j.a < pending.length).length;
            stat.joinsAcross += joins.filter(j => j.a < pending.length && j.b >= pending.length).length;
            for (const { plan, tier, track } of pending) {
                const mesh = buildBridgeMesh(plan, surface.frame);
                // The tier of the line on it rides in the role byte, so the
                // runtime tells a road's own bridge from one crossing over it.
                const tierTag = (tier + 1) << PBR_TIER_SHIFT;
                for (let r = 0; r < mesh.roles.length; r++) {
                    mesh.roles[r] |= tierTag;
                }
                built.push({ mesh, plan, lengthM: plan.lengthM, track, ends: track ? undefined : roadDeckEnds(plan, surface.frame, tier) });
            }
            for (const j of joins.filter(jn => jn.a < pending.length)) {
                const mesh = buildJoinMesh(all, j, surface.frame);
                const A = all[j.a];
                built.push({ mesh, plan: A, lengthM: A.stations[j.pairs[j.pairs.length - 1].i].s - A.stations[j.pairs[0].i].s });
            }
            // Longest first: a full stream drops the short spans, never the viaduct.
            built.sort((a, b) => b.lengthM - a.lengthM);
            const keep: BridgeMesh[] = [];
            const tracks: TrackStroke[] = [];
            const roadEnds: number[] = [];
            let verts = 0;
            let trackVerts = 0;
            for (const b of built) {
                const tv = b.track ? b.track.positions.length / 3 : 0;
                if (verts + b.mesh.vertexCount > PBR_MAX_VERTS || trackVerts + tv > PBR_MAX_VERTS) {
                    stat.dropped++;
                    continue;
                }
                verts += b.mesh.vertexCount;
                keep.push(b.mesh);
                roadEnds.push(...(b.ends ?? []));
                if (b.track) {
                    trackVerts += tv;
                    tracks.push(b.track);
                }
            }
            // Barriers and signs at the level crossings: boxes in float32,
            // built into triangles at runtime (a board is far thinner than
            // the quantisation step the triangles above are stored in).
            const boxes = hasCrossings ? boxesInTileAxes(planCrossingFurniture(ownRoads, surface, furniture, strokeLiftM(k),
                drawnSegments(tilePath(args.dir, k, '.ptr'), surface)), surface.frame) : undefined;
            if (boxes) {
                furniture.tris += (boxes.length / PBR_BOX_FLOATS) * 12;
            }
            const ramps = rampsNear ? borderRamps(k, surface, absHeights(tile, surface, basis), ownRoads, nearbyRoads(args.src, k), raised, dips) : undefined;
            if (ramps) {
                stat.ramps += ramps.length / PBR_RAMP_FLOATS;
            }
            if (keep.length > 0 || boxes || ramps) {
                stat.roadEnds += roadEnds.length / PBR_ROAD_END_FLOATS;
                const m = concat(keep);
                bytes = zlib.gzipSync(encodePbr({
                    id: k, quantScale: tile.quantScale, positions: m.positions,
                    normals: m.normals, roles: m.roles, indices: m.indices,
                    track: tracks.length > 0 ? concatTracks(tracks) : undefined,
                    boxes,
                    ramps,
                    roadEnds: roadEnds.length > 0 ? Float32Array.from(roadEnds) : undefined,
                }), { level: 9 });
                stat.tris += m.triangleCount;
            }
        }
        if (bytes === undefined) {
            if (fs.existsSync(outPath)) {
                fs.unlinkSync(outPath);
            }
            emptied.push(k);
        } else {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, bytes);
            written.push(k);
            stat.gz += bytes.byteLength;
        }
        if (Date.now() - lastLine > 500 || i === tiles.length - 1) {
            process.stdout.write(`\r  ${i + 1}/${tiles.length} (${((i + 1) / tiles.length * 100).toFixed(1)}%)`);
            lastLine = Date.now();
        }
    }
    process.stdout.write('\n');

    // --- index and manifest -------------------------------------------------
    const indexPath = path.join(args.dir, 'index_bridges.bin');
    const present = new Map<string, TileKey>();
    if (args.bbox !== undefined && fs.existsSync(indexPath)) {
        for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
            present.set(keyOf(k), k);
        }
    }
    for (const k of emptied) {
        present.delete(keyOf(k));
    }
    for (const k of written) {
        present.set(keyOf(k), k);
    }
    fs.writeFileSync(indexPath, encodeTileIndex([...present.values()], leafZoom, leafZoom));
    manifest.bridges = {
        path: '{z}/{x}/{y}.pbr',
        indexPath: 'index_bridges.bin',
        encoding: 'PBR1',
        transport: 'gzip',
        minZoom: leafZoom,
        maxZoom: leafZoom,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`crossings    ${furniture.crossings} level crossings, ${furniture.sides} approaches furnished, ${furniture.tris} triangles`);
    console.log(`spans        ${stat.spans}  (planned ${stat.planned}, ${stat.rail} of them rail, tunnels skipped ${stat.tunnels})`);
    console.log(`over roads   ${stat.overRoads} spans lifted clear of a road they cross, ${stat.givesWay} left on the ground over a lower road (graded down under them at runtime)`);
    console.log(`border ramps ${stat.ramps} line crossings of a tile edge held off their drawn height for a deck or a dip beyond`);
    console.log(`neighbours   ${stat.forNeighbours} lifted over a lower road after all: a raised deck of its own too near on to dip under this one`);
    console.log(`piers        ${stat.piers}   of ${stat.joints} joints on ${stat.long} spans long enough for one; off roads: ${stat.piersMoved} moved along the span, ${stat.piersDropped} left out`);
    console.log(`skewed ends  ${stat.skewedEnds}  (abutments parallel to the road or track under the span); piers parallel to one beside them: ${stat.piersAligned}`);
    console.log(`road ends    ${stat.roadEnds}  (road deck ends the grading holds the arriving road to)`);
    console.log(`shared nodes ${stat.sharedNodes}  spans raised at an end to meet the next span of their bridge`);
    console.log(`stayed down  ${stat.stayedDown}  spans kept on the ground: a lifted end met a junction at ground level too near to come down`);
    console.log(`extended     ${stat.endsExtended}  span ends run on so their abutment clears a road beside them`);
    console.log(`joined       ${stat.joins}  stretches where two bridges side by side were made one (${stat.joinsAcross} across a tile border)`);
    console.log(`triangles    ${stat.tris}`);
    console.log(`tall ends    ${stat.liftedEnds}  (abutment taller than a pier: an approach embankment would read better)`);
    console.log(`off mesh     ${stat.offMesh}   dropped for the vertex cap ${stat.dropped}`);
    if (lidar) {
        // (Counted per plan: the first pass and any re-plan count again.)
        console.log(`lidar ends   ${lidarStat.measured} of ${lidarStat.ends} measured (${lidarStat.offTile} of them off their tile's land; ${lidarStat.noLidar} unmeasured: outside the lidar, or no land on the span), mean |approach lift| ${(lidarStat.sumDelta / Math.max(1, lidarStat.measured)).toFixed(2)} m, max ${lidarStat.maxDelta.toFixed(1)} m`);
    }
    console.log(`humps        >2 m: ${stat.humps2}   >4 m: ${stat.humps4}   max ${stat.humpMax.toFixed(1)} m`);
    // Stations where the straight deck passes through ground taller than RIDE_CAP_M:
    // a dyke or a hill the road cuts through, so not an error, but a rise here
    // would mean the ground read is wrong.
    console.log(`cut through  ${stat.buried} stations  (deck passes through a mound; deck is straight)`);
    console.log(`wrote ${written.length} bridge sidecars, ${(stat.gz / 1048576).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
