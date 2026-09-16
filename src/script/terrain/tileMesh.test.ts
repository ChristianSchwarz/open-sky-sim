import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeEnuBasis } from './geodesy';
import { tileAtLonLat } from './tiling';
import { tileOriginWorld, buildSmoothLandGeometry, regionSizes } from './tileMesh';

const HOME = { lat: 28.0015, lon: -15.3937 };
const BASIS = makeEnuBasis(HOME.lat, HOME.lon, 0);
const Z = 9;

/** Indices of every welded vertex at (x, ?, z). */
function verticesAt(g: { getAttribute(name: string): { array: ArrayLike<number> } }, x: number, z: number): number[] {
    const pos = g.getAttribute('position').array;
    const out: number[] = [];
    for (let v = 0; v < pos.length / 3; v++) {
        if (pos[v * 3] === x && pos[v * 3 + 2] === z) out.push(v);
    }
    return out;
}

/** Straight-up normals for every vertex. */
function flatNormals(positions: Int16Array): Int8Array {
    const n = new Int8Array((positions.length / 3) * 4);
    for (let v = 0; v < n.length / 4; v++) n[v * 4 + 1] = 127;
    return n;
}

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

    it('is not welded across two regions sharing a corner', () => {
        const t = tile([
            { pts: right(0), cls: CROP, rgb: [1, 2, 3] },
            // Shares the corner (100, 0, 0) with the first, and is smaller.
            { pts: [100, 0, 0, 150, 0, 0, 100, 0, 50], cls: CROP, rgb: [4, 5, 6] },
            { pts: right(400), cls: GROUND },
        ]);
        const sizes = regionSizes(t.positions, t.attrs, 1);
        const g = buildSmoothLandGeometry(t.positions, flatNormals(t.positions), t.attrs, sizes)!;
        const out = g.getAttribute('regionSize').array as Uint16Array;
        const shared = verticesAt(g, 100, 0);
        assert.equal(shared.length, 2, 'one vertex per region at the corner');
        assert.deepEqual(shared.map(v => out[v]).sort((a, b) => a - b),
            [Math.round(Math.sqrt(1250)), Math.round(Math.sqrt(5000))], 'each keeps its own size');
    });
});

describe('buildSmoothLandGeometry', () => {
    const GROUND = 13;
    const CROP = 4;
    const FOREST = 2;
    function tile(tris: { pts: number[]; cls: number; rgb?: number[] }[]) {
        const positions = new Int16Array(tris.flatMap(t => t.pts));
        const attrs = new Uint8Array(tris.flatMap(t => {
            const [r, g, b] = t.rgb ?? [10, 20, 30];
            return [r, g, b, t.cls, r, g, b, t.cls, r, g, b, t.cls];
        }));
        return { positions, attrs };
    }
    /** Two triangles sharing the edge (0,0,0)-(100,0,0), one tilted so the normals differ. */
    const left = [0, 0, 0, 100, 0, 0, 0, 0, 100];
    const rightSide = [0, 0, 0, 100, 50, -100, 100, 0, 0];
    function normalsOf(positions: Int16Array): Int8Array {
        const n = new Int8Array((positions.length / 3) * 4);
        for (let t = 0; t + 8 < positions.length; t += 9) {
            const ax = positions[t], ay = positions[t + 1], az = positions[t + 2];
            const bx = positions[t + 3] - ax, by = positions[t + 4] - ay, bz = positions[t + 5] - az;
            const cx = positions[t + 6] - ax, cy = positions[t + 7] - ay, cz = positions[t + 8] - az;
            let nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx = Math.round(nx / len * 127); ny = Math.round(ny / len * 127); nz = Math.round(nz / len * 127);
            for (let v = 0; v < 3; v++) {
                const o = ((t / 3) + v) * 4;
                n[o] = nx; n[o + 1] = ny; n[o + 2] = nz;
            }
        }
        return n;
    }
    function colourAt(g: ReturnType<typeof buildSmoothLandGeometry> & object, v: number) {
        const a = (g.getAttribute('coverColor') as { data: { array: Uint8Array } }).data.array;
        return [a[v * 4], a[v * 4 + 1], a[v * 4 + 2], a[v * 4 + 3]];
    }

    it('keeps colour apart, and the normal shared, where two regions share an edge', () => {
        const t = tile([
            { pts: left, cls: CROP, rgb: [200, 0, 0] },
            { pts: rightSide, cls: FOREST, rgb: [0, 200, 0] },
            { pts: [400, 0, 0, 500, 0, 0, 400, 0, 100], cls: GROUND },
        ]);
        const g = buildSmoothLandGeometry(t.positions, normalsOf(t.positions), t.attrs)!;
        const at = verticesAt(g, 100, 0);
        assert.equal(at.length, 2, 'the shared corner is one vertex per region');
        const cols = at.map(v => colourAt(g, v)).sort((a, b) => a[0] - b[0]);
        assert.deepEqual(cols, [[0, 200, 0, FOREST], [200, 0, 0, CROP]], 'no colour bleeds across');
        const n = (g.getAttribute('normal') as { data: { array: Int8Array } }).data.array;
        const normalAt = (v: number) => [n[v * 4], n[v * 4 + 1], n[v * 4 + 2]];
        assert.deepEqual(normalAt(at[0]), normalAt(at[1]), 'both sides light with the one averaged normal');
        const facets = normalsOf(t.positions);
        assert.notDeepEqual(normalAt(at[0]), [facets[0], facets[1], facets[2]], 'and it is neither facet alone');
    });

    it('welds two facets of one region and averages across the edge', () => {
        const t = tile([
            { pts: left, cls: CROP, rgb: [200, 0, 0] },
            { pts: rightSide, cls: CROP, rgb: [200, 0, 0] },
            { pts: [400, 0, 0, 500, 0, 0, 400, 0, 100], cls: GROUND },
        ]);
        const g = buildSmoothLandGeometry(t.positions, normalsOf(t.positions), t.attrs)!;
        assert.equal(verticesAt(g, 100, 0).length, 1, 'the shared corner is welded');
    });

    it('welds ground of different colours: its colour is meant to blend', () => {
        const t = tile([
            { pts: left, cls: GROUND, rgb: [10, 10, 10] },
            { pts: rightSide, cls: GROUND, rgb: [30, 30, 30] },
            { pts: [400, 0, 0, 500, 0, 0, 400, 0, 100], cls: CROP },
        ]);
        const g = buildSmoothLandGeometry(t.positions, normalsOf(t.positions), t.attrs)!;
        const at = verticesAt(g, 100, 0);
        assert.equal(at.length, 1);
        assert.deepEqual(colourAt(g, at[0]), [20, 20, 20, GROUND]);
    });

    it('on a raster-only tile welds across colour but not across class', () => {
        const t = tile([
            { pts: left, cls: CROP, rgb: [10, 10, 10] },
            { pts: rightSide, cls: CROP, rgb: [30, 30, 30] },
        ]);
        const g = buildSmoothLandGeometry(t.positions, normalsOf(t.positions), t.attrs)!;
        assert.equal(verticesAt(g, 100, 0).length, 1, 'a facet colour is a sample, not a region');
        const u = tile([
            { pts: left, cls: CROP },
            { pts: rightSide, cls: FOREST },
        ]);
        const h = buildSmoothLandGeometry(u.positions, normalsOf(u.positions), u.attrs)!;
        assert.equal(verticesAt(h, 100, 0).length, 2, 'a class edge is a hard edge');
    });
});
