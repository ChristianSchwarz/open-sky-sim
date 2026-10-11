/**
 * Crash wreck system (workstream M9): the real WreckField and AirframeDamage
 * driven through scripted crashes - break-up on sloped ground at shallow and
 * steep angles, a ditching in the sea (float, sink, foam), a crash on a moving
 * carrier deck, survivable hard impacts that bend and rip a living airframe
 * (then the final break-up carrying that damage on), a mid-air break-up, a
 * procedural jet with a three-leg gear at scale 1.25 on a coast, and a dense
 * airframe that sheds burning shards. Then fixed-dt stepping for several seconds.
 *
 * The F-22 comes from assets/*.glb through a small synchronous GLB reader (the
 * suites are synchronous; GLTFLoader.parse is not) and the processModel steps
 * the wreck depends on (node matrix decomposed and recomposed, flats dropped,
 * the 0.0001 rad rotateY hack, volumes sorted by name); its meshes are dumped
 * as the input both sides build from. Procedural models are three.js
 * BoxGeometry, described by their arguments with a hash of the TS geometry so
 * the C# replica can check itself.
 *
 * Math.random is a mulberry32 stream while the wreck code runs; three's
 * generateUUID (Object3D / BufferGeometry constructors, which the port does not
 * have) draws from a separate stream, told apart by the call stack.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { AirframeDamage } from '../../../src/script/scene/entities/airframeDamage';
import { WreckField, WreckPart, WreckSource } from '../../../src/script/scene/entities/wreckField';
import { Model } from '../../../src/script/scene/models/models';
import { FrameShift } from '../../../src/script/terrain/geodesy';
import { arr, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ASSETS = path.resolve(__dirname, '../../../assets');
const DT = 1 / 60;
const FULL_EVENTS = 40;

const v3 = (v: THREE.Vector3): number[] => [v.x, v.y, v.z];
const q4 = (q: THREE.Quaternion): number[] => [q.x, q.y, q.z, q.w];

// --- input models ------------------------------------------------------------------

/** A float32 value as JSON keeps it: the shortest round-tripping decimal, and no negative zero. */
const f32 = (x: number): number => (x === 0 ? 0 : Number(Math.fround(x).toPrecision(9)));

interface MeshSpec {
    name: string;
    material: string;
    /** mesh.position / quaternion / scale (the node matrix decomposed, as the loader leaves it). */
    trs: number[];
    /** mesh.matrix after updateMatrix (column-major): compose(trs). */
    matrix: number[];
    positions: number[];
    normals: number[] | null;
    indices: number[] | null;
}

interface BoxSpec {
    material: string;
    /** BoxGeometry(width, height, depth, widthSegments, heightSegments, depthSegments). */
    args: [number, number, number, number, number, number];
    /** .translate(x, y, z) after toNonIndexed(). */
    translate: [number, number, number] | null;
    /** The mesh's own position (mesh.matrix = translation). */
    position: [number, number, number];
}

interface ModelSpec {
    maxSize: number;
    meshes?: MeshSpec[];
    boxes?: BoxSpec[];
}

/** Read a GLB synchronously: scene 0's triangle meshes as three objects, plus the AABB over every node of every scene. */
function readGlb(file: string): { meshes: THREE.Mesh[]; maxSize: number } {
    const buf = fs.readFileSync(path.join(ASSETS, file));
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const binStart = 20 + jsonLen + 8;
    const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
    const accessor = (i: number): { array: Float32Array | Uint16Array | Uint32Array; itemSize: number } => {
        const a = json.accessors[i];
        const bv = json.bufferViews[a.bufferView];
        const itemSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as string] as number;
        const offset = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
        const n = a.count * itemSize;
        if (bv.byteStride && bv.byteStride !== itemSize * 4) throw new Error('strided accessor');
        const bytes = Uint8Array.from(bin.subarray(offset, offset + n * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2)));
        const array = a.componentType === 5126 ? new Float32Array(bytes.buffer)
            : a.componentType === 5125 ? new Uint32Array(bytes.buffer) : new Uint16Array(bytes.buffer);
        return { array, itemSize };
    };
    const nodeMatrix = (node: Any): THREE.Matrix4 => node.matrix
        ? new THREE.Matrix4().fromArray(node.matrix)
        : new THREE.Matrix4().compose(
            new THREE.Vector3().fromArray(node.translation ?? [0, 0, 0]),
            new THREE.Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
            new THREE.Vector3().fromArray(node.scale ?? [1, 1, 1]));
    // ModelManager.processModel: the AABB over every LOD (all scenes, all drawables), maxSize from it.
    const aabb = new THREE.Box3();
    for (const scene of json.scenes) {
        for (const ni of scene.nodes ?? []) {
            const node = json.nodes[ni];
            if (node.mesh === undefined) continue;
            for (const prim of json.meshes[node.mesh].primitives) {
                const pos = accessor(prim.attributes.POSITION).array;
                const box = new THREE.Box3();
                for (let i = 0; i < pos.length; i += 3) box.expandByPoint(new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]));
                aabb.union(box.applyMatrix4(nodeMatrix(node)));
            }
        }
    }
    const meshes: THREE.Mesh[] = [];
    for (const ni of json.scenes[0].nodes ?? []) {
        const node = json.nodes[ni];
        if (node.mesh === undefined || node.extras?.time === 'night') continue; // daytime model
        const prims = json.meshes[node.mesh].primitives;
        if (prims.length !== 1 || (prims[0].mode ?? 4) !== 4) continue; // points and lines are not meshes
        const prim = prims[0];
        let geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(accessor(prim.attributes.POSITION).array, 3));
        if (prim.attributes.NORMAL !== undefined) {
            geo.setAttribute('normal', new THREE.BufferAttribute(accessor(prim.attributes.NORMAL).array, 3));
        }
        if (prim.indices !== undefined) {
            geo.setIndex(new THREE.BufferAttribute(accessor(prim.indices).array, 1));
        }
        // withFaceNormals: only for imports whose normals all point up.
        const normal = geo.getAttribute('normal');
        let allUp = !!normal;
        for (let i = 0; normal && i < normal.count && allUp; i++) {
            allUp = Math.abs(normal.getX(i)) < 1e-3 && normal.getY(i) > 0.999 && Math.abs(normal.getZ(i)) < 1e-3;
        }
        if (!normal || allUp) {
            geo = geo.index ? geo.toNonIndexed() : geo;
            geo.computeVertexNormals();
        }
        const material = new THREE.MeshBasicMaterial();
        material.name = json.materials?.[prim.material]?.name ?? '';
        const mesh = new THREE.Mesh(geo, material);
        mesh.name = node.name ?? '';
        mesh.matrix.copy(nodeMatrix(node));
        mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
        geo.computeBoundingBox();
        const world = geo.boundingBox!.clone().applyMatrix4(mesh.matrix);
        const isZero = (v: number) => Math.abs(v) < 1e-6;
        if (isZero(world.max.y || 0) && isZero(world.min.y || 0)) continue; // a flat
        geo.rotateY(0.0001); //! the loader's dithering hack
        meshes.push(mesh);
    }
    meshes.sort((a, b) => parseInt(a.name.charAt(0)) - parseInt(b.name.charAt(0)));
    return { meshes, maxSize: Math.max(...aabb.getSize(new THREE.Vector3()).toArray()) };
}

function glbSpec(file: string): ModelSpec {
    const { meshes, maxSize } = readGlb(file);
    return {
        maxSize,
        meshes: meshes.map(mesh => {
            mesh.updateMatrix();
            const g = mesh.geometry;
            return {
                name: mesh.name,
                material: (mesh.material as THREE.Material).name,
                trs: [...v3(mesh.position), ...q4(mesh.quaternion), ...v3(mesh.scale)],
                matrix: mesh.matrix.toArray(),
                positions: arr(g.getAttribute('position').array).map(f32),
                normals: g.getAttribute('normal') ? arr(g.getAttribute('normal').array).map(f32) : null,
                indices: g.index ? arr(g.index.array) : null,
            };
        }),
    };
}

function boxGeometry(b: BoxSpec): THREE.BufferGeometry {
    const g = new THREE.BoxGeometry(...b.args).toNonIndexed();
    if (b.translate) {
        g.translate(...b.translate);
    }
    return g;
}

/** FNV-1a over the float64 bytes of some doubles: catches any drift, to the last bit. */
const hashF64 = (a: number[]): string => {
    const f = Float64Array.from(a);
    return hex32(fnv1a32(new Uint8Array(f.buffer)));
};

const hashF32 = (a: ArrayLike<number>): string => {
    const f = a instanceof Float32Array ? a : Float32Array.from(a);
    return hex32(fnv1a32(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)));
};

const materials = new Map<string, THREE.Material>();
function material(name: string): THREE.Material {
    let m = materials.get(name);
    if (!m) {
        m = new THREE.MeshBasicMaterial();
        m.name = name;
        materials.set(name, m);
    }
    return m;
}

/** The three.js model a spec stands for (what the game's Model would hold). */
function buildModel(spec: ModelSpec): Model {
    const volumes: THREE.Object3D[] = [];
    for (const m of spec.meshes ?? []) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(m.positions), 3));
        if (m.normals) g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(m.normals), 3));
        if (m.indices) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.indices), 1));
        const mesh = new THREE.Mesh(g, material(m.material));
        mesh.position.fromArray(m.trs, 0);
        mesh.quaternion.fromArray(m.trs, 3);
        mesh.scale.fromArray(m.trs, 7);
        // collectMeshes recomposes mesh.matrix from these: the dumped matrix.
        mesh.updateMatrix();
        if (mesh.matrix.toArray().some((v, i) => v !== m.matrix[i])) {
            throw new Error(`matrix of ${m.name} does not match`);
        }
        volumes.push(mesh);
    }
    for (const b of spec.boxes ?? []) {
        const mesh = new THREE.Mesh(boxGeometry(b), material(b.material));
        mesh.position.set(...b.position);
        volumes.push(mesh);
    }
    return { lod: [{ flats: [], volumes }], animations: [], maxSize: spec.maxSize, center: new THREE.Vector3() };
}

/** What the C# side needs to rebuild a spec, and to check its BoxGeometry replica. */
function specJson(spec: ModelSpec): unknown {
    return {
        maxSize: spec.maxSize,
        meshes: spec.meshes,
        boxes: spec.boxes?.map(b => {
            const g = boxGeometry(b);
            return {
                ...b,
                hash: {
                    position: hashF32(g.getAttribute('position').array),
                    normal: hashF32(g.getAttribute('normal').array),
                    uv: hashF32(g.getAttribute('uv').array),
                },
            };
        }),
    };
}

const box = (material: string, args: BoxSpec['args'], translate: BoxSpec['translate'], position: BoxSpec['position'] = [0, 0, 0]): BoxSpec =>
    ({ material, args, translate, position });

function modelSpecs(): Record<string, ModelSpec> {
    return {
        f22: glbSpec('f22.glb'),
        f22_gear: glbSpec('f22_landinggear.glb'),
        f22_flaperon_left: glbSpec('f22_flaperon_left.glb'),
        f22_flaperon_right: glbSpec('f22_flaperon_right.glb'),
        f22_elevator_left: glbSpec('f22_elevator_left.glb'),
        f22_elevator_right: glbSpec('f22_elevator_right.glb'),
        f22_rudder_left: glbSpec('f22_rudder_left.glb'),
        f22_rudder_right: glbSpec('f22_rudder_right.glb'),
        // airframeDamage.test.ts jet(): fuselage z -7..7, front +Z, 14 m wing.
        jet: {
            maxSize: 14,
            boxes: [
                box('FUSELAGE', [2, 2, 14, 3, 3, 28], null),
                box('WING', [14, 0.3, 3, 14, 1, 3], [0, 0, 0.5]),
            ],
        },
        // wreckField.test.ts gearModel(): one gear part holding three legs.
        gear3: {
            maxSize: 6,
            boxes: [[0, 4], [2.5, -1], [-2.5, -1]].map(([x, z]) => box('GEAR', [0.4, 2, 0.4, 1, 4, 1], null, [x, 0, z])),
        },
        aileron: { maxSize: 3, boxes: [box('AILERON', [3, 0.2, 1, 2, 1, 2], null)] },
        strut: { maxSize: 0.5, boxes: [box('GEAR', [0.5, 1.5, 0.5, 2, 1, 2], null)] },
        // wreckField.test.ts denseAirframe().
        dense: {
            maxSize: 14,
            boxes: [
                box('FUSELAGE', [2, 2, 14, 4, 4, 12], null),
                box('WING', [14, 0.3, 3, 12, 1, 3], [0, 0, -1]),
            ],
        },
    };
}

// --- scenarios -----------------------------------------------------------------------

interface PartDef {
    model: string;
    kind: 'gear' | 'surface';
    id: number;
    /** Body-frame hinge pivot (gear: the body origin). */
    pivot: [number, number, number];
    axis: [number, number, number];
    deflection: number;
}

const F22_PARTS: PartDef[] = [
    { model: 'f22_gear', kind: 'gear', id: 0, pivot: [0, 0, 0], axis: [1, 0, 0], deflection: 0 },
    { model: 'f22_flaperon_left', kind: 'surface', id: 1, pivot: [4.5, -0.21, -3], axis: [1.681781, -0.152682, 0.57654], deflection: 0.08 },
    { model: 'f22_flaperon_right', kind: 'surface', id: 2, pivot: [-4.5, -0.21, -3], axis: [-1.681781, -0.152682, 0.57654], deflection: -0.08 },
    { model: 'f22_elevator_left', kind: 'surface', id: 3, pivot: [0, 0, -6], axis: [1, 0, 0], deflection: 0.05 },
    { model: 'f22_elevator_right', kind: 'surface', id: 4, pivot: [0, 0, -6], axis: [1, 0, 0], deflection: 0.05 },
    { model: 'f22_rudder_left', kind: 'surface', id: 5, pivot: [2.34, 1.8, -4.05], axis: [0.383502, 0.802989, 0.456217], deflection: 0.1 },
    { model: 'f22_rudder_right', kind: 'surface', id: 6, pivot: [-2.34, 1.8, -4.05], axis: [-0.383502, 0.802989, 0.456217], deflection: 0.1 },
];

const JET_PARTS: PartDef[] = [
    { model: 'gear3', kind: 'gear', id: 0, pivot: [0, -1.2, 0], axis: [1, 0, 0], deflection: 0 },
    { model: 'aileron', kind: 'surface', id: 1, pivot: [5, 0, -1], axis: [1, 0, 0], deflection: 0 },
    { model: 'aileron', kind: 'surface', id: 2, pivot: [-5, 0, -1], axis: [1, 0, 0], deflection: 0 },
    { model: 'aileron', kind: 'surface', id: 3, pivot: [0, 0.8, -6], axis: [1, 0, 0], deflection: 0.1 },
    { model: 'strut', kind: 'surface', id: 4, pivot: [0, -1, 3], axis: [0, 1, 0], deflection: 0 },
];

/** poseSurface at a body pose: the part's scene pose. */
function partPose(p: PartDef, pos: THREE.Vector3, q: THREE.Quaternion): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
    const hinge = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...p.axis).normalize(), p.deflection);
    return {
        position: new THREE.Vector3(...p.pivot).applyQuaternion(q).add(pos),
        quaternion: q.clone().multiply(hinge),
    };
}

interface SourceDef {
    body: string;
    parts: 'f22' | 'jet' | 'none';
    position: [number, number, number];
    /** Euler (pitch x, heading y, roll z), order 'YXZ'. */
    euler: [number, number, number];
    scale: number;
    velocity: [number, number, number];
    cockpit: [number, number, number] | null;
}

type Action =
    | { frame: number; op: 'spawn'; source: SourceDef; withDamage: boolean }
    | { frame: number; op: 'damage'; source: SourceDef; severity: number; hit: [number, number, number] }
    | { frame: number; op: 'rebase'; rotation: [number, number, number, number]; offset: [number, number, number] };

interface Scenario {
    name: string;
    seed: number;
    frames: number;
    sampleEvery: number;
    /** 'slope' | 'flat' | 'seabed' | 'deck' | 'coast'. */
    world: string;
    actions: Action[];
}

const f22 = (position: [number, number, number], euler: [number, number, number], velocity: [number, number, number]): SourceDef =>
    ({ body: 'f22', parts: 'f22', position, euler, scale: 1, velocity, cockpit: [0, 1.0, 8.0] });

/** A velocity of `speed` along the nose after the euler turn, plus `down` m/s straight down. */
function along(euler: [number, number, number], speed: number, down: number, side = 0): [number, number, number] {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(euler[0], euler[1], euler[2], 'YXZ'));
    const v = new THREE.Vector3(side, 0, speed).applyQuaternion(q);
    return [v.x, v.y - down, v.z];
}

const SHALLOW: [number, number, number] = [0.08, 0.6, -0.2];
const STEEP: [number, number, number] = [1.0, -1.9, 0.4];
const DITCH: [number, number, number] = [0.05, 2.4, 0.1];
const DECK: [number, number, number] = [0.06, Math.PI, 0.25];
const LIVE: [number, number, number] = [-0.05, 0.3, 0.15];
const LIVE2: [number, number, number] = [0.02, 0.32, -0.3];
const AIR: [number, number, number] = [-0.4, -0.7, 1.2];
const JET: [number, number, number] = [0.1, 1.2, 0.05];

/** Ground height of each world (also what the C# test implements). */
function groundOf(world: string, deck: { z: number }): (x: number, z: number) => number {
    switch (world) {
        case 'slope': return (x, z) => 3 + 0.02 * x - 0.015 * z + 1.5 * Math.sin(x * 0.013) * Math.cos(z * 0.011);
        case 'seabed': return () => -30;
        case 'deck': return (x, z) => (Math.abs(x) < 15 && Math.abs(z - deck.z) < 140 ? 18 : -25);
        case 'coast': return (x, z) => (x > 60 ? -20 : 0.5 + 0.01 * z);
        default: return () => 0;
    }
}

const DECK_VZ = -12;

const SCENARIOS: Scenario[] = [
    {
        name: 'f22_shallow_fast_slope', seed: 101, frames: 420, sampleEvery: 60, world: 'slope',
        actions: [{ frame: 0, op: 'spawn', withDamage: false, source: f22([30, 5.2, -20], SHALLOW, along(SHALLOW, 150, 14)) }],
    },
    {
        name: 'f22_steep_dive', seed: 202, frames: 420, sampleEvery: 60, world: 'flat',
        actions: [{ frame: 0, op: 'spawn', withDamage: false, source: f22([0, 4, 0], STEEP, along(STEEP, 175, 0, 12)) }],
    },
    {
        name: 'f22_ditch_sea', seed: 303, frames: 1500, sampleEvery: 60, world: 'seabed',
        actions: [{ frame: 0, op: 'spawn', withDamage: false, source: f22([500, 2.5, 800], DITCH, along(DITCH, 110, 32)) }],
    },
    {
        name: 'f22_carrier_deck', seed: 404, frames: 600, sampleEvery: 60, world: 'deck',
        actions: [{ frame: 0, op: 'spawn', withDamage: false, source: f22([2, 20.5, 115], DECK, along(DECK, 35, 32, 4).map((v, i) => v + (i === 2 ? DECK_VZ : 0)) as [number, number, number]) }],
    },
    {
        name: 'f22_damage_then_crash', seed: 505, frames: 520, sampleEvery: 60, world: 'flat',
        actions: [
            { frame: 0, op: 'damage', severity: 0.45, hit: [0.5, 0, -1], source: f22([0, 1.5, 0], LIVE, along(LIVE, 80, 6)) },
            { frame: 20, op: 'damage', severity: 0.55, hit: [24, 0, 12], source: f22([24, 1.4, 12], LIVE, along(LIVE, 78, 3)) },
            { frame: 120, op: 'damage', severity: 0.7, hit: [-3, 0, 133], source: f22([-2, 1.6, 130], LIVE2, along(LIVE2, 70, 7, 10)) },
            { frame: 240, op: 'damage', severity: 0.95, hit: [10, 0, 250], source: f22([8, 1.3, 250], LIVE2, along(LIVE2, 65, 8, -12)) },
            { frame: 300, op: 'spawn', withDamage: true, source: f22([12, 1.6, 300], LIVE2, along(LIVE2, 60, 12)) },
            { frame: 380, op: 'rebase', rotation: [0.004, -0.007, 0.002, 0.99996450], offset: [-150, 2.5, 220] },
        ],
    },
    {
        name: 'f22_midair_breakup', seed: 606, frames: 480, sampleEvery: 60, world: 'slope',
        actions: [{ frame: 0, op: 'spawn', withDamage: false, source: f22([-200, 140, 50], AIR, along(AIR, 210, 30)) }],
    },
    {
        name: 'jet_gear_coast_scaled', seed: 707, frames: 480, sampleEvery: 60, world: 'coast',
        actions: [
            { frame: 0, op: 'damage', severity: 0.8, hit: [20, 0.5, 30], source: { body: 'jet', parts: 'jet', position: [20, 2.2, 30], euler: JET, scale: 1.25, velocity: along(JET, 60, 10, 8), cockpit: [0, 0.8, 5.5] } },
            { frame: 30, op: 'spawn', withDamage: true, source: { body: 'jet', parts: 'jet', position: [45, 2.3, 40], euler: JET, scale: 1.25, velocity: along(JET, 75, 30, 6), cockpit: [0, 0.8, 5.5] } },
        ],
    },
    {
        name: 'dense_shards', seed: 808, frames: 300, sampleEvery: 60, world: 'flat',
        actions: [{ frame: 0, op: 'spawn', withDamage: false, source: { body: 'dense', parts: 'none', position: [0, 1.2, 0], euler: [0, 0, 0], scale: 1, velocity: [0, -90, 140], cockpit: [0, 0.8, 5] } }],
    },
];

// --- recording -------------------------------------------------------------------------

function runScenario(sc: Scenario, models: Record<string, Model>): unknown {
    const rng = new Rng(sc.seed);
    const uuids = new Rng(sc.seed ^ 0x5eed);
    let draws = 0;
    const saved = Math.random;
    Math.random = () => {
        if ((new Error().stack?.split('\n')[2] ?? '').includes('generateUUID')) {
            return uuids.next();
        }
        draws++;
        return rng.next();
    };
    try {
        const deck = { z: 0 };
        const field = new WreckField();
        const f = field as Any;
        const ground = groundOf(sc.world, deck);
        field.setGroundHeightAt(ground);
        if (sc.world === 'seabed') {
            field.setWaterTest(() => true, () => 0);
        } else if (sc.world === 'coast') {
            field.setWaterTest((x) => x > 60, () => 0);
        } else if (sc.world === 'deck') {
            const onDeck = (x: number, z: number) => Math.abs(x) < 15 && Math.abs(z - deck.z) < 140;
            field.setWaterTest((x, z) => !onDeck(x, z), () => 0);
            field.setMovingSurface({
                velocity: new THREE.Vector3(0, 0, DECK_VZ),
                contains: (x, y, z) => onDeck(x, z) && y < 24 && y > 15,
            });
        }

        // Fragment ids: the next number to each piece first seen in the list (scanned in list order).
        const ids = new Map<object, number>();
        const pieces: unknown[] = [];
        const scan = (): void => {
            for (const frag of f.fragments as Any[]) {
                if (ids.has(frag)) continue;
                const id = ids.size;
                ids.set(frag, id);
                pieces.push({
                    id,
                    centre: v3(frag.centre), half: v3(frag.half), originLocal: v3(frag.originLocal),
                    tough: frag.tough, depth: frag.depth, serial: frag.serial,
                    gyration2: frag.gyration2, trailWidth: frag.trailWidth, bobPhase: frag.bobPhase,
                    velocity: v3(frag.velocity), spin: v3(frag.spin),
                    // [material, vertices, position hash, normal hash, uv hash]
                    meshes: (frag.obj.children as THREE.Mesh[]).map(mesh => {
                        const g = mesh.geometry;
                        const pos = g.getAttribute('position');
                        return [
                            (mesh.material as THREE.Material).name,
                            pos ? pos.count : 0,
                            pos ? hashF32(pos.array) : null,
                            g.getAttribute('normal') ? hashF32(g.getAttribute('normal').array) : null,
                            g.getAttribute('uv') ? hashF32(g.getAttribute('uv').array) : null,
                        ];
                    }),
                    // A few whole pieces, to look at when a hash differs.
                    dump: id % 7 === 3 ? (frag.obj.children as THREE.Mesh[]).slice(0, 1).map(m => arr(m.geometry.getAttribute('position').array).slice(0, 90)) : undefined,
                });
            }
        };
        const fireRec = (fire: Any): unknown[] => [fire.kind, ids.get(fire.fragment) ?? -1, ...v3(fire.local)];

        let frame = 0;
        const events: unknown[] = [];
        // The first FULL_EVENTS small events in full, the rest as a hash of their numbers.
        const small = (type: string, v: number[]): void => {
            events.push(events.length < FULL_EVENTS ? [frame, type, ...v] : [frame, type, hashF64(v)]);
        };
        field.onBreakup = (e) => {
            scan();
            events.push({ frame, type: 'breakup', id: e.id, position: v3(e.position), velocity: v3(e.velocity), normal: v3(e.normal), severity: e.severity, water: e.water, fires: e.fires.map(fireRec) });
        };
        field.onMark = (p, n, dx, dz, length, width, strength) => small('mark', [...v3(p), ...v3(n), dx, dz, length, width, strength]);
        field.onBurn = (p, life, intensity) => small('burn', [...v3(p), life, intensity]);
        field.onSplit = (p, v, strength) => small('split', [...v3(p), ...v3(v), strength]);
        field.onDust = (p, v, count, strength) => small('dust', [...v3(p), ...v3(v), count, strength]);
        field.onSplash = (p, v, strength) => small('splash', [...v3(p), ...v3(v), strength]);
        field.onFoam = (p, radius, count) => small('foam', [...v3(p), radius, count]);
        field.onDamage = (e) => { events.push({ frame, type: 'damage', id: e.id, severity: e.severity, fires: e.fires.map(x => [x.kind, ...v3(x.local)]) }); };

        const damage = new AirframeDamage();
        const actionsOut: unknown[] = [];
        const makeSource = (s: SourceDef): { src: WreckSource; parts: { def: PartDef; position: THREE.Vector3; quaternion: THREE.Quaternion }[] } => {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(s.euler[0], s.euler[1], s.euler[2], 'YXZ'));
            const pos = new THREE.Vector3(...s.position);
            const defs = s.parts === 'f22' ? F22_PARTS : s.parts === 'jet' ? JET_PARTS : [];
            const parts = defs.map(def => ({ def, ...partPose(def, pos, q) }));
            const wreckParts: WreckPart[] = parts.map(p => ({ model: models[p.def.model], kind: p.def.kind, id: p.def.id, position: p.position.clone(), quaternion: p.quaternion.clone() }));
            return {
                parts,
                src: {
                    id: 'p', body: models[s.body], position: pos, quaternion: q, scale: new THREE.Vector3(s.scale, s.scale, s.scale),
                    velocity: new THREE.Vector3(...s.velocity), parts: wreckParts,
                    cockpit: s.cockpit ? new THREE.Vector3(...s.cockpit) : undefined,
                },
            };
        };
        const sourceJson = (src: WreckSource, parts: { def: PartDef }[]) => ({
            body: Object.entries(models).find(([, m]) => m === src.body)![0],
            position: v3(src.position), quaternion: q4(src.quaternion), scale: v3(src.scale), velocity: v3(src.velocity),
            cockpit: src.cockpit ? v3(src.cockpit) : null,
            parts: src.parts.map((p, i) => ({ model: parts[i].def.model, kind: p.kind, id: p.id, position: v3(p.position), quaternion: q4(p.quaternion) })),
        });
        const damageState = () => ({
            severity: damage.severity,
            active: damage.active,
            rippedCells: [...damage.rippedCells].sort((a, b) => a - b),
            rippedParts: [...damage.rippedParts].sort((a, b) => a - b),
            joints: damage.joints.map(j => [j.yaw, j.pitch, j.shift]),
            wingFold: [...damage.wingFold.entries()].sort((a, b) => a[0] - b[0]),
            partBends: [...damage.partBends.entries()].sort((a, b) => a[0] - b[0]).map(([id, b]) => ({ id, m: b.m, q: b.q })),
            rootParts: [...damage.rootParts].sort((a, b) => a - b),
            gearInRoot: damage.gearInRoot,
            fireSites: [...damage.fireSites].sort((a, b) => a - b),
            lastBlowAt: damage.lastBlowAt,
            root: damage.root ? (damage.root.children as THREE.Mesh[]).map(mesh => ({
                material: (mesh.material as THREE.Material).name,
                vertices: mesh.geometry.getAttribute('position').count,
                position: hashF32(mesh.geometry.getAttribute('position').array),
                normal: mesh.geometry.getAttribute('normal') ? hashF32(mesh.geometry.getAttribute('normal').array) : null,
            })) : null,
        });
        const lastHooks = () => ({
            dislocation: field.lastDislocationM, kink: field.lastKinkRad, bend: field.lastBendRad, bendUp: field.lastBendUpRad,
            totalBend: field.lastTotalBendRad, scraps: field.lastScrapTriangles,
            bentCells: [...(f.lastBentCells as Set<number>)], brokenCells: [...(f.lastBrokenCells as Set<number>)],
        });

        const frames: unknown[] = [];
        const samples: unknown[] = [];
        for (frame = 0; frame < sc.frames; frame++) {
            for (const action of sc.actions.filter(a => a.frame === frame)) {
                if (action.op === 'rebase') {
                    const shift = new FrameShift(new THREE.Quaternion(...action.rotation).normalize(), new THREE.Vector3(...action.offset));
                    field.rebase(shift);
                    actionsOut.push({ frame, op: 'rebase', rotation: q4(shift.rotation), offset: v3(shift.offset) });
                    continue;
                }
                const { src, parts } = makeSource(action.source);
                if (action.op === 'damage') {
                    const hit = new THREE.Vector3(...action.hit);
                    const changed = field.applyDamage(src, damage, action.severity, hit);
                    scan();
                    // Parts carried by the bend: each at its undamaged pose, then transformPart.
                    const carried = parts.map(p => {
                        const position = p.position.clone();
                        const quaternion = p.quaternion.clone();
                        damage.transformPart(p.def.id, position, quaternion, src.position, src.quaternion, src.scale);
                        return { id: p.def.id, position: v3(position), quaternion: q4(quaternion) };
                    });
                    actionsOut.push({
                        frame, op: 'damage', severity: action.severity, hit: v3(hit), source: sourceJson(src, parts),
                        changed, draws, hooks: lastHooks(), state: damageState(), carried,
                    });
                } else {
                    if (action.withDamage && damage.active) {
                        src.damage = damage;
                    }
                    const ok = field.spawn(src);
                    scan();
                    actionsOut.push({ frame, op: 'spawn', withDamage: src.damage !== undefined, source: sourceJson(src, parts), ok, draws, hooks: lastHooks() });
                }
            }
            if (sc.world === 'deck') {
                deck.z += DECK_VZ * DT;
            }
            field.update(DT);
            scan();
            const list = f.fragments as Any[];
            // Every frame: the counts, the draws so far, and a hash of every piece's pose and motion.
            frames.push([list.length, list.filter(x => x.asleep).length, list.filter(x => x.wet).length, draws,
                hashF64(list.flatMap(x => [...v3(x.obj.position), ...q4(x.obj.quaternion), ...v3(x.velocity), ...v3(x.spin)]))]);
            if (frame % sc.sampleEvery === 0 || frame === sc.frames - 1) {
                const pos = new THREE.Vector3();
                const quat = new THREE.Quaternion();
                const eye = new THREE.Vector3();
                const hasPose = field.cockpitBodyPose('p', pos, quat);
                const hasEye = field.cockpitWorld('p', eye);
                samples.push({
                    frame,
                    pieces: list.map(x => [ids.get(x), ...v3(x.obj.position), ...q4(x.obj.quaternion), x.asleep ? 1 : 0, x.obj.visible ? 1 : 0, x.submerged ? 1 : 0]),
                    cockpit: hasPose ? [...v3(pos), ...q4(quat), ...v3(eye)] : hasEye ? [...v3(eye)] : null,
                    fires: (f.fires as Any[]).map(fire => {
                        const at = new THREE.Vector3();
                        const live = field.fireWorld(fire, at);
                        return [...fireRec(fire), live ? 1 : 0, ...(live ? v3(at) : [])];
                    }),
                });
            }
        }
        return { name: sc.name, seed: sc.seed, frames: sc.frames, world: sc.world, actions: actionsOut, pieces, perFrame: frames, samples, events };
    } finally {
        Math.random = saved;
    }
}

/** Math.exp samples (the field ports V8's fdlibm exp). */
function expSamples(): number[][] {
    const rng = new Rng(99);
    const out: number[][] = [];
    for (const x of [-6 / 120, -3 / 120, -6 / 60, -0.1, 0, -1e-9, 1, -1, 0.7, -0.35, 5, -20, 700, -745.2, 1e-300]) {
        out.push([x, Math.exp(x)]);
    }
    for (let i = 0; i < 40; i++) {
        const x = (rng.next() - 0.5) * 30;
        out.push([x, Math.exp(x)]);
    }
    return out;
}

/** Array.prototype.sort on the gear legs' fuzzy comparator, over random point sets. */
function sortSamples(): number[][][] {
    const rng = new Rng(4242);
    const out: number[][][] = [];
    for (let n = 2; n < 12; n++) {
        for (let k = 0; k < 4; k++) {
            const pts = Array.from({ length: n }, () => [Math.round(rng.range(-3, 3) * 40) / 40, rng.range(-5, 5)]);
            const sorted = pts.slice().sort((a, b) => (Math.abs(a[0] - b[0]) > 0.05 ? a[0] - b[0] : a[1] - b[1]));
            out.push([pts.flat(), sorted.flat()]);
        }
    }
    return out;
}

export function wreckSuite(): SuiteOutput {
    const specs = modelSpecs();
    const models: Record<string, Model> = {};
    for (const [name, spec] of Object.entries(specs)) {
        models[name] = buildModel(spec);
    }
    const scenarios = SCENARIOS.map(sc => runScenario(sc, models));
    const modelsJson: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(specs)) {
        modelsJson[name] = specJson(spec);
    }
    return {
        files: [{
            file: 'wreck.json',
            data: {
                suite: 'wreck',
                version: 1,
                source: [
                    'src/script/scene/entities/wreckField.ts',
                    'src/script/scene/entities/airframeDamage.ts',
                ],
                notes: 'Models: F-22 glb meshes after the loader steps (matrix = mesh.matrix, float32 positions/normals, '
                    + 'Uint16 indices, material = glTF material name); procedural ones are BoxGeometry(args).toNonIndexed() '
                    + '[.translate()] at `position`, with hashes of the TS geometry. Scenarios run at 1/60 s with '
                    + 'Math.random = mulberry32(seed) (three generateUUID on a separate stream); `draws` counts wreck draws. '
                    + 'Worlds: slope h = 3 + 0.02x - 0.015z + 1.5 sin(0.013x) cos(0.011z); flat 0; seabed -30 with water '
                    + 'everywhere (surface 0); deck: 18 inside |x|<15, |z-deckZ|<140 else -25 (sea, surface 0), deckZ moves '
                    + '-12 m/s (advanced before each update), moving surface contains = on deck and 15<y<24; coast: water '
                    + 'x>60 (surface 0, ground -20), else 0.5 + 0.01z. Each frame: actions, deck move, update(1/60), scan. '
                    + 'Fragment ids: next number to each piece first seen when the list is scanned in order (after every '
                    + 'action and update, and inside onBreakup). perFrame = [count, asleep, wet, draws, FNV-1a over the float64 bytes of every '
                    + 'piece pos3 quat4 vel3 spin3 in list order]. Sample piece row: [id, pos3, quat4, asleep, visible, submerged]. '
                    + 'Events: breakup/damage as objects; the others as [frame, type, numbers...] for the first 40 events, later as [frame, type, FNV-1a over the float64 bytes of the numbers]. Fire row: [kind, fragId, local3, live, world3?]. '
                    + 'Mesh hashes: FNV-1a over the float32 attribute bytes.',
                tolerances: { float32: 'exact', doubles: 1e-9 },
                models: modelsJson,
                exp: expSamples(),
                sort: sortSamples(),
                scenarios,
            },
        }],
    };
}
