using System;

namespace Retro.Sim
{
    /// <summary>Everything that characterises one family of wing sections. Angles in radians.</summary>
    public sealed class SectionParams
    {
        /// <summary>Normal-force slope at low Mach (per radian). A thin section is ~2 pi.</summary>
        public double CnAlpha;
        /// <summary>Zero-lift angle; negative for positive camber.</summary>
        public double Alpha0;
        /// <summary>Angle past zero-lift at which the static separation point reaches 0.5.</summary>
        public double AlphaSep;
        /// <summary>Width of the static separation curve around AlphaSep.</summary>
        public double SepWidth;
        /// <summary>Profile (skin-friction) drag coefficient.</summary>
        public double Cd0;
        /// <summary>Fraction of the ideal leading-edge suction recovered in attached flow.</summary>
        public double SuctionEta;
        /// <summary>Normal-force coefficient of the fully separated section at 90 degrees.</summary>
        public double Cd90;
        /// <summary>Pitching couple about the quarter chord in attached flow (camber); nose-down negative.</summary>
        public double Cm0;
        /// <summary>Normal-force slope in reverse flow, as a fraction of CnAlpha.</summary>
        public double ReverseSlopeFactor;
        /// <summary>AlphaSep for reverse flow, measured from the reversed chord.</summary>
        public double ReverseAlphaSep;
        /// <summary>Goman-Khrabrov relaxation time constant, in units of chord / airspeed.</summary>
        public double Tau1;
        /// <summary>Goman-Khrabrov lag of the angle the static curve is read at, in chord / airspeed.</summary>
        public double Tau2;
        /// <summary>Thickness / chord, for the drag-divergence estimate.</summary>
        public double Thickness;
        /// <summary>
        /// Shape of the separated normal-force curve, C_D90 sin a / (a + (1 - a) |sin a|).
        /// 0.56 (default) is Lindenburg's high-aspect-ratio blade; a low-aspect-ratio
        /// planform reaches its plateau at a much lower angle, so takes a smaller a.
        /// </summary>
        public double? PlateShape;
        /// <summary>
        /// Leading-edge vortex lift, by the Polhamus suction analogy: the leading-edge
        /// suction a sharp, swept edge loses as its flow separates reappears as normal
        /// force. 0 (default) for a rounded or unswept edge, ~1 for full recovery.
        /// </summary>
        public double? VortexLift;
        /// <summary>Chord station of the vortex lift, fraction from the leading edge (default 0.3).</summary>
        public double? VortexCp;
        /// <summary>Regime angles over which the vortex bursts and its lift is lost.</summary>
        public double? VortexBurstStart;
        public double? VortexBurstEnd;

        public SectionParams Clone() => (SectionParams)MemberwiseClone();
    }

    /// <summary>Control and flow modifiers applied to one section evaluation.</summary>
    public sealed class SectionModifiers
    {
        /// <summary>Zero-lift angle shift from hinged flaps (rad; negative = more lift).</summary>
        public double DAlpha0;
        /// <summary>Shift of the separation angle, e.g. from leading-edge flaps or flaps (rad).</summary>
        public double DAlphaSep;
        /// <summary>Extra profile drag (deflected flaps, wave drag).</summary>
        public double DCd0;
        /// <summary>Share of the section's vortex lift available, e.g. while a feeding vortex is intact (default 1).</summary>
        public double? VortexScale;
    }

    public sealed class SectionForces
    {
        /// <summary>Normal-force coefficient, along the section normal.</summary>
        public double Cn;
        /// <summary>Chordwise force coefficient, positive towards the leading edge.</summary>
        public double Cc;
        /// <summary>Profile drag coefficient, along the local relative wind.</summary>
        public double CdProfile;
        /// <summary>Centre of pressure, fraction of chord from the (geometric) leading edge.</summary>
        public double Xcp;
        /// <summary>Pitching couple coefficient about the span axis, nose-up positive.</summary>
        public double Cm;
    }

    /// <summary>
    /// Two-dimensional section aerodynamics for FM3's strips, over the whole +-180
    /// degrees (port of physics/fm3/sectionAero.ts).
    ///
    /// The section is described by the forces normal to its chord and along it,
    /// the way Kirchhoff's trailing-edge-separation model (as used by Leishman and
    /// Beddoes) writes them:
    ///
    ///     C_N = C_Na sin(a - a0) ((1 + sqrt f) / 2)^2
    ///     C_C = eta C_Na sin(a - a0) sin a sqrt f
    ///
    /// f in [0, 1] is the trailing-edge separation point (1 = attached). Lift and
    /// drag are not coefficients here at all: the strip applies C_N along its
    /// normal and C_C along its chord, so the resultant's tilt relative to the
    /// local wind (induced drag, the drag rise at stall) comes from the geometry
    /// of those two forces rather than from a polar.
    ///
    /// As f falls to zero the normal force hands over to a flat plate,
    ///
    ///     C_N,plate = C_D90 sin a / (0.56 + 0.44 |sin a|)     (Lindenburg)
    ///
    /// and the centre of pressure walks from the quarter chord towards mid-chord,
    /// so a stall changes the section's pitching moment on its own. Past +-90 the
    /// section flies backwards: the sharp trailing edge leads, there is no suction,
    /// and camber is ignored.
    ///
    /// f itself is a state with Goman-Khrabrov dynamics (see SeparationTarget):
    /// it relaxes towards a static curve evaluated at a lagged angle, with time
    /// constants that scale with chord / airspeed.
    /// </summary>
    public static class SectionAero
    {
        public static readonly SectionModifiers NoModifiers = new SectionModifiers();

        private const double HalfPi = Math.PI / 2;

        /// <summary>
        /// Static separation point for a regime angle a >= 0 (angle past zero lift in
        /// forward flow, angle from the reversed chord in reverse flow). A logistic
        /// normalised to exactly 1 at a = 0, 0.5 near alphaSep, and ~0 well past it.
        /// </summary>
        public static double StaticSeparation(double a, double alphaSep, double width)
        {
            double w = width > 1e-4 ? width : 1e-4;
            double s = 1 / (1 + Math.Exp((a - alphaSep) / w));
            double s0 = 1 / (1 + Math.Exp(-alphaSep / w));
            double f = s / s0;
            return f > 1 ? 1 : f;
        }

        /// <summary>True while the section's leading edge leads (|a| &lt;= 90 degrees).</summary>
        public static bool IsForwardFlow(double alpha) => alpha <= HalfPi && alpha >= -HalfPi;

        /// <summary>
        /// The angle the separation state is keyed on and its sign convention: in
        /// forward flow |a - a0 - da0|, in reverse flow pi - |a|.
        /// </summary>
        public static double RegimeAngle(double alpha, double alpha0)
        {
            if (IsForwardFlow(alpha))
            {
                return Math.Abs(alpha - alpha0);
            }
            return Math.PI - Math.Abs(alpha);
        }

        /// <summary>
        /// Goman-Khrabrov target for the separation state: the static curve read at
        /// the regime angle lagged by tau2 a'. Positive a' (angle growing) reads the
        /// curve at a smaller angle, delaying separation; negative a' delays reattachment.
        /// </summary>
        public static double SeparationTarget(
            double alpha, double regimeRate, double speed, double chord,
            SectionParams p, SectionModifiers mod, double mach)
        {
            bool forward = IsForwardFlow(alpha);
            double a = forward ? Math.Abs(alpha - (p.Alpha0 + mod.DAlpha0)) : Math.PI - Math.Abs(alpha);
            double v = speed > 1 ? speed : 1;
            double lagged = a - p.Tau2 * (chord / v) * regimeRate;
            double sep = forward ? (p.AlphaSep + mod.DAlphaSep) * StallMachFactor(mach) : p.ReverseAlphaSep;
            return StaticSeparation(lagged > 0 ? lagged : 0, sep, p.SepWidth);
        }

        /// <summary>First-order relaxation of the separation state towards its target.</summary>
        public static double AdvanceSeparation(double f, double target, double dt, double speed, double chord, double tau1)
        {
            if (tau1 <= 0 || dt <= 0) return target;
            double v = speed > 1 ? speed : 1;
            double tau = tau1 * chord / v;
            return f + (target - f) * (1 - Math.Exp(-dt / tau));
        }

        /// <summary>
        /// Compressibility factor on the normal-force slope: Prandtl-Glauert to Mach
        /// 0.8, a linear bridge through the transonic band, and Ackeret's 4/sqrt(M^2 - 1)
        /// (relative to the section's own low-speed slope) above Mach 1.2.
        /// </summary>
        public static double SlopeMachFactor(double mach, double cnAlpha)
        {
            double m = mach > 0 ? mach : 0;
            if (m <= 0.8)
            {
                return 1 / Math.Sqrt(1 - m * m);
            }
            double pgAt08 = 1 / Math.Sqrt(1 - 0.64);
            double supAt12 = 4 / Math.Sqrt(1.44 - 1) / cnAlpha;
            if (m < 1.2)
            {
                double t = (m - 0.8) / 0.4;
                return pgAt08 + (supAt12 - pgAt08) * t;
            }
            return 4 / Math.Sqrt(m * m - 1) / cnAlpha;
        }

        /// <summary>Shock-induced separation arrives earlier with Mach: the break angle shrinks by up to 40%.</summary>
        private static double StallMachFactor(double mach)
        {
            if (mach <= 0.3) return 1;
            double t = mach >= 0.9 ? 1 : (mach - 0.3) / 0.6;
            double s = t * t * (3 - 2 * t);
            return 1 - 0.4 * s;
        }

        /// <summary>
        /// Section force coefficients at geometric angle alpha in (-pi, pi] with
        /// separation state f. mach is the Mach number of the flow normal to the
        /// sweep line. Writes into o.
        /// </summary>
        public static SectionForces Forces(
            double alpha, double f, SectionParams p, SectionModifiers mod, double mach, SectionForces o)
        {
            double ff = f < 0 ? 0 : f > 1 ? 1 : f;
            double sq = Math.Sqrt(ff);
            double sinA = Math.Sin(alpha);
            double absSinA = sinA < 0 ? -sinA : sinA;
            double shape = p.PlateShape ?? 0.56;
            double plate = p.Cd90 * sinA / (shape + (1 - shape) * absSinA);
            double w = (1 - ff) * (1 - ff);
            double kirchhoffFactor = 0.25 * (1 + sq) * (1 + sq);

            if (IsForwardFlow(alpha))
            {
                double cnA = p.CnAlpha * SlopeMachFactor(mach, p.CnAlpha);
                double alphaE = alpha - (p.Alpha0 + mod.DAlpha0);
                double sinAe = Math.Sin(alphaE);
                double attached = cnA * sinAe;
                double cn = attached * kirchhoffFactor + w * (plate - 0.25 * attached);
                double xcp = 0.25 + 0.25 * (1 - ff) * absSinA;
                double kv = (p.VortexLift ?? 0) * (mod.VortexScale ?? 1);
                if (kv > 0)
                {
                    double burst = 1 - Smoothstep(p.VortexBurstStart ?? 0.6, p.VortexBurstEnd ?? 1.0, Math.Abs(alphaE));
                    if (burst > 0)
                    {
                        // The suction lost to separation, (1 - sqrt f) of the potential
                        // C_Na sin ae sin a, turned normal to the section.
                        double vortex = kv * attached * absSinA * (1 - sq) * burst;
                        double total = cn + vortex;
                        if (Math.Abs(total) > 1e-9 && cn * vortex >= 0)
                        {
                            xcp = (cn * xcp + vortex * (p.VortexCp ?? 0.3)) / total;
                        }
                        cn = total;
                    }
                }
                o.Cn = cn;
                o.Cc = p.SuctionEta * attached * sinA * sq;
                o.Xcp = xcp;
                o.Cm = p.Cm0 * ff;
            }
            else
            {
                double attached = p.CnAlpha * p.ReverseSlopeFactor * sinA;
                o.Cn = attached * kirchhoffFactor + w * (plate - 0.25 * attached);
                o.Cc = 0;
                o.Xcp = 0.75 - 0.25 * (1 - ff) * absSinA;
                o.Cm = 0;
            }
            o.CdProfile = p.Cd0 + mod.DCd0;
            return o;
        }

        private static double Smoothstep(double edge0, double edge1, double x)
        {
            if (edge1 <= edge0) return x < edge0 ? 0 : 1;
            double t = x <= edge0 ? 0 : x >= edge1 ? 1 : (x - edge0) / (edge1 - edge0);
            return t * t * (3 - 2 * t);
        }

        /// <summary>
        /// Glauert's thin-airfoil flap effectiveness: the zero-lift angle shift per
        /// radian of deflection for a plain flap of chord fraction cf.
        /// </summary>
        public static double FlapEffectiveness(double cf)
        {
            double c = cf < 0 ? 0 : cf > 1 ? 1 : cf;
            double theta = Math.Acos(2 * c - 1);
            return 1 - (theta - Math.Sin(theta)) / Math.PI;
        }

        /// <summary>
        /// Real plain flaps lose effectiveness at large deflections as the flow over
        /// them separates: full effect to 12 degrees, falling to 60% by 30 (DATCOM-style).
        /// </summary>
        public static double FlapDeflectionEfficiency(double deltaRad)
        {
            double d = Math.Abs(deltaRad) * 180 / Math.PI;
            if (d <= 12) return 1;
            if (d >= 30) return 0.6;
            return 1 - 0.4 * (d - 12) / 18;
        }
    }
}
