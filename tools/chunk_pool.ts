/**
 * One per-chunk Python stage of an import over all its chunks on the tile
 * pool (tools/bake/pyChunk.ts): each land chunk's leaf tiles on a satellite or
 * here, then the stage's merge here, chunk by chunk in import order - the
 * coarser tiles from the leaves on disk and the manifest block - which is
 * what the import's own chunk-after-chunk run leaves behind.
 *
 *   node --import tsx tools/chunk_pool.ts --stage coast|roads|buildings|cover
 *       --bbox w,s,e,n --pbf FILE [options]
 *
 *     --planet DIR     the planet pyramid (default assets/planet)
 *     --chunk-deg D    largest chunk side (default 2, as areaImport.ts)
 *     --jobs N         chunks baked here at once (default 1: a coast chunk can take 10 GB)
 *     --stage-jobs N   worker processes a stage's own pool uses here (default: CPUs - 1,
 *                      at most one per 3 GB of memory; JOBS in the environment sets it too)
 *     --satellites     hand chunks to satellite machines on the LAN too; one
 *                      chunk at a time each, with every thread they have
 *     --satellite-port N  their HTTP port (default 47811)
 *     --no-discovery   do not answer the satellites' broadcast
 *
 * A land chunk is one the pyramid's index has a leaf in (the import drops an
 * all-sea chunk at its heights). A chunk a satellite could not bake - a lake
 * reaching past the heights its job brought, a lost source - is baked here
 * before the merge. $PYTHON is the Python here.
 */

import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chunkBbox, snapBboxToTiles } from './areaImport';
import { decodeTileIndex, TileKey } from './bake/index';
import { CHUNK_STAGES, ChunkStage, PyChunkConfig, PyChunkResult, mergeArgs, pyChunk } from './bake/pyChunk';
import { DEFAULT_SATELLITE_PORT, TilePool } from './bake/tilePool';
import { GB_PER_WORKER, localJobs } from './bake/localJobs';

const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const WORKER = path.join(__dirname, 'bake', 'remoteJobWorker.ts');

interface Args {
    stage?: ChunkStage;
    bbox?: [number, number, number, number];
    pbf?: string;
    planet: string;
    chunkDeg: number;
    jobs: number;
    stageJobs: number;
    satellitePort?: number;
    noDiscovery: boolean;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { planet: 'assets/planet', chunkDeg: 2, jobs: 1, stageJobs: localJobs(GB_PER_WORKER.chunk), noDiscovery: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        const [flag, inline] = k.includes('=') ? [k.slice(0, k.indexOf('=')), k.slice(k.indexOf('=') + 1)] : [k, undefined];
        const value = () => inline ?? next();
        if (flag === '--stage') {
            const s = value();
            if (!(s in CHUNK_STAGES)) {
                throw new Error(`--stage ${Object.keys(CHUNK_STAGES).join('|')}, not ${s}`);
            }
            a.stage = s as ChunkStage;
        } else if (flag === '--bbox') a.bbox = value().split(',').map(Number) as Args['bbox'];
        else if (flag === '--pbf') a.pbf = value();
        else if (flag === '--planet') a.planet = value();
        else if (flag === '--chunk-deg') a.chunkDeg = Number(value());
        else if (flag === '--jobs') a.jobs = Math.max(0, Number(value()));
        else if (flag === '--stage-jobs') a.stageJobs = Math.max(1, Number(value()));
        else if (flag === '--satellites') a.satellitePort ??= DEFAULT_SATELLITE_PORT;
        else if (flag === '--satellite-port') a.satellitePort = Number(value());
        else if (flag === '--no-discovery') a.noDiscovery = true;
        else throw new Error(`unknown argument ${k}`);
    }
    if (!a.stage || !a.bbox || a.bbox.length !== 4 || !a.bbox.every(Number.isFinite) || !a.pbf) {
        throw new Error('--stage coast|roads|buildings|cover --bbox w,s,e,n --pbf FILE');
    }
    return a;
}

function sha1File(p: string): string {
    const h = crypto.createHash('sha1');
    const fd = fs.openSync(p, 'r');
    try {
        const buf = Buffer.alloc(1 << 20);
        for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
            h.update(buf.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return h.digest('hex');
}

/** The chunks with a leaf in the pyramid's index, in import order. */
function landChunks(planet: string, chunks: Array<[number, number, number, number]>): Array<[number, number, number, number]> {
    const manifest = JSON.parse(fs.readFileSync(path.join(planet, 'manifest.json'), 'utf8')) as { indexPath?: string; maxZoom?: number };
    const leaf = manifest.maxZoom ?? 12;
    const span = 180 / (1 << leaf);
    const leaves = decodeTileIndex(fs.readFileSync(path.join(planet, manifest.indexPath ?? 'index.bin'))).filter(t => t.z === leaf);
    return chunks.filter(([w, s, e, n]) => leaves.some(t => {
        const west = -180 + t.x * span, north = 90 - t.y * span;
        return west < e && west + span > w && north > s && north - span < n;
    }));
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const stage = args.stage!;
    const t0 = Date.now();
    const planet = path.resolve(args.planet);
    const chunks = landChunks(planet, chunkBbox(snapBboxToTiles(args.bbox!), args.chunkDeg));
    const pbf = path.resolve(args.pbf!);
    console.log(`chunk_pool ${stage}: ${chunks.length} land chunks${args.satellitePort ? ', satellites welcome' : ''}`);
    const cfg: PyChunkConfig = {
        stage, chunks, planet, pbf, pbfSha: args.satellitePort ? sha1File(pbf) : '', pytools: path.resolve('tools'),
        localJobs: args.stageJobs,
    };
    const keys: TileKey[] = chunks.map((_, i) => ({ z: 0, x: i, y: 0 }));
    let results: Array<PyChunkResult | undefined> = [];
    if (chunks.length > 0) {
        const jobs = Math.max(args.satellitePort ? 0 : 1, Math.min(args.jobs, chunks.length));
        const pool = new TilePool<PyChunkResult>({
            local: { file: WORKER, execArgv: process.execArgv, jobs, workerData: { kind: 'pychunk', cfg } },
            cfg, kindOf: () => 'pychunk', roots: { planet, pbf: path.dirname(pbf), pytools: cfg.pytools },
            satellites: args.satellitePort ? { port: args.satellitePort, discovery: !args.noDiscovery } : undefined,
            diskLow: () => false, label: () => 'chunks ', t0, perSatellite: 1,
        });
        await pool.start();
        const pass = await pool.runPass(keys, 1);
        await pool.close();
        results = pass.results;
        for (const e of pass.errors) {
            console.log(`  ${e.split('\n')[0].slice(0, 300)}`);
        }
    }
    // A chunk no satellite could bake is baked here, against the real pyramid.
    for (let i = 0; i < chunks.length; i++) {
        if (!results[i]) {
            console.log(`chunk ${i + 1}/${chunks.length} ${chunks[i].join(',')}: baking it here`);
            results[i] = await pyChunk(cfg, keys[i], '');
        }
    }
    // The merge, in import order: what each chunk's own full run would have written above its leaves.
    for (let i = 0; i < chunks.length; i++) {
        for (const [script, ...rest] of mergeArgs(stage, planet, chunks[i].join(','))) {
            const r = spawnSync(PYTHON, ['-X', 'utf8', `tools/${script}`, ...rest], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
            if (r.status !== 0) {
                process.stdout.write(r.stdout ?? '');
                throw new Error(`${script} ${rest.join(' ')} exited ${r.status}`);
            }
        }
    }
    console.log(`chunk_pool ${stage}: ${chunks.length} chunks baked and merged in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
