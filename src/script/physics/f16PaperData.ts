/**
 * F-16C aerodynamic data from:
 * Rehman, "Aerodynamic Performance Analysis of F-16C Fighting Falcon" (NUST).
 * Chart references computed with Anderson ISA + paper Eq. (2–5), k₂ = 0.
 */

export const F16_PAPER_ANALYTICAL = {
    /** Eq. (2): CD0 = Cfe * Swet / Sref */
    cd0: 0.018,
    /** Eq. (3–5): CDi = K * CL² */
    inducedDragK: 0.1489,
    cl0: 0.2,
    /** NACA 64A204, per radian */
    clAlphaPerRad: 5.73,
    /** Fig. 7 peak */
    maxLiftToDrag: 9.66,
    maxLiftToDragAlphaDeg: 2,
    /** Fig. 9 */
    minGlideAngleDeg: 5.91,
    /** Section III assumptions — cruise at MTOW */
    cruiseVelocityFps: 846,
    cruiseAltitudeFt: 30000,
    /** Jane's / literature service ceiling */
    serviceCeilingFt: 50000,
    wingAreaFt2: 300,
    mtowLb: 42000,
} as const;

/** OpenVSP / VSPAero results cited in Section IV.B. */
export const F16_PAPER_VSPAERO = {
    cd0: 0.0124,
    clAlphaPerRad: 3.62,
    /** Derived from L/D max = 14 at α ≈ 4° with CL₀ = 0.2. */
    inducedDragK: 0.0973,
    maxLiftToDrag: 14,
    maxLiftToDragAlphaDeg: 4,
} as const;

type F16PaperMetric =
    | 'liftToDrag'
    | 'minGlideAngleDeg'
    | 'thrustRequiredLb'
    | 'totalDragLb'
    | 'minTotalDragLb'
    | 'cruiseSpeedFps'
    | 'cd0'
    | 'clAlphaPerRad'
    | 'vMinDragFps';

export interface F16PaperChartCase {
    id: string;
    figure: string;
    description: string;
    metric: F16PaperMetric;
    /** Angle of attack for L/D cases (degrees). */
    alphaDeg?: number;
    altitudeFt: number;
    weightLb: number;
    velocityFps: number;
    reference: number;
    tolerance: number;
}

/**
 * Chart checkpoints from Figs. 7, 9, 10–12, 16–17.
 * Drag/thrust references: ISA + paper polar at stated V, h, W (MATLAB methodology).
 */
export const F16_PAPER_CHART_CASES: F16PaperChartCase[] = [
    {
        id: 'fig7_ld_max',
        figure: 'Fig. 7',
        description: 'Maximum lift-to-drag ratio',
        metric: 'liftToDrag',
        alphaDeg: 2,
        altitudeFt: 0,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 0,
        reference: 9.66,
        tolerance: 0.15,
    },
    {
        id: 'fig9_min_glide',
        figure: 'Fig. 9',
        description: 'Minimum glide angle',
        metric: 'minGlideAngleDeg',
        altitudeFt: 30000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 0,
        reference: 5.91,
        tolerance: 0.1,
    },
    {
        id: 'fig10_min_drag_20k',
        figure: 'Fig. 10',
        description: 'Minimum total drag at 20,000 ft (MTOW)',
        metric: 'minTotalDragLb',
        altitudeFt: 20000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 797,
        reference: 4348.74,
        tolerance: 50,
    },
    {
        id: 'fig10_drag_750fps',
        figure: 'Fig. 10',
        description: 'Total drag at 750 ft/s, 20,000 ft (MTOW)',
        metric: 'totalDragLb',
        altitudeFt: 20000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 750,
        reference: 4381.50,
        tolerance: 50,
    },
    {
        id: 'fig11_min_drag_30k',
        figure: 'Fig. 11',
        description: 'Minimum total drag at 30,000 ft (MTOW)',
        metric: 'minTotalDragLb',
        altitudeFt: 30000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 952,
        reference: 4348.74,
        tolerance: 50,
    },
    {
        id: 'fig11_drag_900fps',
        figure: 'Fig. 11',
        description: 'Total drag at 900 ft/s, 30,000 ft (MTOW)',
        metric: 'totalDragLb',
        altitudeFt: 30000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 900,
        reference: 4375.84,
        tolerance: 50,
    },
    {
        id: 'fig12_min_drag_40k',
        figure: 'Fig. 12',
        description: 'Minimum total drag at 40,000 ft (MTOW)',
        metric: 'minTotalDragLb',
        altitudeFt: 40000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 1173,
        reference: 4348.73,
        tolerance: 50,
    },
    {
        id: 'fig12_drag_1000fps',
        figure: 'Fig. 12',
        description: 'Total drag at 1,000 ft/s, 40,000 ft (MTOW)',
        metric: 'totalDragLb',
        altitudeFt: 40000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 1000,
        reference: 4572.53,
        tolerance: 50,
    },
    {
        id: 'fig16_tr_min_35klb',
        figure: 'Fig. 16',
        description: 'Minimum thrust required at 35,000 lb (30,000 ft)',
        metric: 'thrustRequiredLb',
        altitudeFt: 30000,
        weightLb: 35000,
        velocityFps: 870,
        reference: 3623.96,
        tolerance: 50,
    },
    {
        id: 'fig16_tr_35klb_900fps',
        figure: 'Fig. 16',
        description: 'Thrust required at 35,000 lb, 900 ft/s (30,000 ft)',
        metric: 'thrustRequiredLb',
        altitudeFt: 30000,
        weightLb: 35000,
        velocityFps: 900,
        reference: 3633.01,
        tolerance: 50,
    },
    {
        id: 'fig16_tr_35klb_1000fps',
        figure: 'Fig. 16',
        description: 'Thrust required at 35,000 lb, 1,000 ft/s (30,000 ft)',
        metric: 'thrustRequiredLb',
        altitudeFt: 30000,
        weightLb: 35000,
        velocityFps: 1000,
        reference: 3768.43,
        tolerance: 50,
    },
    {
        id: 'fig17_tr_min_20k',
        figure: 'Fig. 17',
        description: 'Minimum thrust required at 20,000 ft (MTOW)',
        metric: 'thrustRequiredLb',
        altitudeFt: 20000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 797,
        reference: 4348.74,
        tolerance: 50,
    },
    {
        id: 'fig17_tr_min_30k',
        figure: 'Fig. 17',
        description: 'Thrust required at 1,000 ft/s, 30,000 ft (MTOW)',
        metric: 'thrustRequiredLb',
        altitudeFt: 30000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 1000,
        reference: 4370.12,
        tolerance: 50,
    },
    {
        id: 'fig17_tr_1150fps_40k',
        figure: 'Fig. 17',
        description: 'Thrust required at 1,150 ft/s, 40,000 ft (MTOW)',
        metric: 'thrustRequiredLb',
        altitudeFt: 40000,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 1150,
        reference: 4352.20,
        tolerance: 50,
    },
    {
        id: 'assumption_cruise_speed',
        figure: 'Section III',
        description: 'Cruise velocity at 30,000 ft (MTOW)',
        metric: 'cruiseSpeedFps',
        altitudeFt: F16_PAPER_ANALYTICAL.cruiseAltitudeFt,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: F16_PAPER_ANALYTICAL.cruiseVelocityFps,
        reference: 846,
        tolerance: 0.5,
    },
];

/** VSPAero chart checkpoints (Figs. 18–20). */
export const F16_PAPER_VSPAERO_CASES: F16PaperChartCase[] = [
    {
        id: 'fig20_ld_max_vspaero',
        figure: 'Fig. 20',
        description: 'VSPAero maximum L/D',
        metric: 'liftToDrag',
        alphaDeg: 4,
        altitudeFt: 0,
        weightLb: F16_PAPER_ANALYTICAL.mtowLb,
        velocityFps: 0,
        reference: 14,
        tolerance: 0.15,
    },
];

export const FT_TO_M = 0.3048;
export const FPS_TO_MPS = FT_TO_M;
export const LB_TO_N = 4.4482216153;
export const LB_TO_KG = 0.45359237;
