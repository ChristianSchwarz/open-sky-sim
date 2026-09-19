import {
    computeAirDensity,
    computeDynamicPressureDragPenalty,
} from './aeroUtils';
import { computeLevelFlightDragN } from './f16AnalyticalModel';
import { computeF16EngineThrustN } from './f16Engine';
import { F16_PROFILE } from './f16Profile';

const F16_DRY_MASS = F16_PROFILE.combatMassKg;
const F16_WING_AREA = F16_PROFILE.wingAreaM2;
const F16_CD0 = F16_PROFILE.cd0;

export function computeF16AfterburnerThrust(altitudeMeters: number): number {
    return computeF16EngineThrustN(1.0, altitudeMeters);
}

function computeF16MilThrust(altitudeMeters: number): number {
    return computeF16EngineThrustN(F16_PROFILE.milLeverEnd, altitudeMeters);
}

/** Level-flight drag: Anderson polar (CD₀ + K·CL²), L = W. Optional transonic penalty above VNE. */
export function computeF16LevelFlightDrag(
    speedMps: number,
    altitudeMeters: number,
    massKg = F16_DRY_MASS,
    includeWaveDrag = false,
): number {
    const drag = computeLevelFlightDragN(speedMps, altitudeMeters, massKg);
    if (!includeWaveDrag) {
        return drag;
    }

    const waveDrag = computeDynamicPressureDragPenalty(speedMps, altitudeMeters);
    if (waveDrag <= 0) {
        return drag;
    }

    const airDensity = computeAirDensity(altitudeMeters);
    const dynamicPressure = 0.5 * airDensity * speedMps * speedMps;
    const weightN = massKg * 9.8;
    const cl = weightN / (dynamicPressure * F16_WING_AREA);
    const cdParasitic = F16_CD0 * waveDrag;
    return drag + dynamicPressure * F16_WING_AREA * cdParasitic;
}

export function computeF16LevelFlightMaxSpeed(
    altitudeMeters: number,
    includeWaveDrag = true,
): number {
    const thrust = computeF16AfterburnerThrust(altitudeMeters);
    let lo = 10;
    let hi = 800;

    for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) * 0.5;
        if (computeF16LevelFlightDrag(mid, altitudeMeters, F16_DRY_MASS, includeWaveDrag) > thrust) {
            hi = mid;
        } else {
            lo = mid;
        }
    }

    return (lo + hi) * 0.5;
}

export function findF16PeakLevelFlightSpeed(
    maxAltitudeMeters = 16000,
    altitudeStepMeters = 250,
    includeWaveDrag = true,
): { altitudeMeters: number; speedMps: number } {
    let bestAltitude = 0;
    let bestSpeed = 0;

    for (let altitude = 0; altitude <= maxAltitudeMeters; altitude += altitudeStepMeters) {
        const speed = computeF16LevelFlightMaxSpeed(altitude, includeWaveDrag);
        if (speed > bestSpeed) {
            bestSpeed = speed;
            bestAltitude = altitude;
        }
    }

    return { altitudeMeters: bestAltitude, speedMps: bestSpeed };
}
