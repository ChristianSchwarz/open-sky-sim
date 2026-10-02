// In-app terrain area import: the server half.
//
//   GET  /api/osm/:z/:x/:y   OpenStreetMap raster tile, cached on disk
//   GET  /api/areas          the areas the baked pyramid already holds
//   POST /api/import-area    start a bake for a bbox; returns a job id
//   POST /api/delete-area    remove a baked area; returns a job id
//   GET  /api/import-area/:id  server-sent progress for that job (either kind)
//
// The bake is the same command line documented in tools/README.md, run stage by
// stage with one bbox. A cached re-import takes a couple of minutes and a cold
// one waits on Overpass and the satellite imagery on top, which is why this
// streams rather than making the browser hold a request open.

import { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';

const PROJECT_ROOT = path.dirname(__dirname);
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const IMPORTS_DIR = path.join(PROJECT_ROOT, 'data', 'imports');
const OSM_CACHE = path.join(PROJECT_ROOT, 'tools', 'osm-cache');
const TERRAIN_MANIFEST = path.join(PROJECT_ROOT, 'assets', 'terrain', 'manifest.json');

// openstreetmap.org asks for a real identifying User-Agent and no bulk
// downloading. An area picker browses a few hundred tiles at most and every one
// is cached on disk after the first fetch, which keeps this well inside the
// tile usage policy — but point OSM_TILE_URL at your own or a commercial tile
// server if this ever gets used in anger.
const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_USER_AGENT = 'retroflightsim/0.0.1 (+https://github.com/ruben3d/retroflightsim; local dev area picker)';

// Deep zoom is for looking at streets, and an area is picked at the scale of an
// island or a valley. Capping it also caps how much of OSM this can ever pull.
const OSM_MAX_ZOOM = 12;

/** Matches --max-span in tools/fetch_planet_dem.py. */
const MAX_SPAN_DEG = 6;

/**
 * Zoom whose tile edges an import is snapped to.
 *
 * The finest the pyramid goes. `fetch_planet_dem.py` derives max zoom from the
 * source pixel and its 1 arcsec default lands on 12, which is also what the
 * tracked Canaries DEM bakes to.
 */
const SNAP_ZOOM = 12;

/** Largest side, in degrees, of one chunk of an import (see chunkBbox). */
const CHUNK_SPAN_DEG = 2;

/**
 * Grow a hand-drawn box outwards onto whole tile edges.
 *
 * Every stage writes whole tiles. A stage whose sources stop halfway across one
 * still writes all of it, and what it writes over the half it has no data for
 * is not "nothing" — it is open ocean for the coast bake and unknown cover for
 * the cover bake, on top of whatever a neighbouring area baked there.
 *
 * That is the seam between two overlapping imports. Measured on two Crimea
 * areas: the second box's southern edge fell a third of the way down tile row
 * 1019 and the coast bake rewrote the whole row, the lower two thirds as sea —
 * a 3.5 km strip of Black Sea straight across the peninsula.
 *
 * `fetch_planet_dem.py` already snaps its own box for the same reason. Doing it
 * here as well is what keeps every stage on the same box, which is the property
 * the whole scoped-bake design rests on.
 */
export function snapBboxToTiles(
    [west, south, east, north]: [number, number, number, number],
    zoom = SNAP_ZOOM,
): [number, number, number, number] {
    const span = 180 / (1 << zoom);
    // A box already on an edge must not grow: floating point puts a whole
    // number a hair either side of itself, and one ceil() the wrong way spreads
    // every re-bake of that area a tile wider.
    const lo = (v: number) => Math.floor(v + 1e-9);
    const hi = (v: number) => Math.ceil(v - 1e-9);
    return [
        lo((west + 180) / span) * span - 180,
        90 - hi((90 - south) / span) * span,
        hi((east + 180) / span) * span - 180,
        90 - lo((90 - north) / span) * span,
    ];
}

export interface Area {
    name: string;
    west: number;
    south: number;
    east: number;
    north: number;
}

type JobState = 'running' | 'done' | 'failed';

interface Job {
    id: string;
    name: string;
    bbox: [number, number, number, number];
    /** Local `.osm.pbf` extract to read instead of Overpass — see areaImport.ts's `--pbf`. */
    pbf?: string;
    state: JobState;
    log: string[];
    step: string;
    stepIndex: number;
    stepCount: number;
    /** Progress within the current step, 0..100, when the tool reports it. */
    percent: number;
    error?: string;
    /**
     * Steps that finished with something left undone but nothing broken -
     * an airfield bake that skipped an area because Overpass was down. The
     * job still counts as done; these are repeated in its closing line so
     * the user knows a re-run is owed.
     */
    warnings: string[];
    subscribers: Set<Response>;
    /** Wall clock of the last frame sent to subscribers; drives the heartbeat below. */
    lastEmit: number;
    heartbeat?: NodeJS.Timeout;
    /** Every tool process the job has running, so a failure can stop the rest. */
    children?: Set<ChildProcess>;
}

/**
 * How long a stage can stay silent before the browser gets a frame anyway.
 *
 * Some stages (Overpass, the imagery fetch) go quiet for a while between their
 * own progress lines. Nothing here times the connection out, but a UI with no
 * update for a long stretch reads as hung rather than working — so every job
 * gets a frame at least this often even when nothing changed.
 */
const HEARTBEAT_MS = 5000;

const jobs = new Map<string, Job>();

function slug(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// --- OSM tiles -------------------------------------------------------------

export async function osmTile(req: Request, res: Response): Promise<void> {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)
        || z < 0 || z > OSM_MAX_ZOOM) {
        res.status(400).send('bad tile');
        return;
    }
    const span = 1 << z;
    if (x < 0 || x >= span || y < 0 || y >= span) {
        res.status(400).send('tile out of range');
        return;
    }

    const cached = path.join(OSM_CACHE, String(z), String(x), `${y}.png`);
    if (fs.existsSync(cached)) {
        res.type('png').send(fs.readFileSync(cached));
        return;
    }

    const url = OSM_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    try {
        const upstream = await fetch(url, { headers: { 'User-Agent': OSM_USER_AGENT } });
        if (!upstream.ok) {
            res.status(upstream.status).send('tile fetch failed');
            return;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.writeFileSync(cached, buf);
        res.type('png').send(buf);
    } catch (err) {
        res.status(502).send(`tile fetch failed: ${(err as Error).message}`);
    }
}

// --- areas already baked ---------------------------------------------------

export function readAreas(): { areas: Area[]; coverage?: Area } {
    if (!fs.existsSync(TERRAIN_MANIFEST)) {
        return { areas: [] };
    }
    try {
        const m = JSON.parse(fs.readFileSync(TERRAIN_MANIFEST, 'utf8'));
        const areas: Area[] = Array.isArray(m.areas) ? m.areas : [];
        // A pyramid baked before areas were recorded still has coverage, and
        // that is one area by construction.
        if (areas.length === 0 && m.coverage) {
            return { areas: [{ name: 'home', ...m.coverage }], coverage: m.coverage };
        }
        return { areas, coverage: m.coverage };
    } catch {
        return { areas: [] };
    }
}

export function areasHandler(_req: Request, res: Response): void {
    res.json(readAreas());
}

// --- OSM extract coverage ---------------------------------------------------

const EXTRACT_COVERAGE_FILE = path.join(PROJECT_ROOT, 'data', 'osm-cache', 'extracts.json');

/**
 * The Geofabrik regions `tools/osm_extract.py` has already downloaded a raw
 * copy of, so the importer's map can shade "an import here reads a local
 * extract instead of downloading one first" - written by that script, read
 * here rather than re-derived, since it is the one place that knows what it
 * put in `data/imports/geofabrik/`.
 */
export function readExtractCoverage(): Area[] {
    if (!fs.existsSync(EXTRACT_COVERAGE_FILE)) {
        return [];
    }
    try {
        const entries = JSON.parse(fs.readFileSync(EXTRACT_COVERAGE_FILE, 'utf8'));
        return Array.isArray(entries) ? entries : [];
    } catch {
        return [];
    }
}

export function osmExtractsHandler(_req: Request, res: Response): void {
    res.json({ extracts: readExtractCoverage() });
}

// --- the import job --------------------------------------------------------

/**
 * Percent complete out of a tool's own progress line, or undefined.
 *
 * Each stage already prints where it is; this reads those rather than
 * inventing a second progress model that could disagree with what the log
 * plainly says. Unrecognised lines simply carry no percentage.
 */
export function parseProgress(line: string): number | undefined {
    // `  123/456 (27.0%)  1.2 MB` — the mesh and cover bakes — and
    // `  fetching OSM coastline 4.2 MB received  (13.1% of stage)` — the
    // coast bake, whose StageProgress folds its Overpass fetches, polygon
    // assembly and every tile level into one percentage of the whole stage.
    const pct = /\((\d+(?:\.\d+)?)%(?: of stage)?\)/.exec(line);
    if (pct) {
        return clampPercent(Number(pct[1]));
    }
    // `  merged NAME -> 42.0% covered` — the DEM and cover-source fetches.
    const covered = /->\s*(\d+(?:\.\d+)?)%\s+covered/.exec(line);
    if (covered) {
        return clampPercent(Number(covered[1]));
    }
    // `  sampling 12/18`, `  rasterize 12/23`, `  writing 12/23 at z11` and
    // `  clip 12/23 at z11`.
    const ratio = /^\s*(?:sampling|rasterize|writing|clip)\s+(\d+)\s*\/\s*(\d+)/.exec(line);
    if (ratio) {
        const total = Number(ratio[2]);
        return total > 0 ? clampPercent(100 * Number(ratio[1]) / total) : undefined;
    }
    return undefined;
}

function clampPercent(v: number): number | undefined {
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
}

/** True for a line that is only a progress update, so the log can replace it. */
export function isProgressLine(line: string): boolean {
    return /^\s*\d+\s*\/\s*\d+\s*\(/.test(line)
        // tools/osm_extract.py's region download counter: `  12.3/456.7 MB (2.7%)`.
        || /^\s*[\d.]+\s*\/\s*[\d.]+\s*MB\s*\(/.test(line)
        || /^\s*(?:sampling|rasterize|writing|clip)\s+\d+\s*\/\s*\d+/.test(line)
        // The coast bake's stage lines all end the same way; its `phase 3/8`
        // headings and `... done in 4.2s` summaries do not, and stay in the
        // log for good.
        || /\(\d+(?:\.\d+)?% of stage\)\s*$/.test(line);
}

function frameFor(job: Job, event: Record<string, unknown>): string {
    // Overall progress treats every stage as an equal slice. They are not
    // equal — the imagery fetch dwarfs the rest — but a bar that moves
    // steadily and reaches 100 beats one weighted by guesswork.
    const overall = job.stepCount > 0
        ? (100 * (job.stepIndex + job.percent / 100)) / job.stepCount
        : 0;
    return `data: ${JSON.stringify({
        ...event,
        step: job.step,
        state: job.state,
        stepIndex: job.stepIndex,
        stepCount: job.stepCount,
        percent: Math.round(job.percent),
        overall: Math.round(Math.min(100, overall)),
    })}\n\n`;
}

function emit(job: Job, event: Record<string, unknown>): void {
    job.lastEmit = Date.now();
    const frame = frameFor(job, event);
    for (const sub of job.subscribers) {
        sub.write(frame);
    }
}

/** Start the periodic no-op frame that keeps a quiet stage from reading as hung. */
function startHeartbeat(job: Job): void {
    job.heartbeat = setInterval(() => {
        if (Date.now() - job.lastEmit >= HEARTBEAT_MS) {
            emit(job, { line: '' });
        }
    }, HEARTBEAT_MS);
    job.heartbeat.unref?.();
}

/**
 * One line of a step's output into the job log. `side` marks output from a
 * background helper (the Overpass prefetch): it is logged but never read for
 * progress, since the percentage belongs to the foreground step.
 */
function line(job: Job, text: string, side = false): void {
    const progress = side ? undefined : parseProgress(text);
    if (progress !== undefined) {
        job.percent = progress;
    }
    // A progress line supersedes the previous one rather than stacking: the
    // mesh bake alone emits one every hundred tiles.
    if (!side && isProgressLine(text) && job.log.length > 0 && isProgressLine(job.log[job.log.length - 1])) {
        job.log[job.log.length - 1] = text;
        emit(job, { line: text, replace: true });
        return;
    }
    job.log.push(text);
    // The log is only ever read back for a job that is still running; capping
    // it stops a half-hour imagery fetch from becoming a memory leak.
    if (job.log.length > 4000) {
        job.log.splice(0, job.log.length - 4000);
    }
    emit(job, { line: text });
}

/**
 * Split a chunk of child output into whole lines, keeping the remainder.
 *
 * A bare carriage return counts as a line break. The mesh and cover bakes
 * redraw one progress line with `\r` and no newline at all, so splitting on
 * newlines alone means their progress never reaches the browser until the
 * stage is already over.
 */
export function splitStream(tail: string, chunk: string): { lines: string[]; tail: string } {
    const parts = (tail + chunk).split(/\r\n|\n|\r/);
    return { tail: parts.pop() ?? '', lines: parts.filter(l => l.trim().length > 0) };
}

/** `93s` under a minute, `4m 12s` at or past one - readable at either scale
 * without ever printing "0m 8s". */
export function formatDuration(ms: number): string {
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) {
        return `${totalSeconds.toFixed(1)}s`;
    }
    // Round the whole duration first, not just the seconds remainder - 119.6s
    // is 2m 0s, and rounding 59.6 leftover seconds on its own would print the
    // impossible "1m 60s".
    const roundedSeconds = Math.round(totalSeconds);
    const minutes = Math.floor(roundedSeconds / 60);
    const seconds = roundedSeconds - minutes * 60;
    return `${minutes}m ${seconds}s`;
}

/**
 * `tools/fetch_planet_dem.py`'s exit code for a box that is all open sea
 * (EXIT_NO_LAND there): nothing failed, there is just no land to bake.
 */
export const EXIT_NO_LAND = 3;

export type StepOutcome = 'done' | 'partial' | 'skipped' | 'failed';

/**
 * What a step's exit code means for the job. Zero is done; a step's declared
 * `partialCode` is done-with-a-warning, the tool having written its outputs
 * but left part of the work for a re-run; its `skipCode` is "nothing to do
 * here", whose consequences the caller decides; anything else fails the job.
 */
export function stepOutcome(
    code: number | null, step: Pick<Step, 'partialCode' | 'skipCode'>,
): StepOutcome {
    if (code === 0) {
        return 'done';
    }
    if (step.partialCode !== undefined && code === step.partialCode) {
        return 'partial';
    }
    if (step.skipCode !== undefined && code === step.skipCode) {
        return 'skipped';
    }
    return 'failed';
}

function runStep(job: Job, s: Step, index: number): Promise<Exclude<StepOutcome, 'failed'>> {
    const { label, cmd, args } = s;
    return new Promise((resolve, reject) => {
        job.step = label;
        job.stepIndex = index;
        job.percent = 0;
        line(job, `\n[${index + 1}/${job.stepCount}] ${label}`);
        line(job, `$ ${cmd} ${args.join(' ')}`);
        const startedAt = Date.now();
        const child = track(job, spawn(cmd, args, { cwd: PROJECT_ROOT }));
        let tail = '';
        const feed = (d: Buffer) => {
            // Split on a bare carriage return as well as a newline. The mesh
            // and cover bakes redraw a single progress line with \r and no
            // newline at all, so splitting on newlines alone means their
            // progress never arrives until the stage is already over.
            const split = splitStream(tail, d.toString());
            tail = split.tail;
            for (const l of split.lines) {
                line(job, l);
            }
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', err => reject(new Error(`${label}: ${err.message}`)));
        child.on('close', code => {
            if (tail.trim()) {
                line(job, tail);
            }
            const elapsed = formatDuration(Date.now() - startedAt);
            const outcome = stepOutcome(code, s);
            if (outcome === 'done') {
                line(job, `${label} - done in ${elapsed}`);
                resolve(outcome);
            } else if (outcome === 'partial' && s.partialWarning) {
                // The tool wrote what it could and said so on its own last
                // lines; the steps after it still have everything they need.
                job.warnings.push(`${label}: ${s.partialWarning}`);
                line(job, `${label} - done with a warning in ${elapsed}: ${s.partialWarning}`);
                resolve(outcome);
            } else if (outcome === 'skipped') {
                line(job, `${label} - nothing to do (${elapsed})`);
                resolve(outcome);
            } else {
                reject(new Error(`${label} exited with code ${code} after ${elapsed}`));
            }
        });
    });
}

/** Adds a spawned tool to the job's live set until it exits. */
function track<C extends ChildProcess>(job: Job, child: C): C {
    (job.children ??= new Set()).add(child);
    child.on('close', () => job.children?.delete(child));
    return child;
}

/**
 * One step of a background lane (see `runImport`): spawned like a step and
 * judged like one - a failure fails the import, the step's partial code only
 * warns - but its output goes to the log under a `[label]` prefix, with the
 * redrawn progress lines dropped, and it never takes the progress bar.
 */
function runLaneStep(job: Job, s: Step): Promise<void> {
    return new Promise((resolve, reject) => {
        line(job, `[${s.label}] $ ${s.cmd} ${s.args.join(' ')}`, true);
        const startedAt = Date.now();
        const child = track(job, spawn(s.cmd, s.args, { cwd: PROJECT_ROOT }));
        let tail = '';
        const feed = (d: Buffer) => {
            const split = splitStream(tail, d.toString());
            tail = split.tail;
            for (const l of split.lines) {
                if (!isProgressLine(l)) {
                    line(job, `[${s.label}] ${l}`, true);
                }
            }
        };
        child.stdout?.on('data', feed);
        child.stderr?.on('data', feed);
        child.on('error', err => reject(new Error(`${s.label}: ${err.message}`)));
        child.on('close', code => {
            if (tail.trim()) {
                line(job, `[${s.label}] ${tail}`, true);
            }
            const elapsed = formatDuration(Date.now() - startedAt);
            const outcome = stepOutcome(code, { partialCode: s.partialCode });
            if (outcome === 'done') {
                line(job, `[${s.label}] done in ${elapsed}`, true);
                resolve();
            } else if (outcome === 'partial' && s.partialWarning) {
                job.warnings.push(`${s.label}: ${s.partialWarning}`);
                line(job, `[${s.label}] done with a warning in ${elapsed}: ${s.partialWarning}`, true);
                resolve();
            } else {
                reject(new Error(`${s.label} exited with code ${code} after ${elapsed}`));
            }
        });
    });
}

/**
 * Background lanes: each runs its steps one at a time in the order they were
 * queued, each step also waiting for the steps it depends on. A step's
 * promise never rejects - the first failure is kept in `error`, nothing new
 * starts after it, and `join` throws it - so a lane can be chained on and
 * left unawaited without an unhandled rejection taking the server down.
 */
export class Lanes {
    error: Error | undefined;
    private readonly tails = new Map<string, Promise<void>>();
    private readonly all: Promise<void>[] = [];

    run(lane: string, deps: readonly Promise<void>[], fn: () => Promise<void>): Promise<void> {
        const prev = this.tails.get(lane) ?? Promise.resolve();
        const p = Promise.all([prev, ...deps])
            .then(() => (this.error === undefined ? fn() : undefined))
            .catch((err: unknown) => {
                this.error ??= err instanceof Error ? err : new Error(String(err));
            });
        this.tails.set(lane, p);
        this.all.push(p);
        return p;
    }

    async join(): Promise<void> {
        await Promise.all(this.all);
        if (this.error !== undefined) {
            throw this.error;
        }
    }
}

export interface Step {
    label: string;
    cmd: string;
    args: string[];
    /**
     * An exit code that means "outputs written, part of the work skipped" -
     * the job goes on and finishes with `partialWarning` instead of failing.
     */
    partialCode?: number;
    partialWarning?: string;
    /**
     * An exit code that means "nothing here to do" - no outputs, but no
     * failure either. Only a foreground step may declare one, and
     * `runImport` decides what the rest of the chunk does about it.
     */
    skipCode?: number;
    /**
     * Which of the import's lanes runs it - see `runImport`. The foreground
     * lanes ('dem', 'prefetch', 'coast') run one step at a time and drive the
     * progress bar; every other lane runs its chunks in order alongside them.
     */
    lane?: Lane;
}

/**
 * The import's lanes. Each lane runs one step at a time, chunk after chunk,
 * which is what keeps the coarse tiles a stage derives from its own finer
 * ones on disk (coast .lvr, road .rvr, cover .plc) from being rewritten by
 * two of its runs at once. Different lanes write different files; the one
 * file they share, the manifest, is written under a lock
 * (osm_common.update_manifest).
 */
export type Lane = 'dem' | 'prefetch' | 'coast' | 'roads' | 'airfields' | 'cover-fetch' | 'cover';

/** The lanes that take the progress bar, one step at a time. The OSM read and the coast bake are also the two that need most memory (10 GB for one Erz chunk's coast bake), so never two at once. */
const FOREGROUND_LANES: ReadonlySet<Lane> = new Set<Lane>(['dem', 'prefetch', 'coast']);

/**
 * The extract every OSM-reading stage below reads instead of the live
 * Overpass mirrors: `tools/osm_extract.py` resolves the bbox to a Geofabrik
 * region, downloads it once (reused by every future import inside it) and
 * clips it down to this bbox. One step, run before the data stages, rather
 * than each stage fetching for itself — a real import's coast, roads,
 * airfields and cover stages would otherwise all pay for the same download.
 */
export function extractPathFor(bbox: readonly number[]): string {
    return path.join('data', 'imports', 'pbf', `${bbox.join('_')}.osm.pbf`);
}

export function resolveExtractStep(bbox: readonly number[]): Step {
    return {
        label: 'resolving local OSM extract', cmd: PYTHON,
        args: ['tools/osm_extract.py', `--bbox=${bbox.join(',')}`, `--out=${extractPathFor(bbox)}`],
    };
}

/**
 * The stages, in order — the same command line as tools/README.md.
 *
 * The last two are the mesh bake and, always right after it over the same
 * box, the far-tile texture bake: the meshes are what the textures are
 * rasterised from, and a manifest re-written by the mesh bake only
 * describes textures the texture bake then refreshes.
 */
export function plan(job: { name: string; bbox: readonly number[] }): Step[] {
    const pbf = extractPathFor(job.bbox);
    return [
        resolveExtractStep(job.bbox),
        ...dataSteps({ ...job, pbf }),
        ...meshSteps(job.bbox),
    ];
}

/**
 * Chunks an import is cut into: tile-aligned boxes of at most `maxSpan`
 * degrees a side, west to east then north to south. Each axis is split into
 * as few parts as fit under `maxSpan`, as evenly as whole tiles allow - not
 * `maxSpan` after `maxSpan` then whatever is left over, which ended a 4.09
 * degree wide box on a 0.09 degree sliver of a column that was pure Baltic.
 *
 * Every cut lies on a z12 tile edge counted from the (already snapped) box's
 * own corner, which is what `snapBboxToTiles` exists to guarantee - a stage
 * that writes whole tiles never rewrites half of a neighbour chunk's tile. The
 * bakes are super-linear in box size (the DEM tool's own MAX_SPAN note says
 * quadratic), so several small boxes cost less than one big one, hold less in
 * memory, and leave finished chunks on disk if a later one fails.
 */
export function chunkBbox(
    bbox: readonly [number, number, number, number],
    maxSpan = CHUNK_SPAN_DEG,
): [number, number, number, number][] {
    const [west, south, east, north] = bbox;
    const tile = 180 / (1 << SNAP_ZOOM);
    const perChunk = Math.max(1, Math.floor(maxSpan / tile));
    const cuts = (lo: number, hi: number): number[] => {
        const tiles = Math.max(1, Math.round((hi - lo) / tile));
        const parts = Math.ceil(tiles / perChunk);
        const out = [lo];
        for (let i = 1; i < parts; i++) {
            out.push(lo + Math.round((i * tiles) / parts) * tile);
        }
        out.push(hi);
        return out;
    };
    const xs = cuts(west, east);
    const ys = cuts(south, north);
    const chunks: [number, number, number, number][] = [];
    for (let j = ys.length - 1; j > 0; j--) {
        for (let i = 0; i + 1 < xs.length; i++) {
            chunks.push([xs[i], ys[j - 1], xs[i + 1], ys[j]]);
        }
    }
    return chunks;
}

/**
 * The stages that fetch and bake source data for one box - everything up to,
 * not including, the meshes. `extend` makes the DEM merge grow the area's
 * manifest entry, for the second and later chunks of one import. `pbf` is
 * always given: the local extract `resolveExtractStep` (or a chunk's shared
 * job-wide one) produces, read instead of the live Overpass mirrors.
 * Satellite cover is always fetched too - every import wants the colour
 * eventually, and skipping it just meant a second, separately-triggered bake
 * later with the same DEM and coastline already on disk.
 */
export function dataSteps(
    job: { name: string; bbox: readonly number[]; pbf: string }, extend = false,
): Step[] {
    const bbox = job.bbox.join(',');
    const pbfArg = `--pbf=${job.pbf}`;
    const tif = path.join('data', 'imports', `${slug(job.name)}-${job.bbox.join('_')}.tif`);
    // Each chunk's satellite sources in a directory of their own: the fetch
    // lane runs ahead of the cover lane, so a shared data/cover had the next
    // chunk's fetch overwrite the rasters a cover bake was still reading.
    const coverDir = path.join('data', 'cover', 'chunks', job.bbox.join('_'));
    return [
        // An all-sea box is skipped, not failed - see runImport.
        {
            label: 'fetching heights', cmd: PYTHON, lane: 'dem',
            args: ['tools/fetch_planet_dem.py', `--bbox=${bbox}`, '--out', tif],
            skipCode: EXIT_NO_LAND,
        },
        // The merge needs a pyramid to merge into; the first area of a fresh
        // checkout founds one instead.
        fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'planet', 'manifest.json')) || extend
            ? {
                label: 'merging into the pyramid', cmd: PYTHON, lane: 'dem',
                args: ['tools/merge_planet_dem.py', '--input', tif, '--name', job.name,
                    ...(extend ? ['--extend-area'] : [])],
            }
            : {
                label: 'baking the height pyramid', cmd: PYTHON, lane: 'dem',
                args: ['tools/bake_planet_dem.py', '--input', tif, '--name', job.name],
            },
        // Every OSM layer this chunk's bakes read, in one pass over the
        // extract: the coast, road, airfield and cover bakes below then find
        // their answers cached instead of each reading the file again.
        {
            label: 'reading OSM data', cmd: PYTHON, lane: 'prefetch',
            args: ['tools/osm_prefetch.py', `--bbox=${bbox}`, pbfArg],
        },
        {
            label: 'baking coastline', cmd: PYTHON, lane: 'coast',
            // --osm-landuse here is what writes the LVR4 landuse regions the
            // mesh bake cuts facets along; the cover stage's flag of the same
            // name only paints .plc classes and cannot produce them.
            args: ['tools/bake_osm_coast.py', `--bbox=${bbox}`, '--osm-landuse', pbfArg],
        },
        // The road vectors: their own layer beside the coast's, read only by
        // the texture and road-stroke bakes at the very end. So they run in
        // their own lane as soon as the chunk's OSM data is read, alongside
        // the coastline: both read the same merged DEM and write disjoint
        // files (.rvr vs .lwm/.lvr).
        {
            label: 'baking road vectors', cmd: PYTHON, lane: 'roads',
            args: ['tools/bake_osm_roads.py', `--bbox=${bbox}`, pbfArg],
        },
        // After the coast, because an airfield's platform is checked against
        // the land mask the coast bake just wrote — a runway the mask calls
        // water is one the terrain will refuse to flatten. Before the cover,
        // so the ground under the pavement can be painted as built rather than
        // left as whatever grew there.
        // Exit 2 (EXIT_PARTIAL in the tool) is "every Overpass mirror failed
        // for an area, so its airfields were carried from the last bake, not
        // refreshed". The manifest is intact and the mesh flattens whatever it
        // holds, so the import goes on: aborting here threw away the DEM and
        // coast stages' half hour and left no meshes at all, over data that a
        // re-run of the same box picks up in minutes once Overpass is back.
        {
            label: 'baking airfields', cmd: PYTHON, lane: 'airfields',
            args: ['tools/bake_osm_airports.py', `--bbox=${bbox}`, pbfArg],
            partialCode: 2,
            partialWarning: 'the OSM extract had no data for at least one area, so its airfields '
                + 'were carried from an earlier bake - re-run this import to refresh them',
        },
        {
            label: 'fetching cover sources', cmd: PYTHON, lane: 'cover-fetch',
            args: ['tools/fetch_cover_sources.py', `--bbox=${bbox}`, `--out=${coverDir}`],
        },
        {
            label: 'baking cover', cmd: PYTHON, lane: 'cover',
            args: ['tools/bake_planet_cover.py', `--bbox=${bbox}`, '--osm-landuse', pbfArg,
                `--sources=${path.join(coverDir, 'sources.json')}`],
        },
    ];
}

/** The mesh, far-texture and road-stroke bakes: once, over the whole import box. */
export function meshSteps(box: readonly number[]): Step[] {
    const bbox = box.join(',');
    return [
        {
            label: 'baking meshes', cmd: process.execPath,
            args: ['--import', 'tsx', 'tools/bake_planet_mesh.ts', '--bbox', bbox],
        },
        {
            label: 'baking far-tile textures', cmd: process.execPath,
            args: ['--import', 'tsx', 'tools/bake_planet_tex.ts', '--bbox', bbox],
        },
        // Roads last: the strokes are draped on the finished meshes, and the
        // texture bake above has already painted the major ones into the far
        // rasters from the vectors the road bake wrote.
        {
            label: 'baking road strokes', cmd: process.execPath,
            args: ['--import', 'tsx', 'tools/bake_planet_roads.ts', '--bbox', bbox],
        },
    ];
}

/**
 * Runs each chunk's heights stages in turn and returns the data steps of the
 * chunks that hold land. A chunk whose heights fetch is skipped (open sea) is
 * reported to `onSea` and dropped, merge and all; `stepsFor` is told whether
 * a land chunk came before, so the first land chunk founds the pyramid or
 * starts the area whichever chunk it happens to be.
 */
export async function landChunks(
    count: number,
    stepsFor: (ci: number, landBefore: boolean) => Step[],
    run: (s: Step) => Promise<StepOutcome>,
    onSea: (ci: number, steps: Step[]) => void,
): Promise<Step[][]> {
    const land: Step[][] = [];
    for (let ci = 0; ci < count; ci++) {
        const steps = stepsFor(ci, land.length > 0);
        const [fetchHeights, ...merge] = steps.filter(s => s.lane === 'dem');
        if (await run(fetchHeights) === 'skipped') {
            onSea(ci, steps);
            continue;
        }
        for (const s of merge) {
            await run(s);
        }
        land.push(steps);
    }
    if (land.length === 0) {
        throw new Error('no land above sea level anywhere in the import box');
    }
    return land;
}

async function runImport(job: Job): Promise<void> {
    fs.mkdirSync(IMPORTS_DIR, { recursive: true });
    fs.mkdirSync(path.join(PROJECT_ROOT, 'data', 'imports', 'pbf'), { recursive: true });
    // Every stage is scoped to a box instead of rewriting everything already
    // baked. The data stages take one chunk at a time; the meshes take the
    // whole box, since they need every chunk's data and are cheap per tile.
    const chunks = job.bbox.length === 4 ? chunkBbox(job.bbox as [number, number, number, number]) : [];
    const many = chunks.length > 1;
    // One extract covers the whole job — padded past every chunk's own edges —
    // so every chunk's stages read the same local file instead of each
    // resolving (and re-downloading) their own slice of it.
    const pbf = extractPathFor(job.bbox);
    job.pbf = pbf;
    // Built as each chunk's turn comes (see the heights loop below): whether
    // a chunk founds the pyramid or starts the area depends on which of the
    // chunks before it turned out to hold land.
    const chunkSteps = (ci: number, landBefore: boolean) =>
        dataSteps({ name: job.name, bbox: chunks[ci], pbf }, landBefore).map(s => ({
            ...s, label: many ? `chunk ${ci + 1}/${chunks.length}: ${s.label}` : s.label,
        }));
    const tail = meshSteps(job.bbox);
    const foreground = (s: Step) => s.lane === undefined || FOREGROUND_LANES.has(s.lane);
    const foregroundCount = (steps: Step[]) => steps.filter(foreground).length;
    // Background lanes never take a numbered slot.
    job.stepCount = 1 + chunks.reduce((n, _, ci) => n + foregroundCount(chunkSteps(ci, ci > 0)), 0)
        + tail.length;

    let index = 0;
    const run = (s: Step) => runStep(job, s, index++);
    const lanes = new Lanes();
    const inLane = (steps: Step[], lane: Lane) => steps.filter(s => s.lane === lane);
    const laneRun = (steps: Step[], lane: Lane) => async () => {
        for (const s of inLane(steps, lane)) {
            await runLaneStep(job, s);
        }
    };
    // A background lane failing stops the foreground at its next step, not
    // half an hour later at the join.
    const runForeground = async (s: Step) => {
        if (lanes.error !== undefined) {
            throw lanes.error;
        }
        return run(s);
    };

    try {
        await runForeground(resolveExtractStep(job.bbox));
        // Heights first, every chunk: each merge rewrites the pyramid's shared
        // ancestors and the manifest's area, and every later stage samples
        // the merged DEM.
        //
        // A chunk whose heights fetch finds only open sea is dropped here,
        // with every stage after it: there is no DEM to merge, no coast to
        // trace and nothing to cover. The mesh bake still runs over the whole
        // box and simply finds no height tiles there, and a tile missing from
        // the mesh index is drawn as a flat sea-level patch - just as the DEM
        // bake already leaves out an all-sea leaf inside a land chunk.
        const stepsPerChunk = await landChunks(chunks.length, chunkSteps, runForeground, (ci, steps) => {
            job.stepCount -= foregroundCount(steps) - 1;
            line(job, many
                ? `chunk ${ci + 1}/${chunks.length} is open sea - skipping its data stages`
                : 'the import box is open sea');
        });
        // Then a pipeline. The foreground takes each chunk's OSM read and
        // coast bake in turn - the two stages that need most memory, never
        // two at once. Everything else runs beside it in its own lane, one
        // chunk at a time and in chunk order: roads once the chunk's OSM is
        // read, airfields once its coast mask is written (a runway is checked
        // against it), cover once its airfields and satellite sources are in
        // (pavement is painted as built). So chunk 1's airfields, roads and
        // cover bake while chunk 2's OSM read and coastline run.
        const coverSources = stepsPerChunk.map(steps => lanes.run('cover-fetch', [], laneRun(steps, 'cover-fetch')));
        for (let ci = 0; ci < stepsPerChunk.length; ci++) {
            const steps = stepsPerChunk[ci];
            for (const s of inLane(steps, 'prefetch')) {
                await runForeground(s);
            }
            lanes.run('roads', [], laneRun(steps, 'roads'));
            for (const s of inLane(steps, 'coast')) {
                await runForeground(s);
            }
            const airfields = lanes.run('airfields', [], laneRun(steps, 'airfields'));
            lanes.run('cover', [airfields, coverSources[ci]], laneRun(steps, 'cover'));
        }
        // The mesh tail reads every lane's output.
        job.step = 'finishing airfields, roads and cover';
        emit(job, {});
        await lanes.join();
        for (const s of tail) {
            await runForeground(s);
        }
    } catch (err) {
        // Whatever else is still running would only write into an import
        // that has already failed.
        for (const child of job.children ?? []) {
            child.kill();
        }
        await lanes.join().catch(() => undefined);
        throw err;
    }
}

/**
 * Deleting an area: drop its tiles, then re-mesh and re-texture the
 * survivors around the hole over the same box, in that order — see plan().
 */
export function deletePlan(name: string, bbox: readonly number[]): Step[] {
    return [
        {
            label: 'removing baked tiles', cmd: PYTHON,
            args: ['tools/delete_area.py', '--name', name],
        },
        {
            label: 'rebaking surrounding meshes', cmd: process.execPath,
            args: ['--import', 'tsx', 'tools/bake_planet_mesh.ts', '--bbox', bbox.join(',')],
        },
        {
            label: 'rebaking far-tile textures', cmd: process.execPath,
            args: ['--import', 'tsx', 'tools/bake_planet_tex.ts', '--bbox', bbox.join(',')],
        },
        // The re-meshed ancestors have new facets, so their road strokes are
        // draped again; a tile whose .rvr went with the area loses its .ptr.
        {
            label: 'rebaking road strokes', cmd: process.execPath,
            args: ['--import', 'tsx', 'tools/bake_planet_roads.ts', '--bbox', bbox.join(',')],
        },
    ];
}

function runningJob(): Job | undefined {
    for (const j of jobs.values()) {
        if (j.state === 'running') {
            return j;
        }
    }
    return undefined;
}

/** Wire a job's outcome into its state, log and subscribers. */
function finishJob(job: Job, work: Promise<void>, doneLine: string): void {
    const startedAt = Date.now();
    work.then(() => {
        job.state = 'done';
        job.step = 'done';
        job.stepIndex = Math.max(0, job.stepCount - 1);
        job.percent = 100;
        const total = formatDuration(Date.now() - startedAt);
        if (job.warnings.length > 0) {
            line(job, `
${doneLine} (${total} total), with ${job.warnings.length} warning(s):`);
            for (const w of job.warnings) {
                line(job, `  ${w}`);
            }
        } else {
            line(job, `
${doneLine} (${total} total)`);
        }
    }).catch((err: Error) => {
        job.state = 'failed';
        job.error = err.message;
        line(job, `\nFAILED after ${formatDuration(Date.now() - startedAt)}: ${err.message}`);
    }).finally(() => {
        clearInterval(job.heartbeat);
        emit(job, { line: '' });
        for (const sub of job.subscribers) {
            sub.end();
        }
        job.subscribers.clear();
    });
}

export function startImport(req: Request, res: Response): void {
    const busy = runningJob();
    if (busy) {
        res.status(409).json({ ok: false, error: `a job is already running (${busy.name})` });
        return;
    }

    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const bbox = Array.isArray(body.bbox) ? body.bbox.map(Number) : [];

    if (!name || slug(name).length === 0) {
        res.status(400).json({ ok: false, error: 'give the area a name' });
        return;
    }
    if (bbox.length !== 4 || bbox.some((v: number) => !Number.isFinite(v))) {
        res.status(400).json({ ok: false, error: 'bbox must be west,south,east,north' });
        return;
    }
    const [west, south, east, north] = bbox as [number, number, number, number];
    if (west >= east || south >= north) {
        res.status(400).json({ ok: false, error: 'bbox is inside out' });
        return;
    }
    if (west < -180 || east > 180 || south < -90 || north > 90) {
        res.status(400).json({
            ok: false,
            error: 'bbox must lie inside the WGS84 domain (boxes across the antimeridian are not supported)',
        });
        return;
    }
    if (Math.max(east - west, north - south) > MAX_SPAN_DEG) {
        res.status(400).json({
            ok: false,
            error: `bbox spans ${(east - west).toFixed(2)} x ${(north - south).toFixed(2)} deg, `
                + `over the ${MAX_SPAN_DEG} deg limit`,
        });
        return;
    }
    if (readAreas().areas.some(a => a.name === name)) {
        res.status(409).json({ ok: false, error: `an area called "${name}" already exists` });
        return;
    }

    const id = `${slug(name)}-${jobs.size}-${process.hrtime.bigint().toString(36)}`;
    const job: Job = {
        id, name, bbox: snapBboxToTiles([west, south, east, north]),
        state: 'running', log: [], warnings: [], step: 'starting',
        // A rough guess for the single-chunk, common case: overwritten with
        // the real count as soon as runImport has chunked the box.
        stepIndex: 0, stepCount: 7, percent: 0,
        subscribers: new Set(), lastEmit: Date.now(),
    };
    jobs.set(id, job);
    res.json({ ok: true, id });
    startHeartbeat(job);

    finishJob(job, runImport(job), 'import complete — reload to fly there');
}

export function startDelete(req: Request, res: Response): void {
    const busy = runningJob();
    if (busy) {
        res.status(409).json({ ok: false, error: `a job is already running (${busy.name})` });
        return;
    }

    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const { areas } = readAreas();
    const area = areas.find(a => a.name === name);
    if (!area) {
        res.status(404).json({ ok: false, error: `no area called "${name}"` });
        return;
    }
    if (areas.length <= 1) {
        res.status(409).json({
            ok: false,
            error: 'refusing to delete the only area — that is the whole terrain',
        });
        return;
    }

    const bbox: [number, number, number, number] =
        [area.west, area.south, area.east, area.north];
    const id = `delete-${slug(name)}-${jobs.size}-${process.hrtime.bigint().toString(36)}`;
    const job: Job = {
        id, name: `delete ${name}`, bbox,
        state: 'running', log: [], warnings: [], step: 'starting',
        stepIndex: 0, stepCount: 3, percent: 0,
        subscribers: new Set(), lastEmit: Date.now(),
    };
    jobs.set(id, job);
    res.json({ ok: true, id });
    startHeartbeat(job);

    const steps = deletePlan(name, bbox);
    finishJob(job, (async () => {
        for (let i = 0; i < steps.length; i++) {
            await runStep(job, steps[i], i);
        }
    })(), `deleted "${name}" — reload the page`);
}

export function importStream(req: Request, res: Response): void {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const job = jobs.get(String(id));
    if (!job) {
        res.status(404).end();
        return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Replay whatever already happened, so a reconnect is not a blank screen.
    for (const l of job.log) {
        res.write(frameFor(job, { line: l }));
    }
    if (job.state !== 'running') {
        res.write(frameFor(job, { line: '' }));
        res.end();
        return;
    }
    job.subscribers.add(res);
    req.on('close', () => { job.subscribers.delete(res); });
}

/**
 * The area a fresh checkout bakes when it has no source pyramid either: the
 * island PLAY_ORIGIN (and so the authored airbase) sits on.
 */
const DEFAULT_AREA = { name: 'Gran Canaria', bbox: [-15.87, 27.72, -15.33, 28.2] as const };

let bootstrapJob: Job | undefined;

/**
 * Bakes the terrain the game cannot start without, when it is missing - the
 * pyramid is a build product, so a fresh clone (or a wiped assets/terrain)
 * has none. With the source pyramid in assets/planet only the mesh stages
 * run over all of it; with nothing at all, the default area is imported from
 * scratch exactly as F9 would. Called once when the dev server starts; the
 * boot screen follows it through `terrainBootstrapHandler`.
 */
export function ensureTerrain(): void {
    const unfinished = fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'planet', '.bootstrap-incomplete'));
    if ((fs.existsSync(TERRAIN_MANIFEST) && !unfinished) || runningJob()) {
        return;
    }
    // Marks a bootstrap import that has not finished: the DEM stage founds
    // assets/planet within seconds, so a server stopped mid-import would
    // otherwise leave a pyramid with no cover that looks complete.
    const marker = path.join(PROJECT_ROOT, 'assets', 'planet', '.bootstrap-incomplete');
    const hasSource = fs.existsSync(path.join(PROJECT_ROOT, 'assets', 'planet', 'manifest.json'))
        && !fs.existsSync(marker);
    const bbox = snapBboxToTiles([...DEFAULT_AREA.bbox]);
    const job: Job = {
        id: `bootstrap-${process.hrtime.bigint().toString(36)}`,
        // runImport names the merged DEM area after the job.
        name: hasSource ? 'terrain meshes' : DEFAULT_AREA.name,
        bbox, state: 'running', log: [], warnings: [], step: 'starting',
        stepIndex: 0, stepCount: 3, percent: 0,
        subscribers: new Set(), lastEmit: Date.now(),
    };
    jobs.set(job.id, job);
    bootstrapJob = job;
    console.log(`terrain missing: baking ${job.name} (progress on the boot screen)`);
    startHeartbeat(job);
    const work = hasSource
        ? (async () => {
            // Unscoped: every tile the source pyramid holds, not one box.
            const steps = meshSteps([]).map(s => ({ ...s, args: s.args.slice(0, 3) }));
            job.stepCount = steps.length;
            for (let i = 0; i < steps.length; i++) {
                await runStep(job, steps[i], i);
            }
        })()
        : (async () => {
            fs.mkdirSync(path.dirname(marker), { recursive: true });
            fs.writeFileSync(marker, '');
            await runImport(job);
            fs.rmSync(marker, { force: true });
        })();
    finishJob(job, work, 'terrain baked');
    // Nobody is subscribed to this job's stream, so its log would vanish.
    work.catch(() => console.error(`terrain bake failed:\n${job.log.slice(-30).join('\n')}`));
}

export function terrainBootstrapHandler(_req: Request, res: Response): void {
    const job = bootstrapJob;
    const ready = fs.existsSync(TERRAIN_MANIFEST);
    if (!job) {
        res.json({ state: ready ? 'done' : 'missing' });
        return;
    }
    res.json({
        state: job.state === 'running' || ready ? job.state : 'failed',
        name: job.name, step: job.step, stepIndex: job.stepIndex, stepCount: job.stepCount,
        percent: job.percent, error: job.error, log: job.log.slice(-8),
    });
}
