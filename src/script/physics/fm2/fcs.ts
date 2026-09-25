/**
 * Unified flight-control system for the FM2 model.
 *
 * A SINGLE, config-driven class flies every aircraft. The model asks the FCS to
 * turn pilot stick/pedal inputs (plus the current body rates and flight
 * condition) into normalized surface commands in [-1, 1]. Per axis a boolean
 * picks the control law:
 *   - Pitch: an AoA/g-limiting law. Three interchangeable limiter strategies are
 *     selectable at runtime (see {@link FcsPitchLimiter}); all cap AoA and load
 *     factor while keeping the stabilator motion smooth and free of hunting.
 *   - Roll (`roll.rateCommand`): a roll-rate command loop (capped and faded by
 *     dynamic pressure, Mach, altitude and AoA) OR a mechanical direct path
 *     (stick → aileron with roll-rate damping).
 *   - Yaw: a washed-out yaw-rate damper plus an aileron-rudder interconnect and
 *     direct pedal authority — shared by both handling types (gains differ).
 *
 * Outputs are normalized commands in [-1, 1]; the flight model converts them
 * into physical surface incidence for the aero parts. First-order actuator lag
 * is applied so surfaces cannot snap instantaneously.
 */
import { clamp } from '../../utils/math';
import { computeMachNumber } from '../aeroUtils';
import { Fm2FcsConfig, Fm2RollLawConfig } from './fm2AircraftConfig';

const DEG = Math.PI / 180;

/**
 * Pitch AoA/g limiter strategy. All three hold the same AoA and load-factor
 * envelope; they differ only in HOW they ease the stabilator off the limit, and
 * are switchable in flight (keys 1/2/3):
 *
 *   1. {@link FcsPitchLimiter.SOFT} — feed-forward soft authority. The pilot's
 *      pull/push authority is scaled by a smooth (smoothstep) fade of the
 *      CURRENT AoA/g through their soft bands. No feedback loop, so it cannot
 *      hunt; pitch-rate damping keeps the capture gentle.
 *   2. {@link FcsPitchLimiter.PREDICTIVE} — the same authority fade but driven by
 *      LEAD-PREDICTED AoA/g (current + rate·lead), so it starts easing off before
 *      the limit and adds AoA-rate damping that grows toward the limit. Firmer,
 *      anticipatory, minimal overshoot.
 *   3. {@link FcsPitchLimiter.SMOOTH} — an error regulator: pure stick inside the
 *      envelope, blending to a proportional-derivative "hold" command that parks
 *      AoA/g at the soft edge, with the elevator target slew-rate limited so the
 *      stabilator can never move abruptly. Softest, laggiest feel.
 */
export enum FcsPitchLimiter {
    SOFT = 1,
    PREDICTIVE = 2,
    SMOOTH = 3,
}

/** Smooth Hermite fade: 0 at edge0, 1 at edge1 (edges may be reversed). */
function smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge0 === edge1) return x < edge0 ? 0 : 1;
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

// Local limiter tuning (kept out of the per-aircraft config: these shape the
// FEEL of each strategy, not the envelope itself, which comes from the config's
// aoaSoftDeg/aoaLimitDeg/maxCommandG/minCommandG).
// Pitch-rate damping folded into every limiter law. This term does the heavy
// lifting for envelope protection: it adds phase lead so the feed-forward
// authority fade captures the AoA/g limit without overshoot or hunting. It also
// relaxes the stabilator back as a steady pitch rate establishes (a trimmed
// turn needs little elevator), so the command is deliberately NOT a 1:1 stick
// map — it is a rate-damped limiter.
const PITCH_RATE_DAMP = 1.1;
const AUTH_FILTER_TAU_S = 0.14;      // low-pass on the soft-band authority fraction (mode 1)
const PREDICT_AUTH_FILTER_TAU_S = 0.2; // low-pass on the predicted authority (mode 2)
const PREDICT_AOA_DAMP = 0.9;        // extra α̇ damping near the limit (mode 2)
const PREDICT_AOA_DAMP_CLAMP = 0.3;  // cap on the α̇ damping term so it never jerks (mode 2)
const SMOOTH_AUTH_FILTER_TAU_S = 0.3; // heavier authority low-pass for the smooth mode (mode 3)
const SMOOTH_SLEW_PER_S = 5.0;       // max elevator-target change per second (mode 3)

/**
 * Stick [-1, 1] → commanded body roll rate (rad/s) for the rate-command roll
 * law. The peak rate (`maxRollRateDegS`) is scaled by a dynamic-pressure gain
 * schedule and faded by Mach, altitude, AoA and flap limiters.
 */
function computeCommandedRollRate(input: FcsInput, roll: Fm2RollLawConfig): number {
    if (input.landed || Math.abs(input.rollStick) < 1e-6) {
        return 0;
    }
    const mach = computeMachNumber(input.speed, input.altitudeM);
    const flapFactor = input.flapsExtended ? (roll.flapsFactor ?? 0.65) : 1;
    const limiter = rollMachLimiter(mach, roll)
        * rollAltitudeLimiter(input.altitudeM, roll)
        * rollAoaLimiter(input.aoaRad, roll)
        * flapFactor;
    const qGain = rollDynamicPressureGain(input.dynamicPressure, input.qRef, roll);
    return input.rollStick * roll.maxRollRateDegS * DEG * qGain * limiter;
}

function rollDynamicPressureGain(dynamicPressure: number, qRef: number, roll: Fm2RollLawConfig): number {
    const min = roll.qGainMin ?? 0.12;
    const max = roll.qGainMax ?? 1.0;
    const q = Math.max(dynamicPressure, 1);
    const ref = Math.max(qRef, 1);
    const raw = min + (max - min) * Math.sqrt(ref / (ref + q));
    return clamp(raw, min, max);
}

function rollMachLimiter(mach: number, roll: Fm2RollLawConfig): number {
    const onset = roll.machLimiterOnset ?? 0.85;
    if (mach <= onset) {
        return 1;
    }
    return clamp(1 - (mach - onset) / (roll.machLimiterSlope ?? 0.55), roll.machLimiterFloor ?? 0.35, 1);
}

function rollAltitudeLimiter(altitudeM: number, roll: Fm2RollLawConfig): number {
    const onset = roll.altLimiterOnsetM ?? 12000;
    if (altitudeM <= onset) {
        return 1;
    }
    return clamp(1 - (altitudeM - onset) / (roll.altLimiterSlopeM ?? 20000), roll.altLimiterFloor ?? 0.45, 1);
}

function rollAoaLimiter(aoaRad: number, roll: Fm2RollLawConfig): number {
    const onset = roll.aoaLimiterOnsetDeg ?? 15;
    const aoaDeg = Math.abs(aoaRad) / DEG;
    if (aoaDeg <= onset) {
        return 1;
    }
    return clamp(1 - (aoaDeg - onset) / (roll.aoaLimiterSlopeDeg ?? 22), roll.aoaLimiterFloor ?? 0.15, 1);
}

export interface FcsInput {
    pitchStick: number; // [-1, 1] positive = nose up / pull
    rollStick: number;  // [-1, 1] positive = roll right
    yawPedal: number;   // [-1, 1] positive = nose right
    pitchRate: number;  // about +X (rad/s)
    yawRate: number;    // about +Y (rad/s)
    rollRate: number;   // about +Z (rad/s)
    loadFactorG: number;
    aoaRad: number;
    dynamicPressure: number;
    qRef: number;
    speed: number;
    altitudeM: number;
    flapsExtended: boolean;
    landed: boolean;
    /** Active pitch AoA/g limiter strategy (keys 1/2/3). */
    pitchLimiterMode: FcsPitchLimiter;
    /** When false, pilot stick maps straight to the surfaces (no envelope protection). */
    limitersEnabled: boolean;
}

export interface FcsOutput {
    elevator: number;
    aileron: number;
    rudder: number;
    /** Max nose-up elevator command available this frame (HUD clamp line). */
    elevatorLimitHi: number;
    /** Max nose-down elevator command available this frame (HUD clamp line). */
    elevatorLimitLo: number;
}

export class Fm2Fcs {
    private elevator = 0;
    private aileron = 0;
    private rudder = 0;
    private yawRateLowPass = 0;
    private elevatorLimitHi = 1;
    private elevatorLimitLo = -1;

    // Pitch-limiter filter / derivative state.
    private prevAoaRad = 0;
    private prevLoadG = 1;
    private aoaRateLowPass = 0;   // filtered α̇ (rad/s)
    private gRateLowPass = 0;     // filtered ġ (g/s)
    private authLowPass = 1;      // filtered soft-band authority (modes 1 & 2)
    private pitchTarget = 0;      // slew-limited elevator target (mode 3)

    constructor(private readonly cfg: Fm2FcsConfig) { }

    reset(): void {
        this.elevator = 0;
        this.aileron = 0;
        this.rudder = 0;
        this.yawRateLowPass = 0;
        this.prevAoaRad = 0;
        this.prevLoadG = 1;
        this.aoaRateLowPass = 0;
        this.gRateLowPass = 0;
        this.authLowPass = 1;
        this.pitchTarget = 0;
        this.elevatorLimitHi = 1;
        this.elevatorLimitLo = -1;
    }

    getState(): FcsOutput {
        return {
            elevator: this.elevator,
            aileron: this.aileron,
            rudder: this.rudder,
            elevatorLimitHi: this.elevatorLimitHi,
            elevatorLimitLo: this.elevatorLimitLo,
        };
    }

    update(input: FcsInput, dt: number): FcsOutput {
        this.trackPitchRates(input, dt);

        let elevatorTarget: number;
        let aileronTarget: number;
        let rudderTarget: number;

        if (input.limitersEnabled === false) {
            elevatorTarget = clamp(input.pitchStick, -1, 1);
            aileronTarget = clamp(-input.rollStick, -1, 1);
            rudderTarget = clamp(input.yawPedal, -1, 1);
            this.elevatorLimitHi = 1;
            this.elevatorLimitLo = -1;
        } else {
            elevatorTarget = this.pitchLaw(input, dt);
            this.updateElevatorLimits(input, dt);
            aileronTarget = this.cfg.roll.rateCommand
                ? this.rateCommandRollLaw(input)
                : this.directRollLaw(input);
            rudderTarget = this.yawLaw(input, aileronTarget, dt);
        }

        const a = dt <= 0 ? 1 : 1 - Math.exp(-dt / Math.max(this.cfg.actuatorTauS, 1e-3));
        this.elevator += (elevatorTarget - this.elevator) * a;
        this.aileron += (aileronTarget - this.aileron) * a;
        this.rudder += (rudderTarget - this.rudder) * a;

        return this.getState();
    }

    /** Publish the current AoA/g envelope caps for the HUD stick box. */
    private updateElevatorLimits(input: FcsInput, dt: number): void {
        const pullAuth = this.filterAuthority(
            this.pitchAuthority(input.aoaRad, input.loadFactorG, true), dt);
        const pushAuth = this.filterAuthority(
            this.pitchAuthority(input.aoaRad, input.loadFactorG, false), dt);
        this.elevatorLimitHi = pullAuth;
        this.elevatorLimitLo = -pushAuth;
    }

    /** Maintain filtered AoA-rate and g-rate estimates for the limiter laws. */
    private trackPitchRates(input: FcsInput, dt: number): void {
        if (dt > 0) {
            const rawAoaRate = (input.aoaRad - this.prevAoaRad) / dt;
            const rawGRate = (input.loadFactorG - this.prevLoadG) / dt;
            const tau = Math.max(this.cfg.pitch.aoaRateFilterTauS, 1e-3);
            const b = 1 - Math.exp(-dt / tau);
            this.aoaRateLowPass += (rawAoaRate - this.aoaRateLowPass) * b;
            this.gRateLowPass += (rawGRate - this.gRateLowPass) * b;
        }
        this.prevAoaRad = input.aoaRad;
        this.prevLoadG = input.loadFactorG;
    }

    /** Dispatch to the selected pitch AoA/g limiter strategy. */
    private pitchLaw(input: FcsInput, dt: number): number {
        switch (input.pitchLimiterMode) {
            case FcsPitchLimiter.PREDICTIVE:
                return this.pitchLawPredictive(input, dt);
            case FcsPitchLimiter.SMOOTH:
                return this.pitchLawSmooth(input, dt);
            case FcsPitchLimiter.SOFT:
            default:
                return this.pitchLawSoft(input, dt);
        }
    }

    /**
     * Soft-band authority in [0, 1] for the requested direction: 1 = well inside
     * the envelope, 0 = at the AoA or g hard limit (whichever bites first). The
     * fade is a smoothstep over each soft band, so authority — and thus the
     * stabilator — eases off gradually rather than clipping.
     */
    private pitchAuthority(aoaRad: number, g: number, pull: boolean): number {
        const p = this.cfg.pitch;
        const gMargin = p.gLimiterSoftMarginG ?? 1.0;
        const aoaDeg = aoaRad / DEG;
        if (pull) {
            const aoaAuth = 1 - smoothstep(p.aoaSoftDeg, p.aoaLimitDeg, aoaDeg);
            const gAuth = 1 - smoothstep(p.maxCommandG - gMargin, p.maxCommandG, g);
            return clamp(Math.min(aoaAuth, gAuth), 0, 1);
        }
        const aoaAuth = 1 - smoothstep(-p.aoaSoftDeg, -p.aoaLimitDeg, aoaDeg);
        const gAuth = 1 - smoothstep(p.minCommandG + gMargin, p.minCommandG, g);
        return clamp(Math.min(aoaAuth, gAuth), 0, 1);
    }

    private filterAuthority(rawAuth: number, dt: number, tau: number = AUTH_FILTER_TAU_S): number {
        const b = dt <= 0 ? 1 : 1 - Math.exp(-dt / tau);
        this.authLowPass += (rawAuth - this.authLowPass) * b;
        return this.authLowPass;
    }

    /**
     * Strategy 1 — SOFT: feed-forward authority scaling on the current AoA/g,
     * plus pitch-rate damping. Purely open-loop on the envelope, so it cannot
     * set up a limit cycle; the capture is smoothed by the authority low-pass
     * and the rate-damping term.
     */
    private pitchLawSoft(input: FcsInput, dt: number): number {
        const stick = input.pitchStick;
        const rawAuth = this.pitchAuthority(input.aoaRad, input.loadFactorG, stick >= 0);
        const auth = this.filterAuthority(rawAuth, dt);
        return clamp(stick * auth + PITCH_RATE_DAMP * input.pitchRate, -1, 1);
    }

    /**
     * Strategy 2 — PREDICTIVE: the authority fade is fed the LEAD-PREDICTED AoA/g
     * (current + filtered rate · lead), so the limiter starts easing the pull
     * before the aircraft actually reaches the boundary. An α̇ damping term that
     * grows as authority is withdrawn arrests the approach without a hard stop.
     */
    private pitchLawPredictive(input: FcsInput, dt: number): number {
        const p = this.cfg.pitch;
        const stick = input.pitchStick;
        const pull = stick >= 0;
        const aoaLead = (p.aoaLimiterLeadS ?? 0.08) + (p.envelopeAuthorityLeadS ?? 0.2);
        const gLead = pull
            ? (p.gLimiterLeadS ?? 0.05) + (p.envelopeAuthorityLeadS ?? 0.2)
            : (p.gLimiterNegLeadS ?? 0.02) + (p.envelopeAuthorityLeadS ?? 0.2);
        const predAoa = input.aoaRad + this.aoaRateLowPass * aoaLead;
        const predG = input.loadFactorG + this.gRateLowPass * gLead;

        const rawAuth = this.pitchAuthority(predAoa, predG, pull);
        const auth = this.filterAuthority(rawAuth, dt, PREDICT_AUTH_FILTER_TAU_S);

        // α̇ damping grows toward the limit (1 − auth); it opposes a rising |AoA|,
        // so the higher the aircraft climbs into the soft band the more the FCS
        // resists further AoA build-up — a smooth aerodynamic "wall". Clamped so a
        // transient α̇ spike can never jerk the stabilator.
        const aoaDamp = clamp(
            PREDICT_AOA_DAMP * (1 - auth) * this.aoaRateLowPass,
            -PREDICT_AOA_DAMP_CLAMP, PREDICT_AOA_DAMP_CLAMP,
        );
        return clamp(stick * auth + PITCH_RATE_DAMP * input.pitchRate - aoaDamp, -1, 1);
    }

    /**
     * Strategy 3 — SMOOTH: the same feed-forward authority fade as SOFT but with
     * a heavier authority low-pass AND a slew-rate limit on the elevator target,
     * so the commanded stabilator can never move abruptly no matter how sharply
     * the stick is thrown or how fast the envelope is approached. The trade-off
     * is a slightly softer, laggier response — deliberately the gentlest of the
     * three. Being open-loop on the envelope it cannot set up a limit cycle.
     */
    private pitchLawSmooth(input: FcsInput, dt: number): number {
        const stick = input.pitchStick;
        const rawAuth = this.pitchAuthority(input.aoaRad, input.loadFactorG, stick >= 0);
        const auth = this.filterAuthority(rawAuth, dt, SMOOTH_AUTH_FILTER_TAU_S);
        const target = clamp(stick * auth + PITCH_RATE_DAMP * input.pitchRate, -1, 1);

        const maxStep = dt <= 0 ? 1 : SMOOTH_SLEW_PER_S * dt;
        this.pitchTarget = clamp(
            this.pitchTarget + clamp(target - this.pitchTarget, -maxStep, maxStep),
            -1, 1,
        );
        return this.pitchTarget;
    }

    /** Mechanical direct roll: stick straight through, with roll-rate damping. */
    private directRollLaw(input: FcsInput): number {
        return clamp(-input.rollStick - this.cfg.roll.rateDamp * input.rollRate, -1, 1);
    }

    /** Roll-rate command law → aileron. */
    private rateCommandRollLaw(input: FcsInput): number {
        if (input.landed) {
            return 0;
        }
        const commandedRateRad = computeCommandedRollRate(input, this.cfg.roll);
        const rateError = input.rollRate - commandedRateRad;
        return clamp(this.cfg.roll.rateGain * rateError, -1, 1);
    }

    /** Yaw damper (washed out) + aileron-rudder interconnect + pedal. */
    private yawLaw(input: FcsInput, aileronCmd: number, dt: number): number {
        const yaw = this.cfg.yaw;
        const tau = Math.max(yaw.damperWashoutTauS, 1e-3);
        const a = dt <= 0 ? 1 : 1 - Math.exp(-dt / tau);
        this.yawRateLowPass += (input.yawRate - this.yawRateLowPass) * a;
        const yawRateHighPass = input.yawRate - this.yawRateLowPass;

        const damper = -yaw.damperGain * yawRateHighPass;
        const ari = yaw.ariGain * aileronCmd;
        const pedal = input.yawPedal * yaw.maxRudderCmd;
        return clamp(pedal + damper + ari, -1, 1);
    }
}
