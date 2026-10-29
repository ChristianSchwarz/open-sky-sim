import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { makeEnuBasis } from './geodesy';
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
});
