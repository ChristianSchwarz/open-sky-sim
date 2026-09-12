
export const FPS_CAP = 15; // FPS (VGA)
/** Soft cap for HD when SharedArrayBuffer isolation is unavailable (worker onmessage starvation). */
export const HD_FPS_CAP = 30;

export const LO_H_RES = 320;
export const LO_V_RES = 200;
export const HI_H_RES = 640;
export const HI_V_RES = 400;

export const H_RES = 320;
export const V_RES = 200;
export const H_RES_HALF = H_RES / 2;
export const V_RES_HALF = V_RES / 2;

export const PITCH_RATE = Math.PI / 5; // Radians/s
export const ROLL_RATE = Math.PI / 2; // Radians/s (was π/3, +50%)
export const YAW_RATE = Math.PI / 12; // Radians/s
export const MAX_SPEED = 250.0; // World units/s
export const THROTTLE_RATE = 33; // Percentage of maximum/s [0,100]
export const STICK_RATE = 1.5; // Full stick deflection per second (non-arrow layouts)
export const PLANE_DISTANCE_TO_GROUND = 2.0; // World units
export const PLANE_COCKPIT_OFFSET_Y = 1.0; // World units
export const PLANE_COCKPIT_OFFSET_Z = 8.0; // World units
/** Ceiling for kinematic free-fly; must clear the space spawn altitude. */
export const MAX_ALTITUDE = 400000; // World units
/** High-altitude start mode spawn height (m AGL). */
export const HIGH_ALTITUDE_M = 10000;
/** Space start mode spawn height (m AGL). */
export const SPACE_ALTITUDE_M = 100000;

export const COCKPIT_FOV = 50;
/**
 * Default / low-altitude outer clip (m). High-altitude flight raises `camera.far`
 * via {@link cameraFarForAltitudeM} up to ~3.2 Mm.
 */
export const COCKPIT_FAR = 550000;
/** Low-altitude planet terrain mesh range (m); grows with altitude toward the horizon. */
export const TERRAIN_VIEW_RANGE_M = 450000;

export const DEBRIS_PARTICLE_COUNT = 48;
/** Hit fire/smoke puff pool (shared across aircraft leaks). */
export const DAMAGE_SMOKE_PARTICLE_COUNT = 480;

/** KeyboardEvent.code that opens the telemetry graph popup. */
export const TELEMETRY_GRAPH_KEY_CODE = 'NumLock';

export function isTelemetryGraphKey(event: KeyboardEvent): boolean {
    return event.code === TELEMETRY_GRAPH_KEY_CODE
        || event.code === 'Clear'
        || event.key === 'NumLock';
}

export const AIRBASE_RUNWAY = { x: 0, y: 0, z: 0 };
export const RUNWAY_HALF_LENGTH_M = 1500;
export const APPROACH_ALTITUDE_M = 1000;
export const APPROACH_SPEED_KMH = 400;
export const APPROACH_SPEED_MPS = APPROACH_SPEED_KMH / 3.6;
export const APPROACH_FINAL_DISTANCE_M = 7000;

// Asymmetric fore/aft pitch-stick travel in stick units. Forward (push /
// nose-down) reaches -PITCH_STICK_FWD_UNITS; aft (pull / nose-up) reaches
// +PITCH_STICK_AFT_UNITS. Raw [-1, 1] input is scaled so full forward maps to
// -FWD/AFT of the aft throw.
export const PITCH_STICK_FWD_UNITS = 20;
export const PITCH_STICK_AFT_UNITS = 80;
/** Arrows-layout pitch hold: starting stick-units per second. */
export const PITCH_STICK_BASE_UNIT_RATE = 10;
/** Arrows-layout pitch hold: maximum stick-units per second while held. */
export const PITCH_STICK_MAX_UNIT_RATE = 80;
/** Arrows-layout pitch hold: stick-units/s² added to the step rate over hold time. */
export const PITCH_STICK_UNIT_ACCEL = 120;
