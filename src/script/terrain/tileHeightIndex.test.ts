import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { TileHeightIndex } from './tileHeightIndex';

/**
 * A tile the way buildTileMeshes makes one: non-indexed land triangles in
 * quantised local units, under a group carrying the origin and quant scale.
 */
function tile(
    triangles: number[][],
    opts: { origin?: THREE.Vector3; scale?: number; quaternion?: THREE.Quaternion } = {},
): { mesh: THREE.Mesh; group: THREE.Object3D } {
    const positions = new Int16Array(triangles.flat());
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const group = new THREE.Object3D();
    group.position.copy(opts.origin ?? new THREE.Vector3());
    group.scale.setScalar(opts.scale ?? 1);
    if (opts.quaternion) {
        group.quaternion.copy(opts.quaternion);
    }
    return { mesh: new THREE.Mesh(geometry), group };
}

/** A flat-ish grid: `size` x `size` quads, height from `h(ix, iz)`. */
function grid(size: number, step: number, h: (ix: number, iz: number) => number): number[][] {
    const out: number[][] = [];
    for (let iz = 0; iz < size; iz++) {
        for (let ix = 0; ix < size; ix++) {
            const x0 = ix * step, x1 = (ix + 1) * step;
            const z0 = iz * step, z1 = (iz + 1) * step;
            const y00 = h(ix, iz), y10 = h(ix + 1, iz);
            const y01 = h(ix, iz + 1), y11 = h(ix + 1, iz + 1);
            out.push([x0, y00, z0, x1, y10, z0, x0, y01, z1]);
            out.push([x1, y10, z0, x1, y11, z1, x0, y01, z1]);
        }
    }
    return out;
}

describe('TileHeightIndex', () => {

    it('interpolates height across a triangle', () => {
        // A single triangle rising 10 units over 100 along +x.
        const { mesh, group } = tile([[0, 0, 0, 100, 10, 0, 0, 0, 100]]);
        const index = new TileHeightIndex(mesh, group);
        assert.equal(index.heightAtWorld(0, 0), 0);
        assert.equal(index.heightAtWorld(100, 0), 10);
        assert.ok(Math.abs(index.heightAtWorld(50, 0)! - 5) < 1e-6);
        assert.ok(Math.abs(index.heightAtWorld(20, 20)! - 2) < 1e-6);
    });

    it('reads the landcover class of the facet under a point', () => {
        // Two triangles of one quad, each its own class: the bake stamps the
        // class on every vertex of a facet, so a per-vertex read is per-facet.
        const { mesh, group } = tile([
            [0, 0, 0, 100, 0, 0, 0, 0, 100],
            [100, 0, 0, 100, 0, 100, 0, 0, 100],
        ]);
        // Laid out the way buildTileMeshes does: rgb + class in one
        // interleaved byte buffer, the colour view normalised, the class not.
        const attrs = new THREE.InterleavedBuffer(new Uint8Array([
            0x80, 0x70, 0x50, 6, 0x80, 0x70, 0x50, 6, 0x80, 0x70, 0x50, 6,
            0x20, 0x90, 0x30, 3, 0x20, 0x90, 0x30, 3, 0x20, 0x90, 0x30, 3,
        ]), 4);
        mesh.geometry.setAttribute('coverColor', new THREE.InterleavedBufferAttribute(attrs, 3, 0, true));
        mesh.geometry.setAttribute('coverClass', new THREE.InterleavedBufferAttribute(attrs, 1, 3, false));
        const index = new TileHeightIndex(mesh, group, 11);
        assert.deepEqual(index.coverAtWorld(20, 20), { cls: 6, rgb: 0x807050, zoom: 11 });
        assert.deepEqual(index.coverAtWorld(80, 80), { cls: 3, rgb: 0x209030, zoom: 11 });
        assert.equal(index.coverAtWorld(-10, 0), undefined, 'off the tile');
    });

    it('has no cover to give on a mesh without any', () => {
        const { mesh, group } = tile([[0, 0, 0, 100, 10, 0, 0, 0, 100]]);
        const index = new TileHeightIndex(mesh, group);
        assert.equal(index.coverAtWorld(20, 20), undefined);
        assert.equal(index.heightAtWorld(20, 20), 2, 'height still reads');
    });

    it('returns undefined outside the tile', () => {
        const { mesh, group } = tile([[0, 0, 0, 100, 10, 0, 0, 0, 100]]);
        const index = new TileHeightIndex(mesh, group);
        assert.equal(index.heightAtWorld(-10, 0), undefined, 'left of the tile');
        assert.equal(index.heightAtWorld(90, 90), undefined, 'past the hypotenuse');
    });

    it('applies the tile origin and quantisation scale', () => {
        const { mesh, group } = tile(
            [[0, 0, 0, 100, 10, 0, 0, 0, 100]],
            { origin: new THREE.Vector3(1000, 200, -500), scale: 2 },
        );
        const index = new TileHeightIndex(mesh, group);
        // Local (100, 10, 0) -> world (1000 + 200, 200 + 20, -500).
        assert.ok(Math.abs(index.heightAtWorld(1200, -500)! - 220) < 1e-6);
        assert.ok(Math.abs(index.heightAtWorld(1100, -500)! - 210) < 1e-6);
    });

    it('survives a bake-frame rotation', () => {
        const q = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), 0.004);
        const { mesh, group } = tile([[0, 0, 0, 100, 10, 0, 0, 0, 100]], { quaternion: q });
        const index = new TileHeightIndex(mesh, group);
        // Ask at the rotated position of local (50, 5, 0).
        const p = new THREE.Vector3(50, 5, 0).applyQuaternion(q);
        assert.ok(Math.abs(index.heightAtWorld(p.x, p.z)! - p.y) < 1e-4);
    });

    it('finds the right cell across a bucketed grid', () => {
        // 16x16 quads = 512 triangles, so the bucket grid is really used.
        const h = (ix: number, iz: number) => ix * 3 + iz * 5;
        const { mesh, group } = tile(grid(16, 10, h));
        const index = new TileHeightIndex(mesh, group);
        for (let iz = 0; iz <= 16; iz++) {
            for (let ix = 0; ix <= 16; ix++) {
                const y = index.heightAtWorld(ix * 10, iz * 10);
                assert.ok(y !== undefined, `no hit at grid post (${ix}, ${iz})`);
                assert.ok(Math.abs(y - h(ix, iz)) < 1e-4,
                    `post (${ix}, ${iz}): expected ${h(ix, iz)}, got ${y}`);
            }
        }
    });

    it('takes the top surface where a skirt overlaps the rim', () => {
        // A rim triangle at y=50 and the vertical skirt hanging off it. The
        // skirt has no plan-view area, so it must never win.
        const { mesh, group } = tile([
            [0, 50, 0, 100, 50, 0, 0, 50, 100],
            [0, 50, 0, 100, 50, 0, 0, -50, 0],
        ]);
        const index = new TileHeightIndex(mesh, group);
        assert.equal(index.heightAtWorld(10, 10), 50);
    });

    it('reads the ridge a coarser sampler would flatten', () => {
        // The point of the whole class: a crest between two samples 40 apart.
        const { mesh, group } = tile(grid(4, 20, (ix) => (ix === 2 ? 30 : 0)));
        const index = new TileHeightIndex(mesh, group);
        assert.equal(index.heightAtWorld(40, 10), 30, 'crest post');
        const bilinearOf40Spacing = 0;   // posts at x=0 and x=80 are both 0
        assert.ok(index.heightAtWorld(40, 10)! > bilinearOf40Spacing);
    });
});
