/** F8 wireframe toggle and the live diagnostics behind the F9 HUD. */

import * as THREE from 'three';
import { TerrainStats } from './terrainEntity';

let wireframe = false;
const materials = new Set<THREE.Material & { wireframe: boolean }>();

export function isTerrainWireframe(): boolean {
    return wireframe;
}

export function setTerrainWireframe(enabled: boolean): void {
    wireframe = enabled;
    for (const mat of materials) {
        mat.wireframe = enabled;
    }
}

export function trackTerrainMaterial(mat: THREE.Material): void {
    const m = mat as THREE.Material & { wireframe: boolean };
    if (typeof m.wireframe === 'boolean') {
        m.wireframe = wireframe;
        materials.add(m);
    }
}

function clearTerrainMaterialTracking(): void {
    materials.clear();
}

export function publishTerrainStats(stats: TerrainStats & { altitudeM: number }): void {
    (globalThis as Record<string, unknown>).__terrainStats = stats;
}
