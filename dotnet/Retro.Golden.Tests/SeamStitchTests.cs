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

/// <summary>seamStitch.ts over real neighbouring Gran Canaria tiles (seam_stitch.json).</summary>
public class SeamStitchTests
{
    private static readonly JsonElement Fx = Load("seam_stitch.json");

    private static string Hash<T>(T[] a) where T : unmanaged =>
        Structural.Fnv1a32(MemoryMarshal.AsBytes(a.AsSpan())).ToString("x8");

    private static void Array<T>(Mismatches m, string what, JsonElement e, T[] actual) where T : unmanaged
    {
        m.Equal(what + ".length", e.GetProperty("length").GetInt32(), actual.Length);
        m.Equal(what + ".fnv1a32", e.GetProperty("fnv1a32").GetString(), Hash(actual));
        int i = 0;
        foreach (JsonElement h in e.GetProperty("head").EnumerateArray())
        {
            m.Equal($"{what}[{i}]", h.GetDouble(), Convert.ToDouble(actual[i]));
            i++;
        }
    }

    private static TileKey Key(JsonElement e) =>
        new(e.GetProperty("z").GetInt32(), e.GetProperty("x").GetInt32(), e.GetProperty("y").GetInt32());

    private sealed class Built
    {
        public StitchTile Tile = null!;
        public short[] Baked = null!;
    }

    private static List<Built> Build(Mismatches m)
    {
        var tiles = new List<Built>();
        foreach (JsonElement t in Fx.GetProperty("tiles").EnumerateArray())
        {
            string file = t.GetProperty("file").GetString()!;
            PtmTile ptm = PtmCodec.Decode(TileFile.Inflate(File.ReadAllBytes(Path.Combine(Root, file))));
            short[] positions = (short[])ptm.LandPositions.Clone();
            sbyte[] normals = (sbyte[])ptm.LandNormals.Clone();
            byte[] attrs = (byte[])ptm.LandAttrs.Clone();
            LandMesh.LeanEdgeNormals(positions, normals);
            ushort[] sizes = LandMesh.RegionSizes(positions, attrs, ptm.QuantScale);
            SmoothLandMesh smooth = t.GetProperty("smooth").GetBoolean()
                ? LandMesh.BuildSmoothLandGeometry(positions, normals, attrs, sizes)
                : null;
            double scale = Num(t, "scale");
            m.Equal(file + " scale", scale, (double)ptm.QuantScale);
            m.Equal(file + " id", Key(t.GetProperty("id")), ptm.Id);
            m.Equal(file + " bakedPositions", t.GetProperty("bakedPositions").GetString(), Hash(positions));
            m.Equal(file + " leanedNormals", t.GetProperty("leanedNormals").GetString(), Hash(normals));
            m.Equal(file + " regionSizes", t.GetProperty("regionSizes").GetString(), Hash(sizes));
            m.Equal(file + " borderVertices", t.GetProperty("borderVertices").GetInt32(), ptm.Border?.Vertices.Length ?? 0);
            if (smooth != null)
            {
                m.Equal(file + " bakedSmoothPositions", t.GetProperty("bakedSmoothPositions").GetString(), Hash(smooth.OutPositions));
            }
            tiles.Add(new Built
            {
                Baked = ptm.LandPositions,
                Tile = new StitchTile
                {
                    Id = ptm.Id,
                    Border = ptm.Border,
                    Matrix = Mat4d.Compose(V3(t.GetProperty("position")), Q(t.GetProperty("quaternion")), new Vec3d(scale, scale, scale)),
                    Scale = scale,
                    Positions = positions,
                    Normals = normals,
                    Attrs = attrs,
                    RegionSizes = sizes,
                    SmoothPositions = smooth?.OutPositions,
                    SmoothIndices = smooth?.Indices,
                },
            });
        }
        return tiles;
    }

    [Fact]
    public void MatchesTheOracle()
    {
        var m = new Mismatches();
        List<Built> tiles = Build(m);
        foreach (JsonElement sc in Fx.GetProperty("scenarios").EnumerateArray())
        {
            string name = sc.GetProperty("name").GetString()!;
            var keys = sc.GetProperty("drawn").EnumerateArray().Select(k => k.GetString()).ToList();
            var drawn = keys.Select(k => tiles.First(t => t.Tile.Id.ToString() == k).Tile).ToList();
            int?[] before = tiles.Select(t => t.Tile.Seam?.Version).ToArray();
            int moved = SeamStitch.Stitch(drawn);
            m.Equal($"{name} moved", sc.GetProperty("moved").GetInt32(), moved);
            int i = 0;
            foreach (JsonElement te in sc.GetProperty("tiles").EnumerateArray())
            {
                Built b = tiles[i];
                StitchTile t = b.Tile;
                string what = $"{name} {te.GetProperty("key").GetString()}";
                m.Equal(what + " key", te.GetProperty("key").GetString(), t.Id.ToString());
                bool isDrawn = te.GetProperty("drawn").GetBoolean();
                JsonElement masters = te.GetProperty("masters");
                if (masters.ValueKind == JsonValueKind.Null)
                {
                    m.Equal(what + " no seam", true, t.Seam == null);
                }
                else
                {
                    string expect = string.Join("|", masters.EnumerateArray().Select(x => x.GetString()));
                    string actual = t.Seam == null ? "<none>" : System.Text.RegularExpressions.Regex.Replace(t.Seam.Signature, @"@\d+", "");
                    m.Equal(what + " masters", expect, actual);
                }
                JsonElement vc = te.GetProperty("versionChanged");
                if (vc.ValueKind != JsonValueKind.Null)
                {
                    m.Equal(what + " versionChanged", vc.GetBoolean(), t.Seam!.Version != before[i]);
                }
                // Flags only describe the call when the tile was drawn in it.
                bool changed = isDrawn && t.PositionsChanged;
                m.Equal(what + " positionsChanged", te.GetProperty("positionsChanged").GetBoolean(), changed);
                if (changed)
                {
                    m.Equal(what + " dirtyStart", te.GetProperty("dirtyStart").GetInt32(), t.DirtyLo * 3);
                    m.Equal(what + " dirtyCount", te.GetProperty("dirtyCount").GetInt32(), (t.DirtyHi - t.DirtyLo + 1) * 3);
                }
                m.Equal(what + " positions", te.GetProperty("positions").GetString(), Hash(t.Positions));
                int off = 0;
                for (int k = 0; k < t.Positions.Length; k++) if (t.Positions[k] != b.Baked[k]) off++;
                m.Equal(what + " componentsOffBaked", te.GetProperty("componentsOffBaked").GetInt32(), off);
                JsonElement sp = te.GetProperty("smoothPositions");
                if (sp.ValueKind != JsonValueKind.Null)
                {
                    m.Equal(what + " smoothPositions", sp.GetString(), Hash(t.SmoothPositions));
                }
                JsonElement fe = te.GetProperty("fill");
                if (fe.ValueKind == JsonValueKind.Null)
                {
                    m.Equal(what + " fill", true, t.Fill == null);
                }
                else if (t.Fill == null)
                {
                    m.Fail(what + ": expected a fill, got none");
                }
                else
                {
                    m.Equal(what + " fill.vertexCount", fe.GetProperty("vertexCount").GetInt32(), t.Fill.VertexCount);
                    Array(m, what + " fill.positions", fe.GetProperty("positions"), t.Fill.Positions);
                    Array(m, what + " fill.normals", fe.GetProperty("normals"), t.Fill.Normals);
                    Array(m, what + " fill.attrs", fe.GetProperty("attrs"), t.Fill.Attrs);
                    Array(m, what + " fill.sizes", fe.GetProperty("sizes"), t.Fill.Sizes);
                }
                i++;
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void ExercisesMovesFillsAndQuietPasses()
    {
        var scenarios = Fx.GetProperty("scenarios").EnumerateArray().ToList();
        Assert.Contains(scenarios, s => s.GetProperty("moved").GetInt32() == 0);
        Assert.Contains(scenarios, s => s.GetProperty("moved").GetInt32() >= 2);
        Assert.Contains(scenarios, s => s.GetProperty("tiles").EnumerateArray()
            .Any(t => t.GetProperty("fill").ValueKind != JsonValueKind.Null));
    }

    [Fact]
    public void Helpers()
    {
        var m = new Mismatches();
        var drawn = Fx.GetProperty("tiles").EnumerateArray().Select(t => Key(t.GetProperty("id"))).ToDictionary(k => k, k => k);
        foreach (JsonElement h in Fx.GetProperty("helpers").EnumerateArray())
        {
            TileKey id = Key(h.GetProperty("id"));
            int side = h.GetProperty("side").GetInt32();
            string what = $"{id} side {side}";
            JsonElement across = h.GetProperty("across");
            bool has = SeamStitch.NeighbourAcross(id, side, out TileKey a);
            m.Equal(what + " across?", across.ValueKind != JsonValueKind.Null, has);
            if (has && across.ValueKind != JsonValueKind.Null) m.Equal(what + " across", Key(across), a);
            JsonElement master = h.GetProperty("master");
            bool hasMaster = SeamStitch.MasterOf(id, side, drawn, out TileKey mk, out _);
            m.Equal(what + " master?", master.ValueKind != JsonValueKind.Null, hasMaster);
            if (hasMaster && master.ValueKind != JsonValueKind.Null)
            {
                m.Equal(what + " master", Key(master), mk);
                double[] want = Nums(h, "masterParams");
                double[] ps = { 0, 0.25, 0.5, 1 };
                for (int k = 0; k < 4; k++) m.Equal($"{what} masterParam {ps[k]}", want[k], SeamStitch.MasterParam(id, side, mk, ps[k]));
            }
        }
        m.Equal("min gap", Num(Fx, "seamFillMinGapM"), SeamStitch.SeamFillMinGapM);
        m.AssertNone();
    }
}
