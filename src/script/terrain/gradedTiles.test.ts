import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    PTM_FLAG_GRADED, PTM_SIDE_E, PTM_SIDE_N, PtmEncodeInput, decodePtm, encodePtm, isPtmGraded, packBorderEntry, writePtmLand,
} from './ptm';
import { PTR_TILE_GRADED, decodePtr, encodePtr, encodePtrRaw } from './ptr';
import { decodePbd, encodePbd, simplifyBeds } from './pbd';
import { BED_OPEN_A, BED_OPEN_B, RAIL_BED_SEGMENT_FLOATS } from './railBed';
import { TerrainClass, TerrainTone } from './tones';

function tile(): PtmEncodeInput {
    const tri = (ox: number) => [ox, 10, 0, ox + 100, 20, 0, ox, 30, 100];
    return {
        id: { z: 12, x: 4348, y: 966 },
        centerHeightM: 700,
        tileHalfWidthM: 2200,
        skirtDepthM: 7.25,
        skirtSeamFactor: 5,
        geometricErrorM: 12.5,
        land: {
            positions: new Float32Array([...tri(0), ...tri(200)]),
            faceNormals: new Float32Array([0, 1, 0, 0.6, 0.8, 0]),
            classes: new Uint8Array([TerrainClass.Tree, TerrainClass.Sand]),
            colors: new Uint8Array([10, 90, 20, 220, 200, 150]),
        },
        water: {
            positions: new Float32Array([-100, -1, -100, 100, -1, -100, -100, -1, 100]),
            indices: new Uint32Array([0, 1, 2]),
            tones: new Uint8Array([TerrainTone.Water]),
        },
        border: {
            vertices: new Uint32Array([packBorderEntry(PTM_SIDE_N, 0), packBorderEntry(PTM_SIDE_E, 4)]),
            vertexParams: new Float32Array([0, 0.75]),
            edges: new Uint32Array([packBorderEntry(PTM_SIDE_N, 0), packBorderEntry(PTM_SIDE_N, 1)]),
            edgeParams: new Float32Array([0, 0.5]),
        },
    };
}

describe('graded tiles', () => {
    it('splices new land into a .ptm and keeps everything else', () => {
        const bytes = encodePtm(tile());
        const old = decodePtm(bytes);
        // The old land with one vertex lifted and one triangle appended.
        const positions = new Int16Array([...old.landPositions, 10, 20, 30, 40, 50, 60, 70, 80, 9000]);
        positions[4] += 50;
        const normals = new Int8Array([...old.landNormals, 0, 127, 0, 5, 0, 127, 0, 6, 0, 127, 0, 7]);
        const attrs = new Uint8Array([...old.landAttrs, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4]);
        const out = writePtmLand(bytes, { positions, normals, attrs });
        const t = decodePtm(out);
        assert.deepEqual([...t.landPositions], [...positions]);
        assert.deepEqual([...t.landNormals], [...normals]);
        assert.deepEqual([...t.landAttrs], [...attrs]);
        assert.ok(isPtmGraded(t));
        assert.equal(t.flags & ~PTM_FLAG_GRADED, old.flags);
        assert.deepEqual([...t.waterPositions], [...old.waterPositions]);
        assert.deepEqual([...t.border!.vertices], [...old.border!.vertices]);
        assert.deepEqual([...t.border!.edgeParams], [...old.border!.edgeParams]);
        assert.equal(t.geometricErrorM, old.geometricErrorM);
        assert.equal(t.skirtDepthM, old.skirtDepthM);
        // Header word 52 (skirtSeamFactor) is not decoded; it rides along byte for byte.
        assert.equal(new DataView(out.buffer).getUint32(52, true), new DataView(bytes.buffer).getUint32(52, true));
        // The appended vertex at 9000 quanta is past the old bound.
        assert.ok(t.boundingRadiusM >= 9000 * t.quantScale - 1e-3);
        assert.throws(() => writePtmLand(bytes, { positions: positions.slice(0, 9), normals: normals.slice(0, 12), attrs: attrs.slice(0, 12) }), /fewer vertices/);
    });

    it('writes a decoded .ptr back byte for byte, with its tile flags', () => {
        const bytes = encodePtr({
            id: { z: 12, x: 1, y: 2 }, quantScale: 0.08,
            positions: new Float32Array([0, 0, 0, 0, 0, 0, 10, 1, 0, 10, 1, 0]),
            directions: new Float32Array([0, 0, 1, 0, 0, -1, 0, 0, 1, 0, 0, -1]),
            halfWidthsM: new Float32Array([3, 3, 3, 3]),
            classes: new Uint8Array([7, 7 | 0x40, 7, 7 | 0x40]),
            alongM: new Float32Array([0, 0, 10, 10]),
            flags: new Uint8Array([1, 1, 8, 8]),
            indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
        });
        const t = decodePtr(bytes);
        assert.equal(t.tileFlags, 0);
        assert.deepEqual([...encodePtrRaw(t)], [...bytes]);
        const graded = decodePtr(encodePtrRaw(t, PTR_TILE_GRADED));
        assert.equal(graded.tileFlags, PTR_TILE_GRADED);
        assert.deepEqual([...graded.positions], [...t.positions]);
    });

    it('round-trips beds and walls through PBD1 to its quantisation', () => {
        const q = 0.08;
        const beds = Float64Array.from([10, 20, 30, 50, 22, 31, 3.5, 2.25, BED_OPEN_A, 0, 18.5]);
        const walls = { positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 3, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
        const t = decodePbd(encodePbd({ id: { z: 12, x: 3, y: 4 }, quantScale: q, beds, walls }));
        assert.deepEqual(t.id, { z: 12, x: 3, y: 4 });
        for (let k = 0; k < 6; k++) {
            assert.ok(Math.abs(t.beds[k] - beds[k]) <= q / 2 + 1e-9, `coordinate ${k}`);
        }
        assert.deepEqual([...t.beds.slice(6)], [3.5, 2.25, BED_OPEN_A, 0, 18.5]);
        assert.ok(Math.abs(t.walls!.positions[3] - 4) <= q / 2 + 1e-9);
        assert.deepEqual([...t.walls!.indices], [0, 1, 2]);
        assert.ok(Math.abs(t.walls!.normals[2] - 1) < 1e-9);
    });

    it('merges a straight run of beds and keeps the bends, open ends and widest batter', () => {
        const F = RAIL_BED_SEGMENT_FLOATS;
        const seg = (ax: number, ay: number, bx: number, by: number, open = 0, reach = 10, lift = 1) =>
            [ax, ay, 0, bx, by, 0, 3, lift, open, 1, reach];
        // A straight 3-segment run, then a bend, then an open end.
        const beds = Float64Array.from([
            ...seg(0, 0, 5, 0, BED_OPEN_A), ...seg(5, 0, 10, 0, 0, 14, 2), ...seg(10, 0, 15, 0),
            ...seg(15, 0, 20, 5), ...seg(20, 5, 25, 10, BED_OPEN_B),
        ]);
        const s = simplifyBeds(beds);
        assert.equal(s.length / F, 2);
        assert.deepEqual([...s.slice(0, F)], [0, 0, 0, 15, 0, 0, 3, 2, BED_OPEN_A, 1, 14]);
        assert.deepEqual([...s.slice(F, 2 * F)], [15, 0, 0, 25, 10, 0, 3, 1, BED_OPEN_B, 1, 10]);
        // An open end inside a run is never merged across.
        const split = simplifyBeds(Float64Array.from([...seg(0, 0, 5, 0, BED_OPEN_B), ...seg(5, 0, 10, 0)]));
        assert.equal(split.length / F, 2);
    });
});
