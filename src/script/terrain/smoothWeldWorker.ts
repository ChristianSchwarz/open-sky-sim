import { SmoothWeldReply, SmoothWeldRequest, weldBuffers, weldSmoothLand } from './smoothWeld';

/** Runs weldSmoothLand off the main thread; see SmoothWelder. */
self.onmessage = (event: MessageEvent<SmoothWeldRequest>) => {
    const { id, positions, normals, attrs, sizes, strength } = event.data;
    const weld = weldSmoothLand(positions, normals, attrs, sizes, strength);
    const reply: SmoothWeldReply = { id, weld };
    self.postMessage(reply, { transfer: weldBuffers(weld) });
};
