/**
 * Bake every leaf's far land: lighter levels of its land mesh, drawn once the
 * leaf is far enough off that the simplification is under half a pixel (see
 * tools/bake/farLand.ts for the simplification, src/script/terrain/pfl.ts for
 * the sidecar). Runs after the grading, the last stage to change a leaf's
 * land; a leaf baked again afterwards has a sidecar that no longer matches
 * (the fingerprint in its header), which the runtime ignores until this runs
 * again for it.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_farland.ts [options]
 *
 *     --dir DIR        the mesh tree (default assets/terrain)
 *     --bbox w,s,e,n   only leaves in this box; the index is merged
 *     --jobs N         worker threads (default: CPUs - 1)
 *     --levels a,b     tolerances in metres (default 1,4)
 *     --resume         skip leaves whose sidecar is newer than their mesh
 *                      (an interrupted run); the index still covers them all
 *     --no-bundle      run the worker under tsx instead of an esbuild bundle
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { boundsOf } from './bake/coverTex';
import { LonLatBounds } from './bake/shoreline';
import { FAR_LAND_EXT, FarLandConfig, FarLandResult } from './bake/farLandTile';
import { tileFile } from './bake/railBedInputs';

const WORKER_SOURCE = path.join(__dirname, 'bake', 'farLandWorker.ts');
const WORKER_BUNDLE = path.join(__dirname, 'bake', '.build', 'farLandWorker.cjs');
/** Stop handing out tiles when the disk has less than this left, bytes. */
const MIN_FREE_BYTES = 2e9;
const INDEX_FILE = 'index_farland.bin';

interface Args {
    dir: string;
    bbox?: LonLatBounds;
    jobs?: number;
    levelsM: number[];
    noBundle: boolean;
    resume: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { dir: 'assets/terrain', levelsM: [1, 4], noBundle: false, resume: false };
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
        else if (k === '--levels') a.levelsM = next().split(',').map(Number);
        else if (k === '--no-bundle') a.noBundle = true;
        else if (k === '--resume') a.resume = true;
        else throw new Error(`unknown argument ${k}`);
    }
    if (a.levelsM.length === 0 || !a.levelsM.every(m => m > 0) || a.levelsM.some((m, i) => i > 0 && m <= a.levelsM[i - 1])) {
        throw new Error('--levels wants increasing positive tolerances');
    }
    return a;
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const overlaps = (a: LonLatBounds, b: LonLatBounds) =>
    !(a.east <= b.west || a.west >= b.east || a.north <= b.south || a.south >= b.north);

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
            console.warn(`warning: could not bundle the far land worker (${(err as Error).message}); running it under tsx`);
        }
    }
    return { file: WORKER_SOURCE, execArgv: process.execArgv };
}

function freeBytes(dir: string): number {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const manifestPath = path.join(args.dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const leafZoom: number = manifest.mesh.maxZoom;
    const tiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.mesh.indexPath)))
        .filter(k => k.z === leafZoom && (args.bbox === undefined || overlaps(boundsOf(k), args.bbox)));
    // Resuming: a sidecar written after its leaf's mesh was is that mesh's.
    const mtime = (f: string) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : -1);
    const todo = args.resume
        ? tiles.filter(k => mtime(tileFile(args.dir, k, FAR_LAND_EXT)) < mtime(tileFile(args.dir, k, '.ptm')))
        : tiles;
    const jobs = Math.max(1, Math.min(args.jobs ?? os.cpus().length - 1, todo.length));
    console.log(`bake_planet_farland: ${todo.length} leaves${todo.length < tiles.length ? ` of ${tiles.length} (resumed)` : ''}`
        + `${args.bbox ? ' (scoped)' : ''}, levels ${args.levelsM.join(', ')} m, `
        + `${jobs} workers, ${(freeBytes(args.dir) / 1e9).toFixed(1)} GB free`);
    const cfg: FarLandConfig = { dir: args.dir, enuOrigin: manifest.enuOrigin, levelsM: args.levelsM };
    const worker = await prepareWorker(args.noBundle);

    const results: Array<FarLandResult | undefined> = new Array(todo.length);
    const errors: string[] = [];
    let stoppedForDisk = false;
    await new Promise<void>((resolve, reject) => {
        if (todo.length === 0) {
            resolve();
            return;
        }
        let next = 0, done = 0, running = 0, lastLine = 0;
        const workers: Worker[] = [];
        const dispatch = (w: Worker): boolean => {
            if (next >= todo.length || stoppedForDisk) {
                return false;
            }
            if (next % 50 === 0 && freeBytes(args.dir) < MIN_FREE_BYTES) {
                stoppedForDisk = true;
                return false;
            }
            const idx = next++;
            running++;
            w.postMessage({ idx, key: todo[idx] });
            return true;
        };
        const finish = () => {
            for (const w of workers) {
                w.postMessage(null);
            }
            resolve();
        };
        for (let i = 0; i < jobs; i++) {
            const w = new Worker(worker.file, { execArgv: worker.execArgv, workerData: cfg });
            workers.push(w);
            w.on('message', (msg: { idx: number; result: FarLandResult | { error: string } }) => {
                running--;
                done++;
                if ('error' in msg.result) {
                    errors.push(msg.result.error);
                } else {
                    results[msg.idx] = msg.result;
                }
                if (Date.now() - lastLine > 1000 || done === todo.length) {
                    const el = (Date.now() - t0) / 1000;
                    process.stdout.write(`\r  ${done}/${todo.length} (${((done / todo.length) * 100).toFixed(1)}%)  ${(el / 60).toFixed(1)} min   `);
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

    // The index: every leaf with a sidecar, merged with the rest when scoped.
    // A leaf in the box that is no longer in the mesh index went with a
    // deleted area: its sidecar goes too, or the index would keep asking for it.
    const indexPath = path.join(args.dir, INDEX_FILE);
    const present = new Map<string, TileKey>();
    let dropped = 0;
    if (args.bbox !== undefined && fs.existsSync(indexPath)) {
        const leaves = new Set(tiles.map(keyOf));
        for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
            if (overlaps(boundsOf(k), args.bbox) && !leaves.has(keyOf(k))) {
                const stale = tileFile(args.dir, k, FAR_LAND_EXT);
                if (fs.existsSync(stale)) {
                    fs.unlinkSync(stale);
                }
                dropped++;
                continue;
            }
            present.set(keyOf(k), k);
        }
    }
    for (let i = 0; i < tiles.length; i++) {
        const k = tiles[i];
        if (fs.existsSync(tileFile(args.dir, k, FAR_LAND_EXT))) {
            present.set(keyOf(k), k);
        } else {
            present.delete(keyOf(k));
        }
    }
    fs.writeFileSync(indexPath, encodeTileIndex([...present.values()], leafZoom, leafZoom));
    manifest.farLand = {
        path: `{z}/{x}/{y}${FAR_LAND_EXT}`, indexPath: INDEX_FILE, encoding: 'PFL1', transport: 'gzip',
        zoom: leafZoom, levelsM: args.levelsM,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let written = 0, nearTris = 0, coarseTris = 0, bytes = 0, noSaving = 0;
    const firstLevel = args.levelsM.map(() => 0);
    for (const r of results) {
        if (!r) {
            continue;
        }
        if (r.skipped === 'no-saving') {
            noSaving++;
        }
        if (!r.levelTris) {
            continue;
        }
        written++;
        nearTris += r.nearTris ?? 0;
        coarseTris += r.levelTris[r.levelTris.length - 1];
        bytes += r.bytes ?? 0;
        firstLevel[0] += r.levelTris[0];
    }
    if (dropped > 0) {
        console.log(`${dropped} sidecars of leaves no longer in the pyramid removed`);
    }
    console.log(`${written} sidecars, ${(bytes / 1e6).toFixed(1)} MB; ${noSaving} leaves not worth one; `
        + `land triangles ${nearTris} -> finest level ${firstLevel[0]} (${((100 * firstLevel[0]) / Math.max(1, nearTris)).toFixed(0)}%), `
        + `coarsest ${coarseTris} (${((100 * coarseTris) / Math.max(1, nearTris)).toFixed(0)}%); `
        + `${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (stoppedForDisk) {
        console.log('STOPPED EARLY: under 2 GB free on the disk');
    }
    for (const e of errors.slice(0, 10)) {
        console.error(e);
    }
    if (errors.length > 0) {
        console.error(`${errors.length} leaves failed`);
        process.exitCode = 1;
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
