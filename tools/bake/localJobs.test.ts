import assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'node:test';
import { GB_PER_WORKER, localJobs } from './localJobs';

test('no more workers than CPUs - 1, nor than memory holds', () => {
    for (const gb of Object.values(GB_PER_WORKER)) {
        const n = localJobs(gb, {});
        assert.ok(n >= 1);
        assert.ok(n <= Math.max(1, os.cpus().length - 1));
        assert.ok(n === 1 || n * gb * 1e9 <= os.totalmem(), `${n} workers of ${gb} GB`);
    }
});

test('JOBS sets it, anything else in JOBS is ignored', () => {
    assert.equal(localJobs(5, { JOBS: '3' }), 3);
    assert.equal(localJobs(1e6, { JOBS: '40' }), 40);
    assert.equal(localJobs(1e6, { JOBS: '0' }), 1);
    assert.equal(localJobs(1e6, { JOBS: 'lots' }), 1);
});
