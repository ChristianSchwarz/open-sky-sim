import * as THREE from 'three';
import {
    aspectAngle,
    closureRate as geomClosureRate,
    specificEnergyHeight,
    trackingAngle,
} from '../dogfightGeometry';
import { AircraftSnapshot, TacticalGeometry } from './shawTypes';

const _los = new THREE.Vector3();
const _scratch = new THREE.Vector3();

/**
 * Shaw-named geometry aliases over the shared dogfight helpers.
 * AOT ≈ aspect angle (0 = on target's six); TAA ≈ enemy ATA on us.
 */
export function computeTacticalGeometry(self: AircraftSnapshot, target: AircraftSnapshot): TacticalGeometry {
    _los.copy(target.position).sub(self.position);
    const range = _los.length();
    const losVector = range > 1e-6
        ? _los.clone().divideScalar(range)
        : new THREE.Vector3(0, 0, 1);

    const selfEs = specificEnergyHeight(self.altitude, self.airspeed);
    const targetEs = specificEnergyHeight(target.altitude, target.airspeed);

    const ata = trackingAngle(self.position, self.forward, target.position);
    // Aspect angle helper measures observer vs target's *tail*; that is AOT.
    const aot = aspectAngle(self.position, target.position, target.velocity);
    // TAA: how well the target is tracking us (velocity as nose proxy).
    const taa = trackingAngle(target.position, target.velocity, self.position);
    const closure = geomClosureRate(self.position, self.velocity, target.position, target.velocity);

    return {
        range,
        losVector,
        aot,
        taa,
        ata,
        closureRate: closure,
        energyDelta: selfEs - targetEs,
        selfEs,
        targetEs,
    };
}


export { specificEnergyHeight };
