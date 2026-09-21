import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    CoastPolygon, InlandBody, LanduseRegion, Watercourse, decodeLvr, encodeLvrUncompressed,
} from './lvr';

const SQUARE: CoastPolygon = {
    exterior: [
        { lon: 0, lat: 0 }, { lon: 1, lat: 0 },
        { lon: 1, lat: 1 }, { lon: 0, lat: 1 },
    ],
    holes: [],
};

function body(surfaceHeightM: number | undefined): InlandBody {
    return {
        exterior: [
            { lon: 0.2, lat: 0.2 }, { lon: 0.4, lat: 0.2 }, { lon: 0.4, lat: 0.4 },
        ],
        holes: [],
        surfaceHeightM,
    };
}

describe('LVR decode', () => {
    it('round-trips land polygons with no inland layer as LVR1', () => {
        const tile = decodeLvr(encodeLvrUncompressed([SQUARE]));
        assert.equal(tile.polygons.length, 1);
        assert.equal(tile.polygons[0].exterior.length, 4);
        assert.deepEqual(tile.inland, []);
    });

    it('round-trips inland bodies with their surface heights', () => {
        const tile = decodeLvr(encodeLvrUncompressed([SQUARE], [body(912.5), body(-31.25)]));
        assert.equal(tile.polygons.length, 1);
        assert.equal(tile.inland.length, 2);
        assert.equal(tile.inland[0].surfaceHeightM, 912.5);
        // Below sea level is a real elevation, not a missing one: the Dead Sea
        // and the Salton Sea both sit under the datum.
        assert.equal(tile.inland[1].surfaceHeightM, -31.25);
    });

    it('reads a body with no measured height as undefined, not zero', () => {
        const tile = decodeLvr(encodeLvrUncompressed([SQUARE], [body(undefined)]));
        assert.equal(tile.inland.length, 1);
        assert.equal(tile.inland[0].surfaceHeightM, undefined);
    });

    it('round-trips watercourses as LVR3, alongside the other layers', () => {
        const canal: Watercourse = {
            widthM: 12.5,
            points: [{ lon: 0.1, lat: 0.5 }, { lon: 0.5, lat: 0.5 }, { lon: 0.9, lat: 0.6 }],
        };
        const tile = decodeLvr(encodeLvrUncompressed([SQUARE], [body(912.5)], [canal]));
        assert.equal(tile.polygons.length, 1);
        assert.equal(tile.inland.length, 1);
        assert.equal(tile.watercourses.length, 1);
        assert.equal(tile.watercourses[0].widthM, 12.5);
        assert.equal(tile.watercourses[0].points.length, 3);
        assert.ok(Math.abs(tile.watercourses[0].points[2].lat - 0.6) < 1e-5);
    });

    it('carries watercourses with no inland water at all', () => {
        const tile = decodeLvr(encodeLvrUncompressed([SQUARE], [], [{
            widthM: 30, points: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }],
        }]));
        assert.deepEqual(tile.inland, []);
        assert.equal(tile.watercourses.length, 1);
    });

    it('leaves watercourses empty on the LVR1 and LVR2 tiles already baked', () => {
        assert.deepEqual(decodeLvr(encodeLvrUncompressed([SQUARE])).watercourses, []);
        assert.deepEqual(
            decodeLvr(encodeLvrUncompressed([SQUARE], [body(10)])).watercourses, []);
    });

    it('drops a run clipped down to a single point rather than rejecting it', () => {
        const tile = decodeLvr(encodeLvrUncompressed([SQUARE], [], [{
            widthM: 30, points: [{ lon: 0.5, lat: 0.5 }],
        }]));
        assert.deepEqual(tile.watercourses, []);
    });

    it('rejects a blob that is not an LVR tile', () => {
        const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        assert.throws(() => decodeLvr(junk));
    });

    describe('LVR4 regions', () => {
        const forest: LanduseRegion = {
            exterior: [
                { lon: 0.1, lat: 0.1 }, { lon: 0.3, lat: 0.1 }, { lon: 0.3, lat: 0.3 },
            ],
            holes: [],
            isLand: true,
            landuseClass: 1,
        };
        const water: LanduseRegion = {
            exterior: [
                { lon: 0.6, lat: 0.6 }, { lon: 0.9, lat: 0.6 }, { lon: 0.9, lat: 0.9 },
            ],
            holes: [],
            isLand: false,
            landuseClass: undefined,
        };

        it('round-trips regions alongside the base land polygons', () => {
            const tile = decodeLvr(encodeLvrUncompressed([SQUARE], [], [], [forest, water]));
            assert.equal(tile.polygons.length, 1, 'the plain land polygon is untouched');
            assert.equal(tile.regions.length, 2);
            assert.equal(tile.regions[0].isLand, true);
            assert.equal(tile.regions[0].landuseClass, 1);
            assert.equal(tile.regions[1].isLand, false);
            assert.equal(tile.regions[1].landuseClass, undefined);
        });

        it('carries regions alongside inland water and watercourses', () => {
            const tile = decodeLvr(encodeLvrUncompressed(
                [SQUARE], [body(912.5)], [{ widthM: 10, points: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }] }],
                [forest],
            ));
            assert.equal(tile.inland.length, 1);
            assert.equal(tile.watercourses.length, 1);
            assert.equal(tile.regions.length, 1);
        });

        it('leaves regions empty on LVR1/LVR2/LVR3 tiles already baked', () => {
            assert.deepEqual(decodeLvr(encodeLvrUncompressed([SQUARE])).regions, []);
            assert.deepEqual(decodeLvr(encodeLvrUncompressed([SQUARE], [body(10)])).regions, []);
            assert.deepEqual(decodeLvr(encodeLvrUncompressed(
                [SQUARE], [], [{ widthM: 5, points: [{ lon: 0, lat: 0 }, { lon: 1, lat: 0 }] }],
            )).regions, []);
        });
    });
});

describe('LVR5 river profile', () => {
    it('round-trips a profile and marks the tile LVR5', () => {
        const withProfile: InlandBody = {
            ...body(undefined),
            profile: [{ lon: 0.25, lat: 0.25, heightM: 31.5 }, { lon: 0.375, lat: 0.375, heightM: 31.25 }],
        };
        const bytes = encodeLvrUncompressed([SQUARE], [body(12), withProfile]);
        assert.equal(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'LVR5');
        const tile = decodeLvr(bytes);
        assert.equal(tile.inland.length, 2);
        assert.equal(tile.inland[0].profile, undefined);
        assert.deepEqual(tile.inland[1].profile, withProfile.profile);
    });
});
