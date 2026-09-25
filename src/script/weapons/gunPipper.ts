import * as THREE from 'three';

/** Matches combat-sim projectile gravity. */
const GUN_PROJECTILE_GRAVITY = 9.80665;

/** When no weapons target is locked, pipper uses this reference range (m). */
export const GUN_AIM_DEFAULT_RANGE_M = 500;

/**
 * Body-frame muzzle offset (m). Matches {@link PLAYER_GUN} / combat-sim spawn
 * so the pipper starts from the same point rounds leave the aircraft.
 */
export const GUN_MUZZLE_OFFSET = new THREE.Vector3(0, 0, 9);

const _bulletVel = new THREE.Vector3();
const _disp = new THREE.Vector3();

/**
 * Bullet world position after flying for `tof` seconds under gravity.
 * Rounds inherit shooter velocity + muzzle along the nose — same continuous
 * model as the combat-sim Euler integration (`vel.y -= gΔt; pos += velΔt`).
 */
export function bulletPositionAtTime(
    out: THREE.Vector3,
    gunPos: THREE.Vector3,
    bulletVel: THREE.Vector3,
    tof: number,
    gravity: number = GUN_PROJECTILE_GRAVITY,
): THREE.Vector3 {
    out.copy(gunPos).addScaledVector(bulletVel, tof);
    out.y -= 0.5 * gravity * tof * tof;
    return out;
}

/**
 * Time of flight (s) for a round to travel approximately `rangeM` along its
 * ballistic path. Starts from `|V|` and iterates so the muzzle-to-bullet
 * distance matches the requested range (gravity bends the path slightly).
 */
export function tofForRange(
    gunForward: THREE.Vector3,
    gunVel: THREE.Vector3,
    muzzleSpeed: number,
    rangeM: number,
    gravity: number = GUN_PROJECTILE_GRAVITY,
): number {
    _bulletVel.copy(gunForward).multiplyScalar(muzzleSpeed).add(gunVel);
    const speed = Math.max(1, _bulletVel.length());
    const range = Math.max(0, rangeM);
    let tof = range / speed;
    // Refine so |bullet(t) - muzzle| ≈ range. Two iterations are enough at
    // cannon speeds (~1 km/s) where gravity barely stretches path length.
    for (let i = 0; i < 2; i++) {
        _disp.copy(_bulletVel).multiplyScalar(tof);
        _disp.y -= 0.5 * gravity * tof * tof;
        const travelled = Math.max(1e-6, _disp.length());
        tof *= range / travelled;
    }
    return Math.max(0, tof);
}

/**
 * World-space gun pipper: where the bullets are after flying the current
 * target range (or {@link defaultRangeM} with no lock), including gravity drop.
 *
 * `gunPos` should be the muzzle world position (aircraft origin + body muzzle
 * offset). Put this circle on the target to score hits. Target motion is not
 * lead-compensated — the pilot leads by placing the pipper ahead of a mover.
 */
export function computeGunPipperWorldPoint(
    out: THREE.Vector3,
    gunPos: THREE.Vector3,
    gunForward: THREE.Vector3,
    gunVel: THREE.Vector3,
    muzzleSpeed: number,
    targetPos: THREE.Vector3 | undefined,
    defaultRangeM: number = GUN_AIM_DEFAULT_RANGE_M,
    gravity: number = GUN_PROJECTILE_GRAVITY,
): THREE.Vector3 {
    _bulletVel.copy(gunForward).multiplyScalar(muzzleSpeed).add(gunVel);
    const rangeM = targetPos
        ? Math.max(1, targetPos.distanceTo(gunPos))
        : defaultRangeM;
    const tof = tofForRange(gunForward, gunVel, muzzleSpeed, rangeM, gravity);
    return bulletPositionAtTime(out, gunPos, _bulletVel, tof, gravity);
}
