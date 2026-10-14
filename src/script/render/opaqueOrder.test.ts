import assert from 'node:assert/strict';
import * as THREE from 'three';
import { describe, it } from 'node:test';
import { NearFirstOpaqueSort, OpaqueItem, nearEdgeDistance } from './opaqueOrder';

function item(name: string, x: number, z: number, radius: number, depthWrite = true): OpaqueItem {
    const geometry = new THREE.BufferGeometry();
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    const material = new THREE.MeshBasicMaterial({ depthWrite });
    const object = new THREE.Mesh(geometry, material);
    object.name = name;
    object.position.set(x, 0, z);
    object.updateMatrixWorld();
    return { object, geometry, material };
}

const rank = (m: THREE.Material) => (m.depthWrite ? 0 : 2);

describe('nearEdgeDistance', () => {
    it('is the distance to the bounds, not to their centre', () => {
        const a = item('a', 0, -100, 30);
        assert.equal(nearEdgeDistance(a.object, a.geometry), 70);
    });

    it('is zero inside the bounds, wherever the centre is', () => {
        // The tile under the camera, its centre behind it.
        const a = item('a', 0, 400, 1000);
        assert.equal(nearEdgeDistance(a.object, a.geometry), 0);
    });
});

describe('NearFirstOpaqueSort', () => {
    it('draws what writes depth nearest first, by near edge', () => {
        const sort = new NearFirstOpaqueSort(rank);
        sort.beginPass();
        // The big tile's centre is farthest off, but its edge is nearest.
        const items = [item('far', 0, -900, 10), item('mid', 0, -300, 10), item('big', 0, -1500, 1450)];
        items.sort(sort.compare);
        assert.deepEqual(items.map(i => i.object.name), ['big', 'mid', 'far']);
    });

    it('keeps the submitted order of what writes no depth, after the rest', () => {
        const sort = new NearFirstOpaqueSort(rank);
        sort.beginPass();
        const items = [
            item('stroke far', 0, -900, 1, false), item('land', 0, -500, 10),
            item('stroke near', 0, -10, 1, false), item('land near', 0, -20, 10),
        ];
        items.sort(sort.compare);
        assert.deepEqual(items.map(i => i.object.name), ['land near', 'land', 'stroke far', 'stroke near']);
    });

    it('measures each pass afresh', () => {
        const sort = new NearFirstOpaqueSort(rank);
        const a = item('a', 0, -100, 1);
        const b = item('b', 0, -200, 1);
        sort.beginPass();
        assert.ok(sort.compare(a, b) < 0);
        a.object.position.set(0, 0, -300);
        a.object.updateMatrixWorld();
        sort.beginPass();
        assert.ok(sort.compare(a, b) > 0);
    });
});
