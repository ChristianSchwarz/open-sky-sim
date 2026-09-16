import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PTX_NO_DATA } from '../../../terrain/ptx';
import { tileAtLonLat, tileBounds } from '../../../terrain/tiling';
import {
    mapTilePixels,
    mapTilesInView,
    movingMapZoom,
    parseHexColor,
    placeMapTile,
    texelMetres,
} from './movingMap';

// The shipped bake: 256 texels up to z9, 512 from z10, sidecars for z4..z11.
const texelsAt = (z: number) => z >= 10 ? 512 : 256;
const RANGE = { min: 4, max: 11 };

describe('moving map zoom choice', () => {
    it('takes the coarsest zoom whose texels fit a pixel', () => {
        // 20 Km across ~100 px: 200 m/px. A z8 texel is 304 m, z9 152 m.
        assert.ok(texelMetres(8, 256) > 200);
        assert.ok(texelMetres(9, 256) <= 200);
        assert.equal(movingMapZoom(200, texelsAt, RANGE), 9);
    });

    it('accounts for the near tiles being twice as dense', () => {
        // z10 at 512 texels is 38 m; z9 at 256 is 152 m.
        assert.equal(movingMapZoom(100, texelsAt, RANGE), 10);
        assert.equal(movingMapZoom(160, texelsAt, RANGE), 9);
    });

    it('clamps to what the bake wrote', () => {
        assert.equal(movingMapZoom(1, texelsAt, RANGE), 11);
        assert.equal(movingMapZoom(1e6, texelsAt, RANGE), 4);
    });
});

describe('moving map tile placement', () => {
    it('puts the tile under the ownship around the origin, y growing south', () => {
        const lat = 48.1, lon = 11.6;
        const id = tileAtLonLat(10, lon, lat);
        const place = placeMapTile(id, lat, lon);
        assert.ok(place.x <= 0 && place.x + place.width >= 0, `x ${place.x} w ${place.width}`);
        assert.ok(place.y <= 0 && place.y + place.height >= 0, `y ${place.y} h ${place.height}`);
        // A tile north-west of the ownship sits up and left.
        const nw = placeMapTile({ z: id.z, x: id.x - 1, y: id.y - 1 }, lat, lon);
        assert.ok(nw.x + nw.width <= 0);
        assert.ok(nw.y + nw.height <= 0);
    });

    it('narrows the lon span with latitude but not the lat span', () => {
        const id = { z: 10, x: 1090, y: 238 };
        const b = tileBounds(id);
        const midLat = (b.north + b.south) / 2;
        const place = placeMapTile(id, midLat, b.west);
        assert.ok(place.width < place.height);
        assert.ok(Math.abs(place.height - (b.north - b.south) * 110540) < 1e-6);
    });
});

describe('moving map tiles in view', () => {
    it('covers the ownship tile and its neighbours within the extent', () => {
        const lat = 48.1, lon = 11.6;
        const own = tileAtLonLat(10, lon, lat);
        const ids = mapTilesInView(10, lat, lon, 30000);
        assert.ok(ids.some(t => t.x === own.x && t.y === own.y));
        assert.ok(ids.length >= 4 && ids.length <= 25, `${ids.length}`);
        for (const t of ids) {
            assert.ok(Math.abs(t.x - own.x) <= 3 && Math.abs(t.y - own.y) <= 3);
        }
    });

    it('needs only the ownship tile for a tiny extent well inside it', () => {
        const b = tileBounds({ z: 8, x: 272, y: 59 });
        const lat = (b.north + b.south) / 2;
        const lon = (b.east + b.west) / 2;
        assert.equal(mapTilesInView(8, lat, lon, 100).length, 1);
    });
});

describe('moving map pixels', () => {
    it('parses hex colours', () => {
        assert.deepEqual(parseHexColor('#16355e'), [0x16, 0x35, 0x5e]);
        assert.deepEqual(parseHexColor('nope'), [0, 0, 0]);
    });

    it('paints no-data texels the water colour and everything opaque', () => {
        const texels = new Uint8Array([
            10, 20, 30, 3,
            0, 0, 0, PTX_NO_DATA,
        ]);
        const px = mapTilePixels({ id: { z: 4, x: 0, y: 0 }, size: 1, texels }, [1, 2, 3]);
        assert.deepEqual(Array.from(px), [10, 20, 30, 255, 1, 2, 3, 255]);
    });
});
