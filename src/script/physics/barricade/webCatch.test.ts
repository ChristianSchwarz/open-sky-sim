/**
 * Phase 2 of the rigid-body barricade: the webbing follows the game sim's
 * own arrest. The jet's pose over time is recorded from CombatSim itself
 * (its kinematic catch: the 75 m run-out capped at 5 g, the rebound 5 m back
 * over 1.6 s with the 4° lean, then HELD), headless, the way
 * combatSim.barricade.test.ts drives it, and played into WebSolver.step as a
 * kinematic body. The net does not push the jet: one-way coupling.
 *
 * Gates, for each airframe at 5, 30 and 60 m/s, caught centred and 3 m off
 * either side:
 *  - no webbing particle deeper inside the drawn skin than the skin margin,
 *    and no link through it;
 *  - engaging-strap strain under 20 %;
 *  - each belt end's payout within a geometric bound of the jet's travel
 *    past the net (see {@link payoutBound});
 *  - after the rebound and the lean the webbing still drapes the airframe:
 *    at least {@link MIN_DRAPE} strap particles pressed on it, some on each
 *    side of its centreline;
 *  - no energy created: the net's kinetic, elastic and potential energy
 *    gained is at most what the airframe's contacts put in less what the
 *    modelled sinks took, within {@link MAX_CREATED} of the airframe's work;
 *  - every particle under 0.2 m/s three seconds into the hold;
 *  - at most 5 ms of solver time per 60 Hz frame.
 *
 * Also reported: the pull the net would put on the jet (the contact
 * impulses per frame, as g on the airframe's mass) against the sim's 5 g cap.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as THREE from 'three';
import { Faction } from '../../weapons/combatant';
import { FcsPitchLimiter } from '../fm2/fcs';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { CarrierMeshCollider } from '../../scene/entities/carrierDeck';
import {
    BarricadeEngagement, BARRICADE_DECK_Y, BARRICADE_LOCAL_Z, BARRICADE_MAX_DECEL_MPS2, BARRICADE_MID_X,
    BARRICADE_HEIGHT_M, BARRICADE_LOWER_LIFT_M, BARRICADE_PULL_OUT_M, BARRICADE_REBOUND_M, BARRICADE_TILT_RAD,
} from '../../scene/entities/barricadeSpec';
import { CombatSim } from '../sim/combatSim';
import { serializeWorld } from '../sim/serializedWorld';
import { BELT_EA_N, buildRiggedWeb } from './webLayout';
import { WebSolver } from './webSolver';
import { loadWebAirframe, WEB_FIXTURES, WebAirframe, WebFixture } from './webFixtures.testkit.test';
import { cpuMs, MASS_KG, netEnergy, penetration } from './webHarness.testkit.test';

/*
 * Diagnostics, off unless set (node only; this file is outside the app's typecheck):
 * WC_PROBE (fastest particles 3 s into the hold), WC_RING (net energy every 0.5 s of
 * the hold), WC_DIAG (energy books every 15 frames), WC_WORST=<strain> (the strap over
 * it), WC_STRAP=<particle> / WC_BTRACE=<ids> / WC_NORM=<ids> with WC_F0..WC_F1 (body-
 * frame traces), WC_TRACE=<ids> (hold), WC_HOLD=<s> (longer hold), WC_THRU / WC_LINK=<id>
 * (links through the skin), WC_STAGES / WC_ROWS (what each solver stage moves in the
 * hold), WC_NOBANDED, WC_NOREBOUND (the sim catch without its roll-back).
 */
const DT = 1 / 60;
const STATE_NAME = ['none', 'pulling', 'held', 'rebound'];
const G0 = 9.80665;
const SPEEDS = [5, 30, 60];
const OFFSETS = [0, -3, 3];
const MAX_MS_PER_FRAME = 5;
const MAX_STRAP_STRAIN = 0.2;
const MAX_CREATED = 0.05;
const MIN_DRAPE = 10;
const SETTLED_MPS = 0.2;
/** An engaging strap, upper belt to lower belt as rigged (m). */
const STRAP_LENGTH_M = BARRICADE_HEIGHT_M - BARRICADE_LOWER_LIFT_M;
/** How long into the hold the net must have settled (s). */
const SETTLE_S = 3;
/** The settled speed is the displacement over this many frames (see {@link CatchResult.settledSpeed}). */
const SETTLE_WINDOW_F = 6;

// ---------------------------------------------------------------- the sim's arrest

/** One frame of the sim's catch: the jet's pose (carrier-local) and engagement state. */
interface ArrestFrame {
    readonly position: THREE.Vector3;
    readonly quaternion: THREE.Quaternion;
    readonly state: BarricadeEngagement;
}

function flatDeck(): CarrierMeshCollider {
    const y = BARRICADE_DECK_Y;
    const x0 = -60, x1 = 60, z0 = -150, z1 = 150;
    return {
        originX: 0, originY: 0, originZ: 0,
        triangles: [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1],
        aabb: { min: [x0, y, z0], max: [x1, y, z1] },
    };
}

const INPUT = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0,
    landingGearDeployed: true, flapsExtended: true, airbrakesExtended: false, hookDeployed: false,
    wheelBrakesApplied: false, pitchLimiterMode: FcsPitchLimiter.SOFT, limitersEnabled: true,
    wantForceVectors: false, firing: false,
} as const;
const ID = 'web-catch';
const HEADING_BOW = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
type SimAc = {
    barricadeState: BarricadeEngagement;
    model: { position: THREE.Vector3; quaternion: THREE.Quaternion; velocityVector: THREE.Vector3 };
};

/**
 * Run the game sim's own catch: one aircraft rolling toward the bow at
 * `speed`, `aft` metres short of the net and `x` off the centreline, until
 * it has been HELD for `holdS` seconds. Every frame's pose and state.
 */
export function recordArrest(speed: number, x: number, aft: number, holdS: number): ArrestFrame[] {
    const sim = new CombatSim();
    sim.setWorld(serializeWorld([], [], [], [], [flatDeck()]));
    sim.setBarricades([{ originX: 0, originY: 0, originZ: 0, quaternion: [0, 0, 0, 1], armed: true, generation: 1 }]);
    const q = HEADING_BOW;
    sim.addAircraft({
        id: ID, faction: Faction.PLAYER, control: 'ai', kinematic: false,
        aircraftConfig: defaultFm2Config, hitRadius: 5, maxHealth: 100,
        spawn: {
            position: [BARRICADE_MID_X + x, BARRICADE_DECK_Y + fm2GroundRestHeight(defaultFm2Config), BARRICADE_LOCAL_Z + aft],
            quaternion: [q.x, q.y, q.z, q.w], velocity: [0, 0, -speed], throttle: 0, landed: true, airborne: false,
        },
        enabled: true,
    });
    const ac = (sim as unknown as { aircraft: Map<string, SimAc> }).aircraft.get(ID)!;
    const frames: ArrestFrame[] = [];
    // WC_NOREBOUND: the sim's catch with its roll-back taken out (held where it stopped, still
    // leaning), to tell what the kinematic rebound alone does to the net.
    let stopAt: THREE.Vector3 | null = null;
    const push = () => {
        if (process.env.WC_NOREBOUND && ac.barricadeState !== BarricadeEngagement.NONE && ac.barricadeState !== BarricadeEngagement.PULLING) stopAt ??= ac.model.position.clone();
        frames.push({ position: (stopAt ?? ac.model.position).clone(), quaternion: ac.model.quaternion.clone(), state: ac.barricadeState });
    };
    push();
    let held = -1;
    for (let f = 0; f < 60 * 60; f++) {
        sim.step(DT, { [ID]: { ...INPUT } });
        push();
        if (held < 0 && ac.barricadeState === BarricadeEngagement.HELD) held = f;
        if (held >= 0 && f - held >= holdS / DT) break;
    }
    return frames;
}

// ---------------------------------------------------------------- the web following it

interface CatchResult {
    fixture: WebFixture;
    speed: number;
    offset: number;
    frames: number;
    deep: number;
    through: number;
    maxStrapStrain: number;
    /** Frame and arrest state of the worst strain. */
    strainAt: string;
    /** Worst payout outside its geometric bound (m; ≤ 0 inside), and the end and frame it was at. */
    payoutExcess: number;
    payoutAt: string;
    /** Closest the payout came to each limit over the catch (m). */
    loMargin: number;
    hiMargin: number;
    finalPayout: number[];
    /** Strap particles pressed on the airframe at the end of the rebound, all and either side of it. */
    drape: number;
    drapeLeft: number;
    drapeRight: number;
    /** The net's energy gained less (the airframe's work less the sinks), as a share of that work. */
    created: number;
    bodyWorkKJ: number;
    /**
     * Fastest particle three seconds into the hold, as its displacement over
     * the last SETTLE_WINDOW_F frames; and the fastest one-substep velocity
     * then, which also carries the sub-millimetre corrections of contacts
     * re-found every few substeps.
     */
    settledSpeed: number;
    substepSpeed: number;
    /** Seconds into the hold of the last 0.1 s window with a particle at or over SETTLED_MPS. */
    settleTime: number;
    /**
     * What the sinks took (W) from 1 s to 5 s into the hold, with the airframe
     * still: energy the solver put in, since nothing else can (needs a hold of 5 s).
     */
    holdPowerW: number;
    msPerFrame: number;
    /** The net's pull on the jet over the run-out (g on its mass): peak, mean while pulling, and the sim's own peak. */
    pullPeakG: number;
    pullMeanG: number;
    simPeakG: number;
}

/** The mesh's pose for a sim pose: the sim's position is its CG at gear rest height, the mesh sits on its wheels. */
function meshPose(af: WebAirframe, f: ArrestFrame, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    pos.copy(f.position);
    pos.y += -af.bounds[1] - fm2GroundRestHeight(defaultFm2Config);
    quat.copy(f.quaternion);
}

/** One side of an airframe as the belts see it (body frame): its outermost point and that tip's leading edge. */
interface Side {
    /** Half span on this side (m) and the tip's foremost body z. */
    halfSpan: number;
    tipZ: number;
}

/** The airframe's two sides: +1 is body +x. The tip is the outer tenth of the span. */
function sides(af: WebAirframe): Record<1 | -1, Side> {
    const t = af.collisionTriangles;
    const out = { 1: { halfSpan: 0, tipZ: -Infinity }, [-1]: { halfSpan: 0, tipZ: -Infinity } } as Record<1 | -1, Side>;
    for (const sgn of [1, -1] as const) {
        for (let k = 0; k < t.length; k += 3) out[sgn].halfSpan = Math.max(out[sgn].halfSpan, sgn * t[k]);
        for (let k = 0; k < t.length; k += 3) {
            if (sgn * t[k] >= 0.9 * out[sgn].halfSpan) out[sgn].tipZ = Math.max(out[sgn].tipZ, t[k + 2]);
        }
    }
    return out;
}

/**
 * Where one belt end's payout must lie (m), from the geometry of the catch.
 *
 * The belt runs from its anchor, `a` (laterally) from the airframe's tip on
 * that side, out to the webbing on the airframe and across its front. Its
 * anchor-side run was `a` rigged; caught, it reaches forward to where the
 * webbing is. The straps hang the belts from the wing, so a belt station
 * is no farther behind the tip's leading edge (`tipDepth` past the net line)
 * than one strap length: the run is at least sqrt(a² + (tipDepth − strap)²).
 * Nor can it reach farther than the nose has been (`noseDepthMax`, the
 * tethers do not reel in), plus what the run across the front can have
 * grown going from straight to round the nose (`frontGrowth`). The belt's
 * own stretch at the holding force takes up part of what it needs, so the
 * lower limit is less that, `stretch`.
 */
function payoutBound(a: number, tipDepth: number, noseDepthMax: number, frontGrowth: number, stretch: number): [number, number] {
    const reach = Math.max(0, tipDepth - STRAP_LENGTH_M);
    const lo = Math.sqrt(a * a + reach * reach) - a - stretch;
    const hi = Math.sqrt(a * a + noseDepthMax * noseDepthMax) - a + frontGrowth;
    return [lo, hi];
}

function runCatch(fixture: WebFixture, speed: number, offset: number, arrest: ArrestFrame[]): CatchResult {
    const af = loadWebAirframe(fixture);
    const layout = buildRiggedWeb({ engineSetKg: MASS_KG[fixture] });
    const s = new WebSolver(layout);
    for (let f = 0; f < 120; f++) s.step(DT);
    const e0 = netEnergy(s);
    const st = s.stats;
    const sinks = () => st.tetherWork + st.tieWork + st.frictionWork + st.dragWork + st.materialWork + st.contactResetLoss;
    const sinks0 = sinks(), body0 = st.bodyWork;
    // WC_STAGES: how much each solver stage moves the webbing during the hold, as the kinetic
    // energy its corrections would carry (sum of m (dx/h)^2 / 2), summed over a frame.
    const stageE = new Map<string, number>();
    let stagesOn = false;
    if (process.env.WC_STAGES) {
        const anyS = s as unknown as Record<string, (...a: unknown[]) => unknown>;
        const h = DT / 32;
        for (const name of ['solveContacts', 'solveChain', 'solveChainBanded', 'solveTieDowns', 'payOut', 'updateVelocities', 'dampLinks', 'predict']) {
            const orig = anyS[name].bind(s);
            const before = new Float64Array(3 * s.count);
            anyS[name] = (...args: unknown[]) => {
                if (!stagesOn) return orig(...args);
                const isVel = name === 'updateVelocities' || name === 'dampLinks';
                const src = isVel ? s.v : s.x;
                before.set(src);
                const r = orig(...args);
                let e = 0;
                for (let i = 0; i < s.count; i++) {
                    const k = 3 * i;
                    const dx = src[k] - before[k], dy = src[k + 1] - before[k + 1], dz = src[k + 2] - before[k + 2];
                    e += isVel
                        ? 0.5 * layout.mass[i] * (src[k] ** 2 + src[k + 1] ** 2 + src[k + 2] ** 2 - before[k] ** 2 - before[k + 1] ** 2 - before[k + 2] ** 2)
                        : 0.5 * layout.mass[i] * (dx * dx + dy * dy + dz * dz) / (h * h);
                }
                stageE.set(name, (stageE.get(name) ?? 0) + e);
                return r;
            };
        }
    }
    // WC_ROWS: in the hold, the banded rows whose multiplier moves the webbing most.
    let rowsOn = false;
    const rowLog: string[] = [];
    if (process.env.WC_ROWS) {
        const anyS = s as unknown as Record<string, unknown> & { solveChainBanded: (q: number, h: number) => void };
        const orig = anyS.solveChainBanded.bind(s);
        anyS.solveChainBanded = (q: number, h: number) => {
            orig(q, h);
            if (!rowsOn) return;
            const kind = anyS.bRowKind as Int32Array, X = anyS.bX as Float64Array, sc = anyS.bScale as Float64Array, A = anyS.bA as Float64Array, link = anyS.bRowLink as Int32Array;
            const W1 = (anyS.bA as Float64Array).length / (anyS.bRowKind as Int32Array).length;
            const ecS = anyS.ecS as Float64Array, ecN = anyS.ecN as Float64Array;
            const blk = anyS.bBlock as Int32Array;
            const chain = (anyS.chains as { links: number }[])[q];
            const n = blk[chain.links];
            for (let r = 0; r < n; r++) {
                const move = Math.abs(X[r]) * sc[r];
                if (move < 0.001) continue;
                const ci = kind[r] < 0 ? -1 - kind[r] : -1;
                rowLog.push(`chain ${q} row ${r}/${n} ${kind[r] >= 0 ? 'link' : 'edge'} link ${link[r]} move ${(100 * move).toFixed(1)} cm own/scale ${(A[r * W1] / sc[r]).toFixed(3)}${ci >= 0 ? ` s ${ecS[ci].toFixed(2)} n (${ecN[3 * ci].toFixed(2)},${ecN[3 * ci + 1].toFixed(2)},${ecN[3 * ci + 2].toFixed(2)})` : ''}`);
            }
        };
    }
    if (process.env.WC_NOBANDED) {
        const anyS = s as unknown as { solveChainBanded: (q: number, h: number) => void; solveChain: (c: unknown, h: number) => void; chains: unknown[] };
        anyS.solveChainBanded = (q: number, h: number) => anyS.solveChain(anyS.chains[q], h);
    }
    const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
    const prevPosition = new THREE.Vector3(), prevQuaternion = new THREE.Quaternion();
    const body = { collider: af.collider, prevPosition, prevQuaternion, position, quaternion };
    const mass = MASS_KG[fixture];
    const qInv = new THREE.Quaternion();
    // The airframe's nose and its tips, body frame (nose +z).
    const b = af.bounds;
    const side = sides(af);
    let strainAt = '';
    let noseDepthMax = 0, loMargin = Infinity, hiMargin = Infinity;
    let ms = 0, deep = 0, through = 0, maxStrap = 0, payoutExcess = -Infinity, payoutAt = '';
    let drape = 0, drapeLeft = 0, drapeRight = 0, settledSpeed = Infinity;
    let pullPeak = 0, pullSum = 0, pullN = 0, simPeak = 0;
    const tethers = layout.tethers;
    let heldAt = -1, substepSpeed = Infinity;
    let settleFrom: Float64Array | null = null;
    let ringFrom: Float64Array | null = null;
    let windowFrom: Float64Array | null = null, lastMoving = 0;
    let holdSink0 = 0, holdPower = NaN;
    const holdKE: number[] = [];
    const right = new THREE.Vector3();
    for (let f = 1; f < arrest.length; f++) {
        meshPose(af, arrest[f - 1], prevPosition, prevQuaternion);
        meshPose(af, arrest[f], position, quaternion);
        stagesOn = !!process.env.WC_STAGES && heldAt >= 0 && f - heldAt > 120;
        rowsOn = !!process.env.WC_ROWS && heldAt >= 0 && f - heldAt >= 150 && f - heldAt < 153;
        stageE.clear();
        const t0 = cpuMs();
        s.step(DT, body);
        if (rowsOn) { console.log(`ROWS ${rowLog.length}`); for (const l of rowLog.slice(0, 60)) console.log(`ROW ${l}`); }
        if (stagesOn && (f - heldAt) % 30 === 0) {
            let ke = 0;
            for (let i = 0; i < s.count; i++) ke += 0.5 * layout.mass[i] * (s.v[3 * i] ** 2 + s.v[3 * i + 1] ** 2 + s.v[3 * i + 2] ** 2);
            console.log(`STAGES f+${f - heldAt} KE ${ke.toFixed(1)} J: ` + [...stageE].map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', '));
        }
        ms += cpuMs() - t0;
        const state = arrest[f].state;
        if (st.maxStrapStrain > maxStrap) strainAt = `f${f} ${STATE_NAME[state]}`;
        maxStrap = Math.max(maxStrap, st.maxStrapStrain);
        if (process.env.WC_DIAG && f % 15 === 0) {
            const res = ((netEnergy(s) - e0) - ((st.bodyWork - body0) - (sinks() - sinks0))) / 1e3;
            let fast = 0, fi = -1;
            for (let i = 0; i < s.count; i++) { const v = len(s.v, i); if (v > fast) { fast = v; fi = i; } }
            console.log(`DIAG f${f} ${STATE_NAME[state]} created ${res.toFixed(2)} kJ bodyWork ${((st.bodyWork - body0) / 1e3).toFixed(1)} kJ strap ${st.maxStrapStrain.toFixed(3)} belt ${st.maxBeltStrain.toFixed(3)} KE+PE+el ${((netEnergy(s) - e0) / 1e3).toFixed(1)} sinks ${((sinks() - sinks0) / 1e3).toFixed(1)} [fr ${(st.frictionWork / 1e3).toFixed(1)} dr ${(st.dragWork / 1e3).toFixed(1)} mat ${(st.materialWork / 1e3).toFixed(1)} reset ${(st.contactResetLoss / 1e3).toFixed(1)} tie ${(st.tieWork / 1e3).toFixed(1)}] tether ${(st.tetherWork / 1e3).toFixed(1)} fastest p${fi} part ${layout.part[fi]} ${fast.toFixed(1)} m/s y ${(s.x[3 * fi + 1] - BARRICADE_DECK_Y).toFixed(2)} contacts ${st.contacts}`);
        }
        qInv.copy(quaternion).invert();
        if (f % 10 === 0 || state !== arrest[f - 1].state) {
            const p = penetration(s, af, position, qInv);
            deep = Math.max(deep, p.deep);
            through = Math.max(through, p.through);
            if (p.through > 0 && process.env.WC_THRU) {
                for (const li of p.throughLinks) {
                    const l = layout.links[li];
                    const rel = (i: number) => new THREE.Vector3(s.x[3 * i], s.x[3 * i + 1], s.x[3 * i + 2]).sub(position).applyQuaternion(qInv);
                    const a = rel(l.i), bb = rel(l.j);
                    console.log(`THRU f${f} ${STATE_NAME[state]} link ${li} parts ${layout.part[l.i]}/${layout.part[l.j]} (${a.x.toFixed(2)},${a.y.toFixed(2)},${a.z.toFixed(2)}) -> (${bb.x.toFixed(2)},${bb.y.toFixed(2)},${bb.z.toFixed(2)}) pressed ${s.bodyPressed[l.i]}${s.bodyPressed[l.j]}`);
                }
            }
        }
        // The pull: the contact impulses this frame along the run-out (−z), as g on the jet.
        if (state === BarricadeEngagement.PULLING) {
            // reaction is the impulse on the webbing; the jet feels the opposite, +z against its run.
            const g = -st.reaction[2] / DT / mass / G0;
            pullPeak = Math.max(pullPeak, g);
            pullSum += g;
            pullN++;
            const dv = (arrest[f].position.z - arrest[f - 1].position.z) - (arrest[f - 1].position.z - arrest[Math.max(0, f - 2)].position.z);
            simPeak = Math.max(simPeak, dv / DT / DT / G0);
        }
        // Payout against the geometry, each end.
        right.set(1, 0, 0).applyQuaternion(quaternion);
        noseDepthMax = Math.max(noseDepthMax, BARRICADE_LOCAL_Z - (position.z - b[5]));
        for (let t = 0; t < tethers.length; t++) {
            const ax = tethers[t].anchor[0];
            // The tip toward this anchor: heading to −z, body +x is carrier −x.
            const sgn: 1 | -1 = ax < position.x ? 1 : -1;
            const sd = side[sgn];
            const a = Math.max(0, Math.abs(ax - position.x) - sd.halfSpan);
            const tipDepth = BARRICADE_LOCAL_Z - (position.z - sd.tipZ);
            const frontGrowth = Math.hypot(sd.halfSpan, b[5] - sd.tipZ) - sd.halfSpan;
            const runNow = Math.hypot(a, Math.max(0, tipDepth)) + sd.halfSpan;
            const stretch = (st.tetherForce[t] / BELT_EA_N) * runNow;
            const [lo, hi] = payoutBound(a, tipDepth, noseDepthMax, frontGrowth, stretch);
            const p = st.payout[t];
            const ex = Math.max(lo - p, p - hi);
            if (f > 1) { loMargin = Math.min(loMargin, p - lo); hiMargin = Math.min(hiMargin, hi - p); }
            if (ex > payoutExcess) {
                payoutExcess = ex;
                payoutAt = `tether ${t} f${f} payout ${p.toFixed(2)} in [${lo.toFixed(2)}, ${hi.toFixed(2)}] tip ${tipDepth.toFixed(1)} nose ${noseDepthMax.toFixed(1)}`;
            }
        }
        if (heldAt < 0 && state === BarricadeEngagement.HELD) {
            heldAt = f;
            drape = drapeLeft = drapeRight = 0;
            const pb = s.bodyPressed;
            for (let i = 0; i < s.count; i++) {
                if (layout.part[i] !== 2 || !pb[i]) continue;
                drape++;
                const lx = (s.x[3 * i] - position.x) * right.x + (s.x[3 * i + 2] - position.z) * right.z;
                if (lx > 0) drapeLeft++; else drapeRight++;
            }
        }
        if (process.env.WC_BTRACE && f >= Number(process.env.WC_F0 ?? 0) && f <= Number(process.env.WC_F1 ?? 1e9) && f % 3 === 0) {
            for (const i of process.env.WC_BTRACE.split(',').map(Number)) {
                const k = 3 * i;
                const rel = new THREE.Vector3(s.x[k], s.x[k + 1], s.x[k + 2]).sub(position).applyQuaternion(qInv);
                const vb = new THREE.Vector3(s.v[k], s.v[k + 1], s.v[k + 2]).applyQuaternion(qInv);
                console.log(`BT f${f} p${i} body (${rel.x.toFixed(2)}, ${rel.y.toFixed(2)}, ${rel.z.toFixed(2)}) v (${vb.x.toFixed(1)}, ${vb.y.toFixed(1)}, ${vb.z.toFixed(1)}) worldY ${(s.x[k + 1] - BARRICADE_DECK_Y).toFixed(3)} pressed ${s.bodyPressed[i]} jetVz ${((arrest[f].position.z - arrest[f - 1].position.z) / DT).toFixed(2)}`);
            }
        }
        if (process.env.WC_STRAP && f >= Number(process.env.WC_F0 ?? 0) && f <= Number(process.env.WC_F1 ?? 1e9) && f % 6 === 0) {
            const want = Number(process.env.WC_STRAP);
            const strap = layout.straps.find(st2 => st2.includes(want))!;
            const rows = strap.map(i => {
                const k = 3 * i;
                const rel = new THREE.Vector3(s.x[k], s.x[k + 1], s.x[k + 2]).sub(position).applyQuaternion(qInv);
                return `${i}${s.bodyPressed[i] ? '*' : ''}(${rel.x.toFixed(2)},${rel.y.toFixed(2)},${rel.z.toFixed(2)} v${len(s.v, i).toFixed(1)})`;
            });
            console.log(`STRAP f${f} ${rows.join(' ')}`);
        }
        if (process.env.WC_NORM && f >= Number(process.env.WC_F0 ?? 0) && f <= Number(process.env.WC_F1 ?? 1e9)) {
            const anyS = s as unknown as { bcN: Float64Array; bcHas: Uint8Array; bcS: Float64Array; clearance: Float64Array };
            const rows = process.env.WC_NORM.split(',').map(Number).map(i => {
                const k = 3 * i;
                const rel = new THREE.Vector3(s.x[k], s.x[k + 1], s.x[k + 2]).sub(position).applyQuaternion(qInv);
                return `p${i} (${rel.x.toFixed(3)},${rel.y.toFixed(3)},${rel.z.toFixed(3)}) has ${anyS.bcHas[i]} n (${anyS.bcN[k].toFixed(2)},${anyS.bcN[k + 1].toFixed(2)},${anyS.bcN[k + 2].toFixed(2)}) s (${anyS.bcS[k].toFixed(3)},${anyS.bcS[k + 1].toFixed(3)},${anyS.bcS[k + 2].toFixed(3)}) clr ${anyS.clearance[i].toFixed(3)} v ${len(s.v, i).toFixed(1)}`;
            });
            console.log(`NORM f${f} ${rows.join(' || ')}`);
        }
        if (process.env.WC_WORST && st.maxStrapStrain > Number(process.env.WC_WORST)) {
            let best = 0, bs = -1, bn = -1;
            layout.straps.forEach((strap, si) => {
                for (let n = 1; n < strap.length; n++) {
                    const a3 = 3 * strap[n - 1], b3 = 3 * strap[n];
                    const d = Math.hypot(s.x[b3] - s.x[a3], s.x[b3 + 1] - s.x[a3 + 1], s.x[b3 + 2] - s.x[a3 + 2]);
                    const rest = layout.links.find(l => (l.i === strap[n - 1] && l.j === strap[n]) || (l.j === strap[n - 1] && l.i === strap[n]))!.rest;
                    if (d / rest - 1 > best) { best = d / rest - 1; bs = si; bn = n; }
                }
            });
            const strap = layout.straps[bs];
            const rows = strap.map((i, n) => {
                const k = 3 * i;
                const rel = new THREE.Vector3(s.x[k], s.x[k + 1], s.x[k + 2]).sub(position).applyQuaternion(qInv);
                return `${n}${s.bodyPressed[i] ? '*' : ''}(${rel.x.toFixed(2)},${rel.y.toFixed(2)},${rel.z.toFixed(2)})`;
            });
            const strains = strap.slice(1).map((j2, n) => {
                const a3 = 3 * strap[n], b3 = 3 * j2;
                const rest = layout.links.find(l => (l.i === strap[n] && l.j === j2) || (l.j === strap[n] && l.i === j2))!.rest;
                return (100 * (Math.hypot(s.x[b3] - s.x[a3], s.x[b3 + 1] - s.x[a3 + 1], s.x[b3 + 2] - s.x[a3 + 2]) / rest - 1)).toFixed(0);
            });
            console.log(`WORST f${f} ${STATE_NAME[state]} strap ${bs} link ${bn} ${(100 * best).toFixed(1)} %: strains ${strains.join(' ')} | ${rows.join(' ')}`);
        }
        if (process.env.WC_LINK && f >= Number(process.env.WC_F0 ?? 0) && f <= Number(process.env.WC_F1 ?? 1e9)) {
            const li = Number(process.env.WC_LINK);
            const l = layout.links[li];
            const anyS = s as unknown as { elCount: Int32Array; elValid: Uint8Array };
            const rel = (i: number) => new THREE.Vector3(s.x[3 * i], s.x[3 * i + 1], s.x[3 * i + 2]).sub(position).applyQuaternion(qInv);
            const a3 = rel(l.i), b3 = rel(l.j);
            const cross = penetration(s, af, position, qInv).throughLinks.includes(li);
            console.log(`LINK f${f} ${STATE_NAME[state]} (${a3.x.toFixed(3)},${a3.y.toFixed(3)},${a3.z.toFixed(3)}) -> (${b3.x.toFixed(3)},${b3.y.toFixed(3)},${b3.z.toFixed(3)}) pressed ${s.bodyPressed[l.i]}${s.bodyPressed[l.j]} edges ${anyS.elCount[li]} valid ${anyS.elValid[li]} through ${cross}`);
        }
        if (process.env.WC_TRACE && heldAt >= 0 && (f - heldAt) % 6 === 0) {
            const parts: string[] = [];
            for (const i of process.env.WC_TRACE.split(',').map(Number)) {
                parts.push(`p${i} v ${len(s.v, i).toFixed(2)} xyz ${(s.x[3 * i] - position.x).toFixed(3)} ${(s.x[3 * i + 1] - BARRICADE_DECK_Y).toFixed(3)} ${(s.x[3 * i + 2] - position.z).toFixed(3)} pr ${s.bodyPressed[i]}`);
            }
            console.log(`TRACE f+${f - heldAt} ${parts.join('  ')} contacts ${st.contacts}`);
        }
        const settleF = Math.round(SETTLE_S / DT);
        if (heldAt >= 0 && (f - heldAt) % SETTLE_WINDOW_F === 0) {
            if (windowFrom) {
                let m = 0;
                for (let i = 0; i < s.count; i++) {
                    const k = 3 * i;
                    m = Math.max(m, Math.hypot(s.x[k] - windowFrom[k], s.x[k + 1] - windowFrom[k + 1], s.x[k + 2] - windowFrom[k + 2]) / (SETTLE_WINDOW_F * DT));
                }
                if (m >= SETTLED_MPS) lastMoving = (f - heldAt) * DT;
                holdKE.push(m);
            }
            windowFrom = s.x.slice();
        }
        if (process.env.WC_RING && heldAt >= 0 && (f - heldAt) % 30 === 0) {
            const fromX = ringFrom ?? s.x.slice();
            let m = 0, ke = 0;
            for (let i = 0; i < s.count; i++) {
                const k = 3 * i;
                m = Math.max(m, Math.hypot(s.x[k] - fromX[k], s.x[k + 1] - fromX[k + 1], s.x[k + 2] - fromX[k + 2]) / (30 * DT));
                ke += 0.5 * layout.mass[i] * (s.v[k] ** 2 + s.v[k + 1] ** 2 + s.v[k + 2] ** 2);
            }
            console.log(`RING t+${((f - heldAt) * DT).toFixed(1)} s: displacement speed ${m.toFixed(3)} m/s, KE ${ke.toFixed(2)} J, max substep ${st.maxSpeed.toFixed(2)}`);
            ringFrom = s.x.slice();
        }
        if (heldAt >= 0 && f - heldAt === 60) holdSink0 = sinks();
        if (heldAt >= 0 && f - heldAt === 300) holdPower = (sinks() - holdSink0) / 4;
        if (heldAt >= 0 && f - heldAt === settleF - SETTLE_WINDOW_F) settleFrom = s.x.slice();
        if (heldAt >= 0 && f - heldAt === settleF) {
            settledSpeed = 0;
            for (let i = 0; i < s.count; i++) {
                const k = 3 * i;
                settledSpeed = Math.max(settledSpeed, Math.hypot(s.x[k] - settleFrom![k], s.x[k + 1] - settleFrom![k + 1], s.x[k + 2] - settleFrom![k + 2]) / (SETTLE_WINDOW_F * DT));
            }
            substepSpeed = st.maxSpeed;
            if (process.env.WC_PROBE) {
                const d = (i: number) => Math.hypot(s.x[3 * i] - settleFrom![3 * i], s.x[3 * i + 1] - settleFrom![3 * i + 1], s.x[3 * i + 2] - settleFrom![3 * i + 2]) / (SETTLE_WINDOW_F * DT);
                const order = Array.from({ length: s.count }, (_, i) => i).sort((p, q) => d(q) - d(p)).slice(0, 10);
                console.log(`MOVERS ${fixture} ${speed}: beltStrain ${st.maxBeltStrain.toFixed(3)} strapStrain ${st.maxStrapStrain.toFixed(3)} payout ${st.payout.map(p => p.toFixed(1)).join(' ')}; `
                    + order.map(i => `p${i} part ${layout.part[i]} pr ${s.bodyPressed[i]} y ${(s.x[3 * i + 1] - BARRICADE_DECK_Y).toFixed(2)} ${d(i).toFixed(2)}`).join(' | '));
            }
            if (process.env.WC_PROBE) {
                const rows: string[] = [];
                const order = Array.from({ length: s.count }, (_, i) => i)
                    .sort((p, q) => len(s.v, q) - len(s.v, p)).slice(0, 12);
                for (const i of order) rows.push(`p${i} part ${layout.part[i]} pressed ${s.bodyPressed[i]} x ${s.x[3 * i].toFixed(1)} y ${(s.x[3 * i + 1] - BARRICADE_DECK_Y).toFixed(2)} z ${s.x[3 * i + 2].toFixed(1)} v ${len(s.v, i).toFixed(2)} (${s.v[3 * i].toFixed(2)}, ${s.v[3 * i + 1].toFixed(2)}, ${s.v[3 * i + 2].toFixed(2)})`);
                let n = 0; for (let i = 0; i < s.count; i++) if (len(s.v, i) > SETTLED_MPS) n++;
                console.log(`PROBE ${fixture} ${speed} over ${SETTLED_MPS}: ${n} of ${s.count}; ` + rows.join(' | '));
            }
        }
    }
    const bodyWork = st.bodyWork - body0;
    const created = ((netEnergy(s) - e0) - (bodyWork - (sinks() - sinks0))) / Math.max(bodyWork, 1);
    return {
        fixture, speed, offset, frames: arrest.length - 1, deep, through, maxStrapStrain: maxStrap, strainAt,
        payoutExcess, payoutAt, loMargin, hiMargin, finalPayout: st.payout.slice(),
        settleTime: lastMoving, holdPowerW: holdPower, drape, drapeLeft, drapeRight, created, bodyWorkKJ: bodyWork / 1e3, settledSpeed, substepSpeed,
        msPerFrame: ms / (arrest.length - 1),
        pullPeakG: pullPeak, pullMeanG: pullN > 0 ? pullSum / pullN : 0, simPeakG: simPeak,
    };
}

function len(v: Float64Array, i: number): number {
    return Math.hypot(v[3 * i], v[3 * i + 1], v[3 * i + 2]);
}

let riggedMs = 0;

describe('barricade webbing: the sim\'s arrest', () => {
    it('matches the sim: run-out, 5 g cap, rebound and lean', () => {
        for (const speed of SPEEDS) {
            for (const x of [0, 3]) {
                const a = recordArrest(speed, x, 12, 1);
                const caught = a.findIndex(f => f.state !== BarricadeEngagement.NONE);
                const stop = a.findIndex(f => f.state === BarricadeEngagement.REBOUND);
                const held = a.findIndex(f => f.state === BarricadeEngagement.HELD);
                assert.ok(caught > 0 && stop > caught && held > stop, `${speed} m/s: states ${caught} ${stop} ${held}`);
                const runOut = a[caught].position.z - a[stop].position.z;
                // Within the run-out: slow catches stop short of it, rolling drag doing more than
                // the v²/2s the profile asks (0.17 m/s² at 5 m/s), fast ones use most of it.
                assert.ok(runOut <= BARRICADE_PULL_OUT_M + 1 && runOut > (speed > 20 ? 40 : 0), `${speed} m/s: run-out ${runOut.toFixed(1)} m`);
                let peak = 0;
                for (let f = caught + 2; f <= stop; f++) {
                    const acc = ((a[f].position.z - a[f - 1].position.z) - (a[f - 1].position.z - a[f - 2].position.z)) / DT / DT;
                    peak = Math.max(peak, acc);
                }
                assert.ok(peak <= BARRICADE_MAX_DECEL_MPS2 * 1.05, `${speed} m/s: peak ${(peak / G0).toFixed(2)} g`);
                const back = a[held].position.z - a[stop].position.z;
                assert.ok(Math.abs(back - BARRICADE_REBOUND_M) < 0.5, `${speed} m/s: rolled back ${back.toFixed(2)} m`);
                const r = new THREE.Vector3(1, 0, 0).applyQuaternion(a[a.length - 1].quaternion);
                const lean = Math.asin(Math.min(1, Math.abs(r.y)));
                assert.ok(Math.abs(lean - BARRICADE_TILT_RAD) < (1 * Math.PI) / 180, `${speed} m/s: lean ${(lean * 180 / Math.PI).toFixed(1)} deg`);
                // How still the held pose is: the sim's jet rests on its gear springs.
                let dpMax = 0, dqMax = 0;
                for (let f = held + 1; f < a.length; f++) {
                    dpMax = Math.max(dpMax, a[f].position.distanceTo(a[f - 1].position) / DT);
                    dqMax = Math.max(dqMax, a[f].quaternion.angleTo(a[f - 1].quaternion) / DT);
                }
                console.log(`held pose ${speed} m/s x ${x}: max speed ${dpMax.toFixed(4)} m/s, max rate ${dqMax.toFixed(4)} rad/s`);
                console.log(`arrest ${speed} m/s x ${x}: run-out ${runOut.toFixed(1)} m, peak ${(peak / G0).toFixed(2)} g, back ${back.toFixed(2)} m, lean ${(lean * 180 / Math.PI).toFixed(1)} deg, ${a.length} frames`);
            }
        }
    });

    it('rigged net cost, the reference for the catches', () => {
        const s = new WebSolver(buildRiggedWeb());
        for (let f = 0; f < 60; f++) s.step(DT);
        const t0 = cpuMs();
        for (let f = 0; f < 300; f++) s.step(DT);
        riggedMs = (cpuMs() - t0) / 300;
        console.log(`rigged: ${riggedMs.toFixed(2)} ms/frame`);
    });
});

for (const speed of SPEEDS) {
    describe(`barricade webbing: the sim's arrest at ${speed} m/s`, () => {
        for (const offset of OFFSETS) {
            const arrests = new Map<number, ArrestFrame[]>();
            for (const fixture of WEB_FIXTURES) {
                it(`${fixture}, ${offset === 0 ? 'centred' : `${offset > 0 ? '+' : ''}${offset} m`}`, () => {
                    const af = loadWebAirframe(fixture);
                    // Nose 2 m short of the net, as in phase 1.
                    const aft = Math.round((af.bounds[5] + 2) * 10) / 10;
                    let arrest = arrests.get(aft);
                    if (!arrest) arrests.set(aft, arrest = recordArrest(speed, offset, aft, Number(process.env.WC_HOLD ?? SETTLE_S + 0.5)));
                    const r = runCatch(fixture, speed, offset, arrest);
                    const line = `${fixture} @ ${speed} m/s, x ${offset}: ${JSON.stringify({
                        frames: r.frames, deep: r.deep, through: r.through,
                        strain: +r.maxStrapStrain.toFixed(3), strainAt: r.strainAt,
                        payoutExcess: +r.payoutExcess.toFixed(2), payoutAt: r.payoutAt,
                        payoutMargins: [+r.loMargin.toFixed(1), +r.hiMargin.toFixed(1)],
                        finalPayout: r.finalPayout.map(p => +p.toFixed(1)),
                        drape: r.drape, drapeLeft: r.drapeLeft, drapeRight: r.drapeRight,
                        created: +r.created.toFixed(4), bodyWorkKJ: +r.bodyWorkKJ.toFixed(1),
                        settled: +r.settledSpeed.toFixed(3), settleTime: +r.settleTime.toFixed(1), holdPowerW: +r.holdPowerW.toFixed(0), substepSpeed: +r.substepSpeed.toFixed(2),
                        ms: +r.msPerFrame.toFixed(2), vsRigged: riggedMs > 0 ? +(r.msPerFrame / riggedMs).toFixed(2) : null,
                        pullPeakG: +r.pullPeakG.toFixed(2), pullMeanG: +r.pullMeanG.toFixed(2), simPeakG: +r.simPeakG.toFixed(2),
                    })}`;
                    console.log(line);
                    const fails: string[] = [];
                    if (r.deep > 0) fails.push(`${r.deep} particles deeper than the skin`);
                    if (r.through > 0) fails.push(`${r.through} links through the skin`);
                    if (r.maxStrapStrain >= MAX_STRAP_STRAIN) fails.push(`strap strain ${(100 * r.maxStrapStrain).toFixed(1)} %`);
                    if (r.payoutExcess > 0) fails.push(`payout outside its bound: ${r.payoutAt}`);
                    if (r.drape < MIN_DRAPE || r.drapeLeft === 0 || r.drapeRight === 0) fails.push(`drape ${r.drape} (${r.drapeLeft} / ${r.drapeRight})`);
                    if (r.created > MAX_CREATED) fails.push(`${(100 * r.created).toFixed(1)} % energy created`);
                    if (!(r.settledSpeed < SETTLED_MPS)) fails.push(`${r.settledSpeed.toFixed(2)} m/s ${SETTLE_S} s into the hold`);
                    if (r.msPerFrame > MAX_MS_PER_FRAME) fails.push(`${r.msPerFrame.toFixed(2)} ms/frame`);
                    assert.deepEqual(fails, [], line);
                });
            }
        }
    });
}
