import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runScript } from './pyChunk';

const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

test('a chunk script still running at its deadline is killed and fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pychunk-'));
    const script = path.join(dir, 'hang.py');
    fs.writeFileSync(script, 'import time\nprint("started", flush=True)\ntime.sleep(60)\n');
    const t0 = Date.now();
    await assert.rejects(runScript(PYTHON, false, script, [], dir, {}, Date.now() + 500), /time limit[\s\S]*started/);
    assert.ok(Date.now() - t0 < 20_000);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a chunk script that ends in time answers with its output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pychunk-'));
    const script = path.join(dir, 'ok.py');
    fs.writeFileSync(script, 'print("fine")\n');
    assert.match(await runScript(PYTHON, false, script, [], dir, {}, Date.now() + 30_000), /fine/);
    fs.rmSync(dir, { recursive: true, force: true });
});
