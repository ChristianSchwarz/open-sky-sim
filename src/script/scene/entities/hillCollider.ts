import * as THREE from 'three';
import { NO_SURFACE_Y } from './carrierDeck';

/** Analytic cone collider matching lib:hill / lib:mountain geometry. */
export interface HillCollider {
    worldToLocal: THREE.Matrix4;
    localToWorld: THREE.Matrix4;
    baseRadius: number;
    height: number;
    worldX: number;
    worldZ: number;
    /** Horizontal reach in world XZ for cheap proximity tests. */
    worldReach: number;
}



const TMP_LOCAL = new THREE.Vector3();
const TMP_WORLD = new THREE.Vector3();

function hillMayAffectPoint(worldX: number, worldZ: number, hill: HillCollider): boolean {
    const dx = Math.abs(worldX - hill.worldX);
    const dz = Math.abs(worldZ - hill.worldZ);
    if (dx > hill.worldReach || dz > hill.worldReach) {
        return false;
    }
    return dx + dz <= hill.worldReach;
}

/** World Y of the highest hill/mountain surface at (worldX, worldZ), or 0 on flat ground. */
export function sampleHillSurfaceY(worldX: number, worldZ: number, hills: HillCollider[]): number {
    if (hills.length === 0) {
        return NO_SURFACE_Y;
    }
    let maxY = NO_SURFACE_Y;
    for (let i = 0; i < hills.length; i++) {
        const hill = hills[i];
        if (!hillMayAffectPoint(worldX, worldZ, hill)) {
            continue;
        }
        TMP_LOCAL.set(worldX, 0, worldZ).applyMatrix4(hill.worldToLocal);
        // 4-sided cone base is a diamond (|x|+|z|<=R), not a circle — a circular test
        // assigns height outside the mesh and trees float in the air beside hills.
        const footprint = Math.abs(TMP_LOCAL.x) + Math.abs(TMP_LOCAL.z);
        if (footprint > hill.baseRadius) {
            continue;
        }
        TMP_LOCAL.y = hill.height * (1 - footprint / hill.baseRadius);
        TMP_WORLD.copy(TMP_LOCAL).applyMatrix4(hill.localToWorld);
        if (TMP_WORLD.y > maxY) {
            maxY = TMP_WORLD.y;
        }
    }
    return maxY;
}
