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
/// Replays tests/golden/aircraft_fx.json: scripted timelines through AircraftFx
/// (afterburner plumes, wingtip trails with swing-wing tips, re-base, reset,
/// def swaps, tips from the body model) and deriveWingtipOriginsFromModel.
/// Float32 outputs (cone geometry, trail matrices and levels) must be
/// bit-identical; double poses within 1e-12.
/// </summary>
public class AircraftFxTests
{
    private static readonly JsonElement Fx = Load("aircraft_fx.json");

    private static string Hash(ReadOnlySpan<float> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    private static string ZoneName(F16ThrottleZone? z) => z switch
    {
        null => null,
        F16ThrottleZone.AbMin => "ab-min",
        F16ThrottleZone.AbMax => "ab-max",
        _ => "mil",
    };

    private static Dictionary<string, FlyableAircraftDef> Defs()
    {
        JsonElement aircraft = Load("aircraft.json");
        var defs = new Dictionary<string, FlyableAircraftDef> { ["f22"] = AircraftDefs.F22() };
        foreach (JsonElement p in aircraft.GetProperty("packs").EnumerateArray())
        {
            string id = p.GetProperty("id").GetString()!;
            defs[id] = AircraftDefs.FromPackManifest(id, JsonReader.Parse(p.GetProperty("manifest").GetRawText()));
        }
        return defs;
    }

    private static float[] Floats(JsonElement e) => e.EnumerateArray().Select(x => (float)Num(x)).ToArray();

    private static void SameFloats(Mismatches m, string what, JsonElement expected, ReadOnlySpan<float> actual)
    {
        float[] want = Floats(expected);
        m.Equal($"{what} length", want.Length, actual.Length);
        int bad = 0;
        for (int i = 0; i < Math.Min(want.Length, actual.Length); i++)
        {
            if (BitConverter.SingleToInt32Bits(want[i]) != BitConverter.SingleToInt32Bits(actual[i]) && bad++ < 3)
            {
                m.Fail($"{what}[{i}]: expected {want[i]:R}, got {actual[i]:R}");
            }
        }
    }

    [Fact]
    public void TimelinesMatchTheOracle()
    {
        var defs = Defs();
        var models = new Dictionary<string, float[]>();
        foreach (JsonProperty p in Fx.GetProperty("models").EnumerateObject()) models[p.Name] = Floats(p.Value);
        var geometries = new Dictionary<string, JsonElement>();
        foreach (JsonProperty p in Fx.GetProperty("geometries").EnumerateObject()) geometries[p.Name] = p.Value;

        var m = new Mismatches();
        int frames = 0, dumps = 0, visibleCones = 0, drawnSegments = 0;
        foreach (JsonElement sc in Fx.GetProperty("scenarios").EnumerateArray())
        {
            string name = sc.GetProperty("name").GetString()!;
            var fx = new AircraftFx();
            fx.ConfigureFromDef(defs[sc.GetProperty("initialDef").GetString()!]);
            int i = 0;
            foreach (JsonElement f in sc.GetProperty("frames").EnumerateArray())
            {
                string at = $"{name} frame {i}";
                JsonElement inp = f.GetProperty("in");
                var input = new AircraftFxInput
                {
                    ThrottleLever = Num(inp[0]),
                    AbDetents = inp[1].GetBoolean(),
                    WingSweep = Num(inp[2]),
                    Position = V3(f.GetProperty("pos")),
                    Quaternion = Q(f.GetProperty("quat")),
                    Velocity = V3(f.GetProperty("vel")),
                };
                int updates = inp[3].GetInt32();
                if (f.TryGetProperty("event", out JsonElement ev))
                {
                    switch (ev.GetProperty("kind").GetString())
                    {
                        case "reset": fx.ResetTrails(); break;
                        case "configure": fx.ConfigureFromDef(defs[ev.GetProperty("def").GetString()!]); break;
                        case "bindModel": fx.BindWingtipOrigins(models[ev.GetProperty("model").GetString()!]); break;
                        case "rebase":
                            fx.Rebase(new FrameShift(Q(ev.GetProperty("rotation")), V3(ev.GetProperty("offset"))));
                            break;
                    }
                }
                for (int u = 0; u < updates; u++) fx.Update(input);
                fx.LayoutTrails(V3(f.GetProperty("cam")));

                AfterburnerCones cones = fx.AfterburnerCones;
                JsonElement c = f.GetProperty("cones");
                m.Equal($"{at} cones visible", c[0].GetBoolean(), cones.Visible);
                m.Equal($"{at} cones zone", c[1].ValueKind == JsonValueKind.Null ? null : c[1].GetString(), ZoneName(cones.Zone));
                if (c[0].GetBoolean() && cones.Visible)
                {
                    visibleCones++;
                    m.Equal($"{at} inner", c[2].GetString(), Hash(cones.InnerGeometry));
                    m.Equal($"{at} outer", c[3].GetString(), Hash(cones.OuterGeometry));
                    m.Equal($"{at} dish", c[4].GetString(), Hash(cones.DishGeometry));
                    m.Equal($"{at} colour", $"{Num(c[5])},{Num(c[6])},{Num(c[7])}", string.Join(",", AfterburnerCones.ConeColor));
                    var roots = f.GetProperty("roots").EnumerateArray().ToList();
                    m.Equal($"{at} plume count", roots.Count, cones.RootPositions.Length);
                    for (int k = 0; k < Math.Min(roots.Count, cones.RootPositions.Length); k++)
                    {
                        m.Close($"{at} root {k}", V3(roots[k]), cones.RootPositions[k], 1e-12);
                    }
                    m.CloseRotation($"{at} root quat", Q(f.GetProperty("rootQuat")), cones.RootRotation, 0);
                    if (f.TryGetProperty("plumes", out JsonElement plumes))
                    {
                        int k = 0;
                        foreach (JsonElement p in plumes.EnumerateArray())
                        {
                            m.Close($"{at} plume {k}", V3(p), cones.PlumePosition(k), 1e-9);
                            k++;
                        }
                    }
                }

                bool ready = f.TryGetProperty("left", out JsonElement left);
                m.Equal($"{at} wingtips ready", ready, fx.WingtipsReady);
                if (ready && fx.WingtipsReady)
                {
                    WingtipTrails trails = fx.WingtipTrails;
                    foreach ((string side, JsonElement x, WingTrailSide s) in new[] { ("left", left, trails.Left), ("right", f.GetProperty("right"), trails.Right) })
                    {
                        m.Equal($"{at} {side} count", x[0].GetInt32(), s.DrawnCount);
                        m.Equal($"{at} {side} visible", x[1].GetBoolean(), s.Visible);
                        m.Equal($"{at} {side} samples", x[2].GetInt32(), s.SampleCount);
                        m.Equal($"{at} {side} matrices", x[3].GetString(), Hash(s.Matrices.AsSpan(0, s.DrawnCount * 16)));
                        m.Equal($"{at} {side} levels", x[4].GetString(), Hash(s.Levels.AsSpan(0, s.DrawnCount)));
                        drawnSegments += s.DrawnCount;
                        if (f.TryGetProperty(side + "Full", out JsonElement full))
                        {
                            SameFloats(m, $"{at} {side} matrices", full.GetProperty("matrices"), s.Matrices.AsSpan(0, s.DrawnCount * 16));
                            SameFloats(m, $"{at} {side} levels", full.GetProperty("levels"), s.Levels.AsSpan(0, s.DrawnCount));
                            dumps++;
                        }
                    }
                    if (f.TryGetProperty("tips", out JsonElement tips))
                    {
                        m.Close($"{at} left tip", V3(tips[0]), trails.LeftTip, 1e-12);
                        m.Close($"{at} right tip", V3(tips[1]), trails.RightTip, 1e-12);
                    }
                }
                i++;
                frames++;
            }

            var nozzles = sc.GetProperty("nozzles").EnumerateArray().ToList();
            m.Equal($"{name} nozzle count", nozzles.Count, fx.AfterburnerCones.Nozzles.Length);
            for (int k = 0; k < Math.Min(nozzles.Count, fx.AfterburnerCones.Nozzles.Length); k++)
            {
                m.Close($"{name} nozzle {k}", V3(nozzles[k]), fx.AfterburnerCones.Nozzles[k], 0);
            }
            m.Close($"{name} radius", Num(sc, "radius"), fx.AfterburnerCones.Radius, 0);
            JsonElement thrust = sc.GetProperty("thrustOrigin");
            m.Equal($"{name} has thrust origin", thrust.ValueKind != JsonValueKind.Null, fx.ThrustOrigin.HasValue);
            if (thrust.ValueKind != JsonValueKind.Null && fx.ThrustOrigin.HasValue)
            {
                m.Close($"{name} thrust origin", V3(thrust), fx.ThrustOrigin.Value, 0);
            }
        }

        // Every recorded geometry is one the C# builds for some (length, radius).
        var built = new HashSet<string>();
        foreach (double r in new[] { 0.3, 0.5109, 0.4193, 0.4754, 0.4971 })
        {
            foreach (double len in new[] { 3, 4.5, 4, 6 }) built.Add(Hash(AfterburnerCones.ConeGeometry(len, r)));
            built.Add(Hash(AfterburnerCones.DishGeometryFor(r)));
        }
        foreach ((string hash, JsonElement arr) in geometries)
        {
            m.Equal($"geometry {hash} hash", hash, Hash(Floats(arr)));
            m.Equal($"geometry {hash} rebuilt", true, built.Contains(hash));
        }

        Assert.Equal(960, frames);
        Assert.True(visibleCones > 400 && dumps >= 10 && drawnSegments > 50_000, $"{visibleCones} {dumps} {drawnSegments}");
        m.AssertNone();
    }

    [Fact]
    public void WingtipOriginsFromVerticesMatchTheOracle()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("derive").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            var derived = WingtipOrigins.Derive(Floats(c.GetProperty("positions")));
            JsonElement r = c.GetProperty("result");
            m.Equal($"{name} found", r.ValueKind != JsonValueKind.Null, derived.HasValue);
            if (r.ValueKind != JsonValueKind.Null && derived.HasValue)
            {
                m.Close($"{name} left", V3(r.GetProperty("left")), derived.Value.Left, 0);
                m.Close($"{name} right", V3(r.GetProperty("right")), derived.Value.Right, 0);
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void TrailConstantsAndCorners()
    {
        Assert.Equal(0.05, WingtipTrails.SegmentDither(0));
        Assert.Equal(0.9, WingtipTrails.SegmentDither(49), 15);
        Assert.Equal(0.45, WingtipTrails.SampleSpacingM(0));
        Assert.Equal(3.5, WingtipTrails.SampleSpacingM(400));
        Assert.Equal(100 * 0.028, WingtipTrails.SampleSpacingM(100));

        // A straight trail due south seen from the east: quads lie in the vertical plane through it.
        var fx = new AircraftFx();
        fx.ConfigureFromDef(Defs().First(d => d.Value.Wingtips != null).Value);
        for (int k = 0; k < 10; k++)
        {
            fx.Update(new AircraftFxInput { Position = new Vec3d(0, 100, k * 4), Quaternion = Quatd.Identity, Velocity = new Vec3d(0, 0, 240) });
        }
        fx.LayoutTrails(new Vec3d(500, 100, 20));
        WingTrailSide s = fx.WingtipTrails.Left;
        Assert.True(s.DrawnCount > 0);
        Span<float> corners = stackalloc float[12];
        s.SegmentCorners(0, corners);
        double x = fx.WingtipTrails.LeftTip.X;
        for (int c = 0; c < 4; c++) Assert.Equal(x, corners[c * 3], 4);
        Assert.Equal(2 * WingtipTrails.SegmentWidth, Math.Abs(corners[1] - corners[4]), 4);
    }
}
