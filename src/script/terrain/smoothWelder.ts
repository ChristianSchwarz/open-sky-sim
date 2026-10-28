import { SmoothWeld, SmoothWeldReply, SmoothWeldRequest, weldSmoothLand } from './smoothWeld';

/** Workers in the pool: the weld is the only job, and two keep up with streaming. */
const WORKERS = 2;

/**
 * The SMOOTH land weld (weldSmoothLand) on a small pool of workers, so the
 * main thread only ever uploads the result. Without workers (node tests, a
 * browser that refuses them) it welds in place, as before.
 *
 * The arrays are copied for the job: the FACETED geometry the tile keeps
 * drawing until the weld is back is bound to them.
 */
export class SmoothWelder {
    private readonly workers: Worker[] = [];
    private readonly busy: number[] = [];
    private readonly pending = new Map<number, { resolve: (w: SmoothWeld | undefined) => void; worker: number }>();
    private nextId = 1;

    constructor(workers = WORKERS) {
        if (typeof Worker === 'undefined') {
            return;
        }
        try {
            for (let i = 0; i < workers; i++) {
                const worker = new Worker(new URL('./smoothWeldWorker.ts', import.meta.url));
                worker.onmessage = (event: MessageEvent<SmoothWeldReply>) => this.finish(i, event.data);
                this.workers.push(worker);
                this.busy.push(0);
            }
        } catch {
            this.dispose();
        }
    }

    /** Jobs sent and not yet back. */
    get inFlight(): number {
        return this.pending.size;
    }

    weld(positions: Int16Array, normals: Int8Array, attrs: Uint8Array, sizes?: Uint16Array, strength = 1): Promise<SmoothWeld | undefined> {
        if (this.workers.length === 0) {
            return Promise.resolve(weldSmoothLand(positions, normals, attrs, sizes, strength));
        }
        // The least loaded worker; jobs queue in its message port.
        let worker = 0;
        for (let i = 1; i < this.workers.length; i++) {
            if (this.busy[i] < this.busy[worker]) {
                worker = i;
            }
        }
        const id = this.nextId++;
        const request: SmoothWeldRequest = {
            id, positions: positions.slice(), normals: normals.slice(), attrs: attrs.slice(), sizes: sizes?.slice(), strength,
        };
        const transfer = [request.positions, request.normals, request.attrs, request.sizes]
            .filter((a): a is NonNullable<typeof a> => a !== undefined)
            .map(a => a.buffer as ArrayBuffer);
        this.busy[worker]++;
        return new Promise(resolve => {
            this.pending.set(id, { resolve, worker });
            this.workers[worker].postMessage(request, transfer);
        });
    }

    dispose(): void {
        for (const w of this.workers) {
            w.terminate();
        }
        this.workers.length = 0;
        for (const { resolve } of this.pending.values()) {
            resolve(undefined);
        }
        this.pending.clear();
    }

    private finish(worker: number, reply: SmoothWeldReply): void {
        this.busy[worker]--;
        const job = this.pending.get(reply.id);
        if (job) {
            this.pending.delete(reply.id);
            job.resolve(reply.weld);
        }
    }
}
