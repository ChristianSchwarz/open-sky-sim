import { ForceVectorSample } from '../model/flightModel';
import { SimHitEvent } from './simTypes';

/**
 * Flat, transferable snapshot layout. Per-aircraft numeric state is packed into
 * a single {@link Float32Array} (one contiguous row per aircraft) and projectiles
 * into another, so the worker->main handoff transfers two ArrayBuffers instead of
 * deep-cloning nested objects — this is what lets the sim scale to many aircraft.
 *
 * The few non-numeric bits ride alongside: aircraft ids (stable, one string per
 * row), per-aircraft force-vector debug samples (only when present), and hit
 * events (rare, small).
 */

/** Floats per aircraft row. Keep in sync with the AC_* offsets below. */
export const AC_STRIDE = 55;

export const AC = {
    posX: 0, posY: 1, posZ: 2,
    qx: 3, qy: 4, qz: 5, qw: 6,
    velX: 7, velY: 8, velZ: 9,
    ppX: 10, ppY: 11, ppZ: 12,
    pqx: 13, pqy: 14, pqz: 15, pqw: 16,
    pvX: 17, pvY: 18, pvZ: 19,
    deltaRemainder: 20,
    crashed: 21,
    landed: 22,
    aoa: 23,
    loadG: 24,
    cmdElevator: 25,
    cmdAileron: 26,
    cmdRudder: 27,
    accX: 28, accY: 29, accZ: 30,
    engineThrustN: 31,
    effectiveThrottle: 32,
    stall: 33,
    gearDeployed: 34,
    flapsExtended: 35,
    firing: 36,
    health: 37,
    ammo: 38,
    /** Normalized pilot commands mirrored for HUD (worker-owned input). */
    inPitch: 39,
    inRoll: 40,
    inYaw: 41,
    inThrottle: 42,
    pitchStickUnits: 43,
    wheelBrakes: 44,
    limitersEnabled: 45,
    pitchLimiterMode: 46,
    autopilot: 47,
    airbrakesExtended: 48,
    /** Latched arrestor cable index, or -1 when free. */
    arrestorLatch: 49,
    hookX: 50,
    hookY: 51,
    hookZ: 52,
    /** Tailhook lowered (arrestor-capable). */
    hookDeployed: 53,
} as const;

/** Floats per projectile row: position (3) + quaternion (4). */
export const PROJ_STRIDE = 7;

/** The worker->main snapshot payload (typed arrays are transferred, not cloned). */
export interface SnapshotBuffers {
    ids: string[];
    /** `ids.length * AC_STRIDE` floats. */
    aircraft: Float32Array;
    /** Debug force vectors, only for aircraft that currently expose them. */
    forceVectors: Record<string, ForceVectorSample[]>;
    /** AI maneuver / phase labels keyed by aircraft id (for MFD telemetry). */
    maneuverLabels: Record<string, string>;
    /** `projectileCount * PROJ_STRIDE` floats. */
    projectiles: Float32Array;
    projectileCount: number;
    hits: SimHitEvent[];
}
