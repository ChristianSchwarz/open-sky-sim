import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ARROWS_AUTOPILOT_KEY, AUTOPILOT_KEY, COCKPIT_ACTION_KEYS, isAutopilotKey, KeyboardControlLayoutId,
    KeyboardControlLayouts, WHEEL_BRAKE_ONLY_KEY,
} from './keyboardLayouts';

const layouts = [...KeyboardControlLayouts.entries()]
    .map(([id, layout]) => ({ name: KeyboardControlLayoutId[id], keys: Object.values(layout) }));

test('every layout is covered', () => {
    assert.deepEqual(layouts.map(l => l.name).sort(), ['ARROWS', 'AZERTY', 'DVORAK', 'QWERTY', 'QWERTZ']);
});

test('no layout puts a stick key on a cockpit action key', () => {
    for (const { name, keys } of layouts) {
        const clashes = keys.filter(k => COCKPIT_ACTION_KEYS.includes(k));
        assert.deepEqual(clashes, [], `${name}: ${clashes.join(', ')} also act as cockpit keys`);
    }
});

test('the autopilot key is no stick key in any layout', () => {
    for (const { name, keys } of layouts) {
        assert.ok(!keys.includes(AUTOPILOT_KEY), `${name} flies the stick with '${AUTOPILOT_KEY}'`);
    }
    assert.notEqual(AUTOPILOT_KEY, 'a');
});

test('A toggles the autopilot in the Arrows layout only, and is no stick key there', () => {
    for (const [id, layout] of KeyboardControlLayouts) {
        const flies = Object.values(layout).includes(ARROWS_AUTOPILOT_KEY);
        assert.equal(isAutopilotKey(ARROWS_AUTOPILOT_KEY, id), id === KeyboardControlLayoutId.ARROWS);
        if (id === KeyboardControlLayoutId.ARROWS) assert.ok(!flies, 'Arrows flies the stick with a');
        assert.ok(isAutopilotKey(AUTOPILOT_KEY, id));
    }
    assert.ok(!COCKPIT_ACTION_KEYS.includes(ARROWS_AUTOPILOT_KEY));
});

test('a layout binds each key once', () => {
    for (const { name, keys } of layouts) {
        assert.equal(new Set(keys).size, keys.length, `${name} binds a key twice`);
    }
});

test('cockpit action keys are distinct, and the brake-only key is no key a keyboard has', () => {
    assert.equal(new Set(COCKPIT_ACTION_KEYS).size, COCKPIT_ACTION_KEYS.length);
    assert.ok(WHEEL_BRAKE_ONLY_KEY.length > 1);
    assert.ok(!COCKPIT_ACTION_KEYS.includes(WHEEL_BRAKE_ONLY_KEY));
});
