/**
 * Motorway grade: a vertical profile no steeper than MAX_GRADE, and the
 * embankment or cutting that carries the road on it.
 *
 * A road drapes over whatever ground the mesh has, so on a hillside it climbs
 * as steeply as the hill. A motorway does not: it is built to 4-5 %, standing
 * on an embankment where the ground falls away from that line and sunk into a
 * cutting where it rises above it. This module works both halves out:
 *
 *  - `gradeProfile` fits the flattest-deviation profile to the ground under a
 *    road, subject to the grade limit (a dynamic programme over quantised
 *    heights, so the optimum, not a clamped approximation of it).
 *  - `carveGrid` then lays that profile into a tile's height grid before it
 *    is meshed: every node inside the roadbed takes the design height, and
 *    outside it a 1:2 batter rises or falls until it meets the natural
 *    ground. Mesh, coast, decimation and the road stroke draped over it all
 *    see the roadbed as ordinary terrain, so nothing else needs to know.
 *
 * The carve is a pure function of lon/lat and the `.rgr` lines, and every
 * tile within reach of a line is given that line whole, so two neighbouring
 * tiles cut the same node the same way and no seam opens at the border.
 */

import { unzlibSync, zlibSync } from 'fflate';

/** Steepest grade a profile may have. 4.5 %: a margin under the 5 % limit. */
export const ROAD_GRADE_MAX = 0.045;

/** Height quantum of the profile, metres. */
export const GRADE_QUANT_M = 0.25;

/** Grade steps a profile may take between neighbouring samples. */
const GRADE_STEPS = 5;

/** Spacing of profile samples, metres: exactly GRADE_STEPS quanta at the maximum grade. */
export const GRADE_STEP_M = (GRADE_STEPS * GRADE_QUANT_M) / ROAD_GRADE_MAX;

/** Verge beyond the carriageway edge that stays at road height, metres. */
export const ROADBED_SHOULDER_M = 3;

/** Batter: metres of height per metre of horizontal distance (1:2). */
export const BATTER_GRADE = 0.5;

/** Farthest a batter is followed from the roadbed edge, metres. */
export const BATTER_REACH_M = 60;

const METRES_PER_DEGREE = 111320;

export interface GradePoint {
    lon: number;
    lat: number;
    /** Design height of the road surface, metres. */
    h: number;
}

export interface GradeLine {
    /** Half the carriageway width, metres. */
    halfM: number;
    points: GradePoint[];
}

/**
 * The design profile for `ground`, sampled every GRADE_STEP_M along a road:
 * the heights that stay closest to the ground (least squares) while no two
 * neighbours differ by more than `maxGrade` (default ROAD_GRADE_MAX, a
 * motorway's own limit). A lower `maxGrade` is enforced by taking fewer of
 * the GRADE_STEPS state-steps per sample at the same GRADE_STEP_M spacing -
 * rounded down, so the road is never steeper than asked, only ever flatter.
 */
export function gradeProfile(ground: readonly number[], maxGrade: number = ROAD_GRADE_MAX): number[] {
    const n = ground.length;
    if (n === 0) {
        return [];
    }
    const steps = Math.max(1, Math.min(GRADE_STEPS, Math.floor((maxGrade * GRADE_STEP_M) / GRADE_QUANT_M)));
    let lo = Infinity, hi = -Infinity;
    for (const g of ground) {
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
    }
    const base = Math.floor(lo / GRADE_QUANT_M);
    const states = Math.ceil(hi / GRADE_QUANT_M) - base + 1;
    let cost = new Float64Array(states);
    let next = new Float64Array(states);
    // For every sample and state, which state the previous sample came from.
    const from = new Int16Array(n * states);
    for (let s = 0; s < states; s++) {
        const d = (base + s) * GRADE_QUANT_M - ground[0];
        cost[s] = d * d;
    }
    for (let i = 1; i < n; i++) {
        for (let s = 0; s < states; s++) {
            const t0 = Math.max(0, s - steps);
            const t1 = Math.min(states - 1, s + steps);
            let best = Infinity;
            let arg = s;
            for (let t = t0; t <= t1; t++) {
                if (cost[t] < best) {
                    best = cost[t];
                    arg = t;
                }
            }
            const d = (base + s) * GRADE_QUANT_M - ground[i];
            next[s] = best + d * d;
            from[i * states + s] = arg;
        }
        [cost, next] = [next, cost];
    }
    let s = 0;
    for (let k = 1; k < states; k++) {
        if (cost[k] < cost[s]) {
            s = k;
        }
    }
    const out = new Array<number>(n);
    for (let i = n - 1; i >= 0; i--) {
        out[i] = (base + s) * GRADE_QUANT_M;
        if (i > 0) {
            s = from[i * states + s];
        }
    }
    return out;
}

export interface CarveBounds {
    west: number;
    south: number;
    east: number;
    north: number;
}

/**
 * Lay `lines` into a row-major height grid covering `bounds` (row 0 is the
 * north edge, as in a .pdm). Nodes at or under `seaLevel`, and nodata, are
 * left alone: a road is not built out into the sea. Returns the nodes changed.
 */
export function carveGrid(
    heights: Float32Array, size: number, bounds: CarveBounds, lines: readonly GradeLine[], seaLevel: number,
): number {
    if (lines.length === 0) {
        return 0;
    }
    const cells = size - 1;
    const lat0 = (bounds.south + bounds.north) / 2;
    const kx = METRES_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
    const ky = METRES_PER_DEGREE;
    const cellX = ((bounds.east - bounds.west) * kx) / cells;
    const cellY = ((bounds.north - bounds.south) * ky) / cells;
    const bestDist = new Float32Array(size * size).fill(Infinity);
    const bestH = new Float32Array(size * size);
    const bestHalf = new Float32Array(size * size);

    for (const line of lines) {
        // At least three quarters of a cell either side: a roadbed narrower than
        // the grid can miss every node it crosses, and then it is not there.
        const core = Math.max(line.halfM + ROADBED_SHOULDER_M, 0.75 * Math.max(cellX, cellY));
        const reach = core + BATTER_REACH_M;
        for (let k = 0; k + 1 < line.points.length; k++) {
            const a = line.points[k], b = line.points[k + 1];
            const ax = (a.lon - bounds.west) * kx, ay = (bounds.north - a.lat) * ky;
            const bx = (b.lon - bounds.west) * kx, by = (bounds.north - b.lat) * ky;
            const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach) / cellX));
            const gx1 = Math.min(cells, Math.ceil((Math.max(ax, bx) + reach) / cellX));
            const gy0 = Math.max(0, Math.floor((Math.min(ay, by) - reach) / cellY));
            const gy1 = Math.min(cells, Math.ceil((Math.max(ay, by) + reach) / cellY));
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            for (let gy = gy0; gy <= gy1; gy++) {
                const py = gy * cellY;
                for (let gx = gx0; gx <= gx1; gx++) {
                    const px = gx * cellX;
                    const t = len2 > 1e-12
                        ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
                    const dist = Math.hypot(px - ax - dx * t, py - ay - dy * t);
                    const i = gy * size + gx;
                    if (dist < bestDist[i] && dist <= reach) {
                        bestDist[i] = dist;
                        bestH[i] = a.h + (b.h - a.h) * t;
                        bestHalf[i] = core;
                    }
                }
            }
        }
    }

    let changed = 0;
    for (let i = 0; i < heights.length; i++) {
        const dist = bestDist[i];
        if (dist === Infinity) {
            continue;
        }
        const g = heights[i];
        if (!Number.isFinite(g) || g <= seaLevel) {
            continue;
        }
        const d = bestH[i];
        const slope = Math.max(0, dist - bestHalf[i]) * BATTER_GRADE;
        // Fill (road above the ground) raises the ground to the batter; cut
        // lowers it to the batter; where the batter meets natural ground it
        // stops, so the earthwork is exactly as wide as it has to be.
        const h = d > g ? Math.max(g, d - slope) : Math.min(g, d + slope);
        if (h !== g) {
            heights[i] = h;
            changed++;
        }
    }
    return changed;
}

/** RGR1: zlib of 'RGR1', u16 count, per line f32 halfM, u16 n, n x (f32 lon, f32 lat, f32 h). */
const RGR_MAGIC = 0x31524752;

export function encodeRgr(lines: readonly GradeLine[]): Uint8Array {
    let bytes = 6;
    for (const l of lines) {
        bytes += 6 + l.points.length * 12;
    }
    const buf = new Uint8Array(bytes);
    const view = new DataView(buf.buffer);
    view.setUint32(0, RGR_MAGIC, true);
    view.setUint16(4, lines.length, true);
    let o = 6;
    for (const l of lines) {
        view.setFloat32(o, l.halfM, true);
        view.setUint16(o + 4, l.points.length, true);
        o += 6;
        for (const p of l.points) {
            view.setFloat32(o, p.lon, true);
            view.setFloat32(o + 4, p.lat, true);
            view.setFloat32(o + 8, p.h, true);
            o += 12;
        }
    }
    return zlibSync(buf, { level: 9 });
}

export function decodeRgr(bytes: Uint8Array): GradeLine[] {
    const raw = unzlibSync(bytes);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (raw.byteLength < 6 || view.getUint32(0, true) !== RGR_MAGIC) {
        throw new Error('Bad RGR magic');
    }
    const count = view.getUint16(4, true);
    let o = 6;
    const out: GradeLine[] = [];
    for (let r = 0; r < count; r++) {
        const halfM = view.getFloat32(o, true);
        const n = view.getUint16(o + 4, true);
        o += 6;
        const points: GradePoint[] = [];
        for (let i = 0; i < n; i++) {
            points.push({
                lon: view.getFloat32(o, true), lat: view.getFloat32(o + 4, true), h: view.getFloat32(o + 8, true),
            });
            o += 12;
        }
        out.push({ halfM, points });
    }
    return out;
}
