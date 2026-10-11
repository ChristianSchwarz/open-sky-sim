using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Whether a point of a tile stands inside one of its buildings, for the
    /// tree and stone scatter (src/script/terrain/buildingExclusion.ts; the
    /// web game builds one per drawn leaf in terrainEntity.ts attachTrees and
    /// ORs it with the road, man-made and rail-bed masks). Points come in the
    /// tile's own axes, in metres. Footprints are bucketed on a 64 m grid of
    /// the PBH1 (u, v) frame and tested by ray crossing, with a margin so a
    /// crown does not overhang a wall. Immutable once built: safe to query
    /// from any thread.
    /// </summary>
    public sealed class BuildingExclusion
    {
        private const double CellM = 64;
        /// <summary>A scatter point closer than this to a wall counts as inside.</summary>
        public const double TreeMarginM = 2;

        private sealed class Footprint
        {
            public List<(double U, double V)[]> Rings;
            public double MinU, MinV, MaxU, MaxV;
        }

        private readonly Dictionary<long, List<Footprint>> _grid;
        private readonly Vec3d _a, _b;
        private readonly double _margin;

        private BuildingExclusion(Dictionary<long, List<Footprint>> grid, Vec3d a, Vec3d b, double margin)
        {
            _grid = grid;
            _a = a;
            _b = b;
            _margin = margin;
        }

        private static long Key(long cu, long cv) => cu * 65536 + cv;

        /// <summary>buildBuildingExclusion: null when the tile has no buildings.</summary>
        public static BuildingExclusion Build(PbhTile tile, double margin = TreeMarginM)
        {
            if (tile.Buildings.Count == 0)
            {
                return null;
            }
            var grid = new Dictionary<long, List<Footprint>>();
            foreach (PbhBuilding b in tile.Buildings)
            {
                List<(double U, double V)[]> rings = PbhRings.Of(tile, b);
                double minU = double.PositiveInfinity, minV = double.PositiveInfinity;
                double maxU = double.NegativeInfinity, maxV = double.NegativeInfinity;
                if (rings.Count > 0)
                {
                    foreach (var (u, v) in rings[0])
                    {
                        minU = Math.Min(minU, u);
                        maxU = Math.Max(maxU, u);
                        minV = Math.Min(minV, v);
                        maxV = Math.Max(maxV, v);
                    }
                }
                if (double.IsInfinity(minU) || double.IsNaN(minU))
                {
                    continue;
                }
                var fp = new Footprint { Rings = rings, MinU = minU - margin, MinV = minV - margin, MaxU = maxU + margin, MaxV = maxV + margin };
                for (long cu = (long)Math.Floor(fp.MinU / CellM); cu <= (long)Math.Floor(fp.MaxU / CellM); cu++)
                {
                    for (long cv = (long)Math.Floor(fp.MinV / CellM); cv <= (long)Math.Floor(fp.MaxV / CellM); cv++)
                    {
                        long k = Key(cu, cv);
                        if (grid.TryGetValue(k, out List<Footprint> list))
                        {
                            list.Add(fp);
                        }
                        else
                        {
                            grid[k] = new List<Footprint> { fp };
                        }
                    }
                }
            }
            return new BuildingExclusion(grid, tile.Frame.A, tile.Frame.B, margin);
        }

        /// <summary>Whether (x, y, z), in the tile's axes in metres, is inside a building or within the margin of a wall.</summary>
        public bool Contains(double x, double y, double z)
        {
            double u = x * _a.X + y * _a.Y + z * _a.Z;
            double v = x * _b.X + y * _b.Y + z * _b.Z;
            if (!_grid.TryGetValue(Key((long)Math.Floor(u / CellM), (long)Math.Floor(v / CellM)), out List<Footprint> list))
            {
                return false;
            }
            foreach (Footprint fp in list)
            {
                if (u < fp.MinU || u > fp.MaxU || v < fp.MinV || v > fp.MaxV)
                {
                    continue;
                }
                if (InsideRings(fp.Rings, u, v) || (_margin > 0 && NearRings(fp.Rings, u, v, _margin)))
                {
                    return true;
                }
            }
            return false;
        }

        private static bool InsideRings(List<(double U, double V)[]> rings, double u, double v)
        {
            bool inside = false;
            foreach (var ring in rings)
            {
                for (int i = 0, j = ring.Length - 1; i < ring.Length; j = i++)
                {
                    var (ui, vi) = ring[i];
                    var (uj, vj) = ring[j];
                    if ((vi > v) != (vj > v) && u < (uj - ui) * (v - vi) / (vj - vi) + ui)
                    {
                        inside = !inside;
                    }
                }
            }
            return inside;
        }

        private static bool NearRings(List<(double U, double V)[]> rings, double u, double v, double margin)
        {
            double m2 = margin * margin;
            foreach (var ring in rings)
            {
                for (int i = 0, j = ring.Length - 1; i < ring.Length; j = i++)
                {
                    var (ax, ay) = ring[j];
                    var (bx, by) = ring[i];
                    double ex = bx - ax, ey = by - ay;
                    double len2 = ex * ex + ey * ey;
                    double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((u - ax) * ex + (v - ay) * ey) / len2)) : 0;
                    double dx = ax + ex * t - u, dy = ay + ey * t - v;
                    if (dx * dx + dy * dy <= m2)
                    {
                        return true;
                    }
                }
            }
            return false;
        }
    }
}
