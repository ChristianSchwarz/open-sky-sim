import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { SceneWorldQuery } from './worldQuery';
import { createSkiJumpCollider } from '../scene/entities/skiJump';
import { createCarrierMeshCollider } from '../scene/entities/carrierDeck';

const RUNWAY = {
    center: new THREE.Vector3(),
    heading: 0,
    halfLength: 1000,
    halfWidth: 20,
};

/** A world whose only ground is the DEM, at `y` everywhere. */
function worldOverFlatDem(y: number, extras: {
    skiJumps?: ReturnType<typeof createSkiJumpCollider>[];
    carriers?: ReturnType<typeof createCarrierMeshCollider>[];
    scenery?: ReturnType<typeof createCarrierMeshCollider>[];
} = {}): SceneWorldQuery {
    return new SceneWorldQuery(
        [], () => true, [], [RUNWAY],
        extras.skiJumps ?? [], extras.carriers ?? [],
        () => y, [], extras.scenery ?? [],
    );
}

describe('SceneWorldQuery.groundHeightAt', () => {

    it('reports the DEM height where nothing else is placed', () => {
        assert.equal(worldOverFlatDem(120).groundHeightAt(0, 0), 120);
    });

    /**
     * The one that matters. Scene Y = 0 is the tangent plane at the play
     * area's origin, not sea level: the terrain curves away from it, so ground
     * below Y = 0 is ordinary — it is every metre of the world more than a few
     * kilometres out. Clamping it to zero put an invisible floor across the
     * whole map that stopped an aircraft in clear air, ~90 m up at Simferopol
     * and ~280 m at Tenerife North.
     */
    it('does not clamp ground below the tangent plane to zero', () => {
        assert.equal(worldOverFlatDem(-138).groundHeightAt(0, 0), -138);
        assert.equal(worldOverFlatDem(-1760).groundHeightAt(0, 0), -1760);
        assert.equal(worldOverFlatDem(-0.5).groundHeightAt(0, 0), -0.5);
    });

    it('keeps ignoring empty collider lists at negative ground', () => {
        const w = new SceneWorldQuery(
            [], () => true, [], [RUNWAY], [], [], () => -300, [], [],
        );
        assert.equal(w.groundHeightAt(0, 0), -300);
        assert.ok(!Number.isFinite(w.carrierHeightAt(0, 0)),
            'no carrier under the point is "no surface", not Y = 0');
    });

    it('still lets a collider win where it does cover the point', () => {
        // A deck plate 5 m above a DEM that sits 300 m below the tangent plane.
        const deckY = -295;
        const deck = createCarrierMeshCollider(0, deckY, 0, {
            triangles: [
                -10, 0, -10, 10, 0, -10, 10, 0, 10,
                -10, 0, -10, 10, 0, 10, -10, 0, 10,
            ],
            aabb: { min: [-10, 0, -10], max: [10, 0, 10] },
        });
        const w = worldOverFlatDem(-300, { carriers: [deck] });
        assert.equal(w.groundHeightAt(0, 0), deckY, 'deck wins over the DEM under it');
        assert.equal(w.groundHeightAt(50, 0), -300, 'off the deck, the DEM stands');
    });

    it('lets a ski jump on low ground win without lifting the ground elsewhere', () => {
        const baseY = -210;
        const ramp = createSkiJumpCollider(0, baseY, 0, 0);
        const w = worldOverFlatDem(-210, { skiJumps: [ramp] });
        assert.ok(w.groundHeightAt(0, 1) > baseY, 'on the ramp, above its base');
        assert.equal(w.groundHeightAt(5000, 5000), -210, 'off the ramp, the DEM stands');
    });
});
