/**
 * Top-down coverage check: inside each OSM inland body, does the baked mesh
 * actually show water from above, or terrain?
 *
 * Rasterises the land and water streams into height buffers over the tile grid
 * and compares them per cell.
 *
 * Samples at cell CENTRES, not at grid nodes. Mesh vertices sit on integer grid
 * coordinates, so sampling there puts every sample exactly on a shared triangle
 * edge, where the barycentric test is decided by floating-point noise — that
 * loses coverage and makes the result differ run to run.
 *
 * Prints a self-check first: land and water together must cover essentially the
 * whole tile. If they do not, the rasteriser is wrong and nothing below it means
 * anything.
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { decodeLvr, InlandBody } from './bake/lvr';
import { decodePtm } from '../src/script/terrain/ptm';
import {
    ecefToEnu, ecefToGeodetic, enuToEcef, geodeticToEcef, makeEnuBasis,
} from '../src/script/terrain/geodesy';
import { PLAY_ORIGIN } from '../src/script/state/worldLayout';
import { tileBounds } from '../src/script/terrain/tiling';

const N = 256; // cells, not nodes: one sample per cell centre

function inRing(lon: number, lat: number, r: { lon: number; lat: number }[]) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const xi = r[i].lon, yi = r[i].lat, xj = r[j].lon, yj = r[j].lat;
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
const inBody = (lon: number, lat: number, b: InlandBody) =>
    inRing(lon, lat, b.exterior) && !b.holes.some(h => inRing(lon, lat, h));

const tot = { interior: 0, water: 0, land: 0, none: 0, selfCheckWorst: 1 };

for (const arg of process.argv.slice(2)) {
    const [z, x, y] = arg.split('/').map(Number);
    const lp = `assets/planet/${z}/${x}/${y}.lvr`;
    const pp = `assets/terrain/${z}/${x}/${y}.ptm`;
    if (!fs.existsSync(lp) || !fs.existsSync(pp)) { console.log(`${arg}: missing`); continue; }
    const vec = decodeLvr(fs.readFileSync(lp));
    const t = decodePtm(zlib.gunzipSync(fs.readFileSync(pp)));
    const basis = makeEnuBasis(PLAY_ORIGIN.lat, PLAY_ORIGIN.lon, PLAY_ORIGIN.height);
    const b = tileBounds({ z, x, y });
    const c = ecefToEnu(basis, geodeticToEcef((b.south + b.north) / 2, (b.west + b.east) / 2, t.centerHeightM));
    const q = t.quantScale;
    const geo = (pos: Int16Array, v: number) => {
        // z is South in PTM1, not North.
        const p = enuToEcef(basis, { e: c.e + pos[v * 3] * q, u: c.u + pos[v * 3 + 1] * q, n: c.n - pos[v * 3 + 2] * q });
        return ecefToGeodetic(p.x, p.y, p.z);
    };
    // Cell centre (col + 0.5, row + 0.5) in *node* grid units, 0..256.
    const gX = (lon: number) => ((lon - b.west) / (b.east - b.west)) * N;
    const gY = (lat: number) => ((b.north - lat) / (b.north - b.south)) * N;

    // Skirt and wall geometry has to be excluded, and it cannot be found by
    // looking for a vertical sliver. buildTile hangs skirts by subtracting from
    // the ENU *u* component, but the ENU frame is centred once on the play
    // origin — 9000 km from the Grand Canyon — where u is only 19% vertical. So
    // a skirt there is thrown sideways instead of down, and lands outside the
    // tile it belongs to. Anything reaching past the tile bounds is therefore
    // not surface, and a top-down check must drop it.
    const marginLon = (b.east - b.west) * 0.02;
    const marginLat = (b.north - b.south) * 0.02;
    const outside = (v: { lon: number; lat: number }) =>
        v.lon < b.west - marginLon || v.lon > b.east + marginLon
        || v.lat < b.south - marginLat || v.lat > b.north + marginLat;

    const raster = (V: Array<{ lon: number; lat: number; height: number }>, tris: number[][]) => {
        const buf = new Float32Array(N * N).fill(NaN);
        for (const [i0, i1, i2] of tris) {
            if (outside(V[i0]) || outside(V[i1]) || outside(V[i2])) continue;
            const p = [V[i0], V[i1], V[i2]].map(v => ({ x: gX(v.lon), y: gY(v.lat), h: v.height }));
            const d = (p[1].y - p[2].y) * (p[0].x - p[2].x) + (p[2].x - p[1].x) * (p[0].y - p[2].y);
            if (Math.abs(d) < 1e-12) continue; // vertical wall or skirt: no footprint
            const x0 = Math.max(0, Math.floor(Math.min(...p.map(v => v.x)) - 0.5));
            const x1 = Math.min(N - 1, Math.ceil(Math.max(...p.map(v => v.x)) + 0.5));
            const y0 = Math.max(0, Math.floor(Math.min(...p.map(v => v.y)) - 0.5));
            const y1 = Math.min(N - 1, Math.ceil(Math.max(...p.map(v => v.y)) + 0.5));
            for (let row = y0; row <= y1; row++) for (let col = x0; col <= x1; col++) {
                const sx = col + 0.5, sy = row + 0.5;
                const l1 = ((p[1].y - p[2].y) * (sx - p[2].x) + (p[2].x - p[1].x) * (sy - p[2].y)) / d;
                const l2 = ((p[2].y - p[0].y) * (sx - p[2].x) + (p[0].x - p[2].x) * (sy - p[2].y)) / d;
                const l3 = 1 - l1 - l2;
                if (l1 < 0 || l2 < 0 || l3 < 0) continue;
                const h = l1 * p[0].h + l2 * p[1].h + l3 * p[2].h;
                const i = row * N + col;
                if (Number.isNaN(buf[i]) || h > buf[i]) buf[i] = h;
            }
        }
        return buf;
    };
    const LV = Array.from({ length: t.landPositions.length / 3 }, (_, v) => geo(t.landPositions, v));
    const WV = Array.from({ length: t.waterPositions.length / 3 }, (_, v) => geo(t.waterPositions, v));
    const wTris: number[][] = [];
    for (let i = 0; i < t.waterIndices.length; i += 3) wTris.push([t.waterIndices[i], t.waterIndices[i + 1], t.waterIndices[i + 2]]);
    const land = raster(LV, Array.from({ length: LV.length / 3 }, (_, i) => [i * 3, i * 3 + 1, i * 3 + 2]));
    const water = raster(WV, wTris);

    let covered = 0;
    for (let i = 0; i < N * N; i++) if (!Number.isNaN(land[i]) || !Number.isNaN(water[i])) covered++;
    const cov = covered / (N * N);
    tot.selfCheckWorst = Math.min(tot.selfCheckWorst, cov);

    if (vec.inland.length === 0) {
        console.log(`${arg}  [self-check] surface coverage ${(cov * 100).toFixed(1)}%   (no inland water)`);
        continue;
    }
    const isIn = (col: number, row: number) => {
        const lon = b.west + ((col + 0.5) / N) * (b.east - b.west);
        const lat = b.north - ((row + 0.5) / N) * (b.north - b.south);
        return vec.inland.some(bd => inBody(lon, lat, bd));
    };
    let interior = 0, iW = 0, iL = 0, iN = 0, boundary = 0;
    for (let row = 1; row < N - 1; row++) for (let col = 1; col < N - 1; col++) {
        if (!isIn(col, row)) continue;
        if (!(isIn(col + 1, row) && isIn(col - 1, row) && isIn(col, row + 1) && isIn(col, row - 1))) { boundary++; continue; }
        interior++;
        const i = row * N + col, lh = land[i], wh = water[i];
        if (Number.isNaN(wh)) iN++;
        else if (Number.isNaN(lh) || wh >= lh - 0.01) iW++;
        else iL++;
    }
    tot.interior += interior; tot.water += iW; tot.land += iL; tot.none += iN;
    const pc = (v: number) => interior ? `${(v / interior * 100).toFixed(1)}%` : '-';
    console.log(`${arg}  [self-check ${(cov * 100).toFixed(1)}%]  interior ${String(interior).padStart(5)}`
        + ` | water ${pc(iW).padStart(6)} | land on top ${pc(iL).padStart(6)} | NO water ${pc(iN).padStart(6)}`
        + `  (boundary ${boundary})`);
}
const p = (v: number) => tot.interior ? `${(v / tot.interior * 100).toFixed(1)}%` : '-';
console.log(`\nworst surface self-check: ${(tot.selfCheckWorst * 100).toFixed(1)}% `
    + `(must be ~100% or the numbers above are meaningless)`);
console.log(`TOTAL interior ${tot.interior}: water ${p(tot.water)}, land on top ${p(tot.land)}, no water ${p(tot.none)}`);
