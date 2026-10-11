/**
 * Tree billboard and ground clutter fixtures (workstream E, vegetation): the
 * CPU half of terrainEntity.ts's attachTrees - the exclusion masks, the
 * forest/shrub scatter (treeBillboards.ts), the open-ground clutter
 * (stones.ts), the 4x4 cell split with its shuffled thinning order, and the
 * per-instance attributes the billboard shader reads - on two real z12
 * leaves: the one under GCLP (airfield, roads, buildings, beds) and a
 * forested DACH leaf near Garmisch, drawn from a play origin far from the
 * bake's so the frame fix is not the identity.
 *
 * Instance arrays are described as `{type, length, fnv1a32, head}` over the
 * exact Float32Array bytes the InstancedMesh carries; the port has to
 * reproduce them bit for bit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { Airfield } from '../../../src/script/terrain/airfields';
import { buildAirfieldExclusion } from '../../../src/script/terrain/airfieldExclusion';
import { buildBuildingExclusion } from '../../../src/script/terrain/buildingExclusion';
import { decodePbd } from '../../../src/script/terrain/pbd';
import { decodePbh, PbhTile } from '../../../src/script/terrain/pbh';
import { decodePtm, PtmTile } from '../../../src/script/terrain/ptm';
import { decodePtr, PtrTile } from '../../../src/script/terrain/ptr';
import { buildRailBedExclusion } from '../../../src/script/terrain/railBed';
import { buildRoadExclusion } from '../../../src/script/terrain/roadExclusion';
import { buildSurfaceExclusion } from '../../../src/script/terrain/surfaceExclusion';
import { CLUTTER_ELIGIBLE_CLASSES, buildStoneMesh, scatterGroundClutter, ShapeGroup } from '../../../src/script/terrain/stones';
import { tileOriginWorld } from '../../../src/script/terrain/tileMesh';
import {
    SpeciesGroup, buildTreeMeshes, clampTreeDensityMultiplier, scatterTreeSpecies, treeDensityScaleForDistance, treeInstancesToDraw, treeSpacingM,
} from '../../../src/script/terrain/treeBillboards';
import { ecefToEnu, enuFrameRotation, geodeticToEcef, makeEnuBasis, EnuBasis } from '../../../src/script/terrain/geodesy';
import { tileBounds, TileKey } from '../../../src/script/terrain/tiling';
import { SurfacePadCollider } from '../../../src/script/scene/entities/surfacePad';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { describe, Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

/** The two leaves, and where their sidecars live under tests/golden/tiles. */
interface TileCase {
    name: string;
    key: TileKey;
    /** Play origin (the drawing basis); the bake origin is the manifest's. */
    origin: { lat: number; lon: number; height: number };
    /** Airfields the area's mask is built from (OSM ICAO or name). */
    airfields: (a: Airfield) => boolean;
}

export const VEGETATION_TILES: readonly TileCase[] = [
    {
        name: 'gclp',
        key: { z: 12, x: 3745, y: 1412 },
        origin: { lat: 28.0015, lon: -15.3937, height: 0 },
        airfields: a => a.icao === 'GCLP',
    },
    {
        name: 'garmisch_forest',
        key: { z: 12, x: 4347, y: 965 },
        origin: { lat: 47.5, lon: 11.1, height: 0 },
        airfields: a => a.area === 'DACH' && Math.abs(a.lat - 47.6) < 0.4 && Math.abs(a.lon - 11.1) < 0.5,
    },
];

/** Density scales attachTrees passes: full, distance-thinned, and the user's multiplier above 1 (the cap grows). */
const DENSITIES = [1, 0.37, 2.5];
const MAX_ZOOM = 12;
const EXTS = ['ptm', 'ptr', 'pbh', 'pbd'] as const;

function fixtureDir(root: string): string {
    return path.join(root, 'tiles', 'vegetation');
}

function fileName(k: TileKey, ext: string): string {
    return `${k.z}_${k.x}_${k.y}.${ext}`;
}

/** Copy the two leaves' sidecars and the area airfields from the baked tree (--select-tiles). */
export function selectVegetationTiles(ctx: SuiteContext): number {
    const out = fixtureDir(ctx.goldenRoot);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    let n = 0;
    for (const t of VEGETATION_TILES) {
        for (const ext of EXTS) {
            const src = path.join(ctx.terrainRoot, `${t.key.z}`, `${t.key.x}`, `${t.key.y}.${ext}`);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(out, fileName(t.key, ext)));
                n++;
            }
        }
    }
    const all = JSON.parse(fs.readFileSync(path.join(ctx.terrainRoot, 'airfields.json'), 'utf8')) as { items: Airfield[] };
    const items = all.items.filter(a => VEGETATION_TILES.some(t => t.airfields(a)))
        .map(a => ({ icao: a.icao, name: a.name, area: a.area, lat: a.lat, lon: a.lon, plane: a.plane, runways: a.runways, taxiways: a.taxiways, aprons: a.aprons }));
    fs.writeFileSync(path.join(out, 'airfields.json'), JSON.stringify({ items }));
    return n + 1;
}

function readGz(dir: string, k: TileKey, ext: string): Uint8Array | undefined {
    const p = path.join(dir, fileName(k, ext));
    return fs.existsSync(p) ? new Uint8Array(gunzipSync(fs.readFileSync(p))) : undefined;
}

/** Stands in for the material manager: buildTreeMesh only sets two uniforms on what it returns. */
const STUB_MATERIALS = { build: () => new THREE.ShaderMaterial() } as unknown as SceneMaterialManager;
const STUB_ATLAS = new THREE.Texture();

/** terrainEntity.ts loadBeds: the tile centre's vertical in the bake frame's axes. */
function bedUp(bakeBasis: EnuBasis, id: TileKey): [number, number, number] {
    const b = tileBounds(id);
    const lat = (b.south + b.north) / 2, lon = (b.west + b.east) / 2;
    const e0 = ecefToEnu(bakeBasis, geodeticToEcef(lat, lon, 0));
    const e1 = ecefToEnu(bakeBasis, geodeticToEcef(lat, lon, 1000));
    return [(e1.e - e0.e) / 1000, (e1.u - e0.u) / 1000, -(e1.n - e0.n) / 1000];
}

/** terrainEntity.ts sceneExclusionFor (private there), verbatim. */
function sceneExclusionFor(
    tile: PtmTile, basis: EnuBasis, frameFix: THREE.Quaternion,
    onAirfield: ((x: number, z: number) => boolean) | undefined, toAirfield: THREE.Matrix4,
    onSurface: ((x: number, z: number) => boolean) | undefined, toSurface: THREE.Matrix4,
): ((x: number, z: number, y: number) => boolean) | undefined {
    if (!onAirfield && !onSurface) {
        return undefined;
    }
    const origin = tileOriginWorld(tile.id, tile.centerHeightM, basis);
    const q = frameFix;
    const v = new THREE.Vector3();
    const w = new THREE.Vector3();
    return (x, z, y) => {
        v.set(x, y, z).applyQuaternion(q).add(origin);
        if (onAirfield) {
            w.copy(v).applyMatrix4(toAirfield);
            if (onAirfield(w.x, w.z)) return true;
        }
        if (onSurface) {
            w.copy(v).applyMatrix4(toSurface);
            if (onSurface(w.x, w.z)) return true;
        }
        return false;
    };
}

function groupFixture(g: SpeciesGroup | ShapeGroup): unknown {
    const pts = new Float64Array(g.points.length * 3);
    g.points.forEach((p, i) => { pts[i * 3] = p.x; pts[i * 3 + 1] = p.y; pts[i * 3 + 2] = p.z; });
    return {
        kind: 'species' in g ? g.species : g.shape,
        count: g.points.length,
        points: describe(pts),
        tints: describe(Float64Array.from(g.tints)),
        normals: describe(Float64Array.from(g.normals)),
    };
}

function meshFixture(mesh: THREE.InstancedMesh): unknown {
    const geo = mesh.geometry;
    const u = (mesh.material as THREE.ShaderMaterial).uniforms;
    const sphere = mesh.boundingSphere!;
    return {
        count: mesh.count,
        treeTotal: mesh.userData.treeTotal ?? null,
        treeSpacingM: mesh.userData.treeSpacingM ?? null,
        invCount: u.uTreeInvCount?.value ?? null,
        sphere: { center: sphere.center.toArray(), radius: sphere.radius },
        matrices: describe(mesh.instanceMatrix.array as Float32Array, 16),
        shade: describe(geo.getAttribute('instanceShade').array as Float32Array, 8),
        normal: describe(geo.getAttribute('instanceNormal').array as Float32Array, 6),
        species: describe(geo.getAttribute('instanceSpecies').array as Float32Array, 8),
    };
}

/** A few pads per tile in scene x/z, so the surface mask and the frame fix reach the scatter. */
function padsFor(origin: THREE.Vector3, rng: Rng): SurfacePadCollider[] {
    const pads: SurfacePadCollider[] = [];
    for (let i = 0; i < 6; i++) {
        pads.push({
            centerX: origin.x + rng.range(-2500, 2500),
            centerZ: origin.z + rng.range(-2000, 2000),
            heading: rng.range(-Math.PI, Math.PI),
            halfLength: rng.range(40, 400),
            halfWidth: rng.range(20, 150),
            surfaceY: 0,
            baseY: 0,
            feather: rng.range(0, 30),
            slope: i % 2 === 0 ? undefined : rng.range(-0.01, 0.01),
        });
    }
    return pads;
}

function bits(test: (i: number) => boolean, n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += test(i) ? '1' : '0';
    return s;
}

export function vegetationSuite(ctx: SuiteContext): SuiteOutput {
    const dir = fixtureDir(ctx.goldenRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.goldenRoot, 'tiles', 'manifest.json'), 'utf8')) as {
        enuOrigin: { lat: number; lon: number; height: number };
    };
    const bake = manifest.enuOrigin;
    const bakeBasis = makeEnuBasis(bake.lat, bake.lon, bake.height ?? 0);
    const airfieldFile = JSON.parse(fs.readFileSync(path.join(dir, 'airfields.json'), 'utf8')) as { items: Airfield[] };
    const rng = new Rng(0x7EE5);

    const tiles: unknown[] = [];
    for (const tc of VEGETATION_TILES) {
        const tile = decodePtm(readGz(dir, tc.key, 'ptm')!);
        const ptrBytes = readGz(dir, tc.key, 'ptr');
        const pbhBytes = readGz(dir, tc.key, 'pbh');
        const pbdBytes = readGz(dir, tc.key, 'pbd');
        const ptr: PtrTile | undefined = ptrBytes ? decodePtr(ptrBytes) : undefined;
        const pbh: PbhTile | undefined = pbhBytes ? decodePbh(pbhBytes) : undefined;
        const pbd = pbdBytes ? decodePbd(pbdBytes) : undefined;

        const basis = makeEnuBasis(tc.origin.lat, tc.origin.lon, tc.origin.height);
        const frameFix = enuFrameRotation(bakeBasis, basis);
        const toEnu = (lat: number, lon: number, heightM: number) => {
            const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, heightM));
            return { e: enu.e, n: enu.n };
        };
        const airfields = airfieldFile.items.filter(tc.airfields);
        const onAirfield = buildAirfieldExclusion(airfields, toEnu);
        const origin = tileOriginWorld(tile.id, tile.centerHeightM, basis);
        const pads = padsFor(origin, rng);
        const onSurface = buildSurfaceExclusion(pads);
        const identity = new THREE.Matrix4();
        const onManMade = sceneExclusionFor(tile, basis, frameFix, onAirfield, identity, onSurface, identity);
        const onRoad = ptr ? buildRoadExclusion(ptr) : undefined;
        const onBuilding = pbh ? buildBuildingExclusion(pbh) : undefined;
        const up = bedUp(bakeBasis, tc.key);
        const bedCellM = 32 * 2 ** Math.max(0, MAX_ZOOM - tc.key.z);
        const onBed = pbd && pbd.beds.length > 0 ? buildRailBedExclusion(pbd.beds, up, bedCellM) : undefined;
        const isExcluded = onRoad || onManMade || onBed || onBuilding
            ? (x: number, z: number, y: number) => (onRoad?.(x, z) ?? false) || (onBed?.(x, y, z) ?? false)
                || (onManMade?.(x, z, y) ?? false) || (onBuilding?.(x, y, z) ?? false)
            : undefined;

        // Point queries over the tile, per mask, in the tile's own metres.
        const half = 3600;
        const q: Array<[number, number, number]> = [];
        for (let i = 0; i < 2500; i++) {
            q.push([rng.range(-half, half), rng.range(-150, 150), rng.range(-half, half)]);
        }
        // ... and close to whatever each mask is built from, where the answers flip.
        const near: Array<[number, number, number]> = [];
        if (ptr) {
            for (let i = 0; i < 1000; i++) {
                const v = rng.int(0, ptr.positions.length / 3 - 1);
                near.push([ptr.positions[v * 3] * ptr.quantScale + rng.range(-15, 15), ptr.positions[v * 3 + 1] * ptr.quantScale,
                    ptr.positions[v * 3 + 2] * ptr.quantScale + rng.range(-15, 15)]);
            }
        }
        if (pbd && pbd.beds.length > 0) {
            for (let i = 0; i < 1000; i++) {
                const b = rng.int(0, pbd.beds.length / 11 - 1) * 11;
                const t = rng.next();
                near.push([pbd.beds[b] + (pbd.beds[b + 3] - pbd.beds[b]) * t + rng.range(-25, 25),
                    pbd.beds[b + 1] + (pbd.beds[b + 4] - pbd.beds[b + 1]) * t + rng.range(-3, 3),
                    pbd.beds[b + 2] + (pbd.beds[b + 5] - pbd.beds[b + 2]) * t + rng.range(-25, 25)]);
            }
        }
        if (pbh && pbh.buildings.length > 0) {
            const { a, b } = pbh.frame;
            for (let i = 0; i < 1000; i++) {
                const bd = pbh.buildings[rng.int(0, pbh.buildings.length - 1)];
                const u = pbh.verts[bd.firstVert * 2] + rng.range(-6, 6);
                const vv = pbh.verts[bd.firstVert * 2 + 1] + rng.range(-6, 6);
                // Tile x/z from (u, v): a and b are orthonormal and near horizontal, so this lands beside the outline.
                near.push([u * a[0] + vv * b[0], rng.range(-5, 30), u * a[2] + vv * b[2]]);
            }
        }
        // Eighths of a metre: exact in binary and short in JSON.
        const pts = [...q, ...near].map(p => p.map(c => Math.round(c * 8) / 8) as [number, number, number]);
        const masks = {
            pointList: pts.map(p => [p[0], p[1], p[2]]),
            road: onRoad ? bits(i => onRoad(pts[i][0], pts[i][2]), pts.length) : null,
            building: onBuilding ? bits(i => onBuilding(pts[i][0], pts[i][1], pts[i][2]), pts.length) : null,
            bed: onBed ? bits(i => onBed(pts[i][0], pts[i][1], pts[i][2]), pts.length) : null,
            manMade: onManMade ? bits(i => onManMade(pts[i][0], pts[i][2], pts[i][1]), pts.length) : null,
            all: isExcluded ? bits(i => isExcluded(pts[i][0], pts[i][2], pts[i][1]), pts.length) : null,
        };

        const cases: unknown[] = [];
        const runs: Array<{ density: number; excluded: boolean }> = DENSITIES.map(d => ({ density: d, excluded: true }));
        runs.push({ density: 1, excluded: false });
        for (const run of runs) {
            const test = run.excluded ? isExcluded : undefined;
            const groups = scatterTreeSpecies(tile, run.density, test);
            const clutter = scatterGroundClutter(tile, run.density, test);
            const allTreeGroups = [...groups, ...clutter.vegetation];
            const spacing = treeSpacingM(run.density);
            const treeMeshes = allTreeGroups.length > 0 ? buildTreeMeshes(allTreeGroups, STUB_MATERIALS, STUB_ATLAS, spacing) : [];
            const stoneMeshes = clutter.rocks.length > 0 ? [buildStoneMesh(clutter.rocks, STUB_MATERIALS, STUB_ATLAS)] : [];
            cases.push({
                density: run.density,
                excluded: run.excluded,
                spacingM: spacing,
                trees: groups.map(groupFixture),
                clutterVegetation: clutter.vegetation.map(groupFixture),
                rocks: clutter.rocks.map(groupFixture),
                treeCells: treeMeshes.map(meshFixture),
                stones: stoneMeshes.map(meshFixture),
            });
        }

        let eligible = false;
        for (let i = 3; i < tile.landAttrs.length; i += 4) {
            const cls = tile.landAttrs[i];
            if (cls === 1 || cls === 2 || CLUTTER_ELIGIBLE_CLASSES.has(cls)) {
                eligible = true;
                break;
            }
        }

        tiles.push({
            name: tc.name,
            key: tc.key,
            files: Object.fromEntries(EXTS.map(e => [e, fs.existsSync(path.join(dir, fileName(tc.key, e))) ? `tiles/vegetation/${fileName(tc.key, e)}` : null])),
            origin: tc.origin,
            frameFix: frameFix.toArray(),
            tileOrigin: origin.toArray(),
            airfields: airfields.map(a => a.icao || a.name),
            pads: pads.map(p => ({ ...p, slope: p.slope ?? null })),
            bedUp: up,
            bedCellM,
            eligible,
            masks,
            cases,
        });
    }

    // treeInstancesToDraw over a tile-frame sphere, as limitTrackDetail calls it.
    const draws: unknown[] = [];
    for (let i = 0; i < 300; i++) {
        const total = rng.int(0, 9000);
        const spacingM = i % 17 === 0 ? 0 : rng.range(5, 60);
        const center = new THREE.Vector3(rng.range(-4000, 4000), rng.range(-100, 300), rng.range(-4000, 4000));
        const radius = rng.range(100, 3000);
        const eye = i % 23 === 0 ? undefined
            : new THREE.Vector3(rng.range(-20000, 20000), rng.range(0, 8000), rng.range(-20000, 20000));
        const pixelAngle = i % 29 === 0 ? 0 : 2 * Math.tan(rng.range(20, 80) * Math.PI / 360) / rng.int(400, 2200);
        const mesh = { count: total, userData: { treeTotal: total, treeSpacingM: spacingM, tileSphere: new THREE.Sphere(center, radius) } };
        const group = new THREE.Object3D();
        const count = treeInstancesToDraw(mesh as unknown as THREE.InstancedMesh, group, eye, pixelAngle);
        draws.push({ total, spacingM, center: center.toArray(), radius, eye: eye ? eye.toArray() : null, pixelAngle, count });
    }

    const distances: number[] = [];
    for (let d = 0; d <= 12000; d += 250) distances.push(d);
    distances.push(1999.999, 2000.0001, 7999.99, 8000, 9999.99, 10000);
    const multipliers = [-1, 0, 0.5, 1, 7.25, 20, 25, Number.NaN, Number.POSITIVE_INFINITY];

    return {
        files: [{
            file: 'vegetation.json',
            data: {
                suite: 'vegetation',
                version: 1,
                source: [
                    'src/script/terrain/treeBillboards.ts', 'src/script/terrain/stones.ts',
                    'src/script/terrain/{road,building,airfield,surface}Exclusion.ts', 'src/script/terrain/railBed.ts (buildRailBedExclusion)',
                    'src/script/terrain/terrainEntity.ts (attachTrees, sceneExclusionFor, loadBeds)',
                ],
                notes: [
                    'Tile files under tiles/vegetation are gzip on disk, like the codecs fixtures.',
                    'Masks are strings of 0/1 per query point, in pointList order; manMade and all take (x, z, y).',
                    'Cases run attachTrees: scatterTreeSpecies, scatterGroundClutter, buildTreeMeshes on trees + clutter vegetation, buildStoneMesh on rocks.',
                    'treeCells/stones describe the InstancedMesh Float32 arrays (instanceMatrix 16 floats per instance, column-major) in slot order.',
                    'sphere is InstancedMesh.computeBoundingSphere over the slots in order, tile-local metres.',
                ],
                tolerances: { instances: 'exact (fnv1a32 over float32 bytes)', groups: 'exact (fnv1a32 over float64 bytes)', sphere: 'exact' },
                tiles,
                draws,
                densityScale: distances.map(d => [d, treeDensityScaleForDistance(d)]),
                clampMultiplier: multipliers.map(m => [m, clampTreeDensityMultiplier(m)]),
                spacing: [0, 1e-4, 0.08, 0.37, 1, 2.5, 20].map(d => [d, treeSpacingM(d)]),
            },
        }],
    };
}
