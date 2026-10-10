using System.Linq;
using System.Text.Json;
using Retro.Core;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

public class GeodesyTests
{
    private static readonly JsonElement Fx = Load("geodesy.json");
    private static readonly double Metres = Num(Fx.GetProperty("tolerances"), "metres");
    private static readonly double Degrees = Num(Fx.GetProperty("tolerances"), "degrees");
    private static readonly double QuatTol = Num(Fx.GetProperty("tolerances"), "quaternion");
    private static readonly double Radians = Num(Fx.GetProperty("tolerances"), "radians");

    [Fact]
    public void Constants()
    {
        var m = new Mismatches();
        m.Close("A", Num(Fx.GetProperty("constants"), "WGS84_A"), Geodesy.Wgs84A, 0);
        m.Close("B", Num(Fx.GetProperty("constants"), "WGS84_B"), Geodesy.Wgs84B, 0);
        m.AssertNone();
    }

    [Fact]
    public void GeodeticToEcefAndBack()
    {
        var m = new Mismatches();
        foreach (JsonElement p in Fx.GetProperty("geodeticEcef").EnumerateArray())
        {
            double lat = Num(p, "lat"), lon = Num(p, "lon"), h = Num(p, "height");
            string at = $"({lat}, {lon}, {h})";
            Vec3d ecef = Geodesy.GeodeticToEcef(lat, lon, h);
            m.Close($"ecef {at}", V3(p.GetProperty("ecef")), ecef, Metres / 1e6);
            Geodetic back = Geodesy.EcefToGeodetic(ecef);
            JsonElement rt = p.GetProperty("roundTrip");
            m.Close($"lat {at}", Num(rt, "lat"), back.Lat, Degrees);
            m.Close($"lon {at}", Num(rt, "lon"), back.Lon, Degrees);
            m.Close($"height {at}", Num(rt, "height"), back.Height, Metres);
        }
        m.AssertNone();
    }

    [Fact]
    public void EnuBasesAndConversions()
    {
        var m = new Mismatches();
        double c0 = Num(Fx.GetProperty("heightFn"), "c0");
        double cLat = Num(Fx.GetProperty("heightFn"), "cLat");
        double cLon = Num(Fx.GetProperty("heightFn"), "cLon");
        foreach (JsonElement b in Fx.GetProperty("bases").EnumerateArray())
        {
            string label = b.GetProperty("label").GetString()!;
            EnuBasis basis = Geodesy.MakeEnuBasis(Num(b, "lat0"), Num(b, "lon0"), Num(b, "height0"));
            JsonElement bj = b.GetProperty("basis");
            m.Close($"{label} origin", V3(bj.GetProperty("origin")), basis.Origin, 1e-15);
            double[] e2e = Nums(bj, "ecefToEnu");
            Mat3d mm = basis.EcefToEnu;
            double[] got = { mm.M11, mm.M12, mm.M13, mm.M21, mm.M22, mm.M23, mm.M31, mm.M32, mm.M33 };
            for (int i = 0; i < 9; i++) m.Close($"{label} ecefToEnu[{i}]", e2e[i], got[i], 1e-15);

            int k = 0;
            foreach (JsonElement p in b.GetProperty("probes").EnumerateArray())
            {
                string at = $"{label} probe {k++}";
                double lat = Num(p, "lat"), lon = Num(p, "lon"), h = Num(p, "height");
                Vec3d ecef = Geodesy.GeodeticToEcef(lat, lon, h);
                Enu enu = Geodesy.EcefToEnu(basis, ecef);
                m.Close($"{at} enu", V3(p.GetProperty("enu")), new Vec3d(enu.E, enu.N, enu.U), Metres);
                m.Close($"{at} ecefBack", V3(p.GetProperty("ecefBack")), Geodesy.EnuToEcef(basis, enu), Metres / 1e6);
                Vec3d scene = Geodesy.SceneFromEnu(enu);
                m.Close($"{at} scene", V3(p.GetProperty("scene")), scene, Metres);
                m.Close($"{at} world", V3(p.GetProperty("world")), Geodesy.GeodeticToWorld(basis, lat, lon, h), Metres);

                Geodetic geo = Geodesy.WorldToGeodetic(basis, scene.X, scene.Y, scene.Z);
                CloseGeo(m, $"{at} worldToGeodetic", p.GetProperty("worldToGeodetic"), geo);
                CloseGeo(m, $"{at} enuToGeodeticApprox", p.GetProperty("enuToGeodeticApprox"),
                    Geodesy.EnuToGeodeticApprox(basis, enu.E, enu.N, enu.U));
                Enu again = Geodesy.EnuFromScene(scene);
                m.Close($"{at} enuFromScene", V3(p.GetProperty("enuFromScene")), new Vec3d(again.E, again.N, again.U), Metres);
                CloseGeo(m, $"{at} surfaceSolve", p.GetProperty("surfaceSolve"),
                    Geodesy.GeodeticOnSurfaceAtEnu(basis, enu.E, enu.N, (la, lo) => c0 + cLat * la + cLon * lo));
                CloseGeo(m, $"{at} surfaceSolveEllipsoid", p.GetProperty("surfaceSolveEllipsoid"),
                    Geodesy.GeodeticOnSurfaceAtEnu(basis, enu.E, enu.N));
                m.Close($"{at} seaLevelSceneY", Num(p, "seaLevelSceneY"), Geodesy.SeaLevelSceneY(scene.X, scene.Z), Metres);
            }
        }
        m.AssertNone();
    }

    private static void CloseGeo(Mismatches m, string what, JsonElement expected, Geodetic actual)
    {
        m.Close(what + ".lat", Num(expected, "lat"), actual.Lat, Degrees);
        m.Close(what + ".lon", Num(expected, "lon"), actual.Lon, Degrees);
        m.Close(what + ".height", Num(expected, "height"), actual.Height, Metres);
    }

    [Fact]
    public void FrameShifts()
    {
        var m = new Mismatches();
        JsonElement[] origins = Fx.GetProperty("origins").EnumerateArray().ToArray();
        EnuBasis Basis(int i) => Geodesy.MakeEnuBasis(Num(origins[i], "lat"), Num(origins[i], "lon"), Num(origins[i], "height"));
        foreach (JsonElement s in Fx.GetProperty("shifts").EnumerateArray())
        {
            int from = s.GetProperty("from").GetInt32(), to = s.GetProperty("to").GetInt32();
            string at = $"shift {from}->{to}";
            FrameShift shift = FrameShift.Between(Basis(from), Basis(to));
            m.CloseRotation($"{at} rotation", Q(s.GetProperty("rotation")), shift.Rotation, QuatTol);
            m.CloseRotation($"{at} frameRotation", Q(s.GetProperty("frameRotation")), Geodesy.EnuFrameRotation(Basis(from), Basis(to)), QuatTol);
            m.Close($"{at} offset", V3(s.GetProperty("offset")), shift.Offset, Metres);
            int k = 0;
            foreach (JsonElement x in s.GetProperty("samples").EnumerateArray())
            {
                string sat = $"{at} sample {k++}";
                JsonElement pt = x.GetProperty("point"), vc = x.GetProperty("vector"), or = x.GetProperty("orientation");
                m.Close($"{sat} point", V3(pt.GetProperty("out")), shift.Point(V3(pt.GetProperty("in"))), Metres);
                m.Close($"{sat} vector", V3(vc.GetProperty("out")), shift.Vector(V3(vc.GetProperty("in"))), Metres);
                m.CloseRotation($"{sat} orientation", Q(or.GetProperty("out")), shift.Orientation(Q(or.GetProperty("in"))), QuatTol);
                JsonElement hd = x.GetProperty("heading");
                m.Close($"{sat} heading", Num(hd, "out"), shift.Heading(Num(hd, "in")), Radians);
                JsonElement sh = x.GetProperty("slopedHeading");
                var sloped = shift.SlopedHeading(Num(sh, "heading"), Num(sh, "slope"));
                m.Close($"{sat} slopedHeading.heading", Num(sh, "outHeading"), sloped.Heading, Radians);
                m.Close($"{sat} slopedHeading.slope", Num(sh, "outSlope"), sloped.Slope, Radians);
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void NorthHelpers()
    {
        var m = new Mismatches();
        foreach (JsonElement n in Fx.GetProperty("northHelpers").EnumerateArray())
        {
            double z = Num(n, "z");
            m.Close($"north({z})", Num(n, "north"), Geodesy.NorthFromSceneZ(z), 0);
            m.Close($"sceneZ({z})", Num(n, "sceneZ"), Geodesy.SceneZFromNorth(z), 0);
        }
        m.AssertNone();
    }
}
