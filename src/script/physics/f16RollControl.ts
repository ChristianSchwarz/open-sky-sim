import { clamp } from '../utils/math';

/** FBW roll-axis envelope (Cat I clean). Cat III lowers max rate for heavy stores. */
export interface F16RollControlConfig {
    maxRollRateDegS: number;
    actuatorTauS: number;
}

export const F16_ROLL_CAT1: F16RollControlConfig = {
    maxRollRateDegS: 300,
    actuatorTauS: 0.075,
};


const DEG_TO_RAD = Math.PI / 180;

const MIN_Q_GAIN = 0.12;
const MAX_Q_GAIN = 1.0;

export function maxRollRateRad(config: F16RollControlConfig): number {
    return config.maxRollRateDegS * DEG_TO_RAD;
}

/** Gain falls as dynamic pressure rises — FBW limits command to protect structure. */
export function computeF16RollDynamicPressureGain(dynamicPressure: number, qRef: number): number {
    const q = Math.max(dynamicPressure, 1);
    const ref = Math.max(qRef, 1);
    const raw = MIN_Q_GAIN + (MAX_Q_GAIN - MIN_Q_GAIN) * Math.sqrt(ref / (ref + q));
    return clamp(raw, MIN_Q_GAIN, MAX_Q_GAIN);
}

function machRollLimiter(mach: number): number {
    if (mach <= 0.85) {
        return 1;
    }
    return clamp(1 - (mach - 0.85) / 0.55, 0.35, 1);
}

function altitudeRollLimiter(altitudeM: number): number {
    if (altitudeM <= 12000) {
        return 1;
    }
    return clamp(1 - (altitudeM - 12000) / 20000, 0.45, 1);
}

function aoaRollLimiter(aoaRad: number): number {
    const aoaDeg = Math.abs(aoaRad) * (180 / Math.PI);
    if (aoaDeg <= 15) {
        return 1;
    }
    return clamp(1 - (aoaDeg - 15) / 22, 0.15, 1);
}

export interface F16RollCommandInputs {
    stick: number;
    dynamicPressure: number;
    qRef: number;
    mach: number;
    altitudeM: number;
    aoaRad: number;
    flapsExtended: boolean;
    landed: boolean;
    config: F16RollControlConfig;
}

/** Stick [-1, 1] → commanded body roll rate p_cmd (rad/s). */
export function computeF16CommandedRollRate(inputs: F16RollCommandInputs): number {
    if (inputs.landed || Math.abs(inputs.stick) < 1e-6) {
        return 0;
    }

    const flapFactor = inputs.flapsExtended ? 0.65 : 1;
    const limiter = machRollLimiter(inputs.mach)
        * altitudeRollLimiter(inputs.altitudeM)
        * aoaRollLimiter(inputs.aoaRad)
        * flapFactor;

    const qGain = computeF16RollDynamicPressureGain(inputs.dynamicPressure, inputs.qRef);
    return inputs.stick * maxRollRateRad(inputs.config) * qGain * limiter;
}

/** First-order flaperon/actuator lag toward commanded rate. */
export function stepF16BodyRollRate(
    bodyRollRateRad: number,
    commandedRateRad: number,
    delta: number,
    config: F16RollControlConfig,
): number {
    if (delta <= 0) {
        return bodyRollRateRad;
    }
    const alpha = 1 - Math.exp(-delta / Math.max(config.actuatorTauS, 1e-3));
    return bodyRollRateRad + (commandedRateRad - bodyRollRateRad) * alpha;
}

/** High-AoA roll–yaw coupling: auto rudder to coordinate and limit sideslip buildup. */
export function computeF16RollYawCoupling(bodyRollRateRad: number, aoaRad: number, maxRollRateRad: number): number {
    const aoaFactor = clamp((Math.abs(aoaRad) - 0.12) / 0.4, 0, 1);
    if (aoaFactor <= 0 || maxRollRateRad <= 0) {
        return 0;
    }
    const normalizedRoll = clamp(bodyRollRateRad / maxRollRateRad, -1, 1);
    return normalizedRoll * 0.4 * aoaFactor;
}
