import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PtrTile, RoadClass, ROAD_SIDE_BIT } from './ptr';
import { RAIL_MAX_GRADE, gradeProfileWeighted, layRailBeds, railChains } from './railBed';

const Q = 0.05;
const LIFT = 0.7;

/** Ground: flat at 100 m with an 8 m hump across x = 0, 60 m wide. */
const groundAt = (x: number) => 100 + 8 * Math.max(0, 1 - Math.abs(x) / 30);

/** A 400 x 200 m soup of 20 m cells (two triangles each), y up. */
function soup() {
    const pos: number[] = [];
    const cell = 20;
    for (let i = -10; i < 10; i++) {
        for (let j = -5; j < 5; j++) {
            const x0 = i * cell, x1 = x0 + cell, z0 = j * cell, z1 = z0 + cell;
            const p = (x: number, z: number) => [x / Q, groundAt(x) / Q, z / Q];
            pos.push(...p(x0, z0), ...p(x0, z1), ...p(x1, z1), ...p(x0, z0), ...p(x1, z1), ...p(x1, z0));
        }
    }
    const positions = Int16Array.from(pos.map(Math.round));
    const n = positions.length / 3;
    const normals = new Int8Array(n * 4);
    for (let v = 0; v < n; v++) {
        normals[v * 4 + 1] = 127;
    }
    return { positions, normals, attrs: new Uint8Array(n * 4) };
}

/** A straight track along x at z = 0, draped on the ground every 10 m. */
function track(): PtrTile {
    const pts: number[] = [];
    for (let x = -180; x <= 180; x += 10) {
        pts.push(x);
    }
    const n = pts.length * 2;
    const positions = new Int16Array(n * 3);
    const directions = new Int8Array(n * 4);
    pts.forEach((x, i) => {
        for (const k of [0, 1]) {
            const v = i * 2 + k;
            positions[v * 3] = Math.round(x / Q);
            positions[v * 3 + 1] = Math.round((groundAt(x) + LIFT) / Q);
            positions[v * 3 + 2] = 0;
            directions[v * 4 + 2] = k === 0 ? 127 : -127;
            directions[v * 4 + 3] = RoadClass.Rail | (k === 1 ? ROAD_SIDE_BIT : 0);
        }
    });
    const indices: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
        const l0 = i * 2, l1 = l0 + 2;
        indices.push(l0, l0 + 1, l1 + 1, l0, l1 + 1, l1);
    }
    return {
        id: { z: 12, x: 0, y: 0 }, quantScale: Q, positions, directions,
        halfWidths: new Uint16Array(n).fill(25), along: new Uint16Array(n), flags: new Uint8Array(n),
        indices: Uint16Array.from(indices),
    };
}

describe('gradeProfileWeighted', () => {
    it('never exceeds the step, and holds weighted samples', () => {
        const ground = [0, 0, 5, 0, 0];
        const out = gradeProfileWeighted(ground, [1e4, 1, 1, 1, 1e4], 10);
        for (let i = 1; i < out.length; i++) {
            assert.ok(Math.abs(out[i] - out[i - 1]) <= 10 * 0.05 + 1e-9);
        }
        assert.ok(Math.abs(out[0]) < 0.05 && Math.abs(out[4]) < 0.05);
    });
});

describe('layRailBeds', () => {
    it('grades the track to the limit and lays the ground under it, without cracks', () => {
        const land = soup();
        const strokes = track();
        assert.equal(railChains(strokes).length, 1);
        const result = layRailBeds({
            land, quantScale: Q, strokes, up: [0, 1, 0], liftM: LIFT, pinned: new Set(),
        });
        assert.ok(result?.land, 'something moved');
        assert.ok(result.stats.steepM > 0, 'the hump was steeper than the limit before');

        // The track: no segment steeper than the limit.
        const sp = result.strokePositions;
        assert.notEqual(sp, strokes.positions, 'the sidecar itself is left alone');
        for (let i = 0; i + 2 < sp.length / 3; i += 2) {
            const dx = (sp[(i + 2) * 3] - sp[i * 3]) * Q;
            const dh = (sp[(i + 2) * 3 + 1] - sp[i * 3 + 1]) * Q;
            assert.ok(Math.abs(dh / dx) <= RAIL_MAX_GRADE + 0.003, `segment ${i / 2}: ${(dh / dx * 100).toFixed(2)} %`);
        }

        // The ground under the track meets it (within the lift and a quantum or two).
        const P = result.land!.positions;
        const tris = P.length / 9;
        let checked = 0;
        for (let t = 0; t < tris; t++) {
            for (let k = 0; k < 3; k++) {
                const o = (t * 3 + k) * 3;
                const x = P[o] * Q, y = P[o + 1] * Q, z = P[o + 2] * Q;
                if (Math.abs(z) < 2 && Math.abs(x) < 150) {
                    // Find the track height at x.
                    const i = Math.round((x + 180) / 10) * 2;
                    const ty = sp[i * 3 + 1] * Q - LIFT;
                    if (Math.abs(sp[i * 3] * Q - x) < 1) {
                        assert.ok(Math.abs(y - ty) < 0.3, `ground ${y.toFixed(2)} vs track ${ty.toFixed(2)} at x ${x.toFixed(1)}`);
                        checked++;
                    }
                }
            }
        }
        assert.ok(checked > 3, `${checked} ground vertices under the track checked`);

        // No cracks: every edge of a real triangle is shared by two, except the soup's outer boundary.
        const edges = new Map<string, number>();
        const key = (o: number) => `${P[o]},${P[o + 1]},${P[o + 2]}`;
        for (let t = 0; t < tris; t++) {
            const c = [0, 1, 2].map(k => key((t * 3 + k) * 3));
            if (c[0] === c[1] || c[1] === c[2] || c[0] === c[2]) {
                continue; // a refined original, left degenerate
            }
            for (let k = 0; k < 3; k++) {
                const e = [c[k], c[(k + 1) % 3]].sort().join('|');
                edges.set(e, (edges.get(e) ?? 0) + 1);
            }
        }
        let open = 0;
        for (const [e, count] of edges) {
            if (count === 1) {
                const [a, b] = e.split('|').map(s => s.split(',').map(Number));
                const onRim = (p: number[]) => Math.abs(Math.abs(p[0] * Q) - 200) < 0.1 || Math.abs(Math.abs(p[2] * Q) - 100) < 0.1;
                if (!(onRim(a) && onRim(b))) {
                    open++;
                }
            }
        }
        assert.equal(open, 0, 'open edges inside the mesh');
        assert.ok(result.stats.trianglesAdded > 0);
    });
});

describe('layRailBeds on a coarser tile', () => {
    it('grades with its lengths scaled, and leaves the sidecar alone', () => {
        const strokes = track();
        const before = strokes.positions.slice();
        const result = layRailBeds({
            land: soup(), quantScale: Q, strokes, up: [0, 1, 0], liftM: LIFT * 4, pinned: new Set(), scale: 4,
        });
        assert.ok(result);
        assert.deepEqual(strokes.positions, before);
        const sp = result.strokePositions;
        for (let i = 0; i + 2 < sp.length / 3; i += 2) {
            const dx = (sp[(i + 2) * 3] - sp[i * 3]) * Q;
            const dh = (sp[(i + 2) * 3 + 1] - sp[i * 3 + 1]) * Q;
            assert.ok(Math.abs(dh / dx) <= RAIL_MAX_GRADE + 0.003, `segment ${i / 2}: ${(dh / dx * 100).toFixed(2)} %`);
        }
        assert.ok(result.beds.length > 0);
    });
});
