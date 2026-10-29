// Scratch driver (untracked): full re-import of the DACH area with the
// importer's own steps, run in order. Large new data goes to E: (C: is full);
// the mesh-tail bakes run on 6 workers (pagefile trap at CPUs-1).
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { readAreas, chunkBbox, dataSteps, meshSteps } from './areaImport.ts';

const E = 'E:\\retroflightsim-data\\reimport-dach';
const JOBS = process.env.JOBS || '6';
// Fixed: the terrain manifest's DACH entry shrinks to the chunks merged so
// far while the import runs, and a resume read the half box from it.
const box = [5.8447265625, 45.791015625, 17.2265625, 55.107421875];
fs.mkdirSync(path.join(E, 'cover'), { recursive: true });
const pbf = path.join(E, `${box.join('_')}.osm.pbf`);
const PYTHON = process.env.PYTHON || 'python';

function run(label, cmd, args, okCodes = [0]) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        console.log(`\n[${new Date().toISOString()}] [${label}]\n$ ${cmd} ${args.join(' ')}`);
        const child = spawn(cmd, args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', code => {
            console.log(`[${label}] exit ${code} after ${((Date.now() - t0) / 60000).toFixed(1)} min`);
            okCodes.includes(code) ? resolve(code) : reject(new Error(`${label} exited with code ${code}`));
        });
    });
}
const codes = s => [0, ...(s.partialCode !== undefined ? [s.partialCode] : []), ...(s.skipCode !== undefined ? [s.skipCode] : [])];
const toE = a => a
    .replace(/^(--out=)?data[\\/]cover[\\/]chunks[\\/]/, (_, p) => `${p ?? ''}${E}\\cover\\`)
    .replace(/^(--sources=)data[\\/]cover[\\/]chunks[\\/]/, `$1${E}\\cover\\`)
    .replace(/^data[\\/]imports[\\/](dach-[^\\/]+\.tif)$/, `${E}\\$1`);
const withJobs = s => /bake_planet_(grade|farland|mesh)\.ts/.test(s.args.join(' ')) ? { ...s, args: [...s.args, '--jobs', JOBS] } : s;

console.log(`re-importing DACH ${box.join(',')}`);
await run('resolving local OSM extract', PYTHON, ['tools/osm_extract.py', `--bbox=${box.join(',')}`, `--out=${pbf}`]);
const chunks = chunkBbox(box);
// START_CHUNK=n resumes at chunk n (1-based) after chunks before it finished.
const start = Number(process.env.START_CHUNK || 1) - 1;
let land = start > 0 ? 1 : 0;
// A dense chunk's OSM read runs out of memory (one Python dict per node,
// osm_pbf._scan_groups): redo that chunk as smaller tile-aligned pieces.
async function doChunk(bbox, tag, span, resumeAt) {
    let steps = dataSteps({ name: 'DACH', bbox, pbf }, land > 0).map(s => ({ ...s, args: s.args.map(toE) }))
        .map(s => s.args[0] === 'tools/bake_osm_coast.py' ? { ...s, args: [...s.args, '--jobs', process.env.COAST_JOBS || JOBS] } : s);
    if (resumeAt) {
        const i = steps.findIndex(s => s.label === resumeAt);
        if (i < 0) throw new Error(`no step "${resumeAt}"`);
        console.log(`${tag}: resuming at "${resumeAt}"`);
        land++;
        for (const s of steps.slice(i)) await run(`${tag}: ${s.label}`, s.cmd, s.args, codes(s));
        return;
    }
    const [fetch, ...rest] = steps;
    if (await run(`${tag}: ${fetch.label}`, fetch.cmd, fetch.args, codes(fetch)) === fetch.skipCode) {
        console.log(`${tag} is open sea - skipped`);
        return;
    }
    land++;
    for (const s of rest) {
        try {
            await run(`${tag}: ${s.label}`, s.cmd, s.args, codes(s));
        } catch (err) {
            if (s.lane !== 'prefetch' || span <= 0.5) throw err;
            const parts = chunkBbox(bbox, span / 2);
            console.log(`${tag}: OSM read failed - splitting into ${parts.length} pieces of <= ${span / 2} deg`);
            for (let pi = 0; pi < parts.length; pi++) await doChunk(parts[pi], `${tag}.${pi + 1}`, span / 2);
            return;
        }
    }
}
// START_SPAN=1 starts the first chunk already split (it is known to fail whole).
const startSpan = Number(process.env.START_SPAN || 2);
for (let ci = process.env.START_TAIL ? chunks.length : start; ci < chunks.length; ci++) {
    const tag = `chunk ${ci + 1}/${chunks.length}`;
    if (ci === start && startSpan < 2) {
        // START_PIECE=n skips the pieces before it; START_STEP then applies to that piece.
        const parts = chunkBbox(chunks[ci], startSpan);
        const p0 = Number(process.env.START_PIECE || 1) - 1;
        if (p0 > 0) land++;
        for (let pi = p0; pi < parts.length; pi++) {
            await doChunk(parts[pi], `${tag}.${pi + 1}`, startSpan, pi === p0 ? process.env.START_STEP : undefined);
        }
    } else {
        // START_STEP="<label>" resumes the first chunk at that step (its earlier steps finished).
        await doChunk(chunks[ci], tag, 2, ci === start ? process.env.START_STEP : undefined);
    }
}
// START_TAIL="<label>" skips every chunk and the whole-box steps before that one.
let tail = meshSteps(box).map(withJobs);
if (process.env.START_TAIL) {
    const i = tail.findIndex(s => s.label === process.env.START_TAIL);
    if (i < 0) throw new Error(`no whole-box step "${process.env.START_TAIL}"`);
    tail = tail.slice(i);
}
for (const s of tail) await run(s.label, s.cmd, s.args, codes(s));
console.log('\nDACH re-import complete');
