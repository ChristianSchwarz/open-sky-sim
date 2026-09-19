/**
 * F-16C sim profile and reference data.
 * Analytical aero: Rehman, "Aerodynamic Performance Analysis of F-16C Fighting Falcon".
 * Performance envelope: USAF fact sheet / Jane's.
 */
import { F16_PAPER_ANALYTICAL } from './f16PaperData';

export const F16_PROFILE = {
    /** MTOW for paper/envelope analysis (~42,000 lb). */
    combatMassKg: 19051,
    /** Typical takeoff gross weight for sim dynamics (~30,000 lb). */
    simMassKg: 13608,
    wingAreaM2: 27.87,
    wingSpanM: 9.45,
    cd0: F16_PAPER_ANALYTICAL.cd0,
    inducedDragK: F16_PAPER_ANALYTICAL.inducedDragK,
    cl0: F16_PAPER_ANALYTICAL.cl0,
    clAlphaPerRad: F16_PAPER_ANALYTICAL.clAlphaPerRad,
    abThrustKn: 129.4,
    milThrustKn: 76.3,
    /** Lever at 100% military power (98 on 0–100 quadrant). */
    milLeverEnd: 0.98,
    /** Lever at AB1 detent (99 on 0–100 quadrant). */
    abMinLeverEnd: 0.99,
    minFlyingSpeedMps: 68,
    stallAoaDeg: 22,
    serviceCeilingM: F16_PAPER_ANALYTICAL.serviceCeilingFt * 0.3048,
    cruiseAltitudeM: F16_PAPER_ANALYTICAL.cruiseAltitudeFt * 0.3048,
    cruiseSpeedMps: F16_PAPER_ANALYTICAL.cruiseVelocityFps * 0.3048,
    /** Cat I clean-ship FBW roll-rate cap (deg/s). */
    maxRollRateDegS: 300,
    /** Cat III heavy stores roll-rate cap (deg/s). */
    cat3MaxRollRateDegS: 180,
    /** FBW positive structural g limit (Cat I). */
    maxLoadFactorG: 9.5,
    /** Takeoff rotation speed (~70 kt). */
    rotationSpeedMps: 65,
    /** Max touchdown groundspeed with gear down. */
    landingMaxSpeedMps: 90,
    /** Max sink rate at touchdown (m/s). */
    landingMaxVerticalSpeedMps: 8,
    /** Max bank at touchdown (deg). */
    landingMaxRollDeg: 12,
    /** Minimum pitch at touchdown (deg, nose-down limit). */
    landingMinPitchDeg: -12,
} as const;

type F16ReferenceMetric =
    | 'massKg'
    | 'wingAreaM2'
    | 'wingSpanM'
    | 'abThrustKn'
    | 'maxMach'
    | 'maxSpeedKmh'
    | 'minFlyingSpeedKts'
    | 'peakMaxSpeedAltitudeM'
    | 'cd0'
    | 'inducedDragK'
    | 'clAlphaPerRad'
    | 'maxLiftToDrag'
    | 'cruiseSpeedMps';

export interface F16ReferenceCase {
    id: string;
    description: string;
    source: string;
    metric: F16ReferenceMetric;
    altitudeMeters: number;
    reference: number;
    tolerance: number;
    /** For L/D metric. */
    alphaDeg?: number;
}

export const F16_REFERENCE_CASES: F16ReferenceCase[] = [
    {
        id: 'cd0_paper',
        description: 'Zero-lift drag coefficient (Eq. 2)',
        source: 'Rehman paper analytical',
        metric: 'cd0',
        altitudeMeters: 0,
        reference: 0.018,
        tolerance: 0,
    },
    {
        id: 'induced_k_paper',
        description: 'Induced drag factor K (Eq. 3–5)',
        source: 'Rehman paper analytical',
        metric: 'inducedDragK',
        altitudeMeters: 0,
        reference: 0.1489,
        tolerance: 0.0001,
    },
    {
        id: 'cl_alpha_paper',
        description: 'Lift-curve slope',
        source: 'Rehman paper / NACA 64A204',
        metric: 'clAlphaPerRad',
        altitudeMeters: 0,
        reference: 5.73,
        tolerance: 0.01,
    },
    {
        id: 'ld_max_paper',
        description: 'Maximum lift-to-drag ratio at α ≈ 2°',
        source: 'Rehman Fig. 7',
        metric: 'maxLiftToDrag',
        altitudeMeters: 0,
        alphaDeg: 2,
        reference: 9.66,
        tolerance: 0.3,
    },
    {
        id: 'cruise_speed_paper',
        description: 'Cruise true airspeed at 30,000 ft',
        source: 'Rehman Section III (846 ft/s)',
        metric: 'cruiseSpeedMps',
        altitudeMeters: F16_PROFILE.cruiseAltitudeM,
        reference: F16_PROFILE.cruiseSpeedMps,
        tolerance: 0.5,
    },
    {
        id: 'wing_area',
        description: 'Wing reference area (300 ft²)',
        source: 'Jane\'s / Rehman paper',
        metric: 'wingAreaM2',
        altitudeMeters: 0,
        reference: 27.87,
        tolerance: 0.05,
    },
    {
        id: 'ab_thrust_sl',
        description: 'Full afterburner thrust at sea level',
        source: 'F100-PW-229 (129.4 kN)',
        metric: 'abThrustKn',
        altitudeMeters: 0,
        reference: 129.4,
        tolerance: 2.0,
    },
    {
        id: 'max_mach_fl400',
        description: 'Maximum Mach at 40,000 ft (AB, thrust–drag balance)',
        source: 'Sim envelope with Anderson polar + transonic drag',
        metric: 'maxMach',
        altitudeMeters: 12192,
        reference: 1.89,
        tolerance: 0.12,
    },
    {
        id: 'peak_speed_altitude',
        description: 'Altitude of peak level-flight max speed',
        source: 'Sim envelope (ISA thrust lapse)',
        metric: 'peakMaxSpeedAltitudeM',
        altitudeMeters: 0,
        reference: 11000,
        tolerance: 500,
    },
];

export const MPS_TO_KTS = 1.94384;
