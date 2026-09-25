/**
 * The surface a finished .ptm draws, as a height query in a true local frame -
 * the ground a bridge stands on.
 *
 * The tile's own axes are the bake frame's, whose y axis leans off the real
 * vertical by up to tens of degrees far from the ENU origin (32.5 degrees at
 * Berlin): on flat ground y changes by a third of a metre per metre moved
 * sideways. Grades, clearances and spacings measured in it are wrong, so a
 * bridge is planned in a frame built on the tile's own up vector instead: two
 * horizontal axes (u, v) perpendicular to up, and h, the height along up. A
 * point is P = u*a + v*b + h*up, which is how the mesh puts it back.
 *
 * The highest drawn facet over a point is what is seen there (as in
 * drapeRoads.ts). Land and water are kept apart, because a deck clears a
 * river's surface but its piers stand on the bed.
 */

import { EnuBasis, ecefToEnu, geodeticToEcef } from '../../src/script/terrain/geodesy';
import { PtmTile } from '../../src/script/terrain/ptm';
import { tileBounds } from '../../src/script/terrain/tiling';

const BUCKET_CELLS = 64;
const EDGE_EPS = 1e-4;

/** Orthonormal axes, in the tile's own frame, of a true local (u, v, h) frame. */
export interface LocalFrame {
    a: [number, number, number];
    b: [number, number, number];
    up: [number, number, number];
}

export interface TileSurface {
    /** A lon/lat as (x = u, z = v) in the true local frame; the planner's XZ. */
    toXZ(lon: number, lat: number): { x: number; z: number };
    /** Height along up of the highest land facet over (u, v), or undefined where none is drawn. */
    landH(u: number, v: number): number | undefined;
    /** Height along up of the highest water facet over (u, v), or undefined on dry ground. */
    waterH(u: number, v: number): number | undefined;
    /** The frame a mesh built in (u, h, v) is put back into the tile's axes with. */
    frame: LocalFrame;
    /** The tile's local metre = quantised step * this; kept for the encoder. */
    quantScale: number;
}

class Bucketed {
    private readonly tri: Float64Array;
    private readonly buckets = new Map<number, number[]>();
    private readonly minX: number;
    private readonly minZ: number;
    private readonly cellW: number;
    private readonly cellH: number;

    constructor(tri: Float64Array) {
        this.tri = tri;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < tri.length; i += 3) {
            minX = Math.min(minX, tri[i]); maxX = Math.max(maxX, tri[i]);
            minZ = Math.min(minZ, tri[i + 2]); maxZ = Math.max(maxZ, tri[i + 2]);
        }
        this.minX = minX;
        this.minZ = minZ;
        this.cellW = Math.max(1e-6, (maxX - minX) / BUCKET_CELLS);
        this.cellH = Math.max(1e-6, (maxZ - minZ) / BUCKET_CELLS);
        for (let i = 0; i < tri.length / 9; i++) {
            const o = i * 9;
            const [cx0, cz0] = this.cell(Math.min(tri[o], tri[o + 3], tri[o + 6]), Math.min(tri[o + 2], tri[o + 5], tri[o + 8]));
            const [cx1, cz1] = this.cell(Math.max(tri[o], tri[o + 3], tri[o + 6]), Math.max(tri[o + 2], tri[o + 5], tri[o + 8]));
            for (let cz = cz0; cz <= cz1; cz++) {
                for (let cx = cx0; cx <= cx1; cx++) {
                    const key = cz * BUCKET_CELLS + cx;
                    const list = this.buckets.get(key);
                    if (list) {
                        list.push(i);
                    } else {
                        this.buckets.set(key, [i]);
                    }
                }
            }
        }
    }

    private cell(x: number, z: number): [number, number] {
        return [
            Math.min(BUCKET_CELLS - 1, Math.max(0, Math.floor((x - this.minX) / this.cellW))),
            Math.min(BUCKET_CELLS - 1, Math.max(0, Math.floor((z - this.minZ) / this.cellH))),
        ];
    }

    highest(x: number, z: number): number | undefined {
        const list = this.buckets.get(this.cell(x, z)[1] * BUCKET_CELLS + this.cell(x, z)[0]);
        if (!list) {
            return undefined;
        }
        const tri = this.tri;
        let best: number | undefined;
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
        return best;
    }
}

export function tileSurface(tile: PtmTile, basis: EnuBasis): TileSurface {
    const bounds = tileBounds(tile.id);
    const lat0 = (bounds.south + bounds.north) / 2;
    const lon0 = (bounds.west + bounds.east) / 2;
    const centre = ecefToEnu(basis, geodeticToEcef(lat0, lon0, tile.centerHeightM));
    const toLocal = (lon: number, lat: number, h: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, h));
        return { x: enu.e - centre.e, y: enu.u - centre.u, z: centre.n - enu.n };
    };
    const upA = toLocal(lon0, lat0, tile.centerHeightM);
    const upB = toLocal(lon0, lat0, tile.centerHeightM + 1000);
    let upX = upB.x - upA.x, upY = upB.y - upA.y, upZ = upB.z - upA.z;
    const upLen = Math.hypot(upX, upY, upZ);
    upX /= upLen; upY /= upLen; upZ /= upLen;
    // Horizontal axes: a is a reference axis with its up component removed.
    const ref: [number, number, number] = Math.abs(upX) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const d = ref[0] * upX + ref[1] * upY + ref[2] * upZ;
    let ax = ref[0] - d * upX, ay = ref[1] - d * upY, az = ref[2] - d * upZ;
    const aLen = Math.hypot(ax, ay, az);
    ax /= aLen; ay /= aLen; az /= aLen;
    const bx = upY * az - upZ * ay, by = upZ * ax - upX * az, bz = upX * ay - upY * ax;
    const q = tile.quantScale;
    const U = (x: number, y: number, z: number) => x * ax + y * ay + z * az;
    const V = (x: number, y: number, z: number) => x * bx + y * by + z * bz;
    const H = (x: number, y: number, z: number) => x * upX + y * upY + z * upZ;

    // Triangles as (u, h, v) triples, the layout Bucketed reads as (x, y, z).
    const land = tile.landPositions;
    const landTri = new Float64Array(Math.floor(land.length / 9) * 9);
    for (let v = 0; v + 8 < land.length; v += 9) {
        for (let k = 0; k < 9; k += 3) {
            const x = land[v + k] * q, y = land[v + k + 1] * q, z = land[v + k + 2] * q;
            landTri[v + k] = U(x, y, z);
            landTri[v + k + 1] = H(x, y, z);
            landTri[v + k + 2] = V(x, y, z);
        }
    }
    const wp = tile.waterPositions;
    const wi = tile.waterIndices;
    const waterTri = new Float64Array(Math.floor(wi.length / 3) * 9);
    for (let i = 0; i + 2 < wi.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const vi = wi[i + k] * 3;
            const x = wp[vi] * q, y = wp[vi + 1] * q, z = wp[vi + 2] * q;
            waterTri[(i / 3) * 9 + k * 3] = U(x, y, z);
            waterTri[(i / 3) * 9 + k * 3 + 1] = H(x, y, z);
            waterTri[(i / 3) * 9 + k * 3 + 2] = V(x, y, z);
        }
    }
    const landSet = landTri.length > 0 ? new Bucketed(landTri) : undefined;
    const waterSet = waterTri.length > 0 ? new Bucketed(waterTri) : undefined;

    return {
        toXZ(lon, lat) {
            // Sliding a point along up changes only h, so the height it is
            // asked at does not matter.
            const l = toLocal(lon, lat, tile.centerHeightM);
            return { x: U(l.x, l.y, l.z), z: V(l.x, l.y, l.z) };
        },
        landH: (u, v) => landSet?.highest(u, v),
        waterH: (u, v) => waterSet?.highest(u, v),
        frame: { a: [ax, ay, az], b: [bx, by, bz], up: [upX, upY, upZ] },
        quantScale: q,
    };
}
