import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SeamFillData, canCarryFill, fillVersionOf, showFill, writeFill } from './seamFillTail';
import { buildSmoothLandGeometry } from './tileMesh';

/** Two faceted triangles welded SMOOTH: four vertices, six indices. */
function smoothQuad() {
    const positions = new Int16Array([0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0, 10]);
    const normals = new Int8Array(24);
    const attrs = new Uint8Array(24).fill(100);
    for (let v = 0; v < 6; v++) {
        normals[v * 4 + 1] = 127;
        attrs[v * 4 + 3] = 5;
    }
    return buildSmoothLandGeometry(positions, normals, attrs, new Uint16Array(6))!;
}

function fill(count: number, version: number): SeamFillData {
    const position = new Int16Array(count * 3);
    for (let i = 0; i < count; i++) {
        position[i * 3] = 100 + i;
    }
    return {
        position, normals: new Int8Array(count * 4).fill(1), attrs: new Uint8Array(count * 4).fill(7),
        sizes: new Uint16Array(count).fill(3), count, version,
    };
}

describe('seam fill tail', () => {
    it('carries a fill at the end of a SMOOTH land draw, the land untouched', () => {
        const g = smoothQuad();
        assert.ok(canCarryFill(g));
        const grown = writeFill(g, fill(6, 1));
        assert.notEqual(grown, g, 'no room yet: a bigger copy');
        assert.equal(fillVersionOf(grown), 1);
        const index = grown.index!.array;
        assert.deepEqual([...index.slice(0, 6)], [...g.index!.array], 'the land indices as they were');
        assert.deepEqual([...index.slice(6, 12)], [4, 5, 6, 7, 8, 9], 'the fill after the land vertices');
        const pos = grown.getAttribute('position').array;
        assert.deepEqual([...pos.slice(0, 12)], [...g.getAttribute('position').array.slice(0, 12)]);
        assert.equal(pos[4 * 3], 100);

        showFill(grown, true);
        assert.equal(grown.drawRange.count, 12);
        showFill(grown, false);
        assert.equal(grown.drawRange.count, 6);
    });

    it('rewrites in place while the fill fits', () => {
        const g = writeFill(smoothQuad(), fill(6, 1));
        const again = writeFill(g, fill(3, 2));
        assert.equal(again, g);
        assert.equal(fillVersionOf(g), 2);
        showFill(g, true);
        assert.equal(g.drawRange.count, 9);
    });

    it('grows again for a bigger fill, keeping 32-bit indices when they are needed', () => {
        const g = writeFill(smoothQuad(), fill(3, 1));
        const big = writeFill(g, fill(70000, 2));
        assert.notEqual(big, g);
        assert.ok(big.index!.array instanceof Uint32Array);
        showFill(big, true);
        assert.equal(big.drawRange.count, 6 + 70000);
    });

    it('leaves a faceted land alone', () => {
        const g = smoothQuad();
        g.setIndex(null);
        assert.ok(!canCarryFill(g));
    });
});
