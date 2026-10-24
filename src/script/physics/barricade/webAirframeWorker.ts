/**
 * Worker that turns an airframe as drawn into the barricade webbing's
 * collision soup (gear gaps closed, decimated to the coverage gate; see
 * prepareAirframeSoup). It takes a second or two for a detailed airframe,
 * which in the sim's worker stalled the whole simulation on the approach.
 */
import { prepareAirframeSoup } from './webBarricade';

self.onmessage = (event: MessageEvent<{ key: string; triangles: Float32Array }>) => {
    const { key, triangles } = event.data;
    const prepared = prepareAirframeSoup(triangles);
    const out = Float32Array.from(prepared.triangles);
    (self as unknown as Worker).postMessage({ key, triangles: out, coverageP99: prepared.coverageP99 }, [out.buffer]);
};
