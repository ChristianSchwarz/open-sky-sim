/**
 * F100-PW-229 throttle quadrant and thrust schedule for F-16C.
 * Lever [0, 1] maps to 0–100%: 0=MIL 20%, 98=MIL 100%, 99=AB1, 100=AB2.
 */
import { computeAirDensity, computeThrustDensityFactor } from './aeroUtils';
import { F16_PROFILE } from './f16Profile';

/** F100-PW-229 sea-level static thrust (kN), USAF / Jane's. */
export const F16_ENGINE = {
    /** Flight idle (MIL 20% on quadrant) — 0.5 kN sea-level static. */
    idleThrustKn: 0.5,
    milThrustKn: 76.3,
    /** First afterburner detent (min AB / zone 5). */
    abMinThrustKn: 104.0,
    abMaxThrustKn: F16_PROFILE.abThrustKn,
    /** Lever [0, 1] at 100% MIL (98 on quadrant). */
    milLeverEnd: F16_PROFILE.milLeverEnd,
    /** Lever [0, 1] at AB1 detent (99 on quadrant). */
    abMinLeverEnd: F16_PROFILE.abMinLeverEnd,
} as const;

export type F16ThrottleZone = 'mil' | 'ab-min' | 'ab-max';

/** Afterburner nozzle colors — solid, no animation. */
export const F16_ENGINE_NOZZLE_COLORS = {
    mil: '#0a0a0a',
    abMin: '#ff8800',
    abMax: '#ffff00',
} as const;

export function getF16EngineNozzleColor(lever: number): string {
    const zone = getF16ThrottleZone(lever);
    if (zone === 'ab-min') {
        return F16_ENGINE_NOZZLE_COLORS.abMin;
    }
    if (zone === 'ab-max') {
        return F16_ENGINE_NOZZLE_COLORS.abMax;
    }
    return F16_ENGINE_NOZZLE_COLORS.mil;
}

export interface F16AfterburnerConeDither {
    primary: string;
    secondary: string;
}

/** AB cone dither pair (solid orange in AB1, solid yellow in AB2); null when MIL. */
export function getF16AfterburnerConeDither(lever: number): F16AfterburnerConeDither | null {
    const zone = getF16ThrottleZone(lever);
    if (zone === 'ab-min') {
        return {
            primary: F16_ENGINE_NOZZLE_COLORS.abMin,
            secondary: F16_ENGINE_NOZZLE_COLORS.abMin,
        };
    }
    if (zone === 'ab-max') {
        return {
            primary: F16_ENGINE_NOZZLE_COLORS.abMax,
            secondary: F16_ENGINE_NOZZLE_COLORS.abMax,
        };
    }
    return null;
}


const F16_AFTERBURNER_CONE_LENGTH_M = {
    mil: 0,
    abMin: 1.96,
    abMax: 3.43,
} as const;

export function getF16AfterburnerConeLengthM(lever: number): number {
    const zone = getF16ThrottleZone(lever);
    if (zone === 'ab-min') {
        return F16_AFTERBURNER_CONE_LENGTH_M.abMin;
    }
    if (zone === 'ab-max') {
        return F16_AFTERBURNER_CONE_LENGTH_M.abMax;
    }
    return F16_AFTERBURNER_CONE_LENGTH_M.mil;
}

/** Lever [0, 1] as 0–100 throttle quadrant position. */
function leverToPercent(lever: number): number {
    return clampLever(lever) * 100;
}

export function isF16AbDetentBand(lever: number): boolean {
    return leverToPercent(lever) >= 98;
}

export function getF16ThrottleZone(lever: number): F16ThrottleZone {
    const pct = leverToPercent(lever);
    if (pct < 99) {
        return 'mil';
    }
    if (pct < 100) {
        return 'ab-min';
    }
    return 'ab-max';
}

/** Sea-level rated thrust (kN) for lever position, before altitude lapse. */
export function computeF16SlThrustKn(lever: number): number {
    const pct = leverToPercent(lever);
    const { idleThrustKn, milThrustKn, abMinThrustKn, abMaxThrustKn } = F16_ENGINE;

    if (pct <= 98) {
        const milFraction = pct / 98;
        return idleThrustKn + (milThrustKn - idleThrustKn) * milFraction;
    }
    if (pct < 99) {
        return milThrustKn;
    }
    if (pct >= 100) {
        return abMaxThrustKn;
    }
    return abMinThrustKn;
}

/** Delivered engine thrust (N) at altitude with ISA turbofan lapse. */
export function computeF16EngineThrustN(lever: number, altitudeMeters: number): number {
    const slKn = computeF16SlThrustKn(lever);
    const rho = computeAirDensity(altitudeMeters);
    const factor = computeThrustDensityFactor(rho, altitudeMeters);
    return slKn * 1000 * factor;
}

export function computeF16EngineThrustKn(lever: number, altitudeMeters: number): number {
    return computeF16EngineThrustN(lever, altitudeMeters) / 1000;
}

/** HUD label: MIL 20–100% → AB1 → AB2. */
export function formatF16ThrottleHud(lever: number): string {
    const pct = leverToPercent(lever);
    const zone = getF16ThrottleZone(lever);

    if (zone === 'mil') {
        if (pct > 98) {
            return 'MIL 100';
        }
        const milPct = Math.round(20 + (pct / 98) * 80);
        return `MIL ${milPct}`;
    }
    if (zone === 'ab-min') {
        return 'AB1';
    }
    return 'AB2';
}

/** Map lever to [0, 1] for engine audio (idle→mil→full AB). */
export function f16ThrottleAudioLevel(lever: number): number {
    const slKn = computeF16SlThrustKn(lever);
    const { idleThrustKn, abMaxThrustKn } = F16_ENGINE;
    if (abMaxThrustKn <= idleThrustKn) {
        return 0;
    }
    return clampLever((slKn - idleThrustKn) / (abMaxThrustKn - idleThrustKn));
}

/** Continuous MIL ramp for held keyboard input below the MIL stop. */
export function adjustF16ThrottleInput(lever: number, step: number): number {
    const current = clampLever(lever);
    if (step > 0) {
        return rampF16ThrottleUp(current, step);
    }
    if (step < 0) {
        return rampF16ThrottleDown(current, -step);
    }
    return current;
}

/** One detent per key press: MIL 100 → AB1 → AB2 (and reverse). */
export function stepF16ThrottleDetent(lever: number, direction: 1 | -1): number {
    const pct = leverToPercent(lever);
    if (direction > 0) {
        if (pct >= 99) {
            return 1;
        }
        if (pct >= 98) {
            return F16_ENGINE.abMinLeverEnd;
        }
        return lever;
    }
    if (pct >= 100) {
        return F16_ENGINE.abMinLeverEnd;
    }
    if (pct >= 99) {
        return F16_ENGINE.milLeverEnd;
    }
    return lever;
}

function rampF16ThrottleUp(lever: number, step: number): number {
    const target = lever + step;
    if (target >= F16_ENGINE.milLeverEnd) {
        return F16_ENGINE.milLeverEnd;
    }
    return clampLever(target);
}

function rampF16ThrottleDown(lever: number, step: number): number {
    const pct = leverToPercent(lever);
    if (pct > 98) {
        return F16_ENGINE.milLeverEnd;
    }
    return clampLever(lever - step);
}

function clampLever(lever: number): number {
    return Math.max(0, Math.min(1, lever));
}
