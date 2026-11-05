/**
 * Bake far-tile cover textures (.ptx) from the finished mesh tree.
 *
 * Reads the .ptm tiles bake_planet_mesh.ts wrote, rasterises every leaf's
 * land facets top-down into a small RGBA image, folds those 2x2 up the
 * quadtree, and writes one gzip-compressed PTX1 sidecar per coarse tile
 * beside its mesh, plus index_tex.bin and a `texture` block in the manifest.
 * The leaf rasters are bake intermediates - the leaf draws its own facets -
 * and live in a cache keyed by each .ptm's size and mtime, so a re-run only
 * re-rasterises the leaves that changed. See docs/terrain-far-textures.md.
 *
 * Runs after the mesh bake, and only the mesh bake: everything a texel needs
 * is already resolved in the leaf's facets.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_tex.ts [options]
 *
 *     --dir DIR        the mesh tree, read and written   (default assets/terrain)
 *     --src DIR        the planet pyramid, for the road vectors (default assets/planet)
 *     --cache DIR      leaf rasters                      (default assets/planet/tex_cache)
 *     --size N         texels across a far tile          (default 256)
 *     --near-size N    texels across a near tile         (default 512)
 *     --near-zoom N    first level counted as near       (default 10)
 *     --min-zoom N     coarsest level that gets one      (default 4)
 *     --no-buildings   leave the .pbh building footprints out of the leaf rasters
 *     --no-airfields   leave the airfield pavement (airfields.json) out of them
 *     --no-roads       leave the roads and railways (.rvr) out of them
 *     --bboxes FILE    many boxes, one w,s,e,n a line, as one run (tools/bake/bboxes.ts)
 *     --bbox w,s,e,n   re-rasterise only the leaves in this box, refold their
 *                      ancestors, and merge the index with what is there
 *     --jobs N         worker threads rasterising leaves (default: CPUs - 1, at most one
 *                      per 1.5 GB of memory; JOBS in the environment sets it too)
 *     --no-bundle      run the worker under tsx instead of an esbuild bundle
 *     --satellites     also hand leaves to satellite machines on the LAN
 *                      (tools/bake/tilePool.ts); with --jobs 0, to them alone
 *     --satellite-port N  their HTTP port (default 47811)
 *     --no-discovery   do not answer the satellites' broadcast (they are given
 *                      the address; leaves the port to another bake)
 */

import { Box, inBoxes, readBboxes, unionOf } from './bake/bboxes';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../src/script/terrain/geodesy';
import { decodePtm } from '../src/script/terrain/ptm';
import { decodePbh } from '../src/script/terrain/pbh';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import {
    PTX_FLAG_WATER, PTX_HEADER_BYTES, boundsOf, decodePtx, emptyRaster, encodePtx, isEmptyRaster,
    mergeQuadrant, paintWater, quadrantOf, rasterizeLeaf, shrinkTo,
} from './bake/coverTex';
import { decodeRvr } from './bake/rvr';
import { AirfieldPavementSource, Pavement, airfieldPavement, overlapsBounds, paintPavement, roadPavement } from './bake/pavementTex';
import { LonLatBounds } from './bake/shoreline';
import { LeafZoomArea, isLeafTile, leafZoomOf } from '../src/script/terrain/leafZoom';
import { TexLeafConfig, TexLeafResult } from './bake/texLeaf';
import { PaintCounts, Raster, TexFoldConfig, TexFoldResult, childrenOf, paintedLeaf, readPtx, writePtx } from './bake/texFold';
import { DEFAULT_SATELLITE_PORT, TilePool } from './bake/tilePool';
import { GB_PER_WORKER, localJobs } from './bake/localJobs';
import { writeManifestBlock } from './bake/manifestBlock';

const WORKER_SOURCE = path.join(__dirname, 'bake', 'texLeafWorker.ts');
const WORKER_BUNDLE = path.join(__dirname, 'bake', '.build', 'texLeafWorker.cjs');
const FOLD_WORKER_SOURCE = path.join(__dirname, 'bake', 'remoteJobWorker.ts');
const FOLD_WORKER_BUNDLE = path.join(__dirname, 'bake', '.build', 'texFoldWorker.cjs');

const DEFAULT_SIZE = 256;
/**
 * The levels just under the leaf cut are the textured tiles drawn nearest
 * the camera - a z11 tile sits right behind the last leaf - and the ones
 * where a texel per pixel is not quite enough. They get a finer raster;
 * everything coarser, which is drawn from much further away, stays at
 * `--size`. A level's size only ever goes up toward the leaf, so folding a
 * child into a coarser parent is one more halving, never an upsample.
 */
const DEFAULT_NEAR_SIZE = 512;
const DEFAULT_NEAR_ZOOM = 10;
/**
 * Coarsest level that gets a texture. The runtime maps a vertex into the
 * raster on the tile's tangent plane with one first-order term for the lon
 * span narrowing toward the pole; the second-order remainder grows with the
 * square of the tile's angular size and is under two texels of 256 at z4
 * (11 degrees), but a dozen at z3. Below z4 the facets stay.
 */
const DEFAULT_MIN_ZOOM = 4;
/**
 * Leaf rasters are drawn at twice their size and box-filtered down: 4x SSAA.
 * Every 256 and 512 texture is folded from these, so all of them get it.
 * Water, roads and airfields are painted onto the cached raster as it is
 * read, each supersampled on its own (paintWater, pavementTex.ts).
 */
const LEAF_SUPERSAMPLE = 2;
const CACHE_META_FILE = 'meta.json';

interface Args {
    dir: string;
    src: string;
    cache: string;
    size: number;
    nearSize: number;
    nearZoom: number;
    minZoom: number;
    buildings: boolean;
    airfields: boolean;
    roads: boolean;
    jobs?: number;
    noBundle: boolean;
    satellitePort?: number;
    noDiscovery?: boolean;
    bbox?: LonLatBounds;
    /** `--bboxes`: the boxes themselves; `bbox` is their union (tools/bake/bboxes.ts). */
    boxes?: Box[];
}

function parseBbox(text: string): LonLatBounds {
    const parts = text.split(',').map(Number);
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
        dir: 'assets/terrain',
        src: 'assets/planet',
        cache: path.join('assets', 'planet', 'tex_cache'),
        noBundle: false,
        size: DEFAULT_SIZE,
        nearSize: DEFAULT_NEAR_SIZE,
        nearZoom: DEFAULT_NEAR_ZOOM,
        minZoom: DEFAULT_MIN_ZOOM,
        buildings: true,
        airfields: true,
        roads: true,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--src') a.src = next();
        else if (k === '--cache') a.cache = next();
        else if (k === '--size') a.size = Number(next());
        else if (k === '--near-size') a.nearSize = Number(next());
        else if (k === '--near-zoom') a.nearZoom = Number(next());
        else if (k === '--min-zoom') a.minZoom = Number(next());
        else if (k === '--no-buildings') a.buildings = false;
        else if (k === '--no-airfields') a.airfields = false;
        else if (k === '--no-roads') a.roads = false;
        else if (k === '--jobs') a.jobs = Math.max(0, Number(next()));
        else if (k === '--no-bundle') a.noBundle = true;
        else if (k === '--satellites') a.satellitePort ??= DEFAULT_SATELLITE_PORT;
        else if (k === '--satellite-port') a.satellitePort = Number(next());
        else if (k === '--no-discovery') a.noDiscovery = true;
        else if (k === '--bboxes') {
            a.boxes = readBboxes(next());
            a.bbox = unionOf(a.boxes);
        }
        else if (k === '--bbox') a.bbox = parseBbox(next());
        else throw new Error(`unknown argument ${k}`);
    }
    for (const [name, v] of [['--size', a.size], ['--near-size', a.nearSize]] as const) {
        if (!Number.isInteger(v) || v < 2 || (v & (v - 1)) !== 0) {
            throw new Error(`${name} must be a power of two, got ${v}`);
        }
    }
    if (a.nearSize < a.size) {
        throw new Error(`--near-size ${a.nearSize} is smaller than --size ${a.size}; a level's size never drops toward the leaf`);
    }
    return a;
}

interface TerrainManifestFile {
    enuOrigin: { lat: number; lon: number; height: number };
    mesh: { path: string; indexPath: string; maxZoom: number; transport?: string };
    texture?: unknown;
    areas?: LeafZoomArea[];
    [key: string]: unknown;
}

/** One leaf raster's provenance, so an unchanged .ptm is not re-rasterised. */
interface CachedLeaf {
    size: number;
    mtimeMs: number;
    texSize: number;
    /** Samples per texel along each axis; absent on a cache from before SSAA. */
    supersample?: number;
    /** The road vectors painted in, `size:mtime`, or absent when there were none. */
    roads?: string;
    /** The .pbh footprints painted in, `size:mtime`, or absent when there were none. */
    buildings?: string;
}

interface CacheMeta {
    version: 1;
    leaves: Record<string, CachedLeaf>;
}

function loadCacheMeta(dir: string): CacheMeta['leaves'] {
    const p = path.join(dir, CACHE_META_FILE);
    if (!fs.existsSync(p)) {
        return {};
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as CacheMeta;
        return parsed.version === 1 && typeof parsed.leaves === 'object' ? parsed.leaves : {};
    } catch {
        return {};
    }
}

function saveCacheMeta(dir: string, leaves: CacheMeta['leaves']): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CACHE_META_FILE), JSON.stringify({ version: 1, leaves }));
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const tilePath = (dir: string, k: TileKey, ext: string) =>
    path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

async function prepareWorker(noBundle: boolean, source = WORKER_SOURCE, bundle = WORKER_BUNDLE): Promise<{ file: string; execArgv: string[] }> {
    if (!noBundle) {
        try {
            const esbuild = await import('esbuild');
            fs.mkdirSync(path.dirname(bundle), { recursive: true });
            await esbuild.build({
                entryPoints: [source], outfile: bundle, bundle: true, platform: 'node', format: 'cjs',
                target: `node${process.versions.node.split('.')[0]}`, logLevel: 'silent',
            });
            return { file: bundle, execArgv: [] };
        } catch (err) {
            console.warn(`warning: could not bundle the texture worker (${(err as Error).message}); running it under tsx`);
        }
    }
    return { file: source, execArgv: process.execArgv };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();

    const manifestPath = path.join(args.dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`error: no manifest at ${manifestPath}; run npm run bake:mesh first`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TerrainManifestFile;
    const leafZoom = manifest.mesh.maxZoom;
    // An area capped short of it has its leaves at its own zoom (leafZoom.ts):
    // rasterised like any leaf, folded into its parents, never a parent itself.
    const leafZoomAt = leafZoomOf(manifest.areas, leafZoom);
    const isLeaf = (k: TileKey) => isLeafTile(leafZoomAt, k);
    const basis = makeEnuBasis(manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height);
    const meshIndexPath = path.join(args.dir, manifest.mesh.indexPath ?? 'index_mesh.bin');
    const meshTiles = decodeTileIndex(fs.readFileSync(meshIndexPath));
    const meshByLevel = new Map<number, TileKey[]>();
    for (const k of meshTiles) {
        let list = meshByLevel.get(k.z);
        if (!list) {
            meshByLevel.set(k.z, list = []);
        }
        list.push(k);
    }
    const inScope = (k: TileKey) => args.bbox === undefined || (overlaps(boundsOf(k), args.bbox) && inBoxes(boundsOf(k), args.boxes));
    const sizeAt = (z: number) => (z >= args.nearZoom ? args.nearSize : args.size);
    // Leaves are rasterised at the finest size any parent wants.
    const leafSize = Math.max(args.size, args.nearSize);

    // --- leaves: rasterise into the cache -----------------------------------
    const leaves = meshTiles.filter(k => isLeaf(k) && inScope(k));
    const cacheMeta = loadCacheMeta(args.cache);
    console.log(`bake_planet_tex: ${leaves.length} leaves, z${leafZoom} unless capped, `
        + `${args.nearSize} texels from z${args.nearZoom}, ${args.size} below, `
        + `${LEAF_SUPERSAMPLE * LEAF_SUPERSAMPLE}x SSAA, `
        + `textures z${args.minZoom}..z${leafZoom - 1}${args.bbox ? ' (scoped)' : ''}`);
    // The leaves whose raster is stale go to the tile pool (texLeaf.ts); the
    // cache's meta is this process's alone, written once they are back.
    let fromCache = 0;
    let missing = 0;
    const todo: TileKey[] = [];
    const pending = new Map<string, CachedLeaf>();
    for (const k of leaves) {
        const ptmPath = tilePath(args.dir, k, '.ptm');
        if (!fs.existsSync(ptmPath)) {
            missing++;
            continue;
        }
        const st = fs.statSync(ptmPath);
        const key = keyOf(k);
        const known = cacheMeta[key];
        const cachePath = tilePath(args.cache, k, '.ptx');
        // Leaf rasters hold ground and buildings only; water, roads and
        // airfields go on as the raster is read (leafRaster). A cache entry
        // from a bake that drew one-texel roads into it carries a `roads`
        // key and is re-rasterised clean.
        const pbhPath = tilePath(args.dir, k, '.pbh');
        const pbhStat = args.buildings && fs.existsSync(pbhPath) ? fs.statSync(pbhPath) : undefined;
        const pbhSig = pbhStat ? `${pbhStat.size}:${pbhStat.mtimeMs}` : undefined;
        if (known && known.size === st.size && known.mtimeMs === st.mtimeMs
            && known.texSize === leafSize && (known.supersample ?? 1) === LEAF_SUPERSAMPLE
            && known.roads === undefined
            && known.buildings === pbhSig && fs.existsSync(cachePath)) {
            fromCache++;
        } else {
            todo.push(k);
            pending.set(key, { size: st.size, mtimeMs: st.mtimeMs, texSize: leafSize, supersample: LEAF_SUPERSAMPLE, buildings: pbhSig });
        }
    }
    let rasterised = 0;
    if (todo.length > 0) {
        const cfg: TexLeafConfig = {
            dir: args.dir, cache: args.cache, enuOrigin: manifest.enuOrigin, leafSize, supersample: LEAF_SUPERSAMPLE, buildings: args.buildings,
        };
        const jobs = Math.max(args.satellitePort ? 0 : 1, Math.min(args.jobs ?? localJobs(GB_PER_WORKER.tex), todo.length));
        const pool = new TilePool<TexLeafResult>({
            local: { ...await prepareWorker(args.noBundle), jobs }, cfg, kindOf: () => 'texleaf',
            roots: { terrain: args.dir, texcache: args.cache },
            satellites: args.satellitePort ? { port: args.satellitePort, discovery: !args.noDiscovery } : undefined,
            diskLow: () => false, label: () => 'leaves ', t0,
        });
        await pool.start();
        const { results, errors } = await pool.runPass(todo, 1);
        await pool.close();
        for (const r of results) {
            if (r?.rasterised) {
                cacheMeta[r.key] = pending.get(r.key)!;
                rasterised++;
            }
        }
        if (errors.length > 0) {
            saveCacheMeta(args.cache, cacheMeta);
            for (const e of errors.slice(0, 10)) {
                console.error(`error: ${e}`);
            }
            throw new Error(`${errors.length} leaves failed to rasterise`);
        }
    }
    saveCacheMeta(args.cache, cacheMeta);
    console.log(`  rasterised ${rasterised}, cached ${fromCache}`
        + (missing > 0 ? `, ${missing} listed but absent` : ''));

    // --- pavement -----------------------------------------------------------
    // Roads and airfields are painted into each leaf as it is read, after the
    // water and like it, so a change to them needs no leaf re-rasterised
    // (tools/bake/pavementTex.ts). At true width, supersampled; the fold
    // carries them to every level.
    const airfieldsBlock = manifest.airfields as { path?: string } | undefined;
    const airfieldsPath = path.join(args.dir, airfieldsBlock?.path ?? 'airfields.json');
    const pavements: Pavement[] = [];
    if (args.airfields && fs.existsSync(airfieldsPath)) {
        const file = JSON.parse(fs.readFileSync(airfieldsPath, 'utf8')) as { items?: AirfieldPavementSource[] };
        for (const item of file.items ?? []) {
            const p = airfieldPavement(item);
            if (p !== undefined) {
                pavements.push(p);
            }
        }
    }
    console.log(`  airfield pavement: ${pavements.length} fields`);
    const leafKeys = new Set(leaves.map(keyOf));
    const shipsLeaf = (k: TileKey) => args.buildings && leafKeys.has(keyOf(k)) && fs.existsSync(tilePath(args.dir, k, '.pbh'));
    const leafDone = new Set<string>();
    const leafShipped: TileKey[] = [];
    const leafShippedKeys = new Set<string>();
    let leafGz = 0;
    const shipLeaf = (k: TileKey, texels: Uint8Array, size: number) => {
        leafDone.add(keyOf(k));
        if (!isEmptyRaster(texels)) {
            leafGz += writePtx(tilePath(args.dir, k, '.ptx'), k, size, texels);
            leafShipped.push(k);
            leafShippedKeys.add(keyOf(k));
        }
    };

    // --- the pyramid --------------------------------------------------------
    // A level's rasters are kept only until its parents are folded. A child
    // outside a scoped run's box is read back from its .ptx on disk, or from
    // the leaf cache, so the parent still sees all four quadrants.
    const counts: PaintCounts = { water: 0, roads: 0, airfields: 0 };
    const leafRaster = (k: TileKey): Raster | undefined => {
        const r = paintedLeaf(args, basis, k, args.roads, pavements, counts);
        if (r !== undefined && shipsLeaf(k) && !leafDone.has(keyOf(k))) {
            shipLeaf(k, r.texels, r.size);
        }
        return r;
    };
    let previous = new Map<string, Raster>();
    const written: TileKey[] = [];
    const emptied: TileKey[] = [];
    const perLevel: Array<{ z: number; size: number; count: number; raw: number; gz: number }> = [];
    // The parents of leaves read and paint four leaf rasters each - nearly
    // all the bake's time - so they go to the tile pool (texFold.ts); they
    // write their .ptx, and the next level reads it back from disk.
    const foldCfg: TexFoldConfig = {
        dir: args.dir, cache: args.cache, src: args.src, enuOrigin: manifest.enuOrigin,
        leafZoom, areas: manifest.areas, size: args.size, nearSize: args.nearSize, nearZoom: args.nearZoom,
        buildings: args.buildings, roads: args.roads, pavements,
    };
    let foldPool: TilePool<TexFoldResult> | undefined;
    for (let z = leafZoom - 1; z >= args.minZoom; z--) {
        const current = new Map<string, Raster>();
        const all = (meshByLevel.get(z) ?? []).filter(k => inScope(k) && !isLeaf(k));
        const size = sizeAt(z);
        let raw = 0;
        let gz = 0;
        let count = 0;
        const pooled = all.filter(k => childrenOf(k).some(isLeaf));
        const parents = all.filter(k => !childrenOf(k).some(isLeaf));
        if (pooled.length > 0) {
            if (!foldPool) {
                const jobs = Math.max(args.satellitePort ? 0 : 1, args.jobs ?? localJobs(GB_PER_WORKER.tex));
                foldPool = new TilePool<TexFoldResult>({
                    local: { ...await prepareWorker(args.noBundle, FOLD_WORKER_SOURCE, FOLD_WORKER_BUNDLE), jobs, workerData: { kind: 'texfold', cfg: foldCfg } },
                    cfg: foldCfg, kindOf: () => 'texfold',
                    roots: { terrain: args.dir, texcache: args.cache, planet: args.src },
                    satellites: args.satellitePort ? { port: args.satellitePort, discovery: !args.noDiscovery } : undefined,
                    diskLow: () => false, label: () => `z${z} fold `, t0,
                });
                await foldPool.start();
            }
            const { results, errors } = await foldPool.runPass(pooled, 1);
            if (errors.length > 0) {
                await foldPool.close();
                for (const e of errors.slice(0, 10)) {
                    console.error(`error: ${e}`);
                }
                throw new Error(`${errors.length} z${z} tiles failed to fold`);
            }
            const byKey = new Map(pooled.map(k => [keyOf(k), k]));
            for (const r of results) {
                if (!r) {
                    continue;
                }
                const k = byKey.get(r.key)!;
                counts.water += r.counts.water;
                counts.roads += r.counts.roads;
                counts.airfields += r.counts.airfields;
                for (const l of r.leaves) {
                    leafDone.add(l);
                }
                for (const sh of r.shipped) {
                    const [lz, lx, ly] = sh.key.split('/').map(Number);
                    leafGz += sh.gz;
                    leafShipped.push({ z: lz, x: lx, y: ly });
                    leafShippedKeys.add(sh.key);
                }
                if (r.emptied) {
                    const outPath = tilePath(args.dir, k, '.ptx');
                    if (fs.existsSync(outPath)) {
                        fs.unlinkSync(outPath);
                    }
                    emptied.push(k);
                } else {
                    gz += r.gz;
                    raw += r.raw;
                    count++;
                    written.push(k);
                }
            }
        }
        for (const k of parents) {
            const parent = emptyRaster(size);
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const child: TileKey = { z: z + 1, x: k.x * 2 + dx, y: k.y * 2 + dy };
                    const childKey = keyOf(child);
                    let raster = previous.get(childKey);
                    if (raster === undefined) {
                        raster = isLeaf(child)
                            ? leafRaster(child)
                            // A shipped child: a scoped run folds these for
                            // siblings outside its box.
                            : readPtx(tilePath(args.dir, child, '.ptx'));
                    }
                    if (raster === undefined) {
                        continue;
                    }
                    const { qx, qy } = quadrantOf(child);
                    mergeQuadrant(parent, size, shrinkTo(raster.texels, raster.size, size / 2), qx, qy);
                }
            }
            const outPath = tilePath(args.dir, k, '.ptx');
            if (isEmptyRaster(parent)) {
                // Nothing under it was baked to the leaf: no sidecar, and the
                // runtime keeps painting the facets. Drop a stale one.
                if (fs.existsSync(outPath)) {
                    fs.unlinkSync(outPath);
                }
                emptied.push(k);
                continue;
            }
            current.set(keyOf(k), { texels: parent, size });
            gz += writePtx(outPath, k, size, parent);
            raw += PTX_HEADER_BYTES + parent.byteLength;
            count++;
            written.push(k);
        }
        perLevel.push({ z, size, count, raw, gz });
        previous = current;
    }
    await foldPool?.close();

    // --- sparse leaf textures -----------------------------------------------
    // Leaves that carry buildings also ship their raster: their own facets and
    // 3D houses cover the near field, this the far field where the houses are
    // cut. Every other leaf has none, and drops a stale one. Most were
    // shipped already, as the fold read them (shipLeaf).
    const leafDropped: TileKey[] = [];
    for (const k of leaves) {
        if (shipsLeaf(k) && !leafDone.has(keyOf(k))) {
            // leafRaster ships it; absent from the cache, it stays unshipped.
            leafRaster(k);
        }
        const leafOut = tilePath(args.dir, k, '.ptx');
        if (!leafShippedKeys.has(keyOf(k)) && fs.existsSync(leafOut)) {
            fs.unlinkSync(leafOut);
            leafDropped.push(k);
        }
    }
    console.log(`  leaf textures: ${leafShipped.length} shipped (${(leafGz / 1048576).toFixed(1)} MB gz), ${leafDropped.length} dropped; water painted in ${counts.water} leaf reads, airfields in ${counts.airfields}, roads in ${counts.roads}`);

    // --- index and manifest -------------------------------------------------
    const indexPath = path.join(args.dir, 'index_tex.bin');
    const present = new Map<string, TileKey>();
    if (args.bbox !== undefined && fs.existsSync(indexPath)) {
        for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
            present.set(keyOf(k), k);
        }
    }
    const carried = present.size;
    for (const k of emptied) {
        present.delete(keyOf(k));
    }
    for (const k of written) {
        present.set(keyOf(k), k);
    }
    for (const k of leafDropped) {
        present.delete(keyOf(k));
    }
    for (const k of leafShipped) {
        present.set(keyOf(k), k);
    }
    const all = [...present.values()];
    const maxZoom = leafZoom - 1;
    const hasLeaves = all.some(isLeaf);
    fs.writeFileSync(indexPath, encodeTileIndex(all, args.minZoom, hasLeaves ? leafZoom : maxZoom));

    manifest.texture = {
        path: '{z}/{x}/{y}.ptx',
        indexPath: 'index_tex.bin',
        encoding: 'PTX1',
        transport: 'gzip',
        size: args.size,
        nearSize: args.nearSize,
        nearZoom: args.nearZoom,
        minZoom: args.minZoom,
        maxZoom,
        ...(hasLeaves ? { leafZoom } : {}),
    };
    writeManifestBlock(manifestPath, 'texture', manifest.texture);

    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log('  level  texels  tiles   raw MB    gz MB');
    let totalRaw = 0;
    let totalGz = 0;
    for (const l of perLevel) {
        console.log(`  z${String(l.z).padEnd(4)} ${String(l.size).padStart(7)} ${String(l.count).padStart(6)} ${mb(l.raw).padStart(8)} ${mb(l.gz).padStart(8)}`);
        totalRaw += l.raw;
        totalGz += l.gz;
    }
    console.log(`  total          ${String(written.length).padStart(6)} ${mb(totalRaw).padStart(8)} ${mb(totalGz).padStart(8)}`);
    if (carried > 0) {
        console.log(`index: ${written.length} baked + ${carried} carried `
            + `- ${emptied.length} emptied -> ${all.length} tiles`);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`wrote ${written.length} textures, ${mb(totalGz)} MB in ${secs}s`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
