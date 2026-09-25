// Re-bakes every area in assets/terrain/manifest.json from scratch, with
// satellite cover, using the exact same steps as the in-app importer
// (tools/areaImport.ts): fetch/merge DEM, coast, roads, airfields, cover,
// then meshes/textures/road-strokes once over the whole area box.
//
// Run in the background and tee to rebake_all.log; safe to re-run since
// every stage is idempotent over its own bbox.

import { spawn } from 'child_process';
import { readAreas, chunkBbox, dataSteps, meshSteps, prefetchPlan } from './areaImport.ts';

function run(label, cmd, args) {
    return new Promise((resolve, reject) => {
        console.log(`\n[${label}]\n$ ${cmd} ${args.join(' ')}`);
        const child = spawn(cmd, args, { cwd: process.cwd(), stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', code => {
            if (code === 0 || code === 2) {
                // 2 == partial (e.g. airfields carried over on an Overpass failure).
                resolve();
            } else {
                reject(new Error(`${label} exited with code ${code}`));
            }
        });
    });
}

async function runSteps(steps) {
    for (const s of steps) {
        await run(s.label, s.cmd, s.args);
    }
}

async function bakeArea(area) {
    const bbox = [area.west, area.south, area.east, area.north];
    console.log(`\n=== ${area.name} ===`);
    const chunks = chunkBbox(bbox);
    const many = chunks.length > 1;
    for (let ci = 0; ci < chunks.length; ci++) {
        const c = chunks[ci];
        for (const p of prefetchPlan({ bbox: c })) {
            await run(many ? `chunk ${ci + 1}/${chunks.length}: ${p.label}` : p.label, p.cmd, p.args);
        }
        const steps = dataSteps({ name: area.name, bbox: c }, true, ci > 0);
        await runSteps(steps.map(s => ({
            ...s, label: many ? `chunk ${ci + 1}/${chunks.length}: ${s.label}` : s.label,
        })));
    }
    await runSteps(meshSteps(bbox));
}

async function main() {
    const { areas } = readAreas();
    if (areas.length === 0) {
        console.log('no areas in manifest.json');
        return;
    }
    console.log(`baking ${areas.length} area(s), with satellite cover: ${areas.map(a => a.name).join(', ')}`);
    for (const area of areas) {
        await bakeArea(area);
    }
    console.log('\nall areas rebaked.');
}

main().catch(err => {
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
});
