/**
 * Worker thread body for the mesh bake's tile loop. Spawned by
 * bake_planet_mesh.ts, one per CPU, each holding its own copy of the static
 * MeshTileConfig (sent once as workerData) and processing whichever tiles the
 * main thread hands it next.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { MeshTileConfig, TileTask, processTile } from './meshTile';

if (!parentPort) {
    throw new Error('meshTileWorker.ts must be run inside a worker_thread');
}

interface Request {
    idx: number;
    task: TileTask;
}

interface Response {
    idx: number;
    result: ReturnType<typeof processTile>;
}

const cfg = workerData as MeshTileConfig;

parentPort.on('message', (msg: Request | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    const result = processTile(cfg, msg.task);
    const response: Response = { idx: msg.idx, result };
    parentPort!.postMessage(response);
});
