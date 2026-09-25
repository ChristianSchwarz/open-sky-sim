import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TerrainArea, TerrainManifest } from './manifest';
import {
    areaCentre, areaContains, homeArea, resolvePlayArea, terrainAreas,
} from './playArea';

const HOME = { lat: 28.0015, lon: -15.3937, height: 0 };

const CANARIES: TerrainArea = {
    name: 'output_hh', west: -18.66, south: 26.97, east: -12.61, north: 30.49,
};
const ALPS: TerrainArea = {
    name: 'alps', west: 7.55, south: 45.87, east: 8.05, north: 46.02,
};

function manifest(areas?: TerrainArea[]): TerrainManifest {
    return {
        version: 4,
        scheme: 'retro-terrain/1',
        ellipsoid: 'WGS84',
        seaLevel: 0,
        // Deliberately the union box, spanning the ocean between the two.
        coverage: { west: -18.66, south: 26.97, east: 8.05, north: 46.02 },
        areas,
        enuOrigin: HOME,
        mesh: {
            path: '{z}/{x}/{y}.ptm', indexPath: 'i', minZoom: 0, maxZoom: 12,
            encoding: 'PTM1', triangleBudget: 6144,
            levelGeometricErrorM: [], levelSkirtDepthM: [],
        },
        height: {
            path: '{z}/{x}/{y}.pdm', indexPath: 'i', tileSize: 257,
            minZoom: 0, maxZoom: 11, queryZoom: 11, coarseZoom: 7,
        },
        flattenPads: [],
    };
}

describe('playArea', () => {
    it('stands in one area for a pyramid baked before areas were recorded', () => {
        const areas = terrainAreas(manifest(undefined));
        assert.equal(areas.length, 1);
        assert.deepEqual(
            { west: areas[0].west, east: areas[0].east },
            { west: -18.66, east: 8.05 },
        );
    });

    it('treats an empty list the same as a missing one', () => {
        assert.equal(terrainAreas(manifest([])).length, 1);
    });

    it('finds home by position, not by name', () => {
        const found = homeArea([ALPS, CANARIES], HOME);
        assert.equal(found?.name, 'output_hh');
    });

    it('has no home when nothing baked covers the authored origin', () => {
        assert.equal(homeArea([ALPS], HOME), undefined);
    });

    it('keeps the authored origin exactly when flying at home', () => {
        const active = resolvePlayArea(manifest([CANARIES, ALPS]), HOME);
        assert.equal(active.isHome, true);
        assert.equal(active.area.name, 'output_hh');
        // Not the box centre: the scenery is placed in metres from this point.
        assert.deepEqual(active.origin, HOME);
    });

    it('rebases to the box centre when flying somewhere else', () => {
        const active = resolvePlayArea(manifest([CANARIES, ALPS]), HOME, 'alps');
        assert.equal(active.isHome, false);
        assert.deepEqual(active.origin, areaCentre(ALPS));
    });

    it('falls back to home when the saved area no longer exists', () => {
        const active = resolvePlayArea(manifest([CANARIES]), HOME, 'alps');
        assert.equal(active.isHome, true);
        assert.equal(active.area.name, 'output_hh');
    });

    it('falls back to the first area when there is no home either', () => {
        const active = resolvePlayArea(manifest([ALPS]), HOME, 'nowhere');
        assert.equal(active.area.name, 'alps');
        assert.equal(active.isHome, false);
        assert.deepEqual(active.origin, areaCentre(ALPS));
    });

    it('never reports home for an area that does not contain the origin', () => {
        // The guard against a renamed area stranding the scenery: 'output_hh'
        // here is the Alps box, and must not be treated as home.
        const impostor: TerrainArea = { ...ALPS, name: 'output_hh' };
        const active = resolvePlayArea(manifest([impostor]), HOME);
        assert.equal(active.isHome, false);
    });

    it('places the centre in the middle of the box', () => {
        const c = areaCentre(ALPS);
        assert.ok(Math.abs(c.lat - 45.945) < 1e-9, `lat ${c.lat}`);
        assert.ok(Math.abs(c.lon - 7.8) < 1e-9, `lon ${c.lon}`);
        assert.equal(c.height, 0);
    });

    it('tests containment inclusively on the edges', () => {
        assert.equal(areaContains(ALPS, ALPS.south, ALPS.west), true);
        assert.equal(areaContains(ALPS, ALPS.north, ALPS.east), true);
        assert.equal(areaContains(ALPS, ALPS.north + 0.01, ALPS.east), false);
    });
});
