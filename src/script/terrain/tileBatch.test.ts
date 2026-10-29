import assert from 'node:assert/strict';
import * as THREE from 'three';
import { describe, it } from 'node:test';
import { RangeAllocator, TileBatch, TileBatcher } from './tileBatch';

describe('RangeAllocator', () => {
    it('allocates first fit and merges freed neighbours back into one run', () => {
        const a = new RangeAllocator(100);
        assert.equal(a.alloc(30), 0);
        assert.equal(a.alloc(30), 30);
        assert.equal(a.alloc(30), 60);
        assert.equal(a.alloc(30), -1);
        a.release(30, 30);
        a.release(0, 30);
        assert.equal(a.freeUnits, 70);
        // 0..60 is one run again: 50 fits at the start.
        assert.equal(a.alloc(50), 0);
        a.release(0, 50);
        a.release(60, 30);
        assert.equal(a.alloc(100), 0, 'every run merged');
    });

    it('grows with the new tail free, merged with a free run before it', () => {
        const a = new RangeAllocator(10);
        assert.equal(a.alloc(8), 0);
        a.grow(20);
        assert.equal(a.alloc(12), 8);
        assert.equal(a.freeUnits, 0);
    });
});

/** A tile mesh: `n` vertices, a position and a byte attribute, and an index. */
function tileMesh(material: THREE.Material, n: number, index: number[], seed = 1): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    const pos = new Int16Array(n * 3);
    for (let i = 0; i < pos.length; i++) {
        pos[i] = seed * 100 + i;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('secondTone', new THREE.BufferAttribute(new Uint8Array(n).fill(seed), 1));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(index), 1));
    return new THREE.Mesh(g, material);
}

function arenaOf(batch: TileBatch): THREE.BufferGeometry {
    return batch.mesh.geometry;
}

function drawsOf(batch: TileBatch): Array<[number, number]> {
    const m = batch.mesh as unknown as { _multiDrawStarts: Int32Array; _multiDrawCounts: Int32Array };
    return Array.from({ length: batch.draws }, (_, i) => [m._multiDrawStarts[i] / 4, m._multiDrawCounts[i]]);
}

describe('TileBatch', () => {
    const material = () => new THREE.ShaderMaterial({ uniforms: { color: { value: 1 } } });

    it('copies each mesh once and rebases its indices into the arena', () => {
        const batch = new TileBatch(material(), 0);
        const a = tileMesh(batch.source, 4, [0, 1, 2, 2, 3, 0], 1);
        const b = tileMesh(batch.source, 3, [0, 1, 2], 2);
        batch.begin();
        assert.ok(batch.add(a, 0, 6));
        assert.ok(batch.add(b, 0, 3));
        const arena = arenaOf(batch);
        const index = arena.getIndex()!.array;
        const [[sa, ca], [sb, cb]] = drawsOf(batch);
        assert.equal(ca, 6);
        assert.equal(cb, 3);
        const pos = arena.getAttribute('position').array as Int16Array;
        // Every index of b's draw points at b's own vertices.
        for (let i = 0; i < cb; i++) {
            const v = index[sb + i];
            assert.deepEqual([...pos.subarray(v * 3, v * 3 + 3)], [...(b.geometry.getAttribute('position').array as Int16Array).subarray(i * 3, i * 3 + 3)]);
        }
        assert.notEqual(sa, sb);
        assert.deepEqual(batch.used, { vertices: 7, indices: 9 });
        // A second pass reuses the blocks.
        batch.begin();
        batch.add(a, 0, 6);
        batch.add(b, 0, 3);
        assert.deepEqual(batch.used, { vertices: 7, indices: 9 });
    });

    it('draws a sub-range, and an index list over shared attributes as its own block', () => {
        const batch = new TileBatch(material(), 0);
        const full = tileMesh(batch.source, 4, [0, 1, 2, 2, 3, 0]);
        const level = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(full.geometry.attributes)) {
            level.setAttribute(name, attr);
        }
        level.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 3]), 1));
        batch.begin();
        batch.add(full, 3, 3);
        full.geometry = level;
        batch.add(full, 0, 3);
        assert.deepEqual(batch.used, { vertices: 4, indices: 9 }, 'vertices copied once, both index lists');
        const index = arenaOf(batch).getIndex()!.array;
        const [[s0], [s1]] = drawsOf(batch);
        assert.deepEqual([index[s0], index[s0 + 1], index[s0 + 2]], [2, 3, 0]);
        assert.deepEqual([index[s1], index[s1 + 1], index[s1 + 2]], [0, 1, 3]);
    });

    it('copies again when an attribute changes, and frees a disposed geometry', () => {
        const batch = new TileBatch(material(), 0);
        const a = tileMesh(batch.source, 3, [0, 1, 2]);
        batch.begin();
        batch.add(a, 0, 3);
        const pos = a.geometry.getAttribute('position') as THREE.BufferAttribute;
        pos.setXYZ(1, 7, 8, 9);
        pos.needsUpdate = true;
        batch.begin();
        batch.add(a, 0, 3);
        const arena = arenaOf(batch).getAttribute('position').array as Int16Array;
        const v = arenaOf(batch).getIndex()!.array[drawsOf(batch)[0][0] + 1];
        assert.deepEqual([...arena.subarray(v * 3, v * 3 + 3)], [7, 8, 9]);
        a.geometry.dispose();
        assert.deepEqual(batch.used, { vertices: 0, indices: 0 });
    });

    it('grows the arena and keeps what was already in it', () => {
        const batch = new TileBatch(material(), 0);
        const meshes = Array.from({ length: 5 }, (_, k) => tileMesh(batch.source, 20000, [0, 1, 19999], k + 1));
        batch.begin();
        for (const m of meshes) {
            assert.ok(batch.add(m, 0, 3));
        }
        const arena = arenaOf(batch);
        const pos = arena.getAttribute('position').array as Int16Array;
        const tone = arena.getAttribute('secondTone').array as Uint8Array;
        drawsOf(batch).forEach(([start], k) => {
            const v = arena.getIndex()!.array[start + 2];
            assert.equal(tone[v], k + 1, `mesh ${k} tone survived the growth`);
            assert.equal(pos[v * 3], new Int16Array([(k + 1) * 100 + 19999 * 3])[0]);
        });
    });

    it('copies an interleaved attribute component by component', () => {
        const batch = new TileBatch(material(), 0);
        const m = tileMesh(batch.source, 2, [0, 1, 1]);
        const data = new THREE.InterleavedBuffer(new Int8Array([1, 2, 3, 99, 4, 5, 6, 98]), 4);
        m.geometry.setAttribute('riverDir', new THREE.InterleavedBufferAttribute(data, 3, 0, true));
        m.geometry.setAttribute('riverMeta', new THREE.InterleavedBufferAttribute(data, 1, 3, false));
        batch.begin();
        batch.add(m, 0, 3);
        const arena = arenaOf(batch);
        assert.deepEqual([...(arena.getAttribute('riverDir').array as Int8Array).subarray(0, 6)], [1, 2, 3, 4, 5, 6]);
        assert.equal(arena.getAttribute('riverDir').normalized, true);
        assert.deepEqual([...(arena.getAttribute('riverMeta').array as Int8Array).subarray(0, 2)], [99, 98]);
    });

    it('refuses a mesh whose attribute is laid out differently', () => {
        const batch = new TileBatch(material(), 0);
        batch.begin();
        assert.ok(batch.add(tileMesh(batch.source, 3, [0, 1, 2]), 0, 3));
        const odd = tileMesh(batch.source, 3, [0, 1, 2]);
        odd.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
        assert.equal(batch.add(odd, 0, 3), false);
    });

    it('shares the source material\'s uniforms and gives the batch its draw matrices', () => {
        const source = material();
        const batch = new TileBatch(source, 0);
        const own = batch.mesh.material as THREE.ShaderMaterial;
        assert.notEqual(own, source);
        assert.equal(own.uniforms, source.uniforms);
        assert.ok(own.uniforms.uDrawMatrices.value instanceof THREE.DataTexture);
        const flags = batch.mesh as unknown as Record<string, unknown>;
        assert.equal(flags.isBatchedMesh, true);
        assert.equal(flags._colorsTexture, null);
        assert.equal(flags.colorTexture, null);
    });
});

describe('TileBatcher', () => {
    it('takes a registered material\'s visible meshes and hides them from the camera', () => {
        const batcher = new TileBatcher();
        const water = new THREE.ShaderMaterial();
        const other = new THREE.ShaderMaterial();
        batcher.register(water, 0);
        const a = tileMesh(water, 3, [0, 1, 2]);
        const hidden = tileMesh(water, 3, [0, 1, 2]);
        hidden.visible = false;
        const unregistered = tileMesh(other, 3, [0, 1, 2]);
        batcher.begin();
        batcher.offer(a);
        batcher.offer(hidden);
        batcher.offer(unregistered);
        assert.equal(batcher.draws, 1);
        assert.equal(a.layers.mask, 0);
        assert.equal(hidden.layers.mask, 1);
        assert.equal(unregistered.layers.mask, 1);
    });

    it('reads a one-group material array through its group, and its draw range', () => {
        const batcher = new TileBatcher();
        const deep = new THREE.ShaderMaterial();
        batcher.register(deep, 0);
        const m = tileMesh(new THREE.MeshBasicMaterial(), 4, [0, 1, 2, 2, 3, 0]);
        m.material = [new THREE.MeshBasicMaterial(), deep];
        m.geometry.addGroup(0, 6, 1);
        m.geometry.setDrawRange(3, 30);
        batcher.begin();
        batcher.offer(m);
        assert.equal(batcher.draws, 1);
        const batch = (batcher as unknown as { batches: Map<THREE.Material, TileBatch> }).batches.get(deep)!;
        assert.equal(drawsOf(batch)[0][1], 3);
    });

    it('gives every mesh back to the camera when switched off', () => {
        const batcher = new TileBatcher();
        const water = new THREE.ShaderMaterial();
        batcher.register(water, 0);
        const a = tileMesh(water, 3, [0, 1, 2]);
        batcher.begin();
        batcher.offer(a);
        batcher.enabled = false;
        batcher.begin();
        batcher.offer(a);
        assert.equal(a.layers.mask, 1);
        assert.equal(batcher.draws, 0);
    });
});
