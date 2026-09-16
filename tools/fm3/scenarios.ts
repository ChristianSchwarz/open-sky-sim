/**
 * FM3 post-stall scenarios on the default F-16, printed as time histories:
 * the behaviours NASA TP-1538 reports, run through the full model (aero, FCS,
 * rigid body). Used to design fm3PostStall.test.ts.
 *
 * Runs bundled:
 *
 *     node_modules/.bin/esbuild tools/fm3/scenarios.ts --bundle --platform=node --outfile=<tmp>/sc.cjs
 *     node <tmp>/sc.cjs [scenario]
 */
import * as THREE from 'three';
import { defaultFm2Config } from '../../src/script/physics/fm2/fm2AircraftConfig';
import { F16_AIRFRAME } from '../../src/script/physics/fm3/f16Airframe';
import { nasaRatesFromSimOmega } from '../../src/script/physics/fm3/frames';
import { Fm3FlightModel } from '../../src/script/physics/model/fm3FlightModel';

const DT = 1 / 120;
const DEG = 180 / Math.PI;

/** An FM3 F-16 with the CG at `cgFraction` of the mean chord (0.35 = reference). */
function f16(cgFraction = 0.35): Fm3FlightModel {
    const shift = (cgFraction - 0.35) * F16_AIRFRAME.reference.chordM;
    return new Fm3FlightModel({
        ...defaultFm2Config,
        fm3: { ...F16_AIRFRAME, mass: { ...F16_AIRFRAME.mass, cg: [-shift, 0, 0] } },
    });
}

/** Airborne, wings level, at `alphaDeg` on a flight path `gammaDeg` above the horizon. */
function spawn(model: Fm3FlightModel, altitude: number, speed: number, alphaDeg: number, throttle: number, limiters: boolean, gammaDeg = 0): void {
    model.reset();
    model.position.set(0, altitude, 0);
    // Pitch attitude θ = α + γ; nose-up is a negative rotation about sim +X.
    model.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -(alphaDeg + gammaDeg) / DEG);
    const g = gammaDeg / DEG;
    model.velocityVector = new THREE.Vector3(0, speed * Math.sin(g), speed * Math.cos(g));
    model.setLanded(false);
    model.setLandingGearDeployed(false);
    model.setFlapsExtended(false);
    model.setLimitersEnabled(limiters);
    model.setThrottle(throttle);
    model.syncEffectiveThrottle();
    model.snapPhysicsState();
}

function rates(q0: THREE.Quaternion, q1: THREE.Quaternion): [number, number, number] {
    const dq = q0.clone().invert().multiply(q1);
    if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
    const angle = 2 * Math.acos(Math.min(1, dq.w));
    const s = Math.sqrt(Math.max(1e-12, 1 - dq.w * dq.w));
    const out = new Float64Array(3);
    nasaRatesFromSimOmega(dq.x / s * angle / DT, dq.y / s * angle / DT, dq.z / s * angle / DT, out);
    return [out[0], out[1], out[2]];
}

const f = (x: number, w = 6, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a').padStart(w);

/** Run for `seconds`, calling `control(t, state)` each step, printing every `every` seconds. */
function run(
    name: string, model: Fm3FlightModel, seconds: number, every: number,
    control: (t: number, s: { alpha: number; q: number; p: number; r: number }) => void,
): { alpha: number[]; t: number[] } {
    console.log(`\n== ${name}`);
    console.log('   t s     α°     β°    p°/s   q°/s   r°/s  pitch°  bank°   V m/s   n     elev   ail    rud  alt m');
    const alphas: number[] = [];
    const times: number[] = [];
    let q0 = model.quaternion.clone();
    let p = 0, q = 0, r = 0;
    for (let i = 0; i <= seconds * 120; i++) {
        const t = i * DT;
        const alpha = model.getAngleOfAttack() * DEG;
        control(t, { alpha, q, p, r });
        model.update(DT);
        [p, q, r] = rates(q0, model.quaternion).map(v => v * DEG) as [number, number, number];
        q0 = model.quaternion.clone();
        alphas.push(model.getAngleOfAttack() * DEG);
        times.push(t);
        if (i % Math.round(every * 120) === 0) {
            const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(model.quaternion);
            // Starboard wing is sim −X.
            const wing = new THREE.Vector3(-1, 0, 0).applyQuaternion(model.quaternion);
            console.log(`${f(t, 6)} ${f(model.getAngleOfAttack() * DEG)} ${f(model.getSideslip() * DEG)} ${f(p)} ${f(q)} ${f(r)} ${f(Math.asin(nose.y) * DEG, 7)} ${f(-Math.asin(wing.y) * DEG, 6)} ${f(model.velocityVector.length(), 7)} ${f(model.getLoadFactorG(), 5, 2)} ${f(model.getCommandedElevator(), 6, 2)} ${f(model.getCommandedAileron(), 6, 2)} ${f(model.getCommandedRudder(), 6, 2)} ${f(model.position.y, 6, 0)}`);
        }
        if (model.isCrashed()) { console.log('   crashed'); break; }
    }
    return { alpha: alphas, t: times };
}

const which = process.argv[2] ?? 'all';

// A deep stall is a steep, nose-level descent: at α 58° the drag-to-lift ratio
// puts the flight path near −58° and the pitch attitude near level, and
// C_N·q̄·S ≈ W gives ~66 m/s at 9,144 m.
const DEEP_STALL = { altitude: 9144, speed: 66, alpha: 58, gamma: -58 };

if (which === 'all' || which === 'deepstall') {
    const m = f16(0.35);
    spawn(m, DEEP_STALL.altitude, DEEP_STALL.speed, DEEP_STALL.alpha, 0.3, false, DEEP_STALL.gamma);
    m.setPitch(-1);
    run('Deep stall from equilibrium: 9144 m, α 58° on a −58° path, full nose-down stick, limiters off, CG 0.35', m, 40, 2, () => { });
}

if (which === 'all' || which === 'entry') {
    const m = f16(0.35);
    spawn(m, 9144, 100, 10, 0.7, true);
    run('Entry by rolling at the AoA limit: 9144 m, 100 m/s, full aft + full right roll, limiters on, CG 0.35', m, 30, 2, () => {
        m.setPitch(1);
        m.setRoll(1);
    });
}

if (which === 'all' || which === 'rocking') {
    const m = f16(0.375);
    spawn(m, DEEP_STALL.altitude, DEEP_STALL.speed, DEEP_STALL.alpha, 0.3, false, DEEP_STALL.gamma);
    m.setPitch(-1);
    let recovered = false;
    run('Pitch rocking from deep stall, CG 0.375: full forward 10 s, then stick in phase with q until α < 30°', m, 60, 2, (t, s) => {
        if (t < 10) { m.setPitch(-1); return; }
        if (recovered || s.alpha < 30) { recovered = true; m.setPitch(-1); return; }
        m.setPitch(s.q > 0 ? 1 : -1);
    });
}

if (which === 'all' || which === 'rocking35') {
    const m = f16(0.35);
    spawn(m, DEEP_STALL.altitude, DEEP_STALL.speed, DEEP_STALL.alpha, 0.3, false, DEEP_STALL.gamma);
    let phase: 'hold' | 'rock' | 'recovered' = 'hold';
    run('Pitch rocking at CG 0.35: full forward 15 s in the deep stall, then stick in phase with q until α < 25°', m, 60, 2, (t, s) => {
        if (phase === 'hold' && t >= 15) phase = 'rock';
        if (phase === 'rock' && s.alpha < 25) phase = 'recovered';
        m.setPitch(phase === 'rock' ? (s.q > 0 ? 1 : -1) : -1);
    });
}

if (which === 'all' || which === 'coupling2') {
    for (const limiters of [false, true]) {
        const m = f16(limiters ? 0.35 : 0.375);
        spawn(m, 9144, 95, 20, 0.8, limiters);
        run(`Rolling at α ~20°: 9144 m, 95 m/s, stick 0.5 aft + full right roll after 1 s, limiters ${limiters ? 'on, CG 0.35' : 'off, CG 0.375'}`, m, 10, 0.5, (t) => {
            m.setPitch(0.5);
            m.setRoll(t > 1 ? 1 : 0);
        });
    }
}

if (which === 'all' || which === 'coupling') {
    for (const limiters of [false, true]) {
        const m = f16(limiters ? 0.35 : 0.375);
        spawn(m, 9144, 110, 12, 0.8, limiters);
        run(`Inertia coupling: 9144 m, 110 m/s, full aft + full right roll, limiters ${limiters ? 'on, CG 0.35' : 'off, CG 0.375'}`, m, 12, 1, () => {
            m.setPitch(0.6);
            m.setRoll(1);
        });
    }
}

if (which === 'all' || which === 'yaw') {
    const m = f16(0.35);
    spawn(m, 6000, 120, 15, 0.8, true);
    run('Yaw departure attempt: 6000 m, 120 m/s, full aft stick, full right pedal, full left roll, limiters on', m, 15, 1, () => {
        m.setPitch(1);
        m.setYaw(1);
        m.setRoll(-1);
    });
}

if (which === 'all' || which === 'tailslide') {
    const m = f16(0.35);
    spawn(m, 6000, 60, 5, 0, false);
    m.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -89 / DEG);
    m.velocityVector = new THREE.Vector3(0, 60, 0.5);
    m.syncEffectiveThrottle();
    m.snapPhysicsState();
    run('Tail slide: vertical at 60 m/s, idle, neutral stick', m, 30, 2, () => { });
}

if (which === 'all' || which === 'flatspin') {
    // A developed flat spin is a stable attractor at every CG, including the
    // reference one: the aircraft rotates about the vertical at ~95°/s with the
    // nose near level, α ~80°, descending ~75 m/s, and no control input stops it.
    // Entering one from level flight is another matter — see `flatspinentry`.
    const m = f16(0.35);
    spawn(m, 9144, 70, 70, 0, false);
    // Straight down at α 70°, already rotating 100°/s about the vertical.
    m.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), (90 - 70) / DEG);
    m.velocityVector = new THREE.Vector3(0, -70, 0);
    m.syncEffectiveThrottle();
    m.snapPhysicsState();
    const rate = new THREE.Vector3(0, 100 / DEG, 0).applyQuaternion(m.quaternion.clone().invert());
    const omega = (m as unknown as { rb: { omega: Float64Array } }).rb.omega;
    omega[0] = rate.x; omega[1] = rate.y; omega[2] = rate.z;
    run('Developed flat spin, CG 0.35: seeded at 100°/s, pro-spin controls held (full aft, rudder with the rotation, aileron against it)', m, 40, 5, () => {
        m.setPitch(1);
        m.setYaw(-1);
        m.setRoll(1);
    });
}

if (which === 'all' || which === 'flatspinentry') {
    // Getting into it from level flight needs the CG aft: cross-controls at high
    // α wind up into the spin at 0.40 c̄, while at 0.35 the departure tumbles
    // instead of organising into a rotation. Anti-spin controls at 40 s do
    // nothing, as they do not in the real airplane once a flat spin develops.
    const m = f16(0.40);
    spawn(m, 9144, 110, 8, 0, false);
    run('Flat spin entry, CG 0.40: full aft, then full right rudder and full left aileron past 45°; anti-spin controls at 40 s', m, 70, 5, (t, s) => {
        if (t > 40) {
            m.setPitch(-1);
            m.setYaw(-1);
            m.setRoll(0);
            return;
        }
        m.setPitch(1);
        m.setYaw(s.alpha > 45 ? 1 : 0);
        m.setRoll(s.alpha > 45 ? -1 : 0);
    });
}
