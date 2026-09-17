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
 * Output is two vertices per centreline point at the same position with
 * opposite unit offsets across the road, widened per frame by
 * RiverVertProgram, exactly as a river is.
 */

import { EnuBasis, ecefToEnu, geodeticToEcef } from '../../src/script/terrain/geodesy';
import { PtmTile } from '../../src/script/terrain/ptm';
import { PTR_MAX_VERTS } from '../../src/script/terrain/ptr';
import { approxTileEdgeMetres, tileBounds } from '../../src/script/terrain/tiling';
import { RoadLine } from './rvr';

/** Cells across the facet bucket grid; 6k facets over 4k cells is a few per cell. */
const BUCKET_CELLS = 64;

/**
 * How far a road floats above the surface, as a fraction of a DEM grid cell
 * (a tile is 256 cells across). The same figure as RIVER_LIFT_CELLS: coplanar
 * speckles against the facet under it, and this is far below anything
 * visible at the scale the tile is drawn at.
 */
const ROAD_LIFT_CELLS = 0.05;

/** Cap on the samples one segment may produce, a backstop like the rivers'. */
const MAX_SUBDIVISIONS = 512;

export interface DrapedRoads {
    positions: Float32Array;
    directions: Float32Array;
    halfWidthsM: Float32Array;
    classes: Uint8Array;
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
): DrapedRoads | undefined {
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
    const liftM = ROAD_LIFT_CELLS * approxTileEdgeMetres(tile.id) / 256;

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
        for (let k = 0; k < 9; k++) {
            tri[t * 9 + k] = land[v + k] * q;
        }
        t++;
    }
    for (let i = 0; i + 2 < waterIdx.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const vi = waterIdx[i + k] * 3;
            tri[t * 9 + k * 3] = water[vi] * q;
            tri[t * 9 + k * 3 + 1] = water[vi + 1] * q;
            tri[t * 9 + k * 3 + 2] = water[vi + 2] * q;
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
    const idx: number[] = [];
    let strokes = 0;
    let dropped = 0;
    const cap = Math.min(maxVerts, PTR_MAX_VERTS);
    const ordered = [...roads].sort((a, b) => a.cls - b.cls);
    for (const road of ordered) {
        const grid = resample(road.points.map(p => toLocal(p.lon, p.lat, tile.centerHeightM)));
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
        const kept = simplifyDraped(grid, ys as number[], liftM * SIMPLIFY_LIFT_FRACTION);
        const grid2 = kept.map(i => grid[i]);
        const ys2 = kept.map(i => ys[i]!);
        if (half.length + grid2.length * 2 > cap) {
            dropped++;
            continue;
        }
        emitted(grid2, ys2, road);
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
        indices: Uint32Array.from(idx),
        strokes,
        dropped,
        triangles: idx.length / 3,
    };

    function emitted(grid: Local[], ys: number[], road: RoadLine): void {
        const base = half.length;
        const halfM = Math.max(0.5, road.widthM / 2);
        for (let i = 0; i < grid.length; i++) {
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
            const ex = grid[i].x + upX * liftM;
            const ey = ys[i]! + upY * liftM;
            const ez = grid[i].z + upZ * liftM;
            pos.push(ex, ey, ez, ex, ey, ez);
            dir.push(px, py, pz, -px, -py, -pz);
            half.push(halfM, halfM);
            cls.push(road.cls, road.cls);
        }
        for (let i = 0; i + 1 < grid.length; i++) {
            const l0 = base + i * 2;
            idx.push(l0, l0 + 1, l0 + 3, l0, l0 + 3, l0 + 2);
        }
    }
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
