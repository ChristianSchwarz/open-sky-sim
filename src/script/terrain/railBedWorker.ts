/**
 * Lays railway beds off the main thread (see railBed.ts and railBedClient.ts).
 * A tile's beds took 300-400 ms on the render thread, a hitch every time a
 * tile with track streamed in.
 */

import { layRailBeds } from './railBed';
import { RailBedJob, RailBedReply } from './railBedClient';

const ctx = self as unknown as {
    onmessage: ((e: MessageEvent<RailBedJob>) => void) | null;
    postMessage(message: RailBedReply, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
    const { jobId, input } = e.data;
    const t0 = performance.now();
    try {
        const result = layRailBeds({ ...input, pinned: new Set(input.pinned) });
        const transfer: Transferable[] = [];
        if (result) {
            transfer.push(result.strokePositions.buffer, result.beds.buffer);
            if (result.land) {
                transfer.push(result.land.positions.buffer, result.land.normals.buffer, result.land.attrs.buffer);
            }
        }
        ctx.postMessage({ jobId, result, ms: performance.now() - t0 }, transfer);
    } catch (err) {
        ctx.postMessage({ jobId, error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) }, []);
    }
};
