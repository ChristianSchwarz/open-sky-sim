import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    GRADE_STEP_M, GradeLine, ROAD_GRADE_MAX, carveGrid, decodeRgr, encodeRgr, gradeProfile,
} from './roadGrade';

describe('gradeProfile', () => {
    it('never exceeds the grade limit, even under a wall', () => {
        const ground = Array.from({ length: 60 }, (_, i) => (i < 30 ? 0 : 40));
        const d = gradeProfile(ground);
        for (let i = 1; i < d.length; i++) {
            assert.ok(Math.abs(d[i] - d[i - 1]) / GRADE_STEP_M <= ROAD_GRADE_MAX + 1e-9);
        }
    });

    it('follows ground that is already gentle', () => {
        const ground = Array.from({ length: 40 }, (_, i) => i * 0.5);
        const d = gradeProfile(ground);
        for (let i = 0; i < d.length; i++) {
            assert.ok(Math.abs(d[i] - ground[i]) <= 0.13);
        }
    });

    it('bridges a valley with an embankment rather than dipping into it', () => {
        const ground = Array.from({ length: 41 }, (_, i) => (Math.abs(i - 20) < 3 ? -30 : 0));
        const d = gradeProfile(ground);
        assert.ok(d[20] > -30);
    });

    it('holds to a lower grade when asked, never steeper', () => {
        const ground = Array.from({ length: 60 }, (_, i) => (i < 30 ? 0 : 40));
        const d = gradeProfile(ground, 0.04);
        for (let i = 1; i < d.length; i++) {
            assert.ok(Math.abs(d[i] - d[i - 1]) / GRADE_STEP_M <= 0.04 + 1e-9);
        }
    });
});

describe('carveGrid', () => {
    const bounds = { west: 10, east: 10.01, south: 50, north: 50.01 };
    const size = 33;
    const line = (h: number): GradeLine => ({
        halfM: 10,
        points: [{ lon: 10.0, lat: 50.005, h }, { lon: 10.01, lat: 50.005, h }],
    });

    it('raises the roadbed and batters it back to the ground', () => {
        const heights = new Float32Array(size * size).fill(100);
        carveGrid(heights, size, bounds, [line(110)], 0);
        const mid = 16 * size + 16;
        assert.ok(Math.abs(heights[mid] - (110)) < 1e-3);
        // Far off the road nothing changed.
        assert.equal(heights[0], 100);
        // Monotone down the batter.
        for (let gy = 17; gy < size; gy++) {
            assert.ok(heights[gy * size + 16] <= heights[(gy - 1) * size + 16]);
        }
    });

    it('cuts where the ground is above the road', () => {
        const heights = new Float32Array(size * size).fill(100);
        carveGrid(heights, size, bounds, [line(90)], 0);
        assert.ok(Math.abs(heights[16 * size + 16] - (90)) < 1e-3);
        assert.equal(heights[0], 100);
    });

    it('leaves the sea alone', () => {
        const heights = new Float32Array(size * size).fill(0);
        assert.equal(carveGrid(heights, size, bounds, [line(10)], 0), 0);
    });

    it('lets a higher-priority line win even where a lower-priority one sits nearer', () => {
        const heights = new Float32Array(size * size).fill(100);
        // Both cross the same node; low is the exact centreline (distance 0),
        // high is offset a couple of cells north (farther, but priority 1).
        const low: GradeLine = { halfM: 10, priority: 0, points: line(105).points };
        const high: GradeLine = {
            halfM: 10, priority: 1,
            points: [{ lon: 10.0, lat: 50.00531, h: 130 }, { lon: 10.01, lat: 50.00531, h: 130 }],
        };
        carveGrid(heights, size, bounds, [low, high], 0);
        const mid = 16 * size + 16;
        // The node sits just past high's core, so the batter takes a bite out
        // of 130 - but it must still land well above low's own 105.
        assert.ok(heights[mid] > 115, `expected the priority line to win, got ${heights[mid]}`);
    });

    it('round-trips through RGR1', () => {
        const back = decodeRgr(encodeRgr([line(110)]));
        assert.equal(back.length, 1);
        assert.ok(Math.abs(back[0].points[1].h - (110)) < 1e-3);
    });
});
