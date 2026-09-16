import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FixedCameraTuning, fixedCameraInput, stepFixedCameraRates, zeroFixedCameraRates,
} from './fixedCameraControl';

const T: FixedCameraTuning = { startMps: 20, maxMps: 3000, growthPerS: 2, turnDegPerS: 45, easeS: 0.3 };
const idle = { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0 };

describe('fixedCameraInput', () => {
    it('maps the keys to signed axes', () => {
        const w = fixedCameraInput(new Set(['ArrowUp', 'ArrowLeft', 'PageDown', 'Numpad6', 'Numpad2']));
        assert.deepEqual(w, { forward: 1, right: -1, up: -1, yaw: 1, pitch: -1 });
    });
});

describe('stepFixedCameraRates', () => {
    it('starts slow, doubles every second held, and stops at the cap', () => {
        const r = zeroFixedCameraRates();
        stepFixedCameraRates(r, { ...idle, forward: 1 }, 1 / 60, T);
        assert.equal(r.forward, 20);
        for (let i = 0; i < 60; i++) stepFixedCameraRates(r, { ...idle, forward: 1 }, 1 / 60, T);
        assert.ok(Math.abs(r.forward - 40) < 0.5, `after 1 s: ${r.forward}`);
        for (let i = 0; i < 60 * 10; i++) stepFixedCameraRates(r, { ...idle, forward: 1 }, 1 / 60, T);
        assert.equal(r.forward, 3000);
    });

    it('reverses at the start speed and coasts to rest when released', () => {
        const r = { ...zeroFixedCameraRates(), up: 500 };
        stepFixedCameraRates(r, { ...idle, up: -1 }, 1 / 60, T);
        assert.equal(r.up, -20);
        let moving = true;
        for (let i = 0; i < 300 && moving; i++) moving = stepFixedCameraRates(r, idle, 1 / 60, T);
        assert.equal(moving, false);
        assert.equal(r.up, 0);
    });

    it('eases turns toward the fixed rate', () => {
        const r = zeroFixedCameraRates();
        stepFixedCameraRates(r, { ...idle, yaw: 1 }, 0.3, T);
        assert.ok(r.yaw > 28 && r.yaw < 29, `one tau: ${r.yaw}`);
        for (let i = 0; i < 30; i++) stepFixedCameraRates(r, { ...idle, yaw: 1 }, 0.3, T);
        assert.ok(r.yaw > 44.99);
    });
});
