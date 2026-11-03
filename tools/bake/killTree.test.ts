import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { SPAWN_GROUP, killTree } from './killTree.mjs';

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

// A Python in the middle, as a bake stage and its multiprocessing pool: a node
// in the middle would hide the bug on Windows, where Node's kill-on-close job
// ends a node's own children with it, but not a Python's.
test('killTree ends the child and the process it started', async () => {
    const script = [
        'import subprocess, sys, time',
        'p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])',
        'print(p.pid, flush=True)',
        'time.sleep(60)',
    ].join('\n');
    const child = spawn(PYTHON, ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'], ...SPAWN_GROUP });
    const grandchild = await new Promise<number>((resolve, reject) => {
        child.stdout.once('data', (d: Buffer) => resolve(Number(d.toString().trim())));
        child.once('error', reject);
    });
    try {
        assert.ok(alive(grandchild));
        const closed = new Promise(r => child.once('close', r));
        killTree(child);
        await closed;
        for (let i = 0; i < 50 && alive(grandchild); i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        assert.equal(alive(grandchild), false, 'the grandchild outlived the kill');
    } finally {
        if (alive(grandchild)) {
            process.kill(grandchild);
        }
    }
});
