/**
 * Cloud and cirrus fixtures (workstream J): the cumulus/cirrus model geometry the builders
 * make (solid body welded and smooth-normalled, the 12-tier haze buffer with its LOD prefixes,
 * cirrus streaks), and the SceneryField's per-pass placement along camera paths: tile wrap
 * (recycling) as the camera crosses tiles, a re-base, frustum tests and screen-size LOD.
 *
 * The field deals its cells with Math.random; the suite swaps in a seeded Rng while the field
 * is built so the deal is repeatable. The field options and altitude functions are copies of
 * state/game.ts's (they are inline there); keep them in step.
 */
import * as THREE from 'three';
import { HDNoonPalette } from '../../../src/script/config/palettes/hd-noon';
import { DisplayShading, FogQuality } from '../../../src/script/config/profiles/profile';
import { getLodLevel, resolveLodLevel } from '../../../src/script/render/helpers';
import { SceneryField, SceneryFieldSettings } from '../../../src/script/scene/entities/sceneryField';
import { SimpleEntity } from '../../../src/script/scene/entities/simpleEntity';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { CIRRUS_STREAK_SHAPES, CirrusModelLibBuilder } from '../../../src/script/scene/models/lib/cirrusModelBuilder';
import { CLOUD_PUFF_SHAPES, CloudModelLibBuilder } from '../../../src/script/scene/models/lib/cloudModelBuilder';
import { Model, ModelManager } from '../../../src/script/scene/models/models';
import { SceneLayers } from '../../../src/script/scene/scene';
import { FrameShift, makeEnuBasis } from '../../../src/script/terrain/geodesy';
import { describe, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';

const b64 = (a: Float32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');

/** Typed array as {length, fnv1a32, head, sample (every 97th)}; full base64 when small. */
function floats(a: Float32Array, fullBelow = 6000): Record<string, unknown> {
    const sample: number[] = [];
    for (let i = 0; i < a.length; i += 97) sample.push(a[i]);
    return a.length <= fullBelow
        ? { length: a.length, fnv1a32: hex32(fnv1a32(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))), base64: b64(a) }
        : { ...(describe(a, 12) as Record<string, unknown>), sample };
}

function ints(a: ArrayLike<number>): Record<string, unknown> {
    const u = Uint32Array.from(a as ArrayLike<number>);
    return describe(u, 12) as Record<string, unknown>;
}

const CLOUD_BASE_ALTITUDE_M = 1400;
const CLOUD_ALTITUDE_VARIATION_M = 500;
const CIRRUS_BASE_ALTITUDE_M = 9200;
const CIRRUS_ALTITUDE_VARIATION_M = 400;

const cloudFieldOptions: SceneryFieldSettings = {
    tilesInField: 9,
    cellsInTile: 2,
    tileLength: 6000,
    cellVariations: [
        { probability: 0.12, model: 'lib:cloudLarge', jitter: 1, randomRotation: true, lodBias: -2 },
        { probability: 0.18, model: 'lib:cloudMedium', jitter: 1, randomRotation: true, lodBias: -2 },
        { probability: 0.15, model: 'lib:cloudSmall', jitter: 1, randomRotation: true, lodBias: -2 },
        { probability: 0.55, model: 'lib:cloudNone', jitter: 0, randomRotation: false },
    ],
    statsKey: 'cloud',
};
const cloudAltitudeAt = (x: number, z: number) =>
    CLOUD_BASE_ALTITUDE_M + Math.sin(x * 0.00021) * Math.cos(z * 0.00017) * CLOUD_ALTITUDE_VARIATION_M;

const cirrusFieldOptions: SceneryFieldSettings = {
    tilesInField: 7,
    cellsInTile: 2,
    tileLength: 60000,
    cellVariations: [
        { probability: 0.08, model: 'lib:cirrusWide', jitter: 1, randomRotation: false },
        { probability: 0.12, model: 'lib:cirrusThin', jitter: 1, randomRotation: false },
        { probability: 0.8, model: 'lib:cirrusNone', jitter: 0, randomRotation: false },
    ],
    statsKey: 'cirrus',
};
const cirrusAltitudeAt = (x: number, z: number) =>
    CIRRUS_BASE_ALTITUDE_M + Math.sin(x * 0.00013 + 5) * Math.cos(z * 0.00009 + 5) * CIRRUS_ALTITUDE_VARIATION_M;

function meshTriangles(o: THREE.Object3D): number {
    const g = (o as THREE.Mesh).geometry;
    const count = Math.min(g.drawRange.count, g.index ? g.index.count : g.attributes.position.count);
    return count / 3;
}

function describeModel(name: string, model: Model): Record<string, unknown> {
    const out: Record<string, unknown> = {
        name,
        maxSize: model.maxSize,
        centerY: model.center.y,
        lodCount: model.lod.length,
        triangles: model.lod.map(l => l.volumes.reduce((s, m) => s + meshTriangles(m), 0)),
    };
    const first = model.lod[0].volumes;
    if (first.length === 0) return out;
    const g0 = (first[0] as THREE.Mesh).geometry;
    if (name.startsWith('cloud')) {
        out.solid = {
            positions: floats(g0.getAttribute('position').array as Float32Array),
            normals: floats(g0.getAttribute('normal').array as Float32Array),
            index: ints(g0.index!.array),
        };
        const haze = (first[1] as THREE.Mesh).geometry;
        out.haze = {
            positions: floats(haze.getAttribute('position').array as Float32Array),
            normals: floats(haze.getAttribute('normal').array as Float32Array),
            ditherLevel: floats(haze.getAttribute('ditherLevel').array as Float32Array),
            drawRanges: model.lod.map(l => l.volumes.length > 1 ? (l.volumes[1] as THREE.Mesh).geometry.drawRange.count : 0),
        };
    } else {
        out.positions = floats(g0.getAttribute('position').array as Float32Array, 20000);
        out.normals = floats(g0.getAttribute('normal').array as Float32Array, 20000);
    }
    return out;
}

interface Frame {
    pos: [number, number, number];
    target: [number, number, number];
    targetWidth: number;
    fov?: number;
    aspect?: number;
    /** Applied to the field (and the camera path's frame) before this frame. */
    rebase?: { from: [number, number]; to: [number, number] };
}

interface PathCase {
    name: string;
    field: 'cloud' | 'cirrus';
    seed: number;
    frames: Frame[];
}

function paths(): PathCase[] {
    const cruise: Frame[] = [];
    for (let i = 0; i <= 16; i++) {
        const x = -4000 + i * 2500;
        cruise.push({ pos: [x, 3000, 1000], target: [x + 1000, 2700, 1000], targetWidth: 1280 });
    }
    const turn: Frame[] = [];
    for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        turn.push({
            pos: [500, 900, -800], target: [500 + Math.cos(a) * 1000, 1150, -800 + Math.sin(a) * 1000],
            targetWidth: i % 2 === 0 ? 1920 : 640, fov: 50, aspect: 1.6,
        });
    }
    const inDeck: Frame[] = [];
    for (let i = 0; i < 10; i++) {
        const z = 2000 - i * 1500;
        inDeck.push({ pos: [3000, 1500, z], target: [3000, 1450, z - 1000], targetWidth: 2560 });
    }
    const rebased: Frame[] = [];
    for (let i = 0; i < 6; i++) {
        rebased.push({ pos: [i * 4000, 2500, 0], target: [i * 4000 + 1000, 2400, 0], targetWidth: 1280 });
    }
    rebased.push({ pos: [0, 2500, 0], target: [1000, 2400, 0], targetWidth: 1280, rebase: { from: [28.0, -15.4], to: [28.0, -15.18] } });
    for (let i = 1; i < 6; i++) {
        rebased.push({ pos: [i * 4000, 2500, 300], target: [i * 4000 + 1000, 2400, 300], targetWidth: 1280 });
    }
    const outside: Frame[] = [
        { pos: [1.05e7, 3000, 0], target: [1.05e7 + 1000, 3000, 0], targetWidth: 1280 },
        { pos: [9.99e6, 3000, 0], target: [9.99e6 + 1000, 3000, 0], targetWidth: 1280 },
    ];
    const cirrus: Frame[] = [];
    for (let i = 0; i <= 12; i++) {
        const z = 30000 - i * 25000;
        cirrus.push({ pos: [-5000, 8500, z], target: [-4000, 8700, z - 1000], targetWidth: 1280 });
    }
    const cirrusHigh: Frame[] = [];
    for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        cirrusHigh.push({ pos: [200000, 12000, -150000], target: [200000 + Math.cos(a) * 1000, 11900, -150000 + Math.sin(a) * 1000], targetWidth: 1920 });
    }
    return [
        { name: 'cruise east across tiles', field: 'cloud', seed: 101, frames: cruise },
        { name: 'turn in place under the deck', field: 'cloud', seed: 202, frames: turn },
        { name: 'inside the deck heading north', field: 'cloud', seed: 303, frames: inDeck },
        { name: 'cruise with a re-base', field: 'cloud', seed: 404, frames: rebased },
        { name: 'edge of the area', field: 'cloud', seed: 505, frames: outside },
        { name: 'cirrus heading north', field: 'cirrus', seed: 606, frames: cirrus },
        { name: 'cirrus from above, turning', field: 'cirrus', seed: 707, frames: cirrusHigh },
    ];
}

type TileItem = { offset: THREE.Vector3; entity: SimpleEntity };

export function cloudsSuite(): SuiteOutput {
    const materials = new SceneMaterialManager(HDNoonPalette, FogQuality.HIGH, DisplayShading.FULL);
    const builders = [
        new CloudModelLibBuilder('cloudNone', []),
        new CloudModelLibBuilder('cloudSmall', CLOUD_PUFF_SHAPES.small),
        new CloudModelLibBuilder('cloudMedium', CLOUD_PUFF_SHAPES.medium),
        new CloudModelLibBuilder('cloudLarge', CLOUD_PUFF_SHAPES.large),
        new CirrusModelLibBuilder('cirrusNone', []),
        new CirrusModelLibBuilder('cirrusThin', CIRRUS_STREAK_SHAPES.thin),
        new CirrusModelLibBuilder('cirrusWide', CIRRUS_STREAK_SHAPES.wide),
    ];
    const models = new Map<string, Model>();
    const names = new Map<Model, string>();
    for (const b of builders) {
        const m = b.build(materials);
        models.set(`lib:${b.type}`, m);
        names.set(m, b.type);
    }
    const manager = { getModel: (url: string) => models.get(url)! } as unknown as ModelManager;

    const icosahedra = ([[1, 0], [1, 1], [1, 2], [137.5, 0], [260, 2]] as const).map(([r, d]) => ({
        radius: r, detail: d, positions: floats(new THREE.IcosahedronGeometry(r, d).getAttribute('position').array as Float32Array, 20000),
    }));
    const hash01 = [0, 1.7, 11, 3.1 * 977 + 11, 5.3 * 2500 + 3, 7.9 * 13109 + 5].map(n => {
        const s = Math.sin(n * 12.9898) * 43758.5453;
        return [n, s - Math.floor(s)];
    });

    const palette = HDNoonPalette;
    const lists = new Map<string, THREE.Scene>([
        [SceneLayers.EntityFlats, new THREE.Scene()],
        [SceneLayers.EntityVolumes, new THREE.Scene()],
    ]);

    const cases = paths().map(pc => {
        // Only the field's own draws take the seeded stream: three's Object3D constructor
        // (generateUUID, four draws per entity) also calls Math.random, and the port has no
        // Object3D, so those go to a separate stream.
        const rng = new Rng(pc.seed);
        const uuids = new Rng(pc.seed ^ 0x5eed);
        const saved = Math.random;
        Math.random = () => (new Error().stack?.split('\n')[2] ?? '').includes('generateUUID') ? uuids.next() : rng.next();
        let field: SceneryField;
        try {
            field = pc.field === 'cloud'
                ? new SceneryField(manager, new THREE.Box2(new THREE.Vector2(-1e7, -1e7), new THREE.Vector2(1e7, 1e7)), cloudFieldOptions, cloudAltitudeAt)
                : new SceneryField(manager, new THREE.Box2(new THREE.Vector2(-1e7, -1e7), new THREE.Vector2(1e7, 1e7)), cirrusFieldOptions, cirrusAltitudeAt);
        } finally {
            Math.random = saved;
        }
        const tiles = (field as unknown as { tiles: TileItem[][] }).tiles;
        let drawn: number[][] = [];
        let camera!: THREE.PerspectiveCamera;
        let targetWidth = 0;
        const layout = tiles.map((tile, ti) => tile.map((item, ci) => {
            const entity = item.entity;
            const helper = (entity as unknown as { lodHelper: { model: Model; bias: number } }).lodHelper;
            const original = entity.render3D.bind(entity);
            entity.render3D = (w, h, cam, l, p) => {
                original(w, h, cam, l, p);
                const pos = entity.position;
                const lod = resolveLodLevel(helper.model, getLodLevel(pos, entity.scale, targetWidth, camera, helper.model.maxSize, helper.bias));
                drawn.push([ti, ci, pos.x, pos.y, pos.z, lod, entity.lastTriangles]);
            };
            return [names.get(helper.model)!, item.offset.x, item.offset.z, entity.quaternion.y, entity.quaternion.w, helper.bias];
        }));
        const frames = pc.frames.map(f => {
            let rebase: unknown = undefined;
            if (f.rebase) {
                const shift = FrameShift.between(makeEnuBasis(f.rebase.from[0], f.rebase.from[1], 0), makeEnuBasis(f.rebase.to[0], f.rebase.to[1], 0));
                field.rebase(shift);
                const offset = (field as unknown as { fieldOffset: THREE.Vector2 }).fieldOffset;
                rebase = { rotation: shift.rotation.toArray(), offset: shift.offset.toArray(), fieldOffset: [offset.x, offset.y] };
            }
            camera = new THREE.PerspectiveCamera(f.fov ?? 50, f.aspect ?? 1.6, 2, 550000);
            camera.position.set(...f.pos);
            camera.lookAt(new THREE.Vector3(...f.target));
            camera.updateMatrixWorld(true);
            camera.updateProjectionMatrix();
            targetWidth = f.targetWidth;
            drawn = [];
            const height = Math.round(targetWidth / camera.aspect);
            field.render3D(targetWidth, height, camera, lists, palette);
            const projScreen = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
            const frustum = new THREE.Frustum().setFromProjectionMatrix(projScreen);
            return {
                rebase,
                camera: camera.position.toArray(),
                tanHalfFov: Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2),
                aspect: camera.aspect,
                targetWidth,
                projScreen: projScreen.elements.slice(),
                planes: frustum.planes.map(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]),
                drawn,
            };
        });
        return { name: pc.name, field: pc.field, seed: pc.seed, layout, frames };
    });

    return {
        files: [{
            file: 'clouds.json',
            data: {
                suite: 'clouds',
                version: 1,
                source: [
                    'src/script/scene/models/lib/cloudModelBuilder.ts',
                    'src/script/scene/models/lib/cirrusModelBuilder.ts',
                    'src/script/scene/entities/sceneryField.ts',
                    'src/script/render/helpers.ts (getLodLevel, resolveLodLevel)',
                    'src/script/state/game.ts (cloud/cirrus field options and altitude functions, copied)',
                ],
                notes: 'Float arrays are float32: fnv1a32 over little-endian bytes, base64 when small, else head + every 97th element. '
                    + 'Indices are hashed as Uint32. Field cells are dealt with Rng(seed) in place of Math.random. '
                    + 'layout[tile][cell] = [model, offsetX, offsetZ, quaternion.y, quaternion.w, lodBias]. '
                    + 'drawn = [tile, cell, x, y, z, lod, triangles] per entity the field rendered, in call order. '
                    + 'planes are three.js Frustum planes [nx, ny, nz, constant] from projScreen (column-major).',
                tolerances: { all: 0 },
                icosahedra,
                hash01,
                models: builders.map(b => describeModel(b.type, models.get(`lib:${b.type}`)!)),
                cases,
            },
        }],
    };
}
