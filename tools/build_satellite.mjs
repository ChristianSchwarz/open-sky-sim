// Build the bake satellite (tools/satellite/satellite.ts) into one exe:
// dist/satellite/retroflightsim-satellite.exe, a Node single executable with
// the shared token (data/satellite/token) built in. Copy it to another machine
// and run it; see tools/bake/tilePool.ts for the bake's side.
//
// The exe holds only the client: the tile code comes from the bake each time,
// so it needs rebuilding only when the protocol changes (SATELLITE_PROTOCOL)
// or the token does.
//
//   node tools/build_satellite.mjs [--out DIR]   (default dist/satellite)

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')));
const outArg = process.argv.indexOf('--out');
const out = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(root, 'dist', 'satellite');
const work = path.join(out, '.build');
const tokenFile = path.join(root, 'data', 'satellite', 'token');
const exe = path.join(out, `retroflightsim-satellite${process.platform === 'win32' ? '.exe' : ''}`);

if (!fs.existsSync(tokenFile)) {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('hex'));
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();

fs.mkdirSync(work, { recursive: true });
await esbuild.build({
    entryPoints: [path.join(root, 'tools', 'satellite', 'satellite.ts')],
    outfile: path.join(work, 'satellite.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning',
    define: { __SAT_TOKEN__: JSON.stringify(token) },
});
fs.writeFileSync(path.join(work, 'sea.json'), JSON.stringify({
    main: path.join(work, 'satellite.cjs'), output: path.join(work, 'blob.bin'), disableExperimentalSEAWarning: true,
}));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea.json')], { stdio: 'inherit' });
fs.copyFileSync(process.execPath, exe);
// npx keeps postject out of the project's dependencies; it only patches the exe.
// Run through this node, not npx.cmd: a .cmd needs a shell, which concatenates the arguments.
const npxCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
execFileSync(process.execPath,
    [npxCli, '--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', path.join(work, 'blob.bin'),
        '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
    { stdio: ['ignore', 'ignore', 'inherit'] });
fs.rmSync(work, { recursive: true, force: true });
console.log(`${exe} (${(fs.statSync(exe).size / 1e6).toFixed(0)} MB, node ${process.versions.node})`);
