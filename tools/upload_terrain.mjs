// Upload the baked terrain tree to an S3-compatible bucket (Cloudflare R2).
//
//   node tools/upload_terrain.mjs --bucket retro-terrain --version v1 \
//        --endpoint https://<account>.r2.cloudflarestorage.com [--dry-run]
//
// Needs the AWS CLI on PATH and credentials in AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY (an R2 API token). Everything lands under <version>/,
// so a re-bake is a new version and old URLs stay valid in every cache.
import { spawnSync } from 'child_process';
import path from 'path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
const bucket = opt('bucket');
const version = opt('version');
const endpoint = opt('endpoint');
const src = path.resolve(opt('src', 'assets/terrain'));
const dryRun = args.includes('--dry-run');
if (!bucket || !version || !endpoint) {
    console.error('usage: upload_terrain.mjs --bucket B --version vN --endpoint URL [--src DIR] [--dry-run]');
    process.exit(2);
}

const IMMUTABLE = 'public, max-age=31536000, immutable';
// [glob, content type, content encoding]. The gzip-transport formats are stored
// gzipped on disk, so they must be served with Content-Encoding: gzip; the
// page inflates them itself if a host drops the header (tileStore.ts).
const groups = [
    ['*.ptm', 'application/octet-stream', 'gzip'],
    ['*.ptx', 'application/octet-stream', 'gzip'],
    ['*.ptr', 'application/octet-stream', 'gzip'],
    ['*.pbr', 'application/octet-stream', 'gzip'],
    ['*.pdm', 'application/octet-stream', null], // zlib, inflated in JS
    ['*.bin', 'application/octet-stream', null],
    ['*.json', 'application/json', null],
];

let failed = false;
for (const [glob, type, encoding] of groups) {
    const cmd = [
        's3', 'sync', src, `s3://${bucket}/${version}/`,
        '--endpoint-url', endpoint,
        '--exclude', '*', '--include', glob, '--include', `*/${glob}`,
        '--content-type', type,
        '--cache-control', IMMUTABLE,
        '--no-progress',
    ];
    if (encoding) cmd.push('--content-encoding', encoding);
    if (dryRun) cmd.push('--dryrun');
    console.log(`\n== ${glob}${encoding ? ` (Content-Encoding: ${encoding})` : ''}`);
    const r = spawnSync('aws', cmd, { stdio: 'inherit' });
    if (r.status !== 0) { failed = true; }
}
if (failed) {
    console.error('\nSome uploads failed; re-run, sync only sends what is missing.');
    process.exit(1);
}
console.log(`\nDone. Build the game with:\n  TERRAIN_URL=https://<your-domain>/${version}/manifest.json npm run build:prod`);
