using System;

namespace Retro.Core
{
    public struct Geodetic
    {
        /// <summary>Degrees.</summary>
        public double Lat;
        /// <summary>Degrees.</summary>
        public double Lon;
        /// <summary>Metres above the ellipsoid.</summary>
        public double Height;

        public Geodetic(double lat, double lon, double height)
        {
            Lat = lat;
            Lon = lon;
            Height = height;
        }
    }

    /// <summary>Local tangent-plane coordinates in metres: east, north, up.</summary>
    public struct Enu
    {
        public double E;
        public double N;
        public double U;

        public Enu(double e, double n, double u)
        {
            E = e;
            N = n;
            U = u;
        }
    }

    /// <summary>ENU basis at a geodetic origin. Rows of EcefToEnu are the east, north and up axes in ECEF.</summary>
    public sealed class EnuBasis
    {
        /// <summary>ECEF metres.</summary>
        public Vec3d Origin;
        public double Lat0;
        public double Lon0;
        /// <summary>ECEF delta to ENU.</summary>
        public Mat3d EcefToEnu;
        /// <summary>ENU to ECEF delta (the transpose).</summary>
        public Mat3d EnuToEcef;

        public EnuBasis Clone() => (EnuBasis)MemberwiseClone();
    }

    /// <summary>
    /// WGS84 geodetic, ECEF, ENU and scene-space conversions; port of
    /// src/script/terrain/geodesy.ts.
    ///
    /// Scene space is x = east, y = up, z = SOUTH. That is not a style choice:
    /// it is what keeps the frame right-handed with +Y up, and every baked tile
    /// assumes it. The Unity render boundary is the only place that flips z.
    /// </summary>
    public static class Geodesy
    {
        public const double Wgs84A = 6378137.0;
        public const double Wgs84F = 1 / 298.257223563;
        public static readonly double Wgs84E2 = Wgs84F * (2 - Wgs84F);
        public static readonly double Wgs84B = Wgs84A * (1 - Wgs84F);

        private const double Deg = Math.PI / 180;
        private const double Rad = 180 / Math.PI;

        public static double DegToRad(double d) => d * Deg;

        /// <summary>Geodetic (degrees, metres) to ECEF metres.</summary>
        public static Vec3d GeodeticToEcef(double latDeg, double lonDeg, double height)
        {
            double lat = latDeg * Deg;
            double lon = lonDeg * Deg;
            double sinLat = JsTrig.Sin(lat);
            double cosLat = JsTrig.Cos(lat);
            double sinLon = JsTrig.Sin(lon);
            double cosLon = JsTrig.Cos(lon);
            double n = Wgs84A / Math.Sqrt(1 - Wgs84E2 * sinLat * sinLat);
            return new Vec3d(
                (n + height) * cosLat * cosLon,
                (n + height) * cosLat * sinLon,
                (n * (1 - Wgs84E2) + height) * sinLat);
        }

        /// <summary>ECEF metres to geodetic. Bowring closed form.</summary>
        public static Geodetic EcefToGeodetic(double x, double y, double z)
        {
            double lon = JsTrig.Atan2(y, x);
            double p = JsMath.Hypot(x, y);
            double theta = JsTrig.Atan2(z * Wgs84A, p * Wgs84B);
            double sinT = JsTrig.Sin(theta);
            double cosT = JsTrig.Cos(theta);
            double lat = JsTrig.Atan2(
                z + Wgs84E2 * Wgs84B / (1 - Wgs84E2) * sinT * sinT * sinT,
                p - Wgs84E2 * Wgs84A * cosT * cosT * cosT);
            double sinLat = JsTrig.Sin(lat);
            double n = Wgs84A / Math.Sqrt(1 - Wgs84E2 * sinLat * sinLat);
            return new Geodetic(lat * Rad, lon * Rad, p / JsTrig.Cos(lat) - n);
        }

        public static Geodetic EcefToGeodetic(Vec3d ecef) => EcefToGeodetic(ecef.X, ecef.Y, ecef.Z);

        public static EnuBasis MakeEnuBasis(double lat0, double lon0, double height0 = 0)
        {
            Vec3d origin = GeodeticToEcef(lat0, lon0, height0);
            double lat = lat0 * Deg;
            double lon = lon0 * Deg;
            double sinLat = JsTrig.Sin(lat);
            double cosLat = JsTrig.Cos(lat);
            double sinLon = JsTrig.Sin(lon);
            double cosLon = JsTrig.Cos(lon);
            double ex = -sinLon, ey = cosLon, ez = 0;
            double nx = -sinLat * cosLon, ny = -sinLat * sinLon, nz = cosLat;
            double ux = cosLat * cosLon, uy = cosLat * sinLon, uz = sinLat;
            return new EnuBasis
            {
                Origin = origin,
                Lat0 = lat0,
                Lon0 = lon0,
                EcefToEnu = new Mat3d(ex, ey, ez, nx, ny, nz, ux, uy, uz),
                EnuToEcef = new Mat3d(ex, nx, ux, ey, ny, uy, ez, nz, uz),
            };
        }

        public static Enu EcefToEnu(EnuBasis basis, Vec3d ecef)
        {
            double dx = ecef.X - basis.Origin.X;
            double dy = ecef.Y - basis.Origin.Y;
            double dz = ecef.Z - basis.Origin.Z;
            Mat3d m = basis.EcefToEnu;
            return new Enu(
                m.M11 * dx + m.M12 * dy + m.M13 * dz,
                m.M21 * dx + m.M22 * dy + m.M23 * dz,
                m.M31 * dx + m.M32 * dy + m.M33 * dz);
        }

        public static Vec3d EnuToEcef(EnuBasis basis, Enu enu)
        {
            Mat3d m = basis.EnuToEcef;
            return new Vec3d(
                basis.Origin.X + m.M11 * enu.E + m.M12 * enu.N + m.M13 * enu.U,
                basis.Origin.Y + m.M21 * enu.E + m.M22 * enu.N + m.M23 * enu.U,
                basis.Origin.Z + m.M31 * enu.E + m.M32 * enu.N + m.M33 * enu.U);
        }

        /// <summary>Geodetic of a point on the tangent plane; height from the ECEF conversion, not a DEM.</summary>
        public static Geodetic EnuToGeodeticApprox(EnuBasis basis, double e, double n, double u = 0)
        {
            return EcefToGeodetic(EnuToEcef(basis, new Enu(e, n, u)));
        }

        private const double SurfaceSolveTolM = 0.01;
        private const int SurfaceSolveMaxSteps = 4;

        /// <summary>
        /// The geodetic point on the ground straight below (or above) ENU (e, n),
        /// "straight" being along the origin's up (scene Y). heightAt is the ground
        /// height above the ellipsoid; null means the ellipsoid itself.
        /// </summary>
        public static Geodetic GeodeticOnSurfaceAtEnu(EnuBasis basis, double e, double n, Func<double, double, double> heightAt = null)
        {
            double u = -(e * e + n * n) / (2 * Wgs84A);
            for (int i = 0; ; i++)
            {
                Geodetic g = EcefToGeodetic(EnuToEcef(basis, new Enu(e, n, u)));
                double target = heightAt == null ? 0 : heightAt(g.Lat, g.Lon);
                double miss = target - g.Height;
                if (Math.Abs(miss) < SurfaceSolveTolM || i + 1 >= SurfaceSolveMaxSteps)
                {
                    return g;
                }
                u += miss;
            }
        }

        /// <summary>Scene Y of the sea surface at scene (x, z): first-order earth curvature.</summary>
        public static double SeaLevelSceneY(double x, double z) => -(x * x + z * z) / (2 * Wgs84A);

        public static Vec3d SceneFromEnu(Enu enu) => new Vec3d(enu.E, enu.U, -enu.N);

        public static Enu EnuFromScene(Vec3d world) => new Enu(world.X, -world.Z, world.Y);

        public static Vec3d GeodeticToWorld(EnuBasis basis, double latDeg, double lonDeg, double altitudeM)
        {
            return SceneFromEnu(EcefToEnu(basis, GeodeticToEcef(latDeg, lonDeg, altitudeM)));
        }

        public static Geodetic WorldToGeodetic(EnuBasis basis, double x, double y, double z)
        {
            return EcefToGeodetic(EnuToEcef(basis, EnuFromScene(new Vec3d(x, y, z))));
        }

        public static double NorthFromSceneZ(double z) => -z;

        public static double SceneZFromNorth(double n) => -n;

        /// <summary>Scene-space (east, up, south) rotation of a basis: its rows are e, u and -n.</summary>
        private static Mat3d SceneRotation(EnuBasis basis)
        {
            Mat3d m = basis.EcefToEnu;
            return new Mat3d(
                m.M11, m.M12, m.M13,
                m.M31, m.M32, m.M33,
                -m.M21, -m.M22, -m.M23);
        }

        /// <summary>Rotation carrying vectors expressed in from's scene axes into to's.</summary>
        public static Quatd EnuFrameRotation(EnuBasis from, EnuBasis to)
        {
            return Quatd.FromRotationMatrix(SceneRotation(to) * SceneRotation(from).Transposed());
        }
    }
}
