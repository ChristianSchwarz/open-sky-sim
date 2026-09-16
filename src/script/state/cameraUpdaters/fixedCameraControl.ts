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

/** Held key codes → the rates they ask for. */
export function wantedFixedCameraRates(
    held: ReadonlySet<string>, speedMps: number, turnDegPerS: number,
): FixedCameraRates {
    const speed = speedMps * (held.has('ShiftLeft') || held.has('ShiftRight') ? 10 : 1);
    const axis = (plus: string, minus: string) => (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
    return {
        forward: speed * axis('ArrowUp', 'ArrowDown'),
        right: speed * axis('ArrowRight', 'ArrowLeft'),
        up: speed * axis('PageUp', 'PageDown'),
        yaw: turnDegPerS * axis('Numpad6', 'Numpad4'),
        pitch: turnDegPerS * axis('Numpad8', 'Numpad2'),
    };
}

/**
 * Ease `rates` toward `want` over `delta` seconds with time constant `tau`,
 * so a tap nudges and a release coasts to a stop. Returns whether anything
 * is still moving.
 */
export function easeFixedCameraRates(
    rates: FixedCameraRates, want: FixedCameraRates, delta: number, tau: number,
): boolean {
    const k = 1 - Math.exp(-delta / tau);
    let moving = false;
    for (const key of Object.keys(rates) as (keyof FixedCameraRates)[]) {
        rates[key] += (want[key] - rates[key]) * k;
        if (Math.abs(rates[key]) < 1e-3) {
            rates[key] = 0;
        }
        moving ||= rates[key] !== 0;
    }
    return moving;
}
