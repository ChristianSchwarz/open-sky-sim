/** F8 wireframe toggle for aircraft and visibility filtering. */

import * as THREE from 'three';

let aircraftWireframe = false;
let visibleMeshesOnly = false;
const materials = new Set<THREE.Material & { wireframe: boolean }>();
const meshes = new Set<THREE.Mesh | THREE.LineSegments>();

export function isAircraftWireframe(): boolean {
    return aircraftWireframe;
}

export function setAircraftWireframe(enabled: boolean): void {
    aircraftWireframe = enabled;
    for (const mat of materials) {
        mat.wireframe = enabled;
    }
}

export function isVisibleMeshesOnly(): boolean {
    return visibleMeshesOnly;
}

export function setVisibleMeshesOnly(enabled: boolean): void {
    visibleMeshesOnly = enabled;
    for (const mesh of meshes) {
        // Always respect the original visibility state: show only originally visible meshes
        mesh.visible = mesh.userData.aircraftOriginallyVisible ?? true;
    }
}

export function trackAircraftMaterial(mat: THREE.Material): void {
    const m = mat as THREE.Material & { wireframe: boolean };
    if (typeof m.wireframe === 'boolean') {
        m.wireframe = aircraftWireframe;
        materials.add(m);
    }
}

export function trackAircraftMesh(mesh: THREE.Mesh | THREE.LineSegments): void {
    mesh.userData.aircraftOriginallyVisible = mesh.visible;
    meshes.add(mesh);
    if (visibleMeshesOnly) {
        mesh.visible = mesh.userData.aircraftOriginallyVisible;
    }
}

function clearAircraftMaterialTracking(): void {
    materials.clear();
    meshes.clear();
}
