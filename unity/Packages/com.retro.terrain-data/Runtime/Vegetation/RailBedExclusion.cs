using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Keeps scattered vegetation off a tile's graded road and rail beds and their batters (port
    /// of railBed.ts buildRailBedExclusion, planFrame and bedSegmentParam). Beds come from the
    /// .pbd sidecar (<see cref="PbdTile.Beds"/>); points are tile-local (x, y, z) metres, measured
    /// in the plane across the tile's real vertical.
    /// </summary>
    public static class RailBedExclusion
    {
        /// <summary>RAIL_SHOULDER_M: bed beyond the track's half width kept at track height.</summary>
        public const double ShoulderM = 0.8;
        /// <summary>RAIL_BATTER: metres of height per metre sideways.</summary>
        public const double Batter = 0.5;
        /// <summary>RAIL_BATTER_REACH_M: farthest a batter is carried from the bed's edge.</summary>
        public const double BatterReachM = 30;
        /// <summary>SCATTER_MARGIN_M: clear ground beyond the batter's toe.</summary>
        public const double ScatterMarginM = 3;
        public const int BedOpenA = 1;
        public const int BedOpenB = 2;
        /// <summary>CELL_M at the leaf level; terrainEntity.ts doubles it per level above.</summary>
        public const double LeafCellM = 32;

        private static long CellKey(long cu, long cv) => (cu + 32768) * 65536 + (cv + 32768);

        /// <summary>
        /// terrainEntity.ts loadBeds: the real vertical at the tile's lon/lat centre in the bake
        /// frame's axes (x east, y up, z south), which the tile's offsets are in.
        /// </summary>
        public static Vec3d TileUp(EnuBasis bakeBasis, TileKey id)
        {
            LonLatBounds b = Tiling.Bounds(id);
            double lat = (b.South + b.North) / 2, lon = (b.West + b.East) / 2;
            Enu e0 = Geodesy.EcefToEnu(bakeBasis, Geodesy.GeodeticToEcef(lat, lon, 0));
            Enu e1 = Geodesy.EcefToEnu(bakeBasis, Geodesy.GeodeticToEcef(lat, lon, 1000));
            return new Vec3d((e1.E - e0.E) / 1000, (e1.U - e0.U) / 1000, -(e1.N - e0.N) / 1000);
        }

        /// <summary>The grid cell terrainEntity.ts uses for a tile at zoom z: 32 m at the leaf, doubling per level up.</summary>
        public static double CellMFor(int z, int maxZoom) => LeafCellM * Math.Pow(2, Math.Max(0, maxZoom - z));

        /// <summary>bedSegmentParam: where along a segment a point projects, clamped, or null past an open end.</summary>
        public static double? SegmentParam(double pu, double pv, double du, double dv, int open)
        {
            double l2 = du * du + dv * dv;
            if (l2 <= 1e-12) return open != 0 ? (double?)null : 0;
            double t = (pu * du + pv * dv) / l2;
            if ((t < 0 && (open & BedOpenA) != 0) || (t > 1 && (open & BedOpenB) != 0)) return null;
            return Math.Min(1, Math.Max(0, t));
        }

        /// <summary>planFrame: two horizontal axes and the unit up for a vertical.</summary>
        public static (Vec3d A, Vec3d B, Vec3d Up) PlanFrame(Vec3d up)
        {
            double n = JsMath.Hypot(up.X, up.Y, up.Z);
            double ux = up.X / n, uy = up.Y / n, uz = up.Z / n;
            double hx, hy, hz;
            if (Math.Abs(uz) < 0.9) { hx = 0; hy = 0; hz = 1; } else { hx = 1; hy = 0; hz = 0; }
            double d = hx * ux + hy * uy + hz * uz;
            double ax = hx - ux * d, ay = hy - uy * d, az = hz - uz * d;
            double al = JsMath.Hypot(ax, ay, az);
            ax /= al; ay /= al; az /= al;
            var b = new Vec3d(uy * az - uz * ay, uz * ax - ux * az, ux * ay - uy * ax);
            return (new Vec3d(ax, ay, az), b, new Vec3d(ux, uy, uz));
        }

        /// <summary>
        /// buildRailBedExclusion: a test over tile-local (x, y, z), or null for a tile without
        /// beds. <paramref name="beds"/> is <see cref="PbdTile.Beds"/>, <paramref name="up"/>
        /// <see cref="TileUp"/>, <paramref name="cellM"/> <see cref="CellMFor"/>.
        /// </summary>
        public static Func<double, double, double, bool> Build(double[] beds, Vec3d up, double cellM = LeafCellM)
        {
            int n = beds.Length / PbdCodec.SegmentFloats;
            if (n == 0) return null;
            var (fa, fb, _) = PlanFrame(up);
            double a0 = fa.X, a1 = fa.Y, a2 = fa.Z, b0 = fb.X, b1 = fb.Y, b2 = fb.Z;
            var segs = new double[n * 6]; // ua, va, ub, vb, reach, open
            var cells = new Dictionary<long, List<int>>();
            for (int i = 0; i < n; i++)
            {
                int o = i * PbdCodec.SegmentFloats;
                double ua = beds[o] * a0 + beds[o + 1] * a1 + beds[o + 2] * a2;
                double va = beds[o] * b0 + beds[o + 1] * b1 + beds[o + 2] * b2;
                double ub = beds[o + 3] * a0 + beds[o + 4] * a1 + beds[o + 5] * a2;
                double vb = beds[o + 3] * b0 + beds[o + 4] * b1 + beds[o + 5] * b2;
                double reach = beds[o + 6] + ShoulderM + Math.Min(BatterReachM, beds[o + 7] / Batter) + ScatterMarginM;
                segs[i * 6] = ua;
                segs[i * 6 + 1] = va;
                segs[i * 6 + 2] = ub;
                segs[i * 6 + 3] = vb;
                segs[i * 6 + 4] = reach;
                segs[i * 6 + 5] = beds[o + 8];
                long u0 = (long)Math.Floor((Math.Min(ua, ub) - reach) / cellM), u1 = (long)Math.Floor((Math.Max(ua, ub) + reach) / cellM);
                long v0 = (long)Math.Floor((Math.Min(va, vb) - reach) / cellM), v1 = (long)Math.Floor((Math.Max(va, vb) + reach) / cellM);
                for (long cu = u0; cu <= u1; cu++)
                {
                    for (long cv = v0; cv <= v1; cv++)
                    {
                        long key = CellKey(cu, cv);
                        if (!cells.TryGetValue(key, out List<int> list)) cells[key] = list = new List<int>();
                        list.Add(i);
                    }
                }
            }
            return (x, y, z) =>
            {
                double u = x * a0 + y * a1 + z * a2;
                double v = x * b0 + y * b1 + z * b2;
                if (!cells.TryGetValue(CellKey((long)Math.Floor(u / cellM), (long)Math.Floor(v / cellM)), out List<int> list)) return false;
                foreach (int i in list)
                {
                    int o = i * 6;
                    double du = segs[o + 2] - segs[o], dv = segs[o + 3] - segs[o + 1];
                    double? t = SegmentParam(u - segs[o], v - segs[o + 1], du, dv, (int)segs[o + 5]);
                    if (t != null && JsMath.Hypot(u - segs[o] - du * t.Value, v - segs[o + 1] - dv * t.Value) < segs[o + 4]) return true;
                }
                return false;
            };
        }
    }
}
