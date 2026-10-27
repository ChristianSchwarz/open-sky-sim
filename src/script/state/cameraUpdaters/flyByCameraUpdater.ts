import * as THREE from 'three';
import { COCKPIT_FOV } from '../../defs';
import { PlayerEntity } from '../../scene/entities/player';
import { FrameShift } from '../../terrain/geodesy';
import { UP } from '../../utils/math';
import { CameraUpdater } from './cameraUpdater';

/** Seconds of flight ahead of the aircraft the camera is dropped. */
const LEAD_S = 4;
const LEAD_MIN_M = 150;
const LEAD_MAX_M = 900;
/** Sideways and upward offset from the flight path, so it passes, not hits. */
const SIDE_M = 35;
const ABOVE_M = 8;
/** Clearance kept over the ground at the drop point. */
const GROUND_CLEARANCE_M = 4;
/** The aircraft this far past the camera (behind it, along the flight path) re-drops it. */
const REDROP_M = 400;
/** Half the subject size the zoom frames; smaller zooms in further. */
const FRAME_HALF_M = 25;
const MIN_FOV = 8;

/**
 * Flanker's F3: the camera is left hanging in the air ahead of the aircraft,
 * watches it go by, and is dropped ahead again once it is well past.
 */
export class FlyByCameraUpdater extends CameraUpdater {

    private readonly anchor = new THREE.Vector3();
    private placed = false;
    private _v = new THREE.Vector3();
    private _side = new THREE.Vector3();

    constructor(
        actor: PlayerEntity,
        camera: THREE.PerspectiveCamera,
        private readonly groundHeightAt: (x: number, z: number) => number,
    ) {
        super(actor, camera);
    }

    /** Drop the camera ahead again on the next update (a fresh F3). */
    reset(): void {
        this.placed = false;
    }

    /** The scene origin moved (floating-origin re-base). */
    rebase(shift: FrameShift): void {
        shift.point(this.anchor);
    }

    update(delta: number): void {
        const pos = this.actor.getDisplayPosition();
        const vel = this.actor.getDisplayVelocity();
        if (!this.placed || this.isWellPast(pos, vel)) {
            this.drop(pos, vel);
        }
        this.camera.position.copy(this.anchor);
        this.camera.up.copy(UP);
        this.camera.lookAt(pos);
        const dist = this.anchor.distanceTo(pos);
        const fov = THREE.MathUtils.clamp(
            THREE.MathUtils.radToDeg(2 * Math.atan(FRAME_HALF_M / Math.max(dist, 1))), MIN_FOV, COCKPIT_FOV);
        if (Math.abs(fov - this.camera.fov) > 0.01) {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
    }

    private isWellPast(pos: THREE.Vector3, vel: THREE.Vector3): boolean {
        this._v.subVectors(pos, this.anchor);
        const speed = vel.length();
        if (speed < 1) {
            // Parked or nearly so: only when it has wandered off.
            return this._v.length() > LEAD_MAX_M * 2;
        }
        return this._v.dot(vel) / speed > REDROP_M;
    }

    private drop(pos: THREE.Vector3, vel: THREE.Vector3): void {
        const speed = vel.length();
        if (speed < 1) {
            // No flight path to drop onto: off the nose instead.
            this._v.set(0, 0, 1).applyQuaternion(this.actor.getDisplayQuaternion()).setY(0);
            if (this._v.lengthSq() < 1e-6) this._v.set(0, 0, 1);
            this._v.normalize();
        } else {
            this._v.copy(vel).divideScalar(speed);
        }
        const lead = THREE.MathUtils.clamp(speed * LEAD_S, LEAD_MIN_M, LEAD_MAX_M);
        this._side.crossVectors(this._v, UP);
        if (this._side.lengthSq() < 1e-6) this._side.set(1, 0, 0);
        this._side.normalize();
        this.anchor
            .copy(pos)
            .addScaledVector(this._v, lead)
            .addScaledVector(this._side, SIDE_M)
            .addScaledVector(UP, ABOVE_M);
        const floor = this.groundHeightAt(this.anchor.x, this.anchor.z) + GROUND_CLEARANCE_M;
        if (this.anchor.y < floor) this.anchor.y = floor;
        this.placed = true;
    }
}
