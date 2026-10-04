/**
 * Carrying the game's own scene-space records across a re-base.
 *
 * The terrain moves its tiles itself (TerrainEntity.rebaseTo) and entities move
 * their poses (Entity.rebase); what is left is plain data the game keeps beside
 * them - colliders, runways, markers - which these helpers rewrite in place,
 * so every reference to a record (the active runway, a target's approach)
 * stays valid.
 *
 * Records that are a point and a heading only hold yaw; the small tilt a
 * re-base also brings is dropped there, or, where a slope is kept, the part of
 * it along the axis goes into the slope. Twenty kilometres of re-base is a
 * fifth of a degree of tilt: a few centimetres across a runway.
 */

import * as THREE from 'three';
import { FrameShift } from '../terrain/geodesy';
import { SurfacePadCollider } from '../scene/entities/surfacePad';
import { CarrierMeshCollider } from '../scene/entities/carrierDeck';
import { SkiJumpCollider } from '../scene/entities/skiJump';

const _p = new THREE.Vector3();

/** A runway-like record: centre, heading, and optionally a slope along it. */
export function rebaseRunway(
    r: { center: THREE.Vector3; heading: number; slope?: number }, shift: FrameShift,
): void {
    const turned = shift.slopedHeading(r.heading, r.slope ?? 0);
    shift.point(r.center);
    r.heading = turned.heading;
    if (r.slope !== undefined) {
        r.slope = turned.slope;
    }
}

export function rebaseSurfacePad(pad: SurfacePadCollider, shift: FrameShift): void {
    const turned = shift.slopedHeading(pad.heading, pad.slope ?? 0);
    const base = shift.point(_p.set(pad.centerX, pad.baseY, pad.centerZ)).y;
    shift.point(_p.set(pad.centerX, pad.surfaceY, pad.centerZ));
    pad.centerX = _p.x;
    pad.surfaceY = _p.y;
    pad.centerZ = _p.z;
    pad.baseY = base;
    pad.heading = turned.heading;
    if (pad.slope !== undefined) {
        pad.slope = turned.slope;
    }
}

export function rebaseSkiJump(s: SkiJumpCollider, shift: FrameShift): void {
    shift.point(_p.set(s.originX, s.originY, s.originZ));
    s.originX = _p.x;
    s.originY = _p.y;
    s.originZ = _p.z;
    s.heading = shift.heading(s.heading);
}

/**
 * A triangle soup about an origin. The soup's axes are the world's, so its
 * vertices turn with them. The array is replaced, not rewritten: soups are
 * shared with the model they were baked from, and other instances of it.
 */
export function rebaseMeshCollider(c: CarrierMeshCollider, shift: FrameShift): void {
    shift.point(_p.set(c.originX, c.originY, c.originZ));
    c.originX = _p.x;
    c.originY = _p.y;
    c.originZ = _p.z;
    const tris = c.triangles.slice();
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i + 2 < tris.length; i += 3) {
        shift.vector(_p.set(tris[i], tris[i + 1], tris[i + 2]));
        tris[i] = _p.x;
        tris[i + 1] = _p.y;
        tris[i + 2] = _p.z;
        for (let k = 0; k < 3; k++) {
            const v = tris[i + k];
            if (v < min[k]) min[k] = v;
            if (v > max[k]) max[k] = v;
        }
    }
    c.triangles = tris;
    c.aabb = tris.length > 0 ? { min, max } : c.aabb;
}
