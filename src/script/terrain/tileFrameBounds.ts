import * as THREE from 'three';

const sphere = new THREE.Sphere();
const toTile = new THREE.Matrix4();

/**
 * How far `mesh`, a part of the tile drawn by `tileGroup`, is from `eye` at
 * its near edge, both in the scene's own frame.
 *
 * Not from the mesh's matrixWorld: the renderer draws camera-relative
 * (Renderer.submitCameraRelative), which leaves every matrixWorld relative to
 * whichever camera drew last. A tile group's own matrix is in the scene's
 * frame (the terrain root is the identity), set once and moved only by a
 * re-base (FrameShift.object), and what hangs off it does not move within it,
 * so the bounds are kept in the tile's frame.
 */
export function nearDistanceInTile(mesh: THREE.Mesh, tileGroup: THREE.Object3D, eye: THREE.Vector3): number {
    let local = mesh.userData.tileSphere as THREE.Sphere | undefined;
    if (local === undefined) {
        const instanced = mesh as THREE.InstancedMesh;
        let bounds: THREE.Sphere | null;
        if (instanced.isInstancedMesh) {
            if (instanced.boundingSphere === null) {
                instanced.computeBoundingSphere();
            }
            bounds = instanced.boundingSphere;
        } else {
            if (mesh.geometry.boundingSphere === null) {
                mesh.geometry.computeBoundingSphere();
            }
            bounds = mesh.geometry.boundingSphere;
        }
        toTile.identity();
        for (let o: THREE.Object3D | null = mesh; o !== null && o !== tileGroup; o = o.parent) {
            if (o.matrixAutoUpdate) {
                o.updateMatrix();
            }
            toTile.premultiply(o.matrix);
        }
        local = (bounds ?? new THREE.Sphere()).clone().applyMatrix4(toTile);
        mesh.userData.tileSphere = local;
    }
    sphere.copy(local).applyMatrix4(tileGroup.matrix);
    return Math.max(0, sphere.distanceToPoint(eye));
}
