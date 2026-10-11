/**
 * Damage smoke and fire (workstream M9): the real DamageSmokeField driven
 * through scripted scenarios at a fixed dt with Math.random replaced by a
 * seeded mulberry32 (the C# side takes the same Func<double>), so the
 * 4800-puff pool, the leaks, anchored fires, burn spots, the lake of fire and
 * its falling fuel replay exactly.
 *
 * Per frame: the scripted events (hits, scrapes, fireball, fire pool, dust,
 * splash, foam, contact puffs, burn spots, anchored fires, crash plume, debug
 * leak, rebase, reset, surface probe on/off), then update(dt), then the
 * private syncPuffs(camera, palette) that render3D runs. Outputs: the instance
 * count, FNV-1a hashes of the float32 instance matrices / dither levels / two
 * tones (and of the live puffs' kind flags, a diagnostic), the onPoolMark and
 * onBurnMark streams, a little state, and full dumps of the first instances on
 * a few frames.
 *
 * The world the field is given (aircraft poses, anchor positions, ground
 * height, water test, surface kinds, the moving deck) is analytic: the
 * expressions are listed in `notes` and the C# test implements the same ones
 * (JsTrig is V8-exact). After a rebase the poses and anchors are carried
 * through the same FrameShift, so they stay continuous.
 */
import * as THREE from 'three';
import { DamageSmokeField, DamageSmokePose } from '../../../src/script/scene/entities/damageSmokeField';
import { FrameShift } from '../../../src/script/terrain/geodesy';
import { SimHitEvent } from '../../../src/script/physics/sim/simTypes';
import { SceneMaterialManager } from '../../../src/script/scene/materials/materials';
import { HDNoonPalette } from '../../../src/script/config/palettes/hd-noon';
import { HDMidnightPalette } from '../../../src/script/config/palettes/hd-midnight';
import { HDNightVisionPalette } from '../../../src/script/config/palettes/hd-nightvision';
import type { Palette } from '../../../src/script/config/palettes/palette';
import { arr, fnv1a32, hex32, Rng, SuiteOutput } from '../lib';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const stubMaterials = { build: () => new THREE.ShaderMaterial() } as unknown as SceneMaterialManager;

const PALETTES: Record<string, Palette> = {
    noon: HDNoonPalette,
    midnight: HDMidnightPalette,
    nightvision: HDNightVisionPalette,
};

function hashF32(a: Float32Array, n: number = a.length): string {
    const v = a.subarray(0, n);
    return hex32(fnv1a32(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
}

function hashF64(values: number[]): string {
    const a = Float64Array.from(values);
    return hex32(fnv1a32(new Uint8Array(a.buffer)));
}

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------- the world

/**
 * An aircraft flying a circle; it may lose its life, crash (frozen where it
 * was, on the ground at crashY) and vanish. Frame f: t = f * dt.
 */
interface TargetScript {
    id: string;
    cx: number; cy: number; cz: number; r: number; w: number; phase: number; bank: number;
    /** From this frame isAlive is false. */
    deadAt?: number;
    /** From this frame isCrashed is true, the pose frozen at that frame's angle, y = crashY, velocity 0. */
    crashedAt?: number;
    crashY?: number;
    /** From this frame the provider returns undefined. */
    goneAt?: number;
}

/** Anchor kinds: a slide braking to rest, a ballistic fall onto a floor, fixed, riding the deck. */
type AnchorScript =
    | { kind: 'slide'; x: number; y: number; z: number; speed: number; T: number; dirX: number; dirZ: number; from: number; goneAt?: number }
    | { kind: 'fall'; x: number; y: number; z: number; vx: number; vy: number; vz: number; floor: number; from: number; goneAt?: number }
    | { kind: 'fixed'; x: number; y: number; z: number; from: number; goneAt?: number }
    | { kind: 'deck'; x: number; y: number; z: number; from: number; goneAt?: number };

interface DeckScript {
    /** Deck height; it contains points with |y - deckY| < 3 and xMin <= x <= xMax. */
    y: number; xMin: number; xMax: number;
    /** Velocity (vxAmp sin(0.05 t), 0, vz). */
    vxAmp: number; vz: number;
}

type GroundScript =
    | { kind: 'wavy'; base: number; sx: number; sz: number; amp: number }
    | { kind: 'deck'; deck: true };

type Ev =
    | { kind: 'hits'; hits: SimHitEvent[] }
    | { kind: 'scrapes'; hits: SimHitEvent[] }
    | { kind: 'debugLeak'; id: string }
    | { kind: 'crashPlume'; id: string }
    | { kind: 'fireball'; position: number[]; velocity: number[]; severity: number }
    | { kind: 'firePool'; position: number[]; velocity: number[]; severity: number }
    | { kind: 'dust'; position: number[]; velocity: number[]; count: number; strength: number }
    | { kind: 'splash'; position: number[]; strength: number }
    | { kind: 'foam'; position: number[]; radius: number; count: number }
    | { kind: 'contact'; position: number[]; surface: 'dirt' | 'water' | 'concrete'; count: number; scale: number }
    | { kind: 'burnSpot'; position: number[]; life: number; intensity: number }
    | { kind: 'anchored'; anchor: number; targetId: string; rate: number; life: number; small: boolean; trickle?: number; drips?: number }
    | { kind: 'rebase'; rotation: number[]; offset: number[] }
    | { kind: 'reset' }
    | { kind: 'surfaceProbe'; on: boolean };

interface Scenario {
    name: string;
    seed: number;
    dt: number;
    frames: number;
    palette: keyof typeof PALETTES;
    ground: GroundScript;
    /** Open water where x < waterBelowX (and, with a deck, off the deck). Absent: no water test. */
    waterBelowX?: number;
    deck?: DeckScript;
    /** Surface probe (surfaceAt) on from the start. Kinds by x: < waterBelowX water, [concreteMin, concreteMax] concrete, else dirt; on the deck concrete. */
    surfaceProbe: boolean;
    concrete?: [number, number];
    /** Burn and pool marks wired. */
    marks: boolean;
    targets: TargetScript[];
    anchors: AnchorScript[];
    events: { frame: number; ev: Ev }[];
    /** Camera position at frame f: c0 + cv * f. */
    camera: { c0: number[]; cv: number[] };
    dumps: number[];
}

function groundAt(g: GroundScript, deck: DeckScript | undefined, x: number, z: number): number {
    if (g.kind === 'deck') {
        return deck && x >= deck.xMin && x <= deck.xMax ? deck.y : 0;
    }
    return g.base + g.sx * x + g.sz * z + g.amp * Math.sin(0.05 * x) * Math.cos(0.04 * z);
}

function deckVelocity(d: DeckScript, t: number): THREE.Vector3 {
    return new THREE.Vector3(d.vxAmp * Math.sin(0.05 * t), 0, d.vz);
}

function deckContains(d: DeckScript, x: number, y: number): boolean {
    return Math.abs(y - d.y) < 3 && x >= d.xMin && x <= d.xMax;
}

// ---------------------------------------------------------------- scenarios

const hit = (targetId: string, p: number[], damage = 10, source?: 'gun' | 'scrape', slide?: boolean): SimHitEvent => ({
    position: [p[0], p[1], p[2]], velocity: [0, 0, 0], targetId, damage, source, slide,
});

function airborneHits(): Scenario {
    const targets: TargetScript[] = [
        { id: 'a1', cx: 2000, cy: 1500, cz: -3000, r: 600, w: 0.15, phase: 0.3, bank: 0.4, deadAt: 200, crashedAt: 330, crashY: 12, goneAt: 420 },
        { id: 'a2', cx: 2500, cy: 2200, cz: -2500, r: 900, w: -0.1, phase: 2.0, bank: -0.6, goneAt: 300 },
    ];
    // Seven more aircraft loitering in place, to fill the eight leak slots and force a reclaim.
    for (let k = 3; k <= 9; k++) {
        targets.push({ id: `a${k}`, cx: 1500 + 120 * k, cy: 1000 + 40 * k, cz: -2800 - 90 * k, r: 0, w: 0, phase: 0.2 * k, bank: 0 });
    }
    const events: { frame: number; ev: Ev }[] = [
        { frame: 0, ev: { kind: 'hits', hits: [
            hit('a1', [2000 + 600 * Math.sin(0.3) + 1.5, 1500.6, -3000 + 600 * Math.cos(0.3) - 2]),
            hit('ghost', [0, 1000, 0]),
            hit('a1', [2000, 1500, -3000], 5, 'scrape'),
            hit('a1', [2000 + 600 * Math.sin(0.3) - 3, 1499.2, -3000 + 600 * Math.cos(0.3) + 1]),
        ] } },
        { frame: 5, ev: { kind: 'hits', hits: [
            hit('a2', [2500 + 900 * Math.sin(2.0), 2201, -2500 + 900 * Math.cos(2.0)]),
            hit('a2', [2500 + 900 * Math.sin(2.0) + 4, 2199, -2500 + 900 * Math.cos(2.0)]),
            hit('a1', [2000 + 600 * Math.sin(0.325), 1502, -3000 + 600 * Math.cos(0.325)]),
            hit('a2', [2500 + 900 * Math.sin(2.0), 2200, -2500 + 900 * Math.cos(2.0) + 3]),
            hit('a1', [2000 + 600 * Math.sin(0.325) + 2, 1500, -3000 + 600 * Math.cos(0.325)]),
            hit('a2', [2500 + 900 * Math.sin(2.0) - 2, 2200, -2500 + 900 * Math.cos(2.0)]),
            // Past the six-per-frame cap: ignored.
            hit('a3', [1860, 1120, -3070]),
            hit('a4', [1980, 1160, -3160]),
        ] } },
        { frame: 30, ev: { kind: 'hits', hits: [hit('a2', [2500 + 900 * Math.sin(1.9), 2200, -2500 + 900 * Math.cos(1.9)])] } },
        { frame: 60, ev: { kind: 'debugLeak', id: 'a2' } },
        { frame: 100, ev: { kind: 'hits', hits: [3, 4, 5, 6, 7, 8].map(k => hit(`a${k}`, [1500 + 120 * k + 1, 1000 + 40 * k, -2800 - 90 * k])) } },
        { frame: 101, ev: { kind: 'hits', hits: [hit('a9', [1500 + 120 * 9, 1000 + 40 * 9 + 2, -2800 - 90 * 9])] } },
        { frame: 250, ev: { kind: 'hits', hits: [hit('a1', [2000 + 600 * Math.sin(1.55), 1500, -3000 + 600 * Math.cos(1.55)])] } },
        { frame: 335, ev: { kind: 'crashPlume', id: 'a1' } },
        { frame: 336, ev: { kind: 'crashPlume', id: 'a1' } },
        { frame: 340, ev: { kind: 'crashPlume', id: 'nobody' } },
    ];
    return {
        name: 'airborne_hits',
        seed: 0xA1B0E5,
        dt: 1 / 30,
        frames: 480,
        palette: 'noon',
        ground: { kind: 'wavy', base: 10, sx: 0.001, sz: -0.0005, amp: 2 },
        surfaceProbe: false,
        marks: true,
        targets,
        anchors: [],
        events,
        camera: { c0: [2300, 1700, -2300], cv: [1.5, -0.5, -2] },
        dumps: [3, 120, 333, 479],
    };
}

function groundCrash(): Scenario {
    const impact = [100, 0, -50];
    const ground: GroundScript = { kind: 'wavy', base: 4, sx: 0.01, sz: -0.004, amp: 0.6 };
    const g = (x: number, z: number) => groundAt(ground, undefined, x, z);
    const events: { frame: number; ev: Ev }[] = [
        { frame: 0, ev: { kind: 'hits', hits: [hit('p', [impact[0], g(impact[0], impact[2]) + 2, impact[2]])] } },
        { frame: 2, ev: { kind: 'crashPlume', id: 'p' } },
        { frame: 10, ev: { kind: 'fireball', position: [impact[0], g(impact[0], impact[2]) + 1, impact[2]], velocity: [5, -30, 90], severity: 1.1 } },
        { frame: 10, ev: { kind: 'firePool', position: [impact[0], g(impact[0], impact[2]), impact[2]], velocity: [5, -30, 90], severity: 1.1 } },
        { frame: 10, ev: { kind: 'dust', position: [impact[0], g(impact[0], impact[2]), impact[2]], velocity: [5, -30, 90], count: 60, strength: 1.1 } },
        { frame: 10, ev: { kind: 'anchored', anchor: 0, targetId: 'p', rate: 44, life: 120, small: false, trickle: 60, drips: 9 } },
        { frame: 10, ev: { kind: 'anchored', anchor: 1, targetId: 'p', rate: 15, life: 60, small: true, trickle: 30, drips: 3 } },
        { frame: 10, ev: { kind: 'anchored', anchor: 2, targetId: 'p', rate: 26, life: 8.5, small: true, trickle: 14, drips: 0 } },
        { frame: 12, ev: { kind: 'anchored', anchor: 3, targetId: 'p', rate: 15, life: Infinity, small: true } },
        { frame: 600, ev: { kind: 'firePool', position: [600, g(600, 300), 300], velocity: [0, -10, 0], severity: 0.3 } },
        { frame: 600, ev: { kind: 'anchored', anchor: 4, targetId: 'q', rate: 20, life: 30, small: false, trickle: 10, drips: 12 } },
    ];
    // A burning scratch laid along the slide, and some that burn out inside the run.
    for (let k = 0; k < 12; k++) {
        const z = impact[2] + 6 + 5 * k;
        events.push({ frame: 40 + 4 * k, ev: { kind: 'burnSpot', position: [impact[0] + (k % 3) - 1, g(impact[0], z), z], life: 6 + 1.5 * k, intensity: 0.5 + 0.04 * k } });
    }
    // Scrapes as the airframe slides: over dirt, concrete and water by x.
    for (let k = 0; k < 10; k++) {
        const x = [100, 160, -450, 230][k % 4];
        const z = -40 + 4 * k;
        events.push({ frame: 15 + 5 * k, ev: { kind: 'scrapes', hits: [
            hit('p', [x, g(x, z), z], k % 3 === 0 ? 25 : 5, 'scrape', k % 2 === 0),
            hit('p', [x + 1, g(x + 1, z), z], 5, 'gun'),
        ] } });
    }
    events.push({ frame: 450, ev: { kind: 'rebase', rotation: rot(0.004, 0.012, -0.003), offset: [-1500, 2.5, 900] } });
    return {
        name: 'ground_crash',
        seed: 0xC2A5,
        dt: 1 / 30,
        frames: 900,
        palette: 'noon',
        ground,
        waterBelowX: -400,
        surfaceProbe: true,
        concrete: [150, 200],
        marks: true,
        targets: [{ id: 'p', cx: impact[0], cy: 30, cz: impact[2], r: 0, w: 0, phase: 0.7, bank: 0.1, deadAt: 0, crashedAt: 0, crashY: 6 }],
        anchors: [
            { kind: 'slide', x: impact[0], y: 7.2, z: impact[2], speed: 60, T: 5, dirX: 0.05, dirZ: 0.998749, from: 10 },
            { kind: 'fall', x: impact[0] + 4, y: 14, z: impact[2] + 3, vx: 9, vy: 6, vz: 25, floor: 6, from: 10, goneAt: 300 },
            { kind: 'fall', x: impact[0] - 2, y: 9, z: impact[2], vx: -22, vy: 14, vz: 30, floor: 4.5, from: 10 },
            { kind: 'fixed', x: impact[0] - 15, y: 5.5, z: impact[2] + 8, from: 12 },
            { kind: 'slide', x: 600, y: 8, z: 300, speed: 25, T: 6, dirX: 0.6, dirZ: -0.8, from: 600 },
        ],
        events,
        camera: { c0: [60, 40, -160], cv: [0.02, 0.01, 0.1] },
        dumps: [11, 200, 449, 450, 899],
    };
}

function seaAndSurfaces(): Scenario {
    const events: { frame: number; ev: Ev }[] = [
        { frame: 0, ev: { kind: 'contact', position: [50, 0, 10], surface: 'dirt', count: 4, scale: 0.5 } },
        { frame: 0, ev: { kind: 'contact', position: [-50, 0, 10], surface: 'water', count: 4.4, scale: 1.7 } },
        { frame: 0, ev: { kind: 'contact', position: [80, 0, 10], surface: 'concrete', count: 0, scale: 0.1 } },
        { frame: 3, ev: { kind: 'splash', position: [-60, 0, 0], strength: 0.2 } },
        { frame: 3, ev: { kind: 'splash', position: [-80, 0, 20], strength: 1 } },
        { frame: 4, ev: { kind: 'splash', position: [-100, 0, -20], strength: 2.5 } },
        { frame: 6, ev: { kind: 'foam', position: [-70, 0, 5], radius: 4, count: 30 } },
        { frame: 7, ev: { kind: 'foam', position: [-90, 0, 15], radius: 0.1, count: 0.4 } },
        { frame: 8, ev: { kind: 'foam', position: [-110, 0, -5], radius: 25, count: 12.6 } },
        // A crash into the sea: the spray splashes and no lake forms.
        { frame: 20, ev: { kind: 'firePool', position: [-150, 0, 0], velocity: [0, -40, 100], severity: 1 } },
        // Wreckage burning over the sea, shedding fuel that splashes.
        { frame: 25, ev: { kind: 'anchored', anchor: 0, targetId: 'w', rate: 10, life: 40, small: true, drips: 10 } },
        // A crash at the shore: some fuel lands on the beach, some in the sea.
        { frame: 40, ev: { kind: 'firePool', position: [3, 0, 60], velocity: [-30, -20, 10], severity: 0.8 } },
        { frame: 40, ev: { kind: 'anchored', anchor: 1, targetId: 'w2', rate: 20, life: 30, small: false, trickle: 8, drips: 9 } },
        { frame: 60, ev: { kind: 'scrapes', hits: [hit('w', [30, 0, 0], 25, 'scrape', false), hit('w', [-30, 0, 0], 2, 'scrape', true)] } },
        { frame: 150, ev: { kind: 'surfaceProbe', on: true } },
        { frame: 151, ev: { kind: 'scrapes', hits: [
            hit('w', [-10, 0, 0], 0, 'scrape', true), hit('w', [10, 0, 0], 0, 'scrape', true),
            hit('w', [2000, 0, 0], 30, 'scrape', false), hit('w', [12, 0, 4], 0, 'scrape', false),
            hit('w', [14, 0, 4], 0, 'scrape', true), hit('w', [16, 0, 4], 0, 'scrape', true),
            hit('w', [18, 0, 4], 0, 'scrape', true),
        ] } },
        { frame: 160, ev: { kind: 'burnSpot', position: [-20, 0, 30], life: 3, intensity: 1 } },
        { frame: 160, ev: { kind: 'burnSpot', position: [20, 0, 30], life: 3, intensity: 1 } },
    ];
    return {
        name: 'sea_and_surfaces',
        seed: 0x5EA,
        dt: 1 / 30,
        frames: 300,
        palette: 'midnight',
        ground: { kind: 'wavy', base: 0, sx: 0, sz: 0, amp: 0 },
        waterBelowX: 0,
        surfaceProbe: false,
        concrete: [1000, 3000],
        marks: true,
        targets: [],
        anchors: [
            { kind: 'fixed', x: -120, y: 3, z: 10, from: 25 },
            { kind: 'slide', x: 8, y: 1.5, z: 60, speed: 12, T: 4, dirX: -1, dirZ: 0, from: 40 },
        ],
        events,
        camera: { c0: [-60, 120, 200], cv: [0, 0, -0.2] },
        dumps: [0, 9, 45, 299],
    };
}

function carrierDeck(): Scenario {
    const deck: DeckScript = { y: 18, xMin: -20, xMax: 20, vxAmp: 3, vz: -15 };
    const events: { frame: number; ev: Ev }[] = [
        { frame: 0, ev: { kind: 'fireball', position: [0, 18.5, 40], velocity: [0, -5, -60], severity: 0.6 } },
        { frame: 0, ev: { kind: 'firePool', position: [0, 18, 40], velocity: [0, -5, -60], severity: 0.6 } },
        { frame: 0, ev: { kind: 'anchored', anchor: 0, targetId: 'c', rate: 44, life: 90, small: false, trickle: 40, drips: 9 } },
        // A wing tumbling off the deck edge into the sea, still burning.
        { frame: 0, ev: { kind: 'anchored', anchor: 1, targetId: 'c', rate: 15, life: 25, small: true, trickle: 10, drips: 3 } },
        { frame: 5, ev: { kind: 'burnSpot', position: [2, 18, 30], life: 12, intensity: 1 } },
        { frame: 5, ev: { kind: 'burnSpot', position: [40, 0, 30], life: 12, intensity: 0.7 } },
        { frame: 8, ev: { kind: 'contact', position: [1, 18, 35], surface: 'concrete', count: 5, scale: 1 } },
        { frame: 300, ev: { kind: 'firePool', position: [-5, 18, -60], velocity: [0, 0, 0], severity: 0.3 } },
    ];
    return {
        name: 'carrier_deck',
        seed: 0xDEC4,
        dt: 1 / 30,
        frames: 600,
        palette: 'noon',
        ground: { kind: 'deck', deck: true },
        waterBelowX: 1e9,
        deck,
        surfaceProbe: true,
        concrete: [1e9, 1e9],
        marks: true,
        targets: [],
        anchors: [
            { kind: 'deck', x: 0, y: 20, z: 45, from: 0 },
            { kind: 'fall', x: 15, y: 20, z: 40, vx: 6, vy: 2, vz: -10, floor: 0.5, from: 0 },
        ],
        events,
        camera: { c0: [80, 60, 120], cv: [0, 0, -0.5] },
        dumps: [1, 299, 599],
    };
}

function poolExpiry(): Scenario {
    const ground: GroundScript = { kind: 'wavy', base: 120, sx: -0.002, sz: 0.003, amp: 1.5 };
    const g = (x: number, z: number) => groundAt(ground, undefined, x, z);
    const events: { frame: number; ev: Ev }[] = [
        { frame: 0, ev: { kind: 'hits', hits: [hit('x', [5000, g(5000, 5000) + 3, 5000])] } },
        { frame: 1, ev: { kind: 'firePool', position: [5000, g(5000, 5000), 5000], velocity: [70, -50, 0], severity: 1.5 } },
        { frame: 1, ev: { kind: 'anchored', anchor: 0, targetId: 'x', rate: 44, life: 150, small: false, trickle: 30, drips: 9 } },
        { frame: 1, ev: { kind: 'anchored', anchor: 1, targetId: 'x', rate: 10, life: Infinity, small: true, drips: 2 } },
        { frame: 2, ev: { kind: 'burnSpot', position: [5010, g(5010, 5003), 5003], life: 40, intensity: 0.9 } },
        { frame: 760, ev: { kind: 'reset' } },
        { frame: 770, ev: { kind: 'contact', position: [5000, g(5000, 5000), 5000], surface: 'dirt', count: 6, scale: 1 } },
        { frame: 771, ev: { kind: 'firePool', position: [5100, g(5100, 5000), 5000], velocity: [0, -5, 0], severity: 0.5 } },
    ];
    return {
        name: 'pool_expiry_nightvision',
        seed: 0x900F,
        dt: 0.25,
        frames: 800,
        palette: 'nightvision',
        ground,
        surfaceProbe: false,
        marks: true,
        targets: [{ id: 'x', cx: 5000, cy: 400, cz: 5000, r: 0, w: 0, phase: 1.1, bank: 0, deadAt: 0, crashedAt: 0, crashY: 123, goneAt: 3 }],
        anchors: [
            { kind: 'slide', x: 5000, y: 123, z: 5000, speed: 70, T: 3, dirX: 1, dirZ: 0, from: 1 },
            { kind: 'fixed', x: 4995, y: 122, z: 5004, from: 1 },
        ],
        events,
        camera: { c0: [5200, 300, 5200], cv: [0, 0, 0] },
        dumps: [20, 400, 690, 759, 772],
    };
}

/** A unit quaternion from a small rotation vector (x, y, z) about which it turns by its length. */
function rot(x: number, y: number, z: number): number[] {
    const s = [x, y, z, 1];
    const n = Math.hypot(...s);
    return s.map(v => v / n);
}

// ---------------------------------------------------------------- the run

function runScenario(sc: Scenario) {
    const palette = PALETTES[sc.palette];
    // Built before Math.random is swapped: three.js draws it for object UUIDs.
    const field = new DamageSmokeField(stubMaterials);
    const f = field as Any;
    let frame = 0;
    let shift: FrameShift | undefined;
    const time = () => frame * sc.dt;

    const carryPoint = (v: THREE.Vector3) => { if (shift) shift.point(v); return v; };

    const pose = (t: TargetScript): DamageSmokePose | undefined => {
        if (t.goneAt !== undefined && frame >= t.goneAt) {
            return undefined;
        }
        const crashed = t.crashedAt !== undefined && frame >= t.crashedAt;
        const tt = crashed ? t.crashedAt! * sc.dt : time();
        const a = t.phase + t.w * tt;
        const position = new THREE.Vector3(t.cx + t.r * Math.sin(a), crashed ? t.crashY! : t.cy, t.cz + t.r * Math.cos(a));
        const quaternion = new THREE.Quaternion().setFromAxisAngle(UP, a + Math.PI / 2)
            .multiply(new THREE.Quaternion().setFromAxisAngle(FWD, t.bank));
        const velocity = crashed
            ? new THREE.Vector3(0, 0, 0)
            : new THREE.Vector3(t.r * t.w * Math.cos(a), 0, -t.r * t.w * Math.sin(a));
        if (shift) {
            shift.point(position);
            shift.orientation(quaternion);
            shift.vector(velocity);
        }
        return {
            position, quaternion, velocity,
            isAlive: t.deadAt === undefined || frame < t.deadAt,
            isCrashed: crashed,
        };
    };
    field.setPoseProvider(id => {
        const t = sc.targets.find(x => x.id === id);
        return t ? pose(t) : undefined;
    });

    const anchorAt = (a: AnchorScript, out: THREE.Vector3): boolean => {
        if (a.goneAt !== undefined && frame >= a.goneAt) {
            return false;
        }
        const t = (frame - a.from) * sc.dt;
        switch (a.kind) {
            case 'slide': {
                const d = t < a.T ? a.speed * (t - t * t / (2 * a.T)) : a.speed * a.T / 2;
                out.set(a.x + a.dirX * d, a.y, a.z + a.dirZ * d);
                break;
            }
            case 'fall':
                out.set(a.x + a.vx * t, Math.max(a.floor, a.y + a.vy * t - 4.903325 * t * t), a.z + a.vz * t);
                break;
            case 'fixed':
                out.set(a.x, a.y, a.z);
                break;
            case 'deck':
                out.set(a.x, a.y, a.z + sc.deck!.vz * t);
                break;
        }
        carryPoint(out);
        return true;
    };

    field.setGroundHeightAt((x, z) => groundAt(sc.ground, sc.deck, x, z));
    const isWater = (x: number, _z: number) =>
        sc.waterBelowX !== undefined && x < sc.waterBelowX && !(sc.deck && x >= sc.deck.xMin && x <= sc.deck.xMax);
    if (sc.waterBelowX !== undefined) {
        field.setWaterTest((x, z) => isWater(x, z));
    }
    const surfaceKind = (x: number, z: number): 'dirt' | 'water' | 'concrete' => {
        if (sc.deck && x >= sc.deck.xMin && x <= sc.deck.xMax) {
            return 'concrete';
        }
        if (isWater(x, z)) {
            return 'water';
        }
        if (sc.concrete && x >= sc.concrete[0] && x <= sc.concrete[1]) {
            return 'concrete';
        }
        return 'dirt';
    };
    if (sc.surfaceProbe) {
        field.surfaceAt = surfaceKind;
    }
    const deckVel = new THREE.Vector3();
    if (sc.deck) {
        const d = sc.deck;
        field.setMovingSurface({ velocity: deckVel, contains: (x, y) => deckContains(d, x, y) });
    }

    let poolMarks: number[][] = [];
    let burnMarks: number[][] = [];
    if (sc.marks) {
        field.onPoolMark = (p, dirX, dirZ, length, width, char) => {
            poolMarks.push([p.x, p.y, p.z, dirX, dirZ, length, width, char ? 1 : 0]);
        };
        field.onBurnMark = (p, radius, strength, grow) => {
            burnMarks.push([p.x, p.y, p.z, radius, strength, grow]);
        };
    }

    const v = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
    const camera = { position: new THREE.Vector3() };
    const dumps = new Set(sc.dumps);

    const rng = new Rng(sc.seed);
    const saved = Math.random;
    let draws = 0;
    Math.random = () => {
        draws++;
        return rng.next();
    };
    try {
        const frames = [];
        let maxCount = 0;
        let marksShown = 0;
        for (frame = 0; frame < sc.frames; frame++) {
            poolMarks = [];
            burnMarks = [];
            if (sc.deck) {
                deckVel.copy(deckVelocity(sc.deck, time()));
            }
            for (const { ev } of sc.events.filter(e => e.frame === frame)) {
                switch (ev.kind) {
                    case 'hits': field.spawnFromHits(ev.hits); break;
                    case 'scrapes': field.spawnGroundScrapes(ev.hits); break;
                    case 'debugLeak': field.spawnDebugLeak(ev.id); break;
                    case 'crashPlume': field.ensureCrashPlume(ev.id); break;
                    case 'fireball': field.spawnFireball(v(ev.position), v(ev.velocity), ev.severity); break;
                    case 'firePool': field.addFirePool(v(ev.position), v(ev.velocity), ev.severity); break;
                    case 'dust': field.spawnDust(v(ev.position), v(ev.velocity), ev.count, ev.strength); break;
                    case 'splash': field.spawnSplash(v(ev.position), ev.strength); break;
                    case 'foam': field.spawnFoam(v(ev.position), ev.radius, ev.count); break;
                    case 'contact': field.spawnContactPuffs(v(ev.position), ev.surface, ev.count, ev.scale); break;
                    case 'burnSpot': field.addBurnSpot(v(ev.position), ev.life, ev.intensity); break;
                    case 'anchored': {
                        const a = sc.anchors[ev.anchor];
                        field.addAnchoredFire(ev.targetId, out => anchorAt(a, out), {
                            rate: ev.rate, life: ev.life, small: ev.small, trickle: ev.trickle, drips: ev.drips,
                        });
                        break;
                    }
                    case 'rebase': {
                        const s = new FrameShift(
                            new THREE.Quaternion(ev.rotation[0], ev.rotation[1], ev.rotation[2], ev.rotation[3]),
                            v(ev.offset));
                        field.rebase(s);
                        shift = s;
                        break;
                    }
                    case 'reset': field.reset(); break;
                    case 'surfaceProbe': field.surfaceAt = ev.on ? surfaceKind : undefined; break;
                }
            }
            field.update(sc.dt);
            camera.position.set(
                sc.camera.c0[0] + sc.camera.cv[0] * frame,
                sc.camera.c0[1] + sc.camera.cv[1] * frame,
                sc.camera.c0[2] + sc.camera.cv[2] * frame);
            f.syncPuffs(camera, palette);

            const n = f.puffs.count as number;
            maxCount = Math.max(maxCount, n);
            const matrices = f.puffs.instanceMatrix.array as Float32Array;
            const level = f.puffLevel.array as Float32Array;
            const toneA = f.puffToneA.array as Float32Array;
            const toneB = f.puffToneB.array as Float32Array;
            const flags: number[] = [];
            const particles = f.system.particles as { isActive: boolean }[];
            for (let i = 0; i < particles.length; i++) {
                if (particles[i].isActive) {
                    flags.push(f.dustFlags[i]);
                }
            }
            const pools = f.pools as { active: boolean; trail: unknown[] }[];
            const drops = (f.fuelDrops as { active: boolean }[]).filter(d => d.active).length;
            const leaks = (f.leaks as { active: boolean }[]).filter(l => l.active).length;
            const anchored = (f.anchored as { active: boolean }[]).filter(a => a.active).length;
            const spots = (f.burnSpots as { active: boolean }[]).filter(s => s.active).length;
            const rec: Record<string, unknown> = {
                draws,
                count: n,
                matrices: hashF32(matrices, n * 16),
                level: hashF32(level, n),
                toneA: hashF32(toneA, n * 3),
                toneB: hashF32(toneB, n * 3),
                flags: hex32(fnv1a32(Uint8Array.from(flags))),
                state: [
                    leaks, anchored, spots, drops,
                    pools.filter(p => p.active).length,
                    pools.reduce((s, p) => s + (p.active ? p.trail.length : 0), 0),
                ],
            };
            // The mark streams: counts and an FNV-1a hash over the rows as float64, the rows
            // themselves for the scenario's first few marks.
            if (poolMarks.length > 0 || burnMarks.length > 0) {
                rec.marks = [poolMarks.length, burnMarks.length, hashF64([...poolMarks, ...burnMarks].flat())];
                if (marksShown < 40) {
                    rec.poolMarks = poolMarks;
                    rec.burnMarks = burnMarks;
                    marksShown += poolMarks.length + burnMarks.length;
                }
            }
            if (dumps.has(frame)) {
                const k = Math.min(n, 6);
                rec.dump = {
                    matrices: arr(matrices.subarray(0, k * 16)),
                    level: arr(level.subarray(0, k)),
                    toneA: arr(toneA.subarray(0, k * 3)),
                    toneB: arr(toneB.subarray(0, k * 3)),
                    flags: flags.slice(0, 64),
                };
            }
            frames.push(rec);
        }
        return { name: sc.name, seed: sc.seed, maxCount, frames };
    } finally {
        Math.random = saved;
    }
}

/** The scenario as the C# replay reads it (no closures). */
function scenarioInput(sc: Scenario) {
    return {
        name: sc.name,
        seed: sc.seed,
        dt: sc.dt,
        frames: sc.frames,
        palette: sc.palette,
        ground: sc.ground,
        waterBelowX: sc.waterBelowX ?? null,
        deck: sc.deck ?? null,
        surfaceProbe: sc.surfaceProbe,
        concrete: sc.concrete ?? null,
        marks: sc.marks,
        targets: sc.targets,
        anchors: sc.anchors,
        events: sc.events.map(e => ({ frame: e.frame, ...e.ev })),
        camera: sc.camera,
    };
}

export function damageSmokeSuite(): SuiteOutput {
    const scenarios = [airborneHits(), groundCrash(), seaAndSurfaces(), carrierDeck(), poolExpiry()];
    return {
        files: [{
            file: 'damage_smoke.json',
            data: {
                suite: 'damageSmoke',
                version: 1,
                source: [
                    'src/script/scene/entities/damageSmokeField.ts',
                    'src/script/physics/particles/particleSystem.ts',
                    'src/script/physics/particles/emitters/pointEmitter.ts',
                ],
                notes: 'Math.random = mulberry32(seed), counted in `draws`. Per frame f (t = f*dt): set the deck velocity '
                    + '(vxAmp sin(0.05 t), 0, vz); apply the events of frame f in order; update(dt); syncPuffs(camera '
                    + 'c0 + cv*f, palette). Poses: a = phase + w*t (t frozen at crashedAt), position (cx + r sin a, cy or '
                    + 'crashY, cz + r cos a), quaternion axisAngle(Y, a + PI/2) * axisAngle(Z, bank), velocity '
                    + '(r w cos a, 0, -r w sin a) or 0 once crashed; isAlive f < deadAt; undefined from goneAt. Anchors '
                    + '(t = (f - from)*dt, false from goneAt): slide d = t < T ? speed (t - t^2/(2T)) : speed T/2 along '
                    + '(dirX, 0, dirZ); fall (x + vx t, max(floor, y + vy t - 4.903325 t^2), z + vz t); fixed; deck '
                    + '(x, y, z + vz t). After a rebase, pose position/orientation/velocity and anchor points are carried '
                    + 'through that FrameShift. Ground: wavy base + sx x + sz z + amp sin(0.05 x) cos(0.04 z); deck: '
                    + 'deck.y on xMin..xMax else 0. Water test (when waterBelowX is set): x < waterBelowX and not on the '
                    + 'deck strip. Surface probe: deck strip concrete, water, concrete range, else dirt. Deck contains '
                    + '|y - deck.y| < 3 and x on the strip. Hashes: FNV-1a over the float32 prefix of instanceMatrix '
                    + '(16 per puff), ditherLevel, toneA, toneB; flags = the live puffs\' kind bytes in slot order. '
                    + 'state = [active leaks, anchored fires, burn spots, fuel drops in flight, active pools, pool points]. '
                    + 'marks = [pool marks, burn marks, FNV-1a over the rows as float64, pool rows first]; pool rows [x, y, z, dirX, dirZ, length, width, char], burn rows [x, y, z, radius, strength, grow] (written out in full for the first ~40 marks).',
                tolerances: { float32: 'exact', doubles: 'exact (marks), state exact' },
                scenarios: scenarios.map(sc => ({ input: scenarioInput(sc), output: runScenario(sc) })),
            },
        }],
    };
}
