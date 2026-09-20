/**
 * Bake draw-ready terrain tiles (.ptm) from the DEM height pyramid and the OSM
 * coastline vectors.
 *
 * Reads the existing pyramid written by tools/bake_planet_dem.py,
 * tools/bake_osm_coast.py and tools/bake_planet_cover.py — .pdm heights, .lvr
 * land polygons, .plc observed cover — and writes one gzip-compressed PTM1
 * tile per land tile, plus index_mesh.bin and a manifest describing the mesh
 * stream.
 *
 * Cover is optional. Without it every land facet falls back to plain grass,
 * which is exactly what the bake produced before cover existed.
 *
 * This is the only place terrain geometry is produced. The runtime fetches,
 * decodes and draws; it never triangulates, so there is no fallback path to
 * keep in sync.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_mesh.ts [options]
 *
 *     --src DIR        input pyramid            (default assets/planet)
 *     --out DIR        output tree              (default assets/terrain)
 *     --max-zoom N     cap detail
 *     --budget N       triangles per tile       (default 6144)
 *     --only z/x/y     bake a single tile (repeatable), for debugging
 *     --limit N        stop after N tiles, for a quick smoke bake
 *     --swatches N     colours in the baked swatch table (default 24)
 *     --bbox w,s,e,n   bake only tiles overlapping this box, and merge the
 *                      index and swatch table with what is already there
 *                      (see tools/README.md, "Adding an area")
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { decodePdm } from '../src/script/terrain/demTile';
import { decodePtm } from '../src/script/terrain/ptm';
import {
    HISTOGRAM_BINS, accumulateColors, luminanceWindow, medianCut, newColorHistogram,
} from './bake/swatches';
import {
    EnuBasis, ecefToEnu, enuToGeodeticApprox, geodeticToEcef, makeEnuBasis,
} from '../src/script/terrain/geodesy';
import { FlattenPadRecord, padFromRecord } from '../src/script/terrain/flattenPad';
import { AIRBASE_FLATTEN_PAD, PLAY_ORIGIN } from '../src/script/state/worldLayout';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import {
    TileMeta, foldPtmErrors, INDEX_META_FILE, loadIndexMeta, newErrorFoldStats, saveIndexMeta,
} from './bake/errorFold';
import { LonLatBounds } from './bake/shoreline';
import {
    MeshTileConfig, TileProcessResult, TileTask, tileBounds,
} from './bake/meshTile';
import { GROUND_MEANS_FILE, regionalGroundMeans } from './bake/groundColor';

// Triangles per tile. Measured on real Canary z12 tiles: the coast alone costs
// ~18k at full resolution and roughly halves per coarsening step, so this buys
// a ~34 m shoreline (minLeafSize 2) and lands near 5,300 triangles per tile.
const DEFAULT_BUDGET = 6144;

/**
 * Colours in the baked swatch table.
 *
 * 24 is the retro end of "enough": a VGA-era scene got by on far fewer, and
 * past about thirty the mode stops reading as quantised and starts looking
 * like a muddier version of raw imagery.
 */
const DEFAULT_SWATCHES = 24;

interface Args {
    src: string;
    out: string;
    maxZoom?: number;
    budget: number;
    only: string[];
    limit?: number;
    swatches: number;
    bbox?: LonLatBounds;
    /** Worker threads; default one fewer than the machine's CPUs. */
    jobs?: number;
    /** Run the worker from its .ts source under tsx instead of the esbuild bundle. */
    noBundle: boolean;
}

/**
 * `west,south,east,north` in degrees.
 *
 * Scopes a bake to one area so a second one can be added without re-meshing
 * everything already there. Every pyramid-wide record the bake writes - the
 * index, the swatch table, the level skirts - is then merged with what the
 * previous bake left rather than replacing it.
 */
function parseBbox(text: string): LonLatBounds {
    const parts = text.split(',').map(v => Number(v.trim()));
    if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
        throw new Error(`--bbox wants west,south,east,north, got ${text}`);
    }
    const [west, south, east, north] = parts;
    if (west >= east || south >= north) {
        throw new Error(`--bbox is inside out: ${text}`);
    }
    return { west, south, east, north };
}

function overlaps(a: LonLatBounds, b: LonLatBounds): boolean {
    return !(a.east <= b.west || a.west >= b.east || a.north <= b.south || a.south >= b.north);
}

function parseArgs(argv: string[]): Args {
    const a: Args = {
        src: 'assets/planet',
        out: 'assets/terrain',
        budget: DEFAULT_BUDGET,
        only: [],
        swatches: DEFAULT_SWATCHES,
        noBundle: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--src') a.src = next();
        else if (k === '--out') a.out = next();
        else if (k === '--max-zoom') a.maxZoom = Number(next());
        else if (k === '--budget') a.budget = Number(next());
        else if (k === '--only') a.only.push(next());
        else if (k === '--limit') a.limit = Number(next());
        else if (k === '--swatches') a.swatches = Number(next());
        else if (k === '--bbox') a.bbox = parseBbox(next());
        else if (k === '--jobs') a.jobs = Number(next());
        else if (k === '--no-bundle') a.noBundle = true;
        else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

/**
 * The colour histogram, kept on disk beside the tiles it was built from.
 *
 * The swatch table and the luminance window in the manifest describe *the
 * whole pyramid* - the runtime quantises every tile against them, whichever
 * bake produced it. Derive them from one area's tiles and every other area is
 * snapped to colours taken from ground it does not contain. Since the counts
 * cannot be recovered from the finished .ptm files without decoding all of
 * them, the bake carries them forward instead: 32768 bins, 128 KB, add and
 * re-derive.
 */
const HISTOGRAM_FILE = 'swatch_histogram.bin';

function loadHistogram(dir: string): Uint32Array {
    const p = path.join(dir, HISTOGRAM_FILE);
    if (!fs.existsSync(p)) {
        return newColorHistogram();
    }
    const raw = fs.readFileSync(p);
    if (raw.byteLength !== HISTOGRAM_BINS * 4) {
        console.warn(`  ignoring ${HISTOGRAM_FILE}: ${raw.byteLength} bytes, `
            + `expected ${HISTOGRAM_BINS * 4}`);
        return newColorHistogram();
    }
    return new Uint32Array(raw.buffer, raw.byteOffset, HISTOGRAM_BINS).slice();
}

function saveHistogram(dir: string, histogram: Uint32Array): void {
    fs.writeFileSync(path.join(dir, HISTOGRAM_FILE), Buffer.from(histogram.buffer));
}

/**
 * Max DEM height under the airbase pad footprint.
 *
 * The old runtime sampled this at boot (HeightQuery.sampleMaxUnderPad) and then
 * re-meshed the pad tiles, which was the slowest step in the boot sequence. It
 * is a deterministic function of the DEM and a compile-time pad, so the bake
 * computes it once instead and the runtime never has to.
 */
function computePadHeight(
    src: string,
    manifest: { maxZoom: number; seaLevel?: number },
    basis: EnuBasis,
    pad: { centerX: number; centerZ: number; halfW: number; halfD: number },
): number {
    const seaLevel = manifest.seaLevel ?? 0;
    const cache = new Map<string, ReturnType<typeof decodePdm> | null>();
    const load = (z: number, x: number, y: number) => {
        const key = `${z}/${x}/${y}`;
        if (!cache.has(key)) {
            const p = path.join(src, String(z), String(x), `${y}.pdm`);
            cache.set(key, fs.existsSync(p) ? decodePdm(fs.readFileSync(p)) : null);
        }
        return cache.get(key)!;
    };

    const sampleAt = (lon: number, lat: number): number => {
        for (let z = manifest.maxZoom; z >= 0; z--) {
            const span = 180 / (1 << z);
            const x = Math.floor((lon + 180) / span);
            const y = Math.floor((90 - lat) / span);
            const tile = load(z, x, y);
            if (!tile) {
                continue;
            }
            const b = tileBounds(z, x, y);
            const u = (lon - b.west) / (b.east - b.west);
            const v = (b.north - lat) / (b.north - b.south);
            const n = tile.size;
            const fx = Math.min(n - 1, Math.max(0, u * (n - 1)));
            const fy = Math.min(n - 1, Math.max(0, v * (n - 1)));
            const h = tile.heights[Math.round(fy) * n + Math.round(fx)];
            return Number.isFinite(h) ? h : seaLevel;
        }
        return seaLevel;
    };

    const step = Math.max(10, Math.min(pad.halfW, pad.halfD) / 8);
    let maxH = -Infinity;
    for (let dz = -pad.halfD; dz <= pad.halfD; dz += step) {
        for (let dx = -pad.halfW; dx <= pad.halfW; dx += step) {
            const g = enuToGeodeticApprox(basis, pad.centerX + dx, pad.centerZ + dz, 0);
            const h = sampleAt(g.lon, g.lat);
            if (h > seaLevel && h > maxH) {
                maxH = h;
            }
        }
    }
    return Number.isFinite(maxH) ? maxH : seaLevel;
}

/**
 * Copy the height tiles the runtime actually reads into the output tree.
 *
 * CPU ground queries sample one fixed queryZoom plus an always-resident coarse
 * tier, so only z0..queryZoom is needed — the finest DEM level exists purely as
 * bake input. Copying them makes the output a single self-contained directory
 * that any static file server can serve and that deploys as one unit.
 *
 * The alternative — pointing the manifest back at the input tree — only worked
 * when something happened to be mounting both, which is exactly how a stale dev
 * server turns into a 404 on the manifest.
 */
function copyHeightTiles(
    src: string, out: string, maxZoom: number,
): { bytes: number; copied: number; skipped: number } {
    let bytes = 0;
    let copied = 0;
    let skipped = 0;
    for (let z = 0; z <= maxZoom; z++) {
        const zDir = path.join(src, String(z));
        if (!fs.existsSync(zDir)) {
            continue;
        }
        for (const xs of fs.readdirSync(zDir)) {
            const xDir = path.join(zDir, xs);
            if (!fs.statSync(xDir).isDirectory()) {
                continue;
            }
            for (const f of fs.readdirSync(xDir)) {
                if (!f.endsWith('.pdm')) {
                    continue;
                }
                const dstDir = path.join(out, String(z), xs);
                fs.mkdirSync(dstDir, { recursive: true });
                const dst = path.join(dstDir, f);
                const srcStat = fs.statSync(path.join(xDir, f));
                const dstStat = fs.existsSync(dst) ? fs.statSync(dst) : undefined;
                // Already there and no older than the source: nothing to do.
                // A DEM bake rewrites its tiles, so a changed tile is newer.
                if (dstStat !== undefined && dstStat.size === srcStat.size
                    && dstStat.mtimeMs >= srcStat.mtimeMs) {
                    bytes += dstStat.size;
                    skipped++;
                    continue;
                }
                fs.copyFileSync(path.join(xDir, f), dst);
                bytes += srcStat.size;
                copied++;
            }
        }
    }
    const index = path.join(src, 'index.bin');
    if (fs.existsSync(index)) {
        fs.copyFileSync(index, path.join(out, 'index.bin'));
        bytes += fs.statSync(index).size;
    }
    return { bytes, copied, skipped };
}

function walkTiles(src: string, maxZoom: number): Array<{ z: number; x: number; y: number }> {
    const out: Array<{ z: number; x: number; y: number }> = [];
    for (let z = 0; z <= maxZoom; z++) {
        const zDir = path.join(src, String(z));
        if (!fs.existsSync(zDir)) {
            continue;
        }
        for (const xs of fs.readdirSync(zDir)) {
            const xDir = path.join(zDir, xs);
            if (!fs.statSync(xDir).isDirectory()) {
                continue;
            }
            for (const f of fs.readdirSync(xDir)) {
                if (f.endsWith('.pdm')) {
                    out.push({ z, x: Number(xs), y: Number(f.slice(0, -4)) });
                }
            }
        }
    }
    return out;
}

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SOURCE = path.join(TOOLS_DIR, 'bake', 'meshTileWorker.ts');
const WORKER_BUNDLE = path.join(TOOLS_DIR, 'bake', '.build', 'meshTileWorker.cjs');

/**
 * Where the worker threads load their code from.
 *
 * The bake itself runs under `--import tsx`, and a worker spawned with the
 * parent's execArgv does too: every one of the ~20 workers transpiles the
 * whole buildTile graph on start and then runs tsx's output, which this repo
 * has measured at tens of times slower than an esbuild bundle. So the worker
 * is bundled once per bake (a few hundred ms, always redone - cheaper than
 * getting a staleness check wrong) and spawned as plain JavaScript with an
 * empty execArgv. If esbuild is missing or the bundle fails, fall back to
 * the source under tsx: slower, but the same code.
 */
async function prepareWorker(): Promise<{ file: string; execArgv: string[] }> {
    try {
        const esbuild = await import('esbuild');
        fs.mkdirSync(path.dirname(WORKER_BUNDLE), { recursive: true });
        await esbuild.build({
            entryPoints: [WORKER_SOURCE],
            outfile: WORKER_BUNDLE,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: `node${process.versions.node.split('.')[0]}`,
            logLevel: 'silent',
        });
        // Only the profiler flags carry over: `--cpu-prof` on the parent
        // should profile the workers too, and nothing else on execArgv
        // (`--import tsx`) is wanted for the bundle.
        return { file: WORKER_BUNDLE, execArgv: process.execArgv.filter(a => a.startsWith('--cpu-prof')) };
    } catch (err) {
        console.warn(`warning: could not bundle the mesh worker (${(err as Error).message}); `
            + 'running it under tsx instead, which is slower');
        return { file: WORKER_SOURCE, execArgv: process.execArgv };
    }
}

/**
 * Runs `processTile` for every tile across a pool of worker threads.
 *
 * Tiles only read their own input files and write their own `.ptm`, so the
 * *computation* is safe to run in any order or in parallel. What must stay
 * order-independent-proof is the caller: results come back in `tasks` order
 * (indexed, not completion order) so folding them in that fixed order
 * reproduces the old fully-serial bake byte-for-byte - see meshTile.ts.
 */
async function runTilesInParallel(
    cfg: MeshTileConfig,
    tasks: TileTask[],
    onProgress: (done: number, total: number) => void,
    jobs?: number,
    noBundle = false,
): Promise<Array<TileProcessResult | undefined>> {
    const worker = tasks.length > 0 && !noBundle
        ? await prepareWorker()
        : { file: WORKER_SOURCE, execArgv: process.execArgv };
    return new Promise((resolve, reject) => {
        const results: Array<TileProcessResult | undefined> = new Array(tasks.length);
        if (tasks.length === 0) {
            resolve(results);
            return;
        }
        const workerCount = Math.max(1, Math.min(jobs ?? (os.cpus().length - 1), tasks.length));
        let nextTask = 0;
        let completed = 0;
        let failed: unknown;
        const workers: Worker[] = [];

        const settle = (): void => {
            for (const w of workers) {
                w.postMessage(null);
            }
            resolve(results);
        };

        const dispatch = (worker: Worker): void => {
            if (failed !== undefined || nextTask >= tasks.length) {
                return;
            }
            const idx = nextTask++;
            worker.postMessage({ idx, task: tasks[idx] });
        };

        for (let i = 0; i < workerCount; i++) {
            const w = new Worker(worker.file, { execArgv: worker.execArgv, workerData: cfg });
            workers.push(w);
            w.on('message', (msg: { idx: number; result: TileProcessResult | undefined }) => {
                results[msg.idx] = msg.result;
                completed++;
                onProgress(completed, tasks.length);
                if (completed === tasks.length) {
                    settle();
                } else {
                    dispatch(w);
                }
            });
            w.on('error', (err) => {
                if (failed === undefined) {
                    failed = err;
                    for (const w of workers) {
                        void w.terminate();
                    }
                    reject(failed);
                }
            });
            dispatch(w);
        }
    });
}

/**
 * The airfield descriptions, written beside the manifest rather than into it.
 *
 * Carried through whole from the DEM manifest: the runtime wants the runways,
 * taxiways and aprons to draw, and the airports bake has already merged them
 * across every scoped run.
 */
const AIRFIELDS_FILE = 'airfields.json';

// The per-tile header sidecar (index_meta.json) and the error fold that
// reads it live in tools/bake/errorFold.ts.

/** One airfield as `tools/bake_osm_airports.py` writes it into the DEM manifest. */
interface AirfieldRecord {
    name: string;
    icao?: string;
    area?: string;
    pads?: FlattenPadRecord[];
}

/**
 * Every pad this bake should cut, geodetically.
 *
 * The airfields come from the airports bake: real runways, at their real
 * bearings, each cut to the plane fitted for its own platform.
 *
 * An area with none of them still gets the old pad — a 1 x 4 km level box at
 * its centre, which is where the authored airbase stands. That is the only
 * thing left holding it up, and an area that has a real airfield does not need
 * an invented one flattened into the middle of it.
 */
function padRecordsFor(
    src: { airfields?: { items?: AirfieldRecord[] }; maxZoom: number; seaLevel?: number },
    areas: Array<{ name: string; west: number; south: number; east: number; north: number }>,
    srcDir: string,
): FlattenPadRecord[] {
    const records: FlattenPadRecord[] = [];

    const airfields = src.airfields?.items ?? [];
    const areasWithAirfield = new Set(airfields.map(a => a.area).filter(Boolean));

    for (const area of areas) {
        if (areasWithAirfield.has(area.name)) {
            continue;
        }
        const home = PLAY_ORIGIN.lon >= area.west && PLAY_ORIGIN.lon <= area.east
            && PLAY_ORIGIN.lat >= area.south && PLAY_ORIGIN.lat <= area.north;
        const lat = home ? PLAY_ORIGIN.lat : (area.south + area.north) / 2;
        const lon = home ? PLAY_ORIGIN.lon : (area.west + area.east) / 2;
        const heightMsl = computePadHeight(
            srcDir, src, makeEnuBasis(lat, lon, 0), AIRBASE_FLATTEN_PAD);
        console.log(`pad ${area.name}: ${lat.toFixed(4)}, ${lon.toFixed(4)} -> `
            + `${heightMsl.toFixed(2)} m MSL${home ? ' (home)' : ''}`);
        records.push({
            lat, lon,
            halfW: AIRBASE_FLATTEN_PAD.halfW,
            halfD: AIRBASE_FLATTEN_PAD.halfD,
            featherM: AIRBASE_FLATTEN_PAD.featherM,
            heightMsl,
        });
    }

    let airfieldPads = 0;
    for (const airfield of airfields) {
        for (const pad of airfield.pads ?? []) {
            records.push({ ...pad, icao: airfield.icao });
            airfieldPads++;
        }
    }
    if (airfields.length > 0) {
        console.log(`airfields: ${airfieldPads} pads across ${airfields.length} fields; `
            + `${areas.length - areasWithAirfield.size} areas still on a centre pad`);
    } else {
        console.log('airfields: none in the manifest — run `npm run bake:airports`');
    }
    return records;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const manifestPath = path.join(args.src, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`error: no manifest at ${manifestPath}`);
        console.error('Run tools/bake_planet_dem.py first.');
        process.exit(1);
    }
    const src = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const maxZoom = Math.min(args.maxZoom ?? src.maxZoom, src.maxZoom);
    const basis = makeEnuBasis(PLAY_ORIGIN.lat, PLAY_ORIGIN.lon, PLAY_ORIGIN.height);
    // One airbase pad per baked area, so every area has somewhere flat to put
    // a runway. Each is evaluated in a frame centred on itself: the pad is an
    // axis-aligned box in ENU, and ENU axes turn with position, so a box laid
    // out in the bake's frame would sit skewed against the local north the
    // runtime flattens against. Home's frame is the bake's frame, so its pad
    // is unchanged to the last decimal.
    const areas: Array<{ name: string; west: number; south: number; east: number; north: number }> =
        src.areas?.length ? src.areas : [{ name: 'terrain', ...src.coverage }];
    const padRecords = padRecordsFor(src, areas, args.src);
    const airfieldsFile = src.airfields?.items?.length ? src.airfields : undefined;
    // Each pad is evaluated in a frame centred on itself. The pad is an
    // oriented box in ENU and ENU axes turn with position, so a box laid out in
    // the bake's frame would sit skewed against the local north the runtime
    // flattens against.
    const pads = padRecords.map(rec => {
        const padBasis = makeEnuBasis(rec.lat, rec.lon, 0);
        const toEnu = (lat: number, lon: number) => {
            const enu = ecefToEnu(padBasis, geodeticToEcef(lat, lon, 0));
            return { e: enu.e, n: enu.n };
        };
        return { ...padFromRecord(rec, toEnu), basis: padBasis, lat: rec.lat, lon: rec.lon };
    });

    let tiles = args.only.length > 0
        ? args.only.map(s => {
            const [z, x, y] = s.split('/').map(Number);
            return { z, x, y };
        })
        : walkTiles(args.src, maxZoom);
    if (args.bbox !== undefined) {
        const before = tiles.length;
        const box = args.bbox;
        tiles = tiles.filter(t => overlaps(tileBounds(t.z, t.x, t.y), box));
        console.log(`bbox: ${tiles.length} of ${before} tiles overlap it; `
            + `${before - tiles.length} left alone`);
    }
    tiles.sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    if (args.limit !== undefined) {
        tiles = tiles.slice(0, args.limit);
    }

    console.log(`baking ${tiles.length} tiles from ${args.src} -> ${args.out} `
        + `(z0..${maxZoom}, budget ${args.budget})`);

    fs.mkdirSync(args.out, { recursive: true });
    const written: Array<{ z: number; x: number; y: number }> = [];
    // Per-level maxima over every tile in the final index, written or
    // carried. These used to be copied from the height pyramid's manifest,
    // whose table is a monotone max across every merge and delete ever run -
    // a mountain baked long ago pinned z4-z10 at 1.6 km, and the runtime
    // refined flat sea to z11 out to 130 km on the strength of it.
    const levelError: number[] = [];
    const levelSkirt: number[] = [];
    const foldLevel = (z: number, errM: number, skirtM: number) => {
        levelError[z] = Math.max(levelError[z] ?? 0, errM);
        levelSkirt[z] = Math.max(levelSkirt[z] ?? 0, skirtM);
    };
    let totalBytes = 0;
    let totalTris = 0;
    let maxTris = 0;
    let coarsenedCoast = 0;
    let coveredTiles = 0;
    let imageryTiles = 0;
    let inlandTiles = 0;
    let inlandBodies = 0;
    let riverTiles = 0;
    let riverTriangles = 0;
    let landuseTiles = 0;
    let landuseRegions = 0;
    const colorHistogram = args.bbox !== undefined
        ? loadHistogram(args.out)
        : newColorHistogram();
    const leafHistogram = new Map<number, number>();
    /** Per zoom: tile count, triangles, settled tolerance, collapsed vertices. */
    const zoomStats = new Map<number, {
        n: number; tris: number; mesh: number; fill: number; walls: number; skirts: number; water: number; strokes: number;
        tallWalls: number; borderWater: number; borderWaterTiles: number;
        openEdges: number; openEdgeTiles: number;
        errs: number[]; collapsed: number;
    }>();
    const t0 = Date.now();

    // Each tile only reads its own inputs and writes its own .ptm, so the
    // build+gzip work runs across a pool of worker threads (see meshTile.ts).
    // Results come back indexed by `tiles` order, not completion order, and
    // are folded below in that same order - identical to the old serial
    // loop's byte output regardless of which worker finished a given tile.
    const meshCfg: MeshTileConfig = {
        src: args.src,
        out: args.out,
        seaLevel: src.seaLevel ?? 0,
        maxZoom,
        budget: args.budget,
        basis,
        pads,
        groundMeans: regionalGroundMeans(args.src, path.join(args.out, GROUND_MEANS_FILE)),
    };
    const tMesh = Date.now();
    const results = await runTilesInParallel(meshCfg, tiles, (done, total) => {
        const pct = ((done / total) * 100).toFixed(1);
        process.stdout.write(`\r  ${done}/${total} (${pct}%)`);
    }, args.jobs, args.noBundle);
    process.stdout.write('\n');
    console.log(`  meshed ${tiles.length} tiles in ${((Date.now() - tMesh) / 1000).toFixed(1)}s `
        + `after ${((tMesh - t0) / 1000).toFixed(1)}s of setup`);

    for (let i = 0; i < tiles.length; i++) {
        const { z, x, y } = tiles[i];
        const r = results[i];
        if (r === undefined) {
            continue;
        }
        if (r.imagery && r.landColors) {
            accumulateColors(colorHistogram, r.landColors);
        }
        if (r.covered) {
            coveredTiles++;
        }
        if (r.imagery) {
            imageryTiles++;
        }
        if (r.inlandTile) {
            inlandTiles++;
            inlandBodies += r.inlandBodies;
        }
        if (r.riverTile) {
            riverTiles++;
        }
        if (r.landuseTile) {
            landuseTiles++;
            landuseRegions += r.landuseRegions;
        }

        written.push({ z, x, y });
        totalBytes += r.bytesGz;
        totalTris += r.triangleCount;
        riverTriangles += r.riverTriangles;
        maxTris = Math.max(maxTris, r.triangleCount);
        if (r.minLeafSize > 1) {
            coarsenedCoast++;
        }
        leafHistogram.set(r.minLeafSize, (leafHistogram.get(r.minLeafSize) ?? 0) + 1);
        const zs = zoomStats.get(z)
            ?? {
                n: 0, tris: 0, mesh: 0, fill: 0, walls: 0, skirts: 0, water: 0, strokes: 0,
                tallWalls: 0, borderWater: 0, borderWaterTiles: 0, openEdges: 0, openEdgeTiles: 0,
                errs: [], collapsed: 0,
            };
        zs.n++;
        zs.tris += r.triangleCount;
        zs.mesh += r.meshTriangles;
        zs.fill += r.fillTriangles;
        zs.walls += r.wallTriangles;
        zs.skirts += r.skirtTriangles;
        zs.tallWalls += r.tallWallTriangles;
        zs.borderWater += r.borderWaterNodes;
        if (r.borderWaterNodes > 0) {
            zs.borderWaterTiles++;
        }
        zs.openEdges += r.openEdges;
        if (r.openEdges > 0) {
            zs.openEdgeTiles++;
        }
        zs.water += r.waterSheetTriangles;
        zs.strokes += r.strokeTriangles;
        zs.errs.push(r.maxErrorM);
        zs.collapsed += r.collapsedVertices;
        zoomStats.set(z, zs);
    }

    const heightMaxZoom = Math.min(11, src.maxZoom);
    const tCopy = Date.now();
    const heights = copyHeightTiles(args.src, args.out, heightMaxZoom);
    console.log(`height tiles z0..${heightMaxZoom}: ${(heights.bytes / 1048576).toFixed(1)} MB, `
        + `${heights.copied} copied, ${heights.skipped} already current, `
        + `${((Date.now() - tCopy) / 1000).toFixed(1)}s`);

    // Counts from every bake so far, this one included, so the table describes
    // the pyramid rather than the last area added to it.
    saveHistogram(args.out, colorHistogram);
    const swatches = medianCut(colorHistogram, args.swatches);
    const luminance = luminanceWindow(colorHistogram);
    console.log(`cover: ${coveredTiles}/${written.length} tiles, `
        + `${imageryTiles} with real imagery, ${swatches.length} swatches`);
    console.log(`  luminance: mid ${luminance.mid.toFixed(3)}, `
        + `spread ${luminance.spread.toFixed(3)}`);
    if (inlandTiles > 0) {
        console.log(`inland water: ${inlandBodies} bodies across ${inlandTiles} tiles`);
    }
    if (riverTiles > 0) {
        console.log(`watercourses: ${riverTriangles} stroke triangles across ${riverTiles} tiles`);
    }
    if (landuseTiles > 0) {
        console.log(`landuse regions: ${landuseRegions} regions across ${landuseTiles} tiles`);
    }

    // The index has to list every .ptm on disk, not just the ones this run
    // produced. A scoped bake that rewrote it from `written` alone would
    // unlist every other area, and "not in the index" means "ocean, draw a
    // patch" to the runtime - so the rest of the world would quietly flatten.
    const indexPath = path.join(args.out, 'index_mesh.bin');
    const present = new Map<string, TileKey>();
    if (args.bbox !== undefined && fs.existsSync(indexPath)) {
        for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
            present.set(`${k.z}/${k.x}/${k.y}`, k);
        }
    }
    const carried = present.size;
    for (const k of written) {
        present.set(`${k.z}/${k.x}/${k.y}`, k);
    }
    const all = [...present.values()];
    if (carried > 0) {
        console.log(`index: ${written.length} baked + ${carried} carried `
            + `-> ${all.length} tiles`);
    }

    const minZoom = all.length > 0 ? Math.min(...all.map(t => t.z)) : 0;
    const maxWritten = all.length > 0 ? Math.max(...all.map(t => t.z)) : 0;
    fs.writeFileSync(indexPath, encodeTileIndex(all, minZoom, maxWritten));

    // A scoped bake only touched the levels it had tiles on; the carried
    // tiles still have to count toward the per-level maxima, so read their
    // headers back. A carried tile of an older version cannot be mixed with
    // this run's output anyway - the runtime refuses the whole tree.
    // Per-tile figures come from the sidecar where it has them; only the
    // tiles it lacks are decoded. The sidecar is rewritten to cover exactly
    // the tiles in the index, so a deleted area drops out of it too.
    const previousMeta = carried > 0 ? loadIndexMeta(args.out) : {};
    const tileMeta: Record<string, TileMeta> = {};
    for (let i = 0; i < tiles.length; i++) {
        const r = results[i];
        if (r !== undefined) {
            const { z, x, y } = tiles[i];
            tileMeta[`${z}/${x}/${y}`] = {
                geometricErrorM: r.geometricErrorM, skirtDepthM: r.skirtDepthM,
                headerErrorM: r.geometricErrorM,
            };
        }
    }
    let carriedFromMeta = 0;
    let carriedDecoded = 0;
    for (const k of all) {
        const key = `${k.z}/${k.x}/${k.y}`;
        if (tileMeta[key] !== undefined) {
            continue;
        }
        const known = previousMeta[key];
        if (known !== undefined
            && Number.isFinite(known.geometricErrorM) && Number.isFinite(known.skirtDepthM)) {
            tileMeta[key] = known;
            carriedFromMeta++;
        } else {
            const ptmPath = path.join(args.out, String(k.z), String(k.x), `${k.y}.ptm`);
            let tile: ReturnType<typeof decodePtm>;
            try {
                tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
            } catch (err) {
                console.error(`error: carried tile ${key} cannot be read: `
                    + `${(err as Error).message}`);
                console.error('Run a full `npm run bake:mesh` to rebuild the tree.');
                process.exit(1);
            }
            // The header is all that is known here; it is at least the own
            // figure, which is all the fold below needs.
            tileMeta[key] = {
                geometricErrorM: tile.geometricErrorM, skirtDepthM: tile.skirtDepthM,
                headerErrorM: tile.geometricErrorM,
            };
            carriedDecoded++;
        }
    }
    if (carried > 0) {
        console.log(`  carried tile headers: ${carriedFromMeta} from ${INDEX_META_FILE}, `
            + `${carriedDecoded} decoded`);
    }
    // Every tile's figure is known now, so fold them: a parent's header is
    // brought up to the worst tile beneath it, and the per-level maxima are
    // taken over the folded figures. See tools/bake/errorFold.ts.
    const tFold = Date.now();
    const foldStats = newErrorFoldStats();
    const drawnError = foldPtmErrors(args.out, tileMeta, foldStats);
    for (const [key, meta] of Object.entries(tileMeta)) {
        foldLevel(Number(key.split('/')[0]), drawnError.get(key) ?? meta.geometricErrorM, meta.skirtDepthM);
    }
    saveIndexMeta(args.out, tileMeta);
    console.log(`  errors folded in ${((Date.now() - tFold) / 1000).toFixed(1)}s: `
        + `${foldStats.raised} tiles carry a figure from beneath them `
        + `(largest rise ${foldStats.maxRaiseM.toFixed(0)} m), `
        + `${foldStats.rewritten} headers rewritten`);

    const outManifestPath = path.join(args.out, 'manifest.json');
    const previousManifest = fs.existsSync(outManifestPath)
        ? JSON.parse(fs.readFileSync(outManifestPath, 'utf8')) as { texture?: unknown; roads?: unknown; bridges?: unknown }
        : {};
    const carriedTexture = previousManifest.texture;
    const carriedRoads = previousManifest.roads;
    const carriedBridges = previousManifest.bridges;
    if (carriedTexture !== undefined) {
        console.log('texture stream carried from the previous manifest; run `npm run bake:tex` '
            + (args.bbox ? 'with the same --bbox ' : '') + 'to refresh it for the re-meshed tiles');
    }
    if (carriedRoads !== undefined) {
        console.log('road stream carried from the previous manifest; run `npm run bake:road-strokes` '
            + (args.bbox ? 'with the same --bbox ' : '') + 'to drape it over the re-meshed tiles');
    }

    const outManifest = {
        version: 4,
        scheme: 'retro-terrain/1',
        ellipsoid: 'WGS84',
        seaLevel: src.seaLevel ?? 0,
        coverage: src.coverage,
        // Carried through from the height pyramid. `coverage` is the union box
        // of everything baked, which cannot name the individual areas inside
        // it, and naming them is what lets the runtime offer one to fly to.
        areas: src.areas ?? [],
        enuOrigin: { lat: PLAY_ORIGIN.lat, lon: PLAY_ORIGIN.lon, height: PLAY_ORIGIN.height },
        mesh: {
            path: '{z}/{x}/{y}.ptm',
            indexPath: 'index_mesh.bin',
            minZoom,
            maxZoom: maxWritten,
            encoding: 'PTM1',
            transport: 'gzip',
            triangleBudget: args.budget,
            levelGeometricErrorM: Array.from(
                { length: maxWritten + 1 },
                (_, z) => levelError[z] ?? 0,
            ),
            levelSkirtDepthM: Array.from(
                { length: maxWritten + 1 },
                (_, z) => levelSkirt[z] ?? 0,
            ),
            swatches,
            luminance,
        },
        height: {
            path: '{z}/{x}/{y}.pdm',
            indexPath: 'index.bin',
            tileSize: src.tileSize,
            encoding: src.encoding,
            compression: src.compression,
            nodata: src.nodata,
            minZoom: src.minZoom,
            maxZoom: heightMaxZoom,
            queryZoom: heightMaxZoom,
            coarseZoom: 7,
        },
        // The geodetic records, not the working pads built from them: those
        // carry axes resolved in each pad's own ENU frame, and the runtime
        // resolves its own against whichever play area it is flying in.
        flattenPads: padRecords,
        // A pointer, not the descriptions. Every runway, taxiway and apron in
        // the pyramid is an order of magnitude larger than this manifest, and
        // the manifest is fetched before anything can be drawn at all.
        airfields: airfieldsFile === undefined
            ? undefined
            : { path: AIRFIELDS_FILE, count: airfieldsFile.items.length },
        bake: {
            tool: 'bake_planet_mesh',
            version: '1.0.0',
            utc: new Date().toISOString(),
        },
        // The far-tile texture stream is bake_planet_tex.ts's, written after
        // this and described only by its block here. This bake knows nothing
        // about it, so it must not drop it: a re-meshed area keeps its old
        // textures (slightly stale, and drawn) until bake:tex is re-run,
        // rather than losing every texture in the pyramid the moment any
        // area is re-meshed.
        texture: carriedTexture,
        // The road stroke stream, bake_planet_roads.ts's, for the same
        // reason: dropped here, a re-mesh of any area switched roads off for
        // the whole pyramid while every .ptr stayed on disk (2026-09-16).
        roads: carriedRoads,
        // Likewise the bridge geometry stream, bake_planet_bridges.ts's.
        bridges: carriedBridges,
    };
    fs.writeFileSync(
        path.join(args.out, 'manifest.json'),
        `${JSON.stringify(outManifest, null, 2)}\n`,
    );
    if (airfieldsFile !== undefined) {
        const target = path.join(args.out, AIRFIELDS_FILE);
        // Compact, unlike the manifest beside it: this is seven hundred
        // taxiway point arrays that nobody reads by hand, and indenting them
        // costs 600 KB of what the browser has to fetch and parse.
        fs.writeFileSync(target, `${JSON.stringify(airfieldsFile)}\n`);
        const kb = Math.round(fs.statSync(target).size / 1024);
        console.log(`wrote ${airfieldsFile.items.length} airfields to ${target} (${kb} KB)`);
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`wrote ${written.length} tiles, ${(totalBytes / 1048576).toFixed(1)} MB in ${secs}s`);
    if (written.length > 0) {
        console.log(`  triangles: mean ${Math.round(totalTris / written.length)}, max ${maxTris}`);
        console.log(`  mean tile: ${Math.round(totalBytes / written.length / 1024)} KB gzip`);
        const pct = ((coarsenedCoast / written.length) * 100).toFixed(0);
        console.log(`  coast coarsened on ${coarsenedCoast}/${written.length} tiles (${pct}%)`);
        const leaves = [...leafHistogram.entries()].sort((a, b) => a[0] - b[0]);
        console.log(`  shoreline leaf size: `
            + leaves.map(([k, v]) => `${k}cell x${v}`).join(', '));
        // Judge a mesh change on both columns: triangles at the tolerance it
        // settled on, and the tolerance it could afford at the budget.
        // The tolerance is a median: a tile whose coast alone fills the
        // budget settles at a sentinel far above any relief, and one of
        // those swamps a mean.
        for (const [z, zs] of [...zoomStats.entries()].sort((a, b) => a[0] - b[0])) {
            const errs = zs.errs.slice().sort((a, b) => a - b);
            const median = errs[Math.floor(errs.length / 2)];
            const coastOnly = zs.errs.filter(e => e >= 1e9).length;
            const per = (v: number) => Math.round(v / zs.n);
            console.log(`  z${z}: ${zs.n} tiles, mean ${per(zs.tris)} triangles `
                + `(${per(zs.mesh)} surface, ${per(zs.fill)} fill, ${per(zs.walls)} walls, `
                + `${per(zs.skirts)} skirts, ${per(zs.water)} water, ${per(zs.strokes)} strokes), `
                + `median tolerance ${median >= 1e9 ? 'coast-only' : `${median.toFixed(1)} m`}`
                + (coastOnly > 0 ? ` (${coastOnly} coast-only)` : '')
                + `, ${Math.round(zs.collapsed / zs.n)} vertices collapsed per tile`
                + `, ${zs.tallWalls} wall triangles over 150 m`
                + `, ${zs.borderWater} border sea nodes on ${zs.borderWaterTiles} tiles`
                + `, ${zs.openEdges} open edges on ${zs.openEdgeTiles} tiles`);
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
