/**
 * Worker that turns an airframe into the barricade webbing's collider: its
 * gear left out, decimated to the coverage gate (see prepareAirframeSoup), and
 * its edges found. A second or two for a detailed airframe, which in the
 * sim's worker stalled the whole simulation on the approach; the collider is
 * plain typed arrays, so it goes to the sim whole (airframeBuffers).
 * `kind` says what it is: the player's airframe as drawn, or an aircraft
 * type's collision hull (for AI aircraft, and the player until the drawn one
 * is in). `gear`: the drawn airframe's gear is down (a type's hull is taken
 * as it is).
 */
import { airframeBuffers, buildAirframeCollider } from './webBarricade';

self.onmessage = (event: MessageEvent<{ key: string; kind: 'drawn' | 'hull'; gear?: boolean; triangles: Float32Array }>) => {
    const { key, kind, gear, triangles } = event.data;
    const airframe = buildAirframeCollider(triangles, kind === 'drawn' && gear !== false);
    (self as unknown as Worker).postMessage({ key, kind, airframe }, airframeBuffers(airframe));
};
