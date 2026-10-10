/**
 * How hard a touchdown was, graded instead of a cliff: a normal landing, a
 * hard one the aircraft survives (the airframe is bent and torn, see
 * WreckField.applyDamage), and a fatal one. Shared by FM2 and FM3.
 *
 * Both gear states are put on one scale, "hardness", in m/s of sink rate: a
 * gear-up landing's speed, bank and nose-down attitude are converted to the
 * sink rate that would be as bad.
 */

/** Gear down: sink rate (m/s) above which a landing is hard (the envelope's own limit), and fatal. */
export const GEAR_FATAL_SINK_MPS = 15;

/** Gear up (belly): hardness above which it is a hard landing, and above which it is fatal. */
export const BELLY_SOFT_HARDNESS = 6.5;
export const BELLY_FATAL_HARDNESS = 11;
/** Groundspeed (m/s) up to which a belly landing is not made harder by speed, and where it is fatal. */
export const BELLY_SOFT_SPEED_MPS = 110;
export const BELLY_FATAL_SPEED_MPS = 140;
/** Bank (rad) up to which a belly landing is not made harder by it, and where it is fatal. */
export const BELLY_SOFT_ROLL_RAD = 0.45;
export const BELLY_FATAL_ROLL_RAD = 0.9;

/**
 * How much of the way from "no damage" to "destroyed" a touchdown went: 0 up to
 * the soft limit, 1 at the fatal one, linear in between (hardness or sink, m/s).
 */
export function damageFraction(value: number, soft: number, fatal: number): number {
    if (value <= soft) {
        return 0;
    }
    return Math.min(1, (value - soft) / (fatal - soft));
}

/** Linear 0 below `soft`, BELLY_SOFT_HARDNESS at it, BELLY_FATAL_HARDNESS at `fatal`, beyond past it. */
function ramp(value: number, soft: number, fatal: number): number {
    if (value <= soft) {
        return 0;
    }
    return BELLY_SOFT_HARDNESS + (BELLY_FATAL_HARDNESS - BELLY_SOFT_HARDNESS) * (value - soft) / (fatal - soft);
}

/**
 * The hardness (m/s of sink, equivalent) of a gear-up touchdown. `minPitchRad`
 * is the envelope's nose-down limit (negative); twice that is fatal.
 */
export function bellyHardness(
    sinkMps: number, speedMps: number, rollRad: number, pitchRad: number, minPitchRad: number,
): number {
    const nose = Math.min(0, minPitchRad);
    return Math.max(
        sinkMps,
        ramp(speedMps, BELLY_SOFT_SPEED_MPS, BELLY_FATAL_SPEED_MPS),
        ramp(Math.abs(rollRad), BELLY_SOFT_ROLL_RAD, BELLY_FATAL_ROLL_RAD),
        nose < 0 ? ramp(-pitchRad, -nose, -2 * nose) : 0,
    );
}
