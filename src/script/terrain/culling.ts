/** Frustum + ellipsoid horizon culling for planet tiles. */

import * as THREE from 'three';
import { WGS84_A } from './geodesy';

const _sphere = new THREE.Sphere();
const _toCenter = new THREE.Vector3();

/**
 * True when the bounding sphere is at least partially inside the camera frustum.
 */
export function sphereInFrustum(sphereCenter: THREE.Vector3, sphereRadius: number, frustum: THREE.Frustum): boolean {
    _sphere.center.copy(sphereCenter);
    _sphere.radius = sphereRadius;
    return frustum.intersectsSphere(_sphere);
}

/**
 * Horizon / back-face cull on the WGS84 sphere.
 *
 * A point on the ellipsoid is hidden behind the limb when the angle between
 * the camera and the point (from Earth centre) exceeds the horizon angle.
 * We test the bounding-sphere centre; a generous radius slack keeps mountain
 * silhouettes on the limb from popping out.
 */
export function behindHorizon(
    sphereCenterWorld: THREE.Vector3,
    sphereRadius: number,
    cameraWorld: THREE.Vector3,
    earthCenterWorld: THREE.Vector3,
    radiusM: number = WGS84_A,
): boolean {
    _toCenter.subVectors(cameraWorld, earthCenterWorld);
    const camDist = _toCenter.length();
    if (camDist <= radiusM) {
        // Camera inside / near the surface — never cull by horizon.
        return false;
    }
    const sinHorizon = radiusM / camDist;
    const cosHorizon = Math.sqrt(Math.max(0, 1 - sinHorizon * sinHorizon));

    const toPoint = _sphere.center; // reuse
    toPoint.subVectors(sphereCenterWorld, earthCenterWorld);
    const pointDist = toPoint.length();
    if (pointDist < 1) {
        return false;
    }
    const cosAngle = _toCenter.dot(toPoint) / (camDist * pointDist);
    // Slack: allow the sphere radius to poke over the limb.
    const slack = sphereRadius / Math.max(pointDist, 1);
    return cosAngle < cosHorizon - slack;
}
