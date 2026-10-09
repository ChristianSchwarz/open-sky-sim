/**
 * Bake the building sidecars (.pbh) of every leaf mesh tile from the OSM
 * footprints tools/bake_osm_buildings.py wrote into the planet pyramid.
 *
 * Per leaf: each .bvr building is put into the tile's true local frame
 * (tools/bake/tileSurface.ts), given a height, roof and colours from its
 * tags or the rules in tools/bake/buildingPlan.ts, and stood on the ground
 * the finished .ptm draws - which is why this runs after the mesh (and the
 * grading) and has to run again after either. Records go out most prominent
 * first so the runtime can draw a far tile as a prefix.
 *
 * Writes {dir}/12/x/y.pbh (gzip), index_buildings.bin and the manifest's
 * `buildings` block. Design: docs/terrain-buildings.md.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_buildings.ts [--bbox w,s,e,n] [--dir assets/terrain] [--src assets/planet]
 *     [--colour-store data/imports/buildings/store | --no-colours]
 *     [--shape-store data/imports/buildings/shape | --no-shapes] [--surface-forms]
 *     [--lod2-store data/imports/buildings/lod2 | --no-lod2]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { buildingTriangles } from '../src/script/terrain/buildingRoofs';
import { makeEnuBasis } from '../src/script/terrain/geodesy';
import { PBH_FLAG_NO_WALLS, encodePbh } from '../src/script/terrain/pbh';
import { decodePtm } from '../src/script/terrain/ptm';
import { tileBounds } from '../src/script/terrain/tiling';
import { PlannedBuilding, Ring, planBuilding } from './bake/buildingPlan';
import { DEFAULT_COLOUR_STORE, readMeasuredRoofs } from './bake/buildingColourStore';
import { DEFAULT_LOD2_STORE, readLod2 } from './bake/buildingLod2Store';
import { DEFAULT_SHAPE_STORE, readMeasuredShapes } from './bake/buildingShapeStore';
import { decodeBvr } from './bake/bvr';
import { boundsOf } from './bake/coverTex';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { LonLatBounds } from './bake/shoreline';
import { tileSurface } from './bake/tileSurface';

interface Args {
    dir: string;
    src: string;
    bbox?: LonLatBounds;
    /** Roof colours measured in orthophotos (tools/measure_buildings.py); undefined = none. */
    colours?: string;
    /** Roof shapes fitted to surface models (tools/measure_roof_shapes.py); undefined = none. */
    shapes?: string;
    /** Take the fitted roof forms too, not only heights and ridge directions. */
    surfaceForms: boolean;
    /** Official LoD2 models matched to the footprints (tools/import_lod2.py); undefined = none. */
    lod2?: string;
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

function parseArgs(argv: string[]): Args {
    const a: Args = { dir: 'assets/terrain', src: 'assets/planet', colours: DEFAULT_COLOUR_STORE, shapes: DEFAULT_SHAPE_STORE, surfaceForms: false, lod2: DEFAULT_LOD2_STORE };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--src') a.src = next();
        else if (k === '--bbox') a.bbox = parseBbox(next());
        else if (k === '--colour-store') a.colours = next();
        else if (k === '--no-colours') a.colours = undefined;
        else if (k === '--shape-store') a.shapes = next();
        else if (k === '--no-shapes') a.shapes = undefined;
        else if (k === '--surface-forms') a.surfaceForms = true;
        else if (k === '--lod2-store') a.lod2 = next();
        else if (k === '--no-lod2') a.lod2 = undefined;
        else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

function overlaps(a: LonLatBounds, b: LonLatBounds): boolean {
    return !(a.east <= b.west || a.west >= b.east || a.north <= b.south || a.south >= b.north);
}

interface TerrainManifestFile {
    enuOrigin: { lat: number; lon: number; height: number };
    mesh: { indexPath: string; minZoom: number; maxZoom: number };
    buildings?: unknown;
    [key: string]: unknown;
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const tilePath = (dir: string, k: TileKey, ext: string) => path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

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
    const meshTiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.mesh.indexPath ?? 'index_mesh.bin')));
    const tiles = meshTiles.filter(k => k.z === leafZoom && (args.bbox === undefined || overlaps(boundsOf(k), args.bbox)));
    console.log(`bake_planet_buildings: ${tiles.length} leaf tiles${args.bbox ? ' (scoped)' : ''}`);

    const written: TileKey[] = [];
    const emptied: TileKey[] = [];
    const sources = { lod2: 0, surface: 0, height: 0, levels: 0, default: 0 };
    const formSources = { lod2: 0, surface: 0, tag: 0, rules: 0 };
    let leavesLod2 = 0;
    let lod2Added = 0;
    let shapesAbsent = 0;
    let leavesShaped = 0;
    let roofsMeasured = 0;
    let leavesMeasured = 0;
    let read = 0, kept = 0, tris = 0, gzBytes = 0, maxTris = 0;
    let lastLine = 0;
    for (let i = 0; i < tiles.length; i++) {
        const k = tiles[i];
        const outPath = tilePath(args.dir, k, '.pbh');
        const bvrPath = tilePath(args.src, k, '.bvr');
        const ptmPath = tilePath(args.dir, k, '.ptm');
        let planned: PlannedBuilding[] = [];
        let frame;
        if (fs.existsSync(bvrPath) && fs.existsSync(ptmPath)) {
            const buildings = decodeBvr(fs.readFileSync(bvrPath));
            // And the buildings only LoD2 has (tools/import_lod2.py), which take the same road.
            const bvlPath = tilePath(args.src, k, '.bvl');
            if (fs.existsSync(bvlPath)) {
                const extra = decodeBvr(fs.readFileSync(bvlPath));
                lod2Added += extra.length;
                buildings.push(...extra);
            }
            const measured = args.colours !== undefined ? readMeasuredRoofs(args.colours, k) : undefined;
            leavesMeasured += measured ? 1 : 0;
            const shapes = args.shapes !== undefined ? readMeasuredShapes(args.shapes, k) : undefined;
            leavesShaped += shapes ? 1 : 0;
            const lod2 = args.lod2 !== undefined ? readLod2(args.lod2, k) : undefined;
            leavesLod2 += lod2 ? 1 : 0;
            const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
            const surface = tileSurface(tile, basis);
            frame = surface.frame;
            const b = tileBounds(k);
            const lat0 = (b.south + b.north) / 2, lon0 = (b.west + b.east) / 2;
            const o = surface.toXZ(lon0, lat0), n = surface.toXZ(lon0, lat0 + 0.01);
            const nl = Math.hypot(n.x - o.x, n.z - o.z);
            const north: [number, number] = [(n.x - o.x) / nl, (n.z - o.z) / nl];
            read += buildings.length;
            for (const bld of buildings) {
                const rings: Ring[] = bld.rings.map(r => r.map(([lon, lat]) => {
                    const p = surface.toXZ(lon, lat);
                    return [p.x, p.z] as [number, number];
                }));
                const plan = planBuilding({
                    building: bld, rings, lat: lat0, lon: lon0, north,
                    ground: (u, v) => surface.landH(u, v),
                    measured: measured?.get(bld.id),
                    shape: shapes?.get(bld.id),
                    surfaceForms: args.surfaceForms,
                    lod2: lod2?.get(bld.id),
                });
                if (plan !== undefined) {
                    planned.push(plan);
                    sources[plan.heightSource]++;
                    roofsMeasured += plan.roofMeasured ? 1 : 0;
                    shapesAbsent += plan.shapeAbsent ? 1 : 0;
                    formSources[plan.formSource]++;
                }
            }
        }
        if (planned.length === 0 || frame === undefined) {
            if (fs.existsSync(outPath)) {
                fs.unlinkSync(outPath);
            }
            emptied.push(k);
        } else {
            planned.sort((p, q) => q.prominence - p.prominence);
            let tileTris = 0;
            for (const p of planned) {
                tileTris += buildingTriangles({ ...p, noWalls: (p.flags & PBH_FLAG_NO_WALLS) !== 0 }, () => undefined);
            }
            const gz = zlib.gzipSync(encodePbh(k, frame, planned), { level: 9 });
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, gz);
            written.push(k);
            kept += planned.length;
            tris += tileTris;
            maxTris = Math.max(maxTris, tileTris);
            gzBytes += gz.byteLength;
        }
        if (Date.now() - lastLine > 500 || i === tiles.length - 1) {
            process.stdout.write(`\r  ${i + 1}/${tiles.length} (${((i + 1) / tiles.length * 100).toFixed(1)}%)`);
            lastLine = Date.now();
        }
    }
    process.stdout.write('\n');

    const indexPath = path.join(args.dir, 'index_buildings.bin');
    const present = new Map<string, TileKey>();
    if (args.bbox !== undefined && fs.existsSync(indexPath)) {
        for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
            present.set(keyOf(k), k);
        }
    }
    for (const k of emptied) {
        present.delete(keyOf(k));
    }
    for (const k of written) {
        present.set(keyOf(k), k);
    }
    fs.writeFileSync(indexPath, encodeTileIndex([...present.values()], leafZoom, leafZoom));
    // Re-read: a stage that ran meanwhile may have written its own block.
    const latest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TerrainManifestFile;
    latest.buildings = {
        path: '{z}/{x}/{y}.pbh',
        indexPath: 'index_buildings.bin',
        encoding: 'PBH1',
        transport: 'gzip',
        minZoom: leafZoom,
        maxZoom: leafZoom,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(latest, null, 2)}\n`);

    const pct = (n: number) => (kept ? (n / kept * 100).toFixed(0) : '0') + '%';
    console.log(`  ${written.length} tiles, ${kept}/${read} buildings, ${(gzBytes / 1048576).toFixed(2)} MB gz, `
        + `${(gzBytes / Math.max(1, kept)).toFixed(1)} B/building`);
    console.log(`  height from: LoD2 ${pct(sources.lod2)}, surface model ${pct(sources.surface)}, `
        + `tag ${pct(sources.height)}, levels ${pct(sources.levels)}, rules ${pct(sources.default)}`);
    console.log(`  roof form from: LoD2 ${pct(formSources.lod2)}, surface ${pct(formSources.surface)}, `
        + `tag ${pct(formSources.tag)}, rules ${pct(formSources.rules)}; ${leavesLod2} leaves with LoD2, `
        + `${lod2Added} buildings only LoD2 has`);
    console.log(`  surface model: ${leavesShaped} of ${tiles.length} leaves fitted; `
        + `${shapesAbsent} buildings it does not show (kept)`);
    console.log(`  roof colour measured: ${pct(roofsMeasured)} (${leavesMeasured} of ${tiles.length} leaves measured)`);
    console.log(`  triangles: ${tris} total, ${(tris / Math.max(1, kept)).toFixed(1)} per building, `
        + `${maxTris} in the densest tile`);
    console.log(`  index_buildings.bin: ${present.size} tiles; done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main();
