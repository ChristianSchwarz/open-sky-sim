import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GridPoint, GridTri, clipToTriangle, landuseFill } from './landuseFill';

const area = (pts: readonly GridPoint[]): number => {
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    }
    return Math.abs(a / 2);
};

const inside = (p: GridPoint, t: GridTri): boolean => {
    const s = Math.sign((t[1].x - t[0].x) * (t[2].y - t[0].y) - (t[1].y - t[0].y) * (t[2].x - t[0].x));
    for (let e = 0; e < 3; e++) {
        const a = t[e];
        const b = t[(e + 1) % 3];
        if (s * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < -1e-9) {
            return false;
        }
    }
    return true;
};

/** A 4x4-cell tile split into two facets along its diagonal. */
const CELLS = 4;
const FACETS: GridTri[] = [
    [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }],
    [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }],
];

const square = (x0: number, y0: number, x1: number, y1: number): GridPoint[] => [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

describe('clipToTriangle', () => {
    it('keeps a polygon wholly inside the triangle unchanged in area', () => {
        const tri: GridTri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
        assert.equal(area(clipToTriangle(square(1, 1, 2, 2), tri)), 1);
    });

    it('cuts a polygon straddling an edge down to the part inside', () => {
        const tri: GridTri = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }];
        // The unit square at the origin corner is half above the diagonal.
        assert.ok(Math.abs(area(clipToTriangle(square(0, 0, 1, 1), tri)) - 0.5) < 1e-9);
    });

    it('returns nothing for a polygon entirely outside', () => {
        const tri: GridTri = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
        assert.equal(clipToTriangle(square(5, 5, 6, 6), tri).length, 0);
    });
});

describe('landuseFill', () => {
    it('covers exactly the polygon area, split across the facets it spans', () => {
        const pieces = landuseFill(FACETS, [{ exterior: square(1, 1, 3, 3), holes: [] }], CELLS);
        const total = pieces.reduce((s, p) => s + area(p.pts), 0);
        assert.ok(Math.abs(total - 4) < 1e-6, `filled ${total} of 4`);
        assert.deepEqual(new Set(pieces.map(p => p.facet)), new Set([0, 1]));
    });

    it('places every piece inside the facet it names', () => {
        const pieces = landuseFill(FACETS, [{ exterior: square(0.5, 1.5, 3.5, 2.5), holes: [] }], CELLS);
        for (const p of pieces) {
            for (const v of p.pts) {
                assert.ok(inside(v, FACETS[p.facet]), `(${v.x}, ${v.y}) outside facet ${p.facet}`);
            }
        }
    });

    it('leaves a hole unfilled', () => {
        const pieces = landuseFill(FACETS, [{
            exterior: square(0, 0, 4, 4),
            holes: [square(1, 1, 3, 3)],
        }], CELLS);
        const total = pieces.reduce((s, p) => s + area(p.pts), 0);
        assert.ok(Math.abs(total - 12) < 1e-6, `filled ${total} of 12`);
    });

    it('reports which region each piece belongs to', () => {
        const pieces = landuseFill(FACETS, [
            { exterior: square(0, 0, 1, 1), holes: [] },
            { exterior: square(3, 3, 4, 4), holes: [] },
        ], CELLS);
        assert.deepEqual(new Set(pieces.map(p => p.region)), new Set([0, 1]));
    });
});
