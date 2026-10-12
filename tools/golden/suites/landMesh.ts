/**
 * Land mesh fixtures: the per-tile land preparation in tileMesh.ts that the
 * Unity port runs before upload - leanEdgeNormals (in place), regionSizes
 * (land-use region widths) and buildSmoothLandGeometry (the SMOOTH weld).
 *
 * Inputs are the checked-in .ptm tiles under tests/golden/tiles/ptm, decoded
 * with decodePtm. Each step runs the way landGeometryFromArrays chains them:
 * lean a copy of the normals, size the regions, then weld over the leaned
 * normals and the sizes. Outputs are recorded as `{type, length, fnv1a32,
 * head}` (see lib.describe); the indices are widened to Uint32 first so the
 * hash does not depend on which index width three.js would pick.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { decodePtm } from '../../../src/script/terrain/ptm';
import { buildSmoothLandGeometry, leanEdgeNormals, regionSizes } from '../../../src/script/terrain/tileMesh';
import { describe, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

const GROUND_CLASS = 13;

export function landMeshSuite(ctx: SuiteContext): SuiteOutput {
    const dir = path.join(ctx.goldenRoot, 'tiles', 'ptm');
    const names = fs.readdirSync(dir).filter(f => f.endsWith('.ptm')).sort();
    const tiles: unknown[] = [];
    for (const name of names) {
        const tile = decodePtm(gunzipSync(fs.readFileSync(path.join(dir, name))));
        const vertexCount = tile.landPositions.length / 3;
        if (vertexCount === 0) continue;
        const positions = tile.landPositions.slice();
        const attrs = tile.landAttrs.slice();
        const normals = tile.landNormals.slice();
        let groundVertices = 0;
        for (let i = 3; i < attrs.length; i += 4) {
            if (attrs[i] === GROUND_CLASS) groundVertices++;
        }

        leanEdgeNormals(positions, normals);
        const sizes = regionSizes(positions, attrs, tile.quantScale);
        const g = buildSmoothLandGeometry(positions, normals, attrs, sizes)!;
        const pos = g.getAttribute('position') as THREE.BufferAttribute;
        const nrm = g.getAttribute('normal') as THREE.InterleavedBufferAttribute;
        const col = g.getAttribute('coverColor') as THREE.InterleavedBufferAttribute;
        const size = g.getAttribute('regionSize') as THREE.BufferAttribute;
        const index = Uint32Array.from(g.getIndex()!.array as ArrayLike<number>);
        let nonZeroSizes = 0;
        for (let i = 0; i < sizes.length; i++) {
            if (sizes[i] !== 0) nonZeroSizes++;
        }

        tiles.push({
            file: `tiles/ptm/${name}`,
            quantScale: tile.quantScale,
            vertexCount,
            groundVertices,
            inputPositions: describe(tile.landPositions),
            inputNormals: describe(tile.landNormals),
            inputAttrs: describe(tile.landAttrs),
            leanedNormals: describe(normals, 8),
            regionSizes: describe(sizes, 12),
            nonZeroSizes,
            smooth: {
                vertexCount: pos.count,
                indexCount: index.length,
                positions: describe(pos.array, 9),
                normals: describe(nrm.data.array, 8),
                attrs: describe(col.data.array, 8),
                sizes: describe(size.array, 8),
                indices: describe(index, 12),
            },
        });
    }
    return {
        files: [{
            file: 'land_mesh.json',
            data: {
                source: 'src/script/terrain/tileMesh.ts (leanEdgeNormals, regionSizes, buildSmoothLandGeometry)',
                notes: [
                    'Per checked-in .ptm with land: lean a copy of landNormals, regionSizes over the land soup, then the smooth weld over the leaned normals with those sizes.',
                    'Hashes are FNV-1a over raw little-endian bytes; smooth.indices are widened to Uint32 before hashing.',
                ],
                tiles,
            },
        }],
    };
}
