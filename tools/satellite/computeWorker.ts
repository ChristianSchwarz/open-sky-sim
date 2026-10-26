/**
 * A satellite's compute thread (tools/satellite/satellite.ts), bundled into
 * the exe as a script (computeBundle.ts). The bake bundles it from its own
 * tree as well; a satellite whose copy hashes differently runs the bake's,
 * so it always runs the tile code the bake would run locally.
 *
 * Handed a job directory with the inputs in place and the job's config as
 * text (remoteTiles.ts encodeWire, decoded here so the format travels with
 * this code and not with the exe), it runs the job and answers with the tile
 * function's result; the satellite reads the outputs from the directory.
 */

import { parentPort } from 'node:worker_threads';
import { RemoteConfig, RemoteKind, decodeWire, encodeWire, runRemoteJob } from '../bake/remoteTiles';
import { TileKey } from '../../src/script/terrain/tiling';

/** The last config decoded, by its text: the mesh config is megabytes and the same for every tile. */
let lastText = '';
let lastCfg: RemoteConfig | undefined;

parentPort!.on('message', (msg: { id: number; kind: RemoteKind; cfgText: string; key: TileKey; jobDir: string } | null) => {
    if (msg === null) {
        parentPort!.close();
        return;
    }
    try {
        if (msg.cfgText !== lastText || !lastCfg) {
            lastCfg = decodeWire<RemoteConfig>(msg.cfgText);
            lastText = msg.cfgText;
        }
        const result = runRemoteJob(msg.kind, lastCfg, msg.key, msg.jobDir);
        // Encoded here, like the config: a mesh result carries typed arrays (its land colours).
        parentPort!.postMessage({ id: msg.id, resultText: result === undefined ? undefined : encodeWire(result) });
    } catch (err) {
        const k = msg.key;
        parentPort!.postMessage({ id: msg.id, error: `${k.z}/${k.x}/${k.y}: ${err instanceof Error ? err.stack ?? err.message : String(err)}` });
    }
});
