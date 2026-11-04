/** Shared keyboard layout definitions — used on the main thread (OSD) and in the sim worker. */

export enum KeyboardControlAction {
    PITCH_POS,
    PITCH_NEG,
    ROLL_POS,
    ROLL_NEG,
    YAW_POS,
    YAW_NEG,
    THROTTLE_POS,
    THROTTLE_NEG
}

export enum KeyboardControlLayoutId {
    QWERTY,
    QWERTZ,
    AZERTY,
    DVORAK,
    ARROWS,
}

export type KeyboardControlLayout = Record<KeyboardControlAction, string>;

const QwertyKeyboardControlLayout: KeyboardControlLayout = {
    [KeyboardControlAction.PITCH_POS]: 's',
    [KeyboardControlAction.PITCH_NEG]: 'w',
    [KeyboardControlAction.ROLL_POS]: 'd',
    [KeyboardControlAction.ROLL_NEG]: 'a',
    [KeyboardControlAction.YAW_POS]: 'e',
    [KeyboardControlAction.YAW_NEG]: 'q',
    [KeyboardControlAction.THROTTLE_POS]: 'z',
    [KeyboardControlAction.THROTTLE_NEG]: 'x',
};

const QwertzKeyboardControlLayout: KeyboardControlLayout = {
    [KeyboardControlAction.PITCH_POS]: 's',
    [KeyboardControlAction.PITCH_NEG]: 'w',
    [KeyboardControlAction.ROLL_POS]: 'd',
    [KeyboardControlAction.ROLL_NEG]: 'a',
    [KeyboardControlAction.YAW_POS]: 'e',
    [KeyboardControlAction.YAW_NEG]: 'q',
    [KeyboardControlAction.THROTTLE_POS]: 'y',
    [KeyboardControlAction.THROTTLE_NEG]: 'x',
};

const AzertyKeyboardControlLayout: KeyboardControlLayout = {
    [KeyboardControlAction.PITCH_POS]: 's',
    [KeyboardControlAction.PITCH_NEG]: 'z',
    [KeyboardControlAction.ROLL_POS]: 'd',
    [KeyboardControlAction.ROLL_NEG]: 'q',
    [KeyboardControlAction.YAW_POS]: 'e',
    [KeyboardControlAction.YAW_NEG]: 'a',
    [KeyboardControlAction.THROTTLE_POS]: 'w',
    [KeyboardControlAction.THROTTLE_NEG]: 'x',
};

const DvorakKeyboardControlLayout: KeyboardControlLayout = {
    [KeyboardControlAction.PITCH_POS]: 'o',
    [KeyboardControlAction.PITCH_NEG]: ',',
    [KeyboardControlAction.ROLL_POS]: 'e',
    [KeyboardControlAction.ROLL_NEG]: 'a',
    [KeyboardControlAction.YAW_POS]: '.',
    [KeyboardControlAction.YAW_NEG]: '\'',
    [KeyboardControlAction.THROTTLE_POS]: 'q',
    [KeyboardControlAction.THROTTLE_NEG]: 'j',
};

const ArrowsKeyboardControlLayout: KeyboardControlLayout = {
    [KeyboardControlAction.PITCH_POS]: 'arrowdown',
    [KeyboardControlAction.PITCH_NEG]: 'arrowup',
    [KeyboardControlAction.ROLL_POS]: 'arrowright',
    [KeyboardControlAction.ROLL_NEG]: 'arrowleft',
    [KeyboardControlAction.YAW_POS]: 'x',
    [KeyboardControlAction.YAW_NEG]: 'y',
    [KeyboardControlAction.THROTTLE_POS]: 'numpadadd',
    [KeyboardControlAction.THROTTLE_NEG]: 'numpadsubtract',
};

export const KeyboardControlLayouts = new Map<KeyboardControlLayoutId, KeyboardControlLayout>([
    [KeyboardControlLayoutId.QWERTY, QwertyKeyboardControlLayout],
    [KeyboardControlLayoutId.QWERTZ, QwertzKeyboardControlLayout],
    [KeyboardControlLayoutId.AZERTY, AzertyKeyboardControlLayout],
    [KeyboardControlLayoutId.DVORAK, DvorakKeyboardControlLayout],
    [KeyboardControlLayoutId.ARROWS, ArrowsKeyboardControlLayout],
]);

export function getKeyboardLayout(layoutId: KeyboardControlLayoutId): KeyboardControlLayout {
    return KeyboardControlLayouts.get(layoutId) ?? QwertyKeyboardControlLayout;
}

/**
 * Toggles the autopilot. Kept off every layout's flight keys: the worker
 * runs the layout keys and the action keys on the same press, so an
 * autopilot key that is also a stick key would engage it mid-manoeuvre.
 */
export const AUTOPILOT_KEY = 'p';

/**
 * Also toggles the autopilot in the Arrows layout, where the stick is on the
 * arrow keys and 'a' is free. The letter layouts fly with 'a' (roll left;
 * yaw left on AZERTY), so there it stays a stick key only.
 */
export const ARROWS_AUTOPILOT_KEY = 'a';

/** Whether `key` toggles the autopilot under the given layout. */
export function isAutopilotKey(key: string, layoutId: KeyboardControlLayoutId): boolean {
    return key === AUTOPILOT_KEY
        || (layoutId === KeyboardControlLayoutId.ARROWS && key === ARROWS_AUTOPILOT_KEY);
}

/**
 * Wheel brakes only, never a stick key: what the touch BRAKE button presses.
 * The keyboard's own brake key ('w') is pitch-down in the air on QWERTY and
 * QWERTZ (throttle-up on AZERTY); a finger on BRAKE must not push the nose over.
 * Not a key any keyboard produces, so it reaches only the brake handlers.
 */
export const WHEEL_BRAKE_ONLY_KEY = 'wheelbrake';

/**
 * Every key the cockpit takes outside the stick layouts (the worker's action
 * keys, the player's and the game's keypress keys). A layout key that is one
 * of these does two things at once; see keyboardLayouts.test.ts. The brake
 * key 'w' is left out: it shares a stick key on purpose, brakes on the
 * ground and the layout's action in the air.
 */
export const COCKPIT_ACTION_KEYS: readonly string[] = [
    ' ', 'f', 'g', 'b', 'h', 'l', AUTOPILOT_KEY, '1', '2', '3',
    't', 'i', 'u', 'k', '4', 'n', 'v', 'm',
];

/** How pitch keys map to stick deflection. */
export enum KeyboardPitchStickMode {
    /** Arrows layout: latched stepped stick; letter layouts: full deflection while held. */
    LAYOUT_DEFAULT,
    /** Full deflection while a pitch key is held, neutral on release, whatever the layout. */
    HOLD,
}
