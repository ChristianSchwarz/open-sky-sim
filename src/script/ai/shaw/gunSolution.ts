import * as THREE from 'three';
import { ballisticAimPoint, predictedMissDistance } from '../dogfightGeometry';
import { AircraftSnapshot } from './shawTypes';

/** Smoothing on the finite-difference target-acceleration estimate (as AceAiPilot). */
const TARGET_ACC_EMA = 0.25;
/** Cap (m/s^2, ~9 g) on that estimate, so a tumbling target does not throw the aim around. */
const TARGET_ACC_CAP = 90;

const ZERO = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _bulletVel = new THREE.Vector3();

/**
 * Finite-difference acceleration of the target, smoothed: the gun lead then
 * follows the bandit round its turn instead of along a straight line, which
 * at 6 g and 0.7 s time of flight is the 15 m difference between a hit and a
 * miss behind it.
 */
export class TargetAccelEstimator {
    private readonly prevVel = new THREE.Vector3();
    private readonly sample = new THREE.Vector3();
    private hasPrev = false;

    reset(): void {
        this.hasPrev = false;
    }

    update(out: THREE.Vector3, velocity: THREE.Vector3, delta: number): void {
        if (this.hasPrev && delta > 1e-4) {
            this.sample.copy(velocity).sub(this.prevVel).divideScalar(delta).clampLength(0, TARGET_ACC_CAP);
            out.lerp(this.sample, TARGET_ACC_EMA);
        } else {
            out.set(0, 0, 0);
        }
        this.prevVel.copy(velocity);
        this.hasPrev = true;
    }
}

/**
 * Unit direction to point the gun along for the round (which inherits our
 * own velocity and drops under gravity) to meet the target, into `out`.
 * Returns the time of flight (s).
 */
export function gunLeadDirection(
    out: THREE.Vector3, self: AircraftSnapshot, target: AircraftSnapshot, bulletSpeed: number,
): number {
    const tof = ballisticAimPoint(
        _aim, self.position, self.velocity,
        target.position, target.velocity, target.acceleration ?? ZERO, bulletSpeed,
    );
    out.copy(_aim).sub(self.position);
    if (out.lengthSq() < 1e-9) {
        out.copy(target.position).sub(self.position);
    }
    return tof;
}

/** How far (m) a round fired along our nose now would pass from the target. */
export function gunMissDistance(self: AircraftSnapshot, target: AircraftSnapshot, bulletSpeed: number): number {
    const tof = ballisticAimPoint(
        _aim, self.position, self.velocity,
        target.position, target.velocity, target.acceleration ?? ZERO, bulletSpeed,
    );
    _bulletVel.copy(self.forward).multiplyScalar(bulletSpeed).add(self.velocity);
    return predictedMissDistance(
        self.position, _bulletVel, target.position, target.velocity, target.acceleration ?? ZERO, tof,
    );
}
