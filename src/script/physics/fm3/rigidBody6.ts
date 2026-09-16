/**
 * FM3's rigid body: Newton–Euler with the full inertia tensor, spinning-rotor
 * angular momentum, and classic fourth-order Runge–Kutta.
 *
 *     m · v̇ = F                      (world frame, gravity included by the caller)
 *     I · ω̇ = M − ω × (I · ω + h)     (body frame; h = rotor angular momentum)
 *     q̇     = ½ · q ⊗ (ω, 0)          (q rotates body → world)
 *
 * Unlike FM2's integrator there is no limit on the angular rate: a spin or a
 * tumble keeps whatever rate the moments give it. What there is instead is a
 * guard — a step that produces a non-finite state is rolled back and reported,
 * so a bad input shows up as a flag rather than NaN poisoning the sim.
 *
 * State and scratch are preallocated; a step allocates nothing.
 */

/**
 * Evaluates the loads at a trial state. Writes the net world-frame force (N,
 * gravity included) into `forceWorld` and the net body-frame moment about the
 * CG (N·m) into `momentBody`. `stage` is 0–3 within one RK4 step.
 */
export type WrenchFunction = (
    pos: Float64Array, vel: Float64Array, quat: Float64Array, omega: Float64Array,
    stage: number, forceWorld: Float64Array, momentBody: Float64Array,
) => void;

const N = 13;

/** A 13-component state vector with named views onto it. */
class StateVector {
    readonly data = new Float64Array(N);
    readonly pos = this.data.subarray(0, 3);
    readonly vel = this.data.subarray(3, 6);
    /** x, y, z, w. */
    readonly quat = this.data.subarray(6, 10);
    readonly omega = this.data.subarray(10, 13);
}

export class RigidBody6 {
    mass = 1;
    /** Body-frame inertia tensor, row-major (kg·m²). */
    readonly inertia = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    readonly inertiaInv = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    /** Body-frame angular momentum of spinning machinery, e.g. an engine rotor (kg·m²/s). */
    readonly rotorMomentum = new Float64Array(3);

    private readonly s = new StateVector();
    /** World position (m). */
    readonly pos = this.s.pos;
    /** World velocity (m/s). */
    readonly vel = this.s.vel;
    /** Orientation, body → world, as x, y, z, w. */
    readonly quat = this.s.quat;
    /** Body angular velocity (rad/s). */
    readonly omega = this.s.omega;

    private readonly k1 = new Float64Array(N);
    private readonly k2 = new Float64Array(N);
    private readonly k3 = new Float64Array(N);
    private readonly k4 = new Float64Array(N);
    private readonly trial = new StateVector();
    private readonly saved = new Float64Array(N);
    private readonly force = new Float64Array(3);
    private readonly moment = new Float64Array(3);

    constructor() {
        this.quat[3] = 1;
    }

    setMassProperties(mass: number, inertia: ArrayLike<number>): void {
        this.mass = mass;
        for (let i = 0; i < 9; i++) this.inertia[i] = inertia[i];
        invert3x3(this.inertia, this.inertiaInv);
    }

    /** Snapshot the whole state (e.g. before an external correction). */
    copyStateTo(out: Float64Array): void {
        out.set(this.s.data);
    }

    copyStateFrom(src: ArrayLike<number>): void {
        for (let i = 0; i < N; i++) this.s.data[i] = src[i];
    }

    /**
     * Advance by `dt` seconds. Returns false if the step produced a non-finite
     * state, in which case the state is left exactly as it was before the call.
     */
    step(dt: number, wrench: WrenchFunction): boolean {
        const x = this.s.data;
        const t = this.trial.data;
        this.saved.set(x);

        this.derivative(this.s, this.k1, 0, wrench);
        for (let i = 0; i < N; i++) t[i] = x[i] + 0.5 * dt * this.k1[i];
        this.derivative(this.trial, this.k2, 1, wrench);
        for (let i = 0; i < N; i++) t[i] = x[i] + 0.5 * dt * this.k2[i];
        this.derivative(this.trial, this.k3, 2, wrench);
        for (let i = 0; i < N; i++) t[i] = x[i] + dt * this.k3[i];
        this.derivative(this.trial, this.k4, 3, wrench);

        const h6 = dt / 6;
        for (let i = 0; i < N; i++) {
            x[i] += h6 * (this.k1[i] + 2 * this.k2[i] + 2 * this.k3[i] + this.k4[i]);
        }
        normalizeQuat(this.quat);

        for (let i = 0; i < N; i++) {
            if (!Number.isFinite(x[i])) {
                x.set(this.saved);
                return false;
            }
        }
        return true;
    }

    private derivative(sv: StateVector, out: Float64Array, stage: number, wrench: WrenchFunction): void {
        // Trial quaternions drift off unit length between stages; the loads and
        // the kinematics both want a rotation, so renormalise before using it.
        normalizeQuat(sv.quat);
        const f = this.force;
        const m = this.moment;
        wrench(sv.pos, sv.vel, sv.quat, sv.omega, stage, f, m);

        out[0] = sv.vel[0];
        out[1] = sv.vel[1];
        out[2] = sv.vel[2];
        const invM = 1 / this.mass;
        out[3] = f[0] * invM;
        out[4] = f[1] * invM;
        out[5] = f[2] * invM;

        const qx = sv.quat[0], qy = sv.quat[1], qz = sv.quat[2], qw = sv.quat[3];
        const wx = sv.omega[0], wy = sv.omega[1], wz = sv.omega[2];
        out[6] = 0.5 * (qw * wx + qy * wz - qz * wy);
        out[7] = 0.5 * (qw * wy + qz * wx - qx * wz);
        out[8] = 0.5 * (qw * wz + qx * wy - qy * wx);
        out[9] = -0.5 * (qx * wx + qy * wy + qz * wz);

        // ω̇ = I⁻¹ (M − ω × (I ω + h))
        const I = this.inertia;
        const hx = I[0] * wx + I[1] * wy + I[2] * wz + this.rotorMomentum[0];
        const hy = I[3] * wx + I[4] * wy + I[5] * wz + this.rotorMomentum[1];
        const hz = I[6] * wx + I[7] * wy + I[8] * wz + this.rotorMomentum[2];
        const rx = m[0] - (wy * hz - wz * hy);
        const ry = m[1] - (wz * hx - wx * hz);
        const rz = m[2] - (wx * hy - wy * hx);
        const Ii = this.inertiaInv;
        out[10] = Ii[0] * rx + Ii[1] * ry + Ii[2] * rz;
        out[11] = Ii[3] * rx + Ii[4] * ry + Ii[5] * rz;
        out[12] = Ii[6] * rx + Ii[7] * ry + Ii[8] * rz;
    }
}

export function normalizeQuat(q: Float64Array): void {
    const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    if (len > 0) {
        const inv = 1 / len;
        q[0] *= inv; q[1] *= inv; q[2] *= inv; q[3] *= inv;
    }
}

/** out = R(q) · v, rotating a body vector into the world frame. `out` may alias `v`. */
export function rotateBodyToWorld(q: ArrayLike<number>, vx: number, vy: number, vz: number, out: Float64Array, o = 0): void {
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out[o] = vx + qw * tx + (qy * tz - qz * ty);
    out[o + 1] = vy + qw * ty + (qz * tx - qx * tz);
    out[o + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** out = R(q)ᵀ · v, rotating a world vector into the body frame. */
export function rotateWorldToBody(q: ArrayLike<number>, vx: number, vy: number, vz: number, out: Float64Array, o = 0): void {
    const qx = -q[0], qy = -q[1], qz = -q[2], qw = q[3];
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    out[o] = vx + qw * tx + (qy * tz - qz * ty);
    out[o + 1] = vy + qw * ty + (qz * tx - qx * tz);
    out[o + 2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** Inverse of a 3×3 row-major matrix; throws on a singular one. */
export function invert3x3(m: ArrayLike<number>, out: Float64Array): void {
    const a = m[0], b = m[1], c = m[2];
    const d = m[3], e = m[4], f = m[5];
    const g = m[6], h = m[7], i = m[8];
    const A = e * i - f * h;
    const B = -(d * i - f * g);
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 0)) {
        throw new Error('invert3x3: singular matrix');
    }
    const inv = 1 / det;
    out[0] = A * inv;
    out[1] = -(b * i - c * h) * inv;
    out[2] = (b * f - c * e) * inv;
    out[3] = B * inv;
    out[4] = (a * i - c * g) * inv;
    out[5] = -(a * f - c * d) * inv;
    out[6] = C * inv;
    out[7] = -(a * h - b * g) * inv;
    out[8] = (a * e - b * d) * inv;
}
