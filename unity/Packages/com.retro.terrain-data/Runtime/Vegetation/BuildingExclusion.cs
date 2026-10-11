using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>
    /// Whether a scatter point stands in (or within 2 m of) one of a tile's buildings (port of
    /// buildingExclusion.ts). Points are tile-local (x, y, z) metres; they go into the PBH1
    /// frame's (u, v) by its A and B axes, footprints are bucketed on a 64 m grid and tested by ray
    /// crossing over all rings plus a distance-to-edge margin.
    /// </summary>
    public static class BuildingExclusion
    {
        /// <summary>A scatter point closer than this to a wall counts as inside.</summary>
        public const double BuildingTreeMarginM = 2;
        private const double CellM = 64;

        private sealed class Footprint
        {
            public double[][] Rings; // per ring: u0, v0, u1, v1, ...
            public double MinU, MinV, MaxU, MaxV;
        }

        private static long Key(long cu, long cv) => cu * 65536 + cv;

        private static bool InsideRings(double[][] rings, double u, double v)
        {
            bool inside = false;
            foreach (double[] ring in rings)
            {
                int n = ring.Length / 2;
                for (int i = 0, j = n - 1; i < n; j = i++)
                {
                    double ui = ring[i * 2], vi = ring[i * 2 + 1], uj = ring[j * 2], vj = ring[j * 2 + 1];
                    if ((vi > v) != (vj > v) && u < (uj - ui) * (v - vi) / (vj - vi) + ui) inside = !inside;
                }
            }
            return inside;
        }

        private static bool NearRings(double[][] rings, double u, double v, double margin)
        {
            double m2 = margin * margin;
            foreach (double[] ring in rings)
            {
                int n = ring.Length / 2;
                for (int i = 0, j = n - 1; i < n; j = i++)
                {
                    double ax = ring[j * 2], ay = ring[j * 2 + 1], bx = ring[i * 2], by = ring[i * 2 + 1];
                    double ex = bx - ax, ey = by - ay;
                    double len2 = ex * ex + ey * ey;
                    double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((u - ax) * ex + (v - ay) * ey) / len2)) : 0;
                    double dx = ax + ex * t - u, dy = ay + ey * t - v;
                    if (dx * dx + dy * dy <= m2) return true;
                }
            }
            return false;
        }

        /// <summary>pbhRings: a building's rings as (u, v) pairs.</summary>
        public static double[][] Rings(PbhTile tile, PbhBuilding b)
        {
            var rings = new double[b.RingCount][];
            int v = b.FirstVert;
            for (int r = 0; r < b.RingCount; r++)
            {
                int n = tile.RingSizes[b.FirstRing + r];
                var ring = new double[n * 2];
                for (int k = 0; k < n; k++, v++)
                {
                    ring[k * 2] = tile.Verts[v * 2];
                    ring[k * 2 + 1] = tile.Verts[v * 2 + 1];
                }
                rings[r] = ring;
            }
            return rings;
        }

        /// <summary>buildBuildingExclusion: a test over tile-local (x, y, z), or null for a tile without buildings.</summary>
        public static Func<double, double, double, bool> Build(PbhTile tile, double margin = BuildingTreeMarginM)
        {
            if (tile.Buildings.Count == 0) return null;
            var grid = new Dictionary<long, List<Footprint>>();
            foreach (PbhBuilding b in tile.Buildings)
            {
                double[][] rings = Rings(tile, b);
                double minU = double.PositiveInfinity, minV = double.PositiveInfinity;
                double maxU = double.NegativeInfinity, maxV = double.NegativeInfinity;
                if (rings.Length > 0)
                {
                    double[] outer = rings[0];
                    for (int k = 0; k < outer.Length; k += 2)
                    {
                        minU = Math.Min(minU, outer[k]); maxU = Math.Max(maxU, outer[k]);
                        minV = Math.Min(minV, outer[k + 1]); maxV = Math.Max(maxV, outer[k + 1]);
                    }
                }
                if (double.IsInfinity(minU) || double.IsNaN(minU)) continue;
                var fp = new Footprint { Rings = rings, MinU = minU - margin, MinV = minV - margin, MaxU = maxU + margin, MaxV = maxV + margin };
                for (long cu = (long)Math.Floor(fp.MinU / CellM); cu <= (long)Math.Floor(fp.MaxU / CellM); cu++)
                {
                    for (long cv = (long)Math.Floor(fp.MinV / CellM); cv <= (long)Math.Floor(fp.MaxV / CellM); cv++)
                    {
                        long k = Key(cu, cv);
                        if (!grid.TryGetValue(k, out List<Footprint> list)) grid[k] = list = new List<Footprint>();
                        list.Add(fp);
                    }
                }
            }
            double a0 = tile.Frame.A.X, a1 = tile.Frame.A.Y, a2 = tile.Frame.A.Z;
            double b0 = tile.Frame.B.X, b1 = tile.Frame.B.Y, b2 = tile.Frame.B.Z;
            return (x, y, z) =>
            {
                double u = x * a0 + y * a1 + z * a2;
                double v = x * b0 + y * b1 + z * b2;
                if (!grid.TryGetValue(Key((long)Math.Floor(u / CellM), (long)Math.Floor(v / CellM)), out List<Footprint> list)) return false;
                foreach (Footprint fp in list)
                {
                    if (u < fp.MinU || u > fp.MaxU || v < fp.MinV || v > fp.MaxV) continue;
                    if (InsideRings(fp.Rings, u, v) || (margin > 0 && NearRings(fp.Rings, u, v, margin))) return true;
                }
                return false;
            };
        }
    }
}
