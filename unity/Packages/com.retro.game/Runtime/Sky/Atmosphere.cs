using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// atmosphere.ts AtmosphereParams: a spherical, layered Earth atmosphere.
    /// Coefficients are per metre, per RGB channel (~680 / 550 / 440 nm).
    /// </summary>
    public sealed class AtmosphereParams
    {
        /// <summary>Sea level, metres from the planet centre.</summary>
        public double GroundRadius;
        /// <summary>Top of the atmosphere, metres from the planet centre.</summary>
        public double TopRadius;
        public double[] RayleighScattering;
        public double RayleighScaleHeight;
        public double MieScattering;
        public double MieExtinction;
        public double MieScaleHeight;
        public double MieG;
        public double[] OzoneAbsorption;
        public double OzoneCentre;
        public double OzoneHalfWidth;
        public double[] GroundAlbedo;
    }

    /// <summary>atmosphere.ts AtmosphereSample: what the sky does for one sun position (linear radiances).</summary>
    public sealed class AtmosphereSample
    {
        /// <summary>Radiance looking straight up.</summary>
        public double[] Zenith;
        /// <summary>Radiance 0.5 degrees above the horizon on the sun's side.</summary>
        public double[] HorizonSunward;
        /// <summary>Radiance 0.5 degrees above the horizon opposite the sun.</summary>
        public double[] HorizonOpposite;
        /// <summary>What is left of the solar beam at the viewer.</summary>
        public double[] SunDisc;
        /// <summary>The sky 5 degrees above the sun (the aureole).</summary>
        public double[] Sunward;
        /// <summary>Irradiance on a surface square to the sun (same values as <see cref="SunDisc"/>).</summary>
        public double[] DirectIrradiance;
        /// <summary>Irradiance the sky alone puts on a flat surface.</summary>
        public double[] SkyIrradiance;
    }

    /// <summary>
    /// Port of src/script/scene/atmosphere/atmosphere.ts: a CPU single-scattering
    /// ray march with Hillaire-style multiple scattering, sampled whenever the
    /// time of day changes. Every expression keeps the TypeScript evaluation
    /// order; trig goes through <see cref="JsTrig"/>. Math.exp / Math.pow have
    /// no V8-exact port here and use .NET's (they can differ from V8 in the last
    /// ulp; the golden tests bound the effect).
    /// </summary>
    public static class Atmosphere
    {
        /// <summary>atmosphere.ts TURBIDITY: aerosol load as a multiple of clean air.</summary>
        public const double Turbidity = 5;

        /// <summary>atmosphere.ts EARTH_ATMOSPHERE.</summary>
        public static readonly AtmosphereParams Earth = new AtmosphereParams
        {
            GroundRadius = 6360000,
            TopRadius = 6420000,
            RayleighScattering = new[] { 5.802e-6, 13.558e-6, 33.1e-6 },
            RayleighScaleHeight = 8000,
            MieScattering = 3.996e-6 * Turbidity,
            MieExtinction = 4.40e-6 * Turbidity,
            MieScaleHeight = 1200,
            MieG = 0.8,
            OzoneAbsorption = new[] { 0.650e-6, 1.881e-6, 0.085e-6 },
            OzoneCentre = 25000,
            OzoneHalfWidth = 15000,
            GroundAlbedo = new[] { 0.2, 0.2, 0.2 },
        };

        public const int ViewSteps = 32;
        public const int SunSteps = 16;
        public const int MsAltitudeBins = 6;
        public const int MsDirections = 24;
        public const int MsSteps = 10;
        public const int MsSunSteps = 8;
        public const int IrradianceDirections = 32;

        private const double FourPi = 4 * Math.PI;
        private const double RayEpsilon = 1e-3;
        private const double SunwardSampleAngleDeg = 5;
        private const double HorizonSampleElevationDeg = 0.5;
        private const double Deg2Rad = Math.PI / 180;

        private static double Dot(double[] a, double[] b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

        private static double LengthOf(double[] v) => Math.Sqrt(Dot(v, v));

        /// <summary>Nearest t &gt; 1e-3 with |origin + t dir| == radius, or -1 on a miss.</summary>
        private static double RaySphere(double[] origin, double[] dir, double radius)
        {
            double b = Dot(origin, dir);
            double c = Dot(origin, origin) - radius * radius;
            double discriminant = b * b - c;
            if (discriminant < 0)
            {
                return -1;
            }
            double root = Math.Sqrt(discriminant);
            double near = -b - root;
            if (near > RayEpsilon)
            {
                return near;
            }
            double far = -b + root;
            return far > RayEpsilon ? far : -1;
        }

        private static void Densities(AtmosphereParams p, double altitude, out double rayleigh, out double mie, out double ozone)
        {
            double h = Math.Max(altitude, 0);
            rayleigh = Math.Exp(-h / p.RayleighScaleHeight);
            mie = Math.Exp(-h / p.MieScaleHeight);
            ozone = Math.Max(0, 1 - Math.Abs(h - p.OzoneCentre) / p.OzoneHalfWidth);
        }

        private static void Extinction(AtmosphereParams p, double altitude, double[] o)
        {
            Densities(p, altitude, out double rayleigh, out double mie, out double ozone);
            for (int i = 0; i < 3; i++)
            {
                o[i] = p.RayleighScattering[i] * rayleigh
                    + p.MieExtinction * mie
                    + p.OzoneAbsorption[i] * ozone;
            }
        }

        private static double[] Transmittance(AtmosphereParams p, double[] origin, double[] dir, double distance, int steps)
        {
            double dt = distance / steps;
            double depthR = 0, depthG = 0, depthB = 0;
            double[] ext = new double[3];
            double[] at = new double[3];
            for (int i = 0; i < steps; i++)
            {
                double t = (i + 0.5) * dt;
                at[0] = origin[0] + dir[0] * t;
                at[1] = origin[1] + dir[1] * t;
                at[2] = origin[2] + dir[2] * t;
                double altitude = LengthOf(at) - p.GroundRadius;
                Extinction(p, altitude, ext);
                depthR += ext[0] * dt;
                depthG += ext[1] * dt;
                depthB += ext[2] * dt;
            }
            return new[] { Math.Exp(-depthR), Math.Exp(-depthG), Math.Exp(-depthB) };
        }

        /// <summary>atmosphere.ts sunTransmittance: to the top of the atmosphere along sunDir, black when the planet is in the way.</summary>
        public static double[] SunTransmittance(AtmosphereParams p, double[] position, double[] sunDir, int steps = SunSteps)
        {
            if (RaySphere(position, sunDir, p.GroundRadius) >= 0)
            {
                return new double[] { 0, 0, 0 };
            }
            double toTop = RaySphere(position, sunDir, p.TopRadius);
            if (toTop < 0)
            {
                return new double[] { 1, 1, 1 };
            }
            return Transmittance(p, position, sunDir, toTop, steps);
        }

        /// <summary>atmosphere.ts rayleighPhase.</summary>
        public static double RayleighPhase(double cosTheta) => 3 / (16 * Math.PI) * (1 + cosTheta * cosTheta);

        /// <summary>atmosphere.ts miePhase (Cornette-Shanks).</summary>
        public static double MiePhase(double cosTheta, double g)
        {
            double gg = g * g;
            double denominator = Math.Pow(Math.Max(1e-6, 1 + gg - 2 * g * cosTheta), 1.5);
            return 3 * (1 - gg) * (1 + cosTheta * cosTheta)
                / (8 * Math.PI * (2 + gg) * denominator);
        }

        /// <summary>atmosphere.ts sphereDirections: Fibonacci spiral on the unit sphere.</summary>
        private static double[][] SphereDirections(int count)
        {
            double golden = Math.PI * (3 - Math.Sqrt(5));
            var o = new double[count][];
            for (int i = 0; i < count; i++)
            {
                double y = 1 - (double)(2 * i + 1) / count;
                double radius = Math.Sqrt(Math.Max(0, 1 - y * y));
                double theta = golden * i;
                o[i] = new[] { JsTrig.Cos(theta) * radius, y, JsTrig.Sin(theta) * radius };
            }
            return o;
        }

        private static double[][] HemisphereDirections(int count)
        {
            double[][] all = SphereDirections(2 * count);
            int n = 0;
            foreach (double[] d in all) if (d[1] > 0) n++;
            var o = new double[n][];
            n = 0;
            foreach (double[] d in all) if (d[1] > 0) o[n++] = d;
            return o;
        }

        /// <summary>atmosphere.ts multipleScatteringTable: psi per altitude bin (6 bins, ground to top).</summary>
        public static double[][] MultipleScatteringTable(AtmosphereParams p, double[] sunDir)
        {
            double[][] directions = SphereDirections(MsDirections);
            double topAltitude = p.TopRadius - p.GroundRadius;
            var table = new double[MsAltitudeBins][];
            double[] ext = new double[3];
            double[] sample = new double[3];

            for (int bin = 0; bin < MsAltitudeBins; bin++)
            {
                double altitude = topAltitude * bin / (MsAltitudeBins - 1);
                double[] origin = { 0, p.GroundRadius + altitude, 0 };
                double[] second = new double[3];
                double[] fms = new double[3];

                foreach (double[] dir in directions)
                {
                    double ground = RaySphere(origin, dir, p.GroundRadius);
                    double top = RaySphere(origin, dir, p.TopRadius);
                    double distance = ground >= 0 ? ground : top;
                    if (distance <= 0)
                    {
                        continue;
                    }
                    double dt = distance / MsSteps;
                    double viewR = 1, viewG = 1, viewB = 1;

                    for (int step = 0; step < MsSteps; step++)
                    {
                        double t = (step + 0.5) * dt;
                        sample[0] = origin[0] + dir[0] * t;
                        sample[1] = origin[1] + dir[1] * t;
                        sample[2] = origin[2] + dir[2] * t;
                        double sampleAltitude = LengthOf(sample) - p.GroundRadius;
                        Densities(p, sampleAltitude, out double rayleighDensity, out double mieDensity, out _);
                        double[] sun = SunTransmittance(p, sample, sunDir, MsSunSteps);
                        Extinction(p, sampleAltitude, ext);

                        for (int c = 0; c < 3; c++)
                        {
                            double scattering = p.RayleighScattering[c] * rayleighDensity
                                + p.MieScattering * mieDensity;
                            double view = c == 0 ? viewR : c == 1 ? viewG : viewB;
                            second[c] += view * scattering * sun[c] / FourPi * dt;
                            fms[c] += view * scattering / FourPi * dt;
                        }

                        viewR *= Math.Exp(-ext[0] * dt);
                        viewG *= Math.Exp(-ext[1] * dt);
                        viewB *= Math.Exp(-ext[2] * dt);
                    }

                    if (ground >= 0)
                    {
                        double[] hit =
                        {
                            origin[0] + dir[0] * ground,
                            origin[1] + dir[1] * ground,
                            origin[2] + dir[2] * ground,
                        };
                        double[] normal = { hit[0], hit[1], hit[2] };
                        double inverse = 1 / LengthOf(normal);
                        normal[0] *= inverse; normal[1] *= inverse; normal[2] *= inverse;
                        double cosSun = Math.Max(0, Dot(normal, sunDir));
                        if (cosSun > 0)
                        {
                            double[] sun = SunTransmittance(p, hit, sunDir, MsSunSteps);
                            for (int c = 0; c < 3; c++)
                            {
                                double view = c == 0 ? viewR : c == 1 ? viewG : viewB;
                                second[c] += view * p.GroundAlbedo[c] / Math.PI * cosSun * sun[c];
                            }
                        }
                    }
                }

                double weight = FourPi / directions.Length;
                double[] psi = new double[3];
                for (int c = 0; c < 3; c++)
                {
                    double l2 = second[c] * weight / FourPi;
                    double f = Math.Min(0.95, fms[c] * weight / FourPi);
                    psi[c] = l2 / (1 - f);
                }
                table[bin] = psi;
            }
            return table;
        }

        private static void MultipleScatteringAt(double[][] table, AtmosphereParams p, double altitude, double[] o)
        {
            double topAltitude = p.TopRadius - p.GroundRadius;
            double position = Math.Min(1, Math.Max(0, altitude / topAltitude)) * (table.Length - 1);
            int low = (int)Math.Floor(position);
            int high = Math.Min(table.Length - 1, low + 1);
            double blend = position - low;
            for (int c = 0; c < 3; c++)
            {
                o[c] = table[low][c] + (table[high][c] - table[low][c]) * blend;
            }
        }

        /// <summary>
        /// atmosphere.ts skyRadiance: radiance arriving from viewDir at a viewer
        /// altitude metres up (relative to a solar irradiance of 1). msTable
        /// defaults to <see cref="MultipleScatteringTable"/> for sunDir.
        /// </summary>
        public static double[] SkyRadiance(AtmosphereParams p, double altitude, double[] viewDir, double[] sunDir, double[][] msTable = null)
        {
            if (msTable == null)
            {
                msTable = MultipleScatteringTable(p, sunDir);
            }
            double[] origin = { 0, p.GroundRadius + altitude, 0 };
            double ground = RaySphere(origin, viewDir, p.GroundRadius);
            double top = RaySphere(origin, viewDir, p.TopRadius);
            double distance = ground >= 0 ? ground : top;
            if (distance <= 0)
            {
                return new double[] { 0, 0, 0 };
            }

            double cosTheta = Dot(viewDir, sunDir);
            double rayleighWeight = RayleighPhase(cosTheta);
            double mieWeight = MiePhase(cosTheta, p.MieG);

            double dt = distance / ViewSteps;
            double[] radiance = new double[3];
            double[] view = { 1, 1, 1 };
            double[] sample = new double[3];
            double[] ms = new double[3];
            double[] ext = new double[3];

            for (int step = 0; step < ViewSteps; step++)
            {
                double t = (step + 0.5) * dt;
                sample[0] = origin[0] + viewDir[0] * t;
                sample[1] = origin[1] + viewDir[1] * t;
                sample[2] = origin[2] + viewDir[2] * t;
                double sampleAltitude = LengthOf(sample) - p.GroundRadius;
                Densities(p, sampleAltitude, out double rayleighDensity, out double mieDensity, out _);
                double[] sun = SunTransmittance(p, sample, sunDir);
                MultipleScatteringAt(msTable, p, sampleAltitude, ms);
                Extinction(p, sampleAltitude, ext);

                for (int c = 0; c < 3; c++)
                {
                    double rayleigh = p.RayleighScattering[c] * rayleighDensity;
                    double mie = p.MieScattering * mieDensity;
                    double single = (rayleigh * rayleighWeight + mie * mieWeight) * sun[c];
                    double multiple = (rayleigh + mie) * ms[c];
                    radiance[c] += view[c] * (single + multiple) * dt;
                    view[c] *= Math.Exp(-ext[c] * dt);
                }
            }
            return radiance;
        }

        private static double[] InSunPlane(double elevationDeg, bool sunward)
        {
            double a = elevationDeg * Deg2Rad;
            return new[] { JsTrig.Cos(a) * (sunward ? 1 : -1), JsTrig.Sin(a), 0 };
        }

        /// <summary>
        /// atmosphere.ts sampleAtmosphere: the sun in the z = 0 plane at
        /// sunElevationDeg (the model is radially symmetric).
        /// </summary>
        public static AtmosphereSample Sample(double sunElevationDeg, double altitude = 0, AtmosphereParams p = null)
        {
            p ??= Earth;
            double sunAngle = sunElevationDeg * Deg2Rad;
            double[] sunDir = { JsTrig.Cos(sunAngle), JsTrig.Sin(sunAngle), 0 };
            double[][] msTable = MultipleScatteringTable(p, sunDir);
            double[] origin = { 0, p.GroundRadius + altitude, 0 };

            double[] Sky(double[] dir) => SkyRadiance(p, altitude, dir, sunDir, msTable);

            double[] sunDisc = SunTransmittance(p, origin, sunDir);
            double sunwardAngle = (sunElevationDeg + SunwardSampleAngleDeg) * Deg2Rad;

            double[] skyIrradiance = new double[3];
            double[][] hemisphere = HemisphereDirections(IrradianceDirections);
            foreach (double[] dir in hemisphere)
            {
                double[] radiance = Sky(dir);
                double cosine = dir[1];
                for (int c = 0; c < 3; c++)
                {
                    skyIrradiance[c] += radiance[c] * cosine;
                }
            }
            double solidAngle = 2 * Math.PI / hemisphere.Length;
            for (int c = 0; c < 3; c++)
            {
                skyIrradiance[c] *= solidAngle;
            }

            return new AtmosphereSample
            {
                Zenith = Sky(new double[] { 0, 1, 0 }),
                HorizonSunward = Sky(InSunPlane(HorizonSampleElevationDeg, true)),
                HorizonOpposite = Sky(InSunPlane(HorizonSampleElevationDeg, false)),
                SunDisc = sunDisc,
                Sunward = Sky(new[] { JsTrig.Cos(sunwardAngle), JsTrig.Sin(sunwardAngle), 0 }),
                DirectIrradiance = sunDisc,
                SkyIrradiance = skyIrradiance,
            };
        }
    }
}
