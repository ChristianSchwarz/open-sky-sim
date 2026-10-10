/**
 * Dogfight geometry fixtures (workstream H). These helpers are pure functions
 * over vectors and numbers, which makes them the cleanest golden source in the
 * AI layer: the C# port must match them to ~1e-9.
 */
import * as THREE from 'three';
import {
    aspectAngle, angleOff, ballisticAimPoint, closureRate, predictedMissDistance,
    solveInterceptTime, specificEnergyHeight, trackingAngle,
} from '../../../src/script/ai/dogfightGeometry';
import { arr, Rng, SuiteOutput } from '../lib';

type V3 = [number, number, number];

export function dogfightSuite(): SuiteOutput {
    const rng = new Rng(0xD06F16);
    const vec = (span: number): V3 => [rng.range(-span, span), rng.range(-span, span), rng.range(-span, span)];
    const T = (v: V3) => new THREE.Vector3(v[0], v[1], v[2]);

    /** Random inputs plus the degenerate corners the guards exist for. */
    interface Scenario { myPos: V3; myVel: V3; tgtPos: V3; tgtVel: V3; tgtAcc: V3; fwd: V3 }
    const scenarios: Scenario[] = [];
    for (let i = 0; i < 80; i++) {
        scenarios.push({
            myPos: vec(6000), myVel: vec(350), tgtPos: vec(6000), tgtVel: vec(350), tgtAcc: vec(60), fwd: vec(1),
        });
    }
    scenarios.push(
        { myPos: [0, 0, 0], myVel: [0, 0, 250], tgtPos: [0, 0, 0], tgtVel: [0, 0, 200], tgtAcc: [0, 0, 0], fwd: [0, 0, 1] }, // coincident
        { myPos: [0, 0, 0], myVel: [0, 0, 0], tgtPos: [1000, 0, 0], tgtVel: [0, 0, 0], tgtAcc: [0, 0, 0], fwd: [0, 0, 0] }, // all zero
        { myPos: [0, 1000, 0], myVel: [0, 0, 250], tgtPos: [0, 1000, 2000], tgtVel: [0, 0, -250], tgtAcc: [0, 0, 0], fwd: [0, 0, 1] }, // head-on
        { myPos: [0, 1000, 0], myVel: [0, 0, 250], tgtPos: [0, 1000, 800], tgtVel: [0, 0, 250], tgtAcc: [0, 0, 0], fwd: [0, 0, 1] }, // in trail
        { myPos: [0, 1000, 0], myVel: [250, 0, 0], tgtPos: [1500, 1000, 1500], tgtVel: [0, 0, -250], tgtAcc: [0, 0, 0], fwd: [1, 0, 0] }, // crossing
        { myPos: [0, 0, 0], myVel: [0, 0, 300], tgtPos: [0, 0, 0.0000001], tgtVel: [0, 0, 300], tgtAcc: [0, 0, 0], fwd: [0, 0, 1] }, // sub-threshold range
    );

    const muzzleSpeeds = [800, 1000, 1200];

    const cases = scenarios.map((s, i) => {
        const muzzle = muzzleSpeeds[i % muzzleSpeeds.length];
        const relPos = T(s.tgtPos).sub(T(s.myPos));
        const relVel = T(s.tgtVel).sub(T(s.myVel));
        const aim = new THREE.Vector3();
        const tofAim = ballisticAimPoint(aim, T(s.myPos), T(s.myVel), T(s.tgtPos), T(s.tgtVel), T(s.tgtAcc), muzzle);
        const tof = solveInterceptTime(relPos, relVel, muzzle);
        // A round leaves the muzzle at muzzleSpeed along the (normalised) nose, plus the shooter's velocity.
        const nose = T(s.fwd);
        if (nose.lengthSq() > 1e-9) nose.normalize();
        const bulletVel = nose.clone().multiplyScalar(muzzle).add(T(s.myVel));
        return {
            ...s,
            muzzleSpeed: muzzle,
            speed: Math.hypot(s.myVel[0], s.myVel[1], s.myVel[2]),
            specificEnergyHeight: specificEnergyHeight(s.myPos[1], Math.hypot(s.myVel[0], s.myVel[1], s.myVel[2])),
            closureRate: closureRate(T(s.myPos), T(s.myVel), T(s.tgtPos), T(s.tgtVel)),
            trackingAngle: trackingAngle(T(s.myPos), T(s.fwd), T(s.tgtPos)),
            aspectAngle: aspectAngle(T(s.myPos), T(s.tgtPos), T(s.tgtVel)),
            angleOff: angleOff(T(s.myVel), T(s.tgtVel)),
            solveInterceptTime: tof,
            solveInterceptTimeClamped: solveInterceptTime(relPos, relVel, muzzle, 1.0),
            ballisticAimPoint: { point: arr(aim.toArray()), tof: tofAim },
            predictedMissDistance: predictedMissDistance(T(s.myPos), bulletVel, T(s.tgtPos), T(s.tgtVel), T(s.tgtAcc), tof),
        };
    });

    return {
        files: [{
            file: 'dogfight_geometry.json',
            data: {
                suite: 'dogfight_geometry',
                version: 1,
                source: 'src/script/ai/dogfightGeometry.ts',
                notes: [
                    'Scene axes (y up). Gravity is 9.80665 m/s^2.',
                    'bulletVel = normalize(fwd) * muzzleSpeed + myVel (zero fwd leaves just myVel).',
                    'solveInterceptTime default cap is 5 s; the Clamped variant passes maxTof = 1.',
                    'predictedMissDistance is evaluated at tof = solveInterceptTime for the scenario.',
                ],
                tolerances: { absolute: 1e-9, relativeLarge: 1e-12 },
                gravity: 9.80665,
                cases,
            },
        }],
    };
}
