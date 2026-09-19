import * as THREE from 'three';

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
