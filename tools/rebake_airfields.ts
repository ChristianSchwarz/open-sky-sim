/**
 * Re-bake every airfield's ground: the airfields of each area are graded again
 * (tools/bake_osm_airports.py), then the leaves their pads reach - and the
 * leaves the wider runway pads before 2026-10-30 reached - are re-meshed and
 * re-graded in one run per area, every block of leaves (tools/
 * airfield_rebake_boxes.py) handed to each stage as one `--bboxes` file
 * (tools/bake/bboxes.ts), the tile stages on the bake satellites unless
 * SATELLITES=0. A run per block re-baked the coarse tiles over DACH's
 * airfields a thousand times and took 8 minutes a block.
 *
 * What a change to how airfield pads are baked takes to reach the terrain: a
 * graded leaf is never graded again in place, so the mesh and everything
 * after it is baked anew under each block (areaImport.ts meshSteps). The
 * measure-once stages there (lidar lines, LoD2, roof colours and shapes) read
 * nothing the pads change and are left out.
 *
 *   npm run rebake:airfields -- [--areas DACH,Kanaren] [--skip-airports] [--old-only] [--state file]
 *
 * `--old-only` re-bakes only the leaves the old runway pads reached and the
 * new ones do not, for an area re-baked before those were counted.
 *
 * Resumable: every finished area is appended to the state file
 * (data/imports/rebake_airfields.done by default, `area` or `area:old-only`)
 * and skipped on the next run.
 * The boxes come from the manifest as the airport bake left it, so a re-run
 * after the airport step is done passes --skip-airports.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { meshSteps } from './areaImport';

// Trimmed: `set PYTHON=python && ...` in cmd leaves a trailing space in it.
const PYTHON = process.env.PYTHON?.trim() || (process.platform === 'win32' ? 'python' : 'python3');
/** bake_osm_airports.py EXIT_PARTIAL. */
const AIRPORTS_PARTIAL = 2;
const MEASURE_ONCE = /py_leaf_pool\.ts|import_lod2\.py|measure_buildings\.py|measure_roof_shapes\.py/;

function parse(argv: string[]): { areas?: string[]; skipAirports: boolean; oldOnly: boolean; state: string } {
    const out = { areas: undefined as string[] | undefined, skipAirports: false, oldOnly: false, state: 'data/imports/rebake_airfields.done' };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--areas') out.areas = argv[++i].split(',');
        else if (k === '--skip-airports') out.skipAirports = true;
        else if (k === '--old-only') out.oldOnly = true;
        else if (k === '--state') out.state = argv[++i];
        else throw new Error(`unknown argument ${k}`);
    }
    return out;
}

function run(label: string, cmd: string, args: string[], partialCode?: number): void {
    const t0 = Date.now();
    console.log(`\n== ${label}`);
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (partialCode !== undefined && r.status === partialCode) {
        console.log(`== ${label}: partial (exit ${partialCode}), going on`);
        return;
    }
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
            ['tools/bake_osm_airports.py', `--bbox=${a.west},${a.south},${a.east},${a.north}`],
            // Every Overpass mirror failed for the area: the manifest is
            // written and the area keeps the airfields it had, whose pads are
            // re-baked as they are.
            AIRPORTS_PARTIAL);
    }
}

fs.mkdirSync(path.dirname(args.state), { recursive: true });
const done = new Set(fs.existsSync(args.state) ? fs.readFileSync(args.state, 'utf8').split(/\r?\n/).filter(Boolean) : []);
const t0 = Date.now();
for (const a of areas) {
    const key = args.oldOnly ? `${a.name}:old-only` : a.name;
    if (done.has(key)) {
        console.log(`\n${key}: done before`);
        continue;
    }
    const r = spawnSync(PYTHON, ['tools/airfield_rebake_boxes.py', '--area', a.name, ...(args.oldOnly ? ['--old-only'] : [])],
        { encoding: 'utf8' });
    if (r.status !== 0) {
        throw new Error(`airfield_rebake_boxes.py --area ${a.name} failed: ${r.stderr}`);
    }
    const boxes = r.stdout.split(/\r?\n/).filter(Boolean);
    console.log(`\n### ${key}: ${r.stderr.trim()}`);
    if (boxes.length === 0) {
        fs.appendFileSync(args.state, key + '\n');
        continue;
    }
    const file = path.join(path.dirname(args.state), `rebake_airfields.${key.replace(/[^A-Za-z0-9]+/g, '_')}.boxes`);
    fs.writeFileSync(file, boxes.join('\n') + '\n');
    const all = boxes.map(b => b.split(',').map(Number));
    const union = [Math.min(...all.map(b => b[0])), Math.min(...all.map(b => b[1])),
        Math.max(...all.map(b => b[2])), Math.max(...all.map(b => b[3]))];
    for (const step of meshSteps(union, satellites)) {
        if (step.args.some(x => MEASURE_ONCE.test(x))) {
            continue;
        }
        // The union only made the steps; each stage takes the boxes themselves.
        const i = step.args.indexOf('--bbox');
        if (i < 0 || step.args.some(x => x.startsWith('--bbox='))) {
            throw new Error(`"${step.label}" takes no --bbox to swap for --bboxes: ${step.args.join(' ')}`);
        }
        const args2 = [...step.args.slice(0, i), '--bboxes', file, ...step.args.slice(i + 2)];
        run(`${key}: ${step.label}`, step.cmd, args2);
    }
    fs.appendFileSync(args.state, key + '\n');
}
console.log(`\nrebake_airfields: done in ${((Date.now() - t0) / 60000).toFixed(0)} min`);
