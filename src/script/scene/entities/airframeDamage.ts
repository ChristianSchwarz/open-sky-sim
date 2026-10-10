import * as THREE from 'three';

/**
 * How a part riding on the dislocated fuselage has been carried: rigidly, with
 * the section it is on (see WreckField.dislocateFuselage). In the body frame, in
 * model units (the body's scale divided out), a point p becomes `M p`.
 */
export interface PartBend {
    /** The section's rigid move M, column-major (THREE.Matrix4.toArray). */
    m: number[];
    /** The rotation part of M, as a quaternion (x, y, z, w). */
    q: [number, number, number, number];
}

/**
 * One joint of the fuselage, summed over every impact so far: the hinge angle
 * about the vertical axis (yaw, sideways) and about the lateral axis (pitch,
 * the tail rising for +), in rad, and the sideways shift in model units.
 */
export interface JointState {
    yaw: number;
    pitch: number;
    shift: number;
}

/**
 * The structural damage of a living aircraft: how far its fuselage has bent,
 * and which wing sections and parts have been torn off, from the hard ground
 * impacts that did not destroy it. When it is finally destroyed the break-up
 * carries on from here (see WreckSource.damage).
 *
 * All geometry here is in the body frame: the aircraft draws {@link root} at
 * its own pose, in place of the undamaged airframe.
 */
export class AirframeDamage {

    /** The hardest impact so far, as a crash severity (0.2 .. 1.5). 0 = undamaged. */
    severity = 0;
    /** Wing sections (body cells 3..6) torn off so far. */
    readonly rippedCells = new Set<number>();
    /** Parts torn off so far (gear 0, control surface i = 1 + i). */
    readonly rippedParts = new Set<number>();
    /** The bent, torn airframe in the body frame: draw it at the aircraft pose. Undefined while undamaged. */
    root: THREE.Object3D | undefined;
    /**
     * The fuselage's two joints (index 1: fore/middle, 2: middle/aft; 0 unused),
     * summed over the impacts: a later blow bends it further, in its own direction.
     */
    readonly joints: JointState[] = [
        { yaw: 0, pitch: 0, shift: 0 }, { yaw: 0, pitch: 0, shift: 0 }, { yaw: 0, pitch: 0, shift: 0 },
    ];
    /** How far each wing section (cell 3-6) is folded, summed over the impacts (+ = tip up), rad. */
    readonly wingFold = new Map<number, number>();
    /** How each part still on is carried by the bend. */
    readonly partBends = new Map<number, PartBend>();
    /**
     * The gear legs that are still on are part of {@link root} (bent, the torn
     * ones gone): the aircraft must not draw its gear model as well.
     */
    gearInRoot = false;
    /** Parts on a folded wing: drawn with {@link root} as they are, not posed from their own model. */
    readonly rootParts = new Set<number>();
    /** Where fuel fires have been started (-1 fuselage, else the wing cell), once each. */
    readonly fireSites = new Set<number>();
    /** When (field time, s) the last blow landed: close blows are one impact. */
    lastBlowAt = -Infinity;

    private readonly _p = new THREE.Vector3();
    private readonly _q = new THREE.Quaternion();
    private readonly _inv = new THREE.Quaternion();
    private readonly _rot = new THREE.Quaternion();
    private readonly _m = new THREE.Matrix4();

    /** True once the airframe has been bent or torn. */
    get active(): boolean {
        return this.root !== undefined;
    }

    isPartRipped(id: number): boolean {
        return this.rippedParts.has(id);
    }

    /**
     * Carry a part's pose along with the bend: `position`/`quaternion` are its
     * undamaged world pose and are replaced in place by where it now is. The body
     * pose and scale are those the airframe is drawn with.
     */
    transformPart(
        id: number, position: THREE.Vector3, quaternion: THREE.Quaternion,
        bodyPosition: THREE.Vector3, bodyQuaternion: THREE.Quaternion, scale: THREE.Vector3,
    ): void {
        const bend = this.partBends.get(id);
        if (!bend) {
            return;
        }
        this._inv.copy(bodyQuaternion).invert();
        // Into the body frame, in model units.
        const p = this._p.copy(position).sub(bodyPosition).applyQuaternion(this._inv).divide(scale);
        p.applyMatrix4(this._m.fromArray(bend.m));
        p.multiply(scale);
        position.copy(p).applyQuaternion(bodyQuaternion).add(bodyPosition);
        // Its own turn, then the section's.
        this._q.copy(this._inv).multiply(quaternion);
        this._q.premultiply(this._rot.set(bend.q[0], bend.q[1], bend.q[2], bend.q[3]));
        quaternion.copy(bodyQuaternion).multiply(this._q);
    }

    /** Throw the damaged airframe away (a new aircraft). */
    reset(): void {
        this.severity = 0;
        this.rippedCells.clear();
        this.rippedParts.clear();
        this.partBends.clear();
        for (const j of this.joints) {
            j.yaw = 0;
            j.pitch = 0;
            j.shift = 0;
        }
        this.wingFold.clear();
        this.gearInRoot = false;
        this.rootParts.clear();
        this.fireSites.clear();
        this.lastBlowAt = -Infinity;
        this.disposeRoot();
    }

    /** Replace the drawn airframe. */
    setRoot(root: THREE.Object3D | undefined): void {
        this.disposeRoot();
        this.root = root;
    }

    private disposeRoot(): void {
        if (!this.root) {
            return;
        }
        this.root.traverse(o => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) {
                mesh.geometry.dispose(); // materials are shared with the undamaged airframe
            }
        });
        this.root.removeFromParent();
        this.root = undefined;
    }
}
