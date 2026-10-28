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

    it('keeps a rock triangle its own faceted normal', () => {
        const { positions, normals, attrs } = ridge();
        attrs[3] = attrs[7] = attrs[11] = 6;   // first triangle bare rock
        const weld = weldSmoothLand(positions, normals, attrs)!;
        for (let c = 0; c < 3; c++) {
            const v = weld.indices[c];
            assert.deepEqual([...weld.normals.subarray(v * 4, v * 4 + 3)], [...normals.subarray(c * 4, c * 4 + 3)]);
        }
        // Three of its own, and the other triangle's three: nothing left over.
        assert.equal(weld.positions.length / 3, 6);
    });

    it('blends part way at a lower strength, and does not weld steep faces', () => {
        const { positions, normals, attrs } = ridge();
        const full = weldSmoothLand(positions, normals, attrs, undefined, 1)!;
        const half = weldSmoothLand(positions, normals, attrs, undefined, 0.5)!;
        // Corner 1 is on the ridge: welded, its x leans from its facet's to level; half way, part of that.
        const v = half.indices[1], w = full.indices[1];
        const own = normals[4], welded = full.normals[w * 4], blended = half.normals[v * 4];
        assert.ok(Math.abs(blended - own) > 0 && Math.abs(blended - own) < Math.abs(welded - own));

        const steep = ridge(70);
        const cliff = weldSmoothLand(steep.positions, steep.normals, steep.attrs)!;
        assert.equal(cliff.positions.length / 3, 6);
    });
});

/** Two facets meeting at a ridge, each leaning `deg` from up to either side, class grass. */
function ridge(deg = 20) {
    const { positions, attrs } = quad();
    for (let v = 0; v < 6; v++) {
        attrs[v * 4 + 3] = 3;
    }
    const s = Math.round(Math.sin(deg * Math.PI / 180) * 127), c = Math.round(Math.cos(deg * Math.PI / 180) * 127);
    const normals = new Int8Array(6 * 4);
    for (let v = 0; v < 6; v++) {
        normals[v * 4] = v < 3 ? -s : s;
        normals[v * 4 + 1] = c;
    }
    return { positions, normals, attrs };
}

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
