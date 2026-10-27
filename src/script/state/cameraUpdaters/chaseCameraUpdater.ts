import * as THREE from 'three';
import { PlayerEntity } from '../../scene/entities/player';
import { UP } from '../../utils/math';
import { CameraUpdater } from './cameraUpdater';

const BEHIND_M = 28;
const ABOVE_M = 5;
const LOOK_AHEAD_M = 30;

/**
 * Flanker's F4: close behind the aircraft and bolted to it, rolling and
 * pitching with the airframe (F2 stays level and follows only the heading).
 */
export class ChaseCameraUpdater extends CameraUpdater {

    private _p = new THREE.Vector3();

    constructor(actor: PlayerEntity, camera: THREE.PerspectiveCamera) {
        super(actor, camera);
    }

    update(delta: number): void {
        const pos = this.actor.getDisplayPosition();
        const quat = this.actor.getDisplayQuaternion();
        // Body frame: +Z forward, +Y up.
        this.camera.position
            .set(0, ABOVE_M, -BEHIND_M)
            .applyQuaternion(quat)
            .add(pos);
        this.camera.up.copy(UP).applyQuaternion(quat);
        this._p
            .set(0, 0, LOOK_AHEAD_M)
            .applyQuaternion(quat)
            .add(pos);
        this.camera.lookAt(this._p);
    }
}
