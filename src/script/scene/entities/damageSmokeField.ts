import * as THREE from 'three';
import { FrameShift } from '../../terrain/geodesy';
import { Palette, PaletteCategory, PaletteColor, PaletteColorShade } from '../../config/palettes/palette';
import { DAMAGE_SMOKE_PARTICLE_COUNT } from '../../defs';
import { PointEmitter } from '../../physics/particles/emitters/pointEmitter';
import { ParticleSystem } from '../../physics/particles/particleSystem';
import { SimHitEvent } from '../../physics/sim/simTypes';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { SceneMaterialManager, SceneMaterialPrimitiveType } from '../materials/materials';
import { updateUniforms } from '../utils';
import { MovingSurface } from './movingSurface';
import { Entity } from '../entity';
import { Scene, SceneLayers } from '../scene';
import { attachToRenderList } from '../../render/renderList';
import { clamp, lerp } from '../../utils/math';

/** Steady upward rise (m/s). */
const RISE_MPS = 20;
/** Small random horizontal drift (m/s). */
const DRIFT_MPS = 0.9;
/** How long a leak keeps emitting after the last hit while still alive (s). */
const LEAK_EMIT_DURATION_SEC = 14;
/**
 * Base emit rate at low speed (puffs/s). Sized with the pool so a cruising
 * aircraft's ~30 s of puffs fit without recycling the tail early.
 */
const LEAK_EMIT_RATE = 8;
/** At this airspeed (m/s), emit rate is ~2× base; scales linearly with speed. */
const SPEED_REF_MPS = 80;
/** Ground wreck plume — denser than in-flight. */
const CRASH_EMIT_RATE = 40;
const MAX_LEAKS = 8;
const MAX_HITS_PER_FRAME = 6;

const FLAME_DITHER = 0.75;
const SMOKE_DITHER_START = 0.72;
/** End of puff — near-zero (not 0: that disables dithering) so the tail vanishes. */
const SMOKE_DITHER_END = 0.02;
/**
 * Life fraction still on fire (yellow→red). Kept short so longer puff life
 * mostly adds gray smoke, not more flame.
 */
const FIRE_PHASE_END = 0.12;
/** How much of the start→end size growth happens during the fire phase. */
const FIRE_SIZE_GROWTH = 0.1;
/**
 * Flame ramp, as heat 0..1 over a puff's flame phase: yellow, orange, red,
 * dark red, then gray smoke. (The palette's own fire colours are only the
 * yellow and the orange; the reds are derived, see cachePaletteColors.)
 */
const FIRE_RAMP_HEAT = [0, 0.18, 0.4, 0.65, 0.85];
/** How far ahead on the ramp the second dither tone runs. */
const FIRE_TONE_B_LEAD = 0.14;
/** Chance that a fire puff is pure black instead of flame-coloured. */
const BLACK_PUFF_CHANCE = 0.09;
/** How far ahead on the smoke ramp (0..1 of its age) the second dither tone runs. */
const SMOKE_TONE_B_LEAD = 0.2;
/** Chance that a fire puff is plain gray smoke from the start, with no flame stage. */
const SMOKE_PUFF_CHANCE = 0.16;

/** After a pure smoke or black puff the emitter holds off for this long (s), so the stream breaks. */
const SMOKE_GAP_MIN_S = 0.12;
const SMOKE_GAP_VARIATION_S = 0.22;

/**
 * How a fire ages. `burn` is the fraction of its life left (1 fresh, 0 out):
 * the share of its puffs that are still flame falls with it, the stream thins,
 * and the breaks between puffs get longer and more frequent.
 */
const BURN_OUT_FLAME_BELOW = 0.08;
/** Emission left at the very end, as a fraction of the fresh rate. */
const BURN_MIN_RATE = 0.12;
/** Extra breaks per second as the fire dies (on top of those after smoke puffs). */
const BURN_RANDOM_BREAKS_PER_S = 1.4;
/** A gap grows to this many times its length by the time the fire is out. */
const BURN_GAP_GROWTH = 5;

function flameShare(burn: number): number {
    return clamp((burn - BURN_OUT_FLAME_BELOW) / (1 - BURN_OUT_FLAME_BELOW), 0, 1);
}

function burnRate(burn: number): number {
    return BURN_MIN_RATE + (1 - BURN_MIN_RATE) * clamp(burn, 0, 1);
}

function smokeGap(burn = 1): number {
    const growth = 1 + BURN_GAP_GROWTH * (1 - clamp(burn, 0, 1));
    return (SMOKE_GAP_MIN_S + Math.random() * SMOKE_GAP_VARIATION_S) * growth;
}

/**
 * Which kind a new fire puff is: 0 flame, 2 pure smoke, 3 pure black. As the
 * fire burns down (`flame` falling toward 0) flame puffs give way to smoke.
 */
function pickPuffKind(flame = 1, early = 0): number {
    if (Math.random() > flame) {
        return 2;
    }
    // A fresh fire is nearly all flame: smoke and black puffs are rarer.
    const calm = 1 - 0.7 * early;
    const r = Math.random();
    if (r < BLACK_PUFF_CHANCE * calm) {
        return 3;
    }
    return r < (BLACK_PUFF_CHANCE + SMOKE_PUFF_CHANCE) * calm ? 2 : 0;
}

/** How long a puff stays flame-coloured at most, in seconds (short-lived puffs: up to half their life). */
const FIRE_COLOUR_SECONDS = 4.2;

export type DamageSmokePose = {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    velocity: THREE.Vector3;
    /** False after the killing blow — leak keeps emitting until reset. */
    isAlive: boolean;
    /** True after ground impact — pin the emitter at the wreck. */
    isCrashed: boolean;
};

/** A fire riding on something that moves by itself (a wreck fragment). */
type AnchoredFire = {
    active: boolean;
    targetId: string;
    /** Writes the emitter's world position; false once its anchor is gone. */
    where: (out: THREE.Vector3) => boolean;
    rate: number;
    /** Seconds left; Infinity burns until reset. */
    remaining: number;
    life: number;
    /** Smaller flames and a shorter, thinner column. */
    small: boolean;
    accum: number;
    /** Burn marks owed to the ground under this fire. */
    markAccum: number;
    /** Burning fuel drops shed per second (fuselage and wing roots), and the part owed. */
    dripRate: number;
    dripAccum: number;
    /** Where the fire was last frame and how fast it is going, so drops carry its motion. */
    lastPos: THREE.Vector3;
    vel: THREE.Vector3;
    hasLast: boolean;
    /** Seconds left of the gap after a non-flame puff. */
    pause: number;
    /** Seconds of faint smoke left once the flames are out, and how long that lasts in all. */
    trickle: number;
    trickleLife: number;
};

/** Smoke puffs per second from a burnt-out fire at first, thinning as the trickle ends. */
const TRICKLE_RATE = 1.8;
const TRICKLE_RATE_SMALL = 0.8;

/** A patch of ground burning where a burning piece scratched it. */
type BurnSpot = {
    /** Seconds of faint smoke left once the flames are out, and how long that lasts in all. */
    trickle: number;
    trickleLife: number;
    active: boolean;
    position: THREE.Vector3;
    remaining: number;
    life: number;
    intensity: number;
    accum: number;
    markAccum: number;
    pause: number;
    /** On a moving surface: goes along with it. */
    moving: boolean;
};

/**
 * A lake of burning fuel laid along the path of the fuselage as it slides: a
 * point is dropped every few metres of travel and each spreads out into a
 * pool over a few seconds, so the lake widens behind the fuselage and stops
 * growing when the fuselage comes to rest. It burns for minutes, covered in
 * low overlapping flame with the odd column of black smoke standing over it.
 */
type PoolPoint = {
    position: THREE.Vector3;
    born: number;
    /** Direction of the path here, and the length of the stretch it stands for. */
    dirX: number;
    dirZ: number;
    segment: number;
    /** The wider scorch round the char has been laid (it follows as the pool spreads). */
    outer: boolean;
    /** Landed on a moving surface (a carrier deck): it goes along with it. */
    moving: boolean;
    /** Drops of fuel that have landed here: the puddle spreads out to a size that matches. */
    volume: number;
    /** How far the puddle has spread over the ground so far (m), and how far it was last charred to. */
    radiusNow: number;
    charRadius: number;
};

/** The wider scorch round a point's char appears once it has spread this long (s). */
const POOL_OUTER_SCORCH_AFTER_S = 2.5;

type FirePool = {
    active: boolean;
    /** Radius (m) each point spreads out to. */
    radius: number;
    strength: number;
    age: number;
    life: number;
    flameAccum: number;
    smokeAccum: number;
    /** Burn marks owed to the ground under the lake. */
    markAccum: number;
    trail: PoolPoint[];
    /** Where the crash happened: fuel that lands within reach of here (or of the lake) belongs to this lake. */
    origin: THREE.Vector3;
    originMoving: boolean;
    /** Direction of the last trail segment, for the ground scorch. */
    dirX: number;
    dirZ: number;
};

const MAX_FIRE_POOLS = 6;
const MAX_POOL_POINTS = 96;
/** A new point is dropped each time the fuselage has moved this far (m). */
const POOL_POINT_STEP_M = 2.5;
const POOL_LIFE_S = 170;
/** Time constant (s) for each point to spread out to its full radius. */
const POOL_SPREAD_S = 3.5;
/** Flame puffs per second for a lake of one point's area: this plus strength times the second. */
const POOL_FLAME_RATE = 63;
const POOL_FLAME_RATE_PER_STRENGTH = 84;
/** A long lake gets more flame, up to this many times that of one point. */
const POOL_MAX_AREA_FACTOR = 4;
/**
 * Most flame puffs per second the whole lake may put out. Flame puffs live a few
 * seconds, so this keeps a lake to some 1800 live puffs: plenty to cover a long
 * swath several times over, and it leaves the particle pool to the aircraft's own fires.
 */
const POOL_MAX_FLAME_RATE = 364;

/**
 * Burning fuel falling from the fuselage and the wing roots: a drop leaves the
 * fire carrying its motion, falls under gravity as a short trail of flame, and
 * where it lands it splashes and feeds the lake.
 */
type FuelDrop = {
    active: boolean;
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    trailTimer: number;
    /** Whether it leaves a streak of flame as it falls (the crash's spray only does for half its drops). */
    streak: boolean;
    /** Flame share of the fire it came from (1 fresh, falling to 0 as that fire burns down): its streak is smoke when the fire is nearly out. */
    flame: number;
    /** How fresh that fire was (1 right after the crash, falling to 0): a fresh fire is nearly all flame. */
    early: number;
};

const MAX_FUEL_DROPS = 160;
const FUEL_GRAVITY = 9.80665;
/** The crash's spray: this many drops plus this many per unit of crash strength, thrown with this share of the speed. */
const SPILL_DROPS_BASE = 24;
const SPILL_DROPS_PER_STRENGTH = 40;
const SPILL_CARRY = 0.1;
/** Seconds between flame puffs along a falling drop. */
const FUEL_TRAIL_INTERVAL_S = 0.09;
/** A fire shedding drops must be this far above the ground (m) to have a fall to show. */
const FUEL_MIN_FALL_M = 0.5;
/** A landing within this of the lake (m) is already part of it. */
const FUEL_MERGE_M = 4;
/**
 * A puddle of landed fuel creeps outward over the ground: it starts as a splash
 * of this radius (m), and spreads toward a radius of base + per-drop x the drops
 * that have landed there (never past the lake's own radius), with the time
 * constant POOL_SPREAD_S. The ground is charred in a new patch each time its
 * edge has moved out by the step.
 */
const FUEL_SPLASH_RADIUS_M = 1.2;
const FUEL_PUDDLE_BASE_M = 2.5;
const FUEL_PUDDLE_PER_DROP_M = 0.5;
const FUEL_CHAR_STEP_M = 1.5;
/** A landing is only added to a lake within this reach (m). */
const FUEL_FEED_REACH_M = 90;

/**
 * Burn marks laid on the ground under the fires while they burn. They start
 * invisible and darken over BURN_MARK_GROW_* seconds, so the ground blackens
 * gradually and keeps blackening for as long as the fire spreads or burns.
 * Marks per second: under a lake of one point's area (more for a long lake),
 * under the fuselage fire, a small fire, and a burning scratch.
 */
const POOL_BURN_MARK_RATE = 2.2;
const FIRE_BURN_MARK_RATE = 0.7;
const FIRE_BURN_MARK_RATE_SMALL = 0.3;
const SPOT_BURN_MARK_RATE = 0.12;
/** A fire this close above the ground (m) scorches it. */
const BURN_MARK_REACH_M = 4;
const BURN_MARK_GROW_MIN_S = 12;
const BURN_MARK_GROW_MAX_S = 35;
/** Black smoke columns per second from the pool at full burn. */
const POOL_SMOKE_RATE = 5;

const MAX_BURN_SPOTS = 48;
/** Wisps per second from a burnt-out scratch at first (scaled by its intensity). */
const SPOT_TRICKLE_RATE = 0.35;
/** Flame puffs per second at full strength from one spot. */
const BURN_SPOT_RATE = 6;

const _hsl = { h: 0, s: 0, l: 0 };

type ParticleLike = ParticleSystem['particles'][number];

const MAX_ANCHORED_FIRES = 24;

/**
 * A fresh fire is far fiercer than an old one: stream, puff size and height
 * start boosted and ease off with this time constant (s).
 */
const EARLY_BOOST_RATE = 5;
const EARLY_BOOST_RATE_SMALL = 2.4;
const EARLY_TAU_S = 16;
const EARLY_TAU_SMALL_S = 7;
const EARLY_BOOST_SPOT = 2.4;
const EARLY_TAU_SPOT_S = 5;
/** A fresh fire's puffs are this much bigger and taller than a settled fire's (x early). */
const EARLY_SIZE_START_BOOST = 1.3;
const EARLY_SIZE_END_BOOST = 0.7;
const EARLY_RISE_BOOST = 0.55;
const DUST_DITHER_START = 0.8;

type Leak = {
    active: boolean;
    targetId: string;
    localOffset: THREE.Vector3;
    emitRemaining: number;
    emitAccum: number;
    pause: number;
    /** Lethal damage or crash — never time out. */
    permanent: boolean;
    /** Ground impact — emit from pinPos instead of following the hull. */
    crashed: boolean;
    pinPos: THREE.Vector3;
    /** Last emitter world position (used if pose disappears). */
    lastEmitPos: THREE.Vector3;
};

/**
 * Hit fire/smoke: puffs spawn at the impact point on the airframe, rise at
 * {@link RISE_MPS}, drift sideways, and cool yellow → red → gray.
 */
export class DamageSmokeField implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    private readonly system: ParticleSystem;
    /**
     * Every puff in one draw: a wreck plume keeps hundreds alive, and a mesh
     * each was hundreds of draw calls. Live puffs are packed to the front in
     * particle order, the order the separate meshes were drawn in (by
     * material id), so overlaps resolve as before.
     */
    private readonly puffs: THREE.InstancedMesh;
    private readonly puffLevel: THREE.InstancedBufferAttribute;
    private readonly puffToneA: THREE.InstancedBufferAttribute;
    private readonly puffToneB: THREE.InstancedBufferAttribute;
    private readonly puffPose = new THREE.Object3D();
    private readonly root = new THREE.Object3D();
    private readonly leaks: Leak[] = [];
    private readonly anchored: AnchoredFire[] = [];
    private readonly burnSpots: BurnSpot[] = [];
    private nextBurnSpot = 0;
    private readonly pools: FirePool[] = [];
    private nextPool = 0;
    /** Ground that moves under the fire (a carrier deck), if any. */
    private movingSurface: MovingSurface | undefined;
    /** Whether a point is open water; fuel landing there splashes and is gone. */
    private isWaterAt: ((x: number, z: number) => boolean) | undefined;
    private readonly fuelDrops: FuelDrop[] = [];
    private nextFuelDrop = 0;
    private readonly dropPuffAt: THREE.Vector3[] = [];
    private readonly dropPuffFlame: number[] = [];
    private readonly dropPuffEarly: number[] = [];
    /**
     * Marks the ground where the lake burns: ground point, direction, length,
     * width, and whether it is the black char directly under the flames (true)
     * or the wider, lighter scorch round it (false).
     */
    onPoolMark?: (position: THREE.Vector3, dirX: number, dirZ: number, length: number, width: number, char: boolean) => void;
    /**
     * A burn mark under a fire: ground point, radius (m), how dark it ends up
     * 0..1, and seconds to darken. The mark should start invisible and come up.
     */
    onBurnMark?: (position: THREE.Vector3, radius: number, strength: number, growSeconds: number) => void;
    /** Ground height at a point, so the pool's flames sit on a sloping surface. */
    private groundHeightAt: ((x: number, z: number) => number) | undefined;
    /** Per particle slot: 0 = fire (then smoke), 1 = tan dust, 2 = gray smoke only, 3 = pure black, 4 = water spray, 5 = water mist, 6 = foam (lies flat). */
    private readonly dustFlags = new Uint8Array(DAMAGE_SMOKE_PARTICLE_COUNT);
    private poseProvider: ((targetId: string) => DamageSmokePose | undefined) | undefined;

    private readonly worldPos = new THREE.Vector3();
    private readonly localOffset = new THREE.Vector3();
    private readonly invQuat = new THREE.Quaternion();
    private readonly tmpColor = new THREE.Color();
    private readonly tmpColorB = new THREE.Color();
    private readonly yellow = new THREE.Color();
    private readonly orange = new THREE.Color();
    private readonly red = new THREE.Color();
    private readonly darkRed = new THREE.Color();
    private readonly black = new THREE.Color(0x000000);
    private readonly rampA: THREE.Color[] = [];
    private readonly rampB: THREE.Color[] = [];
    private readonly smoke = new THREE.Color();
    private readonly smokeB = new THREE.Color();
    private readonly smokeC = new THREE.Color();
    /** Where the second dither tone sits on the smoke ramp for a fresh smoke puff. */
    private readonly smokeLead = new THREE.Color();
    private readonly dust = new THREE.Color();
    private readonly dustB = new THREE.Color();
    /** Dust off concrete and asphalt: gray. */
    private readonly concreteA = new THREE.Color();
    private readonly concreteB = new THREE.Color();
    private readonly white = new THREE.Color(1, 1, 1);
    /** Water: the column of spray thrown up by a splash, and the mist that lingers after. */
    private readonly sprayA = new THREE.Color();
    private readonly sprayB = new THREE.Color();
    private readonly mistA = new THREE.Color();
    private readonly mistB = new THREE.Color();
    /** Foam lying on the water round a piece in it. */
    private readonly foamA = new THREE.Color();
    private readonly foamB = new THREE.Color();

    rebase(shift: FrameShift): void {
        this.system.rebase(shift);
        for (const leak of this.leaks) {
            shift.point(leak.pinPos);
            shift.point(leak.lastEmitPos);
        }
        for (const spot of this.burnSpots) {
            shift.point(spot.position);
        }
        for (const drop of this.fuelDrops) {
            shift.point(drop.position);
            shift.vector(drop.velocity);
        }
        for (const fire of this.anchored) {
            shift.point(fire.lastPos);
            shift.vector(fire.vel);
        }
        for (const pool of this.pools) {
            shift.point(pool.origin);
            for (const point of pool.trail) {
                shift.point(point.position);
            }
        }
    }

    setWaterTest(fn: ((x: number, z: number) => boolean) | undefined): void {
        this.isWaterAt = fn;
    }

    /**
     * A splash where something heavy went into the water: a column of white spray
     * thrown up, and a mist that spreads over the surface and lingers. Harder
     * for a faster or bigger piece (strength 0.2 .. 1.6).
     */
    spawnSplash(position: THREE.Vector3, strength: number): void {
        const s = clamp(strength, 0.15, 1.6);
        this.worldPos.copy(position);
        this.system.position = this.worldPos;
        this.burstTagged(Math.round(8 + 22 * s), 4, (p) => {
            const a = Math.random() * Math.PI * 2;
            const out = (1 + Math.random() * 4) * (0.5 + 0.6 * s);
            p.velocity.set(Math.cos(a) * out, (4 + Math.random() * 10) * (0.5 + 0.6 * s), Math.sin(a) * out);
            p.lifespan = 1.0 + Math.random() * 0.9;
            p.sizeStart = (0.9 + Math.random() * 1.2) * (0.7 + 0.5 * s);
            p.sizeEnd = (3 + Math.random() * 3) * (0.7 + 0.5 * s);
        });
        this.burstTagged(Math.round(6 + 14 * s), 5, (p) => {
            const a = Math.random() * Math.PI * 2;
            const out = (2 + Math.random() * 6) * (0.6 + 0.5 * s);
            p.velocity.set(Math.cos(a) * out, 0.5 + Math.random() * 2, Math.sin(a) * out);
            p.lifespan = 3 + Math.random() * 2.5;
            p.sizeStart = (2.5 + Math.random() * 2) * (0.7 + 0.5 * s);
            p.sizeEnd = (10 + Math.random() * 7) * (0.7 + 0.5 * s);
        });
    }

    /**
     * Foam on the water round a piece in it: `count` flat white puffs scattered
     * over a patch about `radius` (m) across, drifting out a little and fading
     * over a few seconds. `position` is on the surface.
     */
    spawnFoam(position: THREE.Vector3, radius: number, count: number): void {
        const r = clamp(radius, 0.5, 10);
        this.worldPos.copy(position);
        this.system.position = this.worldPos;
        const at = new THREE.Vector3();
        this.burstTagged(Math.max(1, Math.round(count)), 6, (p) => {
            const a = Math.random() * Math.PI * 2;
            const d = Math.sqrt(Math.random()) * (r * 0.9 + 0.6);
            at.set(position.x + Math.cos(a) * d, position.y + 0.08, position.z + Math.sin(a) * d);
            p.position.copy(at);
            // Spreads out over the surface, going nowhere vertically.
            const out = 0.2 + Math.random() * 0.7;
            p.velocity.set(Math.cos(a) * out, 0, Math.sin(a) * out);
            p.lifespan = 2.6 + Math.random() * 1.8;
            const k = clamp(r / 3, 0.7, 1.6);
            p.sizeStart = (1.3 + Math.random() * 1.1) * k;
            p.sizeEnd = (3 + Math.random() * 2) * k;
        });
    }

    /** A lake of fuel and burning scratches laid on this surface go along with it. */
    setMovingSurface(surface: MovingSurface | undefined): void {
        this.movingSurface = surface;
    }

    setGroundHeightAt(fn: (x: number, z: number) => number): void {
        this.groundHeightAt = fn;
    }

    constructor(materials: SceneMaterialManager) {
        // Near-zero emitter kick — we set absolute plume velocity after burst.
        this.system = new ParticleSystem(
            {
                systemMaxParticles: DAMAGE_SMOKE_PARTICLE_COUNT,
                systemReSpawn: true,
                emitterSpawnRatePerSecond: 0,
                particleLifeMin: 22,
                particleLifeMax: 30,
                particleSizeStartMin: 0.8,
                particleSizeStartMax: 1.3,
                particleSizeEndMin: 16,
                particleSizeEndMax: 24,
                particleRotationStartMin: -Math.PI,
                particleRotationStartMax: Math.PI,
                particleRotationEndMin: -Math.PI * 1.2,
                particleRotationEndMax: Math.PI * 1.2,
            },
            new PointEmitter(0.02, 0.08),
        );

        const geo = new THREE.CircleGeometry(1, 6);
        const n = DAMAGE_SMOKE_PARTICLE_COUNT;
        this.puffLevel = new THREE.InstancedBufferAttribute(new Float32Array(n).fill(FLAME_DITHER), 1);
        this.puffToneA = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        this.puffToneB = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
        for (const attr of [this.puffLevel, this.puffToneA, this.puffToneB]) {
            attr.setUsage(THREE.DynamicDrawUsage);
        }
        geo.setAttribute('ditherLevel', this.puffLevel);
        geo.setAttribute('toneA', this.puffToneA);
        geo.setAttribute('toneB', this.puffToneB);
        const mat = materials.build({
            type: SceneMaterialPrimitiveType.MESH,
            category: PaletteCategory.FX_SMOKE,
            depthWrite: false,
            shaded: false,
            vertexAlphaDither: true,
            instanceTones: true,
            colorDither: true,
        });
        mat.side = THREE.DoubleSide;
        this.puffs = new THREE.InstancedMesh(geo, mat, n);
        this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.puffs.frustumCulled = false;
        this.puffs.count = 0;
        this.puffs.visible = false;
        this.puffs.onBeforeRender = updateUniforms;
        this.root.add(this.puffs);

        for (let i = 0; i < MAX_FUEL_DROPS; i++) {
            this.fuelDrops.push({
                active: false, position: new THREE.Vector3(), velocity: new THREE.Vector3(), trailTimer: 0, streak: true, flame: 1, early: 1,
            });
        }
        for (let i = 0; i < MAX_FIRE_POOLS; i++) {
            this.pools.push({
                active: false, radius: 1, strength: 1, age: 0, life: 1, flameAccum: 0, smokeAccum: 0,
                markAccum: 0, trail: [], origin: new THREE.Vector3(), originMoving: false, dirX: 0, dirZ: 1,
            });
        }
        for (let i = 0; i < MAX_BURN_SPOTS; i++) {
            this.burnSpots.push({
                active: false, position: new THREE.Vector3(), remaining: 0, life: 0, intensity: 0, accum: 0, markAccum: 0, pause: 0,
                moving: false, trickle: 0, trickleLife: 0,
            });
        }
        for (let i = 0; i < MAX_ANCHORED_FIRES; i++) {
            this.anchored.push({
                active: false, targetId: '', where: () => false, rate: 0,
                remaining: 0, life: 0, small: false, accum: 0, markAccum: 0, pause: 0, trickle: 0, trickleLife: 0,
                dripRate: 0, dripAccum: 0, lastPos: new THREE.Vector3(), vel: new THREE.Vector3(), hasLast: false,
            });
        }
        for (let i = 0; i < MAX_LEAKS; i++) {
            this.leaks.push({
                active: false,
                targetId: '',
                localOffset: new THREE.Vector3(),
                emitRemaining: 0,
                emitAccum: 0,
                pause: 0,
                permanent: false,
                crashed: false,
                pinPos: new THREE.Vector3(),
                lastEmitPos: new THREE.Vector3(),
            });
        }
    }

    setPoseProvider(provider: (targetId: string) => DamageSmokePose | undefined): void {
        this.poseProvider = provider;
    }

    spawnFromHits(hits: SimHitEvent[]): void {
        if (!this.poseProvider) {
            return;
        }
        const n = Math.min(hits.length, MAX_HITS_PER_FRAME);
        for (let i = 0; i < n; i++) {
            const hit = hits[i];
            if (hit.source === 'scrape') {
                continue;
            }
            const pose = this.poseProvider(hit.targetId);
            if (!pose) {
                continue;
            }
            this.worldPos.set(hit.position[0], hit.position[1], hit.position[2]);
            this.openLeak(hit.targetId, pose, this.worldPos);
        }
    }

    /**
     * Gray smoke puffs pinned at world impact points (terrain scrapes).
     * No hull leak / no fire phase — smoke only on the ground.
     */
    spawnGroundScrapes(hits: SimHitEvent[]): void {
        let spawned = 0;
        for (let i = 0; i < hits.length && spawned < MAX_HITS_PER_FRAME; i++) {
            const hit = hits[i];
            if (hit.source !== 'scrape') {
                continue;
            }
            this.worldPos.set(hit.position[0], hit.position[1], hit.position[2]);
            this.system.position = this.worldPos;
            if (this.surfaceAt) {
                // Dust of the surface it struck: brown ground, white water, gray concrete and asphalt.
                this.spawnContactPuffs(
                    this.worldPos, this.surfaceAt(hit.position[0], hit.position[2]),
                    hit.slide ? 2 : 4 + (hit.damage >= 20 ? 3 : 0), hit.slide ? 0.5 : 1);
            } else {
                this.emitGroundSmokePuffs(3 + (hit.damage >= 20 ? 3 : 0));
            }
            spawned++;
        }
    }

    /**
     * What the surface under a contact is: brown dust off the ground, white
     * spray off water, gray dust off concrete and asphalt. Set by the game.
     */
    surfaceAt: ((x: number, z: number) => 'dirt' | 'water' | 'concrete') | undefined;

    /**
     * A few small puffs thrown up at a contact point (`position`, on the surface):
     * dust coloured for the surface, spray over water. `scale` 1 is an impact, less a slide.
     */
    spawnContactPuffs(position: THREE.Vector3, surface: 'dirt' | 'water' | 'concrete', count: number, scale: number): void {
        this.worldPos.copy(position);
        this.system.position = this.worldPos;
        const s = clamp(scale, 0.2, 1.5);
        const kind = surface === 'water' ? 4 : surface === 'concrete' ? 7 : 1;
        this.burstTagged(Math.max(1, Math.round(count)), kind, (p) => {
            const a = Math.random() * Math.PI * 2;
            const out = (0.8 + Math.random() * 2.2) * (0.6 + 0.6 * s);
            p.velocity.set(Math.cos(a) * out, (0.6 + Math.random() * 2.2) * (0.6 + 0.6 * s), Math.sin(a) * out);
            p.lifespan = 0.9 + Math.random() * 0.9;
            // Dust stays in its dust phase for its life, so it keeps its colour.
            p.life = Math.max(p.life, FIRE_PHASE_END * p.lifespan + 1e-3);
            p.sizeStart = (0.35 + Math.random() * 0.4) * (0.7 + 0.6 * s);
            p.sizeEnd = (1.6 + Math.random() * 1.4) * (0.7 + 0.6 * s);
        });
    }

    /** Debug: open a leak near the aircraft origin. */
    spawnDebugLeak(targetId: string): void {
        const pose = this.poseProvider?.(targetId);
        if (!pose) {
            return;
        }
        this.worldPos.copy(pose.position);
        this.worldPos.y += 1;
        this.openLeak(targetId, pose, this.worldPos);
    }

    /**
     * Keep (or start) a pinned plume at the wreck after ground impact.
     * Safe to call every crash transition — does not reset an existing plume.
     */
    ensureCrashPlume(targetId: string): void {
        if (this.hasAnchored(targetId)) {
            return;
        }
        const pose = this.poseProvider?.(targetId);
        let slot = this.findLeak(targetId);
        if (!slot) {
            if (!pose) {
                return;
            }
            this.openLeak(targetId, pose, pose.position);
            slot = this.findLeak(targetId);
        }
        if (!slot) {
            return;
        }
        slot.permanent = true;
        if (pose) {
            this.localOffset.copy(slot.localOffset).applyQuaternion(pose.quaternion);
            this.worldPos.copy(pose.position).add(this.localOffset);
        } else {
            this.worldPos.copy(slot.lastEmitPos);
        }
        if (!slot.crashed) {
            slot.crashed = true;
            slot.pinPos.copy(this.worldPos);
        }
        slot.lastEmitPos.copy(slot.pinPos);
        slot.emitAccum = Math.max(slot.emitAccum, 2);
    }

    /**
     * Set a patch of ground alight for `life` seconds. The newest spots win
     * once the pool is full, so a long scratch burns at its fresh end.
     */
    addBurnSpot(position: THREE.Vector3, life: number, intensity: number): void {
        const spot = this.burnSpots[this.nextBurnSpot];
        this.nextBurnSpot = (this.nextBurnSpot + 1) % MAX_BURN_SPOTS;
        spot.active = true;
        spot.position.copy(position);
        spot.remaining = life;
        spot.life = life;
        spot.intensity = intensity;
        spot.accum = Math.random();
        spot.pause = 0;
        // After the flames, a faint wisp for as long again.
        spot.trickle = life;
        spot.trickleLife = life;
        spot.moving = this.movingSurface?.contains(position.x, position.y, position.z) ?? false;
    }

    /**
     * The fireball at the moment of impact: a big, fast burst of flame puffs
     * thrown out and up, bigger for a harder hit.
     */
    spawnFireball(position: THREE.Vector3, velocity: THREE.Vector3, severity: number): void {
        const s = clamp(severity, 0.2, 1.5);
        this.worldPos.copy(position);
        this.system.position = this.worldPos;
        this.burstTagged(Math.round(50 + 80 * s), 0, (p) => {
            const a = Math.random() * Math.PI * 2;
            const out = (4 + Math.random() * 14) * (0.6 + 0.5 * s);
            p.velocity.set(
                Math.cos(a) * out + velocity.x * 0.08,
                3 + Math.random() * 12 * (0.6 + 0.5 * s),
                Math.sin(a) * out + velocity.z * 0.08,
            );
            p.lifespan = 4 + Math.random() * 3;
            p.sizeStart = (3.5 + Math.random() * 3.5) * (0.7 + 0.5 * s);
            p.sizeEnd = (16 + Math.random() * 12) * (0.7 + 0.5 * s);
            // Nearly all flame: a fireball, not a smoke ring.
            return Math.random() < 0.05 ? 3 : 0;
        });
    }

    /** True once this aircraft's fires ride on its wreck fragments. */
    hasAnchored(targetId: string): boolean {
        return this.anchored.some(a => a.active && a.targetId === targetId);
    }

    /**
     * A fire that follows `where` (a wreck fragment) instead of staying pinned
     * to the crash spot. `life` is how long it burns, Infinity until reset.
     */
    addAnchoredFire(
        targetId: string, where: (out: THREE.Vector3) => boolean,
        opts: { rate: number; life: number; small: boolean; trickle?: number; drips?: number },
    ): void {
        const slot = this.anchored.find(a => !a.active);
        if (!slot) {
            return;
        }
        slot.active = true;
        slot.targetId = targetId;
        slot.where = where;
        slot.rate = opts.rate;
        slot.life = opts.life;
        slot.remaining = opts.life;
        slot.small = opts.small;
        slot.accum = 2;
        slot.pause = 0;
        slot.trickle = opts.trickle ?? 0;
        slot.trickleLife = opts.trickle ?? 0;
        slot.dripRate = opts.drips ?? 0;
        slot.dripAccum = 0;
        slot.hasLast = false;
    }

    /**
     * Tan dust thrown up at an impact or kicked up by a sliding piece. It
     * spreads along the ground, biased the way the piece was travelling.
     */
    spawnDust(position: THREE.Vector3, velocity: THREE.Vector3, count: number, strength: number): void {
        this.worldPos.copy(position);
        this.system.position = this.worldPos;
        const s = clamp(strength, 0.2, 1.5);
        this.burstTagged(count, 1, (p) => {
            const a = Math.random() * Math.PI * 2;
            const out = (3 + Math.random() * 9) * s;
            p.velocity.set(
                Math.cos(a) * out + velocity.x * 0.25,
                (1 + Math.random() * 5) * s,
                Math.sin(a) * out + velocity.z * 0.25,
            );
            p.lifespan = 4 + Math.random() * 4;
            p.life = Math.max(p.life, FIRE_PHASE_END * p.lifespan + 1e-3);
            p.sizeStart = (1.5 + Math.random() * 1.5) * (0.6 + 0.4 * s);
            p.sizeEnd = (9 + Math.random() * 8) * (0.6 + 0.4 * s);
        });
    }

    private readonly spawnSnapshot: number[] = [];

    /** Spawn counters of every slot, in a buffer reused between calls. */
    private snapshotSpawns(): number[] {
        const particles = this.system.particles;
        for (let i = 0; i < particles.length; i++) {
            this.spawnSnapshot[i] = particles[i].spawns;
        }
        return this.spawnSnapshot;
    }

    /** Burst `count` puffs, applying `init` to each new one and tagging it dust (1) or not (0). */
    private burstTagged(count: number, dust: number, init: (p: ParticleLike) => number | void): void {
        const prevSpawns = this.snapshotSpawns();
        this.system.burst(count, true);
        for (let i = 0; i < this.system.particles.length; i++) {
            const p = this.system.particles[i];
            if (p.isActive && p.spawns !== prevSpawns[i]) {
                const override = init(p);
                if (i < this.dustFlags.length) {
                    this.dustFlags[i] = override ?? dust;
                }
            }
        }
    }

    private openLeak(targetId: string, pose: DamageSmokePose, hitWorld: THREE.Vector3): void {
        let slot = this.findLeak(targetId);
        if (!slot) {
            slot = this.allocLeak();
            // Fresh occupancy — clear leftover wreck state from a prior aircraft.
            slot.permanent = false;
            slot.crashed = false;
        }
        slot.active = true;
        slot.targetId = targetId;
        // Don't shorten a permanent wreck plume if hits keep arriving.
        if (!slot.permanent) {
            slot.emitRemaining = LEAK_EMIT_DURATION_SEC;
        }
        slot.emitAccum = Math.max(slot.emitAccum, 1);

        // Store offset in aircraft local space so the emitter tracks the hull.
        this.invQuat.copy(pose.quaternion).invert();
        this.localOffset.copy(hitWorld).sub(pose.position).applyQuaternion(this.invQuat);
        slot.localOffset.copy(this.localOffset);
        slot.lastEmitPos.copy(hitWorld);
        if (!pose.isAlive || pose.isCrashed) {
            slot.permanent = true;
        }
        if (pose.isCrashed && !slot.crashed) {
            slot.crashed = true;
            slot.pinPos.copy(hitWorld);
        }
    }

    private findLeak(targetId: string): Leak | undefined {
        for (let i = 0; i < this.leaks.length; i++) {
            if (this.leaks[i].active && this.leaks[i].targetId === targetId) {
                return this.leaks[i];
            }
        }
        return undefined;
    }

    private allocLeak(): Leak {
        for (let i = 0; i < this.leaks.length; i++) {
            if (!this.leaks[i].active) {
                return this.leaks[i];
            }
        }
        // Prefer reclaiming a timed leak over a permanent wreck plume.
        let best = -1;
        for (let i = 0; i < this.leaks.length; i++) {
            if (this.leaks[i].permanent) {
                continue;
            }
            if (best < 0 || this.leaks[i].emitRemaining < this.leaks[best].emitRemaining) {
                best = i;
            }
        }
        if (best < 0) {
            best = 0;
        }
        return this.leaks[best];
    }

    reset(): void {
        this.system.reset();
        this.dustFlags.fill(0);
        for (const a of this.anchored) {
            a.active = false;
        }
        for (const b of this.burnSpots) {
            b.active = false;
        }
        for (const pool of this.pools) {
            pool.active = false;
            pool.trail.length = 0;
        }
        for (const drop of this.fuelDrops) {
            drop.active = false;
        }
        for (let i = 0; i < this.leaks.length; i++) {
            this.leaks[i].active = false;
            this.leaks[i].emitRemaining = 0;
            this.leaks[i].emitAccum = 0;
            this.leaks[i].pause = 0;
            this.leaks[i].permanent = false;
            this.leaks[i].crashed = false;
        }
        this.puffs.count = 0;
        this.puffs.visible = false;
    }

    init(_scene: Scene): void {
        //
    }

    private cachePaletteColors(palette: Palette): void {
        this.yellow.set(PaletteColor(palette, PaletteCategory.FX_FIRE__B));
        this.orange.set(PaletteColor(palette, PaletteCategory.FX_FIRE));
        this.orange.getHSL(_hsl);
        if (_hsl.s > 0.2) {
            // Coloured palette: the fire's orange is no red at all, so take the
            // reds from the red end of the hue wheel.
            this.red.set(0xd81a0a);
            this.darkRed.set(0x5e0a04);
        } else {
            // Grayscale palette (night vision): stay gray, just darker.
            this.red.copy(this.orange).multiplyScalar(0.72);
            this.darkRed.copy(this.orange).multiplyScalar(0.36);
        }
        this.rampA.length = 0;
        this.rampA.push(this.yellow, this.orange, this.red, this.darkRed, this.smoke);
        this.rampB.length = 0;
        this.rampB.push(this.yellow, this.orange, this.red, this.darkRed, this.smokeLead);
        this.smoke.set(PaletteColor(palette, PaletteCategory.FX_SMOKE));
        // The game's default smoke: FX_SMOKE, lightening through __B to __C as
        // the puff ages (the same ramp the particle material uses).
        this.smokeB.set(PaletteColor(palette, PaletteCategory.FX_SMOKE__B));
        this.smokeC.set(PaletteColor(palette, PaletteCategory.FX_SMOKE__C));
        this.smokeAt(SMOKE_TONE_B_LEAD, this.smokeLead);
        this.dust.set(PaletteColor(palette, PaletteCategory.SCENERY_FIELD_OCHRE));
        this.dustB.set(PaletteColorShade(palette, PaletteCategory.SCENERY_FIELD_OCHRE));
        this.concreteA.copy(this.smokeB);
        this.concreteB.copy(this.smokeC);
        // Spray is the palette's lightest smoke taken toward white (so a grayscale palette stays gray).
        this.sprayA.copy(this.smokeC).lerp(this.white, 0.7);
        this.sprayB.copy(this.smokeC).lerp(this.white, 0.45);
        this.mistA.copy(this.smokeC).lerp(this.white, 0.35);
        this.mistB.copy(this.smokeC).lerp(this.white, 0.15);
        this.foamA.copy(this.smokeC).lerp(this.white, 0.9);
        this.foamB.copy(this.smokeC).lerp(this.white, 0.65);
    }

    /** Default smoke colour at `age` 0..1: FX_SMOKE, FX_SMOKE__B, then FX_SMOKE__C. */
    private smokeAt(age: number, out: THREE.Color): void {
        const a = clamp(age, 0, 1);
        if (a < 0.5) {
            out.copy(this.smoke).lerp(this.smokeB, a * 2);
        } else {
            out.copy(this.smokeB).lerp(this.smokeC, (a - 0.5) * 2);
        }
    }

    /** Both dither tones for a smoke puff of the given age. */
    private applySmokeAge(age: number): void {
        this.smokeAt(age, this.tmpColor);
        this.smokeAt(age + SMOKE_TONE_B_LEAD, this.tmpColorB);
    }

    /** The flame ramp at `heat`, written into `out`. */
    private sampleRamp(ramp: THREE.Color[], heat: number, out: THREE.Color): void {
        const h = clamp(heat, 0, 1);
        const last = FIRE_RAMP_HEAT.length - 1;
        if (h >= FIRE_RAMP_HEAT[last]) {
            out.copy(ramp[last]);
            return;
        }
        let i = 0;
        while (i < last - 1 && h >= FIRE_RAMP_HEAT[i + 1]) {
            i++;
        }
        const t = (h - FIRE_RAMP_HEAT[i]) / (FIRE_RAMP_HEAT[i + 1] - FIRE_RAMP_HEAT[i]);
        out.copy(ramp[i]).lerp(ramp[i + 1], t);
    }

    /**
     * Yellow, orange, red, dark red, then gray smoke. The second dither tone
     * runs ahead of the first on the ramp, so the flame is always a stipple of
     * two neighbouring colours rather than one colour that changes over time.
     */
    private applyHeatColors(heat01: number): void {
        this.sampleRamp(this.rampA, heat01, this.tmpColor);
        this.sampleRamp(this.rampB, heat01 + FIRE_TONE_B_LEAD, this.tmpColorB);
    }

    private emitAtLeak(leak: Leak, rate: number, delta: number, crashed: boolean): void {
        if (leak.pause > 0) {
            leak.pause -= delta;
            return;
        }
        leak.emitAccum += rate * delta;
        const toSpawn = Math.floor(leak.emitAccum);
        if (toSpawn > 0) {
            leak.emitAccum -= toSpawn;
            if (this.emitPuffs(toSpawn, crashed)) {
                leak.pause = smokeGap();
            }
        }
    }

    update(delta: number): void {
        if (this.poseProvider) {
            for (let i = 0; i < this.leaks.length; i++) {
                const leak = this.leaks[i];
                if (!leak.active) {
                    continue;
                }
                if (!leak.permanent) {
                    leak.emitRemaining -= delta;
                    if (leak.emitRemaining <= 0) {
                        leak.active = false;
                        continue;
                    }
                }
                if (this.hasAnchored(leak.targetId)) {
                    // The wreck's own fires have taken over from the pinned plume.
                    leak.active = false;
                    continue;
                }
                const pose = this.poseProvider(leak.targetId);
                if (!pose) {
                    // Permanent / crashed plumes keep going from the last known spot.
                    if (leak.permanent || leak.crashed) {
                        if (!leak.crashed) {
                            leak.crashed = true;
                            leak.pinPos.copy(leak.lastEmitPos);
                        }
                        this.system.position = leak.pinPos;
                        this.emitAtLeak(leak, CRASH_EMIT_RATE, delta, true);
                        continue;
                    }
                    leak.active = false;
                    continue;
                }

                if (!pose.isAlive || pose.isCrashed) {
                    leak.permanent = true;
                }

                this.localOffset.copy(leak.localOffset).applyQuaternion(pose.quaternion);
                this.worldPos.copy(pose.position).add(this.localOffset);
                if (pose.isCrashed || leak.crashed) {
                    if (!leak.crashed) {
                        leak.crashed = true;
                        leak.pinPos.copy(this.worldPos);
                    }
                    this.worldPos.copy(leak.pinPos);
                }
                leak.lastEmitPos.copy(this.worldPos);
                this.system.position = this.worldPos;

                const speed = pose.velocity.length();
                const rate = leak.crashed
                    ? CRASH_EMIT_RATE
                    : LEAK_EMIT_RATE * (1 + speed / SPEED_REF_MPS);
                this.emitAtLeak(leak, rate, delta, leak.crashed);
            }
        }
        this.carryWithSurface(delta);
        this.updateAnchored(delta);
        this.updateBurnSpots(delta);
        this.updateFirePools(delta);
        this.updateFuelDrops(delta);
        this.system.update(delta);
    }

    /**
     * Start a lake of burning fuel at a crash. It has no extent of its own: it
     * is made of the fuel that falls out of the aircraft and lands, a spot at a
     * time. The crash itself sprays fuel out ahead of the impact, and the
     * wreckage keeps shedding it (see `addAnchoredFire`'s `drips`). Bigger for a harder hit.
     */
    addFirePool(impact: THREE.Vector3, velocity: THREE.Vector3, severity: number): void {
        const pool = this.pools[this.nextPool];
        this.nextPool = (this.nextPool + 1) % MAX_FIRE_POOLS;
        const strength = clamp(severity, 0.3, 1.5);
        pool.radius = 6 + 6 * strength;
        pool.strength = strength;
        pool.age = 0;
        pool.life = POOL_LIFE_S;
        pool.flameAccum = 0;
        pool.smokeAccum = 0;
        pool.markAccum = 0;
        pool.trail.length = 0;
        pool.origin.copy(impact);
        pool.originMoving = this.movingSurface?.contains(impact.x, impact.y, impact.z) ?? false;
        const len = Math.hypot(velocity.x, velocity.z);
        pool.dirX = len > 1e-3 ? velocity.x / len : 0;
        pool.dirZ = len > 1e-3 ? velocity.z / len : 1;
        pool.active = true;
        this.spillFuel(impact, velocity, strength);
    }

    /** Once a puddle has been spreading a while, scorch the ground in a wider ring round the char. */
    private scorchPoolEdges(pool: FirePool): void {
        if (!this.onPoolMark) {
            return;
        }
        for (const point of pool.trail) {
            if (!point.outer && pool.age - point.born >= POOL_OUTER_SCORCH_AFTER_S) {
                point.outer = true;
                this.onPoolMark(
                    point.position, point.dirX, point.dirZ, point.radiusNow * 2.4, point.radiusNow * 2.4, false);
            }
        }
    }

    private readonly puddleMarkAt = new THREE.Vector3();

    /** Let each puddle creep outward toward the size its fuel makes, charring the ground as its edge moves. */
    private spreadPuddles(pool: FirePool, delta: number): void {
        const k = 1 - Math.exp(-delta / POOL_SPREAD_S);
        for (const point of pool.trail) {
            const target = Math.min(pool.radius, FUEL_PUDDLE_BASE_M + FUEL_PUDDLE_PER_DROP_M * point.volume);
            point.radiusNow += (target - point.radiusNow) * k;
            if (this.onPoolMark && point.radiusNow - point.charRadius >= FUEL_CHAR_STEP_M) {
                point.charRadius = point.radiusNow;
                const a = Math.random() * Math.PI * 2;
                const edge = point.radiusNow * 0.7;
                const at = this.puddleMarkAt.set(
                    point.position.x + Math.cos(a) * edge, point.position.y, point.position.z + Math.sin(a) * edge);
                if (this.groundHeightAt) {
                    at.y = this.groundHeightAt(at.x, at.z);
                }
                this.onPoolMark(at, Math.cos(a), Math.sin(a), point.radiusNow * 1.2, point.radiusNow * 1.2, true);
            }
        }
    }

    private updateFirePools(delta: number): void {
        for (const pool of this.pools) {
            if (!pool.active) {
                continue;
            }
            pool.age += delta;
            if (pool.age >= pool.life) {
                pool.active = false;
                continue;
            }
            if (pool.trail.length === 0) {
                // No fuel has landed yet: nothing is burning on the ground.
                continue;
            }
            this.spreadPuddles(pool, delta);
            this.scorchPoolEdges(pool);
            const burn = 1 - pool.age / pool.life;
            // Fiercest at first.
            const early = Math.exp(-pool.age / 14);
            // A long lake carries more flame, so its density does not thin out along the path.
            // (Landing spots are at least FUEL_MERGE_M apart, so the count is a fair measure of area.)
            const areaFactor = clamp(0.75 + 0.25 * pool.trail.length, 1, POOL_MAX_AREA_FACTOR);
            const rate = Math.min(
                POOL_MAX_FLAME_RATE,
                (POOL_FLAME_RATE + POOL_FLAME_RATE_PER_STRENGTH * pool.strength)
                    * (0.2 + 0.8 * burn) * (1 + 0.9 * early) * areaFactor);
            pool.flameAccum += rate * delta;
            const flames = Math.floor(pool.flameAccum);
            if (flames > 0) {
                pool.flameAccum -= flames;
                this.emitPoolFlames(pool, flames, early, burn);
            }
            // Under the lake the ground blackens, a patch at a time, for as long as it burns.
            if (this.onBurnMark && burn > 0.2) {
                pool.markAccum += POOL_BURN_MARK_RATE * areaFactor * delta;
                const marks = Math.floor(pool.markAccum);
                if (marks > 0) {
                    pool.markAccum -= marks;
                    const at = this.poolScratch2;
                    for (let m = 0; m < marks; m++) {
                        this.poolPoint(pool, at, 0.95);
                        this.scorch(at.x, at.y, at.z, pool.radius * (0.2 + 0.25 * Math.random()));
                    }
                }
            }
            pool.smokeAccum += POOL_SMOKE_RATE * (0.3 + 0.7 * burn) * Math.sqrt(areaFactor) * delta;
            const columns = Math.floor(pool.smokeAccum);
            if (columns > 0) {
                pool.smokeAccum -= columns;
                this.emitPoolSmoke(pool, columns);
            }
        }
    }

    private readonly poolScratch = new THREE.Vector3();
    private readonly poolScratch2 = new THREE.Vector3();
    private readonly markScratch = new THREE.Vector3();

    /** Ask for a burn mark of the given radius at a ground point. */
    private scorch(x: number, y: number, z: number, radius: number): void {
        if (this.isWaterAt?.(x, z)) {
            return; // nothing to blacken on the sea
        }
        this.onBurnMark?.(
            this.markScratch.set(x, y, z), radius, 0.55 + Math.random() * 0.45,
            BURN_MARK_GROW_MIN_S + Math.random() * (BURN_MARK_GROW_MAX_S - BURN_MARK_GROW_MIN_S));
    }

    /** A random point on the lake, written into `out`; `inner` < 1 keeps toward the middle of the swath. */
    private poolPoint(pool: FirePool, out: THREE.Vector3, inner = 1): void {
        const point = pool.trail[Math.floor(Math.random() * pool.trail.length)];
        // Within however far this puddle has spread over the ground so far.
        const r = Math.sqrt(Math.random()) * inner * point.radiusNow;
        const a = Math.random() * Math.PI * 2;
        out.set(point.position.x + Math.cos(a) * r, point.position.y, point.position.z + Math.sin(a) * r);
        if (this.groundHeightAt) {
            out.y = this.groundHeightAt(out.x, out.z);
        }
    }

    private emitPoolFlames(pool: FirePool, count: number, early: number, burn: number): void {
        // The same rule as the other fires: a fresh lake is all flame, a dying one gives more and more smoke and black.
        const flame = Math.max(flameShare(burn), early);
        this.worldPos.copy(pool.trail[0].position);
        this.system.position = this.worldPos;
        const at = new THREE.Vector3();
        this.burstTagged(count, 0, (p) => {
            this.poolPoint(pool, at);
            p.position.copy(at);
            // Low licking flame: a slow rise, so the lake reads as a lake rather than a plume.
            p.velocity.set(
                (Math.random() * 2 - 1) * DRIFT_MPS,
                1.5 + Math.random() * 4.5,
                (Math.random() * 2 - 1) * DRIFT_MPS,
            );
            p.lifespan = 2.4 + Math.random() * 2.2;
            p.sizeStart = (1.8 + Math.random() * 1.7) * (1 + 0.4 * early);
            p.sizeEnd = (3.9 + Math.random() * 2.8) * (1 + 0.3 * early);
            return pickPuffKind(flame, early);
        });
    }

    private emitPoolSmoke(pool: FirePool, count: number): void {
        this.worldPos.copy(pool.trail[0].position);
        this.system.position = this.worldPos;
        const at = new THREE.Vector3();
        this.burstTagged(count, 3, (p) => {
            this.poolPoint(pool, at, 0.6);
            p.position.copy(at);
            // Tall, dark, wide: the black smoke that stands over a burning lake.
            p.velocity.set(
                (Math.random() * 2 - 1) * DRIFT_MPS,
                9 + Math.random() * 8,
                (Math.random() * 2 - 1) * DRIFT_MPS,
            );
            p.lifespan = 11 + Math.random() * 7;
            p.sizeStart = 3.5 + Math.random() * 2.5;
            p.sizeEnd = 20 + Math.random() * 12;
            // Mostly black, some default smoke.
            return Math.random() < 0.7 ? 3 : 2;
        });
    }

    private readonly dropOrigin = new THREE.Vector3();

    /**
     * What was laid on a moving surface goes along with it: the puddles of the
     * lake, where the crash was, and the burning scratches. (The smoke and
     * flame already in the air stay behind, as they would.)
     */
    private carryWithSurface(delta: number): void {
        const surface = this.movingSurface;
        if (!surface) {
            return;
        }
        const v = surface.velocity;
        for (const pool of this.pools) {
            if (!pool.active) {
                continue;
            }
            if (pool.originMoving) {
                pool.origin.addScaledVector(v, delta);
            }
            for (const point of pool.trail) {
                if (point.moving) {
                    point.position.addScaledVector(v, delta);
                }
            }
        }
        for (const spot of this.burnSpots) {
            if (spot.active && spot.moving) {
                spot.position.addScaledVector(v, delta);
            }
        }
    }

    /** Track where the fire is going and let burning fuel run out of it, to fall to the ground. */
    private shedFuel(fire: AnchoredFire, delta: number): void {
        if (fire.hasLast && delta > 0) {
            fire.vel.copy(this.worldPos).sub(fire.lastPos).divideScalar(delta);
            const speed = fire.vel.length();
            if (speed > 80) {
                fire.vel.multiplyScalar(80 / speed);
            }
        }
        fire.lastPos.copy(this.worldPos);
        fire.hasLast = true;
        if (fire.dripRate <= 0 || !this.groundHeightAt) {
            return;
        }
        // Fuel runs out of the wreckage wherever it is: from a piece in the air it
        // falls, and from one on the ground or sliding along it, it runs out onto
        // the ground just below (a drop is released at least a little above it).
        const ground = this.groundHeightAt(this.worldPos.x, this.worldPos.z);
        const from = this.dropOrigin.copy(this.worldPos);
        from.y = Math.max(from.y, ground + FUEL_MIN_FALL_M);
        const burn = Number.isFinite(fire.life) ? clamp(fire.remaining / fire.life, 0, 1) : 1;
        const early = this.freshness(fire);
        fire.dripAccum += fire.dripRate * (0.3 + 0.7 * burn) * delta;
        while (fire.dripAccum >= 1) {
            fire.dripAccum -= 1;
            this.spawnFuelDrop(from, fire.vel, Math.max(flameShare(burn), early), early);
        }
    }

    private spawnFuelDrop(origin: THREE.Vector3, carried: THREE.Vector3, flame: number, early: number): void {
        // The fuel leaves with the piece's motion, thrown off a little to the sides.
        this.launchFuelDrop(
            origin.x + (Math.random() - 0.5) * 1.2, origin.y - Math.random() * 0.3, origin.z + (Math.random() - 0.5) * 1.2,
            carried.x * 0.55 + (Math.random() - 0.5) * 3,
            carried.y * 0.55 + Math.random() * 1.5,
            carried.z * 0.55 + (Math.random() - 0.5) * 3,
            true, flame, early);
    }

    private launchFuelDrop(
        x: number, y: number, z: number, vx: number, vy: number, vz: number, streak: boolean, flame: number, early: number,
    ): void {
        const drop = this.fuelDrops[this.nextFuelDrop];
        this.nextFuelDrop = (this.nextFuelDrop + 1) % MAX_FUEL_DROPS;
        drop.active = true;
        drop.streak = streak;
        drop.flame = flame;
        drop.early = early;
        drop.trailTimer = Math.random() * FUEL_TRAIL_INTERVAL_S;
        drop.position.set(x, y, z);
        drop.velocity.set(vx, vy, vz);
    }

    /**
     * The crash ruptures the tanks: fuel sprays out of the airframe, carried
     * forward by the speed it had, and rains down along and ahead of the impact.
     */
    private spillFuel(impact: THREE.Vector3, velocity: THREE.Vector3, strength: number): void {
        const count = Math.round(SPILL_DROPS_BASE + SPILL_DROPS_PER_STRENGTH * strength);
        for (let i = 0; i < count; i++) {
            this.launchFuelDrop(
                impact.x + (Math.random() - 0.5) * 6, impact.y + 0.4 + Math.random() * 2.2, impact.z + (Math.random() - 0.5) * 6,
                velocity.x * SPILL_CARRY + (Math.random() - 0.5) * 10,
                2 + Math.random() * 9 * (0.6 + 0.5 * strength),
                velocity.z * SPILL_CARRY + (Math.random() - 0.5) * 10,
                i % 2 === 0, 1, 1);
        }
    }

    private updateFuelDrops(delta: number): void {
        if (!this.groundHeightAt) {
            return;
        }
        this.dropPuffAt.length = 0;
        this.dropPuffFlame.length = 0;
        this.dropPuffEarly.length = 0;
        for (const drop of this.fuelDrops) {
            if (!drop.active) {
                continue;
            }
            drop.velocity.y -= FUEL_GRAVITY * delta;
            drop.position.addScaledVector(drop.velocity, delta);
            const ground = this.groundHeightAt(drop.position.x, drop.position.z);
            if (drop.position.y <= ground + 0.05) {
                drop.active = false;
                this.landFuel(drop.position.x, ground, drop.position.z);
                continue;
            }
            drop.trailTimer += delta;
            if (drop.streak && drop.trailTimer >= FUEL_TRAIL_INTERVAL_S) {
                drop.trailTimer = 0;
                this.dropPuffAt.push(this.dropScratch(this.dropPuffAt.length).copy(drop.position));
                this.dropPuffFlame.push(drop.flame);
                this.dropPuffEarly.push(drop.early);
            }
        }
        if (this.dropPuffAt.length > 0) {
            // A short streak of flame behind each falling drop, all in one burst.
            let next = 0;
            this.worldPos.copy(this.dropPuffAt[0]);
            this.system.position = this.worldPos;
            this.burstTagged(this.dropPuffAt.length, 0, (p) => {
                const i = next++ % this.dropPuffAt.length;
                p.position.copy(this.dropPuffAt[i]);
                p.velocity.set((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2);
                p.lifespan = 0.9 + Math.random() * 0.7;
                p.sizeStart = 0.5 + Math.random() * 0.4;
                p.sizeEnd = 1.6 + Math.random() * 1.0;
                return pickPuffKind(this.dropPuffFlame[i], this.dropPuffEarly[i]);
            });
        }
    }

    private readonly dropScratchPool: THREE.Vector3[] = [];

    private dropScratch(i: number): THREE.Vector3 {
        while (this.dropScratchPool.length <= i) {
            this.dropScratchPool.push(new THREE.Vector3());
        }
        return this.dropScratchPool[i];
    }

    /** How fresh the youngest active lake is (1 right after the crash, easing to 0); 0 if there is none. */
    private lakeEarly(): number {
        let early = 0;
        for (const pool of this.pools) {
            if (pool.active) {
                early = Math.max(early, Math.exp(-pool.age / 14));
            }
        }
        return early;
    }

    /** How fresh a fire is: 1 right after it starts, falling to 0 (the same measure its own puffs use). */
    private freshness(fire: AnchoredFire): number {
        return Number.isFinite(fire.life)
            ? Math.exp(-(fire.life - fire.remaining) / Math.min(fire.small ? EARLY_TAU_SMALL_S : EARLY_TAU_S, fire.life * 0.3))
            : 0;
    }

    /** How much of its life the youngest active lake has left (1 if there is none). */
    private lakeBurn(): number {
        let burn = 0;
        let any = false;
        for (const pool of this.pools) {
            if (pool.active) {
                any = true;
                burn = Math.max(burn, 1 - pool.age / pool.life);
            }
        }
        return any ? burn : 1;
    }

    /** A drop of burning fuel hits the ground: it splashes, scorches, and feeds the lake. */
    private landFuel(x: number, ground: number, z: number): void {
        if (this.isWaterAt?.(x, z)) {
            // Fuel landing on the sea: a small splash, and no lake of fire to spread over it.
            this.spawnSplash(this.worldPos.set(x, ground, z), 0.2);
            return;
        }
        this.worldPos.set(x, ground + 0.2, z);
        this.system.position = this.worldPos;
        const burn = this.lakeBurn();
        const early = this.lakeEarly();
        const flame = Math.max(flameShare(burn), early);
        this.burstTagged(3, 0, (p) => {
            p.velocity.set((Math.random() - 0.5) * 5, 1 + Math.random() * 3, (Math.random() - 0.5) * 5);
            p.lifespan = 1.6 + Math.random() * 1.2;
            p.sizeStart = 1.0 + Math.random() * 0.8;
            p.sizeEnd = 3 + Math.random() * 2;
            return pickPuffKind(flame, early);
        });
        this.scorch(x, ground, z, 0.8 + Math.random() * 0.7);
        this.feedLake(x, ground, z);
    }

    /**
     * Fuel has landed: add the spot to the lake it belongs to, unless it is
     * already part of it. A lake is made of nothing else, so one with no fuel
     * landed yet has no points and burns nothing.
     */
    private feedLake(x: number, y: number, z: number): void {
        let best: FirePool | undefined;
        let bestReach = FUEL_FEED_REACH_M;
        let bestToPoint = Infinity;
        let bestPoint: PoolPoint | undefined;
        for (const pool of this.pools) {
            if (!pool.active) {
                continue;
            }
            let toPoint = Infinity;
            let nearest: PoolPoint | undefined;
            for (const point of pool.trail) {
                const d = Math.hypot(point.position.x - x, point.position.z - z);
                if (d < toPoint) {
                    toPoint = d;
                    nearest = point;
                }
            }
            const reach = Math.min(toPoint, Math.hypot(pool.origin.x - x, pool.origin.z - z));
            if (reach < bestReach) {
                bestReach = reach;
                bestToPoint = toPoint;
                bestPoint = nearest;
                best = pool;
            }
        }
        if (!best) {
            return;
        }
        if (bestPoint && bestToPoint < FUEL_MERGE_M) {
            // More fuel on a puddle that is already there: it will spread further.
            bestPoint.volume += 1;
            return;
        }
        if (best.trail.length >= MAX_POOL_POINTS) {
            return;
        }
        const position = new THREE.Vector3(x, y, z);
        best.trail.push({
            position, born: best.age, dirX: best.dirX, dirZ: best.dirZ, segment: 0, outer: false,
            moving: this.movingSurface?.contains(x, y, z) ?? false,
            volume: 1, radiusNow: FUEL_SPLASH_RADIUS_M, charRadius: FUEL_SPLASH_RADIUS_M,
        });
        // Char under the splash; the puddle chars the ground further out as it spreads.
        this.onPoolMark?.(position, best.dirX, best.dirZ, FUEL_SPLASH_RADIUS_M * 2.4, FUEL_SPLASH_RADIUS_M * 2.4, true);
    }

    private updateBurnSpots(delta: number): void {
        for (const spot of this.burnSpots) {
            if (!spot.active) {
                continue;
            }
            spot.remaining -= delta;
            if (spot.remaining <= 0) {
                // Flames out: a faint wisp carries on for a while, then nothing.
                spot.trickle -= delta;
                if (spot.trickle <= 0) {
                    spot.active = false;
                    continue;
                }
                if (spot.pause > 0) {
                    spot.pause -= delta;
                    continue;
                }
                this.emitSpotWisp(spot, delta);
                continue;
            }
            // The scratch blackens the ground under it while it burns, pauses or not.
            if (this.onBurnMark && this.groundHeightAt) {
                spot.markAccum += SPOT_BURN_MARK_RATE * spot.intensity * delta;
                if (spot.markAccum >= 1) {
                    spot.markAccum -= 1;
                    this.scorch(
                        spot.position.x, this.groundHeightAt(spot.position.x, spot.position.z),
                        spot.position.z, 0.9 + Math.random() * 0.7);
                }
            }
            if (spot.pause > 0) {
                spot.pause -= delta;
                continue;
            }
            const burn = spot.remaining / spot.life;
            // As the spot dies: thinner stream, more and longer breaks.
            if (Math.random() < (1 - burn) * BURN_RANDOM_BREAKS_PER_S * delta) {
                spot.pause = smokeGap(burn);
                continue;
            }
            const early = Math.exp(-(spot.life - spot.remaining) / EARLY_TAU_SPOT_S);
            spot.accum += BURN_SPOT_RATE * spot.intensity * burnRate(burn) * (1 + EARLY_BOOST_SPOT * early) * delta;
            const n = Math.floor(spot.accum);
            if (n > 0) {
                spot.accum -= n;
                this.worldPos.copy(spot.position);
                this.system.position = this.worldPos;
                let gap = false;
                const flame = flameShare(burn);
                this.burstTagged(n, 0, (p) => {
                    // Low flames licking up off the ground, then thin smoke.
                    p.velocity.set(
                        (Math.random() * 2 - 1) * DRIFT_MPS,
                        3 + Math.random() * 4,
                        (Math.random() * 2 - 1) * DRIFT_MPS,
                    );
                    p.lifespan = 4 + Math.random() * 3;
                    p.sizeStart = 0.8 + Math.random() * 0.6;
                    p.sizeEnd = 3.5 + Math.random() * 2.5;
                    const kind = pickPuffKind(flame);
                    gap = gap || kind !== 0;
                    return kind;
                });
                if (gap) {
                    spot.pause = smokeGap(burn);
                }
            }
        }
    }

    /** A thin, slow wisp of default smoke off a burnt-out scratch, with long uneven breaks. */
    private emitSpotWisp(spot: BurnSpot, delta: number): void {
        const left = spot.trickleLife > 0 ? clamp(spot.trickle / spot.trickleLife, 0, 1) : 0;
        spot.accum += SPOT_TRICKLE_RATE * spot.intensity * (0.25 + 0.75 * left) * delta;
        const n = Math.floor(spot.accum);
        if (n <= 0) {
            return;
        }
        spot.accum -= n;
        this.worldPos.copy(spot.position);
        this.system.position = this.worldPos;
        this.burstTagged(n, 2, (p) => {
            p.velocity.set(
                (Math.random() * 2 - 1) * DRIFT_MPS * 0.6,
                2 + Math.random() * 2.5,
                (Math.random() * 2 - 1) * DRIFT_MPS * 0.6,
            );
            p.lifespan = 7 + Math.random() * 5;
            p.sizeStart = 0.5 + Math.random() * 0.3;
            p.sizeEnd = 2.5 + Math.random() * 1.5;
        });
        if (Math.random() < 0.6) {
            spot.pause = smokeGap(0) * (1 + 2 * (1 - left));
        }
    }

    private updateAnchored(delta: number): void {
        for (const fire of this.anchored) {
            if (!fire.active) {
                continue;
            }
            fire.remaining -= delta;
            if (!fire.where(this.worldPos)) {
                fire.active = false;
                continue;
            }
            // Flames out: a faint trickle of smoke carries on for a while.
            const smouldering = fire.remaining <= 0;
            if (smouldering) {
                fire.trickle -= delta;
                if (fire.trickle <= 0) {
                    fire.active = false;
                    continue;
                }
            }
            // A fire near the ground blackens it, while the flames last.
            if (!smouldering && this.onBurnMark && this.groundHeightAt) {
                const ground = this.groundHeightAt(this.worldPos.x, this.worldPos.z);
                if (this.worldPos.y - ground < BURN_MARK_REACH_M) {
                    fire.markAccum += (fire.small ? FIRE_BURN_MARK_RATE_SMALL : FIRE_BURN_MARK_RATE) * delta;
                    if (fire.markAccum >= 1) {
                        fire.markAccum -= 1;
                        this.scorch(
                            this.worldPos.x, ground, this.worldPos.z,
                            (fire.small ? 1.1 : 2.3) * (0.7 + 0.6 * Math.random()));
                    }
                }
            }
            // Burning fuel runs off the fuselage and the wing roots and falls to the ground.
            if (!smouldering) {
                this.shedFuel(fire, delta);
            }
            if (fire.pause > 0) {
                fire.pause -= delta;
                continue;
            }
            this.system.position = this.worldPos;
            if (smouldering) {
                this.emitTrickle(fire, delta);
                continue;
            }
            // A fire burns down: fewer flame puffs and more smoke, a thinner
            // stream, and breaks that come more often and last longer, until out.
            const burn = Number.isFinite(fire.life) ? clamp(fire.remaining / fire.life, 0, 1) : 1;
            if (Math.random() < (1 - burn) * BURN_RANDOM_BREAKS_PER_S * delta) {
                fire.pause = smokeGap(burn);
                continue;
            }
            // Fierce at first, easing off: 1 right after the crash, falling to 0.
            const early = this.freshness(fire);
            const boost = 1 + (fire.small ? EARLY_BOOST_RATE_SMALL : EARLY_BOOST_RATE) * early;
            fire.accum += fire.rate * burnRate(burn) * boost * delta;
            const n = Math.floor(fire.accum);
            if (n > 0) {
                fire.accum -= n;
                if (this.emitPuffs(n, true, fire.small, Math.max(flameShare(burn), early), early)) {
                    fire.pause = smokeGap(burn);
                }
            }
        }
    }

    /** A burnt-out fire: the odd thin wisp of default smoke, with long breaks, tailing off. */
    private emitTrickle(fire: AnchoredFire, delta: number): void {
        const left = fire.trickleLife > 0 ? clamp(fire.trickle / fire.trickleLife, 0, 1) : 0;
        fire.accum += (fire.small ? TRICKLE_RATE_SMALL : TRICKLE_RATE) * (0.25 + 0.75 * left) * delta;
        const n = Math.floor(fire.accum);
        if (n <= 0) {
            return;
        }
        fire.accum -= n;
        const small = fire.small;
        this.burstTagged(n, 2, (p) => {
            // Slow, narrow, long-lived: a wisp rather than a plume.
            p.velocity.set(
                (Math.random() * 2 - 1) * DRIFT_MPS,
                RISE_MPS * (0.2 + Math.random() * 0.12),
                (Math.random() * 2 - 1) * DRIFT_MPS,
            );
            p.lifespan = 16 + Math.random() * 8;
            p.sizeStart = small ? 0.7 + Math.random() * 0.4 : 1.1 + Math.random() * 0.6;
            p.sizeEnd = small ? 4 + Math.random() * 2 : 7 + Math.random() * 4;
        });
        // Wisps, not a stream: long, uneven breaks, longer the thinner it gets.
        if (Math.random() < 0.6) {
            fire.pause = smokeGap(0) * (1 + 2 * (1 - left));
        }
    }

    /** Returns true if any puff came out as plain smoke or black, so the caller can break the stream. */
    private emitPuffs(count: number, crashed: boolean, small = false, flame = 1, early = 0): boolean {
        let nonFlame = false;
        const prevSpawns = this.snapshotSpawns();
        this.system.burst(count, true);
        for (let i = 0; i < this.system.particles.length; i++) {
            const p = this.system.particles[i];
            // spawns bumps on every activation — catches recycled slots that stay "was active".
            if (p.isActive && p.spawns !== prevSpawns[i]) {
                // Same plume behaviour in-flight and on the wreck: rise, drift,
                // long smoke life, widen, dither out to zero.
                p.velocity.set(
                    (Math.random() * 2 - 1) * DRIFT_MPS,
                    RISE_MPS * (0.9 + Math.random() * 0.2),
                    (Math.random() * 2 - 1) * DRIFT_MPS,
                );
                p.lifespan = 22 + Math.random() * 8;
                if (small) {
                    // Wing-root fire: a lower, thinner column than the fuselage's.
                    p.velocity.y *= 0.55;
                    p.lifespan = 11 + Math.random() * 5;
                    p.sizeStart = 1.0 + Math.random() * 0.6;
                    p.sizeEnd = 6 + Math.random() * 4;
                } else {
                    if (crashed) {
                        // Slightly larger origin on the ground fire only.
                        p.sizeStart = Math.max(p.sizeStart, 2.2 + Math.random() * 1.2);
                    }
                    p.sizeEnd = 16 + Math.random() * 8;
                }
                // A fresh fire throws bigger, taller puffs.
                p.velocity.y *= 1 + EARLY_RISE_BOOST * early;
                p.sizeStart *= 1 + EARLY_SIZE_START_BOOST * early;
                p.sizeEnd *= 1 + EARLY_SIZE_END_BOOST * early;
                const kind = pickPuffKind(flame, early);
                nonFlame = nonFlame || kind !== 0;
                if (i < this.dustFlags.length) {
                    this.dustFlags[i] = kind;
                }
            }
        }
        return nonFlame;
    }

    /** Short gray puffs at a ground scrape — skips the yellow/red fire phase. */
    private emitGroundSmokePuffs(count: number): void {
        const prevSpawns = this.snapshotSpawns();
        this.system.burst(count, true);
        for (let i = 0; i < this.system.particles.length; i++) {
            const p = this.system.particles[i];
            if (p.isActive && p.spawns !== prevSpawns[i]) {
                p.velocity.set(
                    (Math.random() * 2 - 1) * DRIFT_MPS * 1.4,
                    RISE_MPS * (0.35 + Math.random() * 0.25),
                    (Math.random() * 2 - 1) * DRIFT_MPS * 1.4,
                );
                p.lifespan = 4 + Math.random() * 3;
                // Start past the fire phase so syncPuffs colours as gray smoke only.
                p.life = Math.max(p.life, FIRE_PHASE_END * p.lifespan + 1e-3);
                p.sizeStart = 1.2 + Math.random() * 0.8;
                p.sizeEnd = 6 + Math.random() * 4;
                if (i < this.dustFlags.length) {
                    this.dustFlags[i] = 2;
                }
            }
        }
    }

    private syncPuffs(camera: THREE.Camera, palette: Palette): void {
        this.cachePaletteColors(palette);
        const mesh = this.puffPose;
        let live = 0;
        for (let i = 0; i < this.system.particles.length && i < DAMAGE_SMOKE_PARTICLE_COUNT; i++) {
            const p = this.system.particles[i];
            if (!p.isActive) {
                continue;
            }
            const progress = p.life / p.lifespan;
            // Most widening happens after the flame dies — smoke billows out.
            const sizeT = progress < FIRE_PHASE_END
                ? (progress / FIRE_PHASE_END) * FIRE_SIZE_GROWTH
                : FIRE_SIZE_GROWTH
                    + (1 - FIRE_SIZE_GROWTH)
                    * ((progress - FIRE_PHASE_END) / (1 - FIRE_PHASE_END));
            const size = p.sizeStart + (p.sizeEnd - p.sizeStart) * sizeT;
            mesh.position.copy(p.position);
            mesh.scale.setScalar(size);

            // Yellow → red over the fire phase, then gray smoke for the rest.
            const flag = this.dustFlags[i];
            const isDust = flag === 1;
            if (flag === 6) {
                this.tmpColor.copy(this.foamA);
                this.tmpColorB.copy(this.foamB);
            } else if (flag === 4) {
                this.tmpColor.copy(this.sprayA);
                this.tmpColorB.copy(this.sprayB);
            } else if (flag === 5) {
                this.tmpColor.copy(this.mistA);
                this.tmpColorB.copy(this.mistB);
            } else if (flag === 7) {
                this.tmpColor.copy(this.concreteA);
                this.tmpColorB.copy(this.concreteB);
            } else if (isDust) {
                this.tmpColor.copy(this.dust);
                this.tmpColorB.copy(this.dustB);
            } else if (this.dustFlags[i] === 3) {
                // The odd pure black puff, in among the flames.
                this.tmpColor.copy(this.black);
                this.tmpColorB.copy(this.black);
            } else {
                // Flame colour lasts a few seconds whatever the puff lifespan, so
                // short-lived ground flames still show their red before they smoke.
                const fireEnd = clamp(FIRE_COLOUR_SECONDS / p.lifespan, FIRE_PHASE_END, 0.5);
                if (this.dustFlags[i] === 2) {
                    // Pure smoke: default smoke colour for its whole life.
                    this.applySmokeAge(progress);
                } else if (progress >= fireEnd) {
                    // A flame puff once it has burnt out joins the same smoke ramp.
                    this.applySmokeAge((progress - fireEnd) / (1 - fireEnd));
                } else {
                    this.applyHeatColors(progress / fireEnd);
                }
            }
            this.tmpColor.toArray(this.puffToneA.array, live * 3);
            this.tmpColorB.toArray(this.puffToneB.array, live * 3);
            // Ease-out dissolve: dense early, then a long thin tail to near-zero.
            const fadeT = 1 - (1 - progress) * (1 - progress);
            this.puffLevel.array[live] = lerp(
                fadeT, isDust || flag === 5 || flag === 6 || flag === 7 ? DUST_DITHER_START : SMOKE_DITHER_START, SMOKE_DITHER_END);

            if (flag === 6) {
                // Foam lies flat on the water, not standing up to face the camera.
                mesh.rotation.set(-Math.PI / 2, 0, 0);
            } else {
                mesh.lookAt(camera.position);
            }
            mesh.rotateZ(p.rotationStart + (p.rotationEnd - p.rotationStart) * progress);
            mesh.updateMatrix();
            this.puffs.setMatrixAt(live, mesh.matrix);
            live++;
        }
        this.puffs.count = live;
        this.puffs.visible = live > 0;
        if (live > 0) {
            this.puffs.instanceMatrix.needsUpdate = true;
            this.puffLevel.needsUpdate = true;
            this.puffToneA.needsUpdate = true;
            this.puffToneB.needsUpdate = true;
        }
    }

    render3D(_targetWidth: number, _targetHeight: number, camera: THREE.Camera, lists: Map<string, THREE.Scene>, palette: Palette): void {
        this.syncPuffs(camera, palette);
        const list = lists.get(SceneLayers.EntityFX);
        if (!list) {
            return;
        }
        attachToRenderList(list, this.root);
    }

    render2D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Set<string>, _painter: CanvasPainter, _palette: Palette): void {
        //
    }
}
