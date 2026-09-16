import * as THREE from 'three';
import { UP } from '../../utils/math';
import { CameraUpdater } from './cameraUpdater';

/**
 * A camera nailed to a world position, looking along a bearing and pitch.
 * Heading is degrees clockwise from north (scene −z), pitch is degrees with
 * up positive — the convention `vectorHeading` reads back.
 */
const PITCH_LIMIT_DEG = 89;

export class FixedCameraUpdater extends CameraUpdater {

    private position = new THREE.Vector3();
    private direction = new THREE.Vector3(0, 0, -1);
    private target = new THREE.Vector3();
    private headingDeg = 0;
    private pitchDeg = 0;

    setPose(position: THREE.Vector3, headingDeg: number, pitchDeg: number): void {
        this.position.copy(position);
        this.turn(headingDeg - this.headingDeg, pitchDeg - this.pitchDeg);
    }

    /** Turn by degrees: heading clockwise, pitch up positive, pitch held short of the poles. */
    turn(headingDeg: number, pitchDeg: number): void {
        this.headingDeg = (((this.headingDeg + headingDeg) % 360) + 360) % 360;
        this.pitchDeg = Math.max(-PITCH_LIMIT_DEG, Math.min(PITCH_LIMIT_DEG, this.pitchDeg + pitchDeg));
        const h = this.headingDeg * Math.PI / 180;
        const p = this.pitchDeg * Math.PI / 180;
        this.direction.set(
            Math.sin(h) * Math.cos(p),
            Math.sin(p),
            -Math.cos(h) * Math.cos(p),
        );
    }

    /** Where the camera is, in scene metres. */
    getPosition(out: THREE.Vector3): THREE.Vector3 {
        return out.copy(this.position);
    }

    /** Degrees clockwise from north. */
    get heading(): number {
        return this.headingDeg;
    }

    /** Degrees, up positive. */
    get pitch(): number {
        return this.pitchDeg;
    }

    /**
     * Slide the camera: `forward` along its heading (level, so pitching down
     * does not sink it), `right` across it, `up` along world up. Metres.
     */
    move(forward: number, right: number, up: number): void {
        const x = this.direction.x;
        const z = this.direction.z;
        const len = Math.hypot(x, z) || 1;
        const fx = x / len;
        const fz = z / len;
        this.position.x += fx * forward - fz * right;
        this.position.z += fz * forward + fx * right;
        this.position.y += up;
    }

    update(_delta: number): void {
        this.camera.position.copy(this.position);
        this.camera.up.copy(UP);
        this.target.copy(this.position).add(this.direction);
        this.camera.lookAt(this.target);
    }
}
