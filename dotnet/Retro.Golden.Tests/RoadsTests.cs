using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/roads.json: road stroke split, far road levels, the
/// trees' road mask, and bridge parts, against the oracle on real .ptr/.pbr tiles.
/// </summary>
public class RoadsTests
{
    private static readonly JsonElement Fx = Load("roads.json");

    public static IEnumerable<object[]> StrokeFiles() =>
        Fx.GetProperty("strokes").EnumerateArray().Select(t => new object[] { t.GetProperty("file").GetString()! });

    public static IEnumerable<object[]> BridgeFiles() =>
        Fx.GetProperty("bridges").EnumerateArray().Select(t => new object[] { t.GetProperty("file").GetString()! });

    private static JsonElement Entry(string list, string file) =>
        Fx.GetProperty(list).EnumerateArray().First(t => t.GetProperty("file").GetString() == file);

    /// <summary>A describe()d typed array, or null, against the port's array.</summary>
    private static void Described(string what, JsonElement expected, Array actual, Mismatches m)
    {
        if (expected.ValueKind == JsonValueKind.Null)
        {
            m.Equal(what + " is null", true, actual == null);
            return;
        }
        Structural.Compare(what, expected, actual, m);
    }

    [Theory]
    [MemberData(nameof(StrokeFiles))]
    public void RoadStrokesSplitLikeTheOracle(string file)
    {
        JsonElement e = Entry("strokes", file);
        var m = new Mismatches();
        PtrTile tile = TileFile.Ptr(File.ReadAllBytes(Path.Combine(Root, file)));
        double q = tile.QuantScale;
        m.Close("quantScale", Num(e, "quantScale"), q, 0);

        RoadTileMeshes roads = RoadStrokes.Build(tile, q);
        RoadTileMeshes other = RoadStrokes.Build(tile, q * 1.25);
        m.Close("groupScale", Num(e, "groupScale"), roads.GroupScale, 0);
        m.Close("groupScaleOther", Num(e, "groupScaleOther"), other.GroupScale, 1e-15);
        m.Equal("triangles", e.GetProperty("triangles").GetInt32(), roads.Triangles());
        m.Equal("trianglesNoTrackPasses", e.GetProperty("trianglesNoTrackPasses").GetInt32(), roads.Triangles(false));
        m.Equal("bytes", e.GetProperty("bytes").GetInt64(), roads.Bytes);

        double[] up = Nums(e, "up");
        JsonElement kinds = e.GetProperty("kinds");
        foreach (StrokeKind kind in new[] { StrokeKind.Major, StrokeKind.Minor, StrokeKind.Rail })
        {
            string name = kind.ToString().ToLowerInvariant();
            JsonElement k = kinds.GetProperty(name);
            ushort[] indices = roads.Of(kind);
            if (k.ValueKind == JsonValueKind.Null)
            {
                m.Equal($"{name} absent", true, indices == null);
                continue;
            }
            if (indices == null)
            {
                m.Fail($"{name}: the port has no index list");
                continue;
            }
            Described($"{name}.indices", k.GetProperty("indices"), indices, m);
            m.Equal($"{name}.isAll", k.GetProperty("isAll").GetBoolean(), ReferenceEquals(indices, tile.Indices));

            // In order: roadLevels.
            JsonElement inOrder = k.GetProperty("levels").GetProperty("inOrder");
            ushort[][] all = RoadLod.AllLevels(tile, indices, up[0], up[1], up[2]);
            var seen = new List<ushort[]>();
            int[] refs = all.Select(l => RefId(seen, l)).ToArray();
            m.Equal($"{name}.inOrder.refs", string.Join(",", inOrder.GetProperty("refs").EnumerateArray().Select(x => x.GetInt32())), string.Join(",", refs));
            JsonElement[] want = inOrder.GetProperty("levels").EnumerateArray().ToArray();
            m.Equal($"{name}.inOrder.distinct", want.Length, seen.Count);
            for (int i = 0; i < Math.Min(want.Length, seen.Count); i++) Described($"{name}.inOrder.levels[{i}]", want[i], seen[i], m);

            // Lazily, out of order: build 3, 1, 4, 2.
            JsonElement lazy = k.GetProperty("levels").GetProperty("lazy");
            var levels = new RoadLevels(tile, indices, up[0], up[1], up[2]);
            var seen2 = new List<ushort[]> { indices };
            int step = 0;
            foreach (JsonElement s in lazy.GetProperty("steps").EnumerateArray())
            {
                int level = s.GetProperty("build").GetInt32();
                levels.Build(level);
                string has = string.Join(",", Enumerable.Range(0, 6).Select(l => levels.Has(l)));
                string get = string.Join(",", Enumerable.Range(0, 6).Select(l => RefId(seen2, levels.Get(l))));
                m.Equal($"{name}.lazy[{step}].has", string.Join(",", s.GetProperty("has").EnumerateArray().Select(x => x.GetBoolean())), has);
                m.Equal($"{name}.lazy[{step}].get", string.Join(",", s.GetProperty("get").EnumerateArray().Select(x => x.GetInt32())), get);
                step++;
            }
            JsonElement[] want2 = lazy.GetProperty("levels").EnumerateArray().ToArray();
            m.Equal($"{name}.lazy.distinct", want2.Length, seen2.Count);
            for (int i = 0; i < Math.Min(want2.Length, seen2.Count); i++) Described($"{name}.lazy.levels[{i}]", want2[i], seen2[i], m);
        }

        JsonElement ex = e.GetProperty("exclusion");
        RoadExclusion mask = RoadExclusion.Build(tile);
        if (ex.ValueKind == JsonValueKind.Null)
        {
            m.Equal("exclusion absent", true, mask == null);
        }
        else
        {
            double[] pts = Nums(ex, "points");
            string hits = ex.GetProperty("hits").GetString()!;
            var got = new StringBuilder();
            for (int i = 0; i < pts.Length; i += 2) got.Append(mask.Test(pts[i], pts[i + 1]) ? '1' : '0');
            m.Equal("exclusion.hits", hits, got.ToString());
        }
        m.AssertNone();
    }

    private static int RefId(List<ushort[]> seen, ushort[] a)
    {
        int i = seen.FindIndex(x => ReferenceEquals(x, a));
        if (i >= 0) return i;
        seen.Add(a);
        return seen.Count - 1;
    }

    private static void Sphere(string what, JsonElement expected, BoundsSphere s, Mismatches m)
    {
        double[] c = Nums(expected, "center");
        m.Close(what + ".cx", c[0], s.CenterX, 0);
        m.Close(what + ".cy", c[1], s.CenterY, 0);
        m.Close(what + ".cz", c[2], s.CenterZ, 0);
        m.Close(what + ".r", Num(expected, "radius"), s.Radius, 1e-15);
    }

    private static readonly string[] SlotNames = { "deck", "concrete", "railDeck", "signRed", "signWhite", "signPost" };

    [Theory]
    [MemberData(nameof(BridgeFiles))]
    public void BridgesSplitLikeTheOracle(string file)
    {
        JsonElement e = Entry("bridges", file);
        var m = new Mismatches();
        PbrTile tile = TileFile.Pbr(File.ReadAllBytes(Path.Combine(Root, file)));
        BridgeTileMeshes set = BridgeMeshes.Build(tile, tile.QuantScale);
        m.Equal("bytes", e.GetProperty("bytes").GetInt64(), set.Bytes);

        JsonElement slots = e.GetProperty("slots");
        for (int r = 0; r < 6; r++)
        {
            JsonElement s = slots.GetProperty(SlotNames[r]);
            BridgePart part = set.Slots[r];
            if (s.ValueKind == JsonValueKind.Null)
            {
                m.Equal($"{SlotNames[r]} absent", true, part == null);
                continue;
            }
            if (part == null)
            {
                m.Fail($"{SlotNames[r]}: the port has no part");
                continue;
            }
            bool box = s.GetProperty("boxes").GetBoolean();
            m.Equal($"{SlotNames[r]}.boxes", box, part.Box != null);
            Described($"{SlotNames[r]}.index", s.GetProperty("index"), box ? part.Box.Indices : part.Indices, m);
            m.Equal($"{SlotNames[r]}.isAll", s.GetProperty("isAll").GetBoolean(), ReferenceEquals(part.Indices, tile.Indices));
            Sphere($"{SlotNames[r]}.sphere", s.GetProperty("sphere"), part.Bounds, m);
        }
        JsonElement[] extra = e.GetProperty("extra").EnumerateArray().ToArray();
        m.Equal("extra.length", extra.Length, set.Extra.Count);
        for (int i = 0; i < Math.Min(extra.Length, set.Extra.Count); i++)
        {
            Described($"extra[{i}].index", extra[i].GetProperty("index"), set.Extra[i].Box.Indices, m);
            Sphere($"extra[{i}].sphere", extra[i].GetProperty("sphere"), set.Extra[i].Bounds, m);
        }

        JsonElement boxes = e.GetProperty("boxes");
        for (int r = 0; r < 6; r++)
        {
            JsonElement b = boxes.GetProperty(r.ToString());
            BridgeBoxMesh mesh = tile.Boxes != null ? BridgeMeshes.BoxGeometry(tile.Boxes, (BridgeRole)r, tile.QuantScale) : null;
            if (b.ValueKind == JsonValueKind.Null)
            {
                m.Equal($"boxes[{r}] absent", true, mesh == null);
                continue;
            }
            if (mesh == null)
            {
                m.Fail($"boxes[{r}]: the port built none");
                continue;
            }
            Described($"boxes[{r}].positions", b.GetProperty("positions"), mesh.Positions, m);
            Described($"boxes[{r}].normals", b.GetProperty("normals"), mesh.Normals, m);
            Described($"boxes[{r}].indices", b.GetProperty("indices"), mesh.Indices, m);
        }

        JsonElement track = e.GetProperty("track");
        if (track.ValueKind == JsonValueKind.Null)
        {
            m.Equal("track absent", true, set.Track == null);
        }
        else if (set.Track == null)
        {
            m.Fail("track: the port has none");
        }
        else
        {
            Described("track.index", track.GetProperty("index"), set.Track.Indices, m);
            Sphere("track.sphere", track.GetProperty("sphere"), set.TrackBounds, m);
            m.Equal("track.flags clear", true, set.Track.Flags.All(f => f == 0));
        }

        // Triangles: the oracle's triangles(set) is every mesh's index count / 3.
        int want = 0;
        foreach (JsonElement s in slots.EnumerateObject().Select(p => p.Value))
        {
            if (s.ValueKind != JsonValueKind.Null) want += s.GetProperty("index").GetProperty("length").GetInt32() / 3;
        }
        foreach (JsonElement x in extra) want += x.GetProperty("index").GetProperty("length").GetInt32() / 3;
        if (track.ValueKind != JsonValueKind.Null) want += 3 * (track.GetProperty("index").GetProperty("length").GetInt32() / 3);
        m.Equal("triangles", want, set.Triangles());
        m.AssertNone();
    }

    [Fact]
    public void RoadLevelForAndTrackReach()
    {
        var m = new Mismatches();
        foreach (JsonElement p in Fx.GetProperty("roadLevelFor").EnumerateArray())
        {
            double[] a = Nums(p);
            m.Equal($"roadLevelFor({a[0]})", (int)a[1], RoadLod.LevelFor(a[0]));
        }
        foreach (JsonElement p in Fx.GetProperty("trackDetailReach").EnumerateArray())
        {
            double[] a = Nums(p);
            // Math.Tan is the CRT's, not V8's fdlibm: an ulp apart at most.
            m.Close($"trackDetailReachM({a[0]}, {a[1]}, {a[2]})", a[3], RoadStrokes.TrackDetailReachM(a[0], a[1], a[2]), 1e-12);
        }
        m.AssertNone();
    }

    [Fact]
    public void FixturesCoverEveryKindAndPart()
    {
        var strokes = Fx.GetProperty("strokes").EnumerateArray().ToArray();
        Assert.Contains(strokes, s => s.GetProperty("kinds").GetProperty("rail").ValueKind != JsonValueKind.Null);
        Assert.Contains(strokes, s => s.GetProperty("kinds").GetProperty("major").ValueKind != JsonValueKind.Null);
        var bridges = Fx.GetProperty("bridges").EnumerateArray().ToArray();
        Assert.Contains(bridges, b => b.GetProperty("track").ValueKind != JsonValueKind.Null);
        Assert.Contains(bridges, b => b.GetProperty("slots").GetProperty("signRed").ValueKind != JsonValueKind.Null);
    }
}
