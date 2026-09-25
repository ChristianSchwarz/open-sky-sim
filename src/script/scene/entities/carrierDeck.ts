/**
 * Carrier collision from the kuz triangle mesh: gear springs and solid-world
 * contacts sample surface height from the baked soup (highest triangle under
 * each XZ query — works for flat deck and ski-jump ramp alike).
 */
import * as THREE from 'three';
import { AircraftCollisionMesh } from './aircraftDef';
import { Model } from '../models/models';

const EPS = 1e-8;

/**
 * Sentinel for "no surface of this kind here".
 *
 * It has to be -Infinity rather than 0. Every one of these samplers is folded
 * into a `Math.max` that decides the ground, and scene Y = 0 is not the
 * ground — it is the tangent plane at the play area's origin, which the
 * terrain curves away from. Returning 0 for a miss therefore clamped the
 * ground to Y >= 0 across the whole world: a hard invisible floor that an
 * aircraft hit in clear air, tens of metres up near the home airfield and
 * over a hundred at an imported one. See `HeightSampler.heightAtEnu`.
 */
export const NO_SURFACE_Y = -Infinity;

/** Static carrier collider: local triangle soup + world origin. */

export interface CarrierMeshCollider {
    /** World origin of the local mesh frame (carrier placement). */
    originX: number;
    originY: number;
    originZ: number;
    /** Local-frame triangle soup (same layout as {@link AircraftCollisionMesh}). */
    triangles: number[];
    aabb: { min: [number, number, number]; max: [number, number, number] };
}

export function createCarrierMeshCollider(
    originX: number,
    originY: number,
    originZ: number,
    mesh: AircraftCollisionMesh,
): CarrierMeshCollider {
    return {
        originX,
        originY,
        originZ,
        triangles: mesh.triangles,
        aabb: mesh.aabb,
    };
}

/**
 * Bake a collision soup from a loaded {@link Model} (volumes + flats).
 * Uses each mesh's local TRS (already world-baked by ModelManager for nested groups).
 * An optional `root` transform (e.g. the placed entity's rotation/scale) is
 * applied on top, keeping the soup in the entity-local frame around its origin.
 */
export function bakeCollisionMeshFromModel(model: Model, root?: THREE.Matrix4): AircraftCollisionMesh | undefined {
    const flat: number[] = [];
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const tri = new THREE.Triangle();
    const mat = new THREE.Matrix4();

    const pushVert = (v: THREE.Vector3) => {
        flat.push(v.x, v.y, v.z);
    };

    const consumeMesh = (obj: THREE.Object3D) => {
        if (!('isMesh' in obj) || !obj.isMesh) {
            return;
        }
        const mesh = obj as THREE.Mesh;
        const geom = mesh.geometry;
        const pos = geom.getAttribute('position');
        if (!pos) {
            return;
        }
        mat.compose(mesh.position, mesh.quaternion, mesh.scale);
        if (root) {
            mat.premultiply(root);
        }
        const index = geom.index;
        const triCount = index ? index.count / 3 : pos.count / 3;
        for (let t = 0; t < triCount; t++) {
            let i0: number;
            let i1: number;
            let i2: number;
            if (index) {
                i0 = index.getX(t * 3);
                i1 = index.getX(t * 3 + 1);
                i2 = index.getX(t * 3 + 2);
            } else {
                i0 = t * 3;
                i1 = t * 3 + 1;
                i2 = t * 3 + 2;
            }
            vA.fromBufferAttribute(pos, i0).applyMatrix4(mat);
            vB.fromBufferAttribute(pos, i1).applyMatrix4(mat);
            vC.fromBufferAttribute(pos, i2).applyMatrix4(mat);
            // Skip degenerate / vertical-edge scraps with no XZ area.
            tri.set(vA, vB, vC);
            if (tri.getArea() < 1e-6) {
                continue;
            }
            pushVert(vA);
            pushVert(vB);
            pushVert(vC);
        }
    };

    for (let lod = 0; lod < model.lod.length; lod++) {
        const level = model.lod[lod];
        for (let i = 0; i < level.volumes.length; i++) {
            consumeMesh(level.volumes[i]);
        }
        for (let i = 0; i < level.flats.length; i++) {
            consumeMesh(level.flats[i]);
        }
    }

    if (flat.length < 9) {
        return undefined;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < flat.length; i += 3) {
        const x = flat[i], y = flat[i + 1], z = flat[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    return {
        triangles: flat,
        aabb: {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
        },
    };
}

/** Barycentric test: is (px,pz) inside triangle projected on XZ? */
function pointInTriangleXZ(
    px: number, pz: number,
    ax: number, az: number,
    bx: number, bz: number,
    cx: number, cz: number,
): boolean {
    const v0x = cx - ax;
    const v0z = cz - az;
    const v1x = bx - ax;
    const v1z = bz - az;
    const v2x = px - ax;
    const v2z = pz - az;
    const dot00 = v0x * v0x + v0z * v0z;
    const dot01 = v0x * v1x + v0z * v1z;
    const dot02 = v0x * v2x + v0z * v2z;
    const dot11 = v1x * v1x + v1z * v1z;
    const dot12 = v1x * v2x + v1z * v2z;
    const denom = dot00 * dot11 - dot01 * dot01;
    if (Math.abs(denom) < EPS) {
        return false;
    }
    const inv = 1 / denom;
    const u = (dot11 * dot02 - dot01 * dot12) * inv;
    const v = (dot00 * dot12 - dot01 * dot02) * inv;
    return u >= -EPS && v >= -EPS && u + v <= 1 + EPS;
}

/** Plane Y at (px,pz) for triangle ABC (non-vertical). */
function planeYAtXZ(
    px: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
): number | null {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    // n = e1 × e2
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (Math.abs(ny) < EPS) {
        return null; // vertical face — no unique height
    }
    // n·(p-a)=0 → y = ay - (nx*(px-ax) + nz*(pz-az)) / ny
    return ay - (nx * (px - ax) + nz * (pz - az)) / ny;
}

/**
 * Highest mesh surface Y at (worldX, worldZ), or 0 if no triangle covers that XZ.
 * Uses XZ coverage + plane interpolation so ski-jump ramps are included.
 */
export function sampleCarrierMeshSurfaceY(
    worldX: number,
    worldZ: number,
    carrier: CarrierMeshCollider,
): number {
    const lx = worldX - carrier.originX;
    const lz = worldZ - carrier.originZ;
    const { min, max } = carrier.aabb;
    if (lx < min[0] || lx > max[0] || lz < min[2] || lz > max[2]) {
        return NO_SURFACE_Y;
    }
    const tris = carrier.triangles;
    let bestY = -Infinity;
    for (let i = 0; i + 8 < tris.length; i += 9) {
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
        if (!pointInTriangleXZ(lx, lz, ax, az, bx, bz, cx, cz)) {
            continue;
        }
        const y = planeYAtXZ(lx, lz, ax, ay, az, bx, by, bz, cx, cy, cz);
        if (y !== null && y > bestY) {
            bestY = y;
        }
    }
    if (bestY === -Infinity) {
        return NO_SURFACE_Y;
    }
    return carrier.originY + bestY;
}

/** Highest carrier-mesh surface among colliders, or 0. */
export function sampleCarrierMeshSurfaceYMax(
    worldX: number,
    worldZ: number,
    carriers: readonly CarrierMeshCollider[],
): number {
    let maxY = NO_SURFACE_Y;
    for (let i = 0; i < carriers.length; i++) {
        const y = sampleCarrierMeshSurfaceY(worldX, worldZ, carriers[i]);
        if (y > maxY) {
            maxY = y;
        }
    }
    return maxY;
}
