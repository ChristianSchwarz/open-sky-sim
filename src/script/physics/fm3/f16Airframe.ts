/**
 * The default FM3 airframe: a General Dynamics F-16 as flown in NASA TP-1538.
 *
 * From TP-1538 Table I: weight 91,188 N, inertias (12,875 / 75,674 / 85,552 /
 * 1,331 kg·m²), the reference wing (27.87 m², 9.144 m span, 3.45 m mean chord,
 * reference CG at 0.35 c̄) and the surface deflection limits. The wing
 * planform follows from that reference wing with the F-16's 40° leading-edge
 * sweep and 0.227 taper, which puts the trailing edge square to the fuselage
 * as on the aircraft. Tail areas and the stabilator arm are the ones the
 * JSBSim F-16 carried (63.7 ft² at 16.46 ft, 54.75 ft² fin). Actuator rates,
 * lags and the leading-edge-flap schedule are Stevens & Lewis's.
 *
 * TP-1538's flow visualisation: "the outer wing panels stalled near α = 20°,
 * but the highly swept wing-body strake continued to produce lift at higher
 * angles of attack … Maximum C_L was obtained near α = 35°." So the wing is
 * two panels: an inboard one in the strake's vortex, carrying vortex lift
 * (suction analogy) for as long as that vortex is intact, and an outboard one
 * that stalls like an ordinary thin section. The stabilator and fin, both
 * thin and swept 40°+, keep building normal force past their stall the same
 * way.
 *
 * Fuselage stations, strake and ventral fin sizes are estimates from
 * published three-views. The section and component parameters in
 * {@link F16_AERO_PARAMS} are the physical knobs fitted against TP-1538's
 * figures 9 and 10 with tools/fm3/calibrate.ts.
 *
 * NASA body axes (x forward, y starboard, z down), metres, datum at the
 * reference centre of gravity.
 */
import { F16_ENGINE } from '../f16Engine';
import { DEG, Vec3 } from './frames';
import { Fm3Airframe } from './fm3Airframe';
import { SectionParams } from './sectionAero';

/** The fitted physical parameters (angles in radians). */
export interface F16AeroParams {
    innerAlphaSep: number;
    innerVortexLift: number;
    innerVortexCp: number;
    outerAlphaSep: number;
    outerPlateShape: number;
    stabAlphaSep: number;
    stabSepWidth: number;
    stabPlateShape: number;
    stabVortexLift: number;
    stabBurstStart: number;
    stabBurstEnd: number;
    stabQFactor: number;
    strakeSpan: number;
    strakeBurstTE: number;
    strakeBurstApex: number;
    /** Wing area under the strake vortex (m² per side) and its centroid x. */
    strakeAugArea: number;
    strakeAugX: number;
    bodyCrossflowCd: number;
}

/**
 * Fitted 2026-09-16 by tools/fm3/calibrate.ts, with the leading-edge flaps on
 * their schedule, against TP-1538 figures 9 and 10, the reference roll damping
 * at 15–30° and stable pitch damping through the deep stall: pitching-moment
 * RMS error 0.034 over α 0–90° at δh = 0, ±25° (about the accuracy of reading
 * the figures), lift RMS error 0.087 over α 0–40°, Clp RMS error 0.046, and
 * forced-oscillation Cmq + Cmα̇ no higher than −0.5 at 60–80°.
 *
 * Several land on the edge of their physical range, which is itself a
 * finding: the inboard panel stays attached to 28° and recovers 1.5× its
 * lost leading-edge suction (the strake vortex augmenting it), and the strake
 * vortex bursts gradually all the way to 88°. The outboard panel keeps its
 * flow to 25° (plus the flaps' share), which is what holds roll damping to
 * the AoA limit; weighting lift over roll damping instead lands near 18° and
 * a Clp that collapses at 25°.
 */
export const F16_AERO_PARAMS: F16AeroParams = {
    innerAlphaSep: 28.0 * DEG,
    innerVortexLift: 1.5,
    innerVortexCp: 0.461,
    outerAlphaSep: 25.0 * DEG,
    outerPlateShape: 0.297,
    stabAlphaSep: 18.0 * DEG,
    stabSepWidth: 8.0 * DEG,
    stabPlateShape: 0.431,
    stabVortexLift: 0.023,
    stabBurstStart: 37.7 * DEG,
    stabBurstEnd: 90.0 * DEG,
    stabQFactor: 0.919,
    strakeSpan: 0.696,
    strakeBurstTE: 53.0 * DEG,
    strakeBurstApex: 88.0 * DEG,
    strakeAugArea: 1.469,
    strakeAugX: 1.318,
    bodyCrossflowCd: 1.130,
};

// Reference trapezoid: root chord 4.968 m at the centreline, tip 1.128 m at
// 4.572 m, leading edge swept 40°. The panels split at 40% semi-span.
const WING_ROOT_LE: Vec3 = [2.723, 0, 0.05];
const WING_TIP_LE: Vec3 = [-1.113, 4.572, 0.05];
const WING_SPLIT = 0.4;
const WING_ROOT_CHORD = 4.968;
const WING_TIP_CHORD = 1.128;
const WING_SPLIT_LE: Vec3 = [
    WING_ROOT_LE[0] + WING_SPLIT * (WING_TIP_LE[0] - WING_ROOT_LE[0]),
    WING_SPLIT * WING_TIP_LE[1],
    0.05,
];
const WING_SPLIT_CHORD = WING_ROOT_CHORD + WING_SPLIT * (WING_TIP_CHORD - WING_ROOT_CHORD);

/** Flaperon and leading-edge flap spans, in metres from the centreline. */
const FLAPERON_Y: [number, number] = [0.8, 3.2];
const LEF_Y: [number, number] = [0.8, 4.572];
const toInner = (y: number) => Math.min(1, Math.max(0, y / WING_SPLIT_LE[1]));
const toOuter = (y: number) => Math.min(1, Math.max(0, (y - WING_SPLIT_LE[1]) / (WING_TIP_LE[1] - WING_SPLIT_LE[1])));

export function buildF16Airframe(p: F16AeroParams = F16_AERO_PARAMS): Fm3Airframe {
    /** NACA 64A204, the F-16 wing section, outboard of the strake's influence. */
    const outerWing: SectionParams = {
        cnAlpha: 6.0,
        alpha0: -1.3 * DEG,
        alphaSep: p.outerAlphaSep,
        sepWidth: 3 * DEG,
        cd0: 0.006,
        suctionEta: 0.9,
        cd90: 1.25,
        cm0: -0.02,
        reverseSlopeFactor: 0.6,
        reverseAlphaSep: 6 * DEG,
        tau1: 3,
        tau2: 1.5,
        thickness: 0.04,
        plateShape: p.outerPlateShape,
    };
    /**
     * The same section inboard, where the strake vortex sits over it. Its
     * vortex lift is fed by that vortex, so it bursts with the strake's (the
     * surface's `vortexFromStrakes`), not on an angle of its own.
     */
    const innerWing: SectionParams = {
        ...outerWing,
        alphaSep: p.innerAlphaSep,
        vortexLift: p.innerVortexLift,
        vortexCp: p.innerVortexCp,
        vortexBurstStart: 85 * DEG,
        vortexBurstEnd: 90 * DEG,
    };
    /** Thin, 40°-swept, low-aspect-ratio all-moving stabilator. */
    const stab: SectionParams = {
        cnAlpha: 5.8,
        alpha0: 0,
        alphaSep: p.stabAlphaSep,
        sepWidth: p.stabSepWidth,
        cd0: 0.007,
        suctionEta: 0.85,
        cd90: 1.2,
        cm0: 0,
        reverseSlopeFactor: 0.6,
        reverseAlphaSep: 6 * DEG,
        tau1: 3,
        tau2: 1.5,
        thickness: 0.05,
        plateShape: p.stabPlateShape,
        vortexLift: p.stabVortexLift,
        vortexCp: 0.35,
        vortexBurstStart: p.stabBurstStart,
        vortexBurstEnd: p.stabBurstEnd,
    };
    /** Fin and ventral fins: thin, swept 47.5°, on the fuselage. */
    const fin: SectionParams = {
        cnAlpha: 5.8,
        alpha0: 0,
        alphaSep: 24 * DEG,
        sepWidth: 4 * DEG,
        cd0: 0.007,
        suctionEta: 0.85,
        cd90: 1.2,
        cm0: 0,
        reverseSlopeFactor: 0.6,
        reverseAlphaSep: 6 * DEG,
        tau1: 3,
        tau2: 1.5,
        thickness: 0.05,
        plateShape: 0.45,
    };

    return {
        name: 'F-16 (NASA TP-1538)',
        reference: { areaM2: 27.87, spanM: 9.144, chordM: 3.45, momentRef: [0, 0, 0] },
        mass: {
            massKg: 91188 / 9.80665,
            cg: [0, 0, 0],
            inertia: { ixx: 12875, iyy: 75674, izz: 85552, ixz: 1331 },
        },
        surfaces: [
            {
                name: 'inner wing',
                role: 'wing',
                rootLE: WING_ROOT_LE,
                rootChord: WING_ROOT_CHORD,
                tipLE: WING_SPLIT_LE,
                tipChord: WING_SPLIT_CHORD,
                mirror: true,
                strips: 4,
                spacing: 'uniform',
                vortexFromStrakes: true,
                section: innerWing,
                controls: [
                    { kind: 'flap', channel: 'flapR', mirrorChannel: 'flapL', spanFrom: toInner(FLAPERON_Y[0]), spanTo: 1, chordFraction: 0.25 },
                    { kind: 'leadingEdge', channel: 'lef', spanFrom: toInner(LEF_Y[0]), spanTo: 1 },
                ],
            },
            {
                name: 'outer wing',
                role: 'wing',
                rootLE: WING_SPLIT_LE,
                rootChord: WING_SPLIT_CHORD,
                tipLE: WING_TIP_LE,
                tipChord: WING_TIP_CHORD,
                mirror: true,
                strips: 6,
                section: outerWing,
                controls: [
                    { kind: 'flap', channel: 'flapR', mirrorChannel: 'flapL', spanFrom: 0, spanTo: toOuter(FLAPERON_Y[1]), chordFraction: 0.25 },
                    { kind: 'leadingEdge', channel: 'lef', spanFrom: 0, spanTo: toOuter(LEF_Y[1]) },
                ],
            },
            {
                name: 'stabilator',
                role: 'tail',
                rootLE: [-3.93, 1.0, 0.25],
                rootChord: 2.25,
                tipLE: [-5.43, 2.79, 0.566],
                tipChord: 1.05,
                mirror: true,
                strips: 5,
                section: stab,
                // Mounted clear of the fuselage side, so no endplate; the root runs
                // in the aft body's boundary layer.
                qFactor: p.stabQFactor,
                controls: [
                    { kind: 'allMoving', channel: 'stabR', mirrorChannel: 'stabL', spanFrom: 0, spanTo: 1 },
                ],
            },
            {
                name: 'fin',
                role: 'tail',
                rootLE: [-3.17, 0, -0.75],
                rootChord: 3.35,
                tipLE: [-5.57, 0, -2.95],
                tipChord: 1.22,
                mirror: false,
                strips: 6,
                section: fin,
                qFactor: 0.95,
                rootEndplate: true,
                controls: [
                    { kind: 'flap', channel: 'rudder', spanFrom: 0.05, spanTo: 0.85, chordFraction: 0.3 },
                ],
            },
            {
                name: 'ventral fins',
                role: 'tail',
                rootLE: [-3.0, 0.55, 0.70],
                rootChord: 1.2,
                tipLE: [-3.35, 0.72, 1.35],
                tipChord: 0.7,
                mirror: true,
                strips: 2,
                section: fin,
                qFactor: 0.9,
                rootEndplate: true,
            },
        ],
        strakes: [
            {
                name: 'strakes',
                apex: [5.0, 0.62, 0.05],
                rootChord: 2.9,
                span: p.strakeSpan,
                mirror: true,
                cd90: 1.2,
                burstTrailingEdge: p.strakeBurstTE,
                burstApex: p.strakeBurstApex,
                // Breakdown angle per radian of effective sweep change. Delta-wing
                // data put it near 1 for slender deltas; the F-16's strake, feeding
                // a wing, is less sensitive, and TP-1538's deep-stall lateral
                // oscillations are moderate and decay.
                burstSweepSensitivity: 0.5,
                // Breakdown follows α within a couple of strake chords of travel. A
                // longer lag holds the vortex, and its nose-up lift, while α rises and
                // keeps it burst while α falls: at 8 chords a forced pitch oscillation
                // (tools/fm3/windTunnel.ts) went unstable past 60°, at odds with
                // TP-1538's weak but stable deep-stall trim.
                burstTau1: 2,
                burstTau2: 0.5,
                cd0: 0.004,
                augmentedArea: p.strakeAugArea,
                augmentedX: p.strakeAugX,
            },
        ],
        bodies: [
            {
                name: 'fuselage',
                stations: [
                    [6.70, 0.00, 0.00, 0.00],
                    [6.20, 0.00, 0.45, 0.45],
                    [5.40, -0.05, 0.80, 0.85],
                    [4.60, -0.15, 0.95, 1.20],
                    [3.60, -0.20, 1.10, 1.40],
                    [2.60, -0.05, 1.45, 1.45],
                    [1.50, 0.00, 1.55, 1.40],
                    [0.00, 0.00, 1.55, 1.30],
                    [-1.50, -0.05, 1.50, 1.20],
                    [-3.00, -0.05, 1.40, 1.10],
                    [-4.50, -0.05, 1.25, 1.05],
                    [-6.00, 0.00, 1.05, 1.00],
                    [-7.20, 0.00, 0.95, 0.95],
                ],
                crossflowCd: p.bodyCrossflowCd,
            },
        ],
        bluffBodies: [
            // JSBSim's F-16 gear drag, ΔC_D 0.027 on wing area, split over the legs.
            { name: 'nose gear', position: [2.6, 0, 1.3], cdA: 0.17, deploy: 'gear' },
            { name: 'left main gear', position: [-0.6, -1.2, 1.3], cdA: 0.29, deploy: 'gear' },
            { name: 'right main gear', position: [-0.6, 1.2, 1.3], cdA: 0.29, deploy: 'gear' },
            { name: 'speedbrake', position: [-6.8, 0, 0], cdA: 1.6, deploy: 'speedbrake' },
        ],
        engines: [
            {
                nozzle: [-7.2, 0, 0],
                axis: [1, 0, 0],
                // TP-1538 appendix B: 216.9 kg·m²/s (160 slug·ft²/s).
                rotorMomentum: 216.9,
                idleThrustN: F16_ENGINE.idleThrustKn * 1000,
                milThrustN: F16_ENGINE.milThrustKn * 1000,
                abMinThrustN: F16_ENGINE.abMinThrustKn * 1000,
                maxThrustN: F16_ENGINE.abMaxThrustKn * 1000,
            },
        ],
        actuators: [
            { channel: 'stabL', min: -25 * DEG, max: 25 * DEG, rate: 60 * DEG, tau: 1 / 20.2 },
            { channel: 'stabR', min: -25 * DEG, max: 25 * DEG, rate: 60 * DEG, tau: 1 / 20.2 },
            { channel: 'flapL', min: -21.5 * DEG, max: 21.5 * DEG, rate: 80 * DEG, tau: 1 / 20.2 },
            { channel: 'flapR', min: -21.5 * DEG, max: 21.5 * DEG, rate: 80 * DEG, tau: 1 / 20.2 },
            { channel: 'rudder', min: -30 * DEG, max: 30 * DEG, rate: 120 * DEG, tau: 1 / 20.2 },
            { channel: 'lef', min: 0, max: 25 * DEG, rate: 25 * DEG, tau: 1 / 7.25 },
            { channel: 'speedbrake', min: 0, max: 60 * DEG, rate: 30 * DEG, tau: 0.1 },
        ],
        miscCd0: 0.009,
        // JSBSim F-16 CDmach.
        bodyWaveDrag: [[0, 0], [0.81, 0], [1.1, 0.023], [1.8, 0.015]],
        wakeTau: 1.0,
    };
}

export const F16_AIRFRAME: Fm3Airframe = buildF16Airframe();
