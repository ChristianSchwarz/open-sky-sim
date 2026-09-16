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

/** How pitch keys map to stick deflection. */
export enum KeyboardPitchStickMode {
    /** Arrows layout: latched stepped stick; letter layouts: full deflection while held. */
    LAYOUT_DEFAULT,
    /** Full deflection while a pitch key is held, neutral on release, whatever the layout. */
    HOLD,
}
