import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    createCarrierMeshCollider,
    sampleCarrierMeshSurfaceY,
    NO_SURFACE_Y,
    sampleCarrierMeshSurfaceYMax,
} from './carrierDeck';
import { AircraftCollisionMesh } from './aircraftDef';

/** Unit box: top face at y=10, footprint [-5,5]×[-5,5]. */
function boxTopMesh(): AircraftCollisionMesh {
    const triangles = [
        -5, 10, -5, 5, 10, -5, 5, 10, 5,
        -5, 10, -5, 5, 10, 5, -5, 10, 5,
    ];
    return {
        triangles,
        aabb: { min: [-5, 10, -5], max: [5, 10, 5] },
    };
}

/** Ramp rising along +Z from y=10 at z=0 to y=20 at z=10. */
function rampMesh(): AircraftCollisionMesh {
    const triangles = [
        -2, 10, 0, 2, 10, 0, 2, 20, 10,
        -2, 10, 0, 2, 20, 10, -2, 20, 10,
    ];
    return {
        triangles,
        aabb: { min: [-2, 10, 0], max: [2, 20, 10] },
    };
}

describe('carrierMesh', () => {
    const mesh = boxTopMesh();
    const carrier = createCarrierMeshCollider(100, 0, 200, mesh);

    it('returns deck height inside the footprint', () => {
        assert.ok(Math.abs(sampleCarrierMeshSurfaceY(100, 200, carrier) - 10) < 1e-4);
        assert.ok(Math.abs(sampleCarrierMeshSurfaceY(100 + 4, 200 - 4, carrier) - 10) < 1e-4);
    });

    it('reports no surface outside the footprint', () => {
        // NO_SURFACE_Y, not 0: this value is folded into the Math.max that
        // decides the ground, and 0 there is a floor at the tangent plane.
        assert.equal(sampleCarrierMeshSurfaceY(100 + 6, 200, carrier), NO_SURFACE_Y);
        assert.equal(sampleCarrierMeshSurfaceY(100, 200 + 6, carrier), NO_SURFACE_Y);
        assert.equal(sampleCarrierMeshSurfaceY(0, 0, carrier), NO_SURFACE_Y);
    });

    it('samples ski-jump ramp height along the incline', () => {
        const ramp = createCarrierMeshCollider(0, 0, 0, rampMesh());
        assert.ok(Math.abs(sampleCarrierMeshSurfaceY(0, 0, ramp) - 10) < 1e-3);
        assert.ok(Math.abs(sampleCarrierMeshSurfaceY(0, 5, ramp) - 15) < 1e-3);
        assert.ok(Math.abs(sampleCarrierMeshSurfaceY(0, 10, ramp) - 20) < 1e-3);
    });

    it('sampleCarrierMeshSurfaceYMax picks the highest surface', () => {
        const low = createCarrierMeshCollider(0, 0, 0, {
            triangles: [-1, 5, -1, 1, 5, -1, 1, 5, 1, -1, 5, -1, 1, 5, 1, -1, 5, 1],
            aabb: { min: [-1, 5, -1], max: [1, 5, 1] },
        });
        const high = createCarrierMeshCollider(0, 0, 0, {
            triangles: [-0.5, 20, -0.5, 0.5, 20, -0.5, 0.5, 20, 0.5, -0.5, 20, -0.5, 0.5, 20, 0.5, -0.5, 20, 0.5],
            aabb: { min: [-0.5, 20, -0.5], max: [0.5, 20, 0.5] },
        });
        assert.ok(Math.abs(sampleCarrierMeshSurfaceYMax(0, 0, [low, high]) - 20) < 1e-4);
        assert.ok(Math.abs(sampleCarrierMeshSurfaceYMax(0.8, 0, [low, high]) - 5) < 1e-4);
        assert.equal(sampleCarrierMeshSurfaceYMax(50, 0, [low, high]), NO_SURFACE_Y);
    });
});
