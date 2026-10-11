using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>
    /// Keeps scattered trees off roads (src/script/terrain/roadExclusion.ts).
    /// Built from a tile's decoded road sidecar: every edge of the stroke
    /// triangles that joins two distinct positions goes in a 64 m grid, and a
    /// point is rejected when it lies within the road's half-width plus 5 m of
    /// one. Coordinates are tile-local metres in the sidecar's (bake) axes:
    /// x east, z south, the frame a scatter point is in, so no conversion.
    ///
    /// The oracle's de-duplication of shared edges never takes effect (it tests
    /// the truthiness of <c>Set.add</c>, which returns the set), so every edge is
    /// kept, shared ones twice; the answers are the same either way and this
    /// keeps the grid lists identical.
    /// </summary>
    public sealed class RoadExclusion
    {
        /// <summary>Clear ground kept beyond the road's own half-width, metres (a tree's canopy is ~5 m half-width).</summary>
        public const double TreeMarginM = 5;
        public const double CellM = 64;

        /// <summary>ax, az, bx, bz, reach per segment.</summary>
        private readonly double[] _segs;
        private readonly Dictionary<long, List<int>> _grid;

        private RoadExclusion(double[] segs, Dictionary<long, List<int>> grid)
        {
            _segs = segs;
            _grid = grid;
        }

        public int SegmentCount => _segs.Length / 5;

        private static long CellKey(long cx, long cz) => (cx + 4096) * 8192 + (cz + 4096);

        /// <summary>The mask for a tile, or null when its sidecar has no segments (roadExclusion.ts buildRoadExclusion).</summary>
        public static RoadExclusion Build(PtrTile ptr)
        {
            double s = ptr.QuantScale;
            short[] pos = ptr.Positions;
            ushort[] idx = ptr.Indices;
            var segs = new List<double>();
            for (int i = 0; i + 2 < idx.Length; i += 3)
            {
                for (int e = 0; e < 3; e++)
                {
                    int a = idx[i + e];
                    int b = idx[i + (e + 1) % 3];
                    if (pos[a * 3] == pos[b * 3] && pos[a * 3 + 1] == pos[b * 3 + 1] && pos[a * 3 + 2] == pos[b * 3 + 2]) continue;
                    double reach = Math.Max(ptr.HalfWidths[a], ptr.HalfWidths[b]) / 10.0 + TreeMarginM;
                    segs.Add(pos[a * 3] * s);
                    segs.Add(pos[a * 3 + 2] * s);
                    segs.Add(pos[b * 3] * s);
                    segs.Add(pos[b * 3 + 2] * s);
                    segs.Add(reach);
                }
            }
            if (segs.Count == 0) return null;
            double[] sg = segs.ToArray();
            var grid = new Dictionary<long, List<int>>();
            for (int i = 0; i < sg.Length; i += 5)
            {
                double r = sg[i + 4];
                long x0 = (long)Math.Floor((Math.Min(sg[i], sg[i + 2]) - r) / CellM);
                long x1 = (long)Math.Floor((Math.Max(sg[i], sg[i + 2]) + r) / CellM);
                long z0 = (long)Math.Floor((Math.Min(sg[i + 1], sg[i + 3]) - r) / CellM);
                long z1 = (long)Math.Floor((Math.Max(sg[i + 1], sg[i + 3]) + r) / CellM);
                for (long cx = x0; cx <= x1; cx++)
                {
                    for (long cz = z0; cz <= z1; cz++)
                    {
                        long k = CellKey(cx, cz);
                        if (grid.TryGetValue(k, out List<int> list)) list.Add(i);
                        else grid.Add(k, new List<int> { i });
                    }
                }
            }
            return new RoadExclusion(sg, grid);
        }

        /// <summary>Whether a point (tile-local metres) is on or beside a road.</summary>
        public bool Test(double x, double z)
        {
            if (!_grid.TryGetValue(CellKey((long)Math.Floor(x / CellM), (long)Math.Floor(z / CellM)), out List<int> list)) return false;
            double[] segs = _segs;
            foreach (int i in list)
            {
                double ax = segs[i], az = segs[i + 1];
                double dx = segs[i + 2] - ax, dz = segs[i + 3] - az;
                double len2 = dx * dx + dz * dz;
                double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
                double px = ax + dx * t - x, pz = az + dz * t - z;
                double r = segs[i + 4];
                if (px * px + pz * pz < r * r) return true;
            }
            return false;
        }
    }
}
