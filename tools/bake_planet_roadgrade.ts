/**
 * Bake road grade sidecars (.rgr) into the planet pyramid.
 *
 * Reads the leaf-level road vectors (.rvr) bake_osm_roads.py wrote, joins the
 * pieces of one class the tile borders cut apart, samples the DEM under each
 * run, fits a profile to it - no steeper than 4.5 % for a motorway, 4 % for
 * every other class (tools/bake/roadGrade.ts) - and writes, beside every leaf
 * .pdm the road comes within reach of, the lines with their design heights.
 * Ground too steep for that grade within MAX_EARTHWORK_M of the road (a
 * mountain road, a hairpin) is left alone: the profile only straightens a
 * road the terrain can actually carry flattened - except where the road's
 * surroundings are flat (FLAT_RADIUS_M, FLAT_RELIEF_M below), where a deep
 * earthwork reading is a DEM glitch rather than real relief, and the profile
 * is kept rather than dropping to raw, spiky ground. The mesh bake reads those
 * and lays the roadbed into the height grid before meshing, so embankments
 * and cuttings are ordinary terrain. Run it before `npm run bake:mesh`; after
 * it re-run bake:road-strokes and bake:bridges, whose ground has moved.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_roadgrade.ts [--src DIR] [--bbox w,s,e,n]
 *
 *     --src DIR     the planet pyramid (default assets/planet)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodePdm } from '../src/script/terrain/demTile';
import { tileAtLonLat, tileBounds } from '../src/script/terrain/tiling';
import { decodeRbr } from './bake/rbr';
import { decodeRvr } from './bake/rvr';
import { CrossingEnv, CrossingStats, MAX_CROSSING_WORK_M, RoadPiece, planCrossings } from './bake/crossings';
import {
    BATTER_REACH_M, GRADE_STEP_M, GradeLine, GradePoint, ROAD_GRADE_MAX, ROADBED_SHOULDER_M, encodeRgr, gradeProfile,
} from './bake/roadGrade';

const LEAF_ZOOM = 12;
const MOTORWAY = 0;
const METRES_PER_DEGREE = 111320;
/** Ends this close (metres) are the same node cut by a tile border. */
const JOIN_M = 1.5;
/**
 * Deepest cut or highest fill, metres, the bake will build. Past it the road is
 * under a mountain or over a gorge the map has no tunnel or bridge for (the
 * Hai Van run is 475 m under its ridge), and digging it would carve a canyon.
 *
 * This only excuses genuine relief: FLAT_RADIUS_M below lifts the limit
 * entirely where the ground around a point barely varies, because there a
 * deep reading is a DEM glitch (a building, a bad cell), not a mountain, and
 * leaving the point undraped just to honour a false spike drops a jagged
 * artifact into otherwise flat, graded ground.
 */
const MAX_EARTHWORK_M = 30;
/** Radius, metres, a point's surroundings are read over to judge whether it is flat. */
const FLAT_RADIUS_M = 1000;
/** Relief within FLAT_RADIUS_M under this, metres, counts as flat: real hills clear it easily. */
const FLAT_RELIEF_M = 15;

interface Piece {
    halfM: number;
    pts: Array<{ lon: number; lat: number }>;
}

function parseArgs(argv: string[]): { src: string; bbox?: number[] } {
    const a: { src: string; bbox?: number[] } = { src: 'assets/planet' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--src') a.src = argv[++i];
        else if (argv[i] === '--bbox') a.bbox = argv[++i].split(',').map(Number);
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return a;
}

const demCache = new Map<string, { size: number; heights: Float32Array } | null>();

function makeSampler(src: string) {
    return (lon: number, lat: number): number => {
        const id = tileAtLonLat(LEAF_ZOOM, lon, lat);
        const key = `${id.x}/${id.y}`;
        let dem = demCache.get(key);
        if (dem === undefined) {
            const p = path.join(src, String(LEAF_ZOOM), String(id.x), `${id.y}.pdm`);
            dem = fs.existsSync(p) ? decodePdm(fs.readFileSync(p)) : null;
            if (demCache.size > 96) {
                demCache.clear();
            }
            demCache.set(key, dem);
        }
        if (!dem) {
            return NaN;
        }
        const b = tileBounds(id);
        const cells = dem.size - 1;
        const fx = Math.min(cells - 1e-6, Math.max(0, ((lon - b.west) / (b.east - b.west)) * cells));
        const fy = Math.min(cells - 1e-6, Math.max(0, ((b.north - lat) / (b.north - b.south)) * cells));
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const h = (x: number, y: number) => dem!.heights[y * dem!.size + x];
        return (h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx) * (1 - ty)
            + (h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx) * ty;
    };
}

/** Every road, grouped by class - a run is only ever stitched within one class. */
function readRoads(src: string, bbox?: number[]): Map<number, Piece[]> {
    const byClass = new Map<number, Piece[]>();
    const root = path.join(src, String(LEAF_ZOOM));
    if (!fs.existsSync(root)) {
        return byClass;
    }
    for (const xs of fs.readdirSync(root)) {
        for (const f of fs.readdirSync(path.join(root, xs))) {
            if (!f.endsWith('.rvr')) continue;
            if (bbox) {
                const b = tileBounds({ z: LEAF_ZOOM, x: Number(xs), y: Number(f.slice(0, -4)) });
                if (b.east <= bbox[0] || b.west >= bbox[2] || b.north <= bbox[1] || b.south >= bbox[3]) continue;
            }
            for (const r of decodeRvr(fs.readFileSync(path.join(root, xs, f)))) {
                if (r.points.length < 2) continue;
                const list = byClass.get(r.cls) ?? byClass.set(r.cls, []).get(r.cls)!;
                list.push({ halfM: r.widthM / 2, pts: r.points.map(p => ({ lon: p.lon, lat: p.lat })) });
            }
        }
    }
    return byClass;
}

/**
 * The grade a road of this class is held to. A motorway is always built to
 * 4.5 %. Every other class - trunk down to residential - is held to 4 %,
 * except a run that lies entirely in flat surroundings (every sample clears
 * `flatness` below), which gets the same 4.5 % a motorway does: nothing in a
 * flat run calls for the tighter limit, and the extra half a percent is
 * margin that keeps a minor stray bump from being fought down to 4 % only to
 * open an earthwork deep enough to trip MAX_EARTHWORK_M. Ground steeper than
 * MAX_EARTHWORK_M would let a segment reach is left alone whatever the class:
 * a mountain road follows its hillside, because flattening it would mean an
 * embankment or cutting nothing in the terrain data calls for.
 */
function maxGradeFor(cls: number, flat: boolean): number {
    return cls === MOTORWAY || flat ? ROAD_GRADE_MAX : 0.04;
}

/** Join pieces whose ends meet at exactly one other piece's end. */
function stitch(pieces: Piece[]): Piece[] {
    const cell = (v: number) => Math.round(v * 1e5);
    const ends = new Map<string, Array<{ i: number; end: 0 | 1 }>>();
    const endPt = (i: number, end: 0 | 1) => pieces[i].pts[end === 0 ? 0 : pieces[i].pts.length - 1];
    pieces.forEach((_, i) => ([0, 1] as const).forEach(end => {
        const p = endPt(i, end);
        const k = `${cell(p.lon)},${cell(p.lat)}`;
        (ends.get(k) ?? ends.set(k, []).get(k)!).push({ i, end });
    }));
    const near = (i: number, end: 0 | 1) => {
        const p = endPt(i, end);
        const kx = METRES_PER_DEGREE * Math.cos((p.lat * Math.PI) / 180);
        const out: Array<{ i: number; end: 0 | 1 }> = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const e of ends.get(`${cell(p.lon) + dx},${cell(p.lat) + dy}`) ?? []) {
                    if (e.i === i && e.end === end) continue;
                    const q = endPt(e.i, e.end);
                    if (Math.hypot((q.lon - p.lon) * kx, (q.lat - p.lat) * METRES_PER_DEGREE) <= JOIN_M) out.push(e);
                }
            }
        }
        return out;
    };
    const partner = new Map<string, { i: number; end: 0 | 1 }>();
    pieces.forEach((_, i) => ([0, 1] as const).forEach(end => {
        const n = near(i, end);
        if (n.length === 1 && n[0].i !== i) partner.set(`${i}:${end}`, n[0]);
    }));
    const used = new Uint8Array(pieces.length);
    const out: Piece[] = [];
    const walk = (start: number, startEnd: 0 | 1) => {
        // Walk from `start`, leaving through the end opposite `startEnd`.
        const pts: Piece['pts'] = [];
        let half = 0, count = 0;
        let i = start, entered: 0 | 1 = startEnd;
        for (;;) {
            used[i] = 1;
            const seg = entered === 0 ? pieces[i].pts : [...pieces[i].pts].reverse();
            pts.push(...(pts.length ? seg.slice(1) : seg));
            half += pieces[i].halfM; count++;
            const exit: 0 | 1 = entered === 0 ? 1 : 0;
            const nxt = partner.get(`${i}:${exit}`);
            if (!nxt || used[nxt.i]) break;
            i = nxt.i; entered = nxt.end;
        }
        out.push({ halfM: half / count, pts });
    };
    pieces.forEach((_, i) => {
        if (used[i]) return;
        // Start at a free end if there is one, so a run is walked whole.
        if (!partner.has(`${i}:0`)) walk(i, 0);
        else if (!partner.has(`${i}:1`)) walk(i, 1);
    });
    pieces.forEach((_, i) => { if (!used[i]) walk(i, 0); }); // closed loops
    return out;
}

/** The polyline resampled every GRADE_STEP_M, keeping the last point. */
function resample(pts: Piece['pts']): Array<{ lon: number; lat: number }> {
    const out = [pts[0]];
    let carry = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        const kx = METRES_PER_DEGREE * Math.cos((a.lat * Math.PI) / 180);
        const len = Math.hypot((b.lon - a.lon) * kx, (b.lat - a.lat) * METRES_PER_DEGREE);
        let d = GRADE_STEP_M - carry;
        while (d <= len) {
            const t = d / len;
            out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
            d += GRADE_STEP_M;
        }
        carry = len - (d - GRADE_STEP_M);
    }
    const last = pts[pts.length - 1];
    if (out[out.length - 1] !== last) out.push(last);
    return out;
}

/** Per-sample: is the ground within FLAT_RADIUS_M of this point flat (relief under FLAT_RELIEF_M)? */
function flatness(ground: readonly number[]): boolean[] {
    const w = Math.max(1, Math.round(FLAT_RADIUS_M / GRADE_STEP_M));
    const out = new Array<boolean>(ground.length);
    for (let i = 0; i < ground.length; i++) {
        let lo = Infinity, hi = -Infinity;
        for (let j = Math.max(0, i - w); j <= Math.min(ground.length - 1, i + w); j++) {
            lo = Math.min(lo, ground[j]);
            hi = Math.max(hi, ground[j]);
        }
        out[i] = hi - lo <= FLAT_RELIEF_M;
    }
    return out;
}

function median3(v: number[]): number[] {
    return v.map((_, i) => {
        const w = [v[Math.max(0, i - 1)], v[i], v[Math.min(v.length - 1, i + 1)]].sort((a, b) => a - b);
        return w[1];
    });
}

type TileLines = Map<string, GradeLine[]>;

/** Every leaf tile a segment's reach touches gets that stretch whole. */
function addToTiles(
    perTile: TileLines, halfM: number, line: GradePoint[], workable: (i: number) => boolean,
): void {
    const reachM = halfM + ROADBED_SHOULDER_M + BATTER_REACH_M + 5;
    const runs = new Map<string, number[]>();
    for (let i = 0; i + 1 < line.length; i++) {
        if (!workable(i) || !workable(i + 1)) continue;
        const lat = (line[i].lat + line[i + 1].lat) / 2;
        const rl = reachM / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180)), rt = reachM / METRES_PER_DEGREE;
        const a = tileAtLonLat(LEAF_ZOOM, Math.min(line[i].lon, line[i + 1].lon) - rl, Math.max(line[i].lat, line[i + 1].lat) + rt);
        const b = tileAtLonLat(LEAF_ZOOM, Math.max(line[i].lon, line[i + 1].lon) + rl, Math.min(line[i].lat, line[i + 1].lat) - rt);
        for (let x = a.x; x <= b.x; x++) {
            for (let y = a.y; y <= b.y; y++) {
                const key = `${x}/${y}`;
                (runs.get(key) ?? runs.set(key, []).get(key)!).push(i);
            }
        }
    }
    for (const [key, segs] of runs) {
        let start = segs[0], prev = segs[0];
        const flush = (from: number, to: number) => {
            (perTile.get(key) ?? perTile.set(key, []).get(key)!).push({ halfM, points: line.slice(from, to + 2) });
        };
        for (let k = 1; k < segs.length; k++) {
            if (segs[k] !== prev + 1) { flush(start, prev); start = segs[k]; }
            prev = segs[k];
        }
        flush(start, prev);
    }
}

/** Design height of the motorway nearest a point (within 25 m), or undefined. */
/** The nearest baked road profile's design height near a point, or undefined off one. */
function roadProfileHeights(perTile: TileLines): (lon: number, lat: number) => number | undefined {
    const CELL = 300;
    const hash = new Map<string, GradePoint[]>();
    for (const lines of perTile.values()) {
        for (const l of lines) {
            for (const p of l.points) {
                const key = `${Math.floor(p.lon * CELL)},${Math.floor(p.lat * CELL)}`;
                (hash.get(key) ?? hash.set(key, []).get(key)!).push(p);
            }
        }
    }
    return (lon, lat) => {
        const kx = METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
        let best: number | undefined, bestD = 25;
        const cx = Math.floor(lon * CELL), cy = Math.floor(lat * CELL);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                for (const p of hash.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const d = Math.hypot((p.lon - lon) * kx, (p.lat - lat) * METRES_PER_DEGREE);
                    if (d < bestD) { bestD = d; best = p.h; }
                }
            }
        }
        return best;
    };
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const sample = makeSampler(args.src);
    const byClass = readRoads(args.src, args.bbox);
    const perTile = new Map<string, GradeLine[]>();
    let pieceCount = 0, runCount = 0;
    let samples = 0, skipped = 0, worstCut = 0, worstFill = 0, steep = 0;
    const heavy: string[] = [];
    for (const [cls, pieces] of byClass) {
        const runs = stitch(pieces);
        pieceCount += pieces.length;
        runCount += runs.length;
        for (const run of runs) {
            const pts = resample(run.pts);
            if (pts.length < 2) continue;
            let ground = pts.map(p => sample(p.lon, p.lat));
            const valid = ground.filter(Number.isFinite).length;
            if (valid < pts.length * 0.8) { skipped++; continue; }
            // Holes take the nearest valid neighbour, then a median takes the
            // buildings and single bad cells SRTM has out of the profile.
            let last = ground.find(Number.isFinite)!;
            ground = ground.map(g => (Number.isFinite(g) ? (last = g) : last));
            ground = median3(median3(ground));
            // Ground steeper than MAX_EARTHWORK_M lets a segment reach is a mountain
            // road: left draped on the terrain, whatever class it is - unless the
            // surroundings are flat, where that reading is trusted to be a glitch
            // and the point stays graded rather than dropping to raw, spiky ground.
            const flat = flatness(ground);
            const maxGrade = maxGradeFor(cls, flat.every(f => f));
            const design = gradeProfile(ground, maxGrade);
            const line: GradePoint[] = pts.map((p, i) => ({ lon: p.lon, lat: p.lat, h: design[i] }));
            samples += pts.length;
            const dev = Math.max(...ground.map((g, i) => Math.abs(g - design[i])));
            if (dev > 40) heavy.push(`${pts[0].lat.toFixed(4)},${pts[0].lon.toFixed(4)} ${(pts.length * GRADE_STEP_M / 1000).toFixed(1)} km dev ${dev.toFixed(0)} m`);
            for (let i = 0; i < pts.length; i++) {
                worstFill = Math.max(worstFill, design[i] - ground[i]);
                worstCut = Math.max(worstCut, ground[i] - design[i]);
                if (i > 0 && Math.abs(design[i] - design[i - 1]) / GRADE_STEP_M > maxGrade + 1e-6) steep++;
            }
            addToTiles(perTile, run.halfM, line, i => flat[i] || Math.abs(ground[i] - design[i]) <= MAX_EARTHWORK_M);
        }
    }
    console.log(`bake_planet_roadgrade: ${pieceCount} road pieces -> ${runCount} runs, ${byClass.size} classes`);

    // Bridges over other streets: the smaller road ramps or sinks (crossings.ts).
    //
    // Both `ground` and `roadH` read the same function on purpose. A ramp
    // tapers back to whatever height is already authoritative at a point - the
    // general 4 % profile this loop just wrote for that road if it has one,
    // raw terrain otherwise - not to the bare DEM regardless. Reading raw
    // ground here while a road's own profile stands metres away from it (a
    // profiled street on a hillside, say) split the carve between two
    // disagreeing authorities for the same nodes and opened a seam exactly
    // where the ramp handed off to the profile: the street stopping short of
    // the bridge it was supposed to reach.
    const roadH = roadProfileHeights(perTile);
    const profileOrGround = (lon: number, lat: number) => roadH(lon, lat) ?? sample(lon, lat);
    const env: CrossingEnv = {
        ground: profileOrGround,
        roadH: profileOrGround,
    };
    const cstat: CrossingStats = { crossings: 0, dips: 0, fills: 0, skipped: 0 };
    const rbrRoot = path.join(args.src, String(LEAF_ZOOM));
    const rvrCache = new Map<string, RoadPiece[]>();
    const roadsOf = (x: number, y: number): RoadPiece[] => {
        const key = `${x}/${y}`;
        let roads = rvrCache.get(key);
        if (roads === undefined) {
            const p = path.join(rbrRoot, String(x), `${y}.rvr`);
            roads = fs.existsSync(p)
                ? decodeRvr(fs.readFileSync(p)).map(r => ({ cls: r.cls, halfM: r.widthM / 2, points: r.points }))
                : [];
            if (rvrCache.size > 48) rvrCache.clear();
            rvrCache.set(key, roads);
        }
        return roads;
    };
    for (const xs of fs.existsSync(rbrRoot) ? fs.readdirSync(rbrRoot) : []) {
        for (const f of fs.readdirSync(path.join(rbrRoot, xs))) {
            if (!f.endsWith('.rbr')) continue;
            const x = Number(xs), y = Number(f.slice(0, -4));
            if (args.bbox) {
                const b = tileBounds({ z: LEAF_ZOOM, x, y });
                if (b.east <= args.bbox[0] || b.west >= args.bbox[2] || b.north <= args.bbox[1] || b.south >= args.bbox[3]) continue;
            }
            const spans = decodeRbr(fs.readFileSync(path.join(rbrRoot, xs, f)));
            const roads: RoadPiece[] = [];
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) roads.push(...roadsOf(x + dx, y + dy));
            const lines = planCrossings(spans.map(r => ({ structure: r.structure, points: r.points })), roads, env, cstat);
            for (const l of lines) addToTiles(perTile, l.halfM, l.points, () => true);
        }
    }
    console.log(`crossings   ${cstat.crossings} bridge/road crossings: ${cstat.fills} approach fills, ${cstat.dips} cuttings, ${cstat.skipped} skipped (over ${MAX_CROSSING_WORK_M} m)`);

    const leafRoot = path.join(args.src, String(LEAF_ZOOM));
    let written = 0, bytes = 0, stale = 0;
    const keep = new Set<string>();
    for (const [key, lines] of perTile) {
        const [x, y] = key.split('/');
        if (!fs.existsSync(path.join(leafRoot, x, `${y}.pdm`))) continue;
        const blob = encodeRgr(lines);
        fs.writeFileSync(path.join(leafRoot, x, `${y}.rgr`), blob);
        keep.add(key);
        written++;
        bytes += blob.byteLength;
    }
    if (!args.bbox) {
        for (const xs of fs.existsSync(leafRoot) ? fs.readdirSync(leafRoot) : []) {
            for (const f of fs.readdirSync(path.join(leafRoot, xs))) {
                if (f.endsWith('.rgr') && !keep.has(`${xs}/${f.slice(0, -4)}`)) {
                    fs.unlinkSync(path.join(leafRoot, xs, f));
                    stale++;
                }
            }
        }
    }
    if (heavy.length) {
        console.log(`heavy earthwork (>40 m): ${heavy.length}`);
        for (const h of heavy.slice(0, 8)) console.log(`  ${h}`);
    }
    console.log(`profile     ${samples} samples every ${GRADE_STEP_M.toFixed(1)} m, ${skipped} runs skipped (no DEM)`);
    console.log(`earthwork   worst fill ${worstFill.toFixed(1)} m, worst cut ${worstCut.toFixed(1)} m, steps over 5%: ${steep}`);
    console.log(`wrote ${written} .rgr (${(bytes / 1024).toFixed(0)} KB)${stale ? `, removed ${stale} stale` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('next: npm run bake:mesh, then bake:road-strokes and bake:bridges');
}

main();
