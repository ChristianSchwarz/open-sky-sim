/**
 * The satellite's Python: the runtime tools/satellite/pack_python.py packed
 * (an interpreter and the packages the bake's Python stages import), built
 * into the exe as an asset and unpacked into the cache once per build.
 *
 * Format: 'RFSPY1', a little-endian u32 count, then per file a u16 path
 * length, the path (UTF-8, '/'), u32 raw size, u32 packed size, and the
 * raw-deflated bytes.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/** Unpack `archive` into `dir`; returns the number of files. */
export function unpackRuntime(archive: Uint8Array, dir: string): number {
    const buf = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
    if (buf.subarray(0, 6).toString('latin1') !== 'RFSPY1') {
        throw new Error('not a packed Python runtime');
    }
    const count = buf.readUInt32LE(6);
    let o = 10;
    const root = path.resolve(dir);
    for (let i = 0; i < count; i++) {
        const nameLen = buf.readUInt16LE(o);
        const rel = buf.subarray(o + 2, o + 2 + nameLen).toString('utf8');
        o += 2 + nameLen;
        const rawSize = buf.readUInt32LE(o), packedSize = buf.readUInt32LE(o + 4);
        o += 8;
        const p = path.resolve(root, ...rel.split('/'));
        if (!p.startsWith(root + path.sep)) {
            throw new Error(`refusing ${rel}: outside the runtime directory`);
        }
        const raw = zlib.inflateRawSync(buf.subarray(o, o + packedSize));
        o += packedSize;
        if (raw.byteLength !== rawSize) {
            throw new Error(`${rel} unpacked to ${raw.byteLength} bytes, not ${rawSize}`);
        }
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, raw);
    }
    return count;
}

/**
 * The runtime unpacked under `cacheDir` (once: a marker records the archive's
 * hash), and the interpreter's path.
 */
export function ensureRuntime(archive: Uint8Array, cacheDir: string, log: (s: string) => void): string {
    const sha = crypto.createHash('sha256').update(archive).digest('hex').slice(0, 16);
    const dir = path.join(cacheDir, 'python', sha);
    const marker = path.join(dir, '.unpacked');
    if (!fs.existsSync(marker)) {
        log(`unpacking the Python runtime (${(archive.byteLength / 1e6).toFixed(0)} MB, first run of this build)...`);
        fs.rmSync(dir, { recursive: true, force: true });
        const n = unpackRuntime(archive, dir);
        fs.writeFileSync(marker, String(n));
        // Older builds' runtimes are not needed any more.
        for (const old of fs.readdirSync(path.join(cacheDir, 'python'))) {
            if (old !== sha) {
                fs.rmSync(path.join(cacheDir, 'python', old), { recursive: true, force: true });
            }
        }
        log(`Python runtime ready (${n} files)`);
    }
    return path.join(dir, 'python.exe');
}
