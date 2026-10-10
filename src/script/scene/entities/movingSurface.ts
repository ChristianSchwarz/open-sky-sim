import * as THREE from 'three';

/**
 * Ground that moves, such as a carrier deck steaming along. Things that come
 * to rest on it (wreckage, a lake of burning fuel, scorch marks) must go with it
 * instead of being left behind in the world.
 */
export interface MovingSurface {
    /** The surface's velocity (m/s), live: read it every frame. */
    readonly velocity: THREE.Vector3;
    /** Whether a point is standing on the surface (on the deck, not in the air high above it or in the sea beside it). */
    contains(x: number, y: number, z: number): boolean;
}
