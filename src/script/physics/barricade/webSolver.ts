/**
 * Rigid-body barricade webbing: XPBD particles and constraints.
 *
 * Every lesson the five earlier particle solvers paid for is designed in:
 *  - every belt (with its end cables) and every strap is a chain, and a
 *    chain's distance constraints are solved exactly each substep as one
 *    tridiagonal system, not swept link by link: Gauss-Seidel on a
 *    125-link belt left it stretched 1.5 %, bellied 1.7 m and let the slack
 *    straps whip, which is what the earlier solvers fought with tuning;
 *  - belts and straps are solved in alternating order (a one-way sweep crept
 *    the whole net to one side);
 *  - the arresting gear is a tether whose multiplier is capped at its
 *    holding force inside the chain solve, the rest of the chain re-solved
 *    against that force, and the tether lengthened by what it then gave:
 *    the work it does is exactly force × payout, never a payout law driven
 *    by measured tension (both of those diverged);
 *  - contacts are unilateral XPBD constraints against a plane (normal and
 *    offset fixed for the substep, the multiplier only ever pushing) solved
 *    in the same rounds as the chains, so a chain never ends a substep
 *    pulled back into a wing it was pushed out of; friction is a constraint
 *    on the contact's tangential slip, bounded by its normal multiplier.
 *    As projections before the chains they left particles inside wings and
 *    straps stretched 40–50 %;
 *  - a particle pressed on a surface moves in the chain solves with its
 *    inverse mass projected off the contact normal, w(I − nnᵀ), the chain's
 *    push into the surface added to the contact's multiplier and a pull
 *    away releasing it (an active set over the rounds);
 *  - contacts against the airframe are found in its own frame, by swept
 *    tests over the motion to come, for particles against faces and for
 *    links against the edges a strap catches on (a link lies across a thin
 *    wing with both ends clear of it); they are kept in the body frame for
 *    a few substeps and while the webbing rides along;
 *  - every impulse a contact gives the webbing, position or velocity, is
 *    the airframe's too;
 *  - after a contact the normal velocity is set inelastically to the
 *    surface's own, never derived from the push-out (a 0.1 m push-out in a
 *    0.5 ms substep read back as 190 m/s and flung the net off the jet);
 *  - the lower belt is tied down to the deck along its length (breakaway
 *    ties that yield a few centimetres at their rating, then let go), the ties
 *    solved in the rounds with the chains (solved once after them, they
 *    and the belts' tethers made energy: 58 kJ in a 325 kJ catch).
 *
 * Coordinates are carrier-local. The airframe is either kinematic (its pose
 * interpolated across the step) or a rigid body that only translates and is
 * slowed by the sum of the contact impulses alone.
 */
import * as THREE from 'three';
import {
    bvhClosest, bvhClosestPoint, bvhHit, bvhSegmentHit,
} from '../collision/triangleBvh';
import { BARRICADE_DECK_Y } from '../../scene/entities/barricadeSpec';
import { closest, closestOnTriangle, queryEdges, queryTriangles, WebCollider } from './webCollider';
import { WebLayout } from './webLayout';

/** |(x, y, z)|: Math.hypot guards against overflow these lengths never reach, and costs several times as much in V8. */
function len3(x: number, y: number, z: number): number {
    return Math.sqrt(x * x + y * y + z * z);
}

/**
 * The purchase engine's response time (s): its pull follows the cable's
 * payout speed this much behind, as the oil column and the cable's own
 * stretch do. Taken from the last substep's payout, the pull and the payout
 * it allows fed each other substep by substep.
 */
const ENGINE_LAG_S = 0.005;
/**
 * The run-out valve's narrowest opening, as cable still to go (m): its
 * orifice never shuts. At 1 m the pull's gain on payout speed grew so high
 * at the end of the run-out that, with the engine's lag, it chattered
 * between 235 kN and the relief side to side and whipped the lower belt to
 * 140 m/s (F-22, 60 m/s).
 */
const ENGINE_MIN_LEFT_M = 5;
/** A locked engine's hold (N): far past anything the webbing or a jet's thrust can pull. */
/**
 * The share of the way to where its strap pulls it that an eye slides along
 * the upper belt each substep: the loop's friction on the belt, as a drag on
 * its sliding (see solveSlings). 1 is frictionless, 0 sewn on. Free, the
 * eyes bunched where the nose pushed and 1-4 links crossed the drawn skin in
 * 16 of the 30 and 60 m/s catches (none sewn).
 */
const SLING_SLIDE = 0.05;
/** Nylon webbing on nylon: an eye holds its place on the belt against a pull along it up to this share of the pull across it. */
const SLING_MU = 0.5;
/**
 * The most a purchase cable pays out (m): there the engine's ram has run
 * its stroke and the cable stops paying out. From then on it is an end
 * stop that only stretches, END_STOP_COMPLIANCE m/N, with a buffer
 * (END_STOP_BUFFER_S). Measured with the engines set for a third of an
 * F-22 at 60 m/s (it reaches the stop at 26 m/s):
 *  - the bare wire rope in series with the engine's reeving (1-7/16 in
 *    rope, EA about 1.5e8 N, some 400 m of it) would be about 3e-6. At 6e-7
 *    and 2e-6 the load straps went past 28 % strain against the nose and
 *    the solver pumped their end links to 400-480 m/s;
 *  - at 1e-5, 140 m/s; at 2e-5 the fastest particle stayed at 114 m/s
 *    (under twice the jet's speed), the peak 4.8 g, the jet stopped 29 m
 *    further on, on cable stretch.
 * So 2e-5: softer than the wire alone, a compromise for the solver's sake.
 * A normal catch never reaches it (the 65 m cam stops it by about 75 m).
 * Not rigid in any case: a rigid hold met through the sim's one-step-late
 * coupling threw a jet back off the net.
 */
export const PAYOUT_MAX_M = 90;
const END_STOP_COMPLIANCE = 2e-5;
/** The end-of-stroke buffer's time constant (s): see bufferEndStops. */
const END_STOP_BUFFER_S = 0.02;
/** A step's deadline is judged at its substeps' mean pace times this (see step). */
const DEADLINE_PACE_MARGIN = 1.15;
/** Substeps per step (a 60 Hz frame gives 0.52 ms substeps). */
const SUBSTEPS = 32;
/**
 * Contact-then-chain rounds per substep; a last contact pass closes it.
 * With point and edge contacts inside the chain solves, two hold (one made
 * energy: +26 to +73 % in a catch).
 */
const ROUNDS = 2;
const GRAVITY = 9.81;
/** Webbing is kept this far off a surface it lies on (m). */
export const SKIN_M = 0.04;
/**
 * A contact is made this far beyond the skin (m), so that a chain pulling a
 * particle toward the surface during the rounds meets it. It only pushes
 * once the particle is inside the skin.
 */
const SPECULATIVE_M = 0.05;
/**
 * Airframe contacts are found every this many substeps and kept in the body
 * frame in between, with the reach widened by each particle's motion
 * relative to the airframe over the window. Detection was most of the cost.
 */
const DETECT_EVERY = 4;
/** Body contacts query at least this far (m), so the distance found lets the next detections skip the particle. */
const CLEARANCE_QUERY_M = 0.6;
/**
 * Edge contacts kept per link, nearest first. Four let the F-14's 8 cm
 * nose-gear leg through the lower belt at 60 m/s: its faceted strut and
 * the wheel beside it filled the slots, and the edge the link was pushed
 * into was the one left out.
 */
const EDGE_CONTACTS_PER_LINK = 6;
/**
 * A particle whose slide against the airframe since its last query, plus
 * its motion over the coming window, stays under this keeps that query's
 * contact, for at most this many detections: most contacts ride along, and
 * a plane slid along 4 cm of a 0.3 m radius is off by under 3 mm.
 */
const REQUERY_M = 0.01;
/** A link re-finds its edge contacts once either end has slid this far against the airframe (m). */
const EDGE_REQUERY_M = 0.01;
const REQUERY_AGE = 8;
/**
 * Each particle and link keeps a list of the triangles or edges near it,
 * gathered this much wider (m) than the query needs, and reuses it until it
 * has moved that much against the airframe. Most queries then test a few
 * dozen triangles instead of walking the tree.
 */
const LIST_MARGIN_M = 0.1;
const TRI_LIST = 128;
/** A link within this of its rest length (on the squared length) counts as taut for its damping. */
const DAMP_TOL = 1e-3;
/** Widest coupling in the banded chain solve: a link's row reaches its neighbour's edge rows. */
const BAND = 2 * (1 + EDGE_CONTACTS_PER_LINK) - 1;
/** Give in each edge row of the banded solve, as a fraction of its own stiffness. */
const EDGE_ROW_GIVE = 0.05;
/** A contact whose direction to the particle is more than this far off its face's normal (cos 20°) is on the face's rim. */
const RIM_COS = Math.cos((20 * Math.PI) / 180);
const EDGE_LIST = 64;
/** Coulomb friction: nylon on deck, nylon on paint. */
const DECK_FRICTION = 0.6;
const SKIN_FRICTION = 0.4;
/** Damping ratio of the webbing's own axial vibration (nylon hysteresis, loss factor about 0.2). */
const WEBBING_ZETA = 0.1;
/**
 * Air drag across the webbing (see crossflowDrag): a long flat strip
 * broadside to the flow has Cd about 2.0 (Hoerner, Fluid-Dynamic Drag); the
 * widths are those the linear densities give in nylon (1,140 kg/m^3) a few
 * millimetres thick: 0.5 kg/m engaging straps 0.15 m wide, 1.5 kg/m load
 * straps 0.25 m.
 */
const CROSSFLOW_DRAG = true;
const AIR_DENSITY = 1.225;
const STRIP_CD = 2.0;
const STRAP_WIDTH_M = 0.15;
const BELT_WIDTH_M = 0.25;
/** Air drag on the webbing (1/s). */
const DAMPING = 1.0;

/** The airframe as the webbing meets it: kinematic across one step. */
export interface WebBody {
    readonly collider: WebCollider;
    /** Pose at the start and end of the step (carrier-local). */
    readonly prevPosition: THREE.Vector3;
    readonly prevQuaternion: THREE.Quaternion;
    readonly position: THREE.Vector3;
    readonly quaternion: THREE.Quaternion;
}

/**
 * The airframe as a body of finite mass that only translates (its attitude
 * is held): the net's contact impulses are all that slow it. The solver
 * advances `position` and `velocity` in place.
 */
export interface WebRigidBody {
    readonly collider: WebCollider;
    readonly position: THREE.Vector3;
    readonly quaternion: THREE.Quaternion;
    readonly velocity: THREE.Vector3;
    readonly mass: number;
    /** On its gear: the deck takes the vertical part of the net's pull. */
    readonly onDeck?: boolean;
}

/**
 * The airframe as a free rigid body: it translates and turns under the net's
 * impulses, with its own mass and principal moments of inertia (body
 * frame). `forces` is the rest of the world (deck, gear, tyres, brakes),
 * called each substep after the net's impulses to change the velocities.
 * The solver advances position, quaternion, velocity and angularVelocity in
 * place.
 */
export interface WebDynamicBody {
    readonly collider: WebCollider;
    readonly position: THREE.Vector3;
    readonly quaternion: THREE.Quaternion;
    readonly velocity: THREE.Vector3;
    /** World frame (rad/s). */
    readonly angularVelocity: THREE.Vector3;
    readonly mass: number;
    /** Principal moments about the body axes x, y, z through the centre of mass (kg m^2). */
    readonly inertia: THREE.Vector3;
    /**
     * Centre of mass in the body frame (default the origin). `position` stays
     * the body frame's origin; `velocity` is the centre of mass's, and the
     * body turns about it.
     */
    readonly centerOfMass?: THREE.Vector3;
    readonly forces?: (h: number) => void;
}

/** What one step did, for tests and tuning. */
export interface WebStats {
    maxSpeed: number;
    maxBeltStrain: number;
    maxStrapStrain: number;
    /** Airframe contacts that pushed in the last substep. */
    contacts: number;
    tieDownsBroken: number;
    /** The lowest any particle has been (m, carrier-local y), over the solver's life. */
    lowestY: number;
    /** Payout of each tether so far (m). */
    payout: number[];
    /** Each tether's holding force in the last substep (N). */
    tetherForce: number[];
    /** Work done by the tethers so far (J): holding force × payout. */
    tetherWork: number;
    /** Work done by the tie-downs yielding (J). */
    tieWork: number;
    /**
     * Work the airframe did on the net so far (J): each contact's impulse on
     * the webbing times the airframe surface's velocity there. What a
     * kinematic body puts in; a rigid one loses the same as kinetic energy.
     */
    bodyWork: number;
    /** Energy taken by friction (deck and skin), air drag and the webbing's hysteresis so far (J). */
    frictionWork: number;
    dragWork: number;
    materialWork: number;
    /** Energy the inelastic contact velocity resets took, each in its surface's frame (J). */
    contactResetLoss: number;
    /** Impulse the webbing put on the airframe this step (N·s, carrier-local). */
    reaction: [number, number, number];
    /** Moment of those impulses about the body's position (N m s), summed over the last step. */
    reactionMoment: [number, number, number];
    /** Airframe queries so far: particles against the triangles, links against the edges. */
    pointQueries: number;
    /** Neighbour lists that would have overflowed, so the tree was queried instead. */
    listOverflows: number;
    edgeQueries: number;
    /** Link edge queries that filled the hit buffer, so edges may have been missed (should stay 0). */
    edgeQueryOverflows: number;
}

/** What {@link WebSolver.saveState} keeps. */
export interface WebSolverState {
    readonly x: Float64Array;
    readonly prev: Float64Array;
    readonly v: Float64Array;
    readonly tieSlack: Float64Array;
    readonly tieBroken: Uint8Array;
    readonly tetherRate: Float64Array;
    readonly payout: number[];
    readonly slingAt: Float64Array;
}

/** A chain: node particle ids (−1 − t for tether t's anchor), and where its links sit in the chain arrays. */
interface SolverChain {
    readonly nodes: Int32Array;
    readonly offset: number;
    readonly links: number;
    /** Per node: the anchor's xyz where the node is fixed (unused elsewhere). */
    readonly fixed: Float64Array;
    /** Tether at the first and last link, or −1. */
    readonly tetherFirst: number;
    readonly tetherLast: number;
}

/** Row-major 3×3 rotation of a unit quaternion. */
function rotation(q: THREE.Quaternion, m: Float64Array): void {
    const { x, y, z, w } = q;
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w);
    m[3] = 2 * (x * y + z * w); m[4] = 1 - 2 * (x * x + z * z); m[5] = 2 * (y * z - x * w);
    m[6] = 2 * (x * z - y * w); m[7] = 2 * (y * z + x * w); m[8] = 1 - 2 * (x * x + y * y);
}

export class WebSolver {
    readonly count: number;
    readonly x: Float64Array;
    readonly v: Float64Array;
    private readonly prev: Float64Array;
    private readonly w: Float64Array;
    private readonly mass: Float64Array;
    private readonly linkI: Int32Array;
    private readonly linkJ: Int32Array;
    private readonly linkRest: Float64Array;
    private readonly linkIsStrap: Uint8Array;
    /** Each link's webbing width (m), for its air drag. */
    private readonly linkWidth: Float64Array;
    private readonly linkDampFactor: Float64Array;
    /** Chains (belts with their end cables, straps), their links' rest lengths, compliances and multipliers. */
    private chains: SolverChain[] = [];
    private chainRest = new Float64Array(0);
    private chainCompliance = new Float64Array(0);
    private chainLambda = new Float64Array(0);
    /** Per tether: its link index in the chain arrays, its cap, and whether it held at the cap this substep. */
    private tetherLinks: number[] = [];
    private readonly tetherCapped: Uint8Array;
    /** Each tether's holding force this substep (N), and a purchase engine's payout speed (m/s). */
    private readonly tetherHold: Float64Array;
    private readonly tetherRate: Float64Array;
    /**
     * Paying out at the end of the last substep: its row starts this one
     * fixed at the cap, which saves solving each belt twice per call while
     * the gear runs out (freed again once it stops paying out).
     */
    private readonly tetherHeld: Uint8Array;
    private dir = new Float64Array(0);
    private cC = new Float64Array(0);
    private cA = new Float64Array(0);
    private cB = new Float64Array(0);
    private cR = new Float64Array(0);
    private cCp = new Float64Array(0);
    private cD = new Float64Array(0);
    private cActive = new Uint8Array(0);
    private cW = new Float64Array(0);

    /** Where each strap's eye is on the upper belt, link plus fraction (see solveSlings). */
    private readonly slingAt: Float64Array;
    /** The eyes' particles, and the upper belt's, as typed arrays for the substep loops. */
    private readonly slingEyes: Int32Array;
    private readonly upperBeltIds: Int32Array;

    /** 1 for each tie-down that has let go. */
    readonly tieBroken: Uint8Array;
    private readonly tieLambda: Float64Array;
    /** How far each tie has yielded (m). */
    private readonly tieSlack: Float64Array;

    /**
     * Point contacts made this substep: particle, plane (n·x ≥ off), the
     * surface's velocity, friction, and the accumulated normal and friction
     * corrections (displacements: the particle's mass times them is the
     * multiplier). Body contacts react on the airframe.
     */
    private ctCount = 0;
    private readonly ctI: Int32Array;
    private readonly ctN: Float64Array;
    private readonly ctOff: Float64Array;
    private readonly ctVel: Float64Array;
    private readonly ctMu: Float64Array;
    private readonly ctLn: Float64Array;
    private readonly ctFt: Float64Array;
    private readonly ctBody: Uint8Array;
    /**
     * At the last detection: each particle in the body frame, how far it
     * moves relative to the airframe over the window, and whether it is near
     * the airframe's box.
     */
    private readonly bp0: Float64Array;
    private readonly bMotion: Float64Array;
    /** A lower bound on each particle's distance from the airframe (m), kept across detections. */
    private readonly clearance: Float64Array;
    private detectedFor: WebCollider | undefined;
    /** Airframe contacts in the body frame, kept from one detection to the next: particle, surface point, normal. */
    private bcCount = 0;
    private readonly bcI: Int32Array;
    private readonly bcS: Float64Array;
    private readonly bcN: Float64Array;
    /**
     * Per particle: the triangle its contact was found on when the nearest
     * point is on that triangle's rim (an edge or a corner), else -1. Such a
     * contact is re-aimed every substep (see {@link placeBody}).
     */
    private readonly bcRim: Int32Array;
    /** Edge contacts in the body frame, likewise: the link's particles, where along it, the edge point, normal. */
    private ebCount = 0;
    private readonly ebA: Int32Array;
    private readonly ebB: Int32Array;
    private readonly ebS: Float64Array;
    private readonly ebQ: Float64Array;
    /** Each edge contact slot's feature edge. */
    private readonly ebE: Int32Array;
    private readonly ebN: Float64Array;
    private readonly ebD: Float64Array;
    /** Per link: edge contacts in its slots, whether they are current, and the slots in use this window. */
    private readonly elCount: Uint8Array;
    private readonly elValid: Uint8Array;
    private readonly elPos: Float64Array;
    private readonly elAge: Int32Array;
    private readonly ebList: Int32Array;
    /** Per particle: queried this detection; body-frame position, age and validity of its last query; whether it found a contact. */
    private readonly requeried: Uint8Array;
    private readonly bq: Float64Array;
    private readonly bqAge: Int32Array;
    private readonly bqValid: Uint8Array;
    private readonly bcHas: Uint8Array;
    /**
     * Link-against-edge contacts this substep: the link's particles, where
     * along it, the plane (n·P(s) ≥ off) and the surface velocity, and the
     * accumulated multiplier (kg·m).
     */
    private ecCount = 0;
    private readonly ecA: Int32Array;
    private readonly ecB: Int32Array;
    private readonly ecS: Float64Array;
    private readonly ecN: Float64Array;
    private readonly ecOff: Float64Array;
    private readonly ecVel: Float64Array;
    private readonly ecL: Float64Array;
    /** Each edge contact's accumulated friction multiplier (kg m, a vector along the surface). */
    private readonly ecFt: Float64Array;
    private readonly edgeHits = new Int32Array(1024);
    /** Per particle: nearby triangles (body frame), where and how wide the list was built; count -1 when stale. */
    private readonly triList: Int32Array;
    private readonly triListCount: Int32Array;
    private readonly triListPos: Float64Array;
    private readonly triListR: Float64Array;
    private readonly triScratch = new Int32Array(TRI_LIST);
    /** Per link: nearby edges, the ends where the list was built, and how wide. */
    private readonly edgeList: Int32Array;
    private readonly edgeListCount: Int32Array;
    private readonly edgeListPos: Float64Array;
    private readonly edgeListR: Float64Array;
    private readonly edgeScratch = new Int32Array(EDGE_LIST);
    private substepCount = 0;
    readonly stats: WebStats;

    /**
     * Substeps per step: SUBSTEPS unless a quality step asks for fewer (a
     * web far from the camera, or holding an aircraft nobody watches).
     */
    get substeps(): number {
        return this.substepsN;
    }
    private substepsN: number;

    /** Change the substep count (a quality step), with the webbing's damping per substep to match. */
    setSubsteps(n: number): void {
        if (n === this.substepsN) return;
        this.substepsN = n;
        this.setSubstepDamping(1 / 60 / n);
    }

    /** The webbing's damping for substeps of h (s). */
    private setSubstepDamping(h: number): void {
        this.dampH = h;
        const links = this.layout.links;
        for (let k = 0; k < links.length; k++) {
            const l = links[k];
            if (l.compliance > 0) {
                const omega = Math.sqrt((this.w[l.i] + this.w[l.j]) / l.compliance);
                this.linkDampFactor[k] = Math.exp(-2 * WEBBING_ZETA * omega * h);
            }
        }
    }

    /**
     * The webbing's state between steps (particles, tie-downs, engines), to
     * start another solver of the same layout from (restoreState): a rigged
     * net hung under its own weight is the same every time it is laced.
     */
    saveState(): WebSolverState {
        return {
            x: this.x.slice(), prev: this.prev.slice(), v: this.v.slice(),
            tieSlack: this.tieSlack.slice(), tieBroken: this.tieBroken.slice(),
            tetherRate: this.tetherRate.slice(), payout: this.stats.payout.slice(), slingAt: this.slingAt.slice(),
        };
    }

    restoreState(s: WebSolverState): void {
        this.x.set(s.x);
        this.prev.set(s.prev);
        this.v.set(s.v);
        this.tieSlack.set(s.tieSlack);
        this.tieBroken.set(s.tieBroken);
        this.tetherRate.set(s.tetherRate);
        this.slingAt.set(s.slingAt);
        for (let t = 0; t < s.payout.length; t++) this.stats.payout[t] = s.payout[t];
    }

    /** The substep length the damping table is for (s). */
    private dampH = 0;

    /** Substeps the last step took (fewer than {@link substeps} when its deadline cut it short). */
    lastSubsteps = 0;

    constructor(readonly layout: WebLayout, options: { substeps?: number } = {}) {
        this.substepsN = options.substeps ?? SUBSTEPS;
        const n = layout.count;
        this.count = n;
        this.x = Float64Array.from(layout.x);
        this.prev = Float64Array.from(layout.x);
        this.v = new Float64Array(3 * n);
        this.w = new Float64Array(n);
        this.mass = Float64Array.from(layout.mass);
        for (let i = 0; i < n; i++) this.w[i] = layout.mass[i] > 0 ? 1 / layout.mass[i] : 0;
        const L = layout.links.length;
        this.linkI = new Int32Array(L);
        this.linkJ = new Int32Array(L);
        this.linkRest = new Float64Array(L);
        this.linkIsStrap = new Uint8Array(L);
        this.linkWidth = new Float64Array(L);
        this.linkDampFactor = new Float64Array(L).fill(1);
        this.dampDv = new Float64Array(3 * n);
        this.dampTouched = new Int32Array(n);
        this.dampMark = new Uint8Array(n);
        layout.links.forEach((l, k) => {
            this.linkI[k] = l.i;
            this.linkJ[k] = l.j;
            this.linkRest[k] = l.rest;
            this.linkIsStrap[k] = layout.part[l.i] === 2 || layout.part[l.j] === 2 ? 1 : 0;
            this.linkWidth[k] = this.linkIsStrap[k] ? STRAP_WIDTH_M : BELT_WIDTH_M;
            // Damping per substep: exp(-2 zeta omega h), omega = sqrt(k (1/m_i + 1/m_j)), k = EA / L.
            if (l.compliance > 0) {
                const ws = this.w[l.i] + this.w[l.j];
                const omega = Math.sqrt(ws / l.compliance);
                this.linkDampFactor[k] = Math.exp(-2 * WEBBING_ZETA * omega * (1 / 60 / this.substeps));
            }
        });
        this.dampH = 1 / 60 / this.substeps;
        this.tetherCapped = new Uint8Array(layout.tethers.length);
        this.tetherHold = Float64Array.from(layout.tethers, t => t.holdN);
        this.slingAt = Float64Array.from(layout.slings, s => s.link);
        this.slingEyes = Int32Array.from(layout.slings, s => s.eye);
        this.upperBeltIds = Int32Array.from(layout.upperBelt);
        this.tetherRate = new Float64Array(layout.tethers.length);
        this.tetherHeld = new Uint8Array(layout.tethers.length);
        this.buildChains(layout);
        this.tieBroken = new Uint8Array(layout.tieDowns.length);
        this.tieLambda = new Float64Array(layout.tieDowns.length);
        this.tieSlack = new Float64Array(layout.tieDowns.length);
        const cap = 3 * n;
        this.ctI = new Int32Array(cap);
        this.ctN = new Float64Array(3 * cap);
        this.ctOff = new Float64Array(cap);
        this.ctVel = new Float64Array(3 * cap);
        this.ctMu = new Float64Array(cap);
        this.ctLn = new Float64Array(cap);
        this.ctFt = new Float64Array(3 * cap);
        this.ctBody = new Uint8Array(cap);
        this.bp0 = new Float64Array(3 * n);
        this.triList = new Int32Array(TRI_LIST * n);
        this.triListCount = new Int32Array(n).fill(-1);
        this.triListPos = new Float64Array(3 * n);
        this.triListR = new Float64Array(n);
        this.edgeList = new Int32Array(EDGE_LIST * L);
        this.edgeListCount = new Int32Array(L).fill(-1);
        this.edgeListPos = new Float64Array(6 * L);
        this.edgeListR = new Float64Array(L);
        this.bMotion = new Float64Array(n);
        this.clearance = new Float64Array(n);
        this.bcI = new Int32Array(n);
        this.bcS = new Float64Array(3 * n);
        this.bcN = new Float64Array(3 * n);
        this.bcRim = new Int32Array(n).fill(-1);
        const ecap = EDGE_CONTACTS_PER_LINK * L;
        this.elCount = new Uint8Array(L);
        this.elValid = new Uint8Array(L);
        this.elPos = new Float64Array(6 * L);
        this.elAge = new Int32Array(L);
        this.ebList = new Int32Array(ecap);
        this.requeried = new Uint8Array(n);
        this.bq = new Float64Array(3 * n);
        this.bqAge = new Int32Array(n);
        this.bqValid = new Uint8Array(n);
        this.bcHas = new Uint8Array(n);
        this.touched = new Uint8Array(n);
        this.bodyPressed = new Uint8Array(n);
        this.projCount = new Uint8Array(n);
        this.projE = new Float64Array(6 * n);
        this.projCt = new Int32Array(2 * n);
        this.projF = new Float64Array(3 * n);
        this.chainBusy = new Uint8Array(this.chains.length);
        this.ebA = new Int32Array(ecap);
        this.ebB = new Int32Array(ecap);
        this.ebS = new Float64Array(ecap);
        this.ebQ = new Float64Array(3 * ecap);
        this.ebE = new Int32Array(ecap);
        this.ebN = new Float64Array(3 * ecap);
        this.ebD = new Float64Array(ecap);
        this.ecA = new Int32Array(ecap);
        this.ecB = new Int32Array(ecap);
        this.ecS = new Float64Array(ecap);
        this.ecN = new Float64Array(3 * ecap);
        this.ecOff = new Float64Array(ecap);
        this.ecVel = new Float64Array(3 * ecap);
        this.ecL = new Float64Array(ecap);
        this.ecFt = new Float64Array(3 * ecap);
        this.stats = {
            maxSpeed: 0, maxBeltStrain: 0, maxStrapStrain: 0, contacts: 0, tieDownsBroken: 0, lowestY: Infinity,
            payout: layout.tethers.map(() => 0), tetherForce: layout.tethers.map(t => t.holdN), tetherWork: 0, tieWork: 0, bodyWork: 0, frictionWork: 0, dragWork: 0, materialWork: 0, contactResetLoss: 0, reaction: [0, 0, 0], reactionMoment: [0, 0, 0], pointQueries: 0, listOverflows: 0, edgeQueries: 0, edgeQueryOverflows: 0,
        };
    }

    /**
     * Belts run anchor → belt → anchor (the tethers are their end links, to a
     * massless anchor); each strap runs from its upper station to its lower.
     */
    private buildChains(layout: WebLayout): void {
        const linkOf = new Map<string, number>();
        layout.links.forEach((l, k) => linkOf.set(`${Math.min(l.i, l.j)}:${Math.max(l.i, l.j)}`, k));
        this.linkChain = new Int32Array(layout.links.length).fill(-1);
        this.linkLocal = new Int32Array(layout.links.length);
        this.linkForward = new Uint8Array(layout.links.length);
        const rest: number[] = [];
        const comp: number[] = [];
        const tetherLinks: number[] = layout.tethers.map(() => -1);
        const chain = (nodes: number[]) => {
            const offset = rest.length;
            for (let k = 0; k + 1 < nodes.length; k++) {
                const i = nodes[k];
                const j = nodes[k + 1];
                if (i < 0 || j < 0) {
                    const t = -1 - (i < 0 ? i : j);
                    const p = i < 0 ? j : i;
                    rest.push(dist3(this.x, p, layout.tethers[t].anchor));
                    comp.push(0);
                    tetherLinks[t] = rest.length - 1;
                    continue;
                }
                const lk = linkOf.get(`${Math.min(i, j)}:${Math.max(i, j)}`)!;
                const l = layout.links[lk];
                this.linkChain[lk] = this.chains.length;
                this.linkLocal[lk] = k;
                this.linkForward[lk] = l.i === i ? 1 : 0;
                rest.push(l.rest);
                comp.push(l.compliance);
            }
            // Anchor coordinates where a node is a tether's fixed end.
            const fixedPts = new Float64Array(3 * nodes.length);
            nodes.forEach((id, k) => {
                if (id >= 0) return;
                const an = layout.tethers[-1 - id].anchor;
                fixedPts[3 * k] = an[0];
                fixedPts[3 * k + 1] = an[1];
                fixedPts[3 * k + 2] = an[2];
            });
            this.chains.push({
                nodes: Int32Array.from(nodes), offset, links: nodes.length - 1, fixed: fixedPts,
                tetherFirst: nodes[0] < 0 ? -1 - nodes[0] : -1,
                tetherLast: nodes[nodes.length - 1] < 0 ? -1 - nodes[nodes.length - 1] : -1,
            });
        };
        // A tether ends the first belt that ends on its particle: both belts end on each side's
        // shackle, and its purchase cable is the lower belt's end link (the upper belt meets it there).
        const used = new Set<number>();
        const tetherAt = (i: number) => {
            const t = layout.tethers.findIndex((tt, k) => tt.i === i && !used.has(k));
            if (t >= 0) used.add(t);
            return t;
        };
        for (const belt of [layout.lowerBelt, layout.upperBelt]) {
            const tl = tetherAt(belt[0]);
            const tr = tetherAt(belt[belt.length - 1]);
            chain([...(tl >= 0 ? [-1 - tl] : []), ...belt, ...(tr >= 0 ? [-1 - tr] : [])]);
        }
        for (const strap of layout.straps) chain(strap);
        this.chainRest = Float64Array.from(rest);
        this.chainCompliance = Float64Array.from(comp);
        this.chainLambda = new Float64Array(rest.length);
        this.tetherLinks = tetherLinks;
        const longest = Math.max(...this.chains.map(c => c.links));
        this.dir = new Float64Array(3 * longest);
        this.cC = new Float64Array(longest);
        this.cA = new Float64Array(longest);
        this.cB = new Float64Array(longest);
        this.cR = new Float64Array(longest);
        this.cCp = new Float64Array(longest);
        this.cD = new Float64Array(longest);
        this.cActive = new Uint8Array(longest);
        this.cW = new Float64Array(longest + 1);
    }

    private readonly pa = new THREE.Vector3();
    private readonly pb = new THREE.Vector3();
    private readonly qa = new THREE.Quaternion();
    private readonly qb = new THREE.Quaternion();
    private readonly ra = new Float64Array(9);
    private readonly rb = new Float64Array(9);
    private readonly imp = new Float64Array(3);
    private readonly velImp = new Float64Array(3);
    /** The same impulses' moment about the body's position at the substep's end (N m s). */
    private readonly mom = new Float64Array(3);
    private readonly velMom = new Float64Array(3);

    /**
     * Advance by `dt`, with the airframe (if any) moving kinematically across it.
     * With a deadline (`budgetMs`), a step whose substeps so far, at their pace,
     * would overrun it covers the rest of `dt` in as many substeps as still fit,
     * not fewer than `minSubsteps` in all: a frame's coarser physics rather than
     * a late frame. Without one it always takes {@link substeps}.
     */
    step(dt: number, body?: WebBody, budgetMs = Infinity, minSubsteps = 1): void {
        const n = this.substeps;
        let h = dt / n;
        // Damping to the substep this step takes (a step longer than 1/60 s, or a new count).
        if (Math.abs(h - this.dampH) > 1e-12) this.setSubstepDamping(h);
        this.stats.reaction[0] = this.stats.reaction[1] = this.stats.reaction[2] = 0;
        this.stats.reactionMoment[0] = this.stats.reactionMoment[1] = this.stats.reactionMoment[2] = 0;
        const t0 = budgetMs < Infinity ? performance.now() : 0;
        let done = 0, left = n, taken = 0;
        while (left > 0) {
            const a = done, b = left === 1 ? 1 : done + h / dt;
            if (body) {
                this.pa.lerpVectors(body.prevPosition, body.position, a);
                this.pb.lerpVectors(body.prevPosition, body.position, b);
                this.qa.slerpQuaternions(body.prevQuaternion, body.quaternion, a);
                this.qb.slerpQuaternions(body.prevQuaternion, body.quaternion, b);
            }
            this.substep(h, body?.collider);
            if (body) {
                // The moment of this substep's impulses about where the body's origin was
                // (a kinematic body takes it as a whole, after the step).
                this.stats.reactionMoment[0] += this.mom[0];
                this.stats.reactionMoment[1] += this.mom[1];
                this.stats.reactionMoment[2] += this.mom[2];
            }
            done = b;
            left--;
            taken++;
            if (left > 0 && budgetMs < Infinity) {
                const spent = performance.now() - t0;
                // At the mean pace and a margin: a worker's clock is too coarse (0.1 ms) to time one substep by.
                const pace = DEADLINE_PACE_MARGIN * spent / taken;
                const fit = Math.max(minSubsteps - taken, 1, Math.floor((budgetMs - spent) / pace));
                if (fit < left) {
                    // The rest of the step in fewer, longer substeps (damping to match).
                    left = fit;
                    h = (1 - done) * dt / left;
                    this.setSubstepDamping(h);
                }
            }
        }
        this.lastSubsteps = taken;
        this.crossflowDrag(dt);
        this.measure();
    }

    /**
     * Advance by `dt` with a rigid body pushing in: each substep it moves at
     * its velocity, and the impulses its contacts took then slow it.
     */
    stepRigid(dt: number, body: WebRigidBody): void {
        const h = dt / this.substeps;
        this.stats.reaction[0] = this.stats.reaction[1] = this.stats.reaction[2] = 0;
        this.qa.copy(body.quaternion);
        this.qb.copy(body.quaternion);
        for (let s = 0; s < this.substeps; s++) {
            this.pa.copy(body.position);
            this.pb.copy(body.position).addScaledVector(body.velocity, h);
            this.substep(h, body.collider);
            body.position.copy(this.pb);
            const k = 1 / body.mass;
            body.velocity.x -= this.imp[0] * k;
            if (!body.onDeck) body.velocity.y -= this.imp[1] * k;
            body.velocity.z -= this.imp[2] * k;
        }
        this.crossflowDrag(dt);
        this.measure();
    }

    /**
     * Advance by `dt` with a free rigid body: each substep it moves and turns
     * at its velocities, the impulses and moments its contacts took then
     * change them (through its inertia, turned to the world), and then its
     * other forces act.
     */
    stepDynamic(dt: number, body: WebDynamicBody): void {
        const h = dt / this.substeps;
        this.stats.reaction[0] = this.stats.reaction[1] = this.stats.reaction[2] = 0;
        this.stats.reactionMoment[0] = this.stats.reactionMoment[1] = this.stats.reactionMoment[2] = 0;
        const w = body.angularVelocity, I = body.inertia, q = body.quaternion;
        const L = this.tmpL, Iw = this.tmpIw, R = this.tmpR;
        const com = body.centerOfMass;
        const cg = this.tmpCg;
        for (let s = 0; s < this.substeps; s++) {
            this.pa.copy(body.position);
            this.qa.copy(q);
            // q' = exp(w h / 2) q.
            const wl = w.length();
            if (wl > 1e-12) {
                this.dq.setFromAxisAngle(this.axis.copy(w).divideScalar(wl), wl * h);
                this.qb.copy(this.dq).multiply(q).normalize();
            } else {
                this.qb.copy(q);
            }
            // The centre of mass moves on; the origin turns about it.
            if (com) {
                cg.copy(com).applyQuaternion(q).add(body.position).addScaledVector(body.velocity, h);
                this.pb.copy(com).applyQuaternion(this.qb).negate().add(cg);
            } else {
                this.pb.copy(body.position).addScaledVector(body.velocity, h);
            }
            this.substep(h, body.collider);
            body.position.copy(this.pb);
            q.copy(this.qb);
            body.velocity.x -= this.imp[0] / body.mass;
            body.velocity.y -= this.imp[1] / body.mass;
            body.velocity.z -= this.imp[2] / body.mass;
            // The moment about the centre of mass, from the one about the origin.
            if (com) {
                const rx = cg.x - this.pb.x, ry = cg.y - this.pb.y, rz = cg.z - this.pb.z;
                const ix = this.imp[0], iy = this.imp[1], iz = this.imp[2];
                this.mom[0] -= ry * iz - rz * iy;
                this.mom[1] -= rz * ix - rx * iz;
                this.mom[2] -= rx * iy - ry * ix;
            }
            this.stats.reactionMoment[0] += this.mom[0];
            this.stats.reactionMoment[1] += this.mom[1];
            this.stats.reactionMoment[2] += this.mom[2];
            // The moment on the body is the opposite of the webbing's, plus the gyroscopic term,
            // through the world inertia R I R^T.
            R.makeRotationFromQuaternion(q);
            L.set(-this.mom[0], -this.mom[1], -this.mom[2]);
            Iw.copy(w).applyMatrix4(this.tmpRt.copy(R).transpose());
            Iw.set(Iw.x * I.x, Iw.y * I.y, Iw.z * I.z).applyMatrix4(R);
            L.addScaledVector(this.tmpC.crossVectors(w, Iw), -h);
            L.applyMatrix4(this.tmpRt);
            L.set(L.x / I.x, L.y / I.y, L.z / I.z).applyMatrix4(R);
            w.add(L);
            body.forces?.(h);
        }
        this.crossflowDrag(dt);
        this.measure();
    }
    private readonly tmpL = new THREE.Vector3();
    private readonly tmpCg = new THREE.Vector3();
    private readonly tmpIw = new THREE.Vector3();
    private readonly tmpC = new THREE.Vector3();
    private readonly tmpR = new THREE.Matrix4();
    private readonly tmpRt = new THREE.Matrix4();
    private readonly dq = new THREE.Quaternion();
    private readonly axis = new THREE.Vector3();

    /** One substep; the body's pose runs from (pa, qa) to (pb, qb). */
    /** Per chain: something touches it this substep (belts always count: their tethers and ties couple them). */
    private chainBusy = new Uint8Array(0);
    /** Per layout link: its chain, its place in the chain, and whether it runs the chain's way. */
    private linkChain = new Int32Array(0);
    private linkLocal = new Int32Array(0);
    private linkForward = new Uint8Array(0);
    /** This substep's edge contacts by chain (a counting sort): chainEc[chainEcStart[q] ..]. */
    private chainEcStart = new Int32Array(0);
    private chainEc = new Int32Array(0);
    /** Scratch for the banded chain solve: per row its two nodes, their gradients, and the band. */
    private bRowG = new Float64Array(0);
    private bRowKind = new Int32Array(0);
    private bRhs = new Float64Array(0);
    private bA = new Float64Array(0);
    private bL = new Float64Array(0);
    private bD = new Float64Array(0);
    private bX = new Float64Array(0);
    private bImp = new Float64Array(0);
    /** Per particle: pressed against the airframe (a point or edge contact) in the last substep. */
    readonly bodyPressed: Uint8Array;
    /** Per particle: pressed contact directions the chains may not move it along, their contacts, and the chain impulse on it. */
    private readonly projCount: Uint8Array;
    private readonly projE: Float64Array;
    private readonly projCt: Int32Array;
    private readonly projF: Float64Array;
    private readonly touched: Uint8Array;

    /** Chains a contact presses on (or, before the first round, any contact may): those get the later rounds. */
    private markBusyChains(pressedOnly: boolean): void {
        const t = this.touched;
        t.fill(0);
        for (let c = 0; c < this.ctCount; c++) if (!pressedOnly || this.ctLn[c] > 0) t[this.ctI[c]] = 1;
        for (let c = 0; c < this.ecCount; c++) if (!pressedOnly || this.ecL[c] > 0) { t[this.ecA[c]] = 1; t[this.ecB[c]] = 1; }
        for (let q = 0; q < this.chains.length; q++) {
            const c = this.chains[q];
            let busy = c.tetherFirst >= 0 || c.tetherLast >= 0 ? 1 : 0;
            for (let k = 0; k <= c.links && !busy; k++) if (c.nodes[k] >= 0 && t[c.nodes[k]]) busy = 1;
            this.chainBusy[q] = busy;
        }
    }

    private substep(h: number, collider: WebCollider | undefined): void {
        if (collider) {
            rotation(this.qa, this.ra);
            rotation(this.qb, this.rb);
            this.justDetected = collider !== this.detectedFor || this.substepCount % DETECT_EVERY === 0;
            if (this.justDetected) {
                this.detectBody(collider, h);
                this.detectEdges(collider);
                this.detectedFor = collider;
            }
        } else {
            this.bcCount = 0;
            this.ebCount = 0;
            this.detectedFor = undefined;
        }
        this.predict(h);
        this.ctCount = 0;
        this.ecCount = 0;
        this.contactDeck();
        if (collider) {
            this.placeBody(h);
            this.placeEdges(h);
        }
        this.sortEdgesByChain();
        this.chainLambda.fill(0);
        this.tieLambda.fill(0);
        this.updateTetherHolds();
        this.tetherCapped.fill(0);
        const reverse = (this.substepCount & 1) === 1;
        const n = this.chains.length;
        for (let r = 0; r < ROUNDS; r++) {
            this.solveContacts(h);
            // After the first round, only chains something actually presses on: a speculative
            // contact that has not pushed does not need the coupling rounds.
            if (r > 0) this.markBusyChains(true);
            this.buildProjections();
            for (let q = 0; q < n; q++) {
                // Belts first, then the straps, in alternating order (a one-way sweep crept the
                // net sideways). With the belts last, their pull re-stretched each strap's end link.
                const idx = q < 2 ? q : reverse ? n + 1 - q : q;
                // A chain nothing touches is solved once: the later rounds are for coupling it to contacts.
                if (r === 0 || this.chainBusy[idx]) {
                    // Edge contacts go into the last round's solve; the first round leaves them to
                    // the contact pass that follows it (the same results, half the banded solves).
                    if (r === ROUNDS - 1 && (this.substepCount & 1) === 0 && this.chainHasPressedEdge(idx)) this.solveChainBanded(idx, h);
                    else this.solveChain(this.chains[idx], h);
                }
            }
            this.solveSlings(0);
            this.solveTieDowns(h);
        }
        // The eyes slide along the belt once a substep (in the rounds they hold their place on it).
        this.solveSlings(SLING_SLIDE);
        this.projCount.fill(0);
        this.solveContacts(h);
        this.keepAboveDeck();
        this.payOut(h);
        this.updateVelocities(h);
        this.dampLinks(h);
        this.bufferEndStops(h);
        this.slingVelocities();
        this.collectReaction(h);
        this.substepCount++;
    }

    private predict(h: number): void {
        const { x, prev, v, w } = this;
        const damp = Math.exp(-DAMPING * h);
        for (let i = 0; i < this.count; i++) {
            const k = 3 * i;
            prev[k] = x[k];
            prev[k + 1] = x[k + 1];
            prev[k + 2] = x[k + 2];
            if (w[i] === 0) continue;
            this.stats.dragWork += 0.5 * this.mass[i] * (v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2]) * (1 - damp * damp);
            v[k] *= damp;
            v[k + 1] = (v[k + 1] - GRAVITY * h) * damp;
            v[k + 2] *= damp;
            x[k] += v[k] * h;
            x[k + 1] += v[k + 1] * h;
            x[k + 2] += v[k + 2] * h;
        }
    }

    private sortEdgesByChain(): void {
        const nc = this.chains.length;
        if (this.chainEcStart.length !== nc + 1) this.chainEcStart = new Int32Array(nc + 1);
        if (this.chainEc.length < this.ecA.length) this.chainEc = new Int32Array(this.ecA.length);
        const start = this.chainEcStart;
        start.fill(0);
        for (let c = 0; c < this.ecCount; c++) {
            const q = this.linkChain[Math.floor(this.ebList[c] / EDGE_CONTACTS_PER_LINK)];
            if (q >= 0) start[q + 1]++;
        }
        for (let q = 0; q < nc; q++) start[q + 1] += start[q];
        const fill = this.bFill.length >= nc ? this.bFill : (this.bFill = new Int32Array(nc));
        for (let q = 0; q < nc; q++) fill[q] = start[q];
        for (let c = 0; c < this.ecCount; c++) {
            const q = this.linkChain[Math.floor(this.ebList[c] / EDGE_CONTACTS_PER_LINK)];
            if (q >= 0) this.chainEc[fill[q]++] = c;
        }
        // Within each chain, by link (insertion sort: a handful each).
        const ec = this.chainEc;
        for (let q = 0; q < nc; q++) {
            for (let a = start[q] + 1; a < start[q + 1]; a++) {
                const v = ec[a];
                const key = this.linkLocal[Math.floor(this.ebList[v] / EDGE_CONTACTS_PER_LINK)];
                let b = a - 1;
                while (b >= start[q] && this.linkLocal[Math.floor(this.ebList[ec[b]] / EDGE_CONTACTS_PER_LINK)] > key) { ec[b + 1] = ec[b]; b--; }
                ec[b + 1] = v;
            }
        }
    }
    private bFill = new Int32Array(0);

    /**
     * Whether a chain has an edge contact pressed on a taut link: only there
     * do the link's length and its place off the edge need solving together.
     * A slack link has no row in the chain's system, so its edge rows couple
     * to nothing and the edge pass solves them as well alone.
     */
    private chainHasPressedEdge(q: number): boolean {
        const { x } = this;
        for (let e = this.chainEcStart[q]; e < this.chainEcStart[q + 1]; e++) {
            const ci = this.chainEc[e];
            if (this.ecL[ci] <= 0) continue;
            const lk = Math.floor(this.ebList[ci] / EDGE_CONTACTS_PER_LINK);
            const a = 3 * this.linkI[lk], b = 3 * this.linkJ[lk];
            const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
            const rest = this.linkRest[lk];
            if (dx * dx + dy * dy + dz * dz > rest * rest) return true;
        }
        return false;
    }

    /**
     * A chain with links pressed on airframe edges: the links' multipliers
     * and those edge contacts' together, one banded system (each edge row
     * sits after its link's row and shares that link's two nodes), solved
     * exactly by LDL^T over its envelope. A strap hooked on an edge then
     * keeps its length and its place off the edge at once, where solving
     * them in turn left the hooked link stretched 8-20 points over its
     * neighbours. A tether past its holding force is held there as in the
     * tridiagonal solve; an edge contact the solve would make pull is
     * dropped and the system solved again.
     */
    private solveChainBanded(q: number, h: number): void {
        const c = this.chains[q];
        const { x, w } = this;
        const m = c.links, nodes = c.nodes, fixed = c.fixed;
        const h2 = h * h;
        const e0 = this.chainEcStart[q], e1 = this.chainEcStart[q + 1];
        const maxRows = m + (e1 - e0);
        if (this.bRowKind.length < maxRows) {
            const n2 = 2 * maxRows;
            this.bRowKind = new Int32Array(n2);
            this.bRowLink = new Int32Array(n2);
            this.bRowG = new Float64Array(6 * n2);
            this.bRowWG = new Float64Array(6 * n2);
            this.bRhs = new Float64Array(n2);
            this.bA = new Float64Array(n2 * (BAND + 1));
            this.bL = new Float64Array(n2 * (BAND + 1));
            this.bD = new Float64Array(n2);
            this.bX = new Float64Array(n2);
            this.bScale = new Float64Array(n2);
            this.bFirst = new Int32Array(n2);
        }
        if (this.bLinkRow.length < m) this.bLinkRow = new Int32Array(m);
        if (this.bBlock.length < m + 1) this.bBlock = new Int32Array(m + 1);
        const kind = this.bRowKind, rowLink = this.bRowLink, G = this.bRowG, WG = this.bRowWG, rhs = this.bRhs;
        const linkRow = this.bLinkRow, blockStart = this.bBlock, first = this.bFirst, scale = this.bScale;
        const pc = this.projCount, pe = this.projE;
        let n = 0;
        let ee = e0;
        for (let k = 0; k < m; k++) {
            blockStart[k] = n;
            const i0 = nodes[k], i1 = nodes[k + 1];
            const ax = i0 >= 0 ? x[3 * i0] : fixed[3 * k], ay = i0 >= 0 ? x[3 * i0 + 1] : fixed[3 * k + 1], az = i0 >= 0 ? x[3 * i0 + 2] : fixed[3 * k + 2];
            const bx = i1 >= 0 ? x[3 * i1] : fixed[3 * k + 3], by = i1 >= 0 ? x[3 * i1 + 1] : fixed[3 * k + 4], bz = i1 >= 0 ? x[3 * i1 + 2] : fixed[3 * k + 5];
            const dx = bx - ax, dy = by - ay, dz = bz - az;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const C = d - this.chainRest[c.offset + k];
            linkRow[k] = -1;
            if (C > 0 && d > 1e-12) {
                const r = n++;
                kind[r] = k; rowLink[r] = k; linkRow[k] = r;
                const g = 6 * r;
                G[g] = -dx / d; G[g + 1] = -dy / d; G[g + 2] = -dz / d;
                G[g + 3] = dx / d; G[g + 4] = dy / d; G[g + 5] = dz / d;
                rhs[r] = -C - (this.chainCompliance[c.offset + k] / h2) * this.chainLambda[c.offset + k];
            }
            // This link's edge contacts (sorted by link within the chain).
            for (; ee < e1; ee++) {
                const ci = this.chainEc[ee];
                const lk = Math.floor(this.ebList[ci] / EDGE_CONTACTS_PER_LINK);
                if (this.linkLocal[lk] > k) break;
                if (this.ecL[ci] <= 0) continue;
                const sp = this.linkForward[lk] ? this.ecS[ci] : 1 - this.ecS[ci];
                const nx = this.ecN[3 * ci], ny = this.ecN[3 * ci + 1], nz = this.ecN[3 * ci + 2];
                // Nearly the same constraint as one already in (neighbouring edges met at one
                // point of the link): one row for both, or the system goes singular.
                let dup = false;
                for (let r2 = blockStart[k]; r2 < n; r2++) {
                    if (kind[r2] >= 0) continue;
                    const g2 = 6 * r2;
                    const s2 = G[g2 + 3] * nx + G[g2 + 4] * ny + G[g2 + 5] * nz;
                    const n2 = (G[g2] + G[g2 + 3]) * nx + (G[g2 + 1] + G[g2 + 4]) * ny + (G[g2 + 2] + G[g2 + 5]) * nz;
                    if (n2 > 0.95 && Math.abs(s2 - sp) < 0.1) { dup = true; break; }
                }
                if (dup) continue;
                const r = n++;
                kind[r] = -1 - ci; rowLink[r] = k;
                const g = 6 * r;
                G[g] = (1 - sp) * nx; G[g + 1] = (1 - sp) * ny; G[g + 2] = (1 - sp) * nz;
                G[g + 3] = sp * nx; G[g + 4] = sp * ny; G[g + 5] = sp * nz;
                rhs[r] = -(nx * (ax + sp * dx) + ny * (ay + sp * dy) + nz * (az + sp * dz) - this.ecOff[ci]);
            }
        }
        blockStart[m] = n;
        // Each row's gradients through its nodes' (projected) inverse masses, and its unprojected stiffness.
        for (let r = 0; r < n; r++) {
            const k = rowLink[r];
            let sc = 0;
            for (let ia = 0; ia < 2; ia++) {
                const p = nodes[k + ia];
                const g = 6 * r + 3 * ia;
                if (p < 0) { WG[g] = WG[g + 1] = WG[g + 2] = 0; continue; }
                const wp = w[p];
                let gx = G[g], gy = G[g + 1], gz = G[g + 2];
                sc += wp * (gx * gx + gy * gy + gz * gz);
                for (let j = 0; j < pc[p]; j++) {
                    const e = 6 * p + 3 * j;
                    const dd = pe[e] * gx + pe[e + 1] * gy + pe[e + 2] * gz;
                    gx -= dd * pe[e]; gy -= dd * pe[e + 1]; gz -= dd * pe[e + 2];
                }
                WG[g] = wp * gx; WG[g + 1] = wp * gy; WG[g + 2] = wp * gz;
            }
            scale[r] = sc;
        }
        // The matrix over its envelope: a row couples to its own link's rows (both nodes)
        // and to the previous link's rows (through the node they share).
        const W1 = BAND + 1;
        const A = this.bA;
        for (let r = 0; r < n; r++) {
            const k = rowLink[r];
            const f = k > 0 && blockStart[k - 1] < blockStart[k] ? blockStart[k - 1] : blockStart[k];
            first[r] = f;
            const gr = 6 * r;
            for (let s2 = f; s2 <= r; s2++) {
                const gs = 6 * s2;
                let v: number;
                if (rowLink[s2] === k) {
                    v = G[gr] * WG[gs] + G[gr + 1] * WG[gs + 1] + G[gr + 2] * WG[gs + 2]
                        + G[gr + 3] * WG[gs + 3] + G[gr + 4] * WG[gs + 4] + G[gr + 5] * WG[gs + 5];
                } else {
                    // Shared node k: this row's first node, that row's second.
                    v = G[gr] * WG[gs + 3] + G[gr + 1] * WG[gs + 4] + G[gr + 2] * WG[gs + 5];
                }
                if (s2 === r) {
                    if (kind[r] >= 0) v += this.chainCompliance[c.offset + k] / h2;
                    // A little give in each edge row, so a node wedged between two edges and a
                    // face (rows its held normal leaves nearly opposed) gets a bounded,
                    // least-squares answer instead of a huge squeeze; the contact pass after
                    // takes up the rest.
                    else v += EDGE_ROW_GIVE * scale[r];
                }
                A[r * W1 + (r - s2)] = v;
            }
        }
        // Rows a node's projection left (nearly) without stiffness: that contact holds it.
        for (let r = 0; r < n; r++) {
            const own = A[r * W1] - (kind[r] < 0 ? EDGE_ROW_GIVE * scale[r] : 0);
            if (own < 1e-3 * scale[r]) this.bFixRow(r, n, 0);
        }
        // A tether still paying out from the last substep starts held at its cap.
        for (let end = 0; end < 2; end++) {
            const t = end === 0 ? c.tetherFirst : c.tetherLast;
            const k = end === 0 ? 0 : m - 1;
            if (t < 0 || linkRow[k] < 0 || !this.tetherHeld[t]) continue;
            this.bFixRow(linkRow[k], n, -this.tetherHold[t] * h2 - this.chainLambda[c.offset + k]);
            this.tetherCapped[t] = 1;
        }
        this.bandSolve(n);
        // Tethers past their holding force.
        let resolve = false;
        for (let end = 0; end < 2; end++) {
            const t = end === 0 ? c.tetherFirst : c.tetherLast;
            const k = end === 0 ? 0 : m - 1;
            if (t < 0 || linkRow[k] < 0 || this.tetherHeld[t]) continue;
            const r = linkRow[k];
            const cap = this.tetherHold[t] * h2;
            const li = c.offset + k;
            if (this.chainLambda[li] + this.bX[r] >= -cap) continue;
            this.bFixRow(r, n, -cap - this.chainLambda[li]);
            this.tetherCapped[t] = 1;
            resolve = true;
        }
        // Edge contacts that would pull.
        for (let r = 0; r < n; r++) {
            if (kind[r] >= 0) continue;
            const ci = -1 - kind[r];
            if (this.ecL[ci] + this.bX[r] < 0) {
                this.bFixRow(r, n, -this.ecL[ci]);
                resolve = true;
            }
        }
        if (resolve) this.bandSolve(n);
        // Apply: each row's multiplier along its gradients, into its nodes.
        if (this.bImp.length < 3 * (m + 1)) this.bImp = new Float64Array(3 * (m + 1));
        const imp = this.bImp;
        imp.fill(0, 0, 3 * (m + 1));
        for (let r = 0; r < n; r++) {
            const dl = this.bX[r];
            if (dl === 0) continue;
            if (kind[r] >= 0) this.chainLambda[c.offset + kind[r]] += dl;
            else this.ecL[-1 - kind[r]] += dl;
            const k3 = 3 * rowLink[r], g = 6 * r;
            imp[k3] += G[g] * dl; imp[k3 + 1] += G[g + 1] * dl; imp[k3 + 2] += G[g + 2] * dl;
            imp[k3 + 3] += G[g + 3] * dl; imp[k3 + 4] += G[g + 4] * dl; imp[k3 + 5] += G[g + 5] * dl;
        }
        for (let k = 0; k <= m; k++) {
            const id = nodes[k];
            if (id < 0) continue;
            if (pc[id] === 0) {
                const wi = w[id];
                x[3 * id] += imp[3 * k] * wi; x[3 * id + 1] += imp[3 * k + 1] * wi; x[3 * id + 2] += imp[3 * k + 2] * wi;
            } else {
                this.moveNode(id, imp[3 * k], imp[3 * k + 1], imp[3 * k + 2]);
                this.settleProjected(id);
            }
        }
    }

    private bRowLink = new Int32Array(0);
    private bRowWG = new Float64Array(0);
    private bBlock = new Int32Array(0);
    private bScale = new Float64Array(0);
    private bFirst = new Int32Array(0);
    private bLinkRow = new Int32Array(0);

    /** Fix row r of the banded system at value v: its column moves to the right-hand side. */
    private bFixRow(r: number, n: number, v: number): void {
        const A = this.bA, rhs = this.bRhs, first = this.bFirst;
        for (let s = first[r]; s < r; s++) {
            rhs[s] -= A[r * (BAND + 1) + (r - s)] * v;
            A[r * (BAND + 1) + (r - s)] = 0;
        }
        for (let s = r + 1; s < Math.min(n, r + BAND + 1); s++) {
            if (first[s] > r) break;
            rhs[s] -= A[s * (BAND + 1) + (s - r)] * v;
            A[s * (BAND + 1) + (s - r)] = 0;
        }
        A[r * (BAND + 1)] = 1;
        rhs[r] = v;
    }

    /** Banded LDL^T of bA (lower band, BAND wide), solved for bRhs into bX. */
    private bandSolve(n: number): void {
        const A = this.bA, L = this.bL, D = this.bD, X = this.bX, rhs = this.bRhs, first = this.bFirst;
        const W = BAND + 1;
        for (let r = 0; r < n; r++) {
            const fr = first[r];
            for (let s = fr; s <= r; s++) {
                let sum = A[r * W + (r - s)];
                for (let t = Math.max(fr, first[s]); t < s; t++) sum -= L[r * W + (r - t)] * L[s * W + (s - t)] * D[t];
                if (s < r) L[r * W + (r - s)] = D[s] > 0 ? sum / D[s] : 0;
                // A pivot lost to round-off: that row takes no part.
                else D[r] = sum > 1e-3 * this.bScale[r] ? sum : 0;
            }
        }
        for (let r = 0; r < n; r++) {
            let v = rhs[r];
            for (let t = first[r]; t < r; t++) v -= L[r * W + (r - t)] * X[t];
            X[r] = v;
        }
        for (let r = 0; r < n; r++) X[r] = D[r] > 0 ? X[r] / D[r] : 0;
        for (let r = n - 1; r >= 0; r--) {
            let v = X[r];
            for (let t = r + 1; t < Math.min(n, r + W); t++) {
                if (first[t] > r) break;
                v -= L[t * W + (t - r)] * X[t];
            }
            X[r] = v;
        }
    }

    /**
     * One chain as a tridiagonal system in its links' multipliers:
     * (J W Jᵀ + α̃) Δλ = −C − α̃λ, with J the link directions. A link that is
     * slack at the linearisation is left out (a rope does not push), and an
     * anchor — a tether's fixed end — has no mass. A tether that would pull
     * harder than its holding force is held at it: its multiplier is fixed
     * at the cap and the rest of the chain solved again against that force.
     */
    private solveChain(c: SolverChain, h: number): void {
        const { x, w } = this;
        const m = c.links;
        const h2 = h * h;
        const dir = this.dir;
        const C = this.cC;
        const a = this.cA;
        const b = this.cB;
        const rhs = this.cR;
        const active = this.cActive;
        const nodes = c.nodes;
        const fixed = c.fixed;
        const nw = this.cW;
        const lambda = this.chainLambda;
        const pc = this.projCount;
        for (let k = 0; k <= m; k++) {
            const id = nodes[k];
            nw[k] = id >= 0 ? w[id] : 0;
        }

        // One pass: each link's direction and error, its row, and the coupling of the link before it.
        const restA = this.chainRest, compA = this.chainCompliance, off = c.offset;
        const anchored = c.tetherFirst >= 0 || c.tetherLast >= 0;
        for (let k = 0; k < m; k++) {
            // Node k of the chain: a particle, or (belts only) a fixed anchor.
            const i0 = nodes[k], i1 = nodes[k + 1];
            let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
            if (!anchored || (i0 >= 0 && i1 >= 0)) {
                ax = x[3 * i0]; ay = x[3 * i0 + 1]; az = x[3 * i0 + 2];
                bx = x[3 * i1]; by = x[3 * i1 + 1]; bz = x[3 * i1 + 2];
            } else {
                ax = i0 >= 0 ? x[3 * i0] : fixed[3 * k]; ay = i0 >= 0 ? x[3 * i0 + 1] : fixed[3 * k + 1]; az = i0 >= 0 ? x[3 * i0 + 2] : fixed[3 * k + 2];
                bx = i1 >= 0 ? x[3 * i1] : fixed[3 * k + 3]; by = i1 >= 0 ? x[3 * i1 + 1] : fixed[3 * k + 4]; bz = i1 >= 0 ? x[3 * i1 + 2] : fixed[3 * k + 5];
            }
            const dx = bx - ax, dy = by - ay, dz = bz - az;
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const ck = d - restA[off + k];
            C[k] = ck;
            const on = ck > 0 && d > 1e-12;
            active[k] = on ? 1 : 0;
            const k3 = 3 * k;
            if (on) {
                const inv = 1 / d;
                dir[k3] = dx * inv; dir[k3 + 1] = dy * inv; dir[k3 + 2] = dz * inv;
                const at = compA[off + k] / h2;
                const plain0 = i0 < 0 || pc[i0] === 0, plain1 = i1 < 0 || pc[i1] === 0;
                a[k] = (plain0 ? nw[k] : this.wq(i0, nw[k], k3, k3)) + (plain1 ? nw[k + 1] : this.wq(i1, nw[k + 1], k3, k3)) + at;
                rhs[k] = -ck - at * lambda[off + k];
                // The link before couples to this one through their shared node k.
                if (k > 0) {
                    b[k - 1] = active[k - 1]
                        ? (i0 < 0 || pc[i0] === 0
                            ? -nw[k] * (dir[k3 - 3] * dir[k3] + dir[k3 - 2] * dir[k3 + 1] + dir[k3 - 1] * dir[k3 + 2])
                            : -this.wq(i0, nw[k], k3 - 3, k3))
                        : 0;
                }
            } else {
                dir[k3] = dir[k3 + 1] = dir[k3 + 2] = 0;
                a[k] = 1; rhs[k] = 0;
                if (k > 0) b[k - 1] = 0;
            }
        }
        b[m - 1] = 0;
        // A tether still paying out from the last substep starts held at its cap.
        for (let end = 0; end < 2; end++) {
            const t = end === 0 ? c.tetherFirst : c.tetherLast;
            const k = end === 0 ? 0 : m - 1;
            if (t < 0 || !active[k] || !this.tetherHeld[t]) continue;
            const fixedDl = -this.tetherHold[t] * h2 - lambda[c.offset + k];
            if (k === 0) {
                if (m > 1) { rhs[1] -= b[0] * fixedDl; b[0] = 0; }
            } else {
                rhs[k - 1] -= b[k - 1] * fixedDl;
                b[k - 1] = 0;
            }
            a[k] = 1;
            rhs[k] = fixedDl;
            this.tetherCapped[t] = 1;
        }
        this.thomas(m);
        // Tension is a negative multiplier; past the cap, hold it there.
        let resolve = false;
        for (let end = 0; end < 2; end++) {
            const t = end === 0 ? c.tetherFirst : c.tetherLast;
            const k = end === 0 ? 0 : m - 1;
            if (t < 0 || !active[k] || this.tetherHeld[t]) continue;
            const cap = this.tetherHold[t] * h2;
            const li = c.offset + k;
            if (lambda[li] + this.cD[k] >= -cap) continue;
            const fixedDl = -cap - lambda[li];
            if (k === 0) {
                if (m > 1) { rhs[1] -= b[0] * fixedDl; b[0] = 0; }
            } else {
                rhs[k - 1] -= b[k - 1] * fixedDl;
                b[k - 1] = 0;
            }
            a[k] = 1;
            rhs[k] = fixedDl;
            this.tetherCapped[t] = 1;
            resolve = true;
        }
        if (resolve) this.thomas(m);
        const dl = this.cD;
        // Apply: link k pulls node k+1 back along its direction, node k forward.
        for (let k = 0; k < m; k++) {
            if (!active[k]) continue;
            lambda[c.offset + k] += dl[k];
            const i0 = nodes[k];
            const i1 = nodes[k + 1];
            const sx = dir[3 * k] * dl[k], sy = dir[3 * k + 1] * dl[k], sz = dir[3 * k + 2] * dl[k];
            if (i0 >= 0) {
                if (pc[i0] === 0) { const q = 3 * i0, w0 = nw[k]; x[q] -= sx * w0; x[q + 1] -= sy * w0; x[q + 2] -= sz * w0; }
                else this.moveNode(i0, -sx, -sy, -sz);
            }
            if (i1 >= 0) {
                if (pc[i1] === 0) { const q = 3 * i1, w1 = nw[k + 1]; x[q] += sx * w1; x[q + 1] += sy * w1; x[q + 2] += sz * w1; }
                else this.moveNode(i1, sx, sy, sz);
            }
        }
        // What the pressed contacts carried for the chain, and any node it lifts off.
        for (let k = 0; k <= m; k++) {
            const id = nodes[k];
            if (id >= 0 && pc[id] > 0) this.settleProjected(id);
        }
    }

    /** d_a W d_b for particle id: w (d_a . d_b - sum (e . d_a)(e . d_b)) over its pressed contact normals. */
    private wq(id: number, w: number, a0: number, b0: number): number {
        const dir = this.dir, pe = this.projE;
        let dot = dir[a0] * dir[b0] + dir[a0 + 1] * dir[b0 + 1] + dir[a0 + 2] * dir[b0 + 2];
        for (let j = 0; j < this.projCount[id]; j++) {
            const e = 6 * id + 3 * j;
            dot -= (pe[e] * dir[a0] + pe[e + 1] * dir[a0 + 1] + pe[e + 2] * dir[a0 + 2])
                * (pe[e] * dir[b0] + pe[e + 1] * dir[b0 + 1] + pe[e + 2] * dir[b0 + 2]);
        }
        return w * dot;
    }

    /**
     * Move a node by impulse (sx, sy, sz) of a chain link: w times it, less
     * the part along the normals of its pressed contacts, which those
     * contacts take (summed in projF until the chain is done).
     */
    private moveNode(id: number, sx: number, sy: number, sz: number): void {
        const q = 3 * id;
        const wi = this.w[id];
        const n = this.projCount[id];
        if (n > 0) {
            this.projF[q] += sx; this.projF[q + 1] += sy; this.projF[q + 2] += sz;
            const pe = this.projE;
            for (let j = 0; j < n; j++) {
                const e = 6 * id + 3 * j;
                const d = pe[e] * sx + pe[e + 1] * sy + pe[e + 2] * sz;
                sx -= d * pe[e]; sy -= d * pe[e + 1]; sz -= d * pe[e + 2];
            }
        }
        this.x[q] += sx * wi; this.x[q + 1] += sy * wi; this.x[q + 2] += sz * wi;
    }

    /**
     * The impulse a chain put on a node held by its contacts goes to them:
     * into a surface it is that contact's load (its multiplier grows, and
     * with it its friction and the airframe's share); away from it, the
     * contact gives back what it held and, past that, lets the node lift,
     * and stops holding it for the rest of the round.
     */
    private settleProjected(id: number): void {
        const q = 3 * id;
        const fx = this.projF[q], fy = this.projF[q + 1], fz = this.projF[q + 2];
        this.projF[q] = this.projF[q + 1] = this.projF[q + 2] = 0;
        const n = this.projCount[id];
        const c1 = this.projCt[2 * id];
        const n1x = this.ctN[3 * c1], n1y = this.ctN[3 * c1 + 1], n1z = this.ctN[3 * c1 + 2];
        const f1 = n1x * fx + n1y * fy + n1z * fz;
        let l1: number, l2 = 0, c2 = -1;
        if (n === 1) {
            l1 = -f1;
        } else {
            // Two normals: the multipliers whose sum along both is the removed impulse.
            c2 = this.projCt[2 * id + 1];
            const n2x = this.ctN[3 * c2], n2y = this.ctN[3 * c2 + 1], n2z = this.ctN[3 * c2 + 2];
            const f2 = n2x * fx + n2y * fy + n2z * fz;
            const g = n1x * n2x + n1y * n2y + n1z * n2z;
            const det = 1 - g * g;
            l1 = -(f1 - g * f2) / det;
            l2 = -(f2 - g * f1) / det;
        }
        const wi = this.w[id];
        let liftX = 0, liftY = 0, liftZ = 0, lifted = false;
        for (let j = 0; j < n; j++) {
            const c = j === 0 ? c1 : c2;
            const next = this.ctLn[c] + wi * (j === 0 ? l1 : l2);
            if (next >= 0) {
                this.ctLn[c] = next;
            } else {
                this.ctLn[c] = 0;
                liftX -= next * this.ctN[3 * c]; liftY -= next * this.ctN[3 * c + 1]; liftZ -= next * this.ctN[3 * c + 2];
                lifted = true;
            }
        }
        if (lifted) {
            this.x[q] += liftX; this.x[q + 1] += liftY; this.x[q + 2] += liftZ;
            this.projCount[id] = 0;
        }
    }

    /** Each particle with pressed point contacts: up to two orthonormal directions the chains may not move it along. */
    private buildProjections(): void {
        const pc = this.projCount, pe = this.projE;
        pc.fill(0);
        for (let c = 0; c < this.ctCount; c++) {
            if (this.ctLn[c] <= 0) continue;
            const id = this.ctI[c];
            const n = pc[id];
            if (n >= 2) continue;
            let ex = this.ctN[3 * c], ey = this.ctN[3 * c + 1], ez = this.ctN[3 * c + 2];
            if (n === 1) {
                const e = 6 * id;
                const d = pe[e] * ex + pe[e + 1] * ey + pe[e + 2] * ez;
                ex -= d * pe[e]; ey -= d * pe[e + 1]; ez -= d * pe[e + 2];
                const l = Math.sqrt(ex * ex + ey * ey + ez * ez);
                // Nearly the same plane: the first already holds it.
                if (l < 0.3) continue;
                ex /= l; ey /= l; ez /= l;
            }
            const e = 6 * id + 3 * n;
            pe[e] = ex; pe[e + 1] = ey; pe[e + 2] = ez;
            this.projCt[2 * id + n] = c;
            pc[id] = n + 1;
        }
    }

    /** Thomas algorithm on the chain scratch (symmetric tridiagonal: sub = super = b), into cD. */
    private thomas(m: number): void {
        const a = this.cA, b = this.cB, rhs = this.cR, cp = this.cCp, dl = this.cD;
        cp[0] = b[0] / a[0];
        dl[0] = rhs[0] / a[0];
        for (let k = 1; k < m; k++) {
            const den = a[k] - b[k - 1] * cp[k - 1];
            cp[k] = b[k] / den;
            dl[k] = (rhs[k] - b[k - 1] * dl[k - 1]) / den;
        }
        for (let k = m - 2; k >= 0; k--) dl[k] -= cp[k] * dl[k + 1];
    }

    /**
     * A tether held at its cap this substep has given: it lengthens to
     * where its end now is, and has done holding force × that much work.
     */
    private payOut(h: number): void {
        const { x } = this;
        this.tetherHeld.fill(0);
        const lag = 1 - Math.exp(-h / ENGINE_LAG_S);
        this.tetherLinks.forEach((li, t) => {
            const tether = this.layout.tethers[t];
            let paid = 0;
            if (this.tetherCapped[t]) {
                const k = 3 * tether.i;
                const an = tether.anchor;
                const d = len3(x[k] - an[0], x[k + 1] - an[1], x[k + 2] - an[2]);
                // Not past the engine's stroke (PAYOUT_MAX_M).
                paid = Math.min(Math.max(0, d - this.chainRest[li]), Math.max(0, PAYOUT_MAX_M - this.stats.payout[t]));
                if (paid > 0) {
                    // Paying out, its row starts the next substep at the cap; at the stop it is not.
                    this.tetherHeld[t] = this.stats.payout[t] + paid < PAYOUT_MAX_M ? 1 : 0;
                    this.chainRest[li] += paid;
                    this.stats.payout[t] += paid;
                    this.stats.tetherWork += paid * this.tetherHold[t];
                }
            }
            this.tetherRate[t] += (paid / h - this.tetherRate[t]) * lag;
        });
    }

    /**
     * Each tether's holding force for this substep. A constant one holds at
     * its rating; a hydraulic engine (see PurchaseEngine) at its preload
     * plus its orifice's pull at the cable's payout speed, the orifice closed
     * further the more cable has gone out, up to the relief valve.
     */
    /**
     * Set the purchase engines for an aircraft of this mass (kg), as the deck
     * crew dials in the arriving type; 0 keeps the rig's own setting.
     */
    setEngineMass(kg: number): void {
        this.engineSetKg = kg;
    }

    /**
     * The engines hold the cable where it is from now on: an arrested
     * aircraft stays in the gear until the crew lets it go. Without it a jet
     * stopped in the net at full throttle pulled the rest of the run-out
     * out at the orifice's low-speed pull.
     *
     * Locked, an engine still has its relief valve: it holds up to its 5 g
     * relief and pays out past it. Locked rigid (1e7 N), the webbing met by
     * a second rollout (a respawn into the spent net) stopped the jet within
     * a step, and through the sim's one-step-late coupling threw it back
     * 13 m, then forward off the deck at 75 m/s.
     */
    lockEngines(locked = true): void {
        this.enginesLocked = locked;
    }
    private engineSetKg = 0;
    private enginesLocked = false;

    private updateTetherHolds(): void {
        const tethers = this.layout.tethers;
        for (let t = 0; t < tethers.length; t++) {
            const tether = tethers[t];
            const e = tether.engine;
            if (!e) {
                this.tetherHold[t] = tether.holdN;
                continue;
            }
            const m = this.engineSetKg > 0 ? this.engineSetKg : e.setMassKg;
            if (this.stats.payout[t] >= PAYOUT_MAX_M) {
                // At the end of its stroke: the cable no longer pays out, it stretches (END_STOP_COMPLIANCE).
                const li = this.tetherLinks[t];
                this.chainCompliance[li] = END_STOP_COMPLIANCE;
                this.tetherHold[t] = 1e12;
                continue;
            }
            if (this.enginesLocked) {
                this.tetherHold[t] = e.maxN * (m / e.setMassKg);
                continue;
            }
            const v = this.tetherRate[t];
            const left = Math.max(e.runOutM - this.stats.payout[t], ENGINE_MIN_LEFT_M);
            this.tetherHold[t] = Math.min(e.maxN * (m / e.setMassKg), tether.holdN + (e.share * m * v * v) / (2 * left));
        }
        for (let t = 0; t < tethers.length; t++) {
            if (this.tetherHold[t] < 1e12) {
                this.stats.tetherForce[t] = this.tetherHold[t];
                continue;
            }
            // At the stop: the cable's pull from its stretch.
            const tether = tethers[t];
            const k = 3 * tether.i, an = tether.anchor, li = this.tetherLinks[t];
            const d = len3(this.x[k] - an[0], this.x[k + 1] - an[1], this.x[k + 2] - an[2]);
            this.stats.tetherForce[t] = Math.max(0, d - this.chainRest[li]) / END_STOP_COMPLIANCE;
        }
    }

    /**
     * Each tie is a short cord to its spot on the deck (slack once it has
     * yielded some). Past its rating it holds at the rating and yields,
     * like the tethers; once it has yielded its stroke it lets go.
     */
    /**
     * Each strap's eye back onto the upper belt, where along it the eye now
     * lies nearest: rigid across the belt, free along it (a frictionless
     * sling). The eye's place is a belt coordinate, link plus fraction
     * (slingAt), followed as it slides. Kept a strap's width from its
     * neighbours' eyes by clamping, the centre strap's eye was forced under
     * an F-14's belly and its top links through the skin. Friction (nylon on nylon, mu 0.5) as
     * a position-level stick toward the substep's start was tried, once per
     * round and once per substep: it pinned the eye against the belt running
     * through it at tens of m/s in the pull, and the webbing blew up
     * (particles at 500-990 m/s); a velocity-level friction would be the
     * way to add it.
     */
    private solveSlings(slide: number): void {
        const { x, w } = this;
        const belt = this.upperBeltIds;
        const last = belt.length - 2;
        const eyes = this.slingEyes;
        for (let s = 0; s < eyes.length; s++) {
            const e = 3 * eyes[s];
            let at = this.slingAt[s];
            let j = Math.min(last, Math.floor(at));
            let t = at - j;
            let a = 3 * belt[j], b = 3 * belt[j + 1];
            let abx = x[b] - x[a], aby = x[b + 1] - x[a + 1], abz = x[b + 2] - x[a + 2];
            if (slide > 0) {
                // Where along the belt the strap pulls the eye: the nearest point, link by link.
                for (let hop = 0; hop <= last; hop++) {
                    a = 3 * belt[j];
                    b = 3 * belt[j + 1];
                    abx = x[b] - x[a]; aby = x[b + 1] - x[a + 1]; abz = x[b + 2] - x[a + 2];
                    const l2 = abx * abx + aby * aby + abz * abz;
                    t = l2 > 0 ? ((x[e] - x[a]) * abx + (x[e + 1] - x[a + 1]) * aby + (x[e + 2] - x[a + 2]) * abz) / l2 : 0;
                    if (t < 0 && j > 0) j--;
                    else if (t > 1 && j < last) j++;
                    else break;
                }
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                // Held by friction up to SLING_MU times what presses it on the belt (the correction
                // across it), past that a part of the way there (see SLING_SLIDE).
                const len = Math.sqrt(abx * abx + aby * aby + abz * abz);
                const px = x[e] - (x[a] + t * abx), py = x[e + 1] - (x[a + 1] + t * aby), pz = x[e + 2] - (x[a + 2] + t * abz);
                const hold = len > 0 ? SLING_MU * Math.sqrt(px * px + py * py + pz * pz) / len : 0;
                const want = j + t - at;
                if (Math.abs(want) > hold) at += (want - Math.sign(want) * hold) * slide;
                this.slingAt[s] = at;
                j = Math.min(last, Math.floor(at));
                t = at - j;
                a = 3 * belt[j];
                b = 3 * belt[j + 1];
                abx = x[b] - x[a]; aby = x[b + 1] - x[a + 1]; abz = x[b + 2] - x[a + 2];
            }
            const cx = x[e] - (x[a] + t * abx), cy = x[e + 1] - (x[a + 1] + t * aby), cz = x[e + 2] - (x[a + 2] + t * abz);
            const we = w[e / 3], wa = w[a / 3] * (1 - t), wb = w[b / 3] * t;
            const den = we + wa * (1 - t) + wb * t;
            if (den <= 0) continue;
            const ke = we / den, ka = wa / den, kb = wb / den;
            x[e] -= ke * cx; x[e + 1] -= ke * cy; x[e + 2] -= ke * cz;
            x[a] += ka * cx; x[a + 1] += ka * cy; x[a + 2] += ka * cz;
            x[b] += kb * cx; x[b + 1] += kb * cy; x[b + 2] += kb * cz;
        }
    }

    /**
     * Each eye moves with the belt at its place on it. Its velocity left as
     * the link damping set it, the eye came off the belt each prediction and
     * was put back by the next solve: the outer eyes rang at 0.16 m/s in a
     * rigged net that had otherwise stopped.
     */
    private slingVelocities(): void {
        const { v } = this;
        const belt = this.upperBeltIds;
        const last = belt.length - 2;
        const eyes = this.slingEyes;
        for (let s = 0; s < eyes.length; s++) {
            const e = 3 * eyes[s];
            const at = this.slingAt[s];
            const j = Math.min(last, Math.floor(at));
            const t = at - j;
            const a = 3 * belt[j], b = 3 * belt[j + 1];
            v[e] = v[a] + t * (v[b] - v[a]);
            v[e + 1] = v[a + 1] + t * (v[b + 1] - v[a + 1]);
            v[e + 2] = v[a + 2] + t * (v[b + 2] - v[a + 2]);
        }
    }

    private solveTieDowns(h: number): void {
        const { x, w } = this;
        const h2 = h * h;
        const ties = this.layout.tieDowns;
        for (let k = 0; k < ties.length; k++) {
            if (this.tieBroken[k]) continue;
            const t = ties[k];
            const i = t.i;
            const a = 3 * i;
            const dx = x[a] - t.at[0];
            const dy = x[a + 1] - t.at[1];
            const dz = x[a + 2] - t.at[2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const C = d - this.tieSlack[k];
            if (C <= 0 || d < 1e-12) continue;
            const at = t.compliance / h2;
            let dl = (-C - at * this.tieLambda[k]) / (w[i] + at);
            const cap = t.breakN * h2;
            let yielded = false;
            if (this.tieLambda[k] + dl < -cap) {
                dl = -cap - this.tieLambda[k];
                yielded = true;
            }
            this.tieLambda[k] += dl;
            const move = dl * w[i];
            x[a] += (dx / d) * move;
            x[a + 1] += (dy / d) * move;
            x[a + 2] += (dz / d) * move;
            if (yielded) {
                // Held at its rating: it gives what the particle still pulls past its elastic stretch.
                const now = d + move;
                const slack = now - t.compliance * t.breakN;
                if (slack > this.tieSlack[k]) {
                    this.stats.tieWork += (slack - this.tieSlack[k]) * t.breakN;
                    this.tieSlack[k] = slack;
                }
                if (this.tieSlack[k] >= t.strokeM) this.tieBroken[k] = 1;
            }
        }
    }

    private addContact(i: number, nx: number, ny: number, nz: number, off: number,
        vx: number, vy: number, vz: number, mu: number, body: boolean): void {
        if (this.ctCount >= this.ctI.length) return;
        const c = this.ctCount++;
        this.ctI[c] = i;
        this.ctN[3 * c] = nx; this.ctN[3 * c + 1] = ny; this.ctN[3 * c + 2] = nz;
        this.ctOff[c] = off;
        this.ctVel[3 * c] = vx; this.ctVel[3 * c + 1] = vy; this.ctVel[3 * c + 2] = vz;
        this.ctMu[c] = mu;
        this.ctLn[c] = 0;
        this.ctFt[3 * c] = this.ctFt[3 * c + 1] = this.ctFt[3 * c + 2] = 0;
        this.ctBody[c] = body ? 1 : 0;
    }

    /**
     * Nothing of the webbing below the deck: a hard floor for every particle
     * after the substep's last contact pass. The deck's contacts are only
     * made for particles near it as the substep starts, so a chain solve
     * that pulled one down from higher up could leave it under the deck.
     */
    /**
     * A cable at its stop (PAYOUT_MAX_M) is buffered: the shackle's speed
     * along the cable decays with END_STOP_BUFFER_S, the engine's end-of-
     * stroke buffer taking it. Undamped, the stiff end and the airframe's nose
     * pinched the lower belt's end links between them and pumped them up
     * past 400 m/s.
     */
    private bufferEndStops(h: number): void {
        const { x, v } = this;
        const tethers = this.layout.tethers;
        const keep = Math.exp(-h / END_STOP_BUFFER_S);
        for (let t = 0; t < tethers.length; t++) {
            if (this.stats.payout[t] < PAYOUT_MAX_M) continue;
            const tether = tethers[t];
            const k = 3 * tether.i, an = tether.anchor;
            const dx = x[k] - an[0], dy = x[k + 1] - an[1], dz = x[k + 2] - an[2];
            const d = len3(dx, dy, dz);
            if (d <= 0) continue;
            const ux = dx / d, uy = dy / d, uz = dz / d;
            const along = v[k] * ux + v[k + 1] * uy + v[k + 2] * uz;
            const cut = along * (1 - keep);
            v[k] -= cut * ux;
            v[k + 1] -= cut * uy;
            v[k + 2] -= cut * uz;
        }
    }

    private keepAboveDeck(): void {
        const floor = BARRICADE_DECK_Y + SKIN_M;
        const x = this.x;
        for (let i = 0; i < this.count; i++) {
            if (this.w[i] !== 0 && x[3 * i + 1] < floor) x[3 * i + 1] = floor;
        }
    }

    private contactDeck(): void {
        const floor = BARRICADE_DECK_Y + SKIN_M;
        for (let i = 0; i < this.count; i++) {
            if (this.w[i] === 0 || this.x[3 * i + 1] > floor + SPECULATIVE_M) continue;
            this.addContact(i, 0, 1, 0, floor, 0, 0, 0, DECK_FRICTION, false);
        }
    }

    private readonly hit = bvhHit();
    private readonly near = bvhClosest();

    /**
     * Contacts against the airframe for the next {@link DETECT_EVERY}
     * substeps, found in its frame at the start of them: a swept test from
     * where the particle is to where its velocity relative to the airframe
     * takes it by the end of the window — a crossing makes a contact on the
     * face, on the side it is on now — else the nearest surface within the
     * skin, the speculative reach and that motion. Each is a plane through
     * the surface point, kept in the body frame, so it moves with the
     * airframe until the next detection.
     */
    private detectBody(collider: WebCollider, h: number): void {
        const bvh = collider.bvh;
        const { x, v, pa, pb, ra, rb } = this;
        const bnd = bvh.bounds;
        const reach = SKIN_M + SPECULATIVE_M;
        const window = DETECT_EVERY * h;
        this.bcCount = 0;
        for (let i = 0; i < this.count; i++) {
            if (this.w[i] === 0) continue;
            const k = 3 * i;
            // Body frame now: Raᵀ (x − pa).
            const ex = x[k] - pa.x, ey = x[k + 1] - pa.y, ez = x[k + 2] - pa.z;
            const p0x = ra[0] * ex + ra[3] * ey + ra[6] * ez;
            const p0y = ra[1] * ex + ra[4] * ey + ra[7] * ez;
            const p0z = ra[2] * ex + ra[5] * ey + ra[8] * ez;
            // The airframe's own velocity at that point, from its motion over this substep.
            const bvx = (rb[0] * p0x + rb[1] * p0y + rb[2] * p0z + pb.x - x[k]) / h;
            const bvy = (rb[3] * p0x + rb[4] * p0y + rb[5] * p0z + pb.y - x[k + 1]) / h;
            const bvz = (rb[6] * p0x + rb[7] * p0y + rb[8] * p0z + pb.z - x[k + 2]) / h;
            const rx = (v[k] - bvx) * window, ry = (v[k + 1] - bvy - GRAVITY * window / 2) * window, rz = (v[k + 2] - bvz) * window;
            const dx = ra[0] * rx + ra[3] * ry + ra[6] * rz;
            const dy = ra[1] * rx + ra[4] * ry + ra[7] * rz;
            const dz = ra[2] * rx + ra[5] * ry + ra[8] * rz;
            const motion = Math.sqrt(dx * dx + dy * dy + dz * dz);
            // Clearance from the airframe: what the last query found, less how far
            // the particle has moved relative to it since (body frame, exact).
            const fresh = collider !== this.detectedFor;
            if (fresh) this.triListCount[i] = -1;
            const moved = fresh ? Infinity : len3(p0x - this.bp0[k], p0y - this.bp0[k + 1], p0z - this.bp0[k + 2]);
            let clear = this.clearance[i] - moved;
            this.bp0[k] = p0x; this.bp0[k + 1] = p0y; this.bp0[k + 2] = p0z;
            this.bMotion[i] = motion;
            this.requeried[i] = 1;
            const pad = reach + motion;
            if (fresh) this.bqValid[i] = 0;
            if (clear > pad) {
                this.clearance[i] = clear;
                this.bcHas[i] = 0;
                this.bqValid[i] = 0;
                continue;
            }
            // Outside the box, its distance to the box is a clearance, for free.
            const ox = Math.max(bnd[0] - p0x, 0, p0x - bnd[3]);
            const oy = Math.max(bnd[1] - p0y, 0, p0y - bnd[4]);
            const oz = Math.max(bnd[2] - p0z, 0, p0z - bnd[5]);
            const boxDist = Math.sqrt(ox * ox + oy * oy + oz * oz);
            if (boxDist > pad) {
                this.clearance[i] = boxDist;
                this.bcHas[i] = 0;
                this.bqValid[i] = 0;
                continue;
            }
            // Riding the airframe — hardly moved against it since its last query, and
            // not about to — it keeps what that query found: the same plane again.
            const bq = this.bq;
            if (this.bqValid[i] && this.bqAge[i] < REQUERY_AGE
                && len3(p0x - bq[k], p0y - bq[k + 1], p0z - bq[k + 2]) + motion < REQUERY_M) {
                this.bqAge[i]++;
                this.clearance[i] = Math.max(0, clear);
                this.requeried[i] = 0;
                continue;
            }
            bq[k] = p0x; bq[k + 1] = p0y; bq[k + 2] = p0z;
            this.bqValid[i] = 1;
            this.bqAge[i] = 0;
            this.bcHas[i] = 0;
            this.bcRim[i] = -1;
            // A particle that was clear last time queries wider, which buys a clearance that
            // skips the next few; one in contact would only pay for the wider search.
            const query = this.clearance[i] > CLEARANCE_QUERY_M / 2 ? Math.max(pad, CLEARANCE_QUERY_M) : pad;
            this.stats.pointQueries++;
            const found = this.closestNear(collider, i, p0x, p0y, p0z, query);
            clear = found ? Math.sqrt(this.near.distSq) : query;
            this.clearance[i] = clear;
            let sx: number, sy: number, sz: number, nx: number, ny: number, nz: number;
            if (motion > clear - SKIN_M && motion > 1e-9 && this.segmentHitNear(collider, i, p0x, p0y, p0z, dx, dy, dz)) {
                // It can reach the surface within the window: if its path crosses it, the crossed face is the contact.
                const hit = this.hit;
                sx = hit.x; sy = hit.y; sz = hit.z;
                nx = hit.nx; ny = hit.ny; nz = hit.nz;
                if (nx * (p0x - sx) + ny * (p0y - sy) + nz * (p0z - sz) < 0) { nx = -nx; ny = -ny; nz = -nz; }
            } else if (found && clear <= pad) {
                const near = this.near;
                sx = near.x; sy = near.y; sz = near.z;
                const qx = p0x - sx, qy = p0y - sy, qz = p0z - sz;
                if (clear > 1e-9) { nx = qx / clear; ny = qy / clear; nz = qz / clear; } else { nx = near.nx; ny = near.ny; nz = near.nz; }
                // Off the face's own normal: the nearest point is on its rim, a convex edge or corner.
                if (clear > 1e-9 && near.tri >= 0 && Math.abs(nx * near.nx + ny * near.ny + nz * near.nz) < RIM_COS) this.bcRim[i] = near.tri;
            } else {
                continue;
            }
            this.bcHas[i] = 1;
            this.bcS[k] = sx; this.bcS[k + 1] = sy; this.bcS[k + 2] = sz;
            this.bcN[k] = nx; this.bcN[k + 1] = ny; this.bcN[k + 2] = nz;
        }
        for (let i = 0; i < this.count; i++) if (this.bcHas[i]) this.bcI[this.bcCount++] = i;
    }

    /** The body-frame contacts as carrier-local planes at this substep's end pose, with the surface's velocity. */
    private placeBody(h: number): void {
        const { pa, pb, ra, rb } = this;
        const tri = this.detectedFor?.bvh.tri;
        for (let c = 0; c < this.bcCount; c++) {
            const k = 3 * this.bcI[c];
            const rim = this.bcRim[this.bcI[c]];
            if (rim >= 0 && tri && !(this.justDetected && this.requeried[this.bcI[c]])) {
                // A contact on a convex edge or corner is the nearest point of that rim to where
                // the particle is now, not the plane found at detection: a particle sliding round
                // the edge under a strap's pull met that stale tangent plane outside the skin,
                // was pushed out to it and pulled back, every few substeps, and the strap
                // flailed at 5-15 m/s on a still airframe.
                const ex = this.prev[k] - pa.x, ey = this.prev[k + 1] - pa.y, ez = this.prev[k + 2] - pa.z;
                const px = ra[0] * ex + ra[3] * ey + ra[6] * ez;
                const py = ra[1] * ex + ra[4] * ey + ra[7] * ez;
                const pz = ra[2] * ex + ra[5] * ey + ra[8] * ez;
                const d2 = closestOnTriangle(tri, rim, px, py, pz);
                const qx = px - closest.x, qy = py - closest.y, qz = pz - closest.z;
                const d = Math.sqrt(d2);
                // Only while it stays outside, on the side it was found on.
                if (d > 1e-6 && qx * this.bcN[k] + qy * this.bcN[k + 1] + qz * this.bcN[k + 2] > 0) {
                    this.bcS[k] = closest.x; this.bcS[k + 1] = closest.y; this.bcS[k + 2] = closest.z;
                    this.bcN[k] = qx / d; this.bcN[k + 1] = qy / d; this.bcN[k + 2] = qz / d;
                }
            }
            const sx = this.bcS[k], sy = this.bcS[k + 1], sz = this.bcS[k + 2];
            const nx = this.bcN[k], ny = this.bcN[k + 1], nz = this.bcN[k + 2];
            const wx = rb[0] * sx + rb[1] * sy + rb[2] * sz + pb.x;
            const wy = rb[3] * sx + rb[4] * sy + rb[5] * sz + pb.y;
            const wz = rb[6] * sx + rb[7] * sy + rb[8] * sz + pb.z;
            const vx = (wx - (ra[0] * sx + ra[1] * sy + ra[2] * sz + pa.x)) / h;
            const vy = (wy - (ra[3] * sx + ra[4] * sy + ra[5] * sz + pa.y)) / h;
            const vz = (wz - (ra[6] * sx + ra[7] * sy + ra[8] * sz + pa.z)) / h;
            const mx = rb[0] * nx + rb[1] * ny + rb[2] * nz;
            const my = rb[3] * nx + rb[4] * ny + rb[5] * nz;
            const mz = rb[6] * nx + rb[7] * ny + rb[8] * nz;
            this.addContact(this.bcI[c], mx, my, mz, mx * wx + my * wy + mz * wz + SKIN_M, vx, vy, vz, SKIN_FRICTION, true);
        }
    }

    /**
     * Every contact once, in order: the normal part pushes the particle out
     * to its plane, or gives back what it pushed earlier in the substep if
     * the chains have since lifted it (the multiplier never goes negative:
     * a contact only pushes). Friction then takes back the slip along the
     * surface since the substep began, up to μ times the normal multiplier.
     */
    private solveContacts(h: number): void {
        const { x, prev } = this;
        for (let c = 0; c < this.ctCount; c++) {
            const i = this.ctI[c];
            const k = 3 * i;
            const nx = this.ctN[3 * c], ny = this.ctN[3 * c + 1], nz = this.ctN[3 * c + 2];
            const C = nx * x[k] + ny * x[k + 1] + nz * x[k + 2] - this.ctOff[c];
            const ln = this.ctLn[c];
            const next = Math.max(0, ln - C);
            const dn = next - ln;
            if (dn !== 0) {
                x[k] += nx * dn;
                x[k + 1] += ny * dn;
                x[k + 2] += nz * dn;
                this.ctLn[c] = next;
            }
            const f = 3 * c;
            const fx0 = this.ctFt[f], fy0 = this.ctFt[f + 1], fz0 = this.ctFt[f + 2];
            if (next <= 0) {
                // Not pressed: whatever friction it applied is given back.
                if (fx0 !== 0 || fy0 !== 0 || fz0 !== 0) {
                    x[k] -= fx0; x[k + 1] -= fy0; x[k + 2] -= fz0;
                    this.ctFt[f] = this.ctFt[f + 1] = this.ctFt[f + 2] = 0;
                }
                continue;
            }
            // Slip relative to the surface over the substep, along it.
            const sx = x[k] - prev[k] - this.ctVel[f] * h;
            const sy = x[k + 1] - prev[k + 1] - this.ctVel[f + 1] * h;
            const sz = x[k + 2] - prev[k + 2] - this.ctVel[f + 2] * h;
            const sn = sx * nx + sy * ny + sz * nz;
            let tx = fx0 - (sx - sn * nx);
            let ty = fy0 - (sy - sn * ny);
            let tz = fz0 - (sz - sn * nz);
            const t = Math.sqrt(tx * tx + ty * ty + tz * tz);
            const limit = this.ctMu[c] * next;
            if (t > limit) {
                const s = limit / t;
                tx *= s; ty *= s; tz *= s;
            }
            x[k] += tx - fx0;
            x[k + 1] += ty - fy0;
            x[k + 2] += tz - fz0;
            this.ctFt[f] = tx; this.ctFt[f + 1] = ty; this.ctFt[f + 2] = tz;
        }
        const { w } = this;
        for (let c = 0; c < this.ecCount; c++) {
            const a = 3 * this.ecA[c], b = 3 * this.ecB[c];
            const s = this.ecS[c];
            const wa = w[this.ecA[c]] * (1 - s), wb = w[this.ecB[c]] * s;
            const den = wa * (1 - s) + wb * s;
            if (den <= 0) continue;
            const nx = this.ecN[3 * c], ny = this.ecN[3 * c + 1], nz = this.ecN[3 * c + 2];
            const px = x[a] + s * (x[b] - x[a]), py = x[a + 1] + s * (x[b + 1] - x[a + 1]), pz = x[a + 2] + s * (x[b + 2] - x[a + 2]);
            const C = nx * px + ny * py + nz * pz - this.ecOff[c];
            const l = this.ecL[c];
            const next = Math.max(0, l - C / den);
            const dl = next - l;
            if (dl !== 0) {
                this.ecL[c] = next;
                x[a] += nx * wa * dl; x[a + 1] += ny * wa * dl; x[a + 2] += nz * wa * dl;
                x[b] += nx * wb * dl; x[b + 1] += ny * wb * dl; x[b + 2] += nz * wb * dl;
            }
            // Friction on the edge, as on the skin: the slip of the link's contact point
            // along the surface, taken back up to mu times the normal multiplier. Without
            // it a strap on a swept leading edge slid outboard and shed its load.
            // It acts on the link as a whole: both ends move alike, so friction holds the strap
            // on the edge without stretching the link (applied at the contact point's weights,
            // it stretched the wrapped link past both its neighbours).
            const mab = this.mass[this.ecA[c]] + this.mass[this.ecB[c]];
            const f = 3 * c;
            const fx0 = this.ecFt[f], fy0 = this.ecFt[f + 1], fz0 = this.ecFt[f + 2];
            if (next <= 0) {
                if (fx0 !== 0 || fy0 !== 0 || fz0 !== 0) {
                    x[a] -= fx0 / mab; x[a + 1] -= fy0 / mab; x[a + 2] -= fz0 / mab;
                    x[b] -= fx0 / mab; x[b + 1] -= fy0 / mab; x[b + 2] -= fz0 / mab;
                    this.ecFt[f] = this.ecFt[f + 1] = this.ecFt[f + 2] = 0;
                }
                continue;
            }
            // The slip is the link's own: its centre of mass against the surface. Moving both
            // ends alike to take back the contact point's slip instead added energy whenever
            // the link turned about the edge (the point slid while the link's mass did not):
            // with the banded solve's load on it, 4-6 kW into a net hanging on a still airframe.
            const ma = this.mass[this.ecA[c]] / mab, mb = this.mass[this.ecB[c]] / mab;
            const qx = ma * (x[a] - prev[a]) + mb * (x[b] - prev[b]) - this.ecVel[f] * h;
            const qy = ma * (x[a + 1] - prev[a + 1]) + mb * (x[b + 1] - prev[b + 1]) - this.ecVel[f + 1] * h;
            const qz = ma * (x[a + 2] - prev[a + 2]) + mb * (x[b + 2] - prev[b + 2]) - this.ecVel[f + 2] * h;
            const qn = qx * nx + qy * ny + qz * nz;
            let tx = fx0 - (qx - qn * nx) * mab, ty = fy0 - (qy - qn * ny) * mab, tz = fz0 - (qz - qn * nz) * mab;
            const t = Math.sqrt(tx * tx + ty * ty + tz * tz);
            const limit = SKIN_FRICTION * next;
            if (t > limit) {
                const sc = limit / t;
                tx *= sc; ty *= sc; tz *= sc;
            }
            const ddx = (tx - fx0) / mab, ddy = (ty - fy0) / mab, ddz = (tz - fz0) / mab;
            x[a] += ddx; x[a + 1] += ddy; x[a + 2] += ddz;
            x[b] += ddx; x[b + 1] += ddy; x[b + 2] += ddz;
            this.ecFt[f] = tx; this.ecFt[f + 1] = ty; this.ecFt[f + 2] = tz;
        }
    }

    /**
     * Links against the airframe's edges for the next {@link DETECT_EVERY}
     * substeps, in its frame at their start: each link near the airframe
     * against every feature edge near it, by the closest points of the two
     * segments. A pair within reach (skin, speculative reach and the link's
     * motion over the window) whose closest point is inside the link is a
     * contact on that point of the link. Along an edge its normal is the
     * common perpendicular of link and edge, at an edge's end the
     * perpendicular from the corner to the link — either way pointing to
     * the side the link is on now, so a link lying on an edge stays on its
     * side however the airframe moves under it.
     */
    private detectEdges(col: WebCollider): void {
        const { bp0, bMotion } = this;
        const reach = SKIN_M + SPECULATIVE_M;
        this.ebCount = 0;
        for (let k = 0; k < this.linkI.length; k++) {
            const i = this.linkI[k], j = this.linkJ[k];
            const a = 3 * i, b = 3 * j;
            const r = reach + Math.max(bMotion[i], bMotion[j]);
            // The link can come no nearer the airframe than its nearer end less half its length.
            const half = 0.5 * len3(bp0[b] - bp0[a], bp0[b + 1] - bp0[a + 1], bp0[b + 2] - bp0[a + 2]);
            if (Math.min(this.clearance[i], this.clearance[j]) - half > r) {
                this.elCount[k] = 0;
                this.elValid[k] = 0;
                continue;
            }
            // Both ends riding the airframe: the link keeps what it found last time.
            const first = EDGE_CONTACTS_PER_LINK * k;
            if (col !== this.detectedFor) this.edgeListCount[k] = -1;
            // Re-found once either end has slid EDGE_REQUERY_M against the airframe: a link
            // sliding along an edge on a stale contact let go of it in one jump.
            const ep = this.elPos;
            const moved = Math.max(
                len3(bp0[a] - ep[6 * k], bp0[a + 1] - ep[6 * k + 1], bp0[a + 2] - ep[6 * k + 2]),
                len3(bp0[b] - ep[6 * k + 3], bp0[b + 1] - ep[6 * k + 4], bp0[b + 2] - ep[6 * k + 5]));
            if (!this.elValid[k] || moved >= EDGE_REQUERY_M || this.elAge[k] >= REQUERY_AGE) {
                this.elCount[k] = 0;
                this.elValid[k] = 1;
                this.elAge[k] = 0;
                ep[6 * k] = bp0[a]; ep[6 * k + 1] = bp0[a + 1]; ep[6 * k + 2] = bp0[a + 2];
                ep[6 * k + 3] = bp0[b]; ep[6 * k + 4] = bp0[b + 1]; ep[6 * k + 5] = bp0[b + 2];
                this.stats.edgeQueries++;
                this.findEdges(col, k, first, r);
            } else {
                this.elAge[k]++;
            }
            for (let c = first; c < first + this.elCount[k]; c++) this.ebList[this.ebCount++] = c;
        }
    }

    /** Edge contacts of link `k` into its slots from `first`, within reach `r`. */
    /**
     * The first face the segment from p (body frame) along d crosses, into
     * this.hit. Called right after {@link closestNear} for the same particle
     * with a query at least the segment's length: the particle's triangle
     * list then holds every triangle within that of p, so every one the
     * segment can cross, and the whole tree is walked only when the list
     * overflowed. The tree walk was a fifth of the F-14's fast catch.
     */
    private segmentHitNear(col: WebCollider, i: number, px: number, py: number, pz: number, dx: number, dy: number, dz: number): boolean {
        const n = this.triListCount[i];
        if (n < 0) return bvhSegmentHit(col.bvh, px, py, pz, px + dx, py + dy, pz + dz, this.hit);
        const tri = col.bvh.tri;
        const base = TRI_LIST * i;
        let best = 1, bt = -1, bnx = 0, bny = 0, bnz = 0;
        for (let q = 0; q < n; q++) {
            const t = this.triList[base + q];
            const o = 9 * t;
            const v0x = tri[o], v0y = tri[o + 1], v0z = tri[o + 2];
            const e1x = tri[o + 3] - v0x, e1y = tri[o + 4] - v0y, e1z = tri[o + 5] - v0z;
            const e2x = tri[o + 6] - v0x, e2y = tri[o + 7] - v0y, e2z = tri[o + 8] - v0z;
            // Moller-Trumbore, as the tree's own segment test.
            const qx = dy * e2z - dz * e2y, qy = dz * e2x - dx * e2z, qz = dx * e2y - dy * e2x;
            const det = e1x * qx + e1y * qy + e1z * qz;
            if (Math.abs(det) < 1e-12) continue;
            const inv = 1 / det;
            const tx = px - v0x, ty = py - v0y, tz = pz - v0z;
            const u = (tx * qx + ty * qy + tz * qz) * inv;
            if (u < 0 || u > 1) continue;
            const rx = ty * e1z - tz * e1y, ry = tz * e1x - tx * e1z, rz = tx * e1y - ty * e1x;
            const w = (dx * rx + dy * ry + dz * rz) * inv;
            if (w < 0 || u + w > 1) continue;
            const f = (e2x * rx + e2y * ry + e2z * rz) * inv;
            if (f < 0 || f >= best) continue;
            best = f;
            bt = t;
            bnx = e1y * e2z - e1z * e2y; bny = e1z * e2x - e1x * e2z; bnz = e1x * e2y - e1y * e2x;
        }
        if (bt < 0) return false;
        const hit = this.hit;
        const l = Math.sqrt(bnx * bnx + bny * bny + bnz * bnz) || 1;
        hit.t = best; hit.tri = bt;
        hit.x = px + dx * best; hit.y = py + dy * best; hit.z = pz + dz * best;
        hit.nx = bnx / l; hit.ny = bny / l; hit.nz = bnz / l;
        return true;
    }

    /**
     * The nearest surface point within `query` of particle i (body frame), into
     * this.near. From the particle's list of nearby triangles while that still
     * covers the query (built a margin wider, it holds every triangle within
     * the query until the particle has moved the margin), else a new list;
     * from the whole tree when the list would overflow.
     */
    private closestNear(col: WebCollider, i: number, px: number, py: number, pz: number, query: number): boolean {
        const k = 3 * i;
        const tp = this.triListPos;
        let n = this.triListCount[i];
        if (n < 0 || len3(px - tp[k], py - tp[k + 1], pz - tp[k + 2]) + query > this.triListR[i]) {
            const R = query + LIST_MARGIN_M;
            n = queryTriangles(col, px, py, pz, R, this.triScratch);
            if (n < 0) {
                this.stats.listOverflows++;
                this.triListCount[i] = -1;
                return bvhClosestPoint(col.bvh, px, py, pz, query, this.near);
            }
            this.triList.set(this.triScratch.subarray(0, n), TRI_LIST * i);
            this.triListCount[i] = n;
            this.triListR[i] = R;
            tp[k] = px; tp[k + 1] = py; tp[k + 2] = pz;
        }
        const near = this.near;
        let best = query * query, bt = -1;
        const base = TRI_LIST * i;
        const tri = col.bvh.tri;
        const box = this.boxesFor(col).tri;
        for (let q = 0; q < n; q++) {
            const t = this.triList[base + q];
            // The triangle's box first: most of the list is farther than the best so far.
            const o = 6 * t;
            const r = Math.sqrt(best);
            if (box[o] > px + r || box[o + 3] < px - r || box[o + 1] > py + r || box[o + 4] < py - r
                || box[o + 2] > pz + r || box[o + 5] < pz - r) continue;
            const d2 = closestOnTriangle(tri, t, px, py, pz);
            if (d2 < best) {
                best = d2; bt = t;
                near.x = closest.x; near.y = closest.y; near.z = closest.z;
            }
        }
        if (bt < 0) return false;
        near.distSq = best;
        near.tri = bt;
        // Face normal, for a particle exactly on the surface.
        const o = 9 * bt;
        const e1x = tri[o + 3] - tri[o], e1y = tri[o + 4] - tri[o + 1], e1z = tri[o + 5] - tri[o + 2];
        const e2x = tri[o + 6] - tri[o], e2y = tri[o + 7] - tri[o + 1], e2z = tri[o + 8] - tri[o + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const l = len3(nx, ny, nz) || 1;
        near.nx = nx / l; near.ny = ny / l; near.nz = nz / l;
        return true;
    }

    /**
     * Edges near link k for a query of reach r: its list while that still
     * covers it (built a margin wider), else a new list; straight from the
     * tree when the list would overflow. Returns the array and count.
     */
    /** Each triangle's and each feature edge's box (min xyz, max xyz) for a collider, made once. */
    private boxesFor(col: WebCollider): { tri: Float32Array; edge: Float32Array } {
        if (this.boxCol === col) return this.boxes;
        const tri = col.bvh.tri, E = col.edges;
        const tb = new Float32Array(2 * tri.length / 3), eb = new Float32Array(E.length);
        for (let t = 0; 9 * t < tri.length; t++) {
            const o = 9 * t;
            for (let d = 0; d < 3; d++) {
                tb[6 * t + d] = Math.min(tri[o + d], tri[o + 3 + d], tri[o + 6 + d]);
                tb[6 * t + 3 + d] = Math.max(tri[o + d], tri[o + 3 + d], tri[o + 6 + d]);
            }
        }
        for (let e = 0; e < E.length; e += 6) {
            for (let d = 0; d < 3; d++) {
                eb[e + d] = Math.min(E[e + d], E[e + 3 + d]);
                eb[e + 3 + d] = Math.max(E[e + d], E[e + 3 + d]);
            }
        }
        this.boxCol = col;
        this.boxes = { tri: tb, edge: eb };
        return this.boxes;
    }
    private boxCol: WebCollider | null = null;
    /** The contacts were found at the start of this substep (see placeBody, placeEdges). */
    private justDetected = false;
    private boxes = { tri: new Float32Array(0), edge: new Float32Array(0) };

    private edgesNear(col: WebCollider, k: number, r: number): number {
        const { bp0 } = this;
        const a = 3 * this.linkI[k], b = 3 * this.linkJ[k];
        const lp = this.edgeListPos;
        let n = this.edgeListCount[k];
        const moved = n < 0 ? Infinity : Math.max(
            len3(bp0[a] - lp[6 * k], bp0[a + 1] - lp[6 * k + 1], bp0[a + 2] - lp[6 * k + 2]),
            len3(bp0[b] - lp[6 * k + 3], bp0[b + 1] - lp[6 * k + 4], bp0[b + 2] - lp[6 * k + 5]));
        if (moved + r > this.edgeListR[k]) {
            const R = r + LIST_MARGIN_M;
            n = queryEdges(col,
                Math.min(bp0[a], bp0[b]) - R, Math.min(bp0[a + 1], bp0[b + 1]) - R, Math.min(bp0[a + 2], bp0[b + 2]) - R,
                Math.max(bp0[a], bp0[b]) + R, Math.max(bp0[a + 1], bp0[b + 1]) + R, Math.max(bp0[a + 2], bp0[b + 2]) + R,
                this.edgeScratch);
            if (n === this.edgeScratch.length) {
                this.stats.listOverflows++;
                // Too many for a list: this once from the tree at the reach asked.
                this.edgeListCount[k] = -1;
                this.edgeListR[k] = 0;
                const found = queryEdges(col,
                    Math.min(bp0[a], bp0[b]) - r, Math.min(bp0[a + 1], bp0[b + 1]) - r, Math.min(bp0[a + 2], bp0[b + 2]) - r,
                    Math.max(bp0[a], bp0[b]) + r, Math.max(bp0[a + 1], bp0[b + 1]) + r, Math.max(bp0[a + 2], bp0[b + 2]) + r,
                    this.edgeHits);
                if (found === this.edgeHits.length) this.stats.edgeQueryOverflows++;
                return found;
            }
            this.edgeList.set(this.edgeScratch.subarray(0, n), EDGE_LIST * k);
            this.edgeListCount[k] = n;
            this.edgeListR[k] = R;
            lp[6 * k] = bp0[a]; lp[6 * k + 1] = bp0[a + 1]; lp[6 * k + 2] = bp0[a + 2];
            lp[6 * k + 3] = bp0[b]; lp[6 * k + 4] = bp0[b + 1]; lp[6 * k + 5] = bp0[b + 2];
        }
        // Only those whose boxes reach the box this query needs.
        const mnx = Math.min(bp0[a], bp0[b]) - r, mny = Math.min(bp0[a + 1], bp0[b + 1]) - r, mnz = Math.min(bp0[a + 2], bp0[b + 2]) - r;
        const mxx = Math.max(bp0[a], bp0[b]) + r, mxy = Math.max(bp0[a + 1], bp0[b + 1]) + r, mxz = Math.max(bp0[a + 2], bp0[b + 2]) + r;
        let found = 0;
        const base = EDGE_LIST * k;
        const box = this.boxesFor(col).edge;
        for (let q = 0; q < n; q++) {
            const id = this.edgeList[base + q];
            const e = 6 * id;
            if (box[e] > mxx || box[e + 3] < mnx || box[e + 1] > mxy || box[e + 4] < mny
                || box[e + 2] > mxz || box[e + 5] < mnz) continue;
            this.edgeHits[found++] = id;
        }
        return found;
    }

    private findEdges(col: WebCollider, k: number, first: number, r: number): void {
        const { bp0 } = this;
        const E = col.edges;
        const i = this.linkI[k], j = this.linkJ[k];
        const a = 3 * i, b = 3 * j;
        {
            const found = this.edgesNear(col, k, r);
            for (let q = 0; q < found; q++) {
                const e = 6 * this.edgeHits[q];
                if (!closestSegments(bp0[a], bp0[a + 1], bp0[a + 2], bp0[b], bp0[b + 1], bp0[b + 2],
                    E[e], E[e + 1], E[e + 2], E[e + 3], E[e + 4], E[e + 5])) continue;
                const s = _s, u = _u;
                // A link end at the edge is a particle contact's business.
                if (s <= 0 || s >= 1) continue;
                const qx = E[e] + u * (E[e + 3] - E[e]), qy = E[e + 1] + u * (E[e + 4] - E[e + 1]), qz = E[e + 2] + u * (E[e + 5] - E[e + 2]);
                const ox = bp0[a] + s * (bp0[b] - bp0[a]) - qx;
                const oy = bp0[a + 1] + s * (bp0[b + 1] - bp0[a + 1]) - qy;
                const oz = bp0[a + 2] + s * (bp0[b + 2] - bp0[a + 2]) - qz;
                const d2 = ox * ox + oy * oy + oz * oz;
                if (d2 > r * r || d2 < 1e-12) continue;
                let nx: number, ny: number, nz: number;
                if (u > 0 && u < 1) {
                    const lx = bp0[b] - bp0[a], ly = bp0[b + 1] - bp0[a + 1], lz = bp0[b + 2] - bp0[a + 2];
                    const gx = E[e + 3] - E[e], gy = E[e + 4] - E[e + 1], gz = E[e + 5] - E[e + 2];
                    nx = ly * gz - lz * gy; ny = lz * gx - lx * gz; nz = lx * gy - ly * gx;
                    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
                    if (nl < 1e-6 * Math.sqrt((lx * lx + ly * ly + lz * lz) * (gx * gx + gy * gy + gz * gz))) continue;
                    nx /= nl; ny /= nl; nz /= nl;
                    if (nx * ox + ny * oy + nz * oz < 0) { nx = -nx; ny = -ny; nz = -nz; }
                } else {
                    // The closest point on the link to a corner is square to the link already.
                    const d = Math.sqrt(d2);
                    nx = ox / d; ny = oy / d; nz = oz / d;
                }
                // Keep the nearest few, once each: a split edge gives the same contact twice
                // (same way, same place), but two parallel edges along the link are two contacts.
                const end = first + this.elCount[k];
                let slot = -1;
                for (let c = first; c < end; c++) {
                    if (this.ebN[3 * c] * nx + this.ebN[3 * c + 1] * ny + this.ebN[3 * c + 2] * nz > 0.9
                        && (this.ebQ[3 * c] - qx) ** 2 + (this.ebQ[3 * c + 1] - qy) ** 2 + (this.ebQ[3 * c + 2] - qz) ** 2 < 4e-4) { slot = c; break; }
                }
                if (slot >= 0) {
                    if (d2 >= this.ebD[slot]) continue;
                } else if (end - first < EDGE_CONTACTS_PER_LINK) {
                    slot = end;
                    this.elCount[k]++;
                } else {
                    // Full: replace the farthest if this one is nearer.
                    slot = first;
                    for (let c = first + 1; c < end; c++) if (this.ebD[c] > this.ebD[slot]) slot = c;
                    if (d2 >= this.ebD[slot]) continue;
                }
                this.ebA[slot] = i; this.ebB[slot] = j; this.ebS[slot] = s; this.ebD[slot] = d2;
                this.ebQ[3 * slot] = qx; this.ebQ[3 * slot + 1] = qy; this.ebQ[3 * slot + 2] = qz;
                this.ebN[3 * slot] = nx; this.ebN[3 * slot + 1] = ny; this.ebN[3 * slot + 2] = nz;
                this.ebE[slot] = this.edgeHits[q];
            }
        }
    }

    /** The body-frame edge contacts as carrier-local planes at this substep's end pose. */
    private placeEdges(h: number): void {
        const { pa, pb, ra, rb } = this;
        const E = this.detectedFor?.edges;
        for (let c = 0; c < this.ebCount; c++) {
            const e = this.ebList[c];
            // Found from these very positions this substep: nothing to re-aim.
            if (E && !(this.justDetected && this.elAge[Math.floor(e / EDGE_CONTACTS_PER_LINK)] === 0)) this.reaimEdge(e, E);
            const qx = this.ebQ[3 * e], qy = this.ebQ[3 * e + 1], qz = this.ebQ[3 * e + 2];
            const nx = this.ebN[3 * e], ny = this.ebN[3 * e + 1], nz = this.ebN[3 * e + 2];
            const wx = rb[0] * qx + rb[1] * qy + rb[2] * qz + pb.x;
            const wy = rb[3] * qx + rb[4] * qy + rb[5] * qz + pb.y;
            const wz = rb[6] * qx + rb[7] * qy + rb[8] * qz + pb.z;
            const mx = rb[0] * nx + rb[1] * ny + rb[2] * nz;
            const my = rb[3] * nx + rb[4] * ny + rb[5] * nz;
            const mz = rb[6] * nx + rb[7] * ny + rb[8] * nz;
            this.ecA[c] = this.ebA[e]; this.ecB[c] = this.ebB[e]; this.ecS[c] = this.ebS[e];
            this.ecN[3 * c] = mx; this.ecN[3 * c + 1] = my; this.ecN[3 * c + 2] = mz;
            this.ecOff[c] = mx * wx + my * wy + mz * wz + SKIN_M;
            this.ecVel[3 * c] = (wx - (ra[0] * qx + ra[1] * qy + ra[2] * qz + pa.x)) / h;
            this.ecVel[3 * c + 1] = (wy - (ra[3] * qx + ra[4] * qy + ra[5] * qz + pa.y)) / h;
            this.ecVel[3 * c + 2] = (wz - (ra[6] * qx + ra[7] * qy + ra[8] * qz + pa.z)) / h;
            this.ecL[c] = 0;
            this.ecFt[3 * c] = this.ecFt[3 * c + 1] = this.ecFt[3 * c + 2] = 0;
        }
        this.ecCount = this.ebCount;
    }

    /**
     * Edge contact slot e as the link is now (start of the substep, body
     * frame), not as it was at detection: the closest points of link and
     * edge again, and the normal between them, while the link stays on the
     * side it was found on. A link sliding round an edge met the stale plane
     * outside the skin and was kicked out and pulled back each detection, as
     * point contacts were (see placeBody).
     */
    private reaimEdge(e: number, E: Float32Array): void {
        const { pa, ra, prev } = this;
        const a = 3 * this.ebA[e], b = 3 * this.ebB[e];
        const ax = prev[a] - pa.x, ay = prev[a + 1] - pa.y, az = prev[a + 2] - pa.z;
        const bx = prev[b] - pa.x, by = prev[b + 1] - pa.y, bz = prev[b + 2] - pa.z;
        const p0x = ra[0] * ax + ra[3] * ay + ra[6] * az, p0y = ra[1] * ax + ra[4] * ay + ra[7] * az, p0z = ra[2] * ax + ra[5] * ay + ra[8] * az;
        const p1x = ra[0] * bx + ra[3] * by + ra[6] * bz, p1y = ra[1] * bx + ra[4] * by + ra[7] * bz, p1z = ra[2] * bx + ra[5] * by + ra[8] * bz;
        const g = 6 * this.ebE[e];
        if (!closestSegments(p0x, p0y, p0z, p1x, p1y, p1z, E[g], E[g + 1], E[g + 2], E[g + 3], E[g + 4], E[g + 5])) return;
        const sp = _s, u = _u;
        if (sp <= 0 || sp >= 1) return;
        const qx = E[g] + u * (E[g + 3] - E[g]), qy = E[g + 1] + u * (E[g + 4] - E[g + 1]), qz = E[g + 2] + u * (E[g + 5] - E[g + 2]);
        const ox = p0x + sp * (p1x - p0x) - qx, oy = p0y + sp * (p1y - p0y) - qy, oz = p0z + sp * (p1z - p0z) - qz;
        const d = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const n3 = 3 * e;
        if (d < 1e-6 || ox * this.ebN[n3] + oy * this.ebN[n3 + 1] + oz * this.ebN[n3 + 2] <= 0) return;
        let nx = ox / d, ny = oy / d, nz = oz / d;
        if (u > 0 && u < 1) {
            // Square to both: along their common perpendicular, on the link's side.
            const lx = p1x - p0x, ly = p1y - p0y, lz = p1z - p0z;
            const gx = E[g + 3] - E[g], gy = E[g + 4] - E[g + 1], gz = E[g + 5] - E[g + 2];
            let cx = ly * gz - lz * gy, cy = lz * gx - lx * gz, cz = lx * gy - ly * gx;
            const cl = Math.sqrt(cx * cx + cy * cy + cz * cz);
            if (cl < 1e-6 * Math.sqrt((lx * lx + ly * ly + lz * lz) * (gx * gx + gy * gy + gz * gz))) return;
            if (cx * ox + cy * oy + cz * oz < 0) { cx = -cx; cy = -cy; cz = -cz; }
            nx = cx / cl; ny = cy / cl; nz = cz / cl;
        }
        this.ebS[e] = sp;
        this.ebQ[n3] = qx; this.ebQ[n3 + 1] = qy; this.ebQ[n3 + 2] = qz;
        this.ebN[n3] = nx; this.ebN[n3 + 1] = ny; this.ebN[n3 + 2] = nz;
    }

    /** Add (p - pb) x j to m: the moment about the body's position of an impulse on the webbing at p. */
    private addMoment(m: Float64Array, px: number, py: number, pz: number, jx: number, jy: number, jz: number): void {
        const rx = px - this.pb.x, ry = py - this.pb.y, rz = pz - this.pb.z;
        m[0] += ry * jz - rz * jy;
        m[1] += rz * jx - rx * jz;
        m[2] += rx * jy - ry * jx;
    }

    /** The impulse the airframe contacts put on the webbing this substep; the airframe takes the opposite. */
    private collectReaction(h: number): void {
        // The inelastic velocity resets, then the position corrections.
        let ix = this.velImp[0], iy = this.velImp[1], iz = this.velImp[2];
        this.velImp[0] = this.velImp[1] = this.velImp[2] = 0;
        const mom = this.mom;
        mom[0] = this.velMom[0]; mom[1] = this.velMom[1]; mom[2] = this.velMom[2];
        let pressed = 0;
        const bp = this.bodyPressed;
        bp.fill(0);
        const { x, prev } = this;
        for (let c = 0; c < this.ctCount; c++) {
            if (this.ctLn[c] <= 0) continue;
            // Friction's work: minus its force (mass x correction / h^2) dotted with the slip
            // that remained. Signed, as power is: |F| |slip| counted a node chattering
            // in place, its force and slip flipping, as hundreds of kilowatts of heat.
            const f3 = 3 * c, k3 = 3 * this.ctI[c];
            const ftx = this.ctFt[f3], fty = this.ctFt[f3 + 1], ftz = this.ctFt[f3 + 2];
            if (ftx !== 0 || fty !== 0 || ftz !== 0) {
                const nx = this.ctN[f3], ny = this.ctN[f3 + 1], nz = this.ctN[f3 + 2];
                const sx = x[k3] - prev[k3] - this.ctVel[f3] * h, sy = x[k3 + 1] - prev[k3 + 1] - this.ctVel[f3 + 1] * h, sz = x[k3 + 2] - prev[k3 + 2] - this.ctVel[f3 + 2] * h;
                const sn = sx * nx + sy * ny + sz * nz;
                this.stats.frictionWork -= this.mass[this.ctI[c]] * (ftx * (sx - sn * nx) + fty * (sy - sn * ny) + ftz * (sz - sn * nz)) / (h * h);
            }
            if (!this.ctBody[c]) continue;
            pressed++;
            bp[this.ctI[c]] = 1;
            const m = this.mass[this.ctI[c]] / h;
            const ln = this.ctLn[c];
            const jx = m * (this.ctN[3 * c] * ln + this.ctFt[3 * c]);
            const jy = m * (this.ctN[3 * c + 1] * ln + this.ctFt[3 * c + 1]);
            const jz = m * (this.ctN[3 * c + 2] * ln + this.ctFt[3 * c + 2]);
            ix += jx; iy += jy; iz += jz;
            this.stats.bodyWork += jx * this.ctVel[3 * c] + jy * this.ctVel[3 * c + 1] + jz * this.ctVel[3 * c + 2];
            this.addMoment(mom, x[k3], x[k3 + 1], x[k3 + 2], jx, jy, jz);
        }
        for (let c = 0; c < this.ecCount; c++) {
            const l = this.ecL[c];
            if (l <= 0) continue;
            pressed++;
            bp[this.ecA[c]] = 1;
            bp[this.ecB[c]] = 1;
            const f = 3 * c;
            const jx = (this.ecN[f] * l + this.ecFt[f]) / h;
            const jy = (this.ecN[f + 1] * l + this.ecFt[f + 1]) / h;
            const jz = (this.ecN[f + 2] * l + this.ecFt[f + 2]) / h;
            ix += jx; iy += jy; iz += jz;
            this.stats.bodyWork += jx * this.ecVel[f] + jy * this.ecVel[f + 1] + jz * this.ecVel[f + 2];
            {
                const a = 3 * this.ecA[c], b = 3 * this.ecB[c], sp = this.ecS[c];
                this.addMoment(mom, x[a] + sp * (x[b] - x[a]), x[a + 1] + sp * (x[b + 1] - x[a + 1]), x[a + 2] + sp * (x[b + 2] - x[a + 2]), jx, jy, jz);
            }
            const ftx = this.ecFt[f], fty = this.ecFt[f + 1], ftz = this.ecFt[f + 2];
            if (ftx !== 0 || fty !== 0 || ftz !== 0) {
                // On the link's centre of mass, where the friction acts (see contactEdges).
                const a = 3 * this.ecA[c], b = 3 * this.ecB[c];
                const mab = this.mass[this.ecA[c]] + this.mass[this.ecB[c]];
                const ma = this.mass[this.ecA[c]] / mab, mb = this.mass[this.ecB[c]] / mab;
                const nx = this.ecN[f], ny = this.ecN[f + 1], nz = this.ecN[f + 2];
                const qx = ma * (x[a] - prev[a]) + mb * (x[b] - prev[b]) - this.ecVel[f] * h;
                const qy = ma * (x[a + 1] - prev[a + 1]) + mb * (x[b + 1] - prev[b + 1]) - this.ecVel[f + 1] * h;
                const qz = ma * (x[a + 2] - prev[a + 2]) + mb * (x[b + 2] - prev[b + 2]) - this.ecVel[f + 2] * h;
                const qn = qx * nx + qy * ny + qz * nz;
                this.stats.frictionWork -= (ftx * (qx - qn * nx) + fty * (qy - qn * ny) + ftz * (qz - qn * nz)) / (h * h);
            }
        }
        this.imp[0] = ix; this.imp[1] = iy; this.imp[2] = iz;
        this.stats.reaction[0] += ix;
        this.stats.reaction[1] += iy;
        this.stats.reaction[2] += iz;
        this.stats.contacts = pressed;
    }

    /**
     * Velocity from the substep's displacement — except along a pressed
     * contact's normal, where it is set to the surface's own (inelastic):
     * the push-out is position, not velocity. Friction is already in the
     * positions.
     */
    /**
     * The webbing's own hysteresis, as Kelvin-Voigt damping on each taut
     * link: its stretch rate decays at 2 zeta omega, omega the link's own
     * axial frequency. Nylon webbing loses 10-30 % of the strain energy of
     * a cycle (loss factor 0.1-0.3); zeta = 0.1 is a loss factor of 0.2.
     * At catch strain rates the damping force is a few newtons against
     * kilonewtons of tension: it takes the impact and release vibration out
     * of the webbing, and the energy it takes is counted.
     */
    private dampLinks(h: number): void {
        const { x, v, w } = this;
        // All links from the same velocities, then applied (Jacobi), so the net stays symmetric.
        const dvA = this.dampDv, touched = this.dampTouched;
        let nt = 0;
        let e = 0;
        for (let k = 0; k < this.linkI.length; k++) {
            const f = this.linkDampFactor[k];
            if (f >= 1) continue;
            const i = this.linkI[k], j = this.linkJ[k];
            const a = 3 * i, b = 3 * j;
            const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
            const d2 = dx * dx + dy * dy + dz * dz;
            const rest = this.linkRest[k];
            // A slack link carries no stress, so no internal damping either. A link hanging at
            // its rest length counts as taut: decided by round-off, mirror links went apart.
            if (d2 < rest * rest * (1 - DAMP_TOL)) continue;
            const inv = 1 / Math.sqrt(d2);
            const nx = dx * inv, ny = dy * inv, nz = dz * inv;
            const vr = (v[b] - v[a]) * nx + (v[b + 1] - v[a + 1]) * ny + (v[b + 2] - v[a + 2]) * nz;
            const ws = w[i] + w[j];
            const dv = vr * (f - 1);
            const J = dv / ws;
            if (!this.dampMark[i]) { this.dampMark[i] = 1; touched[nt++] = i; }
            if (!this.dampMark[j]) { this.dampMark[j] = 1; touched[nt++] = j; }
            dvA[a] -= w[i] * J * nx; dvA[a + 1] -= w[i] * J * ny; dvA[a + 2] -= w[i] * J * nz;
            dvA[b] += w[j] * J * nx; dvA[b + 1] += w[j] * J * ny; dvA[b + 2] += w[j] * J * nz;
            // The energy this link's damping takes (its relative motion, reduced mass 1/ws).
            e += 0.5 * (vr * vr - (vr + dv) * (vr + dv)) / ws;
        }
        for (let t = 0; t < nt; t++) {
            const q = 3 * touched[t];
            v[q] += dvA[q]; v[q + 1] += dvA[q + 1]; v[q + 2] += dvA[q + 2];
            dvA[q] = dvA[q + 1] = dvA[q + 2] = 0;
            this.dampMark[touched[t]] = 0;
        }
        this.stats.materialWork += e;
    }
    /**
     * Air drag on the webbing moving across itself: each link a flat strip
     * broadside to the flow, force (rho/2) Cd w L |v_n| v_n on the velocity
     * across the link at its middle (along it the webbing slides free),
     * half to each end. Taken implicitly in |v_n| (the change never more
     * than v_n itself), so it holds at catch speeds too. Once a frame, after
     * its substeps: drag changes the webbing's speed over a tenth of a second
     * and more, and each substep it was a tenth of the solver's time.
     */
    private crossflowDrag(h: number): void {
        if (!CROSSFLOW_DRAG) return;
        const { x, v } = this;
        // All links from the same velocities, then applied (Jacobi): in place, link by link, the
        // shared nodes saw the first link's change, and the rigged net lost its mirror symmetry.
        const dv = this.dampDv;
        let e = 0;
        for (let k = 0; k < this.linkI.length; k++) {
            const i = this.linkI[k], j = this.linkJ[k];
            if (this.w[i] === 0 && this.w[j] === 0) continue;
            const a = 3 * i, b = 3 * j;
            const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d < 1e-9) continue;
            const tx = dx / d, ty = dy / d, tz = dz / d;
            const mx = 0.5 * (v[a] + v[b]), my = 0.5 * (v[a + 1] + v[b + 1]), mz = 0.5 * (v[a + 2] + v[b + 2]);
            const vt = mx * tx + my * ty + mz * tz;
            const nx = mx - vt * tx, ny = my - vt * ty, nz = mz - vt * tz;
            const vn = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (vn < 1e-9) continue;
            // (rho/2) Cd w L over the link's mass: the deceleration per (m/s)^2.
            const mab = this.mass[i] + this.mass[j];
            const c = (0.5 * AIR_DENSITY * STRIP_CD * this.linkWidth[k] * d) / mab;
            // Implicit in the speed: v' = v / (1 + c v h) across the link.
            const f = 1 / (1 + c * vn * h) - 1;
            const ux = nx * f, uy = ny * f, uz = nz * f;
            for (let end = 0; end < 2; end++) {
                const p = end === 0 ? i : j;
                if (this.w[p] === 0) continue;
                const q = 3 * p;
                dv[q] += ux; dv[q + 1] += uy; dv[q + 2] += uz;
            }
        }
        for (let p = 0; p < this.count; p++) {
            const q = 3 * p;
            if (dv[q] === 0 && dv[q + 1] === 0 && dv[q + 2] === 0) continue;
            const before = v[q] * v[q] + v[q + 1] * v[q + 1] + v[q + 2] * v[q + 2];
            v[q] += dv[q]; v[q + 1] += dv[q + 1]; v[q + 2] += dv[q + 2];
            e += 0.5 * this.mass[p] * (before - (v[q] * v[q] + v[q + 1] * v[q + 1] + v[q + 2] * v[q + 2]));
        }
        this.stats.dragWork += e;
        // dampLinks expects its scratch clear.
        dv.fill(0);
    }

    private dampTouched = new Int32Array(0);
    private dampMark = new Uint8Array(0);
    private dampDv = new Float64Array(0);

    private updateVelocities(h: number): void {
        const { x, prev, v } = this;
        this.velMom[0] = this.velMom[1] = this.velMom[2] = 0;
        for (let i = 0; i < this.count; i++) {
            const k = 3 * i;
            v[k] = (x[k] - prev[k]) / h;
            v[k + 1] = (x[k + 1] - prev[k + 1]) / h;
            v[k + 2] = (x[k + 2] - prev[k + 2]) / h;
        }
        for (let c = 0; c < this.ctCount; c++) {
            if (this.ctLn[c] <= 0) continue;
            const k = 3 * this.ctI[c];
            const nx = this.ctN[3 * c], ny = this.ctN[3 * c + 1], nz = this.ctN[3 * c + 2];
            const vn = (v[k] - this.ctVel[3 * c]) * nx + (v[k + 1] - this.ctVel[3 * c + 1]) * ny
                + (v[k + 2] - this.ctVel[3 * c + 2]) * nz;
            this.stats.contactResetLoss += 0.5 * this.mass[this.ctI[c]] * vn * vn;
            v[k] -= vn * nx;
            v[k + 1] -= vn * ny;
            v[k + 2] -= vn * nz;
            if (this.ctBody[c]) {
                // That change of momentum is the airframe's too.
                const m = this.mass[this.ctI[c]];
                this.velImp[0] -= m * vn * nx;
                this.velImp[1] -= m * vn * ny;
                this.velImp[2] -= m * vn * nz;
                this.addMoment(this.velMom, x[k], x[k + 1], x[k + 2], -m * vn * nx, -m * vn * ny, -m * vn * nz);
                this.stats.bodyWork -= m * vn * (nx * this.ctVel[3 * c] + ny * this.ctVel[3 * c + 1] + nz * this.ctVel[3 * c + 2]);
            }
        }
        // A pressed link: no velocity into or out of the edge at its contact point.
        const { w } = this;
        for (let c = 0; c < this.ecCount; c++) {
            if (this.ecL[c] <= 0) continue;
            const a = 3 * this.ecA[c], b = 3 * this.ecB[c];
            const s = this.ecS[c];
            const wa = w[this.ecA[c]] * (1 - s), wb = w[this.ecB[c]] * s;
            const den = wa * (1 - s) + wb * s;
            const nx = this.ecN[3 * c], ny = this.ecN[3 * c + 1], nz = this.ecN[3 * c + 2];
            const vn = (v[a] + s * (v[b] - v[a]) - this.ecVel[3 * c]) * nx
                + (v[a + 1] + s * (v[b + 1] - v[a + 1]) - this.ecVel[3 * c + 1]) * ny
                + (v[a + 2] + s * (v[b + 2] - v[a + 2]) - this.ecVel[3 * c + 2]) * nz;
            const g = -vn / den;
            this.stats.contactResetLoss += 0.5 * vn * vn / den;
            v[a] += nx * wa * g; v[a + 1] += ny * wa * g; v[a + 2] += nz * wa * g;
            v[b] += nx * wb * g; v[b + 1] += ny * wb * g; v[b + 2] += nz * wb * g;
            this.velImp[0] += nx * g;
            this.velImp[1] += ny * g;
            this.velImp[2] += nz * g;
            this.addMoment(this.velMom, x[a] + s * (x[b] - x[a]), x[a + 1] + s * (x[b + 1] - x[a + 1]), x[a + 2] + s * (x[b + 2] - x[a + 2]), nx * g, ny * g, nz * g);
            this.stats.bodyWork += g * (nx * this.ecVel[3 * c] + ny * this.ecVel[3 * c + 1] + nz * this.ecVel[3 * c + 2]);
        }
    }

    private measure(): void {
        const { x, v } = this;
        let maxSpeed = 0, lowest = this.stats.lowestY;
        for (let i = 0; i < this.count; i++) {
            const k = 3 * i;
            maxSpeed = Math.max(maxSpeed, len3(v[k], v[k + 1], v[k + 2]));
            if (x[k + 1] < lowest) lowest = x[k + 1];
        }
        this.stats.lowestY = lowest;
        let belt = 0;
        let strap = 0;
        for (let k = 0; k < this.linkRest.length; k++) {
            const a = 3 * this.linkI[k];
            const b = 3 * this.linkJ[k];
            const d = len3(x[b] - x[a], x[b + 1] - x[a + 1], x[b + 2] - x[a + 2]);
            const strain = (d - this.linkRest[k]) / this.linkRest[k];
            if (this.linkIsStrap[k]) strap = Math.max(strap, strain);
            else belt = Math.max(belt, strain);
        }
        this.stats.maxSpeed = maxSpeed;
        this.stats.maxBeltStrain = belt;
        this.stats.maxStrapStrain = strap;
        this.stats.tieDownsBroken = this.tieBroken.reduce((a, b) => a + b, 0);
    }
}

/** Closest-point parameters of the last {@link closestSegments}. */
let _s = 0, _u = 0;

/**
 * Closest points of segments p0p1 and q0q1 (Ericson, Real-Time Collision
 * Detection 5.1.9): parameters into _s, _u. False when either is degenerate.
 */
function closestSegments(
    p0x: number, p0y: number, p0z: number, p1x: number, p1y: number, p1z: number,
    q0x: number, q0y: number, q0z: number, q1x: number, q1y: number, q1z: number,
): boolean {
    const d1x = p1x - p0x, d1y = p1y - p0y, d1z = p1z - p0z;
    const d2x = q1x - q0x, d2y = q1y - q0y, d2z = q1z - q0z;
    const rx = p0x - q0x, ry = p0y - q0y, rz = p0z - q0z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    if (a < 1e-12 || e < 1e-12) return false;
    const f = d2x * rx + d2y * ry + d2z * rz;
    const c = d1x * rx + d1y * ry + d1z * rz;
    const b = d1x * d2x + d1y * d2y + d1z * d2z;
    const den = a * e - b * b;
    let s = den > 1e-12 * a * e ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
    let u = (b * s + f) / e;
    if (u < 0) {
        u = 0;
        s = Math.min(1, Math.max(0, -c / a));
    } else if (u > 1) {
        u = 1;
        s = Math.min(1, Math.max(0, (b - c) / a));
    }
    _s = s;
    _u = u;
    return true;
}

function dist3(x: Float64Array, i: number, p: readonly number[]): number {
    const k = 3 * i;
    return len3(x[k] - p[0], x[k + 1] - p[1], x[k + 2] - p[2]);
}
