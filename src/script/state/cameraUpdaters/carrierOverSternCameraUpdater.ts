import * as THREE from 'three';
import { PlayerEntity } from "../../scene/entities/player";
import { GroundTargetEntity } from "../../scene/entities/groundTarget";
import { CameraUpdater } from "./cameraUpdater";

export class CarrierOverSternCameraUpdater extends CameraUpdater {

    private tmpSternPos = new THREE.Vector3();
    private tmpCameraPos = new THREE.Vector3();

    constructor(
        actor: PlayerEntity,
        camera: THREE.PerspectiveCamera,
        private carrier: GroundTargetEntity | undefined = undefined
    ) {
        super(actor, camera);
    }

    setCarrier(carrier: GroundTargetEntity | undefined): void {
        this.carrier = carrier;
    }

    update(delta: number): void {
        if (!this.carrier) {
            return;
        }

        // Carrier position in world space
        const carrierPos = this.carrier.position;
        const carrierQuat = this.carrier.quaternion;

        const deckY = 14;
        const cameraDistanceBehind = 100; // 100m behind carrier
        const cameraHeightAboveDeck = 30;
        const focusHeightAboveDeck = 20;

        // Focal point: center of carrier at 20m above deck
        this.tmpSternPos.set(0, deckY + focusHeightAboveDeck, 0);
        this.tmpSternPos.applyQuaternion(carrierQuat);
        this.tmpSternPos.add(carrierPos);

        // Camera position: behind the carrier
        this.tmpCameraPos.set(0, deckY + cameraHeightAboveDeck, -cameraDistanceBehind);
        this.tmpCameraPos.applyQuaternion(carrierQuat);
        this.tmpCameraPos.add(carrierPos);

        this.camera.position.copy(this.tmpCameraPos);
        this.camera.lookAt(this.tmpSternPos);
    }
}
