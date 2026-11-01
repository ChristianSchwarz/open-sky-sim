import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
    angleOff, aspectAngle, ballisticAimPoint, closureRate, isHeadOnGunPass, predictedMissDistance, solveInterceptTime,
    specificEnergyHeight, trackingAngle,
} from './dogfightGeometry';

const DEG = Math.PI / 180;

describe('specificEnergyHeight', () => {
    it('equals altitude alone at zero speed', () => {
        assert.equal(specificEnergyHeight(1000, 0), 1000);
    });

    it('adds the altitude-equivalent of kinetic energy', () => {
        const speed = 100;
        const expected = 1000 + (speed * speed) / (2 * 9.80665);
        assert.ok(Math.abs(specificEnergyHeight(1000, speed) - expected) < 1e-6);
    });

    it('ranks a fast-but-low aircraft above a slow-but-only-slightly-higher one when speed dominates', () => {
        const fastLow = specificEnergyHeight(500, 250);
        const slowHigh = specificEnergyHeight(1000, 50);
        assert.ok(fastLow > slowHigh);
    });
});

describe('closureRate', () => {
    it('is positive (closing) when directly approaching a stationary target', () => {
        const myPos = new THREE.Vector3(0, 0, -1000);
        const myVel = new THREE.Vector3(0, 0, 100); // flying toward +Z, toward the target
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, 0);
        assert.ok(closureRate(myPos, myVel, targetPos, targetVel) > 0);
    });

    it('is negative (opening) when flying directly away from a stationary target', () => {
        const myPos = new THREE.Vector3(0, 0, -1000);
        const myVel = new THREE.Vector3(0, 0, -100); // flying away from the target
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, 0);
        assert.ok(closureRate(myPos, myVel, targetPos, targetVel) < 0);
    });

    it('is zero for a pure beam crossing (velocity perpendicular to the line of sight)', () => {
        const myPos = new THREE.Vector3(-1000, 0, 0);
        const myVel = new THREE.Vector3(0, 0, 100); // perpendicular to the line of sight (+X)
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, 0);
        assert.ok(Math.abs(closureRate(myPos, myVel, targetPos, targetVel)) < 1e-9);
    });

    it('adds both aircrafts closing speeds head-on', () => {
        const myPos = new THREE.Vector3(0, 0, -1000);
        const myVel = new THREE.Vector3(0, 0, 100);
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, -100); // flying toward me
        assert.ok(Math.abs(closureRate(myPos, myVel, targetPos, targetVel) - 200) < 1e-6);
    });
});

describe('trackingAngle', () => {
    it('is zero when the target is dead ahead', () => {
        const shooterPos = new THREE.Vector3(0, 0, 0);
        const shooterForward = new THREE.Vector3(0, 0, 1);
        const targetPos = new THREE.Vector3(0, 0, 500);
        assert.ok(Math.abs(trackingAngle(shooterPos, shooterForward, targetPos)) < 1e-9);
    });

    it('is pi when the target is dead behind', () => {
        const shooterPos = new THREE.Vector3(0, 0, 0);
        const shooterForward = new THREE.Vector3(0, 0, 1);
        const targetPos = new THREE.Vector3(0, 0, -500);
        assert.ok(Math.abs(trackingAngle(shooterPos, shooterForward, targetPos) - Math.PI) < 1e-9);
    });

    it('is pi/2 for a pure beam target', () => {
        const shooterPos = new THREE.Vector3(0, 0, 0);
        const shooterForward = new THREE.Vector3(0, 0, 1);
        const targetPos = new THREE.Vector3(500, 0, 0);
        assert.ok(Math.abs(trackingAngle(shooterPos, shooterForward, targetPos) - Math.PI / 2) < 1e-9);
    });
});

describe('aspectAngle', () => {
    it('is zero when the observer is dead astern of the target (best offensive position)', () => {
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, 100); // target flying toward +Z
        const observerPos = new THREE.Vector3(0, 0, -500); // behind the target
        assert.ok(Math.abs(aspectAngle(observerPos, targetPos, targetVel)) < 1e-9);
    });

    it('is pi when the observer is out in front of the target (head-on aspect)', () => {
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, 100);
        const observerPos = new THREE.Vector3(0, 0, 500); // ahead of the target
        assert.ok(Math.abs(aspectAngle(observerPos, targetPos, targetVel) - Math.PI) < 1e-9);
    });

    it('is pi/2 for a beam aspect', () => {
        const targetPos = new THREE.Vector3(0, 0, 0);
        const targetVel = new THREE.Vector3(0, 0, 100);
        const observerPos = new THREE.Vector3(500, 0, 0);
        assert.ok(Math.abs(aspectAngle(observerPos, targetPos, targetVel) - Math.PI / 2) < 1e-9);
    });
});

describe('angleOff', () => {
    it('is zero for parallel, same-direction velocities (in-trail)', () => {
        const myVel = new THREE.Vector3(0, 0, 100);
        const targetVel = new THREE.Vector3(0, 0, 250);
        assert.ok(Math.abs(angleOff(myVel, targetVel)) < 1e-9);
    });

    it('is pi for opposite velocities (head-on)', () => {
        const myVel = new THREE.Vector3(0, 0, 100);
        const targetVel = new THREE.Vector3(0, 0, -250);
        assert.ok(Math.abs(angleOff(myVel, targetVel) - Math.PI) < 1e-9);
    });

    it('is pi/2 for perpendicular flight paths', () => {
        const myVel = new THREE.Vector3(0, 0, 100);
        const targetVel = new THREE.Vector3(100, 0, 0);
        assert.ok(Math.abs(angleOff(myVel, targetVel) - Math.PI / 2) < 1e-9);
    });

    it('is insensitive to speed, only direction', () => {
        const myVel = new THREE.Vector3(0, 0, 30);
        const targetVel = new THREE.Vector3(Math.sin(45 * DEG) * 300, 0, Math.cos(45 * DEG) * 300);
        assert.ok(Math.abs(angleOff(myVel, targetVel) - 45 * DEG) < 1e-6);
    });
});

describe('solveInterceptTime', () => {
    it('lengthens time-of-flight when the target is moving away along the line of sight', () => {
        const relPos = new THREE.Vector3(0, 0, 900);
        const relVel = new THREE.Vector3(0, 0, 200);
        const tof = solveInterceptTime(relPos, relVel, 1000);
        assert.ok(tof > 0.9 && tof < 1.5);
    });

    it('shortens time-of-flight when the target is closing along the line of sight', () => {
        const relPos = new THREE.Vector3(0, 0, 900);
        const relVel = new THREE.Vector3(0, 0, -200);
        const tof = solveInterceptTime(relPos, relVel, 1000);
        assert.ok(tof > 0.7 && tof < 0.9);
    });
});

describe('ballisticAimPoint', () => {
    const zeroAcc = new THREE.Vector3();

    it('includes gravity hold-over above the linear lead point', () => {
        const myPos = new THREE.Vector3(0, 3000, 0);
        const myVel = new THREE.Vector3(0, 0, 220);
        const targetPos = new THREE.Vector3(0, 3000, 500);
        const targetVel = new THREE.Vector3(0, 0, 220);
        const aim = new THREE.Vector3();
        const tof = ballisticAimPoint(aim, myPos, myVel, targetPos, targetVel, zeroAcc, 1000);
        const naive = new THREE.Vector3().copy(targetPos).addScaledVector(targetVel, tof);
        assert.ok(aim.y > naive.y + 0.5, 'expected gravity hold-over above the naive lead');
        assert.ok(tof > 0.4 && tof < 0.6);
    });

    it('accounts for shooter velocity on a crossing shot', () => {
        const myPos = new THREE.Vector3(0, 3000, 0);
        const myVel = new THREE.Vector3(200, 0, 0);
        const targetPos = new THREE.Vector3(0, 3000, 500);
        const targetVel = new THREE.Vector3(0, 0, 220);
        const aim = new THREE.Vector3();
        ballisticAimPoint(aim, myPos, myVel, targetPos, targetVel, zeroAcc, 1000);
        const naive = new THREE.Vector3().copy(targetPos).addScaledVector(targetVel, 0.5);
        assert.ok(Math.abs(aim.x - naive.x) > 50, 'relative-velocity lead should shift the aim on a crossing shot');
    });
});

describe('predictedMissDistance', () => {
    const zeroAcc = new THREE.Vector3();

    it('is near zero for a perfect in-trail solution', () => {
        const shooterPos = new THREE.Vector3(0, 3000, 0);
        const bulletVel = new THREE.Vector3(0, 0, 1220);
        const targetPos = new THREE.Vector3(0, 3000, 500);
        const targetVel = new THREE.Vector3(0, 0, 220);
        const tof = 500 / 1000;
        const miss = predictedMissDistance(shooterPos, bulletVel, targetPos, targetVel, zeroAcc, tof);
        assert.ok(miss < 15);
    });

    it('reads a dead-on head-on shot as a hit, not as the gap between samples', () => {
        // Round and target close at 1430 m/s: sampled at 5 % of the time of
        // flight, this read as a ~35 m miss and the shot was never taken.
        const shooterPos = new THREE.Vector3(0, 3000, 0);
        const shooterVel = new THREE.Vector3(0, 0, 220);
        const targetPos = new THREE.Vector3(0, 3000, 1500);
        const targetVel = new THREE.Vector3(0, 0, -210);
        const aim = new THREE.Vector3();
        const tof = ballisticAimPoint(aim, shooterPos, shooterVel, targetPos, targetVel, zeroAcc, 1000);
        const bulletVel = aim.sub(shooterPos).normalize().multiplyScalar(1000).add(shooterVel);
        const miss = predictedMissDistance(shooterPos, bulletVel, targetPos, targetVel, zeroAcc, tof);
        assert.ok(miss < 1, `read ${miss.toFixed(1)} m`);
    });

    it('measures a real miss across the line of flight', () => {
        const shooterPos = new THREE.Vector3(0, 3000, 0);
        const targetPos = new THREE.Vector3(0, 3000, 1500);
        const targetVel = new THREE.Vector3(0, 0, -210);
        // Aimed off to the side of a target with nothing to lead: the round is
        // abeam it when it has closed the 1500 m, and that far to the side.
        const bulletVel = new THREE.Vector3(20, 0, 1500).normalize().multiplyScalar(1000);
        const tMeet = 1500 / (bulletVel.z + 210);
        bulletVel.y += 9.80665 * tMeet / 2; // hold over the drop
        const miss = predictedMissDistance(shooterPos, bulletVel, targetPos, targetVel, zeroAcc, tMeet);
        const expected = bulletVel.x * tMeet;
        assert.ok(Math.abs(miss - expected) < 0.5, `read ${miss.toFixed(1)} m, expected ${expected.toFixed(1)}`);
    });
});

describe('isHeadOnGunPass', () => {
    const me = new THREE.Vector3(0, 3000, 0);
    const myVel = new THREE.Vector3(0, 0, 220);

    it('is a bandit flying at us, inside gun range, with our nose toward it', () => {
        assert.equal(isHeadOnGunPass(me, myVel, new THREE.Vector3(100, 3000, 1500), new THREE.Vector3(0, 0, -210)), true);
    });

    it('is not a bandit flying away, or out of range, or off our nose', () => {
        assert.equal(isHeadOnGunPass(me, myVel, new THREE.Vector3(0, 3000, 1500), new THREE.Vector3(0, 0, 210)), false);
        assert.equal(isHeadOnGunPass(me, myVel, new THREE.Vector3(0, 3000, 2500), new THREE.Vector3(0, 0, -210)), false);
        assert.equal(isHeadOnGunPass(me, myVel, new THREE.Vector3(1500, 3000, 200), new THREE.Vector3(-210, 0, 0)), false);
    });

    it('takes a longer range and wider cone for setting the pass up', () => {
        const far = new THREE.Vector3(0, 3000, 2500);
        assert.equal(isHeadOnGunPass(me, myVel, far, new THREE.Vector3(0, 0, -210), 3000, Math.PI / 2), true);
    });
});
