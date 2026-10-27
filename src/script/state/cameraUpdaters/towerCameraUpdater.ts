import * as THREE from 'three';
import { COCKPIT_FOV } from '../../defs';
import { PlayerEntity } from '../../scene/entities/player';
import { UP } from '../../utils/math';
import { CameraUpdater } from './cameraUpdater';

/** Half the subject size the zoom frames; smaller zooms in further. */
const FRAME_HALF_M = 30;
const MIN_FOV = 1.5;
const FALLBACK_OFFSET = new THREE.Vector3(60, 20, 0);

/**
 * Where the tower stands for an aircraft at `from`: written to `out`, false
 * when there is nowhere to stand (no airfield, no carrier).
 */
export type TowerLocator = (from: THREE.Vector3, out: THREE.Vector3) => boolean;

/**
 * Flanker's F7, standing in for its ground-units view: the player watched from
 * the nearest airfield's tower or the carrier, zooming in with distance.
 */
export class TowerCameraUpdater extends CameraUpdater {

    private readonly tower = new THREE.Vector3();

    constructor(actor: PlayerEntity, camera: THREE.PerspectiveCamera, private readonly locate: TowerLocator) {
        super(actor, camera);
    }

    update(delta: number): void {
        const pos = this.actor.getDisplayPosition();
        if (!this.locate(pos, this.tower)) {
            // Nothing to stand on: hang beside the aircraft rather than freeze.
            this.tower.copy(pos).add(FALLBACK_OFFSET);
        }
        this.camera.position.copy(this.tower);
        this.camera.up.copy(UP);
        this.camera.lookAt(pos);
        const dist = this.tower.distanceTo(pos);
        const fov = THREE.MathUtils.clamp(
            THREE.MathUtils.radToDeg(2 * Math.atan(FRAME_HALF_M / Math.max(dist, 1))), MIN_FOV, COCKPIT_FOV);
        if (Math.abs(fov - this.camera.fov) > 0.01) {
            this.camera.fov = fov;
            this.camera.updateProjectionMatrix();
        }
    }
}
