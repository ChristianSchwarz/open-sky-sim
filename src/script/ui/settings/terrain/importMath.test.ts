import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    BAKE_ZOOM, bakeTiles, blockedReason, latToWorld, lonToWorld, TILE_PX, worldToLat, worldToLon,
} from './importMath';

describe('Web Mercator', () => {
    it('puts the antimeridian and the equator at the edges and centre of zoom 0', () => {
        assert.equal(lonToWorld(-180, 0), 0);
        assert.equal(lonToWorld(180, 0), TILE_PX);
        assert.ok(Math.abs(latToWorld(0, 0) - TILE_PX / 2) < 1e-9);
    });

    it('round-trips a point through world pixels', () => {
        const z = 9;
        const lon = 13.405;
        const lat = 52.52;
        assert.ok(Math.abs(worldToLon(lonToWorld(lon, z), z) - lon) < 1e-9);
        assert.ok(Math.abs(worldToLat(latToWorld(lat, z), z) - lat) < 1e-9);
    });
});

describe('bakeTiles', () => {
    const span = 180 / (1 << BAKE_ZOOM);

    it('counts a box inside one tile as one tile', () => {
        assert.equal(bakeTiles({ west: 0.001, south: 0.001, east: 0.002, north: 0.002 }), 1);
    });

    it('counts a box crossing one tile boundary east-west as two tiles', () => {
        assert.equal(bakeTiles({ west: 0.001, south: 0.001, east: span + 0.001, north: 0.002 }), 2);
    });
});

describe('blockedReason', () => {
    const box = { west: 10, south: 45, east: 11, north: 46 };

    it('blocks while a job runs, before anything else', () => {
        assert.equal(blockedReason(true, undefined, ''), 'import running');
    });

    it('asks for a box, then a sane size, then a name', () => {
        assert.match(blockedReason(false, undefined, 'alps') ?? '', /shift-drag/);
        assert.match(blockedReason(false, { ...box, east: 14 }, 'alps') ?? '', /too big/);
        assert.match(blockedReason(false, box, '   ') ?? '', /name/);
    });

    it('is ready with a box within the limit and a name', () => {
        assert.equal(blockedReason(false, box, 'alps'), undefined);
    });
});
