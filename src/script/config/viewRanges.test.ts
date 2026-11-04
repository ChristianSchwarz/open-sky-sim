import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DEFAULT_VIEW_RANGES, VIEW_BAND_MAX_KM, VIEW_LAYER_MAX_KM, sanitizeViewRanges, viewBandsM, viewLayerM,
} from './viewRanges';

describe('sanitizeViewRanges', () => {
    it('falls back to the defaults for anything not a range object', () => {
        assert.deepEqual(sanitizeViewRanges(undefined), DEFAULT_VIEW_RANGES);
        assert.deepEqual(sanitizeViewRanges('far'), DEFAULT_VIEW_RANGES);
    });

    it('keeps the three bands in order', () => {
        const r = sanitizeViewRanges({ textureFromKm: 40, coarseTextureFromKm: 10, blueMarbleFromKm: 5 });
        assert.equal(r.textureFromKm, 40);
        assert.equal(r.coarseTextureFromKm, 40);
        assert.equal(r.blueMarbleFromKm, 40);
    });

    it('clamps each range to its slider', () => {
        const r = sanitizeViewRanges({ blueMarbleFromKm: 9000, treesKm: -3, roadsKm: Number.NaN });
        assert.equal(r.blueMarbleFromKm, VIEW_BAND_MAX_KM);
        assert.equal(r.treesKm, 0);
        assert.equal(r.roadsKm, DEFAULT_VIEW_RANGES.roadsKm);
    });
});

describe('range metres', () => {
    it('reads the top of a slider as no limit', () => {
        const bands = viewBandsM(DEFAULT_VIEW_RANGES);
        assert.equal(bands.coarseTextureFromM, Infinity);
        assert.equal(bands.blueMarbleFromM, Infinity);
        assert.equal(viewLayerM(DEFAULT_VIEW_RANGES, 'buildings'), Infinity);
    });

    it('converts anything below the top to metres', () => {
        const r = sanitizeViewRanges({ coarseTextureFromKm: 60, blueMarbleFromKm: 120, buildingsKm: VIEW_LAYER_MAX_KM.buildings - 1 });
        assert.equal(viewBandsM(r).blueMarbleFromM, 120_000);
        assert.equal(viewLayerM(r, 'buildings'), (VIEW_LAYER_MAX_KM.buildings - 1) * 1000);
    });

    it('never switches the first band off, even at the top', () => {
        const r = sanitizeViewRanges({ textureFromKm: VIEW_BAND_MAX_KM });
        assert.equal(viewBandsM(r).textureFromM, VIEW_BAND_MAX_KM * 1000);
    });
});
