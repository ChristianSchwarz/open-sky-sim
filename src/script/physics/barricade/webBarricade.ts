/**
 * The rigid-body barricade webbing as the sim runs it: one web per rigged
 * barricade, in carrier-local space (barricadeSpec.ts), stepped with the
 * aircraft it holds as a body moving from its last pose to this one. The
 * sim takes the web's reaction and puts it into that aircraft's flight
 * model (see CombatSim), so the net, not a scripted run-out, stops it.
 */
import * as THREE from 'three';
import { buildTriangleBvh, bvhClosest, bvhClosestPoint } from '../collision/triangleBvh';
import { buildWebCollider, closeGearGaps, WebCollider } from './webCollider';
import { decimateSoup } from './webDecimate';
import { BARRICADE_DECK_Y, BARRICADE_LOCAL_Z, BARRICADE_MID_X } from '../../scene/entities/barricadeSpec';
import { buildRiggedWeb, WebLayout } from './webLayout';
import { WebSolver, WebSolverState } from './webSolver';

/**
 * Collision-mesh sizes tried, smallest first (triangles). 3,000 covered the
 * F-22 and F-16s' drawn skins within the coverage gate (p99 3 cm), the
 * F-14, drawn in more separate parts, needed 6,000 (webFixtures.testkit).
 */
const COLLIDER_TRIS = [3000, 6000];
/** The drawn skin must lie this close to the collision mesh at the 99th percentile (m). */
const COVERAGE_P99_M = 0.03;
/** Drawn vertices sampled for that check. */
const COVERAGE_SAMPLES = 3000;

/**
 * The quality step: a web holding an airframe that needed the larger
 * collision mesh steps at fewer substeps. Pinned to the performance cores,
 * the F-14 (6,000 triangles) cost 7.1 ms a frame at 32 substeps and 4.5 ms
 * at 24 in a 45 m/s catch, stopping in the same 80 m; the F-22 (780) 3.5 ms
 * at 32. The worker's budget for the web is 5 ms.
 */
export function substepsFor(collider: AirframeCollider): number {
    return collider.triangles > COLLIDER_TRIS[0] ? 24 : 32;
}

/** An airframe's collision mesh for the webbing, from its drawn soup (body frame, +Z forward). */
export interface AirframeCollider {
    readonly collider: WebCollider;
    readonly triangles: number;
    /** How close the drawn skin lies to it (m, 99th percentile). */
    readonly coverageP99: number;
    /** Its bounds (body frame: min xyz, max xyz). */
    readonly box: readonly number[];
}

/**
 * The webbing's collision mesh from an airframe as drawn: the gear gaps
 * closed (struts up to floating gear, hanging wheels let down to the deck),
 * then decimated to the smallest size that still covers the drawn skin.
 */
export function buildAirframeCollider(drawn: ArrayLike<number>): AirframeCollider {
    const prepared = prepareAirframeSoup(drawn);
    return colliderFromPrepared(prepared.triangles, prepared.coverageP99);
}

/**
 * The heavy half of buildAirframeCollider: the collision soup itself and its
 * coverage. A second or two for a 25k-triangle drawn airframe (the F-14's
 * 2.2 s), so the game runs it in its own worker (webAirframeWorker.ts), not
 * in the sim's, which it stalled.
 */
export function prepareAirframeSoup(drawn: ArrayLike<number>): { triangles: Float32Array; coverageP99: number } {
    const soup = closeGearGaps(Float32Array.from(drawn));
    const near = bvhClosest();
    const vertices = drawn.length / 3;
    const stride = Math.max(1, Math.floor(vertices / COVERAGE_SAMPLES));
    let best: { triangles: Float32Array; coverageP99: number } | undefined;
    for (const target of COLLIDER_TRIS) {
        const tri = soup.length / 9 > target ? decimateSoup(soup, target) : soup;
        const bvh = buildTriangleBvh(tri);
        const d: number[] = [];
        for (let v = 0; v < vertices; v += stride) {
            const k = 3 * v;
            d.push(bvhClosestPoint(bvh, drawn[k], drawn[k + 1], drawn[k + 2], 1, near) ? Math.sqrt(near.distSq) : 1);
        }
        d.sort((a, b) => a - b);
        const p99 = d[Math.floor(0.99 * (d.length - 1))] ?? 0;
        best = { triangles: tri, coverageP99: p99 };
        if (p99 <= COVERAGE_P99_M || tri === soup) break;
    }
    return best!;
}

/**
 * The buffers of an airframe's collider, to transfer it between workers: it
 * is plain typed arrays, so the airframe worker builds it whole and the sim
 * only stores it (the edge build cost the sim's worker 10-25 ms a frame).
 */
export function airframeBuffers(a: AirframeCollider): ArrayBuffer[] {
    const c = a.collider, b = c.bvh;
    return [b.tri, b.triIndex, b.bounds, b.leftFirst, b.triCount, c.edges, c.edgeBounds, c.edgeLeftFirst, c.edgeCount, c.edgeIndex]
        .map(t => t.buffer as ArrayBuffer)
        .filter((buf, i, all) => all.indexOf(buf) === i);
}

/** The cheap half: the webbing's collider from a prepared collision soup (10-25 ms). */
export function colliderFromPrepared(triangles: Float32Array, coverageP99: number): AirframeCollider {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < triangles.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            box[k] = Math.min(box[k], triangles[i + k]);
            box[3 + k] = Math.max(box[3 + k], triangles[i + k]);
        }
    }
    return { collider: buildWebCollider(triangles), triangles: triangles.length / 9, coverageP99, box };
}

/** The aircraft the web holds this step, carrier-local. */
export interface BarricadeWebBody {
    readonly collider: WebCollider;
    readonly position: THREE.Vector3;
    readonly quaternion: THREE.Quaternion;
    /** Where it was last step; the web is stepped with it moving from there. */
    readonly prevPosition: THREE.Vector3;
    readonly prevQuaternion: THREE.Quaternion;
}

/**
 * A web left alone sleeps once it has hung this still (m/s) for this many
 * steps: a rigged net costs nothing until something comes near it. The
 * rigged net rings on at about 0.06 m/s (the phase-1 gate allows 0.15):
 * at 0.05 it never slept and cost the worker a step every frame.
 */
const SLEEP_SPEED_MPS = 0.15;
const SLEEP_STEPS = 60;
/**
 * A web holding a body that has stood still this many steps sleeps however
 * it still moves: a stopped jet in the net, after the straps' pendulum
 * ring-down (4-6 s). Held still, the F-22 and F-14's webbing went on
 * chattering at contacts (particles at 1-2.5 m/s for 15 s and more, a few
 * mm each way) and cost 3-4 ms a step for as long as the jet stood there.
 */
const HELD_SETTLE_STEPS = 360;
/** A held body moving less than this a step (m, and 1 - |q.q'|) counts as still. */
const BODY_STILL_M = 1e-3;
const BODY_STILL_ROT = 1e-8;

/**
 * The web's budget a frame (ms, whatever the step's length). Each step chooses its substeps up front from the cost a substep
 * has been taking (PACE_SMOOTHING): as many as fit, up to the airframe's
 * quality (substepsFor), never fewer than MIN_SUBSTEPS. A step that still
 * runs late finishes in fewer, longer substeps (WebSolver.step's deadline,
 * at the same budget). An averaged governor before it never acted: the
 * deadline cut every heavy frame to its floor, longer substeps bunched at
 * the frame's end.
 *
 * MIN_SUBSTEPS: whole catches held at a fixed count (F-22, F-14, 45 and
 * 60 m/s, 0 and 3 m off): at 12 no link crossed the drawn skin and the
 * run-outs were within 5 m of 24's; at 10-11 the F-14 at 60 m/s put 3-8
 * links through it, at 8 everything did and it ran out 114 m, past the
 * MK-7's 105. Below 25 m/s, 8 still let 1-2 through. A still body (held,
 * stopped) sweeps nothing through the webbing: MIN_SUBSTEPS_STILL.
 */
const BUDGET_MS = 4;
const MIN_SUBSTEPS = 12;
const MIN_SUBSTEPS_STILL = 8;
const PACE_SMOOTHING = 0.3;
/** Substeps for a web with nothing in reach (a 1/60 s step), the solver's own default. */
const SUBSTEPS_ALONE = 32;

/**
 * A new web hangs itself under its own weight in SETTLE_STEPS steps, as
 * many a frame as fit in SETTLE_BUDGET_MS (at least one): done at once in
 * the constructor it stalled the sim's worker 200 ms at every rigging. The
 * rigged net is the same every time it is laced, so the first web's settled
 * state starts every later one. Each settling step is a full one: cut short
 * by a deadline (down to 4 substeps) the stiff upper belt overshot its
 * pendants' 25 kN slip as it took up its load, they paid out 0.4-0.9 m,
 * and the cached net hung 2.3 m slack in the middle (rigged, 0.29 m) at
 * every spawn and K, worse at each catch.
 */
const SETTLE_STEPS = 120;
const SETTLE_BUDGET_MS = 3;
let settledRig: WebSolverState | undefined;

/**
 * A warm-up catch, once per worker: a throwaway copy of the webbing with a
 * plain box airframe (warmAirframe) swept through it at WARM_SPEED_MPS for
 * WARM_STEPS steps of WARM_SUBSTEPS, one a frame while the real webbing
 * touches nothing and costs under WARM_WHEN_UNDER_MS. The contact code runs
 * cold the first time, before the JIT has optimised it: the first catch of
 * a session cost 7-13 ms a step where the same catch again cost 4. A plain
 * box first, since a real airframe can come too late (the barricade-arrival
 * spawn is in reach 0.6 s after spawning, before its drawn airframe has been
 * decimated); then each real airframe once, as it comes, for the deeper
 * tree queries of a big mesh (the F-14's 6k triangles still cost 5.7 ms at
 * first contact after the box alone).
 */
const WARM_STEPS = 60;
const WARM_SUBSTEPS = 8;
const WARM_SPEED_MPS = 45;
const WARM_WHEN_UNDER_MS = 2.5;
/** A warm-up step's deadline (ms): cold, it takes a substep or two a frame, and is done once WARM_STEPS x WARM_SUBSTEPS substeps have run. */
const WARM_BUDGET_MS = 2;
let warmDone = false;
const warmedAirframes = new WeakSet<WebCollider>();
let warming: { solver: WebSolver; collider: WebCollider; substeps: number; at: THREE.Vector3; prevAt: THREE.Vector3; quaternion: THREE.Quaternion } | undefined;

/** A fighter-sized box airframe (body frame, +Z forward, wheels at y 0): fuselage, wing, fin, gear legs. */
function warmAirframe(): WebCollider {
    const tris: number[] = [];
    const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
        const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
        for (const [a, b, d] of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]]) {
            tris.push(...c[a], ...c[b], ...c[d]);
        }
    };
    box(-1, 0.4, -8, 1, 2.6, 8);
    box(-6, 1.5, -4, 6, 1.8, 1);
    box(-0.2, 2.6, -8, 0.2, 5, -5);
    box(-1.6, 0, -1.2, -1.2, 1.5, -0.8);
    box(1.2, 0, -1.2, 1.6, 1.5, -0.8);
    box(-0.2, 0, 4.8, 0.2, 0.5, 5.2);
    return buildWebCollider(Float32Array.from(tris));
}

/**
 * One step of the warm-up catch (see WARM_STEPS), with the box airframe or
 * else `airframe` if it has not been flown; its cost (ms).
 */
function warmUpStep(layout: WebLayout, dt: number, airframe?: AirframeCollider): number {
    const t0 = performance.now();
    if (!warming) {
        if (warmDone && (!airframe || warmedAirframes.has(airframe.collider))) return 0;
        // Heading aft (-z), wheels on the deck, nose a metre short of the webbing.
        const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const solver = new WebSolver(layout, { substeps: WARM_SUBSTEPS });
        if (settledRig) solver.restoreState(settledRig);
        const box = warmDone ? airframe!.box : [-6, 0, -8, 6, 5, 8];
        const at = new THREE.Vector3(BARRICADE_MID_X + 1, BARRICADE_DECK_Y - box[1], BARRICADE_LOCAL_Z + box[5] + 1);
        warming = { solver, collider: warmDone ? airframe!.collider : warmAirframe(), substeps: 0, at, prevAt: at.clone(), quaternion };
        // Built this frame, flown from the next.
        return performance.now() - t0;
    }
    const w = warming;
    w.prevAt.copy(w.at);
    w.at.z -= WARM_SPEED_MPS * dt;
    w.solver.step(dt, { collider: w.collider, position: w.at, quaternion: w.quaternion, prevPosition: w.prevAt, prevQuaternion: w.quaternion },
        Math.max(0, WARM_BUDGET_MS - (performance.now() - t0)));
    w.substeps += w.solver.lastSubsteps;
    if (w.substeps >= WARM_STEPS * WARM_SUBSTEPS) {
        if (warmDone) warmedAirframes.add(w.collider);
        warmDone = true;
        warming = undefined;
    }
    return performance.now() - t0;
}

/** One barricade's webbing, from lacing to striking (one rig generation). */
export class BarricadeWeb {
    readonly layout: WebLayout;
    readonly solver: WebSolver;
    private quiet = 0;
    private bodyStill = 0;
    private settleLeft = 0;
    /** Solver time of the last step (ms), for the budget, and its running mean. */
    lastStepMs = 0;
    /** The dearest step since {@link takePeakMs} last read it (ms). */
    private peakMs = 0;
    /** What a substep has been costing (ms), for the next step's count. */
    private paceMs = 0;
    /** The pose (carrier-local position, quaternion) of the body last stepped with, or NaN without one. */
    readonly bodyPose = new Float64Array(7).fill(NaN);

    constructor(readonly generation: number, substeps?: number) {
        // Engines set for a mid-weight fighter until an aircraft is in reach (setEngineMass).
        this.layout = buildRiggedWeb({ engineSetKg: 20e3 });
        this.solver = new WebSolver(this.layout, { substeps });
        // Hung under its own weight, as the crew leaves it rigged (see SETTLE_STEPS).
        if (settledRig) this.solver.restoreState(settledRig);
        else this.settleLeft = SETTLE_STEPS;
    }

    /** Settled, and the contact code warm (see WARM_STEPS): ready for a catch at full speed. */
    get ready(): boolean {
        return this.settleLeft === 0 && warmDone;
    }

    /** Whether `airframe` has had its own warm-up catch (see WARM_STEPS). */
    isWarm(airframe: AirframeCollider): boolean {
        return warmedAirframes.has(airframe.collider);
    }

    /** The airframe the next idle frames warm up with, once the box has been flown. */
    warmWith: AirframeCollider | undefined;

    /** The dearest step since the last call (ms): a snapshot goes out less often than the sim steps. */
    takePeakMs(): number {
        const peak = Math.max(this.peakMs, this.lastStepMs);
        this.peakMs = 0;
        return peak;
    }

    get asleep(): boolean {
        return this.quiet >= SLEEP_STEPS;
    }

    /**
     * Advance by dt with `body` in the net, or alone (asleep once still).
     * `maxSubsteps` is the quality the airframe asks for (substepsFor), per
     * 1/60 s; the step takes as many of them as fit in BUDGET_MS, and no fewer
     * than MIN_SUBSTEPS.
     */
    step(dt: number, body: BarricadeWebBody | null, maxSubsteps = 32): void {
        // Dev trace (set globalThis.__webTrace = [] in the worker): one row a step.
        const trace = (globalThis as { __webTrace?: number[][] }).__webTrace;
        const st = this.solver.stats;
        const t0 = trace ? performance.now() : 0, pq = st.pointQueries, eq = st.edgeQueries, lo = st.listOverflows;
        this.stepOnce(dt, body, maxSubsteps);
        this.peakMs = Math.max(this.peakMs, this.lastStepMs);
        if (trace) {
            trace.push([t0, this.lastStepMs, this.solver.lastSubsteps, this.solver.substeps, st.contacts,
                st.pointQueries - pq, st.edgeQueries - eq, st.listOverflows - lo, body ? 1 : 0, this.asleep ? 1 : 0, warming ? 1 : 0, dt]);
        }
    }

    private stepOnce(dt: number, body: BarricadeWebBody | null, maxSubsteps: number): void {
        if (this.settleLeft > 0) {
            // An aircraft already in reach finds it hung: the rest of the settling at once.
            const t0 = performance.now();
            let spent = 0, last = 0;
            while (this.settleLeft > 0 && (body || spent + last < SETTLE_BUDGET_MS || last === 0)) {
                const s0 = performance.now();
                // At full quality: no deadline on a settling step (see SETTLE_STEPS).
                this.solver.step(1 / 60);
                this.settleLeft--;
                const now = performance.now();
                last = now - s0;
                spent = now - t0;
            }
            if (this.settleLeft === 0) settledRig ??= this.solver.saveState();
            if (!body) {
                this.lastStepMs = performance.now() - t0;
                this.bodyPose.fill(NaN);
                return;
            }
        }
        // A body that has not moved (held, stopped) lets a still web sleep too; one that moves wakes it.
        const still = !body || (body.position.distanceToSquared(body.prevPosition) < BODY_STILL_M ** 2
            && Math.abs(body.quaternion.dot(body.prevQuaternion)) > 1 - BODY_STILL_ROT);
        if (!still) this.quiet = 0;
        this.bodyStill = body && still ? this.bodyStill + 1 : 0;
        if (body) {
            body.position.toArray(this.bodyPose, 0);
            body.quaternion.toArray(this.bodyPose, 3);
        } else {
            this.bodyPose.fill(NaN);
        }
        if (still && this.asleep) {
            this.lastStepMs = warmUpStep(this.layout, dt, this.warmWith);
            // Asleep, it pushes on nothing.
            const st = this.solver.stats;
            st.reaction[0] = st.reaction[1] = st.reaction[2] = 0;
            st.reactionMoment[0] = st.reactionMoment[1] = st.reactionMoment[2] = 0;
            return;
        }
        // The counts for this step's length: a longer step (the main thread slower than 60 fps, the
        // sim's step following its frame) needs as many substeps a second, or links go through the
        // skin (13-14 at 1/30 s with 1/60 s's 12). The budget stays a frame's: the web's share of a
        // slow frame does not grow with it, unless the floor alone costs more.
        const scale = Math.max(1, dt * 60);
        const most = Math.round(maxSubsteps * scale);
        const least = Math.ceil((still ? MIN_SUBSTEPS_STILL : MIN_SUBSTEPS) * scale);
        const budget = BUDGET_MS;
        const fit = this.paceMs > 0 ? Math.floor(budget / this.paceMs) : most;
        // Alone, it takes the full count, with no deadline: it costs little and soon sleeps, and
        // fewer let the upper belt's pretension (20 kN) pull its pendants past their 25 kN slip.
        const n = body ? Math.min(most, Math.max(least, fit)) : Math.round(SUBSTEPS_ALONE * scale);
        if (n !== this.solver.substeps) this.solver.setSubsteps(n);
        const t0 = performance.now();
        this.solver.step(dt, body ?? undefined, body ? budget : Infinity, least);
        this.lastStepMs = performance.now() - t0;
        const pace = this.lastStepMs / Math.max(1, this.solver.lastSubsteps);
        this.paceMs = this.paceMs > 0 ? this.paceMs + (pace - this.paceMs) * PACE_SMOOTHING : pace;
        this.quiet = still && (this.solver.stats.maxSpeed < SLEEP_SPEED_MPS || this.bodyStill >= HELD_SETTLE_STEPS) ? this.quiet + 1 : 0;
        if ((!warmDone || warming || (this.warmWith && !this.isWarm(this.warmWith)))
            && this.solver.stats.contacts === 0 && this.lastStepMs < WARM_WHEN_UNDER_MS) {
            this.lastStepMs += warmUpStep(this.layout, dt, this.warmWith);
        }
    }

    /** The particles' positions, carrier-local (xyz interleaved), into a fresh array to transfer. */
    positions(): Float32Array {
        return Float32Array.from(this.solver.x);
    }
}
