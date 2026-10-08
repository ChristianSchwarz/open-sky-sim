/**
 * Worker thread body for the far land bake (bake_planet_farland.ts): holds the
 * static FarLandConfig (workerData) and simplifies whichever leaf it is
 * handed next.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { FarLandConfig, FarLandResult, farLandOfTile } from './farLandTile';
import { TileKey } from '../../src/script/terrain/tiling';

if (!parentPort) {
    throw new Error('farLandWorker.ts must be run inside a worker_thread');
}

const cfg = workerData as FarLandConfig;

parentPort.on('message', (msg: { idx: number; key: TileKey } | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    let result: FarLandResult | { error: string };
    try {
        result = farLandOfTile(cfg, msg.key);
    } catch (err) {
        result = { error: `${msg.key.z}/${msg.key.x}/${msg.key.y}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` };
    }
    parentPort!.postMessage({ idx: msg.idx, result });
});
