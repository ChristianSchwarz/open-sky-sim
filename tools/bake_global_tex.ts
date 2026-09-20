/**
 * Bake far-tile cover textures (.ptx) for the coarse global tiles.
 *
 * `bake_planet_tex.ts` builds a texture by rasterising a leaf tile's mesh
 * facets and folding them up the quadtree. That is right where the leaves are
 * z12 and every facet is a field, and useless for the global tiles: their
 * facets are hundreds of kilometres across and each carries one mean colour, so
 * a raster of them would only reproduce the facets. What the global tiles do
 * have is a per-node colour and class (`.plc`, 257 x 257, from Blue Marble),
 * and this bakes that straight into the texture.
 *
 * For each z`--min-zoom`..`--max-zoom` tile that has a mesh:
 *
 *   texel  the mean colour of the four nodes around its centre, and the class
 *          of the commonest of them; a texel with more than one water node is
 *          no-data, so the coast facets keep the colour they were baked with
 *   tile   already has a texture (a regional tile that overlaps a baked area):
 *          its data texels win, and only the no-data ones take the global value
 *
 * The texel grid is the tile's lon/lat box, row 0 north, column 0 west, the
 * same as every other PTX1 tile, so the runtime needs no change. The floor is
 * z4: the runtime maps a vertex into the raster on a tangent plane whose
 * second-order error is under two texels of 256 at z4 and a dozen at z3.
 *
 * Usage:
 *   node --import tsx tools/bake_global_tex.ts [options]
 *
 *     --dir DIR        the mesh tree, read and written   (default assets/terrain)
 *     --src DIR        the planet pyramid holding the .plc (default assets/planet)
 *     --min-zoom N     coarsest level that gets a texture (default 4)
 *     --max-zoom N     finest level (default: the planet manifest's global.maxZoom)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { PTX_NO_DATA, decodePtx, encodePtx } from '../src/script/terrain/ptx';
import { TerrainClass } from '../src/script/terrain/tones';
import { TileKey, decodeTileIndex, encodeTileIndex } from './bake/index';
import { decodePlc } from './bake/plc';

const SIZE = 256;
const DEFAULT_MIN_ZOOM = 4;

interface Args {
    dir: string;
    src: string;
    minZoom: number;
    maxZoom?: number;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { dir: 'assets/terrain', src: 'assets/planet', minZoom: DEFAULT_MIN_ZOOM };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--dir') a.dir = next();
        else if (k === '--src') a.src = next();
        else if (k === '--min-zoom') a.minZoom = Number(next());
        else if (k === '--max-zoom') a.maxZoom = Number(next());
    }
    return a;
}

const keyOf = (k: TileKey): string => `${k.z}/${k.x}/${k.y}`;
const tilePath = (dir: string, k: TileKey, ext: string): string =>
    path.join(dir, String(k.z), String(k.x), `${k.y}${ext}`);

/**
 * A `SIZE x SIZE` raster from a tile's node grid: texel (r, c) sits at the
 * centre of the cell whose corners are nodes (r, c), (r, c+1), (r+1, c) and
 * (r+1, c+1), which is why a 257-node tile makes exactly 256 texels.
 */
function rasterFromNodes(size: number, classes: Uint8Array, colors: Uint8Array): Uint8Array {
    const out = new Uint8Array(SIZE * SIZE * 4);
    if (size !== SIZE + 1) {
        throw new Error(`expected ${SIZE + 1} nodes across a tile, got ${size}`);
    }
    const counts = new Uint8Array(16);
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            const nodes = [r * size + c, r * size + c + 1, (r + 1) * size + c, (r + 1) * size + c + 1];
            let water = 0;
            let red = 0;
            let green = 0;
            let blue = 0;
            counts.fill(0);
            for (const n of nodes) {
                const cls = classes[n] & 15;
                if (cls === TerrainClass.Water) {
                    water++;
                }
                counts[cls]++;
                red += colors[n * 3];
                green += colors[n * 3 + 1];
                blue += colors[n * 3 + 2];
            }
            const o = (r * SIZE + c) * 4;
            if (water > 1) {
                out[o + 3] = PTX_NO_DATA;
                continue;
            }
            let best = 0;
            let bestCount = -1;
            for (let cls = 0; cls < 16; cls++) {
                if (cls !== TerrainClass.Water && counts[cls] > bestCount) {
                    best = cls;
                    bestCount = counts[cls];
                }
            }
            out[o] = Math.round(red / 4);
            out[o + 1] = Math.round(green / 4);
            out[o + 2] = Math.round(blue / 4);
            out[o + 3] = best;
        }
    }
    return out;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();

    const manifestPath = path.join(args.dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const planet = JSON.parse(fs.readFileSync(path.join(args.src, 'manifest.json'), 'utf8'));
    const maxZoom = args.maxZoom ?? planet.global?.maxZoom;
    if (maxZoom === undefined) {
        console.error('error: no global block in the planet manifest and no --max-zoom');
        process.exit(1);
    }
    if (manifest.texture === undefined) {
        console.error('error: the mesh manifest has no texture block; run npm run bake:tex first');
        process.exit(1);
    }

    const meshTiles = decodeTileIndex(fs.readFileSync(path.join(args.dir, 'index_mesh.bin')))
        .filter(k => k.z >= args.minZoom && k.z <= maxZoom);
    const indexPath = path.join(args.dir, 'index_tex.bin');
    const present = new Map<string, TileKey>();
    for (const k of decodeTileIndex(fs.readFileSync(indexPath))) {
        present.set(keyOf(k), k);
    }
    const before = present.size;

    let written = 0;
    let merged = 0;
    let skipped = 0;
    let gzBytes = 0;
    for (const k of meshTiles) {
        const plcPath = tilePath(args.src, k, '.plc');
        if (!fs.existsSync(plcPath)) {
            skipped++;
            continue;
        }
        const cover = decodePlc(fs.readFileSync(plcPath));
        let texels = rasterFromNodes(cover.size, cover.classes, cover.colors);

        const ptxPath = tilePath(args.dir, k, '.ptx');
        if (fs.existsSync(ptxPath)) {
            const existing = decodePtx(zlib.gunzipSync(fs.readFileSync(ptxPath)));
            if (existing.size === SIZE) {
                for (let i = 3; i < texels.length; i += 4) {
                    if (existing.texels[i] !== PTX_NO_DATA) {
                        texels[i - 3] = existing.texels[i - 3];
                        texels[i - 2] = existing.texels[i - 2];
                        texels[i - 1] = existing.texels[i - 1];
                        texels[i] = existing.texels[i];
                    }
                }
                merged++;
            }
        }
        let any = false;
        for (let i = 3; i < texels.length; i += 4) {
            if (texels[i] !== PTX_NO_DATA) {
                any = true;
                break;
            }
        }
        if (!any) {
            // All sea: no sidecar, and a stale one is dropped so it cannot mask the facets.
            if (fs.existsSync(ptxPath)) {
                fs.unlinkSync(ptxPath);
            }
            present.delete(keyOf(k));
            skipped++;
            continue;
        }
        const gz = zlib.gzipSync(encodePtx(k, SIZE, texels), { level: 9 });
        fs.mkdirSync(path.dirname(ptxPath), { recursive: true });
        fs.writeFileSync(ptxPath, gz);
        gzBytes += gz.byteLength;
        present.set(keyOf(k), k);
        written++;
        texels = new Uint8Array(0);
    }

    const all = [...present.values()];
    fs.writeFileSync(indexPath, encodeTileIndex(all, manifest.texture.minZoom, manifest.texture.maxZoom));
    console.log(`global textures z${args.minZoom}..${maxZoom}: ${written} written `
        + `(${merged} filled around an existing regional texture), ${skipped} without land, `
        + `${(gzBytes / 1048576).toFixed(1)} MB gzipped`);
    console.log(`texture index: ${before} -> ${all.length} tiles in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
