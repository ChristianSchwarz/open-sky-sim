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
 *     --cache DIR      leaf rasters                      (default assets/planet/tex_cache)
 *     --size N         texels across a far tile          (default 256)
 *     --near-size N    texels across a near tile         (default 512)
 *     --near-zoom N    first level counted as near       (default 10)
 *     --min-zoom N     coarsest level that gets one      (default 4)
 *     --bbox w,s,e,n   re-rasterise only the leaves in this box, refold their
 *                      ancestors, and merge the index with what is there
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../src/script/terrain/geodesy';
import { decodePtm } from '../src/script/terrain/ptm';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import {
    PTX_HEADER_BYTES, boundsOf, decodePtx, emptyRaster, encodePtx, isEmptyRaster,
    mergeQuadrant, quadrantOf, rasterizeLeaf, shrinkTo,
} from './bake/coverTex';
import { LonLatBounds } from './bake/shoreline';

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
const CACHE_META_FILE = 'meta.json';

interface Args {
    dir: string;
    cache: string;
    size: number;
    nearSize: number;
    nearZoom: number;
    minZoom: number;
    bbox?: LonLatBounds;
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
        cache: path.join('assets', 'planet', 'tex_cache'),
        size: DEFAULT_SIZE,
        nearSize: DEFAULT_NEAR_SIZE,
        nearZoom: DEFAULT_NEAR_ZOOM,
        minZoom: DEFAULT_MIN_ZOOM,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--cache') a.cache = next();
        else if (k === '--size') a.size = Number(next());
        else if (k === '--near-size') a.nearSize = Number(next());
        else if (k === '--near-zoom') a.nearZoom = Number(next());
        else if (k === '--min-zoom') a.minZoom = Number(next());
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
    [key: string]: unknown;
}

/** One leaf raster's provenance, so an unchanged .ptm is not re-rasterised. */
interface CachedLeaf {
    size: number;
    mtimeMs: number;
    texSize: number;
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

interface Raster {
    texels: Uint8Array;
    size: number;
}

function readPtx(p: string): Raster | undefined {
    if (!fs.existsSync(p)) {
        return undefined;
    }
    const { texels, size } = decodePtx(zlib.gunzipSync(fs.readFileSync(p)));
    return { texels, size };
}

function writePtx(p: string, id: TileKey, size: number, texels: Uint8Array): number {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const gz = zlib.gzipSync(encodePtx(id, size, texels), { level: 9 });
    fs.writeFileSync(p, gz);
    return gz.byteLength;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();

    const manifestPath = path.join(args.dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`error: no manifest at ${manifestPath}; run npm run bake:mesh first`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TerrainManifestFile;
    const leafZoom = manifest.mesh.maxZoom;
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
    const inScope = (k: TileKey) => args.bbox === undefined || overlaps(boundsOf(k), args.bbox);
    const sizeAt = (z: number) => (z >= args.nearZoom ? args.nearSize : args.size);
    // Leaves are rasterised at the finest size any parent wants.
    const leafSize = Math.max(args.size, args.nearSize);

    // --- leaves: rasterise into the cache -----------------------------------
    const leaves = (meshByLevel.get(leafZoom) ?? []).filter(inScope);
    const cacheMeta = loadCacheMeta(args.cache);
    console.log(`bake_planet_tex: ${leaves.length} leaves at z${leafZoom}, `
        + `${args.nearSize} texels from z${args.nearZoom}, ${args.size} below, `
        + `textures z${args.minZoom}..z${leafZoom - 1}${args.bbox ? ' (scoped)' : ''}`);
    let rasterised = 0;
    let fromCache = 0;
    let missing = 0;
    let lastLine = 0;
    for (let i = 0; i < leaves.length; i++) {
        const k = leaves[i];
        const ptmPath = tilePath(args.dir, k, '.ptm');
        if (!fs.existsSync(ptmPath)) {
            missing++;
            continue;
        }
        const st = fs.statSync(ptmPath);
        const key = keyOf(k);
        const known = cacheMeta[key];
        const cachePath = tilePath(args.cache, k, '.ptx');
        if (known && known.size === st.size && known.mtimeMs === st.mtimeMs
            && known.texSize === leafSize && fs.existsSync(cachePath)) {
            fromCache++;
        } else {
            const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
            const raster = rasterizeLeaf(tile, basis, leafSize);
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            // Lightly compressed: a megabyte of mostly flat colour per leaf
            // shrinks twentyfold, and the cache holds thousands of them.
            fs.writeFileSync(cachePath, zlib.gzipSync(encodePtx(k, leafSize, raster), { level: 1 }));
            cacheMeta[key] = { size: st.size, mtimeMs: st.mtimeMs, texSize: leafSize };
            rasterised++;
        }
        if (Date.now() - lastLine > 500 || i === leaves.length - 1) {
            process.stdout.write(`\r  leaves ${i + 1}/${leaves.length}`);
            lastLine = Date.now();
        }
    }
    saveCacheMeta(args.cache, cacheMeta);
    console.log(`\n  rasterised ${rasterised}, cached ${fromCache}`
        + (missing > 0 ? `, ${missing} listed but absent` : ''));

    // --- the pyramid --------------------------------------------------------
    // A level's rasters are kept only until its parents are folded. A child
    // outside a scoped run's box is read back from its .ptx on disk, or from
    // the leaf cache, so the parent still sees all four quadrants.
    const leafRaster = (k: TileKey): Raster | undefined => {
        const p = tilePath(args.cache, k, '.ptx');
        if (!fs.existsSync(p)) {
            return undefined;
        }
        const bytes = fs.readFileSync(p);
        // A cache written before it was compressed is still readable.
        const { texels, size } = decodePtx(bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : bytes);
        return { texels, size };
    };
    let previous = new Map<string, Raster>();
    const written: TileKey[] = [];
    const emptied: TileKey[] = [];
    const perLevel: Array<{ z: number; size: number; count: number; raw: number; gz: number }> = [];
    for (let z = leafZoom - 1; z >= args.minZoom; z--) {
        const current = new Map<string, Raster>();
        const parents = (meshByLevel.get(z) ?? []).filter(inScope);
        const size = sizeAt(z);
        let raw = 0;
        let gz = 0;
        let count = 0;
        for (const k of parents) {
            const parent = emptyRaster(size);
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const child: TileKey = { z: z + 1, x: k.x * 2 + dx, y: k.y * 2 + dy };
                    const childKey = keyOf(child);
                    let raster = previous.get(childKey);
                    if (raster === undefined) {
                        raster = child.z === leafZoom
                            ? leafRaster(child)
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
    const all = [...present.values()];
    const maxZoom = leafZoom - 1;
    fs.writeFileSync(indexPath, encodeTileIndex(all, args.minZoom, maxZoom));

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
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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

main();
