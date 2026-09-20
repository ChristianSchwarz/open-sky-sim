/**
 * Bake bridge geometry sidecars (.pbr) from the finished mesh tree and the
 * bridge spans tools/bake_osm_roads.py wrote.
 *
 * For every leaf mesh tile that has a .rbr beside its .pdm, reads the .ptm,
 * plans each span's deck and piers over the drawn surface
 * (tools/bake/bridges.ts), builds the triangles (tools/bake/bridgeMesh.ts)
 * and writes one gzip-compressed PBR1 beside the mesh, plus
 * index_bridges.bin and a `bridges` block in the manifest. A tile with no
 * spans gets no sidecar, and a stale one is dropped.
 *
 * Runs after the mesh bake and the road bake and reads only what they wrote,
 * so like the road strokes it can be re-tuned without touching a mesh.
 *
 * Usage:
 *   node --import tsx tools/bake_planet_bridges.ts [options]
 *
 *     --dir DIR        the mesh tree, read and written   (default assets/terrain)
 *     --src DIR        the planet pyramid with the .rbr  (default assets/planet)
 *     --bbox w,s,e,n   only tiles in this box; the index is merged with what
 *                      is there
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { makeEnuBasis } from '../src/script/terrain/geodesy';
import { decodePtm } from '../src/script/terrain/ptm';
import { PBR_MAX_VERTS, encodePbr } from '../src/script/terrain/pbr';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { boundsOf } from './bake/coverTex';
import { BridgeMesh, buildBridgeMesh } from './bake/bridgeMesh';
import { BridgePlan, PIER_SPACING_M, planBridge } from './bake/bridges';
import { decodeRbr } from './bake/rbr';
import { LonLatBounds } from './bake/shoreline';
import { tileSurface } from './bake/tileSurface';

/**
 * An abutment block taller than this reads as a pier, not an abutment. Smaller
 * lifts are the deck holding a road-like grade over falling ground, which the
 * block under the end hides; short slabs on 10-40% DEM slopes are most spans.
 */
const TALL_ABUTMENT_M = 6;

interface Args {
    dir: string;
    src: string;
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
    const a: Args = { dir: 'assets/terrain', src: 'assets/planet' };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--src') a.src = next();
        else if (k === '--bbox') a.bbox = parseBbox(next());
        else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

interface TerrainManifestFile {
    enuOrigin: { lat: number; lon: number; height: number };
    mesh: { indexPath: string; minZoom: number; maxZoom: number };
    bridges?: unknown;
    [key: string]: unknown;
}

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;
const tilePath = (dir: string, k: TileKey, ext: string) =>
    path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

/** Meshes joined into one, indices offset. */
function concat(meshes: readonly BridgeMesh[]): BridgeMesh {
    const verts = meshes.reduce((n, m) => n + m.vertexCount, 0);
    const idx = meshes.reduce((n, m) => n + m.indices.length, 0);
    const out: BridgeMesh = {
        positions: new Float32Array(verts * 3), normals: new Float32Array(verts * 3),
        roles: new Uint8Array(verts), indices: new Uint32Array(idx),
        vertexCount: verts, triangleCount: idx / 3,
    };
    let v = 0, i = 0;
    for (const m of meshes) {
        out.positions.set(m.positions, v * 3);
        out.normals.set(m.normals, v * 3);
        out.roles.set(m.roles, v);
        for (let k = 0; k < m.indices.length; k++) {
            out.indices[i + k] = m.indices[k] + v;
        }
        v += m.vertexCount;
        i += m.indices.length;
    }
    return out;
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
    const meshTiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, manifest.mesh.indexPath ?? 'index_mesh.bin')));
    const tiles = meshTiles.filter(k => k.z === leafZoom
        && (args.bbox === undefined || overlaps(boundsOf(k), args.bbox)));
    console.log(`bake_planet_bridges: ${tiles.length} leaf tiles z${leafZoom}${args.bbox ? ' (scoped)' : ''}`);

    const written: TileKey[] = [];
    const emptied: TileKey[] = [];
    const stat = {
        spans: 0, planned: 0, tunnels: 0, dropped: 0, offMesh: 0, buried: 0,
        piers: 0, joints: 0, long: 0, liftedEnds: 0, tris: 0, gz: 0, humps2: 0, humps4: 0, humpMax: 0,
    };
    let lastLine = 0;
    for (let i = 0; i < tiles.length; i++) {
        const k = tiles[i];
        const outPath = tilePath(args.dir, k, '.pbr');
        const rbrPath = tilePath(args.src, k, '.rbr');
        const ptmPath = tilePath(args.dir, k, '.ptm');
        let bytes: Uint8Array | undefined;
        if (fs.existsSync(rbrPath) && fs.existsSync(ptmPath)) {
            const spans = decodeRbr(fs.readFileSync(rbrPath));
            const tile = decodePtm(zlib.gunzipSync(fs.readFileSync(ptmPath)));
            const surface = tileSurface(tile, basis);
            const built: { mesh: BridgeMesh; plan: BridgePlan; lengthM: number }[] = [];
            for (const rec of spans) {
                stat.spans++;
                if (rec.structure === 'tunnel') {
                    stat.tunnels++;
                    continue;
                }
                const points = rec.points.map(p => surface.toXZ(p.lon, p.lat));
                let lastGround = 0;
                const groundY = (x: number, z: number): number => {
                    const y = surface.landH(x, z) ?? surface.waterH(x, z);
                    if (y === undefined) {
                        return lastGround;
                    }
                    lastGround = y;
                    return y;
                };
                // Seed the fallback with the first height that exists, so a span
                // that starts off the mesh does not read as sea level.
                for (const p of points) {
                    const y = surface.landH(p.x, p.z) ?? surface.waterH(p.x, p.z);
                    if (y !== undefined) {
                        lastGround = y;
                        break;
                    }
                }
                const plan = planBridge({
                    structure: rec.structure, deckWidthM: rec.deckWidthM, layer: rec.layer, points,
                }, {
                    groundY,
                    // A river is water drawn above its own bed.
                    waterY: (x, z) => {
                        const w = surface.waterH(x, z);
                        const l = surface.landH(x, z);
                        return w !== undefined && (l === undefined || w > l - 1e-3) ? w : undefined;
                    },
                });
                // Judged on the span's own stations: the ramp planner probes past the
                // ends, and off the mesh there is no reason to drop a span that fits.
                const offMesh = plan === undefined ? 0 : plan.stations.filter(
                    st => surface.landH(st.x, st.z) === undefined && surface.waterH(st.x, st.z) === undefined).length;
                if (!plan || offMesh * 2 > plan.stations.length) {
                    stat.offMesh++;
                    continue;
                }
                stat.planned++;
                // How far the deck rises above the straight line between its ends: a
                // hill in the road, which reads as a rollercoaster when nothing under
                // the span needs it.
                {
                    const a = plan.stations[0], b = plan.stations[plan.stations.length - 1];
                    let hump = 0;
                    for (const st of plan.stations) {
                        const t = b.s > a.s ? (st.s - a.s) / (b.s - a.s) : 0;
                        hump = Math.max(hump, st.deckY - (a.deckY + (b.deckY - a.deckY) * t));
                    }
                    if (hump > 2) stat.humps2++;
                    if (hump > 4) stat.humps4++;
                    stat.humpMax = Math.max(stat.humpMax, hump);
                }
                stat.buried += plan.buried;
                stat.piers += plan.piers.length;
                {
                    // Joints a pier could stand at: whole bays of PIER_SPACING_M, less one.
                    const bays = Math.round(plan.lengthM / PIER_SPACING_M);
                    if (['slab', 'beam', 'arch', 'truss'].includes(plan.structure) && bays >= 2) {
                        stat.joints += bays - 1;
                        stat.long++;
                    }
                }
                if (plan.abutmentLiftM[0] > TALL_ABUTMENT_M || plan.abutmentLiftM[1] > TALL_ABUTMENT_M) {
                    stat.liftedEnds++;
                }
                built.push({ mesh: buildBridgeMesh(plan, surface.frame), plan, lengthM: plan.lengthM });
            }
            // Longest first: a full stream drops the short spans, never the viaduct.
            built.sort((a, b) => b.lengthM - a.lengthM);
            const keep: BridgeMesh[] = [];
            let verts = 0;
            for (const b of built) {
                if (verts + b.mesh.vertexCount > PBR_MAX_VERTS) {
                    stat.dropped++;
                    continue;
                }
                verts += b.mesh.vertexCount;
                keep.push(b.mesh);
            }
            if (keep.length > 0) {
                const m = concat(keep);
                bytes = zlib.gzipSync(encodePbr({
                    id: k, quantScale: tile.quantScale, positions: m.positions,
                    normals: m.normals, roles: m.roles, indices: m.indices,
                }), { level: 9 });
                stat.tris += m.triangleCount;
            }
        }
        if (bytes === undefined) {
            if (fs.existsSync(outPath)) {
                fs.unlinkSync(outPath);
            }
            emptied.push(k);
        } else {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, bytes);
            written.push(k);
            stat.gz += bytes.byteLength;
        }
        if (Date.now() - lastLine > 500 || i === tiles.length - 1) {
            process.stdout.write(`\r  ${i + 1}/${tiles.length} (${((i + 1) / tiles.length * 100).toFixed(1)}%)`);
            lastLine = Date.now();
        }
    }
    process.stdout.write('\n');

    // --- index and manifest -------------------------------------------------
    const indexPath = path.join(args.dir, 'index_bridges.bin');
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
    manifest.bridges = {
        path: '{z}/{x}/{y}.pbr',
        indexPath: 'index_bridges.bin',
        encoding: 'PBR1',
        transport: 'gzip',
        minZoom: leafZoom,
        maxZoom: leafZoom,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    console.log(`spans        ${stat.spans}  (planned ${stat.planned}, tunnels skipped ${stat.tunnels})`);
    console.log(`piers        ${stat.piers}   of ${stat.joints} joints on ${stat.long} spans long enough for one`);
    console.log(`triangles    ${stat.tris}`);
    console.log(`tall ends    ${stat.liftedEnds}  (abutment taller than a pier: an approach embankment would read better)`);
    console.log(`off mesh     ${stat.offMesh}   dropped for the vertex cap ${stat.dropped}`);
    console.log(`humps        >2 m: ${stat.humps2}   >4 m: ${stat.humps4}   max ${stat.humpMax.toFixed(1)} m`);
    // Stations where the straight deck passes through ground taller than RIDE_CAP_M:
    // a dyke or a hill the road cuts through, so not an error, but a rise here
    // would mean the ground read is wrong.
    console.log(`cut through  ${stat.buried} stations  (deck passes through a mound taller than the ride cap)`);
    console.log(`wrote ${written.length} bridge sidecars, ${(stat.gz / 1048576).toFixed(2)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
