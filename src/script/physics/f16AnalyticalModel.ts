import { computeAirDensity } from './aeroUtils';
import {
    F16_PAPER_ANALYTICAL,
    F16_PAPER_VSPAERO,
    FPS_TO_MPS,
    FT_TO_M,
    LB_TO_KG,
    LB_TO_N,
} from './f16PaperData';
import { F16_PROFILE } from './f16Profile';

const GRAVITY = 9.80665;

function wingAreaM2(): number {
    return F16_PROFILE.wingAreaM2;
}

function clFromAlphaRad(
    alphaRad: number,
    clAlpha: number = F16_PROFILE.clAlphaPerRad,
    cl0: number = F16_PROFILE.cl0,
): number {
    return cl0 + clAlpha * alphaRad;
}

function cdFromCl(cl: number, cd0: number = F16_PROFILE.cd0, k: number = F16_PROFILE.inducedDragK): number {
    return cd0 + k * cl * cl;
}

export function liftToDragFromAlphaDeg(
    alphaDeg: number,
    cd0: number = F16_PROFILE.cd0,
    k: number = F16_PROFILE.inducedDragK,
    clAlpha: number = F16_PROFILE.clAlphaPerRad,
    cl0: number = F16_PROFILE.cl0,
): number {
    const alphaRad = alphaDeg * Math.PI / 180;
    const cl = clFromAlphaRad(alphaRad, clAlpha, cl0);
    const cd = cdFromCl(cl, cd0, k);
    if (cd <= 0) {
        return 0;
    }
    return cl / cd;
}

export function minGlideAngleDeg(maxLiftToDrag = F16_PAPER_ANALYTICAL.maxLiftToDrag): number {
    return Math.atan(1 / maxLiftToDrag) * 180 / Math.PI;
}

/** Level-flight CL for weight support at speed (Anderson, L = W). */
function levelFlightCl(
    speedMps: number,
    altitudeMeters: number,
    massKg: number,
): number {
    const rho = computeAirDensity(altitudeMeters);
    const weightN = massKg * GRAVITY;
    const q = 0.5 * rho * speedMps * speedMps;
    if (q <= 0 || speedMps <= 0) {
        return 0;
    }
    return weightN / (q * wingAreaM2());
}

/** Total level-flight drag (N) — paper Eq. (2–3), k₂ = 0. */
export function computeLevelFlightDragN(
    speedMps: number,
    altitudeMeters: number,
    massKg: number,
    cd0: number = F16_PROFILE.cd0,
    k: number = F16_PROFILE.inducedDragK,
): number {
    const rho = computeAirDensity(altitudeMeters);
    const q = 0.5 * rho * speedMps * speedMps;
    if (q <= 0 || speedMps <= 0) {
        return 0;
    }

    const cl = levelFlightCl(speedMps, altitudeMeters, massKg);
    const cd = cdFromCl(cl, cd0, k);
    return q * wingAreaM2() * cd;
}

/** Level-flight drag per paper methodology (Thrust_required = Drag, L = W). */
export function totalDragLb(
    velocityFps: number,
    altitudeFt: number,
    weightLb: number,
    cd0: number = F16_PROFILE.cd0,
    k: number = F16_PROFILE.inducedDragK,
): number {
    const velocityMps = velocityFps * FPS_TO_MPS;
    const altitudeM = altitudeFt * FT_TO_M;
    const massKg = weightLb * LB_TO_KG;
    const dragN = computeLevelFlightDragN(velocityMps, altitudeM, massKg, cd0, k);
    return dragN / LB_TO_N;
}

export function thrustRequiredLb(velocityFps: number, altitudeFt: number, weightLb: number): number {
    return totalDragLb(velocityFps, altitudeFt, weightLb);
}

export function findMinDragVelocityFps(
    altitudeFt: number,
    weightLb: number,
    minFps = 400,
    maxFps = 1800,
): { velocityFps: number; dragLb: number } {
    let bestVelocity = minFps;
    let bestDrag = totalDragLb(minFps, altitudeFt, weightLb);

    for (let velocity = minFps; velocity <= maxFps; velocity += 1) {
        const drag = totalDragLb(velocity, altitudeFt, weightLb);
        if (drag < bestDrag) {
            bestDrag = drag;
            bestVelocity = velocity;
        }
    }

    return { velocityFps: bestVelocity, dragLb: bestDrag };
}

/** Minimum drag at (L/D)max for level flight: D = W / (L/D)max. */
export function minimumLevelFlightDragLb(weightLb: number): number {
    return weightLb / F16_PAPER_ANALYTICAL.maxLiftToDrag;
}

/** Sim flight-model constants mapped to paper analytical values. */
export function simMatchesPaperAnalyticalConstants(): boolean {
    return F16_PROFILE.cd0 === F16_PAPER_ANALYTICAL.cd0
        && F16_PROFILE.inducedDragK === F16_PAPER_ANALYTICAL.inducedDragK
        && F16_PROFILE.cl0 === F16_PAPER_ANALYTICAL.cl0
        && F16_PROFILE.clAlphaPerRad === F16_PAPER_ANALYTICAL.clAlphaPerRad;
}

/** VSPAero profile for separate comparison tests (Section IV.B). */
export function liftToDragVspaero(alphaDeg: number): number {
    return liftToDragFromAlphaDeg(
        alphaDeg,
        F16_PAPER_VSPAERO.cd0,
        F16_PAPER_VSPAERO.inducedDragK,
        F16_PAPER_VSPAERO.clAlphaPerRad,
        F16_PAPER_ANALYTICAL.cl0,
    );
}

function weightToMassKg(weightLb: number): number {
    return weightLb * LB_TO_KG;
}

function cruiseDynamicPressurePa(): number {
    const v = F16_PAPER_ANALYTICAL.cruiseVelocityFps * FPS_TO_MPS;
    const rho = computeAirDensity(F16_PAPER_ANALYTICAL.cruiseAltitudeFt * FT_TO_M);
    return 0.5 * rho * v * v;
}

export function simTotalDragLb(
    velocityFps: number,
    altitudeFt: number,
    weightLb: number,
): number {
    return totalDragLb(velocityFps, altitudeFt, weightLb, F16_PROFILE.cd0, F16_PROFILE.inducedDragK);
}
