/**
 * Arresting wires on land, from OSM `barrier=cable_barrier` - Saki's NITKA
 * deck maps its Svetlana-2 gear this way.
 *
 * They snag and pull out exactly like the carrier's (arrestorCables.ts): the
 * same hook test, the same 140 m run-out. What differs is that the field does
 * not move, so it holds the aircraft at rest, and that OSM says nothing about
 * which way the deck is landed on, so every wire is a field each way.
 */
import * as THREE from 'three';
import { airfieldPlaneSceneAt } from '../../state/activeAirfield';
import { Airfield } from '../../terrain/airfields';
import { EnuBasis } from '../../terrain/geodesy';
import { AIRFIELD_SURFACE_EPS_M } from '../airfield/airfieldModel';
import { ArrestorCableField } from './arrestorCables';

/**
 * First id a land wire is reported by. The carrier's cables keep their
 * indices (0-3) below it, so the carrier's visuals never bend a land wire
 * and the reverse.
 */
export const LAND_WIRE_ID_BASE = 1000;

/** Rest height above the drawn pavement (m): the carrier's deck clearance. */
export const LAND_WIRE_CLEARANCE_M = 0.35;

/** One wire in scene coordinates, sheave to sheave. */
export interface LandArrestorWire {
    id: number;
    name: string;
    a: THREE.Vector3;
    b: THREE.Vector3;
}

/**
 * Every wire of these airfields, placed on the airfield's own plane - which
 * is what the bake cut the deck under it to.
 */
export function landArrestorWiresOf(
    airfields: readonly Airfield[], basis: EnuBasis,
): LandArrestorWire[] {
    const out: LandArrestorWire[] = [];
    for (const airfield of airfields) {
        const at = (p: number[]): THREE.Vector3 =>
            airfieldPlaneSceneAt(airfield, basis, p[0], p[1], AIRFIELD_SURFACE_EPS_M + LAND_WIRE_CLEARANCE_M);
        for (const wire of airfield.arrestingWires ?? []) {
            if (wire.points.length < 2) {
                continue;
            }
            out.push({
                id: LAND_WIRE_ID_BASE + out.length,
                name: wire.name,
                a: at(wire.points[0]),
                b: at(wire.points[wire.points.length - 1]),
            });
        }
    }
    return out;
}

/** Two fields per wire, one for a roll-out each way across it. */
export function landArrestorFields(wires: readonly LandArrestorWire[]): ArrestorCableField[] {
    const fields: ArrestorCableField[] = [];
    for (const w of wires) {
        const dx = w.b.x - w.a.x;
        const dz = w.b.z - w.a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1) {
            continue;
        }
        for (const sign of [1, -1]) {
            fields.push({
                originX: (w.a.x + w.b.x) * 0.5,
                originY: (w.a.y + w.b.y) * 0.5,
                originZ: (w.a.z + w.b.z) * 0.5,
                deckAxis: new THREE.Vector3(sign * dz / len, 0, -sign * dx / len),
                segments: [{ a: w.a.clone(), b: w.b.clone() }],
                cableIds: [w.id],
                fixed: true,
            });
        }
    }
    return fields;
}

/** The wire a snapshot latch id names, or undefined for a carrier cable. */
export function landWireById(
    wires: readonly LandArrestorWire[], id: number,
): LandArrestorWire | undefined {
    return id >= LAND_WIRE_ID_BASE ? wires.find(w => w.id === id) : undefined;
}
