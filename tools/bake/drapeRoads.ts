/**
 * Drapes road centrelines over a finished tile mesh into the stroke stream a
 * PTR1 sidecar carries.
 *
 * The one rule, borrowed from the watercourse strokes in buildTile.ts: a
 * stroke has to sit on the surface that is *drawn*, not on the DEM it came
 * from. A coarse tile's interior is decimated to a vertical tolerance of
 * hundreds of metres, and a road draped on the DEM would be buried under
 * that much simplified hillside. So this reads the .ptm's own facets - land
 * and water, in the tile-local metres they are drawn in - and samples the
 * road where it crosses from one facet to the next, which is the only place
 * a straight segment on a planar facet needs a vertex.
 *
 * Before any of that the centreline is smoothed into a centripetal
 * Catmull-Rom curve (roadSpline.ts), so a bend reads as a bend at the
 * stroke's true width rather than as a run of OSM's corners.
 *
 * Output is two vertices per centreline point at the same position with
 * opposite unit offsets across the road, widened per frame by
 * RiverVertProgram, exactly as a river is.
 */

import { EnuBasis, ecefToEnu, geodeticToEcef } from '../../src/script/terrain/geodesy';
import { PtmTile } from '../../src/script/terrain/ptm';
import {
    ALONG_WRAP_M, PTR_MAX_VERTS, ROAD_SIDE_BIT, RoadClass, TRACK_FLAG_CROSSING, TRACK_FLAG_LONG_NEG, TRACK_FLAG_LONG_POS,
    TRACK_FLAG_NO_SLEEPERS, TRACK_FLAG_REACH_MASK, TRACK_FLAG_REACH_SHIFT, TRACK_LONG_TIMBER_EXTRA_M,
    TRACK_LONG_TIMBER_STEP_M, TRACK_REACH_LEVELS,
    isRailClass, isZoneClass, roadDrapeRank,
} from '../../src/script/terrain/ptr';
import { approxTileEdgeMetres, tileBounds } from '../../src/script/terrain/tiling';
import { RoadLine } from './rvr';
import { smoothRoad } from './roadSpline';

/** Cells across the facet bucket grid; 6k facets over 4k cells is a few per cell. */
const BUCKET_CELLS = 64;

/**
 * How far a road floats above the surface, as a fraction of a DEM grid cell
 * (a tile is 256 cells across). The same figure as RIVER_LIFT_CELLS: coplanar
 * speckles against the facet under it, and this is far below anything
 * visible at the scale the tile is drawn at.
 */
const ROAD_LIFT_CELLS = 0.05;

/** How far a stroke floats over the drawn surface on tile `id`, metres. */
export function strokeLiftM(id: { z: number; x: number; y: number }): number {
    return ROAD_LIFT_CELLS * approxTileEdgeMetres(id) / 256;
}

/** Cap on the samples one segment may produce, a backstop like the rivers'. */
const MAX_SUBDIVISIONS = 512;

export interface DrapedRoads {
    positions: Float32Array;
    directions: Float32Array;
    halfWidthsM: Float32Array;
    classes: Uint8Array;
    /** Metres along each stroke from its start, per vertex. */
    alongM: Float32Array;
    /** TRACK_FLAG_* bits per vertex: switch zones on the track. */
    flags: Uint8Array;
    /** Track points flagged inside a switch zone, for the bake summary. */
    zonePoints: number;
    indices: Uint32Array;
    /** Strokes emitted, and strokes dropped because the stream was full. */
    strokes: number;
    dropped: number;
    triangles: number;
}

interface Local {
    x: number;
    y: number;
    z: number;
}

/**
 * Drape `roads` over `tile`. Roads are taken in class order, major first,
 * so a full stream drops residential streets and never the motorway.
 * Returns undefined when nothing could be draped.
 */
export function drapeRoads(
    tile: PtmTile, basis: EnuBasis, roads: readonly RoadLine[], maxVerts: number = PTR_MAX_VERTS,
    /**
     * Smooth the centreline into a curve first (roadSpline.ts). Only worth it
     * on a leaf: every coarser tile is drawn from where a road is a couple of
     * pixels wide and a mapped corner cannot be told from a curve, and its
     * nodes were simplified to half a cell, far past what the spline's offset
     * cap lets it round anyway.
     */
    smooth: boolean = true,
): DrapedRoads | undefined {
    // Switch zones come in with the roads but are flags, never strokes.
    const zoneLines = roads.filter(r => isZoneClass(r.cls));
    roads = roads.filter(r => !isZoneClass(r.cls));
    if (roads.length === 0) {
        return undefined;
    }
    const bounds = tileBounds(tile.id);
    const lat0 = (bounds.south + bounds.north) / 2;
    const lon0 = (bounds.west + bounds.east) / 2;
    const centre = ecefToEnu(basis, geodeticToEcef(lat0, lon0, tile.centerHeightM));
    const toLocal = (lon: number, lat: number, h: number): Local => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, h));
        return { x: enu.e - centre.e, y: enu.u - centre.u, z: centre.n - enu.n };
    };
    // Local vertical at the tile centre, in the bake frame's axes: far from
    // the frame's origin it leans away from y, and a stroke lifted along y
    // would lean off its facet by the same angle.
    const upA = toLocal(lon0, lat0, tile.centerHeightM);
    const upB = toLocal(lon0, lat0, tile.centerHeightM + 1000);
    let upX = upB.x - upA.x, upY = upB.y - upA.y, upZ = upB.z - upA.z;
    const upLen = Math.hypot(upX, upY, upZ);
    upX /= upLen; upY /= upLen; upZ /= upLen;
    const liftM = strokeLiftM(tile.id);
    // The drape works in a sheared frame: every point slides along the local
    // vertical to the y = 0 plane, so a road point at (lon, lat) and the mesh
    // vertex above it share one (x, z) whatever their height. Without it a
    // road placed at the tile's centre height and a facet at real height
    // part company horizontally by dh * sin(tilt), and far from the frame's
    // origin (tilt 60+ deg) that was hundreds of metres to a mile.
    const shear = Math.abs(upY) > 0.05;
    const shearX = shear ? upX / upY : 0;
    const shearZ = shear ? upZ / upY : 0;

    // --- the drawn facets, in metres, bucketed on x/z ----------------------
    const q = tile.quantScale;
    const land = tile.landPositions;
    const water = tile.waterPositions;
    const waterIdx = tile.waterIndices;
    const triCount = land.length / 9 + waterIdx.length / 3;
    if (triCount === 0) {
        return undefined;
    }
    const tri = new Float64Array(triCount * 9);
    let t = 0;
    for (let v = 0; v + 8 < land.length; v += 9) {
        for (let k = 0; k < 9; k += 3) {
            const y = land[v + k + 1] * q;
            tri[t * 9 + k] = land[v + k] * q - y * shearX;
            tri[t * 9 + k + 1] = y;
            tri[t * 9 + k + 2] = land[v + k + 2] * q - y * shearZ;
        }
        t++;
    }
    for (let i = 0; i + 2 < waterIdx.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const vi = waterIdx[i + k] * 3;
            const y = water[vi + 1] * q;
            tri[t * 9 + k * 3] = water[vi] * q - y * shearX;
            tri[t * 9 + k * 3 + 1] = y;
            tri[t * 9 + k * 3 + 2] = water[vi + 2] * q - y * shearZ;
        }
        t++;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < triCount * 9; i += 3) {
        const x = tri[i], z = tri[i + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
    }
    const cellW = Math.max(1e-6, (maxX - minX) / BUCKET_CELLS);
    const cellH = Math.max(1e-6, (maxZ - minZ) / BUCKET_CELLS);
    const cellOf = (x: number, z: number): [number, number] => [
        Math.min(BUCKET_CELLS - 1, Math.max(0, Math.floor((x - minX) / cellW))),
        Math.min(BUCKET_CELLS - 1, Math.max(0, Math.floor((z - minZ) / cellH))),
    ];
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < triCount; i++) {
        const o = i * 9;
        const [cx0, cz0] = cellOf(Math.min(tri[o], tri[o + 3], tri[o + 6]), Math.min(tri[o + 2], tri[o + 5], tri[o + 8]));
        const [cx1, cz1] = cellOf(Math.max(tri[o], tri[o + 3], tri[o + 6]), Math.max(tri[o + 2], tri[o + 5], tri[o + 8]));
        for (let cz = cz0; cz <= cz1; cz++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const key = cz * BUCKET_CELLS + cx;
                const list = buckets.get(key);
                if (list) {
                    list.push(i);
                } else {
                    buckets.set(key, [i]);
                }
            }
        }
    }

    /** Height of the highest drawn facet over (x, z), or undefined off the mesh. */
    const surfaceY = (x: number, z: number): number | undefined => {
        const [cx, cz] = cellOf(x, z);
        let best: number | undefined;
        const EDGE_EPS = 1e-4;
        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const ccx = cx + dx, ccz = cz + dz;
                if (ccx < 0 || ccz < 0 || ccx >= BUCKET_CELLS || ccz >= BUCKET_CELLS) {
                    continue;
                }
                const list = buckets.get(ccz * BUCKET_CELLS + ccx);
                if (!list) {
                    continue;
                }
                for (const i of list) {
                    const o = i * 9;
                    const x0 = tri[o], y0 = tri[o + 1], z0 = tri[o + 2];
                    const x1 = tri[o + 3], y1 = tri[o + 4], z1 = tri[o + 5];
                    const x2 = tri[o + 6], y2 = tri[o + 7], z2 = tri[o + 8];
                    const det = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
                    if (Math.abs(det) < 1e-9) {
                        continue;
                    }
                    const l0 = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / det;
                    const l1 = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / det;
                    const l2 = 1 - l0 - l1;
                    if (l0 < -EDGE_EPS || l1 < -EDGE_EPS || l2 < -EDGE_EPS) {
                        continue;
                    }
                    const y = y0 * l0 + y1 * l1 + y2 * l2;
                    if (best === undefined || y > best) {
                        best = y;
                    }
                }
            }
        }
        return best;
    };

    /** Parameters in (0, 1) where segment a-b crosses a facet edge, sorted. */
    const stamp = new Int32Array(triCount);
    let serial = 0;
    const crossings = (a: Local, b: Local): number[] | undefined => {
        const [cx0, cz0] = cellOf(Math.min(a.x, b.x), Math.min(a.z, b.z));
        const [cx1, cz1] = cellOf(Math.max(a.x, b.x), Math.max(a.z, b.z));
        if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > MAX_SUBDIVISIONS) {
            return undefined;
        }
        const dx = b.x - a.x, dz = b.z - a.z;
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        const loZ = Math.min(a.z, b.z), hiZ = Math.max(a.z, b.z);
        const ts: number[] = [];
        const s = ++serial;
        for (let cz = cz0; cz <= cz1; cz++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const list = buckets.get(cz * BUCKET_CELLS + cx);
                if (!list) {
                    continue;
                }
                for (const i of list) {
                    if (stamp[i] === s) {
                        continue;
                    }
                    stamp[i] = s;
                    const o = i * 9;
                    if (Math.min(tri[o], tri[o + 3], tri[o + 6]) > hi || Math.max(tri[o], tri[o + 3], tri[o + 6]) < lo
                        || Math.min(tri[o + 2], tri[o + 5], tri[o + 8]) > hiZ || Math.max(tri[o + 2], tri[o + 5], tri[o + 8]) < loZ) {
                        continue;
                    }
                    for (let e = 0; e < 3; e++) {
                        const qx = tri[o + e * 3], qz = tri[o + e * 3 + 2];
                        const rx = tri[o + ((e + 1) % 3) * 3], rz = tri[o + ((e + 1) % 3) * 3 + 2];
                        const ex = rx - qx, ez = rz - qz;
                        const denom = dx * ez - dz * ex;
                        if (Math.abs(denom) < 1e-12) {
                            continue;
                        }
                        const u = ((qx - a.x) * ez - (qz - a.z) * ex) / denom;
                        const v = ((qx - a.x) * dz - (qz - a.z) * dx) / denom;
                        if (u > 1e-6 && u < 1 - 1e-6 && v >= -1e-6 && v <= 1 + 1e-6) {
                            ts.push(u);
                        }
                    }
                }
            }
        }
        ts.sort((p, r) => p - r);
        const out: number[] = [];
        for (const u of ts) {
            if (out.length === 0 || u - out[out.length - 1] > 1e-6) {
                out.push(u);
            }
        }
        return out;
    };

    const resample = (pts: readonly Local[]): Local[] => {
        const out: Local[] = [];
        for (const p of pts) {
            const prev = out[out.length - 1];
            if (prev === undefined) {
                out.push(p);
                continue;
            }
            if (Math.abs(p.x - prev.x) < 1e-3 && Math.abs(p.z - prev.z) < 1e-3) {
                continue;   // two OSM nodes at the same place
            }
            const ts = crossings(prev, p);
            if (ts !== undefined) {
                for (const u of ts) {
                    out.push({ x: prev.x + (p.x - prev.x) * u, y: 0, z: prev.z + (p.z - prev.z) * u });
                }
                out.push(p);
                continue;
            }
            const stepM = Math.max(cellW, cellH);
            const steps = Math.min(MAX_SUBDIVISIONS, Math.max(1, Math.ceil(Math.hypot(p.x - prev.x, p.z - prev.z) / stepM)));
            for (let s = 1; s <= steps; s++) {
                const u = s / steps;
                out.push({ x: prev.x + (p.x - prev.x) * u, y: 0, z: prev.z + (p.z - prev.z) * u });
            }
        }
        return out;
    };

    // --- emit ---------------------------------------------------------------
    const pos: number[] = [];
    const dir: number[] = [];
    const half: number[] = [];
    const cls: number[] = [];
    const along: number[] = [];
    const flagOut: number[] = [];
    const idx: number[] = [];
    let zonePoints = 0;
    // The zones in the same sheared horizontal frame as the stroke points.
    const zones = zoneLines.map(z => ({
        through: z.cls === RoadClass.ZoneThrough,
        crossing: z.cls === RoadClass.Crossing,
        pts: z.points.map(p => {
            const l = toLocal(p.lon, p.lat, tile.centerHeightM);
            return { x: l.x - l.y * shearX, z: l.z - l.y * shearZ };
        }),
    }));
    let strokes = 0;
    let dropped = 0;
    const cap = Math.min(maxVerts, PTR_MAX_VERTS);
    const ordered = [...roads].sort((a, b) => roadDrapeRank(a.cls) - roadDrapeRank(b.cls));
    for (const road of ordered) {
        // Smoothed into a curve first, in the tile's horizontal metres, so the
        // facet crossings and the height simplifier below see the curve and
        // not the OSM polyline (see roadSpline.ts).
        const local = road.points.map(p => {
            const l = toLocal(p.lon, p.lat, tile.centerHeightM);
            return { x: l.x - l.y * shearX, y: l.y, z: l.z - l.y * shearZ };
        });
        const track = smooth ? smoothRoad(local) : local;
        const sampled = resample(track.map(p => ({ x: p.x, y: 0, z: p.z })));
        // Near a switch zone or a crossing, track gets a point every metre:
        // a straight run is otherwise sampled only at the mesh cells, ~19 m
        // apart at the leaf, and a 33 m zone could hold no point at all.
        const grid = isRailClass(road.cls) && zones.length > 0 ? densifyNearZones(sampled, zones) : sampled;
        if (grid.length < 2) {
            continue;
        }
        // Heights first: a point off every facet (a road clipped a hair
        // outside the mesh's skirt) takes its neighbour's, so a whole run is
        // not thrown away for one endpoint.
        const ys = grid.map(p => surfaceY(p.x, p.z));
        for (let i = 0; i < ys.length; i++) {
            if (ys[i] === undefined) {
                ys[i] = ys[i - 1] ?? ys.find(y => y !== undefined);
            }
        }
        if (ys[0] === undefined) {
            dropped++;
            continue;
        }
        const zoneFlags = isRailClass(road.cls) && zones.length > 0 ? flagSwitchZones(grid, zones) : undefined;
        let kept = simplifyDraped(grid, ys as number[], liftM * SIMPLIFY_LIFT_FRACTION);
        if (zoneFlags) {
            // A flag must change between two points a metre or so apart, not
            // fade over a long simplified segment: keep both sides of every change.
            const keep = new Set(kept);
            for (let i = 1; i < zoneFlags.length; i++) {
                if (zoneFlags[i] !== zoneFlags[i - 1]) {
                    keep.add(i - 1);
                    keep.add(i);
                }
            }
            kept = [...keep].sort((a, b) => a - b);
            zonePoints += kept.filter(i => zoneFlags[i] !== 0).length;
        }
        const ys2 = kept.map(i => ys[i]!);
        // Back out of the sheared frame: the point sits at its facet's height.
        const grid2 = kept.map((i, k) => ({
            x: grid[i].x + ys2[k] * shearX, y: 0, z: grid[i].z + ys2[k] * shearZ,
        }));
        if (half.length + grid2.length * 2 > cap) {
            dropped++;
            continue;
        }
        emitted(grid2, ys2, road, zoneFlags ? kept.map(i => zoneFlags[i]) : undefined);
        strokes++;
    }
    if (strokes === 0) {
        return undefined;
    }
    return {
        positions: Float32Array.from(pos),
        directions: Float32Array.from(dir),
        halfWidthsM: Float32Array.from(half),
        classes: Uint8Array.from(cls),
        alongM: Float32Array.from(along),
        flags: Uint8Array.from(flagOut),
        zonePoints,
        indices: Uint32Array.from(idx),
        strokes,
        dropped,
        triangles: idx.length / 3,
    };

    function emitted(grid: Local[], ys: number[], road: RoadLine, flags?: number[]): void {
        const halfM = Math.max(0.5, road.widthM / 2);
        // Per point first: position, offset, distance along, flags.
        const pts: { e: number[]; p: number[]; run: number; f: number; h: number }[] = [];
        let run = 0;
        for (let i = 0; i < grid.length; i++) {
            if (i > 0) {
                run += Math.hypot(grid[i].x - grid[i - 1].x, ys[i]! - ys[i - 1]!, grid[i].z - grid[i - 1].z);
            }
            const a = grid[Math.max(0, i - 1)];
            const b = grid[Math.min(grid.length - 1, i + 1)];
            const tx = b.x - a.x, ty = (ys[Math.min(grid.length - 1, i + 1)]! - ys[Math.max(0, i - 1)]!), tz = b.z - a.z;
            // Across the road in the tile's horizontal plane: up x tangent.
            let px = upY * tz - upZ * ty;
            let py = upZ * tx - upX * tz;
            let pz = upX * ty - upY * tx;
            const plen = Math.hypot(px, py, pz);
            if (!(plen > 1e-6)) {
                px = 1; py = 0; pz = 0;
            } else {
                px /= plen; py /= plen; pz /= plen;
            }
            const f = flags ? flags[i] : 0;
            // Long timbers need bed under them: a switch zone's through
            // track is widened to carry them (one track, see RAIL_FRAGMENT).
            const level = (f & TRACK_FLAG_REACH_MASK) >> TRACK_FLAG_REACH_SHIFT;
            const h = f & (TRACK_FLAG_LONG_POS | TRACK_FLAG_LONG_NEG)
                ? Math.max(halfM, SWITCH_ZONE_HALF_M + level * TRACK_LONG_TIMBER_STEP_M) : halfM;
            pts.push({
                e: [grid[i].x + upX * liftM, ys[i]! + upY * liftM, grid[i].z + upZ * liftM],
                p: [px, py, pz], run, f, h,
            });
        }
        const pair = (e: number[], pv: number[], at: number, f: number, h: number): number => {
            const v = half.length;
            pos.push(e[0], e[1], e[2], e[0], e[1], e[2]);
            dir.push(pv[0], pv[1], pv[2], -pv[0], -pv[1], -pv[2]);
            half.push(h, h);
            cls.push(road.cls, road.cls | ROAD_SIDE_BIT);
            along.push(at, at);
            flagOut.push(f, f);
            return v;
        };
        const quad = (l0: number, l1: number) => idx.push(l0, l0 + 1, l1 + 1, l0, l1 + 1, l1);
        let prev = pair(pts[0].e, pts[0].p, pts[0].run, pts[0].f, pts[0].h);
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            // The distance along is stored wrapped at ALONG_WRAP_M, and the
            // shader interpolates it: a segment across a wrap would sweep
            // back through kilometres of sleepers in a few metres. Split it
            // there and start a new strip at zero.
            const k = Math.floor(b.run / ALONG_WRAP_M);
            if (k > Math.floor(a.run / ALONG_WRAP_M) && b.run > a.run) {
                const wrapAt = k * ALONG_WRAP_M;
                const t = (wrapAt - a.run) / (b.run - a.run);
                const e = a.e.map((v, c) => v + (b.e[c] - v) * t);
                const end = pair(e, a.p, wrapAt - ALONG_WRAP_END_M, a.f, a.h);
                quad(prev, end);
                prev = pair(e, b.p, wrapAt, b.f, b.h);
            }
            const next = pair(b.e, b.p, b.run, b.f, b.h);
            quad(prev, next);
            prev = next;
        }
    }
}

/**
 * Half the bed a switch zone's through track is widened to, metres: an
 * ordinary sleeper (1.3) plus the long timber's reach (LONG_TIMBER_EXTRA_M
 * in depthFP.ts, 2.9) and a margin.
 */
const SWITCH_ZONE_HALF_M = 4.4;
/**
 * How far short of a wrap the vertex ending a strip is put, metres: enough
 * that it rounds to the last ALONG_STEP_M before the wrap, not onto it.
 */
const ALONG_WRAP_END_M = 0.03;
/** A track point this close to a zone polyline is on it, metres. */
const ZONE_ON_M = 0.5;
/**
 * A track point this close to a diverging zone is that diverging track,
 * whatever else it is near, metres: the zone is cut from the track's own
 * coordinates, and a through track strays this close only within a few
 * metres of the switch toe.
 */
const DIVERGING_SAME_M = 0.06;
/** Diverging tracks are looked for this far from a through track point, metres: two chained switches. */
const ZONE_REACH_M = 7.5;
/** Half a sleeper, outer rail head and margin: what a timber must reach past a diverging centreline, metres. */
const TIMBER_PAST_CENTRE_M = 0.72 + 0.3;
/** Half an ordinary sleeper, metres (SLEEPER_HALF_LENGTH_M in depthFP.ts). */
const SLEEPER_HALF_M = 1.3;

/** The smallest reach level whose long timbers cover a diverging track `d` metres off. */
export function reachLevel(d: number): number {
    const extra = d + TIMBER_PAST_CENTRE_M - SLEEPER_HALF_M;
    const level = Math.ceil((extra - TRACK_LONG_TIMBER_EXTRA_M) / TRACK_LONG_TIMBER_STEP_M);
    return Math.max(0, Math.min(TRACK_REACH_LEVELS, level));
}

/**
 * TRACK_FLAG_* for each point of a track stroke: on a turnout's through
 * zone, long timbers toward the side the diverging zone lies on; on its
 * diverging zone, no sleepers of its own. Near the switch both zones are a
 * hair apart, so a point goes with the nearer.
 */
export function flagSwitchZones(
    grid: ReadonlyArray<{ x: number; z: number }>,
    zones: ReadonlyArray<{ through: boolean; crossing?: boolean; pts: ReadonlyArray<{ x: number; z: number }> }>,
): number[] {
    const out = new Array<number>(grid.length).fill(0);
    const pad = ZONE_REACH_M;
    const boxes = zones.map(z => {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const q of z.pts) {
            x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z);
        }
        return { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
    });
    for (let i = 0; i < grid.length; i++) {
        const p = grid[i];
        let dThrough = Infinity, dDiverging = Infinity, dCrossing = Infinity;
        // The farthest diverging track within reach on each side of the
        // stroke (+ = up x tangent, (tz, -tx) in plan): the timbers go to it.
        const a = grid[Math.max(0, i - 1)], b = grid[Math.min(grid.length - 1, i + 1)];
        let reachPos = -1, reachNeg = -1;
        for (let zi = 0; zi < zones.length; zi++) {
            const zone = zones[zi], bx = boxes[zi];
            if (p.x < bx.x0 || p.x > bx.x1 || p.z < bx.z0 || p.z > bx.z1) {
                continue;
            }
            const last = zone.pts.length - 2;
            // This zone's nearest point, for the reach: each diverging track
            // counts once, at its nearest, however long its zone.
            let zoneD = Infinity, zoneSide = 0;
            for (let k = 0; k <= last; k++) {
                const q = nearestOnSegment(p, zone.pts[k], zone.pts[k + 1]);
                // Only inside the zone: a point that projects onto its first
                // or last point lies before the switch or past the zone's end,
                // and both zones share the switch point.
                if ((k === 0 && q.t <= 0) || (k === last && q.t >= 1)) {
                    continue;
                }
                if (zone.crossing) {
                    dCrossing = Math.min(dCrossing, q.d);
                } else if (zone.through) {
                    dThrough = Math.min(dThrough, q.d);
                } else {
                    dDiverging = Math.min(dDiverging, q.d);
                    if (q.d < zoneD) {
                        zoneD = q.d;
                        zoneSide = (q.x - p.x) * (b.z - a.z) - (q.z - p.z) * (b.x - a.x);
                    }
                }
            }
            if (!zone.through && !zone.crossing && zoneD <= ZONE_REACH_M) {
                if (zoneSide >= 0) {
                    reachPos = Math.max(reachPos, zoneD);
                } else {
                    reachNeg = Math.max(reachNeg, zoneD);
                }
            }
        }
        // A crossing is on top of whatever else the track is doing there.
        const crossing = dCrossing <= ZONE_ON_M ? TRACK_FLAG_CROSSING : 0;
        out[i] = crossing;
        // On a diverging zone itself, the track draws no sleepers of its
        // own, even where it is also the through track of the next switch:
        // where switch zones overlap, one set of timbers - the root through
        // track's - lies under all of them. Near a switch toe the two tracks
        // are a hair apart, so "on" is DIVERGING_SAME_M; past that, the
        // nearer zone decides as before.
        if (dDiverging <= DIVERGING_SAME_M) {
            out[i] = crossing | TRACK_FLAG_NO_SLEEPERS;
        } else if (dThrough <= ZONE_ON_M && dThrough <= dDiverging) {
            if (reachPos < 0 && reachNeg < 0) {
                continue;
            }
            let f = crossing;
            let needed = 0;
            if (reachPos >= 0) {
                f |= TRACK_FLAG_LONG_POS;
                needed = Math.max(needed, reachPos);
            }
            if (reachNeg >= 0) {
                f |= TRACK_FLAG_LONG_NEG;
                needed = Math.max(needed, reachNeg);
            }
            out[i] = f | (reachLevel(needed) << TRACK_FLAG_REACH_SHIFT);
        } else if (dDiverging <= ZONE_ON_M) {
            out[i] = crossing | TRACK_FLAG_NO_SLEEPERS;
        }
    }
    return out;
}

/** Spacing track is densified to near zones, metres. */
const ZONE_SAMPLE_M = 1;

/**
 * `grid` with points added every ZONE_SAMPLE_M along the segments that pass
 * within ZONE_REACH_M of any zone's bounding box; elsewhere unchanged.
 */
export function densifyNearZones(
    grid: ReadonlyArray<Local>,
    zones: ReadonlyArray<{ pts: ReadonlyArray<{ x: number; z: number }> }>,
): Local[] {
    const boxes = zones.map(z => {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const q of z.pts) {
            x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z);
        }
        return { x0: x0 - ZONE_REACH_M, x1: x1 + ZONE_REACH_M, z0: z0 - ZONE_REACH_M, z1: z1 + ZONE_REACH_M };
    });
    const inside = (p: Local) => boxes.some(bx => p.x >= bx.x0 && p.x <= bx.x1 && p.z >= bx.z0 && p.z <= bx.z1);
    const touches = (a: Local, b: Local) => boxes.some(bx =>
        Math.max(a.x, b.x) >= bx.x0 && Math.min(a.x, b.x) <= bx.x1
        && Math.max(a.z, b.z) >= bx.z0 && Math.min(a.z, b.z) <= bx.z1);
    const out: Local[] = [grid[0]];
    for (let i = 1; i < grid.length; i++) {
        const a = grid[i - 1], b = grid[i];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        if (len > ZONE_SAMPLE_M && touches(a, b)) {
            // Only the stretch of the segment inside a zone's padded box.
            const steps = Math.ceil(len / ZONE_SAMPLE_M);
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                const p = { x: a.x + (b.x - a.x) * t, y: 0, z: a.z + (b.z - a.z) * t };
                if (inside(p)) {
                    out.push(p);
                }
            }
        }
        out.push(b);
    }
    return out;
}

function nearestOnSegment(
    p: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number },
): { x: number; z: number; d: number; t: number } {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2)) : 0;
    const x = a.x + dx * t, z = a.z + dz * t;
    return { x, z, d: Math.hypot(p.x - x, p.z - z), t };
}

/**
 * How far below the drawn surface a simplified stroke may dip, as a share of
 * its lift. Half: the chord between two kept samples then still floats at
 * least half the lift above every facet it crosses, so dropping the
 * crossing samples in between cannot bury it or set it speckling.
 */
const SIMPLIFY_LIFT_FRACTION = 0.5;

/** Horizontal tolerance, metres: only points on a straight line are dropped for it. */
const SIMPLIFY_HORIZONTAL_M = 0.05;

/**
 * Indices of the draped samples worth keeping: Douglas-Peucker on the
 * horizontal track and the height together.
 *
 * The facet-crossing samples put a vertex wherever the road leaves one
 * facet for the next, which is exact and, over flat ground, almost all
 * waste: on Berlin a residential street crossed a facet edge every few
 * metres and each crossing was a vertex pair, until roads were a fifth of
 * the terrain's drawn triangles and pushed the terrain over its budget.
 * A sample the straight chord between its neighbours already passes
 * within `verticalM` of, and that lies on that chord horizontally, adds
 * nothing the eye can see.
 */
export function simplifyDraped(
    grid: ReadonlyArray<{ x: number; z: number }>, ys: readonly number[], verticalM: number,
): number[] {
    const n = grid.length;
    if (n <= 2) {
        return Array.from({ length: n }, (_, i) => i);
    }
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: Array<[number, number]> = [[0, n - 1]];
    while (stack.length > 0) {
        const [a, b] = stack.pop()!;
        if (b - a < 2) {
            continue;
        }
        const ax = grid[a].x, az = grid[a].z, bx = grid[b].x, bz = grid[b].z;
        const dx = bx - ax, dz = bz - az;
        const len2 = dx * dx + dz * dz;
        let worst = -1;
        let worstScore = 1;
        for (let i = a + 1; i < b; i++) {
            const px = grid[i].x - ax, pz = grid[i].z - az;
            const t = len2 > 1e-12 ? Math.min(1, Math.max(0, (px * dx + pz * dz) / len2)) : 0;
            const off = Math.hypot(px - dx * t, pz - dz * t);
            const vert = Math.abs(ys[i] - (ys[a] + (ys[b] - ys[a]) * t));
            // Scored against each tolerance, so either one breaks the span.
            const score = Math.max(off / SIMPLIFY_HORIZONTAL_M, vert / Math.max(1e-6, verticalM));
            if (score > worstScore) {
                worstScore = score;
                worst = i;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push([a, worst], [worst, b]);
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
