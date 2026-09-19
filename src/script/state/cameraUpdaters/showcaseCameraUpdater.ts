import * as THREE from 'three';
import { FORWARD, UP } from '../../utils/math';
import { CameraUpdater } from './cameraUpdater';

export class ShowcaseCameraUpdater extends CameraUpdater {

    private side = new THREE.Vector3();

    update(_delta: number): void {
        const pivot = this.actor.getDisplayPosition();
        this.side.set(FORWARD.z, 0, -FORWARD.x);
        this.camera.position
            .copy(pivot)
            .addScaledVector(this.side, 35)
            .addScaledVector(UP, 5);
        this.camera.up.copy(UP);
        this.camera.lookAt(pivot);
    }
}
