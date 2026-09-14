import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    PTX_NO_DATA, decodePtx, downsample2x2, emptyRaster, encodePtx, isEmptyRaster,
    mergeQuadrant, quadrantOf, rasterizeLeaf,
} from './coverTex';
import { tileBounds } from './meshTile';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from '../../src/script/terrain/geodesy';
import { PtmLandInput, decodePtm, encodePtm } from '../../src/script/terrain/ptm';

const SIZE = 16;
const Z = 12;
// A Gran Canaria leaf, with the bake's frame centred a few km away.
const BASIS = makeEnuBasis(28.0015, -15.3937, 0);
const SPAN = 180 / (1 << Z);
const X = Math.floor((-15.6 + 180) / SPAN);
const Y = Math.floor((90 - 27.95) / SPAN);
const ID = { z: Z, x: X, y: Y };
const BOUNDS = tileBounds(Z, X, Y);
const CENTER_H = 100;

interface Tri {
    /** Three [lon, lat, height] corners. */
    corners: Array<[number, number, number]>;
    cls: number;
    rgb: [number, number, number];
}

/** Tile-local position the way buildTile writes one: global-frame ENU offset from the tile centre, z flipped. */
function local(lon: number, lat: number, h: number): [number, number, number] {
    const c = ecefToEnu(BASIS, geodeticToEcef(
        (BOUNDS.south + BOUNDS.north) / 2, (BOUNDS.west + BOUNDS.east) / 2, CENTER_H,
    ));
    const p = ecefToEnu(BASIS, geodeticToEcef(lat, lon, h));
    return [p.e - c.e, p.u - c.u, c.n - p.n];
}

function leaf(tris: Tri[]) {
    const positions = new Float32Array(tris.length * 9);
    const faceNormals = new Float32Array(tris.length * 3);
    const classes = new Uint8Array(tris.length);
    const colors = new Uint8Array(tris.length * 3);
    tris.forEach((t, i) => {
        t.corners.forEach((c, k) => positions.set(local(c[0], c[1], c[2]), i * 9 + k * 3));
        faceNormals.set([0, 1, 0], i * 3);
        classes[i] = t.cls;
        colors.set(t.rgb, i * 3);
    });
    const land: PtmLandInput = { positions, faceNormals, classes, colors };
    return decodePtm(encodePtm({
        id: ID, centerHeightM: CENTER_H, tileHalfWidthM: 2500, skirtDepthM: 50, geometricErrorM: 1,
        land,
        water: { positions: new Float32Array(0), indices: new Uint32Array(0), tones: new Uint8Array(0) },
    }));
}

/** Fraction of a lon/lat box, as a corner: fx 0 = west, fy 0 = north. */
const at = (fx: number, fy: number, h: number): [number, number, number] => [
    BOUNDS.west + fx * (BOUNDS.east - BOUNDS.west),
    BOUNDS.north - fy * (BOUNDS.north - BOUNDS.south),
    h,
];

function texel(raster: Uint8Array, size: number, x: number, y: number): number[] {
    const o = (y * size + x) * 4;
    return [...raster.subarray(o, o + 4)];
}

/** Two triangles over the whole tile, a hair past its edges so every texel centre is inside. */
function groundQuad(cls: number, rgb: [number, number, number]): Tri[] {
    const m = 0.01;
    return [
        { corners: [at(-m, -m, 100), at(1 + m, -m, 100), at(1 + m, 1 + m, 100)], cls, rgb },
        { corners: [at(-m, -m, 100), at(1 + m, 1 + m, 100), at(-m, 1 + m, 100)], cls, rgb },
    ];
}

describe('rasterizeLeaf', () => {
    it('paints every texel of a tile its ground covers, with the facet word', () => {
        const raster = rasterizeLeaf(leaf(groundQuad(5, [10, 20, 30])), BASIS, SIZE);
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                assert.deepEqual(texel(raster, SIZE, x, y), [10, 20, 30, 5], `texel ${x},${y}`);
            }
        }
    });

    it('lets a lifted fill win its footprint over the ground under it', () => {
        // A fill over the north-west quarter, 5 cm above the ground, emitted
        // after it as buildTile does.
        const fill: Tri = {
            corners: [at(0, 0, 100.05), at(0.5, 0, 100.05), at(0, 0.5, 100.05)],
            cls: 7, rgb: [200, 200, 0],
        };
        const raster = rasterizeLeaf(leaf([...groundQuad(5, [10, 20, 30]), fill]), BASIS, SIZE);
        assert.deepEqual(texel(raster, SIZE, 0, 0), [200, 200, 0, 7]);
        assert.deepEqual(texel(raster, SIZE, SIZE - 1, SIZE - 1), [10, 20, 30, 5]);
        // The fill's hypotenuse runs from (0.5, 0) to (0, 0.5): the south-east
        // half of the quarter stays ground.
        assert.deepEqual(texel(raster, SIZE, SIZE / 2 - 1, SIZE / 2 - 1), [10, 20, 30, 5]);
    });

    it('leaves a texel no-data where nothing is drawn, and skips vertical walls', () => {
        // One ground triangle over the north-west half; a skirt hanging from
        // the tile's west edge, 50 m straight down.
        const tris: Tri[] = [
            { corners: [at(-0.01, -0.01, 100), at(1.01, -0.01, 100), at(-0.01, 1.01, 100)], cls: 5, rgb: [1, 2, 3] },
            { corners: [at(0, 0, 100), at(0, 1, 100), at(0, 1, 50)], cls: 9, rgb: [9, 9, 9] },
            { corners: [at(0, 0, 100), at(0, 1, 50), at(0, 0, 50)], cls: 9, rgb: [9, 9, 9] },
        ];
        const raster = rasterizeLeaf(leaf(tris), BASIS, SIZE);
        assert.deepEqual(texel(raster, SIZE, 0, 0), [1, 2, 3, 5]);
        assert.equal(texel(raster, SIZE, SIZE - 1, SIZE - 1)[3], PTX_NO_DATA);
        for (let y = 0; y < SIZE; y++) {
            assert.notEqual(texel(raster, SIZE, 0, y)[3], 9, `wall painted at row ${y}`);
        }
    });
});

describe('downsample2x2', () => {
    it('averages colour and takes the majority class of the data texels', () => {
        const src = emptyRaster(2);
        src.set([10, 20, 30, 5], 0);
        src.set([20, 40, 60, 5], 4);
        src.set([30, 60, 90, 7], 8);
        // Fourth texel stays no-data and must not dilute the mean.
        const out = downsample2x2(src, 2);
        assert.deepEqual([...out], [20, 40, 60, 5]);
    });

    it('breaks a class tie toward the first texel in row order', () => {
        const src = emptyRaster(2);
        src.set([0, 0, 0, 7], 0);
        src.set([0, 0, 0, 5], 4);
        assert.equal(downsample2x2(src, 2)[3], 7);
    });

    it('propagates no-data only when the whole block is', () => {
        const src = emptyRaster(4);
        src.set([1, 1, 1, 2], 0);
        const out = downsample2x2(src, 4);
        assert.deepEqual(texel(out, 2, 0, 0), [1, 1, 1, 2]);
        assert.equal(texel(out, 2, 1, 1)[3], PTX_NO_DATA);
        assert.equal(isEmptyRaster(out), false);
        assert.equal(isEmptyRaster(emptyRaster(4)), true);
    });

    it('is exactly what a parent quadrant gets from its child', () => {
        const child = rasterizeLeaf(leaf(groundQuad(3, [50, 60, 70])), BASIS, SIZE);
        const parent = emptyRaster(SIZE);
        const { qx, qy } = quadrantOf(ID);
        mergeQuadrant(parent, SIZE, downsample2x2(child, SIZE), qx, qy);
        const half = SIZE / 2;
        for (let y = 0; y < SIZE; y++) {
            for (let x = 0; x < SIZE; x++) {
                const inside = x >= qx * half && x < (qx + 1) * half && y >= qy * half && y < (qy + 1) * half;
                const t = texel(parent, SIZE, x, y);
                if (inside) {
                    assert.deepEqual(t, [50, 60, 70, 3], `quadrant texel ${x},${y}`);
                } else {
                    assert.equal(t[3], PTX_NO_DATA, `outside texel ${x},${y}`);
                }
            }
        }
    });
});

describe('quadrantOf', () => {
    it('reads the low bit of each coordinate', () => {
        assert.deepEqual(quadrantOf({ z: 3, x: 4, y: 6 }), { qx: 0, qy: 0 });
        assert.deepEqual(quadrantOf({ z: 3, x: 5, y: 7 }), { qx: 1, qy: 1 });
        assert.deepEqual(quadrantOf({ z: 3, x: 5, y: 6 }), { qx: 1, qy: 0 });
    });
});

describe('PTX1', () => {
    it('round-trips a raster through the header', () => {
        const texels = emptyRaster(4);
        texels.set([1, 2, 3, 4], 20);
        const bytes = encodePtx({ z: 9, x: 300, y: 140 }, 4, texels);
        const back = decodePtx(bytes);
        assert.deepEqual(back.id, { z: 9, x: 300, y: 140 });
        assert.equal(back.size, 4);
        assert.deepEqual([...back.texels], [...texels]);
    });

    it('rejects a raster that does not match its size', () => {
        assert.throws(() => encodePtx({ z: 1, x: 1, y: 1 }, 4, new Uint8Array(3)));
    });

    it('rejects foreign or truncated bytes', () => {
        assert.throws(() => decodePtx(new Uint8Array(8)));
        const bytes = encodePtx({ z: 1, x: 1, y: 1 }, 2, emptyRaster(2));
        bytes[0] = 0;
        assert.throws(() => decodePtx(bytes), /magic/);
        assert.throws(() => decodePtx(encodePtx({ z: 1, x: 1, y: 1 }, 2, emptyRaster(2)).subarray(0, 20)));
    });
});

describe('shrinkTo', () => {
    it('halves repeatedly down to the target and refuses to grow', async () => {
        const { shrinkTo } = await import('./coverTex');
        const src = emptyRaster(8);
        for (let i = 0; i < 8 * 8; i++) {
            src.set([i, 2 * i, 3 * i, 5], i * 4);
        }
        assert.equal(shrinkTo(src, 8, 8), src);
        const two = shrinkTo(src, 8, 2);
        assert.equal(two.byteLength, 2 * 2 * 4);
        assert.equal(two[3], 5);
        assert.throws(() => shrinkTo(src, 8, 16), /grow/);
    });
});
