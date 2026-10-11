using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>The parts of an airfields.json item the vegetation mask reads (airfields.ts <c>Airfield</c>).</summary>
    public sealed class AirfieldFootprint
    {
        /// <summary>plane.heightMsl: the ellipsoid height the pavement is laid at.</summary>
        public double PlaneHeightMsl;
        public List<RunwayFootprint> Runways = new List<RunwayFootprint>();
        public List<TaxiwayFootprint> Taxiways = new List<TaxiwayFootprint>();
        /// <summary>Apron rings, each a list of [lat, lon].</summary>
        public List<double[][]> Aprons = new List<double[][]>();
    }

    public sealed class RunwayFootprint
    {
        public double Lat;
        public double Lon;
        public double HeadingDeg;
        public double LengthM;
        public double WidthM;
    }

    public sealed class TaxiwayFootprint
    {
        public double WidthM;
        /// <summary>Centreline points, each [lat, lon].</summary>
        public double[][] Points;
    }

    /// <summary>
    /// Keeps scattered vegetation off an area's runways (plus 25 m beside and 500 m beyond each
    /// end), taxiways and aprons (plus 5 m) - port of airfieldExclusion.ts. Built once per area in
    /// scene x/z (+X east, +Z south from the play origin); a tile-local scatter point is moved into
    /// the scene first (<see cref="VegetationExclusion.ForTile"/>).
    /// </summary>
    public static class AirfieldExclusion
    {
        public const double RunwaySideTreeMarginM = 25;
        public const double RunwayEndTreeMarginM = 500;
        public const double ApronTreeMarginM = 5;
        private const double CellM = 64;

        private struct Rect
        {
            public double Cx, Cz, Ax, Az, HalfLen, HalfWid;
        }

        private struct Segment
        {
            public double Ax, Az, Bx, Bz, R;
        }

        private sealed class Ring
        {
            public double[] Points; // x0, z0, x1, z1, ...
            public double MinX, MaxX, MinZ, MaxZ;
        }

        private static long CellKey(long cx, long cz) => (cx + (1L << 20)) * (1L << 21) + (cz + (1L << 20));

        private static bool RectHit(in Rect r, double x, double z)
        {
            double dx = x - r.Cx, dz = z - r.Cz;
            double along = dx * r.Ax + dz * r.Az;
            double across = -dx * r.Az + dz * r.Ax;
            return Math.Abs(along) <= r.HalfLen && Math.Abs(across) <= r.HalfWid;
        }

        private static bool SegmentHit(in Segment s, double x, double z)
        {
            double dx = s.Bx - s.Ax, dz = s.Bz - s.Az;
            double len2 = dx * dx + dz * dz;
            double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((x - s.Ax) * dx + (z - s.Az) * dz) / len2)) : 0;
            double px = s.Ax + dx * t - x, pz = s.Az + dz * t - z;
            return px * px + pz * pz < s.R * s.R;
        }

        private static bool RingHit(Ring ring, double x, double z, double margin)
        {
            if (x < ring.MinX - margin || x > ring.MaxX + margin || z < ring.MinZ - margin || z > ring.MaxZ + margin) return false;
            double[] p = ring.Points;
            int n = p.Length / 2;
            bool inside = false;
            double nearest = double.PositiveInfinity;
            for (int i = 0, j = n - 1; i < n; j = i++)
            {
                double ax = p[i * 2], az = p[i * 2 + 1], bx = p[j * 2], bz = p[j * 2 + 1];
                if ((az > z) != (bz > z))
                {
                    double xCross = ax + (bx - ax) * (z - az) / (bz - az);
                    if (xCross > x) inside = !inside;
                }
                double dx = bx - ax, dz = bz - az;
                double len2 = dx * dx + dz * dz;
                double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
                double px = ax + dx * t - x, pz = az + dz * t - z;
                nearest = Math.Min(nearest, px * px + pz * pz);
            }
            return inside || nearest < margin * margin;
        }

        /// <summary>
        /// buildAirfieldExclusion: one test over scene (x, z) for every airfield, or null when none
        /// has anything to exclude. <paramref name="toEnu"/> is (lat, lon, ellipsoid height) to
        /// the play basis's east/north metres.
        /// </summary>
        public static Func<double, double, bool> Build(IEnumerable<AirfieldFootprint> airfields,
            Func<double, double, double, (double E, double N)> toEnu)
        {
            var rects = new List<Rect>();
            var segs = new List<Segment>();
            var rings = new List<Ring>();
            foreach (AirfieldFootprint airfield in airfields)
            {
                double h = airfield.PlaneHeightMsl;
                Func<double, double, (double E, double N)> at = (lat, lon) => toEnu(lat, lon, h);
                foreach (RunwayFootprint runway in airfield.Runways)
                {
                    var centre = at(runway.Lat, runway.Lon);
                    var axis = FlattenPads.BearingAxisAt(runway.Lat, runway.Lon, runway.HeadingDeg, at);
                    rects.Add(new Rect
                    {
                        Cx = centre.E,
                        Cz = -centre.N,
                        Ax = axis.E,
                        Az = -axis.N,
                        HalfLen = runway.LengthM / 2 + RunwayEndTreeMarginM,
                        HalfWid = runway.WidthM / 2 + RunwaySideTreeMarginM,
                    });
                }
                foreach (TaxiwayFootprint taxiway in airfield.Taxiways)
                {
                    double r = taxiway.WidthM / 2 + ApronTreeMarginM;
                    for (int i = 0; i + 1 < taxiway.Points.Length; i++)
                    {
                        var a = at(taxiway.Points[i][0], taxiway.Points[i][1]);
                        var b = at(taxiway.Points[i + 1][0], taxiway.Points[i + 1][1]);
                        segs.Add(new Segment { Ax = a.E, Az = -a.N, Bx = b.E, Bz = -b.N, R = r });
                    }
                }
                foreach (double[][] apron in airfield.Aprons)
                {
                    if (apron.Length < 3) continue;
                    var pts = new double[apron.Length * 2];
                    double minX = double.PositiveInfinity, maxX = double.NegativeInfinity;
                    double minZ = double.PositiveInfinity, maxZ = double.NegativeInfinity;
                    for (int i = 0; i < apron.Length; i++)
                    {
                        var enu = at(apron[i][0], apron[i][1]);
                        double x = enu.E, z = -enu.N;
                        pts[i * 2] = x;
                        pts[i * 2 + 1] = z;
                        minX = Math.Min(minX, x); maxX = Math.Max(maxX, x);
                        minZ = Math.Min(minZ, z); maxZ = Math.Max(maxZ, z);
                    }
                    rings.Add(new Ring { Points = pts, MinX = minX, MaxX = maxX, MinZ = minZ, MaxZ = maxZ });
                }
            }
            if (rects.Count == 0 && segs.Count == 0 && rings.Count == 0) return null;

            // Entries: kind in the top bits, index below.
            var grid = new Dictionary<long, List<int>>();
            void AddToGrid(double minX, double maxX, double minZ, double maxZ, int entry)
            {
                long x0 = (long)Math.Floor(minX / CellM), x1 = (long)Math.Floor(maxX / CellM);
                long z0 = (long)Math.Floor(minZ / CellM), z1 = (long)Math.Floor(maxZ / CellM);
                for (long cx = x0; cx <= x1; cx++)
                {
                    for (long cz = z0; cz <= z1; cz++)
                    {
                        long k = CellKey(cx, cz);
                        if (!grid.TryGetValue(k, out List<int> list)) grid[k] = list = new List<int>();
                        list.Add(entry);
                    }
                }
            }
            const int KindShift = 28;
            for (int i = 0; i < rects.Count; i++)
            {
                Rect r = rects[i];
                double reach = Math.Max(r.HalfLen, r.HalfWid);
                AddToGrid(r.Cx - reach, r.Cx + reach, r.Cz - reach, r.Cz + reach, i);
            }
            for (int i = 0; i < segs.Count; i++)
            {
                Segment s = segs[i];
                AddToGrid(Math.Min(s.Ax, s.Bx) - s.R, Math.Max(s.Ax, s.Bx) + s.R, Math.Min(s.Az, s.Bz) - s.R, Math.Max(s.Az, s.Bz) + s.R,
                    (1 << KindShift) | i);
            }
            for (int i = 0; i < rings.Count; i++)
            {
                Ring r = rings[i];
                AddToGrid(r.MinX - ApronTreeMarginM, r.MaxX + ApronTreeMarginM, r.MinZ - ApronTreeMarginM, r.MaxZ + ApronTreeMarginM,
                    (2 << KindShift) | i);
            }
            Rect[] rectArr = rects.ToArray();
            Segment[] segArr = segs.ToArray();
            Ring[] ringArr = rings.ToArray();
            return (x, z) =>
            {
                if (!grid.TryGetValue(CellKey((long)Math.Floor(x / CellM), (long)Math.Floor(z / CellM)), out List<int> list)) return false;
                foreach (int entry in list)
                {
                    int kind = entry >> KindShift, i = entry & ((1 << KindShift) - 1);
                    if (kind == 0 ? RectHit(rectArr[i], x, z) : kind == 1 ? SegmentHit(segArr[i], x, z) : RingHit(ringArr[i], x, z, ApronTreeMarginM))
                    {
                        return true;
                    }
                }
                return false;
            };
        }
    }
}
