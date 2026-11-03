/**
 * Tile streaming: the quadtree declares what it wants, this owns everything
 * else — scoring, cancellation, predictive prefetch and the frame budget.
 *
 * Each reconcile pass produces a *want set*. `setWants` diffs it against what
 * is resident, in flight and queued: newly wanted tiles are enqueued,
 * no-longer-wanted fetches are aborted, and everything still wanted is
 * re-scored. Nothing ever carries a stale priority.
 *
 * The priority function is the whole policy:
 *
 *   priority = (pinned         ? 1e9 : 0)   boot / play-area seeding
 *            + (inFrustum      ? 1e6 : 0)   visible beats speculative
 *            + (parentResident ? 0 : 5e5)   coarse-to-fine, always
 *            + sse / (1 + distanceKm)
 *
 * The `parentResident` term is what guarantees we never block on a deep tile
 * while an ancestor is missing, so coarse-to-fine falls out of the scoring
 * rather than needing separate machinery. It pairs with the quadtree's "a
 * parent stays drawn until all four children are resident" rule: that one
 * prevents holes, this one makes them short.
 */

import { TILE_UPLOAD_BUDGET_MS } from './lod';
import { TileKey, parentOf, tileKeyString } from './tiling';
import { TileStore } from './tileStore';

export const PRIORITY_PINNED = 1e9;
export const PRIORITY_IN_FRUSTUM = 1e6;
export const PRIORITY_PARENT_MISSING = 5e5;

export interface TileWant {
    id: TileKey;
    /** Screen-space error in pixels; higher means more visible benefit. */
    ssePx: number;
    distanceM: number;
    inFrustum: boolean;
    pinned: boolean;
}

export interface StreamerStats {
    wanted: number;
    uploaded: number;
    uploadMs: number;
    prefetched: number;
    /** Uploaded tiles held right now, and their bytes (see TileStreamerOptions.sizeOf). */
    resident: number;
    residentBytes: number;
    /** Uploaded tiles released by evictIdle so far. */
    evicted: number;
}

export function scoreWant(want: TileWant, parentResident: boolean): number {
    return (want.pinned ? PRIORITY_PINNED : 0)
        + (want.inFrustum ? PRIORITY_IN_FRUSTUM : 0)
        + (parentResident ? 0 : PRIORITY_PARENT_MISSING)
        + want.ssePx / (1 + want.distanceM / 1000);
}

export interface TileStreamerOptions<T, G> {
    store: TileStore<T>;
    /** Turn a decoded tile into a drawable object. Charged to the frame budget. */
    upload: (id: TileKey, value: T) => G;
    /** Release a previously uploaded object. */
    release?: (id: TileKey, gpu: G) => void;
    /** Bytes an uploaded object holds, for {@link maxBytes}. Without it nothing is ever evicted. */
    sizeOf?: (gpu: G) => number;
    /**
     * Budget for uploaded tiles. Past it evictIdle releases idle ones, least
     * recently used first; tiles in use are never released, so this bounds
     * the idle cache rather than what is drawn. Default: unbounded.
     */
    maxBytes?: number;
    /**
     * Generations (nextGeneration calls) a tile must go unused before
     * evictIdle may release it. Default 1: anything not used this generation.
     */
    idleGenerations?: number;
    uploadBudgetMs?: number;
    now?: () => number;
}

export class TileStreamer<T, G> {
    private readonly gpu = new Map<string, G>();
    /** Arrived and decoded, waiting for a slot in the frame's upload budget. */
    private readonly ready = new Map<string, { id: TileKey; value: T }>();
    private wantKeys = new Set<string>();
    /**
     * Pinned tiles are wanted unconditionally, including before the first
     * reconcile pass has produced a want set at all. Boot pins its spawn area
     * and then waits, so without this their fetches land with nothing willing
     * to upload them and the wait never finishes.
     */
    private pinnedKeys = new Set<string>();
    private uploaded = 0;
    /** Bumped whenever the set of uploaded tiles changes. */
    private residentVersion = 0;
    private uploadMs = 0;
    private prefetched = 0;
    /**
     * Use clock for the uploaded tiles. The store's own LRU cannot stand in
     * for it: a tile is never requested again once uploaded, so the store
     * ages out exactly the tiles that are on screen. Recency here comes from
     * what the caller says it drew (markUsed).
     */
    private generation = 0;
    /** Generation each uploaded tile was last used in, by key. */
    private readonly lastUsed = new Map<string, number>();
    private evictedCount = 0;

    constructor(private readonly opts: TileStreamerOptions<T, G>) { }

    get stats(): StreamerStats {
        return {
            wanted: this.wantKeys.size,
            uploaded: this.uploaded,
            uploadMs: this.uploadMs,
            prefetched: this.prefetched,
            resident: this.gpu.size,
            residentBytes: this.residentBytes(),
            evicted: this.evictedCount,
        };
    }

    /** Tiles that must never be cancelled or skipped, whatever the want set. */
    setPinnedKeys(keys: Iterable<string>): void {
        this.pinnedKeys = new Set(keys);
    }

    /** Changes whenever a tile is uploaded or dropped; equal means the same resident set. */
    get version(): number {
        return this.residentVersion;
    }

    /** Drawable object for a tile, if it has been uploaded. */
    get(id: TileKey): G | undefined {
        return this.gpu.get(tileKeyString(id));
    }

    has(id: TileKey): boolean {
        return this.gpu.has(tileKeyString(id));
    }

    /** Every uploaded drawable, resident or not currently drawn. */
    values(): IterableIterator<G> {
        return this.gpu.values();
    }

    /**
     * Declare the complete set of tiles worth having right now. Anything in
     * flight that is not in the set is aborted.
     *
     * `speculative` tiles (predictive prefetch) are wanted but never outrank a
     * visible tile; they are listed separately only so they can be counted.
     */
    setWants(wants: TileWant[], speculative: TileWant[] = []): void {
        const store = this.opts.store;
        const next = new Set<string>();
        const all = wants.concat(speculative);

        for (const w of all) {
            next.add(tileKeyString(w.id));
        }

        // Abort anything in flight that nobody wants any more.
        for (const key of store.activeKeys()) {
            if (!next.has(key) && !this.pinnedKeys.has(key)) {
                store.cancel(key);
            }
        }

        for (const w of all) {
            const key = tileKeyString(w.id);
            if (this.gpu.has(key) || this.ready.has(key)) {
                continue;
            }
            const parent = parentOf(w.id);
            const parentResident = parent === undefined
                || this.gpu.has(tileKeyString(parent))
                || store.isAbsent(parent);
            const score = scoreWant(w, parentResident);
            void store.request(w.id, score).then(value => {
                if (value !== null) {
                    this.ready.set(key, { id: w.id, value });
                }
            });
            store.reprioritise(key, score);
        }

        this.prefetched = speculative.length;
        this.wantKeys = next;
    }

    /**
     * Request tiles outside the want set — boot pinning, spawn seeding — and
     * route their results into the upload queue.
     *
     * This has to go through the streamer rather than straight to the store:
     * a value sitting in the store's cache is decoded but not *drawable*, and
     * only tiles that reach `ready` are ever uploaded.
     */
    async ensure(ids: TileKey[], priority: number): Promise<void> {
        await Promise.all(ids.map(async id => {
            const key = tileKeyString(id);
            if (this.gpu.has(key) || this.ready.has(key)) {
                return;
            }
            const value = await this.opts.store.request(id, priority);
            if (value !== null) {
                this.ready.set(key, { id, value });
            }
        }));
    }

    /**
     * Upload arrived tiles under a time budget. Tile sizes vary far too much
     * for a fixed count to bound the cost, and a burst landing in one frame is
     * exactly what causes a hitch.
     */
    pumpUploads(budgetMsOverride?: number): number {
        const now = this.opts.now ?? (() => Date.now());
        const budget = budgetMsOverride ?? this.opts.uploadBudgetMs ?? TILE_UPLOAD_BUDGET_MS;
        const start = now();
        let done = 0;
        for (const [key, entry] of this.ready) {
            if (now() - start >= budget) {
                break;
            }
            this.ready.delete(key);
            // A tile can stop being wanted between arriving and uploading.
            if (!this.wantKeys.has(key) && !this.pinnedKeys.has(key)) {
                continue;
            }
            this.gpu.set(key, this.opts.upload(entry.id, entry.value));
            this.lastUsed.set(key, this.generation);
            this.residentVersion++;
            done++;
        }
        this.uploaded += done;
        this.uploadMs = now() - start;
        return done;
    }

    /** Advance the use clock; call once per reconcile pass, before marking what it draws. */
    nextGeneration(): number {
        return ++this.generation;
    }

    /**
     * Mark an uploaded tile as in use this generation: drawn, or about to be
     * (a parent the budget may fold into, a child waiting on its siblings).
     * A tile that is not uploaded is ignored.
     */
    markUsed(id: TileKey): void {
        const key = tileKeyString(id);
        if (this.lastUsed.has(key)) {
            this.lastUsed.set(key, this.generation);
        }
    }

    /** Bytes the uploaded tiles hold now; 0 without sizeOf. */
    residentBytes(): number {
        const sizeOf = this.opts.sizeOf;
        if (!sizeOf) {
            return 0;
        }
        let total = 0;
        for (const g of this.gpu.values()) {
            total += sizeOf(g);
        }
        return total;
    }

    /**
     * Release idle uploaded tiles while the uploaded set is over its byte
     * budget, least recently used first. Idle means unused for at least
     * `idleGenerations` generations and not pinned; nothing else is ever
     * released, however far over budget. A released tile is simply no
     * longer resident: wanted again, it is requested and rebuilt like any
     * other. Returns how many were released.
     */
    evictIdle(): number {
        const sizeOf = this.opts.sizeOf;
        const maxBytes = this.opts.maxBytes ?? Infinity;
        if (!sizeOf || maxBytes === Infinity) {
            return 0;
        }
        let total = 0;
        const idle: Array<{ key: string; used: number; bytes: number }> = [];
        const before = this.generation - (this.opts.idleGenerations ?? 1);
        for (const [key, g] of this.gpu) {
            const bytes = sizeOf(g);
            total += bytes;
            const used = this.lastUsed.get(key) ?? this.generation;
            if (used <= before && !this.pinnedKeys.has(key)) {
                idle.push({ key, used, bytes });
            }
        }
        if (total <= maxBytes || idle.length === 0) {
            return 0;
        }
        // Oldest first; among equally old, the biggest frees the most.
        idle.sort((a, b) => a.used - b.used || b.bytes - a.bytes);
        let n = 0;
        for (const e of idle) {
            if (total <= maxBytes) {
                break;
            }
            this.evict(e.key);
            total -= e.bytes;
            n++;
        }
        this.evictedCount += n;
        return n;
    }

    /** Drop an uploaded tile and release what it holds. */
    evict(key: string): void {
        const g = this.gpu.get(key);
        if (g === undefined) {
            return;
        }
        this.gpu.delete(key);
        this.lastUsed.delete(key);
        this.residentVersion++;
        const [z, x, y] = key.split('/').map(Number);
        this.opts.release?.({ z, x, y }, g);
    }

    /** Number of decoded tiles waiting for the upload budget. */
    get pendingUploads(): number {
        return this.ready.size;
    }
}

/**
 * Extrapolate the camera position along its velocity, for prefetch. Returns
 * the point the camera is expected to reach in `lookaheadS` seconds.
 */
export function predictPosition(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    lookaheadS: number,
): { x: number; y: number; z: number } {
    return {
        x: x + vx * lookaheadS,
        y: y + vy * lookaheadS,
        z: z + vz * lookaheadS,
    };
}

/**
 * Where to prefetch: ahead along the direction the camera is *looking*.
 *
 * Extrapolating along velocity instead only works when the camera faces the
 * way it is moving. In an exterior view the camera orbits the aircraft, so its
 * velocity is the aircraft's — and prefetch then loads terrain ahead of the
 * *aircraft* while the view points somewhere else entirely, which is exactly
 * the terrain that visibly pops in late.
 *
 * The distance scales with speed but never falls to zero, so a camera that is
 * merely turning still pulls in what it is about to face.
 */
export function predictViewTarget(
    x: number, y: number, z: number,
    fx: number, fy: number, fz: number,
    speedMps: number,
    lookaheadS: number,
    minDistanceM: number,
): { x: number; y: number; z: number } {
    const len = Math.hypot(fx, fy, fz);
    if (len < 1e-6) {
        return { x, y, z };
    }
    const d = Math.max(minDistanceM, speedMps * lookaheadS);
    return {
        x: x + (fx / len) * d,
        y: y + (fy / len) * d,
        z: z + (fz / len) * d,
    };
}
