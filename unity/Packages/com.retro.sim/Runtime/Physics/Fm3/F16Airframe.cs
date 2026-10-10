using System;

namespace Retro.Sim
{
    /// <summary>The fitted physical parameters of the F-16 airframe (angles in radians).</summary>
    public sealed class F16AeroParams
    {
        public double InnerAlphaSep;
        public double InnerVortexLift;
        public double InnerVortexCp;
        public double OuterAlphaSep;
        public double OuterPlateShape;
        public double StabAlphaSep;
        public double StabSepWidth;
        public double StabPlateShape;
        public double StabVortexLift;
        public double StabBurstStart;
        public double StabBurstEnd;
        public double StabQFactor;
        public double StrakeSpan;
        public double StrakeBurstTE;
        public double StrakeBurstApex;
        /// <summary>Wing area under the strake vortex (m^2 per side) and its centroid x.</summary>
        public double StrakeAugArea;
        public double StrakeAugX;
        public double BodyCrossflowCd;
    }

    /// <summary>
    /// The default FM3 airframe: a General Dynamics F-16 as flown in NASA TP-1538
    /// (port of physics/fm3/f16Airframe.ts).
    ///
    /// From TP-1538 Table I: weight 91,188 N, inertias (12,875 / 75,674 / 85,552 /
    /// 1,331 kg m^2), the reference wing (27.87 m^2, 9.144 m span, 3.45 m mean chord,
    /// reference CG at 0.35 c) and the surface deflection limits. The wing planform
    /// follows from that reference wing with the F-16's 40 degree leading-edge sweep
    /// and 0.227 taper. Tail areas and the stabilator arm are the ones the JSBSim
    /// F-16 carried. Actuator rates, lags and the leading-edge-flap schedule are
    /// Stevens and Lewis's.
    ///
    /// TP-1538's flow visualisation: the outer wing panels stall near 20 degrees,
    /// but the highly swept strake keeps producing lift at higher angles of attack,
    /// maximum C_L near 35 degrees. So the wing is two panels: an inboard one in the
    /// strake's vortex, carrying vortex lift for as long as that vortex is intact,
    /// and an outboard one that stalls like an ordinary thin section.
    ///
    /// NASA body axes (x forward, y starboard, z down), metres, datum at the
    /// reference centre of gravity.
    /// </summary>
    public static class F16Airframe
    {
        private const double Deg = Fm3Frames.Deg;

        /// <summary>
        /// Fitted 2026-09-16 by tools/fm3/calibrate.ts, with the leading-edge flaps on
        /// their schedule, against TP-1538 figures 9 and 10, the reference roll damping
        /// at 15-30 degrees and stable pitch damping through the deep stall.
        /// </summary>
        public static readonly F16AeroParams AeroParams = new F16AeroParams
        {
            InnerAlphaSep = 28.0 * Deg,
            InnerVortexLift = 1.5,
            InnerVortexCp = 0.461,
            OuterAlphaSep = 25.0 * Deg,
            OuterPlateShape = 0.297,
            StabAlphaSep = 18.0 * Deg,
            StabSepWidth = 8.0 * Deg,
            StabPlateShape = 0.431,
            StabVortexLift = 0.023,
            StabBurstStart = 37.7 * Deg,
            StabBurstEnd = 90.0 * Deg,
            StabQFactor = 0.919,
            StrakeSpan = 0.696,
            StrakeBurstTE = 53.0 * Deg,
            StrakeBurstApex = 88.0 * Deg,
            StrakeAugArea = 1.469,
            StrakeAugX = 1.318,
            BodyCrossflowCd = 1.130,
        };

        // Reference trapezoid: root chord 4.968 m at the centreline, tip 1.128 m at
        // 4.572 m, leading edge swept 40 degrees. The panels split at 40% semi-span.
        private static readonly double[] WingRootLE = { 2.723, 0, 0.05 };
        private static readonly double[] WingTipLE = { -1.113, 4.572, 0.05 };
        private const double WingSplit = 0.4;
        private const double WingRootChord = 4.968;
        private const double WingTipChord = 1.128;
        private static readonly double[] WingSplitLE =
        {
            WingRootLE[0] + WingSplit * (WingTipLE[0] - WingRootLE[0]),
            WingSplit * WingTipLE[1],
            0.05,
        };
        private const double WingSplitChord = WingRootChord + WingSplit * (WingTipChord - WingRootChord);

        /// <summary>Flaperon and leading-edge flap spans, in metres from the centreline.</summary>
        private static readonly double[] FlaperonY = { 0.8, 3.2 };
        private static readonly double[] LefY = { 0.8, 4.572 };

        private static double ToInner(double y) => Math.Min(1, Math.Max(0, y / WingSplitLE[1]));
        private static double ToOuter(double y) => Math.Min(1, Math.Max(0, (y - WingSplitLE[1]) / (WingTipLE[1] - WingSplitLE[1])));

        public static Fm3Airframe Build(F16AeroParams p = null)
        {
            p = p ?? AeroParams;
            // NACA 64A204, the F-16 wing section, outboard of the strake's influence.
            var outerWing = new SectionParams
            {
                CnAlpha = 6.0,
                Alpha0 = -1.3 * Deg,
                AlphaSep = p.OuterAlphaSep,
                SepWidth = 3 * Deg,
                Cd0 = 0.006,
                SuctionEta = 0.9,
                Cd90 = 1.25,
                Cm0 = -0.02,
                ReverseSlopeFactor = 0.6,
                ReverseAlphaSep = 6 * Deg,
                Tau1 = 3,
                Tau2 = 1.5,
                Thickness = 0.04,
                PlateShape = p.OuterPlateShape,
            };
            // The same section inboard, where the strake vortex sits over it. Its
            // vortex lift is fed by that vortex, so it bursts with the strake's (the
            // surface's VortexFromStrakes), not on an angle of its own.
            SectionParams innerWing = outerWing.Clone();
            innerWing.AlphaSep = p.InnerAlphaSep;
            innerWing.VortexLift = p.InnerVortexLift;
            innerWing.VortexCp = p.InnerVortexCp;
            innerWing.VortexBurstStart = 85 * Deg;
            innerWing.VortexBurstEnd = 90 * Deg;
            // Thin, 40 degree swept, low-aspect-ratio all-moving stabilator.
            var stab = new SectionParams
            {
                CnAlpha = 5.8,
                Alpha0 = 0,
                AlphaSep = p.StabAlphaSep,
                SepWidth = p.StabSepWidth,
                Cd0 = 0.007,
                SuctionEta = 0.85,
                Cd90 = 1.2,
                Cm0 = 0,
                ReverseSlopeFactor = 0.6,
                ReverseAlphaSep = 6 * Deg,
                Tau1 = 3,
                Tau2 = 1.5,
                Thickness = 0.05,
                PlateShape = p.StabPlateShape,
                VortexLift = p.StabVortexLift,
                VortexCp = 0.35,
                VortexBurstStart = p.StabBurstStart,
                VortexBurstEnd = p.StabBurstEnd,
            };
            // Fin and ventral fins: thin, swept 47.5 degrees, on the fuselage.
            var fin = new SectionParams
            {
                CnAlpha = 5.8,
                Alpha0 = 0,
                AlphaSep = 24 * Deg,
                SepWidth = 4 * Deg,
                Cd0 = 0.007,
                SuctionEta = 0.85,
                Cd90 = 1.2,
                Cm0 = 0,
                ReverseSlopeFactor = 0.6,
                ReverseAlphaSep = 6 * Deg,
                Tau1 = 3,
                Tau2 = 1.5,
                Thickness = 0.05,
                PlateShape = 0.45,
            };

            return new Fm3Airframe
            {
                Name = "F-16 (NASA TP-1538)",
                Reference = new Fm3Reference { AreaM2 = 27.87, SpanM = 9.144, ChordM = 3.45, MomentRef = new double[] { 0, 0, 0 } },
                Mass = new Fm3Mass
                {
                    MassKg = 91188 / 9.80665,
                    Cg = new double[] { 0, 0, 0 },
                    Inertia = new InertiaNasa { Ixx = 12875, Iyy = 75674, Izz = 85552, Ixz = 1331 },
                },
                Surfaces = new[]
                {
                    new Fm3LiftingSurface
                    {
                        Name = "inner wing",
                        Role = Fm3SurfaceRole.Wing,
                        RootLE = WingRootLE,
                        RootChord = WingRootChord,
                        TipLE = WingSplitLE,
                        TipChord = WingSplitChord,
                        Mirror = true,
                        Strips = 4,
                        Spacing = Fm3StripSpacing.Uniform,
                        VortexFromStrakes = true,
                        Section = innerWing,
                        Controls = new[]
                        {
                            new Fm3ControlSegment { Kind = Fm3ControlKind.Flap, Channel = Fm3Channel.FlapR, MirrorChannel = Fm3Channel.FlapL, SpanFrom = ToInner(FlaperonY[0]), SpanTo = 1, ChordFraction = 0.25 },
                            new Fm3ControlSegment { Kind = Fm3ControlKind.LeadingEdge, Channel = Fm3Channel.Lef, SpanFrom = ToInner(LefY[0]), SpanTo = 1 },
                        },
                    },
                    new Fm3LiftingSurface
                    {
                        Name = "outer wing",
                        Role = Fm3SurfaceRole.Wing,
                        RootLE = WingSplitLE,
                        RootChord = WingSplitChord,
                        TipLE = WingTipLE,
                        TipChord = WingTipChord,
                        Mirror = true,
                        Strips = 6,
                        Section = outerWing,
                        Controls = new[]
                        {
                            new Fm3ControlSegment { Kind = Fm3ControlKind.Flap, Channel = Fm3Channel.FlapR, MirrorChannel = Fm3Channel.FlapL, SpanFrom = 0, SpanTo = ToOuter(FlaperonY[1]), ChordFraction = 0.25 },
                            new Fm3ControlSegment { Kind = Fm3ControlKind.LeadingEdge, Channel = Fm3Channel.Lef, SpanFrom = 0, SpanTo = ToOuter(LefY[1]) },
                        },
                    },
                    new Fm3LiftingSurface
                    {
                        Name = "stabilator",
                        Role = Fm3SurfaceRole.Tail,
                        RootLE = new[] { -3.93, 1.0, 0.25 },
                        RootChord = 2.25,
                        TipLE = new[] { -5.43, 2.79, 0.566 },
                        TipChord = 1.05,
                        Mirror = true,
                        Strips = 5,
                        Section = stab,
                        // Mounted clear of the fuselage side, so no endplate; the root runs
                        // in the aft body's boundary layer.
                        QFactor = p.StabQFactor,
                        Controls = new[]
                        {
                            new Fm3ControlSegment { Kind = Fm3ControlKind.AllMoving, Channel = Fm3Channel.StabR, MirrorChannel = Fm3Channel.StabL, SpanFrom = 0, SpanTo = 1 },
                        },
                    },
                    new Fm3LiftingSurface
                    {
                        Name = "fin",
                        Role = Fm3SurfaceRole.Tail,
                        RootLE = new[] { -3.17, 0, -0.75 },
                        RootChord = 3.35,
                        TipLE = new[] { -5.57, 0, -2.95 },
                        TipChord = 1.22,
                        Mirror = false,
                        Strips = 6,
                        Section = fin,
                        QFactor = 0.95,
                        RootEndplate = true,
                        Controls = new[]
                        {
                            new Fm3ControlSegment { Kind = Fm3ControlKind.Flap, Channel = Fm3Channel.Rudder, SpanFrom = 0.05, SpanTo = 0.85, ChordFraction = 0.3 },
                        },
                    },
                    new Fm3LiftingSurface
                    {
                        Name = "ventral fins",
                        Role = Fm3SurfaceRole.Tail,
                        RootLE = new[] { -3.0, 0.55, 0.70 },
                        RootChord = 1.2,
                        TipLE = new[] { -3.35, 0.72, 1.35 },
                        TipChord = 0.7,
                        Mirror = true,
                        Strips = 2,
                        Section = fin,
                        QFactor = 0.9,
                        RootEndplate = true,
                    },
                },
                Strakes = new[]
                {
                    new Fm3Strake
                    {
                        Name = "strakes",
                        Apex = new[] { 5.0, 0.62, 0.05 },
                        RootChord = 2.9,
                        Span = p.StrakeSpan,
                        Mirror = true,
                        Cd90 = 1.2,
                        BurstTrailingEdge = p.StrakeBurstTE,
                        BurstApex = p.StrakeBurstApex,
                        // Breakdown angle per radian of effective sweep change; the F-16's
                        // strake, feeding a wing, is less sensitive than a slender delta.
                        BurstSweepSensitivity = 0.5,
                        // Breakdown follows alpha within a couple of strake chords of travel.
                        BurstTau1 = 2,
                        BurstTau2 = 0.5,
                        Cd0 = 0.004,
                        AugmentedArea = p.StrakeAugArea,
                        AugmentedX = p.StrakeAugX,
                    },
                },
                Bodies = new[]
                {
                    new Fm3Body
                    {
                        Name = "fuselage",
                        Stations = new[]
                        {
                            new[] { 6.70, 0.00, 0.00, 0.00 },
                            new[] { 6.20, 0.00, 0.45, 0.45 },
                            new[] { 5.40, -0.05, 0.80, 0.85 },
                            new[] { 4.60, -0.15, 0.95, 1.20 },
                            new[] { 3.60, -0.20, 1.10, 1.40 },
                            new[] { 2.60, -0.05, 1.45, 1.45 },
                            new[] { 1.50, 0.00, 1.55, 1.40 },
                            new[] { 0.00, 0.00, 1.55, 1.30 },
                            new[] { -1.50, -0.05, 1.50, 1.20 },
                            new[] { -3.00, -0.05, 1.40, 1.10 },
                            new[] { -4.50, -0.05, 1.25, 1.05 },
                            new[] { -6.00, 0.00, 1.05, 1.00 },
                            new[] { -7.20, 0.00, 0.95, 0.95 },
                        },
                        CrossflowCd = p.BodyCrossflowCd,
                    },
                },
                BluffBodies = new[]
                {
                    // JSBSim's F-16 gear drag, dC_D 0.027 on wing area, split over the legs.
                    new Fm3BluffBody { Name = "nose gear", Position = new[] { 2.6, 0, 1.3 }, CdA = 0.17, Deploy = Fm3BluffDeploy.Gear },
                    new Fm3BluffBody { Name = "left main gear", Position = new[] { -0.6, -1.2, 1.3 }, CdA = 0.29, Deploy = Fm3BluffDeploy.Gear },
                    new Fm3BluffBody { Name = "right main gear", Position = new[] { -0.6, 1.2, 1.3 }, CdA = 0.29, Deploy = Fm3BluffDeploy.Gear },
                    new Fm3BluffBody { Name = "speedbrake", Position = new[] { -6.8, 0, 0 }, CdA = 1.6, Deploy = Fm3BluffDeploy.Speedbrake },
                },
                Engines = new[]
                {
                    new Fm3EngineSpec
                    {
                        Nozzle = new[] { -7.2, 0, 0 },
                        Axis = new double[] { 1, 0, 0 },
                        // TP-1538 appendix B: 216.9 kg m^2/s (160 slug ft^2/s).
                        RotorMomentum = 216.9,
                        IdleThrustN = F16Engine.IdleThrustKn * 1000,
                        MilThrustN = F16Engine.MilThrustKn * 1000,
                        AbMinThrustN = F16Engine.AbMinThrustKn * 1000,
                        MaxThrustN = F16Engine.AbMaxThrustKn * 1000,
                    },
                },
                Actuators = new[]
                {
                    new Fm3Actuator { Channel = Fm3Channel.StabL, Min = -25 * Deg, Max = 25 * Deg, Rate = 60 * Deg, Tau = 1 / 20.2 },
                    new Fm3Actuator { Channel = Fm3Channel.StabR, Min = -25 * Deg, Max = 25 * Deg, Rate = 60 * Deg, Tau = 1 / 20.2 },
                    new Fm3Actuator { Channel = Fm3Channel.FlapL, Min = -21.5 * Deg, Max = 21.5 * Deg, Rate = 80 * Deg, Tau = 1 / 20.2 },
                    new Fm3Actuator { Channel = Fm3Channel.FlapR, Min = -21.5 * Deg, Max = 21.5 * Deg, Rate = 80 * Deg, Tau = 1 / 20.2 },
                    new Fm3Actuator { Channel = Fm3Channel.Rudder, Min = -30 * Deg, Max = 30 * Deg, Rate = 120 * Deg, Tau = 1 / 20.2 },
                    new Fm3Actuator { Channel = Fm3Channel.Lef, Min = 0, Max = 25 * Deg, Rate = 25 * Deg, Tau = 1 / 7.25 },
                    new Fm3Actuator { Channel = Fm3Channel.Speedbrake, Min = 0, Max = 60 * Deg, Rate = 30 * Deg, Tau = 0.1 },
                },
                MiscCd0 = 0.009,
                // JSBSim F-16 CDmach.
                BodyWaveDrag = new[] { new[] { 0, 0.0 }, new[] { 0.81, 0 }, new[] { 1.1, 0.023 }, new[] { 1.8, 0.015 } },
                WakeTau = 1.0,
            };
        }

        public static readonly Fm3Airframe Default = Build();
    }
}
