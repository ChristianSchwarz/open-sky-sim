/**
 * Validate a baked terrain tree without decoding whole payloads.
 *
 * Catches the failure mode a partial or interrupted bake produces: files that
 * exist but do not agree with the manifest or the index, which at runtime would
 * show up as holes in the terrain rather than as an error.
 *
 * Usage:
 *   node --import tsx tools/verify_planet.ts [--dir assets/terrain] [--sample N]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { decodePtm } from '../src/script/terrain/ptm';
import { CLASS_COUNT } from '../src/script/terrain/tones';

interface Args {
    dir: string;
    sample?: number;
}

function parseArgs(argv: string[]): Args {
    const a: Args = { dir: 'assets/terrain' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--dir') a.dir = argv[++i];
        else if (argv[i] === '--sample') a.sample = Number(argv[++i]);
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return a;
}

const INDEX_MAGIC = 0x31584950;

function readIndex(bytes: Uint8Array): Set<string> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 8 || view.getUint32(0, true) !== INDEX_MAGIC) {
        throw new Error('bad index magic');
    }
    const minZoom = view.getUint16(4, true);
    const maxZoom = view.getUint16(6, true);
    const count = maxZoom - minZoom + 1;
    const headers: Array<{ z: number; minX: number; minY: number; w: number; h: number }> = [];
    let o = 8;
    for (let i = 0; i < count; i++) {
        headers.push({
            z: minZoom + i,
            minX: view.getUint32(o, true),
            minY: view.getUint32(o + 4, true),
            w: view.getUint32(o + 8, true),
            h: view.getUint32(o + 12, true),
        });
        o += 16;
    }
    const out = new Set<string>();
    for (const h of headers) {
        const bits = bytes.subarray(o, o + Math.ceil((h.w * h.h) / 8));
        o += Math.ceil((h.w * h.h) / 8);
        for (let i = 0; i < h.w * h.h; i++) {
            if (bits[i >> 3] & (1 << (i & 7))) {
                out.add(`${h.z}/${h.minX + (i % h.w)}/${h.minY + Math.floor(i / h.w)}`);
            }
        }
    }
    return out;
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const dir = args.dir;
    const problems: string[] = [];
    const note = (m: string) => problems.push(m);

    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error(`error: no manifest at ${manifestPath}`);
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.scheme !== 'retro-terrain/1') {
        note(`unexpected scheme ${manifest.scheme}`);
    }
    const budget: number = manifest.mesh?.triangleBudget ?? Infinity;

    const indexPath = path.join(dir, manifest.mesh?.indexPath ?? 'index_mesh.bin');
    if (!fs.existsSync(indexPath)) {
        console.error(`error: no index at ${indexPath}`);
        process.exit(1);
    }
    const indexed = readIndex(new Uint8Array(fs.readFileSync(indexPath)));

    // Walk the tree.
    const onDisk: string[] = [];
    for (const zs of fs.readdirSync(dir)) {
        const zDir = path.join(dir, zs);
        if (!/^\d+$/.test(zs) || !fs.statSync(zDir).isDirectory()) {
            continue;
        }
        for (const xs of fs.readdirSync(zDir)) {
            const xDir = path.join(zDir, xs);
            if (!fs.statSync(xDir).isDirectory()) {
                continue;
            }
            for (const f of fs.readdirSync(xDir)) {
                if (f.endsWith('.ptm')) {
                    onDisk.push(`${zs}/${xs}/${f.slice(0, -4)}`);
                }
            }
        }
    }

    for (const key of indexed) {
        if (!fs.existsSync(path.join(dir, `${key}.ptm`))) {
            note(`indexed but missing on disk: ${key}`);
        }
    }
    for (const key of onDisk) {
        if (!indexed.has(key)) {
            note(`on disk but not indexed: ${key}`);
        }
    }

    const step = args.sample && args.sample < onDisk.length
        ? Math.ceil(onDisk.length / args.sample)
        : 1;
    let checked = 0;
    let totalTris = 0;
    let maxTris = 0;
    let totalBytes = 0;

    for (let i = 0; i < onDisk.length; i += step) {
        const key = onDisk[i];
        const [z, x, y] = key.split('/').map(Number);
        const file = path.join(dir, `${key}.ptm`);
        const raw = fs.readFileSync(file);
        totalBytes += raw.byteLength;
        let bytes: Uint8Array;
        try {
            bytes = raw[0] === 0x1f && raw[1] === 0x8b
                ? new Uint8Array(zlib.gunzipSync(raw))
                : new Uint8Array(raw);
        } catch (err) {
            note(`${key}: gunzip failed (${(err as Error).message})`);
            continue;
        }
        let tile;
        try {
            tile = decodePtm(bytes);
        } catch (err) {
            note(`${key}: decode failed (${(err as Error).message})`);
            continue;
        }
        checked++;
        if (tile.id.z !== z || tile.id.x !== x || tile.id.y !== y) {
            note(`${key}: header says ${tile.id.z}/${tile.id.x}/${tile.id.y}`);
        }
        const tris = tile.landPositions.length / 9 + tile.waterIndices.length / 3;
        totalTris += tris;
        maxTris = Math.max(maxTris, tris);
        if (tris > budget) {
            note(`${key}: ${tris} triangles exceeds budget ${budget}`);
        }
        if (tris === 0) {
            note(`${key}: empty tile`);
        }
        if (!(tile.boundingRadiusM > 0) || !Number.isFinite(tile.boundingRadiusM)) {
            note(`${key}: bad bounding radius ${tile.boundingRadiusM}`);
        }
        if (!Number.isFinite(tile.centerHeightM)) {
            note(`${key}: bad centre height`);
        }
        if (!(tile.geometricErrorM > 0) || !Number.isFinite(tile.geometricErrorM)) {
            note(`${key}: bad geometric error ${tile.geometricErrorM}`);
        }
        if (!(tile.quantScale > 0)) {
            note(`${key}: bad quantisation scale ${tile.quantScale}`);
        }
        for (let v = 3; v < tile.landAttrs.length; v += 4) {
            const c = tile.landAttrs[v];
            if (c >= CLASS_COUNT) {
                note(`${key}: land vertex ${(v - 3) / 4} has cover class ${c}`);
                break;
            }
        }
        for (let v = 0; v < tile.waterTones.length; v++) {
            const t = tile.waterTones[v];
            if (t > 1) {
                note(`${key}: water vertex ${v} has tone ${t}`);
                break;
            }
        }
        for (let i2 = 0; i2 < tile.waterIndices.length; i2++) {
            if (tile.waterIndices[i2] >= tile.waterTones.length) {
                note(`${key}: water index out of range`);
                break;
            }
        }
    }

    console.log(`${dir}: ${onDisk.length} tiles on disk, ${indexed.size} indexed`);
    console.log(`  checked ${checked}${step > 1 ? ` (every ${step}th)` : ''}`);
    if (checked > 0) {
        console.log(`  triangles: mean ${Math.round(totalTris / checked)}, max ${maxTris}`
            + `, budget ${budget}`);
        console.log(`  total ${(totalBytes / 1048576).toFixed(1)} MB`);
    }
    if (problems.length === 0) {
        console.log('OK');
        return;
    }
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems.slice(0, 40)) {
        console.log(`  ${p}`);
    }
    if (problems.length > 40) {
        console.log(`  ... and ${problems.length - 40} more`);
    }
    process.exit(1);
}

main();
