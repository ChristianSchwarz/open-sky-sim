/**
 * A leaf's measured line profiles (railBed.ts RailBedInput.measured) from the
 * lidar store (lidarStore.ts): for every stroke segment of a line the beds
 * grade, every PROFILE_STEP_M, the lidar crown and lift of the measured line
 * it runs along.
 *
 *   lift    crown minus the lidar ground beside it, read as measured - what
 *           the grading uses ('rel': the land plus the measured embankment).
 *   centre  the crown as a height along the tile's up, in the land's datum:
 *           the lidar's datum is not the land's (DHHN2016, EVRF2000, LN02
 *           against FABDEM's EGM2008, plus FABDEM's own bias), so per source
 *           the median of (land - lidar ground) beside the line is added.
 *
 * Built on the ungraded strokes, at grade time: the segments are keyed by
 * their first stroke vertex, which only holds for this bake of the .ptr.
 */

import { EnuBasis, ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef } from '../../src/script/terrain/geodesy';
import { LineProfile } from '../../src/script/terrain/lineProfile';
import { PtmTile } from '../../src/script/terrain/ptm';
import { PtrTile, ROAD_CLASS_MASK } from '../../src/script/terrain/ptr';
import { bedTierOf } from '../../src/script/terrain/railBed';
import { TileKey, tileBounds } from '../../src/script/terrain/tiling';
import { LidarStore } from './lidarStore';
import { tileSurface } from './tileSurface';

export const PROFILE_STEP_M = 5;
const CROWN_MIN_HALF_M = 2;
/** The land beside a line is read this far out past its half width, metres (the middle of the lidar's side reads). */
const SIDE_AT_M = 30;

export interface MeasuredProfiles {
    segments: Map<number, LineProfile>;
    samples: number;
    measured: number;
    /** Land minus lidar ground, per source id, metres. */
    bias: Map<number, number>;
}

function median(xs: number[]): number {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length === 0 ? NaN : v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}

export function measuredProfiles(store: LidarStore, k: TileKey, tile: PtmTile, strokes: PtrTile, basis: EnuBasis): MeasuredProfiles {
    const surface = tileSurface(tile, basis);
    const up = surface.frame.up;
    const b = tileBounds(tile.id);
    const centre = ecefToEnu(basis, geodeticToEcef((b.south + b.north) / 2, (b.west + b.east) / 2, tile.centerHeightM));
    const q = strokes.quantScale;
    const toGeo = (x: number, y: number, z: number) => {
        const e = enuToEcef(basis, { e: centre.e + x, n: centre.n - z, u: centre.u + y });
        return ecefToGeodetic(e.x, e.y, e.z);
    };
    const hAlongUp = (lon: number, lat: number, h: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, h));
        return (enu.e - centre.e) * up[0] + (enu.u - centre.u) * up[1] + (centre.n - enu.n) * up[2];
    };
    interface Seg { a: number; lon: number[]; lat: number[]; crown: number[]; lift: number[]; source: number[] }
    const segs: Seg[] = [];
    const landSide = new Map<number, number[]>();
    let samples = 0, measured = 0;
    for (let i = 0; i + 5 < strokes.indices.length; i += 6) {
        const a = strokes.indices[i], bv = strokes.indices[i + 5];
        const cls = strokes.directions[a * 4 + 3] & ROAD_CLASS_MASK;
        const tier = bedTierOf(cls);
        if (tier < 0 || (strokes.directions[bv * 4 + 3] & ROAD_CLASS_MASK) !== cls) {
            continue;
        }
        const P = (v: number) => toGeo(strokes.positions[v * 3] * q, strokes.positions[v * 3 + 1] * q, strokes.positions[v * 3 + 2] * q);
        const ga = P(a), gb = P(bv);
        const mLat = 111132.92, mLon = 111412.84 * Math.cos((ga.lat * Math.PI) / 180);
        const de = (gb.lon - ga.lon) * mLon, dn = (gb.lat - ga.lat) * mLat;
        const len = Math.hypot(de, dn);
        if (len < 0.5) {
            continue;
        }
        const ne = -dn / len, nn = de / len; // left normal
        const half = Math.max(CROWN_MIN_HALF_M, strokes.halfWidths[a] / 10);
        const n = Math.max(2, Math.ceil(len / PROFILE_STEP_M) + 1);
        const s: Seg = { a, lon: [], lat: [], crown: [], lift: [], source: [] };
        for (let j = 0; j < n; j++) {
            const t = j / (n - 1);
            const lon = ga.lon + (gb.lon - ga.lon) * t, lat = ga.lat + (gb.lat - ga.lat) * t;
            const m = store.lineAt(k, lon, lat, de, dn, tier);
            samples++;
            s.lon.push(lon);
            s.lat.push(lat);
            s.crown.push(m?.crown ?? NaN);
            s.lift.push(m?.lift ?? NaN);
            s.source.push(m?.source ?? 0);
            if (!m) {
                continue;
            }
            measured++;
            // The land beside it, both sides, against the lidar ground there.
            const ground = m.crown - m.lift;
            for (const sign of [1, -1]) {
                const off = sign * (half + SIDE_AT_M);
                const xz = surface.toXZ(lon + (ne * off) / mLon, lat + (nn * off) / mLat);
                const land = surface.landH(xz.x, xz.z);
                if (land !== undefined) {
                    let list = landSide.get(m.source);
                    if (!list) {
                        landSide.set(m.source, list = []);
                    }
                    list.push(land - hAlongUp(lon + (ne * off) / mLon, lat + (nn * off) / mLat, ground));
                }
            }
        }
        segs.push(s);
    }
    const bias = new Map<number, number>();
    for (const [src, list] of landSide) {
        bias.set(src, median(list));
    }
    const segments = new Map<number, LineProfile>();
    for (const s of segs) {
        const c = new Float32Array(s.crown.length), l = new Float32Array(s.crown.length);
        for (let j = 0; j < s.crown.length; j++) {
            const bj = bias.get(s.source[j]);
            l[j] = s.lift[j];
            c[j] = Number.isFinite(s.crown[j]) && bj !== undefined && Number.isFinite(bj)
                ? hAlongUp(s.lon[j], s.lat[j], s.crown[j]) + bj : NaN;
        }
        segments.set(s.a, { centre: c, lift: l });
    }
    return { segments, samples, measured, bias };
}
