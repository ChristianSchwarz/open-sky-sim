import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    BELLY_FATAL_HARDNESS, BELLY_SOFT_HARDNESS, BELLY_SOFT_SPEED_MPS, bellyHardness,
} from './landingLimits';

const MIN_PITCH = -12 * Math.PI / 180;

describe('bellyHardness', () => {
    it('is the sink rate for a level, slow touchdown', () => {
        assert.equal(bellyHardness(3, 60, 0, 0, MIN_PITCH), 3);
    });

    it('rises with speed beyond the soft limit, to fatal at the fatal speed', () => {
        assert.ok(bellyHardness(1, BELLY_SOFT_SPEED_MPS, 0, 0, MIN_PITCH) <= BELLY_SOFT_HARDNESS);
        const mid = bellyHardness(1, 125, 0, 0, MIN_PITCH);
        assert.ok(mid > BELLY_SOFT_HARDNESS && mid < BELLY_FATAL_HARDNESS);
        assert.ok(bellyHardness(1, 141, 0, 0, MIN_PITCH) > BELLY_FATAL_HARDNESS);
    });

    it('counts bank and a nose-down attitude too', () => {
        assert.ok(bellyHardness(0, 60, 0.7, 0, MIN_PITCH) > BELLY_SOFT_HARDNESS);
        assert.ok(bellyHardness(0, 60, 1.0, 0, MIN_PITCH) > BELLY_FATAL_HARDNESS);
        assert.ok(bellyHardness(0, 60, 0, -0.3, MIN_PITCH) > BELLY_SOFT_HARDNESS);
        assert.equal(bellyHardness(0, 60, 0, 0.2, MIN_PITCH), 0);
    });
});
