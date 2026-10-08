/**
 * Railway beds for the collision surface.
 *
 * The drawn land gets its beds laid at runtime (railBed.ts), and the height
 * queries the sim crashes and lands on must see the same cuttings and
 * embankments, the way they see the airfield flatten pads. Each tile's beds
 * come in as segments with their ends in lat/lon and height above the
 * ellipsoid - not scene coordinates, which move with every floating-origin
 * re-base - and a DEM height under them is clamped into every bed's band
 * exactly as the mesh's vertices were (RailBedIndex.clamp in railBed.ts).
 *
 * Pure, and structured-clone friendly: the physics worker holds its own copy,
 * fed through the height mirror.
 */

import { EnuBasis, ecefToGeodetic, enuToEcef } from './geodesy';
import { BATTER_FADE_M, BandResolver, RAIL_BATTER_REACH_M, RAIL_BED_SEGMENT_FLOATS, RAIL_SHOULDER_M, bedSegmentParam } from './railBed';

/**
 * Floats per segment: lon, lat, height of each end, the half width, which
 * ends are open (railBed.ts BED_OPEN_A | BED_OPEN_B, a bridge's end), the
 * tier (railBed.ts BED_TIERS: railway, Autobahn, highway, street), and how
 * far past the shoulder the batter reaches (0 or absent: the full
 * RAIL_BATTER_REACH_M).
 */
export const RAIL_FIELD_SEGMENT_FLOATS = 10;
/** Grid cell, degrees: some 200 m, several segments a cell. */
const CELL_DEG = 0.002;
/** Metres per degree of latitude, and of longitude at the equator. */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;
/** Tiles kept, the oldest going first: plenty around every aircraft, a few MB. */
const MAX_TILES = 128;

export class RailBedField {
    private readonly tiles = new Map<string, { segs: Float64Array; cells: number[] }>();
    private readonly cells = new Map<number, Array<{ segs: Float64Array; i: number }>>();
    /** Bumped on every change, so a sender knows when to look. */
    version = 0;

    /** A tile's segments, replacing any it had. */
    set(key: string, segs: Float64Array): void {
        this.remove(key);
        this.tiles.set(key, { segs, cells: this.index(segs) });
        while (this.tiles.size > MAX_TILES) {
            this.remove(this.tiles.keys().next().value!);
        }
        this.version++;
    }

    delete(key: string): void {
        if (this.remove(key)) {
            this.version++;
        }
    }

    private remove(key: string): boolean {
        const tile = this.tiles.get(key);
        if (!tile) {
            return false;
        }
        this.tiles.delete(key);
        for (const c of tile.cells) {
            const list = this.cells.get(c);
            if (!list) {
                continue;
            }
            const kept = list.filter(e => e.segs !== tile.segs);
            if (kept.length > 0) {
                this.cells.set(c, kept);
            } else {
                this.cells.delete(c);
            }
        }
        return true;
    }

    has(key: string): boolean {
        return this.tiles.has(key);
    }

    get(key: string): Float64Array | undefined {
        return this.tiles.get(key)?.segs;
    }

    keys(): IterableIterator<string> {
        return this.tiles.keys();
    }

    get size(): number {
        return this.tiles.size;
    }

    /**
     * `h` (metres above the ellipsoid, at lon/lat) brought within every bed
     * that reaches here: the design height on a bed, no farther off it than
     * the 1:2 batter beside one.
     */
    clamp(lon: number, lat: number, h: number): number {
        if (this.tiles.size === 0) {
            return h;
        }
        const list = this.cells.get(cellKey(Math.floor(lon / CELL_DEG), Math.floor(lat / CELL_DEG)));
        if (!list) {
            return h;
        }
        const kx = M_PER_DEG_LON * Math.cos(lat * Math.PI / 180);
        const resolver = this.resolver;
        resolver.reset();
        for (const { segs, i } of list) {
            const o = i * RAIL_FIELD_SEGMENT_FLOATS;
            // Metres east and north of the segment's first end.
            const ax = 0, ay = 0;
            const bx = (segs[o + 3] - segs[o]) * kx, by = (segs[o + 4] - segs[o + 1]) * M_PER_DEG_LAT;
            const px = (lon - segs[o]) * kx, py = (lat - segs[o + 1]) * M_PER_DEG_LAT;
            const t = bedSegmentParam(px - ax, py - ay, bx, by, segs[o + 7]);
            if (t === undefined) {
                continue;
            }
            const d = Math.hypot(px - bx * t, py - by * t);
            const excess = Math.max(0, d - segs[o + 6] - RAIL_SHOULDER_M);
            const reach = segs[o + 9] || RAIL_BATTER_REACH_M;
            if (excess > reach + BATTER_FADE_M) {
                continue;
            }
            resolver.add(segs[o + 8], segs[o + 2] + (segs[o + 5] - segs[o + 2]) * t, excess, reach);
        }
        // Who wins where lines of different priority meet: as the drawn
        // ground decided it (railBed.ts BandResolver).
        return resolver.resolve(h);
    }

    private readonly resolver = new BandResolver();

    /** Puts a tile's segments in the grid; returns the cells it touched. */
    private index(segs: Float64Array): number[] {
        const touched = new Set<number>();
        {
            const n = segs.length / RAIL_FIELD_SEGMENT_FLOATS;
            for (let i = 0; i < n; i++) {
                const o = i * RAIL_FIELD_SEGMENT_FLOATS;
                const lat = segs[o + 1];
                const reach = segs[o + 6] + RAIL_SHOULDER_M + (segs[o + 9] || RAIL_BATTER_REACH_M) + BATTER_FADE_M;
                const rLat = reach / M_PER_DEG_LAT;
                const rLon = reach / (M_PER_DEG_LON * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
                const x0 = Math.floor((Math.min(segs[o], segs[o + 3]) - rLon) / CELL_DEG);
                const x1 = Math.floor((Math.max(segs[o], segs[o + 3]) + rLon) / CELL_DEG);
                const y0 = Math.floor((Math.min(segs[o + 1], segs[o + 4]) - rLat) / CELL_DEG);
                const y1 = Math.floor((Math.max(segs[o + 1], segs[o + 4]) + rLat) / CELL_DEG);
                for (let cx = x0; cx <= x1; cx++) {
                    for (let cy = y0; cy <= y1; cy++) {
                        const key = cellKey(cx, cy);
                        touched.add(key);
                        const list = this.cells.get(key);
                        if (list) {
                            list.push({ segs, i });
                        } else {
                            this.cells.set(key, [{ segs, i }]);
                        }
                    }
                }
            }
        }
        return [...touched];
    }
}

function cellKey(cx: number, cy: number): number {
    // Cells of 0.002 deg: lon -90000..90000, lat -45000..45000.
    return (cx + 100_000) * 200_000 + (cy + 100_000);
}

/** Where a tile is drawn: its group's scene position and rotation, and the scene's frame. */
export interface TilePlacement {
    basis: EnuBasis;
    position: [number, number, number];
    /** Quaternion x, y, z, w. */
    quaternion: [number, number, number, number];
}

/**
 * Bed segments from a tile's frame (railBed.ts RailBedResult.beds) to the
 * field's lat/lon and height above the ellipsoid, through the tile's own
 * placement, so they land where the bed is drawn. Pure: runs in the rail
 * bed worker, where a tile's thousands of street segments cost the render
 * thread nothing.
 */
export function bedsToGeodetic(beds: Float64Array, place: TilePlacement): Float64Array {
    const n = beds.length / RAIL_BED_SEGMENT_FLOATS;
    const out = new Float64Array(n * RAIL_FIELD_SEGMENT_FLOATS);
    const [qx, qy, qz, qw] = place.quaternion;
    const [ox, oy, oz] = place.position;
    const enu = { e: 0, n: 0, u: 0 };
    const ecef = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
        const o = i * RAIL_BED_SEGMENT_FLOATS;
        const r = i * RAIL_FIELD_SEGMENT_FLOATS;
        for (let k = 0; k < 2; k++) {
            const vx = beds[o + k * 3], vy = beds[o + k * 3 + 1], vz = beds[o + k * 3 + 2];
            // v' = q v q*, then the tile's origin: scene x east, y up, z south.
            const tx = 2 * (qy * vz - qz * vy), ty = 2 * (qz * vx - qx * vz), tz = 2 * (qx * vy - qy * vx);
            const sx = vx + qw * tx + (qy * tz - qz * ty) + ox;
            const sy = vy + qw * ty + (qz * tx - qx * tz) + oy;
            const sz = vz + qw * tz + (qx * ty - qy * tx) + oz;
            enu.e = sx;
            enu.u = sy;
            enu.n = -sz;
            enuToEcef(place.basis, enu, ecef);
            const g = ecefToGeodetic(ecef.x, ecef.y, ecef.z);
            out[r + k * 3] = g.lon;
            out[r + k * 3 + 1] = g.lat;
            out[r + k * 3 + 2] = g.height;
        }
        out[r + 6] = beds[o + 6];
        out[r + 7] = beds[o + 8];
        out[r + 8] = beds[o + 9];
        out[r + 9] = beds[o + 10];
    }
    return out;
}
