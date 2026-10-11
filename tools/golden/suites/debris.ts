/**
 * Hit debris, scrape sparks and impact marks (workstream M9): the CPU side of
 * debrisField.ts and impactMarks.ts, plus the particle emitter / forces they use.
 *
 * - Debris: the real DebrisField with a stub material manager at a fixed dt and
 *   Math.random = mulberry32(seed). Three.js draws Math.random for object UUIDs
 *   while the constructor builds its meshes, so the field is built first and its
 *   48 chip tumble axes are then re-drawn from the seeded source with the
 *   constructor's own formula (the C# constructor draws them the same way).
 *   Scripted per frame: gun-hit batches on a fast target (incl. scrapes in the
 *   first six and more than six hits), ground scrapes (mixed sources, more than
 *   six), debug bursts with and without velocity, pool recycling under heavy
 *   fire, and a re-base mid-run; then update(dt). Outputs: the chip / spark
 *   model matrices (three.js compose of each mesh's position / quaternion /
 *   scale, float32, all 48 slots incl. stale invisible ones), visibility masks,
 *   draw counts and dumps of the live particle state.
 * - Marks: the real ImpactMarks on flat and sloped ground and on a moving deck
 *   whose velocity changes; burns growing over various grow times; both ring
 *   buffers overflowing; a re-base; a clear. The moving surface's per-frame
 *   velocity and each add's `contains` answer are written to the fixture, so the
 *   C# replay never re-derives the deck.
 * - Math.exp at the drag factors and a sweep (V8's fdlibm exp, see JsExp.cs).
 * - The static meshes: PlaneGeometry(1,1), BoxGeometry(0.06,0.06,0.55),
 *   CircleGeometry(0.5, 8).rotateX(-PI/2) positions (float32) and indices.
 */
import * as THREE from 'three';
import { DebrisField } from '../../../src/script/scene/entities/debrisField';
import { ImpactMarks } from '../../../src/script/scene/entities/impactMarks';
import { FrameShift } from '../../../src/script/terrain/geodesy';
import { SimHitEvent } from '../../../src/script/physics/sim/simTypes';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { arr, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const stubMaterials = { build: () => new THREE.ShaderMaterial() } as unknown as SceneMaterialManager;

function hashF32(a: Float32Array, n: number = a.length): string {
    const v = a.subarray(0, n);
    return hex32(fnv1a32(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
}

const v3 = (v: THREE.Vector3) => [v.x, v.y, v.z];

/** Swap Math.random for a counting seeded source while `body` runs. */
function withRandom<T>(seed: number, body: (draws: () => number) => T): T {
    const rng = new Rng(seed);
    const saved = Math.random;
    let draws = 0;
    Math.random = () => {
        draws++;
        return rng.next();
    };
    try {
        return body(() => draws);
    } finally {
        Math.random = saved;
    }
}

// ---------------------------------------------------------------- debris

type HitIn = { position: number[]; velocity: number[]; source?: 'scrape' };
type DebrisAction =
    | { type: 'hits'; hits: HitIn[] }
    | { type: 'scrapes'; hits: HitIn[] }
    | { type: 'debug'; position: number[]; velocity?: number[] }
    | { type: 'rebase'; rotation: number[]; offset: number[] };

interface DebrisScenario {
    name: string;
    seed: number;
    dt: number;
    frames: number;
    dumps: Set<number>;
    script: (rng: Rng) => DebrisAction[][];
}

/** Rounded to a millimetre; never -0 (JSON cannot hold it, so the replay would see +0). */
const round = (x: number) => (Math.round(x * 1000) / 1000) || 0;

/** A target flying at 180 m/s east-ish, slightly climbing. */
function targetAt(i: number, dt: number): number[] {
    const t = i * dt;
    return [1200 + 180 * t, 850 + 5 * t, -3400 - 60 * t];
}

function gunHits(rng: Rng, i: number, dt: number, n: number, scrapeAt: number[] = []): HitIn[] {
    const p = targetAt(i, dt);
    const hits: HitIn[] = [];
    for (let k = 0; k < n; k++) {
        const h: HitIn = {
            position: [round(p[0] + rng.range(-6, 6)), round(p[1] + rng.range(-1.5, 1.5)), round(p[2] + rng.range(-6, 6))],
            velocity: [round(180 + rng.range(-2, 2)), round(5 + rng.range(-1, 1)), round(-60 + rng.range(-2, 2))],
        };
        if (scrapeAt.includes(k)) {
            h.source = 'scrape';
        }
        hits.push(h);
    }
    return hits;
}

function scrapes(rng: Rng, i: number, n: number, gunAt: number[] = []): HitIn[] {
    const hits: HitIn[] = [];
    const x = -500 + i * 1.2;
    for (let k = 0; k < n; k++) {
        const h: HitIn = {
            position: [round(x + rng.range(-3, 3)), round(2.5 + rng.range(-0.3, 0.3)), round(700 - i * 0.4 + rng.range(-3, 3))],
            velocity: [round(70 + rng.range(-5, 5)), round(rng.range(-4, 1)), round(-25 + rng.range(-3, 3))],
        };
        if (!gunAt.includes(k)) {
            h.source = 'scrape';
        }
        hits.push(h);
    }
    return hits;
}

const REBASE_ROT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.1, 1, 0.05).normalize(), 0.0031);

const DEBRIS_SCENARIOS: DebrisScenario[] = [
    {
        name: 'gunfight_and_scrapes_60hz',
        seed: 0xDEB215,
        dt: 1 / 60,
        frames: 480,
        dumps: new Set([0, 31, 100, 199, 200, 230, 330]),
        script: rng => {
            const dt = 1 / 60;
            const frames: DebrisAction[][] = [];
            for (let i = 0; i < 480; i++) {
                const acts: DebrisAction[] = [];
                if (i < 150 && i % 4 === 0) {
                    acts.push({ type: 'hits', hits: gunHits(rng, i, dt, 1 + (i % 3)) });
                }
                if (i === 30) {
                    // Nine events, two scrapes among the first six: four bursts, the rest capped.
                    acts.push({ type: 'hits', hits: gunHits(rng, i, dt, 9, [1, 4]) });
                }
                if (i === 100 || i === 101) {
                    // Heavy fire: the full pool is recycled oldest-first.
                    acts.push({ type: 'hits', hits: gunHits(rng, i, dt, 6) });
                }
                if (i === 60) {
                    acts.push({ type: 'debug', position: targetAt(i, dt), velocity: [180, 5, -60] });
                }
                if (i === 61 || i === 260) {
                    acts.push({ type: 'debug', position: [round(rng.range(-50, 50)), 300, round(rng.range(-50, 50))] });
                }
                if (i >= 50 && i < 280 && i % 3 === 0) {
                    const n = i === 90 ? 9 : 1 + (i % 5);
                    acts.push({ type: 'scrapes', hits: scrapes(rng, i, n, i % 7 === 0 ? [0] : []) });
                }
                if (i === 200) {
                    acts.push({ type: 'rebase', rotation: [REBASE_ROT.x, REBASE_ROT.y, REBASE_ROT.z, REBASE_ROT.w], offset: [-20000, -15, 8000] });
                }
                frames.push(acts);
            }
            return frames;
        },
    },
    {
        name: 'breakup_bursts_30hz',
        seed: 0x5A11,
        dt: 1 / 30,
        frames: 200,
        dumps: new Set([5, 50, 120]),
        script: rng => {
            const frames: DebrisAction[][] = [];
            for (let i = 0; i < 200; i++) {
                const acts: DebrisAction[] = [];
                if (i === 5 || i === 40 || i === 41) {
                    // A breakup: several bursts scattered around the impact.
                    for (let k = 0; k < 4; k++) {
                        acts.push({
                            type: 'debug',
                            position: [round(40 + rng.range(-3, 3)), round(12 + rng.range(0, 3)), round(-90 + rng.range(-3, 3))],
                            velocity: [round(rng.range(-60, 60)), round(rng.range(-10, 5)), round(rng.range(-60, 60))],
                        });
                    }
                }
                if (i >= 5 && i < 60 && i % 2 === 0) {
                    acts.push({ type: 'scrapes', hits: scrapes(rng, i, 3) });
                }
                if (i === 50) {
                    acts.push({ type: 'rebase', rotation: [0, 0, 0, 1], offset: [120.5, 0, -64.25] });
                }
                frames.push(acts);
            }
            return frames;
        },
    },
];

function toHits(hits: HitIn[]): SimHitEvent[] {
    return hits.map(h => ({
        position: h.position as [number, number, number],
        velocity: h.velocity as [number, number, number],
        targetId: 'ai0',
        damage: 1,
        ...(h.source ? { source: h.source } : {}),
    } as SimHitEvent));
}

function meshMatrices(meshes: THREE.Mesh[]): Float32Array {
    const out = new Float32Array(meshes.length * 16);
    const m = new THREE.Matrix4();
    meshes.forEach((mesh, i) => {
        m.compose(mesh.position, mesh.quaternion, mesh.scale);
        out.set(m.elements, i * 16);
    });
    return out;
}

const mask = (meshes: THREE.Mesh[]) => meshes.map(m => (m.visible ? '1' : '0')).join('');

function particleDump(system: Any) {
    return (system.particles as Any[]).map((p, i) => (p.isActive ? {
        i, life: p.life, lifespan: p.lifespan, position: v3(p.position), velocity: v3(p.velocity),
        sizeStart: p.sizeStart, sizeEnd: p.sizeEnd, rotationStart: p.rotationStart, rotationEnd: p.rotationEnd,
    } : undefined)).filter(x => x !== undefined);
}

function debrisScenario(sc: DebrisScenario) {
    const script = sc.script(new Rng(sc.seed ^ 0x9E3779B9));
    // Built before Math.random is swapped: three.js draws it for object UUIDs.
    const field = new DebrisField(stubMaterials);
    const f = field as Any;
    return withRandom(sc.seed, draws => {
        // The constructor's tumble axes, re-drawn from the seeded source.
        for (const axis of f.spinAxes as THREE.Vector3[]) {
            axis.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
        }
        const spinAxes = (f.spinAxes as THREE.Vector3[]).map(v3);
        const frames = [];
        let maxChips = 0;
        let maxSparks = 0;
        for (let i = 0; i < sc.frames; i++) {
            for (const a of script[i]) {
                if (a.type === 'hits') field.spawnFromHits(toHits(a.hits));
                else if (a.type === 'scrapes') field.spawnGroundScrapes(toHits(a.hits));
                else if (a.type === 'debug') {
                    field.spawnDebugBurst(new THREE.Vector3().fromArray(a.position),
                        a.velocity ? new THREE.Vector3().fromArray(a.velocity) : undefined);
                } else {
                    field.rebase(FrameShift.fromArrays(a));
                }
            }
            field.update(sc.dt);
            const chips = f.chips as THREE.Mesh[];
            const sparks = f.sparks as THREE.Mesh[];
            const chipM = meshMatrices(chips);
            const sparkM = meshMatrices(sparks);
            maxChips = Math.max(maxChips, chips.filter(m => m.visible).length);
            maxSparks = Math.max(maxSparks, sparks.filter(m => m.visible).length);
            const frame: Record<string, unknown> = {
                actions: script[i],
                draws: draws(),
                chipsVisible: mask(chips),
                sparksVisible: mask(sparks),
                chipMatrices: hashF32(chipM),
                sparkMatrices: hashF32(sparkM),
            };
            if (sc.dumps.has(i)) {
                frame.dump = {
                    chipMatrices: arr(chipM),
                    sparkMatrices: arr(sparkM),
                    chips: particleDump(f.system),
                    sparks: particleDump(f.sparkSystem),
                };
            }
            frames.push(frame);
        }
        return { name: sc.name, seed: sc.seed, dt: sc.dt, spinAxes, maxChips, maxSparks, frames };
    });
}

// ---------------------------------------------------------------- marks

type MarkAction =
    | { type: 'add'; position: number[]; normal: number[]; dirX: number; dirZ: number; length: number; width: number; strength: number; onDeck: boolean }
    | { type: 'burn'; position: number[]; normal: number[]; dirX: number; dirZ: number; length: number; width: number; strength: number; growSeconds: number; onDeck: boolean }
    | { type: 'rebase'; rotation: number[]; offset: number[] }
    | { type: 'clear' };

function slopeNormal(rng: Rng, maxTilt: number): number[] {
    const n = new THREE.Vector3(rng.range(-maxTilt, maxTilt), 1, rng.range(-maxTilt, maxTilt)).normalize();
    return v3(n);
}

/** The marks script: a crash on land, then a crash on a moving deck, overflow, re-base, clear. */
function marksScript(rng: Rng, frames: number): { actions: MarkAction[][]; deckVelocity: number[][] } {
    const actions: MarkAction[][] = [];
    const deckVelocity: number[][] = [];
    for (let i = 0; i < frames; i++) {
        const acts: MarkAction[] = [];
        // The ship steams at 14 m/s, turning slowly after frame 150.
        const yaw = 0.4 + (i > 150 ? (i - 150) * 0.002 : 0);
        deckVelocity.push([-14 * Math.sin(yaw), 0, -14 * Math.cos(yaw)]);
        const flat = (k: number): MarkAction => ({
            type: 'add',
            position: [round(300 + rng.range(-40, 40)), round(rng.range(5, 8)), round(-200 + rng.range(-40, 40))],
            normal: k % 3 === 0 ? [0, 1, 0] : slopeNormal(rng, 0.4),
            // Every fifth has no direction: a random heading.
            dirX: k % 5 === 0 ? 0 : round(rng.range(-1, 1)),
            dirZ: k % 5 === 0 ? 0 : round(rng.range(-1, 1)),
            length: round(rng.range(2, 14)), width: round(rng.range(1, 6)),
            // Strength outside 0..1 is clamped.
            strength: round(rng.range(-0.2, 1.3)),
            onDeck: false,
        });
        const burn = (deck: boolean): MarkAction => ({
            type: 'burn',
            position: [round(deck ? -40 + rng.range(-10, 10) : 310 + rng.range(-30, 30)), round(deck ? 18.6 : 6), round(deck ? 60 + rng.range(-40, 40) : -190 + rng.range(-30, 30))],
            normal: deck ? [0, 1, 0] : slopeNormal(rng, 0.25),
            dirX: round(rng.range(-1, 1)), dirZ: round(rng.range(-1, 1)),
            length: round(rng.range(3, 10)), width: round(rng.range(3, 8)),
            strength: round(rng.range(0, 1.1)),
            // Some burns grow almost instantly (the 0.1 s floor), most over seconds.
            growSeconds: rng.next() < 0.15 ? 0 : round(rng.range(1, 12)),
            onDeck: deck && rng.next() < 0.8,
        });
        if (i < 60 && i % 2 === 0) {
            for (let k = 0; k < 3; k++) acts.push(flat(i + k));
        }
        if (i >= 10 && i < 120 && i % 5 === 0) {
            acts.push(burn(false));
        }
        if (i >= 80 && i < 200 && i % 3 === 0) {
            // On the deck (and some just over the side).
            const a = flat(i);
            a.position = [round(-40 + rng.range(-25, 25)), 18.6, round(60 + rng.range(-120, 120))];
            a.normal = [0, 1, 0];
            a.onDeck = rng.next() < 0.75;
            acts.push(a);
            acts.push(burn(true));
        }
        if (i === 140) {
            // Overflow both rings in one frame.
            for (let k = 0; k < 330; k++) {
                const a = flat(k);
                a.onDeck = k % 4 === 0;
                acts.push(a);
            }
            for (let k = 0; k < 560; k++) acts.push(burn(k % 2 === 0));
        }
        if (i === 220) {
            acts.push({ type: 'rebase', rotation: [REBASE_ROT.x, REBASE_ROT.y, REBASE_ROT.z, REBASE_ROT.w], offset: [5000.25, -3, -12000.5] });
        }
        if (i >= 230 && i < 260 && i % 4 === 0) {
            acts.push(flat(i));
            acts.push(burn(true));
        }
        if (i === 290) {
            acts.push({ type: 'clear' });
        }
        if (i > 290 && i % 6 === 0) {
            acts.push(flat(i));
            acts.push(burn(i % 12 === 0));
        }
        actions.push(acts);
    }
    return { actions, deckVelocity };
}

const MARK_DUMPS = new Set([0, 59, 141, 220, 221, 289, 299]);
const DUMP_INSTANCES = 24;

function marksScenario() {
    const seed = 0x1A9AC7;
    const dt = 1 / 30;
    const frames = 320;
    const { actions, deckVelocity } = marksScript(new Rng(seed ^ 0x51ED), frames);
    const marks = new ImpactMarks(stubMaterials);
    const m = marks as Any;
    const velocity = new THREE.Vector3();
    let onDeck = false;
    marks.setMovingSurface({ velocity, contains: () => onDeck });
    return withRandom(seed, draws => {
        const out = [];
        for (let i = 0; i < frames; i++) {
            velocity.fromArray(deckVelocity[i]);
            for (const a of actions[i]) {
                if (a.type === 'add' || a.type === 'burn') {
                    onDeck = a.onDeck;
                    const p = new THREE.Vector3().fromArray(a.position);
                    const n = new THREE.Vector3().fromArray(a.normal);
                    if (a.type === 'add') marks.add(p, n, a.dirX, a.dirZ, a.length, a.width, a.strength);
                    else marks.addBurn(p, n, a.dirX, a.dirZ, a.length, a.width, a.strength, a.growSeconds);
                } else if (a.type === 'rebase') {
                    marks.rebase(FrameShift.fromArrays(a));
                } else {
                    marks.clear();
                }
            }
            marks.update(dt);
            const pool = (p: Any, dump: boolean) => {
                const matrices = p.mesh.instanceMatrix.array as Float32Array;
                const levels = p.level.array as Float32Array;
                const r: Record<string, unknown> = {
                    count: p.mesh.count as number,
                    visible: p.mesh.visible as boolean,
                    next: p.next as number,
                    growing: p.growing as number,
                    movers: p.movers as number,
                    matrices: hashF32(matrices),
                    levels: hashF32(levels),
                };
                if (dump) {
                    r.dumpMatrices = arr(matrices.subarray(0, DUMP_INSTANCES * 16));
                    r.dumpLevels = arr(levels.subarray(0, DUMP_INSTANCES));
                }
                return r;
            };
            const dump = MARK_DUMPS.has(i);
            out.push({
                deckVelocity: deckVelocity[i],
                actions: actions[i],
                draws: draws(),
                impact: pool(m.impact, dump),
                burn: pool(m.burn, dump),
            });
        }
        return { seed, dt, frames: out };
    });
}

// ---------------------------------------------------------------- exp + meshes

function expTable() {
    const xs = [
        -0.55 / 60, -1.2 / 60, -0.55 / 30, -1.2 / 30, -0.55 / 120, -1.2 / 144, 0, -0, 1, -1, 0.5, 0.3465, 0.35, 1.04, 1.05,
        700, 709.7, 710, -745, -746, -708, -1022 * Math.LN2, 1e-9, -1e-9, 3e-9,
    ];
    const rng = new Rng(0xE4B);
    for (let k = 0; k < 400; k++) xs.push(rng.range(-60, 60));
    for (let k = 0; k < 200; k++) xs.push(rng.range(-1, 1) * 0.05);
    return xs.map(x => [x, Math.exp(x)]);
}

function geometry(g: THREE.BufferGeometry) {
    return {
        positions: arr(g.getAttribute('position').array as Float32Array),
        indices: arr(g.getIndex()!.array),
    };
}

export function debrisSuite(): SuiteOutput {
    return {
        files: [{
            file: 'debris.json',
            data: {
                suite: 'debris',
                version: 1,
                source: [
                    'src/script/scene/entities/debrisField.ts',
                    'src/script/scene/entities/impactMarks.ts',
                    'src/script/physics/particles/particleSystem.ts',
                    'src/script/physics/particles/emitters/sphereEmitter.ts',
                    'src/script/physics/particles/forces/constantForce.ts',
                    'src/script/physics/particles/forces/linearDragForce.ts',
                ],
                notes: 'Debris: Math.random = mulberry32(seed); spinAxes re-drawn from it first (3 per chip); per frame '
                    + 'the actions run in order (hits -> spawnFromHits, scrapes -> spawnGroundScrapes, debug -> '
                    + 'spawnDebugBurst, rebase -> FrameShift(rotation xyzw, offset)), then update(dt). Matrices are '
                    + 'Matrix4.compose(position, quaternion, scale) of all 48 meshes per pool as float32, FNV-1a hashed; '
                    + 'masks are visible flags. Marks: the moving surface velocity is deckVelocity for the frame and '
                    + 'contains() answers the action\'s onDeck; per frame actions then update(dt); pools report the '
                    + 'InstancedMesh count / visible, ring next, growing / movers counters, hashes over the whole '
                    + 'instanceMatrix and ditherLevel arrays, dumps of the first 24 instances. exp: [x, Math.exp(x)].',
                tolerances: { float32: 'exact', doubles: 0 },
                debris: DEBRIS_SCENARIOS.map(debrisScenario),
                marks: marksScenario(),
                exp: expTable(),
                meshes: {
                    chip: geometry(new THREE.PlaneGeometry(1, 1)),
                    spark: geometry(new THREE.BoxGeometry(0.06, 0.06, 0.55)),
                    blob: geometry(new THREE.CircleGeometry(0.5, 8).rotateX(-Math.PI / 2)),
                },
            },
        }],
    };
}
