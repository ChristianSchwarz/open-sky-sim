/**
 * Worker that turns an airframe into the barricade webbing's collider: gear
 * gaps closed, decimated to the coverage gate (see prepareAirframeSoup), and
 * its edges found. A second or two for a detailed airframe, which in the
 * sim's worker stalled the whole simulation on the approach; the collider is
 * plain typed arrays, so it goes to the sim whole (airframeBuffers).
 * `kind` says what it is: the player's airframe as drawn, or an aircraft
 * type's collision hull (for AI aircraft, and the player until the drawn one
 * is in).
 */
import { airframeBuffers, buildAirframeCollider } from './webBarricade';

self.onmessage = (event: MessageEvent<{ key: string; kind: 'drawn' | 'hull'; triangles: Float32Array }>) => {
    const { key, kind, triangles } = event.data;
    const airframe = buildAirframeCollider(triangles);
    (self as unknown as Worker).postMessage({ key, kind, airframe }, airframeBuffers(airframe));
};
