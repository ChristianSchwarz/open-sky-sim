namespace Retro.Sim
{
    /// <summary>A control channel FM3's actuators drive; the value is its index (CHANNEL_INDEX).</summary>
    public enum Fm3Channel
    {
        /// <summary>All-moving horizontal tail, trailing edge down positive.</summary>
        StabL = 0,
        StabR = 1,
        /// <summary>Flaperons, trailing edge down positive.</summary>
        FlapL = 2,
        FlapR = 3,
        /// <summary>Rudder, trailing edge to starboard positive (a nose-right moment).</summary>
        Rudder = 4,
        /// <summary>Leading-edge flaps, leading edge down positive.</summary>
        Lef = 5,
        /// <summary>Speedbrake opening angle, 0 = closed.</summary>
        Speedbrake = 6,
    }

    public static class Fm3Channels
    {
        /// <summary>FM3_CHANNELS.length.</summary>
        public const int Count = 7;
    }

    public enum Fm3ControlKind
    {
        Flap,
        LeadingEdge,
        AllMoving,
    }

    public sealed class Fm3ControlSegment
    {
        public Fm3ControlKind Kind;
        /// <summary>Channel for the surface as defined (the starboard side of a mirrored one).</summary>
        public Fm3Channel Channel;
        /// <summary>Channel for the mirrored port copy; defaults to Channel.</summary>
        public Fm3Channel? MirrorChannel;
        /// <summary>Span range covered, as fractions from root (0) to tip (1).</summary>
        public double SpanFrom;
        public double SpanTo;
        /// <summary>Chord fraction of a hinged flap.</summary>
        public double? ChordFraction;
        /// <summary>Deflection of this segment per radian of channel angle (default 1).</summary>
        public double? Gain;
    }

    public enum Fm3SurfaceRole
    {
        /// <summary>Sheds the wake and downwash that tail surfaces fly in.</summary>
        Wing,
        Tail,
    }

    public enum Fm3StripSpacing
    {
        /// <summary>Bunches strips towards a free tip (default).</summary>
        Tip,
        /// <summary>For a panel whose tip joins another panel.</summary>
        Uniform,
    }

    public sealed class Fm3LiftingSurface
    {
        public string Name;
        public Fm3SurfaceRole Role;
        public double[] RootLE;
        public double RootChord;
        public double[] TipLE;
        public double TipChord;
        /// <summary>Incidence at root and tip, leading edge up (towards the surface normal) positive.</summary>
        public double? RootTwist;
        public double? TipTwist;
        /// <summary>Also build the port-side mirror image (y to -y).</summary>
        public bool Mirror;
        /// <summary>Strips per side, spaced closer towards root and tip.</summary>
        public int Strips;
        public SectionParams Section;
        public Fm3ControlSegment[] Controls;
        /// <summary>Fraction of the local dynamic pressure the surface feels (fuselage boundary layer, interference).</summary>
        public double? QFactor;
        /// <summary>
        /// The root sits against a body big enough to act as a reflection plane (a
        /// fin on a fuselage), so no vortex is shed there: the lifting line adds the
        /// surface's mirror image in the root plane.
        /// </summary>
        public bool RootEndplate;
        public Fm3StripSpacing Spacing;
        /// <summary>
        /// The sections' vortex lift is fed by the strake vortex on the same side,
        /// so it lasts exactly as long as that vortex is intact.
        /// </summary>
        public bool VortexFromStrakes;
    }

    /// <summary>A leading-edge extension / strake, flown by the Polhamus suction analogy.</summary>
    public sealed class Fm3Strake
    {
        public string Name;
        /// <summary>Apex of the starboard strake.</summary>
        public double[] Apex;
        /// <summary>Apex to trailing edge, along -x.</summary>
        public double RootChord;
        /// <summary>Exposed span at the trailing edge, outboard.</summary>
        public double Span;
        public bool Mirror;
        /// <summary>Polhamus potential-flow constant; defaults to slender-wing pi A / 2.</summary>
        public double? KPotential;
        /// <summary>Polhamus vortex-lift constant; defaults to pi (slender delta).</summary>
        public double? KVortex;
        /// <summary>Normal-force coefficient once the vortex has burst and the flow is fully separated.</summary>
        public double Cd90;
        /// <summary>Angle of attack at which vortex breakdown reaches the trailing edge, at the design sweep.</summary>
        public double BurstTrailingEdge;
        /// <summary>Angle of attack at which breakdown reaches the apex (no vortex lift left).</summary>
        public double BurstApex;
        /// <summary>Change of both breakdown angles per radian of effective sweep change in sideslip.</summary>
        public double BurstSweepSensitivity;
        /// <summary>Breakdown time constants, in root chords / airspeed (Goman-Khrabrov form).</summary>
        public double BurstTau1;
        public double BurstTau2;
        public double Cd0;
        /// <summary>
        /// Augmented vortex lift (Lamar): the strake vortex induces suction on the
        /// wing beneath it, beyond the strake's own vortex lift. Modelled as the same
        /// K_v sin^2 a normal force on this much wing area (m^2, per side), lost as the
        /// vortex bursts. 0 / absent for an isolated strake.
        /// </summary>
        public double? AugmentedArea;
        /// <summary>x of that wing area's centroid; it sits just outboard of the strake.</summary>
        public double? AugmentedX;
    }

    /// <summary>A slender body (fuselage, pod, tank) as a string of elliptical cross-sections.</summary>
    public sealed class Fm3Body
    {
        public string Name;
        /// <summary>Nose to tail: [x, z of the section centre, width, height].</summary>
        public double[][] Stations;
        /// <summary>Viscous crossflow drag coefficient of the cross-sections (Allen and Perkins).</summary>
        public double CrossflowCd;
        /// <summary>Scale on the slender-body potential normal force (default 1).</summary>
        public double? PotentialFactor;
    }

    public enum Fm3BluffDeploy
    {
        Gear,
        Speedbrake,
        Always,
    }

    public sealed class Fm3BluffBody
    {
        public string Name;
        public double[] Position;
        /// <summary>Drag area C_D A (m^2) fully deployed.</summary>
        public double CdA;
        /// <summary>What deploys it: landing gear, the speedbrake channel, or nothing (always there).</summary>
        public Fm3BluffDeploy Deploy;
    }

    /// <summary>An engine of the airframe (the TS interface Fm3Engine; renamed to free the name for the engine model).</summary>
    public sealed class Fm3EngineSpec
    {
        /// <summary>Thrust application point.</summary>
        public double[] Nozzle;
        /// <summary>Unit thrust direction.</summary>
        public double[] Axis;
        /// <summary>Rotor angular momentum along Axis (kg m^2/s).</summary>
        public double RotorMomentum;
        public double IdleThrustN;
        public double MilThrustN;
        /// <summary>Thrust at the first afterburner detent; 0 for no afterburner.</summary>
        public double AbMinThrustN;
        public double MaxThrustN;
    }

    public sealed class Fm3Actuator
    {
        public Fm3Channel Channel;
        public double Min;
        public double Max;
        /// <summary>Rate limit (rad/s).</summary>
        public double Rate;
        /// <summary>First-order lag (s).</summary>
        public double Tau;
    }

    public sealed class Fm3Reference
    {
        public double AreaM2;
        public double SpanM;
        public double ChordM;
        /// <summary>Point moments are quoted about (e.g. 0.35 c).</summary>
        public double[] MomentRef;
    }

    public sealed class Fm3Mass
    {
        public double MassKg;
        public double[] Cg;
        public InertiaNasa Inertia;
    }

    /// <summary>
    /// The description of an airframe FM3 can fly (port of physics/fm3/fm3Airframe.ts):
    /// geometry and physical parameters only. Nothing in here is a force coefficient
    /// of the whole aircraft; those are what the model computes from this.
    ///
    /// All positions are NASA body axes (x forward, y starboard, z down), in metres
    /// from a fixed datum, and all angles are radians. Keeping positions relative
    /// to a datum rather than to the centre of gravity means moving the CG changes
    /// the static margin by itself, as it does on a real aircraft.
    /// </summary>
    public sealed class Fm3Airframe
    {
        public string Name;
        public Fm3Reference Reference;
        public Fm3Mass Mass;
        public Fm3LiftingSurface[] Surfaces;
        public Fm3Strake[] Strakes;
        public Fm3Body[] Bodies;
        public Fm3BluffBody[] BluffBodies;
        public Fm3EngineSpec[] Engines;
        public Fm3Actuator[] Actuators;
        /// <summary>Parasite drag nothing else models (canopy, inlet, antennas, body skin friction), on wing area.</summary>
        public double MiscCd0;
        /// <summary>Extra drag against Mach [mach, C_D] on wing area: body wave drag and what the sections miss.</summary>
        public double[][] BodyWaveDrag;
        /// <summary>Wake (circulation) build-up time constant, in chords / airspeed.</summary>
        public double WakeTau;
    }
}
