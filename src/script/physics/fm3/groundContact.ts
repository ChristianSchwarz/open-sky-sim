/**
 * FM3 landing gear: spring-damper legs against the terrain, like FM2's, but
 * built for an integrator that evaluates the loads several times per step.
 *
 * The heightfield is sampled once per step per leg — the highest ground under
 * the tyre footprint and the local slope — and each RK4 stage then works
 * against that plane. Friction is split into rolling/braking along the wheel
 * and side friction across it, capped by a friction circle, and regularised
 * near zero slip so a parked aircraft does not chatter.
 */
import { Fm2GearConfig } from '../fm2/fm2AircraftConfig';
import { rotateBodyToWorld, rotateWorldToBody } from './rigidBody6';

/** Half-extent (m) of the footprint samples around each leg (as FM2). */
const FOOTPRINT_M = 0.45;
/** Finite-difference half-step (m) for surface normals (as FM2). */
const NORMAL_EPS_M = 0.5;
/** Slip speed (m/s) below which friction fades out linearly. */
const SLIP_EPS_MPS = 0.1;

export interface GroundQuery {
    groundHeightAt(x: number, z: number): number;
}

export class Fm3GroundContact {
    readonly count: number;
    /** Per-leg oleo compression (m) from the last recorded evaluation. */
    readonly compression: number[];
    private readonly points: Float64Array;
    private readonly planeX: Float64Array;
    private readonly planeY: Float64Array;
    private readonly planeZ: Float64Array;
    private readonly normalX: Float64Array;
    private readonly normalY: Float64Array;
    private readonly normalZ: Float64Array;
    private readonly scratch = new Float64Array(3);
    private readonly scratch2 = new Float64Array(3);
    world: GroundQuery | undefined;

    constructor(private readonly gear: Fm2GearConfig) {
        this.count = gear.points.length;
        this.compression = new Array(this.count).fill(0);
        this.points = Float64Array.from(gear.points.flat());
        this.planeX = new Float64Array(this.count);
        this.planeY = new Float64Array(this.count).fill(-Infinity);
        this.planeZ = new Float64Array(this.count);
        this.normalX = new Float64Array(this.count);
        this.normalY = new Float64Array(this.count).fill(1);
        this.normalZ = new Float64Array(this.count);
    }

    get maxStroke(): number {
        return this.gear.maxStrokeM ?? 0.35;
    }

    /** Body-frame height of the CG above flat ground at rest: −min(leg Y). */
    get restHeight(): number {
        let min = Infinity;
        for (let i = 0; i < this.count; i++) min = Math.min(min, this.points[i * 3 + 1]);
        return -min;
    }

    groundHeightAt(x: number, z: number): number {
        return this.world?.groundHeightAt(x, z) ?? 0;
    }

    /** Highest ground under a tyre footprint (centre and ±footprint on X/Z). */
    groundHeightUnderGear(x: number, z: number): number {
        const r = FOOTPRINT_M;
        return Math.max(
            this.groundHeightAt(x, z),
            this.groundHeightAt(x + r, z),
            this.groundHeightAt(x - r, z),
            this.groundHeightAt(x, z + r),
            this.groundHeightAt(x, z - r),
        );
    }

    /** Sample the ground plane under each leg for the coming step. */
    samplePlanes(pos: ArrayLike<number>, quat: ArrayLike<number>): void {
        const w = this.scratch;
        for (let i = 0; i < this.count; i++) {
            rotateBodyToWorld(quat, this.points[i * 3], this.points[i * 3 + 1], this.points[i * 3 + 2], w);
            const x = pos[0] + w[0], z = pos[2] + w[2];
            this.planeX[i] = x;
            this.planeZ[i] = z;
            this.planeY[i] = this.groundHeightUnderGear(x, z);
            const e = NORMAL_EPS_M;
            const hL = this.groundHeightAt(x - e, z), hR = this.groundHeightAt(x + e, z);
            const hD = this.groundHeightAt(x, z - e), hU = this.groundHeightAt(x, z + e);
            let nx = -(hR - hL) / (2 * e), ny = 1, nz = -(hU - hD) / (2 * e);
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx /= len; ny /= len; nz /= len;
            this.normalX[i] = nx; this.normalY[i] = ny; this.normalZ[i] = nz;
        }
    }

    /**
     * Add the gear reactions at a trial state: world force into `force`, body
     * moment about the CG into `moment`. Returns the body-frame +Y (up) share
     * of the reaction, for the load factor.
     */
    addForces(
        pos: ArrayLike<number>, vel: ArrayLike<number>, quat: ArrayLike<number>, omega: ArrayLike<number>,
        brakes: boolean, force: Float64Array, moment: Float64Array, record: boolean,
    ): number {
        const g = this.gear;
        const r = this.scratch;
        const b = this.scratch2;
        const stroke = this.maxStroke;
        let upBody = 0;
        // Wheel direction: the nose, in the world.
        rotateBodyToWorld(quat, 0, 0, 1, b);
        const fwX = b[0], fwY = b[1], fwZ = b[2];
        for (let i = 0; i < this.count; i++) {
            if (record) this.compression[i] = 0;
            const gx = this.points[i * 3], gy = this.points[i * 3 + 1], gz = this.points[i * 3 + 2];
            rotateBodyToWorld(quat, gx, gy, gz, r);
            const nx = this.normalX[i], ny = this.normalY[i], nz = this.normalZ[i];
            const pen = nx * (this.planeX[i] - (pos[0] + r[0]))
                + ny * (this.planeY[i] - (pos[1] + r[1]))
                + nz * (this.planeZ[i] - (pos[2] + r[2]));
            if (!(pen > 0)) continue;
            if (record) this.compression[i] = pen < stroke ? pen : stroke;

            // Contact point velocity: v + ω_world × r.
            rotateBodyToWorld(quat, omega[0], omega[1], omega[2], b);
            const cvx = vel[0] + (b[1] * r[2] - b[2] * r[1]);
            const cvy = vel[1] + (b[2] * r[0] - b[0] * r[2]);
            const cvz = vel[2] + (b[0] * r[1] - b[1] * r[0]);
            const vn = cvx * nx + cvy * ny + cvz * nz;
            let fn = g.stiffness * pen - g.damping * vn;
            if (fn <= 0) continue;

            // Wheel axes in the ground plane.
            let ax = fwX - (fwX * nx + fwY * ny + fwZ * nz) * nx;
            let ay = fwY - (fwX * nx + fwY * ny + fwZ * nz) * ny;
            let az = fwZ - (fwX * nx + fwY * ny + fwZ * nz) * nz;
            const alen = Math.sqrt(ax * ax + ay * ay + az * az);
            let fx = fn * nx, fy = fn * ny, fz = fn * nz;
            if (alen > 1e-6) {
                ax /= alen; ay /= alen; az /= alen;
                const lx = ny * az - nz * ay, ly = nz * ax - nx * az, lz = nx * ay - ny * ax;
                const vAlong = cvx * ax + cvy * ay + cvz * az;
                const vSide = cvx * lx + cvy * ly + cvz * lz;
                const muAlong = brakes ? g.brakeFriction : g.rollFriction;
                let fAlong = -muAlong * fn * slip(vAlong);
                let fSide = -g.sideFriction * fn * slip(vSide);
                const cap = Math.max(g.sideFriction, muAlong) * fn;
                const mag = Math.sqrt(fAlong * fAlong + fSide * fSide);
                if (mag > cap) {
                    fAlong *= cap / mag;
                    fSide *= cap / mag;
                }
                fx += fAlong * ax + fSide * lx;
                fy += fAlong * ay + fSide * ly;
                fz += fAlong * az + fSide * lz;
            }
            force[0] += fx; force[1] += fy; force[2] += fz;
            // Moment about the CG: r × F, into the body frame.
            rotateWorldToBody(quat, r[1] * fz - r[2] * fy, r[2] * fx - r[0] * fz, r[0] * fy - r[1] * fx, b);
            moment[0] += b[0]; moment[1] += b[1]; moment[2] += b[2];
            rotateWorldToBody(quat, fx, fy, fz, b);
            upBody += b[1];
        }
        return upBody;
    }

    /**
     * Deepest leg penetration past the oleo stroke (m), 0 when none — the
     * springs alone can tunnel on rising terrain, so the caller lifts the body
     * by this much (as FM2 does).
     */
    excessPenetration(pos: ArrayLike<number>, quat: ArrayLike<number>): number {
        const r = this.scratch;
        let maxPen = 0;
        for (let i = 0; i < this.count; i++) {
            rotateBodyToWorld(quat, this.points[i * 3], this.points[i * 3 + 1], this.points[i * 3 + 2], r);
            const pen = this.groundHeightUnderGear(pos[0] + r[0], pos[2] + r[2]) - (pos[1] + r[1]);
            if (pen > maxPen) maxPen = pen;
        }
        const excess = maxPen - this.maxStroke;
        return excess > 0 ? excess : 0;
    }
}

/** Sign of the slip, fading linearly to zero inside ±SLIP_EPS. */
function slip(v: number): number {
    if (v > SLIP_EPS_MPS) return 1;
    if (v < -SLIP_EPS_MPS) return -1;
    return v / SLIP_EPS_MPS;
}
