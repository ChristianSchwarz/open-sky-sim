import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLEARANCE_M, DECK_THICKNESS_M } from './bridges';
import { CROSSING_GRADE_MOTORWAY, CROSSING_GRADE_OTHER, CrossingEnv, CrossingSpan, RoadPiece, planCrossings } from './crossings';

const LAT = 50, LON = 10;
const kx = 111320 * Math.cos((LAT * Math.PI) / 180), ky = 111320;
const at = (x: number, y: number) => ({ lon: LON + x / kx, lat: LAT + y / ky });
const flat: CrossingEnv = { ground: () => 100, roadH: () => 100 };

// A 120 m beam bridge along x, a road running along y across its middle, and
// approach roads continuing the bridge's line on both sides.
const span: CrossingSpan = { structure: 'beam', points: [at(0, 0), at(120, 0)] };
const approachW: RoadPiece = { cls: 3, halfM: 4, points: [at(0, 0), at(-400, 0)] };
const approachE: RoadPiece = { cls: 3, halfM: 4, points: [at(120, 0), at(520, 0)] };
const cross = (cls: number): RoadPiece => ({ cls, halfM: 5, points: [at(60, -200), at(60, 200)] });

describe('planCrossings', () => {
    it('keeps a motorway to 4.5 % where it has to give way', () => {
        const lines = planCrossings([span], [{ ...approachW, cls: 0 }, { ...approachE, cls: 0 }, cross(0)], flat);
        assert.ok(lines.length > 0);
        for (const l of lines) {
            for (let i = 1; i < l.points.length; i++) {
                const m = Math.hypot((l.points[i].lon - l.points[i - 1].lon) * kx, (l.points[i].lat - l.points[i - 1].lat) * ky);
                assert.ok(Math.abs(l.points[i].h - l.points[i - 1].h) / m <= CROSSING_GRADE_MOTORWAY + 1e-6);
            }
        }
    });

    it('sinks a smaller road under a bigger bridge, on a 12 degree cone', () => {
        const lines = planCrossings([span], [approachW, approachE, cross(6)], flat);
        assert.equal(lines.length, 1);
        const cap = 100 - DECK_THICKNESS_M.beam - CLEARANCE_M;
        const low = Math.min(...lines[0].points.map(p => p.h));
        assert.ok(Math.abs(low - cap) < 1e-6);
        const pts = lines[0].points;
        for (let i = 1; i < pts.length; i++) {
            const m = Math.hypot((pts[i].lon - pts[i - 1].lon) * kx, (pts[i].lat - pts[i - 1].lat) * ky);
            assert.ok(Math.abs(pts[i].h - pts[i - 1].h) / m <= CROSSING_GRADE_OTHER + 1e-6);
        }
    });

    it('lifts a minor bridge whole and ramps its approaches at 12 degrees', () => {
        const lines = planCrossings([span], [approachW, approachE, cross(1)], flat);
        assert.equal(lines.length, 2);
        const top = 100 + CLEARANCE_M + DECK_THICKNESS_M.beam;
        for (const l of lines) {
            assert.ok(Math.abs(l.points[0].h - top) < 1e-6);
            for (let i = 1; i < l.points.length; i++) {
                const m = Math.hypot((l.points[i].lon - l.points[i - 1].lon) * kx, (l.points[i].lat - l.points[i - 1].lat) * ky);
                assert.ok(Math.abs(l.points[i].h - l.points[i - 1].h) / m <= CROSSING_GRADE_OTHER + 1e-6);
            }
        }
    });

    it('raises a smaller bridge on ramps when the road under it is bigger', () => {
        // Equal class 0: the bridge rises, at the motorway grade, so it needs fill.
        const lines = planCrossings([span], [{ ...approachW, cls: 0 }, { ...approachE, cls: 0 }, cross(0)], flat);
        assert.equal(lines.length, 2);
        const need = 100 + CLEARANCE_M + DECK_THICKNESS_M.beam;
        for (const l of lines) {
            // Starts at the abutment on the cone and falls to the ground.
            const m = Math.hypot((l.points[0].lon - LON) * kx, (l.points[0].lat - LAT) * ky);
            assert.ok(l.points[0].h > 100);
            assert.ok(Math.abs(l.points[0].h - need) < 1e-6);
            assert.ok(Math.abs(l.points[l.points.length - 1].h - 100) < 1e-6 || l.points.length >= 2);
            assert.ok(m >= 0);
        }
    });

    it('leaves the bigger road alone', () => {
        const lines = planCrossings([span], [{ ...approachW, cls: 0 }, { ...approachE, cls: 0 }, cross(0)], flat);
        assert.ok(lines.every(l => l.halfM === 4));
    });

    it('does nothing where the deck already clears the road', () => {
        const env: CrossingEnv = { ground: () => 100, roadH: (lon, lat) => (Math.abs(lon - (LON + 60 / kx)) < 1e-4 ? 80 : 100) };
        assert.equal(planCrossings([span], [approachW, approachE, cross(6)], env).length, 0);
    });

    it('ignores a road that runs along the span', () => {
        const along: RoadPiece = { cls: 6, halfM: 3, points: [at(-50, 2), at(200, 2)] };
        assert.equal(planCrossings([span], [approachW, approachE, along], flat).length, 0);
    });
});
