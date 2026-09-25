/**
 * Watercourse check: did every centreline in the .lvr reach the .ptm as a
 * stroke, and does that stroke lie on the surface rather than inside it?
 *
 * Complements verify_water.ts, which asks whether a body of water is wet from
 * above. A river is no longer water in the mesh at all unless it is wide enough
 * for the node grid — most are not — so what has to be checked instead is the
 * stroke: that it exists, that it follows the centreline's length, and that it
 * is not buried under the terrain it is meant to be drawn on.
 *
 * Usage: npx tsx tools/verify_rivers.ts 12/4387/853 [...]
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { decodeLvr } from './bake/lvr';
import { decodePtm, PtmTile } from '../src/script/terrain/ptm';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from '../src/script/terrain/geodesy';
import { tileBounds } from '../src/script/terrain/tiling';
import { PLAY_ORIGIN } from '../src/script/state/worldLayout';

/** Metres a stroke may sit below the drawn land before it counts as buried. */
const BURIED_EPS_M = 0.05;

/**
 * Cosine of the steepest a triangle may lean and still count as surface.
 *
 * Shore walls and skirts arrive in the same stream as the terrain with nothing
 * marking them, and they cannot be found by looking for a vertical sliver: the
 * bake hangs them along ENU *u*, which is 31 degrees off vertical at Potsdam,
 * so they are thrown sideways as well as down and sweep a real footprint across
 * the tile. Left in, a wall dropping to a canal reads as ground 32 m above the
 * stroke that is correctly lying on the bank beside it. Their normals are what
 * gives them away — near perpendicular to local up, where no real hillside is.
 */
const SURFACE_MIN_UP = Math.cos(60 * Math.PI / 180);

interface Vec3 { x: number; y: number; z: number; }

/** Ground distance in metres between two lon/lat points. */
function groundMetres(
    a: { lon: number; lat: number }, b: { lon: number; lat: number },
): number {
    const midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
    return Math.hypot(
        (b.lon - a.lon) * 111320 * Math.cos(midLat),
        (b.lat - a.lat) * 110540,
    );
}

/**
 * Height of the drawn land at (x, z) in tile-local metres, or undefined.
 *
 * Walls and skirts are excluded two ways: anything reaching past the tile is
 * not surface, and anything leaning more than SURFACE_MIN_UP allows is not
 * either.
 */
function landHeightAt(
    tile: PtmTile, x: number, z: number, reach: number,
    up: { x: number; y: number; z: number },
): number | undefined {
    const q = tile.quantScale;
    const at = (v: number): Vec3 => ({
        x: tile.landPositions[v * 3] * q,
        y: tile.landPositions[v * 3 + 1] * q,
        z: tile.landPositions[v * 3 + 2] * q,
    });
    const triCount = tile.landPositions.length / 9;
    for (let t = 0; t < triCount; t++) {
        const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
        if ([a, b, c].some(v => Math.abs(v.x) > reach || Math.abs(v.z) > reach)) {
            continue;
        }
        // Baked normals are /127 and already oriented towards local up.
        const lean = Math.abs(
            (tile.landNormals[t * 12] / 127) * up.x
            + (tile.landNormals[t * 12 + 1] / 127) * up.y
            + (tile.landNormals[t * 12 + 2] / 127) * up.z);
        if (lean < SURFACE_MIN_UP) continue;
        const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        if (Math.abs(det) < 1e-9) continue;   // a wall seen edge-on
        const l0 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
        const l1 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
        const l2 = 1 - l0 - l1;
        if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
        return a.y * l0 + b.y * l1 + c.y * l2;
    }
    return undefined;
}

const tot = { runs: 0, strips: 0, lineM: 0, strokeM: 0, checked: 0, buried: 0, worst: 0 };

for (const arg of process.argv.slice(2)) {
    const [z, x, y] = arg.split('/').map(Number);
    const lp = `assets/planet/${z}/${x}/${y}.lvr`;
    const pp = `assets/terrain/${z}/${x}/${y}.ptm`;
    if (!fs.existsSync(lp) || !fs.existsSync(pp)) { console.log(`${arg}: missing`); continue; }
    const vec = decodeLvr(fs.readFileSync(lp));
    const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(pp)));
    const q = tile.quantScale;
    const b = tileBounds({ z, x, y });
    // A little over half the tile's ground width, as the surface cut-off.
    const reach = ((b.north - b.south) * 110540) / 2 * 1.05;
    // The tile's local vertical in scene axes, the same way buildTile finds it:
    // ENU u is only vertical near the frame's own origin, which is 3400 km away.
    const basis = makeEnuBasis(PLAY_ORIGIN.lat, PLAY_ORIGIN.lon, PLAY_ORIGIN.height);
    const lon = (b.west + b.east) / 2;
    const lat = (b.south + b.north) / 2;
    const c0 = ecefToEnu(basis, geodeticToEcef(lat, lon, tile.centerHeightM));
    const c1 = ecefToEnu(basis, geodeticToEcef(lat, lon, tile.centerHeightM + 1000));
    const upLen = Math.hypot(c1.e - c0.e, c1.u - c0.u, c0.n - c1.n) || 1;
    const up = {
        x: (c1.e - c0.e) / upLen, y: (c1.u - c0.u) / upLen, z: (c0.n - c1.n) / upLen,
    };

    // Centreline length asked for, in metres.
    let lineM = 0;
    for (const course of vec.watercourses) {
        for (let i = 1; i < course.points.length; i++) {
            lineM += groundMetres(course.points[i - 1], course.points[i]);
        }
    }

    // ...and the length that came out. Stroke vertices come in pairs sharing a
    // position, so the centreline is every other one; a strip break shows up
    // as a pair whose quad is not in the index buffer.
    const pairs = tile.riverHalfWidths.length / 2;
    const linked = new Set<number>();
    for (let i = 0; i < tile.riverIndices.length; i += 3) {
        const lo = Math.min(
            tile.riverIndices[i], tile.riverIndices[i + 1], tile.riverIndices[i + 2]);
        linked.add(lo >> 1);
    }
    let strokeM = 0;
    let strips = 0;
    let prevLinked = false;
    for (let p = 0; p + 1 < pairs; p++) {
        if (!linked.has(p)) { prevLinked = false; continue; }
        if (!prevLinked) strips++;
        prevLinked = true;
        const a = p * 2, b = (p + 1) * 2;
        strokeM += Math.hypot(
            (tile.riverPositions[b * 3] - tile.riverPositions[a * 3]) * q,
            (tile.riverPositions[b * 3 + 1] - tile.riverPositions[a * 3 + 1]) * q,
            (tile.riverPositions[b * 3 + 2] - tile.riverPositions[a * 3 + 2]) * q,
        );
    }

    // Buried? Every stroke point that lands on a land triangle must be on top
    // of it. Sampled, because the land test is linear in triangle count.
    //
    // A handful of false positives survive at a shoreline, where a stroke
    // correctly sitting on the water surface is overlapped in plan view by the
    // land triangle on the bank above it — the frame's y axis is 31 degrees off
    // vertical at Potsdam, so the two footprints do not separate cleanly. On
    // the Potsdam bake that is 2 points of 862, all on one z10 tile. Read a
    // handful as noise and a run of them as a real problem.
    let checked = 0, buried = 0, worst = 0;
    const step = Math.max(1, Math.floor(pairs / 400));
    for (let p = 0; p < pairs; p += step) {
        const v = p * 2;
        const ground = landHeightAt(
            tile, tile.riverPositions[v * 3] * q, tile.riverPositions[v * 3 + 2] * q,
            reach, up);
        if (ground === undefined) continue;
        checked++;
        const drop = ground - tile.riverPositions[v * 3 + 1] * q;
        if (drop > BURIED_EPS_M) { buried++; worst = Math.max(worst, drop); }
    }

    tot.runs += vec.watercourses.length; tot.strips += strips;
    tot.lineM += lineM; tot.strokeM += strokeM;
    tot.checked += checked; tot.buried += buried;
    tot.worst = Math.max(tot.worst, worst);

    const pc = lineM > 0 ? `${(strokeM / lineM * 100).toFixed(1)}%` : '-';
    console.log(`${arg}  centrelines ${String(vec.watercourses.length).padStart(3)}`
        + ` -> strips ${String(strips).padStart(3)}`
        + ` | length drawn ${pc.padStart(6)}`
        + ` | buried ${buried}/${checked}`
        + (worst > 0 ? ` (worst ${worst.toFixed(2)} m)` : ''));
}

const pc = tot.lineM > 0 ? `${(tot.strokeM / tot.lineM * 100).toFixed(1)}%` : '-';
console.log(`\nTOTAL ${tot.runs} centrelines -> ${tot.strips} strips,`
    + ` ${(tot.lineM / 1000).toFixed(1)} km asked for, ${pc} drawn,`
    + ` ${tot.buried}/${tot.checked} stroke points buried`
    + (tot.worst > 0 ? `, worst ${tot.worst.toFixed(2)} m` : ''));
