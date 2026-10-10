import * as THREE from 'three';
import { WorldQuery } from '../../ai/worldQuery';
import { Fm2AircraftConfig } from '../fm2/fm2AircraftConfig';
import { FlightModel } from '../model/flightModel';
import { Fm2FlightModel } from '../model/fm2FlightModel';
import { Fm3FlightModel } from '../model/fm3FlightModel';
import { SimFlightModelKind } from './simTypes';

export type { SimFlightModelKind };

/**
 * A flight model the combat sim can own: the {@link FlightModel} contract plus
 * the contact and terrain hooks the sim drives directly (solid-world scrapes,
 * deck parking, gear on real terrain).
 */
export type SimFlightModel = FlightModel & {
    setWorldQuery(world: WorldQuery | undefined): void;
    clearAngularVelocity(): void;
    contactSpeedIntoNormal(pointWorld: THREE.Vector3, normalWorld: THREE.Vector3): number;
    applyContactDragAt(pointWorld: THREE.Vector3, dt: number, dragPerSec: number, massFraction: number, maxFrac: number): void;
    /** The aircraft's mass (kg), to work out what a contact must hold up. */
    getMassKg(): number;
    /** World velocity of the material point of the airframe now at `pointWorld` (CG velocity + spin x arm). */
    pointVelocity(pointWorld: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
    /**
     * 1 / m + (r x d) . I^-1 (r x d): how much an impulse of unit size along `dirWorld`
     * at `pointWorld` changes the speed of that point (the rigid body's effective inverse mass).
     */
    invEffectiveMass(pointWorld: THREE.Vector3, dirWorld: THREE.Vector3): number;
};

export function createSimFlightModel(kind: SimFlightModelKind, config?: Fm2AircraftConfig): SimFlightModel {
    if (kind === 'fm3') return new Fm3FlightModel(config);
    return new Fm2FlightModel(config, { kinematic: kind === 'debug' });
}

/** The model an aircraft description asks for; older descriptions only carry `kinematic`. */
export function modelKindFromDesc(desc: { model?: SimFlightModelKind; kinematic?: boolean }): SimFlightModelKind {
    return desc.model ?? (desc.kinematic ? 'debug' : 'fm2');
}
