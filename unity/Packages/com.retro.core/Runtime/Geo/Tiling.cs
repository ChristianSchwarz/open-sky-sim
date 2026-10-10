using System;

namespace Retro.Core
{
    public struct TileKey : IEquatable<TileKey>
    {
        public int Z;
        public int X;
        public int Y;

        public TileKey(int z, int x, int y)
        {
            Z = z;
            X = x;
            Y = y;
        }

        public bool Equals(TileKey o) => Z == o.Z && X == o.X && Y == o.Y;
        public override bool Equals(object obj) => obj is TileKey k && Equals(k);
        public override int GetHashCode() => HashCode.Combine(Z, X, Y);

        /// <summary>"z/x/y", the manifest path order.</summary>
        public override string ToString() => $"{Z}/{X}/{Y}";
    }

    /// <summary>Degrees.</summary>
    public struct LonLatBounds
    {
        public double West;
        public double South;
        public double East;
        public double North;

        public LonLatBounds(double west, double south, double east, double north)
        {
            West = west;
            South = south;
            East = east;
            North = north;
        }
    }

    public struct TileRange
    {
        public int X0, Y0, X1, Y1;
    }

    /// <summary>
    /// Geographic (Plate Carree) quadtree over the whole WGS84 ellipsoid; port
    /// of src/script/terrain/tiling.ts. Level z has 2^(z+1) columns and 2^z
    /// rows; x grows east from lon -180, y grows SOUTH from lat +90.
    /// </summary>
    public static class Tiling
    {
        public static int XCount(int z) => 1 << (z + 1);

        public static int YCount(int z) => 1 << z;

        public static TileKey Parse(string key)
        {
            string[] p = key.Split('/');
            return new TileKey(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]));
        }

        public static LonLatBounds Bounds(TileKey id)
        {
            double span = 180.0 / (1 << id.Z);
            double west = -180 + id.X * span;
            double north = 90 - id.Y * span;
            return new LonLatBounds(west, north - span, west + span, north);
        }

        public static TileKey[] Children(TileKey id)
        {
            int z = id.Z + 1, x = id.X * 2, y = id.Y * 2;
            return new[]
            {
                new TileKey(z, x, y),
                new TileKey(z, x + 1, y),
                new TileKey(z, x, y + 1),
                new TileKey(z, x + 1, y + 1),
            };
        }

        public static TileKey? Parent(TileKey id)
        {
            if (id.Z <= 0) return null;
            return new TileKey(id.Z - 1, id.X >> 1, id.Y >> 1);
        }

        public static TileKey[] RootTiles() => new[] { new TileKey(0, 0, 0), new TileKey(0, 1, 0) };

        public static bool Contains(LonLatBounds b, double lon, double lat)
        {
            return lon >= b.West && lon <= b.East && lat >= b.South && lat <= b.North;
        }

        /// <summary>Tile containing a lon/lat at zoom z, clamped to the grid. Exact edges go east/south.</summary>
        public static TileKey AtLonLat(int z, double lon, double lat)
        {
            int xc = XCount(z), yc = YCount(z);
            double span = 180.0 / (1 << z);
            int x = (int)Math.Floor((lon + 180) / span);
            int y = (int)Math.Floor((90 - lat) / span);
            x = Math.Max(0, Math.Min(xc - 1, x));
            y = Math.Max(0, Math.Min(yc - 1, y));
            return new TileKey(z, x, y);
        }

        public static double ApproxEdgeMetres(TileKey id)
        {
            LonLatBounds b = Bounds(id);
            double midLat = 0.5 * (b.South + b.North);
            double lonM = (b.East - b.West) * 111320 * Math.Cos(midLat * Math.PI / 180);
            double latM = (b.North - b.South) * 110540;
            return Math.Max(lonM, latM);
        }

        /// <summary>Inclusive tile index range covering b at level z.</summary>
        public static TileRange RangeForBounds(int z, LonLatBounds b)
        {
            double span = 180.0 / (1 << z);
            int nx = XCount(z), ny = YCount(z);
            return new TileRange
            {
                X0 = Math.Max(0, (int)Math.Floor((b.West + 180) / span)),
                X1 = Math.Min(nx - 1, (int)Math.Ceiling((b.East + 180) / span) - 1),
                Y0 = Math.Max(0, (int)Math.Floor((90 - b.North) / span)),
                Y1 = Math.Min(ny - 1, (int)Math.Ceiling((90 - b.South) / span) - 1),
            };
        }
    }
}
