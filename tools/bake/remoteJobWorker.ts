/**
 * A local worker thread of the tile pool for any job kind (remoteTiles.ts):
 * the job run against the real directories, as a satellite runs it against a
 * job directory. For the kinds that have no worker of their own (the Python
 * stages). workerData: { kind, cfg } with the real paths in cfg.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { RemoteConfig, RemoteKind, runRemoteJob } from './remoteTiles';
import { TileKey } from '../../src/script/terrain/tiling';

if (!parentPort) {
    throw new Error('remoteJobWorker.ts must be run inside a worker_thread');
}

const { kind, cfg } = workerData as { kind: RemoteKind; cfg: RemoteConfig };

parentPort.on('message', (msg: { idx: number; key: TileKey } | null) => {
    if (msg === null) {
        parentPort!.close();
        process.exit(0); // a Python child may still hold the event loop open
    }
    Promise.resolve()
        .then(() => runRemoteJob(kind, cfg, msg.key, ''))
        .then(result => parentPort!.postMessage({ idx: msg.idx, result }))
        .catch((err: unknown) => parentPort!.postMessage({
            idx: msg.idx, result: { error: `${msg.key.z}/${msg.key.x}/${msg.key.y}: ${err instanceof Error ? err.message : String(err)}` },
        }));
});
