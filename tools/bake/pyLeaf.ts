/**
 * The per-leaf Python stages on the tile pool: a script that measures one z12
 * leaf into a store (tools/leaf_serve.py), kept running per thread with
 * `--serve` (pyServe.ts), so its sources and their caches carry from one
 * leaf to the next as its own --jobs workers keep them.
 *
 *   lidarleaf  measure_lidar.py: the graded lines and bridge ends against
 *              open lidar, into the lidar store (.lms)
 *   roofleaf   measure_buildings.py: every roof's colour off orthophotos,
 *              into the building colour store (.bcs)
 *
 * Here a script runs from tools/ against the real directories. On a
 * satellite it runs from a copy of the scripts the job brought (by content,
 * kept per set of scripts), with the satellite's Python (RFS_SAT_PYTHON) and
 * a download cache that outlives the job (RFS_SAT_CACHE).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PyServe, satelliteCaEnv } from './pyServe';
import { TileKey } from '../../src/script/terrain/tiling';

export type PyLeafKind = 'lidarleaf' | 'roofleaf';

export interface PyStage {
    /** The script, in tools/. */
    script: string;
    /** The leaf's planet files it reads. */
    inputs: string[];
    /** The store root (remoteTiles.ts RemoteRoot) and the extension of a leaf's file in it. */
    storeRoot: 'lidar' | 'bstore';
    storeExt: string;
    /** The env variables that move the script's directories. */
    planetEnv: string;
    storeEnv: string;
    cacheEnv: string;
    /** Its download cache on a satellite, under RFS_SAT_CACHE. */
    satCache: string;
    /** The real store, relative to the checkout. */
    defaultStore: string;
}

export const PY_STAGES: Record<PyLeafKind, PyStage> = {
    lidarleaf: {
        script: 'measure_lidar.py', inputs: ['.rvr', '.rbr'], storeRoot: 'lidar', storeExt: '.lms',
        planetEnv: 'RFS_LIDAR_PLANET', storeEnv: 'RFS_LIDAR_STORE', cacheEnv: 'RFS_LIDAR_CACHE', satCache: 'lidar-cache',
        defaultStore: 'data/imports/lidar/store',
    },
    roofleaf: {
        // The footprints (OSM and LoD2-only) and the roads whose asphalt balances each block's colour.
        script: 'measure_buildings.py', inputs: ['.bvr', '.bvl', '.rvr'], storeRoot: 'bstore', storeExt: '.bcs',
        planetEnv: 'RFS_BUILDINGS_PLANET', storeEnv: 'RFS_BUILDINGS_STORE', cacheEnv: 'RFS_ORTHO_CACHE', satCache: 'ortho-cache',
        defaultStore: 'data/imports/buildings/store',
    },
};

export interface PyLeafConfig {
    /** The planet pyramid. */
    planet: string;
    /** The stage's store. */
    store: string;
    /** The directory holding the script and the modules it imports. */
    pytools: string;
}

/** What a stage's script answers for a leaf: its own summary, numbers mostly. */
export type PyLeafResult = { key: string } & Record<string, unknown>;

const serves = new Map<string, PyServe>();

/** The scripts in `dir`, copied to a directory named by their content, once. */
export function stableScripts(dir: string): string {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.py')).sort();
    const h = crypto.createHash('sha1');
    for (const f of files) {
        h.update(f).update(fs.readFileSync(path.join(dir, f)));
    }
    const out = path.join(process.env.RFS_SAT_CACHE ?? os.tmpdir(), 'pytools', h.digest('hex').slice(0, 16));
    if (!fs.existsSync(path.join(out, '.complete'))) {
        fs.mkdirSync(out, { recursive: true });
        for (const f of files) {
            fs.copyFileSync(path.join(dir, f), path.join(out, f));
        }
        fs.writeFileSync(path.join(out, '.complete'), '');
    }
    return out;
}

export async function pyLeaf(kind: PyLeafKind, cfg: PyLeafConfig, k: TileKey, onSatellite: boolean): Promise<PyLeafResult> {
    const stage = PY_STAGES[kind];
    const scripts = onSatellite ? stableScripts(cfg.pytools) : cfg.pytools;
    const script = path.resolve(scripts, stage.script);
    const python = process.env.RFS_SAT_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    let serve = serves.get(kind);
    if (!serve || serve.script !== script || serve.python !== python) {
        serve?.close();
        const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', ...(onSatellite ? satelliteCaEnv() : {}) };
        if (onSatellite && process.env.RFS_SAT_CACHE) {
            env[stage.cacheEnv] = path.join(process.env.RFS_SAT_CACHE, stage.satCache);
        }
        serve = new PyServe(python, script, env, process.env.RFS_SAT_PYTHON !== undefined);
        serves.set(kind, serve);
    }
    const answer = await serve.request<{ ok: boolean; result?: Record<string, unknown>; error?: string }>({
        x: k.x, y: k.y, planet: path.resolve(cfg.planet), store: path.resolve(cfg.store),
    });
    if (!answer.ok) {
        throw new Error(answer.error ?? `${stage.script} failed`);
    }
    return { ...answer.result!, key: `${k.z}/${k.x}/${k.y}` };
}
