import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BuildingShape, buildingTriangles } from './buildingRoofs';
import { RoofForm } from './pbh';

interface Tri { p: number[]; n: readonly number[]; roof: boolean }

function collect(shape: BuildingShape): Tri[] {
    const out: Tri[] = [];
    const count = buildingTriangles(shape, (p, n, roof) => out.push({ p: [...p], n, roof }));
    assert.equal(count, out.length);
    return out;
}

/** Area of a triangle's shadow on the (u, v) plane. */
function projectedArea(t: Tri): number {
    const [ax, ay, , bx, by, , cx, cy] = t.p;
    return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

function windsWithNormal(t: Tri): boolean {
    const p = t.p;
    const e1 = [p[3] - p[0], p[4] - p[1], p[5] - p[2]];
    const e2 = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    return c[0] * t.n[0] + c[1] * t.n[1] + c[2] * t.n[2] > 0;
}

const RECT: Array<[number, number]> = [[0, 0], [10, 0], [10, 6], [0, 6]];
const L_SHAPE: Array<[number, number]> = [[0, 0], [12, 0], [12, 5], [5, 5], [5, 10], [0, 10]];

function shape(rings: Array<Array<[number, number]>>, form: RoofForm, extra: Partial<BuildingShape> = {}): BuildingShape {
    return { rings, baseM: 100, eaveM: 106, ridgeM: 110, form, ridgeAngle: 0, ...extra };
}

describe('buildingTriangles', () => {
    for (const form of [RoofForm.Flat, RoofForm.Gabled, RoofForm.Hipped, RoofForm.HalfHipped,
        RoofForm.Skillion, RoofForm.Pyramidal]) {
        for (const [name, ring, area] of [['rectangle', RECT, 60], ['L', L_SHAPE, 85]] as const) {
            it(`roof of form ${form} covers the ${name} footprint once`, () => {
                const tris = collect(shape([ring.map(p => [p[0], p[1]] as [number, number])], form));
                const roof = tris.filter(t => t.roof);
                const covered = roof.reduce((s, t) => s + projectedArea(t), 0);
                assert.ok(Math.abs(covered - area) < 1e-6, `roof covers ${covered} m^2 of ${area}`);
                for (const t of tris) {
                    assert.ok(windsWithNormal(t), 'every triangle winds counter-clockwise about its normal');
                }
                for (const t of roof) {
                    assert.ok(t.n[2] > 0, 'roof faces look up');
                    for (let k = 2; k < 9; k += 3) {
                        assert.ok(t.p[k] >= 106 - 1e-6 && t.p[k] <= 110 + 1e-6, `roof height ${t.p[k]}`);
                    }
                }
            });
        }
    }

    it('walls face outward and reach the base', () => {
        const tris = collect(shape([RECT], RoofForm.Gabled));
        const walls = tris.filter(t => !t.roof);
        assert.ok(walls.length > 0);
        for (const t of walls) {
            const cu = (t.p[0] + t.p[3] + t.p[6]) / 3, cv = (t.p[1] + t.p[4] + t.p[7]) / 3;
            assert.ok((cu - 5) * t.n[0] + (cv - 3) * t.n[1] > 0, 'normal points away from the middle');
            assert.equal(t.n[2], 0);
        }
        assert.ok(walls.some(t => [t.p[2], t.p[5], t.p[8]].includes(100)));
    });

    it('gable ends rise to the ridge, along the ridge the walls stop at the eave', () => {
        const tris = collect(shape([RECT], RoofForm.Gabled));
        const top = (pred: (t: Tri) => boolean) =>
            Math.max(...tris.filter(t => !t.roof && pred(t)).flatMap(t => [t.p[2], t.p[5], t.p[8]]));
        // Ridge along u (angle 0): the ends are the u = 0 and u = 10 walls.
        assert.ok(Math.abs(top(t => Math.abs(t.n[0]) > 0.5) - 110) < 1e-6);
        assert.ok(Math.abs(top(t => Math.abs(t.n[1]) > 0.5) - 106) < 1e-6);
        // 4 roof triangles, 4 for the long walls, 8 for the gable ends split at the ridge.
        assert.equal(tris.length, 16);
    });

    it('a ridge across turns the gable ends', () => {
        const tris = collect(shape([RECT], RoofForm.Gabled, { ridgeAngle: Math.PI / 2 }));
        const top = Math.max(...tris.filter(t => !t.roof && Math.abs(t.n[1]) > 0.5)
            .flatMap(t => [t.p[2], t.p[5], t.p[8]]));
        assert.ok(Math.abs(top - 110) < 1e-6);
    });

    it('a courtyard makes the roof flat and gets its own walls', () => {
        const outer: Array<[number, number]> = [[0, 0], [30, 0], [30, 30], [0, 30]];
        const hole: Array<[number, number]> = [[10, 10], [20, 10], [20, 20], [10, 20]];
        const tris = collect(shape([outer, hole], RoofForm.Gabled));
        const roof = tris.filter(t => t.roof);
        assert.ok(Math.abs(roof.reduce((s, t) => s + projectedArea(t), 0) - 800) < 1e-6);
        assert.ok(roof.every(t => t.p[2] === 110 && t.n[2] === 1));
        // Courtyard walls face into it, toward its middle at (15, 15).
        const inner = tris.filter(t => !t.roof
            && [t.p[0], t.p[3], t.p[6]].every(u => u >= 10 - 1e-9 && u <= 20 + 1e-9)
            && [t.p[1], t.p[4], t.p[7]].every(v => v >= 10 - 1e-9 && v <= 20 + 1e-9));
        assert.equal(inner.length, 8);
        for (const t of inner) {
            const cu = (t.p[0] + t.p[3] + t.p[6]) / 3, cv = (t.p[1] + t.p[4] + t.p[7]) / 3;
            assert.ok((15 - cu) * t.n[0] + (15 - cv) * t.n[1] > 0);
        }
    });

    it('a roof on posts has no walls', () => {
        const tris = collect(shape([RECT], RoofForm.Flat, { noWalls: true }));
        assert.ok(tris.length > 0 && tris.every(t => t.roof));
    });

    it('clockwise input is handled like counter-clockwise', () => {
        const a = collect(shape([RECT], RoofForm.Hipped)).length;
        const b = collect(shape([[...RECT].reverse()], RoofForm.Hipped)).length;
        assert.equal(a, b);
    });
});
