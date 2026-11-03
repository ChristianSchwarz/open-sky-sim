import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { FrameShift, makeEnuBasis } from './geodesy';
import { buildOceanPatch, mergeOceanPatches } from './oceanPatch';

describe('mergeOceanPatches', () => {
    const basis = makeEnuBasis(50.3, 11.8, 0);
    const materials = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
    const lift = (lon: number, lat: number) => 100 + 10 * lon + lat;
    const ids = [{ z: 12, x: 2182, y: 903 }, { z: 12, x: 2183, y: 903 }, { z: 11, x: 1090, y: 452 }];
    const patches = ids.map(id => buildOceanPatch(id, basis, 0, 0, materials, undefined, lift, 8));

    /** Every vertex of a group's mesh in the scene frame. */
    function worldVertices(group: THREE.Group): THREE.Vector3[] {
        const mesh = group.children[0] as THREE.Mesh;
        const pos = mesh.geometry.getAttribute('position');
        const out: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++) {
            out.push(new THREE.Vector3().fromBufferAttribute(pos, i).add(group.position));
        }
        return out;
    }

    it('draws the same triangles as the patches, in one mesh', () => {
        const merged = mergeOceanPatches(patches);
        assert.equal(merged.children.length, 1);
        const mesh = merged.children[0] as THREE.Mesh;
        const index = mesh.geometry.getIndex()!;
        const vertices = worldVertices(merged);
        const triangles = (group: THREE.Group, verts: THREE.Vector3[], base: number[]) => {
            const idx = (group.children[0] as THREE.Mesh).geometry.getIndex()!;
            for (let i = 0; i < idx.count; i++) {
                base.push(verts[idx.getX(i)].x, verts[idx.getX(i)].y, verts[idx.getX(i)].z);
            }
            return base;
        };
        const expected: number[] = [];
        for (const p of patches) {
            triangles(p.group, worldVertices(p.group), expected);
        }
        const actual: number[] = [];
        for (let i = 0; i < index.count; i++) {
            const v = vertices[index.getX(i)];
            actual.push(v.x, v.y, v.z);
        }
        assert.equal(actual.length, expected.length);
        for (let i = 0; i < actual.length; i++) {
            assert.ok(Math.abs(actual[i] - expected[i]) < 0.05, `component ${i}: ${actual[i]} vs ${expected[i]}`);
        }
        assert.equal(mesh.geometry.groups.length, 1);
        assert.equal(mesh.geometry.groups[0].count, index.count);
    });

    it('keeps the land attributes byte for byte', () => {
        const mesh = mergeOceanPatches(patches).children[0] as THREE.Mesh;
        const merged = mesh.geometry.getAttribute('coverClass');
        let o = 0;
        for (const p of patches) {
            const a = (p.group.children[0] as THREE.Mesh).geometry.getAttribute('coverClass');
            for (let i = 0; i < a.count; i++, o++) {
                assert.equal(merged.getX(o), a.getX(i));
            }
            assert.equal(merged.normalized, a.normalized);
        }
    });

    /** Every vertex (and normal) of a group's mesh in the scene frame, through its whole transform. */
    function sceneVertices(group: THREE.Group): { points: THREE.Vector3[]; normals: THREE.Vector3[] } {
        group.updateMatrix();
        const mesh = group.children[0] as THREE.Mesh;
        const pos = mesh.geometry.getAttribute('position');
        const nrm = mesh.geometry.getAttribute('normal');
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(group.matrix);
        const points: THREE.Vector3[] = [];
        const normals: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++) {
            points.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(group.matrix));
            normals.push(new THREE.Vector3().fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize());
        }
        return { points, normals };
    }

    it('keeps a patch turned by a re-base where it was, merged with one built after', () => {
        // Built before a 40 km re-base and carried across it (turned), the
        // other built in the new frame (not turned): the case that left the
        // carried patch's fill tens of metres off when only positions moved.
        const from = makeEnuBasis(50.3, 11.8, 0);
        const to = makeEnuBasis(50.3, 12.36, 0);
        const shift = FrameShift.between(from, to);
        const carried = buildOceanPatch(ids[0], from, 0, 0, materials, undefined, lift, 8);
        shift.object(carried.group);
        assert.ok(Math.abs(carried.group.quaternion.w) < 1 - 1e-9, 'the re-base turned the patch');
        const fresh = buildOceanPatch(ids[1], to, 0, 0, materials, undefined, lift, 8);

        for (const order of [[carried, fresh], [fresh, carried]]) {
            const merged = sceneVertices(mergeOceanPatches(order));
            const expected = order.map(p => sceneVertices(p.group));
            let i = 0;
            for (const e of expected) {
                for (let k = 0; k < e.points.length; k++, i++) {
                    const d = merged.points[i].distanceTo(e.points[k]);
                    assert.ok(d < 0.05, `vertex ${i} is ${d.toFixed(3)} m off`);
                    assert.ok(merged.normals[i].angleTo(e.normals[k]) < 1e-5, `normal ${i} turned`);
                }
            }
            assert.equal(i, merged.points.length);
        }
    });
});
