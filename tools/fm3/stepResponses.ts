/**
 * FM3 handling check: step responses of the default F-16 through its flight
 * control system, across the envelope, for tuning the FCS gains.
 *
 * Runs bundled (under tsx it is ~50x slower):
 *
 *     node_modules/.bin/esbuild tools/fm3/stepResponses.ts --bundle --platform=node --outfile=<tmp>/sr.cjs
 *     node <tmp>/sr.cjs
 */
import * as THREE from 'three';
import { nasaRatesFromSimOmega } from '../../src/script/physics/fm3/frames';
import { Fm3FlightModel } from '../../src/script/physics/model/fm3FlightModel';

const DT = 1 / 120;
const DEG = 180 / Math.PI;

function spawn(altitude: number, speed: number, throttle: number, limiters = true): Fm3FlightModel {
    const model = new Fm3FlightModel();
    model.reset();
    model.position.set(0, altitude, 0);
    model.quaternion.identity();
    model.velocityVector = new THREE.Vector3(0, 0, speed);
    model.setLanded(false);
    model.setLandingGearDeployed(false);
    model.setFlapsExtended(false);
    model.setLimitersEnabled(limiters);
    model.setThrottle(throttle);
    model.syncEffectiveThrottle();
    model.snapPhysicsState();
    for (let i = 0; i < 3 * 120; i++) model.update(DT);
    return model;
}

/** NASA body rates over one step from the orientation change. */
function rates(q0: THREE.Quaternion, q1: THREE.Quaternion): [number, number, number] {
    const dq = q0.clone().invert().multiply(q1);
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const angle = 2 * Math.acos(Math.min(1, dq.w));
    const s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
    const out = new Float64Array(3);
    nasaRatesFromSimOmega(dq.x / s * angle / DT, dq.y / s * angle / DT, dq.z / s * angle / DT, out);
    return [out[0], out[1], out[2]];
}

const f = (x: number, w = 7, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a').padStart(w);

const conditions: [number, number][] = [[1000, 120], [1000, 200], [5000, 150], [5000, 250], [9000, 250], [3000, 330]];

console.log('Pitch: 0.5 stick step (peak / settled g, overshoot %), full aft (peak g, peak α), full forward (min g)');
console.log('Roll: full stick (peak p °/s, time to 90° s). Yaw: full pedal (peak β °)');
console.log(' alt    V  | trim α  n    | ½ step pk  set   ovs% | pull g   α°   | push g | p°/s   t90  | β°');
for (const [alt, speed] of conditions) {
    const base = spawn(alt, speed, 0.9);
    const trimAlpha = base.getAngleOfAttack() * DEG;
    const trimG = base.getLoadFactorG();

    let m = spawn(alt, speed, 0.9);
    m.setPitch(0.5);
    let peak = 0, settled = 0;
    for (let i = 0; i < 4 * 120; i++) {
        m.update(DT);
        peak = Math.max(peak, m.getLoadFactorG());
        if (i >= 3 * 120) settled += m.getLoadFactorG() / 120;
    }
    const overshoot = settled > 1.05 ? 100 * (peak - settled) / (settled - 1) : NaN;

    m = spawn(alt, speed, 1.0);
    m.setPitch(1);
    let pullG = 0, pullAlpha = 0;
    for (let i = 0; i < 4 * 120; i++) {
        m.update(DT);
        pullG = Math.max(pullG, m.getLoadFactorG());
        pullAlpha = Math.max(pullAlpha, m.getAngleOfAttack() * DEG);
    }

    m = spawn(alt, speed, 0.9);
    m.setPitch(-1);
    let pushG = 10;
    for (let i = 0; i < 3 * 120; i++) {
        m.update(DT);
        pushG = Math.min(pushG, m.getLoadFactorG());
    }

    m = spawn(alt, speed, 0.9);
    m.setRoll(1);
    let peakP = 0, bank = 0, t90 = NaN;
    let q0 = m.quaternion.clone();
    for (let i = 0; i < 3 * 120; i++) {
        m.update(DT);
        const [p] = rates(q0, m.quaternion);
        q0 = m.quaternion.clone();
        peakP = Math.max(peakP, p * DEG);
        bank += p * DT * DEG;
        if (Number.isNaN(t90) && bank >= 90) t90 = (i + 1) * DT;
    }

    m = spawn(alt, speed, 0.9);
    m.setYaw(1);
    let peakBeta = 0;
    for (let i = 0; i < 2 * 120; i++) {
        m.update(DT);
        peakBeta = Math.max(peakBeta, Math.abs(m.getSideslip() * DEG));
    }

    console.log(`${f(alt, 5, 0)} ${f(speed, 4, 0)} | ${f(trimAlpha, 5)} ${f(trimG, 5, 2)} | ${f(peak, 6, 2)} ${f(settled, 5, 2)} ${f(overshoot, 6, 0)} | ${f(pullG, 5, 2)} ${f(pullAlpha, 5)} | ${f(pushG, 5, 2)} | ${f(peakP, 5, 0)} ${f(t90, 5, 2)} | ${f(peakBeta, 4)}`);
}

console.log('\nLimiters off, 5000 m, 110 m/s, full aft stick then full forward at 6 s (deep-stall entry)');
const ds = spawn(5000, 110, 0.6, false);
ds.setPitch(1);
for (let i = 0; i <= 14 * 120; i++) {
    if (i === 6 * 120) ds.setPitch(-1);
    ds.update(DT);
    if (i % 60 === 0) {
        const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(ds.quaternion);
        console.log(`  t ${f(i * DT, 4)} s  α ${f(ds.getAngleOfAttack() * DEG, 6)}°  pitch ${f(Math.asin(nose.y) * DEG, 6)}°  V ${f(ds.velocityVector.length(), 5, 0)} m/s  n ${f(ds.getLoadFactorG(), 5, 2)}  elev ${f(ds.getCommandedElevator(), 5, 2)}`);
    }
}
