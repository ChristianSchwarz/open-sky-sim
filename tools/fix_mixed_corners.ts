/**
 * Gives every land triangle of the graded tiles one class and one colour set.
 *
 * The grading copied each corner's class and colour from the slot it came
 * from, so a triangle re-cut or flipped beside a bed could carry corners of
 * two covers (a forest sliver with one yellow field corner, drawn as a smear
 * into the field). railBed.ts unifyCorners now prevents that; this repairs the
 * tiles baked before it, in place, without re-grading.
 *
 * Usage:
 *   node --import tsx tools/fix_mixed_corners.ts [--dir assets/terrain] [--bbox w,s,e,n] [--dry]
 *
 * Only .ptm land attributes change, and not the positions, so the far-land
 * sidecars (fingerprinted on positions) stay valid; the far-texture sidecars
 * (bake:tex) and far land (.pfl) of a changed tile keep the old colours until
 * their own stages run again.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { decodePtm, isPtmGraded, writePtmLand } from '../src/script/terrain/ptm';
import { unifyCorners } from '../src/script/terrain/railBed';

let dir = 'assets/terrain';
let bbox: [number, number, number, number] | undefined;
let dry = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') dir = argv[++i];
    else if (argv[i] === '--bbox') bbox = argv[++i].split(',').map(Number) as [number, number, number, number];
    else if (argv[i] === '--dry') dry = true;
    else throw new Error(`unknown argument ${argv[i]}`);
}

let scanned = 0, changedTiles = 0, changedTris = 0;
for (const zs of fs.readdirSync(dir)) {
    const z = Number(zs);
    if (!Number.isInteger(z) || !fs.statSync(path.join(dir, zs)).isDirectory()) continue;
    const span = 180 / (1 << z);
    for (const xs of fs.readdirSync(path.join(dir, zs))) {
        const x = Number(xs);
        const west = -180 + x * span;
        if (bbox && (west > bbox[2] || west + span < bbox[0])) continue;
        for (const f of fs.readdirSync(path.join(dir, zs, xs))) {
            if (!f.endsWith('.ptm')) continue;
            const y = Number(f.slice(0, -4));
            const north = 90 - y * span;
            if (bbox && (north - span > bbox[3] || north < bbox[1])) continue;
            const file = path.join(dir, zs, xs, f);
            const bytes = zlib.gunzipSync(fs.readFileSync(file));
            const tile = decodePtm(bytes);
            scanned++;
            if (!isPtmGraded(tile)) continue;
            const attrs = tile.landAttrs.slice();
            let n = 0;
            for (let t = 0; t < attrs.length / 12; t++) {
                const before = attrs.slice(t * 12, t * 12 + 12);
                unifyCorners(attrs, t * 12);
                for (let i = 0; i < 12; i++) {
                    if (attrs[t * 12 + i] !== before[i]) { n++; break; }
                }
            }
            if (n === 0) continue;
            changedTiles++;
            changedTris += n;
            console.log(`${zs}/${xs}/${y}: ${n} triangles`);
            if (!dry) {
                const out = writePtmLand(bytes, { positions: tile.landPositions, normals: tile.landNormals, attrs });
                fs.writeFileSync(file + '.tmp', zlib.gzipSync(out));
                fs.renameSync(file + '.tmp', file);
            }
        }
    }
}
console.log(`${scanned} tiles scanned, ${changedTiles} changed, ${changedTris} triangles${dry ? ' (dry run)' : ''}`);
