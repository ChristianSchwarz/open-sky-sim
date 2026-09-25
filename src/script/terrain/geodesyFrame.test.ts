import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
    ecefToEnu, enuFrameRotation, geodeticToEcef, makeEnuBasis, sceneFromEnu,
} from './geodesy';

const HOME = { lat: 28.0015, lon: -15.3937 };

/** Scene-space offset of a point from a centre, in `basis` axes. */
function offsetIn(basis: ReturnType<typeof makeEnuBasis>, centre: { lat: number; lon: number },
    point: { lat: number; lon: number }): THREE.Vector3 {
    const c = ecefToEnu(basis, geodeticToEcef(centre.lat, centre.lon, 0));
    const p = ecefToEnu(basis, geodeticToEcef(point.lat, point.lon, 0));
    return sceneFromEnu({ e: p.e - c.e, n: p.n - c.n, u: p.u - c.u });
}

/** A point `metres` north-east of `centre`. */
function offsetPoint(centre: { lat: number; lon: number }, metres: number) {
    return {
        lat: centre.lat + metres / 110540,
        lon: centre.lon + metres / (111320 * Math.cos(centre.lat * Math.PI / 180)),
    };
}

describe('enuFrameRotation', () => {
    it('is the identity between a frame and itself', () => {
        const b = makeEnuBasis(HOME.lat, HOME.lon, 0);
        const q = enuFrameRotation(b, b);
        assert.ok(Math.abs(q.angleTo(new THREE.Quaternion())) < 1e-9);
    });

    it('is the identity between two frames sharing an origin', () => {
        const q = enuFrameRotation(
            makeEnuBasis(HOME.lat, HOME.lon, 0), makeEnuBasis(HOME.lat, HOME.lon, 0),
        );
        assert.ok(Math.abs(q.angleTo(new THREE.Quaternion())) < 1e-9);
    });

    for (const [name, lat, lon, tolerance] of [
        ['Tenerife', 28.31, -16.525, 1e-6],
        ['the Alps', 45.95, 7.80, 1e-6],
        ['the far side of the world', -33.9, 151.2, 1e-4],
    ] as [string, number, number, number][]) {
        it(`carries a baked offset into the drawing frame at ${name}`, () => {
            const bake = makeEnuBasis(HOME.lat, HOME.lon, 0);
            const draw = makeEnuBasis(lat, lon, 0);
            const centre = { lat, lon };
            const point = offsetPoint(centre, 3500);

            const stored = offsetIn(bake, centre, point);
            const correct = offsetIn(draw, centre, point);
            const fixed = stored.clone().applyQuaternion(enuFrameRotation(bake, draw));

            assert.ok(fixed.distanceTo(correct) < tolerance,
                `residual ${fixed.distanceTo(correct)} m`);
        });
    }

    it('the error it removes grows with distance from the bake origin', () => {
        // Guards the reason this exists: without the rotation, a tile drawn in
        // a rebased frame is wrong in proportion to how far the frames differ.
        const bake = makeEnuBasis(HOME.lat, HOME.lon, 0);
        const near = { lat: 28.31, lon: -16.525 };
        const far = { lat: 45.95, lon: 7.80 };
        const errorAt = (c: { lat: number; lon: number }) => {
            const draw = makeEnuBasis(c.lat, c.lon, 0);
            const p = offsetPoint(c, 3500);
            return offsetIn(bake, c, p).distanceTo(offsetIn(draw, c, p));
        };
        assert.ok(errorAt(near) > 10, `near error ${errorAt(near)} m`);
        assert.ok(errorAt(far) > errorAt(near) * 10, `far ${errorAt(far)} vs near ${errorAt(near)}`);
    });
});
