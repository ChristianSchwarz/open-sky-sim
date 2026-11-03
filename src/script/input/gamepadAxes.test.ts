import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDeadZone, GAMEPAD_DEAD_ZONE, GamepadAxisReader } from './gamepadAxes';

test('dead zone reads zero round centre and still reaches full throw', () => {
    assert.equal(applyDeadZone(0.05), 0);
    assert.equal(applyDeadZone(-GAMEPAD_DEAD_ZONE), 0);
    assert.equal(applyDeadZone(1), 1);
    assert.equal(applyDeadZone(-1), -1);
    assert.ok(applyDeadZone(GAMEPAD_DEAD_ZONE + 0.01) > 0 && applyDeadZone(GAMEPAD_DEAD_ZONE + 0.01) < 0.02);
    assert.equal(applyDeadZone(NaN), 0);
});

test('a resting pad is idle and leaves the throttle alone', () => {
    const reader = new GamepadAxisReader();
    // A standard pad: axis 2 is a stick at rest at 0, which would read 50 %.
    const r = reader.read([0.03, -0.04, 0, 0.02], false);
    assert.equal(r.active, false);
    assert.equal(r.pitch, 0);
    assert.ok(Number.isNaN(r.throttle));
});

test('a button or a stick past the dead zone makes it active', () => {
    const reader = new GamepadAxisReader();
    assert.equal(reader.read([0, 0, 0, 0], true).active, true);
    const r = reader.read([0, 0.5, 0, 0], false);
    assert.equal(r.active, true);
    assert.ok(r.pitch > 0.4);
    assert.ok(Number.isNaN(r.throttle), 'the throttle is not taken by moving the stick');
});

test('the throttle is taken once moved from where it rested, then only when it moves', () => {
    const reader = new GamepadAxisReader();
    reader.read([0, 0, 0, 0], false);
    // Moved inside the dead zone: still not the player's.
    assert.ok(Number.isNaN(reader.read([0, 0, -0.05, 0], false).throttle));
    const taken = reader.read([0, 0, -0.6, 0], false);
    assert.equal(taken.active, true);
    assert.ok(Math.abs(taken.throttle - 0.8) < 1e-9);
    // Left where it is: idle again, so the keys can fly.
    const still = reader.read([0, 0, -0.6, 0], false);
    assert.equal(still.active, false);
    assert.ok(Number.isNaN(still.throttle));
    // Moved again: taken again.
    assert.ok(Math.abs(reader.read([0, 0, -1, 0], false).throttle - 1) < 1e-9);
    // A new pad rests wherever it rests.
    reader.reset();
    assert.ok(Number.isNaN(reader.read([0, 0, -1, 0], false).throttle));
});
