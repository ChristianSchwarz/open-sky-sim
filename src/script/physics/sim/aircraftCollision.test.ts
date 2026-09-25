/**
 * Unit tests for body-frame aircraft collision helpers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
    collisionMeshHitsObstacle,
    collisionMeshHitsTerrain,
    findCollisionMeshObstacleContact,
    findCollisionMeshTerrainContact,
    segmentHitsAabbBody,
    segmentHitsCollisionMesh,
    segmentHitsSphere,
    segmentHitsTriangleBody,
    sphereHitsObstacle,
} from './aircraftCollision';
import { AircraftCollisionMesh } from '../../scene/entities/aircraftDef';
import { Obstacle } from '../../ai/worldQuery';

function boxMesh(min: [number, number, number], max: [number, number, number]): AircraftCollisionMesh {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const triangles = [
        x0, y1, z0, x1, y1, z0, x1, y1, z1,
        x0, y1, z0, x1, y1, z1, x0, y1, z1,
        x0, y0, z0, x1, y0, z1, x1, y0, z0,
        x0, y0, z0, x0, y0, z1, x1, y0, z1,
    ];
    return { triangles, aabb: { min, max } };
}

describe('segmentHitsSphere', () => {
    it('hits when segment passes near center', () => {
        const hit = new THREE.Vector3();
        const scratch = new THREE.Vector3();
        const start = new THREE.Vector3(0, 0, -20);
        const seg = new THREE.Vector3(0, 0, 40);
        assert.equal(
            segmentHitsSphere(start, seg, seg.lengthSq(), new THREE.Vector3(), 10, hit, scratch),
            true,
        );
        // First surface crossing should be near z = -10.
        assert.ok(Math.abs(hit.z + 10) < 1e-4, `expected surface hit near z=-10, got ${hit.z}`);
        assert.ok(Math.abs(hit.x) < 1e-6 && Math.abs(hit.y) < 1e-6);
    });

    it('misses when far from sphere', () => {
        const hit = new THREE.Vector3();
        const scratch = new THREE.Vector3();
        const start = new THREE.Vector3(100, 0, 0);
        const seg = new THREE.Vector3(0, 0, 1);
        assert.equal(
            segmentHitsSphere(start, seg, seg.lengthSq(), new THREE.Vector3(), 10, hit, scratch),
            false,
        );
    });
});

describe('segmentHitsTriangleBody', () => {
    it('hits a unit triangle on XY', () => {
        const o = new THREE.Vector3(0.25, 0.25, -1);
        const d = new THREE.Vector3(0, 0, 2);
        const t = segmentHitsTriangleBody(o, d, 0, 0, 0, 1, 0, 0, 0, 1, 0);
        assert.ok(t >= 0 && t <= 1);
        assert.ok(Math.abs(t - 0.5) < 1e-4, `expected t≈0.5, got ${t}`);
    });

    it('misses when segment is beside the triangle', () => {
        const o = new THREE.Vector3(2, 2, -1);
        const d = new THREE.Vector3(0, 0, 2);
        assert.equal(segmentHitsTriangleBody(o, d, 0, 0, 0, 1, 0, 0, 0, 1, 0), -1);
    });
});

describe('segmentHitsAabbBody', () => {
    it('detects segment through AABB', () => {
        assert.equal(segmentHitsAabbBody(
            new THREE.Vector3(0, 0, -5),
            new THREE.Vector3(0, 0, 5),
            [-1, -1, -1],
            [1, 1, 1],
        ), true);
    });

    it('rejects segment outside AABB', () => {
        assert.equal(segmentHitsAabbBody(
            new THREE.Vector3(10, 0, -5),
            new THREE.Vector3(10, 0, 5),
            [-1, -1, -1],
            [1, 1, 1],
        ), false);
    });
});

describe('segmentHitsCollisionMesh', () => {
    it('hits a body-frame box at the aircraft origin', () => {
        const mesh = boxMesh([-2, -1, -4], [2, 1, 4]);
        const bodyStart = new THREE.Vector3();
        const bodyEnd = new THREE.Vector3();
        const hitWorld = new THREE.Vector3();
        // Vertical shot through the top/bottom faces of the box.
        assert.equal(segmentHitsCollisionMesh(
            new THREE.Vector3(0, 5, 0),
            new THREE.Vector3(0, -5, 0),
            new THREE.Vector3(0, 0, 0),
            new THREE.Quaternion(),
            mesh,
            bodyStart,
            bodyEnd,
            hitWorld,
        ), true);
        // First face crossed is the top at y=1.
        assert.ok(Math.abs(hitWorld.y - 1) < 1e-3, `expected hit at y=1, got ${hitWorld.y}`);
    });

    it('misses when the shot is offset past the aabb', () => {
        const mesh = boxMesh([-2, -1, -4], [2, 1, 4]);
        const bodyStart = new THREE.Vector3();
        const bodyEnd = new THREE.Vector3();
        assert.equal(segmentHitsCollisionMesh(
            new THREE.Vector3(50, 5, 0),
            new THREE.Vector3(50, -5, 0),
            new THREE.Vector3(0, 0, 0),
            new THREE.Quaternion(),
            mesh,
            bodyStart,
            bodyEnd,
        ), false);
    });
});

describe('collisionMeshHitsTerrain', () => {
    it('reports penetration below a raised hill surface', () => {
        const mesh = boxMesh([-1, -1, -1], [1, 1, 1]);
        const pos = new THREE.Vector3(0, 5, 0);
        assert.equal(collisionMeshHitsTerrain(
            pos, new THREE.Quaternion(), mesh,
            () => 10,
            0.05,
        ), true);
    });

    it('clear when above flat ground', () => {
        const mesh = boxMesh([-1, -1, -1], [1, 1, 1]);
        const pos = new THREE.Vector3(0, 10, 0);
        assert.equal(collisionMeshHitsTerrain(
            pos, new THREE.Quaternion(), mesh,
            () => 0,
            0.05,
        ), false);
    });
});

describe('obstacles', () => {
    const building: Obstacle = {
        position: new THREE.Vector3(100, 0, 0),
        radius: 5,
        height: 20,
    };

    it('mesh hits a nearby cylinder', () => {
        const mesh = boxMesh([-2, -1, -2], [2, 1, 2]);
        const pos = new THREE.Vector3(100, 5, 0);
        assert.equal(
            collisionMeshHitsObstacle(pos, new THREE.Quaternion(), mesh, building),
            true,
        );
    });

    it('sphere hits when overlapping the cylinder', () => {
        assert.equal(sphereHitsObstacle(new THREE.Vector3(103, 5, 0), 10, building), true);
        assert.equal(sphereHitsObstacle(new THREE.Vector3(200, 5, 0), 10, building), false);
    });

    it('reports side contact normal pointing outward', () => {
        const mesh = boxMesh([-2, -1, -2], [2, 1, 2]);
        const pos = new THREE.Vector3(103, 5, 0);
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const hit = findCollisionMeshObstacleContact(
            pos, new THREE.Quaternion(), mesh, building, point, normal,
        );
        assert.ok(hit, 'expected contact');
        assert.ok(hit!.penetration > 0);
        assert.ok(Math.abs(hit!.normal.y) < 0.25, `expected horizontal normal, got ${hit!.normal.toArray()}`);
        // Outward from building axis at (100,0,0).
        const away = (hit!.point.x - 100) * hit!.normal.x + (hit!.point.z - 0) * hit!.normal.z;
        assert.ok(away > 0, `normal should point away from cylinder axis`);
    });
});

/**
 * A wing-and-fuselage cross: every corner of its bounding box is empty air,
 * which is exactly where the old collider took its samples.
 */
function crossMesh(): AircraftCollisionMesh {
    const triangles = [
        // Wing, spanning x, one metre of chord.
        -8, 0, 0, 8, 0, 0, 0, 0, 1,
        // Fuselage, spanning z, one metre below and above the datum.
        0, -1, 0, 0, 0, 8, 0, 0, -8,
        0, 1, 0, 0, 0, 8, 0, 0, -8,
    ];
    return { triangles, aabb: { min: [-8, -1, -8], max: [8, 1, 8] } };
}

describe('contact points follow the airframe, not its bounding box', () => {
    // Ground rising toward -x and -z, so the box corner at (-8, -1, -8) is over
    // ground 8 m higher than anything the aircraft actually occupies.
    const ground = (x: number, z: number) => 0.5 * (-x) + 0.5 * (-z);

    it('stays clear while every hull point is above the slope', () => {
        const mesh = crossMesh();
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();
        // Wingtip and tail are over ground at 4 m and sit at 5 m; the phantom
        // box corner is over ground at 8 m and would report 4 m of penetration.
        assert.equal(
            findCollisionMeshTerrainContact(
                new THREE.Vector3(0, 5, 0), new THREE.Quaternion(), mesh,
                ground, 0.05, point, normal,
            ),
            null,
            'no part of the airframe is under the slope',
        );
    });

    it('still contacts once the belly is in the ground', () => {
        const mesh = crossMesh();
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const hit = findCollisionMeshTerrainContact(
            new THREE.Vector3(0, 0.5, 0), new THREE.Quaternion(), mesh,
            ground, 0.05, point, normal,
        );
        assert.ok(hit, 'expected the belly to contact');
        assert.ok(hit!.penetration > 0.3, `pen=${hit!.penetration}`);
    });
});

describe('findCollisionMeshTerrainContact', () => {
    it('returns deepest penetration and upward normal on a flat plateau', () => {
        const mesh = boxMesh([-1, -1, -1], [1, 1, 1]);
        const pos = new THREE.Vector3(0, 5, 0);
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();
        const hit = findCollisionMeshTerrainContact(
            pos, new THREE.Quaternion(), mesh, () => 10, 0.05, point, normal,
        );
        assert.ok(hit, 'expected terrain contact');
        // Lowest sample is body y=4; plateau 10 − margin → pen ≈ 5.95
        assert.ok(hit!.penetration > 5, `pen=${hit!.penetration}`);
        assert.ok(hit!.normal.y > 0.9, `normal=${hit!.normal.toArray()}`);
    });

    it('returns null when clear of the surface', () => {
        const mesh = boxMesh([-1, -1, -1], [1, 1, 1]);
        const pos = new THREE.Vector3(0, 10, 0);
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();
        assert.equal(
            findCollisionMeshTerrainContact(
                pos, new THREE.Quaternion(), mesh, () => 0, 0.05, point, normal,
            ),
            null,
        );
    });
});
