import * as THREE from 'three';
import {
    aspectAngle,
    closureRate as geomClosureRate,
    specificEnergyHeight,
    trackingAngle,
} from '../dogfightGeometry';
import { AircraftSnapshot, TacticalGeometry } from './shawTypes';

const _los = new THREE.Vector3();

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

const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _path = new THREE.Vector3();
/** Past this |sin(climb)| the flight path is too near vertical to define a level side by itself. */
const VERTICAL_PATH = 0.97;

/**
 * Write the flight-path frame into `snap.right` / `snap.up`: `right` level
 * and square to the path, `up` square to the path in its vertical plane. The
 * tactical FSMs aim at offsets like `forward + 1.4 x right` or `los + 0.7 x up`;
 * on body axes, under a controller that rolls the lift vector onto the aim,
 * rolling toward "right" moved "right" with it and the roll never converged
 * (the jet hung in the vertical at roll-first stick). On these axes "right"
 * is a compass side and "up" is up, whatever the roll. `bodyRight` stands in
 * while the path is near vertical; the last frame holds if both degenerate.
 */
export function setFlightPathAxes(snap: AircraftSnapshot, bodyRight: THREE.Vector3): void {
    _path.copy(snap.velocity);
    if (_path.lengthSq() < 1) _path.copy(snap.forward);
    _path.normalize();
    if (Math.abs(_path.y) < VERTICAL_PATH) {
        snap.right.crossVectors(_WORLD_UP, _path).normalize();
    } else if (bodyRight.x * bodyRight.x + bodyRight.z * bodyRight.z > 1e-4) {
        snap.right.set(bodyRight.x, 0, bodyRight.z).normalize();
    }
    snap.up.crossVectors(_path, snap.right).normalize();
}
