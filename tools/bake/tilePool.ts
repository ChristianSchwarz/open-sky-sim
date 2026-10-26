/**
 * The tile pool of the grade and far land bakes: worker threads on this
 * machine and, with `satellites`, satellite machines on the LAN pulling the
 * same queue (tools/satellite/satellite.ts, built by `npm run build:satellite`).
 *
 * A local worker reads and writes the tiles itself, as it always has. A
 * satellite is sent its job's inputs (remoteTiles.ts inputsOf, by content hash,
 * so a tile its cache already holds is not sent again), runs the same tile
 * function on its own copy, and sends the outputs back; they are written here
 * through a temporary name, so a neighbour's reader never sees half a file.
 * The index and the manifest stay this machine's: the satellites only ever
 * make leaf files.
 *
 * The satellites find this machine by a UDP broadcast on DISCOVERY_PORT and
 * talk HTTP on `satellites.port`, every request carrying the shared token
 * (data/satellite/token, built into the exe). The tile code is built into the
 * exe too (tools/satellite/computeBundle.ts). This bake bundles the same code
 * from its own tree; a satellite whose hash differs (built before the tile
 * code last changed) fetches this bake's, signed with the token, before it
 * joins, so two versions' tiles never mix and the exe needs no rebuild. Only
 * a satellite on an older protocol is turned away.
 *
 * A satellite that stops heartbeating for LEASE_TIMEOUT_MS has its jobs put
 * back in the queue; a result that arrives after that is dropped.
 */

import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { TileKey } from '../../src/script/terrain/tiling';
import { RemoteConfig, RemoteKind, RemoteRoot, inputsOf, outputsOf, wireConfig } from './remoteTiles';
import { bundleCompute } from '../satellite/computeBundle';

export const DISCOVERY_PORT = 47810;
export const DEFAULT_SATELLITE_PORT = 47811;
/** Bumped when the satellite's side of the HTTP protocol changes. */
export const SATELLITE_PROTOCOL = 3;
export const TOKEN_FILE = path.join('data', 'satellite', 'token');

const LEASE_TIMEOUT_MS = 90_000;
const LONG_POLL_MS = 20_000;
/** Recently read input files kept for the satellites' blob requests, bytes. */
const BLOB_CACHE_BYTES = 512e6;

/** The shared secret, created on first use. */
export function satelliteToken(): string {
    if (!fs.existsSync(TOKEN_FILE)) {
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
        fs.writeFileSync(TOKEN_FILE, crypto.randomBytes(24).toString('hex'));
    }
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

export interface PoolOptions {
    /** The local worker bundle (or tsx source) and how many of it; 0 is satellites only. */
    local: { file: string; execArgv: string[]; jobs: number };
    cfg: RemoteConfig;
    kindOf: (pass: number) => RemoteKind;
    roots: Partial<Record<RemoteRoot, string>>;
    satellites?: { port: number };
    /** Checked every 50 dispatches; true stops handing out tiles. */
    diskLow: () => boolean;
    /** Printed before the progress line, e.g. 'pass 1: '. */
    label: (pass: number) => string;
    t0: number;
}

interface Lease { idx: number; pass: number; satId: string; beat: number; job: Job }
interface Job {
    id: number; kind: RemoteKind; key: TileKey; cfg: RemoteConfig; inputs: Record<string, string | null>; outputs: string[]; codeSha: string;
    /** The pass's progress, for the satellite's screen. */
    progress: { done: number; total: number; pass: number };
}
interface Satellite { id: string; name: string; threads: number; done: number; seen: number }
interface Waiter { res: http.ServerResponse; satId: string; timer: NodeJS.Timeout }

const keyOf = (k: TileKey) => `${k.z}/${k.x}/${k.y}`;

export class TilePool<R extends { key: string }> {
    private readonly workers: Worker[] = [];
    private readonly idle = new Set<Worker>();
    private server?: http.Server;
    private udp?: dgram.Socket;
    private token = '';
    private code = '';
    private codeSha = '';
    /** The code signed with the token: a satellite runs only code from a bake that holds it. */
    private codeHmac = '';
    /** Satellites already told they are too old, by name: said once, not every retry. */
    private readonly refused = new Set<string>();
    private readonly sats = new Map<string, Satellite>();
    private readonly leases = new Map<number, Lease>();
    private readonly waiters: Waiter[] = [];
    private nextJobId = 1;
    private expiry?: NodeJS.Timeout;
    private readonly hashes = new Map<string, { mtimeMs: number; size: number; sha: string }>();
    private readonly shaPath = new Map<string, string>();
    private readonly blobs = new Map<string, Buffer>();
    private blobBytes = 0;
    /** The pass running now, or undefined between passes. */
    private run?: {
        pass: number; tiles: readonly TileKey[]; queue: number[]; results: Array<R | undefined>; finished: boolean[];
        errors: string[]; done: number; dispatched: number; stoppedForDisk: boolean; lastLine: number; resolve: () => void;
    };

    constructor(private readonly opts: PoolOptions) {}

    async start(): Promise<void> {
        for (let i = 0; i < this.opts.local.jobs; i++) {
            const w = new Worker(this.opts.local.file, { execArgv: this.opts.local.execArgv, workerData: this.opts.cfg });
            w.on('message', (msg: { idx: number; result: R | { error: string } }) => {
                this.idle.add(w);
                this.complete(msg.idx, msg.result);
                this.feedIdle();
            });
            w.on('error', (err: Error) => {
                console.error(`\nerror: a local worker died: ${err.stack ?? err.message}`);
                process.exit(1);
            });
            this.workers.push(w);
            this.idle.add(w);
        }
        if (this.opts.satellites) {
            await this.startServer(this.opts.satellites.port);
        }
    }

    /** Run one pass over `tiles`; results in `tiles` order. */
    runPass(tiles: readonly TileKey[], pass: number): Promise<{ results: Array<R | undefined>; errors: string[]; stoppedForDisk: boolean }> {
        if (this.workers.length === 0 && !this.server) {
            throw new Error('a pool with no local workers needs satellites');
        }
        return new Promise(resolve => {
            const run = {
                pass, tiles, queue: tiles.map((_, i) => i), results: new Array<R | undefined>(tiles.length),
                finished: new Array<boolean>(tiles.length).fill(false), errors: [] as string[], done: 0, dispatched: 0,
                stoppedForDisk: false, lastLine: 0,
                resolve: () => {
                    this.run = undefined;
                    process.stdout.write('\n');
                    resolve({ results: run.results, errors: run.errors, stoppedForDisk: run.stoppedForDisk });
                },
            };
            this.run = run;
            if (tiles.length === 0) {
                run.resolve();
                return;
            }
            if (this.workers.length === 0 && this.sats.size === 0) {
                console.log(`  waiting for satellites on port ${this.opts.satellites!.port}...`);
            }
            this.feedIdle();
            this.wakeWaiters();
        });
    }

    async close(): Promise<void> {
        for (const w of this.workers) {
            w.postMessage(null);
        }
        if (this.expiry) {
            clearInterval(this.expiry);
        }
        for (const w of this.waiters.splice(0)) {
            clearTimeout(w.timer);
            w.res.writeHead(410).end();
        }
        this.udp?.close();
        if (this.server) {
            await new Promise<void>(r => this.server!.close(() => r()));
            this.server.closeAllConnections();
        }
        if (this.sats.size > 0) {
            console.log(`satellites: ${[...this.sats.values()].map(s => `${s.name} ${s.done} tiles`).join(', ')}`);
        }
    }

    // --- the queue ------------------------------------------------------------

    /** The next tile index to hand out, or undefined (queue empty, or the disk is low). */
    private take(): number | undefined {
        const run = this.run;
        if (!run || run.stoppedForDisk) {
            return undefined;
        }
        while (run.queue.length > 0) {
            if (run.dispatched % 50 === 0 && this.opts.diskLow()) {
                run.stoppedForDisk = true;
                run.queue.length = 0;
                this.maybeFinish();
                return undefined;
            }
            const idx = run.queue.shift()!;
            if (!run.finished[idx]) {
                run.dispatched++;
                return idx;
            }
        }
        return undefined;
    }

    private feedIdle(): void {
        for (const w of [...this.idle]) {
            const idx = this.take();
            if (idx === undefined) {
                return;
            }
            this.idle.delete(w);
            w.postMessage({ idx, key: this.run!.tiles[idx], pass: this.run!.pass });
        }
    }

    private complete(idx: number, result: R | { error: string }): void {
        const run = this.run;
        if (!run || run.finished[idx]) {
            return;
        }
        run.finished[idx] = true;
        run.done++;
        if ('error' in result) {
            run.errors.push(result.error);
        } else {
            run.results[idx] = result;
        }
        if (Date.now() - run.lastLine > 1000 || run.done === run.tiles.length) {
            const el = (Date.now() - this.opts.t0) / 1000;
            const remote = this.sats.size > 0 ? `, ${this.sats.size} satellites` : '';
            process.stdout.write(`\r  ${this.opts.label(run.pass)}${run.done}/${run.tiles.length} (${((run.done / run.tiles.length) * 100).toFixed(1)}%)  `
                + `${(el / 60).toFixed(1)} min${remote}   `);
            run.lastLine = Date.now();
        }
        this.maybeFinish();
    }

    /** The pass is over when every tile is finished, or the disk stopped it and nothing is out. */
    private maybeFinish(): void {
        const run = this.run;
        if (!run) {
            return;
        }
        if (run.done === run.tiles.length || (run.stoppedForDisk && run.dispatched === run.done)) {
            this.leases.clear();
            run.resolve();
        }
    }

    // --- the satellites ---------------------------------------------------------

    private async startServer(port: number): Promise<void> {
        this.token = satelliteToken();
        const compute = await bundleCompute();
        this.code = compute.code;
        this.codeSha = compute.sha;
        this.codeHmac = crypto.createHmac('sha256', this.token).update(this.code).digest('hex');
        this.server = http.createServer((req, res) => {
            this.handle(req, res).catch((err: Error) => {
                console.error(`\nsatellite request ${req.url} failed: ${err.message}`);
                if (!res.headersSent) {
                    res.writeHead(500).end();
                }
            });
        });
        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(port, () => resolve());
        });
        this.udp = dgram.createSocket('udp4');
        this.udp.on('message', (msg, rinfo) => {
            if (msg.toString() === 'rfs-satellite?') {
                this.udp!.send(JSON.stringify({ rfs: 'coordinator', port, host: os.hostname() }), rinfo.port, rinfo.address);
            }
        });
        this.udp.on('error', err => console.warn(`warning: satellite discovery off (${err.message}); start satellites with --coordinator`));
        this.udp.bind(DISCOVERY_PORT);
        this.expiry = setInterval(() => this.expireLeases(), 5000);
        const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address);
        console.log(`satellites: listening on port ${port} (${ips.join(', ')}), discovery on UDP ${DISCOVERY_PORT}, tile code ${this.codeSha.slice(0, 12)}`);
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (req.headers['x-sat-token'] !== this.token) {
            res.writeHead(401).end();
            return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const satId = String(req.headers['x-sat-id'] ?? '');
        const sat = this.sats.get(satId);
        if (sat) {
            sat.seen = Date.now();
        }
        if (req.method === 'POST' && url.pathname === '/sat/hello') {
            const body = JSON.parse((await readBody(req)).toString()) as { name: string; threads: number; protocol: number; codeSha?: string };
            if (body.protocol !== SATELLITE_PROTOCOL) {
                // Too old to fetch code it can speak to: only a new exe helps.
                res.writeHead(409, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ protocol: SATELLITE_PROTOCOL, codeSha: this.codeSha }));
                if (!this.refused.has(body.name)) {
                    this.refused.add(body.name);
                    console.warn(`\nwarning: turned away satellite ${body.name}: it speaks protocol ${body.protocol}, this bake `
                        + `${SATELLITE_PROTOCOL}; rebuild it (npm run build:satellite) and copy it over`);
                }
                return;
            }
            if (body.codeSha !== this.codeSha) {
                // Not joined yet: it fetches /sat/code and says hello again with this bake's hash.
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ codeSha: this.codeSha }));
                console.log(`\nsatellite ${body.name} has tile code ${String(body.codeSha).slice(0, 12)}; it is fetching this bake's`);
                return;
            }
            if (!this.sats.has(satId)) {
                console.log(`\nsatellite ${body.name} joined with ${body.threads} threads`);
            }
            this.sats.set(satId, { id: satId, name: body.name, threads: body.threads, done: sat?.done ?? 0, seen: Date.now() });
            res.writeHead(204).end();
        } else if (req.method === 'GET' && url.pathname === '/sat/code') {
            res.writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ code: this.code, sha: this.codeSha, hmac: this.codeHmac }));
        } else if (!sat) {
            res.writeHead(403).end();
        } else if (req.method === 'POST' && url.pathname === '/sat/lease') {
            this.lease(sat, res);
        } else if (req.method === 'POST' && url.pathname === '/sat/bye') {
            // Quitting: its tiles go back in the queue now, not after LEASE_TIMEOUT_MS.
            for (const [id, l] of this.leases) {
                if (l.satId === satId) {
                    this.leases.delete(id);
                    if (this.run && this.run.pass === l.pass && !this.run.finished[l.idx]) {
                        this.requeue(l.idx);
                    }
                }
            }
            console.log(`\nsatellite ${sat.name} left after ${sat.done} tiles`);
            this.sats.delete(satId);
            res.writeHead(204).end();
        } else if (req.method === 'POST' && url.pathname === '/sat/heartbeat') {
            const ids = JSON.parse((await readBody(req)).toString()) as number[];
            for (const id of ids) {
                const l = this.leases.get(id);
                if (l && l.satId === satId) {
                    l.beat = Date.now();
                }
            }
            res.writeHead(204).end();
        } else if (req.method === 'GET' && url.pathname.startsWith('/sat/blob/')) {
            const bytes = this.blob(url.pathname.slice('/sat/blob/'.length));
            if (!bytes) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.byteLength }).end(bytes);
        } else if (req.method === 'POST' && url.pathname.startsWith('/sat/result/')) {
            await this.result(sat, Number(url.pathname.slice('/sat/result/'.length)), await readBody(req));
            res.writeHead(204).end();
        } else {
            res.writeHead(404).end();
        }
    }

    /** Hand the satellite a job now, or hold the request until there is one (or LONG_POLL_MS). */
    private lease(sat: Satellite, res: http.ServerResponse): void {
        if (this.sendJob(sat, res)) {
            return;
        }
        const w: Waiter = {
            res, satId: sat.id,
            timer: setTimeout(() => {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                res.writeHead(204).end();
            }, LONG_POLL_MS),
        };
        this.waiters.push(w);
    }

    private wakeWaiters(): void {
        while (this.waiters.length > 0 && this.run && this.run.queue.length > 0) {
            const w = this.waiters.shift()!;
            clearTimeout(w.timer);
            const sat = this.sats.get(w.satId);
            if (!sat || !this.sendJob(sat, w.res)) {
                w.res.writeHead(204).end();
            }
        }
    }

    private sendJob(sat: Satellite, res: http.ServerResponse): boolean {
        const idx = this.take();
        if (idx === undefined) {
            return false;
        }
        const run = this.run!;
        const kind = this.opts.kindOf(run.pass);
        const key = run.tiles[idx];
        const inputs: Record<string, string | null> = {};
        for (const rel of inputsOf(kind, this.opts.cfg, key)) {
            inputs[rel] = this.hashOf(rel);
        }
        const job: Job = {
            id: this.nextJobId++, kind, key, cfg: wireConfig(kind, this.opts.cfg, key),
            inputs, outputs: outputsOf(kind, key), codeSha: this.codeSha,
            progress: { done: run.done, total: run.tiles.length, pass: run.pass },
        };
        this.leases.set(job.id, { idx, pass: run.pass, satId: sat.id, beat: Date.now(), job });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(job));
        return true;
    }

    private expireLeases(): void {
        const now = Date.now();
        for (const [id, l] of this.leases) {
            if (now - l.beat > LEASE_TIMEOUT_MS) {
                this.leases.delete(id);
                if (this.run && this.run.pass === l.pass && !this.run.finished[l.idx]) {
                    console.warn(`\nwarning: ${this.sats.get(l.satId)?.name ?? l.satId} stopped answering; ${keyOf(l.job.key)} goes back in the queue`);
                    this.requeue(l.idx);
                }
            }
        }
        for (const [id, s] of this.sats) {
            if (now - s.seen > LEASE_TIMEOUT_MS) {
                console.warn(`\nsatellite ${s.name} left`);
                this.sats.delete(id);
            }
        }
    }

    private requeue(idx: number): void {
        this.run!.queue.unshift(idx);
        this.run!.dispatched--;
        this.feedIdle();
        this.wakeWaiters();
    }

    private async result(sat: Satellite, jobId: number, body: Buffer): Promise<void> {
        const lease = this.leases.get(jobId);
        if (!lease || lease.satId !== sat.id || !this.run || this.run.pass !== lease.pass || this.run.finished[lease.idx]) {
            return;
        }
        this.leases.delete(jobId);
        const headLen = body.readUInt32LE(0);
        const head = JSON.parse(body.subarray(4, 4 + headLen).toString()) as {
            result?: R; error?: string; retry?: boolean; outputs: Array<{ rel: string; state: 'bytes' | 'deleted' | 'unchanged'; size: number }>;
        };
        if (head.retry) {
            this.requeue(lease.idx);
            return;
        }
        if (head.error !== undefined) {
            this.complete(lease.idx, { error: `${head.error} (on ${sat.name})` });
            return;
        }
        let o = 4 + headLen;
        for (const out of head.outputs) {
            if (!lease.job.outputs.includes(out.rel)) {
                throw new Error(`${sat.name} sent ${out.rel}, not an output of job ${jobId}`);
            }
            const abs = this.absOf(out.rel);
            if (out.state === 'bytes') {
                writeAtomic(abs, body.subarray(o, o + out.size));
                o += out.size;
            } else if (out.state === 'deleted' && fs.existsSync(abs)) {
                fs.unlinkSync(abs);
            }
        }
        sat.done++;
        this.complete(lease.idx, head.result!);
    }

    // --- the input files --------------------------------------------------------

    private absOf(rel: string): string {
        const slash = rel.indexOf('/');
        const root = this.opts.roots[rel.slice(0, slash) as RemoteRoot];
        if (!root) {
            throw new Error(`no root for ${rel}`);
        }
        return path.join(root, ...rel.slice(slash + 1).split('/'));
    }

    /** A file's content hash, null when it does not exist; its bytes kept for the blob request that follows. */
    private hashOf(rel: string): string | null {
        let abs: string;
        try {
            abs = this.absOf(rel);
        } catch {
            return null;
        }
        let st: fs.Stats;
        try {
            st = fs.statSync(abs);
        } catch {
            return null;
        }
        const known = this.hashes.get(abs);
        if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) {
            return known.sha;
        }
        const bytes = fs.readFileSync(abs);
        const sha = crypto.createHash('sha1').update(bytes).digest('hex');
        this.hashes.set(abs, { mtimeMs: st.mtimeMs, size: st.size, sha });
        this.shaPath.set(sha, abs);
        this.keepBlob(sha, bytes);
        return sha;
    }

    private keepBlob(sha: string, bytes: Buffer): void {
        if (this.blobs.has(sha)) {
            return;
        }
        this.blobs.set(sha, bytes);
        this.blobBytes += bytes.byteLength;
        while (this.blobBytes > BLOB_CACHE_BYTES) {
            const [old, b] = this.blobs.entries().next().value!;
            this.blobs.delete(old);
            this.blobBytes -= b.byteLength;
        }
    }

    private blob(sha: string): Buffer | undefined {
        const kept = this.blobs.get(sha);
        if (kept) {
            return kept;
        }
        const abs = this.shaPath.get(sha);
        if (!abs || !fs.existsSync(abs)) {
            return undefined;
        }
        const bytes = fs.readFileSync(abs);
        // The file may have been rewritten since it was hashed.
        return crypto.createHash('sha1').update(bytes).digest('hex') === sha ? bytes : undefined;
    }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const parts: Buffer[] = [];
        req.on('data', (c: Buffer) => parts.push(c));
        req.on('end', () => resolve(Buffer.concat(parts)));
        req.on('error', reject);
    });
}

/** Write through a temporary name, retrying a rename Windows refuses for a moment. */
function writeAtomic(p: string, bytes: Uint8Array): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.sat${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(tmp, p);
            return;
        } catch (err) {
            if (attempt >= 20) {
                throw err;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
    }
}
