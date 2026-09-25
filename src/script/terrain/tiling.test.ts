import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    childrenOf, parentOf, rootTiles, tileAtLonLat, tileBounds, tileContainsLonLat,
    tileKeyString, xCount, yCount,
} from './tiling';

describe('tiling', () => {
    it('has 2×1 roots covering the globe', () => {
        const roots = rootTiles();
        assert.equal(roots.length, 2);
        assert.deepEqual(tileBounds(roots[0]), { west: -180, south: -90, east: 0, north: 90 });
        assert.deepEqual(tileBounds(roots[1]), { west: 0, south: -90, east: 180, north: 90 });
    });

    it('counts tiles as 2^(z+1) × 2^z', () => {
        assert.equal(xCount(0), 2);
        assert.equal(yCount(0), 1);
        assert.equal(xCount(3), 16);
        assert.equal(yCount(3), 8);
    });

    it('round-trips parent/child', () => {
        const id = { z: 4, x: 10, y: 3 };
        const kids = childrenOf(id);
        assert.equal(kids.length, 4);
        for (const c of kids) {
            assert.deepEqual(parentOf(c), id);
        }
    });

    it('locates lon/lat in the correct tile', () => {
        const id = tileAtLonLat(5, -15.4, 28.0);
        const b = tileBounds(id);
        assert.ok(tileContainsLonLat(b, -15.4, 28.0));
        assert.equal(tileKeyString(id).split('/').length, 3);
    });

    it('shares edges between neighbours', () => {
        const a = tileBounds({ z: 3, x: 2, y: 1 });
        const b = tileBounds({ z: 3, x: 3, y: 1 });
        assert.equal(a.east, b.west);
    });
});
