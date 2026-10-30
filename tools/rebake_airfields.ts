/**
 * Re-bake every airfield's ground: the airfields of each area are graded again
 * (tools/bake_osm_airports.py), then the leaves their pads reach are
 * re-meshed and re-graded, block by block (tools/airfield_rebake_boxes.py),
 * the tile stages on the bake satellites unless SATELLITES=0.
 *
 * What a change to how airfield pads are baked takes to reach the terrain: a
 * graded leaf is never graded again in place, so the mesh and everything
 * after it is baked anew under each block (areaImport.ts meshSteps). The
 * measure-once stages there (lidar lines, LoD2, roof colours and shapes) read
 * nothing the pads change and are left out.
 *
 *   npm run rebake:airfields -- [--areas DACH,Kanaren] [--skip-airports] [--state file]
 *
 * Resumable: every finished block is appended to the state file
 * (data/imports/rebake_airfields.done by default) and skipped on the next run.
 * The boxes come from the manifest as the airport bake left it, so a re-run
 * after the airport step is done passes --skip-airports.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { meshSteps } from './areaImport';

// Trimmed: `set PYTHON=python && ...` in cmd leaves a trailing space in it.
const PYTHON = process.env.PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
const MEASURE_ONCE = /py_leaf_pool\.ts|import_lod2\.py|measure_buildings\.py|measure_roof_shapes\.py/;

function parse(argv: string[]): { areas?: string[]; skipAirports: boolean; state: string } {
    const out = { areas: undefined as string[] | undefined, skipAirports: false, state: 'data/imports/rebake_airfields.done' };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--areas') out.areas = argv[++i].split(',');
        else if (k === '--skip-airports') out.skipAirports = true;
        else if (k === '--state') out.state = argv[++i];
        else throw new Error(`unknown argument ${k}`);
    }
    return out;
}

function run(label: string, cmd: string, args: string[]): void {
    const t0 = Date.now();
    console.log(`\n== ${label}`);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`"${label}" failed (exit ${r.status ?? r.signal}${r.error ? `: ${r.error.message}` : ''})`);
    }
    console.log(`== ${label}: ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

const args = parse(process.argv.slice(2));
const satellites = process.env.SATELLITES !== '0';
const manifest = JSON.parse(fs.readFileSync('assets/planet/manifest.json', 'utf8'));
const areas: { name: string; west: number; south: number; east: number; north: number }[] =
    (manifest.areas ?? []).filter((a: { name: string }) => !args.areas || args.areas.includes(a.name));
if (areas.length === 0) {
    throw new Error(`no such area: ${args.areas?.join(', ')}`);
}
console.log(`rebake_airfields: ${areas.map(a => a.name).join(', ')}; satellites ${satellites ? 'on' : 'off'}`);

if (!args.skipAirports) {
    for (const a of areas) {
        run(`grading the airfields of ${a.name}`, PYTHON,
            ['tools/bake_osm_airports.py', `--bbox=${a.west},${a.south},${a.east},${a.north}`]);
    }
}

fs.mkdirSync(path.dirname(args.state), { recursive: true });
const done = new Set(fs.existsSync(args.state) ? fs.readFileSync(args.state, 'utf8').split(/\r?\n/).filter(Boolean) : []);
const boxes: string[] = [];
for (const a of areas) {
    const r = spawnSync(PYTHON, ['tools/airfield_rebake_boxes.py', '--area', a.name], { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`airfield_rebake_boxes.py --area ${a.name} failed: ${r.stderr}`);
    }
    console.log(`${a.name}: ${r.stderr.trim()}`);
    boxes.push(...r.stdout.split(/\r?\n/).filter(Boolean));
}
const todo = boxes.filter(b => !done.has(b));
console.log(`${boxes.length} blocks, ${boxes.length - todo.length} done before, ${todo.length} to bake`);

const t0 = Date.now();
for (const [i, box] of todo.entries()) {
    const bbox = box.split(',').map(Number);
    console.log(`\n### block ${i + 1}/${todo.length} ${box}`
        + (i > 0 ? `  (${((Date.now() - t0) / 60000 / i * (todo.length - i)).toFixed(0)} min left)` : ''));
    for (const step of meshSteps(bbox, satellites)) {
        if (step.args.some(a => MEASURE_ONCE.test(a))) {
            continue;
        }
        run(step.label, step.cmd, step.args);
    }
    fs.appendFileSync(args.state, box + '\n');
}
console.log(`\nrebake_airfields: done, ${todo.length} blocks in ${((Date.now() - t0) / 60000).toFixed(0)} min`);
