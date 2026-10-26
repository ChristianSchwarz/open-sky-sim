/**
 * Worker thread body for the far-tile texture bake's leaves
 * (bake_planet_tex.ts): holds the static TexLeafConfig (workerData) and
 * rasterises whichever leaf it is handed next.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { TexLeafConfig, TexLeafResult, texLeaf } from './texLeaf';
import { TileKey } from '../../src/script/terrain/tiling';

if (!parentPort) {
    throw new Error('texLeafWorker.ts must be run inside a worker_thread');
}

const cfg = workerData as TexLeafConfig;

parentPort.on('message', (msg: { idx: number; key: TileKey } | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    let result: TexLeafResult | { error: string };
    try {
        result = texLeaf(cfg, msg.key);
    } catch (err) {
        result = { error: `${msg.key.z}/${msg.key.x}/${msg.key.y}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` };
    }
    parentPort!.postMessage({ idx: msg.idx, result });
});
