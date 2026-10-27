/**
 * A per-leaf Python stage on the tile pool (tools/bake/pyLeaf.ts): the leaves
 * its script would measure, each a job for a local worker or a satellite.
 * Each worker keeps one `<script> --serve` with its sources open, as the
 * script's own --jobs workers do; a satellite downloads over its own
 * connection and sends back only the leaf's store file.
 *
 *   lidar  tools/measure_lidar.py: the graded lines and bridge ends against
 *          open lidar (data/imports/lidar/store)
 *   roofs  tools/measure_buildings.py: roof colours off orthophotos
 *          (data/imports/buildings/store)
 *
 * Usage:
 *   node --import tsx tools/py_leaf_pool.ts --stage lidar|roofs --bbox w,s,e,n [options]
 *
 *     --jobs N         local workers (default 6, as the scripts; 0 with --satellites: them alone)
 *     --force          measure leaves already up to date
 *     --planet DIR     the planet pyramid (default assets/planet)
 *     --store DIR      the stage's store (default as above)
 *     --satellites     also hand leaves to satellite machines on the LAN
 *     --satellite-port N  their HTTP port (default 47811)
 *     --no-discovery   do not answer the satellites' broadcast
 *
 * $PYTHON is the Python here (one with the scripts' packages). Exit 1 when
 * some leaves failed (an unreachable source): the rest are measured, and a
 * re-run measures the gap - as the scripts do.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { TileKey } from './bake/index';
import { PY_STAGES, PyLeafConfig, PyLeafKind, PyLeafResult } from './bake/pyLeaf';
import { DEFAULT_SATELLITE_PORT, TilePool } from './bake/tilePool';

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const WORKER = path.join(__dirname, 'bake', 'remoteJobWorker.ts');
const KINDS: Record<string, PyLeafKind> = { lidar: 'lidarleaf', roofs: 'roofleaf' };

interface Args {
    kind?: PyLeafKind;
    bbox?: string;
    jobs: number;
    force: boolean;
    planet: string;
    store?: string;
    satellitePort?: number;
    noDiscovery: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { jobs: 6, force: false, planet: 'assets/planet', noDiscovery: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--stage') {
            const s = next();
            a.kind = KINDS[s];
            if (!a.kind) {
                throw new Error(`--stage ${Object.keys(KINDS).join('|')}, not ${s}`);
            }
        } else if (k === '--bbox') a.bbox = next();
        else if (k.startsWith('--bbox=')) a.bbox = k.slice('--bbox='.length);
        else if (k === '--jobs') a.jobs = Math.max(0, Number(next()));
        else if (k === '--force') a.force = true;
        else if (k === '--planet') a.planet = next();
        else if (k === '--store') a.store = next();
        else if (k === '--satellites') a.satellitePort ??= DEFAULT_SATELLITE_PORT;
        else if (k === '--satellite-port') a.satellitePort = Number(next());
        else if (k === '--no-discovery') a.noDiscovery = true;
        else throw new Error(`unknown argument ${k}`);
    }
    if (!a.kind || !a.bbox) {
        throw new Error('--stage lidar|roofs --bbox w,s,e,n');
    }
    return a;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const kind = args.kind!;
    const stage = PY_STAGES[kind];
    const t0 = Date.now();
    const store = args.store ?? stage.defaultStore;
    const env = { ...process.env, [stage.planetEnv]: args.planet, [stage.storeEnv]: store };
    const list = spawnSync(PYTHON, ['-X', 'utf8', `tools/${stage.script}`, '--todo', `--bbox=${args.bbox}`, ...(args.force ? ['--force'] : [])],
        { encoding: 'utf8', env, maxBuffer: 1 << 28 });
    if (list.status !== 0) {
        throw new Error(`${stage.script} --todo failed: ${list.stderr}`);
    }
    const todo: TileKey[] = list.stdout.split('\n').filter(l => l.startsWith('[')).map(l => {
        const [x, y] = JSON.parse(l) as [number, number];
        return { z: 12, x, y };
    });
    const tag = `py_leaf_pool ${stage.script}`;
    console.log(`${tag}: ${todo.length} leaves to measure${args.satellitePort ? ', satellites welcome' : ''}`);
    if (todo.length === 0) {
        return;
    }
    const cfg: PyLeafConfig = { planet: path.resolve(args.planet), store: path.resolve(store), pytools: path.resolve('tools') };
    const jobs = Math.max(args.satellitePort ? 0 : 1, Math.min(args.jobs, todo.length));
    const pool = new TilePool<PyLeafResult>({
        local: { file: WORKER, execArgv: process.execArgv, jobs, workerData: { kind, cfg } },
        cfg, kindOf: () => kind, roots: { planet: cfg.planet, [stage.storeRoot]: cfg.store, pytools: cfg.pytools },
        satellites: args.satellitePort ? { port: args.satellitePort, discovery: !args.noDiscovery } : undefined,
        diskLow: () => false, label: () => 'leaves ', t0,
    });
    await pool.start();
    const first = await pool.runPass(todo, 1);
    await pool.close();
    const results = first.results;
    let errors = first.errors;
    // A leaf that failed - on a satellite whose network cannot reach the
    // source, say - is measured here once more before it counts as failed.
    const again = todo.map((k, i) => ({ k, i })).filter(({ i }) => !results[i]);
    if (again.length > 0 && args.satellitePort) {
        console.log(`${tag}: ${again.length} leaves failed, measuring them here`);
        const local = new TilePool<PyLeafResult>({
            local: { file: WORKER, execArgv: process.execArgv, jobs: Math.max(1, Math.min(args.jobs, again.length)), workerData: { kind, cfg } },
            cfg, kindOf: () => kind, roots: {}, diskLow: () => false, label: () => 'again ', t0,
        });
        await local.start();
        const second = await local.runPass(again.map(a => a.k), 1);
        await local.close();
        again.forEach(({ i }, j) => {
            results[i] = second.results[j];
        });
        errors = second.errors;
    }
    // Every number the script reports, summed: stations and bridge ends, roofs and blocks, downloads.
    const sums: Record<string, number> = {};
    for (const r of results) {
        for (const [k, v] of Object.entries(r ?? {})) {
            if (typeof v === 'number' && k !== 'seconds') {
                sums[k] = (sums[k] ?? 0) + v;
            }
        }
    }
    for (const e of errors.slice(0, 20)) {
        console.error(`  leaf ${e}`);
    }
    const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
    console.log(`${tag}: ${results.filter(Boolean).length} leaves in ${((Date.now() - t0) / 60000).toFixed(1)} min, `
        + `${errors.length} failed; ${Object.entries(sums).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`);
    process.exitCode = errors.length > 0 ? 1 : 0;
}

main().catch(err => {
    console.error(err);
    process.exit(2);
});
