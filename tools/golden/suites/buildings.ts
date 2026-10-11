/**
 * Building fixtures (workstream E): THREE.ShapeUtils triangulation (earcut),
 * roof and wall extrusion (buildingRoofs.ts), whole-tile extrusion of the
 * real PBH1 sidecars in tests/golden/tiles/pbh as BuildingMeshes binds them,
 * the per-frame draw-range budget (BuildingMeshes.endFrame), the tree
 * exclusion mask (buildingExclusion.ts) and the tone table.
 *
 * The tile meshes are run through the real BuildingMeshes class (its queue,
 * buildPending and bind, reached past `private`), so nothing here re-states
 * the oracle. Its clock (performance.now) is scripted for the budget frames.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { BuildingMeshes, BuildingMeshSet } from '../../../src/script/terrain/buildingMeshes';
import { buildingTriangles, BuildingShape, roofPlanes } from '../../../src/script/terrain/buildingRoofs';
import { buildBuildingExclusion } from '../../../src/script/terrain/buildingExclusion';
import { BUILDING_TONES, BuildingTone, nearestTone, noonRgb, ROOF_TONES, WALL_TONES } from '../../../src/script/terrain/buildingTones';
import { decodePbh, PbhTile, pbhRings, RoofForm } from '../../../src/script/terrain/pbh';
import type { TerrainManifest } from '../../../src/script/terrain/manifest';
import { HDNoonPalette } from '../../../src/script/config/palettes/hd-noon';
import { HDMidnightPalette } from '../../../src/script/config/palettes/hd-midnight';
import { HDNightVisionPalette } from '../../../src/script/config/palettes/hd-nightvision';
import type { Palette } from '../../../src/script/config/palettes/palette';
import { arr, describe, Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

type P2 = [number, number];

// ---------------------------------------------------------------- shapeUtils

function triangulate(contour: P2[], holes: P2[][]): { faces?: number[][]; throws?: string } {
    const c = contour.map(p => new THREE.Vector2(p[0], p[1]));
    const h = holes.map(r => r.map(p => new THREE.Vector2(p[0], p[1])));
    try {
        return { faces: THREE.ShapeUtils.triangulateShape(c, h) };
    } catch (e) {
        return { throws: (e as Error).constructor.name };
    }
}

function circle(n: number, cx: number, cy: number, r: number, rng?: Rng, jitter = 0, cw = false): P2[] {
    const out: P2[] = [];
    for (let i = 0; i < n; i++) {
        const a = (cw ? -1 : 1) * 2 * Math.PI * i / n;
        const rr = r * (1 + (rng ? rng.range(-jitter, jitter) : 0));
        out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
    }
    return out;
}

function shapeCases(): unknown[] {
    const rng = new Rng(0xB11D);
    const cases: Array<{ name: string; contour: P2[]; holes: P2[][] }> = [];
    const add = (name: string, contour: P2[], holes: P2[][] = []) => cases.push({ name, contour, holes });
    const sq: P2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    add('square ccw', sq);
    add('square cw', [...sq].reverse());
    add('L concave', [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]]);
    add('U concave', [[0, 0], [30, 0], [30, 20], [22, 20], [22, 6], [8, 6], [8, 20], [0, 20]]);
    add('comb', [[0, 0], [40, 0], [40, 10], [35, 10], [35, 3], [30, 3], [30, 10], [25, 10], [25, 3], [20, 3],
        [20, 10], [15, 10], [15, 3], [10, 3], [10, 10], [5, 10], [5, 3], [0, 3]]);
    add('square with hole', [[0, 0], [20, 0], [20, 20], [0, 20]], [[[5, 5], [15, 5], [15, 15], [5, 15]]]);
    add('two holes same leftmost x', [[0, 0], [30, 0], [30, 20], [0, 20]],
        [[[5, 3], [10, 3], [10, 8], [5, 8]], [[5, 12], [12, 12], [12, 17], [5, 17]]]);
    add('two holes meeting at a vertex', [[0, 0], [30, 0], [30, 30], [0, 30]],
        [[[10, 10], [20, 5], [20, 10]], [[10, 10], [20, 15], [20, 20]]]);
    add('hole touching outer edge', [[0, 0], [20, 0], [20, 20], [0, 20]], [[[0, 5], [6, 8], [0, 11]]]);
    add('closed contour (dup end)', [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
    add('closed hole (dup end)', [[0, 0], [20, 0], [20, 20], [0, 20]], [[[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]]]);
    add('bowtie self-intersecting', [[0, 0], [10, 10], [10, 0], [0, 10]]);
    add('figure eight', [[0, 0], [10, 0], [0, 10], [10, 10], [5, 5], [-5, 5]]);
    add('collinear points', [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]);
    add('all collinear', [[0, 0], [5, 0], [10, 0], [15, 0]]);
    add('repeated points', [[0, 0], [0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 10]]);
    add('two points', [[0, 0], [1, 1]]);
    add('empty contour', []);
    add('single-point hole', [[0, 0], [20, 0], [20, 20], [0, 20]], [[[7, 7]]]);
    add('empty hole', [[0, 0], [20, 0], [20, 20], [0, 20]], [[]]);
    add('hole outside contour', [[0, 0], [10, 0], [10, 10], [0, 10]], [[[20, 20], [25, 20], [25, 25]]]);
    add('star 60 (z-order hash)', (() => {
        const out: P2[] = [];
        for (let i = 0; i < 60; i++) {
            const a = 2 * Math.PI * i / 60;
            const r = i % 2 === 0 ? 50 : 22;
            out.push([r * Math.cos(a), r * Math.sin(a)]);
        }
        return out;
    })());
    add('circle 48 with 3 holes (hash)', circle(48, 0, 0, 100),
        [circle(8, -40, 0, 10, undefined, 0, true), circle(8, 30, 30, 12), circle(5, 30, -30, 9)]);
    add('quantised building-like', [[0.25, 0], [12.5, 0.25], [12.5, 7.75], [6.25, 7.75], [6.25, 15], [0, 15]]);
    for (let k = 0; k < 10; k++) {
        const n = rng.int(5, 70);
        const contour = circle(n, rng.range(-50, 50), rng.range(-50, 50), rng.range(5, 80), rng, 0.45, rng.next() < 0.5);
        const holes: P2[][] = [];
        if (k % 3 === 0) {
            holes.push(circle(rng.int(3, 9), contour[0][0] * 0 + 0, 0, 2, rng, 0.2));
        }
        add(`random ${k}`, contour, holes.map(h => h.map(p => [p[0] + contour.reduce((s, q) => s + q[0], 0) / n, p[1] + contour.reduce((s, q) => s + q[1], 0) / n] as P2)));
    }
    return cases.map(c => {
        const r = triangulate(c.contour.map(p => [...p] as P2), c.holes.map(h => h.map(p => [...p] as P2)));
        const v = c.contour.map(p => new THREE.Vector2(p[0], p[1]));
        return {
            name: c.name, contour: c.contour, holes: c.holes,
            area: c.contour.length > 0 ? THREE.ShapeUtils.area(v) : 0,
            isClockWise: c.contour.length > 0 ? THREE.ShapeUtils.isClockWise(v) : false,
            ...r,
        };
    });
}

// ---------------------------------------------------------------- roofs

function trianglesOf(shape: BuildingShape): { count: number; tris: number[][] } {
    const tris: number[][] = [];
    const count = buildingTriangles(shape, (p, n, roof) => {
        tris.push([...p, ...n, roof ? 1 : 0]);
    });
    return { count, tris };
}

function roofCases(): unknown[] {
    const rng = new Rng(0x400F);
    const out: unknown[] = [];
    const rect: P2[] = [[0, 0], [14, 0], [14, 9], [0, 9]];
    const ell: P2[] = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 18], [0, 18]];
    const tee: P2[] = [[0, 0], [24, 0], [24, 7], [15, 7], [15, 19], [9, 19], [9, 7], [0, 7]];
    const forms = [RoofForm.Flat, RoofForm.Gabled, RoofForm.Hipped, RoofForm.HalfHipped, RoofForm.Skillion, RoofForm.Pyramidal];
    const add = (name: string, shape: BuildingShape) => {
        out.push({
            name,
            shape: { ...shape, form: shape.form as number },
            ...trianglesOf(shape),
        });
    };
    for (const form of forms) {
        add(`rect form ${form}`, { rings: [rect], baseM: 2, eaveM: 7, ridgeM: 11, form, ridgeAngle: 0 });
        add(`rect form ${form} angled`, { rings: [rect], baseM: -1.5, eaveM: 4, ridgeM: 9.5, form, ridgeAngle: 1.1 });
        add(`L form ${form}`, { rings: [ell], baseM: 0, eaveM: 6, ridgeM: 10, form, ridgeAngle: 0.3 });
        add(`T form ${form} cw`, { rings: [[...tee].reverse()], baseM: 3, eaveM: 9, ridgeM: 14, form, ridgeAngle: 4.0 });
    }
    add('unknown form 0', { rings: [rect], baseM: 0, eaveM: 5, ridgeM: 8, form: 0 as RoofForm, ridgeAngle: 0.5 });
    add('unknown form 9', { rings: [ell], baseM: 0, eaveM: 5, ridgeM: 8, form: 9 as RoofForm, ridgeAngle: 2.5 });
    add('wide hipped', { rings: [[[0, 0], [6, 0], [6, 20], [0, 20]]], baseM: 0, eaveM: 5, ridgeM: 9, form: RoofForm.Hipped, ridgeAngle: 0 });
    add('flat low rise', { rings: [rect], baseM: 0, eaveM: 5, ridgeM: 5.03, form: RoofForm.Gabled, ridgeAngle: 0 });
    add('tiny footprint', { rings: [[[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]], baseM: 0, eaveM: 2, ridgeM: 3, form: RoofForm.Gabled, ridgeAngle: 0.7 });
    add('no walls', { rings: [rect], baseM: 0, eaveM: 3, ridgeM: 4, form: RoofForm.Gabled, ridgeAngle: 0, noWalls: true });
    add('courtyard', {
        rings: [[[0, 0], [30, 0], [30, 30], [0, 30]], [[10, 10], [20, 10], [20, 20], [10, 20]]],
        baseM: 1, eaveM: 12, ridgeM: 15, form: RoofForm.Hipped, ridgeAngle: 0.2,
    });
    add('courtyard closed rings (index shift)', {
        rings: [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]], [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]],
        baseM: 1, eaveM: 12, ridgeM: 15, form: RoofForm.Flat, ridgeAngle: 0,
    });
    add('courtyard degenerate second hole', {
        rings: [[[0, 0], [30, 0], [30, 30], [0, 30]], [[2, 2], [3, 3]], [[10, 10], [20, 10], [15, 20]]],
        baseM: 0, eaveM: 8, ridgeM: 8, form: RoofForm.Gabled, ridgeAngle: 0,
    });
    add('skillion concave', { rings: [ell], baseM: 0, eaveM: 4, ridgeM: 6, form: RoofForm.Skillion, ridgeAngle: 5.9 });
    add('two-point ring', { rings: [[[0, 0], [1, 0]]], baseM: 0, eaveM: 4, ridgeM: 6, form: RoofForm.Gabled, ridgeAngle: 0 });
    add('no rings', { rings: [], baseM: 0, eaveM: 4, ridgeM: 6, form: RoofForm.Gabled, ridgeAngle: 0 });
    for (let k = 0; k < 16; k++) {
        const n = rng.int(4, 14);
        const ring = circle(n, rng.range(-30, 30), rng.range(-30, 30), rng.range(3, 25), rng, 0.4, rng.next() < 0.3)
            .map(p => [Math.round(p[0] * 4) / 4, Math.round(p[1] * 4) / 4] as P2);
        const base = Math.round(rng.range(-5, 400) * 10) / 10;
        const eave = base + Math.round(rng.range(2, 20) * 10) / 10;
        const ridge = eave + Math.round(rng.range(0, 8) * 10) / 10;
        add(`random ${k}`, {
            rings: [ring], baseM: base, eaveM: eave, ridgeM: ridge,
            form: forms[k % forms.length], ridgeAngle: rng.int(0, 65535) / 65536 * 2 * Math.PI,
        });
    }
    return out;
}

function planeCases(): unknown[] {
    const out: unknown[] = [];
    for (const form of [0, 1, 2, 3, 4, 5, 6, 7]) {
        for (const [hl, hw, e, r] of [[7, 4.5, 5, 9], [0.2, 0.3, 3, 5], [10, 3, 6, 6.02], [3, 10, 2, 8]]) {
            out.push({ form, halfLength: hl, halfWidth: hw, eave: e, ridge: r, planes: roofPlanes(form as RoofForm, hl, hw, e, r) });
        }
    }
    return out;
}

// ---------------------------------------------------------------- tiles

function maybeGunzip(raw: Uint8Array): Uint8Array {
    return raw.length >= 2 && raw[0] === 0x1F && raw[1] === 0x8B ? new Uint8Array(gunzipSync(raw)) : raw;
}

interface Bound {
    file: string;
    tile: PbhTile;
    set: BuildingMeshSet;
}

function newBuildingMeshes(): BuildingMeshes {
    return new BuildingMeshes({
        manifest: {} as unknown as TerrainManifest,
        baseUrl: '',
        material: new THREE.MeshBasicMaterial(),
    });
}

type Internals = {
    queue(id: unknown, meshes: unknown, tile: PbhTile): void;
    buildPending(ms: number): void;
};

function bindTile(bm: BuildingMeshes, tile: PbhTile): BuildingMeshSet | undefined {
    const meshes: Record<string, unknown> = { group: new THREE.Group(), bytes: 0, disposed: false, buildings: 'pending' };
    const internals = bm as unknown as Internals;
    internals.queue(tile.id, meshes, tile);
    internals.buildPending(1e9);
    const set = meshes.buildings;
    return typeof set === 'object' ? set as BuildingMeshSet : undefined;
}

function headTris(set: BuildingMeshSet, count: number): unknown[] {
    const g = set.mesh.geometry;
    const pos = g.getAttribute('position').array as Float32Array;
    const nrm = g.getAttribute('normal').array as Int8Array;
    const tone = g.getAttribute('tone').array as Uint8Array;
    const raw = g.getAttribute('rawColor').array as Uint8Array;
    const out: unknown[] = [];
    const tris = pos.length / 9;
    // The first triangles, then a spread through the rest.
    const picks = new Set<number>();
    for (let t = 0; t < Math.min(count, tris); t++) picks.add(t);
    for (let k = 0; k < count && tris > 0; k++) picks.add(Math.floor((k + 0.5) * tris / count));
    for (const t of [...picks].sort((a, b) => a - b)) {
        out.push({
            t,
            pos: arr(pos.subarray(t * 9, t * 9 + 9)),
            nrm: arr(nrm.subarray(t * 9, t * 9 + 9)),
            tone: arr(tone.subarray(t * 3, t * 3 + 3)),
            raw: arr(raw.subarray(t * 12, t * 12 + 12)),
        });
    }
    return out;
}

function exclusionSamples(tile: PbhTile, rng: Rng): unknown[] {
    const test = buildBuildingExclusion(tile);
    const out: unknown[] = [];
    if (!test) return out;
    const { a, b, up } = tile.frame;
    const toXyz = (u: number, v: number, h: number): [number, number, number] => [
        u * a[0] + v * b[0] + h * up[0], u * a[1] + v * b[1] + h * up[1], u * a[2] + v * b[2] + h * up[2],
    ];
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < tile.verts.length; i += 2) {
        minU = Math.min(minU, tile.verts[i]); maxU = Math.max(maxU, tile.verts[i]);
        minV = Math.min(minV, tile.verts[i + 1]); maxV = Math.max(maxV, tile.verts[i + 1]);
    }
    for (let k = 0; k < 400; k++) {
        let xyz: [number, number, number];
        if (k < 300) {
            const bld = tile.buildings[rng.int(0, tile.buildings.length - 1)];
            const ring = pbhRings(tile, bld)[0] ?? [[0, 0]];
            const p = ring[rng.int(0, ring.length - 1)];
            const q = ring[rng.int(0, ring.length - 1)];
            const t = rng.next();
            xyz = toXyz(p[0] + (q[0] - p[0]) * t + rng.range(-4, 4), p[1] + (q[1] - p[1]) * t + rng.range(-4, 4), bld.baseM + rng.range(-3, 10));
        } else {
            xyz = toXyz(rng.range(minU, maxU), rng.range(minV, maxV), rng.range(-50, 500));
        }
        out.push([...xyz, test(...xyz) ? 1 : 0]);
    }
    return out;
}

// ---------------------------------------------------------------- budget

function budgetFrames(bound: Bound[]): unknown[] {
    const perf = globalThis.performance;
    const realNow = Object.getOwnPropertyDescriptor(perf, 'now');
    let clock = 0;
    Object.defineProperty(perf, 'now', { value: () => clock, configurable: true, writable: true });
    const runs: unknown[] = [];
    try {
        const scripts: Array<{ name: string; budget: number }> = [
            { name: 'default budget', budget: 300_000 },
            { name: 'tight budget', budget: 25_000 },
            { name: 'starved budget', budget: 600 },
        ];
        for (const script of scripts) {
            const bm = newBuildingMeshes();
            bm.budget = script.budget;
            // Fresh draw state per run: rebind the same tiles.
            const sets = bound.map(b => bindTile(bm, b.tile)!);
            const frames: unknown[] = [];
            const rng = new Rng(0xF4A3);
            clock = 1000;
            const pixelAngle = 2 * Math.tan(30 * Math.PI / 180) / 1080;
            for (let f = 0; f < 90; f++) {
                // Mostly 60 Hz, with a hitch and a long stall.
                clock += f === 30 ? 400 : f === 31 ? 90 : 1000 / 60;
                const near: number[] = sets.map((_, i) => {
                    const base = [200, 900, 3500][i % 3];
                    // Approach then retreat, so tiles both grow and shrink.
                    const phase = f < 45 ? 1 - f / 60 : 0.25 + (f - 45) / 30;
                    return Math.max(0, base * phase + rng.range(-20, 20));
                });
                const want = sets.map((_, i) => !(f >= 60 && f < 66 && i === 1));
                bm.beginFrame();
                sets.forEach((set, i) => {
                    if (want[i]) bm.want({ buildings: set } as never, near[i]);
                });
                bm.endFrame(pixelAngle);
                const s = bm.stats;
                frames.push({
                    nowMs: clock, near, want: want.map(w => (w ? 1 : 0)),
                    minPixels: s.minPixels, shownTriangles: s.shownTriangles,
                    count: sets.map(x => x.count), shown: sets.map(x => x.shown), visible: sets.map(x => (x.mesh.visible ? 1 : 0)),
                });
            }
            runs.push({ name: script.name, budget: script.budget, pixelAngle, tiles: bound.map(b => b.file), frames });
        }
    } finally {
        if (realNow) {
            Object.defineProperty(perf, 'now', realNow);
        } else {
            delete (perf as unknown as Record<string, unknown>).now;
        }
    }
    return runs;
}

// ---------------------------------------------------------------- suite

function paletteHex(p: Palette): string[] {
    return BUILDING_TONES.map(c => {
        const v = p.colors[c];
        return (Array.isArray(v) ? v[0] : v) as string;
    });
}

export function buildingsSuite(ctx: SuiteContext): SuiteOutput {
    const dir = path.join(ctx.goldenRoot, 'tiles', 'pbh');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.pbh')).sort();
    const bm = newBuildingMeshes();
    const rng = new Rng(0xE7C1);
    const bound: Bound[] = [];
    const tiles = files.map(file => {
        const tile = decodePbh(maybeGunzip(new Uint8Array(fs.readFileSync(path.join(dir, file)))));
        const set = bindTile(bm, tile);
        if (!set) {
            return { file: `tiles/pbh/${file}`, buildings: tile.buildings.length, bound: false };
        }
        bound.push({ file: `tiles/pbh/${file}`, tile, set });
        const g = set.mesh.geometry;
        return {
            file: `tiles/pbh/${file}`,
            buildings: tile.buildings.length,
            bound: true,
            triangles: (g.getAttribute('position').array as Float32Array).length / 9,
            bytes: set.bytes,
            position: describe(g.getAttribute('position').array),
            normal: describe(g.getAttribute('normal').array),
            tone: describe(g.getAttribute('tone').array),
            rawColor: describe(g.getAttribute('rawColor').array),
            prefix: describe(set.prefix),
            prominence: describe(set.prominence),
            prefixHead: arr(set.prefix.subarray(0, 50)),
            prominenceHead: arr(set.prominence.subarray(0, 50)),
            sampleTriangles: headTris(set, 40),
            exclusion: exclusionSamples(tile, rng),
        };
    });

    const toneRng = new Rng(0x70E5);
    const tones = {
        categories: BUILDING_TONES.map(c => String(c)),
        noon: paletteHex(HDNoonPalette),
        midnight: paletteHex(HDMidnightPalette),
        nightVision: paletteHex(HDNightVisionPalette),
        noonRgb: BUILDING_TONES.map((_, i) => noonRgb(i as BuildingTone)),
        roofTones: [...ROOF_TONES],
        wallTones: [...WALL_TONES],
        nearest: Array.from({ length: 200 }, () => {
            const rgb = toneRng.int(0, 0xffffff);
            return [rgb, nearestTone(rgb, ROOF_TONES), nearestTone(rgb, WALL_TONES)];
        }),
    };

    return {
        files: [{
            file: 'buildings.json',
            data: {
                suite: 'buildings',
                version: 1,
                source: 'three/src/extras/{ShapeUtils,Earcut,lib/earcut}.js, src/script/terrain/{buildingRoofs,buildingMeshes,buildingExclusion,buildingTones}.ts',
                notes: [
                    'shapeUtils: THREE.ShapeUtils.triangulateShape(contour, holes) faces; `throws` names the error class when three throws.',
                    'roofs: buildingTriangles(shape) emitted triangles as [p0 u,v,h, p1, p2, n u,v,h, roof 0/1].',
                    'tiles: the tile file decoded with decodePbh, queued and built by the real BuildingMeshes (whole tile), arrays described as {type,length,fnv1a32,head}.',
                    'exclusion: [x, y, z, inside 0/1] in the tile axes, buildBuildingExclusion(tile) with the default 2 m margin.',
                    'budget: each run binds the bound tiles afresh, then per frame: performance.now() = nowMs, beginFrame, want(tile i, near[i]) where want[i], endFrame(pixelAngle).',
                ],
                tolerances: { roofMetres: 1e-9, float32: 0, ints: 0 },
                shapeUtils: shapeCases(),
                roofPlanes: planeCases(),
                roofs: roofCases(),
                tiles,
                budget: budgetFrames(bound),
                tones,
            },
        }],
    };
}
