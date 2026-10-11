using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/clouds.json: three.js icosahedra, the cumulus models (welded solid body
/// with smooth normals, the 12-tier haze buffer and its LOD prefixes), the cirrus streaks, and
/// the scenery field's per-pass placement (tile wrap, re-base, frustum, screen-size LOD) along
/// seven camera paths. Everything is compared exactly.
/// </summary>
public class CloudsTests
{
    private static readonly JsonElement Fx = Load("clouds.json");

    private static uint Fnv(float[] a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a.AsSpan()));

    private static uint Fnv(int[] a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a.Select(v => (uint)v).ToArray().AsSpan()));

    private static void CompareFloats(string at, JsonElement x, float[] actual, Mismatches m)
    {
        m.Equal($"{at} length", x.GetProperty("length").GetInt32(), actual.Length);
        m.Equal($"{at} fnv1a32", x.GetProperty("fnv1a32").GetString(), Fnv(actual).ToString("x8"));
        if (x.TryGetProperty("base64", out JsonElement full))
        {
            float[] expected = MemoryMarshal.Cast<byte, float>(Convert.FromBase64String(full.GetString()!)).ToArray();
            int bad = 0;
            for (int i = 0; i < Math.Min(expected.Length, actual.Length); i++)
            {
                if (BitConverter.SingleToInt32Bits(expected[i]) != BitConverter.SingleToInt32Bits(actual[i]) && bad++ < 3)
                {
                    m.Fail($"{at}[{i}]: expected {expected[i]:R}, got {actual[i]:R}");
                }
            }
            return;
        }
        double[] head = Nums(x, "head");
        for (int i = 0; i < head.Length && i < actual.Length; i++) m.Equal($"{at} head[{i}]", (float)head[i], actual[i]);
        double[] sample = Nums(x, "sample");
        for (int i = 0; i < sample.Length && i * 97 < actual.Length; i++)
        {
            if ((float)sample[i] != actual[i * 97])
            {
                m.Fail($"{at} sample[{i * 97}]: expected {sample[i]:R}, got {actual[i * 97]:R}");
                break;
            }
        }
    }

    private static void CompareInts(string at, JsonElement x, int[] actual, Mismatches m)
    {
        m.Equal($"{at} length", x.GetProperty("length").GetInt32(), actual.Length);
        m.Equal($"{at} fnv1a32", x.GetProperty("fnv1a32").GetString(), Fnv(actual).ToString("x8"));
        double[] head = Nums(x, "head");
        for (int i = 0; i < head.Length && i < actual.Length; i++) m.Equal($"{at} head[{i}]", (int)head[i], actual[i]);
    }

    [Fact]
    public void IcosahedraAndHashMatchThreeJs()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("icosahedra").EnumerateArray())
        {
            double r = Num(c, "radius");
            int d = c.GetProperty("detail").GetInt32();
            CompareFloats($"icosahedron({r}, {d})", c.GetProperty("positions"), ThreeGeometry.Icosahedron(r, d), m);
        }
        foreach (JsonElement h in Fx.GetProperty("hash01").EnumerateArray())
        {
            double[] p = Nums(h);
            m.Equal($"hash01({p[0]})", p[1], CloudModel.Hash01(p[0]));
        }
        m.AssertNone();
    }

    [Fact]
    public void ModelsMatchTheBuilders()
    {
        var m = new Mismatches();
        foreach (JsonElement x in Fx.GetProperty("models").EnumerateArray())
        {
            string name = x.GetProperty("name").GetString()!;
            SkyShapeModel model = SkyModels.Get("lib:" + name);
            m.Equal($"{name} maxSize", Num(x, "maxSize"), model.MaxSize);
            m.Equal($"{name} centerY", Num(x, "centerY"), model.CenterY);
            m.Equal($"{name} lodCount", x.GetProperty("lodCount").GetInt32(), model.LodCount);
            double[] tris = Nums(x, "triangles");
            for (int i = 0; i < tris.Length; i++) m.Equal($"{name} triangles[{i}]", (int)tris[i], model.Triangles(i));
            if (model is CloudModel cloud && x.TryGetProperty("solid", out JsonElement solid))
            {
                CompareFloats($"{name} solid positions", solid.GetProperty("positions"), cloud.SolidPositions, m);
                CompareFloats($"{name} solid normals", solid.GetProperty("normals"), cloud.SolidNormals, m);
                CompareInts($"{name} solid index", solid.GetProperty("index"), cloud.SolidIndices, m);
                JsonElement haze = x.GetProperty("haze");
                CompareFloats($"{name} haze positions", haze.GetProperty("positions"), cloud.HazePositions, m);
                CompareFloats($"{name} haze normals", haze.GetProperty("normals"), cloud.HazeNormals, m);
                CompareFloats($"{name} haze ditherLevel", haze.GetProperty("ditherLevel"), cloud.HazeDitherLevel, m);
                double[] ranges = Nums(haze, "drawRanges");
                for (int i = 0; i < ranges.Length; i++) m.Equal($"{name} haze range[{i}]", (int)ranges[i], cloud.HazeVertexCount(i));
            }
            else if (model is CirrusModel cirrus && x.TryGetProperty("positions", out JsonElement positions))
            {
                CompareFloats($"{name} positions", positions, cirrus.Positions, m);
                CompareFloats($"{name} normals", x.GetProperty("normals"), cirrus.Normals, m);
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void FieldPlacementMatchesAlongCameraPaths()
    {
        var m = new Mismatches();
        int drawnTotal = 0;
        foreach (JsonElement c in Fx.GetProperty("cases").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            Func<double> random = Gun.Mulberry32((uint)c.GetProperty("seed").GetInt32());
            SceneryField field = c.GetProperty("field").GetString() == "cloud"
                ? SkyFields.CreateCloudField(random)
                : SkyFields.CreateCirrusField(random);

            // The deal: model, offset, yaw and bias per cell.
            int ti = 0;
            foreach (JsonElement tile in c.GetProperty("layout").EnumerateArray())
            {
                int ci = 0;
                foreach (JsonElement cell in tile.EnumerateArray())
                {
                    JsonElement[] e = cell.EnumerateArray().ToArray();
                    SceneryField.Cell a = field.Tiles[ti][ci];
                    string at = $"{name} tile {ti} cell {ci}";
                    m.Equal($"{at} model", e[0].GetString(), a.Model.Name);
                    m.Equal($"{at} offsetX", Num(e[1]), a.OffsetX);
                    m.Equal($"{at} offsetZ", Num(e[2]), a.OffsetZ);
                    m.Equal($"{at} q.y", Num(e[3]), a.Rotation.Y);
                    m.Equal($"{at} q.w", Num(e[4]), a.Rotation.W);
                    m.Equal($"{at} bias", (int)Num(e[5]), a.LodBias);
                    ci++;
                }
                ti++;
            }

            int fi = 0;
            var output = new List<FieldInstance>();
            foreach (JsonElement f in c.GetProperty("frames").EnumerateArray())
            {
                string at = $"{name} frame {fi++}";
                if (f.TryGetProperty("rebase", out JsonElement rb) && rb.ValueKind == JsonValueKind.Object)
                {
                    field.Rebase(new FrameShift(Q(rb.GetProperty("rotation")), V3(rb.GetProperty("offset"))));
                    double[] fo = Nums(rb, "fieldOffset");
                    m.Equal($"{at} fieldOffset.x", fo[0], field.FieldOffsetX);
                    m.Equal($"{at} fieldOffset.z", fo[1], field.FieldOffsetZ);
                }
                double[] me = Nums(f, "projScreen");
                FieldFrustum frustum = FieldFrustum.FromProjectionMatrix(me);
                double[][] planes = f.GetProperty("planes").EnumerateArray().Select(Nums).ToArray();
                for (int i = 0; i < 6; i++)
                {
                    for (int k = 0; k < 4; k++) m.Equal($"{at} plane[{i}][{k}]", planes[i][k], frustum.Planes[i * 4 + k]);
                }
                var view = new FieldView
                {
                    CameraPosition = V3(f.GetProperty("camera")),
                    TanHalfFov = Num(f, "tanHalfFov"),
                    Aspect = Num(f, "aspect"),
                    TargetWidth = Num(f, "targetWidth"),
                    Frustum = frustum,
                };
                output.Clear();
                field.Collect(view, output, includeUndrawn: true);
                JsonElement[] drawn = f.GetProperty("drawn").EnumerateArray().ToArray();
                m.Equal($"{at} count", drawn.Length, output.Count);
                for (int i = 0; i < Math.Min(drawn.Length, output.Count); i++)
                {
                    double[] d = Nums(drawn[i]);
                    FieldInstance o = output[i];
                    string it = $"{at} #{i}";
                    m.Equal($"{it} tile", (int)d[0], o.Tile);
                    m.Equal($"{it} cell", (int)d[1], o.Cell);
                    m.Equal($"{it} x", d[2], o.Position.X);
                    m.Equal($"{it} y", d[3], o.Position.Y);
                    m.Equal($"{it} z", d[4], o.Position.Z);
                    m.Equal($"{it} lod", (int)d[5], o.Lod);
                    m.Equal($"{it} triangles", (int)d[6], o.Lod < 0 ? 0 : o.Model.Triangles(o.Lod));
                }
                drawnTotal += drawn.Length;

                // The default call leaves out exactly the undrawn ones.
                var drawnOnly = new List<FieldInstance>();
                field.Collect(view, drawnOnly);
                m.Equal($"{at} drawn only", output.Count(o => o.Lod >= 0), drawnOnly.Count);
            }
        }
        Assert.True(drawnTotal > 1000, $"only {drawnTotal} cells compared");
        m.AssertNone();
    }
}
