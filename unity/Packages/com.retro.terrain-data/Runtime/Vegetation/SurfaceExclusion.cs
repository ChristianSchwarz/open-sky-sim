using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// A solid surface the game places itself (surfacePad.ts <c>SurfacePadCollider</c>, the
    /// fields the vegetation mask reads): an oriented rectangle in scene x/z with a feather skirt.
    /// </summary>
    public sealed class SurfaceExclusionPad
    {
        public double CenterX;
        public double CenterZ;
        /// <summary>Radians; 0 = long axis along +Z.</summary>
        public double Heading;
        public double HalfLength;
        public double HalfWidth;
        public double SurfaceY;
        public double BaseY;
        public double Feather;
        public double? Slope;
    }

    /// <summary>
    /// Keeps scattered vegetation off the game's own pavement and footprints (port of
    /// surfaceExclusion.ts): a point counts when sampleSurfacePadY of any pad (skirt included)
    /// is finite there. Scene x/z, bucketed on a 64 m grid.
    /// </summary>
    public static class SurfaceExclusion
    {
        private const double CellM = 64;

        private static long CellKey(long cx, long cz) => (cx + (1L << 20)) * (1L << 21) + (cz + (1L << 20));

        /// <summary>surfacePad.ts padY with the pad's own feather.</summary>
        public static double SamplePadY(double worldX, double worldZ, SurfaceExclusionPad pad)
        {
            double cos = JsTrig.Cos(pad.Heading);
            double sin = JsTrig.Sin(pad.Heading);
            double dx = worldX - pad.CenterX;
            double dz = worldZ - pad.CenterZ;
            double localX = dx * cos - dz * sin;
            double localZ = dx * sin + dz * cos;
            double outX = Math.Abs(localX) - pad.HalfWidth;
            double outZ = Math.Abs(localZ) - pad.HalfLength;
            double outD = Math.Max(outX, outZ);
            double feather = pad.Feather;
            if (outD > 0 && outD >= feather) return double.NegativeInfinity;
            double surfaceY = pad.SurfaceY + (pad.Slope ?? 0) * localZ;
            if (outD <= 0) return surfaceY;
            return pad.BaseY + (surfaceY - pad.BaseY) * (1 - outD / feather);
        }

        /// <summary>buildSurfaceExclusion: one test over scene (x, z), or null without pads. The pads are copied.</summary>
        public static Func<double, double, bool> Build(IReadOnlyList<SurfaceExclusionPad> live)
        {
            if (live.Count == 0) return null;
            var pads = new SurfaceExclusionPad[live.Count];
            var grid = new Dictionary<long, List<int>>();
            for (int i = 0; i < live.Count; i++)
            {
                SurfaceExclusionPad p = live[i];
                var pad = pads[i] = new SurfaceExclusionPad
                {
                    CenterX = p.CenterX, CenterZ = p.CenterZ, Heading = p.Heading, HalfLength = p.HalfLength, HalfWidth = p.HalfWidth,
                    SurfaceY = p.SurfaceY, BaseY = p.BaseY, Feather = p.Feather, Slope = p.Slope,
                };
                double reach = JsMath.Hypot(pad.HalfLength + pad.Feather, pad.HalfWidth + pad.Feather);
                long x0 = (long)Math.Floor((pad.CenterX - reach) / CellM), x1 = (long)Math.Floor((pad.CenterX + reach) / CellM);
                long z0 = (long)Math.Floor((pad.CenterZ - reach) / CellM), z1 = (long)Math.Floor((pad.CenterZ + reach) / CellM);
                for (long cx = x0; cx <= x1; cx++)
                {
                    for (long cz = z0; cz <= z1; cz++)
                    {
                        long k = CellKey(cx, cz);
                        if (!grid.TryGetValue(k, out List<int> list)) grid[k] = list = new List<int>();
                        list.Add(i);
                    }
                }
            }
            return (x, z) =>
            {
                if (!grid.TryGetValue(CellKey((long)Math.Floor(x / CellM), (long)Math.Floor(z / CellM)), out List<int> list)) return false;
                foreach (int i in list)
                {
                    if (SamplePadY(x, z, pads[i]) > double.NegativeInfinity) return true;
                }
                return false;
            };
        }
    }
}
