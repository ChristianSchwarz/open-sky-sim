/**
 * Lay the road and railway beds into the baked terrain: the last stage of a
 * bake, after the mesh, the road strokes and the bridges. Where the lidar
 * store (tools/measure_lidar.py) has measured a leaf, its lines take their
 * embankments and cuttings from the lidar rather than from the land.
 *
 * Every tile with strokes, z8 up, is graded by railBed.ts layRailBeds - the
 * code the browser used to run on every tile it drew - and written back:
 * the .ptm with the beds in its land, the .ptr with its strokes on their
 * profiles, and a .pbd with the beds and the retaining walls (collision, the
 * trees, the walls' mesh). The frontend only loads them. See
 * tools/bake/gradeTile.ts for one tile, railBedInputs.ts for its input.
 *
 * A graded tile is flagged (PTM_FLAG_GRADED, PTR_TILE_GRADED) and never
 * graded again; the stages before this one refuse it. To grade a box again,
 * re-bake its mesh and roads first.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_grade.ts [options]
 *
 *     --dir DIR        the mesh tree (default assets/terrain)
 *     --bbox w,s,e,n   only tiles in this box; the bed index is merged
 *     --jobs N         worker threads (default: CPUs - 1)
 *     --no-bundle      run the worker under tsx instead of an esbuild bundle
 *     --no-free-border grade each leaf alone, its beds fading out at the border
 *     --lidar-store DIR the lidar store (default data/imports/lidar/store),
 *                      written by tools/measure_lidar.py; leaves it has
 *                      measured fit their lines to the lidar
 *     --src DIR        the planet pyramid the store was measured on (default
 *                      assets/planet): a leaf whose .rvr changed since is
 *                      graded without its measurements
 *     --no-lidar       ignore the store
 *
 * Leaves are graded in two passes. The first lays out every leaf's beds -
 * the box's and the ring of leaves round it - into a temporary .pbd1; the
 * second grades each leaf with its neighbours' beds (a bed beside the
 * border has its batter on both tiles) and its border free where a bed
 * reaches it, so both tiles move their shared border alike (railBed.ts
 * RailBedInput.freeBorder). The .pbd1 files are removed at the end.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { boundsOf } from './bake/coverTex';
import { LonLatBounds } from './bake/shoreline';
import { GradeConfig, GradeResult, PASS1_EXT } from './bake/gradeTile';
import { tileFile } from './bake/railBedInputs';
import { LIDAR_STORE_DIR } from './bake/lidarStore';

const WORKER_SOURCE = path.join(__dirname, 'bake', 'gradeTileWorker.ts');
const WORKER_BUNDLE = path.join(__dirname, 'bake', '.build', 'gradeTileWorker.cjs');
/** Stop handing out tiles when the disk has less than this left, bytes. */
const MIN_FREE_BYTES = 2e9;

interface Args {
    dir: string;
    bbox?: LonLatBounds;
    jobs?: number;
    noBundle: boolean;
    freeBorder: boolean;
    lidarStore: string;
    src: string;
    lidar: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { dir: 'assets/terrain', noBundle: false, freeBorder: true, lidarStore: LIDAR_STORE_DIR, src: 'assets/planet', lidar: true };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--bbox') {
            const [west, south, east, north] = next().split(',').map(Number);
            if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
                throw new Error('--bbox wants west,south,east,north');
            }
            a.bbox = { west, south, east, north };
        } else if (k === '--jobs') a.jobs = Math.max(1, Number(next()));
        else if (k === '--no-bundle') a.noBundle = true;
        else if (k === '--no-free-border') a.freeBorder = false;
        else if (k === '--lidar-store') a.lidarStore = next();
        else if (k === '--src') a.src = next();
        else if (k === '--no-lidar') a.lidar = false;
        else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const overlaps = (a: LonLatBounds, b: LonLatBounds) =>
    !(a.east <= b.west || a.west >= b.east || a.north <= b.south || a.south >= b.north);

/** A .ptm's baked centre height, from its header alone (the gzip stream's first bytes). */
function centreHeightOf(p: string): number | undefined {
    if (!fs.existsSync(p)) {
        return undefined;
    }
    const fd = fs.openSync(p, 'r');
    try {
        const head = Buffer.alloc(4096);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        const raw = head[0] === 0x1f && head[1] === 0x8b
            ? zlib.gunzipSync(head.subarray(0, n), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
            : head.subarray(0, n);
        return raw.byteLength >= 20 ? raw.readFloatLE(16) : undefined;
    } finally {
        fs.closeSync(fd);
    }
}

async function prepareWorker(noBundle: boolean): Promise<{ file: string; execArgv: string[] }> {
    if (!noBundle) {
        try {
            const esbuild = await import('esbuild');
            fs.mkdirSync(path.dirname(WORKER_BUNDLE), { recursive: true });
            await esbuild.build({
                entryPoints: [WORKER_SOURCE], outfile: WORKER_BUNDLE, bundle: true, platform: 'node', format: 'cjs',
                target: `node${process.versions.node.split('.')[0]}`, logLevel: 'silent',
            });
            return { file: WORKER_BUNDLE, execArgv: [] };
        } catch (err) {
            console.warn(`warning: could not bundle the grading worker (${(err as Error).message}); running it under tsx`);
        }
    }
    return { file: WORKER_SOURCE, execArgv: process.execArgv };
}

function freeBytes(dir: string): number {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
}

/** Run one pass over `tiles` on a pool of workers; results in `tiles` order. */
async function runPass(
    worker: { file: string; execArgv: string[] }, cfg: GradeConfig, tiles: readonly TileKey[], pass: 1 | 2, t0: number,
    jobs: number, diskLow: () => boolean,
): Promise<{ results: Array<GradeResult | undefined>; errors: string[]; stoppedForDisk: boolean }> {
    const results: Array<GradeResult | undefined> = new Array(tiles.length);
    const errors: string[] = [];
    let stoppedForDisk = false;
    await new Promise<void>((resolve, reject) => {
        if (tiles.length === 0) {
            resolve();
            return;
        }
        let next = 0, done = 0, running = 0, lastLine = 0;
        const workers: Worker[] = [];
        const dispatch = (w: Worker): boolean => {
            if (next >= tiles.length || stoppedForDisk) {
                return false;
            }
            if (next % 50 === 0 && diskLow()) {
                stoppedForDisk = true;
                return false;
            }
            const idx = next++;
            running++;
            w.postMessage({ idx, key: tiles[idx], pass });
            return true;
        };
        const finish = () => {
            for (const w of workers) {
                w.postMessage(null);
            }
            resolve();
        };
        for (let i = 0; i < Math.min(jobs, tiles.length); i++) {
            const w = new Worker(worker.file, { execArgv: worker.execArgv, workerData: cfg });
            workers.push(w);
            w.on('message', (msg: { idx: number; result: GradeResult | { error: string } }) => {
                running--;
                done++;
                if ('error' in msg.result) {
                    errors.push(msg.result.error);
                } else {
                    results[msg.idx] = msg.result;
                }
                if (Date.now() - lastLine > 1000 || done === tiles.length) {
                    const el = (Date.now() - t0) / 1000;
                    process.stdout.write(`\r  pass ${pass}: ${done}/${tiles.length} (${((done / tiles.length) * 100).toFixed(1)}%)  ${(el / 60).toFixed(1)} min   `);
                    lastLine = Date.now();
                }
                if (!dispatch(w) && running === 0) {
                    finish();
                }
            });
            w.on('error', err => {
                for (const x of workers) {
                    void x.terminate();
                }
                reject(err);
            });
            if (!dispatch(w) && running === 0) {
                finish();
            }
        }
    });
    process.stdout.write('\n');
    return { results, errors, stoppedForDisk };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const manifestPath = path.join(args.dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const leafZoom: number = manifest.mesh.maxZoom;
    if (!manifest.roads) {
        console.log('bake_planet_grade: no roads in this pyramid, nothing to grade');
        return;
    }
    const tiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.roads.indexPath)))
        .filter(k => args.bbox === undefined || overlaps(boundsOf(k), args.bbox));
    // Leaves read their neighbours' bridges, placed by the neighbours' centre heights.
    const centreHeights: Record<string, number> = {};
    for (const k of tiles) {
        if (k.z !== leafZoom) {
            continue;
        }
        // Two rings: the first pass lays out the ring round the box too.
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const nb = { z: k.z, x: k.x + dx, y: k.y + dy };
                const key = keyOf(nb);
                if (centreHeights[key] === undefined) {
                    const h = centreHeightOf(tileFile(args.dir, nb, '.ptm'));
                    if (h !== undefined) {
                        centreHeights[key] = h;
                    }
                }
            }
        }
    }
    const jobs = Math.max(1, Math.min(args.jobs ?? os.cpus().length - 1, tiles.length));
    console.log(`bake_planet_grade: ${tiles.length} tiles with strokes${args.bbox ? ' (scoped)' : ''}, ${jobs} workers, `
        + `${(freeBytes(args.dir) / 1e9).toFixed(1)} GB free`);
    const lidar = args.lidar && fs.existsSync(args.lidarStore) ? { store: args.lidarStore, planet: args.src } : undefined;
    console.log(lidar ? `lidar: lines fitted to the measurements in ${args.lidarStore}` : 'lidar: none, the beds follow the land');
    const cfg: GradeConfig = { dir: args.dir, enuOrigin: manifest.enuOrigin, leafZoom, centreHeights, freeBorder: args.freeBorder, lidar };
    const worker = await prepareWorker(args.noBundle);
    const errors: string[] = [];
    let stoppedForDisk = false;
    const diskLow = () => freeBytes(args.dir) < MIN_FREE_BYTES;
    const pass1: TileKey[] = [];
    if (args.freeBorder) {
        // The box's leaves and the ring round them: a ring tile's beds reach over its border into the box.
        const inBox = new Set(tiles.map(keyOf));
        const withStrokes = new Set(decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.roads.indexPath)))
            .filter(k => k.z === leafZoom).map(keyOf));
        const seen = new Set<string>();
        for (const k of tiles) {
            if (k.z !== leafZoom) {
                continue;
            }
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nb = { z: k.z, x: k.x + dx, y: k.y + dy };
                    const key = keyOf(nb);
                    if (!seen.has(key) && (inBox.has(key) || withStrokes.has(key))) {
                        seen.add(key);
                        pass1.push(nb);
                    }
                }
            }
        }
        console.log(`pass 1: beds of ${pass1.length} leaves (the box and the ring round it)`);
        const p1 = await runPass(worker, cfg, pass1, 1, t0, jobs, diskLow);
        errors.push(...p1.errors);
        stoppedForDisk ||= p1.stoppedForDisk;
        console.log('pass 2: grading');
    }
    const p2 = stoppedForDisk ? { results: [] as Array<GradeResult | undefined>, errors: [] as string[], stoppedForDisk: true }
        : await runPass(worker, cfg, tiles, 2, t0, jobs, diskLow);
    const results = p2.results;
    errors.push(...p2.errors);
    stoppedForDisk ||= p2.stoppedForDisk;
    for (const k of pass1) {
        const p = tileFile(args.dir, k, PASS1_EXT);
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    }

    // --- bed index and manifest ---------------------------------------------
    const indexPath = path.join(args.dir, 'index_beds.bin');
    const present = new Map<string, TileKey>();
    if (args.bbox !== undefined && fs.existsSync(indexPath)) {
        for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
            present.set(keyOf(k), k);
        }
    }
    for (const r of results) {
        // A tile graded before keeps its beds: without --bbox the index starts empty.
        if (!r || r.skipped === 'no-strokes') {
            continue;
        }
        const [z, x, y] = r.key.split('/').map(Number);
        if (fs.existsSync(tileFile(args.dir, { z, x, y }, '.pbd'))) {
            present.set(r.key, { z, x, y });
        } else {
            present.delete(r.key);
        }
    }
    const minZoom: number = manifest.roads.minZoom;
    fs.writeFileSync(indexPath, encodeTileIndex([...present.values()], minZoom, leafZoom));
    manifest.beds = { path: '{z}/{x}/{y}.pbd', indexPath: 'index_beds.bin', encoding: 'PBD1', transport: 'gzip', minZoom, maxZoom: leafZoom };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    // --- summary ----------------------------------------------------------------
    const byZ = new Map<number, { n: number; graded: number; already: number; added: number; walls: number; over: number; before: number; after: number; ms: number; beds: number; bedsW: number }>();
    for (const r of results) {
        if (!r) {
            continue;
        }
        const s = byZ.get(r.z) ?? { n: 0, graded: 0, already: 0, added: 0, walls: 0, underpins: 0, spikes: 0, over: 0, before: 0, after: 0, ms: 0, beds: 0, bedsW: 0 };
        byZ.set(r.z, s);
        s.n++;
        if (r.skipped === 'graded') {
            s.already++;
            continue;
        }
        if (r.skipped) {
            continue;
        }
        s.graded++;
        s.added += r.trianglesAdded ?? 0;
        s.walls += r.wallTriangles ?? 0;
        s.underpins += r.underpinTriangles ?? 0;
        s.spikes += r.spikesLowered ?? 0;
        s.over += r.overLimitM ?? 0;
        s.before += r.bytesBefore ?? 0;
        s.after += r.bytesAfter ?? 0;
        s.ms += r.ms ?? 0;
        s.beds += r.beds ?? 0;
        s.bedsW += r.bedsWritten ?? 0;
    }
    for (const [z, s] of [...byZ].sort((a, b) => a[0] - b[0])) {
        console.log(`z${z}: ${s.graded} graded (${s.already} already graded), +${s.added} land triangles, ${s.walls} wall triangles (${s.underpins} under bridges), ${s.spikes} spikes lowered, `
            + `over limit ${(s.over / 1000).toFixed(2)} km, beds ${s.beds} -> ${s.bedsW} written, `
            + `${(s.before / 1e6).toFixed(1)} -> ${(s.after / 1e6).toFixed(1)} MB, ${(s.ms / Math.max(1, s.graded)).toFixed(0)} ms/tile`);
    }
    for (const e of errors.slice(0, 20)) {
        console.error(`error: ${e}`);
    }
    if (stoppedForDisk) {
        console.error(`error: stopped with ${(freeBytes(args.dir) / 1e9).toFixed(1)} GB free; ${tiles.length - results.filter(Boolean).length} tiles not graded`);
    }
    console.log(`bed index ${present.size} tiles; ${((Date.now() - t0) / 60000).toFixed(1)} min; ${(freeBytes(args.dir) / 1e9).toFixed(1)} GB free`);
    if (errors.length > 0 || stoppedForDisk) {
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
