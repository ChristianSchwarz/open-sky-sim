import * as THREE from 'three';
import { clamp } from '../utils/math';

const GRAVITY = 9.8;

/** FBW envelope margin: full authority until 1g below limit, then linear fade. */
export function computeF16EnvelopeAuthority(currentG: number, maxG: number): number {
    const margin = maxG - currentG;
    if (margin >= 1) {
        return 1;
    }
    if (margin <= 0) {
        return 0;
    }
    return margin;
}

/** Reduce nose-up pitch command as positive g approaches the FCS cap. */
export function computeF16PitchGLimit(currentG: number, pitchStick: number, maxG: number): number {
    if (pitchStick <= 0) {
        return 1;
    }
    return computeF16EnvelopeAuthority(currentG, maxG);
}

/** FBW alpha limiter: fade nose-up command as AOA approaches the stall. */
function computeF16PitchAoaAuthority(aoaRad: number, pitchStick: number, stallAoaRad: number): number {
    if (pitchStick <= 0) {
        return 1;
    }
    const limit = stallAoaRad * 0.95;
    if (aoaRad <= limit) {
        return 1;
    }
    return clamp(1 - (aoaRad - limit) / stallAoaRad, 0, 1);
}

/** Nose-down recovery rate (rad/s) when |AOA| exceeds the stall limit. */
function computeF16AoaRecoveryRate(aoaRad: number, stallAoaRad: number, speed: number): number {
    if (speed < 10) {
        return 0;
    }
    if (Math.abs(aoaRad) <= stallAoaRad) {
        return 0;
    }
    return clamp((Math.abs(aoaRad) - stallAoaRad) / stallAoaRad, 0, 1) * 0.35;
}

export function computeLoadFactorG(accel: THREE.Vector3, up: THREE.Vector3, gravity = GRAVITY): number {
    return (accel.x * up.x + (accel.y + gravity) * up.y + accel.z * up.z) / gravity;
}

/** Trim acceleration along body up so load factor does not exceed the FCS envelope. */
export function clampLoadFactorAcceleration(
    accel: THREE.Vector3,
    up: THREE.Vector3,
    maxG: number,
    gravity = GRAVITY,
): void {
    const n = computeLoadFactorG(accel, up, gravity);
    if (n <= maxG) {
        return;
    }
    accel.addScaledVector(up, (maxG - n) * gravity);
}
