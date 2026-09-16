import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { defaultFm2Config, fm2GroundRestHeight } from '../fm2/fm2AircraftConfig';
import { nasaRatesFromSimOmega } from '../fm3/frames';
import { Fm3FlightModel } from './fm3FlightModel';

const DEG = 180 / Math.PI;
const DT = 1 / 120;

function airborne(model: Fm3FlightModel, altitude: number, speed: number, throttle: number): void {
    model.reset();
    model.position.set(0, altitude, 0);
    model.quaternion.identity();
    model.velocityVector = new THREE.Vector3(0, 0, speed);
    model.setLanded(false);
    model.setLandingGearDeployed(false);
    model.setFlapsExtended(false);
    model.setThrottle(throttle);
    model.syncEffectiveThrottle();
    model.snapPhysicsState();
}

/** Mean NASA body rates (p, q, r) over one step, from the orientation change. */
function rates(q0: THREE.Quaternion, q1: THREE.Quaternion): [number, number, number] {
    const dq = q0.clone().invert().multiply(q1);
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const angle = 2 * Math.acos(Math.min(1, dq.w));
    const s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
    const out = new Float64Array(3);
    nasaRatesFromSimOmega(dq.x / s * angle / DT, dq.y / s * angle / DT, dq.z / s * angle / DT, out);
    return [out[0], out[1], out[2]];
}

function assertFinite(model: Fm3FlightModel): void {
    const p = model.position, v = model.velocityVector, q = model.quaternion;
    for (const x of [p.x, p.y, p.z, v.x, v.y, v.z, q.x, q.y, q.z, q.w]) {
        assert.ok(Number.isFinite(x), 'state went non-finite');
    }
}

describe('FM3 flight model', () => {
    it('rests on the runway at idle', () => {
        const model = new Fm3FlightModel();
        const rest = fm2GroundRestHeight(defaultFm2Config);
        model.reset();
        model.position.set(0, rest, 0);
        model.setThrottle(0);
        for (let i = 0; i < 5 * 120; i++) model.update(DT);
        assertFinite(model);
        assert.ok(!model.isCrashed(), 'crashed on the runway');
        assert.ok(model.isLanded(), 'should count as landed');
        assert.ok(model.velocityVector.length() < 0.5, `creeping at ${model.velocityVector.length().toFixed(2)} m/s`);
        assert.ok(model.position.y > rest - 0.4 && model.position.y < rest + 0.1, `height ${model.position.y.toFixed(3)} vs rest ${rest}`);
    });

    it('holds a neutral-stick cruise', () => {
        const model = new Fm3FlightModel();
        airborne(model, 3000, 200, 0.8);
        let minAlpha = Infinity, maxAlpha = -Infinity;
        for (let i = 0; i < 10 * 120; i++) {
            model.update(DT);
            if (i > 240) {
                minAlpha = Math.min(minAlpha, model.getAngleOfAttack() * DEG);
                maxAlpha = Math.max(maxAlpha, model.getAngleOfAttack() * DEG);
            }
        }
        assertFinite(model);
        assert.equal(model.nanGuardTrips, 0);
        assert.ok(!model.isCrashed());
        assert.ok(Math.abs(model.position.y - 3000) < 500, `altitude ${model.position.y.toFixed(0)} m`);
        assert.ok(minAlpha > -2 && maxAlpha < 12, `α ${minAlpha.toFixed(1)}..${maxAlpha.toFixed(1)}°`);
        assert.ok(Math.abs(model.getLoadFactorG() - 1) < 0.3, `n ${model.getLoadFactorG().toFixed(2)}`);
    });

    it('pulls hard without breaking the g and AoA limits', () => {
        const model = new Fm3FlightModel();
        airborne(model, 5000, 250, 1.0);
        model.setPitch(1);
        let maxG = 0, maxAlpha = 0;
        for (let i = 0; i < 4 * 120; i++) {
            model.update(DT);
            maxG = Math.max(maxG, model.getLoadFactorG());
            maxAlpha = Math.max(maxAlpha, model.getAngleOfAttack() * DEG);
        }
        assertFinite(model);
        assert.ok(maxG > 6 && maxG < 10, `max g ${maxG.toFixed(2)}`);
        assert.ok(maxAlpha < 30, `max α ${maxAlpha.toFixed(1)}°`);
    });

    it('rolls right on right stick at a fighter rate', () => {
        const model = new Fm3FlightModel();
        airborne(model, 4000, 220, 0.9);
        model.setRoll(1);
        let peak = 0;
        let q0 = model.quaternion.clone();
        for (let i = 0; i < 2 * 120; i++) {
            model.update(DT);
            const [p] = rates(q0, model.quaternion);
            q0 = model.quaternion.clone();
            peak = Math.max(peak, p);
        }
        assert.ok(peak * DEG > 150, `peak roll rate ${(peak * DEG).toFixed(0)}°/s`);
    });

    it('yaws right on right pedal', () => {
        const model = new Fm3FlightModel();
        airborne(model, 4000, 180, 0.8);
        model.setYaw(1);
        for (let i = 0; i < 60; i++) model.update(DT);
        const q0 = model.quaternion.clone();
        model.update(DT);
        const [, , r] = rates(q0, model.quaternion);
        assert.ok(r > 0, `r ${r}`);
    });

    it('survives thirty seconds of random stick at every attitude', () => {
        const model = new Fm3FlightModel();
        airborne(model, 6000, 180, 0.9);
        model.setLimitersEnabled(false);
        let seed = 12345;
        const rand = () => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;
            return seed / 4294967296 * 2 - 1;
        };
        for (let i = 0; i < 30 * 120; i++) {
            if (i % 30 === 0) {
                model.setPitch(rand());
                model.setRoll(rand());
                model.setYaw(rand());
                model.setThrottle(0.5 + 0.5 * rand());
            }
            model.update(DT);
        }
        assertFinite(model);
        assert.equal(model.nanGuardTrips, 0);
    });
});
