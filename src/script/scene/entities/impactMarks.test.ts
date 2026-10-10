import * as THREE from 'three';
import { describe, it } from 'node:test';
import { expect } from './testExpect';
import { SceneMaterialManager } from '../materials/materials';
import { ImpactMarks } from './impactMarks';

const stubMaterials = { build: () => new THREE.MeshBasicMaterial() } as unknown as SceneMaterialManager;

type MarkPoolPriv = {
    level: { array: Float32Array };
    size: number;
    mesh: THREE.InstancedMesh;
};
const pools = (m: ImpactMarks) => m as unknown as { impact: MarkPoolPriv; burn: MarkPoolPriv };

const up = new THREE.Vector3(0, 1, 0);
const at = new THREE.Vector3(10, 0, 20);

/** The x scale a mark is drawn with (its width). */
function widthOf(pool: MarkPoolPriv, index: number): number {
    const m = new THREE.Matrix4();
    pool.mesh.getMatrixAt(index, m);
    return new THREE.Vector3().setFromMatrixScale(m).x;
}

function positionOf(pool: MarkPoolPriv, index: number): THREE.Vector3 {
    const m = new THREE.Matrix4();
    pool.mesh.getMatrixAt(index, m);
    return new THREE.Vector3().setFromMatrixPosition(m);
}

describe('burn marks', () => {
    it('start too faint to see, then darken to their target over the grow time', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.addBurn(at, up, 0, 1, 6, 6, 1, 20);
        const { burn } = pools(marks);
        const start = burn.level.array[0];
        // Dithering only happens above a hair over zero, so it must not be exactly zero (that would be solid).
        expect(start).toBeGreaterThan(0.001);
        expect(start).toBeLessThan(0.02);

        marks.update(10);
        const half = burn.level.array[0];
        expect(half).toBeGreaterThan(start);
        marks.update(11);
        const done = burn.level.array[0];
        expect(done).toBeGreaterThan(half);
        expect(done).toBeGreaterThan(0.5);
        // It stops at the target.
        marks.update(30);
        expect(burn.level.array[0]).toBe(done);
    });

    it('grow from a part of their size while they darken', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.addBurn(at, up, 0, 1, 8, 8, 1, 20);
        const { burn } = pools(marks);
        const first = widthOf(burn, 0);
        expect(first).toBeLessThan(8 * 0.7);
        marks.update(25);
        expect(widthOf(burn, 0)).toBeCloseTo(8, 3);
    });

    it('end up darker for a stronger strength', () => {
        const target = (strength: number): number => {
            const marks = new ImpactMarks(stubMaterials);
            marks.addBurn(at, up, 0, 1, 4, 4, strength, 5);
            marks.update(10);
            return pools(marks).burn.level.array[0];
        };
        expect(target(1)).toBeGreaterThan(target(0.1));
    });

    it('never push out the impact scars, which sit in a pool of their own', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.add(at, up, 0, 1, 10, 6, 0.8);
        const scar = pools(marks).impact.level.array[0];
        for (let i = 0; i < 2000; i++) {
            marks.addBurn(at, up, 0, 1, 3, 3, 0.8, 10);
        }
        expect(pools(marks).impact.size).toBe(1);
        expect(pools(marks).impact.level.array[0]).toBe(scar);
        // The burn marks are capped; the oldest are overwritten.
        expect(pools(marks).burn.size).toBeLessThanOrEqual(600);
    });

    it('are cleared together with the rest', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.add(at, up, 0, 1, 5, 5, 0.5);
        marks.addBurn(at, up, 0, 1, 5, 5, 0.5, 10);
        marks.clear();
        expect(pools(marks).impact.size + pools(marks).burn.size).toBe(0);
    });
});

describe('marks on a moving carrier deck', () => {
    const DECK_V = new THREE.Vector3(0, 0, -20);
    /** The deck is the strip x < 50. */
    const surface = { velocity: DECK_V, contains: (x: number) => x < 50 };
    const onDeck = new THREE.Vector3(10, 0, 20);
    const beside = new THREE.Vector3(200, 0, 20);

    it('go along with the ship', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.setMovingSurface(surface);
        marks.add(onDeck, up, 0, 1, 10, 6, 0.8);
        const start = positionOf(pools(marks).impact, 0);
        marks.update(3);
        const now = positionOf(pools(marks).impact, 0);
        expect(start.z - now.z).toBeCloseTo(60, 3);
        expect(now.x).toBeCloseTo(start.x, 5);
    });

    it('stay where they are when not on the deck', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.setMovingSurface(surface);
        marks.add(beside, up, 0, 1, 10, 6, 0.8);
        const start = positionOf(pools(marks).impact, 0);
        marks.update(3);
        expect(positionOf(pools(marks).impact, 0).distanceTo(start)).toBeLessThan(1e-6);
    });

    it('stay put with no moving surface at all', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.add(onDeck, up, 0, 1, 10, 6, 0.8);
        const start = positionOf(pools(marks).impact, 0);
        marks.update(3);
        expect(positionOf(pools(marks).impact, 0).distanceTo(start)).toBeLessThan(1e-6);
    });

    it('burn marks go along while they keep darkening and growing', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.setMovingSurface(surface);
        marks.addBurn(onDeck, up, 0, 1, 8, 8, 1, 10);
        const { burn } = pools(marks);
        const startZ = positionOf(burn, 0).z;
        const startLevel = burn.level.array[0];
        const startWidth = widthOf(burn, 0);
        marks.update(5);
        expect(startZ - positionOf(burn, 0).z).toBeCloseTo(100, 3);
        expect(burn.level.array[0]).toBeGreaterThan(startLevel);
        expect(widthOf(burn, 0)).toBeGreaterThan(startWidth);
    });

    it('a mark overwritten by another on land no longer moves', () => {
        const marks = new ImpactMarks(stubMaterials);
        marks.setMovingSurface(surface);
        // Fill the whole impact pool with deck marks, then overwrite them all with ones beside it.
        for (let i = 0; i < 400; i++) {
            marks.add(onDeck, up, 0, 1, 4, 4, 0.5);
        }
        for (let i = 0; i < 400; i++) {
            marks.add(beside, up, 0, 1, 4, 4, 0.5);
        }
        const before = positionOf(pools(marks).impact, 0);
        marks.update(2);
        expect(positionOf(pools(marks).impact, 0).distanceTo(before)).toBeLessThan(1e-6);
    });
});
