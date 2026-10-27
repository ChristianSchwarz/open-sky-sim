import * as THREE from 'three';
import { PlayerEntity } from "../../scene/entities/player";
import { FORWARD, UP } from '../../utils/math';
import { CameraUpdater } from "./cameraUpdater";

/** Height the locked camera keeps over the ground (m). */
const LOCK_GROUND_CLEARANCE_M = 3;

export enum ExteriorViewHeading {
    FRONT,
    BACK
}

export class ExteriorFrontBehindCameraUpdater extends CameraUpdater {

    private _v = new THREE.Vector3();
    private _p = new THREE.Vector3();
    private lookAtTarget: (() => THREE.Vector3 | undefined) | undefined;

    constructor(
        actor: PlayerEntity,
        camera: THREE.PerspectiveCamera,
        private heading: ExteriorViewHeading,
        private readonly groundHeightAt: (x: number, z: number) => number = () => -Infinity,
    ) {
        super(actor, camera);
    }

    /** Lock on: where the target is now, or undefined when it has gone (the plain view returns). */
    setLookAtTarget(target: (() => THREE.Vector3 | undefined) | undefined): void {
        this.lookAtTarget = target;
    }

    update(delta: number): void {
        const playerPos = this.actor.getDisplayPosition();

        const enemyPos = this.lookAtTarget?.();
        if (enemyPos) {
            // On the line from the target through the player, aimed at the
            // player: it stays centred with the target straight on behind it,
            // above or below alike, and the numpad orbit turns round it.
            this._v.subVectors(playerPos, enemyPos);
            if (this._v.lengthSq() < 1) {
                this._v.copy(FORWARD).applyQuaternion(this.actor.getDisplayQuaternion()).negate();
            }
            this._v.normalize();
            this.camera.up.copy(UP);
            this.camera.position
                .copy(playerPos)
                .addScaledVector(this._v, 40)
                .addScaledVector(UP, 5);
            // A target well above puts the line underground: stay over it.
            const floor = this.groundHeightAt(this.camera.position.x, this.camera.position.z) + LOCK_GROUND_CLEARANCE_M;
            if (this.camera.position.y < floor) {
                this.camera.position.y = floor;
            }
            this.camera.lookAt(playerPos);
            return;
        }

        this._v
            .copy(FORWARD)
            .applyQuaternion(this.actor.getDisplayQuaternion())
            .setY(0)
            .normalize();
        this._p
            .copy(playerPos)
            .addScaledVector(this._v, this.heading === ExteriorViewHeading.FRONT ? 1 : -1);
        this.camera.position
            .copy(playerPos);
        this.camera.lookAt(this._p);
        this.camera.position
            .addScaledVector(UP, 5)
            .addScaledVector(this._v, 40.0 * (this.heading === ExteriorViewHeading.BACK ? 1 : -1));
    }
}
