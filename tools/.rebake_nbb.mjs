// Scratch driver (untracked): northern Brandenburg re-baked with lidar - the
// lines measured (the grade's first step does that), then mesh, textures,
// road strokes, bridges, grade, far land and buildings over the box, as
// tools/rebake_box.ts does, but going on past a partial exit (1 on the
// lidar and building measurements is "some leaves failed") and leaving out
// the roof shapes (88 leaves an hour; the user had them skipped for DACH).
import { spawn } from 'child_process';
import { meshSteps } from './areaImport.ts';

const box = [11.26, 52.70, 14.77, 53.56];
const JOBS = process.env.JOBS || '10';
const SKIP = new Set(['fitting roof shapes']);

function run(label, cmd, args, okCodes) {
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

console.log(`re-baking northern Brandenburg ${box.join(',')} with lidar`);
for (const s of meshSteps(box)) {
    if (SKIP.has(s.label)) {
        console.log(`\n[${s.label}] skipped`);
        continue;
    }
    const args = /bake_planet_(grade|farland|mesh)\.ts/.test(s.args.join(' ')) ? [...s.args, '--jobs', JOBS] : s.args;
    await run(s.label, s.cmd, args, [0, ...(s.partialCode !== undefined ? [s.partialCode] : [])]);
}
console.log('\nnorthern Brandenburg re-bake complete');
