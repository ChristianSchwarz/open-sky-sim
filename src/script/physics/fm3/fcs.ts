/**
 * FM3 flight control system, laid out like the F-16's (NASA TP-1538 describes
 * the aircraft's basic system; gains here are FM3's own).
 *
 *  - Pitch: normal-acceleration command blended with pitch-rate command at low
 *    dynamic pressure, proportional-integral on the error, pitch-rate damping,
 *    and angle-of-attack feedback that gives the relaxed-stability airframe its
 *    apparent static stability. Envelope protection is a min-select: the g
 *    error the loop acts on can never exceed the headroom left to the AoA limit,
 *    both taken from lead-predicted values, so a full pull flies to whichever
 *    limit comes first instead of fighting a saturated g loop.
 *  - Roll: roll-rate command, faded at high AoA (TP-1538's cure for the
 *    inertia-coupling departure).
 *  - Yaw: washed-out stability-axis yaw damper, aileron–rudder interconnect
 *    growing with AoA, pedal authority faded at high AoA, and automatic spin
 *    prevention above 29° AoA.
 *  - Leading-edge flaps on the Stevens & Lewis schedule.
 *
 * With the limiters off (the `L` key) the AoA limit, the high-AoA roll and
 * pedal fades and spin prevention go, and AoA feedback fades out past the
 * limit — the stability augmentation stays, so the aircraft is still flyable,
 * but full stick now reaches the deep stall. Roughly the F-16's manual pitch
 * override.
 *
 * Sensor and command conventions are NASA: α, β, p, q, r; stabilator and
 * flaperon trailing edge down positive; rudder positive = nose right.
 */
import { clamp } from '../../utils/math';
import { CHANNEL_INDEX } from './fm3Airframe';

const DEG = Math.PI / 180;
/** Low-pass time constant for the α̇ and ṅ estimates (s). */
const RATE_FILTER_TAU_S = 0.05;

export interface Fm3FcsConfig {
    pitch: {
        maxG: number;
        minG: number;
        /** Stick shaping, 0 = linear … 1 = cubic. */
        stickExpo: number;
        /** Pitch-rate command at full stick where the rate law rules (rad/s). */
        maxPitchRate: number;
        /** Dynamic pressure band (Pa) over which the rate law hands over to the g law. */
        blendQbarLow: number;
        blendQbarHigh: number;
        /** Gains at `qbarRef`, scheduled ∝ qbarRef / q̄ within [scheduleMin, scheduleMax]. */
        qbarRef: number;
        scheduleMin: number;
        scheduleMax: number;
        /** Stabilator (rad) per g of error. */
        kg: number;
        /** Stabilator (rad) per (rad/s) of pitch-rate error (rate law). */
        kqCommand: number;
        /** Integral gain (per second, on the stabilator-unit error). */
        ki: number;
        integratorLimit: number;
        /** Pitch-rate damping (rad of stabilator per rad/s). */
        kq: number;
        /** AoA feedback (rad of stabilator per rad). */
        kAlpha: number;
        /** Lead on the load factor fed to the g loop (s). */
        gLead: number;
        /** First-order prefilter on the g command (s): a stick step asks for g gradually. */
        commandTau: number;
        /** Lead on the load factor the structural g limits protect (s), longer than `gLead`. */
        gLimitLead: number;
        alphaLimit: number;
        negativeAlphaLimit: number;
        /** Lead on the AoA the limiter protects (s). */
        alphaLead: number;
        /** Headroom to the AoA limit, in g of allowed command per radian. */
        alphaLimitG: number;
        /** Band below the limit over which AoA feedback fades out with limiters off. */
        alphaFadeBand: number;
        maxStab: number;
    };
    roll: {
        maxRate: number;
        /** Aileron (rad) per rad/s of stability-axis roll-rate error. */
        kp: number;
        /** Cap on the dynamic-pressure schedule for the lateral loops (roll and yaw damper). */
        scheduleMax: number;
        /** Commanded roll rate fades between these AoA with the limiters on. */
        alphaFadeStart: number;
        alphaFadeEnd: number;
        alphaFadeFloor: number;
        /** Lateral feedback gains fade between these AoA, whatever the limiters. */
        gainFadeStart: number;
        gainFadeEnd: number;
        gainFadeFloor: number;
        /** Differential stabilator per unit aileron. */
        differentialStab: number;
        maxAileron: number;
    };
    yaw: {
        /** Rudder (rad) per rad/s of washed-out stability-axis yaw rate. */
        kr: number;
        washoutTau: number;
        /** Rudder per unit aileron per radian of AoA. */
        ariPerAlpha: number;
        ariMax: number;
        maxRudder: number;
        pedalFadeStart: number;
        pedalFadeEnd: number;
        /** Rudder (rad) per rad of sideslip. */
        kBeta: number;
        antiSpinAlpha: number;
        antiSpinGain: number;
    };
    lef: { enabled: boolean };
    /** Trailing-edge flap deflection with flaps extended. */
    flapDeflection: number;
    speedbrakeAngle: number;
}

export interface Fm3FcsInput {
    pitchStick: number;
    rollStick: number;
    pedal: number;
    alpha: number;
    beta: number;
    p: number; q: number; r: number;
    nz: number;
    qbar: number;
    staticPressure: number;
    landed: boolean;
    limitersEnabled: boolean;
    flapsExtended: boolean;
    airbrakesExtended: boolean;
}

export class Fm3Fcs {
    private integrator = 0;
    private yawLowPass = 0;
    private lastStab = 0;
    private alphaRate = 0;
    private nzRate = 0;
    private prevAlpha = 0;
    private prevNz = 1;
    private hasPrev = false;
    private nCommand = 1;
    /** Roll command in [-1, 1] after shaping and fades, for the HUD / animation. */
    rollCommand = 0;

    constructor(private readonly cfg: Fm3FcsConfig) { }

    reset(): void {
        this.integrator = 0;
        this.yawLowPass = 0;
        this.lastStab = 0;
        this.alphaRate = 0;
        this.nzRate = 0;
        this.hasPrev = false;
        this.nCommand = 1;
        this.rollCommand = 0;
    }

    /** Preload the pitch integrator so a spawn starts near 1 g without a transient. */
    trimTo(stab: number, input: Fm3FcsInput): void {
        const p = this.cfg.pitch;
        const k = this.schedule(input.qbar);
        const feedback = k * (p.kq * input.q + p.kAlpha * input.alpha);
        this.integrator = clamp((feedback - stab) / Math.max(1e-6, k * p.ki), -p.integratorLimit, p.integratorLimit);
        this.lastStab = stab;
        this.hasPrev = false;
    }

    private schedule(qbar: number): number {
        const p = this.cfg.pitch;
        return clamp(p.qbarRef / Math.max(qbar, 1), p.scheduleMin, p.scheduleMax);
    }

    /** Writes channel commands (rad) into `out`, indexed by CHANNEL_INDEX. */
    update(input: Fm3FcsInput, dt: number, out: Float64Array): void {
        const cp = this.cfg.pitch;
        const cr = this.cfg.roll;
        const cy = this.cfg.yaw;
        const limiters = input.limitersEnabled;
        const alpha = input.alpha;
        const k = this.schedule(input.qbar);

        if (dt > 0 && this.hasPrev) {
            const b = 1 - Math.exp(-dt / RATE_FILTER_TAU_S);
            this.alphaRate += ((alpha - this.prevAlpha) / dt - this.alphaRate) * b;
            this.nzRate += ((input.nz - this.prevNz) / dt - this.nzRate) * b;
        }
        this.prevAlpha = alpha;
        this.prevNz = input.nz;
        this.hasPrev = true;

        // ---- Pitch ----
        const stick = clamp(input.pitchStick, -1, 1);
        const s = (1 - cp.stickExpo) * stick + cp.stickExpo * stick * stick * stick;
        const nTarget = s >= 0 ? 1 + s * (cp.maxG - 1) : 1 + s * (1 - cp.minG);
        this.nCommand += (nTarget - this.nCommand) * (dt > 0 ? 1 - Math.exp(-dt / Math.max(cp.commandTau, 1e-3)) : 1);
        const blend = input.landed ? 0 : smoothstep(cp.blendQbarLow, cp.blendQbarHigh, input.qbar);
        const gError = this.nCommand - (input.nz + cp.gLead * this.nzRate);
        const rateError = s * cp.maxPitchRate - input.q;
        let error = blend * cp.kg * gError + (1 - blend) * cp.kqCommand * rateError;
        if (limiters) {
            // Envelope protection: never ask for more than the headroom to the
            // lead-predicted AoA and g limits, in the same stabilator units.
            const alphaPredicted = alpha + cp.alphaLead * this.alphaRate;
            const nPredicted = input.nz + cp.gLimitLead * this.nzRate;
            const upper = Math.min(
                cp.kg * cp.alphaLimitG * (cp.alphaLimit - alphaPredicted),
                cp.kg * (cp.maxG - nPredicted),
            );
            const lower = Math.max(
                cp.kg * cp.alphaLimitG * (cp.negativeAlphaLimit - alphaPredicted),
                cp.kg * (cp.minG - nPredicted),
            );
            if (error > upper) error = upper;
            if (error < lower) error = lower;
        }

        const alphaFade = limiters ? 1 : 1 - smoothstep(cp.alphaLimit - cp.alphaFadeBand, cp.alphaLimit, alpha);
        let damping = k * cp.kq * input.q;
        if (!limiters) {
            // Past the envelope the pilot, not the damper, owns the stabilator:
            // pitch rocking a deep stall has to be possible.
            damping = clamp(damping, -0.4 * cp.maxStab, 0.4 * cp.maxStab);
        }
        let stab = -k * (error + cp.ki * this.integrator) + damping + k * cp.kAlpha * alphaFade * alpha;
        const saturatedHigh = stab >= cp.maxStab && error < 0;
        const saturatedLow = stab <= -cp.maxStab && error > 0;
        if (input.landed) {
            this.integrator *= Math.exp(-dt / 0.5);
        } else if (!saturatedHigh && !saturatedLow) {
            this.integrator = clamp(this.integrator + error * dt, -cp.integratorLimit, cp.integratorLimit);
        }
        stab = clamp(stab, -cp.maxStab, cp.maxStab);
        this.lastStab = stab;

        // ---- Roll ----
        let rollFade = 1;
        if (limiters) {
            const t = smoothstep(cr.alphaFadeStart, cr.alphaFadeEnd, Math.abs(alpha));
            rollFade = 1 - (1 - cr.alphaFadeFloor) * t;
        }
        const antiSpin = limiters && alpha > cy.antiSpinAlpha;
        const rollStick = antiSpin ? 0 : clamp(input.rollStick, -1, 1);
        const pCmd = rollStick * cr.maxRate * rollFade;
        this.rollCommand = rollStick * rollFade;
        // Roll about the velocity vector (stability axes), as the F-16's system
        // does: rolling about the body axis at high AoA would trade angle of
        // attack for sideslip. The lateral feedback gains are capped at low
        // dynamic pressure and fade at high AoA, where the surfaces lose
        // effectiveness and a high-gain damper only drives itself into a cycle.
        const cosA = Math.cos(alpha), sinA = Math.sin(alpha);
        const pStab = input.p * cosA + input.r * sinA;
        const rStab = input.r * cosA - input.p * sinA;
        const gainFade = 1 - (1 - cr.gainFadeFloor) * smoothstep(cr.gainFadeStart, cr.gainFadeEnd, Math.abs(alpha));
        const kLat = Math.min(k, cr.scheduleMax) * gainFade;
        const aileron = clamp(kLat * cr.kp * (pCmd - pStab), -cr.maxAileron, cr.maxAileron);

        // ---- Yaw ----
        this.yawLowPass += (rStab - this.yawLowPass) * (1 - Math.exp(-dt / cy.washoutTau));
        const washed = rStab - this.yawLowPass;
        let rudder: number;
        if (antiSpin) {
            rudder = -cy.antiSpinGain * input.r;
        } else {
            const pedalFade = limiters ? 1 - smoothstep(cy.pedalFadeStart, cy.pedalFadeEnd, alpha) : 1;
            const ari = clamp(cy.ariPerAlpha * alpha, 0, cy.ariMax) * aileron;
            rudder = clamp(input.pedal, -1, 1) * cy.maxRudder * pedalFade - kLat * cy.kr * washed + ari + gainFade * cy.kBeta * input.beta;
        }
        rudder = clamp(rudder, -cy.maxRudder, cy.maxRudder);

        // ---- Mixing ----
        const flap = input.flapsExtended ? this.cfg.flapDeflection : 0;
        const diff = aileron * cr.differentialStab;
        out[CHANNEL_INDEX.stabL] = stab + diff;
        out[CHANNEL_INDEX.stabR] = stab - diff;
        out[CHANNEL_INDEX.flapL] = flap + aileron;
        out[CHANNEL_INDEX.flapR] = flap - aileron;
        out[CHANNEL_INDEX.rudder] = rudder;
        out[CHANNEL_INDEX.speedbrake] = input.airbrakesExtended ? this.cfg.speedbrakeAngle : 0;

        out[CHANNEL_INDEX.lef] = this.cfg.lef.enabled && !input.landed
            ? leadingEdgeFlapSchedule(alpha, input.qbar, input.staticPressure)
            : 0;
    }

    /** Last symmetric stabilator command (rad). */
    get stabCommand(): number {
        return this.lastStab;
    }
}

/**
 * The F-16's leading-edge flap deflection (rad) at angle of attack `alpha`,
 * Stevens & Lewis: 1.38 α° − 9.05 q̄/p_s + 1.45, limited to 0..25°.
 */
export function leadingEdgeFlapSchedule(alpha: number, qbar: number, staticPressure: number): number {
    const deg = 1.38 * alpha / DEG - 9.05 * qbar / Math.max(staticPressure, 1) + 1.45;
    return clamp(deg, 0, 25) * DEG;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    if (edge1 === edge0) return x < edge0 ? 0 : 1;
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

/** Gains for the F-16, tuned with tools/fm3/stepResponses.ts and pinned by fm3FlightModel.test.ts. */
export const F16_FCS: Fm3FcsConfig = {
    pitch: {
        maxG: 9,
        minG: -3,
        stickExpo: 0.6,
        maxPitchRate: 20 * DEG,
        blendQbarLow: 2500,
        blendQbarHigh: 6000,
        qbarRef: 12000,
        scheduleMin: 0.15,
        scheduleMax: 3,
        kg: 0.06,
        kqCommand: 0.8,
        ki: 1.5,
        integratorLimit: 0.5,
        kq: 0.35,
        kAlpha: 0.5,
        gLead: 0.15,
        commandTau: 0.12,
        gLimitLead: 0.35,
        alphaLimit: 25 * DEG,
        negativeAlphaLimit: -5 * DEG,
        alphaLead: 0.3,
        alphaLimitG: 30,
        alphaFadeBand: 5 * DEG,
        maxStab: 25 * DEG,
    },
    roll: {
        maxRate: 300 * DEG,
        kp: 0.2,
        scheduleMax: 1.5,
        alphaFadeStart: 15 * DEG,
        alphaFadeEnd: 30 * DEG,
        alphaFadeFloor: 0.2,
        gainFadeStart: 30 * DEG,
        gainFadeEnd: 60 * DEG,
        gainFadeFloor: 0.25,
        differentialStab: 5.375 / 21.5,
        maxAileron: 21.5 * DEG,
    },
    yaw: {
        kr: 0.8,
        washoutTau: 1.0,
        ariPerAlpha: 1.0,
        ariMax: 0.5,
        maxRudder: 30 * DEG,
        pedalFadeStart: 20 * DEG,
        pedalFadeEnd: 30 * DEG,
        kBeta: 0.5,
        antiSpinAlpha: 29 * DEG,
        antiSpinGain: 1.5,
    },
    lef: { enabled: true },
    flapDeflection: 20 * DEG,
    speedbrakeAngle: 60 * DEG,
};
