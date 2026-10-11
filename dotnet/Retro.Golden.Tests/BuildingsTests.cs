using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Core;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// tests/golden/buildings.json: earcut / ShapeUtils, roof extrusion, whole
/// tiles as BuildingMeshes binds them, the draw-range budget, the tree
/// exclusion mask and the tone table.
/// </summary>
public class BuildingsTests
{
    private static readonly JsonElement Fx = Load("buildings.json");

    private static (double X, double Y)[] Ring(JsonElement e) =>
        e.EnumerateArray().Select(p => (Num(p[0]), Num(p[1]))).ToArray();

    [Fact]
    public void ShapeUtilsTriangulatesLikeThree()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("shapeUtils").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            var contour = Ring(c.GetProperty("contour"));
            var holes = c.GetProperty("holes").EnumerateArray().Select(h => (IReadOnlyList<(double X, double Y)>)Ring(h)).ToArray();
            if (contour.Length > 0)
            {
                m.Close($"{name} area", Num(c, "area"), ShapeUtils.Area(contour), 0);
                m.Equal($"{name} isClockWise", c.GetProperty("isClockWise").GetBoolean(), ShapeUtils.IsClockWise(contour));
            }
            if (c.TryGetProperty("throws", out _))
            {
                bool threw = false;
                try { ShapeUtils.TriangulateShape(contour, holes); }
                catch (ArgumentException) { threw = true; }
                m.Equal($"{name} throws", true, threw);
                continue;
            }
            List<int[]> faces = ShapeUtils.TriangulateShape(contour, holes);
            string want = string.Join(" ", c.GetProperty("faces").EnumerateArray().Select(f => string.Join(",", f.EnumerateArray().Select(i => i.GetInt32()))));
            string got = string.Join(" ", faces.Select(f => string.Join(",", f)));
            m.Equal($"{name} faces", want, got);
        }
        m.AssertNone();
    }

    [Fact]
    public void RoofPlanesMatch()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("roofPlanes").EnumerateArray())
        {
            var form = (RoofForm)c.GetProperty("form").GetInt32();
            RoofPlane[] planes = BuildingRoofs.RoofPlanes(form, Num(c, "halfLength"), Num(c, "halfWidth"), Num(c, "eave"), Num(c, "ridge"));
            var want = c.GetProperty("planes").EnumerateArray().ToArray();
            m.Equal($"form {form} plane count", want.Length, planes.Length);
            for (int i = 0; i < Math.Min(want.Length, planes.Length); i++)
            {
                m.Close($"form {form} plane {i} a", Num(want[i], "a"), planes[i].A, 0);
                m.Close($"form {form} plane {i} b", Num(want[i], "b"), planes[i].B, 0);
                m.Close($"form {form} plane {i} c", Num(want[i], "c"), planes[i].C, 0);
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void RoofsAndWallsMatch()
    {
        double tol = Num(Fx.GetProperty("tolerances"), "roofMetres");
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("roofs").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            JsonElement s = c.GetProperty("shape");
            var shape = new BuildingShape
            {
                Rings = s.GetProperty("rings").EnumerateArray().Select(r => (IReadOnlyList<(double U, double V)>)Ring(r).Select(p => (p.X, p.Y)).ToArray()).ToArray(),
                BaseM = Num(s, "baseM"),
                EaveM = Num(s, "eaveM"),
                RidgeM = Num(s, "ridgeM"),
                Form = (RoofForm)s.GetProperty("form").GetInt32(),
                RidgeAngle = Num(s, "ridgeAngle"),
                NoWalls = s.TryGetProperty("noWalls", out JsonElement nw) && nw.GetBoolean(),
            };
            var got = new List<double[]>();
            int count = BuildingRoofs.BuildingTriangles(shape, (p, nu, nv, nh, roof) =>
                got.Add(p.Concat(new[] { nu, nv, nh, roof ? 1.0 : 0.0 }).ToArray()));
            m.Equal($"{name} count", c.GetProperty("count").GetInt32(), count);
            var want = c.GetProperty("tris").EnumerateArray().Select(Nums).ToArray();
            m.Equal($"{name} emitted", want.Length, got.Count);
            for (int t = 0; t < Math.Min(want.Length, got.Count); t++)
            {
                for (int k = 0; k < 13; k++)
                {
                    m.Close($"{name} tri {t}[{k}]", want[t][k], got[t][k], tol);
                }
            }
        }
        m.AssertNone();
    }

    private static readonly Dictionary<string, (PbhTile Tile, BuildingTileMesh Mesh)> Built = new();

    private static (PbhTile Tile, BuildingTileMesh Mesh) Tile(string file)
    {
        lock (Built)
        {
            if (!Built.TryGetValue(file, out var v))
            {
                PbhTile tile = TileFile.Pbh(File.ReadAllBytes(Path.Combine(Root, file)));
                v = (tile, BuildingTileBuilder.Build(tile));
                Built[file] = v;
            }
            return v;
        }
    }

    public static IEnumerable<object[]> TileFiles() =>
        Fx.GetProperty("tiles").EnumerateArray().Select(t => new object[] { t.GetProperty("file").GetString()! });

    private static void Describe<T>(Mismatches m, string what, JsonElement d, T[] actual) where T : struct
    {
        m.Equal($"{what} length", d.GetProperty("length").GetInt32(), actual.Length);
        uint h = Structural.Fnv1a32(MemoryMarshal.AsBytes(actual.AsSpan()));
        m.Equal($"{what} fnv1a32", d.GetProperty("fnv1a32").GetString(), h.ToString("x8"));
    }

    [Theory]
    [MemberData(nameof(TileFiles))]
    public void ExtrudesTilesLikeTheOracle(string file)
    {
        JsonElement e = Fx.GetProperty("tiles").EnumerateArray().First(t => t.GetProperty("file").GetString() == file);
        var m = new Mismatches();
        var (tile, mesh) = Tile(file);
        m.Equal("buildings", e.GetProperty("buildings").GetInt32(), tile.Buildings.Count);
        m.Equal("bound", e.GetProperty("bound").GetBoolean(), mesh != null);
        if (mesh != null)
        {
            m.Equal("triangles", e.GetProperty("triangles").GetInt32(), mesh.Triangles);
            m.Equal("bytes", e.GetProperty("bytes").GetInt32(), mesh.Bytes);
            foreach (JsonElement s in e.GetProperty("sampleTriangles").EnumerateArray())
            {
                int t = s.GetProperty("t").GetInt32();
                double[] pos = Nums(s, "pos"), nrm = Nums(s, "nrm"), tone = Nums(s, "tone"), raw = Nums(s, "raw");
                for (int k = 0; k < 9; k++) m.Close($"tri {t} pos[{k}]", pos[k], mesh.Positions[t * 9 + k], 0);
                for (int k = 0; k < 9; k++) m.Close($"tri {t} nrm[{k}]", nrm[k], mesh.Normals[t * 9 + k], 0);
                for (int k = 0; k < 3; k++) m.Close($"tri {t} tone[{k}]", tone[k], mesh.Tones[t * 3 + k], 0);
                for (int k = 0; k < 12; k++) m.Close($"tri {t} raw[{k}]", raw[k], mesh.RawColors[t * 12 + k], 0);
            }
            double[] prefixHead = Nums(e, "prefixHead"), promHead = Nums(e, "prominenceHead");
            for (int i = 0; i < prefixHead.Length; i++) m.Close($"prefix[{i}]", prefixHead[i], mesh.Prefix[i], 0);
            for (int i = 0; i < promHead.Length; i++) m.Close($"prominence[{i}]", promHead[i], mesh.Prominence[i], 0);
            Describe(m, "position", e.GetProperty("position"), mesh.Positions);
            Describe(m, "normal", e.GetProperty("normal"), mesh.Normals);
            Describe(m, "tone", e.GetProperty("tone"), mesh.Tones);
            Describe(m, "rawColor", e.GetProperty("rawColor"), mesh.RawColors);
            Describe(m, "prefix", e.GetProperty("prefix"), mesh.Prefix);
            Describe(m, "prominence", e.GetProperty("prominence"), mesh.Prominence);
        }
        m.AssertNone();
    }

    [Fact]
    public void SteppedExtrusionEqualsWholeTile()
    {
        var m = new Mismatches();
        string file = Fx.GetProperty("tiles")[1].GetProperty("file").GetString()!;
        var (tile, whole) = Tile(file);
        var b = new BuildingTileBuilder(tile);
        int steps = 0;
        while (!b.Done)
        {
            b.Step(steps % 2 == 0 ? 64 : 7);
            steps++;
        }
        BuildingTileMesh stepped = b.Finish();
        m.Equal("triangles", whole.Triangles, stepped.Triangles);
        m.Equal("positions", true, whole.Positions.AsSpan().SequenceEqual(stepped.Positions));
        m.Equal("normals", true, whole.Normals.AsSpan().SequenceEqual(stepped.Normals));
        m.Equal("prefix", true, whole.Prefix.AsSpan().SequenceEqual(stepped.Prefix));
        m.AssertNone();
    }

    [Theory]
    [MemberData(nameof(TileFiles))]
    public void ExclusionMatches(string file)
    {
        JsonElement e = Fx.GetProperty("tiles").EnumerateArray().First(t => t.GetProperty("file").GetString() == file);
        var m = new Mismatches();
        var (tile, _) = Tile(file);
        BuildingExclusion ex = BuildingExclusion.Build(tile);
        int i = 0;
        foreach (JsonElement s in e.GetProperty("exclusion").EnumerateArray())
        {
            double[] v = Nums(s);
            m.Equal($"point {i} ({v[0]}, {v[1]}, {v[2]})", v[3] == 1, ex.Contains(v[0], v[1], v[2]));
            i++;
        }
        m.AssertNone();
    }

    [Fact]
    public void BudgetFramesMatch()
    {
        var m = new Mismatches();
        foreach (JsonElement run in Fx.GetProperty("budget").EnumerateArray())
        {
            string name = run.GetProperty("name").GetString()!;
            var budget = new BuildingDrawBudget { Budget = run.GetProperty("budget").GetInt32() };
            double pixelAngle = Num(run, "pixelAngle");
            var sets = run.GetProperty("tiles").EnumerateArray().Select(t => new BuildingDrawSet(Tile(t.GetString()!).Mesh)).ToArray();
            int f = 0;
            foreach (JsonElement fr in run.GetProperty("frames").EnumerateArray())
            {
                double[] near = Nums(fr, "near"), want = Nums(fr, "want");
                budget.BeginFrame();
                for (int i = 0; i < sets.Length; i++)
                {
                    if (want[i] == 1) budget.Want(sets[i], near[i]);
                }
                budget.EndFrame(pixelAngle, Num(fr, "nowMs"));
                string at = $"{name} frame {f}";
                m.Close($"{at} minPixels", Num(fr, "minPixels"), budget.MinPixels, 0);
                m.Close($"{at} shownTriangles", Num(fr, "shownTriangles"), budget.ShownTriangles, 0);
                double[] count = Nums(fr, "count"), shown = Nums(fr, "shown"), visible = Nums(fr, "visible");
                for (int i = 0; i < sets.Length; i++)
                {
                    m.Close($"{at} tile {i} count", count[i], sets[i].Count, 0);
                    m.Close($"{at} tile {i} shown", shown[i], sets[i].Shown, 0);
                    m.Equal($"{at} tile {i} visible", visible[i] == 1, sets[i].Visible);
                }
                f++;
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void TonesMatch()
    {
        var m = new Mismatches();
        JsonElement t = Fx.GetProperty("tones");
        string[] cats = t.GetProperty("categories").EnumerateArray().Select(x => x.GetString()!).ToArray();
        m.Equal("tone count", cats.Length, BuildingTones.PaletteCategories.Count);
        for (int i = 0; i < cats.Length; i++)
        {
            m.Equal($"category {i}", cats[i].ToUpperInvariant().Replace("-", "_"), BuildingTones.PaletteCategories[i]);
        }
        void Hex(string prop, IReadOnlyList<int> table)
        {
            string[] want = t.GetProperty(prop).EnumerateArray().Select(x => x.GetString()!).ToArray();
            for (int i = 0; i < want.Length; i++) m.Equal($"{prop} {i}", want[i].ToLowerInvariant(), "#" + table[i].ToString("x6"));
        }
        Hex("noon", BuildingTones.Noon);
        Hex("midnight", BuildingTones.Midnight);
        Hex("nightVision", BuildingTones.NightVision);
        int k = 0;
        foreach (JsonElement rgb in t.GetProperty("noonRgb").EnumerateArray())
        {
            var (r, g, b) = BuildingTones.NoonRgb((BuildingTone)k);
            double[] w = Nums(rgb);
            m.Equal($"noonRgb {k}", $"{w[0]},{w[1]},{w[2]}", $"{r},{g},{b}");
            k++;
        }
        m.Equal("roofTones", string.Join(",", Nums(t, "roofTones")), string.Join(",", BuildingTones.RoofTones.Select(x => (int)x)));
        m.Equal("wallTones", string.Join(",", Nums(t, "wallTones")), string.Join(",", BuildingTones.WallTones.Select(x => (int)x)));
        foreach (JsonElement n in t.GetProperty("nearest").EnumerateArray())
        {
            double[] v = Nums(n);
            int rgbv = (int)v[0];
            m.Equal($"nearest roof {rgbv:x6}", (int)v[1], (int)BuildingTones.NearestTone(rgbv, BuildingTones.RoofTones));
            m.Equal($"nearest wall {rgbv:x6}", (int)v[2], (int)BuildingTones.NearestTone(rgbv, BuildingTones.WallTones));
        }
        m.AssertNone();
    }
}
