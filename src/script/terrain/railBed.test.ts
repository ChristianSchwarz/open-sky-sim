import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PtrTile, RoadClass, ROAD_SIDE_BIT } from './ptr';
import {
    BED_TIERS, BandResolver, RAIL_MAX_GRADE, gradeProfileWeighted, layRailBeds, railChains, retainingWalls, smoothVerticalCurves, underpinConcrete, cutLandAtWalls, DeckCeiling,
} from './railBed';

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
        // Free 1:2 batters on every side: nothing steep enough for a wall.
        assert.equal(result.stats.wallTriangles, 0);
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

describe('layRailBeds beside the tile border', () => {
    it('refines triangles with border vertices, and leaves the border vertices where and as they were', () => {
        // 100 m cells: every triangle touches the rim, whose vertices are the border.
        const pos: number[] = [];
        const cell = 100;
        for (let i = -2; i < 2; i++) {
            for (let j = -1; j < 1; j++) {
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
        const pinned = new Set<number>();
        for (let v = 0; v < n; v++) {
            const x = positions[v * 3] * Q, z = positions[v * 3 + 2] * Q;
            if (Math.abs(Math.abs(x) - 200) < 0.1 || Math.abs(Math.abs(z) - 100) < 0.1) {
                pinned.add(v);
            }
        }
        const result = layRailBeds({
            land: { positions, normals, attrs: new Uint8Array(n * 4) }, quantScale: Q, strokes: track(), up: [0, 1, 0],
            liftM: LIFT, pinned,
        });
        assert.ok(result?.land, 'the land moved');
        const P = result.land.positions;
        for (const v of pinned) {
            assert.deepEqual([...P.subarray(v * 3, v * 3 + 3)], [...positions.subarray(v * 3, v * 3 + 3)], `border vertex ${v}`);
        }
        // The hump's top under the track is cut down to the graded profile, not left at 108 m.
        // The stroke vertex at x = 0, found by position: the grading inserts
        // vertices along a curved profile.
        const sp = result.strokePositions;
        let mid = 0;
        for (let v = 0; v < sp.length / 3; v++) {
            if (Math.abs(sp[v * 3] * Q) < Math.abs(sp[mid * 3] * Q)) {
                mid = v;
            }
        }
        const trackTop = sp[mid * 3 + 1] * Q - LIFT;
        let under = -Infinity;
        for (let v = 0; v < P.length / 3; v++) {
            if (Math.abs(P[v * 3] * Q) < 1 && Math.abs(P[v * 3 + 2] * Q) < 1) {
                under = Math.max(under, P[v * 3 + 1] * Q);
            }
        }
        assert.ok(Math.abs(under - trackTop) < 0.3, `ground ${under.toFixed(2)} under track at ${trackTop.toFixed(2)}`);
    });
});

describe('layRailBeds keeping clear', () => {
    it('leaves water (and anything else kept) as baked, while the track still grades', () => {
        // A lake right beside the hump, 4-25 m off the track; the cutting
        // through the hump would otherwise slope into it.
        const lake = Float64Array.from([
            -40, 0, 4, 40, 0, 4, 40, 0, 25,
            -40, 0, 4, 40, 0, 25, -40, 0, 25,
        ]);
        const result = layRailBeds({
            land: soup(), quantScale: Q, strokes: track(), up: [0, 1, 0], liftM: LIFT, pinned: new Set(), keep: { tris: lake },
        });
        assert.ok(result?.land);
        const P = result.land.positions;
        let inside = 0;
        for (let v = 0; v < P.length / 3; v++) {
            const x = P[v * 3] * Q, z = P[v * 3 + 2] * Q;
            if (Math.abs(x) <= 40 && z >= 4 && z <= 25) {
                inside++;
                // The baked surface there: linear between the 20 m grid's nodes.
                const x0 = Math.floor(x / 20) * 20, f = (x - x0) / 20;
                const baked = groundAt(x0) * (1 - f) + groundAt(x0 + 20) * f;
                assert.ok(Math.abs(P[v * 3 + 1] * Q - baked) < 0.06, `lake vertex at ${x.toFixed(1)},${z.toFixed(1)} moved`);
            }
        }
        assert.ok(inside > 3, `${inside} vertices in the lake`);
        assert.ok(result.stats.trianglesAdded > 0, 'the cutting was still laid');
        // Squeezed between the track and the lake, the cutting's side is far
        // past 45 degrees: a straight concrete retaining wall, built as its
        // own few quads rather than painted onto the land's facets.
        const walls = result.walls;
        assert.ok(walls && result.stats.wallTriangles > 0, 'retaining walls');
        assert.equal(walls.indices.length / 3, result.stats.wallTriangles);
        // The cutting through the hump is ~60 m long on the lake side: a
        // handful of straight pieces, not one per refined facet.
        assert.ok(result.stats.wallTriangles <= 40, `${result.stats.wallTriangles} wall triangles`);
        // Vertical faces: every face normal is horizontal or straight up.
        for (let v = 0; v < walls.normals.length / 3; v++) {
            const ny = walls.normals[v * 3 + 1];
            assert.ok(Math.abs(ny) < 1e-6 || Math.abs(ny - 1) < 1e-6, `normal ${ny}`);
        }
    });
});

describe('retainingWalls', () => {
    /** A straight 2.5 m bed along x at h 10, its ground dropping 6 m 4.5 m off it on +z: an embankment held by a wall. */
    const embankment = () => {
        const beds = [];
        for (let x = -60; x < 60; x += 10) {
            const s = (u: number) => ({ u, v: 0, ground: 10, weight: 1, h: 10, land: 4, off: false });
            beds.push({ a: s(x), b: s(x + 10), half: 2.5, open: 0, tier: 0, reach: 12, refine: true });
        }
        // Keep each sample shared with its neighbour, as one chain's beds are.
        for (let i = 1; i < beds.length; i++) {
            beds[i].a = beds[i - 1].b;
        }
        // The designed ground: the bed's height out to the cliff, 6 m lower past it.
        const ground = (_u: number, v: number) => (v < 4.5 ? 10 : 4);
        const frame = { up: [0, 1, 0], a: [1, 0, 0], b: [0, 0, 1], toPlan: (p: number[]) => p } as unknown as Parameters<typeof retainingWalls>[1];
        return { beds, ground, frame };
    };

    it('builds a wall along the embankment', () => {
        const { beds, ground, frame } = embankment();
        const walls = retainingWalls(beds as never, frame, ground)!;
        const xs = wallXs(walls);
        assert.ok(Math.min(...xs) < -50 && Math.max(...xs) > 50, `wall from ${Math.min(...xs)} to ${Math.max(...xs)}`);
    });

    it('stands no wall on another road: it stops at a street across its foot and goes on past it', () => {
        const { beds, ground, frame } = embankment();
        // A street across the embankment's foot at x = 0, 3 m each side of its centreline.
        const onRoad = (u: number) => Math.abs(u) < 3.5;
        const walls = retainingWalls(beds as never, frame, ground, u => onRoad(u))!;
        const spans = wallSpans(walls);
        const over = spans.filter(([a, b]) => b > -3.5 && a < 3.5);
        assert.equal(over.length, 0, `wall triangles over the street: ${over.map(([a, b]) => `${a.toFixed(1)}..${b.toFixed(1)}`)}`);
        assert.ok(spans.some(([a]) => a < -40) && spans.some(([, b]) => b > 40), 'the wall goes on either side');
    });

    it('stands no higher than the underside of a deck over it, and not at all with too little room', () => {
        const { beds, ground, frame } = embankment();
        // A deck over x in -10..10, its underside 7 m up: the wall (10 m) stops under it.
        const walls = retainingWalls(beds as never, frame, ground, undefined, undefined, (u: number) => (Math.abs(u) < 10 ? 7 : undefined))!;
        const P = walls.positions;
        for (let i = 0; i < P.length; i += 3) {
            if (Math.abs(P[i]) < 9) {
                assert.ok(P[i + 1] <= 6.9 + 1e-6, `wall at x ${P[i].toFixed(1)} stands ${P[i + 1].toFixed(2)} m up`);
            }
        }
        // Its underside 4.5 m up, over ground at 4: no room for a wall there.
        const low = retainingWalls(beds as never, frame, ground, undefined, undefined, (u: number) => (Math.abs(u) < 10 ? 4.5 : undefined))!;
        const spans = wallSpans(low);
        assert.equal(spans.filter(([x0, x1]) => x1 > -8 && x0 < 8).length, 0, 'no wall under the low deck');
        assert.ok(spans.some(([x0]) => x0 < -40) && spans.some(([, x1]) => x1 > 40), 'the wall goes on either side');
    });

    it('builds no wall for a drop under a metre: that is a bank', () => {
        const { beds, frame } = embankment();
        assert.equal(retainingWalls(beds as never, frame, (_u, v) => (v < 4.5 ? 10 : 9.2)), undefined);
    });

    it('holds an embankment on one stretch and a cutting on the next, each where its cliff is', () => {
        const { beds, frame } = embankment();
        // Beyond the cliff the ground is 6 m down for x < 0 and 6 m up for x > 0.
        const walls = retainingWalls(beds as never, frame, (u, v) => (v < 4.5 ? 10 : u < 0 ? 4 : 16))!;
        const P = walls.positions;
        let lowWest = Infinity, highEast = -Infinity;
        for (let i = 0; i < P.length / 3; i++) {
            const x = P[i * 3], y = P[i * 3 + 1];
            if (x < -10) {
                lowWest = Math.min(lowWest, y);
            } else if (x > 10) {
                highEast = Math.max(highEast, y);
            }
        }
        assert.ok(lowWest < 4, `the embankment's wall goes down to the low ground: ${lowWest.toFixed(1)}`);
        assert.ok(highEast > 15.9, `the cutting's wall goes up to the high ground: ${highEast.toFixed(1)}`);
    });

    it('builds one wall between two lines side by side, not one each', () => {
        const { beds, frame } = embankment();
        // A second bed 12 m off at z = 12, 6 m lower; the cliff between them
        // lies just past the upper one's shoulder.
        const lower = beds.map(b => ({ ...b, a: { ...b.a, v: 12, h: 4 }, b: { ...b.b, v: 12, h: 4 } }));
        for (let i = 1; i < lower.length; i++) {
            lower[i].a = lower[i - 1].b;
        }
        const walls = retainingWalls([...beds, ...lower] as never, frame, (_u, v) => (v < 4.5 ? 10 : 4))!;
        const P = walls.positions;
        // Every wall vertex near the upper bed's cliff, none near the lower bed.
        let far = 0;
        for (let i = 0; i < P.length / 3; i++) {
            if (Math.abs(P[i * 3 + 2]) > 8) {
                far++;
            }
        }
        assert.equal(far, 0, `${far} wall vertices out by the lower line`);
    });

    it('builds no stub shorter than a wall: a road leaving too little is the end of it', () => {
        const { beds, ground, frame } = embankment();
        // Roads at x = -50 and x = -40 leave 10 m between them: no wall there.
        const walls = retainingWalls(beds as never, frame, ground, u => Math.abs(u + 50) < 1 || Math.abs(u + 40) < 1)!;
        assert.ok(!wallSpans(walls).some(([a, b]) => b > -49 && a < -41), 'a 10 m stub between the roads');
    });
});

/** The plan x of every wall vertex. */
function wallXs(walls: { positions: Float32Array }): number[] {
    const out: number[] = [];
    for (let v = 0; v < walls.positions.length / 3; v++) {
        out.push(walls.positions[v * 3]);
    }
    return out;
}

/** The x range each wall triangle covers (a straight wall is one long quad, its vertices at its ends). */
function wallSpans(walls: { positions: Float32Array; indices: Uint32Array }): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i + 2 < walls.indices.length; i += 3) {
        const xs = [0, 1, 2].map(j => walls.positions[walls.indices[i + j] * 3]);
        out.push([Math.min(...xs), Math.max(...xs)]);
    }
    return out;
}

describe('BandResolver ranks', () => {
    const tier = (name: string) => BED_TIERS.findIndex(t => t.name === name);

    it('shares the ground between a railway and an Autobahn: neither batter wins', () => {
        // 2 m past both shoulders: the railway's batter allows 9..11, the
        // Autobahn's 13..15. Ranked, the railway had the last word (11).
        const r = new BandResolver();
        r.reset();
        r.add(tier('railway'), 10, 2);
        r.add(tier('autobahn'), 14, 2);
        assert.equal(r.resolve(20), 12);
    });

    it('averages their surfaces where both cover a point', () => {
        const r = new BandResolver();
        r.reset();
        r.add(tier('railway'), 10, 0);
        r.add(tier('autobahn'), 11, 0);
        assert.equal(r.resolve(0), 10.5);
    });

    it('still lets either win over a highway', () => {
        const r = new BandResolver();
        r.reset();
        r.add(tier('highway'), 14, 2);
        r.add(tier('autobahn'), 10, 2);
        assert.equal(r.resolve(20), 11);
    });
});

describe('smoothVerticalCurves', () => {
    it('rounds a crest between two 3 % grades into a curve of about 5000 m, the held ends kept', () => {
        const step = 5, n = 201;
        const crest = Array.from({ length: n }, (_, i) => 100 - Math.abs(i - 100) * step * 0.03);
        const held = crest.map((_, i) => (i === 0 || i === n - 1 ? 1e4 : 1));
        const h = smoothVerticalCurves(crest, held, crest, crest.map(() => Infinity), 5000, 0.03, step);
        let least = Infinity;
        for (let i = 1; i + 1 < n; i++) {
            const c = Math.abs(h[i - 1] - 2 * h[i] + h[i + 1]) / (step * step);
            least = Math.min(least, c > 0 ? 1 / c : Infinity);
        }
        assert.ok(least >= 4750, `least vertical radius ${least.toFixed(0)} m`);
        assert.equal(h[0], crest[0]);
        assert.equal(h[n - 1], crest[n - 1]);
    });

    it('leaves a straight grade as it is', () => {
        const line = Array.from({ length: 50 }, (_, i) => 10 + i * 0.1);
        const h = smoothVerticalCurves(line, line.map(() => 1), line, line.map(() => Infinity), 5000, 0.03, 5);
        assert.ok(h.every((v, i) => Math.abs(v - line[i]) < 1e-6));
    });

    it('keeps within its band where the radius would take it further: as gentle as the cut allows', () => {
        // A 6 m dip 120 m wide at 10 %: 500 m of radius would float a street
        // well over its bottom; held within 1.5 m of the ground it stays.
        const step = 5, n = 81;
        const ground = Array.from({ length: n }, (_, i) => 100 - 6 * Math.max(0, 1 - Math.abs(i - 40) * step / 60));
        const h = smoothVerticalCurves(ground, ground.map(() => 1), ground, ground.map(() => 1.5), 500, 0.1, step);
        assert.ok(h.every((v, i) => Math.abs(v - ground[i]) <= 1.5 + 0.06), 'within the band');
    });
});

describe('underpinConcrete', () => {
    // Plan = tile here: x, y across, z up.
    const frame = { up: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], toPlan: (p: number[]) => p } as unknown as Parameters<typeof underpinConcrete>[1];
    // A pier's face, 2 m wide along x, from its base at `base` up to 12 m.
    const face = (base: number) => Float64Array.from([0, 0, base, 2, 0, base, 2, 0, 12, 0, 0, base, 2, 0, 12, 0, 0, 12]);
    const flat = (h: number) => ({ at: () => h, lowest: () => h });
    const never = () => false;

    it('carries a face built on the ground down to the land graded under it', () => {
        const w = underpinConcrete(face(4), frame, flat(1), flat(5), never)!;
        const zs = Array.from(w.positions).filter((_, i) => i % 3 === 2);
        assert.equal(w.indices.length, 6);
        assert.ok(Math.abs(Math.max(...zs) - 4) < 1e-6);
        assert.ok(Math.abs(Math.min(...zs) - 0.5) < 1e-6, `foot ${Math.min(...zs)}`);
        // Facing the way the face does (-y, or +y: the face's own normal).
        const n = [w.normals[0], w.normals[1], w.normals[2]];
        assert.ok(Math.abs(Math.abs(n[1]) - 1) < 1e-6 && n[2] === 0);
    });
    it('leaves a face standing over the ground it was built on (a deck side) alone', () => {
        assert.equal(underpinConcrete(face(9), frame, flat(1), flat(5), never), undefined);
    });
    it('leaves a face alone where the land still reaches it', () => {
        assert.equal(underpinConcrete(face(4), frame, flat(4), flat(5), never), undefined);
    });
    it('builds nothing on a road', () => {
        assert.equal(underpinConcrete(face(4), frame, flat(1), flat(5), () => true), undefined);
    });
});

describe('cutLandAtWalls', () => {
    const Qc = 0.01;
    const frame = { up: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], toPlan: (p: number[]) => p } as unknown as Parameters<typeof cutLandAtWalls>[2];
    // A ramp from 0 m at u = 0 up to 4 m at u = 4, 10 m wide: two facets sharing the diagonal.
    const ramp = () => {
        const tris = [[0, 0, 0, 4, 0, 4, 4, 10, 4], [0, 0, 0, 4, 10, 4, 0, 10, 0]];
        return { positions: Int16Array.from(tris.flat().map(x => Math.round(x / Qc))), normals: new Int8Array(24), attrs: new Uint8Array(24).fill(100) };
    };
    // A face along u = 2 from v = 2 to v = 8, looking at -u (the low side), its top 4 m, its foot 0.
    const piece = { a: { u: 2, v: 2, top: 4.05, reach: 2 }, b: { u: 2, v: 8, top: 4.05, reach: 2 }, bottom: -0.5, ou: -1, ov: 0 };
    const corners = (s: { positions: Int16Array }) => {
        const out: number[][][] = [];
        for (let t = 0; t < s.positions.length / 9; t++) {
            out.push([0, 1, 2].map(k => [0, 1, 2].map(m => s.positions[t * 9 + k * 3 + m] * Qc)));
        }
        return out;
    };
    const heightsAt = (s: { positions: Int16Array }, u: number, v: number) => {
        const hs: number[] = [];
        for (const P of corners(s)) {
            const det = (P[1][1] - P[2][1]) * (P[0][0] - P[2][0]) + (P[2][0] - P[1][0]) * (P[0][1] - P[2][1]);
            if (Math.abs(det) < 1e-9) {
                continue;
            }
            const l1 = ((P[1][1] - P[2][1]) * (u - P[2][0]) + (P[2][0] - P[1][0]) * (v - P[2][1])) / det;
            const l2 = ((P[2][1] - P[0][1]) * (u - P[2][0]) + (P[0][0] - P[2][0]) * (v - P[2][1])) / det;
            if (Math.min(l1, l2, 1 - l1 - l2) >= -1e-6) {
                hs.push(l1 * P[0][2] + l2 * P[1][2] + (1 - l1 - l2) * P[2][2]);
            }
        }
        return hs;
    };

    it('steps the land at a face: down at its foot in front, up at its top behind', () => {
        const r = cutLandAtWalls(ramp(), Qc, frame, [piece]);
        assert.equal(r.cut, 2);
        for (const v of [3, 5, 7]) {
            assert.ok(Math.max(...heightsAt(r.soup, 1.9, v)) <= 0.05, `front ${heightsAt(r.soup, 1.9, v)}`);
            assert.ok(Math.min(...heightsAt(r.soup, 2.2, v)) >= 3.7, `behind ${heightsAt(r.soup, 2.2, v)}`);
        }
    });
    it('cuts the shared edge alike from both sides, so no crack opens', () => {
        const r = cutLandAtWalls(ramp(), Qc, frame, [piece]);
        // Where the step (0.15 m behind the face) crosses the shared
        // diagonal: the same two heights, foot and top, from the facets either side of it.
        const at = new Map<number, Set<number>>();
        corners(r.soup).forEach((tri, i) => {
            for (const p of tri) {
                if (Math.abs(p[0] - 2.15) < 0.011 && Math.abs(p[1] - 5.375) < 0.011) {
                    (at.get(Math.round(p[2] * 100)) ?? at.set(Math.round(p[2] * 100), new Set()).get(Math.round(p[2] * 100))!).add(i < 2 ? 0 : 1);
                }
            }
        });
        assert.deepEqual([...at.keys()].sort((x, y) => x - y), [0, 375]);
    });
    it('does not step past the piece: the land runs on as it was beyond its ends', () => {
        const short = { ...piece, a: { ...piece.a, v: 4 }, b: { ...piece.b, v: 4.5 } };
        // The diagonal crosses u = 2 at v = 5, past the short piece: no step anywhere there.
        const r = cutLandAtWalls(ramp(), Qc, frame, [short]);
        for (const h of heightsAt(r.soup, 1.9, 9)) {
            assert.ok(Math.abs(h - 1.9) < 0.05, `beyond the end ${h}`);
        }
    });
    it('gives a facet left whole the corner the cut put on the edge it shares', () => {
        // The ramp plus a facet below it, sharing its bottom edge; a face from v = 4 to 8.
        const land = ramp();
        const below = [0, 0, 0, 4, -5, 4, 4, 0, 4].map(x => Math.round(x / Qc));
        const positions = new Int16Array(27);
        positions.set(land.positions);
        positions.set(below, 18);
        const long = { ...piece, a: { ...piece.a, v: 4 }, b: { ...piece.b, v: 8 } };
        const r = cutLandAtWalls({ positions, normals: new Int8Array(36), attrs: new Uint8Array(36).fill(100) }, Qc, frame, [long]);
        // The step line (u = 2.15) crosses the shared bottom edge past the piece: a plain corner there, in both.
        const at = (p: number[]) => Math.abs(p[0] - 2.15) < 0.011 && Math.abs(p[1]) < 0.011;
        const tris = corners(r.soup);
        const users = tris.filter(tri => tri.some(at));
        // At least one triangle each side of the edge (v > 0 above, v < 0 below).
        assert.ok(users.some(tri => tri.some(p => p[1] > 0.01)), 'above');
        assert.ok(users.some(tri => tri.some(p => p[1] < -0.01)), 'below');
    });
    it('never steps an edge along the tile border', () => {
        // The bottom edge (v = 0) as the border: a wall piece crossing it there steps nothing on it.
        const across = { ...piece, a: { ...piece.a, v: -1 } };
        const r = cutLandAtWalls(ramp(), Qc, frame, [across], (_u, v) => v === 0);
        assert.deepEqual([...new Set(heightsAt(r.soup, 2, 0.001).map(h => Math.round(h * 10) / 10))], [2]);
    });
});

describe('DeckCeiling', () => {
    // A deck 10 m wide (v 0..10) and 20 m long (u 0..20), its top 5 m up; plan = tile with z up.
    const frame = { up: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], toPlan: (p: number[]) => p } as unknown as ConstructorParameters<typeof DeckCeiling>[1];
    const tops = Float64Array.from([0, 0, 5, 20, 0, 5, 20, 10, 5, 0, 0, 5, 20, 10, 5, 0, 10, 5]);
    const c = new DeckCeiling(tops, frame);

    it('holds the land beside a deck under its top at its edge, rising at a batter', () => {
        assert.ok(Math.abs(c.at(10, 10)! - 4.5) < 1e-9, `at the edge ${c.at(10, 10)}`);
        assert.ok(Math.abs(c.at(10, 13)! - (4.5 + 3 / 1.5)) < 1e-9, `3 m off ${c.at(10, 13)}`);
        assert.ok(Math.abs(c.at(-6, 5)! - (4.5 + 6 / 1.5)) < 1e-9, `off its end ${c.at(-6, 5)}`);
    });
    it('says nothing far from any deck', () => {
        assert.equal(c.at(10, 40), undefined);
    });
});
