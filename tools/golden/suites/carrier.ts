/**
 * Carrier scenery (workstream M7): the CPU side of the arrestor cable shapes,
 * the 2 km stern wake ribbon and the ship-wake foam puffs.
 *
 * - Cables: the real ArrestorCablesEntity with a stub material manager and a
 *   fake player (a SimProxyFlightModel-shaped flight model reporting a latch,
 *   plus hinge body / display pose). Per frame: update() then render3D() with
 *   the camera, as the game does. Outputs are the three float32 position
 *   attributes per cable (carrier-local), the LOD choice and the line flag.
 * - Stern ribbon: SternWakeRibbon driven directly along a turning track, plus
 *   the alpha / half-width ramps.
 * - Ship wake: the real ShipWakeEntity at a fixed dt with Math.random replaced
 *   by a seeded mulberry32 (the C# side takes the same Func<double>), so the
 *   particle pool replays exactly; the instanced float32 attributes per frame.
 *
 * Every input (poses, hinge, camera) is written to the fixture, so the C#
 * replay never re-derives the scripted motion.
 */
import * as THREE from 'three';
import { ArrestorCablesEntity } from '../../../src/script/scene/entities/arrestorCablesEntity';
import { ArrestorCarrierPose } from '../../../src/script/scene/entities/arrestorCables';
import {
    SternWakeRibbon,
    sternWakeAlphaAt,
    sternWakeHalfWidthAt,
} from '../../../src/script/scene/entities/sternWake';
import { ShipWakeEntity } from '../../../src/script/scene/entities/shipWake';
import { SimProxyFlightModel } from '../../../src/script/physics/model/simProxyFlightModel';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { arr, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const UP = new THREE.Vector3(0, 1, 0);

/** Stub manager: records each build's alphaDither, returns a bare ShaderMaterial. */
function stubMaterials(dithers?: number[]): SceneMaterialManager {
    return {
        build: (props: { alphaDither?: number }) => {
            dithers?.push(props.alphaDither ?? 0);
            return new THREE.ShaderMaterial();
        },
    } as unknown as SceneMaterialManager;
}

function hashF32(a: Float32Array, n: number = a.length): string {
    const v = a.subarray(0, n);
    return hex32(fnv1a32(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
}

function yawQuat(yaw: number): THREE.Quaternion {
    return new THREE.Quaternion().setFromAxisAngle(UP, yaw);
}

const q4 = (q: THREE.Quaternion) => [q.x, q.y, q.z, q.w];
const v3 = (v: THREE.Vector3) => [v.x, v.y, v.z];

/**
 * The world ground sampler the cable entity is given: a wavy deck around
 * `deckBase` + 13.5, sometimes under the 13.55 m floor, sometimes over it.
 * The C# test implements the same expression (JsTrig is V8-exact).
 */
function deckSampler(deckBase: number): (x: number, z: number) => number {
    return (x, z) => deckBase + 13.5 + 0.2 * Math.sin(x * 0.05) * Math.cos(z * 0.07);
}

// ---------------------------------------------------------------- cables

interface CableFrameIn {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    latch: number;
    hingeBody: THREE.Vector3;
    displayQuat: THREE.Quaternion;
    displayPos: THREE.Vector3;
    camera: THREE.Vector3;
}

interface CableScenario {
    name: string;
    deckBase: number;
    frames: number;
    frame: (i: number) => CableFrameIn;
}

const HINGE_BODY = new THREE.Vector3(0, -0.25, -3.85);

/** Lod anchor (mean cable mid) in carrier-local space. */
const ANCHOR_LOCAL = new THREE.Vector3((-34.33 + 43.83) * 0.5, 13.85, (95 + 83 + 71 + 59) / 4);

function cameraAt(position: THREE.Vector3, quaternion: THREE.Quaternion, dist: number, bearing: number, up: number) {
    const anchor = ANCHOR_LOCAL.clone().applyQuaternion(quaternion).add(position);
    return new THREE.Vector3(anchor.x + Math.sin(bearing) * dist, anchor.y + up, anchor.z + Math.cos(bearing) * dist);
}

/** Camera distance profile across the 350 m switch: out to 400, back to 340 (still lines), in to 300. */
function lodProfile(i: number, n: number): number {
    const t = i / (n - 1);
    if (t < 0.4) return 80 + (420 - 80) * (t / 0.4);
    if (t < 0.6) return 420 - (420 - 340) * ((t - 0.4) / 0.2);
    if (t < 0.7) return 340;
    return 340 - (340 - 280) * ((t - 0.7) / 0.3);
}

/**
 * The aircraft rolls out along the deck (-Z local) dragging cable `latch`;
 * hinge body offset puts the hook behind the CG. The display pose is the
 * carrier frame plus a local track, so the V-mid follows the hook.
 */
function trapFrame(
    position: THREE.Vector3, quaternion: THREE.Quaternion,
    cableZ: number, pull: number, lateral: number, pitch: number,
): { displayPos: THREE.Vector3; displayQuat: THREE.Quaternion } {
    const local = new THREE.Vector3((-34.33 + 43.83) * 0.5 + lateral, 15.6, cableZ + 3.85 - pull);
    const displayPos = local.applyQuaternion(quaternion).add(position);
    const body = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, Math.PI + 0.05 * lateral, 0, 'YXZ'));
    const displayQuat = quaternion.clone().multiply(body);
    return { displayPos, displayQuat };
}

const CABLE_SCENARIOS: CableScenario[] = [
    {
        // Moored carrier, cables idle; the camera walks across the LOD band and back.
        name: 'idle_lod_hysteresis',
        deckBase: 0,
        frames: 60,
        frame: i => {
            const position = new THREE.Vector3(10000, 0, -2000);
            const quaternion = new THREE.Quaternion();
            return {
                position, quaternion, latch: -1,
                hingeBody: HINGE_BODY, displayQuat: new THREE.Quaternion(), displayPos: new THREE.Vector3(),
                camera: cameraAt(position, quaternion, lodProfile(i, 60), 0.6 + i * 0.02, 30),
            };
        },
    },
    {
        // Steaming and yawing with idle cables: the local layout is not rebuilt
        // (the skip), the root pose follows the ship.
        name: 'idle_steaming_turn',
        deckBase: -0.8,
        frames: 40,
        frame: i => {
            const yaw = 0.7 + i * 0.01;
            const quaternion = yawQuat(yaw);
            const position = new THREE.Vector3(10000 - 12 * Math.sin(yaw) * i * 0.25, -0.8, -2000 - 12 * Math.cos(yaw) * i * 0.25);
            return {
                position, quaternion, latch: -1,
                hingeBody: HINGE_BODY, displayQuat: new THREE.Quaternion(), displayPos: new THREE.Vector3(),
                camera: cameraAt(position, quaternion, 200 + i * 8, -1.1, 60),
            };
        },
    },
    {
        // Trap on wire 2 (index 1): pulled out 0 -> 120 m with drift and pitch,
        // then released; camera chases inside the ribbon range then backs off.
        name: 'trap_wire2_pullout',
        deckBase: 1.25,
        frames: 70,
        frame: i => {
            const yaw = -0.35 + i * 0.002;
            const quaternion = yawQuat(yaw);
            const position = new THREE.Vector3(-4200 + i * 0.3, 1.25, 8800 - i * 2.4);
            const latch = i >= 5 && i < 60 ? 1 : -1;
            const pull = latch >= 0 ? Math.min(120, (i - 5) * 2.4) : 0;
            const lateral = 3.5 * Math.sin(i * 0.15);
            const { displayPos, displayQuat } = trapFrame(position, quaternion, 83, pull, lateral, 0.04 * Math.cos(i * 0.3));
            return {
                position, quaternion, latch,
                hingeBody: HINGE_BODY, displayQuat, displayPos,
                camera: i < 50 ? displayPos.clone().add(new THREE.Vector3(8, 4, 30))
                    : cameraAt(position, quaternion, 300 + (i - 50) * 6, 2.0, 40),
            };
        },
    },
    {
        // Wire 4 (index 3) then wire 1 (index 0) in one run; frames with the hook
        // hinge straight above the sheave (degenerate leg A, kept from before)
        // and the hinge on the sheave (fallback direction).
        name: 'trap_degenerate_and_switch',
        deckBase: 0.4,
        frames: 30,
        frame: i => {
            const quaternion = new THREE.Quaternion();
            const position = new THREE.Vector3(3000, 0.4, 500);
            const latch = i < 12 ? 3 : i < 14 ? -1 : 0;
            const cableZ = latch === 3 ? 59 : 95;
            let { displayPos, displayQuat } = trapFrame(position, quaternion, cableZ, (i % 12) * 4, -2 + i * 0.3, 0.02);
            let hingeBody = HINGE_BODY;
            const sheaveLocal = new THREE.Vector3((-34.33 + 43.83) * 0.5 - 18, 13.85, cableZ);
            const sheave = sheaveLocal.clone().add(position);
            if (i === 8 || i === 20) {
                // Hinge exactly above the sheave: tip lands on it, leg A has zero length.
                displayQuat = new THREE.Quaternion();
                hingeBody = new THREE.Vector3(0, 0, 0);
                displayPos = sheave.clone().add(new THREE.Vector3(0, 1.25, 0));
            } else if (i === 9 || i === 21) {
                // Hinge on the sheave: the (0,-1,-1) fallback direction.
                displayQuat = new THREE.Quaternion();
                hingeBody = new THREE.Vector3(0, 0, 0);
                displayPos = sheave.clone();
            }
            return {
                position, quaternion, latch, hingeBody, displayQuat, displayPos,
                camera: new THREE.Vector3(3010, 40, 600 + i * 15),
            };
        },
    },
];

function cablesScenario(sc: CableScenario) {
    let current = sc.frame(0);
    const pose: ArrestorCarrierPose = { position: current.position.clone(), quaternion: current.quaternion.clone() };
    const fm = Object.create(SimProxyFlightModel.prototype) as Any;
    fm.getArrestorLatch = () => current.latch;
    const player = {
        getFlightModel: () => fm,
        updateDisplayTransform: () => { /* inputs are already the display pose */ },
        getArrestorHookHingeBody: (out: THREE.Vector3) => out.copy(current.hingeBody),
        getDisplayQuaternion: () => current.displayQuat,
        getDisplayPosition: () => current.displayPos,
    } as Any;
    const entity = new ArrestorCablesEntity(
        stubMaterials(), () => pose, () => player, deckSampler(sc.deckBase));
    const camera = new THREE.PerspectiveCamera();
    const lists = new Map<string, THREE.Scene>();
    const ent = entity as Any;
    const snapshot = () => ent.cables.map((c: Any) => ({
        ribbonA: arr(c.cableAPos.array), ribbonB: arr(c.cableBPos.array), line: arr(c.linePos.array),
    }));
    const initial = snapshot();

    const frames = [];
    for (let i = 0; i < sc.frames; i++) {
        current = sc.frame(i);
        pose.position.x = current.position.x;
        pose.position.y = current.position.y;
        pose.position.z = current.position.z;
        pose.quaternion!.copy(current.quaternion);
        camera.position.copy(current.camera);
        entity.update(1 / 60);
        entity.render3D(800, 600, camera, lists, undefined as Any);
        frames.push({
            position: v3(current.position), quaternion: q4(current.quaternion), latch: current.latch,
            hingeBody: v3(current.hingeBody), displayQuat: q4(current.displayQuat), displayPos: v3(current.displayPos),
            camera: v3(current.camera),
            useLineLod: ent.useLineLod as boolean,
            ribbonVisible: ent.cables.map((c: Any) => c.cableA.visible && c.cableB.visible),
            lineVisible: ent.cables.map((c: Any) => c.line.visible),
            cables: snapshot(),
        });
    }
    return { name: sc.name, deckBase: sc.deckBase, initial, frames };
}

// ---------------------------------------------------------------- stern ribbon

function ribbonScenario() {
    const dithers: number[] = [];
    const ribbon = new SternWakeRibbon(stubMaterials(dithers));
    const r = ribbon as Any;
    const steps = [];
    let heading = 0.3;
    const stern = new THREE.Vector3(25000, 0, -18000);
    for (let i = 0; i < 140; i++) {
        // Straight, a hard turn, then straight again; 23 m a step so a sample
        // is pushed on most steps (40 m spacing) but not all.
        if (i >= 40 && i < 90) heading += 0.045;
        const fwd = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
        if (i > 0) stern.addScaledVector(fwd, 23);
        const aft = fwd.clone().negate();
        ribbon.update(stern, aft);
        const positions = new Float32Array(50 * 12);
        const visible: boolean[] = [];
        for (let j = 0; j < 50; j++) {
            positions.set(r.positions[j].array as Float32Array, j * 12);
            visible.push(r.segments[j].visible as boolean);
        }
        const step: Record<string, unknown> = {
            stern: v3(stern), aft: v3(aft),
            object: v3(ribbon.object.position),
            visible,
            hash: hashF32(positions),
        };
        if (i % 20 === 0 || i === 139) step.positions = arr(positions);
        steps.push(step);
    }
    const ramps = [];
    for (let d = -50; d <= 2300; d += 37.5) {
        ramps.push({ d, alpha: sternWakeAlphaAt(d), halfWidth: sternWakeHalfWidthAt(d) });
    }
    return { segmentDither: dithers, ramps, steps };
}

// ---------------------------------------------------------------- ship wake

interface WakeScenario {
    name: string;
    seed: number;
    dt: number;
    frames: number;
    pose: (i: number) => { position: THREE.Vector3; quaternion: THREE.Quaternion };
}

const WAKE_SCENARIOS: WakeScenario[] = [
    {
        name: 'steaming_straight',
        seed: 0xC0FFEE,
        dt: 1 / 60,
        frames: 1200,
        pose: i => {
            const yaw = 0.4;
            const s = 14 * i / 60;
            return {
                position: new THREE.Vector3(30000 - Math.sin(yaw) * s, -70.5, -20000 - Math.cos(yaw) * s),
                quaternion: yawQuat(yaw),
            };
        },
    },
    {
        name: 'turning_30hz',
        seed: 0x5EA5,
        dt: 1 / 30,
        frames: 600,
        pose: (() => {
            // Integrated track, so it is computed once and indexed.
            const track: { position: THREE.Vector3; quaternion: THREE.Quaternion }[] = [];
            const p = new THREE.Vector3(-8000, -5, 12000);
            let yaw = -2.0;
            for (let i = 0; i < 600; i++) {
                if (i > 0) {
                    yaw += (3 * Math.PI / 180) / 30;
                    p.x -= Math.sin(yaw) * 12 / 30;
                    p.z -= Math.cos(yaw) * 12 / 30;
                }
                track.push({ position: p.clone(), quaternion: yawQuat(yaw) });
            }
            return (i: number) => track[i];
        })(),
    },
];

const WAKE_DUMPS = new Set([1, 59, 599, 1000, 1199]);

function wakeScenario(sc: WakeScenario) {
    let current = sc.pose(0);
    const pose: ArrestorCarrierPose = { position: current.position.clone(), quaternion: current.quaternion.clone() };
    // Built before Math.random is swapped: three.js draws it for object UUIDs.
    const wake = new ShipWakeEntity(stubMaterials(), () => pose);
    const w = wake as Any;
    const rng = new Rng(sc.seed);
    const saved = Math.random;
    let draws = 0;
    Math.random = () => {
        draws++;
        return rng.next();
    };
    try {
        const frames = [];
        for (let i = 0; i < sc.frames; i++) {
            current = sc.pose(i);
            pose.position.x = current.position.x;
            pose.position.y = current.position.y;
            pose.position.z = current.position.z;
            pose.quaternion!.copy(current.quaternion);
            wake.update(sc.dt);
            const n = w.geometry.instanceCount as number;
            const offsets = w.attrOffset.array as Float32Array;
            const scales = w.attrScale.array as Float32Array;
            const rotations = w.attrRotation.array as Float32Array;
            const colors = w.attrColor.array as Float32Array;
            const ribbonPos = new Float32Array(50 * 12);
            for (let j = 0; j < 50; j++) ribbonPos.set(w.sternRibbon.positions[j].array as Float32Array, j * 12);
            const frame: Record<string, unknown> = {
                position: v3(current.position), quaternion: q4(current.quaternion),
                draws,
                count: n,
                offsets: hashF32(offsets, n * 3),
                scales: hashF32(scales, n),
                rotations: hashF32(rotations, n),
                colors: hashF32(colors, n * 4),
                ribbonObject: v3(w.sternRibbon.object.position),
                ribbon: hashF32(ribbonPos),
            };
            if (WAKE_DUMPS.has(i)) {
                frame.dump = {
                    offsets: arr(offsets.subarray(0, n * 3)),
                    scales: arr(scales.subarray(0, n)),
                    rotations: arr(rotations.subarray(0, n)),
                    colors: arr(colors.subarray(0, n * 4)),
                };
            }
            frames.push(frame);
        }
        return { name: sc.name, seed: sc.seed, dt: sc.dt, frames };
    } finally {
        Math.random = saved;
    }
}

export function carrierSuite(): SuiteOutput {
    return {
        files: [{
            file: 'carrier.json',
            data: {
                suite: 'carrier',
                version: 1,
                source: [
                    'src/script/scene/entities/arrestorCablesEntity.ts',
                    'src/script/scene/entities/arrestorCables.ts',
                    'src/script/scene/entities/sternWake.ts',
                    'src/script/scene/entities/shipWake.ts',
                    'src/script/physics/particles/particleSystem.ts',
                    'src/script/physics/particles/emitters/pointEmitter.ts',
                ],
                notes: 'Cables: per frame set the carrier pose, latch, hinge body / display pose and camera, then '
                    + 'entity.update() and render3D(); ground sampler = deckBase + 13.5 + 0.2 sin(0.05 x) cos(0.07 z). '
                    + 'ribbonA/ribbonB are the 4-vertex quads (index 0,1,2,2,1,3), line the 3-point polyline, all '
                    + 'carrier-local float32. `initial` is after the constructor. Stern ribbon: update(stern, aft) per '
                    + 'step; positions are the 50 segment quads concatenated (root-relative, float32). Ship wake: '
                    + 'Math.random = mulberry32(seed); `draws` counts calls so far; hashes are FNV-1a over the drawn '
                    + 'float32 prefix; dumps every few frames.',
                tolerances: { float32: 'exact', doubles: 1e-12 },
                cables: CABLE_SCENARIOS.map(cablesScenario),
                sternRibbon: ribbonScenario(),
                shipWake: WAKE_SCENARIOS.map(wakeScenario),
            },
        }],
    };
}
