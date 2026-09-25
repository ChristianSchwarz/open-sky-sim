import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { defaultFm2Config } from '../fm2/fm2AircraftConfig';
import { Fm3Aero } from '../fm3/aeroModel';
import { F16_AIRFRAME } from '../fm3/f16Airframe';
import { nasaRatesFromSimOmega } from '../fm3/frames';
import { Fm3FlightModel } from './fm3FlightModel';

/*
 * FM3's post-stall behaviour on the default F-16, against what NASA TP-1538
 * reports for the same airframe.
 */

const DEG = Math.PI / 180;
const DT = 1 / 120;

/** An FM3 F-16 with the CG at `cgFraction` of the mean chord (TP-1538's reference is 0.35). */
function f16(cgFraction: number): Fm3FlightModel {
    const shift = (cgFraction - 0.35) * F16_AIRFRAME.reference.chordM;
    return new Fm3FlightModel({
        ...defaultFm2Config,
        fm3: { ...F16_AIRFRAME, mass: { ...F16_AIRFRAME.mass, cg: [-shift, 0, 0] } },
    });
}

/** Airborne and wings level at `alphaDeg`, on a flight path `gammaDeg` above the horizon. */
function spawn(
    model: Fm3FlightModel, altitude: number, speed: number, alphaDeg: number, gammaDeg: number,
    throttle: number, limiters: boolean,
): void {
    model.reset();
    model.position.set(0, altitude, 0);
    // Pitch attitude is α + γ; nose-up is a negative rotation about sim +X.
    model.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -(alphaDeg + gammaDeg) * DEG);
    const gamma = gammaDeg * DEG;
    model.velocityVector = new THREE.Vector3(0, speed * Math.sin(gamma), speed * Math.cos(gamma));
    model.setLanded(false);
    model.setLandingGearDeployed(false);
    model.setFlapsExtended(false);
    model.setLimitersEnabled(limiters);
    model.setThrottle(throttle);
    model.syncEffectiveThrottle();
    model.snapPhysicsState();
}

interface Sample {
    /** Degrees. */
    alpha: number;
    beta: number;
    /** NASA yaw rate, degrees per second. */
    r: number;
}

/** Fly for `seconds`, calling `control(t)` before each step. */
function fly(model: Fm3FlightModel, seconds: number, control?: (t: number) => void): Sample[] {
    const samples: Sample[] = [];
    const rates = new Float64Array(3);
    let q0 = model.quaternion.clone();
    for (let i = 1; i <= Math.round(seconds / DT); i++) {
        control?.(i * DT);
        model.update(DT);
        const dq = q0.invert().multiply(model.quaternion);
        if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
        const angle = 2 * Math.acos(Math.min(1, dq.w));
        const s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
        nasaRatesFromSimOmega(dq.x / s * angle / DT, dq.y / s * angle / DT, dq.z / s * angle / DT, rates);
        q0 = model.quaternion.clone();
        samples.push({ alpha: model.getAngleOfAttack() / DEG, beta: model.getSideslip() / DEG, r: rates[2] / DEG });
    }
    return samples;
}

const max = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), -Infinity);
const min = (xs: number[]) => xs.reduce((a, b) => Math.min(a, b), Infinity);
const maxAbs = (xs: number[]) => max(xs.map(Math.abs));

/** Stabilators at full nose-down and leading-edge flaps fully down, as in a deep stall. */
const NOSE_DOWN = { stabL: 25 * DEG, stabR: 25 * DEG, lef: 25 * DEG };

describe('FM3 post-stall (F-16 against NASA TP-1538)', () => {
    it('trims in the deep stall with the stabilators at full nose-down', () => {
        const aero = new Fm3Aero(F16_AIRFRAME);
        const cm = (deg: number) => aero.coefficients({ speed: 60, alpha: deg * DEG, controls: NOSE_DOWN }).Cm;
        // TP-1538: "a weak but stable trim point at α = 60°".
        let trim = NaN;
        for (let deg = 45; deg < 75; deg++) {
            const a = cm(deg), b = cm(deg + 1);
            if (a > 0 && b <= 0) {
                trim = deg + a / (a - b);
                break;
            }
        }
        assert.ok(trim > 55 && trim < 68, `nose-down trim at ${trim.toFixed(1)}°`);
        assert.ok(cm(trim - 6) > 0 && cm(trim + 6) < 0, 'the trim should be stable');
        assert.ok(cm(20) < -0.1, `full nose-down Cm at 20° is ${cm(20).toFixed(3)}`);
    });

    it('damps pitch through the deep-stall range', () => {
        // The static trim above says nothing about the lags that set damping
        // past stall; a forced oscillation measures Cmq + Cmα̇ with them.
        const aero = new Fm3Aero(F16_AIRFRAME);
        for (const deg of [50, 60, 70, 80]) {
            const damping = aero.pitchDamping({ speed: 60, alpha: deg * DEG, controls: NOSE_DOWN });
            assert.ok(damping < 0, `Cmq + Cmα̇ at ${deg}° is ${damping.toFixed(2)}`);
        }
    });

    it('stays in the deep stall with full nose-down stick', () => {
        // TP-1538 figure 44: with the stabilators at full nose-down, α oscillates about 60°.
        const model = f16(0.35);
        spawn(model, 9144, 66, 58, -58, 0.3, false);
        model.setPitch(-1);
        const alphas = fly(model, 10).map(s => s.alpha);
        const mean = alphas.reduce((a, b) => a + b, 0) / alphas.length;
        assert.ok(min(alphas) > 35, `α fell to ${min(alphas).toFixed(1)}°`);
        assert.ok(mean > 50 && mean < 70, `mean α ${mean.toFixed(1)}°`);
        assert.equal(model.nanGuardTrips, 0);
    });

    it('holds the AoA limit while rolling at it', () => {
        const model = f16(0.35);
        spawn(model, 9144, 100, 10, 0, 0.7, true);
        const trace = fly(model, 10, () => {
            model.setPitch(1);
            model.setRoll(1);
        });
        assert.ok(max(trace.map(s => s.alpha)) < 28, `max α ${max(trace.map(s => s.alpha)).toFixed(1)}°`);
        assert.ok(maxAbs(trace.map(s => s.beta)) < 25, `max |β| ${maxAbs(trace.map(s => s.beta)).toFixed(1)}°`);
    });

    it('resists a yaw departure under cross-controls', () => {
        // TP-1538 found the airplane resistant to the classical yaw departure.
        const model = f16(0.35);
        spawn(model, 6000, 120, 15, 0, 0.8, true);
        const trace = fly(model, 8, () => {
            model.setPitch(1);
            model.setYaw(1);
            model.setRoll(-1);
        });
        // Full cross-controls may overshoot the 25° limit (spin prevention
        // engages at 29°); a departure is α and sideslip running away.
        assert.ok(max(trace.map(s => s.alpha)) < 35, `max α ${max(trace.map(s => s.alpha)).toFixed(1)}°`);
        assert.ok(maxAbs(trace.map(s => s.beta)) < 25, `max |β| ${maxAbs(trace.map(s => s.beta)).toFixed(1)}°`);
        assert.ok(maxAbs(trace.map(s => s.r)) < 45, `max |r| ${maxAbs(trace.map(s => s.r)).toFixed(0)}°/s`);
    });

    it('departs when rolled hard at high AoA with the limiters off, not with them on', () => {
        // TP-1538: rapid rolls at high α and low speed pitch-depart through inertia
        // coupling; the limiters and roll-rate fade prevent it.
        const roll = (limiters: boolean, cg: number) => {
            const model = f16(cg);
            spawn(model, 9144, 95, 20, 0, 0.8, limiters);
            return fly(model, 8, t => {
                model.setPitch(0.5);
                model.setRoll(t > 1 ? 1 : 0);
            });
        };
        const off = roll(false, 0.375);
        const offAlpha = max(off.map(s => s.alpha)), offBeta = maxAbs(off.map(s => s.beta));
        assert.ok(offAlpha > 45 || offBeta > 30, `limiters off: max α ${offAlpha.toFixed(1)}°, max |β| ${offBeta.toFixed(1)}°`);
        const on = roll(true, 0.35);
        const onAlpha = max(on.map(s => s.alpha)), onBeta = maxAbs(on.map(s => s.beta));
        assert.ok(onAlpha < 28 && onBeta < 20, `limiters on: max α ${onAlpha.toFixed(1)}°, max |β| ${onBeta.toFixed(1)}°`);
    });

    it('falls through a tail slide and recovers', () => {
        const model = f16(0.35);
        spawn(model, 6000, 60, 5, 0, 0, false);
        model.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -89 * DEG);
        model.velocityVector = new THREE.Vector3(0, 60, 0.5);
        model.syncEffectiveThrottle();
        model.snapPhysicsState();
        const alphas = fly(model, 20).map(s => s.alpha);
        assert.ok(max(alphas) > 150, `the airflow never reversed: max α ${max(alphas).toFixed(0)}°`);
        assert.ok(Math.abs(alphas[alphas.length - 1]) < 15, `α ${alphas[alphas.length - 1].toFixed(1)}° after 20 s`);
        assert.ok(model.velocityVector.length() > 100, `${model.velocityVector.length().toFixed(0)} m/s after 20 s`);
        assert.equal(model.nanGuardTrips, 0);
    });

    it('flies the same departure twice', () => {
        const run = () => {
            const model = f16(0.375);
            spawn(model, 9144, 95, 20, 0, 0.8, false);
            fly(model, 4, t => {
                model.setPitch(0.5);
                model.setRoll(t > 1 ? 1 : 0);
            });
            const { position: p, quaternion: q, velocityVector: v } = model;
            return [p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z];
        };
        assert.deepEqual(run(), run());
    });
});
