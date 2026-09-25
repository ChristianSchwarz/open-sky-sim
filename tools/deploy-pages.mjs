// Publishes a production build to the gh-pages branch for GitHub Pages.
//
//   npm run deploy:pages            build, commit to gh-pages, push to origin
//   npm run deploy:pages -- --no-push   stop after the local commit
//
// The branch holds only the built site (one fresh commit each deploy, force
// pushed), so the baked terrain never lands in the source history. The game is
// static and uses relative URLs, so it runs from /<repo>/ unchanged; /api is
// dev-server only and the UI already hides import features without it.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const push = !process.argv.includes('--no-push');
const root = process.cwd();
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });
const out = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

if (!existsSync(join(root, 'assets/terrain/manifest.json'))) {
    throw new Error('assets/terrain/manifest.json missing: bake terrain before deploying');
}

rmSync(join(root, 'dist'), { recursive: true, force: true });
run('npm run build:prod');

const source = out('git rev-parse --short HEAD');
const dir = mkdtempSync(join(tmpdir(), 'gh-pages-'));
try {
    cpSync(join(root, 'dist'), dir, { recursive: true });
    // Without this Pages runs Jekyll, which drops files starting with "_".
    writeFileSync(join(dir, '.nojekyll'), '');
    run('git init -q -b gh-pages', dir);
    run('git add -A', dir);
    run(`git commit -q -m "Deploy ${source}"`, dir);
    run(`git fetch -q "${dir}" gh-pages:gh-pages --force`);
    console.log(`gh-pages now holds the build of ${source}`);
    if (push) {
        run('git push --force origin gh-pages');
    }
} finally {
    rmSync(dir, { recursive: true, force: true });
}
