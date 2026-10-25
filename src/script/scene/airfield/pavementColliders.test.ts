import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MeshColliderIndex, NO_SURFACE_Y, sampleCarrierMeshSurfaceYMax } from '../entities/carrierDeck';
import { PAVEMENT_SKIRT_M, pavementColliders } from './pavementColliders';

/** A 40 m square apron drawn 1.5 m above flat ground at y = 0, as two triangles. */
const APRON = [
    0, 1.5, 0, 40, 1.5, 0, 40, 1.5, 40,
    0, 1.5, 0, 40, 1.5, 40, 0, 1.5, 40,
];
const ORIGIN = { x: 1000, y: 0, z: -2000 };

describe('pavement colliders', () => {

    it('is solid where it is drawn, at the height it is drawn', () => {
        const colliders = pavementColliders(APRON, ORIGIN, 1.5);
        for (const [x, z] of [[1, 1], [20, 20], [39, 5]]) {
            assert.ok(Math.abs(sampleCarrierMeshSurfaceYMax(ORIGIN.x + x, ORIGIN.z + z, colliders) - 1.5) < 1e-6);
        }
    });

    it('slopes from its edge down to the ground instead of standing on a lip', () => {
        const colliders = pavementColliders(APRON, ORIGIN, 1.5);
        const half = PAVEMENT_SKIRT_M / 2;
        // Halfway down each side's skirt, and not along the diagonal both triangles share.
        for (const [x, z] of [[-half, 20], [40 + half, 20], [20, -half], [20, 40 + half]]) {
            const y = sampleCarrierMeshSurfaceYMax(ORIGIN.x + x, ORIGIN.z + z, colliders);
            assert.ok(Math.abs(y - 0.75) < 1e-6, `at ${x},${z}: ${y}`);
        }
        assert.ok(sampleCarrierMeshSurfaceYMax(ORIGIN.x + 20, ORIGIN.z + 20, colliders) === 1.5,
            'the shared diagonal grew a skirt across the apron');
    });

    it('is not solid beyond the skirt', () => {
        const colliders = pavementColliders(APRON, ORIGIN, 1.5);
        assert.equal(sampleCarrierMeshSurfaceYMax(ORIGIN.x - PAVEMENT_SKIRT_M - 1, ORIGIN.z + 20, colliders), NO_SURFACE_Y);
    });

    it('files a large soup in cells, each with its own box', () => {
        // A 1 km strip of 40 m squares.
        const strip: number[] = [];
        for (let i = 0; i < 25; i++) {
            strip.push(...APRON.map((v, k) => k % 3 === 0 ? v + i * 40 : v));
        }
        const colliders = pavementColliders(strip, ORIGIN, 1.5);
        assert.ok(colliders.length >= 10, `${colliders.length} cells`);
        assert.ok(Math.abs(sampleCarrierMeshSurfaceYMax(ORIGIN.x + 515, ORIGIN.z + 20, colliders) - 1.5) < 1e-6);
    });

    it('answers through the grid index exactly as by testing every collider', () => {
        const strip: number[] = [];
        for (let i = 0; i < 25; i++) {
            strip.push(...APRON.map((v, k) => k % 3 === 0 ? v + i * 40 : v));
        }
        const colliders = pavementColliders(strip, ORIGIN, 1.5);
        const index = new MeshColliderIndex(colliders);
        for (let x = -40; x < 1060; x += 7.3) {
            for (let z = -30; z < 70; z += 3.7) {
                assert.equal(index.sampleYMax(ORIGIN.x + x, ORIGIN.z + z),
                    sampleCarrierMeshSurfaceYMax(ORIGIN.x + x, ORIGIN.z + z, colliders), `at ${x},${z}`);
            }
        }
    });
});
