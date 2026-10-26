/**
 * The satellites' tile code (computeWorker.ts) as one script, and its hash:
 * built into the exe by tools/build_satellite.ts, and built again by every
 * bake that takes satellites (tools/bake/tilePool.ts), which turns away a
 * satellite whose hash differs - one built before the tile code last changed.
 *
 * Both sides must produce the same bytes from the same tree, so the options
 * live here only. The working directory is pinned to the checkout because
 * esbuild writes each module's path into the bundle.
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

export async function bundleCompute(): Promise<{ code: string; sha: string }> {
    const esbuild = await import('esbuild');
    const r = await esbuild.build({
        entryPoints: [path.join(ROOT, 'tools', 'satellite', 'computeWorker.ts')], absWorkingDir: ROOT,
        bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false, logLevel: 'silent',
    });
    const code = r.outputFiles[0].text;
    return { code, sha: crypto.createHash('sha256').update(code).digest('hex') };
}
