import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { Fm2FlightModel } from '../model/fm2FlightModel';
import {
    inertiaNasaToSim, nasaRatesFromSimOmega, nasaToSim, simOmegaFromNasaRates, simToNasa, Vec3,
} from './frames';

function cross(a: Vec3, b: Vec3): Vec3 {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function airborne(model: Fm2FlightModel): void {
    model.reset();
    model.position.set(0, 4000, 0);
    model.velocityVector = new THREE.Vector3(0, 0, 200);
    model.setLanded(false);
    model.setLandingGearDeployed(false);
    model.setFlapsExtended(false);
    model.setThrottle(0.8);
    model.syncEffectiveThrottle();
    model.snapPhysicsState();
}

/** Mean body-frame angular velocity between two orientations, NASA axes. */
function nasaRatesBetween(q0: THREE.Quaternion, q1: THREE.Quaternion, dt: number): Vec3 {
    const dq = q0.clone().invert().multiply(q1);
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const angle = 2 * Math.acos(Math.min(1, dq.w));
    const s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
    const w = new THREE.Vector3(dq.x / s, dq.y / s, dq.z / s).multiplyScalar(angle / dt);
    const out = new Float64Array(3);
    nasaRatesFromSimOmega(w.x, w.y, w.z, out);
    return [out[0], out[1], out[2]];
}

describe('FM3 frames', () => {
    it('round-trips vectors between NASA and sim axes', () => {
        const v: Vec3 = [1.5, -2.25, 3.125];
        assert.deepEqual(simToNasa(nasaToSim(v)), v);
        assert.deepEqual(nasaToSim(simToNasa(v)), v);
    });

    it('is a proper rotation: cross products survive the mapping', () => {
        const a: Vec3 = [0.3, -1.2, 2.0];
        const b: Vec3 = [-0.7, 0.4, 1.1];
        const lhs = nasaToSim(cross(a, b));
        const rhs = cross(nasaToSim(a), nasaToSim(b));
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(lhs[i] - rhs[i]) < 1e-12);
    });

    it('rotates the inertia tensor as C·I·Cᵀ', () => {
        const i = { ixx: 12875, iyy: 75674, izz: 85552, ixz: 1331, ixy: 17, iyz: -23 };
        const tensorN = [
            [i.ixx, -i.ixy, -i.ixz],
            [-i.ixy, i.iyy, -i.iyz],
            [-i.ixz, -i.iyz, i.izz],
        ];
        // Columns of C are the sim images of the NASA unit vectors.
        const C = [nasaToSim([1, 0, 0]), nasaToSim([0, 1, 0]), nasaToSim([0, 0, 1])];
        const cm = (r: number, c: number) => C[c][r];
        const expected = new Float64Array(9);
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let a = 0; a < 3; a++) {
                    for (let b = 0; b < 3; b++) sum += cm(r, a) * tensorN[a][b] * cm(c, b);
                }
                expected[r * 3 + c] = sum;
            }
        }
        const actual = inertiaNasaToSim(i);
        for (let k = 0; k < 9; k++) assert.ok(Math.abs(actual[k] - expected[k]) < 1e-9, `entry ${k}`);
    });

    it('maps body rates both ways', () => {
        const pqr = new Float64Array(3);
        const w = new Float64Array(3);
        simOmegaFromNasaRates(0.4, -0.2, 0.1, w);
        nasaRatesFromSimOmega(w[0], w[1], w[2], pqr);
        assert.deepEqual(Array.from(pqr), [0.4, -0.2, 0.1]);
    });

    describe('agrees with FM2 control polarity', () => {
        const dt = 1 / 120;

        it('right roll stick is positive p', () => {
            const model = new Fm2FlightModel();
            airborne(model);
            model.setRoll(1);
            for (let i = 0; i < 60; i++) model.update(dt);
            const q0 = model.quaternion.clone();
            model.update(dt);
            const [p, q, r] = nasaRatesBetween(q0, model.quaternion, dt);
            assert.ok(p > 0.5, `p = ${p}`);
            assert.ok(Math.abs(p) > 5 * Math.abs(q) && Math.abs(p) > 5 * Math.abs(r), `p ${p} q ${q} r ${r}`);
        });

        it('aft stick is positive q (nose up)', () => {
            const model = new Fm2FlightModel();
            airborne(model);
            model.setPitch(0.5);
            for (let i = 0; i < 60; i++) model.update(dt);
            const q0 = model.quaternion.clone();
            model.update(dt);
            const [, q] = nasaRatesBetween(q0, model.quaternion, dt);
            assert.ok(q > 0.05, `q = ${q}`);
            const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(model.quaternion);
            assert.ok(nose.y > 0, 'nose should be above the horizon');
        });

        it('right pedal is positive r (nose right)', () => {
            const model = new Fm2FlightModel();
            airborne(model);
            model.setYaw(1);
            for (let i = 0; i < 30; i++) model.update(dt);
            const q0 = model.quaternion.clone();
            model.update(dt);
            const [, , r] = nasaRatesBetween(q0, model.quaternion, dt);
            assert.ok(r > 0.01, `r = ${r}`);
        });
    });
});
