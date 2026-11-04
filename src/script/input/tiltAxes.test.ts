import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tiltAngles, tiltStick, upInScreen, TILT_FULL_THROW_RAD } from './tiltAxes';

const DEG = Math.PI / 180;

function close(actual: number, expected: number, what: string): void {
    assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} vs ${expected}`);
}

test('up in screen axes for the plain poses', () => {
    const flat = upInScreen(0, 0, 0);
    close(flat[2], 1, 'flat face up: up is out of the screen');
    const upright = upInScreen(90, 0, 0);
    close(upright[1], 1, 'upright portrait: up is screen up');
    // Landscape, device top to the left (angle 90), held upright: the device's
    // right side points up, which is gamma -90 in the spec's angles.
    const landscape = upInScreen(0, -90, 90);
    close(landscape[1], 1, 'upright landscape: up is screen up');
    close(landscape[0], 0, 'upright landscape: nothing sideways');
});

test('a phone held at 45 degrees reads as no stick', () => {
    const held = tiltAngles(upInScreen(45, 0, 0));
    close(held.lean, 45 * DEG, 'lean');
    close(held.bank, 0, 'bank');
    const stick = tiltStick(held, held);
    close(stick.pitch, 0, 'pitch');
    close(stick.roll, 0, 'roll');
});

test('tipping the top away pushes the nose down, toward you pulls it up', () => {
    const neutral = tiltAngles(upInScreen(45, 0, 0));
    const away = tiltStick(tiltAngles(upInScreen(45 - 10, 0, 0)), neutral);
    assert.ok(away.pitch < 0, `top away gave pitch ${away.pitch}`);
    close(away.pitch, -10 * DEG / TILT_FULL_THROW_RAD, 'ten degrees away');
    const toward = tiltStick(tiltAngles(upInScreen(45 + 10, 0, 0)), neutral);
    assert.ok(toward.pitch > 0, `top toward gave pitch ${toward.pitch}`);
});

test('turning it like a wheel rolls, whichever way the screen is turned', () => {
    for (const angle of [0, 90, 180, 270]) {
        // Build the pose in screen terms: held at 45 degrees, then the right
        // edge dipped by 10 degrees. Find device angles that give it by search.
        const neutral = tiltAngles(screenPose(angle, 45, 0));
        const right = tiltStick(tiltAngles(screenPose(angle, 45, 10)), neutral);
        assert.ok(right.roll > 0.3, `angle ${angle}: right edge down gave roll ${right.roll}`);
        assert.ok(Math.abs(right.pitch) < 0.2, `angle ${angle}: rolling pitched ${right.pitch}`);
        const left = tiltStick(tiltAngles(screenPose(angle, 45, -10)), neutral);
        assert.ok(left.roll < -0.3, `angle ${angle}: left edge down gave roll ${left.roll}`);
    }
});

test('full throw at the limit and no further', () => {
    const neutral = tiltAngles(upInScreen(45, 0, 0));
    assert.equal(tiltStick(tiltAngles(upInScreen(-30, 0, 0)), neutral).pitch, -1);
    // Positive gamma is the right edge down (the spec's "tilted right").
    assert.equal(tiltStick(tiltAngles(upInScreen(45, 60, 0)), neutral).roll, 1);
});

/**
 * Up in screen axes for a phone leaning back `leanDeg` from upright with its
 * right edge dipped `dipDeg`, found through the device angles a real phone
 * would report at that screen rotation (a coarse search, then the closest).
 */
function screenPose(angle: number, leanDeg: number, dipDeg: number): [number, number, number] {
    const lean = leanDeg * DEG;
    const dip = dipDeg * DEG;
    const want = [-Math.sin(dip), Math.cos(dip) * Math.cos(lean), Math.cos(dip) * Math.sin(lean)];
    let best: [number, number, number] = [0, 0, 1];
    let bestError = Infinity;
    for (let beta = -180; beta <= 180; beta += 0.5) {
        for (let gamma = -90; gamma <= 90; gamma += 0.5) {
            const up = upInScreen(beta, gamma, angle);
            const error = Math.hypot(up[0] - want[0], up[1] - want[1], up[2] - want[2]);
            if (error < bestError) {
                bestError = error;
                best = up;
            }
        }
    }
    assert.ok(bestError < 0.02, `no device pose for angle ${angle}: ${bestError}`);
    return best;
}
