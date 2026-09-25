/**
 * Diagnostic: how far the drawn terrain sits above or below the pavement.
 *
 * The taxiways and aprons are draped on the *fine DEM* (bilinear, pads
 * applied), while the terrain under them is a decimated TIN baked into the
 * .ptm tiles. The two are not the same surface, and where the TIN wins the
 * pavement is buried. This measures the gap along every taxiway centreline
 * and apron ring of one airfield.
 *
 *   node --import tsx tools/diag_pavement.ts GCLP
 *
 * Only valid for airfields in the area the manifest's enuOrigin belongs to:
 * everything here works in that one basis, and a tile baked in another area's
 * frame comes back with no facet under any point at all ("outside the mesh").
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

import * as THREE from 'three';
import { decodePdm, sampleBilinear } from '../src/script/terrain/demTile';
import {
    EnuBasis, ecefToEnu, enuToGeodeticApprox, geodeticToEcef, enuFromScene, makeEnuBasis, sceneFromEnu,
} from '../src/script/terrain/geodesy';
import { FlattenPad, applyFlattenPad, padBlendWeight, padFromRecord, padLocal } from '../src/script/terrain/flattenPad';
import { decodePtm } from '../src/script/terrain/ptm';
import { tileAtLonLat, tileBounds } from '../src/script/terrain/tiling';

const TERRAIN = 'assets/terrain';
const PLANET = 'assets/planet';
const icao = process.argv[2] ?? 'GCLP';

const manifest = JSON.parse(fs.readFileSync(path.join(TERRAIN, 'manifest.json'), 'utf8'));
const fields = JSON.parse(fs.readFileSync(path.join(TERRAIN, 'airfields.json'), 'utf8'));
const airfield = fields.items.find((a: any) => a.icao === icao);
if (!airfield) {
    throw new Error(`no airfield ${icao}`);
}

const basis: EnuBasis = makeEnuBasis(
    manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height ?? 0);
const toEnu = (lat: number, lon: number) => {
    const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, 0));
    return { e: enu.e, n: enu.n };
};
const pads: FlattenPad[] = (manifest.flattenPads ?? []).map((r: any) => padFromRecord(r, toEnu));

// --- fine DEM, exactly as HeightSampler reads it ---------------------------

const pdmCache = new Map<string, any>();
function pdmAt(z: number, lon: number, lat: number): number {
    const id = tileAtLonLat(z, lon, lat);
    const key = `${id.z}/${id.x}/${id.y}`;
    if (!pdmCache.has(key)) {
        const p = path.join(PLANET, String(id.z), String(id.x), `${id.y}.pdm`);
        pdmCache.set(key, fs.existsSync(p) ? decodePdm(fs.readFileSync(p)) : null);
    }
    const tile = pdmCache.get(key);
    if (!tile) return NaN;
    const b = tileBounds(id);
    return sampleBilinear(tile, (lon - b.west) / (b.east - b.west),
        (b.north - lat) / (b.north - b.south));
}

function groundElevation(e: number, n: number): number {
    const g = enuToGeodeticApprox(basis, e, n, 0);
    let h = pdmAt(manifest.height.queryZoom, g.lon, g.lat);
    if (!Number.isFinite(h)) h = pdmAt(manifest.height.coarseZoom, g.lon, g.lat);
    if (!Number.isFinite(h)) h = manifest.seaLevel;
    for (const pad of pads) h = applyFlattenPad(h, e, n, pad);
    return h;
}

function sceneAt(e: number, n: number, elevation: number) {
    const g = enuToGeodeticApprox(basis, e, n, 0);
    return sceneFromEnu(ecefToEnu(basis, geodeticToEcef(g.lat, g.lon, elevation)));
}

// --- drawn terrain, as the .ptm tiles carry it ------------------------------

interface Tri { ax: number; az: number; ay: number; bx: number; bz: number; by: number; cx: number; cz: number; cy: number }
const triCache = new Map<string, Tri[]>();

function ptmTris(z: number, lon: number, lat: number): Tri[] {
    const id = tileAtLonLat(z, lon, lat);
    const key = `${id.z}/${id.x}/${id.y}`;
    let tris = triCache.get(key);
    if (tris !== undefined) return tris;
    tris = [];
    const p = path.join(TERRAIN, String(id.z), String(id.x), `${id.y}.ptm`);
    if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p);
        const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw;
        const tile = decodePtm(bytes);
        const b = tileBounds(id);
        const origin = sceneFromEnu(ecefToEnu(basis, geodeticToEcef(
            (b.south + b.north) / 2, (b.west + b.east) / 2, tile.centerHeightM)));
        const s = tile.quantScale;
        const pos = tile.landPositions;
        for (let i = 0; i + 8 < pos.length; i += 9) {
            tris.push({
                ax: origin.x + pos[i] * s, ay: origin.y + pos[i + 1] * s, az: origin.z + pos[i + 2] * s,
                bx: origin.x + pos[i + 3] * s, by: origin.y + pos[i + 4] * s, bz: origin.z + pos[i + 5] * s,
                cx: origin.x + pos[i + 6] * s, cy: origin.y + pos[i + 7] * s, cz: origin.z + pos[i + 8] * s,
            });
        }
    }
    triCache.set(key, tris);
    return tris;
}

/** Highest drawn terrain Y at a scene (x, z), over every triangle covering it. */
function terrainY(x: number, z: number, lon: number, lat: number, zoom: number): number {
    let best = NaN;
    for (const t of ptmTris(zoom, lon, lat)) {
        const d = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz);
        if (Math.abs(d) < 1e-9) continue;
        const l0 = ((t.bz - t.cz) * (x - t.cx) + (t.cx - t.bx) * (z - t.cz)) / d;
        const l1 = ((t.cz - t.az) * (x - t.cx) + (t.ax - t.cx) * (z - t.cz)) / d;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        const y = l0 * t.ay + l1 * t.by + l2 * t.cy;
        if (!(best > y)) best = y;
    }
    return best;
}

// --- sample every pavement vertex ------------------------------------------

const EPS = 1.5;
const points: Array<{ lat: number; lon: number; what: string }> = [];
for (const tx of airfield.taxiways) {
    for (const p of tx.points) points.push({ lat: p[0], lon: p[1], what: 'taxiway' });
}
for (const ap of airfield.aprons) {
    for (const p of ap.ring) points.push({ lat: p[0], lon: p[1], what: 'apron' });
}

const zoom = Number(process.argv[3] ?? manifest.mesh.maxZoom);
const buried: number[] = [];
let missing = 0;
const worst: Array<{ d: number; lat: number; lon: number; what: string; core: boolean }> = [];
for (const pt of points) {
    const { e, n } = toEnu(pt.lat, pt.lon);
    const pave = sceneAt(e, n, groundElevation(e, n) + EPS);
    const ty = terrainY(pave.x, pave.z, pt.lon, pt.lat, zoom);
    if (!Number.isFinite(ty)) { missing++; continue; }
    const d = ty - pave.y;      // > 0: terrain above pavement, pavement buried
    buried.push(d);
    let core = false;
    for (const pad of pads) if (padBlendWeight(e, n, pad) >= 1) core = true;
    worst.push({ d, lat: pt.lat, lon: pt.lon, what: pt.what, core });
}

buried.sort((a, b) => a - b);
const q = (f: number) => buried[Math.min(buried.length - 1, Math.floor(f * buried.length))];
console.log(`${icao}: ${buried.length} pavement vertices sampled at z${zoom}`
    + ` (${missing} outside the mesh)`);
console.log(`terrainY - pavementY, metres (positive = pavement buried):`);
console.log(`  min ${q(0).toFixed(2)}  p50 ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}`
    + `  p99 ${q(0.99).toFixed(2)}  max ${buried[buried.length - 1].toFixed(2)}`);
const over = buried.filter(d => d > 0);
console.log(`  buried at all: ${over.length} (${(100 * over.length / buried.length).toFixed(1)}%)`
    + `; by more than 1 m: ${buried.filter(d => d > 1).length}`);
worst.sort((a, b) => b.d - a.d);
console.log('worst ten:');
for (const w of worst.slice(0, 10)) {
    const { e, n } = toEnu(w.lat, w.lon);
    console.log(`  ${w.d.toFixed(2)} m  ${w.what}${w.core ? ' (pad core)' : ''}`
        + `  ${w.lat.toFixed(5)},${w.lon.toFixed(5)}  ${padEdgeReport(e, n)}`);
}

/** How far inside the nearest pad's core this point is, and its blend weight. */
function padEdgeReport(e: number, n: number): string {
    let best = -Infinity;
    let bestPad: FlattenPad | undefined;
    for (const pad of pads) {
        const w = padBlendWeight(e, n, pad);
        if (w > 0 && w > best) { best = w; bestPad = pad; }
    }
    if (bestPad === undefined) return 'no pad';
    const local = padLocal(e, n, bestPad);
    const inW = bestPad.halfW - Math.abs(local.across);
    const inD = bestPad.halfD - Math.abs(local.along);
    return `w=${best.toFixed(2)} ${Math.min(inW, inD).toFixed(0)} m inside pad edge`;
}

// --- why: dump the drawn triangle under the worst point ---------------------

{
    const w = worst[0];
    const { e, n } = toEnu(w.lat, w.lon);
    const pave = sceneAt(e, n, groundElevation(e, n) + EPS);
    console.log(`\nunder the worst point (${w.lat.toFixed(5)},${w.lon.toFixed(5)}):`);
    console.log(`  pavement scene y ${pave.y.toFixed(2)}, ground elevation `
        + `${groundElevation(e, n).toFixed(2)} m`);
    for (const t of ptmTris(zoom, w.lon, w.lat)) {
        const d = (t.bz - t.cz) * (t.ax - t.cx) + (t.cx - t.bx) * (t.az - t.cz);
        if (Math.abs(d) < 1e-9) continue;
        const l0 = ((t.bz - t.cz) * (pave.x - t.cx) + (t.cx - t.bx) * (pave.z - t.cz)) / d;
        const l1 = ((t.cz - t.az) * (pave.x - t.cx) + (t.ax - t.cx) * (pave.z - t.cz)) / d;
        if (l0 < -1e-6 || l1 < -1e-6 || 1 - l0 - l1 < -1e-6) continue;
        const span = Math.max(
            Math.hypot(t.ax - t.bx, t.az - t.bz),
            Math.hypot(t.bx - t.cx, t.bz - t.cz),
            Math.hypot(t.cx - t.ax, t.cz - t.az));
        console.log(`  triangle span ${span.toFixed(0)} m`);
        // Each drawn corner against what the height query says at the same
        // place: agreement means the bake and the runtime share a surface and
        // any error is interpolation; disagreement means they do not.
        for (const c of [[t.ax, t.ay, t.az], [t.bx, t.by, t.bz], [t.cx, t.cy, t.cz]]) {
            const cEnu = enuFromScene(new THREE.Vector3(c[0], 0, c[2]));
            const want = sceneAt(cEnu.e, cEnu.n, groundElevation(cEnu.e, cEnu.n)).y;
            let bestW = 0;
            for (const pad of pads) bestW = Math.max(bestW, padBlendWeight(cEnu.e, cEnu.n, pad));
            console.log(`    corner drawn y ${c[1].toFixed(2)}  query y ${want.toFixed(2)}`
                + `  diff ${(c[1] - want).toFixed(2)}  padWeight ${bestW.toFixed(2)}`);
        }
    }
}

// --- is the drawn surface off the query away from pads too? ----------------
//
// If the bake and the runtime disagree only inside a pad's reach, the pad is
// the story. If they disagree just as much on plain ground, it is not.
{
    const base = toEnu(airfield.lat, airfield.lon);
    const byWeight: Record<string, number[]> = { off: [], feather: [], core: [] };
    for (let de = -1500; de <= 1500; de += 60) {
        for (let dn = -1500; dn <= 1500; dn += 60) {
            const e = base.e + de;
            const n = base.n + dn;
            const want = sceneAt(e, n, groundElevation(e, n));
            const g = enuToGeodeticApprox(basis, e, n, 0);
            const ty = terrainY(want.x, want.z, g.lon, g.lat, zoom);
            if (!Number.isFinite(ty)) continue;
            let w = 0;
            for (const pad of pads) w = Math.max(w, padBlendWeight(e, n, pad));
            byWeight[w <= 0 ? 'off' : w >= 1 ? 'core' : 'feather'].push(ty - want.y);
        }
    }
    console.log('\ndrawn minus query over a 3 km grid, by pad influence:');
    for (const [k, v] of Object.entries(byWeight)) {
        if (v.length === 0) { console.log(`  ${k}: none`); continue; }
        v.sort((a, b) => a - b);
        const mean = v.reduce((s, x) => s + x, 0) / v.length;
        console.log(`  ${k.padEnd(8)} n=${String(v.length).padEnd(5)}`
            + ` mean ${mean.toFixed(2)}  p50 ${v[v.length >> 1].toFixed(2)}`
            + `  min ${v[0].toFixed(2)}  max ${v[v.length - 1].toFixed(2)}`);
    }
}
