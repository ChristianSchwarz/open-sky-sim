using System;
using System.Linq;

namespace Retro.Sim
{
    /// <summary>One rigid lifting surface (fm2Constants.ts SurfaceGeometry). Optional fields are null when absent.</summary>
    public sealed class SurfaceGeometry
    {
        public string Name;
        /// <summary>Application point relative to the CG, body frame (m).</summary>
        public double[] Position;
        /// <summary>Lift direction at positive AoA, body unit vector.</summary>
        public double[] Up;
        /// <summary>Chord direction, body unit vector (nominally +Z).</summary>
        public double[] Forward;
        public double AreaM2;
        public double LiftSlopePerRad;
        public double? ZeroLiftAoaRad;
        public double? ClMax;
        public double StallAoaRad;
        public double Cd0;
        public double InducedK;
        public double? FlatPlateCd;
        public double ControlEffectiveness;
        public double? VortexLiftScale;
        public double? HighAoaDampingScale;
        public double? UnsteadyTauS;

        public SurfaceGeometry Clone()
        {
            var c = (SurfaceGeometry)MemberwiseClone();
            c.Position = (double[])Position.Clone();
            c.Up = (double[])Up.Clone();
            c.Forward = (double[])Forward.Clone();
            return c;
        }
    }

    public sealed class Fm2GeometryConfig
    {
        public double MassKg;
        public double WingAreaM2;
        public double WingSpanM;
        public double MeanChordM;
    }

    /// <summary>Principal moments of inertia in the sim body frame (kg m^2).</summary>
    public sealed class Fm2InertiaConfig
    {
        /// <summary>About +X.</summary>
        public double Pitch;
        /// <summary>About +Y.</summary>
        public double Yaw;
        /// <summary>About +Z.</summary>
        public double Roll;
    }

    public sealed class Fm2SurfaceSet
    {
        public SurfaceGeometry Fuselage;
        public SurfaceGeometry WingLeft;
        public SurfaceGeometry WingRight;
        public SurfaceGeometry HtailLeft;
        public SurfaceGeometry HtailRight;
        public SurfaceGeometry Vtail;
        /// <summary>Optional.</summary>
        public SurfaceGeometry AileronLeft;
        /// <summary>Optional.</summary>
        public SurfaceGeometry AileronRight;
        /// <summary>Optional forward strake / LERX.</summary>
        public SurfaceGeometry ForeStrake;
    }

    public sealed class Fm2FlapsConfig
    {
        public double AoaBiasRad;
        public double StallReductionRad;
        public double ExtraCd;
    }

    public sealed class Fm2WaveDragConfig
    {
        public double MachOnset;
        public double Scale;
    }

    /// <summary>Spring-damper landing gear.</summary>
    public sealed class Fm2GearConfig
    {
        /// <summary>Contact points, body frame (m).</summary>
        public double[][] Points;
        public double Stiffness;
        public double Damping;
        public double RollFriction;
        public double BrakeFriction;
        public double SideFriction;
        /// <summary>Defaults to 0.35 in the FM when null.</summary>
        public double? MaxStrokeM;
    }

    public sealed class Fm2EngineConfig
    {
        public bool Afterburner;
        public double IdleThrustKn;
        public double MilThrustKn;
        public double AbMinThrustKn;
        public double AbMaxThrustKn;
        public double MilLeverEnd;
        public double AbMinLeverEnd;
    }

    public sealed class Fm2PitchLawConfig
    {
        public bool GCommand;
        public double RateDampGain;
        public double MaxCommandG;
        public double MinCommandG;
        public double GGain;
        public double IGain;
        public double AoaRateDampGain;
        public double AoaRateFilterTauS;
        public double? AoaRateDampQFadeStartNorm;
        public double? AoaRateDampQFadeEndNorm;
        public double? AoaRateDampQFadeFloor;
        public double? AoaRateDampQFadeTauS;
        public double StickExpo;
        public double IntegralLeakTauS;
        public double AoaLimitDeg;
        public double AoaSoftDeg;
        public double? AoaLimiterGain;
        public double? AoaLimiterLeadS;
        public double? GLimiterGain;
        public double? GLimiterLeadS;
        public double? GLimiterNegLeadS;
        public double? GLimiterSoftMarginG;
        public double? EnvelopeAuthorityTauS;
        public double? EnvelopeAuthorityLeadS;
        /// <summary>Deprecated in the TS; kept for manifest compatibility.</summary>
        public double? CapBackCalcGain;
        public double? CapRateTauS;
        public double? AoaCapQFadeStart;
        public double? AoaCapQFadeEnd;
    }

    public sealed class Fm2RollLawConfig
    {
        public bool RateCommand;
        public double RateGain;
        public double RateDamp;
        public double MaxRollRateDegS;
        public double? QGainMin;
        public double? QGainMax;
        public double? MachLimiterOnset;
        public double? MachLimiterSlope;
        public double? MachLimiterFloor;
        public double? AltLimiterOnsetM;
        public double? AltLimiterSlopeM;
        public double? AltLimiterFloor;
        public double? AoaLimiterOnsetDeg;
        public double? AoaLimiterSlopeDeg;
        public double? AoaLimiterFloor;
        public double? FlapsFactor;
    }

    public sealed class Fm2YawLawConfig
    {
        public double MaxRudderCmd;
        public double DamperGain;
        public double DamperWashoutTauS;
        public double AriGain;
    }

    /// <summary>Deprecated legacy tuning; manifest compatibility only.</summary>
    public sealed class Fm2HighAoaFcsConfig
    {
        public double? DirectDampScale;
    }

    public sealed class Fm2FcsConfig
    {
        public double MaxStabilatorRad;
        public double MaxRudderRad;
        public double TaileronRollFraction;
        public double ActuatorTauS;
        public Fm2PitchLawConfig Pitch;
        public Fm2RollLawConfig Roll;
        public Fm2YawLawConfig Yaw;
        public Fm2HighAoaFcsConfig HighAoa;
    }

    public sealed class Fm2EnvelopeConfig
    {
        public double StallAoaRad;
        public double MinFlyingSpeedMps;
        public double CruiseAltitudeM;
        public double CruiseSpeedMps;
        public double MaxLoadFactorG;
        public double LandingMaxSpeedMps;
        public double LandingMaxVerticalSpeedMps;
        public double LandingMinPitchRad;
        public double LandingMaxRollRad;
    }

    /// <summary>Forebody vortex asymmetry (Ericsson nose slice), only live in the laminar regime.</summary>
    public sealed class Fm2ForebodyAsymmetryConfig
    {
        public double ArmZ;
        public double RefAreaM2;
        public double OnsetAoaRad;
        public double FullAoaRad;
        public double MaxSideForceCoeff;
        public double LockInRateGain;
        public double SeedDrive;
        public double DriveScale;
        public double PitchRateArmRatio;
    }

    public sealed class Fm2TransonicPitchDampConfig
    {
        public double QKnee;
        public double Gain;
        public double? MaxRamp;
    }

    /// <summary>Everything FM2 needs to fly one airframe; FM3 also takes gear, engine, envelope and hook from it.</summary>
    public sealed class Fm2AircraftConfig
    {
        public Fm2GeometryConfig Geometry;
        public Fm2InertiaConfig Inertia;
        public Fm2SurfaceSet Surfaces;
        public double AileronMaxDeflectionRad;
        public Fm2FlapsConfig Flaps;
        public double GearCd;
        public double AirbrakeCd;
        public double BodyCd0;
        public Fm2WaveDragConfig WaveDrag;
        public Fm2GearConfig Gear;
        public Fm2EngineConfig Engine;
        public Fm2FcsConfig Fcs;
        public Fm2EnvelopeConfig Envelope;
        /// <summary>Optional body-frame arrestor hook point (m).</summary>
        public double[] Hook;
        public Fm2ForebodyAsymmetryConfig ForebodyAsymmetry;
        public Fm2TransonicPitchDampConfig TransonicPitchDamp;
        /// <summary>FM3 geometry; null means FM3 flies the default F-16 airframe.</summary>
        public Fm3Airframe Fm3;

        /// <summary>Body-frame altitude when level on a flat runway: -min(gear Y).</summary>
        public static double GroundRestHeight(Fm2AircraftConfig config) => -config.Gear.Points.Min(p => p[1]);

        /// <summary>A shallow copy with a different hook, as flightConfigWithArrestorHook does.</summary>
        public Fm2AircraftConfig WithHook(double[] hook)
        {
            var c = (Fm2AircraftConfig)MemberwiseClone();
            c.Hook = hook;
            return c;
        }
    }

    /// <summary>
    /// The FM2 constant tables and the default player aircraft (fm2Constants.ts
    /// and defaultFm2Config). Each call builds a fresh config so callers can
    /// mutate theirs.
    /// </summary>
    public static class Fm2Defaults
    {
        private const double Deg = Math.PI / 180;

        public const double MeanChordM = 3.45;
        public const double GearCd = 0.022;
        public const double AirbrakeCd = 0.028;
        public const double BodyCd0 = 0.010;
        public const double AileronMaxDeflectionRad = 2.5 * Deg;

        public static Fm2InertiaConfig Inertia() => new Fm2InertiaConfig
        {
            Pitch = 55814 * 1.35582,
            Yaw = 63100 * 1.35582,
            Roll = 9496 * 1.35582,
        };

        private static SurfaceGeometry Surface(string name, double[] position, double[] up, double area, double slope,
            double stall, double cd0, double inducedK, double control)
        {
            return new SurfaceGeometry
            {
                Name = name,
                Position = position,
                Up = up,
                Forward = new double[] { 0, 0, 1 },
                AreaM2 = area,
                LiftSlopePerRad = slope,
                StallAoaRad = stall,
                Cd0 = cd0,
                InducedK = inducedK,
                ControlEffectiveness = control,
            };
        }

        public static Fm2SurfaceSet Surfaces()
        {
            double[] up = { 0, 1, 0 };
            var fuselage = Surface("fuselage", new double[] { 0.0, 0.0, 0.0 }, up, 13.0, 2.4, 40 * Deg, 0.0, 0.25, 0);
            fuselage.ZeroLiftAoaRad = -1.9 * Deg;
            fuselage.ClMax = 1.5;
            fuselage.FlatPlateCd = 1.3;

            var strake = Surface("foreStrake", new double[] { 0.0, 0.0, 3.2 }, up, 5.0, 0.4, 18 * Deg, 0.006, 0.2, 0);
            strake.ClMax = 1.2;
            strake.FlatPlateCd = 1.3;
            strake.VortexLiftScale = 2.5;
            strake.UnsteadyTauS = 0.30;

            SurfaceGeometry Wing(string name, double x)
            {
                var w = Surface(name, new double[] { x, 0.0, -0.15 }, (double[])up.Clone(), 7.1, 5.2, 24 * Deg, 0.0085, 0.118, 0);
                w.ZeroLiftAoaRad = -1.3 * Deg;
                w.ClMax = 1.5;
                w.FlatPlateCd = 1.9;
                w.UnsteadyTauS = 0.18;
                return w;
            }

            SurfaceGeometry Aileron(string name, double x)
            {
                var a = Surface(name, new double[] { x, 0.0, -0.6 }, (double[])up.Clone(), 1.5, 4.5, 28 * Deg, 0.009, 0.15, 1.0);
                a.ClMax = 1.5;
                a.FlatPlateCd = 1.9;
                return a;
            }

            SurfaceGeometry Htail(string name, double x)
            {
                var h = Surface(name, new double[] { x, 0.0, -4.6 }, (double[])up.Clone(), 2.95, 3.4, 26 * Deg, 0.006, 0.15, 0.9);
                h.FlatPlateCd = 2.0;
                h.HighAoaDampingScale = 0.7;
                return h;
            }

            var vtail = Surface("vtail", new double[] { 0.0, 1.1, -4.3 }, new double[] { 1, 0, 0 }, 5.1, 2.9, 30 * Deg, 0.007, 0.16, 0.55);
            vtail.FlatPlateCd = 2.0;

            return new Fm2SurfaceSet
            {
                Fuselage = fuselage,
                WingLeft = Wing("wingLeft", -2.4),
                WingRight = Wing("wingRight", 2.4),
                HtailLeft = Htail("htailLeft", -1.5),
                HtailRight = Htail("htailRight", 1.5),
                Vtail = vtail,
                AileronLeft = Aileron("aileronLeft", -3.4),
                AileronRight = Aileron("aileronRight", 3.4),
                ForeStrake = strake,
            };
        }

        public static Fm2AircraftConfig Default()
        {
            double g = SimConstants.PlaneDistanceToGround;
            return new Fm2AircraftConfig
            {
                Geometry = new Fm2GeometryConfig
                {
                    MassKg = F16Profile.SimMassKg,
                    WingAreaM2 = F16Profile.WingAreaM2,
                    WingSpanM = F16Profile.WingSpanM,
                    MeanChordM = MeanChordM,
                },
                Inertia = Inertia(),
                Surfaces = Surfaces(),
                AileronMaxDeflectionRad = AileronMaxDeflectionRad,
                Flaps = new Fm2FlapsConfig { AoaBiasRad = 8 * Deg, StallReductionRad = 1 * Deg, ExtraCd = 0.020 },
                GearCd = GearCd,
                AirbrakeCd = AirbrakeCd,
                BodyCd0 = BodyCd0,
                WaveDrag = new Fm2WaveDragConfig { MachOnset = 0.95, Scale = 0.55 },
                Gear = new Fm2GearConfig
                {
                    Points = new[]
                    {
                        new[] { 0.0, -g, 2.6 },
                        new[] { -1.2, -g, -0.6 },
                        new[] { 1.2, -g, -0.6 },
                    },
                    Stiffness = 4.0e6,
                    Damping = 1.6e5,
                    RollFriction = 0.04,
                    BrakeFriction = 0.55,
                    SideFriction = 0.8,
                    MaxStrokeM = 0.35,
                },
                Engine = new Fm2EngineConfig
                {
                    Afterburner = true,
                    IdleThrustKn = 0.5,
                    MilThrustKn = 76.3,
                    AbMinThrustKn = 104.0,
                    AbMaxThrustKn = F16Profile.AbThrustKn,
                    MilLeverEnd = F16Profile.MilLeverEnd,
                    AbMinLeverEnd = F16Profile.AbMinLeverEnd,
                },
                Fcs = new Fm2FcsConfig
                {
                    MaxStabilatorRad = 25 * Deg,
                    MaxRudderRad = 22 * Deg,
                    TaileronRollFraction = 0.6,
                    ActuatorTauS = 0.05,
                    Pitch = new Fm2PitchLawConfig
                    {
                        GCommand = true,
                        RateDampGain = 1.1,
                        MaxCommandG = F16Profile.MaxLoadFactorG,
                        MinCommandG = -3.0,
                        GGain = 0.14,
                        IGain = 0.6,
                        AoaRateDampGain = 4.5,
                        AoaRateFilterTauS = 0.05,
                        AoaRateDampQFadeStartNorm = 1.3,
                        AoaRateDampQFadeEndNorm = 1.9,
                        AoaRateDampQFadeFloor = 0.55,
                        AoaRateDampQFadeTauS = 0.5,
                        StickExpo = 0.92,
                        IntegralLeakTauS = 0.35,
                        AoaLimitDeg = 28,
                        AoaSoftDeg = 24,
                        AoaLimiterGain = 0.35,
                        AoaLimiterLeadS = 0.08,
                        GLimiterGain = 0.9,
                        GLimiterLeadS = 0.05,
                        GLimiterNegLeadS = 0.02,
                        GLimiterSoftMarginG = 1.0,
                        EnvelopeAuthorityTauS = 0.15,
                        EnvelopeAuthorityLeadS = 0.2,
                        CapBackCalcGain = 0.75,
                        CapRateTauS = 0.06,
                        AoaCapQFadeStart = 0.3,
                        AoaCapQFadeEnd = 0.7,
                    },
                    HighAoa = new Fm2HighAoaFcsConfig { DirectDampScale = 0.19 },
                    Roll = new Fm2RollLawConfig
                    {
                        RateCommand = true,
                        RateGain = 0.8,
                        RateDamp = 0,
                        MaxRollRateDegS = F16Profile.MaxRollRateDegS,
                        QGainMin = 0.12,
                        QGainMax = 1.0,
                        MachLimiterOnset = 0.85,
                        MachLimiterSlope = 0.55,
                        MachLimiterFloor = 0.35,
                        AltLimiterOnsetM = 12000,
                        AltLimiterSlopeM = 20000,
                        AltLimiterFloor = 0.45,
                        AoaLimiterOnsetDeg = 15,
                        AoaLimiterSlopeDeg = 22,
                        AoaLimiterFloor = 0.15,
                        FlapsFactor = 0.65,
                    },
                    Yaw = new Fm2YawLawConfig
                    {
                        MaxRudderCmd = 1.0,
                        DamperGain = 1.6,
                        DamperWashoutTauS = 1.0,
                        AriGain = 0.10,
                    },
                },
                Envelope = new Fm2EnvelopeConfig
                {
                    StallAoaRad = F16Profile.StallAoaDeg * Deg,
                    MinFlyingSpeedMps = F16Profile.MinFlyingSpeedMps,
                    CruiseAltitudeM = F16Profile.CruiseAltitudeM,
                    CruiseSpeedMps = F16Profile.CruiseSpeedMps,
                    MaxLoadFactorG = F16Profile.MaxLoadFactorG,
                    LandingMaxSpeedMps = F16Profile.LandingMaxSpeedMps,
                    LandingMaxVerticalSpeedMps = F16Profile.LandingMaxVerticalSpeedMps,
                    LandingMinPitchRad = F16Profile.LandingMinPitchDeg * Deg,
                    LandingMaxRollRad = F16Profile.LandingMaxRollDeg * Deg,
                },
                ForebodyAsymmetry = new Fm2ForebodyAsymmetryConfig
                {
                    ArmZ = 3.6,
                    RefAreaM2 = F16Profile.WingAreaM2,
                    OnsetAoaRad = 35 * Deg,
                    FullAoaRad = 55 * Deg,
                    MaxSideForceCoeff = 0.42,
                    LockInRateGain = 6.0,
                    SeedDrive = 0.06,
                    DriveScale = 0.5,
                    PitchRateArmRatio = 1.0,
                },
                TransonicPitchDamp = new Fm2TransonicPitchDampConfig { QKnee = 2.0, Gain = 0.5, MaxRamp = 2.0 },
            };
        }
    }
}
