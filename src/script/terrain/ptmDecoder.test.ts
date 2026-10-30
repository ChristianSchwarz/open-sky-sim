import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { regionSizes } from './landPrep';
import { PTM_SIDE_N, PtmEncodeInput, decodePtm, encodePtm, packBorderEntry } from './ptm';
import { PtmDecoder, tileBuffers } from './ptmDecoder';
import { TerrainClass, TerrainTone } from './tones';

function input(): PtmEncodeInput {
    const tri = (ox: number) => [ox, 10, 0, ox + 100, 20, 0, ox, 30, 100];
    return {
        id: { z: 12, x: 1, y: 2 },
        centerHeightM: 100,
        tileHalfWidthM: 2200,
        skirtDepthM: 5,
        geometricErrorM: 10,
        land: {
            positions: new Float32Array([...tri(0), ...tri(100), ...tri(300)]),
            faceNormals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
            // The ground triangle marks it a land-use tile (raster-only tiles have no widths).
            classes: new Uint8Array([TerrainClass.Tree, TerrainClass.Tree, TerrainClass.Ground]),
            colors: new Uint8Array([10, 90, 20, 10, 90, 20, 50, 60, 40]),
        },
        water: {
            positions: new Float32Array([-100, -1, -100, 100, -1, -100, -100, -1, 100]),
            indices: new Uint32Array([0, 1, 2]),
            tones: new Uint8Array([TerrainTone.Water]),
        },
        border: {
            vertices: new Uint32Array([packBorderEntry(PTM_SIDE_N, 0)]),
            vertexParams: new Float32Array([0]),
            edges: new Uint32Array([packBorderEntry(PTM_SIDE_N, 0), packBorderEntry(PTM_SIDE_N, 1)]),
            edgeParams: new Float32Array([0, 0.5]),
        },
    };
}

/** encodePtm's bytes as a buffer of their own, as a fetch hands them over. */
function bytes(): ArrayBuffer {
    const b = encodePtm(input());
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe('PtmDecoder', () => {
    it('decodes in place without workers and sets the region widths', async () => {
        const tile = await new PtmDecoder().decode(bytes());
        const plain = decodePtm(bytes());
        assert.ok(tile.landRegionSizes);
        assert.deepEqual([...tile.landRegionSizes], [...regionSizes(plain.landPositions, plain.landAttrs, plain.quantScale)]);
        assert.ok(tile.landRegionSizes.some(s => s > 0), 'the tree patch has a width');
    });

    it('lists every buffer under the tile once, the border\'s too', () => {
        const tile = decodePtm(bytes());
        const buffers = tileBuffers(tile);
        assert.equal(new Set(buffers).size, buffers.length);
        for (const a of [tile.landPositions, tile.waterIndices, tile.riverPositions, tile.border!.edges]) {
            assert.ok(buffers.includes(a.buffer as ArrayBuffer));
        }
    });
});
