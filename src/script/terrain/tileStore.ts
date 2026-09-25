/**
 * Generic tile cache: byte-budget LRU, in-flight dedupe, cancellation, bounded
 * retry and adaptive concurrency. Shared by the mesh and height streams.
 *
 * This replaces two near-identical 180-line copies (demStore + coastStore) and
 * fixes what was wrong with both:
 *
 *  - the queue was re-sorted on every single request;
 *  - a queued fetch kept its enqueue-time priority forever, so a tile queued
 *    while distant stayed high-priority after the camera moved on;
 *  - nothing could be cancelled, so a hard turn left hundreds of now-useless
 *    fetches to complete and decode;
 *  - eviction scanned the entire map on every insert;
 *  - the cache was capped by tile *count* although tile sizes vary ~10x;
 *  - a failed fetch threw and left the node permanently broken.
 */

import { STREAM_CONCURRENCY_MAX, STREAM_CONCURRENCY_MIN } from './lod';
import { TileKey, tileKeyString, parseTileKey } from './tiling';

/** Doubly-linked LRU node, so eviction is O(1) rather than a full scan. */
interface Entry<T> {
    key: string;
    value: T;
    bytes: number;
    pinned: boolean;
    /** Generation the tile was last drawn in; drives eviction order. */
    lastUsed: number;
    prev?: Entry<T>;
    next?: Entry<T>;
}

interface Pending<T> {
    key: string;
    id: TileKey;
    priority: number;
    controller: AbortController;
    resolve: (v: T | null) => void;
    reject: (e: unknown) => void;
    attempt: number;
}

export interface TileStoreOptions<T> {
    baseUrl: string;
    /** Absolute URL for a tile. */
    url: (id: TileKey) => string;
    /** Decode raw bytes. Should be cheap; PTM1 decoding is O(1) by design. */
    decode: (bytes: ArrayBuffer) => T;
    /** Approximate retained size, for the byte budget. */
    sizeOf: (value: T) => number;
    /** Called when a value is evicted, so GPU resources can be released. */
    dispose?: (value: T) => void;
    maxBytes: number;
    /** Tiles the index says do not exist are never requested. */
    exists?: (id: TileKey) => boolean;
    maxRetries?: number;
    /** Base retry backoff in ms; doubles per attempt. Lowered in tests. */
    retryBackoffMs?: number;
}

export interface TileStoreStats {
    cached: number;
    cacheBytes: number;
    inflight: number;
    queued: number;
    bytesInFlight: number;
    aborted: number;
    failed: number;
    evicted: number;
    concurrency: number;
}

/** Whether a payload starts with the gzip magic, i.e. was not inflated on the way. */
export function isGzip(buf: ArrayBuffer): boolean {
    if (buf.byteLength < 2) {
        return false;
    }
    const b = new Uint8Array(buf, 0, 2);
    return b[0] === 0x1f && b[1] === 0x8b;
}

/** Inflate a gzip payload with the browser's native decoder. */
export async function inflateGzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
}

export class TileStore<T> {
    private readonly map = new Map<string, Entry<T>>();
    private warnedRawGzip = false;
    private head?: Entry<T>;   // most recently used
    private tail?: Entry<T>;   // least recently used
    private cacheBytes = 0;

    private readonly queue = new Map<string, Pending<T>>();
    private readonly inflight = new Map<string, Pending<T>>();
    private readonly promises = new Map<string, Promise<T | null>>();
    /** Tiles that failed past the retry limit; treated as absent, not retried. */
    private readonly dead = new Set<string>();

    private generation = 0;
    private concurrency = 12;
    private latencyEmaMs = 200;
    private aborted = 0;
    private failed = 0;
    private evicted = 0;
    private bytesInFlight = 0;
    private queueDirty = false;
    private sorted: Pending<T>[] = [];

    constructor(private readonly opts: TileStoreOptions<T>) { }

    get stats(): TileStoreStats {
        return {
            cached: this.map.size,
            cacheBytes: this.cacheBytes,
            inflight: this.inflight.size,
            queued: this.queue.size,
            bytesInFlight: this.bytesInFlight,
            aborted: this.aborted,
            failed: this.failed,
            evicted: this.evicted,
            concurrency: this.concurrency,
        };
    }

    /** Advance the draw generation; call once per reconcile pass. */
    nextGeneration(): number {
        return ++this.generation;
    }

    has(id: TileKey): boolean {
        return this.map.has(tileKeyString(id));
    }

    /** Look up without changing recency (for read-only probes). */
    peek(id: TileKey): T | undefined {
        return this.map.get(tileKeyString(id))?.value;
    }

    /** Return all cached tiles without marking them as used. */
    peekAll(): Array<{ id: TileKey; value: T }> {
        const out: Array<{ id: TileKey; value: T }> = [];
        for (const entry of this.map.values()) {
            const id = parseTileKey(entry.key);
            out.push({ id, value: entry.value });
        }
        return out;
    }

    /** Look up and mark as used this generation. */
    get(id: TileKey): T | undefined {
        const e = this.map.get(tileKeyString(id));
        if (!e) {
            return undefined;
        }
        e.lastUsed = this.generation;
        this.moveToFront(e);
        return e.value;
    }

    /** True when the tile is known not to exist, or has permanently failed. */
    isAbsent(id: TileKey): boolean {
        const key = tileKeyString(id);
        if (this.dead.has(key)) {
            return true;
        }
        return this.opts.exists ? !this.opts.exists(id) : false;
    }

    setPinned(id: TileKey, pinned: boolean): void {
        const e = this.map.get(tileKeyString(id));
        if (e) {
            e.pinned = pinned;
        }
    }

    /**
     * Request a tile. Resolves null when the tile does not exist, was
     * cancelled, or failed permanently — never throws for those.
     */
    request(id: TileKey, priority: number): Promise<T | null> {
        const key = tileKeyString(id);
        const cached = this.map.get(key);
        if (cached) {
            cached.lastUsed = this.generation;
            this.moveToFront(cached);
            return Promise.resolve(cached.value);
        }
        if (this.isAbsent(id)) {
            return Promise.resolve(null);
        }
        const existing = this.promises.get(key);
        if (existing) {
            this.reprioritise(key, priority);
            return existing;
        }
        const promise = new Promise<T | null>((resolve, reject) => {
            this.queue.set(key, {
                key, id, priority, resolve, reject,
                controller: new AbortController(),
                attempt: 0,
            });
            this.queueDirty = true;
        });
        this.promises.set(key, promise);
        void promise.finally(() => this.promises.delete(key));
        this.pump();
        return promise;
    }

    /** Update the score of a queued tile. In-flight tiles are left alone. */
    reprioritise(key: string, priority: number): void {
        const q = this.queue.get(key);
        if (q && q.priority !== priority) {
            q.priority = priority;
            this.queueDirty = true;
        }
    }

    /**
     * Drop a tile that is no longer wanted. A queued tile is removed outright;
     * an in-flight one is aborted so its bytes stop arriving.
     */
    cancel(key: string): void {
        const q = this.queue.get(key);
        if (q) {
            this.queue.delete(key);
            this.queueDirty = true;
            q.resolve(null);
            this.aborted++;
            return;
        }
        const f = this.inflight.get(key);
        if (f) {
            f.controller.abort();
            this.aborted++;
        }
    }

    /** Keys currently queued or in flight. */
    activeKeys(): string[] {
        return [...this.queue.keys(), ...this.inflight.keys()];
    }

    private moveToFront(e: Entry<T>): void {
        if (this.head === e) {
            return;
        }
        this.unlink(e);
        e.next = this.head;
        if (this.head) {
            this.head.prev = e;
        }
        this.head = e;
        if (!this.tail) {
            this.tail = e;
        }
    }

    private unlink(e: Entry<T>): void {
        if (e.prev) {
            e.prev.next = e.next;
        }
        if (e.next) {
            e.next.prev = e.prev;
        }
        if (this.head === e) {
            this.head = e.next;
        }
        if (this.tail === e) {
            this.tail = e.prev;
        }
        e.prev = undefined;
        e.next = undefined;
    }

    private put(id: TileKey, value: T): void {
        const key = tileKeyString(id);
        const bytes = Math.max(1, this.opts.sizeOf(value));
        const e: Entry<T> = { key, value, bytes, pinned: false, lastUsed: this.generation };
        this.map.set(key, e);
        this.cacheBytes += bytes;
        this.moveToFront(e);
        this.evictToBudget();
    }

    private evictToBudget(): void {
        let node = this.tail;
        while (node && this.cacheBytes > this.opts.maxBytes) {
            const prev = node.prev;
            // Never evict a pinned tile, nor one drawn this generation.
            if (!node.pinned && node.lastUsed < this.generation) {
                this.unlink(node);
                this.map.delete(node.key);
                this.cacheBytes -= node.bytes;
                this.evicted++;
                this.opts.dispose?.(node.value);
            }
            node = prev;
        }
    }

    private takeNext(): Pending<T> | undefined {
        if (this.queue.size === 0) {
            return undefined;
        }
        if (this.queueDirty) {
            this.sorted = [...this.queue.values()].sort((a, b) => b.priority - a.priority);
            this.queueDirty = false;
        }
        while (this.sorted.length > 0) {
            const job = this.sorted.pop();
            if (job && this.queue.has(job.key)) {
                this.queue.delete(job.key);
                return job;
            }
        }
        // The cached ordering went stale; rebuild once.
        const rest = [...this.queue.values()].sort((a, b) => a.priority - b.priority);
        const job = rest.pop();
        if (job) {
            this.queue.delete(job.key);
        }
        return job;
    }

    private pump(): void {
        while (this.inflight.size < this.concurrency) {
            const job = this.takeNext();
            if (!job) {
                return;
            }
            this.inflight.set(job.key, job);
            void this.fetchOne(job);
        }
    }

    private async fetchOne(job: Pending<T>): Promise<void> {
        const started = Date.now();
        try {
            const res = await fetch(this.opts.url(job.id), { signal: job.controller.signal });
            if (res.status === 404) {
                // The index said this tile exists, so a 404 means the index and
                // the baked pyramid disagree. It is treated as ocean from here
                // on, which silently turns land into flat water -- say so.
                console.warn(`[terrain] ${job.key}: 404 though the index lists it; drawn as sea from now on`);
                this.dead.add(job.key);
                this.finish(job, null, started);
                return;
            }
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            let buf = await res.arrayBuffer();
            if (isGzip(buf)) {
                // The tile is stored gzip on disk and meant to be served with
                // Content-Encoding: gzip, which the browser inflates before we
                // see it. A server without that rule - a stale dev server, a
                // static host missing the header - hands over the raw gzip
                // bytes instead, which would fail to decode and be drawn as
                // sea from then on. Inflate here rather than fail.
                if (!this.warnedRawGzip) {
                    this.warnedRawGzip = true;
                    console.warn(`[terrain] ${job.key}: served without Content-Encoding: gzip; inflating in the page`);
                }
                buf = await inflateGzip(buf);
            }
            this.bytesInFlight += buf.byteLength;
            const value = this.opts.decode(buf);
            this.bytesInFlight -= buf.byteLength;
            this.put(job.id, value);
            this.finish(job, value, started);
        } catch (err) {
            if (job.controller.signal.aborted) {
                this.finish(job, null, started);
                return;
            }
            const max = this.opts.maxRetries ?? 3;
            if (job.attempt < max) {
                job.attempt++;
                this.inflight.delete(job.key);
                const backoff = 2 ** job.attempt * (this.opts.retryBackoffMs ?? 100);
                setTimeout(() => {
                    job.controller = new AbortController();
                    this.queue.set(job.key, job);
                    this.queueDirty = true;
                    this.pump();
                }, backoff);
                return;
            }
            // Permanently failed: treat as absent so the quadtree falls back to
            // the parent tile instead of leaving a hole, and stop retrying.
            // That fallback paints whatever was there as flat sea for the rest
            // of the session, so it is not something to swallow quietly.
            console.warn(`[terrain] ${job.key}: gave up after ${max} retries; drawn as sea from now on`, err);
            this.dead.add(job.key);
            this.failed++;
            this.finish(job, null, started);
        }
    }

    private finish(job: Pending<T>, value: T | null, startedMs: number): void {
        this.inflight.delete(job.key);
        const elapsed = Date.now() - startedMs;
        this.latencyEmaMs = this.latencyEmaMs * 0.9 + elapsed * 0.1;
        // Fast responses mean headroom; slow ones mean we are saturating.
        if (this.latencyEmaMs < 120) {
            this.concurrency = Math.min(STREAM_CONCURRENCY_MAX, this.concurrency + 1);
        } else if (this.latencyEmaMs > 400) {
            this.concurrency = Math.max(STREAM_CONCURRENCY_MIN, this.concurrency - 1);
        }
        job.resolve(value);
        this.pump();
    }
}
