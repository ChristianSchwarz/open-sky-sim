/**
 * Road, railway and bridge geometry fixtures (workstream E, roads part): what
 * the runtime computes on the CPU per tile from the decoded .ptr and .pbr
 * sidecars before anything reaches the GPU.
 *
 * - roadStrokes.ts: the split of a .ptr index list into major / minor / rail
 *   meshes (buildRoadMeshes), their triangle and byte counts, the track-detail
 *   reach.
 * - roadLod.ts: the coarser index lists (RoadLevels) at [0.25, 1, 4, 16] m,
 *   built in order and out of order (the lazy build depends on it), and
 *   roadLevelFor.
 * - roadExclusion.ts: the trees' road mask, probed at points near and between
 *   the strokes.
 * - bridgeMeshes.ts: role-split index lists, the level-crossing furniture
 *   boxes (float32 positions/normals, uint32 indices), the deck track stroke,
 *   triangle and byte counts, and every part's bounding sphere (what
 *   showLevel's hide-by-pixel-size measures to).
 *
 * The tiles are copied verbatim into tests/golden/tiles/roads/ by
 * copyRoadTiles (run from --select-tiles or --select-road-tiles); the suite
 * itself only reads the copies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { BridgeRole, decodePbr, PbrTile } from '../../../src/script/terrain/pbr';
import { decodePtr, PtrTile } from '../../../src/script/terrain/ptr';
import { ecefToEnu, makeEnuBasis, sceneFromEnu } from '../../../src/script/terrain/geodesy';
import { buildBridgeMeshes, boxGeometry } from '../../../src/script/terrain/bridgeMeshes';
import { buildRoadExclusion } from '../../../src/script/terrain/roadExclusion';
import { RoadLevels, roadLevelFor, roadLevels } from '../../../src/script/terrain/roadLod';
import { buildRoadMeshes, roadTriangles, trackDetailReachM } from '../../../src/script/terrain/roadStrokes';
import { tileOriginWorld } from '../../../src/script/terrain/tileMesh';
import { TileKey } from '../../../src/script/terrain/tiling';
import { describe, Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

/**
 * Gran Canaria (home, roads only, z8/z10/z12) and DACH leaves with railways,
 * service track, switch zones, bridge decks with track and level-crossing
 * furniture.
 */
export const ROAD_TILES: ReadonlyArray<{ key: TileKey; ext: 'ptr' | 'pbr' }> = [
    { key: { z: 8, x: 233, y: 88 }, ext: 'ptr' },
    { key: { z: 10, x: 935, y: 352 }, ext: 'ptr' },
    { key: { z: 12, x: 3741, y: 1411 }, ext: 'ptr' },
    { key: { z: 12, x: 3741, y: 1411 }, ext: 'pbr' },
    { key: { z: 12, x: 4236, y: 934 }, ext: 'ptr' },
    { key: { z: 12, x: 4236, y: 934 }, ext: 'pbr' },
    { key: { z: 12, x: 4231, y: 988 }, ext: 'ptr' },
    { key: { z: 12, x: 4231, y: 988 }, ext: 'pbr' },
    { key: { z: 12, x: 4230, y: 973 }, ext: 'ptr' },
    { key: { z: 12, x: 4230, y: 973 }, ext: 'pbr' },
];

function fixtureName(k: TileKey, ext: string): string {
    return `${k.z}_${k.x}_${k.y}.${ext}`;
}

/** Copy the suite's tiles from the baked tree; returns how many. */
export function copyRoadTiles(ctx: SuiteContext): number {
    const outDir = path.join(ctx.goldenRoot, 'tiles', 'roads');
    fs.mkdirSync(outDir, { recursive: true });
    let n = 0;
    for (const { key, ext } of ROAD_TILES) {
        const src = path.join(ctx.terrainRoot, `${key.z}`, `${key.x}`, `${key.y}.${ext}`);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(outDir, fixtureName(key, ext)));
        n++;
    }
    return n;
}

function inflate(raw: Uint8Array): Uint8Array {
    return raw.length >= 2 && raw[0] === 0x1F && raw[1] === 0x8B ? new Uint8Array(gunzipSync(raw)) : raw;
}

/** Index of the first array in `seen` that is the same object, appending it when new. */
function refId(seen: unknown[], a: unknown): number {
    const i = seen.indexOf(a);
    if (i >= 0) return i;
    seen.push(a);
    return seen.length - 1;
}

const dummy = new THREE.MeshBasicMaterial();

/** The local vertical at a tile in its own (bake) axes: what terrainEntity's localUp hands RoadLevels. */
function localUp(key: TileKey, manifest: { enuOrigin: { lat: number; lon: number; height: number } }): [number, number, number] {
    const basis = makeEnuBasis(manifest.enuOrigin.lat, manifest.enuOrigin.lon, manifest.enuOrigin.height);
    const origin = tileOriginWorld(key, 0, basis);
    const earth = sceneFromEnu(ecefToEnu(basis, { x: 0, y: 0, z: 0 }));
    const up = origin.sub(earth).normalize();
    return [up.x, up.y, up.z];
}

function levelsFixture(tile: PtrTile, indices: Uint16Array, up: [number, number, number]): unknown {
    const all = roadLevels(tile, indices, up);
    const seen: unknown[] = [];
    const inOrder = { refs: all.map(l => refId(seen, l)), levels: seen.map(l => describe(l)) };
    // The lazy build skips the levels between: building 3 first makes level 3
    // relative to level 0, and level 1 built after it is its own.
    const lazy = new RoadLevels(tile, indices, up);
    const steps: unknown[] = [];
    const seen2: unknown[] = [indices];
    for (const level of [3, 1, 4, 2]) {
        lazy.build(level);
        steps.push({ build: level, has: [0, 1, 2, 3, 4, 5].map(l => lazy.has(l)), get: [0, 1, 2, 3, 4, 5].map(l => refId(seen2, lazy.get(l))) });
    }
    return { inOrder, lazy: { steps, levels: seen2.map(l => describe(l)) } };
}

function exclusionFixture(tile: PtrTile, rng: Rng): unknown {
    const test = buildRoadExclusion(tile);
    if (!test) return null;
    const s = tile.quantScale;
    const n = tile.positions.length / 3;
    const pts: number[] = [];
    // Near the strokes: a vertex pushed out across its reach, so the probes
    // straddle the half-width + 5 m boundary.
    for (let i = 0; i < 300; i++) {
        const v = rng.int(0, n - 1);
        const reach = tile.halfWidths[v] / 10 + 5;
        const a = rng.range(0, 2 * Math.PI);
        const d = rng.range(0, reach * 1.6);
        pts.push(tile.positions[v * 3] * s + Math.cos(a) * d, tile.positions[v * 3 + 2] * s + Math.sin(a) * d);
    }
    // On the boundary itself, to the centimetre: a vertex's reach out
    // across its own stroke (dir is the offset across the road).
    for (let i = 0; i < 300; i++) {
        const v = rng.int(0, n - 1);
        const reach = tile.halfWidths[v] / 10 + 5;
        const d = reach * (1 + rng.range(-0.002, 0.002));
        const dx = tile.directions[v * 4], dz = tile.directions[v * 4 + 2];
        const len = Math.hypot(dx, dz) || 1;
        pts.push(tile.positions[v * 3] * s + dx / len * d, tile.positions[v * 3 + 2] * s + dz / len * d);
    }
    // Anywhere over the strokes' extent, and a little past it.
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let v = 0; v < n; v++) {
        x0 = Math.min(x0, tile.positions[v * 3] * s); x1 = Math.max(x1, tile.positions[v * 3] * s);
        z0 = Math.min(z0, tile.positions[v * 3 + 2] * s); z1 = Math.max(z1, tile.positions[v * 3 + 2] * s);
    }
    for (let i = 0; i < 200; i++) {
        pts.push(rng.range(x0 - 200, x1 + 200), rng.range(z0 - 200, z1 + 200));
    }
    let hits = '';
    for (let i = 0; i < pts.length; i += 2) hits += test(pts[i], pts[i + 1]) ? '1' : '0';
    return { points: pts, hits };
}

function ptrFixture(name: string, raw: Uint8Array, up: [number, number, number], rng: Rng): unknown {
    const tile = decodePtr(inflate(raw));
    // Same step as the tile it is drawn in, and a different bake's step.
    const roads = buildRoadMeshes(tile, tile.quantScale, { major: dummy, minor: dummy, rail: dummy, railDetail: dummy, railTop: dummy });
    const other = buildRoadMeshes(tile, tile.quantScale * 1.25, { major: dummy, minor: dummy, rail: dummy });
    const kinds: Record<string, unknown> = {};
    for (const kind of ['major', 'minor', 'rail'] as const) {
        const mesh = roads[kind];
        const index = mesh?.geometry.getIndex()?.array as Uint16Array | undefined;
        kinds[kind] = index
            ? { indices: describe(index), isAll: index === tile.indices, levels: levelsFixture(tile, index, up) }
            : null;
    }
    return {
        file: `tiles/roads/${name}`,
        key: tile.id,
        quantScale: tile.quantScale,
        up,
        kinds,
        triangles: roadTriangles(roads),
        trianglesNoTrackPasses: roadTriangles(other),
        bytes: roads.bytes,
        groupScale: roads.group.scale.x,
        groupScaleOther: other.group.scale.x,
        exclusion: exclusionFixture(tile, rng),
    };
}

function sphereOf(mesh: THREE.Mesh | undefined): unknown {
    if (!mesh) return null;
    mesh.geometry.computeBoundingSphere();
    const s = mesh.geometry.boundingSphere!;
    return { center: [s.center.x, s.center.y, s.center.z], radius: s.radius };
}

function indexOf(mesh: THREE.Mesh | undefined): unknown {
    return mesh ? describe(mesh.geometry.getIndex()!.array) : null;
}

function pbrFixture(name: string, raw: Uint8Array): unknown {
    const tile: PbrTile = decodePbr(inflate(raw));
    const set = buildBridgeMeshes(tile, tile.quantScale, {
        deck: dummy, concrete: dummy, railDeck: dummy, signRed: dummy, signWhite: dummy, signPost: dummy,
        track: dummy, trackDetail: dummy, trackTop: dummy,
    });
    const slots: Record<string, unknown> = {};
    for (const slot of ['deck', 'concrete', 'railDeck', 'signRed', 'signWhite', 'signPost'] as const) {
        const mesh = set[slot];
        const index = mesh?.geometry.getIndex()?.array;
        slots[slot] = mesh ? {
            index: describe(index),
            isAll: index === tile.indices,
            // Bridge geometry shares the tile's int16 positions; furniture has its own float32 boxes.
            boxes: mesh.geometry.getAttribute('position').array instanceof Float32Array,
            sphere: sphereOf(mesh),
        } : null;
    }
    const boxes: Record<string, unknown> = {};
    for (const role of [BridgeRole.Deck, BridgeRole.Concrete, BridgeRole.RailDeck, BridgeRole.SignRed, BridgeRole.SignWhite, BridgeRole.SignPost]) {
        const g = tile.boxes ? boxGeometry(tile.boxes, role, tile.quantScale) : undefined;
        boxes[String(role)] = g ? {
            positions: describe(g.getAttribute('position').array),
            normals: describe(g.getAttribute('normal').array),
            indices: describe(g.getIndex()!.array),
        } : null;
    }
    return {
        file: `tiles/roads/${name}`,
        key: tile.id,
        quantScale: tile.quantScale,
        slots,
        extra: (set.extra ?? []).map(m => ({ index: indexOf(m), sphere: sphereOf(m) })),
        boxes,
        track: set.track ? {
            index: indexOf(set.track),
            sphere: sphereOf(set.track),
            passes: [set.trackDetail !== undefined, set.trackTop !== undefined],
        } : null,
        bytes: set.bytes,
    };
}

export function roadsSuite(ctx: SuiteContext): SuiteOutput {
    const dir = path.join(ctx.goldenRoot, 'tiles', 'roads');
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.goldenRoot, 'tiles', 'manifest.json'), 'utf8'));
    const rng = new Rng(0x40AD5);
    const strokes: unknown[] = [];
    const bridges: unknown[] = [];
    for (const { key, ext } of ROAD_TILES) {
        const name = fixtureName(key, ext);
        const p = path.join(dir, name);
        if (!fs.existsSync(p)) throw new Error(`missing ${p}; run generate.ts --select-road-tiles`);
        const raw = new Uint8Array(fs.readFileSync(p));
        if (ext === 'ptr') {
            strokes.push(ptrFixture(name, raw, localUp(key, manifest), rng));
        } else {
            bridges.push(pbrFixture(name, raw));
        }
    }

    const levelFor: Array<[number, number]> = [];
    for (const m of [0, 0.1, 0.4999, 0.5, 0.5001, 1, 1.99, 2, 2.5, 7.99, 8, 9, 31.99, 32, 33, 100, 1e6]) {
        levelFor.push([m, roadLevelFor(m)]);
    }
    const reach: Array<[number, number, number, number]> = [];
    for (const [fov, aspect, h] of [[50, 16 / 9, 1080], [60, 4 / 3, 720], [30, 2.1, 2160], [90, 1, 0], [10, 1.5, 400]]) {
        reach.push([fov, aspect, h, trackDetailReachM(fov, aspect, h)]);
    }

    return {
        files: [{
            file: 'roads.json',
            data: {
                suite: 'roads',
                version: 1,
                source: 'src/script/terrain/{roadStrokes,roadLod,roadExclusion,bridgeMeshes}.ts',
                notes: [
                    'Tiles are copied verbatim (gzip) under tests/golden/tiles/roads/.',
                    'kinds.<kind>.indices: buildRoadMeshes splits the index list by the class byte of each triangle\'s first vertex: rail = classes 7/8, major <= 3 (Secondary), minor the rest. isAll = the tile\'s own array was reused.',
                    '`up` is the input to RoadLevels: the geocentric vertical at the tile origin (h = 0) in the manifest ENU scene axes (x E, y U, z S).',
                    'levels.inOrder: roadLevels() (build 1..4 in order); refs[i] = which distinct array level i is (a level that saves < 10% repeats the finer one by reference).',
                    'levels.lazy: one RoadLevels built 3, 1, 4, 2 in that order; get[l] for l = 0..5 indexes lazy.levels, whose entry 0 is the full list.',
                    'exclusion.points are (x, z) pairs in tile-local metres; hits is one 0/1 per pair.',
                    'triangles counts major+minor+rail+sleeper pass+rail pass (the two passes share the rail list); trianglesNoTrackPasses is without them.',
                    'groupScale: quantScale/tileScale when they differ by more than 1e-6 relative, else 1 (tileScaleOther = 1.25 x quantScale).',
                    'bridge slots: role-split index lists over the shared int16 positions, or (boxes = true) the furniture box mesh when the role has no bridge geometry. sphere is three.js computeBoundingSphere over the whole position buffer, in quantisation units.',
                    'boxes.<role>: boxGeometry float32 positions in quantisation units (metres / quantScale), float32 normals, uint32 indices.',
                    'bytes: the GPU byte estimate the cache budget uses.',
                    'roadLevelFor: [metresPerPixel, level]; trackDetailReach: [fovDeg, aspect, heightPx, metres].',
                ],
                tolerances: { doubles: 1e-12, reachRelative: 1e-12 },
                strokes,
                bridges,
                roadLevelFor: levelFor,
                trackDetailReach: reach,
            },
        }],
    };
}
