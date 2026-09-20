import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { buildBridgeMeshes } from './bridgeMeshes';
import { BridgeRole, decodePbr, encodePbr } from './pbr';

/** Two quads: one Deck (role 0), one Concrete (role 1), four vertices each. */
function sample() {
    const positions = new Float32Array(8 * 3);
    const normals = new Float32Array(8 * 3);
    for (let i = 0; i < 8; i++) {
        positions[i * 3] = i;
        normals[i * 3 + 1] = 1;
    }
    const roles = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
    const indices = Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return decodePbr(encodePbr({ id: { z: 12, x: 5, y: 6 }, quantScale: 0.5, positions, normals, roles, indices }));
}

describe('buildBridgeMeshes', () => {
    const deck = new THREE.MeshBasicMaterial();
    const concrete = new THREE.MeshBasicMaterial();

    it('splits the triangles into a deck mesh and a concrete mesh by role', () => {
        const set = buildBridgeMeshes(sample(), 0.5, deck, concrete);
        assert.equal(set.deck!.material, deck);
        assert.equal(set.concrete!.material, concrete);
        assert.equal(set.deck!.geometry.getIndex()!.count, 6);
        assert.equal(set.concrete!.geometry.getIndex()!.count, 6);
        assert.ok(set.bytes > 0);
    });

    it('builds only the mesh a tile has faces for', () => {
        const tile = sample();
        for (let i = 0; i < tile.normals.length / 4; i++) {
            tile.normals[i * 4 + 3] = BridgeRole.Concrete;
        }
        const set = buildBridgeMeshes(tile, 0.5, deck, concrete);
        assert.equal(set.deck, undefined);
        assert.equal(set.concrete!.geometry.getIndex()!.count, 12);
    });

    it('rescales a sidecar baked at another quantisation step', () => {
        const set = buildBridgeMeshes(sample(), 0.25, deck, concrete);
        assert.ok(Math.abs(set.group.scale.x - 2) < 1e-6);
    });

    it('does not scale a sidecar that agrees with its tile', () => {
        const set = buildBridgeMeshes(sample(), 0.5, deck, concrete);
        assert.equal(set.group.scale.x, 1);
    });
});
