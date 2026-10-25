/**
 * Ski-jump ramps from OpenStreetMap (Saki's T2), as the game's own ski-jump:
 * the same cosine deck (skiJump.ts) for the gear to roll up, sized to the
 * footprint and the roof height OSM gives, standing on the airfield's plane
 * at the end of its run-up.
 */
import { airfieldPlaneSceneAt } from '../../state/activeAirfield';
import { Airfield, AirfieldSkiJump } from '../../terrain/airfields';
import { EnuBasis } from '../../terrain/geodesy';
import { AIRFIELD_SURFACE_EPS_M } from '../airfield/airfieldModel';
import { createSkiJumpCollider, SkiJumpCollider } from './skiJump';

export interface OsmSkiJump {
    source: AirfieldSkiJump;
    collider: SkiJumpCollider;
}

/** Every ramp of these airfields, in scene coordinates. */
export function osmSkiJumpsOf(airfields: readonly Airfield[], basis: EnuBasis): OsmSkiJump[] {
    const out: OsmSkiJump[] = [];
    for (const airfield of airfields) {
        for (const jump of airfield.skiJumps ?? []) {
            if (!(jump.lengthM > 1 && jump.widthM > 1 && jump.heightM > 0)) {
                continue;
            }
            // On the run-up's pavement, which like all of it is drawn and
            // solid AIRFIELD_SURFACE_EPS_M off the plane.
            const base = airfieldPlaneSceneAt(airfield, basis, jump.lat, jump.lon, AIRFIELD_SURFACE_EPS_M);
            // The heading from two placed points rather than from the bearing,
            // so it carries the frame's own turn away from the play origin.
            const r = jump.headingDeg * Math.PI / 180;
            const perLat = 111_132.954;
            const perLon = 111_412.84 * Math.cos(jump.lat * Math.PI / 180);
            const tip = airfieldPlaneSceneAt(airfield, basis,
                jump.lat + jump.lengthM * Math.cos(r) / perLat,
                jump.lon + jump.lengthM * Math.sin(r) / perLon, AIRFIELD_SURFACE_EPS_M);
            const heading = Math.atan2(tip.x - base.x, tip.z - base.z);
            out.push({
                source: jump,
                collider: createSkiJumpCollider(
                    base.x, base.y, base.z, heading, jump.lengthM, jump.heightM, jump.widthM),
            });
        }
    }
    return out;
}
