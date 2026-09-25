import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PITCH_STICK_AFT_UNITS } from '../../defs';
import { KeyboardControlLayoutId, KeyboardPitchStickMode } from '../../input/keyboardLayouts';
import { FcsPitchLimiter } from '../fm2/fcs';
import { SimPlayerInput, SimPlayerInputSink } from './simPlayerInput';

const sink: SimPlayerInputSink = {
    control: 'external',
    health: 100,
    isLanded: () => false,
    isOnGround: () => false,
    isCrashed: () => false,
    getThrottle: () => 0.5,
    getAfterburner: () => false,
    isGearDeployed: () => false,
    isFlapsExtended: () => false,
    isAirbrakesExtended: () => false,
    isHookDeployed: () => false,
    toggleGear: () => {},
    toggleFlaps: () => {},
    toggleAirbrakes: () => {},
    toggleHook: () => {},
    toggleAutopilot: () => {},
    setPitchLimiterMode: (_mode: FcsPitchLimiter) => {},
};

function arrowsInput(mode: KeyboardPitchStickMode): SimPlayerInput {
    const input = new SimPlayerInput();
    input.setKeyboardLayout(KeyboardControlLayoutId.ARROWS);
    input.setKeyboardPitchStickMode(mode);
    return input;
}

test('layout default on Arrows: a press steps one unit and latches on release', () => {
    const input = arrowsInput(KeyboardPitchStickMode.LAYOUT_DEFAULT);
    input.keyDown('arrowdown', false, sink);
    assert.equal(input.tick(0.016, sink).pitch, 1 / PITCH_STICK_AFT_UNITS);
    input.keyUp('arrowdown', sink);
    assert.equal(input.tick(0.016, sink).pitch, 1 / PITCH_STICK_AFT_UNITS);
});

test('hold mode on Arrows: full deflection while held, neutral on release', () => {
    const input = arrowsInput(KeyboardPitchStickMode.HOLD);
    input.keyDown('arrowdown', false, sink);
    assert.equal(input.tick(0.016, sink).pitch, 1);
    assert.equal(input.tick(0.5, sink).pitch, 1);
    input.keyUp('arrowdown', sink);
    assert.equal(input.tick(0.016, sink).pitch, 0);
    input.keyDown('arrowup', false, sink);
    assert.equal(input.tick(0.016, sink).pitch, -1);
    input.keyUp('arrowup', sink);
    assert.equal(input.tick(0.016, sink).pitch, 0);
});

test('hold mode mirrors full stick units for the HUD', () => {
    const input = arrowsInput(KeyboardPitchStickMode.HOLD);
    input.keyDown('arrowdown', false, sink);
    input.tick(0.016, sink);
    const mirror = {
        pitch: 0, roll: 0, yaw: 0, throttle: 0, pitchStickUnits: 0, wheelBrakes: false,
        limitersEnabled: true, pitchLimiterMode: FcsPitchLimiter.SOFT, autopilot: false,
    };
    input.readMirror(mirror, 'external');
    assert.equal(mirror.pitchStickUnits, PITCH_STICK_AFT_UNITS);
});

test('switching mode mid-hold neutralises the stick', () => {
    const input = arrowsInput(KeyboardPitchStickMode.LAYOUT_DEFAULT);
    input.keyDown('arrowdown', false, sink);
    input.tick(0.016, sink);
    input.setKeyboardPitchStickMode(KeyboardPitchStickMode.HOLD);
    assert.equal(input.tick(0.016, sink).pitch, 0);
});
