/**
 * Bake motorway grade sidecars (.rgr) into the planet pyramid.
 *
 * Reads the leaf-level road vectors (.rvr) bake_osm_roads.py wrote, joins the
 * motorway pieces the tile borders cut apart, samples the DEM under each run,
 * fits a profile no steeper than 4.5 % to it (tools/bake/roadGrade.ts) and
 * writes, beside every leaf .pdm the road comes within reach of, the lines
 * with their design heights. The mesh bake reads those and lays the roadbed
 * into the height grid before meshing, so embankments and cuttings are ordinary
 * terrain. Run it before `npm run bake:mesh`; after it re-run bake:road-strokes
 * and bake:bridges, whose ground has moved.
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
import { decodeRvr } from './bake/rvr';
import {
    BATTER_REACH_M, GRADE_STEP_M, GradeLine, GradePoint, ROADBED_SHOULDER_M, encodeRgr, gradeProfile,
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
 */
const MAX_EARTHWORK_M = 30;

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

function readMotorways(src: string, bbox?: number[]): Piece[] {
    const pieces: Piece[] = [];
    const root = path.join(src, String(LEAF_ZOOM));
    if (!fs.existsSync(root)) {
        return pieces;
    }
    for (const xs of fs.readdirSync(root)) {
        for (const f of fs.readdirSync(path.join(root, xs))) {
            if (!f.endsWith('.rvr')) continue;
            if (bbox) {
                const b = tileBounds({ z: LEAF_ZOOM, x: Number(xs), y: Number(f.slice(0, -4)) });
                if (b.east <= bbox[0] || b.west >= bbox[2] || b.north <= bbox[1] || b.south >= bbox[3]) continue;
            }
            for (const r of decodeRvr(fs.readFileSync(path.join(root, xs, f)))) {
                if (r.cls === MOTORWAY && r.points.length >= 2) {
                    pieces.push({ halfM: r.widthM / 2, pts: r.points.map(p => ({ lon: p.lon, lat: p.lat })) });
                }
            }
        }
    }
    return pieces;
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

function median3(v: number[]): number[] {
    return v.map((_, i) => {
        const w = [v[Math.max(0, i - 1)], v[i], v[Math.min(v.length - 1, i + 1)]].sort((a, b) => a - b);
        return w[1];
    });
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const sample = makeSampler(args.src);
    const pieces = readMotorways(args.src, args.bbox);
    const runs = stitch(pieces);
    console.log(`bake_planet_roadgrade: ${pieces.length} motorway pieces -> ${runs.length} runs`);

    const perTile = new Map<string, GradeLine[]>();
    let samples = 0, skipped = 0, worstCut = 0, worstFill = 0, steep = 0;
    const heavy: string[] = [];
    const reachDeg = (lat: number, m: number) => ({
        lon: m / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180)), lat: m / METRES_PER_DEGREE,
    });
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
        const design = gradeProfile(ground);
        const line: GradePoint[] = pts.map((p, i) => ({ lon: p.lon, lat: p.lat, h: design[i] }));
        samples += pts.length;
        const dev = Math.max(...ground.map((g, i) => Math.abs(g - design[i])));
        if (dev > 40) heavy.push(`${pts[0].lat.toFixed(4)},${pts[0].lon.toFixed(4)} ${(pts.length * GRADE_STEP_M / 1000).toFixed(1)} km dev ${dev.toFixed(0)} m`);
        for (let i = 0; i < pts.length; i++) {
            worstFill = Math.max(worstFill, design[i] - ground[i]);
            worstCut = Math.max(worstCut, ground[i] - design[i]);
            if (i > 0 && Math.abs(design[i] - design[i - 1]) / GRADE_STEP_M > 0.05) steep++;
        }
        // Every leaf tile a segment's reach touches gets that stretch whole.
        const reachM = run.halfM + ROADBED_SHOULDER_M + BATTER_REACH_M + 5;
        const runs: Map<string, number[]> = new Map();
        const workable = (i: number) => Math.abs(ground[i] - design[i]) <= MAX_EARTHWORK_M;
        for (let i = 0; i + 1 < line.length; i++) {
            if (!workable(i) || !workable(i + 1)) continue;
            const r = reachDeg((line[i].lat + line[i + 1].lat) / 2, reachM);
            const a = tileAtLonLat(LEAF_ZOOM, Math.min(line[i].lon, line[i + 1].lon) - r.lon, Math.max(line[i].lat, line[i + 1].lat) + r.lat);
            const b = tileAtLonLat(LEAF_ZOOM, Math.max(line[i].lon, line[i + 1].lon) + r.lon, Math.min(line[i].lat, line[i + 1].lat) - r.lat);
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
                (perTile.get(key) ?? perTile.set(key, []).get(key)!)
                    .push({ halfM: run.halfM, points: line.slice(from, to + 2) });
            };
            for (let k = 1; k < segs.length; k++) {
                if (segs[k] !== prev + 1) { flush(start, prev); start = segs[k]; }
                prev = segs[k];
            }
            flush(start, prev);
        }
    }

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
