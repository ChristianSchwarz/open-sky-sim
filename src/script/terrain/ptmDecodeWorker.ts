import { prepareLand } from './landPrep';
import { decodePtm } from './ptm';
import { PtmDecodeReply, PtmDecodeRequest, tileBuffers } from './ptmDecoder';

/** Decodes a mesh tile and prepares its land off the main thread; see PtmDecoder. */
self.onmessage = (event: MessageEvent<PtmDecodeRequest>) => {
    const { id, bytes } = event.data;
    let reply: PtmDecodeReply;
    try {
        reply = { id, tile: prepareLand(decodePtm(bytes)) };
    } catch (err) {
        reply = { id, error: String(err) };
    }
    self.postMessage(reply, { transfer: reply.tile ? tileBuffers(reply.tile) : [] });
};
