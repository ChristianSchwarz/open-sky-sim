/**
 * Bake road stroke sidecars (.ptr) from the finished mesh tree and the road
 * vectors tools/bake_osm_roads.py wrote.
 *
 * For every mesh tile that has a .rvr beside its .pdm, reads the .ptm, drapes
 * the roads over its drawn facets (tools/bake/drapeRoads.ts) and writes one
 * gzip-compressed PTR1 beside the mesh, plus index_roads.bin and a `roads`
 * block in the manifest. A tile with no road vectors gets no sidecar, and a
 * stale one is dropped.
 *
 * Runs after the mesh bake and after the road bake, and reads only what
 * they wrote: nothing about a mesh changes, which is the point of roads
 * being a sidecar - widths, class cuts and the vertex cap can all be
 * re-tuned by re-running this alone.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_roads.ts [options]
 *
 *     --dir DIR        the mesh tree, read and written   (default assets/terrain)
 *     --src DIR        the planet pyramid with the .rvr  (default assets/planet)
 *     --max-verts N    stroke vertices per leaf tile     (default 16384)
 *     --bbox w,s,e,n   only tiles in this box; the index is merged with what
 *                      is there
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../src/script/terrain/geodesy';
import { decodePtm } from '../src/script/terrain/ptm';
import { PTR_MAX_VERTS, encodePtr } from '../src/script/terrain/ptr';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { boundsOf } from './bake/coverTex';
import { drapeRoads } from './bake/drapeRoads';
import { decodeRvr } from './bake/rvr';
import { LonLatBounds } from './bake/shoreline';

/**
 * Stroke vertices a leaf may carry: 8k centreline points, or roughly 16k
 * triangles laid over a 6k-triangle mesh. A city leaf wants more - Berlin
 * runs to 11 km of road per km^2 - and the excess is residential streets,
 * which are what the class ordering drops first.
 */
const DEFAULT_MAX_VERTS = 16384;

interface Args {
    dir: string;
    src: string;
    maxVerts: number;
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
    const a: Args = { dir: 'assets/terrain', src: 'assets/planet', maxVerts: DEFAULT_MAX_VERTS };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--src') a.src = next();
        else if (k === '--max-verts') a.maxVerts = Number(next());
        else if (k === '--bbox') a.bbox = parseBbox(next());
        else throw new Error(`unknown argument ${k}`);
    }
    if (!Number.isInteger(a.maxVerts) || a.maxVerts < 4 || a.maxVerts > PTR_MAX_VERTS) {
        throw new Error(`--max-verts must be 4..${PTR_MAX_VERTS}, got ${a.maxVerts}`);
    }
    return a;
}

interface TerrainManifestFile {
    enuOrigin: { lat: number; lon: number; height: number };
    mesh: { indexPath: string; minZoom: number; maxZoom: number; triangleBudget?: number };
    roads?: unknown;
    [key: string]: unknown;
}

interface PlanetManifestFile {
    roads?: { path: string; minZoom: number };
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const tilePath = (dir: string, k: TileKey, ext: string) =>
    path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();

    const manifestPath = path.join(args.dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`error: no manifest at ${manifestPath}; run npm run bake:mesh first`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TerrainManifestFile;
    const planetManifestPath = path.join(args.src, 'manifest.json');
    const planet = fs.existsSync(planetManifestPath)
        ? JSON.parse(fs.readFileSync(planetManifestPath, 'utf8')) as PlanetManifestFile
        : {};
    if (!planet.roads) {
        console.error(`error: ${planetManifestPath} has no roads block; run npm run bake:roads first`);
        process.exit(1);
    }
    const leafZoom = manifest.mesh.maxZoom;
    const minZoom = Math.max(planet.roads.minZoom, manifest.mesh.minZoom);
    const basis = makeEnuBasis(manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height);
    const meshTiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.mesh.indexPath ?? 'index_mesh.bin')));
    const inScope = (k: TileKey) => k.z >= minZoom && k.z <= leafZoom
        && (args.bbox === undefined || overlaps(boundsOf(k), args.bbox));
    const tiles = meshTiles.filter(inScope);
    // A coarse tile is drawn from far enough away that its strokes get the
    // mesh budget's worth of vertices and no more, as the rivers do.
    const budget = manifest.mesh.triangleBudget ?? DEFAULT_MAX_VERTS;
    const capFor = (z: number) => (z >= leafZoom ? args.maxVerts : Math.min(args.maxVerts, budget));

    console.log(`bake_planet_roads: ${tiles.length} mesh tiles z${minZoom}..z${leafZoom}`
        + `${args.bbox ? ' (scoped)' : ''}, ${args.maxVerts} vertices per leaf`);

    const written: TileKey[] = [];
    const emptied: TileKey[] = [];
    const perLevel = new Map<number, { tiles: number; roads: number; strokes: number; dropped: number; tris: number; gz: number }>();
    let lastLine = 0;
    for (let i = 0; i < tiles.length; i++) {
        const k = tiles[i];
        const outPath = tilePath(args.dir, k, '.ptr');
        const rvrPath = tilePath(args.src, k, '.rvr');
        const ptmPath = tilePath(args.dir, k, '.ptm');
        let level = perLevel.get(k.z);
        if (!level) {
            perLevel.set(k.z, level = { tiles: 0, roads: 0, strokes: 0, dropped: 0, tris: 0, gz: 0 });
        }
        let draped;
        let tile;
        if (fs.existsSync(rvrPath) && fs.existsSync(ptmPath)) {
            const roads = decodeRvr(fs.readFileSync(rvrPath));
            tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
            level.roads += roads.length;
            draped = drapeRoads(tile, basis, roads, capFor(k.z), k.z >= leafZoom);
        }
        if (draped === undefined || tile === undefined) {
            if (fs.existsSync(outPath)) {
                fs.unlinkSync(outPath);
            }
            emptied.push(k);
        } else {
            const bytes = encodePtr({
                id: k, quantScale: tile.quantScale, positions: draped.positions, directions: draped.directions,
                halfWidthsM: draped.halfWidthsM, classes: draped.classes, indices: draped.indices,
            });
            const gz = zlib.gzipSync(bytes, { level: 9 });
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, gz);
            written.push(k);
            level.tiles++;
            level.strokes += draped.strokes;
            level.dropped += draped.dropped;
            level.tris += draped.triangles;
            level.gz += gz.byteLength;
        }
        if (Date.now() - lastLine > 500 || i === tiles.length - 1) {
            process.stdout.write(`\r  ${i + 1}/${tiles.length} (${((i + 1) / tiles.length * 100).toFixed(1)}%)`);
            lastLine = Date.now();
        }
    }
    process.stdout.write('\n');

    // --- index and manifest -------------------------------------------------
    const indexPath = path.join(args.dir, 'index_roads.bin');
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
    fs.writeFileSync(indexPath, encodeTileIndex(all, minZoom, leafZoom));
    manifest.roads = {
        path: '{z}/{x}/{y}.ptr',
        indexPath: 'index_roads.bin',
        encoding: 'PTR1',
        transport: 'gzip',
        minZoom,
        maxZoom: leafZoom,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const mb = (n: number) => (n / 1048576).toFixed(1);
    console.log('  level  tiles   runs  strokes dropped   tris/tile   gz MB');
    let totalGz = 0;
    for (const z of [...perLevel.keys()].sort((a, b) => a - b)) {
        const l = perLevel.get(z)!;
        const perTile = l.tiles > 0 ? Math.round(l.tris / l.tiles) : 0;
        console.log(`  z${String(z).padEnd(4)} ${String(l.tiles).padStart(6)} ${String(l.roads).padStart(6)}`
            + ` ${String(l.strokes).padStart(8)} ${String(l.dropped).padStart(7)} ${String(perTile).padStart(11)} ${mb(l.gz).padStart(7)}`);
        totalGz += l.gz;
    }
    if (carried > 0) {
        console.log(`index: ${written.length} baked + ${carried} carried - ${emptied.length} emptied -> ${all.length} tiles`);
    }
    console.log(`wrote ${written.length} road sidecars, ${mb(totalGz)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
