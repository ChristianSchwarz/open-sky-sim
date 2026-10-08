import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { boxGeometry, buildBridgeMeshes } from './bridgeMeshes';
import { BridgeRole, PBR_BOX_FLOATS, decodePbr, encodePbr } from './pbr';

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
    const railDeck = new THREE.MeshBasicMaterial();
    const mats = { deck, concrete, railDeck };

    it('splits the triangles into a deck mesh and a concrete mesh by role', () => {
        const set = buildBridgeMeshes(sample(), 0.5, mats);
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
        const set = buildBridgeMeshes(tile, 0.5, mats);
        assert.equal(set.deck, undefined);
        assert.equal(set.concrete!.geometry.getIndex()!.count, 12);
    });

    it('gives a rail bridge deck its own mesh and material', () => {
        const tile = sample();
        for (let i = 0; i < 4; i++) {
            tile.normals[i * 4 + 3] = BridgeRole.RailDeck;
        }
        const set = buildBridgeMeshes(tile, 0.5, mats);
        assert.equal(set.deck, undefined);
        assert.equal(set.railDeck!.material, railDeck);
        assert.equal(set.railDeck!.geometry.getIndex()!.count, 6);
        assert.equal(set.concrete!.geometry.getIndex()!.count, 6);
    });

    it('rescales a sidecar baked at another quantisation step', () => {
        const set = buildBridgeMeshes(sample(), 0.25, mats);
        assert.ok(Math.abs(set.group.scale.x - 2) < 1e-6);
    });

    it('does not scale a sidecar that agrees with its tile', () => {
        const set = buildBridgeMeshes(sample(), 0.5, mats);
        assert.equal(set.group.scale.x, 1);
    });

    it('draws the track a rail deck carries with the track material, after the deck', () => {
        const tile = sample();
        tile.track = {
            positions: new Int16Array([0, 2, 0, 0, 2, 0, 20, 2, 0, 20, 2, 0]),
            directions: new Int8Array([0, 0, 127, 7, 0, 0, -127, 71, 0, 0, 127, 7, 0, 0, -127, 71]),
            halfWidths: new Uint16Array([25, 25, 25, 25]),
            along: new Uint16Array([0, 0, 200, 200]),
            indices: new Uint16Array([0, 1, 3, 0, 3, 2]),
        };
        const track = new THREE.MeshBasicMaterial();
        const set = buildBridgeMeshes(tile, 0.5, { ...mats, track });
        assert.equal(set.track!.material, track);
        assert.ok(set.track!.geometry.getAttribute('railAlong'));
        assert.ok(set.track!.renderOrder > (set.deck!.renderOrder ?? 0));
        // Without a track material the stroke is left out.
        assert.equal(buildBridgeMeshes(tile, 0.5, mats).track, undefined);
    });

    it('carries furniture boxes in float32 and builds them at full precision', () => {
        // A 2.4 cm board, far thinner than the 0.5 m quantisation step.
        const box = Float32Array.from([
            10, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0.3, 0.075, 0.012, BridgeRole.SignRed,
        ]);
        assert.equal(box.length, PBR_BOX_FLOATS);
        const positions = new Float32Array(3), normals = Float32Array.from([0, 1, 0]);
        const tile = decodePbr(encodePbr({
            id: { z: 12, x: 5, y: 6 }, quantScale: 0.5, positions, normals,
            roles: Uint8Array.from([0]), indices: new Uint32Array(0), boxes: box,
        }).slice().buffer);
        assert.deepEqual([...tile.boxes!], [...box]);
        const g = boxGeometry(tile.boxes!, BridgeRole.SignRed, 0.5)!;
        const p = g.getAttribute('position').array as Float32Array;
        const zs = new Set<number>();
        for (let i = 2; i < p.length; i += 3) {
            zs.add(Math.round(p[i] * 0.5 * 1000) / 1000);
        }
        // Both faces of the board kept apart: 3 +- 0.012 m.
        assert.deepEqual([...zs].sort(), [2.988, 3.012]);
        assert.equal(g.getIndex()!.count, 36);
        assert.equal(boxGeometry(tile.boxes!, BridgeRole.SignWhite, 0.5), undefined);
        const set = buildBridgeMeshes(tile, 0.5, { ...mats, signRed: new THREE.MeshBasicMaterial() });
        assert.ok(set.signRed);
    });

    it('carries the border ramps after the boxes, and reads a version 3 file without them', () => {
        const ramps = Float32Array.from([1200, 34.5, -80, 4.25, -1650, 12, 300, -5.5]);
        const positions = new Float32Array(3), normals = Float32Array.from([0, 1, 0]);
        const box = new Float32Array(PBR_BOX_FLOATS);
        const bytes = encodePbr({
            id: { z: 12, x: 5, y: 6 }, quantScale: 0.5, positions, normals,
            roles: Uint8Array.from([0]), indices: new Uint32Array(0), boxes: box, ramps,
        });
        const tile = decodePbr(bytes.slice().buffer);
        assert.deepEqual([...tile.ramps!], [...ramps]);
        assert.equal(tile.boxes!.length, PBR_BOX_FLOATS);
        // Without the section, as a version 3 file was written.
        const v3 = bytes.slice(0, bytes.length - 4 - ramps.length * 4);
        v3[4] = 3;
        const old = decodePbr(v3.buffer);
        assert.equal(old.ramps, undefined);
        assert.equal(old.boxes!.length, PBR_BOX_FLOATS);
    });
});
