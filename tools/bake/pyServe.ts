/**
 * A long-lived Python worker for the tile pool: one script started with
 * `--serve`, asked one JSON line at a time and answering one JSON line each
 * (tools/measure_lidar.py serve). Kept for the life of the thread, so the
 * script's sources and their caches carry from one leaf to the next.
 *
 * Also the local Python modules a script imports, for shipping it to a
 * satellite: every `import x` / `from x import` that names a tools/x.py.
 */

import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class PyServe {
    private child?: ChildProcess;
    private buffer = '';
    private waiting?: { resolve: (v: unknown) => void; reject: (e: Error) => void };
    private stderrTail: string[] = [];

    /** `isolated`: -E -s, nothing from the machine's own Python setup (a satellite's built-in runtime). */
    constructor(readonly python: string, readonly script: string, private readonly env: NodeJS.ProcessEnv = {}, private readonly isolated = false) {}

    private start(): ChildProcess {
        // -u: answers are not held in a buffer. Not isolated otherwise: a Store Python keeps its packages in the user site.
        const flags = [...(this.isolated ? ['-E', '-s'] : []), '-u', '-X', 'utf8'];
        const child = spawn(this.python, [...flags, this.script, '--serve'], {
            stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...this.env }, windowsHide: true,
        });
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (d: string) => {
            this.buffer += d;
            let nl: number;
            while ((nl = this.buffer.indexOf('\n')) >= 0) {
                const line = this.buffer.slice(0, nl).trim();
                this.buffer = this.buffer.slice(nl + 1);
                if (!line.startsWith('{')) {
                    continue; // a print from inside the script, not an answer
                }
                const w = this.waiting;
                this.waiting = undefined;
                w?.resolve(JSON.parse(line));
            }
        });
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (d: string) => {
            this.stderrTail.push(d);
            if (this.stderrTail.length > 20) {
                this.stderrTail.shift();
            }
        });
        child.on('exit', code => {
            this.child = undefined;
            const w = this.waiting;
            this.waiting = undefined;
            w?.reject(new Error(`${path.basename(this.script)} --serve exited (${code}): ${this.stderrTail.join('').slice(-800)}`));
        });
        child.on('error', err => {
            const w = this.waiting;
            this.waiting = undefined;
            w?.reject(err);
        });
        return child;
    }

    /** One request; the answer's parsed JSON. One at a time. */
    request<T>(req: unknown): Promise<T> {
        if (this.waiting) {
            throw new Error('PyServe: one request at a time');
        }
        this.child ??= this.start();
        return new Promise<T>((resolve, reject) => {
            this.waiting = { resolve: v => resolve(v as T), reject };
            this.child!.stdin!.write(`${JSON.stringify(req)}\n`);
        });
    }

    close(): void {
        this.child?.stdin?.end();
        this.child = undefined;
    }
}

/** `entry` and every tools/*.py it imports, directly or not, as file names. */
export function localPyImports(toolsDir: string, entry: string): string[] {
    const seen = new Set<string>();
    const visit = (file: string) => {
        if (seen.has(file)) {
            return;
        }
        seen.add(file);
        const text = fs.readFileSync(path.join(toolsDir, file), 'utf8');
        for (const m of text.matchAll(/^\s*(?:from\s+([A-Za-z_][\w]*)\s+import|import\s+([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_][\w]*)*))/gm)) {
            for (const name of (m[1] ?? m[2]).split(',').map(s => s.trim())) {
                if (fs.existsSync(path.join(toolsDir, `${name}.py`))) {
                    visit(`${name}.py`);
                }
            }
        }
    };
    visit(entry);
    return [...seen].sort();
}
