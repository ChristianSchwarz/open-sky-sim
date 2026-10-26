/**
 * The per-chunk Python stages of an import on the tile pool (tools/chunk_pool.ts):
 * one stage for one chunk, its leaf tiles only, run where the job lands - here
 * against the real pyramid, on a satellite against a job directory holding the
 * chunk's slice of it. What a stage builds above the leaves, and its manifest
 * block, are this machine's: chunk_pool.ts runs the stage's merge after every
 * chunk is back (MERGE_ARGS).
 *
 *   coast      bake_osm_coast.py --leaves-only: .lwm, .lvr
 *   roads      bake_osm_roads.py --min-zoom 12: .rvr, .rbr
 *   buildings  bake_osm_buildings.py --leaves-only: .bvr
 *   cover      fetch_cover_sources.py, then bake_planet_cover.py --leaves-only: .plc
 *
 * A satellite's job brings the manifest and index, the chunk's leaf heights
 * (and a margin of them: a lake across the chunk's edge is sampled whole), the
 * stage's leaf files already there (so a removal is told from a tile never
 * touched), the OSM extract and the scripts. The height sampler there raises
 * on a tile the index lists but the job did not bring (osm_common.py
 * DemSampler, RFS_STRICT_INPUTS), and chunk_pool.ts bakes that chunk here.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stableScripts } from './pyLeaf';
import { decodeTileIndex } from './index';
import { TileKey } from '../../src/script/terrain/tiling';

export type ChunkStage = 'coast' | 'roads' | 'buildings' | 'cover';

export interface ChunkStageSpec {
    /** The scripts it runs, in tools/: the last is the bake. */
    scripts: string[];
    /** The leaf files it writes or removes. */
    outputs: string[];
    /** Whether it needs the chunk's leaf heights on disk (every one does: they say which leaves exist). */
    heights: boolean;
}

export const CHUNK_STAGES: Record<ChunkStage, ChunkStageSpec> = {
    coast: { scripts: ['bake_osm_coast.py'], outputs: ['.lwm', '.lvr'], heights: true },
    roads: { scripts: ['bake_osm_roads.py'], outputs: ['.rvr', '.rbr'], heights: true },
    buildings: { scripts: ['bake_osm_buildings.py'], outputs: ['.bvr'], heights: true },
    cover: { scripts: ['fetch_cover_sources.py', 'bake_planet_cover.py'], outputs: ['.plc'], heights: true },
};

/** The stage's merge on this machine, per land chunk in chunk order (chunk_pool.ts). */
export function mergeArgs(stage: ChunkStage, planet: string, bbox: string): string[][] {
    switch (stage) {
        case 'coast': return [['bake_osm_coast.py', '--out', planet, '--rebuild-ancestors', '--mark-coverage', `--bbox=${bbox}`]];
        case 'roads': return [['bake_osm_roads.py', '--out', planet, '--rebuild-ancestors', '--mark-coverage', `--bbox=${bbox}`]];
        case 'buildings': return [['bake_osm_buildings.py', '--out', planet, '--mark-coverage', `--bbox=${bbox}`]];
        case 'cover': return [['bake_planet_cover.py', '--src', planet, '--ancestors-only', `--bbox=${bbox}`]];
    }
}

export interface PyChunkConfig {
    stage: ChunkStage;
    /** Every chunk of the import, whole leaf tiles; a job's key x is its index. */
    chunks: Array<[number, number, number, number]>;
    /** The planet pyramid. */
    planet: string;
    /** The OSM extract, and its content hash (a satellite keeps one copy per extract). */
    pbf: string;
    pbfSha: string;
    /** The directory holding the scripts and the modules they import. */
    pytools: string;
    /** Worker processes a stage's own pool uses here; a satellite gives it all its threads. */
    localJobs: number;
}

export interface PyChunkResult {
    key: string;
    seconds: number;
    /** The end of what the scripts printed. */
    tail: string;
}

const bboxText = (b: readonly number[]) => b.join(',');

const LEAF_ZOOM = 12;
/** Leaf heights brought beyond the chunk's edge, degrees: the shore of a lake across it. */
const HEIGHT_MARGIN_DEG = 0.1;

/** Leaf columns and rows of a box, as tile_range_for_bounds has them (whole tiles, edges exclusive). */
function leafRange(b: readonly number[]): [number, number, number, number] {
    const span = 180 / (1 << LEAF_ZOOM);
    return [
        Math.floor((b[0] + 180) / span), Math.floor((90 - b[3]) / span),
        Math.ceil((b[2] + 180) / span) - 1, Math.ceil((90 - b[1]) / span) - 1,
    ];
}

const indexes = new Map<string, Set<string>>();

/** The leaves the pyramid's index lists, as 'x/y'. */
function indexedLeaves(planet: string): Set<string> {
    let set = indexes.get(planet);
    if (!set) {
        const manifest = JSON.parse(fs.readFileSync(path.join(planet, 'manifest.json'), 'utf8')) as { indexPath?: string };
        set = new Set(decodeTileIndex(fs.readFileSync(path.join(planet, manifest.indexPath ?? 'index.bin')))
            .filter(t => t.z === LEAF_ZOOM).map(t => `${t.x}/${t.y}`));
        indexes.set(planet, set);
    }
    return set;
}

/** What a satellite needs for a chunk of `cfg.stage`, as root-relative paths (see the header). */
export function chunkInputs(cfg: PyChunkConfig, k: TileKey, pyInputs: (entry: string) => string[]): string[] {
    const spec = CHUNK_STAGES[cfg.stage];
    const chunk = cfg.chunks[k.x];
    const manifest = JSON.parse(fs.readFileSync(path.join(cfg.planet, 'manifest.json'), 'utf8')) as { indexPath?: string };
    const out = ['planet/manifest.json', `planet/${manifest.indexPath ?? 'index.bin'}`, `pbf/${path.basename(cfg.pbf)}`];
    for (const s of spec.scripts) {
        out.push(...pyInputs(s));
    }
    const indexed = indexedLeaves(cfg.planet);
    if (spec.heights) {
        const m = HEIGHT_MARGIN_DEG;
        const [x0, y0, x1, y1] = leafRange([chunk[0] - m, chunk[1] - m, chunk[2] + m, chunk[3] + m]);
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (indexed.has(`${x}/${y}`)) {
                    out.push(`planet/${LEAF_ZOOM}/${x}/${y}.pdm`);
                }
            }
        }
    }
    // The stage's leaf files already there: a removal is an output.
    for (const rel of chunkOutputs(cfg, k)) {
        if (fs.existsSync(path.join(cfg.planet, ...rel.slice('planet/'.length).split('/')))) {
            out.push(rel);
        }
    }
    return [...new Set(out)];
}

/** Every leaf file the chunk's stage may write or remove. */
export function chunkOutputs(cfg: PyChunkConfig, k: TileKey): string[] {
    const [x0, y0, x1, y1] = leafRange(cfg.chunks[k.x]);
    const out: string[] = [];
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            for (const ext of CHUNK_STAGES[cfg.stage].outputs) {
                out.push(`planet/${LEAF_ZOOM}/${x}/${y}${ext}`);
            }
        }
    }
    return out;
}

/** The arguments of each script of `stage` for one chunk. */
function stageArgs(stage: ChunkStage, planet: string, bbox: string, pbf: string, coverDir: string, jobs: number): string[][] {
    switch (stage) {
        case 'coast': return [['bake_osm_coast.py', '--out', planet, `--bbox=${bbox}`, '--osm-landuse', `--pbf=${pbf}`,
            '--allow-tiny-land', '--leaves-only', '--jobs', String(jobs)]];
        case 'roads': return [['bake_osm_roads.py', '--out', planet, `--bbox=${bbox}`, `--pbf=${pbf}`, '--min-zoom', '12']];
        case 'buildings': return [['bake_osm_buildings.py', '--out', planet, `--bbox=${bbox}`, `--pbf=${pbf}`, '--leaves-only']];
        case 'cover': return [
            ['fetch_cover_sources.py', `--bbox=${bbox}`, `--out=${coverDir}`],
            ['bake_planet_cover.py', '--src', planet, `--bbox=${bbox}`, '--osm-landuse', `--pbf=${pbf}`,
                `--sources=${path.join(coverDir, 'sources.json')}`, '--leaves-only', '--jobs', String(jobs)],
        ];
    }
}

/** Run one script to its end; its output's tail, or an error carrying it. */
function runScript(python: string, isolated: boolean, script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
        const flags = [...(isolated ? ['-E', '-s'] : []), '-u', '-X', 'utf8'];
        const child = spawn(python, [...flags, script, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true });
        let tail = '';
        const keep = (d: Buffer) => {
            tail = (tail + d.toString('utf8')).slice(-6000);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve(tail);
            } else {
                reject(new Error(`${path.basename(script)} exited ${code}: ${tail.slice(-1500)}`));
            }
        });
    });
}

/** The extract at a path that stays the same from job to job, so the scripts' OSM cache (keyed on it) holds. */
function stablePbf(jobPbf: string, sha: string): string {
    const dir = path.join(process.env.RFS_SAT_CACHE ?? os.tmpdir(), 'pbf');
    const p = path.join(dir, `${sha.slice(0, 16)}.osm.pbf`);
    if (!fs.existsSync(p)) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(jobPbf, `${p}.tmp`);
        fs.renameSync(`${p}.tmp`, p);
    }
    return p;
}

export async function pyChunk(cfg: PyChunkConfig, k: TileKey, jobDir: string): Promise<PyChunkResult> {
    const t0 = Date.now();
    const onSatellite = jobDir !== '';
    const bbox = bboxText(cfg.chunks[k.x]);
    const planet = path.resolve(jobDir, cfg.planet);
    const scripts = onSatellite ? stableScripts(path.join(jobDir, cfg.pytools)) : cfg.pytools;
    const pbf = onSatellite ? stablePbf(path.join(jobDir, cfg.pbf), cfg.pbfSha) : cfg.pbf;
    const python = process.env.RFS_SAT_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    // A satellite's scripts run in a working directory that outlives the job, so
    // their OSM cache (data/osm-cache under it) serves its next chunk and stage.
    const cwd = onSatellite ? path.join(process.env.RFS_SAT_CACHE ?? os.tmpdir(), 'pywork') : process.cwd();
    fs.mkdirSync(cwd, { recursive: true });
    const coverDir = onSatellite ? path.join(jobDir, 'cover-sources') : path.join('data', 'cover', 'chunks', bbox.replace(/,/g, '_'));
    const jobs = onSatellite ? Number(process.env.RFS_SAT_THREADS ?? os.cpus().length - 1) : cfg.localJobs;
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', ...(onSatellite ? { RFS_STRICT_INPUTS: '1' } : {}) };
    let tail = '';
    for (const [script, ...args] of stageArgs(cfg.stage, planet, bbox, pbf, coverDir, Math.max(1, jobs))) {
        tail = await runScript(python, process.env.RFS_SAT_PYTHON !== undefined, path.resolve(scripts, script), args, cwd, env);
    }
    return { key: `chunk ${k.x}`, seconds: (Date.now() - t0) / 1000, tail: tail.slice(-600) };
}
