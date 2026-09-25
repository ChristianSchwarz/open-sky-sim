import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rotateBodyToWorld, rotateWorldToBody, RigidBody6, WrenchFunction } from './rigidBody6';

const torqueFree: WrenchFunction = (_p, _v, _q, _w, _s, f, m) => {
    f[0] = 0; f[1] = 0; f[2] = 0;
    m[0] = 0; m[1] = 0; m[2] = 0;
};

function kineticEnergy(rb: RigidBody6): number {
    const w = rb.omega;
    const I = rb.inertia;
    let t = 0;
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) t += w[r] * I[r * 3 + c] * w[c];
    }
    return 0.5 * t;
}

/** Angular momentum in the world frame (conserved without torque). */
function worldMomentum(rb: RigidBody6): [number, number, number] {
    const w = rb.omega;
    const I = rb.inertia;
    const out = new Float64Array(3);
    rotateBodyToWorld(rb.quat,
        I[0] * w[0] + I[1] * w[1] + I[2] * w[2],
        I[3] * w[0] + I[4] * w[1] + I[5] * w[2],
        I[6] * w[0] + I[7] * w[1] + I[8] * w[2], out);
    return [out[0], out[1], out[2]];
}

function tumbling(dt: number, seconds: number): RigidBody6 {
    const rb = new RigidBody6();
    // A tensor with a product of inertia, like an aircraft's.
    rb.setMassProperties(1000, [2000, 0, 0, 0, 5000, 400, 0, 400, 9000]);
    rb.omega[0] = 0.02;
    rb.omega[1] = 6.0; // near the intermediate axis: the Dzhanibekov flip
    rb.omega[2] = 0.03;
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) rb.step(dt, torqueFree);
    return rb;
}

describe('FM3 rigid body', () => {
    it('conserves energy and world angular momentum while tumbling', () => {
        const rb = new RigidBody6();
        rb.setMassProperties(1000, [2000, 0, 0, 0, 5000, 400, 0, 400, 9000]);
        rb.omega[0] = 0.02;
        rb.omega[1] = 6.0;
        rb.omega[2] = 0.03;
        const t0 = kineticEnergy(rb);
        const l0 = worldMomentum(rb);
        let flipped = false;
        for (let i = 0; i < 60 * 120; i++) {
            rb.step(1 / 120, torqueFree);
            if (rb.omega[1] < -3) flipped = true;
        }
        const t1 = kineticEnergy(rb);
        const l1 = worldMomentum(rb);
        assert.ok(Math.abs(t1 - t0) / t0 < 1e-4, `energy drift ${(t1 - t0) / t0}`);
        const lMag = Math.hypot(...l0);
        const dl = Math.hypot(l1[0] - l0[0], l1[1] - l0[1], l1[2] - l0[2]);
        assert.ok(dl / lMag < 1e-4, `momentum drift ${dl / lMag}`);
        assert.ok(flipped, 'rotation about the intermediate axis should flip');
    });

    it('converges at fourth order', () => {
        const reference = tumbling(1 / 1920, 2);
        const coarse = tumbling(1 / 60, 2);
        const fine = tumbling(1 / 120, 2);
        const err = (rb: RigidBody6) => Math.hypot(
            rb.omega[0] - reference.omega[0],
            rb.omega[1] - reference.omega[1],
            rb.omega[2] - reference.omega[2],
        );
        const ratio = err(coarse) / err(fine);
        assert.ok(ratio > 10 && ratio < 24, `error ratio ${ratio} (expect ~16)`);
    });

    it('integrates constant gravity exactly', () => {
        const rb = new RigidBody6();
        rb.setMassProperties(10, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        rb.vel[0] = 3;
        const gravity: WrenchFunction = (_p, _v, _q, _w, _s, f, m) => {
            f[0] = 0; f[1] = -9.80665 * 10; f[2] = 0;
            m[0] = 0; m[1] = 0; m[2] = 0;
        };
        for (let i = 0; i < 240; i++) rb.step(1 / 120, gravity);
        assert.ok(Math.abs(rb.pos[1] - (-0.5 * 9.80665 * 4)) < 1e-9, `y ${rb.pos[1]}`);
        assert.ok(Math.abs(rb.pos[0] - 6) < 1e-9);
    });

    it('precesses a spinning rotor under a pitching moment', () => {
        const rb = new RigidBody6();
        rb.setMassProperties(1000, [5000, 0, 0, 0, 6000, 0, 0, 0, 1000]);
        const h = 200;
        rb.rotorMomentum[2] = h;
        const moment = 1000;
        const push: WrenchFunction = (_p, _v, _q, _w, _s, f, m) => {
            f[0] = 0; f[1] = 0; f[2] = 0;
            m[0] = moment; m[1] = 0; m[2] = 0;
        };
        const t = 0.1;
        for (let i = 0; i < 12; i++) rb.step(t / 12, push);
        // ω̇y = (ωx·h)/Iy with ωx ≈ (M/Ix)·t  →  ωy ≈ M·h·t² / (2·Ix·Iy)
        const expected = moment * h * t * t / (2 * 5000 * 6000);
        assert.ok(rb.omega[1] > 0, 'rotor should turn the pitch push into yaw');
        assert.ok(Math.abs(rb.omega[1] - expected) / expected < 0.02, `ωy ${rb.omega[1]} vs ${expected}`);
    });

    it('rolls back a step that goes non-finite', () => {
        const rb = new RigidBody6();
        rb.setMassProperties(1, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        rb.pos[1] = 5;
        rb.omega[2] = 0.5;
        const before = new Float64Array(13);
        rb.copyStateTo(before);
        const broken: WrenchFunction = (_p, _v, _q, _w, stage, f, m) => {
            f[0] = stage === 2 ? NaN : 0; f[1] = 0; f[2] = 0;
            m[0] = 0; m[1] = 0; m[2] = 0;
        };
        assert.equal(rb.step(1 / 120, broken), false);
        const after = new Float64Array(13);
        rb.copyStateTo(after);
        assert.deepEqual(Array.from(after), Array.from(before));
    });

    it('rotates vectors body→world and back', () => {
        const q = new Float64Array([0.1, 0.7, -0.2, 0.6]);
        const len = Math.hypot(q[0], q[1], q[2], q[3]);
        for (let i = 0; i < 4; i++) q[i] /= len;
        const w = new Float64Array(3);
        const b = new Float64Array(3);
        rotateBodyToWorld(q, 1.5, -0.5, 2.0, w);
        rotateWorldToBody(q, w[0], w[1], w[2], b);
        assert.ok(Math.abs(b[0] - 1.5) < 1e-12 && Math.abs(b[1] + 0.5) < 1e-12 && Math.abs(b[2] - 2.0) < 1e-12);
    });
});
