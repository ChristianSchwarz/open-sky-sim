import * as THREE from 'three';

/** The fields of THREE's render list item (WebGLRenderLists) an opaque sort reads. */
export interface OpaqueItem {
    object: THREE.Object3D;
    geometry: THREE.BufferGeometry | null;
    material: THREE.Material;
}

const centre = new THREE.Vector3();

/**
 * How far `object`'s bounds are from the origin at their near edge, in
 * world units: the camera's distance, since Renderer.submitCameraRelative
 * draws with the camera at the origin and every matrixWorld relative to it.
 */
export function nearEdgeDistance(object: THREE.Object3D, geometry: THREE.BufferGeometry | null): number {
    const sphere = (object as THREE.InstancedMesh).boundingSphere ?? geometry?.boundingSphere ?? null;
    if (sphere === null) {
        return centre.setFromMatrixPosition(object.matrixWorld).length();
    }
    centre.copy(sphere.center).applyMatrix4(object.matrixWorld);
    return Math.max(0, centre.length() - sphere.radius * object.matrixWorld.getMaxScaleOnAxis());
}

/**
 * The opaque draw order for a pass: by `rank`, and within rank 0 (what
 * writes depth) nearest first, so the GPU's depth test throws away what a
 * nearer surface already covers before shading it - terrain behind a ridge,
 * a town behind the hill in front of it. Every other rank keeps the order it
 * was submitted in (the sort is stable): strokes that write no depth are
 * layered by that order, not by distance.
 *
 * Not THREE's own `z`: that is the projected depth of the bounds' centre,
 * which flips for a tile whose centre is behind the camera - the very tile
 * under it, which hides the most.
 *
 * Dearer than ranks alone, which leave three distinct keys: a full sort of
 * ~800 draws, ~0.15 ms on a desktop core (0.7 ms in the game on a loaded
 * one) against ~0.05 ms. The GPU's saving pays for it many times over where
 * terrain hides terrain (13-15 % of the scene pass at Garmisch). The terrain
 * already hands its tiles over nearest first (syncGroup), which spares a
 * third of the comparisons; the rest is the comparator calls themselves.
 */
export class NearFirstOpaqueSort {
    /** Stamped on each item with its key, so the key is worked out once a pass, not once a comparison. */
    private pass = 0;

    constructor(private readonly rank: (material: THREE.Material) => number) { }

    /** Forget the keys of the last pass; call before each sorted render. */
    beginPass(): void {
        this.pass++;
    }

    readonly compare = (a: OpaqueItem, b: OpaqueItem): number => this.keyOf(a) - this.keyOf(b);

    /**
     * Rank first, then, in rank 0 only, the near-edge distance: equal keys
     * keep their submitted order (the sort is stable). THREE reuses its
     * render items from frame to frame, so the key rides on the item.
     */
    private keyOf(item: OpaqueItem): number {
        const keyed = item as KeyedItem;
        if (keyed.nearFirstPass !== this.pass) {
            const rank = this.rank(item.material);
            keyed.nearFirstPass = this.pass;
            keyed.nearFirstKey = rank * RANK_STRIDE
                + (rank === 0 ? Math.min(nearEdgeDistance(item.object, item.geometry), RANK_STRIDE - 1) : 0);
        }
        return keyed.nearFirstKey!;
    }
}

/** Past any distance a pass draws to, in world units. */
const RANK_STRIDE = 1e9;

interface KeyedItem extends OpaqueItem {
    nearFirstPass?: number;
    nearFirstKey?: number;
}
