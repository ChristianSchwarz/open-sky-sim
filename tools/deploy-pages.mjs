// Publishes a production build to the gh-pages branch for GitHub Pages.
//
//   npm run deploy:pages            build, commit to gh-pages, push to origin
//   npm run deploy:pages -- --no-push   stop after the local commit
//   npm run deploy:pages -- --terrain assets/terrain-mallorca
//                                   ship that tree as assets/terrain (see
//                                   tools/extract_area_tree.py)
//   npm run deploy:pages -- --no-packs  leave the aircraft mod packs out; a
//                                   static host never loads them anyway (they
//                                   are listed by the dev-only /api)
//   npm run deploy:pages -- --settings tools/pages-settings.json
//                                   first-run settings for players who have
//                                   saved none (settingsStorage.ts)
//
// The branch holds only the built site (one commit per deploy on top of the
// last, plain pushed), so the baked terrain never lands in the source history. The game is
// static and uses relative URLs, so it runs from /<repo>/ unchanged; /api is
// dev-server only and the UI already hides import features without it.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// GitHub Pages: about 1 GB per site, 100 MB per file.
const SITE_LIMIT = 1e9;
const FILE_LIMIT = 100e6;

const args = process.argv.slice(2);
const push = !args.includes('--no-push');
const packs = !args.includes('--no-packs');
const terrainAt = args.indexOf('--terrain');
const terrain = resolve(terrainAt >= 0 ? args[terrainAt + 1] : 'assets/terrain');
const settingsAt = args.indexOf('--settings');
// Parsed here so a broken file fails the deploy, not every first visit.
const settings = settingsAt >= 0
    ? JSON.stringify(JSON.parse(readFileSync(resolve(args[settingsAt + 1]), 'utf8')))
    : '';
const root = process.cwd();
const run = (cmd, cwd = root, env = process.env) => execSync(cmd, { cwd, stdio: 'inherit', env });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

if (!existsSync(join(terrain, 'manifest.json'))) {
    throw new Error(`${terrain}/manifest.json missing: bake terrain before deploying`);
}

rmSync(join(root, 'dist'), { recursive: true, force: true });
run('npx webpack --mode=production', root, { ...process.env, TERRAIN_DIR: terrain, DEFAULT_SETTINGS: settings });
if (packs) {
    run('npm run pack-mods');
}

let total = 0;
const tooBig = [];
const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(path);
        } else {
            const size = statSync(path).size;
            total += size;
            if (size > FILE_LIMIT) {
                tooBig.push(path);
            }
        }
    }
};
walk(join(root, 'dist'));
console.log(`dist is ${(total / 1e6).toFixed(1)} MB`);
if (total > SITE_LIMIT || tooBig.length) {
    throw new Error(`too big for GitHub Pages: ${(total / 1e6).toFixed(0)} MB`
        + (tooBig.length ? `; files over 100 MB: ${tooBig.join(', ')}` : ''));
}

const source = out('git rev-parse --short HEAD');
const dir = mkdtempSync(join(tmpdir(), 'gh-pages-'));
try {
    cpSync(join(root, 'dist'), dir, { recursive: true });
    // Without this Pages runs Jekyll, which drops files starting with "_".
    writeFileSync(join(dir, '.nojekyll'), '');
    run('git init -q -b gh-pages', dir);
    run('git add -A', dir);
    run(`git commit -q -m "Deploy ${source}"`, dir);
    run(`git fetch -q "${dir}" gh-pages`);
    const tree = out('git rev-parse FETCH_HEAD^{tree}');
    // On top of the live build, so a plain push publishes it. Git keeps each
    // unchanged file once, so a deploy adds only what changed (mostly the bundle).
    let parent = '';
    try {
        execSync('git fetch -q origin gh-pages', { cwd: root, stdio: 'ignore' });
        parent = ` -p ${out('git rev-parse FETCH_HEAD')}`;
    } catch {
        // No gh-pages on origin yet: the first deploy starts the branch.
    }
    const commit = out(`git commit-tree ${tree}${parent} -m "Deploy ${source}"`);
    run(`git update-ref refs/heads/gh-pages ${commit}`);
    console.log(`gh-pages now holds the build of ${source}`);
    if (push) {
        run('git push origin gh-pages');
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}
