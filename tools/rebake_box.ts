/**
 * Re-bake a graded box: meshes, far-tile textures, road strokes, bridges, the
 * grading and the far land, in that order (areaImport.ts meshSteps) - what it takes to
 * apply a change to the grading or the bridges to an area, since a graded
 * tile is never graded again in place (bake_planet_grade.ts).
 *
 *   npm run rebake:box -- --bbox w,s,e,n
 *   npm run rebake:box -- --at lat,lon [--tiles N]
 *
 * `--at` takes the leaf tile under a point - a game URL's lat/lng - and,
 * with `--tiles N`, the N-by-N block of leaves centred on it (odd N; 1 by
 * default). The box is inset a metre so only those leaves (and the coarse
 * tiles over them) are re-baked. Each stage prints as it runs; the first to
 * fail stops the rest.
 */

import { spawnSync } from 'node:child_process';
import { meshSteps } from './areaImport';

const LEAF_ZOOM = 12;
const INSET_DEG = 1e-5;

function parse(argv: string[]): number[] {
    let bbox: number[] | undefined, at: number[] | undefined, n = 1;
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i], v = argv[++i];
        if (k === '--bbox') bbox = v.split(',').map(Number);
        else if (k === '--at') at = v.split(',').map(Number);
        else if (k === '--tiles') n = Number(v);
        else throw new Error(`unknown argument ${k}`);
    }
    if (bbox) {
        if (bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
            throw new Error('--bbox wants west,south,east,north');
        }
        return bbox;
    }
    if (!at || at.length !== 2 || !at.every(Number.isFinite) || !(n >= 1 && n % 2 === 1)) {
        throw new Error('give --bbox w,s,e,n, or --at lat,lon with an odd --tiles N');
    }
    const span = 180 / 2 ** LEAF_ZOOM;
    const [lat, lon] = at;
    const x = Math.floor((lon + 180) / span), y = Math.floor((90 - lat) / span), r = (n - 1) / 2;
    return [
        -180 + (x - r) * span + INSET_DEG, 90 - (y + r + 1) * span + INSET_DEG,
        -180 + (x + r + 1) * span - INSET_DEG, 90 - (y - r) * span - INSET_DEG,
    ];
}

const box = parse(process.argv.slice(2));
console.log(`rebake_box: ${box.map(v => v.toFixed(5)).join(',')}`);
for (const step of meshSteps(box)) {
    console.log(`\n== ${step.label}`);
    const r = spawnSync(step.cmd, step.args, { stdio: 'inherit' });
    if (r.status !== 0) {
        console.error(`rebake_box: "${step.label}" failed (exit ${r.status ?? r.signal}); stopping`);
        process.exit(1);
    }
}
console.log('\nrebake_box: done');
