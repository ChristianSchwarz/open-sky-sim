import * as THREE from 'three';
import { PLANE_DISTANCE_TO_GROUND } from '../defs';
import { DEFAULT_LOD_BIAS } from '../render/helpers';
import { AIRBASE_LOCAL } from './worldLayout';

/** Parked nose-out, across the runway. Turned with the base like everything else. */
const RAMP_HEADING = -Math.PI / 2;

export interface StaticAircraftType {
    name: string;
    body: string;
    shadow: string;
    lodBias: number;
}

export interface StaticModelView {
    name: string;
    position: THREE.Vector3;
    heading: number;
}

/**
 * Where the base is and which way it faces. The ramp is authored as offsets
 * from a runway pointing due north, so a real one on 021 needs the whole row
 * turned with it — see `Game.airbaseAt`, which is the same transform.
 */
export interface RampFrame {
    /** Runway-local offset to world XZ. */
    at(dx: number, dz: number): { x: number; z: number };
    heading: number;
}

const STATIC_AIRCRAFT_TYPES: StaticAircraftType[] = [
    {
        name: 'F-22',
        body: 'assets/f22_scenery.glb',
        shadow: 'assets/f22_shadow.glb',
        lodBias: DEFAULT_LOD_BIAS,
    },
];

/**
 * The parked aircraft slots, in world space.
 *
 * A function rather than a module constant: the ramp used to be at a known
 * place because there was one airbase and it never moved, and now it is
 * wherever the session's runway is.
 */
export function buildStaticModelViews(frame: RampFrame): StaticModelView[] {
    const views: StaticModelView[] = [];
    for (const type of STATIC_AIRCRAFT_TYPES) {
        for (let slotIndex = 0; slotIndex < AIRBASE_LOCAL.rampZ.length; slotIndex++) {
            const p = frame.at(AIRBASE_LOCAL.rampX, AIRBASE_LOCAL.rampZ[slotIndex]);
            views.push({
                name: `${type.name} ${slotIndex + 1}`,
                position: new THREE.Vector3(p.x, PLANE_DISTANCE_TO_GROUND, p.z),
                heading: frame.heading + RAMP_HEADING,
            });
        }
    }
    return views;
}

export function forEachStaticAircraftSlot(
    views: readonly StaticModelView[],
    fn: (type: StaticAircraftType, position: THREE.Vector3, heading: number) => void,
): void {
    let viewIndex = 0;
    for (const type of STATIC_AIRCRAFT_TYPES) {
        for (const _z of AIRBASE_LOCAL.rampZ) {
            const view = views[viewIndex++];
            if (view !== undefined) {
                fn(type, view.position, view.heading);
            }
        }
    }
}
