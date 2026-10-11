using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>skyModel.ts SkySample: per-slot linear-RGB gains plus the night crossover for one sun elevation.</summary>
    public sealed class SkySample
    {
        /// <summary>Sun elevation this was sampled at (the 0.25 degree quantised value), degrees.</summary>
        public double ElevationDeg;
        /// <summary>0 = the authored noon palette, 1 = the authored midnight one.</summary>
        public double NightMix;
        public double[] Zenith;
        /// <summary>The clear colour and the fog colours: the horizon band.</summary>
        public double[] Horizon;
        public double[] HorizonSunward;
        /// <summary>Aerial perspective over land.</summary>
        public double[] Haze;
        public double[] Cloud;
        /// <summary>The solar disc and its corona.</summary>
        public double[] SunDisc;
        /// <summary>Lit surfaces.</summary>
        public double[] Ground;
        public double[] Water;
        /// <summary>Colour of the direct beam relative to the reference sun, luminance 1 (hue only).</summary>
        public double[] DirectTint;
        /// <summary>Colour of the sky's fill light relative to the reference sun, luminance 1 (hue only).</summary>
        public double[] AmbientTint;
    }

    /// <summary>skyModel.ts DomeShade: the sky's hue and brightness in one direction.</summary>
    public struct DomeShade
    {
        /// <summary>Absolute chromaticity of the sky there (sums to 1).</summary>
        public double ChromaR, ChromaG, ChromaB;
        /// <summary>How far to trust that chroma over the authored one, 0..0.8.</summary>
        public double HueWeight;
        /// <summary>Luminance relative to the same direction at the reference sun, in [0.0005, 1].</summary>
        public double Brightness;
    }

    /// <summary>
    /// Port of src/script/scene/atmosphere/skyModel.ts: turns the atmosphere's
    /// radiances into per-slot gains (ratios against the sun at
    /// <see cref="ReferenceSunElevationDeg"/>) and the per-direction dome shade.
    /// Results are cached per 0.25 degrees of sun elevation exactly as the TS
    /// does, and the quantisation is part of the contract (the sample is built
    /// at the quantised elevation). Thread-safe.
    /// </summary>
    public static class SkyModel
    {
        /// <summary>Sun elevation the palettes were authored against: local noon at 29 N on the equinox.</summary>
        public const double ReferenceSunElevationDeg = 61;
        public const double CacheQuantumDeg = 0.25;
        public const double NightDecades = 7.5;

        private static readonly double[] SkyBrightnessRange = { 0.75, 1.15 };
        private static readonly double[] SunBrightnessRange = { 0.85, 1.5 };
        private static readonly double[] CloudBrightnessRange = { 0.22, 1.15 };
        private static readonly double[] GroundBrightnessRange = { 0.12, 1.25 };
        private static readonly double[] DomeGainRange = { 0.0005, 1.0 };

        private const double CloudBeamShare = 0.85;
        private const double WaterSkyShare = 0.75;
        private const double WaterHueTrust = 0.35;
        private const double HazeHorizonShare = 0.08;

        /// <summary>skyModel.ts DOME_ELEVATIONS_DEG / DOME_AZIMUTHS_DEG: the dome gain grid.</summary>
        public static readonly double[] DomeElevationsDeg = { 0.3, 1.5, 4, 8, 15, 26, 42, 62, 90 };
        public static readonly double[] DomeAzimuthsDeg = { 0, 20, 40, 60, 90, 120, 150, 180 };

        private const double HueTrustStartElevationDeg = 12;
        private const double HueTrustFullElevationDeg = 0;
        private const double HueTrustMax = 0.8;

        private static readonly object Gate = new object();
        private static AtmosphereSample _referenceSample;
        private static readonly Dictionary<double, SkySample> Cache = new Dictionary<double, SkySample>();
        private static double[][][] _domeReference;
        private static readonly Dictionary<double, double[][][]> DomeCache = new Dictionary<double, double[][][]>();

        private static double Luminance(double[] c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

        private static double[] HorizonMean(AtmosphereSample s) => new[]
        {
            (s.HorizonSunward[0] + s.HorizonOpposite[0]) / 2,
            (s.HorizonSunward[1] + s.HorizonOpposite[1]) / 2,
            (s.HorizonSunward[2] + s.HorizonOpposite[2]) / 2,
        };

        private static double[] CloudIllumination(AtmosphereSample s)
        {
            double[] o = new double[3];
            for (int c = 0; c < 3; c++)
            {
                o[c] = s.DirectIrradiance[c] * CloudBeamShare
                    + s.SkyIrradiance[c] * (1 - CloudBeamShare);
            }
            return o;
        }

        private static double[] GroundIllumination(AtmosphereSample s, double sunElevationDeg)
        {
            double cosine = Math.Max(0, JsTrig.Sin(sunElevationDeg * Math.PI / 180));
            return new[]
            {
                s.DirectIrradiance[0] * cosine + s.SkyIrradiance[0],
                s.DirectIrradiance[1] * cosine + s.SkyIrradiance[1],
                s.DirectIrradiance[2] * cosine + s.SkyIrradiance[2],
            };
        }

        private static double[] WaterIllumination(AtmosphereSample s, double sunElevationDeg)
        {
            double[] horizon = HorizonMean(s);
            double[] ground = GroundIllumination(s, sunElevationDeg);
            double[] o = new double[3];
            for (int c = 0; c < 3; c++)
            {
                o[c] = ground[c] + (horizon[c] - ground[c]) * WaterSkyShare;
            }
            return o;
        }

        private static double[] HazeIllumination(AtmosphereSample s, double sunElevationDeg)
        {
            double[] horizon = HorizonMean(s);
            double[] ground = GroundIllumination(s, sunElevationDeg);
            double[] o = new double[3];
            for (int c = 0; c < 3; c++)
            {
                o[c] = ground[c] + (horizon[c] - ground[c]) * HazeHorizonShare;
            }
            return o;
        }

        private static double[] Gain(double[] now, double[] reference, double common, double[] range, double hueTrust = 1)
        {
            double[] raw = new double[3];
            for (int c = 0; c < 3; c++)
            {
                raw[c] = reference[c] > 1e-12 ? (now[c] / reference[c]) / common : 1;
            }
            double brightness = Luminance(raw);
            if (brightness <= 1e-9)
            {
                return new double[] { 1, 1, 1 };
            }
            double[] tinted = hueTrust >= 1 ? raw : new[]
            {
                brightness + (raw[0] - brightness) * hueTrust,
                brightness + (raw[1] - brightness) * hueTrust,
                brightness + (raw[2] - brightness) * hueTrust,
            };
            double bounded = Math.Min(range[1], Math.Max(range[0], brightness));
            double scale = bounded / brightness;
            return new[] { tinted[0] * scale, tinted[1] * scale, tinted[2] * scale };
        }

        private static double[] RelativeTint(double[] now, double[] reference)
        {
            double[] raw = new double[3];
            for (int c = 0; c < 3; c++)
            {
                raw[c] = reference[c] > 1e-12 && now[c] > 0 ? now[c] / reference[c] : 1;
            }
            double l = Luminance(raw);
            if (l <= 1e-12)
            {
                return new double[] { 1, 1, 1 };
            }
            return new[] { raw[0] / l, raw[1] / l, raw[2] / l };
        }

        private static AtmosphereSample Reference()
        {
            lock (Gate)
            {
                return _referenceSample ??= Atmosphere.Sample(ReferenceSunElevationDeg);
            }
        }

        private static SkySample Build(double elevationDeg)
        {
            AtmosphereSample now = Atmosphere.Sample(elevationDeg);
            AtmosphereSample reference = Reference();

            double zenithRatio = Luminance(now.Zenith) / Math.Max(1e-30, Luminance(reference.Zenith));
            double decades = -Math.Log10(Math.Max(1e-30, zenithRatio));
            double t = Math.Min(1, Math.Max(0, decades / NightDecades));
            double nightMix = t * t * (3 - 2 * t);

            double common = zenithRatio;
            double fade = 1 - nightMix;
            double[] Settle(double[] g) => new[]
            {
                1 + (g[0] - 1) * fade,
                1 + (g[1] - 1) * fade,
                1 + (g[2] - 1) * fade,
            };

            double[] groundNow = GroundIllumination(now, elevationDeg);
            double[] groundRef = GroundIllumination(reference, ReferenceSunElevationDeg);

            return new SkySample
            {
                ElevationDeg = elevationDeg,
                NightMix = nightMix,
                Zenith = Settle(Gain(now.Zenith, reference.Zenith, common, SkyBrightnessRange)),
                Horizon = Settle(Gain(HorizonMean(now), HorizonMean(reference), common, SkyBrightnessRange)),
                HorizonSunward = Settle(Gain(now.HorizonSunward, reference.HorizonSunward, common, SkyBrightnessRange)),
                Haze = Settle(Gain(
                    HazeIllumination(now, elevationDeg), HazeIllumination(reference, ReferenceSunElevationDeg),
                    common, GroundBrightnessRange)),
                Cloud = Settle(Gain(CloudIllumination(now), CloudIllumination(reference), common, CloudBrightnessRange)),
                SunDisc = Settle(Gain(now.Sunward, reference.Sunward, common, SunBrightnessRange)),
                Ground = Settle(Gain(groundNow, groundRef, common, GroundBrightnessRange)),
                Water = Settle(Gain(
                    WaterIllumination(now, elevationDeg), WaterIllumination(reference, ReferenceSunElevationDeg),
                    common, SkyBrightnessRange, WaterHueTrust)),
                DirectTint = Settle(RelativeTint(now.DirectIrradiance, reference.DirectIrradiance)),
                AmbientTint = Settle(RelativeTint(now.SkyIrradiance, reference.SkyIrradiance)),
            };
        }

        /// <summary>
        /// skyModel.ts skyFor: the sky for a sun at elevationDeg, built at the
        /// nearest multiple of 0.25 degrees and cached. Costs a few ms on a miss.
        /// </summary>
        public static SkySample SkyFor(double elevationDeg)
        {
            double key = JsMath.Round(elevationDeg / CacheQuantumDeg);
            lock (Gate)
            {
                if (Cache.TryGetValue(key, out SkySample hit))
                {
                    return hit;
                }
            }
            SkySample sample = Build(key * CacheQuantumDeg);
            lock (Gate)
            {
                if (Cache.TryGetValue(key, out SkySample raced))
                {
                    return raced;
                }
                Cache[key] = sample;
            }
            return sample;
        }

        private static double[][][] BuildDomeGrid(double sunElevationDeg)
        {
            double sunAngle = sunElevationDeg * Math.PI / 180;
            double[] sunDir = { JsTrig.Cos(sunAngle), JsTrig.Sin(sunAngle), 0 };
            double[][] msTable = Atmosphere.MultipleScatteringTable(Atmosphere.Earth, sunDir);
            var grid = new double[DomeElevationsDeg.Length][][];
            for (int i = 0; i < DomeElevationsDeg.Length; i++)
            {
                grid[i] = new double[DomeAzimuthsDeg.Length][];
                for (int j = 0; j < DomeAzimuthsDeg.Length; j++)
                {
                    double e = DomeElevationsDeg[i] * Math.PI / 180;
                    double a = DomeAzimuthsDeg[j] * Math.PI / 180;
                    double[] view = { JsTrig.Cos(e) * JsTrig.Cos(a), JsTrig.Sin(e), JsTrig.Cos(e) * JsTrig.Sin(a) };
                    grid[i][j] = Atmosphere.SkyRadiance(Atmosphere.Earth, 0, view, sunDir, msTable);
                }
            }
            return grid;
        }

        private static void DomeGridFor(double elevationDeg, out double[][][] grid, out double[][][] reference)
        {
            lock (Gate)
            {
                _domeReference ??= BuildDomeGrid(ReferenceSunElevationDeg);
                reference = _domeReference;
            }
            double key = JsMath.Round(elevationDeg / CacheQuantumDeg);
            lock (Gate)
            {
                if (DomeCache.TryGetValue(key, out grid))
                {
                    return;
                }
            }
            double[][][] built = BuildDomeGrid(key * CacheQuantumDeg);
            lock (Gate)
            {
                if (!DomeCache.TryGetValue(key, out grid))
                {
                    DomeCache[key] = built;
                    grid = built;
                }
            }
        }

        private static void Locate(double[] stops, double value, out int i0, out int i1, out double w)
        {
            if (value <= stops[0])
            {
                i0 = 0; i1 = 0; w = 0;
                return;
            }
            for (int i = 1; i < stops.Length; i++)
            {
                if (value <= stops[i])
                {
                    i0 = i - 1; i1 = i; w = (value - stops[i - 1]) / (stops[i] - stops[i - 1]);
                    return;
                }
            }
            int last = stops.Length - 1;
            i0 = last; i1 = last; w = 0;
        }

        /// <summary>
        /// skyModel.ts domeShade: the sky's absolute chroma, how far to trust it,
        /// and its brightness relative to the reference sun, for a view at
        /// viewElevationDeg and azimuthFromSunDeg (0..180, sign ignored). The
        /// grid is quantised to 0.25 degrees of sun elevation; the hue weight
        /// uses the raw sunElevationDeg.
        /// </summary>
        public static DomeShade Shade(double sunElevationDeg, double viewElevationDeg, double azimuthFromSunDeg)
        {
            DomeGridFor(sunElevationDeg, out double[][][] grid, out double[][][] reference);
            double elevation = Math.Max(DomeElevationsDeg[0], viewElevationDeg);
            Locate(DomeElevationsDeg, elevation, out int e0, out int e1, out double ew);
            Locate(DomeAzimuthsDeg, Math.Abs(azimuthFromSunDeg), out int a0, out int a1, out double aw);

            double[] Bilinear(double[][][] g)
            {
                double[] o = new double[3];
                for (int c = 0; c < 3; c++)
                {
                    double low = g[e0][a0][c] + (g[e0][a1][c] - g[e0][a0][c]) * aw;
                    double high = g[e1][a0][c] + (g[e1][a1][c] - g[e1][a0][c]) * aw;
                    o[c] = low + (high - low) * ew;
                }
                return o;
            }

            double[] now = Bilinear(grid);
            double[] then = Bilinear(reference);

            double t = Math.Min(1, Math.Max(0,
                (sunElevationDeg - HueTrustFullElevationDeg)
                / (HueTrustStartElevationDeg - HueTrustFullElevationDeg)));
            double eased = t * t * (3 - 2 * t);

            double ratio = Luminance(then) > 1e-30 ? Luminance(now) / Luminance(then) : 1;
            double total = now[0] + now[1] + now[2];
            var shade = new DomeShade
            {
                HueWeight = HueTrustMax * (1 - eased),
                Brightness = Math.Min(DomeGainRange[1], Math.Max(DomeGainRange[0], ratio)),
            };
            if (total > 1e-30)
            {
                shade.ChromaR = now[0] / total; shade.ChromaG = now[1] / total; shade.ChromaB = now[2] / total;
            }
            else
            {
                shade.ChromaR = shade.ChromaG = shade.ChromaB = 1.0 / 3;
            }
            return shade;
        }
    }
}
