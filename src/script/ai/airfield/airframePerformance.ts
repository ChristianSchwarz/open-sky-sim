/**
 * The slow end of an airframe's envelope, as an AI pilot needs it to land:
 * how slowly the aircraft can be flown at all, and how fast its wheels may
 * meet the runway. Read off the flight model's envelope config, so every
 * airframe brings its own numbers rather than the pilot assuming one jet's.
 */
export interface AirframeSlowSpeeds {
    /** Stall / minimum flying speed in the landing configuration (m/s). */
    minFlyingSpeed: number;
    /**
     * Fastest touchdown the gear takes (m/s). Above it the flight model does
     * not count the aircraft as landed, however gently it arrives.
     */
    maxTouchdownSpeed: number;
}

/** Final-approach speed over the stall: the usual 1.3 Vs margin. */
const VREF_STALL_FACTOR = 1.3;
/**
 * Slowest the touchdown may come in under the gear's limit (m/s). The flare
 * bleeds a few m/s off Vref, so this is the floor below Vref, not the touchdown
 * speed itself.
 */
const VREF_TOUCHDOWN_MARGIN = 5;

/**
 * Speed (m/s) to fly the final approach at: 1.3 times the stall, but slow
 * enough under the touchdown limit that the wheels arrive below it. A wide
 * stall margin is no use if the aircraft cannot then get onto the runway.
 */
export function approachSpeed(speeds: AirframeSlowSpeeds): number {
    const fromStall = speeds.minFlyingSpeed * VREF_STALL_FACTOR;
    const fromGear = speeds.maxTouchdownSpeed - VREF_TOUCHDOWN_MARGIN;
    return Math.max(speeds.minFlyingSpeed * 1.1, Math.min(fromStall, fromGear));
}
