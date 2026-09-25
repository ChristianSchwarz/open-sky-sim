import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import {
    ecefToEnu, ecefToGeodetic, geodeticToEcef, makeEnuBasis, enuToEcef, WGS84_A,
    enuFromScene, sceneFromEnu,
} from './geodesy';
import { vectorHeading } from '../utils/math';

describe('geodesy', () => {
    it('round-trips geodetic → ECEF → geodetic', () => {
        const ecef = geodeticToEcef(28.0015, -15.3937, 123);
        const g = ecefToGeodetic(ecef.x, ecef.y, ecef.z);
        assert.ok(Math.abs(g.lat - 28.0015) < 1e-6);
        assert.ok(Math.abs(g.lon - (-15.3937)) < 1e-6);
        assert.ok(Math.abs(g.height - 123) < 1e-3);
    });

    it('maps the ENU origin to (0,0,0)', () => {
        const basis = makeEnuBasis(28.0015, -15.3937, 0);
        const ecef = geodeticToEcef(28.0015, -15.3937, 0);
        const enu = ecefToEnu(basis, ecef);
        assert.ok(Math.abs(enu.e) < 1e-6);
        assert.ok(Math.abs(enu.n) < 1e-6);
        assert.ok(Math.abs(enu.u) < 1e-6);
    });

    it('round-trips ENU → ECEF → ENU', () => {
        const basis = makeEnuBasis(28.0015, -15.3937, 0);
        const enu = { e: 1000, n: -500, u: 50 };
        const ecef = enuToEcef(basis, enu);
        const back = ecefToEnu(basis, ecef);
        assert.ok(Math.abs(back.e - enu.e) < 1e-6);
        assert.ok(Math.abs(back.n - enu.n) < 1e-6);
        assert.ok(Math.abs(back.u - enu.u) < 1e-6);
    });

    /**
     * The mirror guard.
     *
     * Mapping ENU north onto +z instead of −z is a reflection, not a rotation:
     * nothing about it looks broken up close — normals still point up, tiles
     * still tile — and the only symptom is that the whole world is drawn back
     * to front, with what is really east of the pilot appearing to the west.
     * These lock the handedness down against the compass the rest of the sim
     * already flies by.
     */
    describe('scene axes', () => {
        const BASIS = makeEnuBasis(28.0015, -15.3937, 0);

        /** Scene position of a point `metres` due north of the origin. */
        const dueNorth = (metres: number): THREE.Vector3 => sceneFromEnu(
            ecefToEnu(BASIS, geodeticToEcef(28.0015 + metres / 110540, -15.3937, 0)),
        );

        it('puts north on −z, which is the heading the HUD reads', () => {
            const north = dueNorth(5000);
            assert.ok(north.z < 0, `north at z ${north.z}`);
            assert.ok(Math.abs(north.x) < 1, `north drifts east by ${north.x} m`);
            assert.equal(vectorHeading(north), 0);
        });

        it('puts east on +x, and reads it as a bearing of 090', () => {
            const east = sceneFromEnu({ e: 5000, n: 0, u: 0 });
            assert.equal(east.x, 5000);
            assert.equal(vectorHeading(east), 90);
        });

        it('is right-handed: east × up points along +z, away from north', () => {
            const east = sceneFromEnu({ e: 1, n: 0, u: 0 });
            const up = sceneFromEnu({ e: 0, n: 0, u: 1 });
            const cross = new THREE.Vector3().crossVectors(east, up);
            assert.ok(cross.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-12,
                `east × up = ${cross.toArray()}, expected +z (south)`);
        });

        it('round-trips scene → ENU → scene', () => {
            const enu = { e: 1000, n: -500, u: 50 };
            const back = enuFromScene(sceneFromEnu(enu));
            assert.deepEqual(back, enu);
        });
    });

    it('places equator ECEF x near WGS84_A', () => {
        const ecef = geodeticToEcef(0, 0, 0);
        assert.ok(Math.abs(ecef.x - WGS84_A) < 1);
        assert.ok(Math.abs(ecef.y) < 1);
        assert.ok(Math.abs(ecef.z) < 1);
    });
});
