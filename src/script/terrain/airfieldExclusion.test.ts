import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAirfieldExclusion } from './airfieldExclusion';
import { Airfield } from './airfields';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from './geodesy';
import { sceneRunwayOf } from '../state/activeAirfield';

/** Munich's 08L/26R, 450 m up and ~230 km from a DACH-style origin. */
const MUNICH: Airfield = {
    name: 'Flughafen München', icao: 'EDDM', iata: 'MUC', kind: 'aerodrome', area: 'DACH',
    lat: 48.3538, lon: 11.7861, elevationM: 450,
    plane: { heightMsl: 450, gradient: 0, headingDeg: 80 },
    runways: [{
        ref: '08L/26R', headingDeg: 80, lengthM: 4000, widthM: 60, surface: 'concrete', lit: true,
        lat: 48.3640, lon: 11.7700, thresholds: [],
    }],
    taxiways: [], aprons: [], buildings: [], pads: [],
};

describe('buildAirfieldExclusion', () => {
    it('covers the runway where it is drawn, far from the origin and high up', () => {
        const basis = makeEnuBasis(50.3, 11.8, 0);
        const toEnu = (lat: number, lon: number, h: number) => {
            const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, h));
            return { e: enu.e, n: enu.n };
        };
        const test = buildAirfieldExclusion([MUNICH], toEnu)!;
        const drawn = sceneRunwayOf(MUNICH, MUNICH.runways[0], basis, 0);
        const ax = Math.sin(drawn.heading), az = Math.cos(drawn.heading);
        for (let t = -1; t <= 1; t += 0.25) {
            for (const s of [-1, 0, 1]) {
                const x = drawn.center.x + ax * t * drawn.halfLength + az * s * drawn.halfWidth;
                const z = drawn.center.z + az * t * drawn.halfLength - ax * s * drawn.halfWidth;
                assert.equal(test(x, z), true, `t=${t} s=${s}`);
            }
        }
        // And not the farmland a few hundred metres beside it.
        assert.equal(test(drawn.center.x + az * 200, drawn.center.z - ax * 200), false);
    });
});
