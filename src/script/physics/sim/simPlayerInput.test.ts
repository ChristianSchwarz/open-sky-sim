import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PITCH_STICK_AFT_UNITS } from '../../defs';
import {
    AUTOPILOT_KEY, KeyboardControlLayoutId, KeyboardPitchStickMode, WHEEL_BRAKE_ONLY_KEY,
} from '../../input/keyboardLayouts';
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
    toggleWingFold: () => {},
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
    input.keyDown(AUTOPILOT_KEY, true, flying);
    assert.equal(gear, 0, 'gear key acted while the autopilot flew');
    assert.equal(toggles, 0, 'a held-key repeat toggled the autopilot');
    input.keyDown(AUTOPILOT_KEY, false, flying);
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

test('touch axes fly the stick while active and hand back to the keys when released', () => {
    const input = arrowsInput(KeyboardPitchStickMode.HOLD);
    input.setTouchAxes(0.5, -0.25, 0.1, 0.8, true);
    const touched = input.tick(0.016, sink);
    assert.equal(touched.pitch, 0.5);
    assert.equal(touched.roll, -0.25);
    assert.equal(touched.yaw, 0.1);
    assert.equal(touched.throttle, 0.8);
    input.setTouchAxes(0, 0, 0, 0, false);
    input.keyDown('arrowdown', false, sink);
    assert.equal(input.tick(0.016, sink).pitch, 1);
});

test('a connected gamepad wins over the touch axes', () => {
    const input = new SimPlayerInput();
    input.setTouchAxes(0.5, 0.5, 0, 0.8, true);
    input.setGamepadAxes(-0.3, 0, 0, 0.2, true);
    const out = input.tick(0.016, sink);
    assert.equal(out.pitch, -0.3);
    assert.equal(out.throttle, 0.2);
    input.setGamepadAxes(0, 0, 0, 0, false);
    assert.equal(input.tick(0.016, sink).pitch, 0.5);
});

test('brakes held through a touchdown engage on contact under analog input', () => {
    const input = new SimPlayerInput();
    let onGround = false;
    const landing: SimPlayerInputSink = { ...sink, isOnGround: () => onGround };
    input.setTouchAxes(0, 0, 0, 0.3, true);
    input.keyDown('w', false, landing);
    assert.equal(input.tick(0.016, landing).wheelBrakesApplied, false);
    onGround = true;
    assert.equal(input.tick(0.016, landing).wheelBrakesApplied, true);
    input.keyUp('w', landing);
    assert.equal(input.tick(0.016, landing).wheelBrakesApplied, false);
});

test('rolling left on QWERTY leaves the autopilot alone; its own key toggles it', () => {
    const input = new SimPlayerInput();
    input.setKeyboardLayout(KeyboardControlLayoutId.QWERTY);
    let toggles = 0;
    const flying: SimPlayerInputSink = { ...sink, toggleAutopilot: () => { toggles++; } };
    input.keyDown('a', false, flying);
    assert.ok(input.tick(0.016, flying).roll < 0, 'a rolls left');
    assert.equal(toggles, 0, 'rolling left engaged the autopilot');
    input.keyUp('a', flying);
    input.keyDown(AUTOPILOT_KEY, false, flying);
    assert.equal(toggles, 1);
});

test('in the Arrows layout A toggles the autopilot, on and off', () => {
    const input = new SimPlayerInput();
    input.setKeyboardLayout(KeyboardControlLayoutId.ARROWS);
    let toggles = 0;
    const manual: SimPlayerInputSink = { ...sink, toggleAutopilot: () => { toggles++; } };
    input.keyDown('a', false, manual);
    assert.equal(toggles, 1, 'a did not engage the autopilot');
    assert.equal(input.tick(0.016, manual).roll, 0, 'a moved the stick');
    input.keyUp('a', manual);
    const flying: SimPlayerInputSink = { ...manual, control: 'ai' };
    input.keyDown('a', false, flying);
    assert.equal(toggles, 2, 'a did not hand control back');
});

test('the brake-only key brakes on the ground and never pushes the nose over', () => {
    const input = new SimPlayerInput();
    input.setKeyboardLayout(KeyboardControlLayoutId.QWERTY);
    input.setKeyboardPitchStickMode(KeyboardPitchStickMode.HOLD);
    let onGround = false;
    const s: SimPlayerInputSink = { ...sink, isOnGround: () => onGround };
    input.keyDown(WHEEL_BRAKE_ONLY_KEY, false, s);
    const air = input.tick(0.016, s);
    assert.equal(air.pitch, 0, 'brake button pitched the nose down in the air');
    assert.equal(air.wheelBrakesApplied, false);
    onGround = true;
    const ground = input.tick(0.016, s);
    assert.equal(ground.wheelBrakesApplied, true, 'held through touchdown, the brakes engage');
    assert.equal(ground.pitch, 0);
    input.keyUp(WHEEL_BRAKE_ONLY_KEY, s);
    assert.equal(input.tick(0.016, s).wheelBrakesApplied, false);
});

test('the keys take over from a released gamepad at neutral, and an untaken throttle stays put', () => {
    const input = new SimPlayerInput();
    input.setKeyboardLayout(KeyboardControlLayoutId.QWERTY);
    input.syncThrottle(0.4);
    input.setGamepadAxes(0.7, -0.6, 0.3, NaN, true);
    const pad = input.tick(0.016, sink);
    assert.equal(pad.pitch, 0.7);
    assert.equal(pad.throttle, 0.4, 'a NaN throttle took the throttle');
    input.setGamepadAxes(0, 0, 0, 0, false);
    const keys = input.tick(0.016, sink);
    assert.equal(keys.pitch, 0);
    assert.equal(keys.roll, 0);
    assert.equal(keys.yaw, 0);
    assert.equal(keys.throttle, 0.4);
});
