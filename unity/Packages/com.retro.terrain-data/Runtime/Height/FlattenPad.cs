using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// An airfield platform the ground is flattened to: an oriented, optionally
    /// sloped rectangle in ENU metres with a smoothstep feather (flattenPad.ts).
    /// Axis/gradient are null on records baked before pads could turn.
    /// </summary>
    public sealed class FlattenPad
    {
        public double CenterX;
        public double CenterZ;
        public double HalfW;
        public double HalfD;
        public double FeatherM;
        public double HeightMsl;
        public double? AxisE;
        public double? AxisN;
        public double? GradE;
        public double? GradN;
    }

    /// <summary>The geodetic manifest record a pad is built from.</summary>
    public sealed class FlattenPadRecord
    {
        public double Lat;
        public double Lon;
        public double HalfW;
        public double HalfD;
        public double FeatherM;
        public double HeightMsl;
        public double? HeadingDeg;
        public double? Gradient;
        public double? GradientHeadingDeg;
        public string Icao;
    }

    public static class FlattenPads
    {
        private const double AxisProbeM = 1000;

        public static (double E, double N) AxisFromHeading(double headingDeg)
        {
            double r = headingDeg * Math.PI / 180;
            return (JsTrig.Sin(r), JsTrig.Cos(r));
        }

        public static (double E, double N) AxisTowards(double centerE, double centerN, double aheadE, double aheadN)
        {
            double de = aheadE - centerE, dn = aheadN - centerN;
            double len = JsMath.Hypot(de, dn);
            return len > 1e-6 ? (de / len, dn / len) : (0, 1);
        }

        /// <summary>Along the pad axis and across it (the axis turned 90 degrees right).</summary>
        public static (double Along, double Across) Local(double e, double n, FlattenPad pad)
        {
            double de = e - pad.CenterX, dn = n - pad.CenterZ;
            double ae = pad.AxisE ?? 0, an = pad.AxisN ?? 1;
            return (de * ae + dn * an, de * an - dn * ae);
        }

        /// <summary>1 on the core, smoothstep down to 0 across the feather (at most half the pad).</summary>
        public static double BlendWeight(double e, double n, FlattenPad pad)
        {
            double feather = Math.Min(Math.Max(1, pad.FeatherM), Math.Max(1, Math.Min(pad.HalfW, pad.HalfD) * 0.5));
            double coreW = Math.Max(0, pad.HalfW - feather);
            double coreD = Math.Max(0, pad.HalfD - feather);
            var local = Local(e, n, pad);
            double dx = Math.Abs(local.Across), dz = Math.Abs(local.Along);
            if (dx >= pad.HalfW || dz >= pad.HalfD) return 0;
            if (dx <= coreW && dz <= coreD) return 1;
            double tx = dx <= coreW ? 1 : 1 - (dx - coreW) / feather;
            double tz = dz <= coreD ? 1 : 1 - (dz - coreD) / feather;
            double t = Math.Max(0, Math.Min(1, Math.Min(tx, tz)));
            return t * t * (3 - 2 * t);
        }

        public static double SurfaceHeight(double e, double n, FlattenPad pad)
        {
            double gradE = pad.GradE ?? 0, gradN = pad.GradN ?? 0;
            if (gradE == 0 && gradN == 0) return pad.HeightMsl;
            return pad.HeightMsl + gradE * (e - pad.CenterX) + gradN * (n - pad.CenterZ);
        }

        public static (double E, double N) GradientFromHeading(double gradient, double headingDeg)
        {
            var axis = AxisFromHeading(headingDeg);
            return (gradient * axis.E, gradient * axis.N);
        }

        /// <summary>Blend `height` toward the pad surface; a non-finite height takes the surface outright.</summary>
        public static double Apply(double height, double e, double n, FlattenPad pad)
        {
            if (double.IsNaN(pad.HeightMsl) || double.IsInfinity(pad.HeightMsl)) return height;
            double w = BlendWeight(e, n, pad);
            if (w <= 0) return height;
            double target = SurfaceHeight(e, n, pad);
            double baseH = double.IsNaN(height) || double.IsInfinity(height) ? target : height;
            return baseH + (target - baseH) * w;
        }

        private static (double Lat, double Lon) MetresPerDegree(double latDeg)
        {
            double lat = latDeg * Math.PI / 180;
            return (111132.92 - 559.82 * JsTrig.Cos(2 * lat) + 1.175 * JsTrig.Cos(4 * lat),
                111412.84 * JsTrig.Cos(lat) - 93.5 * JsTrig.Cos(3 * lat));
        }

        /// <summary>A bearing turned into an ENU axis by probing 1 km ahead (meridian convergence).</summary>
        public static (double E, double N) BearingAxisAt(double lat, double lon, double bearingDeg,
            Func<double, double, (double E, double N)> toEnu)
        {
            var centre = toEnu(lat, lon);
            var perDeg = MetresPerDegree(lat);
            double r = bearingDeg * Math.PI / 180;
            var ahead = toEnu(
                lat + (AxisProbeM * JsTrig.Cos(r)) / perDeg.Lat,
                lon + (AxisProbeM * JsTrig.Sin(r)) / Math.Max(1, perDeg.Lon));
            return AxisTowards(centre.E, centre.N, ahead.E, ahead.N);
        }

        public static FlattenPad FromRecord(FlattenPadRecord p, Func<double, double, (double E, double N)> toEnu)
        {
            var centre = toEnu(p.Lat, p.Lon);
            var pad = new FlattenPad
            {
                CenterX = centre.E,
                CenterZ = centre.N,
                HalfW = p.HalfW,
                HalfD = p.HalfD,
                FeatherM = p.FeatherM,
                HeightMsl = p.HeightMsl,
            };
            // A record from before pads could turn keeps no axis, so old pyramids reproduce exactly.
            if (p.HeadingDeg == null && p.Gradient == null) return pad;
            double heading = p.HeadingDeg ?? 0;
            var axis = BearingAxisAt(p.Lat, p.Lon, heading, toEnu);
            double gradient = p.Gradient ?? 0;
            var rise = gradient == 0 ? (0.0, 0.0) : BearingAxisAt(p.Lat, p.Lon, p.GradientHeadingDeg ?? heading, toEnu);
            pad.AxisE = axis.E;
            pad.AxisN = axis.N;
            pad.GradE = gradient * rise.Item1;
            pad.GradN = gradient * rise.Item2;
            return pad;
        }

        public static double ReachM(FlattenPad pad) => JsMath.Hypot(pad.HalfD + pad.FeatherM, pad.HalfW + pad.FeatherM);
    }

    /// <summary>Pads bucketed in 2 km cells so a height read tests only nearby pads; order within a cell is list order.</summary>
    public sealed class PadGrid
    {
        private const double CellM = 2000;
        private readonly Dictionary<long, List<FlattenPad>> cells = new Dictionary<long, List<FlattenPad>>();

        public PadGrid(IEnumerable<FlattenPad> pads)
        {
            foreach (FlattenPad pad in pads)
            {
                double reach = FlattenPads.ReachM(pad);
                if (!IsFinite(reach) || !IsFinite(pad.CenterX) || !IsFinite(pad.CenterZ)) continue;
                long x0 = (long)Math.Floor((pad.CenterX - reach) / CellM);
                long x1 = (long)Math.Floor((pad.CenterX + reach) / CellM);
                long z0 = (long)Math.Floor((pad.CenterZ - reach) / CellM);
                long z1 = (long)Math.Floor((pad.CenterZ + reach) / CellM);
                for (long cx = x0; cx <= x1; cx++)
                {
                    for (long cz = z0; cz <= z1; cz++)
                    {
                        long key = Key(cx, cz);
                        if (!cells.TryGetValue(key, out List<FlattenPad> cell))
                        {
                            cell = new List<FlattenPad>();
                            cells[key] = cell;
                        }
                        cell.Add(pad);
                    }
                }
            }
        }

        private static bool IsFinite(double v) => !double.IsNaN(v) && !double.IsInfinity(v);

        private static long Key(long cx, long cz) => (cx + 1048576) * 2097152 + (cz + 1048576);

        /// <summary>The pads whose reach touches the cell of (e, n), or null.</summary>
        public IReadOnlyList<FlattenPad> At(double e, double n)
        {
            return cells.TryGetValue(Key((long)Math.Floor(e / CellM), (long)Math.Floor(n / CellM)), out List<FlattenPad> c) ? c : null;
        }
    }
}
