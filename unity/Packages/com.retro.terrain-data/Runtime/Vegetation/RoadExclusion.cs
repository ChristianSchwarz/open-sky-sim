using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>
    /// Keeps scattered vegetation off a tile's roads and rails (port of roadExclusion.ts): the
    /// stroke triangles' edges between distinct centreline points, bucketed on a 64 m grid; a
    /// point within the stroke's half width plus 5 m of one is excluded. Tile-local x/z metres,
    /// the frame the PTR positions are in.
    /// </summary>
    public static class RoadExclusion
    {
        /// <summary>Clear ground kept beyond the road's own half width, metres.</summary>
        public const double RoadTreeMarginM = 5;
        private const double CellM = 64;

        private static long CellKey(long cx, long cz) => (cx + 4096) * 8192 + (cz + 4096);

        /// <summary>buildRoadExclusion: a test over (x, z), or null when the tile has no stroke edges.</summary>
        public static Func<double, double, bool> Build(PtrTile ptr)
        {
            double s = ptr.QuantScale;
            short[] pos = ptr.Positions;
            ushort[] idx = ptr.Indices;
            var segs = new List<double>(); // ax, az, bx, bz, reach
            var seen = new HashSet<long>();
            for (int i = 0; i + 2 < idx.Length; i += 3)
            {
                for (int e = 0; e < 3; e++)
                {
                    int a = idx[i + e];
                    int b = idx[i + (e + 1) % 3];
                    bool same = pos[a * 3] == pos[b * 3] && pos[a * 3 + 1] == pos[b * 3 + 1] && pos[a * 3 + 2] == pos[b * 3 + 2];
                    long key = a < b ? (long)a * 65536 + b : (long)b * 65536 + a;
                    // The TS `!seen.add(key)` never skips (Set.add returns the set), so it keeps
                    // shared edges twice; skipping them here gives the same answers with less work.
                    if (same || !seen.Add(key)) continue;
                    double reach = Math.Max(ptr.HalfWidths[a], ptr.HalfWidths[b]) / 10.0 + RoadTreeMarginM;
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
                    double ax = sg[i], az = sg[i + 1];
                    double dx = sg[i + 2] - ax, dz = sg[i + 3] - az;
                    double len2 = dx * dx + dz * dz;
                    double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
                    double px = ax + dx * t - x, pz = az + dz * t - z;
                    double r = sg[i + 4];
                    if (px * px + pz * pz < r * r) return true;
                }
                return false;
            };
        }
    }
}
