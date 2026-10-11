/**
 * Golden-fixture generator for the Unity port (milestone M0).
 *
 *   node --import tsx tools/golden/generate.ts                  write fixtures to tests/golden
 *   node --import tsx tools/golden/generate.ts --check          regenerate in memory, fail on drift
 *   node --import tsx tools/golden/generate.ts --select-tiles   also re-pick tile fixtures from assets/terrain
 *   node --import tsx tools/golden/generate.ts --only geodesy,tiling
 *   node --import tsx tools/golden/generate.ts --select-road-tiles  re-copy only the roads suite's tiles
 *   node --import tsx tools/golden/generate.ts --select-vegetation --only vegetation
 *
 * See tools/golden/README.md for the fixture format and what each suite covers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Asset, sha256Hex, stringify, SuiteFile, SuiteOutput } from './lib';
import { geodesySuite } from './suites/geodesy';
import { tilingSuite } from './suites/tiling';
import { dogfightSuite } from './suites/dogfight';
import { codecsSuite, selectTiles } from './suites/codecs';
import { flightModelsSuite } from './suites/flightModels';
import { aiSuite } from './suites/ai';
import { quadtreeSuite } from './suites/quadtree';
import { heightsSuite } from './suites/heights';
import { combatSimSuite } from './suites/combatSim';
import { airfieldsSuite } from './suites/airfields';
import { aircraftSuite } from './suites/aircraft';
import { buildingsSuite } from './suites/buildings';
import { copyRoadTiles, roadsSuite } from './suites/roads';
import { selectVegetationTiles, vegetationSuite } from './suites/vegetation';
import { skySuite } from './suites/sky';
import { cloudsSuite } from './suites/clouds';

export const GOLDEN_ROOT = path.resolve(__dirname, '../../tests/golden');
/** The baked tree tiles are selected from; GOLDEN_TERRAIN_ROOT points a worktree (which has none) at a checkout's. */
const TERRAIN_ROOT = process.env.GOLDEN_TERRAIN_ROOT ?? path.resolve(__dirname, '../../assets/terrain');

interface SuiteDef {
    name: string;
    run: (ctx: SuiteContext) => SuiteOutput;
}

export interface SuiteContext {
    goldenRoot: string;
    terrainRoot: string;
}

const SUITES: SuiteDef[] = [
    { name: 'geodesy', run: () => geodesySuite() },
    { name: 'tiling', run: () => tilingSuite() },
    { name: 'dogfight', run: () => dogfightSuite() },
    { name: 'codecs', run: ctx => codecsSuite(ctx) },
    { name: 'flightModels', run: () => flightModelsSuite() },
    { name: 'ai', run: () => aiSuite() },
    { name: 'quadtree', run: ctx => quadtreeSuite(ctx) },
    { name: 'heights', run: ctx => heightsSuite(ctx) },
    { name: 'combatSim', run: () => combatSimSuite() },
    { name: 'airfields', run: ctx => airfieldsSuite(ctx) },
    { name: 'aircraft', run: ctx => aircraftSuite(ctx) },
    { name: 'buildings', run: ctx => buildingsSuite(ctx) },
    { name: 'roads', run: ctx => roadsSuite(ctx) },
    { name: 'vegetation', run: ctx => vegetationSuite(ctx) },
    { name: 'sky', run: () => skySuite() },
    { name: 'clouds', run: () => cloudsSuite() },
];

export interface GenerateResult {
    files: SuiteFile[];
    assets: Asset[];
}

/** Run suites in memory; nothing touches the disk. */
export function generateAll(only?: ReadonlySet<string>, root: string = GOLDEN_ROOT): GenerateResult {
    const ctx: SuiteContext = { goldenRoot: root, terrainRoot: TERRAIN_ROOT };
    const files: SuiteFile[] = [];
    const assets: Asset[] = [];
    for (const suite of SUITES) {
        if (only && !only.has(suite.name)) continue;
        const out = suite.run(ctx);
        files.push(...out.files);
        assets.push(...(out.assets ?? []));
    }
    return { files, assets };
}

function writeFileEnsuring(p: string, data: string | Uint8Array): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
}

function main(): void {
    const args = process.argv.slice(2);
    const check = args.includes('--check');
    const selectNew = args.includes('--select-tiles');
    const onlyArg = args.find(a => a.startsWith('--only='))?.slice('--only='.length)
        ?? (args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined);
    const only = onlyArg ? new Set(onlyArg.split(',')) : undefined;

    if (selectNew) {
        if (check) throw new Error('--select-tiles cannot be combined with --check');
        const n = selectTiles({ goldenRoot: GOLDEN_ROOT, terrainRoot: TERRAIN_ROOT });
        console.log(`selected ${n} tile fixtures from ${TERRAIN_ROOT}`);
    } else if (args.includes('--select-road-tiles')) {
        if (check) throw new Error('--select-road-tiles cannot be combined with --check');
        const n = copyRoadTiles({ goldenRoot: GOLDEN_ROOT, terrainRoot: TERRAIN_ROOT });
        console.log(`copied ${n} road tile fixtures from ${TERRAIN_ROOT}`);
    }
    if (selectNew || args.includes('--select-vegetation')) {
        if (check) throw new Error('--select-vegetation cannot be combined with --check');
        const n = selectVegetationTiles({ goldenRoot: GOLDEN_ROOT, terrainRoot: TERRAIN_ROOT });
        console.log(`selected ${n} vegetation fixtures from ${TERRAIN_ROOT}`);
    }

    const { files, assets } = generateAll(only);

    if (check) {
        const drift: string[] = [];
        for (const f of files) {
            const p = path.join(GOLDEN_ROOT, f.file);
            const want = stringify(f.data);
            if (!fs.existsSync(p)) {
                drift.push(`missing   ${f.file}`);
            } else if (fs.readFileSync(p, 'utf8') !== want) {
                drift.push(`differs   ${f.file}`);
            }
        }
        for (const a of assets) {
            const p = path.join(GOLDEN_ROOT, a.file);
            if (!fs.existsSync(p)) {
                drift.push(`missing   ${a.file}`);
            } else if (sha256Hex(fs.readFileSync(p)) !== sha256Hex(a.bytes)) {
                drift.push(`differs   ${a.file}`);
            }
        }
        if (drift.length > 0) {
            console.error(`golden fixtures drifted from the oracle:\n  ${drift.join('\n  ')}`);
            console.error('Regenerate with: npm run golden:generate (and review the diff).');
            process.exit(1);
        }
        console.log(`golden fixtures up to date (${files.length} files, ${assets.length} assets)`);
        return;
    }

    for (const f of files) {
        writeFileEnsuring(path.join(GOLDEN_ROOT, f.file), stringify(f.data));
    }
    for (const a of assets) {
        writeFileEnsuring(path.join(GOLDEN_ROOT, a.file), a.bytes);
    }
    const manifest = {
        generator: 'tools/golden/generate.ts',
        files: files.map(f => f.file).sort(),
        assets: assets.map(a => ({ file: a.file, sha256: sha256Hex(a.bytes), bytes: a.bytes.length })).sort((x, y) => x.file.localeCompare(y.file)),
    };
    if (!only) {
        writeFileEnsuring(path.join(GOLDEN_ROOT, 'manifest.json'), stringify(manifest));
    }
    console.log(`wrote ${files.length} fixture files and ${assets.length} assets to ${GOLDEN_ROOT}`);
}

if (require.main === module) {
    main();
}
