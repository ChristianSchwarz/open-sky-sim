import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Airfield } from '../terrain/airfields';
import { makeEnuBasis } from '../terrain/geodesy';
import {
    airfieldChoices, headingForward, nearestSceneRunway, pickStartRunway, sceneRunwayOf,
    sceneRunwaysOf,
} from './activeAirfield';

const BASIS = makeEnuBasis(28.0015, -15.3937, 0);
const EPS = 1.5;

function airfield(over: Partial<Airfield> = {}): Airfield {
    return {
        name: 'Gran Canaria',
        icao: 'GCLP',
        iata: 'LPA',
        kind: 'international',
        area: 'home',
        lat: 27.93016,
        lon: -15.38801,
        elevationM: 12.97,
        plane: { heightMsl: 12.97, gradient: -0.00385, headingDeg: 21.4354 },
        runways: [{
            ref: '03L/21R', headingDeg: 21.4354, lengthM: 3103, widthM: 45,
            surface: 'asphalt', lit: true, lat: 27.931904, lon: -15.386584,
            thresholds: [[27.918871, -15.392346], [27.944937, -15.380823]],
        }],
        taxiways: [], aprons: [], buildings: [], pads: [],
        ...over,
    };
}

const DEG = 180 / Math.PI;

describe('active airfield', () => {

    describe('scene runway', () => {

        it('turns a true bearing into a scene heading', () => {
            // Scene axes are x east, z south, so a runway on 021 true faces
            // 159 in the scene. Getting this wrong lands every aircraft
            // backwards down its own runway.
            const r = sceneRunwayOf(airfield(), airfield().runways[0], BASIS, EPS);
            const heading = ((r.heading * DEG) % 360 + 360) % 360;
            assert.ok(Math.abs(heading - (180 - 21.4354)) < 0.5,
                `scene heading ${heading.toFixed(2)}`);
        });

        it('keeps the runway its own size', () => {
            const r = sceneRunwayOf(airfield(), airfield().runways[0], BASIS, EPS);
            assert.equal(r.halfLength, 3103 / 2);
            assert.equal(r.halfWidth, 22.5);
            assert.equal(r.ref, '03L/21R');
            assert.equal(r.icao, 'GCLP');
        });

        it('faces the low designator, so the numbers read on landing', () => {
            // Landing on 03 means flying roughly north-east, which in scene
            // axes is +x and -z.
            const r = sceneRunwayOf(airfield(), airfield().runways[0], BASIS, EPS);
            const fwd = headingForward(r.heading);
            assert.ok(fwd.x > 0, 'not heading east');
            assert.ok(fwd.z < 0, 'not heading north');
        });

        it('carries the runway slope, downhill toward the far threshold', () => {
            const r = sceneRunwayOf(airfield(), airfield().runways[0], BASIS, EPS);
            // The elevation gradient is -0.385%. Scene Y differs from it by the
            // curvature: this runway climbs toward the play origin, so its far
            // threshold loses less of the drop and the slope comes out shallower
            // rather than steeper. Downhill either way, and still a runway.
            assert.ok(r.slope < 0, `slope ${r.slope} is not downhill`);
            assert.ok(Math.abs(r.slope) > 0.001, `slope ${r.slope} is flat`);
            assert.ok(Math.abs(r.slope) < 0.008, `slope ${r.slope} is not a runway`);
        });

        it('is level when the airfield is', () => {
            const level = airfield({
                plane: { heightMsl: 100, gradient: 0, headingDeg: 21.4354 },
            });
            const r = sceneRunwayOf(level, level.runways[0], BASIS, EPS);
            // Not exactly zero: the two thresholds sit at different distances
            // from the play origin, so the ground curves away unevenly.
            assert.ok(Math.abs(r.slope) < 0.003, `slope ${r.slope}`);
        });
    });

    describe('the area\'s runways', () => {

        const twoFields = [
            airfield(),
            airfield({
                name: 'La Palma', icao: 'GCLA', lat: 28.627, lon: -17.755,
                plane: { heightMsl: 26, gradient: 0, headingDeg: 179 },
                runways: [{
                    ref: '18/36', headingDeg: 179, lengthM: 2112, widthM: 45,
                    surface: 'asphalt', lit: true, lat: 28.627, lon: -17.755,
                    thresholds: [[28.636, -17.755], [28.617, -17.755]],
                }],
            }),
        ];

        it('lists every runway, longest first', () => {
            const runways = sceneRunwaysOf(twoFields, BASIS, EPS);
            assert.equal(runways.length, 2);
            assert.ok(runways[0].halfLength >= runways[1].halfLength);
            assert.equal(runways[0].icao, 'GCLP');
        });

        it('marks one runway per airfield as its primary', () => {
            const parallel = airfield({
                runways: [
                    airfield().runways[0],
                    { ...airfield().runways[0], ref: '03R/21L', lengthM: 3099 },
                ],
            });
            const runways = sceneRunwaysOf([parallel], BASIS, EPS);
            assert.equal(runways.filter(r => r.primary).length, 1);
            assert.equal(runways.find(r => r.primary)!.ref, '03L/21R');
        });

        it('starts at the usable field nearest the play origin', () => {
            // Not the longest in the area: an area three degrees across can
            // have that a hundred kilometres away across water, and the
            // scenario, the carrier and the finest vertices are all at the
            // origin.
            const distant = airfield({
                name: 'Tenerife Norte', icao: 'GCXO', lat: 28.483, lon: -16.341,
                plane: { heightMsl: 621, gradient: 0, headingDeg: 110.6 },
                runways: [{
                    ref: '12/30', headingDeg: 110.6, lengthM: 3395, widthM: 45,
                    surface: 'asphalt', lit: true, lat: 28.483, lon: -16.341,
                    thresholds: [[28.49, -16.36], [28.47, -16.32]],
                }],
            });
            const runways = sceneRunwaysOf([...twoFields, distant], BASIS, EPS);
            assert.equal(runways[0].icao, 'GCXO', 'the long one should sort first');
            assert.equal(pickStartRunway(runways)!.icao, 'GCLP');
        });

        it('honours a named airfield', () => {
            const runways = sceneRunwaysOf(twoFields, BASIS, EPS);
            assert.equal(pickStartRunway(runways, 'GCLA')!.icao, 'GCLA');
        });

        it('ignores a name that is not in this area', () => {
            // Flying somewhere else should not leave the session with no
            // airfield at all because the last choice was in another one.
            const runways = sceneRunwaysOf(twoFields, BASIS, EPS);
            assert.equal(pickStartRunway(runways, 'EDDB')!.icao, 'GCLP');
        });

        it('honours an unnamed airfield picked by its name', () => {
            // Most small US strips and unnamed OSM airstrips carry no ICAO —
            // the picker offers them keyed by name instead (see
            // airfieldChoices), and the same key has to work coming back in.
            const unnamed = airfield({
                icao: '', name: 'Gatow', lat: 28.05, lon: -15.39,
                plane: { heightMsl: 46, gradient: 0, headingDeg: 77 },
                runways: [{
                    ref: '08R/26L', headingDeg: 77, lengthM: 871, widthM: 46,
                    surface: 'asphalt', lit: false, lat: 28.05, lon: -15.39,
                    thresholds: [[28.05, -15.4], [28.05, -15.38]],
                }],
            });
            const runways = sceneRunwaysOf([...twoFields, unnamed], BASIS, EPS);
            assert.equal(pickStartRunway(runways, 'Gatow')!.name, 'Gatow');
        });

        it('would rather start on grass than nowhere', () => {
            const grass = sceneRunwaysOf([airfield({
                runways: [{ ...airfield().runways[0], surface: 'grass' }],
            })], BASIS, EPS);
            assert.ok(pickStartRunway(grass) !== undefined);
        });

        it('keeps the pavement when nothing is long enough to be a base', () => {
            // An area of small fields has nothing over 1500 m. Falling straight
            // through to "any primary, nearest" based Berlin at a 910 m grass
            // strip with a 1100 m asphalt one up the road.
            const nearGrass = airfield({
                icao: 'EDBE', name: 'grass', lat: 28.01, lon: -15.39,
                plane: { heightMsl: 30, gradient: 0, headingDeg: 100 },
                runways: [{
                    ref: '10/28', headingDeg: 100, lengthM: 910, widthM: 40,
                    surface: 'grass', lit: false, lat: 28.01, lon: -15.39,
                    thresholds: [[28.01, -15.4], [28.01, -15.38]],
                }],
            });
            const fartherPaved = airfield({
                icao: 'EDAZ', name: 'paved', lat: 28.2, lon: -15.39,
                plane: { heightMsl: 40, gradient: 0, headingDeg: 76 },
                runways: [{
                    ref: '07/25', headingDeg: 76, lengthM: 1101, widthM: 23,
                    surface: 'asphalt', lit: true, lat: 28.2, lon: -15.39,
                    thresholds: [[28.2, -15.4], [28.2, -15.38]],
                }],
            });
            const runways = sceneRunwaysOf([nearGrass, fartherPaved], BASIS, EPS);
            assert.equal(pickStartRunway(runways)!.icao, 'EDAZ');
        });

        it('takes the longest strip when none of them is a base', () => {
            // Berlin: a 871 m paved museum field 26 km out against a 1101 m
            // paved one at 30. Neither is base-sized, so distance stops being
            // the question and the better runway wins.
            const near = airfield({
                icao: '', name: 'Gatow', lat: 28.05, lon: -15.39,
                plane: { heightMsl: 46, gradient: 0, headingDeg: 77 },
                runways: [{
                    ref: '08R/26L', headingDeg: 77, lengthM: 871, widthM: 46,
                    surface: 'asphalt', lit: false, lat: 28.05, lon: -15.39,
                    thresholds: [[28.05, -15.4], [28.05, -15.38]],
                }],
            });
            const far = airfield({
                icao: 'EDAZ', name: 'Schoenhagen', lat: 28.25, lon: -15.39,
                plane: { heightMsl: 40, gradient: 0, headingDeg: 76 },
                runways: [{
                    ref: '07/25', headingDeg: 76, lengthM: 1101, widthM: 23,
                    surface: 'asphalt', lit: true, lat: 28.25, lon: -15.39,
                    thresholds: [[28.25, -15.4], [28.25, -15.38]],
                }],
            });
            assert.equal(
                pickStartRunway(sceneRunwaysOf([near, far], BASIS, EPS))!.icao, 'EDAZ');
        });

        it('has no runway when the area has no airfield', () => {
            assert.equal(pickStartRunway([]), undefined);
            assert.equal(nearestSceneRunway([], 0, 0), undefined);
        });

        it('finds the closest one to a point', () => {
            const runways = sceneRunwaysOf(twoFields, BASIS, EPS);
            const gclp = runways.find(r => r.icao === 'GCLP')!;
            const near = nearestSceneRunway(
                runways, gclp.center.x + 500, gclp.center.z - 500);
            assert.equal(near!.icao, 'GCLP');
        });
    });

    describe('the airfield menu', () => {

        it('offers one entry per airfield, not per runway', () => {
            const parallel = airfield({
                runways: [
                    airfield().runways[0],
                    { ...airfield().runways[0], ref: '03R/21L', lengthM: 3099 },
                ],
            });
            const choices = airfieldChoices(sceneRunwaysOf([parallel], BASIS, EPS));
            assert.equal(choices.length, 1);
            assert.equal(choices[0].icao, 'GCLP');
            assert.equal(choices[0].ref, '03L/21R');
            assert.equal(Math.round(choices[0].lengthM), 3103);
        });

        it('keeps two unnamed airstrips apart', () => {
            // Keyed by ICAO, and an airstrip has none — so without the name
            // fallback every unnamed field in an area collapses into one entry.
            const strips = [
                airfield({ icao: '', name: 'north strip' }),
                airfield({ icao: '', name: 'south strip', lat: 27.8 }),
            ];
            assert.equal(airfieldChoices(sceneRunwaysOf(strips, BASIS, EPS)).length, 2);
        });
    });

    describe('heading forward', () => {

        it('points along +Z at heading 0, as the AI and the player agree', () => {
            const f = headingForward(0);
            assert.ok(Math.abs(f.x) < 1e-12);
            assert.equal(f.z, 1);
            const east = headingForward(Math.PI / 2);
            assert.equal(east.x, 1);
            assert.ok(Math.abs(east.z) < 1e-12);
        });
    });
});
