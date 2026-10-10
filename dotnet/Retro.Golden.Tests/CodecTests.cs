using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Retro.Core;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

public class CodecTests
{
    private static readonly JsonElement Fx = Load("codecs.json");

    public static IEnumerable<object[]> TileFiles() =>
        Fx.GetProperty("tiles").EnumerateArray().Select(t => new object[] { t.GetProperty("file").GetString()! });

    private static JsonElement Entry(string file) =>
        Fx.GetProperty("tiles").EnumerateArray().First(t => t.GetProperty("file").GetString() == file);

    [Theory]
    [MemberData(nameof(TileFiles))]
    public void DecodesLikeTheOracle(string file)
    {
        JsonElement e = Entry(file);
        var m = new Mismatches();
        byte[] raw = File.ReadAllBytes(Path.Combine(Root, file));
        m.Equal("sha256", e.GetProperty("sha256").GetString(), Convert.ToHexString(SHA256.HashData(raw)).ToLowerInvariant());
        m.Equal("bytes", e.GetProperty("bytes").GetInt32(), raw.Length);
        Assert.False(e.TryGetProperty("error", out _), "the oracle failed to decode this tile");

        string ext = e.GetProperty("ext").GetString()!;
        object decoded;
        if (ext == "pdm")
        {
            DemTile dem = TileFile.Pdm(raw);
            decoded = dem;
            int i = 0;
            foreach (JsonElement s in e.GetProperty("samples").EnumerateArray())
            {
                double u = Num(s, "u"), v = Num(s, "v");
                m.Close($"sample {i} bilinear ({u}, {v})", Num(s, "bilinear"), DemCodec.SampleBilinear(dem, u, v), 1e-12);
                m.Close($"sample {i} nearest ({u}, {v})", Num(s, "nearest"), DemCodec.SampleNearest(dem, u, v), 0);
                i++;
            }
        }
        else
        {
            byte[] inflated = TileFile.Inflate(raw);
            m.Equal("inflatedBytes", e.GetProperty("inflatedBytes").GetInt32(), inflated.Length);
            m.Equal("inflatedFnv1a32", e.GetProperty("inflatedFnv1a32").GetString(), Structural.Fnv1a32(inflated).ToString("x8"));
            decoded = ext switch
            {
                "ptm" => PtmCodec.Decode(inflated),
                "ptx" => PtxCodec.Decode(inflated),
                "ptr" => PtrCodec.Decode(inflated),
                "pbr" => PbrCodec.Decode(inflated),
                "pbh" => PbhCodec.Decode(inflated),
                "pbd" => PbdCodec.Decode(inflated),
                "pfl" => PflCodec.Decode(inflated),
                _ => throw new InvalidOperationException(ext),
            };
        }
        Structural.Compare("decoded", e.GetProperty("decoded"), decoded, m);
        m.AssertNone();
    }

    [Fact]
    public void EveryFormatHasFixtures()
    {
        var exts = Fx.GetProperty("tiles").EnumerateArray().Select(t => t.GetProperty("ext").GetString()).ToHashSet();
        foreach (string ext in new[] { "ptm", "pdm", "ptx", "ptr", "pbr", "pbh", "pbd", "pfl" }) Assert.Contains(ext, exts);
    }

    [Fact]
    public void TileIndices()
    {
        var m = new Mismatches();
        foreach (JsonElement ix in Fx.GetProperty("indices").EnumerateArray())
        {
            string name = ix.GetProperty("file").GetString()!;
            TileIndex index = TileIndex.Decode(File.ReadAllBytes(Path.Combine(Root, "tiles", "index", name)));
            m.Equal($"{name} minZoom", ix.GetProperty("minZoom").GetInt32(), index.MinZoom);
            m.Equal($"{name} maxZoom", ix.GetProperty("maxZoom").GetInt32(), index.MaxZoom);
            JsonElement[] levels = ix.GetProperty("levels").EnumerateArray().ToArray();
            m.Equal($"{name} levels", string.Join(",", levels.Select(l => l.GetProperty("z").GetInt32())), string.Join(",", index.Levels));
            foreach (JsonElement l in levels)
            {
                int z = l.GetProperty("z").GetInt32();
                List<TileKey> tiles = index.TilesAt(z);
                m.Equal($"{name} z{z} count", l.GetProperty("count").GetInt32(), tiles.Count);
                byte[] joined = Encoding.UTF8.GetBytes(string.Join("\n", tiles.Select(t => t.ToString())));
                m.Equal($"{name} z{z} keys", l.GetProperty("keysFnv1a32").GetString(), Structural.Fnv1a32(joined).ToString("x8"));
                foreach (JsonElement p in l.GetProperty("probes").EnumerateArray())
                {
                    JsonElement k = p.GetProperty("key");
                    var key = new TileKey(k.GetProperty("z").GetInt32(), k.GetProperty("x").GetInt32(), k.GetProperty("y").GetInt32());
                    m.Equal($"{name} has {key}", p.GetProperty("has").GetBoolean(), index.Has(key));
                }
            }
        }
        m.AssertNone();
    }
}
