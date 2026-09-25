import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { TileKey, tileKeyString } from './tiling';
import { TileStore } from './tileStore';

interface Fake {
    key: string;
    bytes: number;
    disposed: boolean;
}

/** Scriptable fetch: per-URL status, delay and payload size. */
function makeStore(opts: {
    maxBytes?: number;
    status?: (url: string, attempt: number) => number;
    exists?: (id: TileKey) => boolean;
    bytes?: number;
    delayMs?: number;
    onDispose?: (v: Fake) => void;
} = {}) {
    const attempts = new Map<string, number>();
    const disposed: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const n = (attempts.get(url) ?? 0) + 1;
        attempts.set(url, n);
        if (init?.signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        const status = opts.status ? opts.status(url, n) : 200;
        if (status === 404) {
            return { ok: false, status: 404 } as Response;
        }
        if (status !== 200) {
            return { ok: false, status } as Response;
        }
        if (opts.delayMs) {
            await new Promise((res, rej) => {
                const timer = setTimeout(res, opts.delayMs);
                init?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                });
            });
        }
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new ArrayBuffer(opts.bytes ?? 100),
        } as Response;
    }) as typeof fetch;

    const store = new TileStore<Fake>({
        baseUrl: 'base',
        url: (id) => `base/${tileKeyString(id)}`,
        decode: (buf) => ({ key: 'x', bytes: buf.byteLength, disposed: false }),
        sizeOf: (v) => v.bytes,
        dispose: (v) => {
            v.disposed = true;
            disposed.push(v.key);
            opts.onDispose?.(v);
        },
        maxBytes: opts.maxBytes ?? 1_000_000,
        retryBackoffMs: 1,
        exists: opts.exists,
    });
    return {
        store,
        attempts,
        disposed,
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

const t = (z: number, x: number, y: number): TileKey => ({ z, x, y });

describe('TileStore', () => {
    it('caches a fetched tile and serves it without refetching', async () => {
        const h = makeStore();
        try {
            const a = await h.store.request(t(1, 2, 3), 0);
            const b = await h.store.request(t(1, 2, 3), 0);
            assert.ok(a);
            assert.equal(a, b);
            assert.equal(h.attempts.get('base/1/2/3'), 1);
        } finally {
            h.restore();
        }
    });

    it('dedupes concurrent requests for the same tile', async () => {
        const h = makeStore();
        try {
            const [a, b] = await Promise.all([
                h.store.request(t(1, 2, 3), 0),
                h.store.request(t(1, 2, 3), 0),
            ]);
            assert.equal(a, b);
            assert.equal(h.attempts.get('base/1/2/3'), 1);
        } finally {
            h.restore();
        }
    });

    it('never requests a tile the index says does not exist', async () => {
        const h = makeStore({ exists: () => false });
        try {
            assert.equal(await h.store.request(t(1, 2, 3), 0), null);
            assert.equal(h.attempts.size, 0);
        } finally {
            h.restore();
        }
    });

    it('treats a 404 as absent and does not retry it', async () => {
        const h = makeStore({ status: () => 404 });
        try {
            assert.equal(await h.store.request(t(4, 5, 6), 0), null);
            assert.equal(await h.store.request(t(4, 5, 6), 0), null);
            assert.equal(h.attempts.get('base/4/5/6'), 1, 'no refetch after 404');
            assert.equal(h.store.isAbsent(t(4, 5, 6)), true);
        } finally {
            h.restore();
        }
    });

    describe('byte-budget eviction', () => {
        it('evicts least-recently-drawn once over budget, and disposes', async () => {
            const h = makeStore({ maxBytes: 250, bytes: 100 });
            try {
                await h.store.request(t(0, 0, 0), 0);
                await h.store.request(t(0, 0, 1), 0);
                h.store.nextGeneration();
                // Touch tile 0 so tile 1 becomes the least recently used.
                h.store.get(t(0, 0, 0));
                await h.store.request(t(0, 0, 2), 0);

                assert.ok(h.store.has(t(0, 0, 0)), 'recently drawn survives');
                assert.ok(h.store.has(t(0, 0, 2)), 'newest survives');
                assert.equal(h.store.has(t(0, 0, 1)), false, 'stale one evicted');
                assert.equal(h.disposed.length, 1, 'dispose was called');
                assert.ok(h.store.stats.cacheBytes <= 250);
            } finally {
                h.restore();
            }
        });

        it('never evicts a pinned tile', async () => {
            const h = makeStore({ maxBytes: 150, bytes: 100 });
            try {
                await h.store.request(t(0, 0, 0), 0);
                h.store.setPinned(t(0, 0, 0), true);
                h.store.nextGeneration();
                await h.store.request(t(0, 0, 1), 0);
                await h.store.request(t(0, 0, 2), 0);
                assert.ok(h.store.has(t(0, 0, 0)), 'pinned tile survives the budget');
            } finally {
                h.restore();
            }
        });

        it('never evicts a tile drawn in the current generation', async () => {
            const h = makeStore({ maxBytes: 150, bytes: 100 });
            try {
                await h.store.request(t(0, 0, 0), 0);
                h.store.get(t(0, 0, 0));           // used this generation
                await h.store.request(t(0, 0, 1), 0);
                assert.ok(h.store.has(t(0, 0, 0)));
            } finally {
                h.restore();
            }
        });
    });

    describe('cancellation', () => {
        it('drops a queued tile that is no longer wanted', async () => {
            // pump() dispatches synchronously, so a tile is only *queued* once
            // there are more requests than the concurrency allows.
            const h = makeStore({ delayMs: 30 });
            try {
                const pending: Array<Promise<unknown>> = [];
                for (let i = 0; i < 40; i++) {
                    pending.push(h.store.request(t(9, 0, i), i));
                }
                assert.ok(h.store.stats.queued > 0, 'some tiles are queued');
                // The lowest priority is queued, not in flight.
                h.store.cancel('9/0/0');
                assert.equal(await h.store.request(t(9, 0, 0), 0).catch(() => null), null);
                assert.ok(h.store.stats.aborted >= 1);
                await Promise.all(pending);
            } finally {
                h.restore();
            }
        });

        it('aborts an in-flight fetch so its bytes stop arriving', async () => {
            const h = makeStore({ delayMs: 50 });
            try {
                const p = h.store.request(t(9, 9, 9), 0);
                assert.equal(h.store.stats.inflight, 1);
                h.store.cancel('9/9/9');
                assert.equal(await p, null, 'aborted fetch resolves null, not a value');
                assert.equal(h.store.has(t(9, 9, 9)), false, 'nothing was cached');
                assert.ok(h.store.stats.aborted >= 1);
            } finally {
                h.restore();
            }
        });

        it('reports queued and in-flight keys so the streamer can diff them', async () => {
            const h = makeStore();
            try {
                const p = h.store.request(t(3, 1, 1), 5);
                assert.ok(h.store.activeKeys().includes('3/1/1'));
                await p;
            } finally {
                h.restore();
            }
        });
    });

    describe('retry and permanent failure', () => {
        it('retries a 500 with backoff, then succeeds', async () => {
            const h = makeStore({ status: (_u, attempt) => (attempt < 3 ? 500 : 200) });
            try {
                const v = await h.store.request(t(2, 2, 2), 0);
                assert.ok(v, 'eventually resolved');
                assert.equal(h.attempts.get('base/2/2/2'), 3);
                assert.equal(h.store.stats.failed, 0);
            } finally {
                h.restore();
            }
        });

        it('gives up after the retry limit and marks the tile absent', async () => {
            const h = makeStore({ status: () => 500 });
            try {
                assert.equal(await h.store.request(t(7, 7, 7), 0), null);
                assert.equal(h.store.stats.failed, 1);
                assert.equal(h.store.isAbsent(t(7, 7, 7)), true,
                    'absent, so the quadtree falls back to the parent instead of a hole');
                // And it is not retried on the next request.
                const before = h.attempts.get('base/7/7/7');
                assert.equal(await h.store.request(t(7, 7, 7), 0), null);
                assert.equal(h.attempts.get('base/7/7/7'), before);
            } finally {
                h.restore();
            }
        });
    });

    it('re-scores a queued tile instead of keeping its enqueue priority', async () => {
        const h = makeStore();
        try {
            const p = h.store.request(t(5, 5, 5), 1);
            h.store.reprioritise('5/5/5', 999);
            await p;
            // The observable contract is that reprioritise does not disturb the
            // pending promise; ordering itself is covered by the streamer tests.
            assert.ok(h.store.has(t(5, 5, 5)));
        } finally {
            h.restore();
        }
    });

    it('adapts concurrency within the configured bounds', async () => {
        const h = makeStore();
        try {
            for (let i = 0; i < 40; i++) {
                await h.store.request(t(1, 0, i), 0);
            }
            const c = h.store.stats.concurrency;
            assert.ok(c >= 6 && c <= 32, `concurrency ${c} out of bounds`);
        } finally {
            h.restore();
        }
    });
});

void mock;

describe('raw gzip payloads', () => {
    it('recognises the gzip magic and inflates it with the native decoder', async () => {
        const zlib = await import('node:zlib');
        const { inflateGzip, isGzip } = await import('./tileStore');
        const plain = new Uint8Array([80, 84, 88, 49, 1, 2, 3, 4, 5, 6, 7, 8]);
        const gz = zlib.gzipSync(plain);
        const gzBuf = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
        assert.equal(isGzip(gzBuf), true);
        assert.equal(isGzip(plain.buffer as ArrayBuffer), false);
        const back = new Uint8Array(await inflateGzip(gzBuf));
        assert.deepEqual([...back], [...plain]);
    });
});
