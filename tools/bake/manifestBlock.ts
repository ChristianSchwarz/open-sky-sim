import * as fs from 'node:fs';

/**
 * Set one top-level block of a terrain `manifest.json` and write it back.
 *
 * Stages run side by side (roads beside tex, grade beside farland), and each
 * read the manifest at start-up. Writing that copy back would drop a block
 * another stage wrote meanwhile, so the file is re-read here, just before the
 * write, and only `key` is replaced. The write goes through a temporary file
 * so a reader never sees half a manifest.
 */
export function writeManifestBlock(manifestPath: string, key: string, block: unknown): void {
    const latest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    latest[key] = block;
    const tmp = `${manifestPath}.tmp${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(latest, null, 2)}\n`);
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(tmp, manifestPath);
            return;
        } catch (err) {
            // Windows refuses a rename over a file another process has open
            // for a moment; give it a few tries before failing the stage.
            if (attempt >= 20) throw err;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}
