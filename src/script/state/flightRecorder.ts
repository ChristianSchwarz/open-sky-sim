import * as THREE from 'three';
import { FrameShift } from '../terrain/geodesy';

/** Samples per second of flight time. Poses are interpolated between them. */
export const RECORD_RATE_HZ = 30;
/** How much flight the recorder keeps; older samples are dropped. */
export const RECORD_MAX_SECONDS = 600;

/** Device animation state worth showing in a replay; all in 0..1 except throttle. */
export interface ReplayDevices {
    throttle: number;
    gear: boolean;
    flaps: boolean;
    airbrakes: boolean;
    hook: boolean;
}

export interface ReplayPose {
    position: THREE.Vector3;
    quaternion: THREE.Quaternion;
    velocity: THREE.Vector3;
    devices: ReplayDevices;
}

/**
 * Flat, ring-buffered record of the player aircraft's pose over time.
 *
 * Sim time only advances while {@link record} is called, so pauses (menu,
 * spawn) leave no gap. Positions are kept in the live scene frame: a
 * floating-origin re-base must be passed on through {@link rebase}, or the
 * samples would sit where the world used to be.
 */
export class FlightRecorder {
    private static readonly STRIDE = 14; // px py pz  qx qy qz qw  vx vy vz  throttle flags  t
    private readonly capacity: number;
    private readonly data: Float64Array;
    private head = 0; // next write slot
    private count = 0;
    private clock = 0;
    private lastSampleAt = -Infinity;

    constructor(private readonly rateHz = RECORD_RATE_HZ, maxSeconds = RECORD_MAX_SECONDS) {
        this.capacity = Math.max(2, Math.ceil(rateHz * maxSeconds));
        this.data = new Float64Array(this.capacity * FlightRecorder.STRIDE);
    }

    get length(): number {
        return this.count;
    }

    /** Time of the oldest / newest sample, in recorder seconds. */
    get startTime(): number {
        return this.count === 0 ? 0 : this.time(0);
    }

    get endTime(): number {
        return this.count === 0 ? 0 : this.time(this.count - 1);
    }

    get duration(): number {
        return this.endTime - this.startTime;
    }

    clear(): void {
        this.head = 0;
        this.count = 0;
        this.clock = 0;
        this.lastSampleAt = -Infinity;
    }

    /** Advance by `delta` seconds of flight and keep a sample when one is due. */
    record(delta: number, pose: ReplayPose): void {
        this.clock += delta;
        if (this.clock - this.lastSampleAt < 1 / this.rateHz - 1e-6) {
            return;
        }
        this.lastSampleAt = this.clock;
        const o = this.head * FlightRecorder.STRIDE;
        const d = this.data;
        d[o] = pose.position.x; d[o + 1] = pose.position.y; d[o + 2] = pose.position.z;
        d[o + 3] = pose.quaternion.x; d[o + 4] = pose.quaternion.y;
        d[o + 5] = pose.quaternion.z; d[o + 6] = pose.quaternion.w;
        d[o + 7] = pose.velocity.x; d[o + 8] = pose.velocity.y; d[o + 9] = pose.velocity.z;
        d[o + 10] = pose.devices.throttle;
        d[o + 11] = (pose.devices.gear ? 1 : 0) | (pose.devices.flaps ? 2 : 0)
            | (pose.devices.airbrakes ? 4 : 0) | (pose.devices.hook ? 8 : 0);
        d[o + 12] = this.clock;
        this.head = (this.head + 1) % this.capacity;
        this.count = Math.min(this.count + 1, this.capacity);
    }

    /** Carry every stored pose across a floating-origin re-base. */
    rebase(shift: FrameShift): void {
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const d = this.data;
        for (let i = 0; i < this.count; i++) {
            const o = this.slot(i) * FlightRecorder.STRIDE;
            shift.point(p.set(d[o], d[o + 1], d[o + 2]));
            d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z;
            shift.orientation(q.set(d[o + 3], d[o + 4], d[o + 5], d[o + 6]));
            d[o + 3] = q.x; d[o + 4] = q.y; d[o + 5] = q.z; d[o + 6] = q.w;
            shift.vector(p.set(d[o + 7], d[o + 8], d[o + 9]));
            d[o + 7] = p.x; d[o + 8] = p.y; d[o + 9] = p.z;
        }
    }

    /**
     * Pose at `t` (recorder seconds, clamped to the recorded span), blended
     * between the two samples around it. False when nothing is recorded.
     */
    sample(t: number, out: ReplayPose): boolean {
        if (this.count === 0) {
            return false;
        }
        t = Math.min(Math.max(t, this.startTime), this.endTime);
        // Binary search for the last sample at or before t.
        let lo = 0;
        let hi = this.count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.time(mid) <= t) lo = mid; else hi = mid - 1;
        }
        const next = Math.min(lo + 1, this.count - 1);
        const t0 = this.time(lo);
        const t1 = this.time(next);
        const k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
        const a = this.slot(lo) * FlightRecorder.STRIDE;
        const b = this.slot(next) * FlightRecorder.STRIDE;
        const d = this.data;
        out.position.set(
            d[a] + (d[b] - d[a]) * k,
            d[a + 1] + (d[b + 1] - d[a + 1]) * k,
            d[a + 2] + (d[b + 2] - d[a + 2]) * k);
        out.velocity.set(
            d[a + 7] + (d[b + 7] - d[a + 7]) * k,
            d[a + 8] + (d[b + 8] - d[a + 8]) * k,
            d[a + 9] + (d[b + 9] - d[a + 9]) * k);
        _qa.set(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
        _qb.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
        out.quaternion.copy(_qa).slerp(_qb, k);
        out.devices.throttle = d[a + 10] + (d[b + 10] - d[a + 10]) * k;
        const flags = d[a + 11];
        out.devices.gear = (flags & 1) !== 0;
        out.devices.flaps = (flags & 2) !== 0;
        out.devices.airbrakes = (flags & 4) !== 0;
        out.devices.hook = (flags & 8) !== 0;
        return true;
    }

    /** Slot in the ring of the i-th oldest sample. */
    private slot(i: number): number {
        return (this.head - this.count + i + this.capacity * 2) % this.capacity;
    }

    private time(i: number): number {
        return this.data[this.slot(i) * FlightRecorder.STRIDE + 12];
    }
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

export function newReplayPose(): ReplayPose {
    return {
        position: new THREE.Vector3(),
        quaternion: new THREE.Quaternion(),
        velocity: new THREE.Vector3(),
        devices: { throttle: 0, gear: false, flaps: false, airbrakes: false, hook: false },
    };
}

export const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];

/** Playback cursor over a recorder: time, speed, pause, seek. */
export class ReplayPlayer {
    time = 0;
    paused = false;
    private speedIndex = 2;

    constructor(private readonly rec: FlightRecorder) {}

    get speed(): number {
        return REPLAY_SPEEDS[this.speedIndex];
    }

    /** Begin at the start of the last `seconds` of the recording. */
    start(seconds = Infinity): void {
        this.time = Math.max(this.rec.startTime, this.rec.endTime - seconds);
        this.paused = false;
        this.speedIndex = 2;
    }

    /** Advance by real `delta`; loops back to the start at the end. */
    advance(delta: number): void {
        if (this.paused) {
            return;
        }
        this.time += delta * this.speed;
        if (this.time >= this.rec.endTime) {
            this.time = this.rec.startTime;
        }
    }

    /** Next speed, wrapping from the fastest back to the slowest. */
    cycleSpeed(): void {
        this.speedIndex = (this.speedIndex + 1) % REPLAY_SPEEDS.length;
    }

    seek(deltaSeconds: number): void {
        this.time = Math.min(Math.max(this.time + deltaSeconds, this.rec.startTime), this.rec.endTime);
    }

    changeSpeed(direction: 1 | -1): void {
        this.speedIndex = Math.min(Math.max(this.speedIndex + direction, 0), REPLAY_SPEEDS.length - 1);
    }

    get fraction(): number {
        const d = this.rec.duration;
        return d > 0 ? (this.time - this.rec.startTime) / d : 0;
    }
}
