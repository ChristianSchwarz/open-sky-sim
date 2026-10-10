import * as THREE from 'three';
import { FrameShift } from '../../terrain/geodesy';
import { Palette } from '../../config/palettes/palette';
import { CanvasPainter } from '../../render/screen/canvasPainter';
import { attachToRenderList } from '../../render/renderList';
import { Entity } from '../entity';
import { Model } from '../models/models';
import { Scene, SceneLayers } from '../scene';
import { updateUniforms } from '../utils';
import { MovingSurface } from './movingSurface';
import { AirframeDamage, JointState, PartBend } from './airframeDamage';

/** A separately-posed piece of the airframe (gear leg, control surface) at crash time. */
export interface WreckPart {
    model: Model;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    /** Gear and surfaces near the impact snap off more readily than ones far from it. */
    kind: 'gear' | 'surface';
    /** Which part it is, stable between calls: gear 0, control surface i = 1 + i. Defaults to its position in the list. */
    id?: number;
}

/**
 * A living aircraft was bent or torn by an impact it survived: where fuel
 * fires should start on it, in its own body frame (metres).
 */
export interface WreckDamageEvent {
    id: string;
    severity: number;
    fires: { kind: 'fuselage' | 'wingRoot'; local: THREE.Vector3 }[];
}

/** Everything the field needs to take an aircraft apart. All vectors are scene-space. */
export interface WreckSource {
    /** Sim id of the aircraft, so its fires can replace the old pinned plume. */
    id: string;
    body: Model;
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    scale: THREE.Vector3;
    /** Velocity just before the impact (m/s). */
    velocity: THREE.Vector3;
    parts: WreckPart[];
    /** Pilot's eye in the body frame (m), so a camera can follow the cockpit piece. */
    cockpit?: THREE.Vector3;
    /**
     * Damage it already has from impacts that did not destroy it: sections and
     * parts already torn off are not torn off again, and it is at least as
     * bent as it was.
     */
    damage?: AirframeDamage;
}

const VELOCITY_HISTORY = 8;

/**
 * Per-aircraft crash edge detector. Remembers the velocity from a few frames
 * back, because by the time the aircraft reads as crashed the sim has already
 * bled off speed in the contact response.
 */
export class WreckTracker {
    /** True while the aircraft is shown as a wreck (its own mesh must stay hidden). */
    shown = false;
    field: WreckField | undefined;

    private readonly history: THREE.Vector3[] = Array.from({ length: VELOCITY_HISTORY }, () => new THREE.Vector3());
    private cursor = 0;
    private filled = 0;
    private wasCrashed = false;

    /**
     * Call once per rendered frame. Returns the pre-impact velocity on the
     * frame the aircraft first reads as crashed, otherwise undefined.
     */
    sample(crashed: boolean, velocity: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 | undefined {
        if (!crashed) {
            this.history[this.cursor].copy(velocity);
            this.cursor = (this.cursor + 1) % VELOCITY_HISTORY;
            this.filled = Math.min(this.filled + 1, VELOCITY_HISTORY);
            this.wasCrashed = false;
            this.shown = false;
            return undefined;
        }
        if (this.wasCrashed) {
            return undefined;
        }
        this.wasCrashed = true;
        // The oldest sample still on record.
        const oldest = this.filled < VELOCITY_HISTORY ? 0 : this.cursor;
        return out.copy(this.history[oldest]);
    }
}

/** Vertices closer than this (m) are one vertex when working out what is connected. */
const WELD_M = 0.06;
/** A scrap of a cut piece smaller than this (triangles) is dropped rather than left floating. */
const COMPONENT_MIN_TRIS = 10;
/** At most this many connected pieces come out of one cut half. */
const COMPONENT_MAX_KEEP = 6;
/** Which body sections are joined to which: fuselage chain 0-1-2, wings off the middle. */
const CELL_NEIGHBOURS: number[][] = [[1], [0, 2, 3, 5], [1], [1, 4], [3], [1, 6], [5]];

/** The welded position of vertex `k` (0-2) of triangle `t` in a flat xyz array, as a lookup key. */
export function weldKey(pos: ArrayLike<number>, t: number, k: number): string {
    const o = t * 9 + k * 3;
    const inv = 1 / WELD_M;
    return Math.round(pos[o] * inv) + '_' + Math.round(pos[o + 1] * inv) + '_' + Math.round(pos[o + 2] * inv);
}

/**
 * Group triangles that share a (welded) vertex. `pos` is a flat xyz array with
 * nine numbers per triangle and `t` the triangle's index in it. Returns groups
 * of indices into `items`.
 */
export function groupTriangles(items: { pos: ArrayLike<number>; t: number }[]): number[][] {
    const parent = new Int32Array(items.length);
    for (let i = 0; i < parent.length; i++) {
        parent[i] = i;
    }
    const find = (a: number): number => {
        while (parent[a] !== a) {
            parent[a] = parent[parent[a]];
            a = parent[a];
        }
        return a;
    };
    const seen = new Map<string, number>();
    for (let i = 0; i < items.length; i++) {
        const { pos, t } = items[i];
        for (let k = 0; k < 3; k++) {
            const key = weldKey(pos, t, k);
            const j = seen.get(key);
            if (j === undefined) {
                seen.set(key, i);
            } else {
                const a = find(i);
                const b = find(j);
                if (a !== b) {
                    parent[a] = b;
                }
            }
        }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < items.length; i++) {
        const r = find(i);
        const g = groups.get(r);
        if (g) {
            g.push(i);
        } else {
            groups.set(r, [i]);
        }
    }
    return [...groups.values()];
}

const GRAVITY = 9.80665;
/** A gouge segment every this many metres of sliding, and at most this many per piece. */
const TRAIL_STEP_M = 3;
const TRAIL_MARKS_MAX = 30;
/** Below this crash severity nothing is flung out as a shard. */
const SHARD_MIN_SEVERITY = 0.35;
const SHARD_MAX = 9;
/** A shard is a cluster of at most this many triangles, cut from a mesh with plenty to spare. */
const SHARD_MAX_TRIS = 36;
const SHARD_MIN_SOURCE_TRIS = 24;
const SHARD_MIN_LEFT_TRIS = 8;
/** A piece hitting the ground harder than this (m/s into it) may break apart. */
const SPLIT_MIN_IMPACT_MPS = 8;
/** Impact speed at which a split is all but certain. */
const SPLIT_SURE_IMPACT_MPS = 38;
const SPLIT_MAX_DEPTH = 3;
/** Pieces smaller than this (longest side, m) are left whole. */
const SPLIT_MIN_SIZE_M = 2.5;
/**
 * The fuselage takes a lot: it dislocates and folds first (see dislocateFuselage),
 * and only under a blow well past what takes a wing off does one of its three
 * sections tear away at a joint.
 */
const FUSELAGE_TEAR_THRESHOLD = 1.15;
/** The score that takes a wing section off, and a gear leg or control surface. */
const WING_TEAR_THRESHOLD = 0.7;
const PART_TEAR_THRESHOLD = 0.6;
/**
 * The dislocation: below this crash severity the sections stay in line; above
 * it each joint gives by a sideways shift of (base + per-severity x severity)
 * fuselage half-widths in all, up to the maximum (kept under the full width so
 * the sections always still overlap), and a twist of about the same relative size.
 */
// (Severity is never below 0.2, so a touchdown with no real speed to it sits just under this and stays in line.)
const DISLOCATE_MIN_SEVERITY = 0.22;
const DISLOCATE_BASE_HALF_WIDTHS = 0.25;
const DISLOCATE_PER_SEVERITY_HALF_WIDTHS = 0.6;
const DISLOCATE_MAX_HALF_WIDTHS = 1.2;
const KINK_BASE_RAD = 0.08;
const KINK_PER_SEVERITY_RAD = 0.25;
const KINK_MAX_RAD = 0.5;
/** The joint nearest the impact takes this share of the movement, the other joint the rest. */
const DISLOCATE_NEAR_JOINT_SHARE = 0.7;
/**
 * Bending comes in gradually: nothing at this severity (the least there is), full
 * by this one. So a landing just past the clean limit bends the airframe a little,
 * and damage grows smoothly from there.
 */
const BEND_RAMP_FROM = 0.2;
const BEND_RAMP_TO = 0.5;
const bendRamp = (severity: number): number =>
    THREE.MathUtils.clamp((severity - BEND_RAMP_FROM) / (BEND_RAMP_TO - BEND_RAMP_FROM), 0, 1);
/**
 * Gear legs (see splitGearLegs): each bends under a blow near it by this much
 * of its length per unit of severity, up to the maximum share, and tears off
 * like any other part. Pieces of a gear model whose boxes are this close (m)
 * are one leg.
 */
/**
 * Damage adds up: a blow on an airframe already damaged counts as its own
 * severity plus this share of the weaker of the two, unless it follows the
 * last one within SAME_IMPACT_S (then it is the same impact, a slide scraping).
 */
const CUMULATIVE_SHARE = 0.35;
const SAME_IMPACT_S = 0.6;
/**
 * Wings fold at the root of each section, by up to this much (20 degrees) as the
 * blow nears what would tear the section off, and not at all below the minimum.
 * The outer section's fold adds to the inner one's. A section that would fold
 * further than the maximum (one blow, or the folds of several added up) breaks
 * off instead.
 */
const WING_BEND_MAX_RAD = 20 * Math.PI / 180;
const WING_BEND_MIN_RAD = 0.06;
const GEAR_BEND_GAIN = 3;
const GEAR_BEND_MAX_RAD = 2.4;
const GEAR_LEG_MERGE_M = 0.15;
/** Ids of the second and later legs of a gear part, clear of the surfaces' 1 + i. */
const GEAR_LEG_ID_BASE = 1000;
/**
 * The bend, on top of the dislocation: the fuselage folds sideways at its joints
 * by (base + per-severity x severity) radians in all, up to the maximum, shared
 * between the two joints like the shift is. Its sections are moved whole.
 */
const BEND_BASE_RAD = 0.1;
const BEND_PER_SEVERITY_RAD = 1.6;
const BEND_MAX_RAD = 2.4;
/**
 * The plane it folds in: how much of its angle (from sideways to vertical) follows the
 * blow, the rest being chance; and how often a vertical fold has the tail rising.
 */
const BEND_PLANE_BLOW_SHARE = 0.5;
const BEND_UP_SHARE = 0.75;
/**
 * In the water: most of the speed goes at the surface, then it drags the piece
 * to a halt sideways (per second) and eases its fall to a slow sink.
 */
const WATER_ENTRY_KEEP = 0.45;
const WATER_SPIN_KEEP = 0.6;
const WATER_DRAG_PER_S = 2.4;
const WATER_SPIN_DRAG_PER_S = 1.6;
const WATER_SINK_MPS = 0.7;
/**
 * A piece that goes into the water floats for this long (s), riding with its
 * lower part under and bobbing a little, before it starts to sink. The sink
 * then eases in over WATER_SINK_EASE_S.
 */
const WATER_FLOAT_S = 10;
const WATER_SINK_EASE_S = 2;
/** While floating it rides this fraction of its half-height below the surface. */
const WATER_FLOAT_DEPTH = 0.3;
const WATER_BOB_M = 0.15;
/**
 * Foam round a piece in the water, in puffs per second: this plus this per metre
 * of its size, scaled by how much churn there is (full as it goes in and goes
 * under, steady while it floats, thinning as it sinks to the depth where none is left).
 */
const FOAM_RATE_BASE = 3;
const FOAM_RATE_PER_M = 2.5;
const FOAM_FLOATING_STRENGTH = 0.55;
const FOAM_ENTRY_S = 1.5;
const FOAM_NONE_DEPTH_M = 8;
/** A ring of this many puffs is laid as a piece goes in. */
const FOAM_ENTRY_PUFFS = 8;
const WATER_SINK_RELAX_PER_S = 3;
/** A fire on a piece this far under (m) is out. */
const WATER_SUBMERGED_M = 1.2;
/** A piece this deep (m) is out of sight and no longer simulated. */
const WATER_HIDE_DEPTH_M = 25;
const MAX_FRAGMENTS = 80;
const MAX_STEP_S = 1 / 30;
const SUBSTEPS = 2;
const SLEEP_SPEED_MPS = 0.45;
const SLEEP_SPIN_RADPS = 0.35;
/** A piece longer than this (half-length, m) and more upright than TOPPLE_MIN_UP topples over. */
const TOPPLE_MIN_HALF_M = 1.2;
const TOPPLE_MIN_UP = 0.45;
const TOPPLE_RADPS2 = 2.5;
/** A flat piece (thin axis under this share of its middle one) tilted more than SETTLE_MIN_SIN settles flat. */
const SETTLE_MIN_HALF_M = 1.0;
const SETTLE_FLATNESS = 0.7;
const SETTLE_MIN_SIN = 0.15;
/** A piece that is still tipped after trying this long (s) is left to rest. */
const SETTLE_GIVE_UP_S = 14;
/** How often (s) a piece at rest checks the ground under it, how far sunk (m) it is lifted, how far hanging (m) it wakes. */
const RESEAT_INTERVAL_S = 0.25;
const RESEAT_SINK_M = 0.03;
const RESEAT_HANG_M = 0.4;
/** A piece taller than this many times its footprint (half-extents) is toppled, whatever its shape. */
const TALL_RATIO = 1.15;
const TALL_MATRIX = new THREE.Matrix4();
const CARRY_MATRIX = new THREE.Matrix4();
const TOPPLE_UP = new THREE.Vector3(0, 1, 0);
const TOPPLE_AXIS = new THREE.Vector3();
const SLEEP_AFTER_S = 0.8;
/** Vertex attributes carried onto fragments. */
const COPIED_ATTRIBUTES = ['position', 'normal', 'color', 'uv'];
/** Fraction of the body's tangential speed a fragment keeps, by how hard it was hit. */
const BASE_FRICTION = 0.25;

/** Body sections: 0-2 fuselage fore→aft, 3-6 wings (inner/outer × left/right). */
const CELL_COUNT = 7;
/** How readily each section snaps off (higher = weaker joint). */
const CELL_WEAKNESS = [1.0, 0.95, 1.15, 1.1, 1.3, 1.1, 1.3];

interface SplitPart {
    material: THREE.Material | THREE.Material[];
    attrs: Map<string, { data: number[]; itemSize: number }>;
}
type SplitSide = SplitPart[];

interface ChunkMesh {
    material: THREE.Material | THREE.Material[];
    /** attribute name → flat float array (positions already world-oriented). */
    attrs: Map<string, { data: number[]; itemSize: number }>;
}

/** A fire that rides on a fragment, at a fixed spot in that fragment's frame. */
export interface WreckFire {
    fragment: Fragment;
    local: THREE.Vector3;
    /** 'brand' = a small burning shard thrown clear of the wreck. */
    kind: 'fuselage' | 'wingRoot' | 'brand';
}

export interface WreckEvent {
    id: string;
    position: THREE.Vector3;
    velocity: THREE.Vector3;
    normal: THREE.Vector3;
    /** 0.2 (scrape-off) .. 1.5 (dive into the ground). */
    severity: number;
    fires: WreckFire[];
    /** The impact was in open water. */
    water: boolean;
}

interface Chunk {
    /** Body section 0-6, or -1 for a gear leg / control surface. */
    cell: number;
    /** One leg of the landing gear: it can bend and tear off; while on it stays with the fuselage. */
    gear?: boolean;
    /** For a part: which one (see WreckPart.id). */
    partId?: number;
    /** Where a fire would sit on this section (body-origin-relative, world-oriented). */
    anchor?: THREE.Vector3;
    meshes: ChunkMesh[];
    /** Bounding box in body-origin-relative world orientation. */
    box: THREE.Box3;
    /** Weakness multiplier for the break-off test. */
    weakness: number;
}

export interface Fragment {
    obj: THREE.Object3D;
    /** Body-origin-relative centre the fragment's geometry was built around. */
    centre: THREE.Vector3;
    disposed: boolean;
    /** Where the aircraft origin sits in this piece's own frame (follows splits). */
    originLocal: THREE.Vector3;
    /** Times this lineage has already broken apart. */
    depth: number;
    splitQueued: boolean;
    dustAccum: number;
    /** Distance slid since the last gouge segment, and how many it has laid. */
    slideAccum: number;
    trailMarks: number;
    /** Width of the gouge this piece cuts. */
    trailWidth: number;
    /** Half extents of the piece, for the impression it leaves at rest. */
    half: THREE.Vector3;
    /** How long (s) it has been trying to settle or topple (see SETTLE_GIVE_UP_S). */
    settleS?: number;
    /** Seconds since a piece at rest last checked that the ground under it is still where it left it. */
    reseatS?: number;
    /** Seconds until it may lay another dent. */
    markCooldown: number;
    wasTouching: boolean;
    /** Lying on a moving surface (a carrier deck) this frame. */
    onMover: boolean;
    /** In the water: it has gone in; it floats for a while, then sinks. */
    wet: boolean;
    /** Seconds since it went in, and the phase of its bobbing while it floats. */
    wetTime: number;
    bobPhase: number;
    /** Foam owed to the water round it. */
    foamAccum: number;
    /** Holds fuselage: it is never split further. */
    tough: boolean;
    /** Far enough under that a fire on it is out. */
    submerged: boolean;
    /** Water surface height where it went in. */
    waterY: number;
    /** Seconds until this piece may throw up another impact puff. */
    impactCooldown: number;
    velocity: THREE.Vector3;
    spin: THREE.Vector3;
    /** Local-space AABB corners used as contact points. */
    corners: THREE.Vector3[];
    /** Radius-of-gyration squared (m²), for contact impulses. */
    gyration2: number;
    asleep: boolean;
    restTime: number;
    /** Highest wreck generation this belongs to (oldest dropped first). */
    serial: number;
}

/**
 * Breaks a crashed aircraft into rigid pieces that keep moving on their own.
 *
 * Where it hit decides what happens: the body is cut into fuselage and wing
 * sections, and the sections nearest the impact (and the weakest joints, and
 * everything on a hard enough hit) come away as separate fragments, each with
 * the velocity the airframe had at that spot, less what the ground took, plus a
 * kick away from the impact point. Sections that hold stay together as one
 * lump. Gear legs and control surfaces are pieces of their own.
 */
export class WreckField implements Entity {

    readonly tags: string[] = [];
    enabled = true;

    /** Called once per breakup, for debris, dust and fires. */
    onBreakup?: (event: WreckEvent) => void;
    /**
     * A mark on the ground: ground point, ground normal, direction of the long
     * axis (horizontal), length, width, darkness 0..1.
     */
    onMark?: (position: THREE.Vector3, normal: THREE.Vector3, dirX: number, dirZ: number,
        length: number, width: number, strength: number) => void;
    /** A scratch laid by a burning piece should smoulder: ground point, seconds, intensity 0..1. */
    onBurn?: (position: THREE.Vector3, life: number, intensity: number) => void;
    /** A piece broke apart on the ground: where, how fast it was going. */
    onSplit?: (position: THREE.Vector3, velocity: THREE.Vector3, strength: number) => void;
    /** Dust kicked up by a piece sliding along the ground. */
    onDust?: (position: THREE.Vector3, velocity: THREE.Vector3, count: number, strength: number) => void;

    private readonly fragments: Fragment[] = [];
    private readonly fires: WreckFire[] = [];
    /** Where the body sits in its own frame (from the last slice): centreline x and the z extent. */
    private bodyFrame: { cx: number; zMin: number; zMax: number; halfSpan: number } | undefined;
    /**
     * How far the last break-up shifted the rear section of the fuselage sideways
     * (m, signed: positive toward +x of the body), and the twist (rad, signed) of
     * it; 0 if the sections were left in line.
     */
    lastDislocationM = 0;
    lastKinkRad = 0;
    /** Test hook: the angle (rad) the tail of the fuselage was bent through by the last break-up. */
    lastBendRad = 0;
    /** Test hook: the upward (+) or downward (-) part of that bend, rad. */
    lastBendUpRad = 0;
    /** Test hook: the size of the whole fold now, summed over every impact so far (rad). */
    lastTotalBendRad = 0;
    /** The wing sections the last wing fold bent (cells 3-6). */
    private lastBentCells = new Set<number>();
    /** The wing sections the last wing fold would have bent past the maximum: they break off. */
    private lastBrokenCells = new Set<number>();
    /** An aircraft was bent or torn by an impact it survived: fuel fires start where. */
    onDamage: ((e: WreckDamageEvent) => void) | undefined;
    /** Seconds of simulated time (sum of update deltas): damage blows are told apart by it. */
    private clock = 0;
    /** Triangles dropped as scraps (joined to nothing) by the last break-up. */
    lastScrapTriangles = 0;
    /** How the last bend carried each part chunk (rigidly at its station); empty if it was not bent. */
    private lastPartBends = new Map<Chunk, PartBend>();
    /** Ground that moves under the wreckage (a carrier deck), if any. */
    private movingSurface: MovingSurface | undefined;
    private readonly noMotion = new THREE.Vector3();
    /** Whether a point is open water (not land, not a deck or runway standing in it). */
    private isWaterAt: ((x: number, z: number) => boolean) | undefined;
    /**
     * Height of the sea itself at a point. Not the ground height, which includes the
     * carrier's hull and deck: over the ship that would read as 20 m of "water".
     */
    private waterSurfaceAt: ((x: number, z: number) => number) | undefined;
    /** A piece has gone into the water: where, how fast, and how hard (0.2..1.6). */
    onSplash?: (position: THREE.Vector3, velocity: THREE.Vector3, strength: number) => void;
    /**
     * Foam on the water round a piece in it: the centre of the patch (on the surface),
     * how big the piece is (m), and how many puffs of it to lay.
     */
    onFoam?: (position: THREE.Vector3, radius: number, count: number) => void;
    private readonly pendingSplits: { fragment: Fragment; impact: number }[] = [];
    /** Aircraft id → the piece the cockpit is on, and the eye's spot in that piece's frame. */
    private readonly cockpits = new Map<string, {
        fragment: Fragment;
        local: THREE.Vector3;
        /** The airframe's orientation when it broke up. */
        q0: THREE.Quaternion;
    }>();
    private readonly root = new THREE.Object3D();
    private serial = 0;
    private groundHeightAt: (x: number, z: number) => number = () => 0;

    private readonly _v = new THREE.Vector3();
    private readonly _v2 = new THREE.Vector3();
    private readonly _n = new THREE.Vector3();
    private readonly _r = new THREE.Vector3();
    private readonly _q = new THREE.Quaternion();
    private readonly _m = new THREE.Matrix4();
    private readonly _nm = new THREE.Matrix3();

    /** Tell the field where the sea is: pieces going into it splash and sink instead of landing. */
    setWaterTest(
        fn: ((x: number, z: number) => boolean) | undefined,
        surface?: (x: number, z: number) => number,
    ): void {
        this.isWaterAt = fn;
        this.waterSurfaceAt = surface;
    }

    /** True if a point is open water, for the caller to treat a crash there differently. */
    inWater(x: number, z: number): boolean {
        return this.isWaterAt?.(x, z) ?? false;
    }

    /** Wreckage lying on this surface goes along with it. */
    setMovingSurface(surface: MovingSurface | undefined): void {
        this.movingSurface = surface;
    }

    setGroundHeightAt(fn: (x: number, z: number) => number): void {
        this.groundHeightAt = fn;
    }

    init(_scene: Scene): void {
        //
    }

    rebase(shift: FrameShift): void {
        for (const f of this.fragments) {
            shift.point(f.obj.position);
            shift.orientation(f.obj.quaternion);
            shift.vector(f.velocity);
            shift.vector(f.spin);
        }
    }

    /** Remove every fragment (respawn). */
    clear(): void {
        for (const f of this.fragments) {
            this.disposeFragment(f);
        }
        this.fragments.length = 0;
        this.fires.length = 0;
        this.pendingSplits.length = 0;
        this.cockpits.clear();
    }

    /**
     * Take the aircraft apart. Returns false when there is nothing drawable to
     * break up (model not loaded), in which case the caller keeps drawing it.
     */
    spawn(src: WreckSource): boolean {
        this.lastScrapTriangles = 0;
        let bodyChunks = this.sliceBody(src);
        if (bodyChunks === undefined) {
            return false;
        }
        let partChunks = this.slicePartChunks(src);
        // What was torn off by earlier, survivable impacts is already gone.
        if (src.damage) {
            const damage = src.damage;
            bodyChunks = bodyChunks.filter(c => !damage.rippedCells.has(c.cell));
            partChunks = partChunks.filter(c => c.partId === undefined || !damage.rippedParts.has(c.partId));
        }

        // Impact point: the lowest vertex of the airframe.
        const impact = this.lowestVertex([...bodyChunks, ...partChunks]);

        const groundN = this.groundNormal(src.position.x + impact.x, src.position.z + impact.z, new THREE.Vector3());
        const v = src.velocity;
        const vn = v.dot(groundN);
        const vNormal = groundN.clone().multiplyScalar(vn);
        const vTangent = v.clone().sub(vNormal);
        const speedInto = Math.max(0, -vn);
        const speedAlong = vTangent.length();
        // Already bent and torn: the final blow counts for more (see applyDamage).
        const crash = THREE.MathUtils.clamp((speedInto + 0.35 * speedAlong) / 110, 0.2, 1.5);
        const prior = src.damage?.severity ?? 0;
        const severity = prior > 0
            ? Math.min(1.5, Math.max(crash, prior) + CUMULATIVE_SHARE * Math.min(crash, prior))
            : crash;
        const size = Math.max(src.body.maxSize, 1) * Math.max(src.scale.x, 1e-3);

        // The wings fold up where the blow reached them, then the fuselage bends round the
        // impact, to the side, and stays in one piece.
        // (What the airframe has already had is kept; this crash adds its own bend, in its own direction.)
        const priorFold = new Map(src.damage?.wingFold ?? []);
        const priorJoints = [0, 1, 2].map(i => ({
            yaw: src.damage?.joints[i].yaw ?? 0,
            pitch: src.damage?.joints[i].pitch ?? 0,
            shift: src.damage?.joints[i].shift ?? 0,
        }));
        this.bendWings(bodyChunks, partChunks, src, impact, crash, size, priorFold);
        this.dislocateFuselage(bodyChunks, partChunks, src, impact, crash, priorJoints);
        this.bendGearLegs(partChunks, src, impact, severity, size);

        // Decide which sections break away; the rest stay on the airframe.
        const looseBody: Chunk[] = [];
        const hullBody: Chunk[] = [];
        const looseParts: Chunk[] = [];
        const keptParts: Chunk[] = [];
        const centre = new THREE.Vector3();
        const keptGear: Chunk[] = [];
        const breaksAway = (chunk: Chunk, isPart: boolean): boolean => {
            chunk.box.getCenter(centre);
            const d = Math.min(1.15, centre.distanceTo(impact) / size);
            const near = 1.15 - d;
            const score = severity * chunk.weakness * near
                + 0.6 * Math.max(0, severity - 0.7)
                + (Math.random() - 0.5) * 0.3 * bendRamp(severity);
            // The fuselage dislocates and folds first (see dislocateFuselage); only a blow far past
            // what takes a wing off tears one of its sections away, at a joint.
            if (!isPart && chunk.cell >= 0 && chunk.cell <= 2) {
                return score > FUSELAGE_TEAR_THRESHOLD;
            }
            if (!isPart && this.lastBrokenCells.has(chunk.cell)) {
                return true;
            }
            return score > (isPart ? PART_TEAR_THRESHOLD : WING_TEAR_THRESHOLD);
        };
        for (const chunk of bodyChunks) {
            (breaksAway(chunk, false) ? looseBody : hullBody).push(chunk);
        }
        for (const chunk of partChunks) {
            if (breaksAway(chunk, true)) {
                looseParts.push(chunk);
            } else if (chunk.gear) {
                keptGear.push(chunk);
            } else {
                keptParts.push(chunk);
            }
        }

        // Small burning shards torn off and flung clear. They are cut out of the
        // airframe's own triangles so nothing is drawn twice.
        const shardCount = severity < SHARD_MIN_SEVERITY
            ? 0
            : THREE.MathUtils.clamp(Math.round(1 + 6 * (severity - 0.2)), 1, SHARD_MAX);
        const shards = shardCount > 0 ? this.extractShards(bodyChunks, shardCount, size) : [];

        this.serial++;

        // What stays on the airframe is one piece only where its sections are
        // really joined: with a middle section gone, the ends are separate pieces.
        const comps: { chunks: Chunk[]; hull: boolean }[] = looseBody.map(c => ({ chunks: [c], hull: false }));
        for (const joined of this.joinedSections(hullBody)) {
            comps.push({ chunks: joined, hull: true });
        }
        // Gear and surfaces still on are fixed to the section nearest them (the
        // gear to the fuselage), so none ends up floating in a piece it is not part of.
        const hostOf = (part: Chunk, fuselageOnly: boolean): { chunks: Chunk[]; hull: boolean } | undefined => {
            part.box.getCenter(centre);
            const pool = fuselageOnly && bodyChunks.some(c => c.cell <= 2) ? bodyChunks.filter(c => c.cell <= 2) : bodyChunks;
            let host: Chunk | undefined;
            let hostD = Infinity;
            for (const c of pool) {
                const d = c.box.distanceToPoint(centre);
                if (d < hostD) {
                    hostD = d;
                    host = c;
                }
            }
            return comps.find(k => host !== undefined && k.chunks.includes(host));
        };
        for (const gear of keptGear) {
            hostOf(gear, true)?.chunks.push(gear);
        }
        for (const part of keptParts) {
            hostOf(part, false)?.chunks.push(part);
        }
        for (const part of looseParts) {
            comps.push({ chunks: [part], hull: false });
        }
        const owner = new Map<Chunk, Fragment>();
        for (const comp of comps) {
            const frag = this.buildFragment(comp.chunks, comp.hull, src.position, vNormal, vTangent, groundN, impact, severity, size);
            for (const chunk of comp.chunks) {
                owner.set(chunk, frag);
            }
        }

        // Fires stay with the piece they were on: the fuselage burns wherever
        // it ends up, smaller fires smoulder at each wing root.
        if (src.cockpit) {
            const eye = src.cockpit.clone().applyQuaternion(src.quaternion);
            let best: Fragment | undefined;
            let bestD = Infinity;
            for (const chunk of bodyChunks) {
                const d = chunk.box.distanceToPoint(eye);
                if (d < bestD && owner.has(chunk)) {
                    bestD = d;
                    best = owner.get(chunk);
                }
            }
            if (best) {
                this.cockpits.set(src.id, { fragment: best, local: eye.sub(best.centre), q0: src.quaternion.clone() });
            }
        }

        const fires: WreckFire[] = [];
        for (const chunk of bodyChunks) {
            const frag = owner.get(chunk);
            if (!chunk.anchor || !frag) {
                continue;
            }
            const kind = chunk.cell === 1 ? 'fuselage' : 'wingRoot';
            if (kind === 'wingRoot' && severity < 0.35 && Math.random() < 0.5) {
                continue;
            }
            fires.push({ fragment: frag, local: chunk.anchor.clone().sub(frag.centre), kind });
        }
        this.fires.push(...fires);
        if (!fires.some(f => f.kind === 'fuselage')) {
            // No middle section (tiny model): burn the largest piece.
            const frag = this.fragments[this.fragments.length - 1];
            if (frag) {
                const fallback: WreckFire = { fragment: frag, local: new THREE.Vector3(), kind: 'fuselage' };
                fires.push(fallback);
                this.fires.push(fallback);
            }
        }

        for (const shard of shards) {
            const frag = this.buildFragment([shard], false, src.position, vNormal, vTangent, groundN, impact, severity, size);
            this.burstSideways(frag, vTangent, impact, severity);
            const brand: WreckFire = { fragment: frag, local: new THREE.Vector3(), kind: 'brand' };
            fires.push(brand);
            this.fires.push(brand);
        }

        while (this.fragments.length > MAX_FRAGMENTS) {
            this.disposeFragment(this.fragments.shift()!);
        }

        const water = this.inWater(src.position.x + impact.x, src.position.z + impact.z);
        if (!water) {
            this.markFirstImpact(src.position, impact, groundN, vTangent, severity);
        }
        this.onBreakup?.({
            water,
            id: src.id,
            position: impact.clone().add(src.position),
            velocity: v.clone(),
            normal: groundN,
            severity,
            fires,
        });
        return this.fragments.length > 0;
    }

    /**
     * A hard impact that did not destroy the aircraft: bend its fuselage and tear
     * off whatever the blow is hard enough to take (wing sections, control
     * surfaces), which fly off as pieces, while the rest carries on. The result
     * is kept in `state` (see AirframeDamage); only a harder impact than any
     * so far changes anything. `hit` is the impact point, in the scene.
     * Returns whether anything changed.
     */
    applyDamage(src: WreckSource, state: AirframeDamage, severity: number, hit: THREE.Vector3): boolean {
        // Damage adds up: a new blow on an airframe already bent or torn counts for more, so what is
        // weakened breaks off or bends further. Blows in quick succession (one slide scraping) are
        // one impact and only count for the hardest of them.
        const blow = THREE.MathUtils.clamp(severity, 0.2, 1.5);
        const sameImpact = this.clock - state.lastBlowAt < SAME_IMPACT_S;
        const sev = sameImpact
            ? Math.max(blow, state.severity)
            : THREE.MathUtils.clamp(
                Math.max(blow, state.severity) + CUMULATIVE_SHARE * Math.min(blow, state.severity), 0.2, 1.5);
        state.lastBlowAt = this.clock;
        if (sev <= state.severity + 0.01) {
            return false;
        }
        // The airframe in its own frame, at the origin, so what is cut is in the body frame.
        const inv = src.quaternion.clone().invert();
        const parts: WreckPart[] = src.parts.map((part, i) => ({
            ...part,
            id: part.id ?? i,
            position: part.position.clone().sub(src.position).applyQuaternion(inv),
            quaternion: inv.clone().multiply(part.quaternion),
        }));
        const body: WreckSource = {
            ...src,
            position: new THREE.Vector3(),
            quaternion: new THREE.Quaternion(),
            velocity: src.velocity.clone().applyQuaternion(inv),
            parts,
            damage: undefined,
        };
        let bodyChunks = this.sliceBody(body);
        if (bodyChunks === undefined) {
            return false;
        }
        let partChunks = this.slicePartChunks(body);
        const gearPresent = partChunks.some(c => c.gear);
        bodyChunks = bodyChunks.filter(c => !state.rippedCells.has(c.cell));
        partChunks = partChunks.filter(c => c.partId === undefined || !state.rippedParts.has(c.partId));

        const hitLocal = hit.clone().sub(src.position).applyQuaternion(inv);
        const size = Math.max(src.body.maxSize, 1) * Math.max(src.scale.x, 1e-3);
        // What this blow bends is its own: added to what is already bent, in its own direction (a
        // scrape within the same impact only adds what it has over the harder part of it).
        const bendBy = sameImpact ? sev - state.severity : blow;
        const wingParts = this.bendWings(bodyChunks, partChunks, body, hitLocal, bendBy, size, state.wingFold);
        this.dislocateFuselage(bodyChunks, partChunks, body, hitLocal, bendBy, state.joints);
        const bends = this.lastPartBends;
        this.bendGearLegs(partChunks, body, hitLocal, sev, size);

        // What this blow is hard enough to tear off, by the same measure as a crash.
        const centre = new THREE.Vector3();
        const tears = (chunk: Chunk, isPart: boolean): boolean => {
            chunk.box.getCenter(centre);
            const near = 1.15 - Math.min(1.15, centre.distanceTo(hitLocal) / size);
            const score = sev * chunk.weakness * near + 0.6 * Math.max(0, sev - 0.7) + (Math.random() - 0.5) * 0.3 * bendRamp(sev);
            return score > (isPart ? PART_TEAR_THRESHOLD : WING_TEAR_THRESHOLD);
        };
        const frontPlus = src.cockpit && this.bodyFrame
            ? src.cockpit.z >= 0.5 * (this.bodyFrame.zMin + this.bodyFrame.zMax) : true;
        // The fuselage thirds run from low z to high z: the tail is the one away from the cockpit.
        const aftCell = frontPlus ? 0 : 2;
        const fuselageTears = (chunk: Chunk): boolean => {
            chunk.box.getCenter(centre);
            const near = 1.15 - Math.min(1.15, centre.distanceTo(hitLocal) / size);
            const score = sev * chunk.weakness * near + 0.6 * Math.max(0, sev - 0.7)
                + (Math.random() - 0.5) * 0.3 * bendRamp(sev);
            return score > FUSELAGE_TEAR_THRESHOLD;
        };
        const torn: Chunk[] = [];
        const kept: Chunk[] = [];
        for (const chunk of bodyChunks) {
            // A blow that the aircraft survives can take its tail section off, never the nose or
            // the middle (that would be the end of it: the crash break-up deals with those).
            const tearsFuselage = chunk.cell === aftCell && fuselageTears(chunk);
            const folded = chunk.cell >= 3 && this.lastBrokenCells.has(chunk.cell);
            if ((chunk.cell >= 3 && tears(chunk, false)) || tearsFuselage || folded) {
                torn.push(chunk);
                state.rippedCells.add(chunk.cell);
            } else {
                kept.push(chunk);
            }
        }
        state.partBends.clear();
        const keptGear: Chunk[] = [];
        state.rootParts.clear();
        for (const chunk of partChunks) {
            if (chunk.partId !== undefined && tears(chunk, true)) {
                torn.push(chunk);
                state.rippedParts.add(chunk.partId);
            } else if (chunk.gear) {
                keptGear.push(chunk); // drawn with the airframe, bent
            } else if (chunk.partId !== undefined && wingParts.has(chunk.partId)) {
                keptGear.push(chunk); // on a folded wing: drawn with the airframe, as it is now
                state.rootParts.add(chunk.partId);
            } else if (chunk.partId !== undefined) {
                const bend = bends.get(chunk);
                if (bend) {
                    state.partBends.set(chunk.partId, bend);
                }
            }
        }

        // The torn pieces fly off with the aircraft's own motion, out of the body frame and into the world.
        if (torn.length > 0) {
            const groundN = this.groundNormal(hit.x, hit.z, new THREE.Vector3());
            const v = src.velocity;
            const vNormal = groundN.clone().multiplyScalar(v.dot(groundN));
            const vTangent = v.clone().sub(vNormal);
            const impactRel = hit.clone().sub(src.position);
            this.serial++;
            for (const chunk of torn) {
                this.rotateChunk(chunk, src.quaternion);
                this.buildFragment([chunk], false, src.position, vNormal, vTangent, groundN, impactRel, sev, size);
            }
            this.onSplit?.(hit.clone(), v.clone(), Math.min(1.5, sev));
        }

        // What is left is drawn, in the body frame, at the aircraft pose.
        const root = new THREE.Object3D();
        for (const chunk of [...kept, ...keptGear]) {
            for (const cm of chunk.meshes) {
                const geo = new THREE.BufferGeometry();
                for (const [name, a] of cm.attrs) {
                    geo.setAttribute(name, new THREE.BufferAttribute(new Float32Array(a.data), a.itemSize));
                }
                geo.computeBoundingSphere();
                const mesh = new THREE.Mesh(geo, cm.material);
                mesh.frustumCulled = false;
                mesh.onBeforeRender = updateUniforms;
                root.add(mesh);
            }
        }
        state.severity = sev;
        state.gearInRoot = gearPresent;
        state.setRoot(root);
        this.igniteDamage(src, state, bodyChunks, hitLocal, sev, torn);
        return true;
    }

    /**
     * Fuel fires start as soon as the airframe is bent or torn: at the fuselage
     * where it was bent, and at the root of each wing section that was bent or
     * torn off. Each site ignites once (see AirframeDamage.fireSites). The
     * positions are in the body frame, in metres.
     */
    private igniteDamage(
        src: WreckSource, state: AirframeDamage, bodyChunks: Chunk[], hitLocal: THREE.Vector3, sev: number,
        torn: Chunk[],
    ): void {
        const frame = this.bodyFrame;
        if (!this.onDamage || !frame) {
            return;
        }
        const sx = src.scale.x;
        const sz = src.scale.z;
        const fires: WreckDamageEvent['fires'] = [];
        const middle = bodyChunks.find(c => c.cell === 1);
        const midY = middle && !middle.box.isEmpty() ? middle.box.getCenter(new THREE.Vector3()).y : hitLocal.y;
        if ((this.lastDislocationM !== 0 || this.lastBendRad !== 0) && !state.fireSites.has(-1)) {
            state.fireSites.add(-1);
            const z = THREE.MathUtils.clamp(hitLocal.z, frame.zMin * sz, frame.zMax * sz);
            fires.push({ kind: 'fuselage', local: new THREE.Vector3(frame.cx * sx, midY, z) });
        }
        const cells = new Set<number>(this.lastBentCells);
        for (const c of torn) {
            if (c.cell >= 3) {
                cells.add(c.cell);
            }
        }
        for (const cell of cells) {
            if (state.fireSites.has(cell)) {
                continue;
            }
            state.fireSites.add(cell);
            const chunk = bodyChunks.find(c => c.cell === cell);
            const side = cell < 5 ? -1 : 1;
            const level = (cell - 3) % 2;
            const z = chunk && !chunk.box.isEmpty() ? chunk.box.getCenter(new THREE.Vector3()).z : hitLocal.z;
            const x = (frame.cx + side * (level === 0 ? 0.2 : 0.6) * frame.halfSpan) * sx;
            fires.push({ kind: 'wingRoot', local: new THREE.Vector3(x, midY, z) });
        }
        if (fires.length > 0) {
            this.onDamage({ id: src.id, severity: sev, fires });
        }
    }

    /** Turn a chunk\'s data (positions, normals, box, anchor) by a rotation. */
    private rotateChunk(chunk: Chunk, q: THREE.Quaternion): void {
        const p = new THREE.Vector3();
        chunk.box.makeEmpty();
        for (const cm of chunk.meshes) {
            const pos = cm.attrs.get('position')?.data;
            const nrm = cm.attrs.get('normal')?.data;
            if (pos) {
                for (let i = 0; i < pos.length; i += 3) {
                    p.set(pos[i], pos[i + 1], pos[i + 2]).applyQuaternion(q);
                    pos[i] = p.x;
                    pos[i + 1] = p.y;
                    pos[i + 2] = p.z;
                    chunk.box.expandByPoint(p);
                }
            }
            if (nrm) {
                for (let i = 0; i < nrm.length; i += 3) {
                    p.set(nrm[i], nrm[i + 1], nrm[i + 2]).applyQuaternion(q);
                    nrm[i] = p.x;
                    nrm[i + 1] = p.y;
                    nrm[i + 2] = p.z;
                }
            }
        }
        if (chunk.anchor) {
            chunk.anchor.applyQuaternion(q);
        }
    }

    update(delta: number): void {
        this.clock += delta;
        const dt = Math.min(delta, MAX_STEP_S) / SUBSTEPS;
        if (dt <= 0) {
            return;
        }
        this.carryWithSurface(delta);
        this.reseatSleepers(delta);
        for (let s = 0; s < SUBSTEPS; s++) {
            for (const f of this.fragments) {
                if (!f.asleep) {
                    this.step(f, dt);
                }
            }
            this.applySplits();
        }
    }

    /**
     * A piece at rest is not stepped, so it would stay where it fell however the
     * ground under it moves: a deck that rises as the ship steams on (the hull
     * follows the sea's curve) would swallow it, and a runway tile that streams in
     * higher or lower would bury it or leave it hanging. Every so often each one
     * checks its contact points against the ground: sunk in, it is lifted out;
     * left hanging over a gap, it wakes and falls.
     */
    private reseatSleepers(delta: number): void {
        for (const f of this.fragments) {
            if (!f.asleep || f.disposed || f.wet) {
                continue;
            }
            f.reseatS = (f.reseatS ?? Math.random() * RESEAT_INTERVAL_S) + delta;
            if (f.reseatS < RESEAT_INTERVAL_S) {
                continue;
            }
            f.reseatS = 0;
            const obj = f.obj;
            let sunk = 0;
            let lowestGap = Infinity;
            for (const c of f.corners) {
                this._r.copy(c).applyQuaternion(obj.quaternion);
                const wx = obj.position.x + this._r.x;
                const wz = obj.position.z + this._r.z;
                const gap = obj.position.y + this._r.y - this.groundHeightAt(wx, wz);
                sunk = Math.max(sunk, -gap);
                lowestGap = Math.min(lowestGap, gap);
            }
            if (sunk > RESEAT_SINK_M) {
                obj.position.y += sunk;
            } else if (lowestGap > RESEAT_HANG_M) {
                f.asleep = false;
                f.restTime = 0;
            }
        }
    }

    /**
     * Note which pieces are lying on the moving surface this frame, and carry
     * the ones at rest along with it (the ones still moving feel it as the
     * ground sliding under them, see `step`).
     */
    private carryWithSurface(delta: number): void {
        const surface = this.movingSurface;
        for (const f of this.fragments) {
            const p = f.obj.position;
            // A piece in the water is in the water: the ship's motion does not carry it.
            // Judged by the piece's lowest point: a tall piece (a wing folded up) has its centre well
            // above the deck it is standing on.
            let probeY = p.y;
            if (surface !== undefined) {
                const e = CARRY_MATRIX.makeRotationFromQuaternion(f.obj.quaternion).elements;
                const hy = Math.abs(e[1]) * f.half.x + Math.abs(e[5]) * f.half.y + Math.abs(e[9]) * f.half.z;
                probeY = p.y - hy + 0.5;
            }
            f.onMover = !f.wet && surface !== undefined && surface.contains(p.x, probeY, p.z);
            if (f.onMover && f.asleep) {
                p.addScaledVector(surface!.velocity, delta);
            }
        }
    }

    render3D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, lists: Map<string, THREE.Scene>, _palette: Palette): void {
        const list = lists.get(SceneLayers.EntityVolumes);
        if (!list || this.fragments.length === 0) {
            return;
        }
        attachToRenderList(list, this.root);
    }

    render2D(_targetWidth: number, _targetHeight: number, _camera: THREE.Camera, _lists: Set<string>, _painter: CanvasPainter, _palette: Palette): void {
        //
    }

    // --- Slicing ---------------------------------------------------------------

    /** Cut the body's solid meshes into sections. Undefined if there is no geometry. */
    private sliceBody(src: WreckSource): Chunk[] | undefined {
        const level = src.body.lod[0];
        if (level === undefined || level.volumes.length === 0) {
            return undefined;
        }
        const meshes = this.collectMeshes(level.volumes);
        if (meshes.length === 0) {
            return undefined;
        }

        // Body-local bounds decide where the section cuts fall.
        const bounds = new THREE.Box3();
        const tmp = new THREE.Vector3();
        for (const { mesh, matrix } of meshes) {
            const pos = mesh.geometry.getAttribute('position');
            for (let i = 0; i < pos.count; i++) {
                bounds.expandByPoint(tmp.fromBufferAttribute(pos, i).applyMatrix4(matrix));
            }
        }
        const cx = 0.5 * (bounds.min.x + bounds.max.x);
        const halfSpan = Math.max(0.5 * (bounds.max.x - bounds.min.x), 1e-3);
        const zMin = bounds.min.z;
        const zLen = Math.max(bounds.max.z - bounds.min.z, 1e-3);
        this.bodyFrame = { cx, zMin, zMax: bounds.max.z, halfSpan };

        const cellOf = (x: number, z: number): number => {
            const ax = Math.abs(x - cx) / halfSpan;
            if (ax < 0.2) {
                return Math.min(2, Math.floor(THREE.MathUtils.clamp((z - zMin) / zLen, 0, 0.999) * 3));
            }
            const side = x < cx ? 0 : 1;
            return 3 + side * 2 + (ax > 0.6 ? 1 : 0);
        };

        const chunks: Chunk[] = [];
        const localBoxes: THREE.Box3[] = [];
        for (let c = 0; c < CELL_COUNT; c++) {
            chunks.push({ cell: c, meshes: [], box: new THREE.Box3(), weakness: CELL_WEAKNESS[c] });
            localBoxes.push(new THREE.Box3());
        }
        const rot = new THREE.Matrix4().makeRotationFromQuaternion(src.quaternion);
        const scaleM = new THREE.Matrix4().makeScale(src.scale.x, src.scale.y, src.scale.z);
        const toWorldRel = new THREE.Matrix4().multiplyMatrices(rot, scaleM);

        for (const { mesh, matrix } of meshes) {
            const geo = mesh.geometry;
            const pos = geo.getAttribute('position');
            const index = geo.index;
            const triCount = (index ? index.count : pos.count) / 3;
            const perCell: ChunkMesh[] = [];
            const centroid = new THREE.Vector3();
            const modelToWorldRel = new THREE.Matrix4().multiplyMatrices(toWorldRel, matrix);
            this._nm.getNormalMatrix(modelToWorldRel);
            const nm = this._nm.clone();

            for (let t = 0; t < triCount; t++) {
                const ia = index ? index.getX(t * 3) : t * 3;
                const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
                const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
                centroid.set(0, 0, 0);
                for (const vi of [ia, ib, ic]) {
                    centroid.x += pos.getX(vi);
                    centroid.y += pos.getY(vi);
                    centroid.z += pos.getZ(vi);
                }
                centroid.multiplyScalar(1 / 3).applyMatrix4(matrix);
                const cell = cellOf(centroid.x, centroid.z);
                localBoxes[cell].expandByPoint(centroid);
                let cm = perCell[cell];
                if (cm === undefined) {
                    cm = { material: mesh.material, attrs: new Map() };
                    perCell[cell] = cm;
                    chunks[cell].meshes.push(cm);
                }
                this.appendTriangle(cm, geo, [ia, ib, ic], modelToWorldRel, nm, chunks[cell].box);
            }
        }

        // Fire spots, in body-local space: the fuselage's middle, and each wing
        // root (the inner edge of the inner wing section, where it meets the hull).
        const anchorAt = (cell: number, pick: (b: THREE.Box3, out: THREE.Vector3) => void): void => {
            if (localBoxes[cell].isEmpty()) {
                return;
            }
            const local = new THREE.Vector3();
            pick(localBoxes[cell], local);
            chunks[cell].anchor = local.applyMatrix4(toWorldRel);
        };
        anchorAt(1, (b, o) => b.getCenter(o));
        anchorAt(3, (b, o) => { b.getCenter(o); o.x = b.max.x; });
        anchorAt(5, (b, o) => { b.getCenter(o); o.x = b.min.x; });
        return chunks.filter(c => c.meshes.length > 0);
    }

    /**
     * A gear part is a lump of several legs (nose, left main, right main...):
     * split it into one chunk per leg, so each can bend or tear off on its own.
     * Triangles that share a vertex belong together, and so do pieces whose
     * boxes touch (a wheel that sits on its strut). The legs are numbered by
     * their place on the airframe, so the same leg has the same id every time:
     * the first keeps the part's own id, the others get GEAR_LEG_ID_BASE and up.
     */
    private splitGearLegs(chunk: Chunk): Chunk[] {
        type Tri = { cm: number; t: number };
        const tris: Tri[] = [];
        chunk.meshes.forEach((cm, ci) => {
            const n = cm.attrs.get('position')!.data.length / 9;
            for (let t = 0; t < n; t++) {
                tris.push({ cm: ci, t });
            }
        });
        if (tris.length < 2) {
            return [chunk];
        }
        const parent = tris.map((_, i) => i);
        const find = (i: number): number => {
            while (parent[i] !== i) {
                parent[i] = parent[parent[i]];
                i = parent[i];
            }
            return i;
        };
        const keyOwner = new Map<string, number>();
        tris.forEach((tri, ti) => {
            const d = chunk.meshes[tri.cm].attrs.get('position')!.data;
            for (let v = 0; v < 3; v++) {
                const o = tri.t * 9 + v * 3;
                const key = Math.round(d[o] / WELD_M) + ',' + Math.round(d[o + 1] / WELD_M) + ',' + Math.round(d[o + 2] / WELD_M);
                const seen = keyOwner.get(key);
                if (seen === undefined) {
                    keyOwner.set(key, ti);
                } else {
                    parent[find(ti)] = find(seen);
                }
            }
        });
        // Group, with a box each.
        const groups = new Map<number, { tris: Tri[]; box: THREE.Box3 }>();
        const p = new THREE.Vector3();
        tris.forEach((tri, ti) => {
            const r = find(ti);
            let g = groups.get(r);
            if (!g) {
                g = { tris: [], box: new THREE.Box3() };
                groups.set(r, g);
            }
            g.tris.push(tri);
            const d = chunk.meshes[tri.cm].attrs.get('position')!.data;
            for (let v = 0; v < 3; v++) {
                const o = tri.t * 9 + v * 3;
                g.box.expandByPoint(p.set(d[o], d[o + 1], d[o + 2]));
            }
        });
        // Merge pieces whose boxes touch.
        let legs = [...groups.values()];
        let merged = true;
        while (merged && legs.length > 1) {
            merged = false;
            outer:
            for (let i = 0; i < legs.length; i++) {
                for (let j = i + 1; j < legs.length; j++) {
                    if (legs[i].box.clone().expandByScalar(GEAR_LEG_MERGE_M).intersectsBox(legs[j].box)) {
                        legs[i].tris.push(...legs[j].tris);
                        legs[i].box.union(legs[j].box);
                        legs.splice(j, 1);
                        merged = true;
                        break outer;
                    }
                }
            }
        }
        if (legs.length < 2) {
            return [chunk];
        }
        const centreA = new THREE.Vector3();
        const centreB = new THREE.Vector3();
        legs = legs.sort((a, b) => {
            a.box.getCenter(centreA);
            b.box.getCenter(centreB);
            return Math.abs(centreA.x - centreB.x) > 0.05 ? centreA.x - centreB.x : centreA.z - centreB.z;
        });
        const baseId = chunk.partId ?? 0;
        return legs.map((leg, k) => {
            const out: Chunk = {
                cell: -1,
                gear: true,
                partId: k === 0 ? baseId : GEAR_LEG_ID_BASE + baseId * 16 + k,
                meshes: [],
                box: leg.box,
                weakness: chunk.weakness,
            };
            chunk.meshes.forEach((cm, ci) => {
                const mine = leg.tris.filter(t => t.cm === ci);
                if (mine.length === 0) {
                    return;
                }
                const nm: ChunkMesh = { material: cm.material, attrs: new Map() };
                for (const [name, a] of cm.attrs) {
                    const data: number[] = [];
                    const per = a.itemSize * 3;
                    for (const t of mine) {
                        for (let i = 0; i < per; i++) {
                            data.push(a.data[t.t * per + i]);
                        }
                    }
                    nm.attrs.set(name, { data, itemSize: a.itemSize });
                }
                out.meshes.push(nm);
            });
            return out;
        });
    }

    /**
     * Fold the gear legs the blow reached: each leg near the impact swings about
     * its top (where it joins the airframe), as a whole, by up to
     * GEAR_BEND_MAX_RAD (well past a right angle), and stays on until it tears
     * (see breaksAway). A leg far from the impact is left as it is. Works on the
     * chunks' own data.
     */
    private bendGearLegs(
        partChunks: Chunk[], src: WreckSource, impact: THREE.Vector3, severity: number, size: number,
    ): void {
        if (severity <= BEND_RAMP_FROM) {
            return;
        }
        const inv = src.quaternion.clone().invert();
        const impactLocal = impact.clone().applyQuaternion(inv);
        const vb = src.velocity.clone().applyQuaternion(inv);
        const p = new THREE.Vector3();
        const centre = new THREE.Vector3();
        for (const chunk of partChunks) {
            if (!chunk.gear) {
                continue;
            }
            let top = -Infinity;
            let bottom = Infinity;
            let n = 0;
            centre.set(0, 0, 0);
            for (const cm of chunk.meshes) {
                const d = cm.attrs.get('position')!.data;
                for (let i = 0; i < d.length; i += 3) {
                    p.set(d[i], d[i + 1], d[i + 2]).applyQuaternion(inv);
                    top = Math.max(top, p.y);
                    bottom = Math.min(bottom, p.y);
                    centre.add(p);
                    n++;
                }
            }
            const length = top - bottom;
            if (n === 0 || length < 0.2) {
                continue;
            }
            centre.multiplyScalar(1 / n);
            const near = THREE.MathUtils.clamp(1.15 - centre.distanceTo(impactLocal) / size, 0, 1.15);
            const angle = THREE.MathUtils.clamp(
                bendRamp(severity) * GEAR_BEND_GAIN * severity * near * (0.6 + 0.8 * Math.random()), 0, GEAR_BEND_MAX_RAD);
            if (angle < 0.08) {
                continue;
            }
            // Folded away from the impact, and the way it was travelling.
            let dx = centre.x - impactLocal.x;
            let dz = centre.z - impactLocal.z;
            const away = Math.hypot(dx, dz);
            if (away > 1e-3) {
                dx /= away;
                dz /= away;
            } else {
                const a = Math.random() * Math.PI * 2;
                dx = Math.cos(a);
                dz = Math.sin(a);
            }
            const speed = Math.hypot(vb.x, vb.z);
            if (speed > 1) {
                dx = 0.5 * dx + 0.5 * vb.x / speed;
                dz = 0.5 * dz + 0.5 * vb.z / speed;
            }
            const dl = Math.hypot(dx, dz) || 1;
            dx /= dl;
            dz /= dl;
            // The whole leg swings about its top, as a rigid piece: its foot goes the way it is
            // pushed, up to well past a right angle. Nothing in it is bent.
            const axis = new THREE.Vector3(dx, 0, dz).cross(new THREE.Vector3(0, 1, 0)).normalize();
            const pivot = new THREE.Vector3(centre.x, top, centre.z);
            const swing = new THREE.Quaternion().setFromAxisAngle(axis, angle);
            chunk.box.makeEmpty();
            for (const cm of chunk.meshes) {
                const d = cm.attrs.get('position')!.data;
                const nrm = cm.attrs.get('normal')?.data;
                for (let i = 0; i < d.length; i += 3) {
                    p.set(d[i], d[i + 1], d[i + 2]).applyQuaternion(inv);
                    p.sub(pivot).applyQuaternion(swing).add(pivot).applyQuaternion(src.quaternion);
                    d[i] = p.x;
                    d[i + 1] = p.y;
                    d[i + 2] = p.z;
                    chunk.box.expandByPoint(p);
                    if (nrm) {
                        p.set(nrm[i], nrm[i + 1], nrm[i + 2]).applyQuaternion(inv).applyQuaternion(swing)
                            .applyQuaternion(src.quaternion);
                        nrm[i] = p.x;
                        nrm[i + 1] = p.y;
                        nrm[i + 2] = p.z;
                    }
                }
            }
        }
    }

    /**
     * Bend the wings: each wing section the blow reached folds upward about its
     * root edge (the outer section about the inner one's end, so the angles add
     * up), by up to WING_BEND_MAX_RAD (past a right angle) as the blow approaches
     * what would tear the section off. Control surfaces over a bent section turn
     * with it. Runs on the sliced data, in the body-origin frame, before the
     * fuselage is dislocated. Returns the ids of the parts it moved.
     */
    private bendWings(
        bodyChunks: Chunk[], partChunks: Chunk[], src: WreckSource, impact: THREE.Vector3, severity: number, size: number,
        fold: Map<number, number>,
    ): Set<number> {
        const moved = new Set<number>();
        this.lastBentCells = new Set();
        this.lastBrokenCells = new Set();
        const frame = this.bodyFrame;
        const hadFold = [...fold.values()].some(v => v !== 0);
        if (!frame || (severity < DISLOCATE_MIN_SEVERITY && !hadFold)) {
            return moved;
        }
        const inv = src.quaternion.clone().invert();
        const impactLocal = impact.clone().applyQuaternion(inv);
        const cx = frame.cx * src.scale.x;
        const halfSpan = frame.halfSpan * src.scale.x;
        const centre = new THREE.Vector3();
        const p = new THREE.Vector3();
        const byCell = new Map<number, Chunk>();
        for (const c of bodyChunks) {
            byCell.set(c.cell, c);
        }
        const sections = (x: number): number => {
            const ax = Math.abs(x - cx) / halfSpan;
            return ax < 0.2 ? -1 : ax > 0.6 ? 1 : 0; // -1 fuselage, 0 inner, 1 outer
        };
        for (const side of [0, 1]) {
            const sign = side === 0 ? -1 : 1; // left wing is at -x
            // The way this blow folds this wing: mostly up (the tip rises), sometimes down.
            const wingDir = Math.random() < BEND_UP_SHARE ? 1 : -1;
            // The turn so far: a point is first turned by the inner hinge, then by the outer.
            const hinges: { x: number; y: number; cos: number; sin: number }[] = [];
            let yMean = 0;
            let yCount = 0;
            const inner = byCell.get(3 + side * 2);
            if (inner) {
                for (const cm of inner.meshes) {
                    const d = cm.attrs.get('position')!.data;
                    for (let i = 0; i < d.length; i += 3) {
                        yMean += p.set(d[i], d[i + 1], d[i + 2]).applyQuaternion(inv).y;
                        yCount++;
                    }
                }
            }
            if (yCount === 0) {
                continue;
            }
            yMean /= yCount;
            for (let level = 0; level < 2; level++) {
                const chunk = byCell.get(3 + side * 2 + level);
                if (!chunk) {
                    break;
                }
                chunk.box.getCenter(centre).applyQuaternion(inv);
                const near = THREE.MathUtils.clamp(1.15 - centre.distanceTo(impactLocal) / size, 0, 1.15);
                const score = severity * chunk.weakness * near + 0.6 * Math.max(0, severity - 0.7);
                const frac = THREE.MathUtils.clamp(score / WING_TEAR_THRESHOLD, 0, 1);
                const cell = 3 + side * 2 + level;
                // This blow's fold, added to what the section already has, in its own direction.
                const inc = severity > BEND_RAMP_FROM
                    ? wingDir * WING_BEND_MAX_RAD * frac * bendRamp(severity) * (0.7 + 0.3 * Math.random()) : 0;
                const wanted = (fold.get(cell) ?? 0) + inc;
                if (Math.abs(wanted) > WING_BEND_MAX_RAD + 1e-9) {
                    // Further than a wing bends: it goes.
                    this.lastBrokenCells.add(cell);
                }
                const folded = THREE.MathUtils.clamp(wanted, -WING_BEND_MAX_RAD, WING_BEND_MAX_RAD);
                fold.set(cell, folded);
                const angle = Math.abs(folded) >= WING_BEND_MIN_RAD ? folded : 0;
                if (Math.abs(inc) >= WING_BEND_MIN_RAD) {
                    this.lastBentCells.add(cell);
                }
                // Hinge at this section's inner edge, in the frame after the earlier hinges.
                const hx0 = cx + sign * (level === 0 ? 0.2 : 0.6) * halfSpan;
                let hx = hx0;
                let hy = yMean;
                for (const h of hinges) {
                    const dx = hx - h.x;
                    const dy = hy - h.y;
                    hx = h.x + dx * h.cos - dy * h.sin;
                    hy = h.y + dx * h.sin + dy * h.cos;
                }
                const a = sign * angle; // the tip goes up (angle > 0) or down
                hinges.push({ x: hx, y: hy, cos: Math.cos(a), sin: Math.sin(a) });
            }
            if (hinges.every(h => h.sin === 0)) {
                continue;
            }
            // Which hinges act on a point: the inner one on the inner and outer sections,
            // the outer one on the outer section only.
            const turn = (v: THREE.Vector3, upTo: number): void => {
                for (let k = 0; k < Math.min(hinges.length, upTo + 1); k++) {
                    const h = hinges[k];
                    // hinge k belongs to level (hinges[0] is the inner one only if it folded)
                    const dx = v.x - h.x;
                    const dy = v.y - h.y;
                    v.x = h.x + dx * h.cos - dy * h.sin;
                    v.y = h.y + dx * h.sin + dy * h.cos;
                }
            };
            const levelsFolded = hinges.length;
            const apply = (chunk: Chunk, level: number): void => {
                chunk.box.makeEmpty();
                for (const cm of chunk.meshes) {
                    const pos = cm.attrs.get('position')!.data;
                    const nrm = cm.attrs.get('normal')?.data;
                    for (let i = 0; i < pos.length; i += 3) {
                        p.set(pos[i], pos[i + 1], pos[i + 2]).applyQuaternion(inv);
                        turn(p, level);
                        p.applyQuaternion(src.quaternion);
                        pos[i] = p.x;
                        pos[i + 1] = p.y;
                        pos[i + 2] = p.z;
                        chunk.box.expandByPoint(p);
                        if (nrm) {
                            p.set(nrm[i], nrm[i + 1], nrm[i + 2]).applyQuaternion(inv);
                            for (let k = 0; k < Math.min(levelsFolded, level + 1); k++) {
                                const h = hinges[k];
                                const x = p.x * h.cos - p.y * h.sin;
                                p.y = p.x * h.sin + p.y * h.cos;
                                p.x = x;
                            }
                            p.applyQuaternion(src.quaternion);
                            nrm[i] = p.x;
                            nrm[i + 1] = p.y;
                            nrm[i + 2] = p.z;
                        }
                    }
                }
                if (chunk.anchor) {
                    p.copy(chunk.anchor).applyQuaternion(inv);
                    turn(p, level);
                    chunk.anchor.copy(p).applyQuaternion(src.quaternion);
                }
            };
            for (let level = 0; level < 2; level++) {
                const chunk = byCell.get(3 + side * 2 + level);
                if (chunk) {
                    apply(chunk, level);
                }
            }
            // Parts (control surfaces) on a bent section turn with it.
            for (const part of partChunks) {
                if (part.gear) {
                    continue;
                }
                part.box.getCenter(centre).applyQuaternion(inv);
                if (Math.sign(centre.x - cx) !== sign) {
                    continue;
                }
                const where = sections(centre.x);
                if (where < 0) {
                    continue;
                }
                apply(part, where);
                if (part.partId !== undefined) {
                    moved.add(part.partId);
                }
            }
        }
        return moved;
    }

    /** Each gear leg / control surface is a chunk of its own. */
    private slicePartChunks(src: WreckSource): Chunk[] {
        const out: Chunk[] = [];
        const rel = new THREE.Vector3();
        for (let partIndex = 0; partIndex < src.parts.length; partIndex++) {
            const part = src.parts[partIndex];
            const level = part.model.lod[0];
            if (level === undefined || level.volumes.length === 0) {
                continue;
            }
            const meshes = this.collectMeshes(level.volumes);
            if (meshes.length === 0) {
                continue;
            }
            rel.copy(part.position).sub(src.position);
            const xf = new THREE.Matrix4().compose(rel, part.quaternion, src.scale);
            const chunk: Chunk = {
                cell: -1,
                gear: part.kind === 'gear',
                partId: part.id ?? partIndex,
                meshes: [],
                box: new THREE.Box3(),
                weakness: part.kind === 'gear' ? 1.4 : 1.2,
            };
            for (const { mesh, matrix } of meshes) {
                const geo = mesh.geometry;
                const pos = geo.getAttribute('position');
                const index = geo.index;
                const triCount = (index ? index.count : pos.count) / 3;
                const m = new THREE.Matrix4().multiplyMatrices(xf, matrix);
                const nm = new THREE.Matrix3().getNormalMatrix(m);
                const cm: ChunkMesh = { material: mesh.material, attrs: new Map() };
                for (let t = 0; t < triCount; t++) {
                    const ia = index ? index.getX(t * 3) : t * 3;
                    const ib = index ? index.getX(t * 3 + 1) : t * 3 + 1;
                    const ic = index ? index.getX(t * 3 + 2) : t * 3 + 2;
                    this.appendTriangle(cm, geo, [ia, ib, ic], m, nm, chunk.box);
                }
                chunk.meshes.push(cm);
            }
            if (part.kind === 'gear') {
                out.push(...this.splitGearLegs(chunk));
            } else {
                out.push(chunk);
            }
        }
        return out;
    }

    private collectMeshes(roots: THREE.Object3D[]): { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] {
        const out: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];
        for (const root of roots) {
            root.updateMatrix();
            root.traverse(o => {
                const mesh = o as THREE.Mesh;
                if (!mesh.isMesh || !mesh.geometry || mesh.geometry.getAttribute('position') === undefined) {
                    return;
                }
                if (mesh.visible === false) {
                    return;
                }
                // Meshes are loaded with their world matrix baked into position/quaternion/scale.
                mesh.updateMatrix();
                out.push({ mesh, matrix: mesh.matrix.clone() });
            });
        }
        return out;
    }

    private appendTriangle(
        cm: ChunkMesh, geo: THREE.BufferGeometry, verts: number[],
        m: THREE.Matrix4, nm: THREE.Matrix3, box: THREE.Box3,
    ): void {
        for (const name of COPIED_ATTRIBUTES) {
            const attr = geo.getAttribute(name);
            if (attr === undefined) {
                continue;
            }
            let dst = cm.attrs.get(name);
            if (dst === undefined) {
                dst = { data: [], itemSize: attr.itemSize };
                cm.attrs.set(name, dst);
            }
            for (const vi of verts) {
                if (name === 'position') {
                    this._r.fromBufferAttribute(attr, vi).applyMatrix4(m);
                    dst.data.push(this._r.x, this._r.y, this._r.z);
                    box.expandByPoint(this._r);
                } else if (name === 'normal') {
                    this._r.fromBufferAttribute(attr, vi).applyMatrix3(nm).normalize();
                    dst.data.push(this._r.x, this._r.y, this._r.z);
                } else {
                    for (let k = 0; k < attr.itemSize; k++) {
                        dst.data.push(attr.getComponent(vi, k));
                    }
                }
            }
        }
    }

    private lowestVertex(chunks: Chunk[]): THREE.Vector3 {
        const best = new THREE.Vector3();
        let bestY = Infinity;
        for (const c of chunks) {
            for (const cm of c.meshes) {
                const p = cm.attrs.get('position')!.data;
                for (let i = 0; i < p.length; i += 3) {
                    if (p[i + 1] < bestY) {
                        bestY = p[i + 1];
                        best.set(p[i], p[i + 1], p[i + 2]);
                    }
                }
            }
        }
        return best;
    }

    // --- Fragments -------------------------------------------------------------

    /**
     * Where the aircraft's origin and orientation would be if the airframe were
     * still rigid with its cockpit piece. Lets every camera view, which places
     * itself from the aircraft pose, follow the cockpit after a crash.
     */
    cockpitBodyPose(id: string, outPosition: THREE.Vector3, outQuaternion: THREE.Quaternion): boolean {
        const c = this.cockpits.get(id);
        if (!c || c.fragment.disposed) {
            return false;
        }
        const f = c.fragment;
        outPosition.copy(f.originLocal).applyQuaternion(f.obj.quaternion).add(f.obj.position);
        outQuaternion.copy(f.obj.quaternion).multiply(c.q0);
        if (f.wet) {
            // A camera riding the cockpit down stays above the water and watches it go.
            outPosition.y = Math.max(outPosition.y, f.waterY + 1);
        }
        return true;
    }

    /** Scorch where the airframe struck, with pocks thrown around it. */
    private markFirstImpact(
        origin: THREE.Vector3, impact: THREE.Vector3, normal: THREE.Vector3,
        vTangent: THREE.Vector3, severity: number,
    ): void {
        if (!this.onMark) {
            return;
        }
        const x = origin.x + impact.x;
        const z = origin.z + impact.z;
        const dir = Math.hypot(vTangent.x, vTangent.z) > 1e-3
            ? this._v.set(vTangent.x, 0, vTangent.z).normalize()
            : this._v.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        const dx = dir.x;
        const dz = dir.z;
        const at = this._v2.set(x, this.groundHeightAt(x, z), z);
        const n = this.groundNormal(x, z, this._n);
        this.onMark(at, n, dx, dz, 6 + 14 * severity, 4 + 7 * severity, 0.9);
        const pocks = 3 + Math.round(4 * severity);
        for (let i = 0; i < pocks; i++) {
            const r = (2 + Math.random() * 10) * (0.5 + severity);
            const a = Math.random() * Math.PI * 2;
            const px = x + Math.cos(a) * r + dx * r * 0.6;
            const pz = z + Math.sin(a) * r + dz * r * 0.6;
            const size = 1 + Math.random() * 2.5 * (0.5 + severity);
            this.onMark(
                this._v2.set(px, this.groundHeightAt(px, pz), pz),
                this.groundNormal(px, pz, this._n),
                Math.random() - 0.5, Math.random() - 0.5, size * 1.4, size, 0.6 + Math.random() * 0.3);
        }
    }

    /** World position of the pilot's eye on its wreck piece; false if none (or dropped). */
    cockpitWorld(id: string, out: THREE.Vector3): boolean {
        const c = this.cockpits.get(id);
        if (!c || c.fragment.disposed) {
            return false;
        }
        out.copy(c.local).applyQuaternion(c.fragment.obj.quaternion).add(c.fragment.obj.position);
        return true;
    }

    /**
     * Dislocate and bend the fuselage: its three sections (fore, middle, aft)
     * are moved whole against each other at the joints: shifted sideways, and
     * hinged by an angle that can lie in any plane through the fuselage's axis,
     * sideways, upward (the tail rises) or downward, as the blow dictates. Each
     * section is moved as it is, never deformed, and nothing is torn: they still
     * overlap at the joints.
     *
     * The front section (where the cockpit is) keeps its place. The joint nearest
     * the impact takes most of the movement. Wings, gear and control surfaces
     * move with the section they are on. Works on the sliced data, in the
     * body-origin frame.
     */
    private dislocateFuselage(
        bodyChunks: Chunk[], partChunks: Chunk[], src: WreckSource, impact: THREE.Vector3, severity: number,
        joints: JointState[],
    ): void {
        const frame = this.bodyFrame;
        this.lastDislocationM = 0;
        this.lastKinkRad = 0;
        this.lastBendRad = 0;
        this.lastBendUpRad = 0;
        this.lastTotalBendRad = 0;
        this.lastPartBends = new Map();
        const hadBend = joints.some(j => j.yaw !== 0 || j.pitch !== 0 || j.shift !== 0);
        if (!frame || (severity < DISLOCATE_MIN_SEVERITY && !hadBend)) {
            return;
        }
        const length = frame.zMax - frame.zMin;
        if (length < 1e-3) {
            return;
        }
        const inv = src.quaternion.clone().invert();
        const scale = src.scale;
        const frontPlus = src.cockpit ? src.cockpit.z >= 0.5 * (frame.zMin + frame.zMax) : true;
        const dirZ = frontPlus ? 1 : -1;
        const zFront = frontPlus ? frame.zMax : frame.zMin;
        const third = length / 3;

        // Which way: the rear goes the way the aircraft was being thrown sideways, else either.
        const vb = src.velocity.clone().applyQuaternion(inv);
        const side = Math.abs(vb.x) > 2 ? Math.sign(vb.x) : (Math.random() < 0.5 ? -1 : 1);

        // In which plane it folds: from sideways (0) to vertical (pi/2), by how much of the blow was
        // sideways and how much was straight into the ground, and a good deal of chance (a fuselage
        // folds where it is weakest). Vertically it mostly folds upward, the tail rising.
        const lateral = Math.abs(vb.x);
        const vertical = Math.abs(vb.y);
        const planeByBlow = Math.atan2(0.6 * vertical + 1, lateral + 1);
        const plane = THREE.MathUtils.clamp(
            BEND_PLANE_BLOW_SHARE * planeByBlow + (1 - BEND_PLANE_BLOW_SHARE) * Math.random() * Math.PI / 2, 0, Math.PI / 2);
        const upSign = Math.random() < BEND_UP_SHARE ? 1 : -1;

        // How wide the fuselage is (its sections 0-2), and where its centreline runs (height).
        let halfWidth = 0;
        let ySum = 0;
        let yCount = 0;
        const probe = new THREE.Vector3();
        for (const chunk of bodyChunks) {
            if (chunk.cell < 0 || chunk.cell > 2) {
                continue;
            }
            for (const cm of chunk.meshes) {
                const d = cm.attrs.get('position')!.data;
                for (let i = 0; i < d.length; i += 3) {
                    probe.set(d[i], d[i + 1], d[i + 2]).applyQuaternion(inv);
                    halfWidth = Math.max(halfWidth, Math.abs(probe.x / scale.x - frame.cx));
                    ySum += probe.y / scale.y;
                    yCount++;
                }
            }
        }
        if (halfWidth < 1e-3) {
            return;
        }
        const centreY = yCount > 0 ? ySum / yCount : 0;
        // This blow's own bend (none if it is too gentle to bend anything).
        const bends = severity > BEND_RAMP_FROM;
        const ramp = bendRamp(severity);
        const total = bends ? ramp * halfWidth * THREE.MathUtils.clamp(
            DISLOCATE_BASE_HALF_WIDTHS + DISLOCATE_PER_SEVERITY_HALF_WIDTHS * severity, 0, DISLOCATE_MAX_HALF_WIDTHS) : 0;
        const kink = bends ? ramp * THREE.MathUtils.clamp(KINK_BASE_RAD + KINK_PER_SEVERITY_RAD * severity, 0, KINK_MAX_RAD) : 0;
        const theta = bends ? ramp * THREE.MathUtils.clamp(BEND_BASE_RAD + BEND_PER_SEVERITY_RAD * severity, 0, BEND_MAX_RAD) : 0;

        // The joints, front to back (1: fore/middle, 2: middle/aft), and the share of the movement each takes.
        const impactLocal = impact.clone().applyQuaternion(inv);
        const uImpact = dirZ * (zFront - impactLocal.z / scale.z);
        const nearJoint = uImpact < 0.5 * length ? 1 : 2;
        const share = [0, 0, 0];
        share[nearJoint] = DISLOCATE_NEAR_JOINT_SHARE;
        share[3 - nearJoint] = 1 - DISLOCATE_NEAR_JOINT_SHARE;

        // Each section's rigid move, in the body's model units: p -> M p. Section 0 (front) is not
        // moved. A joint hinges the sections behind it about itself and shifts them sideways; moves
        // compose from the front backward, each relative to the section in front of it.
        const sections: THREE.Matrix4[] = [new THREE.Matrix4()];
        const sectionQuats: THREE.Quaternion[] = [new THREE.Quaternion()];
        const yawBend = side * dirZ * theta * Math.cos(plane);
        const pitchBend = upSign * dirZ * theta * Math.sin(plane);
        // Add this blow to what the joints already have, and keep the whole within what a fuselage can take.
        for (let j = 1; j <= 2; j++) {
            joints[j].yaw += side * dirZ * kink * share[j] + yawBend * share[j];
            joints[j].pitch += pitchBend * share[j];
            joints[j].shift += side * total * share[j];
        }
        {
            const sumYaw = joints[1].yaw + joints[2].yaw;
            const sumPitch = joints[1].pitch + joints[2].pitch;
            const mag = Math.hypot(sumYaw, sumPitch);
            const cap = BEND_MAX_RAD + KINK_MAX_RAD;
            if (mag > cap) {
                for (let j = 1; j <= 2; j++) {
                    joints[j].yaw *= cap / mag;
                    joints[j].pitch *= cap / mag;
                }
            }
            const sumShift = Math.abs(joints[1].shift) + Math.abs(joints[2].shift);
            const shiftCap = halfWidth * DISLOCATE_MAX_HALF_WIDTHS;
            if (sumShift > shiftCap) {
                for (let j = 1; j <= 2; j++) {
                    joints[j].shift *= shiftCap / sumShift;
                }
            }
            this.lastTotalBendRad = Math.hypot(joints[1].yaw + joints[2].yaw, joints[1].pitch + joints[2].pitch);
        }
        const jointPoint = new THREE.Vector3();
        const toJoint = new THREE.Matrix4();
        const fromJoint = new THREE.Matrix4();
        const hinge = new THREE.Matrix4();
        const turn = new THREE.Matrix4();
        for (let j = 1; j <= 2; j++) {
            // Rotation about the vertical axis (x' = x cos - z sin): the twist and the sideways part of
            // the bend; about the lateral axis, the upward or downward part. Summed over the impacts.
            const yaw = joints[j].yaw;
            const pitch = joints[j].pitch;
            jointPoint.set(frame.cx, centreY, zFront - dirZ * third * j);
            toJoint.makeTranslation(jointPoint.x, jointPoint.y, jointPoint.z);
            fromJoint.makeTranslation(-jointPoint.x, -jointPoint.y, -jointPoint.z);
            turn.makeRotationY(-yaw).multiply(new THREE.Matrix4().makeRotationX(pitch));
            hinge.copy(toJoint).multiply(turn).multiply(fromJoint);
            const shift = new THREE.Matrix4().makeTranslation(joints[j].shift, 0, 0);
            const m = sections[j - 1].clone().multiply(shift).multiply(hinge);
            sections.push(m);
            sectionQuats.push(new THREE.Quaternion().setFromRotationMatrix(m));
        }
        // What the tests and callers can see of it.
        this.lastDislocationM = side * total;
        this.lastKinkRad = side * dirZ * kink;
        this.lastBendRad = side * dirZ * theta;
        this.lastBendUpRad = pitchBend;

        // Which section a station (distance back from the front) is on.
        const sectionAt = (u: number): number => THREE.MathUtils.clamp(Math.floor(u / third), 0, 2);

        const local = new THREE.Vector3();
        const movePoint = (p: THREE.Vector3, section: number): void => {
            local.copy(p).applyQuaternion(inv);
            local.divide(scale).applyMatrix4(sections[section]).multiply(scale);
            p.copy(local).applyQuaternion(src.quaternion);
        };
        const nLocal = new THREE.Vector3();
        const moveNormal = (n: THREE.Vector3, section: number): void => {
            nLocal.copy(n).applyQuaternion(inv).applyQuaternion(sectionQuats[section]);
            n.copy(nLocal).applyQuaternion(src.quaternion);
        };

        const p = new THREE.Vector3();
        const n = new THREE.Vector3();
        const moveChunk = (chunk: Chunk, section: number, isPart: boolean): void => {
            chunk.box.makeEmpty();
            for (const cm of chunk.meshes) {
                const pos = cm.attrs.get('position')!.data;
                const nrm = cm.attrs.get('normal')?.data;
                for (let i = 0; i < pos.length; i += 3) {
                    p.set(pos[i], pos[i + 1], pos[i + 2]);
                    movePoint(p, section);
                    pos[i] = p.x;
                    pos[i + 1] = p.y;
                    pos[i + 2] = p.z;
                    chunk.box.expandByPoint(p);
                    if (nrm) {
                        n.set(nrm[i], nrm[i + 1], nrm[i + 2]);
                        moveNormal(n, section);
                        nrm[i] = n.x;
                        nrm[i + 1] = n.y;
                        nrm[i + 2] = n.z;
                    }
                }
            }
            if (chunk.anchor) {
                movePoint(chunk.anchor, section);
            }
            if (isPart) {
                // A part rides on its section: p' = M p in the body's model units (see PartBend).
                const q = sectionQuats[section];
                this.lastPartBends.set(chunk, {
                    m: sections[section].toArray(),
                    q: [q.x, q.y, q.z, q.w],
                });
            }
        };

        // The station of a chunk not in the fuselage: the mean distance back of its vertices.
        const stationOf = (chunk: Chunk): number => {
            let sum = 0;
            let count = 0;
            for (const cm of chunk.meshes) {
                const d = cm.attrs.get('position')!.data;
                for (let i = 0; i < d.length; i += 3) {
                    p.set(d[i], d[i + 1], d[i + 2]).applyQuaternion(inv);
                    sum += dirZ * (zFront - p.z / scale.z);
                    count++;
                }
            }
            return count > 0 ? sum / count : 0;
        };

        for (const chunk of bodyChunks) {
            if (chunk.cell >= 0 && chunk.cell <= 2) {
                // The fuselage thirds run from low z to high z; the front section is the one at the cockpit end.
                moveChunk(chunk, frontPlus ? 2 - chunk.cell : chunk.cell, false);
            } else {
                moveChunk(chunk, sectionAt(stationOf(chunk)), false);
            }
        }
        for (const chunk of partChunks) {
            moveChunk(chunk, sectionAt(stationOf(chunk)), true);
        }
    }

    /**
     * 0 for a piece lying down; up to 1 for a long piece standing on end. Leaves
     * its long axis (world) in TOPPLE_AXIS. Only pieces much longer than wide count.
     */
    private standingAmount(f: Fragment): number {
        const h = f.half;
        let axis = 0;
        let len = h.x;
        if (h.y > len) {
            axis = 1;
            len = h.y;
        }
        if (h.z > len) {
            axis = 2;
            len = h.z;
        }
        const others = h.x + h.y + h.z - len;
        if (len < TOPPLE_MIN_HALF_M || len < 0.5 * others * 1.0) {
            return this.tallAmount(f);
        }
        TOPPLE_AXIS.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
            .applyQuaternion(f.obj.quaternion);
        if (TOPPLE_AXIS.y < 0) {
            TOPPLE_AXIS.negate();
        }
        const up = Math.abs(TOPPLE_AXIS.y);
        return up > TOPPLE_MIN_UP ? up : 0;
    }

    /**
     * A piece that is not a stick but is tall for its footprint (a fuselage folded
     * up into a V, standing on its ends): 0 if it is not, else how far over the
     * limit, up to 1. Leaves the local axis now most nearly vertical (world,
     * pointing up) in TOPPLE_AXIS, which the toppling torque then pushes over.
     */
    private tallAmount(f: Fragment): number {
        const e = TALL_MATRIX.makeRotationFromQuaternion(f.obj.quaternion).elements;
        const h = f.half;
        const worldY = Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z;
        const worldX = Math.abs(e[0]) * h.x + Math.abs(e[4]) * h.y + Math.abs(e[8]) * h.z;
        const worldZ = Math.abs(e[2]) * h.x + Math.abs(e[6]) * h.y + Math.abs(e[10]) * h.z;
        const footprint = Math.max(worldX, worldZ);
        if (worldY < TOPPLE_MIN_HALF_M || worldY < TALL_RATIO * footprint) {
            return 0;
        }
        const ax = Math.abs(e[1]);
        const ay = Math.abs(e[5]);
        const az = Math.abs(e[9]);
        const k = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
        TOPPLE_AXIS.set(e[k * 4], e[k * 4 + 1], e[k * 4 + 2]);
        if (TOPPLE_AXIS.y < 0) {
            TOPPLE_AXIS.negate();
        }
        return Math.min(1, (worldY / footprint - TALL_RATIO) + 0.3);
    }

    /**
     * 0 for a flat-ish piece that lies on its broad side; otherwise how far it is
     * tipped from that (sin of the angle, up to 1). Leaves the world direction its
     * thinnest axis should be pulling toward vertical in TOPPLE_AXIS (pointing up:
     * the spin that settles it is up x axis, as for toppling).
     */
    private settleTilt(f: Fragment): number {
        const h = f.half;
        const big = Math.max(h.x, h.y, h.z);
        if (big < SETTLE_MIN_HALF_M) {
            return 0;
        }
        // The thinnest axis, and the middle one: only a clearly flat piece has a "flat side".
        let axis = 0;
        let thin = h.x;
        if (h.y < thin) {
            axis = 1;
            thin = h.y;
        }
        if (h.z < thin) {
            axis = 2;
            thin = h.z;
        }
        const mid = h.x + h.y + h.z - big - thin;
        if (thin > SETTLE_FLATNESS * mid) {
            return 0;
        }
        TOPPLE_AXIS.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
            .applyQuaternion(f.obj.quaternion);
        if (TOPPLE_AXIS.y < 0) {
            TOPPLE_AXIS.negate();
        }
        // tilt: sin of the angle from vertical. TOPPLE_AXIS leans toward +Y; ω = up x axis would tip it
        // further, so flip: we want axis -> up, i.e. spin about axis x up.
        const sin = Math.sqrt(Math.max(0, 1 - TOPPLE_AXIS.y * TOPPLE_AXIS.y));
        if (sin < SETTLE_MIN_SIN) {
            return 0;
        }
        TOPPLE_AXIS.negate(); // so up x (-axis) = axis x up
        return Math.min(1, sin * 1.5);
    }

    /** Split sections into runs that are actually joined to each other (see CELL_NEIGHBOURS). */
    private joinedSections(chunks: Chunk[]): Chunk[][] {
        const byCell = new Map<number, Chunk>();
        for (const c of chunks) {
            byCell.set(c.cell, c);
        }
        const seen = new Set<number>();
        const out: Chunk[][] = [];
        for (const c of chunks) {
            if (seen.has(c.cell)) {
                continue;
            }
            const run: Chunk[] = [];
            const stack = [c.cell];
            seen.add(c.cell);
            while (stack.length > 0) {
                const cell = stack.pop()!;
                run.push(byCell.get(cell)!);
                for (const n of CELL_NEIGHBOURS[cell] ?? []) {
                    if (byCell.has(n) && !seen.has(n)) {
                        seen.add(n);
                        stack.push(n);
                    }
                }
            }
            out.push(run);
        }
        return out;
    }

    /**
     * The connected pieces of a cut half, as parts ready to build from. Scraps
     * smaller than COMPONENT_MIN_TRIS are dropped so no loose bits ride along
     * with a piece; if everything is small the largest is kept.
     */
    private connectedParts(parts: SplitPart[]): SplitPart[][] {
        const items: { pos: number[]; t: number; part: number }[] = [];
        parts.forEach((part, part_i) => {
            const pos = part.attrs.get('position')!.data;
            for (let t = 0; t < pos.length / 9; t++) {
                items.push({ pos, t, part: part_i });
            }
        });
        if (items.length === 0) {
            return [];
        }
        const groups = groupTriangles(items).sort((a, b) => b.length - a.length);
        const kept = groups.filter(g => g.length >= COMPONENT_MIN_TRIS).slice(0, COMPONENT_MAX_KEEP);
        if (kept.length === 0) {
            kept.push(groups[0]);
        }
        return kept.map(group => {
            const out = new Map<number, SplitPart>();
            for (const i of group) {
                const { part, t } = items[i];
                let dst = out.get(part);
                if (dst === undefined) {
                    dst = { material: parts[part].material, attrs: new Map() };
                    out.set(part, dst);
                }
                for (const [name, a] of parts[part].attrs) {
                    let d = dst.attrs.get(name);
                    if (d === undefined) {
                        d = { data: [], itemSize: a.itemSize };
                        dst.attrs.set(name, d);
                    }
                    const per = a.itemSize * 3;
                    for (let k = 0; k < per; k++) {
                        d.data.push(a.data[t * per + k]);
                    }
                }
            }
            return [...out.values()];
        });
    }

    /**
     * Cut `count` small shards out of the body chunks. Each is a cluster of
     * neighbouring triangles around a random point, removed from its source so
     * the piece it came from is left with a hole rather than a duplicate.
     */
    private extractShards(chunks: Chunk[], count: number, size: number): Chunk[] {
        const shards: Chunk[] = [];
        const cands: ChunkMesh[] = [];
        for (const chunk of chunks) {
            for (const cm of chunk.meshes) {
                if (cm.attrs.has('position')) {
                    cands.push(cm);
                }
            }
        }
        const trisOf = (cm: ChunkMesh): number => cm.attrs.get('position')!.data.length / 9;
        for (let n = 0; n < count && cands.length > 0; n++) {
            let total = 0;
            for (const cm of cands) {
                total += trisOf(cm);
            }
            // Weighted pick: bigger meshes lose shards more often.
            let pick = Math.random() * total;
            let cm = cands[0];
            for (const c of cands) {
                pick -= trisOf(c);
                if (pick <= 0) {
                    cm = c;
                    break;
                }
            }
            const pos = cm.attrs.get('position')!.data;
            const tris = pos.length / 9;
            if (tris < SHARD_MIN_SOURCE_TRIS) {
                continue;
            }
            const t0 = Math.floor(Math.random() * tris);
            const cx = (pos[t0 * 9] + pos[t0 * 9 + 3] + pos[t0 * 9 + 6]) / 3;
            const cy = (pos[t0 * 9 + 1] + pos[t0 * 9 + 4] + pos[t0 * 9 + 7]) / 3;
            const cz = (pos[t0 * 9 + 2] + pos[t0 * 9 + 5] + pos[t0 * 9 + 8]) / 3;
            const r2 = (size * (0.045 + Math.random() * 0.05)) ** 2;
            // The triangles nearest the seed (so the seed itself is always in, and the
            // shard is round), however many lie within reach and wherever they are in the mesh.
            const near: { t: number; d2: number }[] = [];
            for (let t = 0; t < tris; t++) {
                const x = (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3 - cx;
                const y = (pos[t * 9 + 1] + pos[t * 9 + 4] + pos[t * 9 + 7]) / 3 - cy;
                const z = (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3 - cz;
                const d2 = x * x + y * y + z * z;
                if (d2 < r2) {
                    near.push({ t, d2 });
                }
            }
            near.sort((a, b) => a.d2 - b.d2);
            // Ascending, as the removal below needs.
            let picked: number[] = near.slice(0, SHARD_MAX_TRIS).map(n => n.t).sort((a, b) => a - b);
            // Only the triangles joined to the seed one: a cluster that happens to
            // span a second, unconnected surface would otherwise carry it along.
            const joined = groupTriangles(picked.map(t => ({ pos, t })))
                .find(g => g.some(i => picked[i] === t0)) ?? [];
            picked = joined.map(i => picked[i]).sort((a, b) => a - b);
            if (picked.length < 2 || tris - picked.length < SHARD_MIN_LEFT_TRIS) {
                continue;
            }
            // The cut can leave a few triangles hanging by their corners from the hole,
            // joined to nothing but the part taken out. Those go with it, so the piece
            // it was cut from is left in one part.
            const takenKeys = new Set<string>();
            for (const t of picked) {
                for (let k = 0; k < 3; k++) {
                    takenKeys.add(weldKey(pos, t, k));
                }
            }
            const taken = new Set(picked);
            const rest: number[] = [];
            for (let t = 0; t < tris; t++) {
                if (!taken.has(t)) {
                    rest.push(t);
                }
            }
            const islands = groupTriangles(rest.map(t => ({ pos, t })));
            if (islands.length > 1) {
                let main = 0;
                for (let i = 1; i < islands.length; i++) {
                    if (islands[i].length > islands[main].length) {
                        main = i;
                    }
                }
                for (let i = 0; i < islands.length; i++) {
                    if (i === main) {
                        continue;
                    }
                    const tri = islands[i].map(j => rest[j]);
                    const touchesHole = tri.some(t => [0, 1, 2].some(k => takenKeys.has(weldKey(pos, t, k))));
                    if (touchesHole && tri.length < COMPONENT_MIN_TRIS * 4) {
                        picked.push(...tri);
                    }
                }
                picked.sort((a, b) => a - b);
            }
            const out: ChunkMesh = { material: cm.material, attrs: new Map() };
            const box = new THREE.Box3();
            const p = new THREE.Vector3();
            for (const [name, a] of cm.attrs) {
                const per = a.itemSize * 3;
                const taken: number[] = [];
                for (const t of picked) {
                    for (let k = 0; k < per; k++) {
                        taken.push(a.data[t * per + k]);
                    }
                }
                for (let i = picked.length - 1; i >= 0; i--) {
                    a.data.splice(picked[i] * per, per);
                }
                out.attrs.set(name, { data: taken, itemSize: a.itemSize });
                if (name === 'position') {
                    for (let i = 0; i < taken.length; i += 3) {
                        box.expandByPoint(p.set(taken[i], taken[i + 1], taken[i + 2]));
                    }
                }
            }
            shards.push({ cell: -1, meshes: [out], box, weakness: 1 });
        }
        return shards;
    }

    /**
     * Throw a shard out to the side of the line of travel, up and a little away
     * from the impact, spinning hard: the burning bits that spray clear of a crash.
     */
    private burstSideways(frag: Fragment, vTangent: THREE.Vector3, impact: THREE.Vector3, severity: number): void {
        const side = new THREE.Vector3(-vTangent.z, 0, vTangent.x);
        if (side.lengthSq() < 1e-4) {
            side.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        }
        side.normalize().multiplyScalar(Math.random() < 0.5 ? -1 : 1);
        const away = frag.centre.clone().sub(impact);
        away.y = 0;
        if (away.lengthSq() > 1e-4) {
            away.normalize();
        }
        const dir = side.multiplyScalar(0.85).addScaledVector(away, 0.3);
        dir.y = 0.55;
        dir.normalize();
        const speed = (10 + Math.random() * 24) * (0.6 + 0.5 * Math.min(severity, 1.2));
        frag.velocity.addScaledVector(dir, speed);
        frag.spin.x += (Math.random() - 0.5) * 20;
        frag.spin.y += (Math.random() - 0.5) * 12;
        frag.spin.z += (Math.random() - 0.5) * 20;
    }

    /** The impression a piece leaves where it finally settles: roughly its footprint. */
    private markRest(f: Fragment): void {
        if (!this.onMark) {
            return;
        }
        const x = f.obj.position.x;
        const z = f.obj.position.z;
        // The piece's long horizontal axis, from its own orientation.
        this._v.set(0, 0, 1).applyQuaternion(f.obj.quaternion);
        const long = Math.max(f.half.x, f.half.z);
        const short = Math.min(f.half.x, f.half.z);
        this.onMark(
            this._v2.set(x, this.groundHeightAt(x, z), z),
            this.groundNormal(x, z, this._n),
            this._v.x, this._v.z,
            THREE.MathUtils.clamp(long * 2, 1.2, 14), THREE.MathUtils.clamp(short * 2, 1, 9), 0.5);
    }

    /** The strongest fire riding on this piece, if any. */
    private burningKind(f: Fragment): 'fuselage' | 'wingRoot' | undefined {
        let kind: 'fuselage' | 'wingRoot' | undefined;
        for (const fire of this.fires) {
            if (fire.fragment === f) {
                if (fire.kind === 'fuselage') {
                    return 'fuselage';
                }
                kind = 'wingRoot';
            }
        }
        return kind;
    }

    private applySplits(): void {
        if (this.pendingSplits.length === 0) {
            return;
        }
        const queue = this.pendingSplits.splice(0);
        for (const { fragment, impact } of queue) {
            fragment.splitQueued = false;
            if (fragment.disposed || this.fragments.length >= MAX_FRAGMENTS) {
                continue;
            }
            this.splitFragment(fragment, impact);
        }
    }

    /**
     * Cut a piece in two along a plane across its longest side. Each half keeps
     * the motion of its part of the parent, plus a kick apart; fires and the
     * cockpit go with whichever half they were in. False if it will not split.
     */
    private splitFragment(parent: Fragment, impact: number): boolean {
        const meshes = parent.obj.children as THREE.Mesh[];
        const box = new THREE.Box3();
        const p = new THREE.Vector3();
        for (const m of meshes) {
            const pos = m.geometry.getAttribute('position');
            for (let i = 0; i < pos.count; i++) {
                box.expandByPoint(p.fromBufferAttribute(pos, i));
            }
        }
        const size = box.getSize(new THREE.Vector3());
        if (Math.max(size.x, size.y, size.z) < SPLIT_MIN_SIZE_M) {
            return false;
        }

        const axes = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
        for (const axis of axes) {
            const extent = size.getComponent(axis);
            if (extent < 1.2) {
                continue;
            }
            const mid = box.min.getComponent(axis) + extent * (0.5 + (Math.random() - 0.5) * 0.4);
            const sides: [SplitSide, SplitSide] = [[], []];
            const tris = [0, 0];
            for (const m of meshes) {
                const geo = m.geometry;
                const pos = geo.getAttribute('position');
                const parts: [SplitPart, SplitPart] = [
                    { attrs: new Map(), material: m.material },
                    { attrs: new Map(), material: m.material },
                ];
                for (let t = 0; t + 2 < pos.count; t += 3) {
                    const c = (pos.getComponent(t, axis) + pos.getComponent(t + 1, axis) + pos.getComponent(t + 2, axis)) / 3;
                    const side = c < mid ? 0 : 1;
                    tris[side]++;
                    for (const name of COPIED_ATTRIBUTES) {
                        const attr = geo.getAttribute(name);
                        if (attr === undefined) {
                            continue;
                        }
                        let dst = parts[side].attrs.get(name);
                        if (dst === undefined) {
                            dst = { data: [], itemSize: attr.itemSize };
                            parts[side].attrs.set(name, dst);
                        }
                        for (let k = 0; k < 3; k++) {
                            for (let j = 0; j < attr.itemSize; j++) {
                                dst.data.push(attr.getComponent(t + k, j));
                            }
                        }
                    }
                }
                for (const s of [0, 1] as const) {
                    if (parts[s].attrs.size > 0) {
                        sides[s].push(parts[s]);
                    }
                }
            }
            if (tris[0] < 2 || tris[1] < 2) {
                continue;
            }
            if (this.makeHalves(parent, sides, axis, impact)) {
                return true;
            }
        }
        return false;
    }

    private makeHalves(parent: Fragment, sides: [SplitSide, SplitSide], axis: number, impact: number): boolean {
        // Each half is cut into its connected pieces, so a cut that leaves a
        // piece in two unjoined parts makes two pieces, never one with a loose bit.
        const pieces: { parts: SplitPart[]; side: number }[] = [];
        for (let s = 0; s < 2; s++) {
            for (const parts of this.connectedParts(sides[s])) {
                pieces.push({ parts, side: s });
            }
        }
        if (pieces.length < 2) {
            return false;
        }
        const q = parent.obj.quaternion;
        const axisDir = new THREE.Vector3().setComponent(axis, 1).applyQuaternion(q);
        const children: Fragment[] = [];
        const centresLocal: THREE.Vector3[] = [];
        const boxes: THREE.Box3[] = [];

        for (const { parts, side } of pieces) {
            const box = new THREE.Box3();
            const p = new THREE.Vector3();
            for (const part of parts) {
                const d = part.attrs.get('position')!.data;
                for (let i = 0; i < d.length; i += 3) {
                    box.expandByPoint(p.set(d[i], d[i + 1], d[i + 2]));
                }
            }
            const centreLocal = box.getCenter(new THREE.Vector3());
            const obj = new THREE.Object3D();
            for (const part of parts) {
                const geo = new THREE.BufferGeometry();
                for (const [name, a] of part.attrs) {
                    const data = new Float32Array(a.data);
                    if (name === 'position') {
                        for (let i = 0; i < data.length; i += 3) {
                            data[i] -= centreLocal.x;
                            data[i + 1] -= centreLocal.y;
                            data[i + 2] -= centreLocal.z;
                        }
                    }
                    geo.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
                }
                geo.computeBoundingSphere();
                const mesh = new THREE.Mesh(geo, part.material);
                mesh.frustumCulled = false;
                mesh.onBeforeRender = updateUniforms;
                obj.add(mesh);
            }
            const rel = centreLocal.clone().applyQuaternion(q);
            obj.quaternion.copy(q);
            obj.position.copy(parent.obj.position).add(rel);
            this.root.add(obj);

            const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
            const corners: THREE.Vector3[] = [];
            for (let i = 0; i < 8; i++) {
                corners.push(new THREE.Vector3(
                    (i & 1 ? 1 : -1) * half.x, (i & 2 ? 1 : -1) * half.y, (i & 4 ? 1 : -1) * half.z));
            }
            // Motion of this piece: the parent at its centre, plus a kick apart.
            const velocity = new THREE.Vector3().crossVectors(parent.spin, rel).add(parent.velocity);
            const apart = (side === 0 ? -1 : 1) * (1.5 + Math.random() * 4) * Math.min(1.5, impact / 20);
            velocity.addScaledVector(axisDir, apart);
            velocity.y += Math.random() * 2.5;
            const spin = parent.spin.clone();
            spin.x += (Math.random() - 0.5) * 6;
            spin.y += (Math.random() - 0.5) * 4;
            spin.z += (Math.random() - 0.5) * 6;

            const child: Fragment = {
                obj, centre: parent.centre.clone(), disposed: false,
                originLocal: parent.originLocal.clone().sub(centreLocal),
                depth: parent.depth + 1, splitQueued: false, tough: parent.tough,
                dustAccum: 0, slideAccum: 0, trailMarks: 0,
                trailWidth: THREE.MathUtils.clamp(Math.min(half.x, half.z), 0.7, 2.5),
                impactCooldown: 0.4, velocity, spin, corners,
                half: half.clone(), markCooldown: 0.4, wasTouching: false, onMover: false, wet: false, wetTime: 0, bobPhase: Math.random() * Math.PI * 2, foamAccum: 0, submerged: false, waterY: 0,
                gyration2: Math.max(0.05, (2 / 9) * half.lengthSq()),
                asleep: false, restTime: 0, serial: parent.serial,
            };
            children.push(child);
            centresLocal.push(centreLocal);
            boxes.push(box);
            this.fragments.push(child);
        }

        // A point of the parent frame goes with the piece whose geometry is nearest it.
        const pick = (local: THREE.Vector3): number => {
            let best = 0;
            let bestD = Infinity;
            for (let i = 0; i < boxes.length; i++) {
                const d = boxes[i].distanceToPoint(local);
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            }
            return best;
        };
        for (const fire of this.fires) {
            if (fire.fragment === parent) {
                const i = pick(fire.local);
                fire.fragment = children[i];
                fire.local = fire.local.clone().sub(centresLocal[i]);
            }
        }
        for (const [, c] of this.cockpits) {
            if (c.fragment === parent) {
                const i = pick(c.local);
                c.fragment = children[i];
                c.local = c.local.clone().sub(centresLocal[i]);
            }
        }

        this.onSplit?.(parent.obj.position.clone(), parent.velocity.clone(), Math.min(1.5, impact / 30));
        const index = this.fragments.indexOf(parent);
        if (index >= 0) {
            this.fragments.splice(index, 1);
        }
        this.disposeFragment(parent);
        return true;
    }

    /** World position of a fire; false once its fragment has been dropped. */
    fireWorld(fire: WreckFire, out: THREE.Vector3): boolean {
        if (fire.fragment.disposed || fire.fragment.submerged) {
            return false;
        }
        out.copy(fire.local).applyQuaternion(fire.fragment.obj.quaternion).add(fire.fragment.obj.position);
        return true;
    }

    /**
     * Triangles of the body sections of a piece that end up joined to nothing
     * (a corner of a section whose neighbour tore away, say): too small to be a
     * piece and not part of one, so they are dropped rather than left floating.
     * Gear, surfaces and shards are separate by design and left alone.
     */
    private dropScraps(chunks: Chunk[]): void {
        const meshes: ChunkMesh[] = [];
        for (const chunk of chunks) {
            if (chunk.cell < 0) {
                continue;
            }
            for (const cm of chunk.meshes) {
                if (cm.attrs.has('position')) {
                    meshes.push(cm);
                }
            }
        }
        const items: { pos: number[]; t: number; mesh: number }[] = [];
        meshes.forEach((cm, mesh) => {
            const pos = cm.attrs.get('position')!.data;
            for (let t = 0; t < pos.length / 9; t++) {
                items.push({ pos, t, mesh });
            }
        });
        if (items.length === 0) {
            return;
        }
        const groups = groupTriangles(items);
        if (groups.length < 2) {
            return;
        }
        let main = 0;
        for (let i = 1; i < groups.length; i++) {
            if (groups[i].length > groups[main].length) {
                main = i;
            }
        }
        const drop = new Map<number, number[]>();
        groups.forEach((g, i) => {
            if (i === main || g.length >= COMPONENT_MIN_TRIS) {
                return;
            }
            for (const j of g) {
                const it = items[j];
                const list = drop.get(it.mesh) ?? [];
                list.push(it.t);
                drop.set(it.mesh, list);
            }
        });
        for (const [mesh, list] of drop) {
            list.sort((a, b) => b - a);
            for (const [, a] of meshes[mesh].attrs) {
                const per = a.itemSize * 3;
                for (const t of list) {
                    a.data.splice(t * per, per);
                }
            }
            this.lastScrapTriangles += list.length;
        }
    }

    private buildFragment(
        chunks: Chunk[], isHull: boolean, origin: THREE.Vector3,
        vNormal: THREE.Vector3, vTangent: THREE.Vector3,
        groundN: THREE.Vector3, impact: THREE.Vector3, severity: number, size: number,
    ): Fragment {
        this.dropScraps(chunks);
        const box = new THREE.Box3();
        for (const c of chunks) {
            box.union(c.box);
        }
        const centre = box.getCenter(new THREE.Vector3());

        const obj = new THREE.Object3D();
        for (const c of chunks) {
            for (const cm of c.meshes) {
                const geo = new THREE.BufferGeometry();
                for (const [name, a] of cm.attrs) {
                    const data = new Float32Array(a.data);
                    if (name === 'position') {
                        for (let i = 0; i < data.length; i += 3) {
                            data[i] -= centre.x;
                            data[i + 1] -= centre.y;
                            data[i + 2] -= centre.z;
                        }
                    }
                    geo.setAttribute(name, new THREE.BufferAttribute(data, a.itemSize));
                }
                geo.computeBoundingSphere();
                const mesh = new THREE.Mesh(geo, cm.material);
                mesh.frustumCulled = false;
                mesh.onBeforeRender = updateUniforms;
                obj.add(mesh);
            }
        }
        obj.position.copy(origin).add(centre);
        this.root.add(obj);

        const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        const corners: THREE.Vector3[] = [];
        for (let i = 0; i < 8; i++) {
            corners.push(new THREE.Vector3(
                (i & 1 ? 1 : -1) * half.x,
                (i & 2 ? 1 : -1) * half.y,
                (i & 4 ? 1 : -1) * half.z));
        }
        const gyration2 = Math.max(0.05, (2 / 9) * half.lengthSq());

        // Velocity at this piece: what the airframe carried, less what the
        // ground took out of it close to the impact, plus a kick away from it.
        const away = this._v.copy(centre).sub(impact);
        const dist = away.length();
        const loss = THREE.MathUtils.clamp(1.15 - dist / size, 0, 1) * Math.min(1, severity);
        const velocity = new THREE.Vector3();
        // Normal component: stop going into the ground, with a little bounce.
        const into = Math.min(0, vNormal.dot(groundN));
        velocity.copy(vTangent).multiplyScalar(1 - (BASE_FRICTION + 0.45 * loss) * Math.min(1, severity));
        velocity.addScaledVector(groundN, -into * (0.04 + 0.08 * Math.random()) * (isHull ? 0.4 : 1));
        if (dist > 1e-3) {
            away.multiplyScalar(1 / dist);
        } else {
            away.set(0, 1, 0);
        }
        away.addScaledVector(groundN, 0.6);
        away.x += (Math.random() - 0.5) * 0.6;
        away.z += (Math.random() - 0.5) * 0.6;
        away.normalize();
        const kick = isHull ? 0 : severity * (3 + 11 * Math.random()) * (0.4 + loss);
        velocity.addScaledVector(away, kick);
        // A piece nearest a hard hit also loses forward speed outright.
        velocity.multiplyScalar(isHull ? 1 : 1 - 0.3 * loss);

        // Spin: lever arm from the impact point, plus tumble that scales with the hit.
        const spin = new THREE.Vector3().crossVectors(this._v.copy(centre).sub(impact), vTangent)
            .multiplyScalar(0.012 / Math.max(1, size * 0.1));
        const tumble = isHull ? 0.12 : 0.6;
        spin.x += (Math.random() - 0.5) * 2 * severity * 9 * tumble;
        spin.y += (Math.random() - 0.5) * 2 * severity * 6 * tumble;
        spin.z += (Math.random() - 0.5) * 2 * severity * 9 * tumble;

        const fragment: Fragment = {
            obj, centre: centre.clone(), disposed: false, dustAccum: 0, impactCooldown: 0,
            originLocal: centre.clone().negate(), depth: 0, splitQueued: false,
            tough: chunks.some(c => c.cell >= 0 && c.cell <= 2),
            slideAccum: 0, trailMarks: 0, trailWidth: THREE.MathUtils.clamp(Math.min(half.x, half.z), 0.7, 2.5),
            half: half.clone(), markCooldown: 0, wasTouching: false, onMover: false, wet: false, wetTime: 0, bobPhase: Math.random() * Math.PI * 2, foamAccum: 0, submerged: false, waterY: 0,
            velocity, spin, corners, gyration2,
            asleep: false, restTime: 0, serial: this.serial,
        };
        this.fragments.push(fragment);
        return fragment;
    }

    private disposeFragment(f: Fragment): void {
        f.disposed = true;
        this.root.remove(f.obj);
        f.obj.traverse(o => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.geometry.dispose(); // materials are shared with the live airframe
            }
        });
    }

    private groundNormal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
        const e = 2;
        const dx = this.groundHeightAt(x + e, z) - this.groundHeightAt(x - e, z);
        const dz = this.groundHeightAt(x, z + e) - this.groundHeightAt(x, z - e);
        return out.set(-dx / (2 * e), 1, -dz / (2 * e)).normalize();
    }

    /**
     * A piece over the sea: it falls until it reaches the surface, splashes, and
     * then sinks slowly, losing its speed to the water.
     */
    /** How big a piece is across, for the foam round it (m, kept to a sensible range). */
    private footprint(f: Fragment): number {
        return THREE.MathUtils.clamp(Math.max(f.half.x, f.half.z), 0.8, 8);
    }

    private stepOverWater(f: Fragment, dt: number): void {
        const obj = f.obj;
        const waterY = this.waterSurfaceAt
            ? this.waterSurfaceAt(obj.position.x, obj.position.z)
            : this.groundHeightAt(obj.position.x, obj.position.z);
        f.waterY = waterY;
        f.wasTouching = false;
        f.restTime = 0;
        if (!f.wet) {
            if (obj.position.y - f.half.y * 0.4 > waterY) {
                return; // still on its way down
            }
            f.wet = true;
            const horizontal = Math.hypot(f.velocity.x, f.velocity.z);
            const strength = THREE.MathUtils.clamp((Math.max(0, -f.velocity.y) + 0.3 * horizontal) / 60, 0.2, 1.6);
            this.onSplash?.(this._v.set(obj.position.x, waterY, obj.position.z), f.velocity, strength);
            f.velocity.multiplyScalar(WATER_ENTRY_KEEP);
            f.spin.multiplyScalar(WATER_SPIN_KEEP);
            this.onFoam?.(this._v.set(obj.position.x, waterY, obj.position.z), this.footprint(f), FOAM_ENTRY_PUFFS);
            return;
        }
        f.wetTime += dt;
        // The water carries the piece's weight: step() has just pulled it down by gravity, so undo that,
        // or the slow sink below would settle at gravity over its relaxation rate (about 4 m/s) instead.
        f.velocity.y += GRAVITY * dt;
        const drag = Math.max(0, 1 - WATER_DRAG_PER_S * dt);
        f.velocity.x *= drag;
        f.velocity.z *= drag;
        if (f.wetTime < WATER_FLOAT_S) {
            // Buoyant: held with its lower part under, bobbing a little; whatever fall it
            // arrived with is turned into a settling at that level.
            const bob = Math.sin(f.wetTime * 1.7 + f.bobPhase) * WATER_BOB_M;
            const rideY = waterY - f.half.y * WATER_FLOAT_DEPTH + bob;
            const want = THREE.MathUtils.clamp((rideY - obj.position.y) * 3, -3, 3);
            f.velocity.y += (want - f.velocity.y) * (1 - Math.exp(-6 * dt));
        } else {
            // Then it starts to sink, easing into the slow descent.
            const ease = Math.min(1, (f.wetTime - WATER_FLOAT_S) / WATER_SINK_EASE_S);
            f.velocity.y += (-WATER_SINK_MPS * ease - f.velocity.y) * (1 - Math.exp(-WATER_SINK_RELAX_PER_S * dt));
        }
        f.spin.multiplyScalar(Math.max(0, 1 - WATER_SPIN_DRAG_PER_S * dt));
        const depth = waterY - obj.position.y;
        f.submerged = depth > WATER_SUBMERGED_M;
        if (this.onFoam) {
            const churn = f.wetTime < FOAM_ENTRY_S ? 1
                : f.wetTime < WATER_FLOAT_S ? FOAM_FLOATING_STRENGTH
                    : THREE.MathUtils.clamp(1 - Math.max(0, depth) / FOAM_NONE_DEPTH_M, 0, 1);
            const size = this.footprint(f);
            f.foamAccum += (FOAM_RATE_BASE + FOAM_RATE_PER_M * size) * churn * dt;
            const puffs = Math.floor(f.foamAccum);
            if (puffs > 0) {
                f.foamAccum -= puffs;
                // On the surface, over the piece\'s own spot (which is where it is, whatever its depth).
                this.onFoam(this._v.set(obj.position.x, waterY, obj.position.z), size, puffs);
            }
        }
        if (depth > WATER_HIDE_DEPTH_M) {
            f.asleep = true;
            obj.visible = false;
            f.velocity.set(0, 0, 0);
            f.spin.set(0, 0, 0);
        }
    }

    private step(f: Fragment, dt: number): void {
        const obj = f.obj;
        // The ground may itself be moving (a carrier deck): friction acts on the
        // piece's velocity relative to it, and a piece that comes to rest does so on it.
        const vs = f.onMover && this.movingSurface ? this.movingSurface.velocity : this.noMotion;
        f.velocity.y -= GRAVITY * dt;
        // Light drag so debris does not carry like a bullet.
        const drag = Math.max(0, 1 - 0.04 * dt);
        f.velocity.multiplyScalar(drag);
        obj.position.addScaledVector(f.velocity, dt);

        const angle = f.spin.length() * dt;
        if (angle > 1e-6) {
            this._v.copy(f.spin).normalize();
            this._q.setFromAxisAngle(this._v, angle);
            obj.quaternion.premultiply(this._q).normalize();
        }
        obj.updateMatrix();

        // Over open water there is no ground to land on.
        // Once in, a piece stays in: when the ship steams over where it floats, it is not
        // suddenly on a deck (and lifted up onto it) but under the hull, still in the sea.
        if (this.isWaterAt && (f.wet || this.isWaterAt(obj.position.x, obj.position.z))) {
            this.stepOverWater(f, dt);
            return;
        }

        // Contact: each AABB corner against the ground, resolved with impulses.
        const n = this.groundNormal(obj.position.x, obj.position.z, this._n);
        let touched = false;
        let worst = 0;
        let hardest = 0;
        let hitX = 0;
        let hitZ = 0;
        f.impactCooldown -= dt;
        for (const c of f.corners) {
            this._r.copy(c).applyQuaternion(obj.quaternion);
            const wx = obj.position.x + this._r.x;
            const wz = obj.position.z + this._r.z;
            const pen = this.groundHeightAt(wx, wz) - (obj.position.y + this._r.y);
            if (pen <= 0) {
                continue;
            }
            touched = true;
            worst = Math.max(worst, pen);
            // Velocity of the corner, relative to the ground it is on.
            this._v.crossVectors(f.spin, this._r).add(f.velocity).sub(vs);
            const vn = this._v.dot(n);
            if (vn >= 0) {
                continue;
            }
            if (-vn > hardest) {
                hardest = -vn;
                hitX = wx;
                hitZ = wz;
            }
            const rn = this._v2.crossVectors(this._r, n);
            const e = vn < -6 ? 0.07 : 0;
            const j = -(1 + e) * vn / (1 + rn.lengthSq() / f.gyration2);
            f.velocity.addScaledVector(n, j);
            // angular impulse: r × (j n) / k²
            f.spin.addScaledVector(rn, j / f.gyration2);
            // Coulomb friction along the sliding direction.
            this._v.crossVectors(f.spin, this._r).add(f.velocity).sub(vs);
            const vtan = this._v2.copy(this._v).addScaledVector(n, -this._v.dot(n));
            const vtLen = vtan.length();
            if (vtLen > 1e-4) {
                const jt = Math.min(0.55 * j, vtLen / (1 + 1 / f.gyration2 * 0.5));
                vtan.multiplyScalar(-jt / vtLen);
                f.velocity.add(vtan);
                f.spin.addScaledVector(this._v.crossVectors(this._r, vtan), 1 / f.gyration2);
            }
        }
        if (hardest > 2.5 && f.impactCooldown <= 0 && this.onDust) {
            // A puff where the piece struck: more for a harder blow.
            f.impactCooldown = 0.25;
            this._v.set(hitX, this.groundHeightAt(hitX, hitZ) + 0.3, hitZ);
            this.onDust(this._v, f.velocity, Math.min(30, Math.round(5 + hardest * 0.7)), Math.min(1.2, hardest / 40));
        }
        // (A piece holding fuselage is never split: the fuselage stays whole.)
        if (!f.tough && hardest > SPLIT_MIN_IMPACT_MPS && !f.splitQueued && f.depth < SPLIT_MAX_DEPTH
            && Math.random() < (hardest - SPLIT_MIN_IMPACT_MPS) / (SPLIT_SURE_IMPACT_MPS - SPLIT_MIN_IMPACT_MPS)) {
            f.splitQueued = true;
            this.pendingSplits.push({ fragment: f, impact: hardest });
        }
        f.markCooldown -= dt;
        if (this.onMark && f.markCooldown <= 0 && (hardest > 0.6 || (touched && !f.wasTouching))) {
            // A dent wherever a piece touches down, sized by how hard it struck.
            f.markCooldown = 0.12;
            const x = hardest > 0 ? hitX : obj.position.x;
            const z = hardest > 0 ? hitZ : obj.position.z;
            const size = Math.min(5, 0.8 + Math.max(hardest, 1) * 0.12);
            this.onMark(
                this._v2.set(x, this.groundHeightAt(x, z), z),
                this.groundNormal(x, z, this._n),
                f.velocity.x - vs.x, f.velocity.z - vs.z, size * 1.3, size, Math.min(0.8, 0.4 + hardest * 0.04));
        }
        f.wasTouching = touched;
        if (touched) {
            obj.position.y += Math.min(worst, 3) * 0.8;
            const relX = f.velocity.x - vs.x;
            const relZ = f.velocity.z - vs.z;
            const slide = Math.hypot(relX, relZ);
            if (this.onMark && slide > 0.8 && f.trailMarks < TRAIL_MARKS_MAX) {
                f.slideAccum += slide * dt;
                if (f.slideAccum >= TRAIL_STEP_M) {
                    f.slideAccum = 0;
                    f.trailMarks++;
                    const px = obj.position.x;
                    const pz = obj.position.z;
                    this.onMark(
                        this._v2.set(px, this.groundHeightAt(px, pz), pz),
                        this.groundNormal(px, pz, this._n),
                        relX, relZ,
                        TRAIL_STEP_M * 1.25, f.trailWidth, 0.45);
                    // A piece with a fire on it sets its scratch alight: the
                    // fuselage burns longest, a wing root less.
                    if (this.onBurn) {
                        const kind = this.burningKind(f);
                        if (kind !== undefined) {
                            const fuselage = kind === 'fuselage';
                            this.onBurn(
                                this._v2,
                                fuselage ? 40 + Math.random() * 25 : 18 + Math.random() * 14,
                                fuselage ? 1 : 0.6);
                        }
                    }
                }
            }
            if (this.onDust && slide > 5) {
                f.dustAccum += dt * Math.min(14, slide * 0.5);
                if (f.dustAccum >= 1) {
                    const count = Math.floor(f.dustAccum);
                    f.dustAccum -= count;
                    this._v.set(obj.position.x, this.groundHeightAt(obj.position.x, obj.position.z) + 0.3, obj.position.z);
                    this.onDust(this._v, f.velocity, count, Math.min(1, slide / 60));
                }
            }
            // Sliding wreckage scrubs off spin and speed.
            f.spin.multiplyScalar(Math.max(0, 1 - 1.2 * dt));
            // A long piece does not stand on end: once it is slow it topples onto its side.
            let standing = this.standingAmount(f);
            if (standing === 0) {
                // Not on its end, but perched on a wingtip or an edge: settle onto its flat side.
                standing = this.settleTilt(f);
            }
            if (standing > 0) {
                // A piece that cannot settle (a folded wing propped on its tip) gives up after a while
                // and is let to rest as it is.
                f.settleS = (f.settleS ?? 0) + dt;
                if (f.settleS > SETTLE_GIVE_UP_S) {
                    standing = 0;
                } else {
                    this._v.copy(TOPPLE_UP).cross(TOPPLE_AXIS);
                    if (this._v.lengthSq() < 1e-6) {
                        // Exactly upright: no torque at all. A breath of wind tips it.
                        const t = Math.random() * Math.PI * 2;
                        this._v.set(Math.cos(t), 0, Math.sin(t));
                    }
                    f.spin.addScaledVector(this._v, TOPPLE_RADPS2 * standing * dt);
                }
            }
            const scrub = Math.max(0, 1 - 0.35 * dt);
            f.velocity.x = vs.x + (f.velocity.x - vs.x) * scrub;
            f.velocity.z = vs.z + (f.velocity.z - vs.z) * scrub;
            const restX = f.velocity.x - vs.x;
            const restZ = f.velocity.z - vs.z;
            if (standing === 0 && restX * restX + f.velocity.y * f.velocity.y + restZ * restZ < SLEEP_SPEED_MPS ** 2
                && f.spin.lengthSq() < SLEEP_SPIN_RADPS ** 2) {
                f.restTime += dt;
                if (f.restTime > SLEEP_AFTER_S) {
                    f.asleep = true;
                    // At rest relative to the ground: still going with it if that moves.
                    f.velocity.copy(vs);
                    f.spin.set(0, 0, 0);
                    this.markRest(f);
                }
            } else {
                f.restTime = 0;
            }
        } else {
            f.restTime = 0;
        }
    }
}
