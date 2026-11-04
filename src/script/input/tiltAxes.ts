import { clamp, wrapPi } from "../utils/math";

/** Tilt from the held position that gives full stick deflection. */
export const TILT_FULL_THROW_RAD = 25 * Math.PI / 180;

/** The phone's tilt as a pilot reads it, in radians. */
export interface TiltAngles {
    /** Right edge down is positive, as the stick rolls right. */
    bank: number;
    /** Angle of the screen back from upright: 0 held upright, pi/2 lying face up. */
    lean: number;
}

/**
 * The world's up direction in screen axes (x right, y up, z out of the
 * screen toward the player), from a `deviceorientation` event's beta and
 * gamma (degrees) and the screen's rotation (`screen.orientation.angle`).
 * The device frame is the spec's: alpha about z, then beta about x, then
 * gamma about y. Alpha (compass heading) does not change where up is.
 */
export function upInScreen(betaDeg: number, gammaDeg: number, screenAngleDeg: number): [number, number, number] {
    const beta = betaDeg * Math.PI / 180;
    const gamma = gammaDeg * Math.PI / 180;
    // Device frame: up = R^T (0, 0, 1) for R = Rz(alpha) Rx(beta) Ry(gamma).
    const dx = -Math.cos(beta) * Math.sin(gamma);
    const dy = Math.sin(beta);
    const dz = Math.cos(beta) * Math.cos(gamma);
    // A screen turned by `angle` (90 = landscape with the device's top to the
    // left) has its right along the device's -y and its up along the device's +x.
    const a = screenAngleDeg * Math.PI / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [dx * c - dy * s, dx * s + dy * c, dz];
}

export function tiltAngles(up: readonly [number, number, number]): TiltAngles {
    const [x, y, z] = up;
    const length = Math.hypot(x, y, z) || 1;
    return {
        // Right edge down tips up toward the screen's left.
        bank: Math.asin(clamp(-x / length, -1, 1)),
        lean: Math.atan2(z, y),
    };
}

/**
 * Stick axes from the tilt away from where the phone was held when tilt
 * steering was switched on: tip the top away for nose down, toward you for
 * nose up (as pushing and pulling a yoke), and turn it like a wheel to roll.
 * Unshaped, in -1..1; the caller applies its dead zone and curve.
 */
export function tiltStick(now: TiltAngles, neutral: TiltAngles): { pitch: number; roll: number } {
    return {
        pitch: clamp(-wrapPi(now.lean - neutral.lean) / TILT_FULL_THROW_RAD, -1, 1),
        roll: clamp((now.bank - neutral.bank) / TILT_FULL_THROW_RAD, -1, 1),
    };
}
