import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refreshWeldPositions, weldSmoothLand } from './smoothWeld';
import { SmoothWelder } from './smoothWelder';

/** Two triangles sharing an edge, faceted: six vertices, four positions. */
function quad() {
    const positions = new Int16Array([0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 0, 0, 10]);
    const normals = new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]);
    const attrs = new Uint8Array(6 * 4).fill(100);
    for (let v = 0; v < 6; v++) {
        attrs[v * 4 + 3] = 5;
    }
    return { positions, normals, attrs };
}

describe('weldSmoothLand', () => {
    it('shares one vertex per position within a region', () => {
        const { positions, normals, attrs } = quad();
        const weld = weldSmoothLand(positions, normals, attrs)!;
        assert.equal(weld.positions.length / 3, 4);
        assert.deepEqual([...weld.indices], [0, 1, 2, 1, 3, 2]);
    });
});

describe('refreshWeldPositions', () => {
    it('takes the faceted positions as they are now, through the index', () => {
        const { positions, normals, attrs } = quad();
        const weld = weldSmoothLand(positions, normals, attrs)!;
        // A stitch moved the shared corner (faceted vertices 1 and 3) after the copy.
        positions[1 * 3 + 1] = 7;
        positions[3 * 3 + 1] = 7;
        refreshWeldPositions(weld.positions, weld.indices, positions);
        assert.equal(weld.positions[1 * 3 + 1], 7);
        assert.equal(weld.positions[0 * 3 + 1], 0);
    });
});

describe('SmoothWelder', () => {
    it('welds in place where there are no workers, and leaves the input alone', async () => {
        const { positions, normals, attrs } = quad();
        const before = positions.slice();
        const welder = new SmoothWelder();
        const weld = await welder.weld(positions, normals, attrs);
        assert.deepEqual(weld, weldSmoothLand(positions, normals, attrs));
        assert.deepEqual(positions, before);
        assert.equal(welder.inFlight, 0);
    });
});
