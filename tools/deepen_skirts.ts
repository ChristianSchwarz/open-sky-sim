/**
 * Hang the land skirts of an already baked terrain pyramid as deep as a fresh
 * bake would (deepenedSkirtM), without re-meshing.
 *
 * `npm run bake:mesh` does it itself for every tile it writes; this brings a
 * tree baked before the factor existed up to it (see tools/bake/deepenSkirts.ts
 * and SKIRT_SEAM_FACTOR in tools/bake/meshTile.ts). Safe to run twice: a tile
 * records the factor in its header and is left alone the second time. Patches
 * every `.ptm`, the index sidecar's skirt figures, and the manifest's level
 * figures.
 *
 *   node --import tsx tools/deepen_skirts.ts [--out assets/terrain]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { deepenSkirts } from './bake/deepenSkirts';
import { deepenedSkirtM, SKIRT_SEAM_FACTOR } from './bake/meshTile';
import { loadIndexMeta, saveIndexMeta } from './bake/errorFold';

function* ptmFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* ptmFiles(p);
        } else if (entry.name.endsWith('.ptm')) {
            yield p;
        }
    }
}

function main(): void {
    const argv = process.argv.slice(2);
    const out = argv[0] === '--out' ? argv[1] : 'assets/terrain';
    const meta = loadIndexMeta(out);
    const levelMax: number[] = [];
    let changed = 0;
    let skipped = 0;
    let total = 0;
    for (const file of ptmFiles(out)) {
        total++;
        const raw = new Uint8Array(zlib.gunzipSync(fs.readFileSync(file)));
        const r = deepenSkirts(raw, deepenedSkirtM, SKIRT_SEAM_FACTOR);
        const [z, x, y] = path.relative(out, file).replace(/\.ptm$/, '').split(path.sep).map(Number);
        const key = `${z}/${x}/${y}`;
        if (r.changed) {
            fs.writeFileSync(file, zlib.gzipSync(raw, { level: 9 }));
            changed++;
            if (meta[key]) {
                meta[key].skirtDepthM = r.skirtDepthM;
            }
        } else {
            skipped++;
        }
        levelMax[z] = Math.max(levelMax[z] ?? 0, r.skirtDepthM);
    }
    saveIndexMeta(out, meta);
    const manifestPath = path.join(out, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        mesh?: { levelSkirtDepthM?: number[] };
    };
    const levels = manifest.mesh?.levelSkirtDepthM;
    if (levels) {
        manifest.mesh!.levelSkirtDepthM = levels.map((v, z) => Math.max(v, levelMax[z] ?? 0));
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    console.log(`${total} tiles: ${changed} deepened, ${skipped} left alone`);
}

main();
