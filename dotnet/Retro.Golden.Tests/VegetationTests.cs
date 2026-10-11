using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Retro.Core;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/vegetation.json: the exclusion masks, the tree and clutter scatter, the
/// 4 x 4 cell split with its shuffled slots, and the per-instance float32 attributes on two real
/// z12 leaves (GCLP, a forest near Garmisch), plus the per-frame draw count.
/// </summary>
public class VegetationTests
{
    private static readonly JsonElement Fx = Load("vegetation.json");

    private sealed class TileSetup
    {
        public JsonElement Fx;
        public PtmTile Tile;
        public Func<double, double, bool> Road;
        public Func<double, double, double, bool> Building;
        public Func<double, double, double, bool> Bed;
        public Func<double, double, double, bool> ManMade;
        public Func<double, double, double, bool> All;
        public Quatd FrameFix;
        public Vec3d Origin;
        public Vec3d BedUp;
        public double BedCellM;
    }

    private static readonly Lazy<List<TileSetup>> Tiles = new(BuildTiles);

    private static EnuBasis BakeBasis()
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(Root, "tiles", "manifest.json")));
        JsonElement o = doc.RootElement.GetProperty("enuOrigin");
        return Geodesy.MakeEnuBasis(Num(o, "lat"), Num(o, "lon"), Num(o, "height"));
    }

    private static Func<double, double, bool> AsTest(RoadExclusion r) => r == null ? null : r.Test;

    private static Func<double, double, double, bool> AsTest(BuildingExclusion b) => b == null ? null : b.Contains;

    private static AirfieldFootprint Footprint(JsonElement a)
    {
        var f = new AirfieldFootprint { PlaneHeightMsl = Num(a.GetProperty("plane"), "heightMsl") };
        foreach (JsonElement r in a.GetProperty("runways").EnumerateArray())
        {
            f.Runways.Add(new RunwayFootprint
            {
                Lat = Num(r, "lat"), Lon = Num(r, "lon"), HeadingDeg = Num(r, "headingDeg"), LengthM = Num(r, "lengthM"), WidthM = Num(r, "widthM"),
            });
        }
        foreach (JsonElement t in a.GetProperty("taxiways").EnumerateArray())
        {
            f.Taxiways.Add(new TaxiwayFootprint
            {
                WidthM = Num(t, "widthM"),
                Points = t.GetProperty("points").EnumerateArray().Select(Nums).ToArray(),
            });
        }
        foreach (JsonElement ap in a.GetProperty("aprons").EnumerateArray())
        {
            f.Aprons.Add(ap.GetProperty("ring").EnumerateArray().Select(Nums).ToArray());
        }
        return f;
    }

    private static List<TileSetup> BuildTiles()
    {
        EnuBasis bake = BakeBasis();
        string dir = Path.Combine(Root, "tiles", "vegetation");
        using JsonDocument airDoc = JsonDocument.Parse(File.ReadAllText(Path.Combine(dir, "airfields.json")));
        JsonElement[] airItems = airDoc.RootElement.GetProperty("items").EnumerateArray().Select(e => e.Clone()).ToArray();
        var list = new List<TileSetup>();
        foreach (JsonElement t in Fx.GetProperty("tiles").EnumerateArray())
        {
            JsonElement files = t.GetProperty("files");
            byte[] Read(string ext) =>
                files.GetProperty(ext).ValueKind == JsonValueKind.Null ? null : File.ReadAllBytes(Path.Combine(Root, files.GetProperty(ext).GetString()!));
            PtmTile tile = TileFile.Ptm(Read("ptm"));
            byte[] ptrBytes = Read("ptr"), pbhBytes = Read("pbh"), pbdBytes = Read("pbd");
            PtrTile ptr = ptrBytes == null ? null : TileFile.Ptr(ptrBytes);
            PbhTile pbh = pbhBytes == null ? null : TileFile.Pbh(pbhBytes);
            PbdTile pbd = pbdBytes == null ? null : TileFile.Pbd(pbdBytes);

            JsonElement o = t.GetProperty("origin");
            EnuBasis basis = Geodesy.MakeEnuBasis(Num(o, "lat"), Num(o, "lon"), Num(o, "height"));
            Quatd frameFix = Geodesy.EnuFrameRotation(bake, basis);
            (double E, double N) ToEnu(double lat, double lon, double h)
            {
                Enu enu = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, h));
                return (enu.E, enu.N);
            }
            var names = t.GetProperty("airfields").EnumerateArray().Select(e => e.GetString()).ToList();
            var airfields = names.Select(n => airItems.First(a =>
            {
                string icao = a.GetProperty("icao").GetString();
                return (string.IsNullOrEmpty(icao) ? a.GetProperty("name").GetString() : icao) == n;
            })).Select(Footprint).ToList();
            Func<double, double, bool> onAirfield = AirfieldExclusion.Build(airfields, ToEnu);
            var pads = t.GetProperty("pads").EnumerateArray().Select(p => new SurfaceExclusionPad
            {
                CenterX = Num(p, "centerX"), CenterZ = Num(p, "centerZ"), Heading = Num(p, "heading"),
                HalfLength = Num(p, "halfLength"), HalfWidth = Num(p, "halfWidth"), SurfaceY = Num(p, "surfaceY"),
                BaseY = Num(p, "baseY"), Feather = Num(p, "feather"),
                Slope = p.GetProperty("slope").ValueKind == JsonValueKind.Null ? null : Num(p, "slope"),
            }).ToList();
            Func<double, double, bool> onSurface = SurfaceExclusion.Build(pads);
            LonLatBounds b = Tiling.Bounds(tile.Id);
            Vec3d origin = Geodesy.GeodeticToWorld(basis, (b.South + b.North) / 2, (b.West + b.East) / 2, tile.CenterHeightM);
            Vec3d up = RailBedExclusion.TileUp(bake, tile.Id);
            double cellM = RailBedExclusion.CellMFor(tile.Id.Z, 12);

            var s = new TileSetup
            {
                Fx = t,
                Tile = tile,
                FrameFix = frameFix,
                Origin = origin,
                BedUp = up,
                BedCellM = cellM,
                // The roads and buildings ports' masks, as the tree scatter consults them.
                Road = ptr == null ? null : AsTest(RoadExclusion.Build(ptr)),
                Building = pbh == null ? null : AsTest(BuildingExclusion.Build(pbh)),
                Bed = pbd == null || pbd.Beds.Length == 0 ? null : RailBedExclusion.Build(pbd.Beds, up, cellM),
                ManMade = VegetationExclusion.ForTile(origin, frameFix, onAirfield, null, onSurface, null),
            };
            s.All = VegetationExclusion.Combine(s.Road, s.Bed, s.ManMade, s.Building);
            list.Add(s);
        }
        return list;
    }

    [Fact]
    public void FramesMatchTheOracle()
    {
        var m = new Mismatches();
        foreach (TileSetup s in Tiles.Value)
        {
            string at = s.Fx.GetProperty("name").GetString()!;
            double[] q = Nums(s.Fx, "frameFix");
            m.Close($"{at} frameFix.x", q[0], s.FrameFix.X, 0);
            m.Close($"{at} frameFix.y", q[1], s.FrameFix.Y, 0);
            m.Close($"{at} frameFix.z", q[2], s.FrameFix.Z, 0);
            m.Close($"{at} frameFix.w", q[3], s.FrameFix.W, 0);
            m.Close($"{at} tileOrigin", V3(s.Fx.GetProperty("tileOrigin")), s.Origin, 0);
            m.Close($"{at} bedUp", V3(s.Fx.GetProperty("bedUp")), s.BedUp, 0);
            m.Close($"{at} bedCellM", Num(s.Fx, "bedCellM"), s.BedCellM, 0);
            m.Equal($"{at} eligible", s.Fx.GetProperty("eligible").GetBoolean(), TreeBillboards.HasVegetationSource(s.Tile));
        }
        m.AssertNone();
    }

    private static string Bits(Func<double[], bool> test, double[][] pts)
    {
        var sb = new StringBuilder(pts.Length);
        foreach (double[] p in pts) sb.Append(test(p) ? '1' : '0');
        return sb.ToString();
    }

    private static void CompareBits(Mismatches m, string what, string expected, string actual)
    {
        if (expected == null || actual == null)
        {
            m.Equal(what + " present", expected != null, actual != null);
            return;
        }
        m.Equal(what + " length", expected.Length, actual.Length);
        int bad = 0, first = -1;
        for (int i = 0; i < Math.Min(expected.Length, actual.Length); i++)
        {
            if (expected[i] != actual[i])
            {
                bad++;
                if (first < 0) first = i;
            }
        }
        m.Equal($"{what} differing points (first at {first})", 0, bad);
    }

    [Fact]
    public void MasksMatchTheOracle()
    {
        var m = new Mismatches();
        foreach (TileSetup s in Tiles.Value)
        {
            string at = s.Fx.GetProperty("name").GetString()!;
            JsonElement masks = s.Fx.GetProperty("masks");
            double[][] pts = masks.GetProperty("pointList").EnumerateArray().Select(Nums).ToArray();
            string Want(string k) => masks.GetProperty(k).ValueKind == JsonValueKind.Null ? null : masks.GetProperty(k).GetString();
            CompareBits(m, $"{at} road", Want("road"), s.Road == null ? null : Bits(p => s.Road(p[0], p[2]), pts));
            CompareBits(m, $"{at} building", Want("building"), s.Building == null ? null : Bits(p => s.Building(p[0], p[1], p[2]), pts));
            CompareBits(m, $"{at} bed", Want("bed"), s.Bed == null ? null : Bits(p => s.Bed(p[0], p[1], p[2]), pts));
            CompareBits(m, $"{at} manMade", Want("manMade"), s.ManMade == null ? null : Bits(p => s.ManMade(p[0], p[2], p[1]), pts));
            CompareBits(m, $"{at} all", Want("all"), s.All == null ? null : Bits(p => s.All(p[0], p[2], p[1]), pts));
        }
        m.AssertNone();
    }

    private static void CompareGroups(Mismatches m, string at, JsonElement expected, List<ScatterGroup> actual)
    {
        JsonElement[] want = expected.EnumerateArray().ToArray();
        m.Equal(at + " groups", want.Length, actual.Count);
        for (int i = 0; i < Math.Min(want.Length, actual.Count); i++)
        {
            ScatterGroup g = actual[i];
            m.Equal($"{at}[{i}] kind", want[i].GetProperty("kind").GetInt32(), g.Kind);
            m.Equal($"{at}[{i}] count", want[i].GetProperty("count").GetInt32(), g.Count);
            Structural.Compare($"{at}[{i}].points", want[i].GetProperty("points"), g.Points.ToArray(), m, 0);
            Structural.Compare($"{at}[{i}].tints", want[i].GetProperty("tints"), g.Tints.ToArray(), m, 0);
            Structural.Compare($"{at}[{i}].normals", want[i].GetProperty("normals"), g.Normals.ToArray(), m, 0);
        }
    }

    private static void CompareMesh(Mismatches m, string at, JsonElement e, BillboardInstances b)
    {
        m.Equal(at + " count", e.GetProperty("count").GetInt32(), b.Count);
        JsonElement total = e.GetProperty("treeTotal");
        if (total.ValueKind != JsonValueKind.Null)
        {
            m.Equal(at + " treeTotal", total.GetInt32(), b.Total);
            m.Close(at + " treeSpacingM", Num(e, "treeSpacingM"), b.SpacingM, 0);
            m.Close(at + " invCount", Num(e, "invCount"), b.InvCount, 0);
        }
        else
        {
            m.Equal(at + " stones", true, b.Stones);
        }
        JsonElement sphere = e.GetProperty("sphere");
        m.Close(at + " sphere.center", V3(sphere.GetProperty("center")), b.SphereCenter, 0);
        m.Close(at + " sphere.radius", Num(sphere, "radius"), b.SphereRadius, 0);
        Structural.Compare(at + ".matrices", e.GetProperty("matrices"), b.Matrices(), m, 0);
        Structural.Compare(at + ".shade", e.GetProperty("shade"), b.Shade, m, 0);
        Structural.Compare(at + ".normal", e.GetProperty("normal"), b.Normals, m, 0);
        Structural.Compare(at + ".species", e.GetProperty("species"), b.Kinds, m, 0);
    }

    [Fact]
    public void ScatterAndInstancesMatchTheOracle()
    {
        var m = new Mismatches();
        int instances = 0;
        foreach (TileSetup s in Tiles.Value)
        {
            string name = s.Fx.GetProperty("name").GetString()!;
            foreach (JsonElement c in s.Fx.GetProperty("cases").EnumerateArray())
            {
                double density = Num(c, "density");
                bool excluded = c.GetProperty("excluded").GetBoolean();
                string at = $"{name} d{density}{(excluded ? "" : " unmasked")}";
                Func<double, double, double, bool> test = excluded ? s.All : null;
                m.Close(at + " spacingM", Num(c, "spacingM"), TreeBillboards.SpacingM(density), 0);

                List<ScatterGroup> trees = TreeBillboards.ScatterTreeSpecies(s.Tile, density, test);
                GroundClutterResult clutter = GroundClutter.Scatter(s.Tile, density, test);
                CompareGroups(m, at + " trees", c.GetProperty("trees"), trees);
                CompareGroups(m, at + " clutterVegetation", c.GetProperty("clutterVegetation"), clutter.Vegetation);
                CompareGroups(m, at + " rocks", c.GetProperty("rocks"), clutter.Rocks);

                TileVegetation v = TileVegetation.Build(s.Tile, density, test);
                JsonElement[] cells = c.GetProperty("treeCells").EnumerateArray().ToArray();
                m.Equal(at + " cells", cells.Length, v.TreeCells.Count);
                for (int i = 0; i < Math.Min(cells.Length, v.TreeCells.Count); i++)
                {
                    CompareMesh(m, $"{at} cell {i}", cells[i], v.TreeCells[i]);
                    instances += v.TreeCells[i].Count;
                }
                JsonElement[] stones = c.GetProperty("stones").EnumerateArray().ToArray();
                m.Equal(at + " stone draws", stones.Length, v.Stones == null ? 0 : 1);
                if (stones.Length == 1 && v.Stones != null)
                {
                    CompareMesh(m, at + " stones", stones[0], v.Stones);
                    instances += v.Stones.Count;
                }
            }
        }
        Assert.True(instances > 50000, $"only {instances} instances compared");
        m.AssertNone();
    }

    [Fact]
    public void DrawCountsMatchTheOracle()
    {
        var m = new Mismatches();
        int i = 0;
        foreach (JsonElement d in Fx.GetProperty("draws").EnumerateArray())
        {
            JsonElement eye = d.GetProperty("eye");
            double? near = eye.ValueKind == JsonValueKind.Null
                ? null
                : TreeBillboards.NearDistance(V3(d.GetProperty("center")), Num(d, "radius"), V3(eye));
            int got = TreeBillboards.InstancesToDraw(d.GetProperty("total").GetInt32(), Num(d, "spacingM"), near, Num(d, "pixelAngle"));
            m.Equal($"draw {i++}", d.GetProperty("count").GetInt32(), got);
        }
        m.AssertNone();
    }

    [Fact]
    public void DensityFunctionsMatchTheOracle()
    {
        var m = new Mismatches();
        foreach (JsonElement p in Fx.GetProperty("densityScale").EnumerateArray())
        {
            double[] a = Nums(p);
            m.Close($"densityScale({a[0]})", a[1], TreeBillboards.DensityScaleForDistance(a[0]), 0);
        }
        foreach (JsonElement p in Fx.GetProperty("clampMultiplier").EnumerateArray())
        {
            double[] a = Nums(p);
            m.Close($"clampMultiplier({a[0]})", a[1], TreeBillboards.ClampDensityMultiplier(a[0]), 0);
        }
        foreach (JsonElement p in Fx.GetProperty("spacing").EnumerateArray())
        {
            double[] a = Nums(p);
            m.Close($"spacing({a[0]})", a[1], TreeBillboards.SpacingM(a[0]), 0);
        }
        m.AssertNone();
    }
}
