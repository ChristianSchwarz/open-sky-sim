/**
 * Aircraft exterior FX (workstream J, aircraft part): the CPU side of
 * AircraftFx - afterburner plumes (when they show, their AB1/AB2 cone
 * geometry, placement at the symmetrised nozzles) and wingtip trails (sample
 * history, spacing by speed, the camera-facing segment instances with their
 * per-segment dither levels, swing-wing tips, re-base, reset, def swaps,
 * tips derived from the body model's vertices).
 *
 * Scripted timelines drive the real AircraftFx with a stub material manager
 * (the materials only carry colour uniforms on the CPU). Defs come from
 * tests/golden/aircraft.json, so the suite needs no mod packs. Instance
 * arrays are float32: per frame the drawn prefix is hashed (FNV-1a over the
 * bytes), and every DUMP_EVERY-th frame it is dumped whole.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { AircraftFx } from '../../../src/script/scene/entities/aircraftFx';
import { FlyableAircraftDef } from '../../../src/script/scene/entities/aircraftDef';
import { deriveWingtipOriginsFromModel } from '../../../src/script/scene/entities/wingtipOrigins';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { Model } from '../../../src/script/scene/models/models';
import { FrameShift } from '../../../src/script/terrain/geodesy';
import { arr, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

const DT = 1 / 60;
const DUMP_EVERY = 100;

/** Only what AfterburnerCones and WingtipTrails touch: colour uniforms. */
function stubMaterials(): SceneMaterialManager {
    return {
        build: () => new THREE.ShaderMaterial({
            uniforms: {
                color: { value: new THREE.Color() },
                colorSecondary: { value: new THREE.Color() },
            },
        }),
    } as unknown as SceneMaterialManager;
}

/** A body model whose LOD0 is one mesh with these float32 positions. */
function fakeModel(positions: Float32Array): Model {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(g);
    return { lod: [{ volumes: [mesh], flats: [] }] } as unknown as Model;
}

/** A rough jet planform: fuselage plus two wings out to +-span/2, seeded. */
function planformVertices(rng: Rng, span: number, count: number): Float32Array {
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const wing = rng.next() < 0.6;
        const x = wing ? rng.range(-span / 2, span / 2) : rng.range(-0.8, 0.8);
        out[i * 3] = x;
        out[i * 3 + 1] = rng.range(-0.6, 0.9);
        out[i * 3 + 2] = wing ? rng.range(-4, 1) - Math.abs(x) * 0.4 : rng.range(-7, 8);
    }
    return out;
}

interface JsonDef {
    id: string; name: string; body: string; shadow: string; cockpitOffset: [number, number, number];
    wingtips: [number, number, number][] | null; nozzles: [number, number, number][] | null;
    nozzleRadius: number | null; swingWings: { minKias: number; maxKias: number; travelSeconds: number } | null;
    surfaces: { role: string; model: string; pivot: [number, number, number]; axis: [number, number, number];
        control: string; sign: number; rangeRad: number; sweepParent: string | null }[];
}

function toDef(d: JsonDef): FlyableAircraftDef {
    return {
        id: d.id, name: d.name, body: d.body, shadow: d.shadow, cockpitOffset: d.cockpitOffset,
        surfaces: d.surfaces.map(s => ({ ...s, sweepParent: s.sweepParent ?? undefined })),
        swingWings: d.swingWings ?? undefined,
        fx: d.wingtips || d.nozzles || d.nozzleRadius !== null
            ? { wingtips: d.wingtips ?? undefined, nozzles: d.nozzles ?? undefined, nozzleRadius: d.nozzleRadius ?? undefined }
            : undefined,
    } as unknown as FlyableAircraftDef;
}

/** One scripted frame's inputs. `camera` may be computed from the trail itself (see degenerate). */
interface FrameIn {
    lever: number;
    ab: boolean;
    sweep: number;
    pos: THREE.Vector3;
    quat: THREE.Quaternion;
    vel: THREE.Vector3;
    camera: THREE.Vector3;
    /** fx.update calls this frame (the player calls it from the sim and again from render). */
    updates: number;
    event?: Event;
}

type Event =
    | { kind: 'reset' }
    | { kind: 'configure'; def: string }
    | { kind: 'bindModel'; model: string }
    | { kind: 'rebase'; rotation: number[]; offset: number[] };

interface Flight {
    heading: number; pitch: number; roll: number; speed: number;
    pos: THREE.Vector3;
}

function pose(f: Flight): { quat: THREE.Quaternion; vel: THREE.Vector3 } {
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(f.pitch, f.heading, f.roll, 'YXZ'));
    const vel = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).multiplyScalar(f.speed);
    return { quat, vel };
}

function chase(pos: THREE.Vector3, quat: THREE.Quaternion, back: number, up: number): THREE.Vector3 {
    return new THREE.Vector3(0, up, -back).applyQuaternion(quat).add(pos);
}

interface Scenario {
    name: string;
    initialDef: string;
    frames: number;
    /** Steer the flight and pick the inputs for frame i (before the step). */
    script: (i: number, f: Flight, fx: AircraftFx) => Omit<FrameIn, 'pos' | 'quat' | 'vel' | 'camera'> & { camera?: THREE.Vector3 };
    start: Flight;
}

const round = (v: number, k: number) => Math.round(v * k) / k;
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function trailHistoryMid(fx: AircraftFx, side: 'left' | 'right', age: number): THREE.Vector3 {
    const s = (fx as Any).wingtipTrails[side];
    const at = (a: number) => s.history[(s.head - 1 - a + 51 * 2) % 51] as THREE.Vector3;
    return new THREE.Vector3().addVectors(at(age), at(age - 1)).multiplyScalar(0.5);
}

const SCENARIOS: Scenario[] = [
    {
        // Built-in F-22: no fx in the def, tips from the body model once it "loads";
        // the FM's AB detents gate the plume; throttle ramps through MIL, AB1, AB2.
        name: 'f22_model_tips_turn',
        initialDef: 'f22',
        frames: 220,
        start: { heading: 0.3, pitch: 0.05, roll: 0, speed: 250, pos: new THREE.Vector3(120, 2500, -340) },
        script: (i, f) => {
            f.roll = lerp(0, 1.1, i / 90);
            f.heading += 0.35 * DT * Math.min(1, i / 90);
            const lever = i < 160 ? lerp(0.95, 1.0, i / 100) : i < 190 ? 0.995 : 0.5;
            return {
                lever, ab: true, sweep: 0, updates: i % 3 === 0 ? 2 : 1,
                event: i === 6 ? { kind: 'bindModel', model: 'f22' } : undefined,
            };
        },
    },
    {
        // Su-33 pack: nozzles in the def light the plume without AB detents; a
        // standing start (no new samples while still), then a hard pull, a reset.
        name: 'su33_standing_start_pull',
        initialDef: 'su_33',
        frames: 200,
        start: { heading: -2.0, pitch: 0, roll: 0, speed: 0, pos: new THREE.Vector3(-5000, 30, 8000) },
        script: (i, f) => {
            f.speed = i < 20 ? 0 : lerp(0, 320, (i - 20) / 60);
            if (i > 90) {
                f.pitch += 0.6 * DT;
                f.roll = lerp(0, -0.4, (i - 90) / 60);
            }
            return {
                lever: i < 160 ? 1 : 0.992, ab: false, sweep: 0, updates: 1,
                event: i === 140 ? { kind: 'reset' } : undefined,
            };
        },
    },
    {
        // F-14 pack: swing wings carry the tips (sweep 0 -> 1 -> 0.3), asymmetric
        // nozzles symmetrised, a mid-flight re-base, AB1 then AB2.
        name: 'f14_sweep_rebase',
        initialDef: 'f_14a',
        frames: 200,
        start: { heading: 1.2, pitch: -0.05, roll: 0.2, speed: 180, pos: new THREE.Vector3(18000, 6000, -22000) },
        script: (i, f) => {
            f.speed = lerp(180, 270, i / 200);
            f.heading -= 0.2 * DT;
            const sweep = i < 110 ? lerp(0, 1, i / 100) : lerp(1, 0.3, (i - 110) / 60);
            const s = Math.sin(0.01);
            return {
                lever: i < 80 ? 0.993 : 1, ab: false, sweep, updates: 1,
                event: i === 80
                    ? { kind: 'rebase', rotation: [0.3 * s, 0.9 * s, -0.2 * s, Math.cos(0.01)].map((v, k, a) => v / Math.hypot(...a)), offset: [-20000, 3.5, 15000] }
                    : undefined,
            };
        },
    },
    {
        // Mirage (single nozzle, no symmetrise), swapped to the E-3 (wide tips,
        // far nozzles), then to the F-22 (no tips, default nozzles, no plume without
        // detents) whose model tips bind later.
        name: 'mirage_e3_f22_swaps',
        initialDef: 'mirage',
        frames: 220,
        start: { heading: 3.0, pitch: 0.1, roll: -0.3, speed: 140, pos: new THREE.Vector3(0, 900, 0) },
        script: (i, f) => {
            f.heading += 0.1 * DT;
            f.speed = i < 100 ? 140 : 110;
            let event: Event | undefined;
            if (i === 80) event = { kind: 'configure', def: 'e3' };
            if (i === 140) event = { kind: 'configure', def: 'f22' };
            if (i === 180) event = { kind: 'bindModel', model: 'f22' };
            return { lever: 1, ab: false, sweep: 0, updates: 1, event };
        },
    },
    {
        // Straight and level due south (identity attitude): samples on exact
        // lines. Cameras on a segment midpoint (zero view vector) and on the
        // trail's own line (right vector falls back to dir x UP).
        name: 'degenerate_cameras',
        initialDef: 'su_33',
        frames: 120,
        start: { heading: 0, pitch: 0, roll: 0, speed: 60, pos: new THREE.Vector3(10, 400, 20) },
        script: (i, f, fx) => {
            let camera: THREE.Vector3 | undefined;
            if (i >= 40 && i < 60) camera = trailHistoryMid(fx, 'left', 3);
            if (i >= 60 && i < 80) {
                const tip = (fx as Any).wingtipTrails._leftTip as THREE.Vector3;
                camera = new THREE.Vector3(tip.x, tip.y, tip.z - 300);
            }
            if (i >= 80 && i < 90) camera = trailHistoryMid(fx, 'right', 1);
            return { lever: i < 60 ? 0.5 : 1, ab: false, sweep: 0, updates: 1, camera };
        },
    },
];

function hashF32(a: Float32Array, n: number): string {
    const v = a.subarray(0, n);
    return hex32(fnv1a32(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
}

export function aircraftFxSuite(ctx: SuiteContext): SuiteOutput {
    const aircraft = JSON.parse(fs.readFileSync(path.join(ctx.goldenRoot, 'aircraft.json'), 'utf8')) as {
        f22: JsonDef; packs: { id: string; def: JsonDef }[];
    };
    const defs = new Map<string, { id: string; def: FlyableAircraftDef }>();
    defs.set('f22', { id: 'f22', def: toDef(aircraft.f22) });
    for (const [key, frag] of [['su_33', 'su_33_su_33'], ['f_14a', 'f_14a_f_14a'], ['e3', 'e3_sentry'], ['mirage', 'mirage_2000']]) {
        const p = aircraft.packs.find(x => x.id.includes(frag));
        if (!p) throw new Error(`aircraftFx suite: no pack ${frag} in aircraft.json`);
        defs.set(key, { id: p.id, def: toDef(p.def) });
    }

    const models = new Map<string, Float32Array>();
    models.set('f22', planformVertices(new Rng(0xF22), 13.56, 400));

    const geometries = new Map<string, number[]>();
    const geoHash = (mesh: THREE.Mesh): string => {
        const a = mesh.geometry.getAttribute('position').array as Float32Array;
        const h = hashF32(a, a.length);
        if (!geometries.has(h)) geometries.set(h, arr(a));
        return h;
    };

    const scenarios = SCENARIOS.map(sc => {
        const fx = new AircraftFx(stubMaterials());
        let sweep = 0;
        fx.setWingSweepSource(() => sweep);
        fx.configureFromDef(defs.get(sc.initialDef)!.def);
        const f: Flight = { ...sc.start, pos: sc.start.pos.clone() };
        const lists = new Map<string, THREE.Scene>([['EntityVolumes', new THREE.Scene()], ['EntityFX', new THREE.Scene()]]);
        const frames: unknown[] = [];
        for (let i = 0; i < sc.frames; i++) {
            const s = sc.script(i, f, fx);
            const posed = pose(f);
            f.pos.addScaledVector(posed.vel, DT);
            // Inputs are rounded (shorter fixture); the oracle runs on the rounded values.
            const quat = new THREE.Quaternion().fromArray(posed.quat.toArray().map(v => round(v, 1e9)));
            const vel = new THREE.Vector3().fromArray(posed.vel.toArray().map(v => round(v, 1e4)));
            const pos = new THREE.Vector3().fromArray(f.pos.toArray().map(v => round(v, 1e4)));
            const camera = s.camera ?? new THREE.Vector3().fromArray(chase(pos, quat, 28 + 10 * Math.sin(i * 0.05), 6).toArray().map(v => round(v, 1e4)));
            sweep = s.sweep;

            let event: unknown;
            if (s.event) {
                const e = s.event;
                if (e.kind === 'reset') {
                    fx.resetTrails();
                    event = { kind: 'reset' };
                } else if (e.kind === 'configure') {
                    fx.configureFromDef(defs.get(e.def)!.def);
                    event = { kind: 'configure', def: defs.get(e.def)!.id };
                } else if (e.kind === 'bindModel') {
                    fx.ensureBound(fakeModel(models.get(e.model)!));
                    event = { kind: 'bindModel', model: e.model };
                } else {
                    fx.rebase(new FrameShift(new THREE.Quaternion().fromArray(e.rotation), new THREE.Vector3().fromArray(e.offset)));
                    event = { kind: 'rebase', rotation: e.rotation, offset: e.offset };
                }
            }
            for (let u = 0; u < s.updates; u++) {
                fx.update(s.lever, s.ab, pos, quat, vel);
            }
            const cam = new THREE.PerspectiveCamera();
            cam.position.copy(camera);
            fx.addAfterburnerToRenderList(lists);
            fx.addTrailsToRenderList(lists, cam);

            const dump = i % DUMP_EVERY === DUMP_EVERY - 1;
            const cones = (fx as Any).afterburnerCones;
            const roots = cones.plumeRoots as THREE.Object3D[];
            const plumeWorld = roots.map(r => {
                r.updateMatrixWorld(true);
                return arr(r.children[0].getWorldPosition(new THREE.Vector3()));
            });
            const trails = (fx as Any).wingtipTrails;
            /** [count, visible, samples, matrices hash, levels hash]. */
            const side = (name: 'left' | 'right') => {
                const t = trails[name];
                const n = t.mesh.count as number;
                return [n, t.root.visible as boolean, t.count as number,
                    hashF32(t.mesh.instanceMatrix.array as Float32Array, n * 16), hashF32(t.levels.array as Float32Array, n)];
            };
            const full = (name: 'left' | 'right') => {
                const t = trails[name];
                const n = t.mesh.count as number;
                return {
                    matrices: arr((t.mesh.instanceMatrix.array as Float32Array).subarray(0, n * 16)),
                    levels: arr((t.levels.array as Float32Array).subarray(0, n)),
                };
            };
            const ready = (fx as Any).wingtipsReady as boolean;
            const visible = roots[0].visible;
            frames.push({
                in: [s.lever, s.ab, s.sweep, s.updates],
                pos: arr(pos.toArray()), quat: quat.toArray(), vel: arr(vel.toArray()), cam: arr(camera.toArray()),
                event: event ?? undefined,
                // [visible, zone, inner, outer, dish geometry hashes, colour r, g, b]; hidden
                // plumes keep stale poses nobody draws, so only visibility and stage then.
                cones: visible
                    ? [true, cones.lastZone, geoHash(cones.plumeMeshes[0]), geoHash(cones.outerPlumeMeshes[0]),
                        geoHash(cones.dishMeshes[0]), ...(cones.plumeMaterial.uniforms.color.value as THREE.Color).toArray()]
                    : [false, cones.lastZone],
                roots: visible ? roots.map(r => arr(r.position.toArray())) : undefined,
                rootQuat: visible ? roots[0].quaternion.toArray() : undefined,
                plumes: visible && dump ? plumeWorld : undefined,
                left: ready ? side('left') : undefined,
                right: ready ? side('right') : undefined,
                tips: ready && dump ? [arr(trails._leftTip.toArray()), arr(trails._rightTip.toArray())] : undefined,
                leftFull: ready && dump ? full('left') : undefined,
                rightFull: ready && dump ? full('right') : undefined,
            });
        }
        const cones = (fx as Any).afterburnerCones;
        return {
            name: sc.name,
            initialDef: defs.get(sc.initialDef)!.id,
            nozzles: (cones.nozzles as THREE.Vector3[]).map(n => arr(n.toArray())),
            radius: cones.radius as number,
            thrustOrigin: (() => {
                const t = new THREE.Vector3();
                return fx.getThrustOrigin(t) ? arr(t.toArray()) : null;
            })(),
            frames,
        };
    });

    // deriveWingtipOriginsFromModel on its own: the planform, and the rejections.
    const rng = new Rng(77);
    const derive: { name: string; positions: number[] }[] = [
        { name: 'planform', positions: arr(models.get('f22')!) },
        { name: 'too_few', positions: [5, 0, 0, -5, 0, 0, 1, 1, 1, -1, 1, 1, 2, 0, 0, -2, 0, 0, 0.5, 0, 0] },
        { name: 'one_sided', positions: arr(new Float32Array(Array.from({ length: 60 }, (_, k) => (k % 3 === 0 ? rng.range(0.1, 5) : rng.range(-2, 2))))) },
        { name: 'narrow', positions: arr(new Float32Array(Array.from({ length: 60 }, (_, k) => (k % 3 === 0 ? rng.range(-0.29, 0.29) : rng.range(-2, 2))))) },
        { name: 'centreline_only', positions: arr(new Float32Array(Array.from({ length: 30 }, (_, k) => (k % 3 === 0 ? rng.range(-0.05, 0.05) : rng.range(-2, 2))))) },
        { name: 'ties', positions: [3, 0, 0, 3, 1, 1, -3, 0, 0, -3, 2, 2, 1, 0, 0, -1, 0, 0, 2, 5, 5, -2, 5, 5, 0, 0, 0] },
        { name: 'random_wide', positions: arr(planformVertices(new Rng(5), 20, 64)) },
    ].map(c => ({ name: c.name, positions: c.positions }));
    const deriveCases = derive.map(c => {
        const r = deriveWingtipOriginsFromModel(fakeModel(new Float32Array(c.positions)));
        return { ...c, result: r ? { left: arr(r.left.toArray()), right: arr(r.right.toArray()) } : null };
    });

    return {
        files: [{
            file: 'aircraft_fx.json',
            data: {
                suite: 'aircraftFx',
                version: 1,
                source: [
                    'src/script/scene/entities/aircraftFx.ts',
                    'src/script/scene/entities/afterburnerCones.ts',
                    'src/script/scene/entities/wingtipTrails.ts',
                    'src/script/scene/entities/wingtipOrigins.ts',
                    'src/script/scene/entities/wingSweep.ts (tipSweepsFromDef, sweptTip)',
                ],
                notes: 'Per frame: optional event, then fx.update(lever, ab, pos, quat, vel) `updates` times (sweep read '
                    + 'from the source), then the afterburner and trail render-list calls with a camera at `camera`. '
                    + 'Defs: f22 = AircraftDefs.F22(), others = aircraft.json packs by id. Cone geometries are keyed by '
                    + 'the FNV-1a of their float32 position bytes (see geometries). Trail matrices/levels: FNV-1a of the '
                    + 'drawn float32 prefix (count*16 / count); every 100th frame also in full (with the plume group world positions). bindModel feeds LOD0 '
                    + 'vertices from models[name]. plumes = world position of the plume group (0.5 m ahead of the root).',
                tolerances: { float32: 'exact', doubles: 1e-12, plumes: 1e-9 },
                models: Object.fromEntries([...models].map(([k, v]) => [k, arr(v)])),
                scenarios,
                geometries: Object.fromEntries(geometries),
                derive: deriveCases,
            },
        }],
    };
}
