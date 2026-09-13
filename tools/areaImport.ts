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
import { spawn } from 'child_process';

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
    state: JobState;
    log: string[];
    step: string;
    stepIndex: number;
    stepCount: number;
    /** Progress within the current step, 0..100, when the tool reports it. */
    percent: number;
    error?: string;
    subscribers: Set<Response>;
}

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
    const frame = frameFor(job, event);
    for (const sub of job.subscribers) {
        sub.write(frame);
    }
}

function line(job: Job, text: string): void {
    const progress = parseProgress(text);
    if (progress !== undefined) {
        job.percent = progress;
    }
    // A progress line supersedes the previous one rather than stacking: the
    // mesh bake alone emits one every hundred tiles.
    if (isProgressLine(text) && job.log.length > 0 && isProgressLine(job.log[job.log.length - 1])) {
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

function runStep(
    job: Job, label: string, index: number, cmd: string, args: string[],
): Promise<void> {
    return new Promise((resolve, reject) => {
        job.step = label;
        job.stepIndex = index;
        job.percent = 0;
        line(job, `\n[${index + 1}/${job.stepCount}] ${label}`);
        line(job, `$ ${cmd} ${args.join(' ')}`);
        const startedAt = Date.now();
        const child = spawn(cmd, args, { cwd: PROJECT_ROOT });
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
            if (code === 0) {
                line(job, `${label} - done in ${elapsed}`);
                resolve();
            } else {
                reject(new Error(`${label} exited with code ${code} after ${elapsed}`));
            }
        });
    });
}

interface Step { label: string; cmd: string; args: string[] }

/** The stages, in order — the same command line as tools/README.md. */
function plan(job: Job, withCover: boolean): Step[] {
    const bbox = job.bbox.join(',');
    const tif = path.join('data', 'imports', `${slug(job.name)}.tif`);
    const steps: Step[] = [
        {
            label: 'fetching heights', cmd: PYTHON,
            args: ['tools/fetch_planet_dem.py', `--bbox=${bbox}`, '--out', tif],
        },
        {
            label: 'merging into the pyramid', cmd: PYTHON,
            args: ['tools/merge_planet_dem.py', '--input', tif, '--name', job.name],
        },
        {
            label: 'baking coastline', cmd: PYTHON,
            // --osm-landuse here is what writes the LVR4 landuse regions the
            // mesh bake cuts facets along; the cover stage's flag of the same
            // name only paints .plc classes and cannot produce them.
            args: ['tools/bake_osm_coast.py', `--bbox=${bbox}`, '--osm-landuse'],
        },
        // After the coast, because an airfield's platform is checked against
        // the land mask the coast bake just wrote — a runway the mask calls
        // water is one the terrain will refuse to flatten. Before the cover,
        // so the ground under the pavement can be painted as built rather than
        // left as whatever grew there.
        {
            label: 'baking airfields', cmd: PYTHON,
            args: ['tools/bake_osm_airports.py', `--bbox=${bbox}`],
        },
    ];
    if (withCover) {
        steps.push({
            label: 'fetching cover sources', cmd: PYTHON,
            args: ['tools/fetch_cover_sources.py', `--bbox=${bbox}`],
        });
        steps.push({
            label: 'baking cover', cmd: PYTHON,
            args: ['tools/bake_planet_cover.py', `--bbox=${bbox}`, '--osm-landuse'],
        });
    }
    steps.push({
        label: 'baking meshes', cmd: process.execPath,
        args: ['--import', 'tsx', 'tools/bake_planet_mesh.ts', '--bbox', bbox],
    });
    steps.push({
        label: 'baking far-tile textures', cmd: process.execPath,
        args: ['--import', 'tsx', 'tools/bake_planet_tex.ts', '--bbox', bbox],
    });
    return steps;
}

async function runImport(job: Job, withCover: boolean): Promise<void> {
    fs.mkdirSync(IMPORTS_DIR, { recursive: true });
    // One bbox throughout: it is what scopes every stage to this area instead
    // of rewriting everything already baked.
    const steps = plan(job, withCover);
    job.stepCount = steps.length;
    for (let i = 0; i < steps.length; i++) {
        await runStep(job, steps[i].label, i, steps[i].cmd, steps[i].args);
    }
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
        line(job, `\n${doneLine} (${formatDuration(Date.now() - startedAt)} total)`);
    }).catch((err: Error) => {
        job.state = 'failed';
        job.error = err.message;
        line(job, `\nFAILED after ${formatDuration(Date.now() - startedAt)}: ${err.message}`);
    }).finally(() => {
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
    const withCover = body.withCover === true;

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
        state: 'running', log: [], step: 'starting',
        stepIndex: 0, stepCount: withCover ? 6 : 4, percent: 0,
        subscribers: new Set(),
    };
    jobs.set(id, job);
    res.json({ ok: true, id });

    finishJob(job, runImport(job, withCover), 'import complete — reload to fly there');
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
        state: 'running', log: [], step: 'starting',
        stepIndex: 0, stepCount: 3, percent: 0,
        subscribers: new Set(),
    };
    jobs.set(id, job);
    res.json({ ok: true, id });

    const steps: Step[] = [
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
    ];
    finishJob(job, (async () => {
        for (let i = 0; i < steps.length; i++) {
            await runStep(job, steps[i].label, i, steps[i].cmd, steps[i].args);
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
