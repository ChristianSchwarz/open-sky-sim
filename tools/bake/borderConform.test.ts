import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BorderSource, conformBorders, seamAncestor } from './borderConform';

describe('seamAncestor', () => {
    it('follows a side up while the tile is the parent\'s first or last child on it', () => {
        // x = 8 at z12 is 0 mod 8: west side is on the z9 boundary (x 1), and z8 (x 0.5) is no boundary.
        assert.deepEqual(seamAncestor(12, 8, 5, 'W', 9), { z: 9, x: 1, y: 0 });
        assert.deepEqual(seamAncestor(12, 16, 5, 'W', 9), { z: 9, x: 2, y: 0 });
        // Odd x: its west side is interior to the parent, nothing to conform to.
        assert.equal(seamAncestor(12, 9, 5, 'W', 9), undefined);
        // East is the last child on the line: x = 7 mod 8.
        assert.deepEqual(seamAncestor(12, 7, 5, 'E', 9), { z: 9, x: 0, y: 0 });
        // Never coarser than the limit.
        assert.deepEqual(seamAncestor(12, 0, 0, 'N', 10), { z: 10, x: 0, y: 0 });
    });
});

describe('conformBorders', () => {
    const size = 5;
    const ramp = new Float32Array(size).map((_, i) => 100 + 40 * i);   // ancestor border, nodes 0..4
    const source: BorderSource = { border: () => ramp };

    it('reads the ancestor\'s straight line at the tile\'s own nodes', () => {
        // z10 tile, first child (y even) of its z9 parent along the west side.
        const h = new Float32Array(size * size).fill(500);
        const n = conformBorders(h, size, 10, 0, 0, 0, source, 9);
        assert.ok(n > 0);
        // Segment 0 of 2: the tile's 5 nodes cover ancestor u = 0 .. 2, i.e. 100, 120, 140, 160, 180.
        for (let i = 0; i < size; i++) {
            assert.ok(Math.abs(h[i * size] - (100 + 20 * i)) < 1e-4, `W node ${i}: ${h[i * size]}`);
        }
        // Interior untouched.
        assert.equal(h[size + 1], 500);
    });

    it('leaves a node alone that would cross the coastline, or has no data', () => {
        const h = new Float32Array(size * size).fill(500);
        h[0] = -3;
        h[size] = NaN;
        conformBorders(h, size, 10, 0, 0, 0, source, 9);
        assert.equal(h[0], -3);
        assert.ok(Number.isNaN(h[size]));
    });

    it('leaves the sides interior to the parent alone', () => {
        // Child (1, 1) shares only its east and south sides with the parent.
        const h = new Float32Array(size * size).fill(500);
        conformBorders(h, size, 10, 1, 1, 0, source, 9);
        for (let i = 1; i < size - 1; i++) {
            assert.equal(h[i * size], 500, 'west');
            assert.equal(h[i], 500, 'north');
        }
        assert.notEqual(h[2 * size + size - 1], 500, 'east');
    });
});
