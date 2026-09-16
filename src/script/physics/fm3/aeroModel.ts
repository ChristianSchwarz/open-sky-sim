/**
 * FM3 aerodynamics: turns an {@link Fm3Airframe} into the force and moment on
 * the rigid body.
 *
 * Every contribution is computed from the local flow at its own location — the
 * CG's velocity through the air plus ω × r — so rate damping, sideslip effects
 * and the asymmetric loads of a rolling, yawing, stalled aircraft come out of
 * the geometry:
 *
 *  - Lifting surfaces are cut into spanwise strips. Each strip resolves its
 *    local velocity into the plane normal to its quarter-chord line (simple
 *    sweep theory), subtracts the induced velocity of the lifting line, and
 *    applies the section forces of sectionAero.ts at its centre of pressure.
 *  - Circulation builds up with a lag of order chord / airspeed; the tail feels
 *    the wing's circulation from one wake-transport time ago (that delay is the
 *    physical Cmα̇), and sits in the wing's separated wake when it passes
 *    through it (Silverstein–Katzoff).
 *  - Strakes add vortex lift by the Polhamus suction analogy, lost as vortex
 *    breakdown moves up the strake — earlier on the windward side in sideslip.
 *  - Slender bodies take a potential normal force from their area growth and a
 *    viscous crossflow force (Allen & Perkins), each section with its own ω × r.
 *  - Gear legs and speedbrakes are drag areas at their own positions.
 *
 * The slow states — separation, circulation, induced velocity, wake, vortex
 * breakdown — advance once per step in {@link Fm3Aero.advance}; within an
 * integration step {@link Fm3Aero.evaluate} holds them fixed.
 *
 * Internally everything is sim body axes relative to the CG (see frames.ts);
 * {@link Fm3Aero.coefficients} reports NASA-axis coefficients for validation.
 */
import { ForceVectorKind, ForceVectorSample } from '../model/flightModel';
import { nasaToSim, simToNasa, Vec3 } from './frames';
import { CHANNEL_INDEX, Fm3Airframe, Fm3Channel, FM3_CHANNELS, Fm3LiftingSurface } from './fm3Airframe';
import { HorseshoeSet, InfluenceTable, WAKE_ALPHAS, WAKE_BETAS } from './liftingLine';
import {
    advanceSeparation, flapDeflectionEfficiency, flapEffectiveness, isForwardFlow, SectionForces, sectionForces,
    SectionModifiers, SectionParams, separationTarget, staticSeparation,
} from './sectionAero';

/**
 * Separation angle gained per radian of leading-edge droop: half the droop.
 * Much less and the F-16's outer panels stall at its 25° AoA limit, where the
 * reference tables still show full roll damping (Clp), and a rolling pull
 * overshoots the limiter. The lift this adds is taken back in calibration,
 * which fits TP-1538 with the flaps on their schedule (tools/fm3/calibrate.ts).
 */
const LEF_SEP_GAIN = 0.5;
/** Zero-lift angle shift per radian of leading-edge droop. */
const LEF_ALPHA0_GAIN = 0.1;
const LEF_CD_GAIN = 0.1;
/** Flaps add camber; the separation angle (measured past zero lift) grows by this share of it. */
const FLAP_SEP_GAIN = 0.7;
const FLAP_CD_GAIN = 1.2;
/** Low-pass on each strip's α̇ estimate (s). */
const ALPHA_RATE_TAU_S = 0.03;
/** Wing circulation history kept for the tail's downwash delay. */
const GAMMA_HISTORY = 96;
/**
 * Spanwise smoothing of circulation between neighbouring strips, scaled by how
 * separated they are. A lifting line past stall has more than one solution —
 * neighbouring strips can settle on opposite sides of the lift peak, each
 * propping the other up with the vortex shed between them — and nothing in
 * real separated flow keeps a jump that sharp. Attached flow is left alone.
 */
const SEPARATED_GAMMA_SMOOTHING = 0.2;
/** Wake-angle change (rad) below which the interpolated influences are reused. */
const INFLUENCE_REUSE_RAD = 0.25 * Math.PI / 180;

/** Everything the aerodynamics needs that isn't the rigid-body state. */
export interface AeroEnvironment {
    rho: number;
    soundSpeed: number;
    /** CG height above the ground (m), for ground effect. */
    heightAboveGround: number;
    /** Landing gear extension, 0..1. */
    gearDown: number;
}

export interface NasaCoefficients {
    CX: number; CY: number; CZ: number;
    Cl: number; Cm: number; Cn: number;
    CL: number; CD: number;
}

export interface StaticCondition {
    alpha: number;
    beta?: number;
    speed?: number;
    rho?: number;
    soundSpeed?: number;
    /** NASA body rates (rad/s). */
    p?: number; q?: number; r?: number;
    heightAboveGround?: number;
    gearDown?: number;
    controls?: Partial<Record<Fm3Channel, number>>;
}

interface StripDef {
    group: number;
    role: number;
    /** +1 as defined (starboard for mirrored surfaces), −1 for the mirror copy. */
    side: number;
    vortexFromStrakes: boolean;
    a: Vec3; b: Vec3; p: Vec3; n: Vec3; f: Vec3; s: Vec3; te: Vec3;
    /** Mirror-image nodes in a root endplate, when the surface has one. */
    imageA?: Vec3; imageB?: Vec3;
    chordN: number; ds: number; section: SectionParams; qFactor: number;
    allMovingCh: number; allMovingGain: number;
    flapCh: number; flapTau: number; flapGain: number; flapCf: number;
    lefCh: number; lefGain: number;
    /** NASA y of the control point, for pairing tail strips with the wing ahead. */
    lateral: number;
    /** NASA x of the control point. */
    longitudinal: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.sqrt(dot(a, a));
const normalize = (a: Vec3): Vec3 => scale(a, 1 / length(a));
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
const mirrorY = (a: Vec3): Vec3 => [a[0], -a[1], a[2]];

/** Rodrigues rotation of v about unit axis k by angle θ. */
function rotateAbout(v: Vec3, k: Vec3, theta: number): Vec3 {
    const c = Math.cos(theta), s = Math.sin(theta);
    const kv = cross(k, v);
    const kdv = dot(k, v);
    return [
        v[0] * c + kv[0] * s + k[0] * kdv * (1 - c),
        v[1] * c + kv[1] * s + k[1] * kdv * (1 - c),
        v[2] * c + kv[2] * s + k[2] * kdv * (1 - c),
    ];
}

/** Jorgensen's crossflow factor η against body fineness ratio. */
function crossflowEta(fineness: number): number {
    const table: [number, number][] = [[2, 0.56], [4, 0.6], [8, 0.66], [12, 0.7], [20, 0.75], [40, 0.82]];
    if (fineness <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (fineness <= table[i][0]) {
            const t = (fineness - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
            return table[i - 1][1] + t * (table[i][1] - table[i - 1][1]);
        }
    }
    return table[table.length - 1][1];
}

/** Transonic drag rise of a section (Korn's drag divergence, Lock's fourth-power rise). */
function sectionWaveDrag(mach: number, thickness: number): number {
    const mcrit = 0.87 - thickness - 0.108;
    if (mach <= mcrit) return 0;
    const peak = 1.05;
    const excess = (mach < peak ? mach : peak) - mcrit;
    const rise = 20 * excess * excess * excess * excess;
    if (mach <= peak) return rise;
    // Supersonic: decays towards thin-airfoil wave drag 4(t/c)²/√(M²−1).
    const linear = 4 * thickness * thickness / Math.sqrt(mach * mach - 1);
    const linearAtPeak = 4 * thickness * thickness / Math.sqrt(peak * peak - 1);
    return rise * (linear / linearAtPeak);
}

function interpolateTable(table: [number, number][], x: number): number {
    if (table.length === 0) return 0;
    if (x <= table[0][0]) return table[0][1];
    for (let i = 1; i < table.length; i++) {
        if (x <= table[i][0]) {
            const t = (x - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
            return table[i - 1][1] + t * (table[i][1] - table[i - 1][1]);
        }
    }
    return table[table.length - 1][1];
}

export class Fm3Aero {
    readonly airframe: Fm3Airframe;
    /** Surface deflections by channel (rad), see {@link CHANNEL_INDEX}. */
    readonly controls = new Float64Array(FM3_CHANNELS.length);

    /** Force-vector groups, in order. */
    readonly groupNames: string[] = [];

    // ---- Strips (wing strips first) ----
    readonly stripCount: number;
    readonly wingStripCount: number;
    private readonly px: Float64Array; private readonly py: Float64Array; private readonly pz: Float64Array;
    private readonly nx: Float64Array; private readonly ny: Float64Array; private readonly nz: Float64Array;
    private readonly fx: Float64Array; private readonly fy: Float64Array; private readonly fz: Float64Array;
    private readonly sx: Float64Array; private readonly sy: Float64Array; private readonly sz: Float64Array;
    private readonly tex: Float64Array; private readonly tey: Float64Array; private readonly tez: Float64Array;
    private readonly chordN: Float64Array;
    private readonly stripArea: Float64Array;
    private readonly qFactor: Float64Array;
    private readonly sections: SectionParams[];
    private readonly stripGroup: Uint8Array;
    private readonly allMovingCh: Int8Array; private readonly allMovingGain: Float64Array;
    private readonly flapCh: Int8Array; private readonly flapTau: Float64Array;
    private readonly flapGain: Float64Array; private readonly flapCf: Float64Array;
    private readonly lefCh: Int8Array; private readonly lefGain: Float64Array;
    /** For tail strips: the wing strip whose wake it may sit in (−1 for wing strips). */
    private readonly wakeSource: Int16Array;
    private readonly influence: InfluenceTable;
    private readonly influenceNow: Float64Array;
    private influenceAlpha = NaN;
    private influenceBeta = NaN;
    /** Mean wing-to-tail distance along the body axis (m). */
    private readonly tailArm: number;
    private readonly neighborI: Int16Array;
    private readonly neighborJ: Int16Array;
    private readonly gammaScratch: Float64Array;
    private readonly stripSide: Int8Array;
    private readonly stripVortexFromStrakes: Uint8Array;
    /** For each strip fed by a strake vortex, that strake's index (−1 otherwise). */
    private readonly stripStrake: Int16Array;

    // Strip states.
    readonly separation: Float64Array;
    readonly circulation: Float64Array;
    readonly inducedVelocity: Float64Array;
    readonly wakeQ: Float64Array;
    private readonly alphaPrev: Float64Array;
    private readonly alphaRate: Float64Array;
    private readonly hasPrev: Uint8Array;
    private readonly gammaHistory: Float64Array;
    private historyHead = 0;
    private historyFilled = 0;
    private readonly gammaEffective: Float64Array;

    // Per-strip results of the last recorded evaluation.
    readonly lastAlpha: Float64Array;
    private readonly lastSpeed: Float64Array;
    private readonly lastMach: Float64Array;
    private readonly lastCl: Float64Array;
    private readonly lastCd: Float64Array;
    private readonly lastDAlpha0: Float64Array;
    private readonly lastDAlphaSep: Float64Array;

    // ---- Strakes ----
    private readonly strakeCount: number;
    private readonly stx: Float64Array; private readonly sty: Float64Array; private readonly stz: Float64Array;
    private readonly stOutX: Float64Array;
    private readonly stArea: Float64Array;
    private readonly stRootChord: Float64Array;
    private readonly stKp: Float64Array; private readonly stKv: Float64Array; private readonly stCd90: Float64Array;
    private readonly stBurstTE: Float64Array; private readonly stBurstApex: Float64Array;
    private readonly stSweepSens: Float64Array;
    private readonly stTau1: Float64Array; private readonly stTau2: Float64Array;
    private readonly stCd0: Float64Array;
    private readonly stAugArea: Float64Array;
    private readonly stAugX: Float64Array; private readonly stAugY: Float64Array; private readonly stAugZ: Float64Array;
    private readonly stGroup: Uint8Array;
    readonly strakeBurst: Float64Array;
    private readonly stAlpha: Float64Array;
    private readonly stAlphaPrev: Float64Array;
    private readonly stRate: Float64Array;
    private readonly stBeta: Float64Array;
    private readonly stSpeed: Float64Array;

    // ---- Body segments ----
    private readonly segCount: number;
    private readonly bx: Float64Array; private readonly by: Float64Array; private readonly bz: Float64Array;
    private readonly segLength: Float64Array;
    private readonly segWidth: Float64Array; private readonly segHeight: Float64Array;
    private readonly segDArea: Float64Array;
    private readonly segCdc: Float64Array;
    private readonly segPotential: Float64Array;
    private readonly segGroup: Uint8Array;

    // ---- Bluff bodies ----
    private readonly bluffCount: number;
    private readonly blx: Float64Array; private readonly bly: Float64Array; private readonly blz: Float64Array;
    private readonly blCdA: Float64Array;
    private readonly blDeploy: Uint8Array;
    private readonly blGroup: Uint8Array;
    private readonly speedbrakeMax: number;

    // ---- Scratch ----
    private readonly mods: SectionModifiers = { dAlpha0: 0, dAlphaSep: 0, dCd0: 0 };
    private readonly sf: SectionForces = { cn: 0, cc: 0, cdProfile: 0, xcp: 0, cm: 0 };
    private readonly scratchF = new Float64Array(3);
    private readonly scratchM = new Float64Array(3);

    // ---- Force-vector recording ----
    private readonly groupF: Float64Array;
    private readonly groupM: Float64Array;
    private readonly groupP: Float64Array;
    private readonly groupW: Float64Array;
    private readonly groupKind: ForceVectorKind[] = [];

    constructor(airframe: Fm3Airframe) {
        this.airframe = airframe;
        const cg = airframe.mass.cg;
        const toSim = (p: Vec3): Vec3 => nasaToSim(sub(p, cg));

        // --- Strips ---
        const strips: StripDef[] = [];
        const addGroup = (name: string, kind: ForceVectorKind = 'lift'): number => {
            this.groupNames.push(name);
            this.groupKind.push(kind);
            return this.groupNames.length - 1;
        };
        const wings = airframe.surfaces.filter(s => s.role === 'wing');
        const tails = airframe.surfaces.filter(s => s.role === 'tail');
        for (const surface of [...wings, ...tails]) {
            buildStrips(surface, addGroup(surface.name), toSim, strips);
        }
        const n = strips.length;
        this.stripCount = n;
        this.wingStripCount = strips.filter(s => s.role === 0).length;
        const f64 = (get: (s: StripDef) => number) => Float64Array.from(strips, get);
        this.px = f64(s => s.p[0]); this.py = f64(s => s.p[1]); this.pz = f64(s => s.p[2]);
        this.nx = f64(s => s.n[0]); this.ny = f64(s => s.n[1]); this.nz = f64(s => s.n[2]);
        this.fx = f64(s => s.f[0]); this.fy = f64(s => s.f[1]); this.fz = f64(s => s.f[2]);
        this.sx = f64(s => s.s[0]); this.sy = f64(s => s.s[1]); this.sz = f64(s => s.s[2]);
        this.tex = f64(s => s.te[0]); this.tey = f64(s => s.te[1]); this.tez = f64(s => s.te[2]);
        this.chordN = f64(s => s.chordN);
        this.stripArea = f64(s => s.chordN * s.ds);
        this.qFactor = f64(s => s.qFactor);
        this.sections = strips.map(s => s.section);
        this.stripGroup = Uint8Array.from(strips, s => s.group);
        this.allMovingCh = Int8Array.from(strips, s => s.allMovingCh);
        this.allMovingGain = f64(s => s.allMovingGain);
        this.flapCh = Int8Array.from(strips, s => s.flapCh);
        this.flapTau = f64(s => s.flapTau);
        this.flapGain = f64(s => s.flapGain);
        this.flapCf = f64(s => s.flapCf);
        this.lefCh = Int8Array.from(strips, s => s.lefCh);
        this.lefGain = f64(s => s.lefGain);

        // Tail strips look for the wing strip at the nearest lateral station on
        // their own side (a centreline fin takes the starboard root).
        const nWing = this.wingStripCount;
        this.wakeSource = new Int16Array(n).fill(-1);
        let wingX = 0, tailX = 0;
        for (let i = 0; i < nWing; i++) wingX += strips[i].longitudinal;
        for (let i = nWing; i < n; i++) {
            tailX += strips[i].longitudinal;
            let best = -1, bestD = Infinity;
            for (let j = 0; j < nWing; j++) {
                if (strips[i].lateral * strips[j].lateral < -1e-6) continue;
                const d = Math.abs(Math.abs(strips[i].lateral) - Math.abs(strips[j].lateral));
                if (d < bestD) { bestD = d; best = j; }
            }
            this.wakeSource[i] = best;
        }
        this.tailArm = nWing > 0 && n > nWing ? Math.max(0.5, wingX / nWing - tailX / (n - nWing)) : 0;

        const set: HorseshoeSet = {
            count: n,
            ax: f64(s => s.a[0]), ay: f64(s => s.a[1]), az: f64(s => s.a[2]),
            bx: f64(s => s.b[0]), by: f64(s => s.b[1]), bz: f64(s => s.b[2]),
            px: this.px, py: this.py, pz: this.pz,
            nx: this.nx, ny: this.ny, nz: this.nz,
            // A small core, only to keep a control point next to a node finite;
            // anything chord-sized would under-predict the induced flow.
            core: f64(s => 0.1 * Math.min(s.chordN, 2 * s.ds)),
            hasImage: Uint8Array.from(strips, s => s.imageA ? 1 : 0),
            iax: f64(s => s.imageA?.[0] ?? 0), iay: f64(s => s.imageA?.[1] ?? 0), iaz: f64(s => s.imageA?.[2] ?? 0),
            ibx: f64(s => s.imageB?.[0] ?? 0), iby: f64(s => s.imageB?.[1] ?? 0), ibz: f64(s => s.imageB?.[2] ?? 0),
        };
        this.influence = new InfluenceTable(set, WAKE_ALPHAS, WAKE_BETAS);
        this.influenceNow = new Float64Array(n * n);

        // Neighbouring strips share a node of the lifting line.
        const pairs: [number, number][] = [];
        const same = (p: Vec3, q: Vec3) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-6;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const si = strips[i], sj = strips[j];
                if (same(si.a, sj.a) || same(si.a, sj.b) || same(si.b, sj.a) || same(si.b, sj.b)) pairs.push([i, j]);
            }
        }
        this.neighborI = Int16Array.from(pairs, p => p[0]);
        this.neighborJ = Int16Array.from(pairs, p => p[1]);
        this.gammaScratch = new Float64Array(n);
        this.stripSide = Int8Array.from(strips, s => s.side);
        this.stripVortexFromStrakes = Uint8Array.from(strips, s => s.vortexFromStrakes ? 1 : 0);

        this.separation = new Float64Array(n);
        this.circulation = new Float64Array(n);
        this.inducedVelocity = new Float64Array(n);
        this.wakeQ = new Float64Array(n);
        this.alphaPrev = new Float64Array(n);
        this.alphaRate = new Float64Array(n);
        this.hasPrev = new Uint8Array(n);
        this.gammaHistory = new Float64Array(GAMMA_HISTORY * Math.max(1, nWing));
        this.gammaEffective = new Float64Array(n);
        this.lastAlpha = new Float64Array(n);
        this.lastSpeed = new Float64Array(n);
        this.lastMach = new Float64Array(n);
        this.lastCl = new Float64Array(n);
        this.lastCd = new Float64Array(n);
        this.lastDAlpha0 = new Float64Array(n);
        this.lastDAlphaSep = new Float64Array(n);

        // --- Strakes ---
        const strakes: { c: Vec3; aug: Vec3; outX: number; area: number; cr: number; kp: number; kv: number; st: typeof airframe.strakes[0]; group: number }[] = [];
        for (const st of airframe.strakes) {
            const group = addGroup(st.name);
            for (const side of st.mirror ? [1, -1] : [1]) {
                const centroidN: Vec3 = [st.apex[0] - (2 / 3) * st.rootChord, side * (Math.abs(st.apex[1]) + st.span / 3), st.apex[2]];
                const augmentedN: Vec3 = [st.augmentedX ?? st.apex[0] - st.rootChord, side * (Math.abs(st.apex[1]) + st.span), st.apex[2]];
                const aspect = 4 * st.span / st.rootChord;
                strakes.push({
                    c: toSim(centroidN),
                    aug: toSim(augmentedN),
                    outX: nasaToSim([0, side, 0])[0],
                    area: 0.5 * st.rootChord * st.span,
                    cr: st.rootChord,
                    kp: st.kPotential ?? Math.PI * aspect / 2,
                    kv: st.kVortex ?? Math.PI,
                    st, group,
                });
            }
        }
        const sk = strakes.length;
        this.strakeCount = sk;
        const s64 = (get: (s: typeof strakes[0]) => number) => Float64Array.from(strakes, get);
        this.stx = s64(s => s.c[0]); this.sty = s64(s => s.c[1]); this.stz = s64(s => s.c[2]);
        this.stOutX = s64(s => s.outX);
        this.stArea = s64(s => s.area);
        this.stRootChord = s64(s => s.cr);
        this.stKp = s64(s => s.kp); this.stKv = s64(s => s.kv); this.stCd90 = s64(s => s.st.cd90);
        this.stBurstTE = s64(s => s.st.burstTrailingEdge);
        this.stBurstApex = s64(s => s.st.burstApex);
        this.stSweepSens = s64(s => s.st.burstSweepSensitivity);
        this.stTau1 = s64(s => s.st.burstTau1);
        this.stTau2 = s64(s => s.st.burstTau2);
        this.stCd0 = s64(s => s.st.cd0);
        this.stAugArea = s64(s => s.st.augmentedArea ?? 0);
        this.stAugX = s64(s => s.aug[0]); this.stAugY = s64(s => s.aug[1]); this.stAugZ = s64(s => s.aug[2]);
        this.stGroup = Uint8Array.from(strakes, s => s.group);
        this.strakeBurst = new Float64Array(sk).fill(1);
        const strakeSides = strakes.map(s => Math.sign(this.stOutXSign(s.outX)));
        this.stripStrake = new Int16Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            if (!this.stripVortexFromStrakes[i]) continue;
            this.stripStrake[i] = strakeSides.findIndex(side => side === this.stripSide[i]);
        }
        this.stAlpha = new Float64Array(sk);
        this.stAlphaPrev = new Float64Array(sk);
        this.stRate = new Float64Array(sk);
        this.stBeta = new Float64Array(sk);
        this.stSpeed = new Float64Array(sk);

        // --- Bodies ---
        const segs: { r: Vec3; len: number; w: number; h: number; dA: number; cdc: number; pot: number; group: number }[] = [];
        for (const body of airframe.bodies) {
            const group = addGroup(body.name);
            const st = body.stations;
            const length = st[0][0] - st[st.length - 1][0];
            const maxD = Math.max(...st.map(s => Math.sqrt(s[2] * s[3])));
            const eta = crossflowEta(length / Math.max(maxD, 1e-3));
            for (let k = 0; k + 1 < st.length; k++) {
                const [x0, z0, w0, h0] = st[k];
                const [x1, z1, w1, h1] = st[k + 1];
                segs.push({
                    r: toSim([(x0 + x1) / 2, 0, (z0 + z1) / 2]),
                    len: x0 - x1,
                    w: (w0 + w1) / 2,
                    h: (h0 + h1) / 2,
                    dA: Math.PI * (w1 * h1 - w0 * h0) / 4,
                    cdc: body.crossflowCd * eta,
                    pot: body.potentialFactor ?? 1,
                    group,
                });
            }
        }
        this.segCount = segs.length;
        const g64 = (get: (s: typeof segs[0]) => number) => Float64Array.from(segs, get);
        this.bx = g64(s => s.r[0]); this.by = g64(s => s.r[1]); this.bz = g64(s => s.r[2]);
        this.segLength = g64(s => s.len);
        this.segWidth = g64(s => s.w); this.segHeight = g64(s => s.h);
        this.segDArea = g64(s => s.dA);
        this.segCdc = g64(s => s.cdc);
        this.segPotential = g64(s => s.pot);
        this.segGroup = Uint8Array.from(segs, s => s.group);

        // --- Bluff bodies ---
        const bluffGroups = new Map<string, number>();
        const bluff = airframe.bluffBodies.map(b => {
            const key = b.deploy === 'always' ? 'drag' : b.deploy;
            if (!bluffGroups.has(key)) bluffGroups.set(key, addGroup(key, 'drag'));
            return { r: toSim(b.position), cdA: b.cdA, deploy: b.deploy === 'gear' ? 1 : b.deploy === 'speedbrake' ? 2 : 0, group: bluffGroups.get(key)! };
        });
        this.bluffCount = bluff.length;
        this.blx = Float64Array.from(bluff, b => b.r[0]);
        this.bly = Float64Array.from(bluff, b => b.r[1]);
        this.blz = Float64Array.from(bluff, b => b.r[2]);
        this.blCdA = Float64Array.from(bluff, b => b.cdA);
        this.blDeploy = Uint8Array.from(bluff, b => b.deploy);
        this.blGroup = Uint8Array.from(bluff, b => b.group);
        const sbActuator = airframe.actuators.find(a => a.channel === 'speedbrake');
        this.speedbrakeMax = sbActuator && sbActuator.max > 0 ? sbActuator.max : 1;

        const groups = this.groupNames.length;
        this.groupF = new Float64Array(groups * 3);
        this.groupM = new Float64Array(groups * 3);
        this.groupP = new Float64Array(groups * 3);
        this.groupW = new Float64Array(groups);

        this.reset();
    }

    /** Side (+1 starboard, −1 port) of a strake from its outboard sim-X direction (starboard is −X). */
    private stOutXSign(outX: number): number {
        return outX < 0 ? 1 : -1;
    }

    /** Attached flow, no circulation: the state of an aircraft that has not flown yet. */
    reset(): void {
        this.separation.fill(1);
        this.circulation.fill(0);
        this.inducedVelocity.fill(0);
        this.wakeQ.fill(1);
        this.alphaPrev.fill(0);
        this.alphaRate.fill(0);
        this.hasPrev.fill(0);
        this.gammaHistory.fill(0);
        this.historyHead = 0;
        this.historyFilled = 0;
        this.gammaEffective.fill(0);
        this.strakeBurst.fill(1);
        this.stAlphaPrev.fill(0);
        this.stRate.fill(0);
    }

    /**
     * Aerodynamic force and moment about the CG, sim body axes, for the CG
     * moving at (vx, vy, vz) through the air with body rates (wx, wy, wz). Slow
     * states are read, never written, unless `record` is set — then per-strip
     * results are kept for {@link advance} and the force-vector overlay.
     */
    evaluate(
        vx: number, vy: number, vz: number, wx: number, wy: number, wz: number,
        env: AeroEnvironment, force: Float64Array, moment: Float64Array, record: boolean,
    ): void {
        let Fx = 0, Fy = 0, Fz = 0, Mx = 0, My = 0, Mz = 0;
        const rho = env.rho;
        const a = env.soundSpeed > 1 ? env.soundSpeed : 340;
        const ctl = this.controls;
        const mods = this.mods;
        const sf = this.sf;
        if (record) {
            this.groupF.fill(0);
            this.groupM.fill(0);
            this.groupP.fill(0);
            this.groupW.fill(0);
        }

        // ---- Lifting strips ----
        for (let i = 0; i < this.stripCount; i++) {
            const rx = this.px[i], ry = this.py[i], rz = this.pz[i];
            const nxi = this.nx[i], nyi = this.ny[i], nzi = this.nz[i];
            const w = this.inducedVelocity[i];
            const ux = vx + (wy * rz - wz * ry) - w * nxi;
            const uy = vy + (wz * rx - wx * rz) - w * nyi;
            const uz = vz + (wx * ry - wy * rx) - w * nzi;
            const sxi = this.sx[i], syi = this.sy[i], szi = this.sz[i];
            const us = ux * sxi + uy * syi + uz * szi;
            const unx = ux - us * sxi, uny = uy - us * syi, unz = uz - us * szi;
            const un2 = unx * unx + uny * uny + unz * unz;
            if (un2 < 1e-4) {
                if (record) { this.lastSpeed[i] = 0; this.lastCl[i] = 0; this.lastCd[i] = 0; }
                continue;
            }
            const un = Math.sqrt(un2);
            const cfx = this.fx[i], cfy = this.fy[i], cfz = this.fz[i];
            let alpha = Math.atan2(-(unx * nxi + uny * nyi + unz * nzi), unx * cfx + uny * cfy + unz * cfz);

            let cnx = nxi, cny = nyi, cnz = nzi, ccx = cfx, ccy = cfy, ccz = cfz;
            const amc = this.allMovingCh[i];
            if (amc >= 0) {
                const d = ctl[amc] * this.allMovingGain[i];
                if (d !== 0) {
                    // Deflecting an all-moving surface rotates its chord nose-up by d.
                    alpha += d;
                    const cd = Math.cos(d), sd = Math.sin(d);
                    ccx = cfx * cd + nxi * sd; ccy = cfy * cd + nyi * sd; ccz = cfz * cd + nzi * sd;
                    cnx = nxi * cd - cfx * sd; cny = nyi * cd - cfy * sd; cnz = nzi * cd - cfz * sd;
                    if (alpha > Math.PI) alpha -= 2 * Math.PI;
                    else if (alpha <= -Math.PI) alpha += 2 * Math.PI;
                }
            }

            let dA0 = 0, dSep = 0, dCd = 0;
            const flc = this.flapCh[i];
            if (flc >= 0) {
                const d = ctl[flc] * this.flapGain[i];
                if (d !== 0) {
                    const shift = this.flapTau[i] * flapDeflectionEfficiency(d) * d;
                    dA0 -= shift;
                    dSep += FLAP_SEP_GAIN * shift;
                    const s = Math.sin(d);
                    dCd += FLAP_CD_GAIN * this.flapCf[i] * s * s;
                }
            }
            const lc = this.lefCh[i];
            if (lc >= 0) {
                const d = ctl[lc] * this.lefGain[i];
                if (d !== 0) {
                    dSep += LEF_SEP_GAIN * d;
                    dA0 -= LEF_ALPHA0_GAIN * d;
                    const s = Math.sin(d);
                    dCd += LEF_CD_GAIN * s * s;
                }
            }
            const section = this.sections[i];
            const mach = un / a;
            dCd += sectionWaveDrag(mach, section.thickness);
            mods.dAlpha0 = dA0;
            mods.dAlphaSep = dSep;
            mods.dCd0 = dCd;
            const strake = this.stripStrake[i];
            mods.vortexScale = strake >= 0 ? this.strakeBurst[strake] : 1;
            sectionForces(alpha, this.separation[i], section, mods, mach, sf);

            const qa = 0.5 * rho * un2 * this.qFactor[i] * this.wakeQ[i] * this.stripArea[i];
            const drag = sf.cdProfile / un;
            const fxs = qa * (sf.cn * cnx + sf.cc * ccx - drag * unx);
            const fys = qa * (sf.cn * cny + sf.cc * ccy - drag * uny);
            const fzs = qa * (sf.cn * cnz + sf.cc * ccz - drag * unz);
            // Centre of pressure along the (deflected) chord.
            const off = (0.25 - sf.xcp) * this.chordN[i];
            const ax = rx + off * ccx, ay = ry + off * ccy, az = rz + off * ccz;
            Fx += fxs; Fy += fys; Fz += fzs;
            Mx += ay * fzs - az * fys;
            My += az * fxs - ax * fzs;
            Mz += ax * fys - ay * fxs;
            if (sf.cm !== 0) {
                // Couple about the span axis, nose-up positive: axis = chord × normal.
                const c = qa * this.chordN[i] * sf.cm;
                Mx += c * (ccy * cnz - ccz * cny);
                My += c * (ccz * cnx - ccx * cnz);
                Mz += c * (ccx * cny - ccy * cnx);
            }

            if (record) {
                this.lastAlpha[i] = alpha;
                this.lastSpeed[i] = un;
                this.lastMach[i] = mach;
                this.lastDAlpha0[i] = dA0;
                this.lastDAlphaSep[i] = dSep;
                const ca = Math.cos(alpha), sa = Math.sin(alpha);
                this.lastCl[i] = sf.cn * ca + sf.cc * sa;
                this.lastCd[i] = sf.cn * sa - sf.cc * ca + sf.cdProfile;
                this.recordGroup(this.stripGroup[i], fxs, fys, fzs, ax, ay, az);
            }
        }

        // ---- Strakes: Polhamus suction analogy ----
        for (let k = 0; k < this.strakeCount; k++) {
            const rx = this.stx[k], ry = this.sty[k], rz = this.stz[k];
            const ux = vx + (wy * rz - wz * ry);
            const uy = vy + (wz * rx - wx * rz);
            const uz = vz + (wx * ry - wy * rx);
            const v2 = ux * ux + uy * uy + uz * uz;
            if (v2 < 1e-4) continue;
            const v = Math.sqrt(v2);
            // Strake plane: normal +Y (up), chord +Z (forward), outboard ±X.
            const alpha = Math.atan2(-uy, uz);
            const sa = Math.sin(alpha), ca = Math.cos(alpha);
            const absSa = sa < 0 ? -sa : sa;
            let cn: number;
            if (ca >= 0) {
                const b = this.strakeBurst[k];
                cn = this.stKp[k] * sa * ca + (b * this.stKv[k] + (1 - b) * this.stCd90[k]) * sa * absSa;
            } else {
                cn = this.stCd90[k] * sa * absSa;
            }
            const q = 0.5 * rho * v2;
            const qa = q * this.stArea[k];
            const drag = this.stCd0[k] / v;
            const fxs = qa * (-drag * ux);
            const fys = qa * (cn - drag * uy);
            const fzs = qa * (-drag * uz);
            Fx += fxs; Fy += fys; Fz += fzs;
            Mx += ry * fzs - rz * fys;
            My += rz * fxs - rx * fzs;
            Mz += rx * fys - ry * fxs;
            // Augmented vortex lift on the wing under the vortex, while it lasts.
            let augF = 0;
            if (ca >= 0 && this.stAugArea[k] > 0) {
                augF = q * this.stAugArea[k] * this.stKv[k] * sa * absSa * this.strakeBurst[k];
                const ax = this.stAugX[k], az = this.stAugZ[k];
                Fy += augF;
                Mx += -az * augF;
                Mz += ax * augF;
            }
            if (record) {
                this.stAlpha[k] = alpha;
                this.stSpeed[k] = v;
                const sb = (ux * this.stOutX[k]) / v;
                this.stBeta[k] = Math.asin(sb > 1 ? 1 : sb < -1 ? -1 : sb);
                this.recordGroup(this.stGroup[k], fxs, fys, fzs, rx, ry, rz);
                if (augF !== 0) this.recordGroup(this.stGroup[k], 0, augF, 0, this.stAugX[k], this.stAugY[k], this.stAugZ[k]);
            }
        }

        // ---- Slender bodies ----
        for (let k = 0; k < this.segCount; k++) {
            const rx = this.bx[k], ry = this.by[k], rz = this.bz[k];
            const ux = vx + (wy * rz - wz * ry);
            const uy = vy + (wz * rx - wx * rz);
            const ua = vz + (wx * ry - wy * rx);
            const uc2 = ux * ux + uy * uy;
            if (uc2 < 1e-6) continue;
            const uc = Math.sqrt(uc2);
            const ex = ux / uc, ey = uy / uc;
            // Potential flow: ρ·u_axial·u_cross·dS (slender-body theory), with
            // Jorgensen's cos(α/2) for high incidence; α here runs 0..π.
            const alphaB = Math.atan2(uc, ua);
            const nPot = rho * ua * uc * this.segDArea[k] * this.segPotential[k] * Math.cos(0.5 * alphaB);
            // Viscous crossflow on the projected width of the elliptical section.
            const halfW = 0.5 * this.segWidth[k], halfH = 0.5 * this.segHeight[k];
            const proj = 2 * Math.sqrt(halfW * halfW * ey * ey + halfH * halfH * ex * ex);
            const nVisc = 0.5 * rho * uc2 * proj * this.segCdc[k] * this.segLength[k];
            const nTotal = nPot + nVisc;
            const fxs = -ex * nTotal, fys = -ey * nTotal;
            Fx += fxs; Fy += fys;
            Mx += -rz * fys;
            My += rz * fxs;
            Mz += rx * fys - ry * fxs;
            if (record) this.recordGroup(this.segGroup[k], fxs, fys, 0, rx, ry, rz);
        }

        // ---- Bluff bodies (gear legs, speedbrakes) ----
        for (let k = 0; k < this.bluffCount; k++) {
            const mode = this.blDeploy[k];
            const deploy = mode === 1 ? env.gearDown
                : mode === 2 ? ctl[CHANNEL_INDEX.speedbrake] / this.speedbrakeMax
                    : 1;
            if (deploy <= 0) continue;
            const rx = this.blx[k], ry = this.bly[k], rz = this.blz[k];
            const ux = vx + (wy * rz - wz * ry);
            const uy = vy + (wz * rx - wx * rz);
            const uz = vz + (wx * ry - wy * rx);
            const v = Math.sqrt(ux * ux + uy * uy + uz * uz);
            const k2 = -0.5 * rho * v * this.blCdA[k] * deploy;
            const fxs = k2 * ux, fys = k2 * uy, fzs = k2 * uz;
            Fx += fxs; Fy += fys; Fz += fzs;
            Mx += ry * fzs - rz * fys;
            My += rz * fxs - rx * fzs;
            Mz += rx * fys - ry * fxs;
            if (record) this.recordGroup(this.blGroup[k], fxs, fys, fzs, rx, ry, rz);
        }

        // ---- Lumped parasite and wave drag, through the CG ----
        const v2 = vx * vx + vy * vy + vz * vz;
        if (v2 > 1e-4) {
            const v = Math.sqrt(v2);
            const cd = this.airframe.miscCd0 + interpolateTable(this.airframe.bodyWaveDrag, v / a);
            const k2 = -0.5 * rho * v * cd * this.airframe.reference.areaM2;
            Fx += k2 * vx; Fy += k2 * vy; Fz += k2 * vz;
        }

        force[0] = Fx; force[1] = Fy; force[2] = Fz;
        moment[0] = Mx; moment[1] = My; moment[2] = Mz;
    }

    private recordGroup(g: number, fx: number, fy: number, fz: number, x: number, y: number, z: number): void {
        const o = g * 3;
        this.groupF[o] += fx; this.groupF[o + 1] += fy; this.groupF[o + 2] += fz;
        this.groupM[o] += y * fz - z * fy;
        this.groupM[o + 1] += z * fx - x * fz;
        this.groupM[o + 2] += x * fy - y * fx;
        const w = Math.sqrt(fx * fx + fy * fy + fz * fz);
        this.groupP[o] += w * x; this.groupP[o + 1] += w * y; this.groupP[o + 2] += w * z;
        this.groupW[g] += w;
    }

    /**
     * Advance the slow aerodynamic states by `dt` from the current flight
     * condition: separation (Goman–Khrabrov), circulation, induced velocity
     * with the tail's downwash delay, wake blanketing and vortex breakdown.
     */
    advance(
        dt: number, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number,
        env: AeroEnvironment,
    ): void {
        this.evaluate(vx, vy, vz, wx, wy, wz, env, this.scratchF, this.scratchM, true);
        const rateBlend = 1 - Math.exp(-dt / ALPHA_RATE_TAU_S);
        const mods = this.mods;
        const n = this.stripCount;
        this.interpolateInfluence(vx, vy, vz);

        for (let i = 0; i < n; i++) {
            const speed = this.lastSpeed[i];
            if (speed <= 0) continue;
            const alpha = this.lastAlpha[i];
            let d = alpha - this.alphaPrev[i];
            if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
            const raw = this.hasPrev[i] ? d / dt : 0;
            this.alphaPrev[i] = alpha;
            this.hasPrev[i] = 1;
            this.alphaRate[i] += (raw - this.alphaRate[i]) * rateBlend;

            const section = this.sections[i];
            const a0 = section.alpha0 + this.lastDAlpha0[i];
            const rate = this.alphaRate[i];
            const regimeRate = isForwardFlow(alpha)
                ? (alpha >= a0 ? rate : -rate)
                : (alpha >= 0 ? -rate : rate);
            mods.dAlpha0 = this.lastDAlpha0[i];
            mods.dAlphaSep = this.lastDAlphaSep[i];
            mods.dCd0 = 0;
            const chord = this.chordN[i];
            const target = separationTarget(alpha, regimeRate, speed, chord, section, mods, this.lastMach[i]);
            this.separation[i] = advanceSeparation(this.separation[i], target, dt, speed, chord, section.tau1);

            this.relaxCirculation(i, speed, 1 - Math.exp(-dt * Math.max(speed, 5) / (this.airframe.wakeTau * chord)));
        }
        this.smoothSeparatedCirculation();

        this.pushHistory();
        this.updateInducedVelocity(vx, vy, vz, env, true);
        this.updateWake(vx, vy, vz);
        this.advanceStrakes(dt, false);
    }

    /**
     * Put the slow states at the steady solution for the current condition —
     * separation on its static curve, circulation converged, no delay — as a
     * wind tunnel would see it, or for an airborne spawn.
     */
    settle(
        vx: number, vy: number, vz: number, wx: number, wy: number, wz: number,
        env: AeroEnvironment, iterations = 80,
    ): void {
        const mods = this.mods;
        for (let it = 0; it < iterations; it++) {
            this.evaluate(vx, vy, vz, wx, wy, wz, env, this.scratchF, this.scratchM, true);
            this.interpolateInfluence(vx, vy, vz);
            for (let i = 0; i < this.stripCount; i++) {
                const speed = this.lastSpeed[i];
                if (speed <= 0) continue;
                mods.dAlpha0 = this.lastDAlpha0[i];
                mods.dAlphaSep = this.lastDAlphaSep[i];
                mods.dCd0 = 0;
                const target = separationTarget(this.lastAlpha[i], 0, speed, this.chordN[i], this.sections[i], mods, this.lastMach[i]);
                this.separation[i] = target;
                this.relaxCirculation(i, speed, 0.5);
            }
            this.smoothSeparatedCirculation();
            this.updateInducedVelocity(vx, vy, vz, env, false);
            this.updateWake(vx, vy, vz);
            this.advanceStrakes(0, true);
        }
        for (let i = 0; i < this.stripCount; i++) {
            this.alphaPrev[i] = this.lastAlpha[i];
            this.alphaRate[i] = 0;
            this.hasPrev[i] = 1;
        }
        const nWing = this.wingStripCount;
        for (let h = 0; h < GAMMA_HISTORY; h++) {
            for (let j = 0; j < nWing; j++) this.gammaHistory[h * nWing + j] = this.circulation[j];
        }
        this.historyFilled = GAMMA_HISTORY;
        for (let k = 0; k < this.strakeCount; k++) {
            this.stAlphaPrev[k] = this.stAlpha[k];
            this.stRate[k] = 0;
        }
    }

    private interpolateInfluence(vx: number, vy: number, vz: number): void {
        const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
        let alpha = 0, beta = 0;
        if (v > 1) {
            alpha = Math.atan2(-vy, vz);
            const sb = -vx / v;
            beta = Math.asin(sb > 1 ? 1 : sb < -1 ? -1 : sb);
        }
        // The influences change slowly with the wake's direction; re-blending
        // the tables every step while it has hardly moved is most of the cost.
        if (Math.abs(alpha - this.influenceAlpha) < INFLUENCE_REUSE_RAD && Math.abs(beta - this.influenceBeta) < INFLUENCE_REUSE_RAD) {
            return;
        }
        this.influenceAlpha = alpha;
        this.influenceBeta = beta;
        this.influence.interpolate(alpha, beta, this.influenceNow);
    }

    /**
     * Relax one strip's circulation towards Kutta–Joukowski's ½·V·c·C_L. The
     * strip's own trailing legs react against any change within the step, so
     * the update treats that self-influence implicitly — without it, the narrow
     * tip strips of a fast aircraft overshoot and ring.
     */
    private relaxCirculation(i: number, speed: number, lambda: number): void {
        const target = 0.5 * speed * this.chordN[i] * this.lastCl[i] * this.qFactor[i] * this.wakeQ[i];
        const self = Math.abs(this.influenceNow[i * this.stripCount + i]);
        const k = 0.5 * this.chordN[i] * this.sections[i].cnAlpha * self;
        this.circulation[i] += lambda * (target - this.circulation[i]) / (1 + lambda * k);
    }

    private smoothSeparatedCirculation(): void {
        const g = this.circulation;
        const next = this.gammaScratch;
        next.set(g);
        for (let k = 0; k < this.neighborI.length; k++) {
            const i = this.neighborI[k], j = this.neighborJ[k];
            const separated = 1 - Math.min(this.separation[i], this.separation[j]);
            if (separated <= 0) continue;
            const d = SEPARATED_GAMMA_SMOOTHING * separated * (g[j] - g[i]);
            next[i] += d;
            next[j] -= d;
        }
        g.set(next);
    }

    private pushHistory(): void {
        const nWing = this.wingStripCount;
        if (nWing === 0) return;
        this.historyHead = (this.historyHead + 1) % GAMMA_HISTORY;
        const o = this.historyHead * nWing;
        for (let j = 0; j < nWing; j++) this.gammaHistory[o + j] = this.circulation[j];
        if (this.historyFilled < GAMMA_HISTORY) this.historyFilled++;
    }

    private updateInducedVelocity(vx: number, vy: number, vz: number, env: AeroEnvironment, delayed: boolean): void {
        const n = this.stripCount;
        const nWing = this.wingStripCount;
        const gEff = this.gammaEffective;
        for (let j = 0; j < n; j++) gEff[j] = this.circulation[j];

        // The tail sees the wing's circulation from one wake-transport time ago.
        let delaySteps = 0;
        if (delayed && nWing > 0 && n > nWing) {
            const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
            delaySteps = Math.min(this.historyFilled - 1, GAMMA_HISTORY - 1, this.tailArm / Math.max(v, 1) * 120);
            if (delaySteps < 0) delaySteps = 0;
        }

        // Ground effect: the image vortex system cancels part of the induced flow (McCormick).
        const hb = 16 * env.heightAboveGround / this.airframe.reference.spanM;
        const sigma = Number.isFinite(hb) ? (hb * hb) / (1 + hb * hb) : 1;

        const A = this.influenceNow;
        if (delaySteps > 0) {
            const lo = Math.floor(delaySteps);
            const t = delaySteps - lo;
            const h0 = (this.historyHead - lo + GAMMA_HISTORY) % GAMMA_HISTORY;
            const h1 = (this.historyHead - lo - 1 + GAMMA_HISTORY) % GAMMA_HISTORY;
            for (let i = 0; i < n; i++) {
                let wsum = 0;
                const row = i * n;
                if (i >= nWing) {
                    for (let j = 0; j < nWing; j++) {
                        const g = (1 - t) * this.gammaHistory[h0 * nWing + j] + t * this.gammaHistory[h1 * nWing + j];
                        wsum += A[row + j] * g;
                    }
                } else {
                    for (let j = 0; j < nWing; j++) wsum += A[row + j] * gEff[j];
                }
                for (let j = nWing; j < n; j++) wsum += A[row + j] * gEff[j];
                this.inducedVelocity[i] = sigma * wsum;
            }
        } else {
            for (let i = 0; i < n; i++) {
                let wsum = 0;
                const row = i * n;
                for (let j = 0; j < n; j++) wsum += A[row + j] * gEff[j];
                this.inducedVelocity[i] = sigma * wsum;
            }
        }
    }

    /** Silverstein–Katzoff wake of the wing strip ahead, over each tail strip (NACA TR-651). */
    private updateWake(vx: number, vy: number, vz: number): void {
        const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
        for (let i = 0; i < this.wingStripCount; i++) this.wakeQ[i] = 1;
        if (v < 1) {
            for (let i = this.wingStripCount; i < this.stripCount; i++) this.wakeQ[i] = 1;
            return;
        }
        const fx = -vx / v, fy = -vy / v, fz = -vz / v;
        for (let i = this.wingStripCount; i < this.stripCount; i++) {
            const j = this.wakeSource[i];
            let q = 1;
            if (j >= 0) {
                // The wake leaves along the freestream, pushed off it by the wing's
                // far-field downwash (twice the downwash at the lifting line).
                let dx = fx, dy = fy, dz = fz;
                const eps = Math.min(0.35, 2 * Math.max(0, -this.inducedVelocity[j]) / v);
                if (eps > 0) {
                    const nd = this.nx[j] * fx + this.ny[j] * fy + this.nz[j] * fz;
                    let px = this.nx[j] - nd * fx, py = this.ny[j] - nd * fy, pz = this.nz[j] - nd * fz;
                    const pl = Math.sqrt(px * px + py * py + pz * pz);
                    if (pl > 1e-6) {
                        px /= pl; py /= pl; pz /= pl;
                        dx = fx - eps * px; dy = fy - eps * py; dz = fz - eps * pz;
                        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        dx /= dl; dy /= dl; dz /= dl;
                    }
                }
                const rx = this.px[i] - this.tex[j], ry = this.py[i] - this.tey[j], rz = this.pz[i] - this.tez[j];
                const along = rx * dx + ry * dy + rz * dz;
                if (along > 0) {
                    const px = rx - along * dx, py = ry - along * dy, pz = rz - along * dz;
                    const across = Math.sqrt(px * px + py * py + pz * pz);
                    const c = this.chordN[j];
                    const cd = this.lastCd[j] > 0.005 ? this.lastCd[j] : 0.005;
                    const halfWidth = 0.68 * c * Math.sqrt(cd * (along / c + 0.15));
                    if (across < halfWidth) {
                        const centre = Math.min(0.95, 2.42 * Math.sqrt(cd) / (along / c + 0.3));
                        const shape = Math.cos(0.5 * Math.PI * across / halfWidth);
                        q = 1 - centre * shape * shape;
                    }
                }
            }
            this.wakeQ[i] = q;
        }
    }

    /** Vortex breakdown on the strakes, lagged like separation. */
    private advanceStrakes(dt: number, steady: boolean): void {
        for (let k = 0; k < this.strakeCount; k++) {
            const speed = this.stSpeed[k];
            if (speed <= 0) continue;
            const alpha = this.stAlpha[k];
            const absAlpha = Math.abs(alpha);
            let rate = 0;
            if (!steady && dt > 0) {
                rate = (absAlpha - Math.abs(this.stAlphaPrev[k])) / dt;
                this.stRate[k] += (rate - this.stRate[k]) * (1 - Math.exp(-dt / ALPHA_RATE_TAU_S));
                rate = this.stRate[k];
            }
            this.stAlphaPrev[k] = alpha;
            const chordTime = this.stRootChord[k] / Math.max(speed, 1);
            const lagged = steady ? absAlpha : absAlpha - this.stTau2[k] * chordTime * rate;
            // Windward (positive outboard sideslip) sees less sweep: breakdown comes earlier.
            const shift = -this.stSweepSens[k] * this.stBeta[k];
            const lo = this.stBurstTE[k] + shift;
            const hi = this.stBurstApex[k] + shift;
            let target: number;
            if (Math.cos(alpha) < 0 || lagged >= hi) target = 0;
            else if (lagged <= lo) target = 1;
            else {
                const t = (lagged - lo) / (hi - lo);
                target = 1 - t * t * (3 - 2 * t);
            }
            if (steady) {
                this.strakeBurst[k] = target;
            } else {
                const tau = this.stTau1[k] * chordTime;
                this.strakeBurst[k] += (target - this.strakeBurst[k]) * (1 - Math.exp(-dt / tau));
            }
        }
    }

    /**
     * Per-group force and moment about the CG from the last recorded
     * evaluation, sim body axes (for diagnostics; the couple of cambered
     * sections is not included).
     */
    groupLoads(): { name: string; force: Vec3; moment: Vec3 }[] {
        return this.groupNames.map((name, g) => ({
            name,
            force: [this.groupF[g * 3], this.groupF[g * 3 + 1], this.groupF[g * 3 + 2]],
            moment: [this.groupM[g * 3], this.groupM[g * 3 + 1], this.groupM[g * 3 + 2]],
        }));
    }

    /** Per-strip state from the last recorded evaluation, for diagnostics. */
    stripDiagnostics(): { group: string; alpha: number; separation: number; inducedAngle: number; cl: number; cd: number; wakeQ: number }[] {
        const out = [];
        for (let i = 0; i < this.stripCount; i++) {
            const speed = this.lastSpeed[i];
            out.push({
                group: this.groupNames[this.stripGroup[i]],
                alpha: this.lastAlpha[i],
                separation: this.separation[i],
                inducedAngle: speed > 0 ? this.inducedVelocity[i] / speed : 0,
                cl: this.lastCl[i],
                cd: this.lastCd[i],
                wakeQ: this.wakeQ[i],
            });
        }
        return out;
    }

    /** Area-weighted fraction of wing strips whose flow has separated (f < 0.5). */
    wingSeparatedFraction(): number {
        let sep = 0, total = 0;
        for (let i = 0; i < this.wingStripCount; i++) {
            total += this.stripArea[i];
            if (this.separation[i] < 0.5) sep += this.stripArea[i];
        }
        return total > 0 ? sep / total : 0;
    }

    /**
     * Body-frame force-vector samples from the last recorded evaluation: per
     * group, the resultant at its force-weighted centre, split into lift and
     * drag against the relative wind (sim → display origin is the CG).
     */
    forceVectorSnapshot(vx: number, vy: number, vz: number): ForceVectorSample[] {
        const out: ForceVectorSample[] = [];
        const v = Math.sqrt(vx * vx + vy * vy + vz * vz);
        const dx = v > 1e-3 ? -vx / v : 0, dy = v > 1e-3 ? -vy / v : 0, dz = v > 1e-3 ? -vz / v : 0;
        for (let g = 0; g < this.groupNames.length; g++) {
            const w = this.groupW[g];
            if (w <= 0) continue;
            const o = g * 3;
            const fx = this.groupF[o], fy = this.groupF[o + 1], fz = this.groupF[o + 2];
            const origin: [number, number, number] = [this.groupP[o] / w, this.groupP[o + 1] / w, this.groupP[o + 2] / w];
            const d = fx * dx + fy * dy + fz * dz;
            const drag: [number, number, number] = [d * dx, d * dy, d * dz];
            if (this.groupKind[g] === 'drag') {
                out.push({ part: this.groupNames[g], kind: 'drag', origin, vec: [fx, fy, fz] });
                continue;
            }
            out.push({ part: this.groupNames[g], kind: 'lift', origin, vec: [fx - drag[0], fy - drag[1], fz - drag[2]] });
            out.push({ part: this.groupNames[g], kind: 'drag', origin, vec: drag });
        }
        return out;
    }

    /**
     * The wind tunnel: NASA body-axis coefficients about the reference point
     * for a held attitude and rates, with the slow states settled.
     */
    coefficients(c: StaticCondition): NasaCoefficients {
        const speed = c.speed ?? 100;
        const rho = c.rho ?? 1.225;
        const beta = c.beta ?? 0;
        this.controls.fill(0);
        for (const [ch, value] of Object.entries(c.controls ?? {})) {
            this.controls[CHANNEL_INDEX[ch as Fm3Channel]] = value ?? 0;
        }
        // NASA (u, v, w) → sim (−v, −w, u).
        const u = speed * Math.cos(c.alpha) * Math.cos(beta);
        const vN = speed * Math.sin(beta);
        const w = speed * Math.sin(c.alpha) * Math.cos(beta);
        const vx = -vN, vy = -w, vz = u;
        const p = c.p ?? 0, q = c.q ?? 0, r = c.r ?? 0;
        const wx = -q, wy = -r, wz = p;
        const env: AeroEnvironment = {
            rho,
            soundSpeed: c.soundSpeed ?? 340.3,
            heightAboveGround: c.heightAboveGround ?? Infinity,
            gearDown: c.gearDown ?? 0,
        };
        this.reset();
        this.settle(vx, vy, vz, wx, wy, wz, env);
        const f = new Float64Array(3);
        const m = new Float64Array(3);
        this.evaluate(vx, vy, vz, wx, wy, wz, env, f, m, false);

        const F = simToNasa([f[0], f[1], f[2]]);
        const Mcg = simToNasa([m[0], m[1], m[2]]);
        const arm = sub(this.airframe.mass.cg, this.airframe.reference.momentRef);
        const M = add(Mcg, cross(arm, F));
        const ref = this.airframe.reference;
        const qS = 0.5 * rho * speed * speed * ref.areaM2;
        const CX = F[0] / qS, CY = F[1] / qS, CZ = F[2] / qS;
        const ca = Math.cos(c.alpha), sa = Math.sin(c.alpha), cb = Math.cos(beta), sb = Math.sin(beta);
        return {
            CX, CY, CZ,
            Cl: M[0] / (qS * ref.spanM),
            Cm: M[1] / (qS * ref.chordM),
            Cn: M[2] / (qS * ref.spanM),
            CL: CX * sa - CZ * ca,
            CD: -(CX * ca * cb + CY * sb + CZ * sa * cb),
        };
    }

    /**
     * Pitch damping, Cmq + Cmα̇ per unit of q·c̄/2V about the CG, by forced
     * oscillation: the body pitches ±`amplitude` about `c.alpha` at `omega`
     * rad/s with the flight path held, and the moment in phase with α̇ is the
     * damping. Unlike {@link coefficients} it carries the lags of separation,
     * circulation, downwash and vortex breakdown, which decide it past stall.
     * One cycle settles; the next is measured.
     */
    pitchDamping(c: StaticCondition, amplitude = Math.PI / 36, omega = 0.8): number {
        const speed = c.speed ?? 100;
        const rho = c.rho ?? 1.225;
        const beta = c.beta ?? 0;
        this.controls.fill(0);
        for (const [ch, value] of Object.entries(c.controls ?? {})) {
            this.controls[CHANNEL_INDEX[ch as Fm3Channel]] = value ?? 0;
        }
        const env: AeroEnvironment = {
            rho,
            soundSpeed: c.soundSpeed ?? 340.3,
            heightAboveGround: c.heightAboveGround ?? Infinity,
            gearDown: c.gearDown ?? 0,
        };
        const wy = -(c.r ?? 0), wz = c.p ?? 0;
        const v = new Float64Array(3);
        // NASA (u, v, w) → sim (−v, −w, u).
        const velocityAt = (alpha: number) => {
            v[0] = -speed * Math.sin(beta);
            v[1] = -speed * Math.sin(alpha) * Math.cos(beta);
            v[2] = speed * Math.cos(alpha) * Math.cos(beta);
        };
        velocityAt(c.alpha);
        this.reset();
        this.settle(v[0], v[1], v[2], 0, wy, wz, env);

        const f = new Float64Array(3);
        const m = new Float64Array(3);
        const dt = 1 / 120;
        const cycle = Math.max(1, Math.round(2 * Math.PI / omega / dt));
        let inPhase = 0;
        for (let i = 0; i < 2 * cycle; i++) {
            const t = i * dt;
            velocityAt(c.alpha + amplitude * Math.sin(omega * t));
            // q = α̇, and sim ω about +X is −q.
            const wx = -amplitude * omega * Math.cos(omega * t);
            this.advance(dt, v[0], v[1], v[2], wx, wy, wz, env);
            this.evaluate(v[0], v[1], v[2], wx, wy, wz, env, f, m, true);
            // NASA pitching moment is −M about sim +X.
            if (i >= cycle) inPhase -= m[0] * Math.cos(omega * t);
        }
        const ref = this.airframe.reference;
        const qSc = 0.5 * rho * speed * speed * ref.areaM2 * ref.chordM;
        return 2 * inPhase / cycle / qSc / (ref.chordM / (2 * speed) * amplitude * omega);
    }
}

/**
 * Cut one surface (and its mirror image) into strips. Nodes follow the
 * quarter-chord line; each strip's normal comes from its twisted chord and
 * span directions, and its bound vortex is oriented so positive circulation
 * lifts along the normal.
 */
function buildStrips(
    surface: Fm3LiftingSurface, group: number, toSim: (p: Vec3) => Vec3, out: StripDef[],
): void {
    const role = surface.role === 'wing' ? 0 : 1;
    const sides = surface.mirror ? [1, -1] : [1];
    const nStrips = Math.max(1, surface.strips);
    const rootTwist = surface.rootTwist ?? 0;
    const tipTwist = surface.tipTwist ?? 0;
    const downstream: Vec3 = [-1, 0, 0];
    for (const side of sides) {
        for (let k = 0; k < nStrips; k++) {
            // Closer together towards a free tip, where the loading falls away.
            // A root, or a tip that joins another panel, is not a free edge:
            // strips bunched there would only shed spurious vortices between them.
            const uniform = surface.spacing === 'uniform';
            const t0 = uniform ? k / nStrips : Math.sin(0.5 * Math.PI * k / nStrips);
            const t1 = uniform ? (k + 1) / nStrips : Math.sin(0.5 * Math.PI * (k + 1) / nStrips);
            const tm = 0.5 * (t0 + t1);
            const chordAt = (t: number) => surface.rootChord + t * (surface.tipChord - surface.rootChord);
            const quarter = (t: number): Vec3 => add(lerp(surface.rootLE, surface.tipLE, t), [-0.25 * chordAt(t), 0, 0]);
            let A = quarter(t0);
            let B = quarter(t1);
            let P = quarter(tm);
            let le = lerp(surface.rootLE, surface.tipLE, tm);
            const chord = chordAt(tm);
            const twist = rootTwist + tm * (tipTwist - rootTwist);
            let s = normalize(sub(B, A));
            const ds = length(sub(B, A));
            let chordBack = rotateAbout([-1, 0, 0], s, twist);
            let n = normalize(cross(chordBack, s));
            const perp = sub(chordBack, scale(s, dot(chordBack, s)));
            const chordN = chord * length(perp);
            let f = scale(normalize(perp), -1);
            let te = add(le, scale(chordBack, chord));
            if (side < 0) {
                A = mirrorY(A); B = mirrorY(B); P = mirrorY(P); le = mirrorY(le); te = mirrorY(te);
                s = mirrorY(s); chordBack = mirrorY(chordBack); n = mirrorY(n); f = mirrorY(f);
            }
            if (dot(cross(downstream, sub(B, A)), n) < 0) {
                const tmp = A; A = B; B = tmp;
            }
            // Root endplate: reflect the horseshoe in the root plane, reversed so
            // its trailing leg at the root cancels the real one.
            let imageA: Vec3 | undefined;
            let imageB: Vec3 | undefined;
            if (surface.rootEndplate) {
                const spanDir = sub(surface.tipLE, surface.rootLE);
                let m = normalize([0, spanDir[1], spanDir[2]]);
                let origin = surface.rootLE;
                if (side < 0) { m = mirrorY(m); origin = mirrorY(origin); }
                const reflect = (p: Vec3): Vec3 => sub(p, scale(m, 2 * dot(sub(p, origin), m)));
                imageA = toSim(reflect(B));
                imageB = toSim(reflect(A));
            }

            const def: StripDef = {
                group, role, imageA, imageB, side,
                vortexFromStrakes: surface.vortexFromStrakes ?? false,
                a: toSim(A), b: toSim(B), p: toSim(P), te: toSim(te),
                n: nasaToSim(n), f: nasaToSim(f), s: nasaToSim(s),
                chordN, ds, section: surface.section, qFactor: surface.qFactor ?? 1,
                allMovingCh: -1, allMovingGain: 0,
                flapCh: -1, flapTau: 0, flapGain: 0, flapCf: 0,
                lefCh: -1, lefGain: 0,
                lateral: P[1],
                longitudinal: P[0],
            };
            for (const seg of surface.controls ?? []) {
                if (tm < seg.spanFrom || tm > seg.spanTo) continue;
                const ch = CHANNEL_INDEX[side > 0 ? seg.channel : (seg.mirrorChannel ?? seg.channel)];
                const gain = seg.gain ?? 1;
                if (seg.kind === 'allMoving') {
                    def.allMovingCh = ch; def.allMovingGain = gain;
                } else if (seg.kind === 'flap') {
                    def.flapCh = ch; def.flapGain = gain;
                    def.flapCf = seg.chordFraction ?? 0.25;
                    def.flapTau = flapEffectiveness(def.flapCf);
                } else {
                    def.lefCh = ch; def.lefGain = gain;
                }
            }
            out.push(def);
        }
    }
}

export { staticSeparation };
