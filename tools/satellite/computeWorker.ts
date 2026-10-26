/**
 * A satellite's compute thread (tools/satellite/satellite.ts), bundled into
 * the exe as a script (computeBundle.ts). The bake bundles it from its own
 * tree as well; a satellite whose copy hashes differently runs the bake's,
 * so it always runs the tile code the bake would run locally.
 *
 * Handed a job directory with the inputs in place, it runs the job and
 * answers with the tile function's result; the satellite reads the outputs
 * from the directory.
 */

import { parentPort } from 'node:worker_threads';
import { RemoteConfig, RemoteKind, runRemoteJob } from '../bake/remoteTiles';
import { TileKey } from '../../src/script/terrain/tiling';

parentPort!.on('message', (msg: { id: number; kind: RemoteKind; cfg: RemoteConfig; key: TileKey; jobDir: string } | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    try {
        parentPort!.postMessage({ id: msg.id, result: runRemoteJob(msg.kind, msg.cfg, msg.key, msg.jobDir) });
    } catch (err) {
        const k = msg.key;
        parentPort!.postMessage({ id: msg.id, error: `${k.z}/${k.x}/${k.y}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` });
    }
});
