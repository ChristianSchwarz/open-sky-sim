import { prepareLand } from './landPrep';
import { PtmTile, decodePtm } from './ptm';

/** Workers in the pool: decoding is cheap, the land preparation is what they carry. */
const WORKERS = 2;

export interface PtmDecodeRequest {
    id: number;
    bytes: ArrayBuffer;
}

export interface PtmDecodeReply {
    id: number;
    tile?: PtmTile;
    error?: string;
}

/** Every buffer under a tile's arrays, once each, to transfer it whole. */
export function tileBuffers(tile: PtmTile): ArrayBuffer[] {
    const out = new Set<ArrayBuffer>();
    const visit = (value: unknown, depth: number): void => {
        if (ArrayBuffer.isView(value)) {
            out.add(value.buffer as ArrayBuffer);
        } else if (value !== null && typeof value === 'object' && depth < 2) {
            for (const v of Object.values(value)) {
                visit(v, depth + 1);
            }
        }
    };
    visit(tile, 0);
    return [...out];
}

/**
 * Mesh tile decoding (decodePtm) plus the land preparation every tile needs
 * before upload (prepareLand: region widths, leaned border normals) on a
 * small pool of workers. The preparation ran inside the upload, on the main
 * thread, and a big tile took 30-80 ms of a frame there. Without workers
 * (node tests, a browser that refuses them) it runs in place.
 *
 * The fetched bytes are transferred to the worker, and the tile's arrays
 * back: the caller gives up the buffer it passes in.
 */
export class PtmDecoder {
    private readonly workers: Worker[] = [];
    private readonly busy: number[] = [];
    private readonly pending = new Map<number, { resolve: (t: PtmTile) => void; reject: (e: Error) => void; worker: number }>();
    private nextId = 1;

    constructor(workers = WORKERS) {
        if (typeof Worker === 'undefined') {
            return;
        }
        try {
            for (let i = 0; i < workers; i++) {
                const worker = new Worker(new URL('./ptmDecodeWorker.ts', import.meta.url));
                worker.onmessage = (event: MessageEvent<PtmDecodeReply>) => this.finish(i, event.data);
                this.workers.push(worker);
                this.busy.push(0);
            }
        } catch {
            this.dispose();
        }
    }

    decode(bytes: ArrayBuffer): Promise<PtmTile> {
        if (this.workers.length === 0) {
            return Promise.resolve(prepareLand(decodePtm(bytes)));
        }
        let worker = 0;
        for (let i = 1; i < this.workers.length; i++) {
            if (this.busy[i] < this.busy[worker]) {
                worker = i;
            }
        }
        const id = this.nextId++;
        const request: PtmDecodeRequest = { id, bytes };
        this.busy[worker]++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject, worker });
            this.workers[worker].postMessage(request, [bytes]);
        });
    }

    dispose(): void {
        for (const w of this.workers) {
            w.terminate();
        }
        this.workers.length = 0;
        for (const { reject } of this.pending.values()) {
            reject(new Error('decoder disposed'));
        }
        this.pending.clear();
    }

    private finish(worker: number, reply: PtmDecodeReply): void {
        this.busy[worker]--;
        const job = this.pending.get(reply.id);
        if (!job) {
            return;
        }
        this.pending.delete(reply.id);
        if (reply.tile) {
            job.resolve(reply.tile);
        } else {
            job.reject(new Error(reply.error ?? 'decode failed'));
        }
    }
}
