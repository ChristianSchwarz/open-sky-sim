/**
 * Re-fold the geometric errors of an already baked terrain pyramid.
 *
 * `npm run bake:mesh` folds the figures itself once the tiles are written
 * (see tools/bake/errorFold.ts); this does the same fold on its own, for a
 * tree baked before the fold existed, without re-meshing anything. Every
 * `.ptm` whose header figure moves is patched in place, the index sidecar
 * remembers what each header holds, and the manifest's per-level maxima are
 * brought up to the folded figures.
 *
 *   npm run bake:errors [-- --out assets/terrain]
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodeTileIndex } from './bake/index';
import {
    TileMeta, foldPtmErrors, loadIndexMeta, newErrorFoldStats, readPtmHeaderError, saveIndexMeta,
    tileMetaKey,
} from './bake/errorFold';

function parseArgs(argv: string[]): { out: string } {
    const a = { out: 'assets/terrain' };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--out') {
            a.out = argv[++i];
        } else {
            throw new Error(`unknown argument ${k}`);
        }
    }
    return a;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const indexPath = path.join(args.out, 'index_mesh.bin');
    const manifestPath = path.join(args.out, 'manifest.json');
    if (!fs.existsSync(indexPath) || !fs.existsSync(manifestPath)) {
        console.error(`error: ${args.out} holds no baked pyramid (index_mesh.bin and manifest.json wanted)`);
        process.exit(1);
    }
    const tiles = decodeTileIndex(fs.readFileSync(indexPath));
    const tileMeta = loadIndexMeta(args.out);
    let decoded = 0;
    for (const { z, x, y } of tiles) {
        const key = tileMetaKey(z, x, y);
        if (tileMeta[key] !== undefined) {
            continue;
        }
        // No sidecar entry: the header is all that is known, and it is at
        // least the own figure, which is all the fold needs.
        const errM = readPtmHeaderError(path.join(args.out, String(z), String(x), `${y}.ptm`));
        tileMeta[key] = { geometricErrorM: errM, skirtDepthM: 0, headerErrorM: errM };
        decoded++;
    }
    // A sidecar entry for a tile the index no longer lists is a deleted area.
    const present = new Set(tiles.map(t => tileMetaKey(t.z, t.x, t.y)));
    const live: Record<string, TileMeta> = {};
    for (const key of Object.keys(tileMeta)) {
        if (present.has(key)) {
            live[key] = tileMeta[key];
        }
    }
    console.log(`${tiles.length} tiles in the index, ${decoded} read from their headers`);

    const t0 = Date.now();
    const stats = newErrorFoldStats();
    const drawn = foldPtmErrors(args.out, live, stats);
    saveIndexMeta(args.out, live);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        mesh?: { maxZoom?: number; levelGeometricErrorM?: number[] };
    };
    const levels = manifest.mesh?.levelGeometricErrorM;
    if (levels !== undefined) {
        const folded = levels.map((v, z) => v);
        for (const [key, v] of drawn) {
            const z = Number(key.split('/')[0]);
            folded[z] = Math.max(folded[z] ?? 0, v);
        }
        manifest.mesh!.levelGeometricErrorM = folded;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const byZoom = [...stats.raisedByZoom.entries()].sort((a, b) => a[0] - b[0])
        .map(([z, n]) => `z${z}: ${n}`).join(', ');
    console.log(`errors folded in ${((Date.now() - t0) / 1000).toFixed(1)}s: `
        + `${stats.raised} tiles carry a figure from beneath them `
        + `(largest rise ${stats.maxRaiseM.toFixed(0)} m; ${byZoom || 'none'}), `
        + `${stats.rewritten} headers rewritten`);
}

main();
