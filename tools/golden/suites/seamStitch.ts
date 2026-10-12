/**
 * Seam stitch fixtures: seamStitch.ts run over real neighbouring Gran Canaria
 * tiles drawn together, the way TerrainEntity.syncGroup calls stitchSeams.
 *
 * Tiles: 11/1870/705 (tiles/ptm, shared with the codec suite) and
 * 12/3742/1411, 12/3743/1411, 11/1871/706 (tiles/seams, copied from
 * assets/terrain). 12/3742/1411 meets 11/1870/705 on its west side and
 * 11/1871/706 on its south side; 12/3743/1411 meets 12/3742/1411 on its west
 * side (a master that itself moved) and 11/1871/706 on its south side.
 *
 * Each tile is built like buildTileMeshes: group at tileOriginWorld under a
 * session basis, rotated by the frame fix from a bake basis elsewhere, scaled
 * by quantScale; faceted land from landGeometryFromArrays over copies of the
 * decoded arrays; the SMOOTH weld for the two z12 tiles. Scenarios run in
 * sequence on the same tiles: everything, the same again (nothing changes),
 * the west z11 master gone (12/3742/1411 springs back, so its east neighbour
 * restitches), the master back, then the south z11 master gone and back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as THREE from 'three';
import { decodePtm, PTM_SIDE_E, PTM_SIDE_N, PTM_SIDE_S, PTM_SIDE_W } from '../../../src/script/terrain/ptm';
import { enuFrameRotation, makeEnuBasis } from '../../../src/script/terrain/geodesy';
import { buildSmoothLandGeometry, landGeometryFromArrays, tileOriginWorld } from '../../../src/script/terrain/tileMesh';
import {
    StitchableTile, masterOf, masterParam, neighbourAcross, SEAM_FILL_MIN_GAP_M, stitchSeams,
} from '../../../src/script/terrain/seamStitch';
import { TileKey, tileKeyString } from '../../../src/script/terrain/tiling';
import { describe, fnv1a32, hex32, SuiteOutput } from '../lib';
import type { SuiteContext } from '../generate';

const TILES: Array<{ file: string; id: TileKey; smooth: boolean }> = [
    { file: 'tiles/ptm/11_1870_705.ptm', id: { z: 11, x: 1870, y: 705 }, smooth: false },
    { file: 'tiles/seams/12_3742_1411.ptm', id: { z: 12, x: 3742, y: 1411 }, smooth: true },
    { file: 'tiles/seams/12_3743_1411.ptm', id: { z: 12, x: 3743, y: 1411 }, smooth: true },
    { file: 'tiles/seams/11_1871_706.ptm', id: { z: 11, x: 1871, y: 706 }, smooth: false },
];

/** Drawn lists per scenario, as indices into TILES, deliberately not in stitch order. */
const SCENARIOS: Array<{ name: string; drawn: number[] }> = [
    { name: 'all', drawn: [2, 3, 1, 0] },
    { name: 'again', drawn: [2, 3, 1, 0] },
    { name: 'westGone', drawn: [1, 3, 2] },
    { name: 'westBack', drawn: [0, 1, 2, 3] },
    { name: 'southGone', drawn: [0, 2, 1] },
    { name: 'southBack', drawn: [3, 0, 2, 1] },
];

const SESSION = { lat: 28.0, lon: -15.6 };
const BAKE = { lat: 27.9, lon: -15.5 };

function hashOf(a: ArrayBufferView): string {
    return hex32(fnv1a32(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)));
}

export function seamStitchSuite(ctx: SuiteContext): SuiteOutput {
    const basis = makeEnuBasis(SESSION.lat, SESSION.lon, 0);
    const frameFix = enuFrameRotation(makeEnuBasis(BAKE.lat, BAKE.lon, 0), basis);
    const tiles = TILES.map(def => {
        const ptm = decodePtm(gunzipSync(fs.readFileSync(path.join(ctx.goldenRoot, def.file))));
        const group = new THREE.Group();
        group.position.copy(tileOriginWorld(ptm.id, ptm.centerHeightM, basis));
        group.quaternion.copy(frameFix);
        group.scale.setScalar(ptm.quantScale);
        group.updateMatrix();
        const positions = ptm.landPositions.slice();
        const normals = ptm.landNormals.slice();
        const attrs = ptm.landAttrs.slice();
        const faceted = landGeometryFromArrays(positions, normals, attrs, ptm.quantScale)!;
        const sizes = (faceted.getAttribute('regionSize') as THREE.BufferAttribute).array as Uint16Array;
        const smooth = def.smooth ? buildSmoothLandGeometry(positions, normals, attrs, sizes) : undefined;
        const land = new THREE.Mesh(faceted, new THREE.MeshBasicMaterial());
        group.add(land);
        const tile: StitchableTile = {
            group, border: ptm.border, land, landGeometryFaceted: faceted, landGeometrySmooth: smooth,
        };
        return {
            def, ptm, tile, positions, smooth,
            input: {
                file: def.file,
                id: def.id,
                position: [group.position.x, group.position.y, group.position.z],
                quaternion: [group.quaternion.x, group.quaternion.y, group.quaternion.z, group.quaternion.w],
                scale: group.scale.x,
                smooth: def.smooth,
                landVertices: positions.length / 3,
                borderVertices: ptm.border?.vertices.length ?? 0,
                borderEdges: (ptm.border?.edges.length ?? 0) / 2,
                bakedPositions: hashOf(positions),
                bakedSmoothPositions: smooth ? hashOf((smooth.getAttribute('position') as THREE.BufferAttribute).array as Int16Array) : null,
                leanedNormals: hashOf(normals),
                regionSizes: hashOf(sizes),
            },
        };
    });

    const scenarios: unknown[] = [];
    for (const sc of SCENARIOS) {
        const drawn = sc.drawn.map(i => ({ id: tiles[i].def.id, tile: tiles[i].tile }));
        const before = tiles.map(t => t.tile.seam?.version);
        // What an upload would do: the renderer clears the ranges it consumed.
        for (const t of tiles) {
            (t.tile.landGeometryFaceted!.getAttribute('position') as THREE.BufferAttribute).clearUpdateRanges();
        }
        const moved = stitchSeams(drawn);
        const out = tiles.map((t, i) => {
            const seam = t.tile.seam;
            const pos = t.positions;
            let offBaked = 0;
            for (let v = 0; v < pos.length; v++) {
                if (pos[v] !== t.ptm.landPositions[v]) offBaked++;
            }
            const attr = t.tile.landGeometryFaceted!.getAttribute('position') as THREE.BufferAttribute;
            const versionChanged = seam === undefined || before[i] === undefined ? null : seam.version !== before[i];
            const range = attr.updateRanges.length > 0 ? attr.updateRanges[0] : undefined;
            const fill = t.tile.seamFill?.geometry;
            return {
                key: tileKeyString(t.def.id),
                drawn: sc.drawn.includes(i),
                masters: seam ? seam.signature.split('|').map(s => s.replace(/@\d+$/, '')) : null,
                versionChanged,
                positionsChanged: range !== undefined,
                dirtyStart: range ? range.start : null,
                dirtyCount: range ? range.count : null,
                positions: hashOf(pos),
                componentsOffBaked: offBaked,
                smoothPositions: t.smooth ? hashOf((t.smooth.getAttribute('position') as THREE.BufferAttribute).array as Int16Array) : null,
                fill: fill ? {
                    vertexCount: (fill.getAttribute('position') as THREE.BufferAttribute).count,
                    positions: describe((fill.getAttribute('position') as THREE.BufferAttribute).array, 9),
                    normals: describe((fill.getAttribute('normal') as THREE.InterleavedBufferAttribute).data.array, 8),
                    attrs: describe((fill.getAttribute('coverColor') as THREE.InterleavedBufferAttribute).data.array, 8),
                    sizes: describe((fill.getAttribute('regionSize') as THREE.BufferAttribute).array, 4),
                } : null,
            };
        });
        scenarios.push({ name: sc.name, drawn: sc.drawn.map(i => tileKeyString(tiles[i].def.id)), moved, tiles: out });
    }

    // The pure helpers, over the same neighbourhood plus the wrap and the pole.
    const keys = new Map(TILES.map(t => [tileKeyString(t.id), t.id]));
    const helperIds: TileKey[] = [...TILES.map(t => t.id), { z: 2, x: 0, y: 0 }, { z: 2, x: 7, y: 3 }];
    const helpers = helperIds.flatMap(id => [PTM_SIDE_W, PTM_SIDE_E, PTM_SIDE_N, PTM_SIDE_S].map(side => {
        const across = neighbourAcross(id, side);
        const m = masterOf(id, side, keys);
        return {
            id, side,
            across: across ?? null,
            master: m ? m.id : null,
            masterParams: m ? [0, 0.25, 0.5, 1].map(p => masterParam(id, side, m.id, p)) : null,
        };
    }));

    return {
        files: [{
            file: 'seam_stitch.json',
            data: {
                source: 'src/script/terrain/seamStitch.ts (stitchSeams, seamFillVertices via the fill mesh, masterOf, masterParam, neighbourAcross)',
                notes: [
                    'Tiles built like buildTileMeshes: group = compose(position, quaternion, scale) with the listed values; faceted land from landGeometryFromArrays over copies of the decoded arrays (normals leaned in place); SMOOTH weld built for tiles with smooth=true before any stitching.',
                    'Scenarios run in order on the same tiles. masters is the seam signature with the version stamps removed; versionChanged is null where the tile had no seam state before the call. positionsChanged/dirtyStart/dirtyCount: the faceted position update range (in components) the call set; ranges are cleared before each call, as an upload would.',
                    'Hashes are FNV-1a over raw little-endian bytes. fill.attrs is the coverColor buffer (rgb + class, stride 4); fill.normals stride 4 with a zero pad byte.',
                ],
                seamFillMinGapM: SEAM_FILL_MIN_GAP_M,
                session: SESSION,
                bake: BAKE,
                tiles: tiles.map(t => t.input),
                scenarios,
                helpers,
            },
        }],
    };
}
