import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { easeFixedCameraRates, wantedFixedCameraRates, zeroFixedCameraRates } from './fixedCameraControl';

describe('wantedFixedCameraRates', () => {
    it('maps the keys, with Shift ten times faster', () => {
        const w = wantedFixedCameraRates(new Set(['ArrowUp', 'ArrowLeft', 'PageDown', 'Numpad6', 'Numpad2', 'ShiftLeft']), 100, 45);
        assert.deepEqual(w, { forward: 1000, right: -1000, up: -1000, yaw: 45, pitch: -45 });
    });
});

describe('easeFixedCameraRates', () => {
    it('ramps up toward the target and coasts back to rest', () => {
        const r = zeroFixedCameraRates();
        const want = { ...zeroFixedCameraRates(), forward: 100 };
        assert.equal(easeFixedCameraRates(r, want, 0.3, 0.3), true);
        assert.ok(r.forward > 60 && r.forward < 65, `one tau: ${r.forward}`);
        for (let i = 0; i < 20; i++) easeFixedCameraRates(r, want, 0.3, 0.3);
        assert.ok(r.forward > 99.9);
        const rest = zeroFixedCameraRates();
        let moving = true;
        for (let i = 0; i < 20 && moving; i++) moving = easeFixedCameraRates(r, rest, 0.3, 0.3);
        assert.equal(moving, false);
        assert.equal(r.forward, 0);
    });
});
