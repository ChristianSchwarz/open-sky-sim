/**
 * Runway pads for test airfields: what the bake would write for a field whose
 * ground is exactly its `plane`. Tests describe a field by its plane because
 * that is one line; the runtime reads the pads.
 */

import { Airfield, primaryRunway } from './airfields';
import { FlattenPadManifest } from './manifest';

/** Margin and feather round a test runway's pavement, as the bake lays them out. */
const MARGIN_M = 10;
const FEATHER_M = 30;

export function padsOnPlane(airfield: Airfield): FlattenPadManifest[] {
    const primary = primaryRunway(airfield);
    const lat0 = primary?.lat ?? airfield.lat;
    const lon0 = primary?.lon ?? airfield.lon;
    const mLat = 111132.92 - 559.82 * Math.cos(2 * lat0 * Math.PI / 180);
    const mLon = 111412.84 * Math.cos(lat0 * Math.PI / 180);
    const ph = airfield.plane.headingDeg * Math.PI / 180;
    const planeAt = (e: number, n: number) =>
        airfield.plane.heightMsl + airfield.plane.gradient * (e * Math.sin(ph) + n * Math.cos(ph));
    return airfield.runways.map(r => {
        const e = (r.lon - lon0) * mLon;
        const n = (r.lat - lat0) * mLat;
        const rh = r.headingDeg * Math.PI / 180;
        const halfD = r.lengthM / 2 + MARGIN_M + FEATHER_M;
        return {
            lat: r.lat,
            lon: r.lon,
            headingDeg: r.headingDeg,
            halfD,
            halfW: r.widthM / 2 + MARGIN_M + FEATHER_M,
            featherM: FEATHER_M,
            heightMsl: planeAt(e, n),
            profile: [-halfD, halfD].map(u => planeAt(e + Math.sin(rh) * u, n + Math.cos(rh) * u)),
        };
    });
}
