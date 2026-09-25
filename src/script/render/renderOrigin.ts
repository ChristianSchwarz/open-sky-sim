import * as THREE from 'three';

/**
 * Absolute ENU origin subtracted for the current GPU submit (camera-relative
 * rendering). Zero when not rebasing. Shaders that bypass modelMatrix (e.g.
 * particle offsets) must subtract this from world positions.
 */
export const RENDER_ORIGIN = new THREE.Vector3();

export function setRenderOrigin(origin: THREE.Vector3): void {
    RENDER_ORIGIN.copy(origin);
}

export function clearRenderOrigin(): void {
    RENDER_ORIGIN.set(0, 0, 0);
}
