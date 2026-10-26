/**
 * tools/measure_lidar.py on the tile pool: the leaves it would measure, each
 * a job for a local worker or a satellite (tools/bake/lidarLeaf.ts). Each
 * worker keeps one `measure_lidar.py --serve` with its sources open, as the
 * script's own --jobs workers do; a satellite downloads the lidar over its
 * own connection and sends back only the leaf's store file.
 *
 * Usage:
 *   node --import tsx tools/measure_lidar_pool.ts --bbox w,s,e,n [options]
 *
 *     --jobs N         local workers (default 6, as measure_lidar.py; 0 with --satellites: them alone)
 *     --force          measure leaves already up to date
 *     --cache-gb N     each worker's download cache (default 2)
 *     --planet DIR     the planet pyramid (default assets/planet)
 *     --store DIR      the lidar store (default data/imports/lidar/store)
 *     --satellites     also hand leaves to satellite machines on the LAN
 *     --satellite-port N  their HTTP port (default 47811)
 *     --no-discovery   do not answer the satellites' broadcast
 *
 * Exit 1 when some leaves failed (an unreachable source): the rest are
 * measured, and a re-run measures the gap - as measure_lidar.py.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { TileKey } from './bake/index';
import { LidarLeafConfig, LidarLeafResult } from './bake/lidarLeaf';
import { DEFAULT_SATELLITE_PORT, TilePool } from './bake/tilePool';

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const WORKER = path.join(__dirname, 'bake', 'remoteJobWorker.ts');

interface Args {
    bbox?: string;
    jobs: number;
    force: boolean;
    cacheGb: number;
    planet: string;
    store: string;
    satellitePort?: number;
    noDiscovery: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { jobs: 6, force: false, cacheGb: 2, planet: 'assets/planet', store: 'data/imports/lidar/store', noDiscovery: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--bbox') a.bbox = next().replace(/^=/, '');
        else if (k.startsWith('--bbox=')) a.bbox = k.slice('--bbox='.length);
        else if (k === '--jobs') a.jobs = Math.max(0, Number(next()));
        else if (k === '--force') a.force = true;
        else if (k === '--cache-gb') a.cacheGb = Number(next());
        else if (k === '--planet') a.planet = next();
        else if (k === '--store') a.store = next();
        else if (k === '--satellites') a.satellitePort ??= DEFAULT_SATELLITE_PORT;
        else if (k === '--satellite-port') a.satellitePort = Number(next());
        else if (k === '--no-discovery') a.noDiscovery = true;
        else throw new Error(`unknown argument ${k}`);
    }
    if (!a.bbox) {
        throw new Error('--bbox w,s,e,n');
    }
    return a;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const env = { ...process.env, RFS_LIDAR_PLANET: args.planet, RFS_LIDAR_STORE: args.store };
    const list = spawnSync(PYTHON, ['-X', 'utf8', 'tools/measure_lidar.py', '--todo', `--bbox=${args.bbox}`, ...(args.force ? ['--force'] : [])],
        { encoding: 'utf8', env, maxBuffer: 1 << 28 });
    if (list.status !== 0) {
        throw new Error(`measure_lidar.py --todo failed: ${list.stderr}`);
    }
    const todo: TileKey[] = list.stdout.split('\n').filter(l => l.startsWith('[')).map(l => {
        const [x, y] = JSON.parse(l) as [number, number];
        return { z: 12, x, y };
    });
    console.log(`measure_lidar_pool: ${todo.length} leaves to measure${args.satellitePort ? ', satellites welcome' : ''}`);
    if (todo.length === 0) {
        return;
    }
    const cfg: LidarLeafConfig = {
        planet: path.resolve(args.planet), store: path.resolve(args.store), pytools: path.resolve('tools'), cacheGb: args.cacheGb,
    };
    const jobs = Math.max(args.satellitePort ? 0 : 1, Math.min(args.jobs, todo.length));
    const pool = new TilePool<LidarLeafResult>({
        local: { file: WORKER, execArgv: process.execArgv, jobs, workerData: { kind: 'lidarleaf', cfg } },
        cfg, kindOf: () => 'lidarleaf', roots: { planet: cfg.planet, lidar: cfg.store, pytools: cfg.pytools },
        satellites: args.satellitePort ? { port: args.satellitePort, discovery: !args.noDiscovery } : undefined,
        diskLow: () => false, label: () => 'leaves ', t0,
    });
    await pool.start();
    const { results, errors } = await pool.runPass(todo, 1);
    await pool.close();
    let stations = 0, measured = 0, ends = 0, endsMeasured = 0, mb = 0, bytes = 0;
    for (const r of results) {
        if (r) {
            stations += r.stations;
            measured += r.measured;
            ends += r.ends;
            endsMeasured += r.endsMeasured;
            mb += r.downloadedMB;
            bytes += r.bytes;
        }
    }
    for (const e of errors.slice(0, 20)) {
        console.error(`  leaf ${e}`);
    }
    console.log(`measure_lidar_pool: ${results.filter(Boolean).length} leaves in ${((Date.now() - t0) / 60000).toFixed(1)} min, `
        + `${errors.length} failed; stations ${measured}/${stations} measured; bridge ends ${endsMeasured}/${ends}; `
        + `store +${(bytes / 1e6).toFixed(1)} MB; ${mb.toFixed(0)} MB down`);
    process.exitCode = errors.length > 0 ? 1 : 0;
}

main().catch(err => {
    console.error(err);
    process.exit(2);
});
