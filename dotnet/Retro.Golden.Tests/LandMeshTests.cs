using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>tileMesh.ts land preparation: leanEdgeNormals, regionSizes, the SMOOTH weld.</summary>
public class LandMeshTests
{
    private static readonly JsonElement Fx = Load("land_mesh.json");

    public static IEnumerable<object[]> Tiles() =>
        Fx.GetProperty("tiles").EnumerateArray().Select(t => new object[] { t.GetProperty("file").GetString()! });

    private static JsonElement Entry(string file) =>
        Fx.GetProperty("tiles").EnumerateArray().First(t => t.GetProperty("file").GetString() == file);

    private static void Array<T>(Mismatches m, string what, JsonElement e, T[] actual) where T : unmanaged
    {
        m.Equal(what + ".length", e.GetProperty("length").GetInt32(), actual.Length);
        m.Equal(what + ".fnv1a32", e.GetProperty("fnv1a32").GetString(),
            Structural.Fnv1a32(MemoryMarshal.AsBytes(actual.AsSpan())).ToString("x8"));
        int i = 0;
        foreach (JsonElement h in e.GetProperty("head").EnumerateArray())
        {
            m.Equal($"{what}[{i}]", h.GetDouble(), Convert.ToDouble(actual[i]));
            i++;
        }
    }

    [Theory]
    [MemberData(nameof(Tiles))]
    public void MatchesTheOracle(string file)
    {
        JsonElement e = Entry(file);
        var m = new Mismatches();
        PtmTile tile = PtmCodec.Decode(TileFile.Inflate(File.ReadAllBytes(Path.Combine(Root, file))));
        m.Equal("quantScale", Num(e, "quantScale"), (double)tile.QuantScale);
        Array(m, "inputPositions", e.GetProperty("inputPositions"), tile.LandPositions);
        Array(m, "inputNormals", e.GetProperty("inputNormals"), tile.LandNormals);
        Array(m, "inputAttrs", e.GetProperty("inputAttrs"), tile.LandAttrs);

        short[] positions = (short[])tile.LandPositions.Clone();
        sbyte[] normals = (sbyte[])tile.LandNormals.Clone();
        byte[] attrs = (byte[])tile.LandAttrs.Clone();
        m.Equal("groundVertices", e.GetProperty("groundVertices").GetInt32(),
            Enumerable.Range(0, attrs.Length / 4).Count(v => attrs[v * 4 + 3] == LandMesh.GroundClass));

        LandMesh.LeanEdgeNormals(positions, normals);
        Array(m, "leanedNormals", e.GetProperty("leanedNormals"), normals);

        ushort[] sizes = LandMesh.RegionSizes(positions, attrs, tile.QuantScale);
        Array(m, "regionSizes", e.GetProperty("regionSizes"), sizes);
        m.Equal("nonZeroSizes", e.GetProperty("nonZeroSizes").GetInt32(), sizes.Count(s => s != 0));

        SmoothLandMesh s = LandMesh.BuildSmoothLandGeometry(positions, normals, attrs, sizes);
        Assert.NotNull(s);
        JsonElement se = e.GetProperty("smooth");
        m.Equal("smooth.vertexCount", se.GetProperty("vertexCount").GetInt32(), s.VertexCount);
        m.Equal("smooth.indexCount", se.GetProperty("indexCount").GetInt32(), s.Indices.Length);
        Array(m, "smooth.positions", se.GetProperty("positions"), s.OutPositions);
        Array(m, "smooth.normals", se.GetProperty("normals"), s.OutNormals);
        Array(m, "smooth.attrs", se.GetProperty("attrs"), s.OutAttrs);
        Array(m, "smooth.sizes", se.GetProperty("sizes"), s.OutSizes);
        Array(m, "smooth.indices", se.GetProperty("indices"), s.Indices);
        m.AssertNone();
    }

    [Fact]
    public void CoversLanduseAndRasterOnlyTiles()
    {
        var tiles = Fx.GetProperty("tiles").EnumerateArray().ToList();
        Assert.Contains(tiles, t => t.GetProperty("groundVertices").GetInt32() > 0 && t.GetProperty("nonZeroSizes").GetInt32() > 0);
        Assert.Contains(tiles, t => t.GetProperty("groundVertices").GetInt32() == 0);
    }

    [Fact]
    public void EmptySoupHasNoSmoothMesh()
    {
        Assert.Null(LandMesh.BuildSmoothLandGeometry(new short[0], new sbyte[0], new byte[0]));
    }
}
