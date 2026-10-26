/**
 * Does a satellite bake the same bytes as this machine? Bakes a small box's
 * meshes, roads and bridges into a scratch tree (ungraded, so the grade has
 * work to do), copies it twice, then runs the grade and the far land over one
 * copy with local workers and over the other with satellites only
 * (--jobs 0 --satellites, one satellite started here), and compares every
 * file of the two trees byte for byte.
 *
 * A difference means remoteTiles.ts inputsOf misses a file a tile function
 * reads (or the satellite runs other code than the bake).
 *
 *   node --import tsx tools/verify_satellite.ts [options]
 *
 *     --bbox w,s,e,n  the box (default 11.03,47.46,11.17,47.60, Garmisch: roads,
 *                     rail, bridges and lidar measurements)
 *     --work DIR      scratch directory, emptied first (default
 *                     E:/retroflightsim-data/verify-satellite: C: is short of room)
 *     --exe PATH      run this built satellite instead of tools/satellite/satellite.ts
 *     --keep          keep the scratch trees
 */

import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GROUND_MEANS_FILE } from './bake/groundColor';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
};
const bbox = opt('--bbox', '11.03,47.46,11.17,47.60')!;
const work = path.resolve(opt('--work', 'E:/retroflightsim-data/verify-satellite')!);
const exe = opt('--exe');
const keep = args.includes('--keep');
const PORT = '47821';

const tsx = (script: string, ...rest: string[]) => {
    console.log(`> ${script} ${rest.join(' ')}`);
    execFileSync(process.execPath, ['--import', 'tsx', script, ...rest], { stdio: 'inherit' });
};

/** Every file under `dir`, relative, sorted. */
function walk(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...walk(p, base));
        } else {
            out.push(path.relative(base, p).split(path.sep).join('/'));
        }
    }
    return out.sort();
}

function startSatellite(): ChildProcess {
    const satArgs = ['--coordinator', `127.0.0.1:${PORT}`, '--once', '--threads', '3', '--name', 'verify',
        '--cache', path.join(work, 'cache')];
    const child = exe
        ? spawn(exe, satArgs, { stdio: 'inherit' })
        : spawn(process.execPath, ['--import', 'tsx', 'tools/satellite/satellite.ts', ...satArgs], { stdio: 'inherit' });
    return child;
}

async function bakeBoth(script: string, a: string, b: string, extra: string[]): Promise<void> {
    tsx(script, '--dir', a, '--bbox', bbox, '--jobs', '3', ...extra);
    const sat = startSatellite();
    const exited = new Promise<number | null>(r => sat.on('exit', code => r(code)));
    try {
        tsx(script, '--dir', b, '--bbox', bbox, '--jobs', '0', '--satellite-port', PORT, ...extra);
    } finally {
        // --once: it leaves when the bake does; give it a moment, then make sure.
        const code = await Promise.race([exited, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), 10_000))]);
        if (code === 'timeout') {
            sat.kill();
        }
    }
}

async function main(): Promise<void> {
    fs.rmSync(work, { recursive: true, force: true });
    const base = path.join(work, 'base'), a = path.join(work, 'local'), b = path.join(work, 'satellite');
    fs.mkdirSync(base, { recursive: true });
    // Without its cache the mesh bake decodes every cover tile of the planet for the regional ground colours.
    if (fs.existsSync(path.join('assets', 'terrain', GROUND_MEANS_FILE))) {
        fs.copyFileSync(path.join('assets', 'terrain', GROUND_MEANS_FILE), path.join(base, GROUND_MEANS_FILE));
    }
    tsx('tools/bake_planet_mesh.ts', '--out', base, '--bbox', bbox);
    tsx('tools/bake_planet_roads.ts', '--dir', base, '--bbox', bbox);
    tsx('tools/bake_planet_bridges.ts', '--dir', base, '--bbox', bbox);
    fs.cpSync(base, a, { recursive: true });
    fs.cpSync(base, b, { recursive: true });

    await bakeBoth('tools/bake_planet_grade.ts', a, b, []);
    await bakeBoth('tools/bake_planet_farland.ts', a, b, []);

    const fa = walk(a), fb = walk(b);
    const onlyA = fa.filter(f => !fb.includes(f)), onlyB = fb.filter(f => !fa.includes(f));
    const differ = fa.filter(f => fb.includes(f) && !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))));
    const changed = fa.filter(f => !fs.existsSync(path.join(base, f)) || !fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(base, f))));
    console.log(`\n${fa.length} files, ${changed.length} written by the grade and far land locally`);
    for (const [label, list] of [['only local', onlyA], ['only satellite', onlyB], ['different', differ]] as const) {
        if (list.length > 0) {
            console.log(`${label}: ${list.length}\n  ${list.slice(0, 20).join('\n  ')}`);
        }
    }
    const ok = onlyA.length === 0 && onlyB.length === 0 && differ.length === 0 && changed.length > 0;
    console.log(ok ? 'SAME: the satellite baked every file byte for byte as the local workers did'
        : changed.length === 0 ? 'NOTHING GRADED: pick a box with roads' : 'DIFFERENT');
    if (!keep && ok) {
        fs.rmSync(work, { recursive: true, force: true });
    }
    process.exitCode = ok ? 0 : 1;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
