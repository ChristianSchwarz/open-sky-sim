import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { TileKey } from '../../src/script/terrain/tiling';
import { RemoteConfig } from './remoteTiles';
import { satelliteToken, SATELLITE_PROTOCOL, TilePool } from './tilePool';

const tiles: TileKey[] = Array.from({ length: 8 }, (_, i) => ({ z: 12, x: i, y: 0 }));
const keyStr = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;

/** A local worker that answers every tile at once with its key. */
function localWorker(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tilepool-'));
    const file = path.join(dir, 'worker.mjs');
    fs.writeFileSync(file, `import { parentPort } from 'node:worker_threads';
parentPort.on('message', m => {
    if (m === null) { process.exit(0); }
    parentPort.postMessage({ idx: m.idx, result: \`\${m.key.z}/\${m.key.x}/\${m.key.y}\` });
});
`);
    return file;
}

function pool(port: number, localJobs: number): TilePool<string> {
    return new TilePool<string>({
        local: { file: localJobs > 0 ? localWorker() : '', execArgv: [], jobs: localJobs },
        cfg: {} as RemoteConfig,
        kindOf: () => 'farland',
        roots: {},
        satellites: { port, discovery: false },
        diskLow: () => false,
        label: () => '',
        t0: Date.now(),
        overdueFloorMs: 400,
    });
}

/**
 * A satellite with `threads` lease loops. A thread whose tile `hangs` keeps
 * heartbeating it and stops (its tile code hung); any other tile is answered
 * at once, after `delayMs`, with its key.
 */
async function fakeSatellite(port: number, name: string, threads: number, hangs: (k: TileKey) => boolean, delayMs = 0) {
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'x-sat-token': satelliteToken(), 'x-sat-id': name };
    const stop = new AbortController();
    const call = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers, signal: stop.signal });
    const { sha } = await (await call('/sat/code')).json() as { sha: string };
    await call('/sat/hello', { method: 'POST', body: JSON.stringify({ name, threads, protocol: SATELLITE_PROTOCOL, codeSha: sha }) });
    const leased: string[] = [];
    const active = new Set<number>();
    const beat = setInterval(() => {
        call('/sat/heartbeat', { method: 'POST', body: JSON.stringify([...active]) }).catch(() => undefined);
    }, 50);
    const thread = async () => {
        while (!stop.signal.aborted) {
            const res = await call('/sat/lease', { method: 'POST' });
            if (res.status === 204) {
                continue;
            }
            if (res.status !== 200) {
                return;
            }
            const job = await res.json() as { id: number; key: TileKey };
            leased.push(keyStr(job.key));
            if (hangs(job.key)) {
                active.add(job.id);
                return;
            }
            active.add(job.id);
            await new Promise(r => setTimeout(r, delayMs));
            const head = Buffer.from(JSON.stringify({ result: keyStr(job.key), outputs: [] }));
            const len = Buffer.alloc(4);
            len.writeUInt32LE(head.length);
            await call(`/sat/result/${job.id}`, { method: 'POST', body: Buffer.concat([len, head]) });
            active.delete(job.id);
        }
    };
    const loops = Array.from({ length: threads }, () => thread().catch(() => undefined));
    // Let the lease requests reach the pool before its pass starts.
    await new Promise(r => setTimeout(r, 200));
    return {
        leased,
        async close() {
            clearInterval(beat);
            stop.abort();
            await Promise.all(loops);
        },
    };
}

test('a tile a heartbeating satellite never finishes goes to the local workers', async () => {
    const p = pool(47891, 1);
    await p.start();
    const sat = await fakeSatellite(47891, 'hangs', 1, () => true);
    try {
        const r = await p.runPass(tiles, 1);
        assert.deepEqual(r.errors, []);
        assert.deepEqual(r.results, tiles.map(keyStr));
        // It held one tile, which did not come back to it.
        assert.equal(sat.leased.length, 1);
    } finally {
        await sat.close();
        await p.close();
    }
});

test('without local workers an overdue tile goes to another satellite, not back to the one it hung on', async () => {
    const p = pool(47892, 0);
    await p.start();
    const bad = await fakeSatellite(47892, 'bad', 4, k => k.x === 0);
    const good = await fakeSatellite(47892, 'good', 1, () => false, 20);
    try {
        const r = await p.runPass(tiles, 1);
        assert.deepEqual(r.errors, []);
        assert.deepEqual(r.results, tiles.map(keyStr));
        assert.equal(bad.leased.filter(k => k === '12/0/0').length, 1);
        assert.ok(good.leased.includes('12/0/0'));
    } finally {
        await bad.close();
        await good.close();
        await p.close();
    }
});

test('a tile that overruns on every try fails the pass instead of looping', async () => {
    const p = pool(47893, 0);
    await p.start();
    const sat = await fakeSatellite(47893, 'only', 4, k => k.x === 0);
    try {
        const r = await p.runPass(tiles, 1);
        assert.equal(r.errors.length, 1);
        assert.match(r.errors[0], /12\/0\/0.*overdue 3 times/);
        assert.equal(r.results[0], undefined);
        assert.deepEqual(r.results.slice(1), tiles.slice(1).map(keyStr));
        // The only satellite there is: it got the tile again, three times in all.
        assert.equal(sat.leased.filter(k => k === '12/0/0').length, 3);
    } finally {
        await sat.close();
        await p.close();
    }
});
