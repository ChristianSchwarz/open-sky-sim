import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FillPiece, GridPoint, GridTri, clipToTriangle, landuseFill, mergePieces, snapToShore } from './landuseFill';

describe('mergePieces', () => {
    const tri = (a: [number, number], b: [number, number], c: [number, number]): [GridPoint, GridPoint, GridPoint] =>
        [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }, { x: c[0], y: c[1] }];
    const triArea = (t: readonly GridPoint[]) => {
        let s = 0;
        for (let i = 0, j = t.length - 1; i < t.length; j = i++) {
            s += t[j].x * t[i].y - t[i].x * t[j].y;
        }
        return Math.abs(s) / 2;
    };
    const facet: GridTri = tri([0, 0], [4, 0], [0, 4]);
    const c: [number, number] = [4 / 3, 4 / 3];

    it('turns a facet fully covered by many fragments into one triangle', () => {
        const pieces = [
            { facet: 0, region: 0, pts: tri([0, 0], [4, 0], c) },
            { facet: 0, region: 0, pts: tri([4, 0], [0, 4], c) },
            { facet: 0, region: 0, pts: tri([0, 4], [0, 0], c) },
        ];
        const merged = mergePieces(pieces, [facet]);
        assert.equal(merged.length, 1);
        assert.ok(Math.abs(triArea(merged[0].pts) - 8) < 1e-9);
    });

    it('drops crossing points along a facet edge and keeps the area', () => {
        // Left strip x <= 1 of the facet, cut into three by two diagonals
        // that meet the facet edge y = 0 at x = 0.5 and the line x = 1.
        const pieces = [
            { facet: 0, region: 0, pts: tri([0, 0], [0.5, 0], [1, 3]) },
            { facet: 0, region: 0, pts: tri([0.5, 0], [1, 0], [1, 3]) },
            { facet: 0, region: 0, pts: tri([0, 0], [1, 3], [0, 4]) },
        ];
        const merged = mergePieces(pieces, [facet]);
        // Outline (0,0) (1,0) (1,3) (0,4): four corners, two triangles.
        assert.equal(merged.length, 2);
        const total = merged.reduce((s, p) => s + triArea(p.pts), 0);
        assert.ok(Math.abs(total - 3.5) < 1e-9, `area ${total}`);
    });

    it('keeps fragments that do not form one loop', () => {
        const pieces = [
            { facet: 0, region: 0, pts: tri([0, 0], [1, 0], [0, 1]) },
            { facet: 0, region: 0, pts: tri([2, 0], [3, 0], [2, 1]) },
        ];
        assert.equal(mergePieces(pieces, [facet]).length, 2);
    });

    it('does not merge across regions', () => {
        const pieces = [
            { facet: 0, region: 0, pts: tri([0, 0], [4, 0], c) },
            { facet: 0, region: 1, pts: tri([4, 0], [0, 4], c) },
            { facet: 0, region: 1, pts: tri([0, 4], [0, 0], c) },
        ];
        assert.equal(mergePieces(pieces, [facet]).length, 3);
    });
});

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

describe('snapToShore', () => {
    // Land is a 4 x 3 strip of unit cells, each split into two facets; the
    // shore runs along y = 3 and the water lies beyond it.
    const facets: GridTri[] = [];
    for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 4; x++) {
            facets.push([{ x, y }, { x: x + 1, y }, { x, y: y + 1 }]);
            facets.push([{ x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 }]);
        }
    }
    const rect = (x0: number, y0: number, x1: number, y1: number) => ({
        exterior: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
        holes: [],
    });
    const area = (pieces: FillPiece[]) => pieces.reduce((s, p) => {
        const [a, b, c] = p.pts;
        return s + Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }, 0);
    const snap = (pieces: FillPiece[], maxCells: number, snaps = true) => snapToShore(pieces, facets, {
        snaps: () => snaps,
        onShore: p => p.y === 3,
        shoreDistance: p => 3 - p.y,
        maxCells,
    });

    it('closes a strip inside the shore row with fewer pieces', () => {
        const before = landuseFill(facets, [rect(0, 0, 4, 2.6)], 4);
        const after = snap(before, 1);
        assert.ok(Math.abs(area(after) - 12) < 1e-9);
        assert.ok(after.length < before.length);
    });

    it('closes a strip two facets wide through the shore row behind it', () => {
        const after = snap(landuseFill(facets, [rect(0, 0, 4, 1.5)], 4), 2);
        assert.ok(Math.abs(area(after) - 12) < 1e-9);
        assert.equal(after.length, facets.length);
    });

    it('does not creep along the bank past the end of the forest', () => {
        const after = snap(landuseFill(facets, [rect(0, 0, 2, 2.6)], 4), 1);
        assert.ok(Math.abs(area(after) - 6) < 1e-9);
    });

    it('leaves a gap wider than the reach alone', () => {
        const before = landuseFill(facets, [rect(0, 0, 4, 1)], 4);
        assert.ok(Math.abs(area(snap(before, 1)) - 4) < 1e-9);
    });

    it('leaves regions that do not snap alone', () => {
        const before = landuseFill(facets, [rect(0, 0, 4, 2.6)], 4);
        assert.ok(Math.abs(area(snap(before, 1, false)) - 4 * 2.6) < 1e-9);
    });

    it('does not fill a facet shared with another region', () => {
        const before = landuseFill(facets, [rect(0, 0, 4, 2.6), rect(0, 2.8, 4, 3)], 4);
        const after = snap(before, 1);
        assert.ok(Math.abs(area(after) - (4 * 2.6 + 4 * 0.2)) < 1e-9);
    });
});
