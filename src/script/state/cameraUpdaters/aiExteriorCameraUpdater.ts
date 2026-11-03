import * as THREE from 'three';
import { PlayerEntity } from '../../scene/entities/player';
import { FORWARD, UP } from '../../utils/math';
import { CameraUpdater } from './cameraUpdater';
import { ExteriorViewHeading, LOCK_GROUND_CLEARANCE_M } from './exteriorFrontBehindCameraUpdater';


/** Anything that can be chased by an exterior camera. */
export interface ChaseTarget {
    getDisplayPosition(): THREE.Vector3;
    getDisplayQuaternion(): THREE.Quaternion;
}

/** Initial opponent standoff ahead of the player (m). */
export const AI_SPAWN_DISTANCE_M = 500;

/** Match the F2 exterior back/front offset (m). */
const EXTERIOR_CHASE_DISTANCE_M = 40;
const EXTERIOR_CHASE_HEIGHT_M = 5;

/**
 * F6 exterior view: behind the AI opponent on the line from its target (the
 * player) through it, aimed at the AI and so straight on at the target past
 * it, whatever their geometry; the numpad orbit turns round the AI, which
 * stays centred. Press F6 again for the reverse: from the target's side.
 */
export class AiExteriorCameraUpdater extends CameraUpdater {

    private _v = new THREE.Vector3();

    constructor(
        actor: PlayerEntity,
        camera: THREE.PerspectiveCamera,
        private orbitSubject: ChaseTarget,
        private heading: ExteriorViewHeading = ExteriorViewHeading.BACK,
        private readonly groundHeightAt: (x: number, z: number) => number = () => -Infinity,
    ) {
        super(actor, camera);
    }

    setHeading(heading: ExteriorViewHeading): void {
        this.heading = heading;
    }

    update(delta: number): void {
        const subjectPos = this.orbitSubject.getDisplayPosition();
        const playerPos = this.actor.getDisplayPosition();

        // From the target through the AI; the AI's own nose when they coincide.
        this._v.subVectors(subjectPos, playerPos);
        if (this._v.lengthSq() < 1) {
            this._v.copy(FORWARD).applyQuaternion(this.orbitSubject.getDisplayQuaternion()).negate();
        }
        this._v.normalize();
        if (this.heading === ExteriorViewHeading.FRONT) {
            this._v.negate();
        }

        this.camera.up.copy(UP);
        this.camera.position
            .copy(subjectPos)
            .addScaledVector(this._v, EXTERIOR_CHASE_DISTANCE_M)
            .addScaledVector(UP, EXTERIOR_CHASE_HEIGHT_M);
        // The player well above puts the line underground: stay over it.
        const floor = this.groundHeightAt(this.camera.position.x, this.camera.position.z) + LOCK_GROUND_CLEARANCE_M;
        if (this.camera.position.y < floor) {
            this.camera.position.y = floor;
        }
        this.camera.lookAt(subjectPos);
    }
}
