/**
 * The description of an airframe FM3 can fly: geometry and physical
 * parameters only. Nothing in here is a force coefficient of the whole
 * aircraft — those are what the model computes from this.
 *
 * All positions are NASA body axes (x forward, y starboard, z down), in metres
 * from a fixed datum, and all angles are radians. Keeping positions relative
 * to a datum rather than to the centre of gravity means moving the CG changes
 * the static margin by itself, as it does on a real aircraft.
 */
import { InertiaNasa, Vec3 } from './frames';
import { SectionParams } from './sectionAero';

/** A control channel FM3's actuators drive. */
export type Fm3Channel =
    /** All-moving horizontal tail, trailing edge down positive. */
    | 'stabL' | 'stabR'
    /** Flaperons, trailing edge down positive. */
    | 'flapL' | 'flapR'
    /** Rudder, trailing edge to starboard positive (a nose-right moment). */
    | 'rudder'
    /** Leading-edge flaps, leading edge down positive. */
    | 'lef'
    /** Speedbrake opening angle, 0 = closed. */
    | 'speedbrake';

export const FM3_CHANNELS: readonly Fm3Channel[] = ['stabL', 'stabR', 'flapL', 'flapR', 'rudder', 'lef', 'speedbrake'];

export const CHANNEL_INDEX: Readonly<Record<Fm3Channel, number>> = {
    stabL: 0, stabR: 1, flapL: 2, flapR: 3, rudder: 4, lef: 5, speedbrake: 6,
};

export interface Fm3ControlSegment {
    kind: 'flap' | 'leadingEdge' | 'allMoving';
    /** Channel for the surface as defined (the starboard side of a mirrored one). */
    channel: Fm3Channel;
    /** Channel for the mirrored port copy; defaults to `channel`. */
    mirrorChannel?: Fm3Channel;
    /** Span range covered, as fractions from root (0) to tip (1). */
    spanFrom: number;
    spanTo: number;
    /** Chord fraction of a hinged flap. */
    chordFraction?: number;
    /** Deflection of this segment per radian of channel angle (default 1). */
    gain?: number;
}

export interface Fm3LiftingSurface {
    name: string;
    /** A 'wing' sheds the wake and downwash that 'tail' surfaces fly in. */
    role: 'wing' | 'tail';
    rootLE: Vec3;
    rootChord: number;
    tipLE: Vec3;
    tipChord: number;
    /** Incidence at root and tip, leading edge up (towards the surface normal) positive. */
    rootTwist?: number;
    tipTwist?: number;
    /** Also build the port-side mirror image (y → −y). */
    mirror: boolean;
    /** Strips per side, spaced closer towards root and tip. */
    strips: number;
    section: SectionParams;
    controls?: Fm3ControlSegment[];
    /** Fraction of the local dynamic pressure the surface feels (fuselage boundary layer, interference). */
    qFactor?: number;
    /**
     * The root sits against a body big enough to act as a reflection plane (a
     * fin on a fuselage), so no vortex is shed there: the lifting line adds the
     * surface's mirror image in the root plane.
     */
    rootEndplate?: boolean;
    /**
     * Strip spacing: 'tip' (default) bunches strips towards a free tip;
     * 'uniform' for a panel whose tip joins another panel.
     */
    spacing?: 'tip' | 'uniform';
    /**
     * The sections' vortex lift is fed by the strake vortex on the same side,
     * so it lasts exactly as long as that vortex is intact.
     */
    vortexFromStrakes?: boolean;
}

/** A leading-edge extension / strake, flown by the Polhamus suction analogy. */
export interface Fm3Strake {
    name: string;
    /** Apex of the starboard strake. */
    apex: Vec3;
    /** Apex to trailing edge, along −x. */
    rootChord: number;
    /** Exposed span at the trailing edge, outboard. */
    span: number;
    mirror: boolean;
    /** Polhamus potential-flow constant; defaults to slender-wing πA/2. */
    kPotential?: number;
    /** Polhamus vortex-lift constant; defaults to π (slender delta). */
    kVortex?: number;
    /** Normal-force coefficient once the vortex has burst and the flow is fully separated. */
    cd90: number;
    /** Angle of attack at which vortex breakdown reaches the trailing edge, at the design sweep. */
    burstTrailingEdge: number;
    /** Angle of attack at which breakdown reaches the apex (no vortex lift left). */
    burstApex: number;
    /** Change of both breakdown angles per radian of effective sweep change in sideslip. */
    burstSweepSensitivity: number;
    /** Breakdown time constants, in root chords / airspeed (Goman–Khrabrov form). */
    burstTau1: number;
    burstTau2: number;
    cd0: number;
    /**
     * Augmented vortex lift (Lamar): the strake vortex induces suction on the
     * wing beneath it, beyond the strake's own vortex lift. Modelled as the same
     * K_v·sin²α normal force on this much wing area (m², per side), lost as the
     * vortex bursts. 0 / absent for an isolated strake.
     */
    augmentedArea?: number;
    /** x of that wing area's centroid; it sits just outboard of the strake. */
    augmentedX?: number;
}

/** A slender body — fuselage, pod, tank — as a string of elliptical cross-sections. */
export interface Fm3Body {
    name: string;
    /** Nose to tail: [x, z of the section centre, width, height]. */
    stations: [number, number, number, number][];
    /** Viscous crossflow drag coefficient of the cross-sections (Allen & Perkins). */
    crossflowCd: number;
    /** Scale on the slender-body potential normal force (default 1). */
    potentialFactor?: number;
}

export interface Fm3BluffBody {
    name: string;
    position: Vec3;
    /** Drag area C_D·A (m²) fully deployed. */
    cdA: number;
    /** What deploys it: landing gear, the speedbrake channel, or nothing (always there). */
    deploy: 'gear' | 'speedbrake' | 'always';
}

export interface Fm3Engine {
    /** Thrust application point. */
    nozzle: Vec3;
    /** Unit thrust direction. */
    axis: Vec3;
    /** Rotor angular momentum along `axis` (kg·m²/s). */
    rotorMomentum: number;
    idleThrustN: number;
    milThrustN: number;
    /** Thrust at the first afterburner detent; 0 for no afterburner. */
    abMinThrustN: number;
    maxThrustN: number;
}

export interface Fm3Actuator {
    channel: Fm3Channel;
    min: number;
    max: number;
    /** Rate limit (rad/s). */
    rate: number;
    /** First-order lag (s). */
    tau: number;
}

export interface Fm3Airframe {
    name: string;
    reference: {
        areaM2: number;
        spanM: number;
        chordM: number;
        /** Point moments are quoted about (e.g. 0.35 c̄). */
        momentRef: Vec3;
    };
    mass: { massKg: number; cg: Vec3; inertia: InertiaNasa };
    surfaces: Fm3LiftingSurface[];
    strakes: Fm3Strake[];
    bodies: Fm3Body[];
    bluffBodies: Fm3BluffBody[];
    engines: Fm3Engine[];
    actuators: Fm3Actuator[];
    /** Parasite drag nothing else models (canopy, inlet, antennas, body skin friction), on wing area. */
    miscCd0: number;
    /** Extra drag against Mach [mach, C_D] on wing area: body wave drag and what the sections miss. */
    bodyWaveDrag: [number, number][];
    /** Wake (circulation) build-up time constant, in chords / airspeed. */
    wakeTau: number;
}
