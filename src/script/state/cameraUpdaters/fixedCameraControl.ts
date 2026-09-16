/** Rates the fixed camera is moving at: metres per second and degrees per second. */
export interface FixedCameraRates {
    forward: number;
    right: number;
    up: number;
    yaw: number;
    pitch: number;
}

export function zeroFixedCameraRates(): FixedCameraRates {
    return { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0 };
}

/** Direction each key pair asks for: +1, -1 or 0. */
export interface FixedCameraInput {
    forward: number;
    right: number;
    up: number;
    yaw: number;
    pitch: number;
}

/** Held key codes -> the direction on each axis. */
export function fixedCameraInput(held: ReadonlySet<string>): FixedCameraInput {
    const axis = (plus: string, minus: string) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    return {
        forward: axis('ArrowUp', 'ArrowDown'),
        right: axis('ArrowRight', 'ArrowLeft'),
        up: axis('PageUp', 'PageDown'),
        yaw: axis('Numpad6', 'Numpad4'),
        pitch: axis('Numpad8', 'Numpad2'),
    };
}

export interface FixedCameraTuning {
    /** Speed a move starts at, m/s. */
    startMps: number;
    /** Speed a held move never exceeds, m/s. */
    maxMps: number;
    /** Factor the speed grows by per second held. */
    growthPerS: number;
    /** Turn rate on the numpad, deg/s. */
    turnDegPerS: number;
    /** Time constant for easing turns in and every axis out, seconds. */
    easeS: number;
}

const MOVE_AXES = ['forward', 'right', 'up'] as const;
const TURN_AXES = ['yaw', 'pitch'] as const;

/**
 * Advance `rates` by `delta` seconds. A held move key accelerates: the
 * speed starts at `startMps` and multiplies by `growthPerS` every second
 * until `maxMps`, so a tap nudges and a long press covers ground. Turns ease
 * to a fixed rate. Anything released coasts to a stop. Returns whether
 * something is still moving.
 */
export function stepFixedCameraRates(
    rates: FixedCameraRates, input: FixedCameraInput, delta: number, t: FixedCameraTuning,
): boolean {
    const k = 1 - Math.exp(-delta / t.easeS);
    const settle = (key: keyof FixedCameraRates) => {
        rates[key] -= rates[key] * k;
        if (Math.abs(rates[key]) < 1e-3) {
            rates[key] = 0;
        }
    };
    for (const key of MOVE_AXES) {
        const dir = input[key];
        if (dir === 0) {
            settle(key);
            continue;
        }
        const along = rates[key] * dir;
        const speed = along < t.startMps
            ? t.startMps
            : Math.min(t.maxMps, along * Math.pow(t.growthPerS, delta));
        rates[key] = dir * speed;
    }
    for (const key of TURN_AXES) {
        const want = input[key] * t.turnDegPerS;
        rates[key] += (want - rates[key]) * k;
        if (want === 0 && Math.abs(rates[key]) < 1e-3) {
            rates[key] = 0;
        }
    }
    return [...MOVE_AXES, ...TURN_AXES].some(key => rates[key] !== 0);
}
