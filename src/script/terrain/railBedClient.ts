/**
 * The render thread's end of the rail bed workers: queues a tile's land and
 * strokes, resolves with the beds. Finer tiles go first - a leaf near the
 * camera must not wait behind a z9 tile 75 km across - and up to two run at
 * once. Where there is no Worker (tests, node), the same code runs inline.
 */

import { RailBedInput, RailBedResult, layRailBeds } from './railBed';

/** What crosses to a worker: RailBedInput with the pinned set as an array. */
export interface RailBedJob {
    jobId: number;
    input: Omit<RailBedInput, 'pinned'> & { pinned: Uint32Array };
}

export type RailBedReply =
    | { jobId: number; result: RailBedResult | undefined; ms: number; error?: undefined }
    | { jobId: number; error: string; result?: undefined; ms?: undefined };

/** A finished job: the beds, and how long the worker spent on them. */
export interface RailBedRun {
    result: RailBedResult | undefined;
    ms: number;
}

interface Queued {
    job: RailBedJob;
    priority: number;
    resolve: (r: RailBedRun) => void;
    reject: (e: Error) => void;
}

/** Workers at most; one fewer than the cores leaves the render thread its own. */
const MAX_WORKERS = 2;

export class RailBedClient {
    private readonly idle: Worker[] = [];
    private readonly all: Worker[] = [];
    private readonly queue: Queued[] = [];
    private readonly running = new Map<number, Queued>();
    private nextId = 1;

    constructor() {
        if (typeof Worker === 'undefined') {
            return;
        }
        const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2;
        const n = Math.max(1, Math.min(MAX_WORKERS, cores - 1));
        for (let i = 0; i < n; i++) {
            let worker: Worker;
            try {
                worker = new Worker(new URL('./railBedWorker.ts', import.meta.url));
            } catch {
                break;
            }
            worker.onmessage = (e: MessageEvent<RailBedReply>) => {
                const job = this.running.get(e.data.jobId);
                this.running.delete(e.data.jobId);
                this.idle.push(worker);
                if (job) {
                    if (e.data.error !== undefined) {
                        job.reject(new Error(e.data.error));
                    } else {
                        job.resolve({ result: e.data.result, ms: e.data.ms });
                    }
                }
                this.pump();
            };
            worker.onerror = (e) => {
                console.error('[railBedWorker]', e.message, e.filename, e.lineno);
            };
            this.all.push(worker);
            this.idle.push(worker);
        }
    }

    /**
     * Lay one tile's beds; higher `priority` first. The land arrays and the
     * pinned list are handed over (transferred), so pass copies of anything
     * still in use.
     */
    run(input: RailBedJob['input'], priority = 0): Promise<RailBedRun> {
        if (this.all.length === 0) {
            const t0 = Date.now();
            try {
                const result = layRailBeds({ ...input, pinned: new Set(input.pinned) });
                return Promise.resolve({ result, ms: Date.now() - t0 });
            } catch (err) {
                return Promise.reject(err);
            }
        }
        return new Promise((resolve, reject) => {
            this.queue.push({ job: { jobId: this.nextId++, input }, priority, resolve, reject });
            this.pump();
        });
    }

    private pump(): void {
        while (this.idle.length > 0 && this.queue.length > 0) {
            let best = 0;
            for (let i = 1; i < this.queue.length; i++) {
                if (this.queue[i].priority > this.queue[best].priority) {
                    best = i;
                }
            }
            const next = this.queue.splice(best, 1)[0];
            const worker = this.idle.pop()!;
            this.running.set(next.job.jobId, next);
            const { land, pinned } = next.job.input;
            worker.postMessage(next.job, [land.positions.buffer, land.normals.buffer, land.attrs.buffer, pinned.buffer]);
        }
    }

    /** Jobs queued or running. */
    get inflight(): number {
        return this.queue.length + this.running.size;
    }

    dispose(): void {
        for (const w of this.all) {
            w.terminate();
        }
        this.all.length = 0;
        this.idle.length = 0;
        for (const job of [...this.queue, ...this.running.values()]) {
            job.reject(new Error('rail bed worker disposed'));
        }
        this.queue.length = 0;
        this.running.clear();
    }
}
