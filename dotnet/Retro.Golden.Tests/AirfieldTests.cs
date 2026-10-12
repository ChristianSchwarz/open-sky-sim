using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>Replays tests/golden/airfields.json: airfield geometry, runway paint and taxiway smoothing.</summary>
public class AirfieldTests
{
    private static readonly JsonElement Fx = Load("airfields.json");

    private static double? OptNum(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out JsonElement v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    private static double[][] Points(JsonElement e) =>
        e.EnumerateArray().Select(p => p.EnumerateArray().Select(Num).ToArray()).ToArray();

    private static RunwaySurface Surface(string s) => AirfieldsJson.Surface(s);

    /// <summary>The fixture's airfields.json record through the same parse Unity uses.</summary>
    internal static Airfield ParseAirfield(JsonElement a) => AirfieldsJson.ParseAirfield(Retro.Core.JsonReader.Parse(a.GetRawText()));

    private static uint Fnv(float[] a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a.AsSpan()));

    private static void ComparePart(string at, JsonElement x, AirfieldPart p, AirfieldGeometry g, Mismatches m)
    {
        m.Equal($"{at} category", x.GetProperty("category").GetString(), PaletteCategories.Key(p.Paint.Category));
        // flatMaterial: a bare tone is overbright 1; solids ask for none.
        m.Equal($"{at} overbright", OptNum(x, "overbright"), p.Shaded ? null : p.Paint.Bare ? 1 : p.Paint.Lighten);
        JsonElement raw = x.GetProperty("rawColor");
        m.Equal($"{at} rawColor", raw.ValueKind == JsonValueKind.Null ? null : raw.GetString(), p.Paint.RawColor);
        m.Equal($"{at} maxFootprintM", OptNum(x, "maxFootprintM"), p.Paint.MaxFootprintM);
        m.Equal($"{at} shaded", x.GetProperty("shaded").GetBoolean(), p.Shaded);
        double? hash = OptNum(x, "markingHash");
        m.Equal($"{at} markingHash", hash.HasValue ? (uint?)(uint)hash.Value : null,
            p.MarkedRunway >= 0 ? Structural.Fnv1a32(g.MarkingTextures[p.MarkedRunway].Data) : (uint?)null);
        m.Equal($"{at} count", x.GetProperty("count").GetInt32(), p.Positions.Length);
        if (x.TryGetProperty("positions", out JsonElement full))
        {
            float[] expected = MemoryMarshal.Cast<byte, float>(Convert.FromBase64String(full.GetString()!)).ToArray();
            int bad = 0;
            for (int i = 0; i < Math.Min(expected.Length, p.Positions.Length); i++)
            {
                if (expected[i] != p.Positions[i] && bad++ < 3) m.Fail($"{at} position[{i}]: expected {expected[i]:R}, got {p.Positions[i]:R}");
            }
        }
        else
        {
            float[] head = MemoryMarshal.Cast<byte, float>(Convert.FromBase64String(x.GetProperty("head").GetString()!)).ToArray();
            for (int i = 0; i < head.Length && i < p.Positions.Length; i++)
            {
                if (head[i] != p.Positions[i])
                {
                    m.Fail($"{at} head[{i}]: expected {head[i]:R}, got {p.Positions[i]:R}");
                    break;
                }
            }
            m.Equal($"{at} hash", (uint)Num(x, "hash"), Fnv(p.Positions));
        }
        JsonElement uvs = x.GetProperty("uvs");
        m.Equal($"{at} uvs", uvs.ValueKind == JsonValueKind.Null ? null : string.Join(",", Nums(uvs)),
            p.Uvs == null ? null : string.Join(",", p.Uvs.Select(v => (double)v)));
    }

    [Fact]
    public void AirfieldGeometryMatchesTheOracle()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("cases").EnumerateArray())
        {
            string name = c.GetProperty("icao").GetString() + (c.GetProperty("drape").GetBoolean() ? " draped" : "");
            double[] o = Nums(c, "origin");
            EnuBasis basis = Geodesy.MakeEnuBasis(o[0], o[1], o[2]);
            Airfield airfield = ParseAirfield(c.GetProperty("airfield"));
            var recorded = c.GetProperty("triangulations").EnumerateArray()
                .Select(t => t.EnumerateArray().Select(f => f.EnumerateArray().Select(i => i.GetInt32()).ToArray()).ToList())
                .ToList();
            int call = 0;
            Func<double, double, double> ground = c.GetProperty("drape").GetBoolean()
                ? (e, n) => 40 + 3 * JsTrig.Sin(e / 47) + 2 * JsTrig.Cos(n / 31)
                : null;
            // The oracle's faces, after checking the shared earcut port gives the same ones.
            var noHoles = Array.Empty<IReadOnlyList<(double X, double Y)>>();
            AirfieldGeometry g = AirfieldGeometryBuilder.Build(airfield, basis, ground, contour =>
            {
                List<int[]> faces = ShapeUtils.TriangulateShape(contour, noHoles);
                List<int[]> expected = recorded[call];
                m.Equal($"{name} triangulation {call}",
                    string.Join(";", expected.Select(f => string.Join(",", f))),
                    string.Join(";", faces.Select(f => string.Join(",", f))));
                return recorded[call++];
            });
            m.Equal($"{name} triangulation calls", recorded.Count, call);

            JsonElement r = c.GetProperty("result");
            m.Close($"{name} origin", V3(r.GetProperty("origin")), g.Origin, 1e-12);
            // The target's position without building the geometry: the same point exactly.
            m.Close($"{name} OriginOf", V3(r.GetProperty("origin")), AirfieldGeometryBuilder.OriginOf(airfield, basis).Value, 0);
            m.Close($"{name} maxSize", Num(r, "maxSize"), g.MaxSize, 0);
            var levels = r.GetProperty("levels").EnumerateArray().ToList();
            m.Equal($"{name} levels", levels.Count, g.Levels.Length);
            for (int l = 0; l < Math.Min(levels.Count, g.Levels.Length); l++)
            {
                foreach (var (kind, list) in new[] { ("flats", g.Levels[l].Flats), ("volumes", g.Levels[l].Volumes) })
                {
                    var parts = levels[l].GetProperty(kind).EnumerateArray().ToList();
                    m.Equal($"{name} L{l} {kind} parts", parts.Count, list.Count);
                    for (int i = 0; i < Math.Min(parts.Count, list.Count); i++)
                    {
                        ComparePart($"{name} L{l} {kind}[{i}]", parts[i], list[i], g, m);
                    }
                }
            }
            var strips = r.GetProperty("groundStrips").EnumerateArray().ToList();
            m.Equal($"{name} groundStrips", strips.Count, g.GroundStrips.Count);
            for (int i = 0; i < Math.Min(strips.Count, g.GroundStrips.Count); i++)
            {
                var samples = strips[i].GetProperty("samples").EnumerateArray().Select(V3).ToList();
                for (int k = 0; k < samples.Count; k++) m.Close($"{name} strip {i} sample {k}", samples[k], g.GroundStrips[i].Samples[k], 1e-12);
                JsonElement z = strips[i].GetProperty("paintedZoom");
                m.Equal($"{name} strip {i} zoom", z.ValueKind == JsonValueKind.String ? double.PositiveInfinity : z.GetDouble(), g.GroundStrips[i].PaintedZoom);
                m.Equal($"{name} strip {i} lighten", Num(strips[i], "lighten"), g.GroundStrips[i].Lighten);
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void RunwayMarkingsAndTexturesMatchTheOracle()
    {
        var m = new Mismatches();
        int n = 0;
        foreach (JsonElement c in Fx.GetProperty("markings").EnumerateArray())
        {
            string at = $"markings[{n++}]";
            double lengthM = Num(c, "lengthM"), widthM = Num(c, "widthM");
            List<MarkingRect> rects = RunwayMarkings.For(lengthM, widthM, c.GetProperty("ref").GetString()!, Surface(c.GetProperty("surface").GetString()!));
            var expected = c.GetProperty("rects").EnumerateArray().ToList();
            m.Equal($"{at} rect count", expected.Count, rects.Count);
            for (int i = 0; i < Math.Min(expected.Count, rects.Count); i++)
            {
                var e = expected[i].EnumerateArray().ToList();
                m.Close($"{at} rect {i} u", Num(e[0]), rects[i].U, 1e-12);
                m.Close($"{at} rect {i} v", Num(e[1]), rects[i].V, 1e-12);
                m.Close($"{at} rect {i} length", Num(e[2]), rects[i].LengthM, 1e-12);
                m.Close($"{at} rect {i} width", Num(e[3]), rects[i].WidthM, 1e-12);
                m.Equal($"{at} rect {i} kind", e[4].GetString(), rects[i].Kind.ToString().ToLowerInvariant());
            }
            MarkingTexture tex = RunwayMarkingTexture.Rasterise(rects, lengthM, widthM);
            JsonElement t = c.GetProperty("texture");
            m.Equal($"{at} width", t.GetProperty("width").GetInt32(), tex.Width);
            m.Equal($"{at} height", t.GetProperty("height").GetInt32(), tex.Height);
            m.Equal($"{at} hash", (uint)Num(t, "hash"), Structural.Fnv1a32(tex.Data));
            foreach (JsonElement p in t.GetProperty("probes").EnumerateArray())
            {
                int[] q = p.EnumerateArray().Select(v => v.GetInt32()).ToArray();
                int i = (q[1] * tex.Width + q[0]) * 2;
                m.Equal($"{at} texel {q[0]},{q[1]}", (q[2], q[3]), ((int)tex.Data[i], (int)tex.Data[i + 1]));
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void TaxiwaySmoothingMatchesTheOracle()
    {
        var m = new Mismatches();
        int n = 0;
        foreach (JsonElement c in Fx.GetProperty("smoothing").EnumerateArray())
        {
            var pts = Points(c.GetProperty("points")).Select(p => (p[0], p[1])).ToList();
            var output = AirfieldGeometryBuilder.SmoothCentreline(pts, Num(c, "widthM"));
            var expected = Points(c.GetProperty("out"));
            m.Equal($"smoothing[{n}] count", expected.Length, output.Count);
            for (int i = 0; i < Math.Min(expected.Length, output.Count); i++)
            {
                m.Close($"smoothing[{n}][{i}].e", expected[i][0], output[i].E, 1e-12);
                m.Close($"smoothing[{n}][{i}].n", expected[i][1], output[i].N, 1e-12);
            }
            n++;
        }
        m.AssertNone();
    }
}
