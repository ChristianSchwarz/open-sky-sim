/**
 * FM3 engine: Stevens & Lewis's F100 power-level dynamics driving the same
 * thrust schedule and throttle quadrant FM2 uses.
 *
 * Power runs 0–100%: 0–50 is idle to military, 50–100 afterburner. The core
 * spools with a rate that depends on how far it has to go — slowly for a big
 * change, briskly for a small one — and lighting the afterburner from below
 * military first spools the core to 60% (Stevens & Lewis, "Aircraft Control
 * and Simulation", F-16 engine model).
 */
import { computeThrustDensityFactor } from '../aeroUtils';

export interface EngineSchedule {
    idleThrustN: number;
    milThrustN: number;
    /** 0 = no afterburner. */
    abMinThrustN: number;
    maxThrustN: number;
    /** Lever position at 100% military (the quadrant's MIL detent). */
    milLeverEnd: number;
    /** Lever position at the first afterburner detent. */
    abMinLeverEnd: number;
}

/** Reciprocal time constant (1/s) for a core power change of `dp` percent. */
function rtau(dp: number): number {
    if (dp <= 25) return 1.0;
    if (dp >= 50) return 0.1;
    return 1.9 - 0.036 * dp;
}

export class Fm3Engine {
    /** Current power level, percent. */
    power = 0;

    constructor(private readonly schedule: EngineSchedule) { }

    get afterburner(): boolean {
        return this.schedule.abMinThrustN > 0;
    }

    /** Power level at the first afterburner detent. */
    private get abMinPower(): number {
        const s = this.schedule;
        return 50 + 50 * (s.abMinThrustN - s.milThrustN) / Math.max(1, s.maxThrustN - s.milThrustN);
    }

    /** Commanded power for a throttle lever in [0, 1]. */
    commandedPower(lever: number): number {
        const l = lever < 0 ? 0 : lever > 1 ? 1 : lever;
        if (!this.afterburner) return 50 * l;
        const s = this.schedule;
        if (l <= s.milLeverEnd) return 50 * l / s.milLeverEnd;
        if (l < s.abMinLeverEnd) return 50;
        if (l < 1) return this.abMinPower;
        return 100;
    }

    /** Jump straight to the commanded power (airborne spawn). */
    sync(lever: number): void {
        this.power = this.commandedPower(lever);
    }

    update(dt: number, lever: number): void {
        const pc = this.commandedPower(lever);
        const p = this.power;
        let target: number;
        let rate: number;
        if (pc >= 50) {
            if (p >= 50) { target = pc; rate = 5.0; }
            else { target = 60; rate = rtau(target - p); }
        } else if (p >= 50) {
            target = 40; rate = 5.0;
        } else {
            target = pc; rate = rtau(target - p);
        }
        // Frozen target and rate over the step: an exact first-order update.
        let next = p + (target - p) * (1 - Math.exp(-rate * dt));
        // Don't let the intermediate 60% / 40% targets carry the core past the command.
        if ((target === 60 && pc < 60 && next > pc && p <= pc) || (target === 40 && pc > 40 && next < pc && p >= pc)) {
            next = pc;
        }
        this.power = next < 0 ? 0 : next > 100 ? 100 : next;
    }

    /** Delivered thrust (N) with the sim's ISA turbofan lapse. */
    thrustN(rho: number, altitudeM: number): number {
        const s = this.schedule;
        const p = this.power;
        const sl = p <= 50
            ? s.idleThrustN + (s.milThrustN - s.idleThrustN) * p / 50
            : s.milThrustN + (s.maxThrustN - s.milThrustN) * (p - 50) / 50;
        return sl * computeThrustDensityFactor(rho, altitudeM);
    }

    /** The lever position that would command the current power (HUD, audio, nozzle glow). */
    equivalentLever(): number {
        const p = this.power;
        if (!this.afterburner) return p / 50;
        const s = this.schedule;
        if (p <= 50) return s.milLeverEnd * p / 50;
        const ab1 = this.abMinPower;
        if (p < ab1) return s.milLeverEnd + (s.abMinLeverEnd - s.milLeverEnd) * (p - 50) / Math.max(1e-6, ab1 - 50);
        return s.abMinLeverEnd + (1 - s.abMinLeverEnd) * (p - ab1) / Math.max(1e-6, 100 - ab1);
    }
}
