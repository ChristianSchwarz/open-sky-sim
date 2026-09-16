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
};

export function createSimFlightModel(kind: SimFlightModelKind, config?: Fm2AircraftConfig): SimFlightModel {
    if (kind === 'fm3') return new Fm3FlightModel(config);
    return new Fm2FlightModel(config, { kinematic: kind === 'debug' });
}

/** The model an aircraft description asks for; older descriptions only carry `kinematic`. */
export function modelKindFromDesc(desc: { model?: SimFlightModelKind; kinematic?: boolean }): SimFlightModelKind {
    return desc.model ?? (desc.kinematic ? 'debug' : 'fm2');
}
