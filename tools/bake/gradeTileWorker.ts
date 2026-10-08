/**
 * Worker thread body for the grading bake: one per CPU (bake_planet_grade.ts),
 * each holding the static GradeConfig (sent once as workerData) and grading
 * whichever tiles the main thread hands it next.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { GradeConfig, GradeResult, bedsOfTile, gradeTile } from './gradeTile';
import { TileKey } from '../../src/script/terrain/tiling';

if (!parentPort) {
    throw new Error('gradeTileWorker.ts must be run inside a worker_thread');
}

const cfg = workerData as GradeConfig;

parentPort.on('message', (msg: { idx: number; key: TileKey; pass: 1 | 2 } | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    let result: GradeResult | { error: string };
    try {
        result = msg.pass === 1 ? bedsOfTile(cfg, msg.key) : gradeTile(cfg, msg.key);
    } catch (err) {
        result = { error: `${msg.key.z}/${msg.key.x}/${msg.key.y}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` };
    }
    parentPort!.postMessage({ idx: msg.idx, result });
});
