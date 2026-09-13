import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeEnuBasis } from './geodesy';
import { tileAtLonLat } from './tiling';
import { tileOriginWorld, buildSmoothLandGeometry, regionSizes } from './tileMesh';

const HOME = { lat: 28.0015, lon: -15.3937 };
const BASIS = makeEnuBasis(HOME.lat, HOME.lon, 0);
const Z = 9;

/** Where a tile holding a point `dLat`/`dLon` from home is placed. */
function originNear(dLat: number, dLon: number) {
    return tileOriginWorld(tileAtLonLat(Z, HOME.lon + dLon, HOME.lat + dLat), 0, BASIS);
}

describe('tileOriginWorld', () => {
    /**
     * Placement has to agree with the axes the vertices inside the tile are
     * baked in, and both have to agree with the compass. Get the sign wrong
     * and the terrain still tiles seamlessly — as a mirror image of the
     * world it is supposed to be. See `sceneFromEnu`.
     */
    it('places a northern tile at negative z and an eastern one at positive x', () => {
        const north = originNear(0.5, 0);
        const east = originNear(0, 0.5);
        assert.ok(north.z < 0, `tile to the north sits at z ${north.z}`);
        assert.ok(east.x > 0, `tile to the east sits at x ${east.x}`);
    });

    it('is symmetric about the origin', () => {
        const north = originNear(0.5, 0);
        const south = originNear(-0.5, 0);
        assert.ok(north.z < 0 && south.z > 0, `${north.z} / ${south.z}`);
    });
});

describe('regionSizes', () => {
    const GROUND = 13;
    const CROP = 4;
    /** Non-indexed triangles: [ax, ay, az, bx, ..., cz] per triangle, all on y = 0. */
    function tile(tris: { pts: number[]; cls: number; rgb?: number[] }[]) {
        const positions = new Int16Array(tris.flatMap(t => t.pts));
        const attrs = new Uint8Array(tris.flatMap(t => {
            const [r, g, b] = t.rgb ?? [10, 20, 30];
            return [r, g, b, t.cls, r, g, b, t.cls, r, g, b, t.cls];
        }));
        return { positions, attrs };
    }
    // A right triangle with 100-unit legs: 5000 units^2.
    const right = (x0: number) => [x0, 0, 0, x0 + 100, 0, 0, x0, 0, 100];

    it('is the square root of a region summed area, in metres', () => {
        const t = tile([
            { pts: right(0), cls: CROP },
            { pts: right(200), cls: CROP },
            { pts: right(400), cls: GROUND },
        ]);
        const sizes = regionSizes(t.positions, t.attrs, 2);
        // Two 5000-unit triangles at 2 m per unit: 40 000 m^2, width 200 m.
        for (let v = 0; v < 6; v++) assert.equal(sizes[v], 200);
        for (let v = 6; v < 9; v++) assert.equal(sizes[v], 0, 'ground carries no size');
    });

    it('keeps regions of different colour apart', () => {
        const t = tile([
            { pts: right(0), cls: CROP, rgb: [1, 2, 3] },
            { pts: right(200), cls: CROP, rgb: [4, 5, 6] },
            { pts: right(400), cls: GROUND },
        ]);
        const sizes = regionSizes(t.positions, t.attrs, 1);
        assert.equal(sizes[0], Math.round(Math.sqrt(5000)));
        assert.equal(sizes[3], Math.round(Math.sqrt(5000)));
    });

    it('gives a raster-only tile no sizes at all', () => {
        const t = tile([{ pts: right(0), cls: CROP }, { pts: right(200), cls: 1 }]);
        const sizes = regionSizes(t.positions, t.attrs, 1);
        assert.ok(sizes.every(v => v === 0), 'a class there is the ground, not a region');
    });

    it('survives the smooth weld, keeping the larger region at a shared corner', () => {
        const t = tile([
            { pts: right(0), cls: CROP, rgb: [1, 2, 3] },
            // Shares the corner (100, 0, 0) with the first, and is smaller.
            { pts: [100, 0, 0, 150, 0, 0, 100, 0, 50], cls: CROP, rgb: [4, 5, 6] },
        ]);
        const attrs = new Uint8Array(t.attrs.length);
        attrs.set(t.attrs);
        // The tile needs Ground somewhere for the sizes to exist at all.
        const withGround = tile([
            { pts: right(0), cls: CROP, rgb: [1, 2, 3] },
            { pts: [100, 0, 0, 150, 0, 0, 100, 0, 50], cls: CROP, rgb: [4, 5, 6] },
            { pts: right(400), cls: GROUND },
        ]);
        const sizes = regionSizes(withGround.positions, withGround.attrs, 1);
        const normals = new Int8Array((withGround.positions.length / 3) * 4).fill(0);
        for (let v = 0; v < normals.length / 4; v++) normals[v * 4 + 1] = 127;
        const g = buildSmoothLandGeometry(withGround.positions, normals, withGround.attrs, sizes)!;
        const out = g.getAttribute('regionSize').array as Uint16Array;
        const pos = g.getAttribute('position').array as Int16Array;
        let shared = -1;
        for (let v = 0; v < pos.length / 3; v++) {
            if (pos[v * 3] === 100 && pos[v * 3 + 2] === 0) shared = v;
        }
        assert.ok(shared >= 0, 'the shared corner was welded');
        assert.equal(out[shared], Math.round(Math.sqrt(5000)), 'the larger region wins the corner');
        void attrs;
    });
});
