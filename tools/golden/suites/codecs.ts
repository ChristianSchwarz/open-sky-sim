/**
 * Terrain codec fixtures (workstream B): the eight binary tile formats plus the
 * PIX1 existence index and PDM height sampling.
 *
 * The tile files themselves are checked in under tests/golden/tiles so the
 * fixtures (and the C# tests) are hermetic: nothing here needs the 17 GB
 * `assets/terrain` tree except `--select-tiles`, which refreshes the copies.
 *
 * For each tile the fixture records the header scalars and, for every typed
 * array, `{type, length, fnv1a32, head}` where the hash is FNV-1a over the
 * array's raw little-endian bytes. The C# decoders must produce the same
 * bytes from the same inflated input.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { decodePdm, sampleBilinear, sampleNearest } from '../../../src/script/terrain/demTile';
import { decodePbd } from '../../../src/script/terrain/pbd';
import { decodePbh } from '../../../src/script/terrain/pbh';
import { decodePbr } from '../../../src/script/terrain/pbr';
import { decodePfl } from '../../../src/script/terrain/pfl';
import { decodePtm } from '../../../src/script/terrain/ptm';
import { decodePtr } from '../../../src/script/terrain/ptr';
import { decodePtx } from '../../../src/script/terrain/ptx';
import { TileIndex } from '../../../src/script/terrain/tileIndex';
import { tileAtLonLat, tileKeyString, TileKey } from '../../../src/script/terrain/tiling';
import { describe, fnv1a32, hex32, Rng, sha256Hex, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

/** Where we look for tiles worth keeping, in preference order. */
const SITES: ReadonlyArray<readonly [string, number, number]> = [
    ['Gran Canaria', -15.58, 27.95],
    ['Munich', 11.57, 48.14],
    ['Berlin', 13.40, 52.52],
    ['Crimea', 34.00, 44.50],
];

/** Per extension: zooms to sample, and how many sites to take from each. */
const PLAN: ReadonlyArray<{ ext: string; zooms: number[]; sites: number }> = [
    { ext: 'ptm', zooms: [0, 4, 8, 10, 11, 12], sites: 1 },
    { ext: 'pdm', zooms: [0, 5, 7, 9, 11], sites: 1 },
    { ext: 'ptx', zooms: [5, 8, 10, 11], sites: 1 },
    { ext: 'ptr', zooms: [8, 10, 12], sites: 1 },
    { ext: 'pbd', zooms: [8, 10, 12], sites: 1 },
    { ext: 'pbr', zooms: [12], sites: 3 },
    { ext: 'pbh', zooms: [12], sites: 3 },
    { ext: 'pfl', zooms: [12], sites: 3 },
];

/** Larger z12 mesh sample so decode is exercised on a dense tile. */
const EXTRA_PTM_Z12_SITES = 3;
const MAX_TILE_BYTES = 450 * 1024;
const MIN_TILE_BYTES = 600;
const INDEX_FILES = [
    'index.bin', 'index_mesh.bin', 'index_tex.bin', 'index_roads.bin', 'index_beds.bin',
    'index_bridges.bin', 'index_farland.bin', 'index_buildings.bin',
];

function tilePath(root: string, ext: string, k: TileKey): string {
    return path.join(root, `${k.z}`, `${k.x}`, `${k.y}.${ext}`);
}

function fixtureName(ext: string, k: TileKey): string {
    return `${k.z}_${k.x}_${k.y}.${ext}`;
}

/** Ring search outward from a tile for the nearest one that exists and is a usable size. */
function findNear(root: string, ext: string, start: TileKey, radius: number, taken: Set<string>): TileKey | undefined {
    for (let r = 0; r <= radius; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const k = { z: start.z, x: start.x + dx, y: start.y + dy };
                const p = tilePath(root, ext, k);
                if (!fs.existsSync(p)) continue;
                const size = fs.statSync(p).size;
                if (size < MIN_TILE_BYTES || size > MAX_TILE_BYTES) continue;
                if (taken.has(`${ext}/${fixtureName(ext, k)}`)) continue;
                return k;
            }
        }
    }
    return undefined;
}

/** Copy the representative tiles and index files from the baked tree into the fixture folder. */
export function selectTiles(ctx: SuiteContext): number {
    const outDir = path.join(ctx.goldenRoot, 'tiles');
    fs.rmSync(outDir, { recursive: true, force: true });
    const taken = new Set<string>();
    let count = 0;
    const copy = (ext: string, k: TileKey): void => {
        const dest = path.join(outDir, ext, fixtureName(ext, k));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(tilePath(ctx.terrainRoot, ext, k), dest);
        taken.add(`${ext}/${fixtureName(ext, k)}`);
        count++;
    };
    for (const { ext, zooms, sites } of PLAN) {
        for (const z of zooms) {
            const wantSites = ext === 'ptm' && z === 12 ? EXTRA_PTM_Z12_SITES : sites;
            let got = 0;
            for (const [, lon, lat] of SITES) {
                if (got >= wantSites) break;
                const k = findNear(ctx.terrainRoot, ext, tileAtLonLat(z, lon, lat), ext === 'pbh' ? 60 : 8, taken);
                if (k) {
                    copy(ext, k);
                    got++;
                }
            }
        }
    }
    // The manifest drives level errors and the ENU origin for the LOD and height suites.
    fs.copyFileSync(path.join(ctx.terrainRoot, 'manifest.json'), path.join(outDir, 'manifest.json'));
    count++;
    for (const name of INDEX_FILES) {
        const src = path.join(ctx.terrainRoot, name);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(outDir, 'index', name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        count++;
    }
    return count;
}

function listFixtures(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en'));
}

function parseName(name: string): TileKey {
    const m = /^(\d+)_(\d+)_(\d+)\./.exec(name);
    if (!m) throw new Error(`bad fixture name ${name}`);
    return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
}

/** Inflate a tile the way the browser's HTTP stack would have. PDM is zlib and decodePdm handles that itself. */
function inflate(raw: Uint8Array): Uint8Array {
    if (raw.length >= 2 && raw[0] === 0x1F && raw[1] === 0x8B) {
        return new Uint8Array(gunzipSync(raw));
    }
    return raw;
}

const DECODERS: Record<string, (b: Uint8Array) => unknown> = {
    ptm: decodePtm, ptx: decodePtx, ptr: decodePtr, pbr: decodePbr, pbh: decodePbh, pbd: decodePbd, pfl: decodePfl,
};

function demSamples(tile: ReturnType<typeof decodePdm>, rng: Rng): unknown[] {
    const n = tile.size;
    const out = [] as unknown[];
    const push = (u: number, v: number): void => {
        out.push({ u, v, bilinear: sampleBilinear(tile, u, v), nearest: sampleNearest(tile, u, v) });
    };
    // Corners and edges, exact half-texel positions (JS Math.round rounds .5 up;
    // C# Math.Round does not), then scattered points, then out of range.
    for (const u of [0, 1]) for (const v of [0, 1]) push(u, v);
    for (let i = 0; i < 6; i++) {
        push((i + 0.5) / (n - 1), (2 * i + 0.5) / (n - 1));
        push((7 * i + 3.5) / (n - 1), (i + 0.5) / (n - 1));
    }
    for (let i = 0; i < 24; i++) push(rng.next(), rng.next());
    push(-0.001, 0.5);
    push(0.5, 1.001);
    return out;
}

function indexFixture(name: string, bytes: Uint8Array, rng: Rng): unknown {
    const index = TileIndex.decode(bytes);
    const levels = index.levels.map(z => {
        const tiles = index.tilesAt(z);
        const joined = new TextEncoder().encode(tiles.map(tileKeyString).join('\n'));
        // Probe the bounding box of present tiles plus a margin: both hits and misses.
        const probes = [] as unknown[];
        if (tiles.length > 0) {
            const xs = tiles.map(t => t.x), ys = tiles.map(t => t.y);
            const x0 = Math.min(...xs) - 3, x1 = Math.max(...xs) + 3;
            const y0 = Math.min(...ys) - 3, y1 = Math.max(...ys) + 3;
            for (let i = 0; i < 120; i++) {
                const k = { z, x: rng.int(x0, x1), y: rng.int(y0, y1) };
                probes.push({ key: k, has: index.has(k) });
            }
            for (const t of tiles.slice(0, 5)) probes.push({ key: t, has: index.has(t) });
        }
        return { z, count: tiles.length, keysFnv1a32: hex32(fnv1a32(joined)), first: tiles.slice(0, 3), last: tiles.slice(-3), probes };
    });
    return { file: name, sha256: sha256Hex(bytes), bytes: bytes.length, minZoom: index.minZoom, maxZoom: index.maxZoom, levels };
}

export function codecsSuite(ctx: SuiteContext): SuiteOutput {
    const tilesRoot = path.join(ctx.goldenRoot, 'tiles');
    const rng = new Rng(0xC0DEC5);
    const tiles = [] as unknown[];

    for (const ext of Object.keys(DECODERS).concat('pdm').sort()) {
        for (const name of listFixtures(path.join(tilesRoot, ext))) {
            const raw = new Uint8Array(fs.readFileSync(path.join(tilesRoot, ext, name)));
            const key = parseName(name);
            const entry: Record<string, unknown> = {
                ext,
                file: `tiles/${ext}/${name}`,
                key,
                sha256: sha256Hex(raw),
                bytes: raw.length,
                gzip: raw.length >= 2 && raw[0] === 0x1F && raw[1] === 0x8B,
            };
            try {
                if (ext === 'pdm') {
                    const tile = decodePdm(raw);
                    entry.decoded = describe(tile);
                    entry.samples = demSamples(tile, rng);
                } else {
                    const inflated = inflate(raw);
                    entry.inflatedBytes = inflated.length;
                    entry.inflatedFnv1a32 = hex32(fnv1a32(inflated));
                    entry.decoded = describe(DECODERS[ext](inflated));
                }
            } catch (e) {
                entry.error = String(e instanceof Error ? e.message : e);
            }
            tiles.push(entry);
        }
    }

    const indices = listFixtures(path.join(tilesRoot, 'index')).map(name =>
        indexFixture(name, new Uint8Array(fs.readFileSync(path.join(tilesRoot, 'index', name))), rng));

    return {
        files: [{
            file: 'codecs.json',
            data: {
                suite: 'codecs',
                version: 1,
                source: 'src/script/terrain/{ptm,pdm,ptx,ptr,pbr,pbh,pbd,pfl,tileIndex,demTile}.ts',
                notes: [
                    'Tile files are copied verbatim under tests/golden/tiles/<ext>/<z>_<x>_<y>.<ext>.',
                    'All but .pdm are gzip on disk; `inflated*` describe the bytes after gunzip, which the decoders consume.',
                    '.pdm is zlib; decode straight from the file bytes.',
                    'Typed-array entries: {type, length, fnv1a32 over raw little-endian bytes, head = first elements}.',
                    'PDM heights are computed in double then stored as float32: C# must do minH + q*quantScale in double and cast.',
                    'sampleNearest uses JS Math.round (half rounds up); C# Math.Round rounds half to even. Samples include exact .5 positions.',
                    'Decoded object keys are the TypeScript field names; ArrayBuffer-backed fields appear as typed arrays.',
                ],
                tolerances: { heightsMetres: 1e-4 },
                tiles,
                indices,
            },
        }],
    };
}
