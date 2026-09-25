import { AC_STRIDE, PROJ_STRIDE } from './simSnapshotCodec';

/** Max aircraft rows mirrored in the shared banks (player + AI + room). */
export const SIM_SHARED_MAX_AIRCRAFT = 16;

/** Must match combatSim projectile pool size. */
const SIM_SHARED_MAX_PROJECTILES = 480;

/** Int32 control-block indices (Atomics). */
const CTRL = {
    BUSY: 0,
    WRITE_SEQ: 1,
    ACTIVE_BANK: 2,
    AIRCRAFT_COUNT: 3,
    PROJECTILE_COUNT: 4,
    /** Reserved / padding through 7. */
} as const;

const CTRL_INTS = 6;
const AIRCRAFT_BANK_FLOATS = SIM_SHARED_MAX_AIRCRAFT * AC_STRIDE;
const PROJECTILE_BANK_FLOATS = SIM_SHARED_MAX_PROJECTILES * PROJ_STRIDE;

const HEADER_BYTES = CTRL_INTS * 4;
const AIRCRAFT_BANK_BYTES = AIRCRAFT_BANK_FLOATS * 4;
const PROJECTILE_BANK_BYTES = PROJECTILE_BANK_FLOATS * 4;
const TOTAL_BYTES =
    HEADER_BYTES
    + AIRCRAFT_BANK_BYTES * 2
    + PROJECTILE_BANK_BYTES * 2;

export interface SimSharedViews {
    readonly buffer: SharedArrayBuffer;
    readonly ctrl: Int32Array;
    readonly aircraft0: Float32Array;
    readonly aircraft1: Float32Array;
    readonly projectiles0: Float32Array;
    readonly projectiles1: Float32Array;
}

export interface SimSharedPull {
    seq: number;
    aircraftCount: number;
    projectileCount: number;
    aircraft: Float32Array;
    projectiles: Float32Array;
}

/** Allocate the combat-sim shared mirror (main thread, requires crossOriginIsolated). */
export function createSimSharedState(): SimSharedViews {
    return wrapSimSharedState(new SharedArrayBuffer(TOTAL_BYTES));
}

/** Build typed views over an existing SAB (worker after attachSharedState). */
export function wrapSimSharedState(buffer: SharedArrayBuffer): SimSharedViews {
    const ctrl = new Int32Array(buffer, 0, CTRL_INTS);
    let offset = HEADER_BYTES;
    const aircraft0 = new Float32Array(buffer, offset, AIRCRAFT_BANK_FLOATS);
    offset += AIRCRAFT_BANK_BYTES;
    const aircraft1 = new Float32Array(buffer, offset, AIRCRAFT_BANK_FLOATS);
    offset += AIRCRAFT_BANK_BYTES;
    const projectiles0 = new Float32Array(buffer, offset, PROJECTILE_BANK_FLOATS);
    offset += PROJECTILE_BANK_BYTES;
    const projectiles1 = new Float32Array(buffer, offset, PROJECTILE_BANK_FLOATS);
    return {
        buffer, ctrl,
        aircraft0, aircraft1,
        projectiles0, projectiles1,
    };
}

export function aircraftBank(views: SimSharedViews, bank: number): Float32Array {
    return bank === 0 ? views.aircraft0 : views.aircraft1;
}

export function projectileBank(views: SimSharedViews, bank: number): Float32Array {
    return bank === 0 ? views.projectiles0 : views.projectiles1;
}

/**
 * Worker: finish writing the back bank, then publish counts/bank/seq and clear busy.
 * Callers must have already filled the back-bank float regions.
 */
export function publishSharedBanks(
    views: SimSharedViews,
    aircraftCount: number,
    projectileCount: number,
): number {
    const back = 1 - Atomics.load(views.ctrl, CTRL.ACTIVE_BANK);
    // Counts and bank before seq so readers that observe seq see consistent metadata.
    Atomics.store(views.ctrl, CTRL.AIRCRAFT_COUNT, aircraftCount);
    Atomics.store(views.ctrl, CTRL.PROJECTILE_COUNT, projectileCount);
    Atomics.store(views.ctrl, CTRL.ACTIVE_BANK, back);
    const seq = Atomics.add(views.ctrl, CTRL.WRITE_SEQ, 1) + 1;
    Atomics.store(views.ctrl, CTRL.BUSY, 0);
    return seq;
}

/** Which bank the worker should write into next (the inactive one). */
export function sharedBackBank(views: SimSharedViews): number {
    return 1 - Atomics.load(views.ctrl, CTRL.ACTIVE_BANK);
}

/** Main: pull a newer snapshot if the worker has published one since `lastSeq`. */
export function tryPullSharedSnapshot(views: SimSharedViews, lastSeq: number): SimSharedPull | null {
    for (let attempt = 0; attempt < 3; attempt++) {
        const seq = Atomics.load(views.ctrl, CTRL.WRITE_SEQ);
        if (seq <= lastSeq) {
            return null;
        }
        const bank = Atomics.load(views.ctrl, CTRL.ACTIVE_BANK);
        const aircraftCount = Atomics.load(views.ctrl, CTRL.AIRCRAFT_COUNT);
        const projectileCount = Atomics.load(views.ctrl, CTRL.PROJECTILE_COUNT);
        // Seq must still match — otherwise a newer publish raced; retry.
        if (Atomics.load(views.ctrl, CTRL.WRITE_SEQ) !== seq) {
            continue;
        }
        return {
            seq,
            aircraftCount,
            projectileCount,
            aircraft: aircraftBank(views, bank),
            projectiles: projectileBank(views, bank),
        };
    }
    return null;
}

export function setSharedBusy(views: SimSharedViews, busy: boolean): void {
    Atomics.store(views.ctrl, CTRL.BUSY, busy ? 1 : 0);
}

export function isSharedBusy(views: SimSharedViews): boolean {
    return Atomics.load(views.ctrl, CTRL.BUSY) !== 0;
}
