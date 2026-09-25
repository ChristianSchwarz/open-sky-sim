import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { CoverTextures, buildCoverMips, coverFrame, coverTextureBytes } from './coverTextures';
import { ecefToEnu, geodeticToEcef, makeEnuBasis } from './geodesy';
import { TerrainManifest } from './manifest';
import { PTX_NO_DATA } from './ptx';
import { TileMeshes } from './tileMesh';
import { TileKey, tileBounds } from './tiling';

describe('buildCoverMips', () => {
    it('runs from the raster itself down to one texel', () => {
        const size = 8;
        const texels = new Uint8Array(size * size * 4);
        const mips = buildCoverMips(texels, size);
        assert.deepEqual(mips.map(m => m.width), [8, 4, 2, 1]);
        assert.equal(mips[0].data, texels);
    });

    it('averages colour over data texels and takes the first data class', () => {
        const src = new Uint8Array(2 * 2 * 4).fill(0);
        src.set([0, 0, 0, PTX_NO_DATA], 0);   // (0,0) empty
        src.set([10, 20, 30, 7], 4);           // (1,0)
        src.set([30, 40, 50, 5], 8);           // (0,1)
        src.set([0, 0, 0, PTX_NO_DATA], 12);  // (1,1) empty
        const mips = buildCoverMips(src, 2);
        assert.deepEqual([...mips[1].data], [20, 30, 40, 7]);
    });

    it('keeps a block with no data as no data', () => {
        const src = new Uint8Array(2 * 2 * 4);
        for (let i = 3; i < src.length; i += 4) {
            src[i] = PTX_NO_DATA;
        }
        assert.equal(buildCoverMips(src, 2)[1].data[3], PTX_NO_DATA);
    });

    it('charges a third over the base level for the chain', () => {
        assert.equal(coverTextureBytes(256), Math.ceil(256 * 256 * 4 * 4 / 3));
    });
});

describe('CoverTextures.attach', () => {
    const manifest = {
        enuOrigin: { lat: 28, lon: -15.4, height: 0 },
        mesh: { maxZoom: 12 },
        texture: { path: '{z}/{x}/{y}.ptx', indexPath: 'index_tex.bin', encoding: 'PTX1', size: 4, minZoom: 6, maxZoom: 11 },
    } as unknown as TerrainManifest;
    const basis = makeEnuBasis(28, -15.4, 0);
    const meshes = (): TileMeshes => ({
        group: new THREE.Group(), land: new THREE.Mesh(), bytes: 0, geometricErrorM: 0,
    });
    const coarse: TileKey = { z: 9, x: 467, y: 176 };

    it('marks a leaf, and anything outside the baked zoom range, as having no texture', () => {
        const cover = new CoverTextures({ manifest, baseUrl: '.', bakeBasis: basis });
        const leaf = meshes();
        cover.attach({ z: 12, x: 3740, y: 1412 }, leaf, 1);
        assert.equal(leaf.cover, 'none');
        const tooCoarse = meshes();
        cover.attach({ z: 5, x: 29, y: 11 }, tooCoarse, 1);
        assert.equal(tooCoarse.cover, 'none');
    });

    it('asks for a coarse tile in range, and not while switched off', () => {
        const cover = new CoverTextures({ manifest, baseUrl: '.', bakeBasis: basis });
        cover.setEnabled(false);
        const off = meshes();
        cover.attach(coarse, off, 1);
        assert.equal(off.cover, undefined, 'switched off: not even asked for');
        cover.setEnabled(true);
        cover.attach(coarse, off, 1);
        assert.equal(off.cover, 'pending', 'switched on: the same tile is asked for');
    });

    it('does nothing for a pyramid without textures', () => {
        const cover = new CoverTextures({ manifest: { ...manifest, texture: undefined }, baseUrl: '.', bakeBasis: basis });
        assert.equal(cover.enabled, false);
        const m = meshes();
        cover.attach(coarse, m, 1);
        assert.equal(m.cover, undefined);
    });
});

describe('coverFrame', () => {
    const BASIS = makeEnuBasis(28.0015, -15.3937, 0);
    const QUANT = 0.25;

    /** A vertex position the way a tile stores it: quantised bake-frame offset from the tile centre. */
    function positionOf(id: TileKey, lat: number, lon: number, height = 0): THREE.Vector3 {
        const b = tileBounds(id);
        const c = ecefToEnu(BASIS, geodeticToEcef((b.south + b.north) / 2, (b.west + b.east) / 2, 0));
        const p = ecefToEnu(BASIS, geodeticToEcef(lat, lon, height));
        return new THREE.Vector3((p.e - c.e) / QUANT, (p.u - c.u) / QUANT, (c.n - p.n) / QUANT);
    }

    /** What the vertex program computes from the frame. */
    function uvOf(frame: ReturnType<typeof coverFrame>, position: THREE.Vector3): [number, number] {
        const e = position.dot(frame.east);
        const n = position.dot(frame.north);
        return [0.5 + e / (1 - frame.k * n), 0.5 - n];
    }

    it('maps the tile corners to the texture corners, row 0 north', () => {
        const id: TileKey = { z: 9, x: 467, y: 176 }; // Gran Canaria, near the frame origin
        const b = tileBounds(id);
        const frame = coverFrame(id, BASIS, QUANT);
        const ne = uvOf(frame, positionOf(id, b.north, b.east));
        const sw = uvOf(frame, positionOf(id, b.south, b.west));
        assert.ok(Math.abs(ne[0] - 1) < 2e-3 && Math.abs(ne[1] - 0) < 2e-3, `NE -> ${ne}`);
        assert.ok(Math.abs(sw[0] - 0) < 2e-3 && Math.abs(sw[1] - 1) < 2e-3, `SW -> ${sw}`);
    });

    it('holds for a coarse tile far from the frame origin, where its axes are not local ENU', () => {
        // Berlin-ish z7 tile, 3400 km from the Canaries frame: the bake frame's
        // x is nowhere near local east here, and the tile is 1.4 degrees tall.
        const id: TileKey = { z: 7, x: 137, y: 27 };
        const b = tileBounds(id);
        const frame = coverFrame(id, BASIS, QUANT);
        for (const [lat, lon, u, v] of [
            [b.north, b.east, 1, 0], [b.south, b.west, 0, 1], [b.north, b.west, 0, 0], [b.south, b.east, 1, 1],
            [(b.north + b.south) / 2, (b.east + b.west) / 2, 0.5, 0.5],
        ] as const) {
            const uv = uvOf(frame, positionOf(id, lat, lon, 500));
            assert.ok(Math.abs(uv[0] - u) < 5e-3 && Math.abs(uv[1] - v) < 5e-3, `(${lat},${lon}) -> ${uv}, want ${u},${v}`);
        }
    });

    it('narrows the lon span toward the pole in the northern hemisphere', () => {
        const frame = coverFrame({ z: 7, x: 137, y: 27 }, BASIS, QUANT);
        assert.ok(frame.k > 0, `k = ${frame.k}`);
    });
});
