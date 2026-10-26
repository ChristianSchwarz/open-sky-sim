/**
 * Do satellites bake an import's chunk stages as this machine does? Builds a
 * small scratch pyramid from scratch (heights, extract), copies it, and runs
 * the chunk stages (tools/chunk_pool.ts: coast, roads, buildings, then the
 * airfields here, then cover) over one copy with local workers and over the
 * other with satellites only, the box cut into small chunks so their edges
 * are crossed; then compares every file of the two pyramids byte for byte.
 *
 * With --normal a third copy is baked the way the import does it, chunk after
 * chunk with every stage, and compared too, for information: a stage that
 * reads what another chunk's later stage writes (the airfields read the
 * coast's land mask, the cover the airfields' pads) can come out otherwise
 * near a chunk's edge when stages run across all chunks first.
 *
 *   node --import tsx tools/verify_chunks.ts [options]
 *
 *     --bbox w,s,e,n  the box (default 10.94,47.42,11.12,47.52: lakes, roads, villages)
 *     --chunk-deg D   chunk side (default 0.09, two leaves)
 *     --work DIR      scratch directory, emptied first (default E:/retroflightsim-data/verify-chunks)
 *     --data-cwd DIR  where the DEM cache and the Geofabrik extracts live (default: here)
 *     --normal        also bake the import's own way and compare
 *     --keep          keep the scratch pyramids
 */

import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOKEN_FILE } from './bake/tilePool';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
};
const bbox = opt('--bbox', '10.94,47.42,11.12,47.52')!;
const chunkDeg = opt('--chunk-deg', '0.09')!;
const work = path.resolve(opt('--work', 'E:/retroflightsim-data/verify-chunks')!);
const dataCwd = path.resolve(opt('--data-cwd', '.')!);
const normal = args.includes('--normal');
const keep = args.includes('--keep');
const PYTHON = process.env.PYTHON || 'python';
const PORT = '47825';
const STAGES = ['coast', 'roads', 'buildings', 'cover'] as const;

const run = (cmd: string, argv: string[], cwd = process.cwd()) => {
    console.log(`> ${path.basename(argv.find(a => a.endsWith('.py') || a.endsWith('.ts')) ?? cmd)} ${argv.filter(a => !a.endsWith('.py') && !a.endsWith('.ts')).join(' ')}`);
    execFileSync(cmd, argv, { stdio: 'inherit', cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
};
const py = (script: string, ...rest: string[]) => run(PYTHON, ['-X', 'utf8', path.resolve('tools', script), ...rest]);
const tsx = (script: string, ...rest: string[]) => run(process.execPath, ['--import', 'tsx', script, ...rest]);

function walk(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...walk(p, base));
        } else if (!e.name.endsWith('.lock')) {
            out.push(path.relative(base, p).split(path.sep).join('/'));
        }
    }
    return out.sort();
}

function sameFile(a: string, b: string): boolean {
    const x = fs.readFileSync(a), y = fs.readFileSync(b);
    if (x.equals(y)) {
        return true;
    }
    if (!a.endsWith('.json')) {
        return false;
    }
    const strip = (s: string) => JSON.stringify(JSON.parse(s, (k, v: unknown) => (k === 'utc' ? undefined : v)));
    return strip(x.toString()) === strip(y.toString());
}

function compare(label: string, a: string, b: string): boolean {
    const fa = walk(a), fb = walk(b);
    const inA = new Set(fa), inB = new Set(fb);
    const onlyA = fa.filter(f => !inB.has(f)), onlyB = fb.filter(f => !inA.has(f));
    const differ = fa.filter(f => inB.has(f) && !sameFile(path.join(a, f), path.join(b, f)));
    const byExt = (list: string[]) => {
        const m = new Map<string, number>();
        for (const f of list) {
            const e = path.extname(f) || f;
            m.set(e, (m.get(e) ?? 0) + 1);
        }
        return [...m].map(([e, n]) => `${e} ${n}`).join(', ');
    };
    console.log(`\n${label}: ${fa.length} files`);
    for (const [what, list] of [['only in the first', onlyA], ['only in the second', onlyB], ['different', differ]] as const) {
        if (list.length > 0) {
            console.log(`  ${what}: ${list.length} (${byExt(list)})\n    ${list.slice(0, 12).join('\n    ')}`);
        }
    }
    const same = onlyA.length === 0 && onlyB.length === 0 && differ.length === 0;
    console.log(same ? '  SAME' : '  DIFFERENT');
    return same;
}

function startSatellite(): ChildProcess {
    return spawn(process.execPath, ['--import', 'tsx', 'tools/satellite/satellite.ts', '--coordinator', `127.0.0.1:${PORT}`,
        '--once', '--threads', '3', '--name', 'verify-chunks', '--cache', path.join(work, 'satcache')], { stdio: 'inherit' });
}

async function chunkStage(stage: string, planet: string, pbf: string, satellites: boolean): Promise<void> {
    const common = ['tools/chunk_pool.ts', '--stage', stage, '--bbox', bbox, '--pbf', pbf, '--planet', planet, '--chunk-deg', chunkDeg];
    if (!satellites) {
        tsx(...common as [string, ...string[]], '--jobs', '1');
        return;
    }
    const sat = startSatellite();
    const exited = new Promise<void>(r => sat.on('exit', () => r()));
    try {
        tsx(...common as [string, ...string[]], '--jobs', '0', '--satellite-port', PORT, '--no-discovery');
    } finally {
        await Promise.race([exited, new Promise(r => setTimeout(r, 10_000))]);
        sat.kill();
    }
}

async function main(): Promise<void> {
    if (!fs.existsSync(TOKEN_FILE)) {
        throw new Error(`no ${TOKEN_FILE}: copy it from the checkout the satellites were built from`);
    }
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const tif = path.join(work, 'dem.tif'), pbf = path.join(work, 'box.osm.pbf'), base = path.join(work, 'base');
    // The DEM cache and the extracts are wherever --data-cwd says.
    run(PYTHON, ['-X', 'utf8', path.resolve('tools', 'fetch_planet_dem.py'), `--bbox=${bbox}`, '--out', tif], dataCwd);
    run(PYTHON, ['-X', 'utf8', path.resolve('tools', 'osm_extract.py'), `--bbox=${bbox}`, '--out', pbf], dataCwd);
    py('bake_planet_dem.py', '--input', tif, '--out', base, '--name', 'Verify');

    const chunks = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '-e',
        `const {chunkBbox,snapBboxToTiles}=require('./tools/areaImport.ts');`
        + `console.log(JSON.stringify(chunkBbox(snapBboxToTiles([${bbox}]),${chunkDeg})))`], { encoding: 'utf8' })) as number[][];
    const trees = { local: path.join(work, 'local'), satellite: path.join(work, 'satellite') };
    for (const t of Object.values(trees)) {
        fs.cpSync(base, t, { recursive: true });
    }
    for (const [name, tree] of Object.entries(trees)) {
        for (const stage of STAGES) {
            if (stage === 'cover') {
                // The airfields, here in both and per chunk as the import runs them: the cover
                // paints their pads, and they read the coast's land mask.
                for (const c of chunks) {
                    py('bake_osm_airports.py', '--out', tree, `--bbox=${c.join(',')}`, `--pbf=${pbf}`);
                }
            }
            await chunkStage(stage, tree, pbf, name === 'satellite');
        }
    }
    const ok = compare('local workers vs satellites only', trees.local, trees.satellite);

    if (normal) {
        // The import's own order, chunk after chunk (areaImport.ts dataSteps), with the same chunks.
        const tree = path.join(work, 'normal');
        fs.cpSync(base, tree, { recursive: true });
        for (const c of chunks) {
            const b = `--bbox=${c.join(',')}`;
            const coverDir = path.join(work, 'normal-cover', c.join('_'));
            py('bake_osm_coast.py', '--out', tree, b, '--osm-landuse', `--pbf=${pbf}`, '--allow-tiny-land');
            py('bake_osm_roads.py', '--out', tree, b, `--pbf=${pbf}`);
            py('bake_osm_buildings.py', '--out', tree, b, `--pbf=${pbf}`);
            py('bake_osm_airports.py', '--out', tree, b, `--pbf=${pbf}`);
            py('fetch_cover_sources.py', b, `--out=${coverDir}`);
            py('bake_planet_cover.py', '--src', tree, b, '--osm-landuse', `--pbf=${pbf}`, `--sources=${path.join(coverDir, 'sources.json')}`);
        }
        compare('chunk stages (local) vs the import\'s own order (for information)', trees.local, tree);
    }
    if (!keep && ok) {
        fs.rmSync(work, { recursive: true, force: true });
    }
    process.exitCode = ok ? 0 : 1;
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
