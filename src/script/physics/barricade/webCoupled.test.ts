/**
 * Phase 3 of the rigid-body barricade: the net stops the jet. Two-way: the
 * airframe is a body of its own mass that only the net's impulses (and its
 * tyres' rolling drag) slow, the purchase engines set for its weight (see
 * PurchaseEngine). No sim run-out: the catch is whatever the net does, and
 * after the stop the body stays free, so any roll-back is the webbing's own.
 *
 * Stage A: the body translates (attitude held). Each airframe at 5, 30 and
 * 60 m/s, caught centred and 3 m off either side, must:
 *  - stop within the MK-7's run-out ({@link MAX_RUN_OUT_M}), the peak
 *    deceleration (frame to frame) under the 5 g it is cleared for;
 *  - keep strap strain under 20 %, no particle deeper than the skin and no
 *    link through it;
 *  - account for the energy it lost within 15 % (tethers, ties, friction,
 *    drag, hysteresis, contact resets, tyre drag, the net's own energy);
 *  - be still, web and jet, within 3 s of the stop: every particle and the
 *    body under 0.2 m/s, the pilot holding the brakes from the stop
 *    ({@link BRAKE_MU});
 *  - cost at most 5 ms per 60 Hz frame of solver time.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as THREE from 'three';
import { BARRICADE_DECK_Y, BARRICADE_LOCAL_Z, BARRICADE_MID_X } from '../../scene/entities/barricadeSpec';
import { buildRiggedWeb } from './webLayout';
import { WebSolver } from './webSolver';
import { loadWebAirframe, WEB_FIXTURES, WebAirframe, WebFixture } from './webFixtures.testkit.test';
import { cpuMs, deckAndPayoutFails, MASS_KG, netEnergy, penetration } from './webHarness.testkit.test';

const DT = 1 / 60;
const G0 = 9.80665;
const SPEEDS = [5, 30, 60];
const OFFSETS = [0, -3, 3];
const MAX_MS_PER_FRAME = 5;
const MAX_STRAP_STRAIN = 0.2;
/** The MK-7 Mod 3's longest run-out, 344 ft (m). */
const MAX_RUN_OUT_M = 105;
const MAX_DECEL_G = 5;
const MAX_UNACCOUNTED = 0.15;
/** Stage B: the body's own energy books, and how far a centred catch may turn it (deg). */
const MAX_BODY_CREATED = 0.05;
const MAX_CENTRED_YAW_DEG = 2;
const SETTLED_MPS = 0.2;
/** Seconds after the stop by which web and jet must be still. */
const SETTLE_S = 3;
const SETTLE_WINDOW_F = 6;
/** Tyre rolling drag on the deck, as a fraction of weight (aircraft tyres, about 0.02). */
const ROLLING_DRAG = 0.02;
/**
 * Wheel brakes, held by the pilot once the jet has stopped, as a fraction of
 * weight: 0.3, a wet steel deck with anti-skid (dry runways give 0.5-0.6).
 * Without them the stretched webbing rolled every jet back 2-5 m and it was
 * still rolling at about 1 m/s three seconds later, on tyre drag alone.
 * WC_NOBRAKES leaves them off (the free roll-back, for comparison).
 */
const BRAKE_MU = process.env.WC_NOBRAKES ? 0 : 0.3;

interface CoupledResult {
    fixture: WebFixture;
    speed: number;
    offset: number;
    stopped: boolean;
    /** Travel from the net line to the first stop (m), and how far it rolled back after (m). */
    runOut: number;
    rollBack: number;
    peakG: number;
    stopS: number;
    deep: number;
    through: number;
    maxStrapStrain: number;
    unaccounted: number;
    /** Fastest particle (0.1 s displacement) and the body, SETTLE_S after the stop (m/s). */
    settledWeb: number;
    settledBody: number;
    /** Seconds after the stop of the last 0.1 s window with a particle at or over SETTLED_MPS (WC_SETTLE=<s> runs on that long). */
    settleTime?: number;
    msPerFrame: number;
}

function runCoupled(fixture: WebFixture, speed: number, offset: number): CoupledResult {
    const af = loadWebAirframe(fixture);
    const mass = MASS_KG[fixture];
    const layout = buildRiggedWeb({ engineSetKg: mass });
    const s = new WebSolver(layout);
    for (let f = 0; f < 120; f++) s.step(DT);
    const st = s.stats;
    const sinks = () => st.tetherWork + st.tieWork + st.frictionWork + st.dragWork + st.materialWork + st.contactResetLoss;
    const e0 = netEnergy(s), sinks0 = sinks();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const qInv = q.clone().invert();
    const position = new THREE.Vector3(BARRICADE_MID_X + offset, BARRICADE_DECK_Y - af.bounds[1], BARRICADE_LOCAL_Z + af.bounds[5] + 2);
    const velocity = new THREE.Vector3(0, 0, -speed);
    const body = { collider: af.collider, position, quaternion: q, velocity, mass, onDeck: true };
    const z0 = position.z - (af.bounds[5] + 2);
    let ms = 0, frames = 0, deep = 0, through = 0, maxStrap = 0, peak = 0, rollWork = 0;
    let stopF = -1, stopZ = NaN, maxBackZ = -Infinity;
    let settledWeb = Infinity, settledBody = Infinity, settleTime = 0;
    let from: Float64Array | null = null, winFrom: Float64Array | null = null;
    const maxFrames = Math.ceil(40 / DT);
    for (let f = 0; f < maxFrames; f++) {
        const v0 = velocity.clone();
        const t0 = cpuMs();
        s.stepRigid(DT, body);
        ms += cpuMs() - t0;
        frames++;
        // Tyre drag, and the brakes once stopped, against the motion, never past a stop.
        const sp = Math.hypot(velocity.x, velocity.z);
        if (sp > 0) {
            const dv = Math.min(sp, (ROLLING_DRAG + (stopF >= 0 ? BRAKE_MU : 0)) * G0 * DT);
            rollWork += 0.5 * mass * (sp * sp - (sp - dv) ** 2);
            velocity.x -= (velocity.x / sp) * dv;
            velocity.z -= (velocity.z / sp) * dv;
        }
        const a = velocity.clone().sub(v0).length() / DT;
        if (stopF < 0) peak = Math.max(peak, a);
        maxStrap = Math.max(maxStrap, st.maxStrapStrain);
        if (f % 10 === 0) {
            const p = penetration(s, af, position, qInv);
            deep = Math.max(deep, p.deep);
            through = Math.max(through, p.through);
        }
        if (stopF < 0 && velocity.z >= 0) {
            stopF = f;
            stopZ = position.z;
        }
        if (stopF >= 0) {
            maxBackZ = Math.max(maxBackZ, position.z);
            const g = f - stopF;
            const settleF = Math.round(SETTLE_S / DT);
            if (process.env.WC_RING && g % 30 === 0) {
                let ke = 0;
                for (let i = 0; i < s.count; i++) ke += 0.5 * layout.mass[i] * (s.v[3 * i] ** 2 + s.v[3 * i + 1] ** 2 + s.v[3 * i + 2] ** 2);
                console.log(`RING t+${(g * DT).toFixed(1)} KE ${ke.toFixed(1)} J sinks ${((sinks() - sinks0) / 1e3).toFixed(2)} kJ [fr ${(st.frictionWork / 1e3).toFixed(2)} dr ${(st.dragWork / 1e3).toFixed(2)} reset ${(st.contactResetLoss / 1e3).toFixed(2)} tether ${(st.tetherWork / 1e3).toFixed(2)}] bodyWork ${(st.bodyWork / 1e3).toFixed(2)} net ${((netEnergy(s) - e0) / 1e3).toFixed(2)} kJ maxSpeed ${st.maxSpeed.toFixed(2)}`);
            }
            if (g % SETTLE_WINDOW_F === 0) {
                if (winFrom) {
                    let m = 0;
                    for (let q2 = 0; q2 < s.count; q2++) {
                        const k3 = 3 * q2;
                        m = Math.max(m, Math.hypot(s.x[k3] - winFrom[k3], s.x[k3 + 1] - winFrom[k3 + 1], s.x[k3 + 2] - winFrom[k3 + 2]) / (SETTLE_WINDOW_F * DT));
                    }
                    if (m >= SETTLED_MPS) settleTime = g * DT;
                }
                winFrom = s.x.slice();
            }
            if (g === settleF - SETTLE_WINDOW_F) from = s.x.slice();
            if (g === settleF) {
                settledWeb = 0;
                for (let i = 0; i < s.count; i++) {
                    const k = 3 * i;
                    settledWeb = Math.max(settledWeb, Math.hypot(s.x[k] - from![k], s.x[k + 1] - from![k + 1], s.x[k + 2] - from![k + 2]) / (SETTLE_WINDOW_F * DT));
                }
                settledBody = velocity.length();
                if (process.env.WC_PROBE) {
                    const d = (i: number) => Math.hypot(s.x[3 * i] - from![3 * i], s.x[3 * i + 1] - from![3 * i + 1], s.x[3 * i + 2] - from![3 * i + 2]) / (SETTLE_WINDOW_F * DT);
                    const order = Array.from({ length: s.count }, (_, i) => i).sort((p2, q2) => d(q2) - d(p2)).slice(0, 10);
                    const rel = (i: number) => new THREE.Vector3(s.x[3 * i], s.x[3 * i + 1], s.x[3 * i + 2]).sub(position).applyQuaternion(qInv);
                    console.log(`MOVERS ${fixture} ${speed}: tether F ${st.tetherForce.map(v => (v / 1e3).toFixed(0)).join('/')} payout ${st.payout.map(v => v.toFixed(1)).join('/')} belt ${st.maxBeltStrain.toFixed(3)}; `
                        + order.map(i => { const r = rel(i); return `p${i} part ${layout.part[i]} pr ${s.bodyPressed[i]} (${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)}) ${d(i).toFixed(2)}`; }).join(' | '));
                }
            }
            if (g >= settleF && (!process.env.WC_SETTLE || g >= Math.round(Number(process.env.WC_SETTLE) / DT))) break;
        }
    }
    const energyLost = 0.5 * mass * (speed * speed - velocity.lengthSq());
    const unaccounted = (energyLost - (sinks() - sinks0) - rollWork - (netEnergy(s) - e0)) / energyLost;
    return {
        deckPay: deckAndPayoutFails(s), lowestY: s.stats.lowestY,
        fixture, speed, offset, stopped: stopF >= 0,
        runOut: z0 - stopZ, rollBack: maxBackZ - stopZ, peakG: peak / G0, stopS: stopF * DT,
        deep, through, maxStrapStrain: maxStrap, unaccounted,
        settledWeb, settledBody, settleTime, msPerFrame: ms / frames,
    };
}

// ---------------------------------------------------------------- stage B: the airframe turns

/**
 * Principal moments of inertia (kg m^2, body x pitch, y yaw, z roll) from mass
 * and size: the F-16's published values (Ixx 12,875, Iyy 75,674, Izz 85,552
 * kg m^2 at 9,295 kg; NASA TP-1538) as radii of gyration of its 15.0 m length
 * and 9.45 m span (pitch 0.19 L, yaw 0.20 L, roll 0.125 b), scaled to each
 * airframe. A fighter's mass sits near its middle, so a uniform box (0.29 L)
 * would overstate them twice over.
 */
function inertiaOf(af: WebAirframe, mass: number): THREE.Vector3 {
    const b = af.bounds;
    const L = b[5] - b[2], span = b[3] - b[0];
    return new THREE.Vector3(mass * (0.19 * L) ** 2, mass * (0.2 * L) ** 2, mass * (0.125 * span) ** 2);
}

/** A wheel: where its tyre meets the deck (body frame), its spring and damper, the weight share it carries at rest, and whether it castors. */
interface Wheel {
    readonly r: THREE.Vector3;
    readonly k: number;
    readonly c: number;
    readonly share: number;
    readonly castors: boolean;
}

/** The static stroke of every gear leg at rest (m): oleo struts sit about this far into their travel. */
const GEAR_STROKE_M = 0.15;
/**
 * Full stroke (m) and polytropic exponent of the oleo-pneumatic struts: a
 * gas spring, F = W ((s_max - s0) / (s_max - s))^n, stiffening toward
 * full stroke as the gas compresses (fighter struts travel 0.3-0.5 m). As a
 * linear spring, the nose wheel took 0.8 of the weight at 2.7 g, sank a
 * metre and put the nose on the deck, and the deck's friction there, ahead
 * of the CG, spun the jet round.
 */
const GEAR_FULL_STROKE_M = 0.4;
const GEAR_POLYTROPIC = 1.3;
const GEAR_ZETA = 0.4;

/** An oleo's spring force (N) at stroke s, carrying `weight` at the static stroke. */
function oleoForce(weight: number, s: number): number {
    const left = Math.max(GEAR_FULL_STROKE_M - s, 0.01);
    return weight * ((GEAR_FULL_STROKE_M - GEAR_STROKE_M) / left) ** GEAR_POLYTROPIC;
}

/** An oleo's stored energy (J) from full extension to stroke s. */
function oleoEnergy(weight: number, s: number): number {
    const n = GEAR_POLYTROPIC, S = GEAR_FULL_STROKE_M;
    const left = Math.max(S - s, 0.01);
    return (weight * (S - GEAR_STROKE_M) ** n / (n - 1)) * (left ** (1 - n) - S ** (1 - n));
}
/**
 * Side friction of a tyre on a wet deck. The nose wheel grips too: in an
 * arrestment the pilot keeps nose-wheel steering engaged, pedals neutral,
 * so it is steered straight, not castoring. Castoring, every 60 m/s catch
 * 3 m off-centre ground-looped 31-122 degrees, the pull acting ahead of
 * the CG and only the mains, 0.7 m behind it, resisting.
 */
const TYRE_SIDE_MU = 0.5;

/**
 * The weight on the nose wheel at rest. Tricycle-gear fighters carry 8-15 %
 * there; the drawn meshes' origins are not their centres of mass (the
 * F-22's sits 0.5 m ahead of its mains, 8 %), so the centre of mass is put
 * where this share puts it, on the line between nose wheel and mains, at
 * the origin's height.
 */
const NOSE_SHARE = 0.12;

/**
 * The gear from the collision mesh (whose wheels reach the deck; the
 * F-14's drawn nose wheels hang 20 cm clear of it): the vertices within
 * 15 cm of its lowest point are the tyres, those ahead of the origin the
 * nose wheel, the rest the mains on either side. Each leg is a spring sized
 * to sit GEAR_STROKE_M down under its share of the weight, damped at
 * GEAR_ZETA; its contact point is that much below the tyre, so the jet
 * starts at rest on its tyres. Also returns the centre of mass.
 */
function gearOf(af: WebAirframe, mass: number): { wheels: Wheel[]; com: THREE.Vector3 } {
    // From the drawn mesh: the collision mesh has no gear (withoutGear).
    const t = af.triangles, b = af.bounds;
    const groups = [{ x: 0, z: 0, n: 0 }, { x: 0, z: 0, n: 0 }, { x: 0, z: 0, n: 0 }];
    for (let k = 0; k < t.length; k += 3) {
        // The tyres: the F-14's nose wheels hang 20 cm above the mains' (only x and z are taken).
        if (t[k + 1] > b[1] + 0.3) continue;
        const g = t[k + 2] > 0 ? groups[0] : t[k] > 0 ? groups[1] : groups[2];
        g.x += t[k]; g.z += t[k + 2]; g.n++;
    }
    const pts = groups.map(g => new THREE.Vector3(g.x / g.n, b[1] - GEAR_STROKE_M, g.z / g.n));
    const zMain = (pts[1].z + pts[2].z) / 2, zNose = pts[0].z;
    const com = new THREE.Vector3(0, 0, zMain + NOSE_SHARE * (zNose - zMain));
    const shares = [NOSE_SHARE, (1 - NOSE_SHARE) / 2, (1 - NOSE_SHARE) / 2];
    const wheels = pts.map((r, i) => {
        const k = (shares[i] * mass * G0) / GEAR_STROKE_M;
        return { r, k, c: 2 * GEAR_ZETA * Math.sqrt(k * shares[i] * mass), share: shares[i], castors: false };
    });
    return { wheels, com };
}

/**
 * The underside that can strike the deck: the lowest collision-mesh vertex
 * in each 0.5 m cell of the planform. Nothing but the gear held the jet
 * up, and the net's pull, aft and up at the wings' leading edges above the
 * CG, rocked the F-22 back on its mains 25 degrees with the tail through the
 * deck.
 */
function bellyOf(af: WebAirframe): THREE.Vector3[] {
    const t = af.collisionTriangles;
    const cells = new Map<string, THREE.Vector3>();
    for (let k = 0; k < t.length; k += 3) {
        const key = `${Math.floor(t[k] / 0.5)},${Math.floor(t[k + 2] / 0.5)}`;
        const c = cells.get(key);
        if (!c || t[k + 1] < c.y) cells.set(key, new THREE.Vector3(t[k], t[k + 1], t[k + 2]));
    }
    // The gear's own tyres are the wheels' business.
    return [...cells.values()].filter(p => p.y > af.bounds[1] + 0.2);
}
/**
 * A point of the hull on the deck is a one-sided contact at the velocity
 * level: an impulse through the point's effective mass that stops it going
 * further down, a fraction HULL_PUSH of its depth taken out per substep,
 * and Coulomb friction (HULL_MU) along the deck. As penalty springs, a few
 * hundred of them damped near critical each went unstable together and
 * pitched the F-14 31 degrees into the deck.
 */
const HULL_PUSH = 0.2;
const HULL_MU = 0.5;

interface TurningResult extends CoupledResult {
    /** Heading change (deg, + is nose toward carrier +x), at the stop and at the end; peak yaw rate (deg/s). */
    yawAtStop: number;
    yawEnd: number;
    peakYawRate: number;
    /** Pitch (deg, + nose up) and roll (deg, + left wing down) at the end, and the most nose-down pitch. */
    pitchEnd: number;
    rollEnd: number;
    minPitch: number;
    maxPitch: number;
    /** Substep-points of hull on the deck (a tail or belly strike if any). */
    hullHits: number;
    /** Energy the body gained that neither the net nor the deck gave it, as a share of its work on the net. */
    bodyCreated: number;
}

/** Heading, pitch and roll of an attitude against the start (deg). */
function attitude(q: THREE.Quaternion, q0: THREE.Quaternion): { yaw: number; pitch: number; roll: number } {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q), fwd0 = new THREE.Vector3(0, 0, 1).applyQuaternion(q0);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const yaw = Math.atan2(fwd.x * fwd0.z - fwd.z * fwd0.x, fwd.x * fwd0.x + fwd.z * fwd0.z);
    return { yaw: (yaw * 180) / Math.PI, pitch: (Math.asin(fwd.y) * 180) / Math.PI, roll: (Math.asin(-right.y) * 180) / Math.PI };
}

function runTurning(fixture: WebFixture, speed: number, offset: number): TurningResult {
    const af = loadWebAirframe(fixture);
    const mass = MASS_KG[fixture];
    const layout = buildRiggedWeb({ engineSetKg: mass });
    const s = new WebSolver(layout);
    for (let f = 0; f < 120; f++) s.step(DT);
    const st = s.stats;
    const sinks = () => st.tetherWork + st.tieWork + st.frictionWork + st.dragWork + st.materialWork + st.contactResetLoss;
    const e0 = netEnergy(s), sinks0 = sinks(), work0 = st.bodyWork;
    const q0 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    const quaternion = q0.clone();
    const position = new THREE.Vector3(BARRICADE_MID_X + offset, BARRICADE_DECK_Y - af.bounds[1], BARRICADE_LOCAL_Z + af.bounds[5] + 2);
    const velocity = new THREE.Vector3(0, 0, -speed);
    const angularVelocity = new THREE.Vector3();
    const inertia = inertiaOf(af, mass);
    const { wheels, com } = gearOf(af, mass);
    const belly = bellyOf(af);
    let stopped = false, hullHits = 0;
    const R = new THREE.Matrix4(), Rt = new THREE.Matrix4();
    const P = new THREE.Vector3(), rw = new THREE.Vector3(), vP = new THREE.Vector3(), J = new THREE.Vector3(), dw = new THREE.Vector3();
    const fwd = new THREE.Vector3(), side = new THREE.Vector3();
    const tdir = new THREE.Vector3(), rn = new THREE.Vector3();
    // The effective mass of the body at world offset rw from the CG, along (nx, ny, nz).
    const pointMass = (r: THREE.Vector3, nx: number, ny: number, nz: number) => {
        rn.set(r.y * nz - r.z * ny, r.z * nx - r.x * nz, r.x * ny - r.y * nx).applyMatrix4(Rt);
        const k = rn.x * rn.x / inertia.x + rn.y * rn.y / inertia.y + rn.z * rn.z / inertia.z;
        return 1 / (1 / mass + k);
    };
    // An impulse J at world offset rw from the CG, into both velocities.
    let extWork = 0;
    const vBefore = new THREE.Vector3();
    const push = () => {
        vBefore.crossVectors(angularVelocity, rw).add(velocity);
        velocity.addScaledVector(J, 1 / mass);
        dw.crossVectors(rw, J).applyMatrix4(Rt);
        dw.set(dw.x / inertia.x, dw.y / inertia.y, dw.z / inertia.z).applyMatrix4(R);
        angularVelocity.add(dw);
        // Its work: the impulse times the point's mean velocity over it.
        vP.crossVectors(angularVelocity, rw).add(velocity).add(vBefore).multiplyScalar(0.5);
        extWork += J.dot(vP);
    };
    // The body's own energy: motion, turning, height of its centre of mass and its gear springs.
    const cgW = new THREE.Vector3(), wb = new THREE.Vector3(), Pw = new THREE.Vector3();
    const bodyEnergy = () => {
        wb.copy(angularVelocity).applyQuaternion(qInvB.copy(quaternion).invert());
        cgW.copy(com).applyQuaternion(quaternion).add(position);
        let e = 0.5 * mass * velocity.lengthSq() + 0.5 * (inertia.x * wb.x ** 2 + inertia.y * wb.y ** 2 + inertia.z * wb.z ** 2) + mass * G0 * cgW.y;
        for (const w of wheels) {
            Pw.copy(w.r).applyQuaternion(quaternion).add(position);
            const d = BARRICADE_DECK_Y - Pw.y;
            if (d > 0) e += oleoEnergy(w.share * mass * G0, d);
        }
        return e;
    };
    const qInvB = new THREE.Quaternion();
    const forces = (h: number) => {
        velocity.y -= G0 * h;
        R.makeRotationFromQuaternion(quaternion);
        Rt.copy(R).transpose();
        fwd.set(0, 0, 1).applyQuaternion(quaternion).setY(0).normalize();
        side.set(-fwd.z, 0, fwd.x);
        for (const w of wheels) {
            P.copy(w.r).applyMatrix4(R).add(position);
            rw.copy(w.r).sub(com).applyMatrix4(R);
            const d = BARRICADE_DECK_Y - P.y;
            if (d <= 0) continue;
            vP.crossVectors(angularVelocity, rw).add(velocity);
            const N = Math.max(0, oleoForce(w.share * mass * G0, d) - w.c * vP.y) * h;
            J.set(0, N, 0);
            push();
            // Along the wheel: rolling drag, and the brakes once stopped; across it, the tyre grip.
            const m = w.share * mass;
            vP.crossVectors(angularVelocity, rw).add(velocity);
            const vl = vP.dot(fwd), vs = vP.dot(side);
            const jl = -Math.sign(vl) * Math.min((ROLLING_DRAG + (stopped ? BRAKE_MU : 0)) * N, Math.abs(vl) * m);
            const js = w.castors ? 0 : -Math.sign(vs) * Math.min(TYRE_SIDE_MU * N, Math.abs(vs) * m);
            J.copy(fwd).multiplyScalar(jl).addScaledVector(side, js);
            push();
        }
        for (const r of belly) {
            P.copy(r).applyMatrix4(R).add(position);
            const d = BARRICADE_DECK_Y - P.y;
            if (d <= 0) continue;
            rw.copy(r).sub(com).applyMatrix4(R);
            vP.crossVectors(angularVelocity, rw).add(velocity);
            const target = (HULL_PUSH * d) / h;
            if (vP.y >= target) continue;
            const N = (target - vP.y) * pointMass(rw, 0, 1, 0);
            J.set(0, N, 0);
            push();
            vP.crossVectors(angularVelocity, rw).add(velocity);
            const vt = Math.hypot(vP.x, vP.z);
            if (vt > 1e-9) {
                tdir.set(-vP.x / vt, 0, -vP.z / vt);
                const jt = Math.min(HULL_MU * N, vt * pointMass(rw, tdir.x, 0, tdir.z));
                J.copy(tdir).multiplyScalar(jt);
                push();
            }
            hullHits++;
        }
    };
    const body = { collider: af.collider, position, quaternion, velocity, angularVelocity, mass, inertia, centerOfMass: com, forces };
    const eBody0 = bodyEnergy();
    const z0 = position.z - (af.bounds[5] + 2);
    let ms = 0, frames = 0, deep = 0, through = 0, maxStrap = 0, peak = 0;
    let stopF = -1, stopZ = NaN, maxBackZ = -Infinity, yawAtStop = 0, peakYawRate = 0, minPitch = 0, maxPitch = 0;
    let settledWeb = Infinity, settledBody = Infinity;
    let from: Float64Array | null = null;
    const qInv = new THREE.Quaternion();
    for (let f = 0; f < Math.ceil(30 / DT); f++) {
        const v0 = velocity.clone();
        const t0 = cpuMs();
        s.stepDynamic(DT, body);
        ms += cpuMs() - t0;
        frames++;
        const a = Math.hypot(velocity.x - v0.x, velocity.z - v0.z) / DT;
        if (stopF < 0) peak = Math.max(peak, a);
        if (process.env.WC_WORST && st.maxStrapStrain > Number(process.env.WC_WORST) && st.maxStrapStrain > maxStrap) {
            let best = 0, bs = -1;
            layout.straps.forEach((strap, si) => {
                for (let n = 1; n < strap.length; n++) {
                    const a3 = 3 * strap[n - 1], b3 = 3 * strap[n];
                    const rest = layout.links.find(l => (l.i === strap[n - 1] && l.j === strap[n]) || (l.j === strap[n - 1] && l.i === strap[n]))!.rest;
                    const e = Math.hypot(s.x[b3] - s.x[a3], s.x[b3 + 1] - s.x[a3 + 1], s.x[b3 + 2] - s.x[a3 + 2]) / rest - 1;
                    if (e > best) { best = e; bs = si; }
                }
            });
            const strap = layout.straps[bs];
            qInv.copy(quaternion).invert();
            const strains = strap.slice(1).map((j2, n) => {
                const a3 = 3 * strap[n], b3 = 3 * j2;
                const rest = layout.links.find(l => (l.i === strap[n] && l.j === j2) || (l.j === strap[n] && l.i === j2))!.rest;
                return (100 * (Math.hypot(s.x[b3] - s.x[a3], s.x[b3 + 1] - s.x[a3 + 1], s.x[b3 + 2] - s.x[a3 + 2]) / rest - 1)).toFixed(0);
            });
            const rows = strap.map(i => { const r = new THREE.Vector3(s.x[3 * i], s.x[3 * i + 1], s.x[3 * i + 2]).sub(position).applyQuaternion(qInv); return `${s.bodyPressed[i] ? '*' : ''}(${r.x.toFixed(1)},${r.y.toFixed(1)},${r.z.toFixed(1)})`; });
            const at = attitude(quaternion, q0);
            console.log(`WORST f${f} strap ${bs} ${(100 * best).toFixed(1)} % pitch ${at.pitch.toFixed(1)} F ${st.tetherForce.map(v => (v / 1e3).toFixed(0)).join('/')}: strains ${strains.join(' ')} | ${rows.join(' ')}`);
        }
        maxStrap = Math.max(maxStrap, st.maxStrapStrain);
        peakYawRate = Math.max(peakYawRate, (Math.abs(angularVelocity.y) * 180) / Math.PI);
        minPitch = Math.min(minPitch, attitude(quaternion, q0).pitch);
        if (process.env.WC_GEAR && f % 6 === 0 && f < 300) {
            const at = attitude(quaternion, q0);
            const dn = wheels.map(w => (BARRICADE_DECK_Y - P.copy(w.r).applyQuaternion(quaternion).add(position).y).toFixed(2));
            const M = st.reactionMoment;
            const Mb = new THREE.Vector3(-M[0], -M[1], -M[2]).applyQuaternion(qInv.copy(quaternion).invert());
            console.log(`GEAR f${f} pitch ${at.pitch.toFixed(1)} yaw ${at.yaw.toFixed(1)} v ${velocity.length().toFixed(1)} strokes ${dn.join('/')} hull ${hullHits} netMomentBody (${(Mb.x / DT / 1e3).toFixed(0)}, ${(Mb.y / DT / 1e3).toFixed(0)}, ${(Mb.z / DT / 1e3).toFixed(0)}) kNm F ${(-st.reaction[2] / DT / 1e3).toFixed(0)} kN up ${(-st.reaction[1] / DT / 1e3).toFixed(0)} kN`);
        }
        maxPitch = Math.max(maxPitch, attitude(quaternion, q0).pitch);
        if (f % 10 === 0) {
            qInv.copy(quaternion).invert();
            const p = penetration(s, af, position, qInv);
            deep = Math.max(deep, p.deep);
            through = Math.max(through, p.through);
        }
        if (stopF < 0 && velocity.dot(fwd.set(0, 0, 1).applyQuaternion(quaternion)) <= 0) {
            stopF = f;
            stopZ = position.z;
            stopped = true;
            yawAtStop = attitude(quaternion, q0).yaw;
        }
        if (stopF >= 0) {
            maxBackZ = Math.max(maxBackZ, position.z);
            const g = f - stopF;
            const settleF = Math.round(SETTLE_S / DT);
            if (g === settleF - SETTLE_WINDOW_F) from = s.x.slice();
            if (g === settleF) {
                settledWeb = 0;
                for (let i = 0; i < s.count; i++) {
                    const k = 3 * i;
                    settledWeb = Math.max(settledWeb, Math.hypot(s.x[k] - from![k], s.x[k + 1] - from![k + 1], s.x[k + 2] - from![k + 2]) / (SETTLE_WINDOW_F * DT));
                }
                settledBody = Math.hypot(velocity.x, velocity.z);
                break;
            }
        }
    }
    const work = st.bodyWork - work0;
    const att = attitude(quaternion, q0);
    // The body's books: what it lost is what it gave the net and what the deck took.
    const bodyCreated = (bodyEnergy() - eBody0 + work - extWork) / Math.max(work, 1);
    return {
        deckPay: deckAndPayoutFails(s), lowestY: s.stats.lowestY,
        fixture, speed, offset, stopped: stopF >= 0,
        runOut: z0 - stopZ, rollBack: maxBackZ - stopZ, peakG: peak / G0, stopS: stopF * DT,
        deep, through, maxStrapStrain: maxStrap,
        // The net's own books: what the airframe put in, less what the sinks took and the net kept.
        unaccounted: (work - (sinks() - sinks0) - (netEnergy(s) - e0)) / Math.max(work, 1),
        settledWeb, settledBody, msPerFrame: ms / frames,
        yawAtStop, yawEnd: att.yaw, peakYawRate, pitchEnd: att.pitch, rollEnd: att.roll, minPitch,
        maxPitch, hullHits, bodyCreated,
    };
}

let riggedMs = 0;

describe('barricade webbing, coupled: reference', () => {
    it('rigged net cost', () => {
        const s = new WebSolver(buildRiggedWeb({ engineSetKg: 20e3 }));
        for (let f = 0; f < 60; f++) s.step(DT);
        const t0 = cpuMs();
        for (let f = 0; f < 300; f++) s.step(DT);
        riggedMs = (cpuMs() - t0) / 300;
        console.log(`rigged: ${riggedMs.toFixed(2)} ms/frame`);
    });
});

for (const speed of SPEEDS) {
    describe(`barricade webbing, coupled: stage A at ${speed} m/s`, () => {
        for (const offset of OFFSETS) {
            for (const fixture of WEB_FIXTURES) {
                it(`${fixture}, ${offset === 0 ? 'centred' : `${offset > 0 ? '+' : ''}${offset} m`}`, () => {
                    const r = runCoupled(fixture, speed, offset);
                    const line = `${fixture} @ ${speed} m/s, x ${offset}: ${JSON.stringify({
                        stopped: r.stopped, runOut: +r.runOut.toFixed(1), rollBack: +r.rollBack.toFixed(2),
                        peakG: +r.peakG.toFixed(2), stopS: +r.stopS.toFixed(1),
                        deep: r.deep, through: r.through, strain: +r.maxStrapStrain.toFixed(3),
                        unaccounted: +r.unaccounted.toFixed(4),
                        settledWeb: +r.settledWeb.toFixed(3), settledBody: +r.settledBody.toFixed(3), settleTime: r.settleTime,
                        ms: +r.msPerFrame.toFixed(2), vsRigged: riggedMs > 0 ? +(r.msPerFrame / riggedMs).toFixed(2) : null,
                    })}`;
                    console.log(line);
                    const fails: string[] = [...r.deckPay];
                    if (!r.stopped) fails.push('not stopped');
                    if (r.runOut > MAX_RUN_OUT_M) fails.push(`run-out ${r.runOut.toFixed(1)} m`);
                    if (r.peakG >= MAX_DECEL_G) fails.push(`peak ${r.peakG.toFixed(2)} g`);
                    if (r.deep > 0) fails.push(`${r.deep} particles deeper than the skin`);
                    if (r.through > 0) fails.push(`${r.through} links through the skin`);
                    if (r.maxStrapStrain >= MAX_STRAP_STRAIN) fails.push(`strap strain ${(100 * r.maxStrapStrain).toFixed(1)} %`);
                    if (Math.abs(r.unaccounted) > MAX_UNACCOUNTED) fails.push(`${(100 * r.unaccounted).toFixed(1)} % of the energy unaccounted`);
                    if (!(r.settledWeb < SETTLED_MPS)) fails.push(`web at ${r.settledWeb.toFixed(2)} m/s ${SETTLE_S} s after the stop`);
                    if (!(r.settledBody < SETTLED_MPS)) fails.push(`jet at ${r.settledBody.toFixed(2)} m/s ${SETTLE_S} s after the stop`);
                    if (r.msPerFrame > MAX_MS_PER_FRAME) fails.push(`${r.msPerFrame.toFixed(2)} ms/frame`);
                    assert.deepEqual(fails, [], line);
                });
            }
        }
    });
}

for (const speed of SPEEDS) {
    describe(`barricade webbing, coupled: stage B at ${speed} m/s`, () => {
        for (const offset of OFFSETS) {
            for (const fixture of WEB_FIXTURES) {
                it(`${fixture}, ${offset === 0 ? 'centred' : `${offset > 0 ? '+' : ''}${offset} m`}`, () => {
                    const r = runTurning(fixture, speed, offset);
                    const line = `B ${fixture} @ ${speed} m/s, x ${offset}: ${JSON.stringify({
                        stopped: r.stopped, runOut: +r.runOut.toFixed(1), rollBack: +r.rollBack.toFixed(2),
                        peakG: +r.peakG.toFixed(2), stopS: +r.stopS.toFixed(1),
                        deep: r.deep, through: r.through, strain: +r.maxStrapStrain.toFixed(3),
                        unaccounted: +r.unaccounted.toFixed(4),
                        settledWeb: +r.settledWeb.toFixed(3), settledBody: +r.settledBody.toFixed(3),
                        yawAtStop: +r.yawAtStop.toFixed(2), yawEnd: +r.yawEnd.toFixed(2), peakYawRate: +r.peakYawRate.toFixed(2),
                        pitchEnd: +r.pitchEnd.toFixed(2), minPitch: +r.minPitch.toFixed(2), maxPitch: +r.maxPitch.toFixed(2), rollEnd: +r.rollEnd.toFixed(2), hullHits: r.hullHits, bodyCreated: +r.bodyCreated.toFixed(4),
                        ms: +r.msPerFrame.toFixed(2), vsRigged: riggedMs > 0 ? +(r.msPerFrame / riggedMs).toFixed(2) : null,
                    })}`;
                    console.log(line);
                    const fails: string[] = [...r.deckPay];
                    if (!r.stopped) fails.push('not stopped');
                    if (r.runOut > MAX_RUN_OUT_M) fails.push(`run-out ${r.runOut.toFixed(1)} m`);
                    if (r.peakG >= MAX_DECEL_G) fails.push(`peak ${r.peakG.toFixed(2)} g`);
                    if (r.deep > 0) fails.push(`${r.deep} particles deeper than the skin`);
                    if (r.through > 0) fails.push(`${r.through} links through the skin`);
                    if (r.maxStrapStrain >= MAX_STRAP_STRAIN) fails.push(`strap strain ${(100 * r.maxStrapStrain).toFixed(1)} %`);
                    if (Math.abs(r.unaccounted) > MAX_UNACCOUNTED) fails.push(`${(100 * r.unaccounted).toFixed(1)} % of the energy unaccounted`);
                    if (!(r.settledWeb < SETTLED_MPS)) fails.push(`web at ${r.settledWeb.toFixed(2)} m/s ${SETTLE_S} s after the stop`);
                    if (!(r.settledBody < SETTLED_MPS)) fails.push(`jet at ${r.settledBody.toFixed(2)} m/s ${SETTLE_S} s after the stop`);
                    if (r.msPerFrame > MAX_MS_PER_FRAME) fails.push(`${r.msPerFrame.toFixed(2)} ms/frame`);
                    // Turning: the body's own books close, and a centred catch stays straight
                    // (the rig is mirror-symmetric to 1e-10, the meshes nearly so).
                    if (Math.abs(r.bodyCreated) > MAX_BODY_CREATED) fails.push(`${(100 * r.bodyCreated).toFixed(1)} % of the body's energy unaccounted`);
                    if (offset === 0 && Math.abs(r.yawEnd) > MAX_CENTRED_YAW_DEG) fails.push(`centred catch yawed ${r.yawEnd.toFixed(1)} deg`);
                    assert.deepEqual(fails, [], line);
                });
            }
        }
    });
}
