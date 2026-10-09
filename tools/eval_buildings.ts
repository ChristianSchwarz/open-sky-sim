/**
 * Score the building bake's sources against official LoD2 models (phase 4 of
 * docs/terrain-buildings.md): for every OSM building that tools/import_lod2.py
 * matched one to one, the real planBuilding (tools/bake/buildingPlan.ts) is
 * run with the rules only, with the surface fits' heights and ridges, and
 * with the surface fits' forms too, and each answer is compared with LoD2's
 * roof form, ridge and eave height and ridge direction.
 *
 * It runs the plan on a level ground at 0 in a local equirectangular frame
 * (north = +v), so heights compare above the ground and directions as
 * compass bearings, without the meshes.
 *
 * Usage:
 *   node --import tsx tools/eval_buildings.ts --bbox 11.03,47.46,11.17,47.60 [--src assets/planet]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { RoofForm } from '../src/script/terrain/pbh';
import { tileBounds } from '../src/script/terrain/tiling';
import { PlanInput, Ring, planBuilding } from './bake/buildingPlan';
import { DEFAULT_LOD2_STORE, LOD2_MATCH_ONE, readLod2 } from './bake/buildingLod2Store';
import { DEFAULT_SHAPE_STORE, readMeasuredShapes } from './bake/buildingShapeStore';
import { decodeBvr } from './bake/bvr';
import { TileKey } from './bake/index';

const FORMS: Array<[RoofForm, string]> = [
    [RoofForm.Flat, 'flat'], [RoofForm.Gabled, 'gabled'], [RoofForm.Hipped, 'hipped'],
    [RoofForm.HalfHipped, 'half-hipped'], [RoofForm.Skillion, 'skillion'], [RoofForm.Pyramidal, 'pyramidal'],
];
const LEAF = 12;
const M_PER_DEG_LAT = 111132.92;

interface Config {
    name: string;
    shapes: boolean;
    surfaceForms: boolean;
}

const CONFIGS: Config[] = [
    { name: 'rules only', shapes: false, surfaceForms: false },
    { name: 'rules + surface heights and ridges (the bake without LoD2)', shapes: true, surfaceForms: false },
    { name: 'rules + surface heights, ridges and forms', shapes: true, surfaceForms: true },
];

function parseArgs(argv: string[]) {
    const a = { src: 'assets/planet', bbox: undefined as number[] | undefined, lod2: DEFAULT_LOD2_STORE, shapes: DEFAULT_SHAPE_STORE };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--src') a.src = argv[++i];
        else if (k === '--bbox') a.bbox = argv[++i].split(',').map(Number);
        else if (k === '--lod2-store') a.lod2 = argv[++i];
        else if (k === '--shape-store') a.shapes = argv[++i];
        else throw new Error(`unknown argument ${k}`);
    }
    if (!a.bbox || a.bbox.length !== 4 || a.bbox.some(v => !Number.isFinite(v))) {
        throw new Error('give --bbox west,south,east,north');
    }
    return a;
}

function angleError(a: number, b: number, period: number): number {
    const d = ((a - b) % period + period) % period;
    return Math.min(d, period - d);
}

function main(): void {
    const args = parseArgs(process.argv.slice(2));
    const [w, s, e, n] = args.bbox!;
    const span = 180 / (1 << LEAF);
    const leaves: TileKey[] = [];
    for (let y = Math.floor((90 - n) / span); y <= Math.floor((90 - s) / span); y++) {
        for (let x = Math.floor((w + 180) / span); x <= Math.floor((e + 180) / span); x++) {
            if (fs.existsSync(path.join(args.src, String(LEAF), String(x), `${y}.bvr`))) {
                leaves.push({ z: LEAF, x, y });
            }
        }
    }
    type Tally = { confusion: Map<string, number>; ridge: number[]; eave: number[]; dir: number[]; n: number };
    const tallies = CONFIGS.map((): Tally => ({ confusion: new Map(), ridge: [], eave: [], dir: [], n: 0 }));
    let compared = 0;
    for (const k of leaves) {
        const lod2 = readLod2(args.lod2, k);
        if (!lod2) {
            continue;
        }
        const shapes = readMeasuredShapes(args.shapes, k);
        const b = tileBounds(k);
        const lat0 = (b.south + b.north) / 2, lon0 = (b.west + b.east) / 2;
        const mLon = 111412.84 * Math.cos(lat0 * Math.PI / 180);
        for (const bld of decodeBvr(fs.readFileSync(path.join(args.src, String(LEAF), String(k.x), `${k.y}.bvr`)))) {
            const truth = lod2.get(bld.id);
            if (!truth || truth.match !== LOD2_MATCH_ONE || truth.form === undefined) {
                continue;
            }
            compared++;
            const rings: Ring[] = bld.rings.map(r => r.map(([lon, lat]) =>
                [(lon - lon0) * mLon, (lat - lat0) * M_PER_DEG_LAT] as [number, number]));
            CONFIGS.forEach((cfg, i) => {
                const input: PlanInput = {
                    building: bld, rings, lat: lat0, lon: lon0, north: [0, 1], ground: () => 0,
                    shape: cfg.shapes ? shapes?.get(bld.id) : undefined, surfaceForms: cfg.surfaceForms,
                };
                const p = planBuilding(input);
                if (!p) {
                    return;
                }
                const t = tallies[i];
                t.n++;
                const key = `${truth.form}>${p.form}`;
                t.confusion.set(key, (t.confusion.get(key) ?? 0) + 1);
                t.ridge.push(p.ridgeM - truth.ridgeM);
                if (truth.form !== RoofForm.Flat) {
                    t.eave.push(p.eaveM - truth.eaveM);
                }
                if (truth.form === RoofForm.Gabled && truth.azimuthDeg !== undefined) {
                    const az = (Math.atan2(Math.cos(p.ridgeAngle), Math.sin(p.ridgeAngle)) * 180 / Math.PI + 360) % 360;
                    t.dir.push(angleError(az, truth.azimuthDeg, 180));
                }
            });
        }
    }
    const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length);
    const median = (v: number[]) => { const a = v.slice().sort((x, y) => x - y); return a[a.length >> 1] ?? NaN; };
    console.log(`eval_buildings: ${compared} OSM buildings with one LoD2 building of their size, ${leaves.length} leaves`);
    CONFIGS.forEach((cfg, i) => {
        const t = tallies[i];
        console.log(`\n${cfg.name} (${t.n})`);
        console.log('  LoD2 \\ ours   ' + FORMS.map(([, nm]) => nm.slice(0, 9).padStart(10)).join('') + '   recall');
        let agree = 0;
        for (const [tf, tn] of FORMS) {
            const row = FORMS.map(([pf]) => t.confusion.get(`${tf}>${pf}`) ?? 0);
            const tot = row.reduce((x, y) => x + y, 0);
            if (!tot) {
                continue;
            }
            agree += t.confusion.get(`${tf}>${tf}`) ?? 0;
            console.log(`  ${tn.padEnd(13)}${row.map(v => String(v).padStart(10)).join('')}   ${((t.confusion.get(`${tf}>${tf}`) ?? 0) / tot * 100).toFixed(0).padStart(4)}%`);
        }
        console.log(`  form agreement ${(agree / Math.max(1, t.n) * 100).toFixed(1)} %`);
        console.log(`  ridge height: mean abs ${mean(t.ridge.map(Math.abs)).toFixed(2)} m, median ${median(t.ridge).toFixed(2)} m; `
            + `eave: mean abs ${mean(t.eave.map(Math.abs)).toFixed(2)} m, median ${median(t.eave).toFixed(2)} m`);
        console.log(`  gable ridge direction within 20 deg: ${(t.dir.filter(d => d < 20).length / Math.max(1, t.dir.length) * 100).toFixed(0)} % (${t.dir.length})`);
    });
}

main();
