/**
 * Motion for the drawn barricade: the webbing gets picked up, not swapped in.
 *
 * barricadeWrap.ts gives the shape the net has for a pose, and that shape
 * jumps from flat curtain to finished wrap on the frame the sim reports the
 * catch. This puts motion back without a solver: every node of the two load
 * straps is a damped spring pulled toward its place in that shape. Nodes on
 * the airframe are stiff and critically damped, since the wing holds them.
 * The free tails out to the shackles are soft and underdamped, so they fall
 * off the stanchion tops, swing, and settle.
 *
 * The springs live in the aircraft's frame, so the jet's own deceleration
 * acts on them: the loose webbing surges forward through the run-out and
 * swings back when the jet stops. There are no constraints between nodes.
 * Each node only ever heads for a valid shape, so this can lag but cannot
 * knot. It is drawing only; the sim never sees it.
 *
 * Carrier-local coordinates throughout, like barricadeWrap.ts.
 */
import * as THREE from 'three';
import { BARRICADE_DECK_Y } from './barricadeSpec';
import { BarricadeNetShape } from './barricadeWrap';

type V3 = THREE.Vector3;

/** Nodes per load strap. */
const UPPER_NODES = 64;
const LOWER_NODES = 40;
/** Spring rate (1/s²) and damping ratio of a node held by the airframe... */
const STIFF_K = 1600;
const STIFF_ZETA = 1;
/** ...and of a free tail. ~1.2 Hz, so a swing reads at a glance. */
const SOFT_K = 60;
const SOFT_ZETA = 0.3;
/** Beyond the wingtip by this much a node is fully free; this far inside, fully held (m). */
const FREE_BEYOND_TIP_M = 2;
const HELD_INSIDE_TIP_M = 0.5;
/**
 * Share of the jet's closing speed a free node starts with, backwards in the
 * jet's frame. The tails were standing still, but they are sewn to webbing
 * that is already moving at full speed.
 */
const TAIL_LAG = 0.25;
/** Largest integration step (s). */
const MAX_SUBSTEP_S = 1 / 240;
/** Low-pass time constant for the jet's acceleration (s). */
const ACCEL_SMOOTH_S = 0.05;
/** Deck friction on a node lying on it, per substep. */
const DECK_FRICTION = 0.9;
/** A vertical strap is drawn hooked once its top is this close to where the wrap puts it (m). */
const HOOK_SNAP_M = 0.8;
const DECK_CLEARANCE_M = 0.04;

/** One strap's nodes: offsets from the aircraft CG and their velocities. */
class StrapNodes {
    readonly offset: V3[] = [];
    readonly vel: V3[] = [];
    readonly k: number[] = [];
    readonly c: number[] = [];

    constructor(readonly count: number) {
        for (let i = 0; i < count; i++) {
            this.offset.push(new THREE.Vector3());
            this.vel.push(new THREE.Vector3());
            this.k.push(SOFT_K);
            this.c.push(0);
        }
    }
}

export class BarricadeNetMotion {
    private readonly upper = new StrapNodes(UPPER_NODES);
    private readonly lower = new StrapNodes(LOWER_NODES);
    private running = false;
    private readonly prevPos = new THREE.Vector3();
    private readonly prevVel = new THREE.Vector3();
    private hasPrevVel = false;
    private readonly accel = new THREE.Vector3();

    /** True between {@link begin} and {@link reset}. */
    get active(): boolean {
        return this.running;
    }

    /** Drop all motion; the next {@link begin} starts fresh. */
    reset(): void {
        this.running = false;
        this.hasPrevVel = false;
        this.accel.set(0, 0, 0);
    }

    /**
     * The catch: start each node from the rigged curtain, or from the wrap
     * where the airframe already holds it.
     * @param rest the shape the instant before (curtain between the stanchions)
     * @param target the wrap for this pose
     * @param closingVel the jet's velocity relative to the ship
     * @param halfSpan the jet's half-span (m)
     */
    begin(rest: BarricadeNetShape, target: BarricadeNetShape, aircraft: V3, closingVel: V3, halfSpan: number): void {
        this.running = true;
        this.prevPos.copy(aircraft);
        this.prevVel.copy(closingVel);
        this.hasPrevVel = true;
        this.accel.set(0, 0, 0);
        this.seed(this.upper, resample(rest.upper, UPPER_NODES), resample(target.upper, UPPER_NODES), aircraft, closingVel, halfSpan);
        this.seed(this.lower, resample(rest.lower, LOWER_NODES), resample(target.lower, LOWER_NODES), aircraft, closingVel, halfSpan);
    }

    /**
     * Advance by `dt` toward `target` and return the shape to draw.
     * Stanchions and anything not on a load strap follow from the nodes.
     */
    step(dt: number, target: BarricadeNetShape, aircraft: V3, halfSpan: number): BarricadeNetShape {
        if (!this.running) return target;
        const upperTarget = resample(target.upper, UPPER_NODES);
        const lowerTarget = resample(target.lower, LOWER_NODES);
        if (dt > 0) {
            this.trackAircraft(dt, aircraft);
            setStiffness(this.upper, upperTarget, aircraft, halfSpan);
            setStiffness(this.lower, lowerTarget, aircraft, halfSpan);
            const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP_S));
            const h = dt / n;
            for (let s = 0; s < n; s++) {
                this.integrate(this.upper, upperTarget, aircraft, h);
                this.integrate(this.lower, lowerTarget, aircraft, h);
            }
        }
        const upper = this.upper.offset.map(o => o.clone().add(aircraft));
        const lower = this.lower.offset.map(o => o.clone().add(aircraft));
        // Both straps end in the one shackle per side, the lower strap's end
        // (the joint) as far below the upper's as the wrap holds it: caught,
        // that is off the deck at the gear, not up at the shackle.
        for (const [lo, up] of [[0, 0], [lower.length - 1, upper.length - 1]]) {
            lower[lo].copy(upper[up]).setY(upper[up].y + lowerTarget[lo].y - upperTarget[up].y);
        }

        // Vertical straps ride the moving straps at their stations, keeping
        // whatever the wrap did to them (pushed aside by the nose, hooked).
        const verticals: V3[][] = [];
        const count = target.verticals.length;
        for (let j = 0; j < count; j++) {
            const u = (j + 1) / (count + 1);
            const tv = target.verticals[j];
            const top = sampleAt(upper, u).add(tv[0].clone().sub(sampleAt(upperTarget, u)));
            // The top rides the moving upper strap; the bottom its side's joint,
            // the moving lower strap's end.
            const side = j < count / 2 ? 0 : lower.length - 1;
            const bottom = tv[tv.length - 1].clone().add(lower[side].clone().sub(lowerTarget[side]));
            if (target.slung[j] && top.distanceTo(tv[0]) < HOOK_SNAP_M) {
                // Folded over the wing: the wing holds its middle in place.
                verticals.push([top, ...tv.slice(1, -1).map(p => p.clone()), bottom]);
            } else if (target.slung[j]) {
                verticals.push([top, bottom]);
            } else {
                // A free strap keeps its shape and rides its two ends.
                const dTop = top.clone().sub(tv[0]);
                const dBottom = bottom.clone().sub(tv[tv.length - 1]);
                const n = tv.length - 1;
                verticals.push(tv.map((p, i) => p.clone().add(dTop.clone().lerp(dBottom, n > 0 ? i / n : 0))));
            }
        }
        // The straps' feet ride a resampled lower strap while it moves; keep them on the deck.
        const floor = BARRICADE_DECK_Y + DECK_CLEARANCE_M;
        for (const v of verticals) for (const p of v) p.y = Math.max(p.y, floor);
        // Purchase cables to the lower strap's ends, pendants to the upper's.
        const ends = [lower[0], lower[lower.length - 1]];
        const cables = target.cables.map((c, s) => [c[0].clone(), (ends[s] ?? c[1]).clone()]);
        // The glove is held by the wing itself: it goes where the wing goes.
        return { stanchions: target.stanchions, upper, lower, verticals, cables, glove: target.glove, slung: target.slung };
    }

    private seed(nodes: StrapNodes, rest: V3[], target: V3[], aircraft: V3, closingVel: V3, halfSpan: number): void {
        for (let i = 0; i < nodes.count; i++) {
            const held = heldness(target[i], aircraft, halfSpan);
            nodes.offset[i].lerpVectors(rest[i], target[i], held).sub(aircraft);
            nodes.vel[i].copy(closingVel).multiplyScalar(-TAIL_LAG * (1 - held));
        }
    }

    /** The jet's acceleration in the ship frame, from its drawn positions. */
    private trackAircraft(dt: number, aircraft: V3): void {
        const vel = aircraft.clone().sub(this.prevPos).divideScalar(dt);
        if (this.hasPrevVel) {
            const raw = vel.clone().sub(this.prevVel).divideScalar(dt);
            this.accel.lerp(raw, Math.min(1, dt / ACCEL_SMOOTH_S));
        }
        this.prevVel.copy(vel);
        this.hasPrevVel = true;
        this.prevPos.copy(aircraft);
    }

    private integrate(nodes: StrapNodes, target: V3[], aircraft: V3, h: number): void {
        const floor = BARRICADE_DECK_Y + DECK_CLEARANCE_M - aircraft.y;
        for (let i = 0; i < nodes.count; i++) {
            const o = nodes.offset[i];
            const v = nodes.vel[i];
            const k = nodes.k[i];
            const c = nodes.c[i];
            // Spring toward the wrap, damping, and the frame's own deceleration.
            const ax = k * (target[i].x - aircraft.x - o.x) - c * v.x - this.accel.x;
            const ay = k * (target[i].y - aircraft.y - o.y) - c * v.y - this.accel.y;
            const az = k * (target[i].z - aircraft.z - o.z) - c * v.z - this.accel.z;
            v.x += ax * h;
            v.y += ay * h;
            v.z += az * h;
            o.addScaledVector(v, h);
            if (o.y < floor) {
                o.y = floor;
                if (v.y < 0) v.y = 0;
                v.x *= DECK_FRICTION;
                v.z *= DECK_FRICTION;
            }
        }
    }
}

/** 0 for a free tail, 1 for a node the airframe holds, by how far out past the tip it sits. */
function heldness(p: V3, aircraft: V3, halfSpan: number): number {
    const out = Math.abs(p.x - aircraft.x) - halfSpan;
    return 1 - THREE.MathUtils.smoothstep(out, -HELD_INSIDE_TIP_M, FREE_BEYOND_TIP_M);
}

function setStiffness(nodes: StrapNodes, target: V3[], aircraft: V3, halfSpan: number): void {
    for (let i = 0; i < nodes.count; i++) {
        const held = heldness(target[i], aircraft, halfSpan);
        const k = THREE.MathUtils.lerp(SOFT_K, STIFF_K, held);
        const zeta = THREE.MathUtils.lerp(SOFT_ZETA, STIFF_ZETA, held);
        nodes.k[i] = k;
        nodes.c[i] = 2 * zeta * Math.sqrt(k);
    }
}

/** `count` points evenly spaced by arc length along a polyline. */
export function resample(pts: readonly V3[], count: number): V3[] {
    const out: V3[] = [];
    if (pts.length === 0) {
        for (let i = 0; i < count; i++) out.push(new THREE.Vector3());
        return out;
    }
    for (let i = 0; i < count; i++) out.push(sampleAt(pts, count > 1 ? i / (count - 1) : 0));
    return out;
}

/** The point a fraction `u` of the way along a polyline, by arc length. */
function sampleAt(pts: readonly V3[], u: number): V3 {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += pts[i - 1].distanceTo(pts[i]);
    let s = THREE.MathUtils.clamp(u, 0, 1) * total;
    for (let i = 1; i < pts.length; i++) {
        const seg = pts[i - 1].distanceTo(pts[i]);
        if (s <= seg) {
            return new THREE.Vector3().lerpVectors(pts[i - 1], pts[i], seg > 1e-9 ? s / seg : 0);
        }
        s -= seg;
    }
    return pts[pts.length - 1].clone();
}
