/**
 * How many worker threads (or processes) a bake runs on this machine when
 * --jobs is not given: one fewer than the CPUs, but no more than its memory
 * holds at `gbPerWorker` each. CPUs - 1 alone put 19 grading workers on a
 * 32 GB machine, which ran out of memory and grew the pagefile on C: by
 * gigabytes a minute; 6 was measured faster as well (no thrashing).
 *
 * JOBS in the environment overrides it for every bake an import runs, as the
 * re-import drivers set it. A bake satellite on the same machine needs its
 * share too: lower JOBS, or its threads (F3).
 */

import * as os from 'node:os';

/** Memory one worker of each bake takes at its worst, roughly, gigabytes. */
export const GB_PER_WORKER = {
    grade: 5,
    mesh: 2,
    farland: 2,
    tex: 1.5,
    /** One chunk's coast or cover bake, per process of its own pool: 11 of them at 3 GB grew the pagefile. */
    chunk: 5,
} as const;

export function localJobs(gbPerWorker: number, env: NodeJS.ProcessEnv = process.env): number {
    const set = Number(env.JOBS);
    if (env.JOBS !== undefined && Number.isFinite(set) && set >= 1) {
        return Math.floor(set);
    }
    return Math.max(1, Math.min(os.cpus().length - 1, Math.floor(os.totalmem() / (gbPerWorker * 1e9))));
}
