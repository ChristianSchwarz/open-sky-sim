import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TileKey, tileKeyString } from './tiling';
import { TileStore } from './tileStore';
import {
    PRIORITY_IN_FRUSTUM, PRIORITY_PARENT_MISSING, PRIORITY_PINNED, TileStreamer, TileWant,
    predictPosition, predictViewTarget, scoreWant,
} from './tileStreamer';

const t = (z: number, x: number, y: number): TileKey => ({ z, x, y });

function want(over: Partial<TileWant> & { id: TileKey }): TileWant {
    return {
        ssePx: 4,
        distanceM: 1000,
        inFrustum: true,
        pinned: false,
        ...over,
    };
}

/** A store whose fetches resolve only when the test says so. */
function makeHarness(opts: { delayMs?: number } = {}) {
    const requested: Array<{ key: string; priority: number }> = [];
    const cancelled: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) {
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
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
        void input;
        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => new ArrayBuffer(64),
        } as Response;
    }) as typeof fetch;

    const store = new TileStore<{ n: number }>({
        baseUrl: 'b',
        url: (id) => `b/${tileKeyString(id)}`,
        decode: () => ({ n: 1 }),
        sizeOf: () => 64,
        maxBytes: 10_000_000,
        retryBackoffMs: 1,
    });
    const realRequest = store.request.bind(store);
    store.request = (id, priority) => {
        requested.push({ key: tileKeyString(id), priority });
        return realRequest(id, priority);
    };
    const realCancel = store.cancel.bind(store);
    store.cancel = (key) => {
        cancelled.push(key);
        realCancel(key);
    };

    let clock = 0;
    const streamer = new TileStreamer<{ n: number }, string>({
        store,
        upload: (id) => `gpu:${tileKeyString(id)}`,
        uploadBudgetMs: 4,
        now: () => clock,
    });
    return {
        store,
        streamer,
        requested,
        cancelled,
        tick: (ms: number) => { clock += ms; },
        restore: () => { globalThis.fetch = originalFetch; },
    };
}

describe('want scoring', () => {
    it('ranks pinned above everything else', () => {
        const pinned = scoreWant(want({ id: t(5, 1, 1), pinned: true, inFrustum: false }), true);
        const visible = scoreWant(want({ id: t(5, 1, 2), inFrustum: true }), true);
        assert.ok(pinned > visible);
        assert.ok(pinned >= PRIORITY_PINNED);
    });

    it('ranks visible above speculative', () => {
        const seen = scoreWant(want({ id: t(5, 1, 1), inFrustum: true }), true);
        const unseen = scoreWant(want({ id: t(5, 1, 2), inFrustum: false }), true);
        assert.ok(seen > unseen);
        assert.ok(seen - unseen >= PRIORITY_IN_FRUSTUM - 1);
    });

    it('ranks a tile with a missing parent above an equal one whose parent is resident', () => {
        const base = want({ id: t(5, 1, 1) });
        const orphan = scoreWant(base, false);
        const settled = scoreWant(base, true);
        assert.ok(orphan > settled, 'coarse-to-fine falls out of the scoring');
        assert.equal(orphan - settled, PRIORITY_PARENT_MISSING);
    });

    it('prefers nearer tiles at equal error', () => {
        const near = scoreWant(want({ id: t(5, 1, 1), distanceM: 500 }), true);
        const far = scoreWant(want({ id: t(5, 1, 2), distanceM: 50_000 }), true);
        assert.ok(near > far);
    });

    it('prefers higher screen-space error at equal distance', () => {
        const big = scoreWant(want({ id: t(5, 1, 1), ssePx: 20 }), true);
        const small = scoreWant(want({ id: t(5, 1, 2), ssePx: 2 }), true);
        assert.ok(big > small);
    });
});

describe('TileStreamer', () => {
    it('requests every wanted tile once', async () => {
        const h = makeHarness();
        try {
            h.streamer.setWants([want({ id: t(3, 1, 1) }), want({ id: t(3, 1, 2) })]);
            await Promise.resolve();
            const keys = h.requested.map(r => r.key);
            assert.deepEqual(keys.sort(), ['3/1/1', '3/1/2']);
        } finally {
            h.restore();
        }
    });

    it('aborts an in-flight tile that drops out of the want set', async () => {
        const h = makeHarness({ delayMs: 50 });
        try {
            h.streamer.setWants([want({ id: t(3, 1, 1) }), want({ id: t(3, 1, 2) })]);
            h.streamer.setWants([want({ id: t(3, 1, 1) })]);
            assert.ok(h.cancelled.includes('3/1/2'), 'dropped tile was cancelled');
            assert.ok(!h.cancelled.includes('3/1/1'), 'kept tile was not');
        } finally {
            h.restore();
        }
    });

    it('re-scores a tile that is still wanted after the camera moves', async () => {
        const h = makeHarness({ delayMs: 50 });
        try {
            const id = t(3, 4, 4);
            h.streamer.setWants([want({ id, distanceM: 100_000, inFrustum: false })]);
            const first = h.requested[h.requested.length - 1].priority;
            // Same tile, now close and visible: it must not keep the old score.
            h.streamer.setWants([want({ id, distanceM: 200, inFrustum: true })]);
            const rescored = scoreWant(want({ id, distanceM: 200, inFrustum: true }), true);
            assert.ok(rescored > first, 'the new score is higher');
            assert.ok(!h.cancelled.includes('3/4/4'), 'still wanted, so not cancelled');
        } finally {
            h.restore();
        }
    });

    describe('upload budget', () => {
        it('stops at the budget and resumes next frame rather than dropping work', async () => {
            const h = makeHarness();
            try {
                const wants = Array.from({ length: 8 }, (_, i) => want({ id: t(4, 0, i) }));
                h.streamer.setWants(wants);
                // Let all the fetches settle.
                await new Promise(r => setTimeout(r, 5));

                assert.equal(h.streamer.pendingUploads, 8, 'all decoded, none uploaded yet');
                // Clock advances past the budget after 4 uploads.
                // Time only advances between frames, so one pump drains what
                // it can inside the budget and the rest stays queued.
                const uploads = h.streamer.pumpUploads();
                assert.ok(uploads > 0, 'uploaded something');
                assert.equal(
                    uploads + h.streamer.pendingUploads, 8,
                    'nothing was dropped',
                );
            } finally {
                h.restore();
            }
        });

        it('skips a tile that stopped being wanted before it was uploaded', async () => {
            const h = makeHarness();
            try {
                h.streamer.setWants([want({ id: t(4, 9, 9) })]);
                await new Promise(r => setTimeout(r, 5));
                assert.equal(h.streamer.pendingUploads, 1);
                h.streamer.setWants([]);          // no longer wanted
                h.streamer.pumpUploads();
                assert.equal(h.streamer.has(t(4, 9, 9)), false, 'not uploaded');
            } finally {
                h.restore();
            }
        });

        it('makes uploaded tiles retrievable', async () => {
            const h = makeHarness();
            try {
                h.streamer.setWants([want({ id: t(4, 2, 2) })]);
                await new Promise(r => setTimeout(r, 5));
                h.streamer.pumpUploads();
                assert.equal(h.streamer.get(t(4, 2, 2)), 'gpu:4/2/2');
            } finally {
                h.restore();
            }
        });
    });

    it('counts speculative prefetch separately from visible wants', async () => {
        const h = makeHarness({ delayMs: 20 });
        try {
            h.streamer.setWants(
                [want({ id: t(3, 1, 1) })],
                [want({ id: t(3, 8, 8), inFrustum: false })],
            );
            assert.equal(h.streamer.stats.prefetched, 1);
            assert.equal(h.streamer.stats.wanted, 2);
            const keys = h.requested.map(r => r.key);
            assert.ok(keys.includes('3/8/8'), 'prefetched tile was requested');
        } finally {
            h.restore();
        }
    });

    it('releases an evicted tile', async () => {
        const released: string[] = [];
        const h = makeHarness();
        try {
            const s = new TileStreamer<{ n: number }, string>({
                store: h.store,
                upload: (id) => `gpu:${tileKeyString(id)}`,
                release: (id) => released.push(tileKeyString(id)),
            });
            s.setWants([want({ id: t(6, 1, 1) })]);
            await new Promise(r => setTimeout(r, 5));
            s.pumpUploads();
            assert.ok(s.has(t(6, 1, 1)));
            s.evict('6/1/1');
            assert.equal(s.has(t(6, 1, 1)), false);
            assert.deepEqual(released, ['6/1/1']);
        } finally {
            h.restore();
        }
    });
});

describe('TileStreamer idle eviction', () => {
    /** Four uploaded tiles of 100 bytes each, under a 250-byte budget. */
    async function residentFour(h: ReturnType<typeof makeHarness>, idleGenerations = 2) {
        const released: string[] = [];
        const uploads: string[] = [];
        const s = new TileStreamer<{ n: number }, string>({
            store: h.store,
            upload: (id) => {
                uploads.push(tileKeyString(id));
                return `gpu:${tileKeyString(id)}`;
            },
            release: (id) => released.push(tileKeyString(id)),
            sizeOf: () => 100,
            maxBytes: 250,
            idleGenerations,
        });
        const ids = [t(8, 0, 0), t(8, 1, 0), t(8, 2, 0), t(8, 3, 0)];
        s.setWants(ids.map(id => want({ id })));
        await new Promise(r => setTimeout(r, 5));
        s.pumpUploads();
        assert.equal(s.stats.resident, 4);
        assert.equal(s.stats.residentBytes, 400);
        // Resident and drawn: the quadtree stops wanting what it has.
        s.setWants([]);
        return { s, ids, released, uploads };
    }

    it('never releases a tile that is drawn, however far over budget', async () => {
        const h = makeHarness();
        try {
            const { s, ids, released } = await residentFour(h);
            for (let g = 0; g < 10; g++) {
                s.nextGeneration();
                ids.forEach(id => s.markUsed(id));
                assert.equal(s.evictIdle(), 0);
            }
            assert.deepEqual(released, []);
            assert.equal(s.stats.resident, 4);
        } finally {
            h.restore();
        }
    });

    it('releases idle tiles past the budget, least recently drawn first, and only down to it', async () => {
        const h = makeHarness();
        try {
            const { s, ids, released } = await residentFour(h);
            // 8/0/0 last drawn in generation 1, 8/1/0 in 2, the others throughout.
            for (let g = 1; g <= 6; g++) {
                s.nextGeneration();
                if (g <= 1) s.markUsed(ids[0]);
                if (g <= 2) s.markUsed(ids[1]);
                s.markUsed(ids[2]);
                s.markUsed(ids[3]);
            }
            assert.equal(s.evictIdle(), 2);
            assert.deepEqual(released, ['8/0/0', '8/1/0']);
            assert.equal(s.has(ids[0]), false);
            assert.equal(s.has(ids[2]), true);
            assert.equal(s.stats.residentBytes, 200);
            assert.equal(s.stats.evicted, 2);
            // Under budget now: nothing more goes, idle or not.
            s.nextGeneration();
            s.nextGeneration();
            s.nextGeneration();
            assert.equal(s.evictIdle(), 0);
        } finally {
            h.restore();
        }
    });

    it('waits the idle generations before releasing anything', async () => {
        const h = makeHarness();
        try {
            const { s, released } = await residentFour(h, 3);
            s.nextGeneration();
            s.nextGeneration();
            assert.equal(s.evictIdle(), 0, 'idle two generations, three needed');
            s.nextGeneration();
            assert.equal(s.evictIdle(), 2);
            assert.equal(released.length, 2);
        } finally {
            h.restore();
        }
    });

    it('never releases a pinned tile', async () => {
        const h = makeHarness();
        try {
            const { s, ids, released } = await residentFour(h);
            s.setPinnedKeys(ids.slice(0, 3).map(tileKeyString));
            for (let g = 0; g < 5; g++) {
                s.nextGeneration();
            }
            assert.equal(s.evictIdle(), 1, 'only the one unpinned tile can go');
            assert.deepEqual(released, ['8/3/0']);
            for (const id of ids.slice(0, 3)) {
                assert.ok(s.has(id), `${tileKeyString(id)} is pinned`);
            }
        } finally {
            h.restore();
        }
    });

    it('requests and rebuilds a released tile when it is wanted again', async () => {
        const h = makeHarness();
        try {
            const { s, ids, released, uploads } = await residentFour(h);
            for (let g = 0; g < 3; g++) {
                s.nextGeneration();
                ids.slice(1).forEach(id => s.markUsed(id));
            }
            assert.equal(s.evictIdle(), 1, 'the one idle tile, though still over budget');
            assert.deepEqual(released, ['8/0/0']);
            const versionAfterEvict = s.version;
            h.requested.length = 0;

            s.setWants([want({ id: ids[0] })]);
            assert.deepEqual(h.requested.map(r => r.key), ['8/0/0'], 'asked for again');
            await new Promise(r => setTimeout(r, 5));
            s.pumpUploads();
            assert.equal(s.get(ids[0]), 'gpu:8/0/0');
            assert.equal(uploads.filter(k => k === '8/0/0').length, 2, 'built a second time');
            assert.ok(s.version > versionAfterEvict);
            // Fresh: just uploaded counts as used, so it is not the next to go.
            s.nextGeneration();
            s.markUsed(ids[2]);
            s.markUsed(ids[3]);
            assert.equal(s.evictIdle(), 0, 'one generation idle is not enough');
        } finally {
            h.restore();
        }
    });

    it('evicts nothing without a size or a budget', async () => {
        const h = makeHarness();
        try {
            await new Promise(r => setTimeout(r, 0));
            h.streamer.setWants([want({ id: t(8, 5, 5) })]);
            await new Promise(r => setTimeout(r, 5));
            h.streamer.pumpUploads();
            for (let g = 0; g < 5; g++) {
                h.streamer.nextGeneration();
            }
            assert.equal(h.streamer.evictIdle(), 0);
            assert.ok(h.streamer.has(t(8, 5, 5)));
        } finally {
            h.restore();
        }
    });
});

describe('predictive prefetch', () => {
    /**
     * The distinction that matters: in an exterior view the camera orbits the
     * aircraft, so camera velocity is the *aircraft's* heading. Prefetching
     * along velocity loaded terrain ahead of the aircraft while the view
     * pointed elsewhere, so whatever the player was looking at popped in late.
     */
    it('aims where the camera looks, not where it travels', () => {
        // Flying north at 300 m/s, but looking east.
        const look = predictViewTarget(0, 1000, 0, 1, 0, 0, 300, 4, 3000);
        assert.ok(look.x > 1000, `should reach east, got x=${look.x}`);
        assert.equal(look.z, 0, 'and not north, where the aircraft is going');

        const travel = predictPosition(0, 1000, 0, 0, 0, 300, 4);
        assert.equal(travel.x, 0);
        assert.ok(travel.z > 1000, 'velocity-based prefetch goes north instead');
    });

    it('reaches further the faster the camera moves', () => {
        // Low floor here so the speed term is what is being measured; at the
        // real 3 km floor both of these would clamp to it.
        const slow = predictViewTarget(0, 0, 0, 0, 0, 1, 50, 4, 100);
        const fast = predictViewTarget(0, 0, 0, 0, 0, 1, 300, 4, 100);
        assert.equal(slow.z, 200, '50 m/s for 4 s');
        assert.equal(fast.z, 1200, '300 m/s for 4 s');
        assert.ok(fast.z > slow.z);
    });

    it('still reaches ahead when the camera is only turning', () => {
        // A camera that is not moving at all must still pull in what it faces,
        // or an orbiting exterior view prefetches nothing.
        const p = predictViewTarget(0, 500, 0, 0, 0, 1, 0, 4, 3000);
        assert.equal(p.z, 3000, 'falls back to the minimum distance');
    });

    it('normalises the view direction', () => {
        const p = predictViewTarget(0, 0, 0, 0, 0, 7, 0, 4, 3000);
        assert.equal(p.z, 3000, 'a non-unit forward vector must not scale it');
    });

    it('is a no-op for a degenerate direction', () => {
        const p = predictViewTarget(5, 6, 7, 0, 0, 0, 300, 4, 3000);
        assert.deepEqual(p, { x: 5, y: 6, z: 7 });
    });

    it('extrapolates ahead of the camera, not behind it', () => {
        const p = predictPosition(0, 0, 0, 300, 0, 0, 4);
        assert.equal(p.x, 1200, 'four seconds at 300 m/s');
        assert.equal(p.z, 0);
    });

    it('is a no-op when stationary', () => {
        const p = predictPosition(10, 20, 30, 0, 0, 0, 4);
        assert.deepEqual(p, { x: 10, y: 20, z: 30 });
    });
});
