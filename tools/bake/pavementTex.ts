/**
 * Pavement for the far-tile cover textures: every road and railway at its
 * true width, and the paved runways, taxiways and aprons of each airfield,
 * painted into a leaf raster so they still read past the range their
 * strokes and 3D models are drawn at.
 *
 * Painted into the leaf after the cache (like the water, see paintWater),
 * by area: each texel takes the share of it pavement covers - a 4x4 grid of
 * samples - as the mix of pavement and ground colour, and turns
 * TerrainClass.Ground (drawn in its own rgb in every colour mode) once
 * pavement holds half of it. The 2x2 fold then averages a 45 m runway
 * into a faint grey line at z9 and keeps it solid at z11, the same way it
 * treats a town's roofs - and a 5 m residential street stays a share of a
 * texel, so a city's grid tints the town instead of filling it solid grey.
 *
 * The tones and what counts as pavement follow the model
 * (src/script/scene/airfield/airfieldModel.ts): a runway in its own surface,
 * asphalt or concrete; taxiways and aprons in the field's pavement, which is
 * concrete when the primary runway is. Grass and gravel strips are drawn in
 * the ground's own colour there and are left out here.
 */

import { TerrainClass } from '../../src/script/terrain/tones';
import { PTX_NO_DATA } from '../../src/script/terrain/ptx';
import { LonLatBounds } from './shoreline';
import { ROAD_TEXEL_RGB, RAIL_TEXEL_RGB } from './coverTex';
import { RoadClass } from '../../src/script/terrain/ptr';

/** The noon palette's SCENERY_ROAD_SECONDARY: what the model draws asphalt in. */
export const ASPHALT_TEXEL_RGB: readonly [number, number, number] = [0x5d, 0x5d, 0x5d];
/** The noon palette's SCENERY_BASE_CONCRETE. */
export const CONCRETE_TEXEL_RGB: readonly [number, number, number] = [0xa5, 0x9f, 0x90];

/** Samples per texel along each axis. */
const SUB = 4;
const SAMPLES = SUB * SUB;

/** OSM surfaces of a taxiway or apron that are not pavement. */
const UNPAVED = new Set(['grass', 'grass_paver', 'gravel', 'unpaved', 'ground', 'dirt', 'compacted', 'sand', 'water']);

/** Just the parts of an airfields.json item this reads. */
export interface AirfieldPavementSource {
    lat: number;
    lon: number;
    runways: ReadonlyArray<{ widthM: number; surface: string; thresholds: number[][]; lengthM?: number; skiJump?: boolean; plates?: boolean }>;
    taxiways: ReadonlyArray<{ widthM: number; points: number[][]; surface?: string }>;
    aprons: ReadonlyArray<{ ring: number[][]; surface?: string }>;
}

interface Capsule { ax: number; ay: number; bx: number; by: number; half: number }
interface Ring { pts: Array<[number, number]>; minX: number; minY: number; maxX: number; maxY: number }

/** Pavement of one tone, in metres east/north of the field's origin. */
interface ToneGroup {
    rgb: readonly [number, number, number];
    capsules: Capsule[];
    rings: Ring[];
}

/** Pavement in one local frame (an airfield's, a tile's), ready to paint into any tile. */
export interface Pavement {
    lat0: number;
    lon0: number;
    /** Metres per degree of latitude and of longitude at the origin. */
    mLat: number;
    mLon: number;
    bounds: LonLatBounds;
    /** Painted in order: taxiways and aprons, then the runways over them. */
    groups: ToneGroup[];
}

function metresPerDegree(lat: number): { mLat: number; mLon: number } {
    const r = Math.PI / 180;
    return {
        mLat: 111132.92 - 559.82 * Math.cos(2 * lat * r) + 1.175 * Math.cos(4 * lat * r),
        mLon: 111412.84 * Math.cos(lat * r) - 93.5 * Math.cos(3 * lat * r),
    };
}

function ringOf(pts: Array<[number, number]>): Ring {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { pts, minX, minY, maxX, maxY };
}

/**
 * An airfield's paved surfaces, or undefined when it has none (a grass
 * strip). Runways are quads between their thresholds; taxiways are capsules
 * per segment, so bends and junctions are round and gap-free.
 */
export function airfieldPavement(field: AirfieldPavementSource): Pavement | undefined {
    const lat0 = field.lat, lon0 = field.lon;
    const { mLat, mLon } = metresPerDegree(lat0);
    const xy = (p: number[]): [number, number] => [(p[1] - lon0) * mLon, (p[0] - lat0) * mLat];
    const primary = [...field.runways].filter(r => !r.skiJump && r.surface !== 'metal')
        .sort((a, b) => (b.lengthM ?? 0) - (a.lengthM ?? 0))[0];
    const fieldTone = primary?.surface === 'concrete' ? CONCRETE_TEXEL_RGB : ASPHALT_TEXEL_RGB;

    const ground: ToneGroup = { rgb: fieldTone, capsules: [], rings: [] };
    for (const t of field.taxiways) {
        if (t.surface !== undefined && UNPAVED.has(t.surface)) {
            continue;
        }
        const half = t.widthM / 2;
        for (let i = 0; i + 1 < t.points.length; i++) {
            const [ax, ay] = xy(t.points[i]);
            const [bx, by] = xy(t.points[i + 1]);
            ground.capsules.push({ ax, ay, bx, by, half });
        }
    }
    for (const a of field.aprons) {
        if ((a.surface !== undefined && UNPAVED.has(a.surface)) || a.ring.length < 3) {
            continue;
        }
        ground.rings.push(ringOf(a.ring.map(xy)));
    }
    const runways: ToneGroup[] = [
        { rgb: ASPHALT_TEXEL_RGB, capsules: [], rings: [] },
        { rgb: CONCRETE_TEXEL_RGB, capsules: [], rings: [] },
    ];
    for (const r of field.runways) {
        if ((r.surface !== 'asphalt' && r.surface !== 'concrete') || r.thresholds.length < 2) {
            continue;
        }
        const [ax, ay] = xy(r.thresholds[0]);
        const [bx, by] = xy(r.thresholds[1]);
        const len = Math.hypot(bx - ax, by - ay);
        if (len < 1) {
            continue;
        }
        const px = (-(by - ay) / len) * (r.widthM / 2);
        const py = ((bx - ax) / len) * (r.widthM / 2);
        runways[r.surface === 'concrete' ? 1 : 0].rings.push(ringOf([
            [ax + px, ay + py], [bx + px, by + py], [bx - px, by - py], [ax - px, ay - py],
        ]));
    }
    return finish(lat0, lon0, mLat, mLon, [ground, ...runways]);
}

/**
 * A tile's roads and railways as pavement at their true width: everything
 * the stroke mesh draws, whatever the class. Lines of the classes the
 * stroke bake reads but never draws (turnout zones, crossings) are left out.
 */
export function roadPavement(
    roads: ReadonlyArray<{ cls: number; widthM: number; points: ReadonlyArray<{ lon: number; lat: number }> }>,
    bounds: LonLatBounds,
): Pavement | undefined {
    const lat0 = (bounds.south + bounds.north) / 2, lon0 = (bounds.west + bounds.east) / 2;
    const { mLat, mLon } = metresPerDegree(lat0);
    const road: ToneGroup = { rgb: ROAD_TEXEL_RGB, capsules: [], rings: [] };
    const rail: ToneGroup = { rgb: RAIL_TEXEL_RGB, capsules: [], rings: [] };
    for (const r of roads) {
        if (r.cls > RoadClass.RailService || !(r.widthM > 0)) {
            continue;
        }
        const g = r.cls === RoadClass.Rail || r.cls === RoadClass.RailService ? rail : road;
        const half = r.widthM / 2;
        for (let i = 0; i + 1 < r.points.length; i++) {
            const a = r.points[i], b = r.points[i + 1];
            g.capsules.push({
                ax: (a.lon - lon0) * mLon, ay: (a.lat - lat0) * mLat,
                bx: (b.lon - lon0) * mLon, by: (b.lat - lat0) * mLat, half,
            });
        }
    }
    // Roads first, so a level crossing reads as track.
    return finish(lat0, lon0, mLat, mLon, [road, rail]);
}

function finish(lat0: number, lon0: number, mLat: number, mLon: number, all: ToneGroup[]): Pavement | undefined {
    const groups = all.filter(g => g.capsules.length > 0 || g.rings.length > 0);
    if (groups.length === 0) {
        return undefined;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of groups) {
        for (const c of g.capsules) {
            minX = Math.min(minX, c.ax - c.half, c.bx - c.half); maxX = Math.max(maxX, c.ax + c.half, c.bx + c.half);
            minY = Math.min(minY, c.ay - c.half, c.by - c.half); maxY = Math.max(maxY, c.ay + c.half, c.by + c.half);
        }
        for (const r of g.rings) {
            minX = Math.min(minX, r.minX); maxX = Math.max(maxX, r.maxX);
            minY = Math.min(minY, r.minY); maxY = Math.max(maxY, r.maxY);
        }
    }
    return {
        lat0, lon0, mLat, mLon, groups,
        bounds: { west: lon0 + minX / mLon, east: lon0 + maxX / mLon, south: lat0 + minY / mLat, north: lat0 + maxY / mLat },
    };
}

function insideRing(pts: ReadonlyArray<[number, number]>, x: number, y: number): boolean {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

function inCapsule(c: Capsule, x: number, y: number): boolean {
    const dx = c.bx - c.ax, dy = c.by - c.ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - c.ax) * dx + (y - c.ay) * dy) / l2)) : 0;
    const ex = c.ax + dx * t - x, ey = c.ay + dy * t - y;
    return ex * ex + ey * ey <= c.half * c.half;
}

export function overlapsBounds(a: LonLatBounds, b: LonLatBounds): boolean {
    return a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
}

/**
 * Paint the pavement of `fields` (airfields, a tile's roads) into a `size x size` raster over the
 * lon/lat box `bounds`. Over water too, at half coverage or more: a runway
 * on a reclaimed shore is still a runway. Returns the texels painted.
 */
export function paintPavement(
    out: Uint8Array, size: number, bounds: LonLatBounds, fields: ReadonlyArray<Pavement>,
): number {
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;
    let painted = 0;
    for (const f of fields) {
        if (!overlapsBounds(f.bounds, bounds)) {
            continue;
        }
        // Texel window of the field, and each sample's position in its metres.
        const wx0 = Math.max(0, Math.floor(((f.bounds.west - bounds.west) / lonSpan) * size));
        const wx1 = Math.min(size - 1, Math.floor(((f.bounds.east - bounds.west) / lonSpan) * size));
        const wy0 = Math.max(0, Math.floor(((bounds.north - f.bounds.north) / latSpan) * size));
        const wy1 = Math.min(size - 1, Math.floor(((bounds.north - f.bounds.south) / latSpan) * size));
        if (wx1 < wx0 || wy1 < wy0) {
            continue;
        }
        const w = wx1 - wx0 + 1, h = wy1 - wy0 + 1;
        const texelM = Math.min((lonSpan / size) * f.mLon, (latSpan / size) * f.mLat);
        const sx = (px: number) => (bounds.west + (px / size) * lonSpan - f.lon0) * f.mLon;
        const sy = (py: number) => (bounds.north - (py / size) * latSpan - f.lat0) * f.mLat;
        // Metres to fractional window-texel coordinates, for each shape's box.
        const toPx = (x: number) => ((f.lon0 + x / f.mLon - bounds.west) / lonSpan) * size - wx0;
        const toPy = (y: number) => ((bounds.north - (f.lat0 + y / f.mLat)) / latSpan) * size - wy0;
        for (const g of f.groups) {
            const mask = new Uint16Array(w * h);
            const cover = (minX: number, minY: number, maxX: number, maxY: number, test: (x: number, y: number) => boolean) => {
                const x0 = Math.max(0, Math.floor(toPx(minX))), x1 = Math.min(w - 1, Math.floor(toPx(maxX)));
                const y0 = Math.max(0, Math.floor(toPy(maxY))), y1 = Math.min(h - 1, Math.floor(toPy(minY)));
                for (let py = y0; py <= y1; py++) {
                    for (let px = x0; px <= x1; px++) {
                        const i = py * w + px;
                        if (mask[i] === 0xffff) {
                            continue;
                        }
                        let bits = mask[i];
                        for (let s = 0; s < SAMPLES; s++) {
                            if ((bits & (1 << s)) === 0
                                && test(sx(wx0 + px + ((s % SUB) + 0.5) / SUB), sy(wy0 + py + (Math.floor(s / SUB) + 0.5) / SUB))) {
                                bits |= 1 << s;
                            }
                        }
                        mask[i] = bits;
                    }
                }
            };
            for (const c of g.capsules) {
                // In pieces about two texels long, so a long diagonal segment
                // tests the texels along it rather than its whole bounding box.
                const len = Math.hypot(c.bx - c.ax, c.by - c.ay);
                const pieces = Math.max(1, Math.ceil(len / (2 * texelM)));
                for (let i = 0; i < pieces; i++) {
                    const t0 = i / pieces, t1 = (i + 1) / pieces;
                    const ax = c.ax + (c.bx - c.ax) * t0, ay = c.ay + (c.by - c.ay) * t0;
                    const bx = c.ax + (c.bx - c.ax) * t1, by = c.ay + (c.by - c.ay) * t1;
                    cover(Math.min(ax, bx) - c.half, Math.min(ay, by) - c.half,
                        Math.max(ax, bx) + c.half, Math.max(ay, by) + c.half, (x, y) => inCapsule(c, x, y));
                }
            }
            for (const r of g.rings) {
                cover(r.minX, r.minY, r.maxX, r.maxY, (x, y) => insideRing(r.pts, x, y));
            }
            const [r, gg, b] = g.rgb;
            for (let py = 0; py < h; py++) {
                for (let px = 0; px < w; px++) {
                    let bits = mask[py * w + px];
                    if (bits === 0) {
                        continue;
                    }
                    let n = 0;
                    for (; bits !== 0; bits &= bits - 1) {
                        n++;
                    }
                    const share = n / SAMPLES;
                    const o = ((wy0 + py) * size + wx0 + px) * 4;
                    const cls = out[o + 3];
                    if (cls >= PTX_NO_DATA - 1) {
                        // No ground colour to mix with (no data, or water):
                        // pavement only where it holds the texel.
                        if (share < 0.5) {
                            continue;
                        }
                        out[o] = r; out[o + 1] = gg; out[o + 2] = b;
                    } else {
                        out[o] = Math.round(out[o] + (r - out[o]) * share);
                        out[o + 1] = Math.round(out[o + 1] + (gg - out[o + 1]) * share);
                        out[o + 2] = Math.round(out[o + 2] + (b - out[o + 2]) * share);
                    }
                    if (share >= 0.5) {
                        out[o + 3] = TerrainClass.Ground;
                    }
                    painted++;
                }
            }
        }
    }
    return painted;
}
