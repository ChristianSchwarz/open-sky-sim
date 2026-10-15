// Pack the baked terrain tree for hosting: every gzip-transport tile
// re-encoded as Brotli, everything else copied as is.
//
//   node tools/pack_terrain_br.mjs --out E:\retroflightsim-data\terrain-br [--src assets/terrain] [--jobs N]
//
// The bake reads and writes gzip (every stage reads tiles back), so the tree it
// works in stays gzip; this makes the copy that ships. Measured on 300 DACH
// leaves: .ptm 25 % and .pfl 31 % smaller than gzip -9 at quality 11 and a
// 16 MB window. The page needs nothing new: a host serving these files with
// Content-Encoding: br hands it the raw tile, as gzip does today
// (tileStore.ts). tools/upload_terrain.mjs sees the marker file this writes
// and uploads the tiles with that header.
//
// Incremental: a tile whose packed copy is newer than its source is skipped,
// so a re-bake only re-packs what it touched. Packed files whose source is
// gone are not removed; pack into a fresh directory for a new version.
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';

/** The formats stored gzipped on disk (manifest `transport: 'gzip'`). */
export const GZIP_EXTS = new Set(['.ptm', '.ptx', '.ptr', '.pbr', '.pbd', '.pfl', '.pbh']);
/** Marker an uploader reads to know the tiles are Brotli. */
export const MARKER = 'PACKED_BROTLI';

const BROTLI = {
    params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC,
    },
};

/** Re-encodes one gzip tile as Brotli; returns [gzip bytes, brotli bytes]. */
export function packFile(src, dst) {
    const gz = fs.readFileSync(src);
    const raw = zlib.gunzipSync(gz);
    const br = zlib.brotliCompressSync(raw, BROTLI);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.part`;
    fs.writeFileSync(tmp, br);
    fs.renameSync(tmp, dst);
    return [gz.length, br.length];
}

if (!isMainThread) {
    parentPort.on('message', ({ src, dst }) => {
        try {
            parentPort.postMessage({ ok: true, sizes: packFile(src, dst) });
        } catch (err) {
            parentPort.postMessage({ ok: false, error: `${src}: ${err.message}` });
        }
    });
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}

function* walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            yield* walk(p);
        } else if (e.isFile()) {
            yield p;
        }
    }
}

function upToDate(src, dst) {
    try {
        return fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs;
    } catch {
        return false;
    }
}

async function main() {
    const args = process.argv.slice(2);
    const opt = (name, fallback) => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : fallback;
    };
    const src = path.resolve(opt('src', 'assets/terrain'));
    const out = opt('out');
    if (!out) {
        console.error('usage: pack_terrain_br.mjs --out DIR [--src DIR] [--jobs N]');
        process.exit(2);
    }
    const dstRoot = path.resolve(out);
    if (dstRoot === src || dstRoot.startsWith(src + path.sep)) {
        console.error('--out must lie outside --src');
        process.exit(2);
    }
    const jobs = Math.max(1, Number(opt('jobs', Math.max(1, os.cpus().length - 2))));

    const todo = [];
    let copied = 0, skipped = 0;
    for (const file of walk(src)) {
        const rel = path.relative(src, file);
        // Half-written files, and the grade's first-pass beds, which never ship.
        if (rel.endsWith('.part') || rel.endsWith('.pbd1')) {
            continue;
        }
        const dst = path.join(dstRoot, rel);
        if (upToDate(file, dst)) {
            skipped++;
        } else if (GZIP_EXTS.has(path.extname(file))) {
            todo.push({ src: file, dst });
        } else {
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.copyFileSync(file, dst);
            copied++;
        }
    }
    console.log(`pack_terrain_br: ${todo.length} tiles to pack, ${copied} files copied, ${skipped} up to date, ${jobs} workers`);

    let gzTotal = 0, brTotal = 0, done = 0;
    const errors = [];
    const t0 = Date.now();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(jobs, todo.length) }, () => new Promise((resolve, reject) => {
        const w = new Worker(fileURLToPath(import.meta.url));
        const feed = () => {
            if (next >= todo.length) {
                w.terminate().then(() => resolve());
                return;
            }
            w.postMessage(todo[next++]);
        };
        w.on('message', m => {
            if (m.ok) {
                gzTotal += m.sizes[0];
                brTotal += m.sizes[1];
            } else {
                errors.push(m.error);
            }
            done++;
            if (done % 2000 === 0 || done === todo.length) {
                const s = (Date.now() - t0) / 1000;
                console.log(`  ${done}/${todo.length} packed, ${(gzTotal / 1e9).toFixed(2)} -> ${(brTotal / 1e9).toFixed(2)} GB, ${s.toFixed(0)} s`);
            }
            feed();
        });
        w.on('error', reject);
        feed();
    })));

    fs.writeFileSync(path.join(dstRoot, MARKER), 'tiles in this tree are Brotli; serve them with Content-Encoding: br\n');
    if (gzTotal > 0) {
        console.log(`packed ${done - errors.length} tiles: ${(gzTotal / 1e9).toFixed(2)} GB gzip -> ${(brTotal / 1e9).toFixed(2)} GB Brotli `
            + `(${(100 * (1 - brTotal / gzTotal)).toFixed(0)} % smaller)`);
    }
    if (errors.length > 0) {
        console.error(`${errors.length} tiles failed:\n  ${errors.slice(0, 20).join('\n  ')}`);
        process.exit(1);
    }
}
