/**
 * Build the bake satellite (tools/satellite/satellite.ts) into one exe:
 * dist/satellite/retroflightsim-satellite.exe, a Node single executable with
 * everything it runs built in - the client, the tile code
 * (tools/satellite/computeWorker.ts, see computeBundle.ts) and the shared
 * token (data/satellite/token). Copy it to another machine and run it; see
 * tools/bake/tilePool.ts for the bake's side.
 *
 * A satellite whose tile code differs from a bake's fetches the bake's copy,
 * so a code change needs no rebuild; a new token or SATELLITE_PROTOCOL does.
 *
 *   node --import tsx tools/build_satellite.ts [--out DIR]   (default dist/satellite)
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { bundleCompute } from './satellite/computeBundle';
import { satelliteToken } from './bake/tilePool';

async function main(): Promise<void> {
    const root = path.join(__dirname, '..');
    const outArg = process.argv.indexOf('--out');
    const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'dist', 'satellite');
    const work = path.join(out, '.build');
    const exe = path.join(out, `retroflightsim-satellite${process.platform === 'win32' ? '.exe' : ''}`);

    const compute = await bundleCompute();
    fs.mkdirSync(work, { recursive: true });
    await esbuild.build({
        entryPoints: [path.join(root, 'tools', 'satellite', 'satellite.ts')],
        outfile: path.join(work, 'satellite.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning',
        // The checkout-only path (bundling the tile code at start) is never taken in the exe.
        external: ['esbuild'],
        define: { __SAT_TOKEN__: JSON.stringify(satelliteToken()), __SAT_COMPUTE__: JSON.stringify(compute.code) },
    });
    fs.writeFileSync(path.join(work, 'sea.json'), JSON.stringify({
        main: path.join(work, 'satellite.cjs'), output: path.join(work, 'blob.bin'), disableExperimentalSEAWarning: true,
    }));
    execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea.json')], { stdio: 'ignore' });
    fs.copyFileSync(process.execPath, exe);
    // Through this node, not npx.cmd (a .cmd needs a shell, which concatenates
    // the arguments); npx keeps postject out of the project's dependencies.
    const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    execFileSync(process.execPath,
        [npxCli, '--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', path.join(work, 'blob.bin'),
            '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
        { stdio: ['ignore', 'ignore', 'inherit'] });
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`${exe} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB, node ${process.versions.node}, tile code ${compute.sha.slice(0, 12)})`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
