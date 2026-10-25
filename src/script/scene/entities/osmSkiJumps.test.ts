import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { airfieldPlaneSceneAt, sceneRunwaysOf } from '../../state/activeAirfield';
import { Airfield } from '../../terrain/airfields';
import { makeEnuBasis } from '../../terrain/geodesy';
import { osmSkiJumpsOf } from './osmSkiJumps';
import { sampleSkiJumpSurfaceY } from './skiJump';

const BASIS = makeEnuBasis(45.098, 33.605, 0);

function saki(): Airfield {
    return {
        name: 'Saki', icao: 'URFI', iata: '', kind: 'military', area: 'Krim',
        lat: 45.09, lon: 33.59, elevationM: 14.9,
        plane: { heightMsl: 14.9, gradient: 0, headingDeg: 45 },
        runways: [
            {
                ref: '04R/22L', headingDeg: 45, lengthM: 3220, widthM: 45,
                surface: 'concrete', lit: false, lat: 45.0918, lon: 33.6048,
                thresholds: [[45.0817, 33.5902], [45.1019, 33.6194]],
            },
            {
                ref: '04/22', headingDeg: 45, lengthM: 213, widthM: 30,
                surface: 'concrete', lit: false, lat: 45.0974, lon: 33.6042,
                thresholds: [[45.0967, 33.6033], [45.0981, 33.6052]], skiJump: true,
            },
        ],
        taxiways: [], aprons: [], buildings: [], pads: [],
        skiJumps: [{
            name: 'T2 ski-jump', ring: [], heightM: 8,
            lat: 45.098074, lon: 33.605216, headingDeg: 45, lengthM: 55, widthM: 27,
            runUpFound: true,
        }],
    };
}

describe('OSM ski-jumps', () => {

    it('stands the ramp on the airfield plane, rising north-east to its lip', () => {
        const [jump] = osmSkiJumpsOf([saki()], BASIS);
        const c = jump.collider;
        // On the run-up's pavement: the plane's 14.9 m plus the 1.5 m every
        // pavement is lifted, a few hundred metres from the origin.
        assert.ok(Math.abs(c.originY - 16.4) < 0.1, `${c.originY}`);
        // Scene heading: x east, z south, so 045 is +x, -z.
        assert.ok(Math.abs(c.heading - Math.atan2(1, -1)) < 0.02, `${c.heading}`);
        assert.equal(c.length, 55);
        assert.equal(c.height, 8);
        assert.equal(c.halfWidth, 13.5);
        const lip = sampleSkiJumpSurfaceY(
            c.originX + Math.sin(c.heading) * 54.9, c.originZ + Math.cos(c.heading) * 54.9, c);
        assert.ok(Math.abs(lip - (c.originY + 8)) < 0.05, `${lip}`);
    });

    it('makes the run-up a start point facing the ramp', () => {
        const runways = sceneRunwaysOf([saki()], BASIS, 1.5);
        assert.deepEqual(runways.filter(r => !r.startOnly).map(r => r.ref), ['04R/22L']);
        const run = runways.find(r => r.startOnly)!;
        assert.equal(run.label, 'T2 ski-jump');
        // Facing 045: +x, -z in scene terms.
        assert.ok(Math.sin(run.heading) > 0.6 && Math.cos(run.heading) < -0.6, `${run.heading}`);
    });

    it('puts a runway far down a sloped plane on that plane, not on the main runway height', () => {
        // Saki: the plane rises 0.47 % to the north-east; NITKA lies 1.8 km
        // south-west of the main runway. Its solid surface sat 8.5 m above the
        // deck drawn for it.
        const field = saki();
        field.plane = { heightMsl: 14.9, gradient: 0.0047, headingDeg: 45 };
        field.runways[1] = { ...field.runways[1], lat: 45.0837, lon: 33.5849,
            thresholds: [[45.0830, 33.5839], [45.0844, 33.5859]], skiJump: false, surface: 'metal' };
        const deck = sceneRunwaysOf([field], BASIS, 0).find(r => r.startOnly)!;
        const want = airfieldPlaneSceneAt(field, BASIS, 45.0837, 33.5849);
        assert.ok(Math.abs(deck.center.y - want.y) < 0.05, `${deck.center.y} vs ${want.y}`);
        assert.ok(deck.center.y < 14.9 - 7, `still at ${deck.center.y}`);
    });

    it('turns the run-up round when its designators put the ramp behind', () => {
        const field = saki();
        field.runways[1] = { ...field.runways[1], headingDeg: 225, ref: '22/04',
            thresholds: [[45.0981, 33.6052], [45.0967, 33.6033]] };
        const run = sceneRunwaysOf([field], BASIS, 1.5).find(r => r.startOnly)!;
        assert.ok(Math.sin(run.heading) > 0.6 && Math.cos(run.heading) < -0.6, `${run.heading}`);
    });
});
