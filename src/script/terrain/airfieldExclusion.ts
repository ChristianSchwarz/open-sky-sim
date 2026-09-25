/**
 * Keeps scattered trees off an airfield's own pavement and clearways.
 *
 * Built once per area (see terrainEntity.ts's setAirfieldExclusion) from the
 * same airfield descriptions airfieldModel.ts draws, in the same tile axes
 * the trees are scattered in - +X east, +Z south - so `x`/`z` here match
 * treeBillboards.ts's `point.x`/`point.z` directly, no further conversion.
 *
 * Runways are oriented rectangles (their pad, plus a margin); taxiways are
 * buffered centreline segments; aprons are their own ring, buffered the same
 * way. All three are bucketed into a coarse grid so a tile's scatter, which
 * only ever tests points near one airfield at most, does not walk every
 * runway of every airfield in the pyramid.
 */

import { Airfield } from './airfields';
import { bearingAxisAt } from './flattenPad';

/** Clear ground kept beyond a runway's own strip, metres. */
const RUNWAY_TREE_MARGIN_M = 15;
/** Clear ground kept beyond a taxiway's or apron's own edge, metres. */
const APRON_TREE_MARGIN_M = 5;
const CELL_M = 64;

export type AirfieldExclusion = (x: number, z: number) => boolean;
type ToEnu = (lat: number, lon: number) => { e: number; n: number };

/** East/south tile axes, matching treeBillboards.ts's scatter points. */
function toTile(e: number, n: number): { x: number; z: number } {
    return { x: e, z: -n };
}

interface Rect {
    cx: number; cz: number;
    /** Unit axis along the rectangle's length, in tile x/z. */
    ax: number; az: number;
    halfLen: number; halfWid: number;
}

interface Segment {
    ax: number; az: number; bx: number; bz: number; r: number;
}

interface Ring {
    points: { x: number; z: number }[];
    /** Bounding box, for the grid and for a quick reject before the polygon test. */
    minX: number; maxX: number; minZ: number; maxZ: number;
}

function rectHit(r: Rect, x: number, z: number): boolean {
    const dx = x - r.cx, dz = z - r.cz;
    const along = dx * r.ax + dz * r.az;
    const across = -dx * r.az + dz * r.ax;
    return Math.abs(along) <= r.halfLen && Math.abs(across) <= r.halfWid;
}

function segmentHit(s: Segment, x: number, z: number): boolean {
    const dx = s.bx - s.ax, dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
    const px = s.ax + dx * t - x, pz = s.az + dz * t - z;
    return px * px + pz * pz < s.r * s.r;
}

/** Ray-cast point-in-polygon, plus a buffer read off the nearest edge when outside. */
function ringHit(ring: Ring, x: number, z: number, margin: number): boolean {
    if (x < ring.minX - margin || x > ring.maxX + margin
        || z < ring.minZ - margin || z > ring.maxZ + margin) {
        return false;
    }
    const pts = ring.points;
    let inside = false;
    let nearest = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i], b = pts[j];
        if ((a.z > z) !== (b.z > z)) {
            const xCross = a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z);
            if (xCross > x) {
                inside = !inside;
            }
        }
        const dx = b.x - a.x, dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2)) : 0;
        const px = a.x + dx * t - x, pz = a.z + dz * t - z;
        nearest = Math.min(nearest, px * px + pz * pz);
    }
    return inside || nearest < margin * margin;
}

/**
 * Build one exclusion test over every airfield in `airfields`, or undefined
 * when none of them has anything to exclude trees from.
 */
export function buildAirfieldExclusion(airfields: Airfield[], toEnu: ToEnu): AirfieldExclusion | undefined {
    const rects: Rect[] = [];
    const segs: Segment[] = [];
    const rings: Ring[] = [];

    for (const airfield of airfields) {
        for (const runway of airfield.runways) {
            const centre = toEnu(runway.lat, runway.lon);
            const axisEn = bearingAxisAt(runway.lat, runway.lon, runway.headingDeg, toEnu);
            const c = toTile(centre.e, centre.n);
            // East/south flips the sign of the north component only.
            const ax = axisEn.e, az = -axisEn.n;
            rects.push({
                cx: c.x, cz: c.z, ax, az,
                halfLen: runway.lengthM / 2 + RUNWAY_TREE_MARGIN_M,
                halfWid: runway.widthM / 2 + RUNWAY_TREE_MARGIN_M,
            });
        }
        for (const taxiway of airfield.taxiways) {
            const pts = taxiway.points.map(p => {
                const enu = toEnu(p[0], p[1]);
                return toTile(enu.e, enu.n);
            });
            const r = taxiway.widthM / 2 + APRON_TREE_MARGIN_M;
            for (let i = 0; i + 1 < pts.length; i++) {
                segs.push({ ax: pts[i].x, az: pts[i].z, bx: pts[i + 1].x, bz: pts[i + 1].z, r });
            }
        }
        for (const apron of airfield.aprons) {
            const pts = apron.ring.map(p => {
                const enu = toEnu(p[0], p[1]);
                return toTile(enu.e, enu.n);
            });
            if (pts.length < 3) {
                continue;
            }
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (const p of pts) {
                minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
            }
            rings.push({ points: pts, minX, maxX, minZ, maxZ });
        }
    }
    if (rects.length === 0 && segs.length === 0 && rings.length === 0) {
        return undefined;
    }

    // A coarse grid over every obstacle's bounding box, same shape as
    // roadExclusion.ts's - an area's whole set of airfields is small, but a
    // tile's scatter calls this per candidate tree point, so a linear scan
    // over every runway/taxiway/apron in the pyramid is worth avoiding.
    type Entry = { kind: 'rect'; i: number } | { kind: 'seg'; i: number } | { kind: 'ring'; i: number };
    const grid = new Map<number, Entry[]>();
    const cellKey = (cx: number, cz: number) => (cx + (1 << 20)) * (1 << 21) + (cz + (1 << 20));
    const addToGrid = (minX: number, maxX: number, minZ: number, maxZ: number, entry: Entry) => {
        const x0 = Math.floor(minX / CELL_M), x1 = Math.floor(maxX / CELL_M);
        const z0 = Math.floor(minZ / CELL_M), z1 = Math.floor(maxZ / CELL_M);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cz = z0; cz <= z1; cz++) {
                const k = cellKey(cx, cz);
                const list = grid.get(k);
                if (list) {
                    list.push(entry);
                } else {
                    grid.set(k, [entry]);
                }
            }
        }
    };
    rects.forEach((r, i) => {
        const reach = Math.max(r.halfLen, r.halfWid);
        addToGrid(r.cx - reach, r.cx + reach, r.cz - reach, r.cz + reach, { kind: 'rect', i });
    });
    segs.forEach((s, i) => {
        addToGrid(
            Math.min(s.ax, s.bx) - s.r, Math.max(s.ax, s.bx) + s.r,
            Math.min(s.az, s.bz) - s.r, Math.max(s.az, s.bz) + s.r,
            { kind: 'seg', i },
        );
    });
    rings.forEach((r, i) => addToGrid(
        r.minX - APRON_TREE_MARGIN_M, r.maxX + APRON_TREE_MARGIN_M,
        r.minZ - APRON_TREE_MARGIN_M, r.maxZ + APRON_TREE_MARGIN_M,
        { kind: 'ring', i },
    ));

    return (x, z) => {
        const list = grid.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
        if (!list) {
            return false;
        }
        for (const entry of list) {
            if (entry.kind === 'rect' ? rectHit(rects[entry.i], x, z)
                : entry.kind === 'seg' ? segmentHit(segs[entry.i], x, z)
                    : ringHit(rings[entry.i], x, z, APRON_TREE_MARGIN_M)) {
                return true;
            }
        }
        return false;
    };
}
