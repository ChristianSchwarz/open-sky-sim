import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PtrTile, ROAD_SIDE_BIT, RoadClass } from './ptr';
import { BED_TIERS, LandSoup, layRailBeds } from './railBed';

const Q = 0.05;
const LIFT = 0.7;

/** Flat at 100 m with a 6 m dip across x = 0, 120 m wide, running along z. */
const groundAt = (x: number) => 100 - 6 * Math.max(0, 1 - Math.abs(x) / 60);

/** A 400 x 400 m soup of 20 m cells, y up. */
function soup(): LandSoup {
    const pos: number[] = [];
    for (let i = -10; i < 10; i++) {
        for (let j = -10; j < 10; j++) {
            const x0 = i * 20, x1 = x0 + 20, z0 = j * 20, z1 = z0 + 20;
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

interface Line {
    cls: RoadClass;
    /** Half width, metres. */
    half: number;
    /** Plan points (x, z), metres. */
    pts: Array<[number, number]>;
}

/** Stroke pairs and quads for some lines, draped on groundAt; and where each line's pairs start. */
function strokes(lines: Line[]): { tile: PtrTile; first: number[] } {
    const pos: number[] = [];
    const dir: number[] = [];
    const half: number[] = [];
    const idx: number[] = [];
    const first: number[] = [];
    for (const line of lines) {
        const start = pos.length / 3;
        first.push(start);
        line.pts.forEach(([x, z], i) => {
            for (const k of [0, 1]) {
                pos.push(Math.round(x / Q), Math.round((groundAt(x) + LIFT) / Q), Math.round(z / Q));
                dir.push(0, 0, 0, line.cls | (k ? ROAD_SIDE_BIT : 0));
                half.push(Math.round(line.half * 10));
            }
            if (i > 0) {
                const l0 = start + (i - 1) * 2, l1 = l0 + 2;
                idx.push(l0, l0 + 1, l1 + 1, l0, l1 + 1, l1);
            }
        });
    }
    const n = pos.length / 3;
    return {
        tile: {
            id: { z: 12, x: 0, y: 0 }, quantScale: Q, positions: Int16Array.from(pos), directions: Int8Array.from(dir),
            halfWidths: Uint16Array.from(half), along: new Uint16Array(n), flags: new Uint8Array(n), indices: Uint16Array.from(idx),
        },
        first,
    };
}

const along = (from: number, to: number, step: number, at: (s: number) => [number, number]) => {
    const out: Array<[number, number]> = [];
    for (let s = from; s <= to + 1e-9; s += step) {
        out.push(at(s));
    }
    return out;
};

/** Surface height (stroke minus lift) of a line's i-th point. */
const surface = (P: Int16Array, first: number, i: number) => P[(first + i * 2) * 3 + 1] * Q - LIFT;

/** The highest land over (x, z), from the soup's triangles. */
const landAt = (P: Int16Array, x: number, z: number): number | undefined => {
    let best: number | undefined;
    for (let t = 0; t < P.length / 9; t++) {
        const a = [P[t * 9] * Q, P[t * 9 + 1] * Q, P[t * 9 + 2] * Q];
        const b = [P[t * 9 + 3] * Q, P[t * 9 + 4] * Q, P[t * 9 + 5] * Q];
        const c = [P[t * 9 + 6] * Q, P[t * 9 + 7] * Q, P[t * 9 + 8] * Q];
        const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(det) < 1e-9) {
            continue;
        }
        const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
        const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) {
            continue;
        }
        const h = l1 * a[1] + l2 * b[1] + l3 * c[1];
        best = best === undefined ? h : Math.max(best, h);
    }
    return best;
};

const lay = (lines: Line[]) => {
    const s = strokes(lines);
    const result = layRailBeds({ land: soup(), quantScale: Q, strokes: s.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set() });
    assert.ok(result);
    return { result, first: s.first };
};

describe('bed tiers', () => {
    const highway: Line = { cls: RoadClass.Primary, half: 4, pts: along(-180, 180, 10, s => [s, 0]) };
    const street: Line = { cls: RoadClass.Residential, half: 2, pts: along(-150, 150, 10, s => [0, s]) };

    it('lets the higher line keep its profile, and brings the lower one to it at a crossing', () => {
        const alone = lay([highway]);
        const both = lay([highway, street]);
        // The highway does not notice the street.
        for (let i = 0; i < highway.pts.length; i++) {
            assert.equal(surface(both.result.strokePositions, both.first[0], i),
                surface(alone.result.strokePositions, alone.first[0], i), `highway point ${i}`);
        }
        // It bridged the dip on an embankment...
        const mid = highway.pts.findIndex(([x]) => x === 0);
        const top = surface(both.result.strokePositions, both.first[0], mid);
        assert.ok(top > groundAt(0) + 1, `highway at ${top.toFixed(2)} over the dip`);
        // ... and the street meets it there, ramping up within its grade.
        const cross = street.pts.findIndex(([, z]) => z === 0);
        const meet = surface(both.result.strokePositions, both.first[1], cross);
        assert.ok(Math.abs(meet - top) < 0.15, `street ${meet.toFixed(2)} vs highway ${top.toFixed(2)}`);
        const limit = BED_TIERS[3].maxGrade;
        for (let i = 0; i + 2 < street.pts.length; i++) {
            const g = Math.abs(surface(both.result.strokePositions, both.first[1], i + 2)
                - surface(both.result.strokePositions, both.first[1], i)) / 20;
            assert.ok(g <= limit + 0.01, `street ${(g * 100).toFixed(1)} % at ${street.pts[i][1]}`);
        }
    });

    it('keeps an Autobahn embankment off a street beside it: the street stays on its own ground', () => {
        const autobahn: Line = { cls: RoadClass.Motorway, half: 6, pts: along(-180, 180, 10, s => [s, 0]) };
        // A street alongside, its edge 2 m from the Autobahn's shoulder:
        // steep enough (10 %) to follow the dip the Autobahn fills.
        const side: Line = { cls: RoadClass.Residential, half: 2, pts: along(-100, 100, 10, s => [s, 11]) };
        const alone = lay([autobahn]);
        const { result, first } = lay([autobahn, side]);
        for (let i = 0; i < autobahn.pts.length; i++) {
            assert.equal(surface(result.strokePositions, first[0], i), surface(alone.result.strokePositions, alone.first[0], i));
        }
        const top = surface(result.strokePositions, first[0], autobahn.pts.findIndex(([x]) => x === 0));
        assert.ok(top > groundAt(0) + 3, `Autobahn ${top.toFixed(2)} over the dip`);
        // The street is not lifted onto the embankment's slope: graded just
        // as it would be with no Autobahn beside it...
        const own = lay([side]);
        for (let i = 0; i < side.pts.length; i++) {
            const h = surface(result.strokePositions, first[1], i), h0 = surface(own.result.strokePositions, own.first[0], i);
            assert.ok(Math.abs(h - h0) < 0.06, `street ${h.toFixed(2)} at x ${side.pts[i][0]}, ${h0.toFixed(2)} alone`);
        }
        // ... and its land stays down with it: the embankment's face ends at
        // the street's edge (steeper than 45 degrees, it gets a wall).
        const P = result.land!.positions;
        for (let v = 0; v < P.length / 3; v++) {
            const x = P[v * 3] * Q, z = P[v * 3 + 2] * Q;
            if (Math.abs(x) < 20 && Math.abs(z - 11) < 1.5) {
                // Within the street's own earthworks: smoothed, it rides up to
                // its 1.5 m over the dip's bottom.
                assert.ok(P[v * 3 + 1] * Q < groundAt(x) + BED_TIERS[3].maxEarthworkM + 0.1, `street land ${(P[v * 3 + 1] * Q).toFixed(2)} at x ${x.toFixed(1)}`);
            }
        }
    });

    it('meets at a junction without a step', () => {
        const main: Line = { cls: RoadClass.Residential, half: 2, pts: along(-150, 150, 10, s => [s, 0]) };
        const branch: Line = { cls: RoadClass.Residential, half: 2, pts: along(0, 150, 10, s => [0, s]) };
        const { result, first } = lay([main, branch]);
        const atMain = surface(result.strokePositions, first[0], main.pts.findIndex(([x]) => x === 0));
        const atBranch = surface(result.strokePositions, first[1], 0);
        assert.ok(Math.abs(atMain - atBranch) < 0.06, `main ${atMain.toFixed(2)} vs branch ${atBranch.toFixed(2)}`);
        assert.equal(result.stats.byTier[3].chains, 2);
    });

    it('lays no bed where a line has no land under it, so the land round it is not carved', () => {
        // A hole in the land at x 40..80, z -20..20 (water, a gap under a
        // bridge); a street ends in it, drawn 10 m below the land around.
        const land = soup();
        const keep: number[] = [];
        const P0 = land.positions;
        for (let t = 0; t < P0.length / 9; t++) {
            const cx = (P0[t * 9] + P0[t * 9 + 3] + P0[t * 9 + 6]) / 3 * Q, cz = (P0[t * 9 + 2] + P0[t * 9 + 5] + P0[t * 9 + 8]) / 3 * Q;
            if (!(cx > 40 && cx < 80 && cz > -20 && cz < 20)) {
                keep.push(t);
            }
        }
        const pick = <T extends Int16Array | Int8Array | Uint8Array>(a: T, per: number): T => {
            const out = new (a.constructor as new (n: number) => T)(keep.length * 3 * per);
            keep.forEach((t, i) => out.set(a.subarray(t * 3 * per, (t + 1) * 3 * per), i * 3 * per));
            return out;
        };
        const holed = { positions: pick(land.positions, 3), normals: pick(land.normals, 4), attrs: pick(land.attrs, 4) };
        const line: Line = { cls: RoadClass.Unclassified, half: 2, pts: along(-100, 60, 10, s => [s, 0]) };
        const st = strokes([line]);
        const last = (line.pts.length - 1) * 2;
        for (const v of [last, last + 1]) {
            st.tile.positions[v * 3 + 1] -= Math.round(10 / Q);
        }
        const result = layRailBeds({ land: holed, quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set() });
        const P = result?.land?.positions ?? holed.positions;
        for (let v = 0; v < P.length / 3; v++) {
            const x = P[v * 3] * Q, z = P[v * 3 + 2] * Q;
            if (x >= 30 && x <= 90 && Math.abs(z) <= 30) {
                const x0 = Math.floor(x / 20) * 20, f = (x - x0) / 20;
                const baked = groundAt(x0) * (1 - f) + groundAt(x0 + 20) * f;
                // At most a street's own cut (its end is held where drawn, and
                // it may descend to it), never the 10 m down to the drawn end.
                assert.ok(P[v * 3 + 1] * Q > baked - BED_TIERS[3].maxEarthworkM - 0.1, `land at ${x.toFixed(1)},${z.toFixed(1)} cut to ${(P[v * 3 + 1] * Q).toFixed(2)} (baked ${baked.toFixed(2)})`);
            }
        }
    });

    it('does not join two lines crossing one above the other as a junction', () => {
        // A street drawn 30 m up (an overpass with no deck baked) over a
        // street on the ground, sharing a plan point.
        const ground: Line = { cls: RoadClass.Residential, half: 2, pts: along(-150, 150, 10, s => [s, 0]) };
        const over: Line = { cls: RoadClass.Residential, half: 2, pts: along(-150, 150, 10, s => [0, s]) };
        const st = strokes([ground, over]);
        for (let i = 0; i < over.pts.length; i++) {
            for (const k of [0, 1]) {
                st.tile.positions[(st.first[1] + i * 2 + k) * 3 + 1] += Math.round(30 / Q);
            }
        }
        const result = layRailBeds({ land: soup(), quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set() });
        assert.ok(result);
        const at = ground.pts.findIndex(([x]) => x === 0);
        const h = surface(result.strokePositions, st.first[0], at);
        assert.ok(Math.abs(h - groundAt(0)) < 1.6, `the street on the ground stays down there: ${h.toFixed(2)}`);
    });

    it('ends a ramp to a bridge square at the abutment, every segment of it', () => {
        // A highway climbing 6 m onto a deck that starts at x 100 and runs on
        // to x 160; the ground beyond the abutment (under the span) is the
        // flat 100 m it was baked at.
        const deckH = 106;
        const deck = Float64Array.from([100, deckH, -6, 100, deckH, 6, 160, deckH, 6, 100, deckH, -6, 160, deckH, 6, 160, deckH, -6]);
        const ramp: Line = { cls: RoadClass.Primary, half: 4, pts: along(-150, 100, 10, s => [s, 0]) };
        const st = strokes([ramp]);
        const result = layRailBeds({
            land: soup(), quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set(),
            roadDecks: deck, deckTops: deck,
        });
        assert.ok(result);
        // It meets the deck...
        const end = surface(result.strokePositions, st.first[0], ramp.pts.length - 1);
        assert.ok(Math.abs(end - deckH) < 0.1, `ramp ends at ${end.toFixed(2)}`);
        // ... and its embankment stops there: the segment before the last
        // rounded its batter on 30 m past the abutment.
        const P = result.land!.positions;
        for (let v = 0; v < P.length / 3; v++) {
            const x = P[v * 3] * Q, z = P[v * 3 + 2] * Q;
            if (x > 100.5 && x < 140 && Math.abs(z) < 40) {
                assert.ok(P[v * 3 + 1] * Q < 100.05, `land at ${x.toFixed(1)},${z.toFixed(1)} lifted to ${(P[v * 3 + 1] * Q).toFixed(2)}`);
            }
        }
    });

    it('takes a street down under a railway bridge left on the ground, at its own grade, between walls', () => {
        // A railway deck 8 m wide across the street at z 0, its top 100.5 m
        // on 100 m ground and its underside 0.6 m lower; the street runs
        // along z at x 150, where the ground is flat.
        const top = 100.5, under = 99.9;
        const deck = Float64Array.from([140, top, -4, 160, top, 4, 160, top, -4, 140, top, -4, 140, top, 4, 160, top, 4]);
        // Outward faces: the underside winds downward.
        const concrete = Float64Array.from([140, under, -4, 160, under, -4, 160, under, 4, 140, under, -4, 160, under, 4, 140, under, 4]);
        const street: Line = { cls: RoadClass.Residential, half: 3, pts: along(-180, 180, 10, s => [150, s]) };
        const st = strokes([street]);
        const result = layRailBeds({
            land: soup(), quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set(),
            deckTops: deck, deckConcrete: concrete,
            // The bridge is kept as baked, as the game does: its abutments
            // squeeze the batters, and walls hold the cutting there.
            keep: { tris: Float64Array.from([...deck, ...concrete]) },
        });
        assert.ok(result);
        const at = (i: number) => surface(result.strokePositions, st.first[0], i);
        const mid = street.pts.findIndex(([, z]) => z === 0);
        assert.ok(at(mid) <= under - 5 + 0.1, `street under the deck at ${at(mid).toFixed(2)}`);
        const limit = BED_TIERS[3].maxGrade;
        for (let i = 0; i + 1 < street.pts.length; i++) {
            const g = Math.abs(at(i + 1) - at(i)) / 10;
            assert.ok(g <= limit + 0.02, `street ${(g * 100).toFixed(1)} % at ${street.pts[i][1]}`);
        }
        // Far off, it is on the ground still.
        assert.ok(Math.abs(at(0) - 100) < 0.2, `street end at ${at(0).toFixed(2)}`);
        // The land comes down with it, and walls hold the cutting.
        // The land's surface on the street's centreline under the deck (a
        // vertex need not lie there).
        const P = result.land!.positions;
        let lowest = Infinity;
        for (let z = -3; z <= 3; z += 0.5) {
            lowest = Math.min(lowest, landAt(P, 150, z) ?? Infinity);
        }
        assert.ok(lowest < under - 4.4, `land under the street at the deck ${lowest.toFixed(2)}`);
        assert.ok(result.stats.wallTriangles > 0, 'walls');
    });

    it('takes a road under two decks of different heights at its own grade, not a step between them', () => {
        // A primary road along z at x 150 on 100 m ground, under a deck from
        // z -10 to -4 whose underside is 104.4 m (clear 5 m under it at
        // 99.4) and then one from z 5 to 11, 3.4 m lower. Held exactly 5 m
        // under each, it dropped 3.4 m in the 9 m between them.
        const deckAt = (z0: number, z1: number, top: number) => [140, top, z0, 160, top, z1, 160, top, z0, 140, top, z0, 140, top, z1, 160, top, z1];
        const underAt = (z0: number, z1: number, y: number) => [140, y, z0, 160, y, z0, 160, y, z1, 140, y, z0, 160, y, z1, 140, y, z1];
        const deck = Float64Array.from([...deckAt(-10, -4, 105), ...deckAt(5, 11, 101.6)]);
        const concrete = Float64Array.from([...underAt(-10, -4, 104.4), ...underAt(5, 11, 101)]);
        const road: Line = { cls: RoadClass.Primary, half: 4, pts: along(-200, 200, 5, s => [150, s]) };
        const st = strokes([road]);
        const result = layRailBeds({
            land: soup(), quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set(),
            deckTops: deck, deckConcrete: concrete,
            keep: { tris: Float64Array.from([...deck, ...concrete]) },
        });
        assert.ok(result);
        const at = (i: number) => surface(result.strokePositions, st.first[0], i);
        const limit = BED_TIERS[2].maxGrade;
        let worst = 0, where = 0;
        for (let i = 0; i + 1 < road.pts.length; i++) {
            const g = Math.abs(at(i + 1) - at(i)) / 5;
            if (g > worst) {
                worst = g;
                where = road.pts[i][1];
            }
        }
        assert.ok(worst <= limit + 0.01, `road ${(worst * 100).toFixed(1)} % at ${where}`);
        // Clear under both decks still.
        for (let i = 0; i < road.pts.length; i++) {
            const z = road.pts[i][1];
            const under = z >= -10 && z <= -4 ? 104.4 : z >= 5 && z <= 11 ? 101 : undefined;
            if (under !== undefined) {
                assert.ok(at(i) - LIFT <= under - 5 + 0.1, `road at ${z} ${(at(i) - LIFT).toFixed(2)} under ${under}`);
            }
        }
    });

    it('carries a ramp across the tile border at a height the tile beyond holds too', () => {
        // A railway deck 6 m up from x 100 to 150, the track going on from
        // its end to the tile's east border at x 200: 50 m, where 3 % gives
        // 1.5 m. Held where drawn at the border, it climbed 12 %.
        const top = 106;
        const deck = Float64Array.from([100, top, -4, 100, top, 4, 150, top, 4, 100, top, -4, 150, top, 4, 150, top, -4]);
        const rail: Line = { cls: RoadClass.Rail, half: 2, pts: along(150, 200, 10, s => [s, 0]) };
        const st = strokes([rail]);
        const land = soup();
        const pinned = new Set<number>();
        for (let v = 0; v < land.positions.length / 3; v++) {
            if (land.positions[v * 3] * Q === 200) {
                pinned.add(v);
            }
        }
        // The bake's border ramp there: the tile across holds the same.
        const want = top - BED_TIERS[0].maxGrade * 0.85 * 50;
        const result = layRailBeds({
            land, quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned,
            deckEnds: Float64Array.from([150, top + LIFT, 0]), deckTops: deck, deckTopTiers: Int8Array.from([0, 0]),
            borderRamps: Float64Array.from([200, 100, 0, want - 100]),
        });
        assert.ok(result);
        const at = (i: number) => surface(result.strokePositions, st.first[0], i);
        const end = at(rail.pts.length - 1);
        assert.ok(Math.abs(end - want) < 0.2, `track at the border ${end.toFixed(2)}, both tiles hold ${want.toFixed(2)}`);
        for (let i = 0; i + 1 < rail.pts.length; i++) {
            const g = Math.abs(at(i + 1) - at(i)) / 10;
            assert.ok(g <= BED_TIERS[0].maxGrade + 0.005, `track ${(g * 100).toFixed(1)} % at ${rail.pts[i][0]}`);
        }
        // The border's land under it comes up with it.
        const P = result.land!.positions;
        let border = -Infinity;
        for (let v = 0; v < P.length / 3; v++) {
            if (P[v * 3] * Q === 200 && Math.abs(P[v * 3 + 2] * Q) < 1) {
                border = Math.max(border, P[v * 3 + 1] * Q);
            }
        }
        assert.ok(border > want - 0.5, `border land ${border.toFixed(2)}`);
    });

    it('holds a border ramp on a line whose end was draped down the skirt', () => {
        // A primary road east to the tile border at x 200, where the bake
        // lowered the crossing 2 m (a bridge to pass under beyond). Its last
        // point, on the border, was draped 50 m down the skirt: the line is
        // held 2 m under its drawn height at its own point 1 m in.
        const road: Line = { cls: RoadClass.Primary, half: 4, pts: [...along(100, 190, 10, s => [s, 0] as [number, number]), [199, 0], [200, 0]] };
        const st = strokes([road]);
        const last = (st.first[0] + (road.pts.length - 1) * 2) * 3 + 1;
        for (const o of [0, 3]) {
            st.tile.positions[last + o] = Math.round((groundAt(200) - 50 + LIFT) / Q);
        }
        const land = soup();
        const pinned = new Set<number>();
        for (let v = 0; v < land.positions.length / 3; v++) {
            if (land.positions[v * 3] * Q === 200) {
                pinned.add(v);
            }
        }
        const result = layRailBeds({
            land, quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned,
            borderRamps: Float64Array.from([200, groundAt(200), 0, -2]),
        });
        assert.ok(result);
        const at = (i: number) => surface(result.strokePositions, st.first[0], i);
        const end = at(road.pts.length - 2);
        assert.ok(Math.abs(end - (groundAt(199) - 2)) < 0.25, `road 1 m from the border ${end.toFixed(2)}, held ${(groundAt(199) - 2).toFixed(2)}`);
    });

    it('trims the skirt strays off the end they hang from, not the real points at the other', () => {
        // A street of two points 60 m apart, then two more at its far end
        // draped 40 m and 30 m down the skirt. Looking three points in from
        // the near end, the stray step past the second point trimmed the two
        // real ones: the strays were left, too short to grade, in the air.
        const road: Line = { cls: RoadClass.Residential, half: 3, pts: [[100, 0], [160, 0], [160, 0.05], [160, 0.1]] };
        const st = strokes([road]);
        for (const [i, drop] of [[2, 40], [3, 30]] as const) {
            const at = (st.first[0] + i * 2) * 3 + 1;
            for (const o of [0, 3]) {
                st.tile.positions[at + o] = Math.round((groundAt(160) - drop + LIFT) / Q);
            }
        }
        const result = layRailBeds({ land: soup(), quantScale: Q, strokes: st.tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set() });
        assert.ok(result);
        const at = (i: number) => surface(result.strokePositions, st.first[0], i);
        for (let i = 0; i < road.pts.length; i++) {
            assert.ok(Math.abs(at(i) - groundAt(road.pts[i][0])) < 0.5, `point ${i} at ${at(i).toFixed(2)}, ground ${groundAt(road.pts[i][0]).toFixed(2)}`);
        }
    });
});

describe('no terrain over roads', () => {
    /** Flat 100 m land in coarse 100 m cells, y up. */
    const flatSoup = (): LandSoup => {
        const pos: number[] = [];
        for (let i = -2; i < 2; i++) {
            for (let j = -2; j < 2; j++) {
                const x0 = i * 100, x1 = x0 + 100, z0 = j * 100, z1 = z0 + 100;
                const p = (x: number, z: number) => [x / Q, 100 / Q, z / Q];
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
    };

    it('keeps the land under a road in a cutting, between its vertices too', () => {
        // A highway along z = 7 (off the cells' diagonals), measured 3 m into
        // a cutting over its whole length.
        const line: Line = { cls: RoadClass.Primary, half: 4, pts: along(-150, 150, 10, s => [s, 7]) };
        const { tile } = strokes([line]);
        const segments = new Map<number, { centre: Float32Array; lift: Float32Array }>();
        for (let i = 0; i + 5 < tile.indices.length; i += 6) {
            segments.set(tile.indices[i], { centre: new Float32Array([97, 97]), lift: new Float32Array([-3, -3]) });
        }
        const result = layRailBeds({
            land: flatSoup(), quantScale: Q, strokes: tile, up: [0, 1, 0], liftM: LIFT, pinned: new Set(),
            measured: { segments, mode: 'rel' },
        })!;
        const P = result.land!.positions, S = result.strokePositions;
        let worst = -Infinity, checked = 0;
        for (let i = 0; i + 1 < line.pts.length; i++) {
            const a = S[(i * 2) * 3 + 1] * Q, b = S[((i + 1) * 2) * 3 + 1] * Q;
            for (let f = 0; f <= 1; f += 0.1) {
                const drawn = a + (b - a) * f;
                for (const off of [-3.8, 0, 3.8]) {
                    const land = landAt(P, line.pts[i][0] + 10 * f, 7 + off);
                    if (land !== undefined) {
                        worst = Math.max(worst, land - drawn);
                        checked++;
                    }
                }
            }
        }
        assert.ok(checked > 300, `${checked} points checked`);
        assert.ok(worst <= -0.05, `land ${worst.toFixed(2)} m over the drawn road`);
        assert.ok(result.stats.landLoweredUnderRoads + result.stats.splitForRoads >= 0);
    });
});
