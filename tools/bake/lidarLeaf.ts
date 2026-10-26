/**
 * One leaf of the lidar measurement (tools/measure_lidar.py) on the tile
 * pool: the leaf's OSM vectors in, its lidar store file out, measured by a
 * `measure_lidar.py --serve` kept per thread (pyServe.ts) so the sources and
 * their downloads carry from leaf to leaf, as its own --jobs workers do.
 *
 * Here the script runs from tools/ against the real directories. On a
 * satellite it runs from a copy of the scripts the job brought (by content,
 * kept per set of scripts), with the satellite's Python (RFS_SAT_PYTHON) and
 * a download cache that outlives the job (RFS_SAT_CACHE).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PyServe } from './pyServe';
import { TileKey } from '../../src/script/terrain/tiling';

export interface LidarLeafConfig {
    /** The planet pyramid (.rvr, .rbr). */
    planet: string;
    /** The lidar store the .lms goes into. */
    store: string;
    /** The directory holding measure_lidar.py and the modules it imports. */
    pytools: string;
    /** measure_lidar.py --cache-gb, per process. */
    cacheGb: number;
}

export interface LidarLeafResult {
    key: string;
    seconds: number;
    stations: number;
    measured: number;
    ends: number;
    endsMeasured: number;
    bytes: number;
    downloadedMB: number;
    downloads: number;
    cacheHits: number;
    blocks: number;
    kmBySource: Record<string, number>;
}

let serve: PyServe | undefined;

/** The scripts in `dir`, copied to a directory named by their content, once. */
function stableScripts(dir: string): string {
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

export async function lidarLeaf(cfg: LidarLeafConfig, k: TileKey, onSatellite: boolean): Promise<LidarLeafResult> {
    const scripts = onSatellite ? stableScripts(cfg.pytools) : cfg.pytools;
    const script = path.resolve(scripts, 'measure_lidar.py');
    const python = process.env.RFS_SAT_PYTHON ?? process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    if (!serve || serve.script !== script || serve.python !== python) {
        serve?.close();
        const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8' };
        if (onSatellite && process.env.RFS_SAT_CACHE) {
            env.RFS_LIDAR_CACHE = path.join(process.env.RFS_SAT_CACHE, 'lidar-cache');
        }
        serve = new PyServe(python, script, env, process.env.RFS_SAT_PYTHON !== undefined);
    }
    const answer = await serve.request<{ ok: boolean; result?: Omit<LidarLeafResult, 'key'>; error?: string }>({
        x: k.x, y: k.y, planet: path.resolve(cfg.planet), store: path.resolve(cfg.store), cacheGb: cfg.cacheGb,
    });
    if (!answer.ok) {
        throw new Error(answer.error ?? 'measure_lidar failed');
    }
    return { key: `${k.z}/${k.x}/${k.y}`, ...answer.result! };
}
