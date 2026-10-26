/**
 * Worker thread body for the mesh bake's tile loop. Spawned by the tile pool
 * (tilePool.ts) for bake_planet_mesh.ts, each holding its own copy of the
 * static MeshTileConfig (sent once as workerData) and processing whichever
 * tiles the main thread hands it next.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { MeshTileConfig, TileTask, processTile } from './meshTile';

if (!parentPort) {
    throw new Error('meshTileWorker.ts must be run inside a worker_thread');
}

const cfg = workerData as MeshTileConfig;

parentPort.on('message', (msg: { idx: number; key: TileTask } | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    let result: ReturnType<typeof processTile> | { error: string };
    try {
        result = processTile(cfg, msg.key);
    } catch (err) {
        result = { error: `${msg.key.z}/${msg.key.x}/${msg.key.y}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` };
    }
    parentPort!.postMessage({ idx: msg.idx, result });
});
