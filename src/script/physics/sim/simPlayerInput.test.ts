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

test('the autopilot key switches the autopilot off again; nothing else gets through while it flies', () => {
    const input = new SimPlayerInput();
    let toggles = 0;
    let gear = 0;
    const flying: SimPlayerInputSink = {
        ...sink,
        control: 'ai',
        toggleAutopilot: () => { toggles++; },
        toggleGear: () => { gear++; },
    };
    input.keyDown('g', false, flying);
    input.keyDown('a', true, flying);
    assert.equal(gear, 0, 'gear key acted while the autopilot flew');
    assert.equal(toggles, 0, 'a held-key repeat toggled the autopilot');
    input.keyDown('a', false, flying);
    assert.equal(toggles, 1);
});

test('held roll key ramps the stick to full throw, neutral on release', () => {
    const input = arrowsInput(KeyboardPitchStickMode.LAYOUT_DEFAULT);
    input.keyDown('arrowright', false, sink);
    const first = input.tick(0.016, sink).roll;
    assert.ok(first > 0 && first < 0.05, `first tick ${first}`);
    let roll = first;
    for (let i = 0; i < 10; i++) {
        const next = input.tick(0.016, sink).roll;
        assert.ok(next > roll, 'stick keeps moving while held');
        roll = next;
    }
    assert.ok(roll < 1, 'not at full throw after a sixth of a second');
    for (let i = 0; i < 60; i++) {
        roll = input.tick(0.016, sink).roll;
    }
    assert.equal(roll, 1);
    input.keyUp('arrowright', sink);
    assert.equal(input.tick(0.016, sink).roll, 0);
});
