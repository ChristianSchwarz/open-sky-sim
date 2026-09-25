import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from '../../src/script/terrain/geodesy';
import { PtmTile } from '../../src/script/terrain/ptm';
import { RoadClass, decodePtr, encodePtr } from '../../src/script/terrain/ptr';
import { tileBounds } from '../../src/script/terrain/tiling';
import { drapeRoads, simplifyDraped } from './drapeRoads';
import { RoadLine } from './rvr';

const ID = { z: 12, x: 4400, y: 850 };
const HEIGHT = 100;
const Q = 0.5;

/**
 * A tile whose drawn surface is one flat quad `HEIGHT` metres up, split
 * along its diagonal, built the way the bake would: tile-local metres from
 * the tile centre, in the frame of a basis at the tile's own centre so
 * "up" is y.
 */
function flatTile(): { tile: PtmTile; basis: ReturnType<typeof makeEnuBasis> } {
    const b = tileBounds(ID);
    const lat0 = (b.south + b.north) / 2;
    const lon0 = (b.west + b.east) / 2;
    const basis = makeEnuBasis(lat0, lon0, 0);
    const centre = ecefToEnu(basis, geodeticToEcef(lat0, lon0, 0));
    const local = (lon: number, lat: number) => {
        const enu = ecefToEnu(basis, geodeticToEcef(lat, lon, HEIGHT));
        return [enu.e - centre.e, enu.u - centre.u, centre.n - enu.n];
    };
    const nw = local(b.west, b.north), ne = local(b.east, b.north);
    const sw = local(b.west, b.south), se = local(b.east, b.south);
    const tris = [nw, sw, se, nw, se, ne];
    const landPositions = new Int16Array(tris.length * 3);
    tris.forEach((p, i) => {
        landPositions[i * 3] = Math.round(p[0] / Q);
        landPositions[i * 3 + 1] = Math.round(p[1] / Q);
        landPositions[i * 3 + 2] = Math.round(p[2] / Q);
    });
    const tile: PtmTile = {
        id: ID, version: 6, flags: 1, centerHeightM: 0, quantScale: Q, boundingRadiusM: 10000,
        skirtDepthM: 0, geometricErrorM: 0,
        landPositions,
        landNormals: new Int8Array(tris.length * 4),
        landAttrs: new Uint8Array(tris.length * 4),
        waterPositions: new Int16Array(0), waterTones: new Uint8Array(0), waterIndices: new Uint16Array(0),
        waterGroups: [],
        riverPositions: new Int16Array(0), riverDirections: new Int8Array(0),
        riverHalfWidths: new Uint16Array(0), riverIndices: new Uint16Array(0),
    };
    return { tile, basis };
}

function road(cls: number, widthM: number, ...lonLat: number[]): RoadLine {
    const points = [];
    for (let i = 0; i + 1 < lonLat.length; i += 2) {
        points.push({ lon: lonLat[i], lat: lonLat[i + 1] });
    }
    return { cls, widthM, points };
}

describe('drapeRoads', () => {
    const b = tileBounds(ID);
    const lat0 = (b.south + b.north) / 2;

    it('lays a road on the drawn surface, two vertices per point', () => {
        const { tile, basis } = flatTile();
        // West to east across the middle: crosses the quad's diagonal once.
        const out = drapeRoads(tile, basis, [road(RoadClass.Primary, 12, b.west + 0.001, lat0, b.east - 0.001, lat0)]);
        assert.ok(out);
        assert.equal(out.strokes, 1);
        // Two OSM points, doubled: the diagonal crossing lies on a flat
        // surface, so the simplifier drops it.
        assert.equal(out.positions.length / 3, 4);
        for (let v = 0; v < out.positions.length / 3; v++) {
            const y = out.positions[v * 3 + 1];
            assert.ok(y > HEIGHT && y < HEIGHT + 2, `vertex ${v} at ${y}, surface at ${HEIGHT}`);
        }
        assert.equal(out.triangles, 2);
        assert.equal(out.halfWidthsM[0], 6);
        assert.equal(out.classes[0], RoadClass.Primary);
        // Offsets are unit and opposite within a pair.
        const d = out.directions;
        assert.ok(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-6);
        assert.ok(Math.abs(d[0] + d[3]) < 1e-9 && Math.abs(d[2] + d[5]) < 1e-9);
    });

    it('takes major roads first and drops the minor ones when the cap is full', () => {
        const { tile, basis } = flatTile();
        const minor = road(RoadClass.Residential, 5, b.west + 0.001, lat0 + 0.002, b.east - 0.001, lat0 + 0.002);
        const major = road(RoadClass.Motorway, 25, b.west + 0.001, lat0 - 0.002, b.east - 0.001, lat0 - 0.002);
        const out = drapeRoads(tile, basis, [minor, major], 6);
        assert.ok(out);
        assert.equal(out.strokes, 1);
        assert.equal(out.dropped, 1);
        assert.equal(out.classes[0], RoadClass.Motorway);
    });

    it('returns nothing for a tile with no roads', () => {
        const { tile, basis } = flatTile();
        assert.equal(drapeRoads(tile, basis, []), undefined);
    });

    it('round-trips through PTR1', () => {
        const { tile, basis } = flatTile();
        const out = drapeRoads(tile, basis, [road(RoadClass.Secondary, 9, b.west + 0.001, lat0, b.east - 0.001, lat0)])!;
        const bytes = encodePtr({
            id: ID, quantScale: Q, positions: out.positions, directions: out.directions,
            halfWidthsM: out.halfWidthsM, classes: out.classes, indices: out.indices,
        });
        // As the runtime sees it: a fresh, aligned buffer.
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const back = decodePtr(copy.buffer);
        assert.deepEqual(back.id, ID);
        assert.equal(back.quantScale, Q);
        assert.equal(back.positions.length, out.positions.length);
        assert.equal(back.indices.length, out.indices.length);
        assert.equal(back.halfWidths[0], 45);
        assert.equal(back.directions[3], RoadClass.Secondary);
        assert.ok(Math.abs(back.positions[1] * Q - out.positions[1]) <= Q);
    });
});

describe('simplifyDraped', () => {
    const line = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i * 10, z: 0 }));

    it('drops samples on a straight, flat run down to its ends', () => {
        assert.deepEqual(simplifyDraped(line(6), [5, 5, 5, 5, 5, 5], 0.5), [0, 5]);
    });

    it('drops samples on an even slope too', () => {
        assert.deepEqual(simplifyDraped(line(5), [0, 1, 2, 3, 4], 0.5), [0, 4]);
    });

    it('keeps a crest the chord would cut through', () => {
        assert.deepEqual(simplifyDraped(line(5), [0, 0, 3, 0, 0], 0.5), [0, 1, 2, 3, 4]);
    });

    it('keeps a bend in the track however flat the ground', () => {
        const bent = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
        assert.deepEqual(simplifyDraped(bent, [0, 0, 0], 0.5), [0, 1, 2]);
    });

    it('keeps a small rise under the tolerance out', () => {
        assert.deepEqual(simplifyDraped(line(3), [0, 0.4, 0], 0.5), [0, 2]);
    });
});
