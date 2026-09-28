import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodePdm, encodePdmUncompressed } from './demTile';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from './geodesy';
import { HeightSampler } from './heightSampler';
import { tileAtLonLat, tileBounds, tileKeyString } from './tiling';

const QUERY_ZOOM = 11;
const SIZE = 33;
/** Metres of rise per degree of longitude: a steady eastward ramp. */
const RISE_PER_DEG = 20_000;

/** Berlin Brandenburg, 65 km from an origin at Oehna - where it showed. */
const BASIS = makeEnuBasis(51.8994140625, 12.8759765625);
const HERE = { lat: 52.3519, lon: 13.4958 };

const tile = tileAtLonLat(QUERY_ZOOM, HERE.lon, HERE.lat);
const bounds = tileBounds(tile);
const rampAt = (lon: number) => 100 + RISE_PER_DEG * (lon - bounds.west);

/** One tile holding the ramp; bilinear sampling of a linear field is exact. */
function sampler(): HeightSampler {
    const grid = new Float32Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row++) {
        for (let col = 0; col < SIZE; col++) {
            grid[row * SIZE + col] = rampAt(
                bounds.west + (col / (SIZE - 1)) * (bounds.east - bounds.west));
        }
    }
    const dem = decodePdm(encodePdmUncompressed(grid, SIZE, 0).buffer);
    const key = tileKeyString(tile);
    return new HeightSampler({
        basis: BASIS, seaLevel: 0, queryZoom: QUERY_ZOOM, coarseZoom: 7, pads: [],
        fine: (id) => (tileKeyString(id) === key ? dem : undefined),
        coarse: () => undefined,
    });
}

describe('height sampler far from the play origin', () => {
    // The ground at HERE is drawn at the ENU point of (lat, lon, ramp). A
    // query at that point's (e, n) has to find that same ground. Reading
    // (e, n) off the origin's tangent plane instead lands 3.5 m away, which
    // on this ramp is metres of height.
    const h = rampAt(HERE.lon);
    const drawn = ecefToEnu(BASIS, geodeticToEcef(HERE.lat, HERE.lon, h));
    const s = sampler();

    it('reads the elevation of the ground drawn at that point', () => {
        const got = s.geodeticHeightAtEnu(drawn.e, drawn.n);
        assert.ok(Math.abs(got - h) < 0.05, `read ${got.toFixed(2)} m, drawn at ${h.toFixed(2)}`);
    });

    it('puts the ground at the scene height it is drawn at', () => {
        const got = s.heightAtEnu(drawn.e, drawn.n);
        assert.ok(Math.abs(got - drawn.u) < 0.05,
            `ground at u ${got.toFixed(2)}, drawn at ${drawn.u.toFixed(2)}`);
    });
});
