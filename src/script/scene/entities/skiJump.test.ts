import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    createSkiJumpCollider,
    sampleSkiJumpSurfaceY,
    skiJumpDeckHeight,
    SKI_JUMP_HEIGHT_M,
    SKI_JUMP_LENGTH_M,
} from './skiJump';
import { NO_SURFACE_Y } from './carrierDeck';

describe('ski jump surface', () => {
    const ramp = createSkiJumpCollider(1500, 0, -845, 0);

    it('is flat at the base and rises to tip height on a cosine curve', () => {
        assert.equal(sampleSkiJumpSurfaceY(1500, -845, ramp), 0);
        const tipZ = -845 + SKI_JUMP_LENGTH_M;
        assert.ok(
            Math.abs(sampleSkiJumpSurfaceY(1500, tipZ, ramp) - SKI_JUMP_HEIGHT_M) < 1e-6,
            'tip should reach full height',
        );
        assert.equal(SKI_JUMP_HEIGHT_M, 12);
        const midZ = -845 + SKI_JUMP_LENGTH_M * 0.5;
        const expectedMid = skiJumpDeckHeight(0.5, SKI_JUMP_HEIGHT_M);
        assert.ok(expectedMid < SKI_JUMP_HEIGHT_M * 0.5, 'curve stays below linear mid');
        assert.ok(
            Math.abs(sampleSkiJumpSurfaceY(1500, midZ, ramp) - expectedMid) < 1e-6,
            'midpoint follows cosine arc',
        );
    });

    it('reports no surface outside the footprint', () => {
        assert.equal(sampleSkiJumpSurfaceY(1500, -900, ramp), NO_SURFACE_Y);
        assert.equal(sampleSkiJumpSurfaceY(1600, -800, ramp), NO_SURFACE_Y);
    });

    it('adds originY so the ramp sits on raised terrain / pavement', () => {
        const baseY = 51.5;
        const raised = createSkiJumpCollider(0, baseY, 0, 0);
        assert.equal(sampleSkiJumpSurfaceY(0, 0, raised), baseY);
        const tipZ = SKI_JUMP_LENGTH_M;
        assert.ok(
            Math.abs(sampleSkiJumpSurfaceY(0, tipZ, raised) - (baseY + SKI_JUMP_HEIGHT_M)) < 1e-6,
            'tip is base + deck height',
        );
        // Outside reports no surface so Math.max with DEM/pad can win — which
        // 0 does not do where the DEM sits below the tangent plane.
        assert.equal(sampleSkiJumpSurfaceY(100, 0, raised), NO_SURFACE_Y);
    });
});
