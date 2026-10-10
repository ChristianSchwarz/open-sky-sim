using System.Text.Json;
using Retro.Core;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

public class TilingTests
{
    private static readonly JsonElement Fx = Load("tiling.json");

    private static TileKey Key(JsonElement e) =>
        new(e.GetProperty("z").GetInt32(), e.GetProperty("x").GetInt32(), e.GetProperty("y").GetInt32());

    [Fact]
    public void TilesBoundsParentsChildren()
    {
        var m = new Mismatches();
        foreach (JsonElement t in Fx.GetProperty("tiles").EnumerateArray())
        {
            TileKey k = Key(t.GetProperty("key"));
            m.Equal($"{k} keyString", t.GetProperty("keyString").GetString(), k.ToString());
            m.Equal($"{k} xCount", t.GetProperty("xCount").GetInt32(), Tiling.XCount(k.Z));
            m.Equal($"{k} yCount", t.GetProperty("yCount").GetInt32(), Tiling.YCount(k.Z));
            double[] b = Nums(t, "bounds");
            LonLatBounds got = Tiling.Bounds(k);
            m.Close($"{k} west", b[0], got.West, 0);
            m.Close($"{k} south", b[1], got.South, 0);
            m.Close($"{k} east", b[2], got.East, 0);
            m.Close($"{k} north", b[3], got.North, 0);
            JsonElement parent = t.GetProperty("parent");
            TileKey? p = Tiling.Parent(k);
            if (parent.ValueKind == JsonValueKind.Null) m.Equal($"{k} parent", false, p.HasValue);
            else m.Equal($"{k} parent", Key(parent), p ?? default);
            TileKey[] children = Tiling.Children(k);
            int i = 0;
            foreach (JsonElement c in t.GetProperty("children").EnumerateArray()) m.Equal($"{k} child {i}", Key(c), children[i++]);
            m.Close($"{k} edge", Num(t, "approxEdgeMetres"), Tiling.ApproxEdgeMetres(k), 1e-9);
        }
        m.AssertNone();
    }

    [Fact]
    public void LookupsAndRanges()
    {
        var m = new Mismatches();
        foreach (JsonElement l in Fx.GetProperty("lookups").EnumerateArray())
        {
            int z = l.GetProperty("z").GetInt32();
            double lon = Num(l, "lon"), lat = Num(l, "lat");
            m.Equal($"z{z} ({lon}, {lat})", Key(l.GetProperty("tile")), Tiling.AtLonLat(z, lon, lat));
        }
        foreach (JsonElement r in Fx.GetProperty("ranges").EnumerateArray())
        {
            int z = r.GetProperty("z").GetInt32();
            double[] b = Nums(r, "bounds");
            TileRange got = Tiling.RangeForBounds(z, new LonLatBounds(b[0], b[1], b[2], b[3]));
            JsonElement want = r.GetProperty("range");
            string at = $"z{z} [{string.Join(", ", b)}]";
            m.Equal($"{at} x0", want.GetProperty("x0").GetInt32(), got.X0);
            m.Equal($"{at} y0", want.GetProperty("y0").GetInt32(), got.Y0);
            m.Equal($"{at} x1", want.GetProperty("x1").GetInt32(), got.X1);
            m.Equal($"{at} y1", want.GetProperty("y1").GetInt32(), got.Y1);
        }
        int n = 0;
        foreach (JsonElement root in Fx.GetProperty("roots").EnumerateArray()) m.Equal($"root {n}", Key(root), Tiling.RootTiles()[n++]);
        m.AssertNone();
    }
}
