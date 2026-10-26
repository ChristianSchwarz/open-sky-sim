/**
 * A bake satellite: lends this machine's cores to a grade or far land bake
 * running elsewhere on the LAN (tools/bake/tilePool.ts).
 *
 * Built into one exe by `npm run build:satellite` (dist/satellite): copy it to
 * any Windows machine and run it - no checkout, no Node, no Python. It finds
 * a bake by UDP broadcast, waits while there is none, and goes back to
 * waiting when one ends. The tile code (computeWorker.ts) is built into the
 * exe. A bake whose own copy of that code differs (it changed since the exe
 * was built) sends its copy, signed with the shared token, and the satellite
 * runs that for the bake instead, so it always runs what the bake would run
 * locally. Only a bake on another protocol needs a new exe.
 *
 *   retroflightsim-satellite.exe [options]
 *
 *     --coordinator HOST:PORT  skip the broadcast (another subnet, VPN)
 *     --threads N              compute threads (default: CPUs - 1, at most one per 3 GB of RAM)
 *     --cache DIR              tile cache: input tiles kept between bakes (default:
 *                              %LOCALAPPDATA%\retroflightsim-satellite)
 *     --cache-gb N             cache size kept between bakes (default 10)
 *     --name NAME              shown in the bake's log (default: the host name)
 *     --once                   exit after one bake instead of waiting for the next
 *
 * The console is a full-screen panel in the style of an old DOS file manager
 * (tools/satellite/tui.ts): the bake and its overall progress, this machine's
 * tiles, the network traffic, the cache, what each thread is doing and a log.
 * The function keys change the settings while it runs - F2 the cache folder,
 * F3 the threads, F4 the cache size, F5 the name, F6 the bake's address - and
 * each change is saved (%APPDATA%\retroflightsim-satellite\settings.json), so
 * the next start keeps it. Options given on the command line win over the
 * saved settings for that run.
 *
 * Under tsx from a checkout, the token is read from data/satellite/token and
 * the tile code bundled from the checkout at start.
 */

import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Tui, InfoRow, formatBytes, formatDuration } from './tui';

declare const __SAT_TOKEN__: string | undefined;
declare const __SAT_COMPUTE__: string | undefined;

const DISCOVERY_PORT = 47810;
const PROTOCOL = 3;
const HEARTBEAT_MS = 15_000;
const REL_PATTERN = /^(terrain|lidar|planet)\/\d+\/-?\d+\/-?\d+\.[a-z0-9]+$/;

interface Args { coordinator?: string; threads: number; cache: string; cacheGb: number; name: string; once: boolean }

interface Job {
    id: number; kind: string; key: { z: number; x: number; y: number }; cfg: unknown;
    inputs: Record<string, string | null>; outputs: string[]; codeSha: string;
    /** The whole bake's progress in the running pass when the job was handed out. */
    progress?: { done: number; total: number; pass: number };
}

const KIND_LABEL: Record<string, string> = { grade1: 'beds', grade2: 'grading', farland: 'far land' };
const PASS_LABEL: Record<string, string> = { grade1: 'grading, pass 1 (beds)', grade2: 'grading, pass 2', farland: 'far land' };

/** What one compute thread is doing, for the status block. */
interface SlotView { phase: 'idle' | 'fetching' | 'computing' | 'sending'; kind?: string; key?: string; since: number }

/** What the settings dialogs change, kept between runs. */
type Settings = Partial<Pick<Args, 'coordinator' | 'threads' | 'cache' | 'cacheGb' | 'name'>>;

const SETTINGS_FILE = path.join(process.env.APPDATA ?? os.homedir(), 'retroflightsim-satellite', 'settings.json');

function loadSettings(): Settings {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
    } catch {
        return {};
    }
}

function saveSettings(change: Settings): void {
    const next = { ...loadSettings(), ...change };
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

const DEFAULT_THREADS = Math.max(1, Math.min(os.cpus().length - 1, Math.floor(os.totalmem() / 3e9)));

function parseArgs(argv: string[]): Args {
    const a: Args = {
        threads: DEFAULT_THREADS,
        cache: path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'retroflightsim-satellite'),
        cacheGb: 10, name: os.hostname(), once: false,
        ...loadSettings(),
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
            console.log([
                'retroflightsim-satellite [options]',
                '  --coordinator HOST:PORT  the bake to join, instead of finding it by broadcast',
                `  --threads N              compute threads (default ${a.threads} here)`,
                `  --cache DIR              tile cache folder (default ${a.cache})`,
                '  --cache-gb N             cache size kept between bakes (default 10)',
                '  --name NAME              shown in the bake\'s log (default: the host name)',
                '  --once                   exit after one bake',
                '',
                `Settings changed in the running app are kept in ${SETTINGS_FILE}.`,
            ].join('\n'));
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

let tui: Tui | undefined;
const log = (s: string) => (tui ? tui.log(s) : console.log(`${new Date().toLocaleTimeString()}  ${s}`));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha1 = (b: Uint8Array) => crypto.createHash('sha1').update(b).digest('hex');

/** Broadcast on every interface until a bake answers (its host:port), or `stop` says to give up (undefined). */
async function discover(stop: () => boolean): Promise<string | undefined> {
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
        while (!stop()) {
            const answer = new Promise<string | undefined>(resolve => {
                // Removed on the timeout too, or every unanswered round leaves one behind.
                const t = setTimeout(() => {
                    sock.off('message', onMessage);
                    resolve(undefined);
                }, 2000);
                const onMessage = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
                    clearTimeout(t);
                    sock.off('message', onMessage);
                    try {
                        const m = JSON.parse(msg.toString()) as { rfs: string; port: number };
                        resolve(m.rfs === 'coordinator' ? `${rinfo.address}:${m.port}` : undefined);
                    } catch {
                        resolve(undefined);
                    }
                };
                sock.on('message', onMessage);
            });
            for (const t of targets) {
                sock.send('rfs-satellite?', DISCOVERY_PORT, t, () => undefined);
            }
            const found = await answer;
            if (found) {
                return found;
            }
            if (!said && !tui?.tty) {
                log('waiting for a bake (start one with --satellites)...');
                said = true;
            }
            await sleep(1000);
        }
        return undefined;
    } finally {
        sock.close();
    }
}

class SessionOver extends Error {}
/** The bake speaks another protocol than this satellite was built for. */
class Refused extends Error {}
/** An input could not be fetched (rewritten at the bake since): the bake hands the tile out again. */
class Retry extends Error {}

class Satellite {
    private readonly id = crypto.randomUUID();
    private readonly tok = token();
    private readonly blobFetches = new Map<string, Promise<void>>();
    private readonly active = new Set<number>();
    private done = 0;
    /** Sessions joined so far. */
    private joined = 0;
    private readonly started = Date.now();
    private readonly slots: SlotView[];
    /** The bake joined now, when, and its progress as of the last job. */
    private bake?: { base: string; since: number; tiles: number; progress?: Job['progress']; kind?: string };
    private where = 'looking for a bake';
    private quitting = false;
    private readonly stats = { tiles: 0, failed: 0, retried: 0, computeMs: 0, bytesIn: 0, hits: 0, misses: 0, bytesOut: 0, cacheBytes: 0 };

    /** The tile code this satellite runs now: the built-in one, or the last bake's. */
    private code: { sha: string; text: string };
    /** Every tile code seen, by hash: a satellite moving between two bakes fetches each once. */
    private readonly codes = new Map<string, { sha: string; text: string }>();

    constructor(private readonly args: Args, private readonly builtIn: { sha: string; text: string }) {
        this.code = builtIn;
        this.codes.set(builtIn.sha, builtIn);
        this.slots = Array.from({ length: args.threads }, () => ({ phase: 'idle' as const, since: Date.now() }));
        fs.mkdirSync(path.join(args.cache, 'blobs'), { recursive: true });
        fs.rmSync(path.join(args.cache, 'jobs'), { recursive: true, force: true });
        this.pruneCache();
    }

    async serve(): Promise<void> {
        let quiet = false;
        for (;;) {
            this.where = this.args.coordinator ? `waiting for a bake at ${this.args.coordinator}` : 'looking for a bake (UDP broadcast on port 47810)';
            const wanted = this.args.coordinator;
            const coord = wanted ?? await discover(() => this.args.coordinator !== wanted || this.quitting);
            if (coord === undefined || this.quitting) {
                if (this.quitting) {
                    return;
                }
                continue; // the bake's address was changed (F6) while looking
            }
            const joined = this.joined;
            try {
                await this.session(coord);
                quiet = false;
            } catch (err) {
                if (err instanceof Refused) {
                    if (!quiet) {
                        log(err.message);
                        quiet = true;
                    }
                    this.where = `turned away by ${coord}: needs a new exe`;
                    if (this.args.once) {
                        process.exitCode = 1;
                        return;
                    }
                    await sleep(30_000);
                    continue;
                }
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
            if ((this.args.once && this.joined > 0) || this.quitting) {
                return;
            }
            await sleep(2000);
        }
    }

    /** Leaving: the bake gets this satellite's tiles back at once instead of after the lease timeout. */
    async quit(): Promise<void> {
        this.quitting = true;
        if (this.bake) {
            await this.call(this.bake.base, '/sat/bye', { method: 'POST', body: JSON.stringify([...this.active]), timeoutMs: 3000 })
                .catch(() => undefined);
        }
    }

    get inBake(): boolean {
        return this.bake !== undefined;
    }

    get activeTiles(): number {
        return this.active.size;
    }

    /** Move the cache to `dir`: new tiles land there; the old folder is left as it is. Throws when `dir` is unusable. */
    setCache(dir: string): void {
        const resolved = path.resolve(dir);
        fs.mkdirSync(path.join(resolved, 'blobs'), { recursive: true });
        const probe = path.join(resolved, `.probe${process.pid}`);
        fs.writeFileSync(probe, 'x');
        fs.rmSync(probe);
        this.args.cache = resolved;
        this.pruneCache();
    }

    setCacheGb(gb: number): void {
        this.args.cacheGb = gb;
        this.pruneCache();
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
        const hello = (codeSha: string) => this.call(base, '/sat/hello', {
            method: 'POST',
            body: JSON.stringify({ name: this.args.name, threads: this.args.threads, protocol: PROTOCOL, codeSha }),
        });
        let res = await hello(this.code.sha);
        if (res.status === 200) {
            // The bake runs other tile code: take its copy, then say hello again with it.
            const { codeSha } = await res.json() as { codeSha: string };
            const was = this.code.sha;
            this.code = this.codes.get(codeSha) ?? await this.fetchCode(base, codeSha);
            log(`tile code ${was.slice(0, 12)} -> ${this.code.sha.slice(0, 12)} from the bake`
                + (this.code === this.builtIn ? ' (the built-in one)' : ''));
            res = await hello(this.code.sha);
        }
        if (res.status === 409) {
            const theirs = await res.json() as { protocol: number };
            throw new Refused(`the bake at ${base} speaks protocol ${theirs.protocol}, this satellite ${PROTOCOL}: `
                + 'rebuild it (npm run build:satellite) and copy it over');
        }
        if (res.status !== 204) {
            throw new Error(`hello answered ${res.status}`);
        }
        if (this.slots.length !== this.args.threads) {
            // A thread count changed (F3) between bakes.
            this.slots.length = 0;
            this.slots.push(...Array.from({ length: this.args.threads }, () => ({ phase: 'idle' as const, since: Date.now() })));
        }
        log(`joined the bake at ${base} with ${this.slots.length} threads`);
        this.joined++;
        this.bake = { base, since: Date.now(), tiles: 0 };
        const beat = setInterval(() => {
            void this.call(base, '/sat/heartbeat', { method: 'POST', body: JSON.stringify([...this.active]) }).catch(() => undefined);
        }, HEARTBEAT_MS);
        try {
            await Promise.all(this.slots.map((_, i) => this.slot(base, this.code, i)));
            log(`the bake at ${base} is over: ${this.bake.tiles} tiles done here in ${formatDuration(Date.now() - this.bake.since)}`);
        } finally {
            clearInterval(beat);
            this.bake = undefined;
        }
    }

    /** The bake's tile code, checked against the token (a bake without it cannot sign) and the hash it gave. */
    private async fetchCode(base: string, sha: string): Promise<{ sha: string; text: string }> {
        const c = await (await this.call(base, '/sat/code')).json() as { code: string; sha: string; hmac: string };
        const mac = crypto.createHmac('sha256', this.tok).update(c.code).digest('hex');
        const got = crypto.createHash('sha256').update(c.code).digest('hex');
        if (mac !== c.hmac || got !== sha || c.sha !== sha) {
            throw new Error('the bake sent tile code not signed with this satellite\'s token; not running it');
        }
        const code = { sha, text: c.code };
        this.codes.set(sha, code);
        return code;
    }

    /** One compute thread's loop: lease, fetch, run, send back; until the bake goes away. */
    private async slot(base: string, code: { sha: string; text: string }, i: number): Promise<void> {
        const view = this.slots[i];
        const phase = (p: SlotView['phase'], job?: Job) => {
            view.phase = p;
            view.since = Date.now();
            view.kind = job?.kind;
            view.key = job ? `${job.key.z}/${job.key.x}/${job.key.y}` : undefined;
        };
        let worker = new Worker(code.text, { eval: true });
        try {
            for (;;) {
                if (this.quitting) {
                    return;
                }
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
                    return; // the bake restarted with other code: the next hello fetches it
                }
                this.active.add(job.id);
                if (this.bake && job.progress) {
                    this.bake.progress = job.progress;
                    this.bake.kind = job.kind;
                }
                phase('fetching', job);
                try {
                    const body = await this.runJob(job, worker, () => phase('computing', job)).catch(async (err: Error) => {
                        if (err instanceof Retry) {
                            this.stats.retried++;
                            return frame({ retry: true, outputs: [] }, []);
                        }
                        this.stats.failed++;
                        log(`tile ${view.key} failed: ${err.message.split('\n')[0]}`);
                        await worker.terminate();
                        worker = new Worker(code.text, { eval: true });
                        return frame({ error: err.message, outputs: [] }, []);
                    });
                    phase('sending', job);
                    await this.call(base, `/sat/result/${job.id}`, { method: 'POST', body });
                    this.stats.bytesOut += body.byteLength;
                    this.done++;
                } finally {
                    this.active.delete(job.id);
                    phase('idle');
                }
            }
        } finally {
            void worker.terminate();
        }
    }

    private async runJob(job: Job, worker: Worker, computing: () => void): Promise<Buffer<ArrayBuffer>> {
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
            computing();
            const t0 = Date.now();
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
                this.stats.failed++;
                log(`tile ${job.key.z}/${job.key.x}/${job.key.y} failed: ${reply.error.split('\n')[0]}`);
                return frame({ error: reply.error, outputs: [] }, []);
            }
            this.stats.tiles++;
            this.stats.computeMs += Date.now() - t0;
            if (this.bake) {
                this.bake.tiles++;
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
            this.stats.hits++;
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
                this.stats.misses++;
                this.stats.bytesIn += b.byteLength;
                this.stats.cacheBytes += b.byteLength;
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
        this.stats.cacheBytes = total;
    }

    // --- the console ------------------------------------------------------------

    title(): string {
        return `retroflightsim satellite - ${this.args.name}`;
    }

    info(): InfoRow[] {
        const st = this.stats, now = Date.now();
        const rows: InfoRow[] = [];
        if (this.bake) {
            const pr = this.bake.progress;
            rows.push({ label: 'Bake', value: this.bake.base, tone: 'bright' });
            rows.push({ label: 'Stage', value: this.bake.kind ? PASS_LABEL[this.bake.kind] ?? this.bake.kind : 'waiting for the first tile' });
            rows.push(pr
                ? { label: 'Progress', bar: pr.done / Math.max(1, pr.total), value: `${pr.done} / ${pr.total} tiles  ${((100 * pr.done) / Math.max(1, pr.total)).toFixed(1)} %`, tone: 'bright' }
                : { label: 'Progress', bar: 0, value: '-', tone: 'dim' });
            rows.push({ label: 'Joined', value: `${formatDuration(now - this.bake.since)} ago, ${this.bake.tiles} tiles done here in this bake` });
        } else {
            rows.push({ label: 'Bake', value: this.where, tone: this.where.startsWith('turned away') ? 'bad' : 'dim' });
            rows.push({ label: 'Stage', value: '-', tone: 'dim' });
            rows.push({ label: 'Progress', bar: 0, value: '-', tone: 'dim' });
            rows.push({ label: 'Joined', value: '-', tone: 'dim' });
        }
        const perTile = st.tiles > 0 ? `, ${(st.computeMs / st.tiles / 1000).toFixed(1)} s per tile and thread` : '';
        rows.push({ label: 'Tiles', value: `${st.tiles} done, ${st.failed} failed, ${st.retried} handed back${perTile}`, tone: st.failed > 0 ? 'bad' : 'value' });
        const asked = st.hits + st.misses;
        rows.push({ label: 'Network', value: `in ${formatBytes(st.bytesIn)} (${asked > 0 ? ((100 * st.hits) / asked).toFixed(0) : 0} % of input files from the cache), out ${formatBytes(st.bytesOut)}` });
        rows.push({ label: 'Cache', value: `${this.args.cache}   ${formatBytes(st.cacheBytes)} of ${this.args.cacheGb} GB` });
        const threads = this.bake && this.slots.length !== this.args.threads
            ? `${this.slots.length} threads (${this.args.threads} from the next bake)` : `${this.args.threads} threads`;
        const code = `tile code ${this.code.sha.slice(0, 12)}${this.code === this.builtIn ? ' (built in)' : ' (from the bake)'}`;
        rows.push({ label: 'Machine', value: `${threads}, ${code}, up ${formatDuration(now - this.started)}` });
        return rows;
    }

    threads(): string[] {
        const now = Date.now();
        return this.slots.map((v, i) => `${String(i + 1).padStart(2)}.  ` + (v.phase === 'idle'
            ? (this.bake ? 'idle, waiting for a tile' : 'idle')
            : `${(KIND_LABEL[v.kind ?? ''] ?? v.kind ?? '').padEnd(9)} ${String(v.key ?? '').padEnd(16)} ${v.phase.padEnd(10)} ${formatDuration(now - v.since)}`));
    }

    /** One line, for a console that is not a terminal. */
    summary(): string {
        const st = this.stats;
        const busy = this.slots.filter(v => v.phase !== 'idle').length;
        const pr = this.bake?.progress;
        return (this.bake ? `bake ${this.bake.base}${pr ? ` ${pr.done}/${pr.total}` : ''}` : this.where)
            + `; ${st.tiles} tiles done, ${st.failed} failed; ${busy}/${this.slots.length} threads busy; `
            + `in ${formatBytes(st.bytesIn)}, out ${formatBytes(st.bytesOut)}; cache ${formatBytes(st.cacheBytes)}`;
    }
}

/** A result body: header length, header JSON, then the output bytes in order. */
function frame(head: unknown, bytes: Uint8Array[]): Buffer<ArrayBuffer> {
    const h = Buffer.from(JSON.stringify(head));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(h.byteLength);
    return Buffer.concat([len, h, ...bytes]);
}

/** The tile code: built in, or under tsx bundled from the checkout as the bake does. */
async function computeCode(): Promise<{ sha: string; text: string }> {
    if (typeof __SAT_COMPUTE__ === 'string') {
        return { sha: crypto.createHash('sha256').update(__SAT_COMPUTE__).digest('hex'), text: __SAT_COMPUTE__ };
    }
    const { bundleCompute } = await import('./computeBundle');
    const b = await bundleCompute();
    return { sha: b.sha, text: b.code };
}

const HELP = [
    'This machine lends its cores to a terrain bake: grading and far land',
    'tiles. Start the bake on the main machine with --satellites; this',
    'program finds it on the network, works through tiles until the bake',
    'ends, and then waits for the next one.',
    '',
    'F2  cache folder      where input tiles are kept between bakes',
    'F3  threads           compute threads (from the next bake on)',
    'F4  cache size        GB kept between bakes; older tiles go first',
    'F5  name              shown in the bake\'s log (from the next bake on)',
    'F6  bake address      HOST:PORT, or empty to find the bake by broadcast',
    'F10 quit              tiles in progress go back to the bake at once',
    '',
    'The digit keys 1..9 and 0 work as F1..F10. Changes are saved for the',
    'next start; options on the command line win over them for that run.',
];

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const code = await computeCode();
    const sat = new Satellite(args, code);
    let dialogOpen = false;
    const ui: Tui = new Tui(sat, ['Help', 'Cache', 'Threads', 'Size', 'Name', 'Bake', '', '', '', 'Quit'], n => {
        if (dialogOpen && n !== 10) {
            return;
        }
        dialogOpen = true;
        void handleKey(n).finally(() => {
            dialogOpen = false;
        });
    });
    const handleKey = async (n: number): Promise<void> => {
        if (n === 1) {
            await ui.message('Help', HELP);
        } else if (n === 2) {
            const v = await ui.prompt({
                title: 'Cache folder', label: 'Folder:', value: args.cache,
                lines: ['Input tiles are kept here between bakes, so a tile is', 'fetched over the network once. The old folder is left', 'as it is; delete it yourself if you no longer need it.'],
                validate: d => {
                    if (!d) {
                        return 'enter a folder';
                    }
                    try {
                        sat.setCache(d);
                        return undefined;
                    } catch (err) {
                        return `cannot use it: ${(err as Error).message}`;
                    }
                },
            });
            if (v !== undefined) {
                saveSettings({ cache: args.cache });
                log(`cache folder is now ${args.cache}`);
            }
        } else if (n === 3) {
            const v = await ui.prompt({
                title: 'Threads', label: `Threads (1..${os.cpus().length}):`, value: String(args.threads),
                lines: [`This machine has ${os.cpus().length} CPUs and ${formatBytes(os.totalmem())} of memory; a grading`, 'thread can take 2-3 GB. Applies from the next bake on.'],
                validate: t => (/^\d+$/.test(t) && Number(t) >= 1 && Number(t) <= os.cpus().length ? undefined : `a number from 1 to ${os.cpus().length}`),
            });
            if (v !== undefined) {
                args.threads = Number(v);
                saveSettings({ threads: args.threads });
                log(`threads: ${args.threads}${sat.inBake ? ' from the next bake on' : ''}`);
            }
        } else if (n === 4) {
            const v = await ui.prompt({
                title: 'Cache size', label: 'Gigabytes:', value: String(args.cacheGb),
                lines: ['The cache is cut back to this size, oldest tiles first.'],
                validate: t => (/^\d+(\.\d+)?$/.test(t) && Number(t) > 0 ? undefined : 'a number of gigabytes above 0'),
            });
            if (v !== undefined) {
                sat.setCacheGb(Number(v));
                saveSettings({ cacheGb: args.cacheGb });
                log(`cache size: ${args.cacheGb} GB`);
            }
        } else if (n === 5) {
            const v = await ui.prompt({
                title: 'Name', label: 'Name:', value: args.name, lines: ['Shown in the bake\'s log. Applies from the next bake on.'],
                validate: t => (t ? undefined : 'enter a name'),
            });
            if (v !== undefined) {
                args.name = v;
                saveSettings({ name: v });
                log(`name: ${v}`);
            }
        } else if (n === 6) {
            const v = await ui.prompt({
                title: 'Bake address', label: 'HOST:PORT (empty: find it by broadcast):', value: args.coordinator ?? '',
                lines: ['Where the bake runs, for when the broadcast does not reach', 'it (another subnet, a VPN). The bake listens on port 47811.'],
                validate: t => (!t || /^[\w.-]+:\d+$/.test(t) ? undefined : 'HOST:PORT, e.g. 192.168.1.20:47811, or empty'),
            });
            if (v !== undefined) {
                args.coordinator = v || undefined;
                saveSettings({ coordinator: args.coordinator });
                log(`bake address: ${args.coordinator ?? 'found by broadcast'}${sat.inBake ? ', from the next bake on' : ''}`);
            }
        } else if (n === 10) {
            const leave = !sat.inBake || await ui.confirm('Quit', [
                'A bake is running. Leave it?',
                sat.activeTiles > 0 ? `The ${sat.activeTiles} tiles in progress here go back to it.` : 'No tile is in progress here.',
            ]);
            if (leave) {
                await sat.quit();
                ui.stop();
                process.exit(0);
            }
        }
    };
    tui = ui;
    ui.start();
    log(`started: ${args.threads} threads, tile code ${code.sha.slice(0, 12)}, cache ${args.cache}`);
    await sat.serve();
    ui.stop();
}

main().catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
