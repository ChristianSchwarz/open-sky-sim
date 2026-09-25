/**
 * Reference points from NASA TP-1538 (Nguyen, Ogburn, Gilbert, Kibler, Brown &
 * Deal, "Simulator Study of Stall/Post-Stall Characteristics of a Fighter
 * Airplane With Relaxed Longitudinal Static Stability", 1979), read off its
 * figures by eye — good to about ±0.02 in the coefficients. For validating FM3
 * only; nothing flies from these.
 *
 * All at the reference centre of gravity, 0.35 c̄, sideslip zero, low speed.
 */

const range = (from: number, to: number, step: number) => {
    const out: number[] = [];
    for (let x = from; x <= to + 1e-9; x += step) out.push(x);
    return out;
};

/** Figure 9: untrimmed lift of the simulated configuration. */
export const TP1538_FIG9_LIFT = {
    alphaDeg: range(0, 40, 5),
    CL: [0, 0.37, 0.75, 1.10, 1.38, 1.56, 1.81, 1.89, 1.88],
};

/**
 * Figure 10: pitching moment against angle of attack for three stabilator
 * settings (trailing edge down positive). The +25° curve's zero crossing at
 * 60° with negative slope is the deep-stall trim: "even with the stabilators
 * deflected for full nose-down control, the airplane exhibits a weak but
 * stable trim point at α = 60°".
 */
export const TP1538_FIG10_PITCH = {
    alphaDeg: range(0, 90, 5),
    Cm: {
        0: [-0.05, -0.03, -0.02, 0.00, 0.00, 0.00, 0.02, 0.00, -0.01, 0.03, 0.09, 0.06, 0.02, -0.04, -0.12, -0.25, -0.37, -0.45, -0.51],
        25: [-0.21, -0.21, -0.215, -0.155, -0.16, -0.16, -0.10, -0.07, -0.035, 0.01, 0.02, 0.03, 0.00, -0.05, -0.10, -0.26, -0.40, -0.47, -0.53],
        [-25]: [0.15, 0.18, 0.20, 0.25, 0.26, 0.25, 0.27, 0.24, 0.20, 0.20, 0.17, 0.13, 0.10, 0.02, -0.05, -0.15, -0.25, -0.32, -0.38],
    } as Record<number, number[]>,
};

/**
 * Figure 44: deep-stall entry at 9,144 m with the CG at 0.35 c̄ and no
 * asymmetries. α climbs slowly to ~22°, departs to ~72° within about five
 * seconds, then oscillates about ~60° (between ~50° and ~70°) for the rest of
 * the minute, with sideslip swings of up to ±20–27° and roll-rate swings of
 * ±30°/s that die away.
 */
export const TP1538_FIG44_DEEP_STALL = {
    altitudeM: 9144,
    peakAlphaDeg: 72,
    trimAlphaDeg: 60,
    trimAlphaBandDeg: 10,
};

/** Deep-stall recovery by pitch rocking at 0.375 c̄ (figures 53 and 54). */
export const TP1538_PITCH_ROCKING = {
    cgFraction: 0.375,
    wellPhasedRecoveryS: 8,
    poorlyPhasedCycles: 5,
    poorlyPhasedRecoveryS: 30,
};
