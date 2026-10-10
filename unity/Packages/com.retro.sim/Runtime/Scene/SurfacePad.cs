using System;
using System.Collections.Generic;

namespace Retro.Sim
{
    /// <summary>Solid surface: an oriented rectangle, optionally sloping along its axis (port of surfacePad.ts).</summary>
    public sealed class SurfacePadCollider
    {
        /// <summary>World XZ of the pad centre.</summary>
        public double CenterX;
        public double CenterZ;
        /// <summary>Pad heading (rad); 0 = long axis aligned with +Z.</summary>
        public double Heading;
        /// <summary>Half extent along the pad axis (m).</summary>
        public double HalfLength;
        /// <summary>Half extent across the pad axis (m).</summary>
        public double HalfWidth;
        /// <summary>World Y of the surface top, at the pad centre.</summary>
        public double SurfaceY;
        /// <summary>World Y of the surrounding ground the edge skirt blends down to.</summary>
        public double BaseY;
        /// <summary>Horizontal skirt width beyond the pad edge (m).</summary>
        public double Feather;
        /// <summary>Rise in world Y per metre along the pad axis; null means level.</summary>
        public double? Slope;

        public SurfacePadCollider Clone() => (SurfacePadCollider)MemberwiseClone();
    }

    public static class SurfacePads
    {
        /// <summary>Pad surface Y at (worldX, worldZ), or -Infinity outside the footprint plus skirt.</summary>
        public static double SampleSurfacePadY(double worldX, double worldZ, SurfacePadCollider pad)
        {
            return PadY(worldX, worldZ, pad, pad.Feather);
        }

        /// <summary>Highest pad surface among colliders, or -Infinity when over none.</summary>
        public static double SampleSurfacePadYMax(double worldX, double worldZ, IReadOnlyList<SurfacePadCollider> pads)
        {
            double maxY = double.NegativeInfinity;
            for (int i = 0; i < pads.Count; i++)
            {
                double y = PadY(worldX, worldZ, pads[i], pads[i].Feather);
                if (y > maxY) maxY = y;
            }
            return maxY;
        }

        /// <summary>Highest pad surface whose own footprint (not its skirt) holds the point, or -Infinity.</summary>
        public static double SampleSurfacePadCoreYMax(double worldX, double worldZ, IReadOnlyList<SurfacePadCollider> pads)
        {
            double maxY = double.NegativeInfinity;
            for (int i = 0; i < pads.Count; i++)
            {
                double y = PadY(worldX, worldZ, pads[i], 0);
                if (y > maxY) maxY = y;
            }
            return maxY;
        }

        /// <summary>Surface Y with the skirt `feather` metres wide; 0 is the footprint alone.</summary>
        internal static double PadY(double worldX, double worldZ, SurfacePadCollider pad, double feather)
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
            if (outD > 0 && outD >= feather) return double.NegativeInfinity;
            double surfaceY = pad.SurfaceY + (pad.Slope ?? 0) * localZ;
            if (outD <= 0) return surfaceY;
            return pad.BaseY + (surfaceY - pad.BaseY) * (1 - outD / feather);
        }
    }

    /// <summary>
    /// The pads of a world, bucketed into a coarse grid so a ground query tests
    /// only the few near it. Same answers as the array functions.
    /// </summary>
    public sealed class SurfacePadIndex
    {
        /// <summary>Grid cell, metres.</summary>
        private const double PadCellM = 256;

        private readonly List<SurfacePadCollider> list = new List<SurfacePadCollider>();
        private readonly Dictionary<double, List<int>> grid = new Dictionary<double, List<int>>();

        public SurfacePadIndex(IReadOnlyList<SurfacePadCollider> pads = null)
        {
            if (pads != null) Add(pads);
        }

        private static double PadCellKey(double cx, double cz) => (cx + (1 << 20)) * (1 << 21) + (cz + (1 << 20));

        /// <summary>Every pad, in the order added.</summary>
        public IReadOnlyList<SurfacePadCollider> Pads => list;

        public int Length => list.Count;

        public void Add(IReadOnlyList<SurfacePadCollider> pads)
        {
            foreach (SurfacePadCollider pad in pads)
            {
                Push(pad);
            }
        }

        public void Push(SurfacePadCollider pad)
        {
            int i = list.Count;
            list.Add(pad);
            // Circumscribed radius of footprint plus skirt, so the cells hold the pad at any heading.
            double reach = Retro.Core.JsMath.Hypot(pad.HalfLength + pad.Feather, pad.HalfWidth + pad.Feather);
            double x0 = Math.Floor((pad.CenterX - reach) / PadCellM);
            double x1 = Math.Floor((pad.CenterX + reach) / PadCellM);
            double z0 = Math.Floor((pad.CenterZ - reach) / PadCellM);
            double z1 = Math.Floor((pad.CenterZ + reach) / PadCellM);
            for (double cx = x0; cx <= x1; cx++)
            {
                for (double cz = z0; cz <= z1; cz++)
                {
                    double k = PadCellKey(cx, cz);
                    if (grid.TryGetValue(k, out List<int> cell))
                    {
                        cell.Add(i);
                    }
                    else
                    {
                        grid[k] = new List<int> { i };
                    }
                }
            }
        }

        public void Clear()
        {
            list.Clear();
            grid.Clear();
        }

        public double SampleYMax(double worldX, double worldZ) => Sample(worldX, worldZ, true);

        public double SampleCoreYMax(double worldX, double worldZ) => Sample(worldX, worldZ, false);

        private double Sample(double worldX, double worldZ, bool skirt)
        {
            double maxY = double.NegativeInfinity;
            if (!grid.TryGetValue(PadCellKey(Math.Floor(worldX / PadCellM), Math.Floor(worldZ / PadCellM)), out List<int> cell))
            {
                return maxY;
            }
            for (int n = 0; n < cell.Count; n++)
            {
                SurfacePadCollider pad = list[cell[n]];
                double y = SurfacePads.PadY(worldX, worldZ, pad, skirt ? pad.Feather : 0);
                if (y > maxY) maxY = y;
            }
            return maxY;
        }
    }
}
