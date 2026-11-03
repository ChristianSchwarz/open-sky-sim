/**
 * Ending a spawned tool together with everything it started.
 *
 * `child.kill()` ends one process. The bake's tools start their own: the
 * chunk and leaf pools (tools/chunk_pool.ts, py_leaf_pool.ts) run Python per
 * chunk or per leaf, a Python stage runs a multiprocessing pool, a Windows
 * spawn with `shell: true` is a cmd.exe in front of the real program. Killed
 * one process deep, the rest ran on and kept writing into the pyramid after
 * the import that started them had failed.
 *
 * Windows: `taskkill /T /F` walks the tree by parent id. POSIX: every process
 * whose parent chain leads to the child (one `ps` table), and its process
 * group when it leads one (spawned with SPAWN_GROUP), which catches a
 * grandchild whose parent already ended. Synchronous on purpose, so an exit
 * hook can use it. Plain JavaScript so tools/dev.mjs, run by node without
 * tsx, shares it; the types are in killTree.d.mts.
 */

import { spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';

/**
 * Spawn options that make a child its own process group on POSIX, for the
 * group kill above. Nothing on Windows: `detached` there takes the child out
 * of Node's kill-on-exit job and opens it a console of its own.
 */
export const SPAWN_GROUP = WIN ? {} : { detached: true };

/** pid -> its children's pids, from `ps` (POSIX). */
function childTable() {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
    const table = new Map();
    for (const line of (r.stdout ?? '').split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid > 0 && ppid >= 0) {
            if (!table.has(ppid)) {
                table.set(ppid, []);
            }
            table.get(ppid).push(pid);
        }
    }
    return table;
}

/** `pid` and its descendants, deepest last (POSIX). */
function treeOf(pid, table) {
    const out = [pid];
    for (let i = 0; i < out.length; i++) {
        for (const c of table.get(out[i]) ?? []) {
            if (!out.includes(c)) {
                out.push(c);
            }
        }
    }
    return out;
}

function signal(pid, sig) {
    try {
        process.kill(pid, sig);
    } catch {
        // gone already, or not ours
    }
}

/**
 * Kill `child` (a ChildProcess or a pid) and every process under it. Safe on
 * one that has already ended: on POSIX its group still goes; on Windows its
 * tree can no longer be found from it (the reason the hooks run before exit).
 */
export function killTree(child) {
    const pid = typeof child === 'number' ? child : child?.pid;
    if (!pid) {
        return;
    }
    if (WIN) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        return;
    }
    const tree = treeOf(pid, childTable());
    signal(-pid, 'SIGKILL');
    for (const p of tree) {
        signal(p, 'SIGKILL');
    }
}

/**
 * Kill every child tree of this process: for a process whose children were
 * started by code it cannot reach (worker threads: the satellite's compute
 * threads run the Python stages), on its way out.
 */
export function killChildTrees() {
    if (WIN) {
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { $_.ProcessId }`],
        { encoding: 'utf8', windowsHide: true });
        for (const s of (r.stdout ?? '').split(/\s+/)) {
            const pid = Number(s);
            if (pid > 0) {
                killTree(pid);
            }
        }
        return;
    }
    const table = childTable();
    for (const c of table.get(process.pid) ?? []) {
        if (c !== process.pid) {
            signal(-c, 'SIGKILL');
            for (const p of treeOf(c, table)) {
                signal(p, 'SIGKILL');
            }
        }
    }
}
