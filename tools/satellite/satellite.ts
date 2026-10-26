/**
 * A bake satellite: lends this machine's cores to a grade or far land bake
 * running elsewhere on the LAN (tools/bake/tilePool.ts).
 *
 * Built into one exe by `npm run build:satellite` (dist/satellite): copy it to
 * any Windows machine and run it - no checkout, no Node, no Python. It finds
 * a bake by UDP broadcast, waits while there is none, and goes back to
 * waiting when one ends. The tile code it runs comes from the bake (signed
 * with the shared token built into the exe), so the exe never goes stale.
 *
 *   retroflightsim-satellite.exe [options]
 *
 *     --coordinator HOST:PORT  skip the broadcast (another subnet, VPN)
 *     --threads N              compute threads (default: CPUs - 1, at most one per 3 GB of RAM)
 *     --cache DIR              tile cache (default: %LOCALAPPDATA%\retroflightsim-satellite)
 *     --cache-gb N             cache size kept between bakes (default 10)
 *     --name NAME              shown in the bake's log (default: the host name)
 *     --once                   exit after one bake instead of waiting for the next
 *
 * Under tsx from a checkout, the token is read from data/satellite/token.
 */

import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

declare const __SAT_TOKEN__: string | undefined;

const DISCOVERY_PORT = 47810;
const PROTOCOL = 1;
const HEARTBEAT_MS = 15_000;
const REL_PATTERN = /^(terrain|lidar|planet)\/\d+\/-?\d+\/-?\d+\.[a-z0-9]+$/;

interface Args { coordinator?: string; threads: number; cache: string; cacheGb: number; name: string; once: boolean }

interface Job {
    id: number; kind: string; key: { z: number; x: number; y: number }; cfg: unknown;
    inputs: Record<string, string | null>; outputs: string[]; codeSha: string;
}

function parseArgs(argv: string[]): Args {
    const a: Args = {
        threads: Math.max(1, Math.min(os.cpus().length - 1, Math.floor(os.totalmem() / 3e9))),
        cache: path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'retroflightsim-satellite'),
        cacheGb: 10, name: os.hostname(), once: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        const next = () => argv[++i];
        if (k === '--coordinator') a.coordinator = next();
        else if (k === '--threads') a.threads = Math.max(1, Number(next()));
        else if (k === '--cache') a.cache = next();
        else if (k === '--cache-gb') a.cacheGb = Number(next());
        else if (k === '--name') a.name = next();
        else if (k === '--once') a.once = true;
        else if (k === '--help' || k === '-h') {
            console.log('retroflightsim-satellite [--coordinator HOST:PORT] [--threads N] [--cache DIR] [--cache-gb N] [--name NAME] [--once]');
            process.exit(0);
        } else throw new Error(`unknown argument ${k}`);
    }
    return a;
}

function token(): string {
    if (typeof __SAT_TOKEN__ === 'string') {
        return __SAT_TOKEN__;
    }
    const f = path.join('data', 'satellite', 'token');
    if (process.env.RFS_SAT_TOKEN) {
        return process.env.RFS_SAT_TOKEN;
    }
    if (fs.existsSync(f)) {
        return fs.readFileSync(f, 'utf8').trim();
    }
    throw new Error('no token: run from the checkout (data/satellite/token) or use the built exe');
}

const log = (s: string) => console.log(`${new Date().toLocaleTimeString()}  ${s}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha1 = (b: Uint8Array) => crypto.createHash('sha1').update(b).digest('hex');

/** Broadcast on every interface until a bake answers; its host:port. */
async function discover(): Promise<string> {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>(r => sock.bind(0, () => r()));
    sock.setBroadcast(true);
    const targets = new Set(['255.255.255.255', '127.0.0.1']);
    for (const i of Object.values(os.networkInterfaces()).flat()) {
        if (i && i.family === 'IPv4' && !i.internal) {
            const a = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
            targets.add(a.map((v, j) => (v & m[j]) | (~m[j] & 255)).join('.'));
        }
    }
    let said = false;
    try {
        for (;;) {
            const answer = new Promise<string | undefined>(resolve => {
                const t = setTimeout(() => resolve(undefined), 2000);
                sock.once('message', (msg, rinfo) => {
                    clearTimeout(t);
                    try {
                        const m = JSON.parse(msg.toString()) as { rfs: string; port: number };
                        resolve(m.rfs === 'coordinator' ? `${rinfo.address}:${m.port}` : undefined);
                    } catch {
                        resolve(undefined);
                    }
                });
            });
            for (const t of targets) {
                sock.send('rfs-satellite?', DISCOVERY_PORT, t, () => undefined);
            }
            const found = await answer;
            if (found) {
                return found;
            }
            if (!said) {
                log('waiting for a bake (start one with --satellites)...');
                said = true;
            }
            await sleep(1000);
        }
    } finally {
        sock.close();
    }
}

class SessionOver extends Error {}
/** An input could not be fetched (rewritten at the bake since): the bake hands the tile out again. */
class Retry extends Error {}

class Satellite {
    private readonly id = crypto.randomUUID();
    private readonly tok = token();
    private code?: { sha: string; text: string };
    private readonly blobFetches = new Map<string, Promise<void>>();
    private readonly active = new Set<number>();
    private done = 0;
    /** Sessions joined so far. */
    private joined = 0;

    constructor(private readonly args: Args) {
        fs.mkdirSync(path.join(args.cache, 'blobs'), { recursive: true });
        fs.rmSync(path.join(args.cache, 'jobs'), { recursive: true, force: true });
        this.pruneCache();
    }

    async serve(): Promise<void> {
        let quiet = false;
        for (;;) {
            const coord = this.args.coordinator ?? await discover();
            const joined = this.joined;
            try {
                await this.session(coord);
                quiet = false;
            } catch (err) {
                if (this.joined === joined && ['TypeError', 'TimeoutError'].includes((err as Error).name)) {
                    // Nobody there yet (--coordinator given and the bake not started): wait for it.
                    if (!quiet) {
                        log(`waiting for a bake at ${coord}...`);
                        quiet = true;
                    }
                } else if (!(err instanceof SessionOver)) {
                    log(`lost the bake at ${coord}: ${(err as Error).message}`);
                }
            }
            if (this.args.once && this.joined > 0) {
                return;
            }
            await sleep(2000);
        }
    }

    private async call(base: string, p: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
        const res = await fetch(`http://${base}${p}`, {
            ...init,
            headers: { 'x-sat-token': this.tok, 'x-sat-id': this.id, ...(init.headers ?? {}) },
            signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
        });
        if (res.status === 401) {
            throw new Error('the bake refused this satellite\'s token: rebuild it from that checkout (npm run build:satellite)');
        }
        if (res.status === 410 || res.status === 403) {
            throw new SessionOver();
        }
        return res;
    }

    private async session(base: string): Promise<void> {
        this.currentBase = base;
        const hello = await this.call(base, '/sat/hello', {
            method: 'POST', body: JSON.stringify({ name: this.args.name, threads: this.args.threads, protocol: PROTOCOL }),
        });
        if (hello.status === 426) {
            throw new Error('this satellite is older than the bake: rebuild it (npm run build:satellite)');
        }
        const { codeSha } = await hello.json() as { codeSha: string };
        if (this.code?.sha !== codeSha) {
            const c = await (await this.call(base, '/sat/code')).json() as { code: string; sha: string; hmac: string };
            const mac = crypto.createHmac('sha256', this.tok).update(c.code).digest('hex');
            if (mac !== c.hmac || c.sha !== codeSha) {
                throw new Error('the bake\'s code is not signed with this satellite\'s token');
            }
            this.code = { sha: c.sha, text: c.code };
        }
        log(`joined the bake at ${base} with ${this.args.threads} threads`);
        this.joined++;
        const beat = setInterval(() => {
            void this.call(base, '/sat/heartbeat', { method: 'POST', body: JSON.stringify([...this.active]) }).catch(() => undefined);
        }, HEARTBEAT_MS);
        try {
            const before = this.done;
            await Promise.all(Array.from({ length: this.args.threads }, () => this.slot(base, this.code!)));
            log(`the bake is over; ${this.done - before} tiles done here`);
        } finally {
            clearInterval(beat);
        }
    }

    /** One compute thread's loop: lease, fetch, run, send back; until the bake goes away. */
    private async slot(base: string, code: { sha: string; text: string }): Promise<void> {
        let worker = new Worker(code.text, { eval: true });
        try {
            for (;;) {
                let res: Response;
                try {
                    res = await this.call(base, '/sat/lease', { method: 'POST', timeoutMs: 60_000 });
                } catch (err) {
                    if (err instanceof SessionOver || ['TypeError', 'TimeoutError'].includes((err as Error).name)) {
                        return; // gone: refused, or the connection itself failed
                    }
                    throw err;
                }
                if (res.status === 204) {
                    continue;
                }
                if (!res.ok) {
                    throw new Error(`lease answered ${res.status}`);
                }
                const job = await res.json() as Job;
                if (job.codeSha !== code.sha) {
                    return; // the bake restarted with other code: the next session fetches it
                }
                this.active.add(job.id);
                try {
                    const body = await this.runJob(job, worker).catch(async (err: Error) => {
                        if (err instanceof Retry) {
                            return frame({ retry: true, outputs: [] }, []);
                        }
                        await worker.terminate();
                        worker = new Worker(code.text, { eval: true });
                        return frame({ error: err.message, outputs: [] }, []);
                    });
                    await this.call(base, `/sat/result/${job.id}`, { method: 'POST', body });
                    this.done++;
                } finally {
                    this.active.delete(job.id);
                }
            }
        } finally {
            void worker.terminate();
        }
    }

    private async runJob(job: Job, worker: Worker): Promise<Buffer<ArrayBuffer>> {
        const jobDir = path.join(this.args.cache, 'jobs', String(job.id));
        try {
            for (const [rel, sha] of Object.entries(job.inputs)) {
                if (!REL_PATTERN.test(rel)) {
                    throw new Error(`refusing input path ${rel}`);
                }
                if (sha) {
                    await this.blob(sha).catch((err: Error) => {
                        throw err instanceof SessionOver ? err : new Retry(err.message);
                    });
                    const p = path.join(jobDir, ...rel.split('/'));
                    fs.mkdirSync(path.dirname(p), { recursive: true });
                    fs.copyFileSync(this.blobPath(sha), p);
                }
            }
            const reply = await new Promise<{ result?: unknown; error?: string }>((resolve, reject) => {
                const onMsg = (m: { id: number; result?: unknown; error?: string }) => {
                    if (m.id === job.id) {
                        worker.off('message', onMsg);
                        worker.off('error', reject);
                        resolve(m);
                    }
                };
                worker.on('message', onMsg);
                worker.once('error', reject);
                worker.postMessage({ id: job.id, kind: job.kind, cfg: job.cfg, key: job.key, jobDir });
            });
            if (reply.error !== undefined) {
                return frame({ error: reply.error, outputs: [] }, []);
            }
            const outputs: Array<{ rel: string; state: string; size: number }> = [];
            const bytes: Uint8Array[] = [];
            for (const rel of job.outputs) {
                if (!REL_PATTERN.test(rel)) {
                    throw new Error(`refusing output path ${rel}`);
                }
                const p = path.join(jobDir, ...rel.split('/'));
                if (!fs.existsSync(p)) {
                    outputs.push({ rel, state: 'deleted', size: 0 });
                    continue;
                }
                const b = fs.readFileSync(p);
                if (job.inputs[rel] === sha1(b)) {
                    outputs.push({ rel, state: 'unchanged', size: 0 });
                } else {
                    outputs.push({ rel, state: 'bytes', size: b.byteLength });
                    bytes.push(b);
                }
            }
            return frame({ result: reply.result, outputs }, bytes);
        } finally {
            fs.rmSync(jobDir, { recursive: true, force: true });
        }
    }

    private blobPath(sha: string): string {
        return path.join(this.args.cache, 'blobs', sha.slice(0, 2), sha);
    }

    /** The blob in the cache, fetched once however many jobs ask for it at the same time. */
    private blob(sha: string): Promise<void> {
        const p = this.blobPath(sha);
        if (fs.existsSync(p)) {
            return Promise.resolve();
        }
        let f = this.blobFetches.get(sha);
        if (!f) {
            f = (async () => {
                const base = this.currentBase!;
                const res = await this.call(base, `/sat/blob/${sha}`);
                if (!res.ok) {
                    throw new Error(`blob ${sha} answered ${res.status}`);
                }
                const b = new Uint8Array(await res.arrayBuffer());
                if (sha1(b) !== sha) {
                    throw new Error(`blob ${sha} arrived corrupted`);
                }
                fs.mkdirSync(path.dirname(p), { recursive: true });
                const tmp = `${p}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, b);
                fs.renameSync(tmp, p);
            })().finally(() => this.blobFetches.delete(sha));
            this.blobFetches.set(sha, f);
        }
        return f;
    }

    private currentBase?: string;

    /** Keep the cache under --cache-gb, oldest first. */
    private pruneCache(): void {
        const root = path.join(this.args.cache, 'blobs');
        const files: Array<{ p: string; size: number; t: number }> = [];
        for (const d of fs.readdirSync(root)) {
            for (const f of fs.readdirSync(path.join(root, d))) {
                const p = path.join(root, d, f);
                const st = fs.statSync(p);
                files.push({ p, size: st.size, t: st.mtimeMs });
            }
        }
        let total = files.reduce((n, f) => n + f.size, 0);
        files.sort((a, b) => a.t - b.t);
        for (const f of files) {
            if (total <= this.args.cacheGb * 1e9) {
                break;
            }
            fs.rmSync(f.p, { force: true });
            total -= f.size;
        }
    }
}

/** A result body: header length, header JSON, then the output bytes in order. */
function frame(head: unknown, bytes: Uint8Array[]): Buffer<ArrayBuffer> {
    const h = Buffer.from(JSON.stringify(head));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(h.byteLength);
    return Buffer.concat([len, h, ...bytes]);
}

const args = parseArgs(process.argv.slice(2));
log(`retroflightsim satellite ${args.name}: ${args.threads} threads, cache ${args.cache}`);
new Satellite(args).serve().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
