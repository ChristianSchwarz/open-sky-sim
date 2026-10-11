using System;
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
/// Replays tests/golden/carrier.json: arrestor cable shapes (idle, trapped,
/// degenerate legs, LOD hysteresis), the stern wake ribbon and the ship-wake
/// foam pool with a seeded Math.random. Float32 outputs must be bit-identical.
/// Also ports sternWake.test.ts and the arrestorCables.test.ts cases whose
/// functions exist in C#.
/// </summary>
public class CarrierTests
{
    private static readonly JsonElement Carrier = Load("carrier.json");

    private static string Hash(ReadOnlySpan<float> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    private static float[] Floats(JsonElement e) => e.EnumerateArray().Select(x => (float)Num(x)).ToArray();

    private static void SameFloats(Mismatches m, string what, JsonElement expected, ReadOnlySpan<float> actual)
    {
        float[] want = Floats(expected);
        m.Equal($"{what} length", want.Length, actual.Length);
        int bad = 0;
        for (int i = 0; i < Math.Min(want.Length, actual.Length); i++)
        {
            m.Equal($"{what}[{i}] bits", BitConverter.SingleToInt32Bits(want[i]), BitConverter.SingleToInt32Bits(actual[i]));
            if (BitConverter.SingleToInt32Bits(want[i]) != BitConverter.SingleToInt32Bits(actual[i]) && ++bad >= 3) break;
        }
    }

    private static ArrestorCarrierPose Pose(JsonElement f) =>
        new() { Position = V3(f.GetProperty("position")), Quaternion = Q(f.GetProperty("quaternion")) };

    /// <summary>The suite's deckSampler (JsTrig is V8-exact).</summary>
    private static Func<double, double, double> DeckSampler(double deckBase) =>
        (x, z) => deckBase + 13.5 + 0.2 * JsTrig.Sin(x * 0.05) * JsTrig.Cos(z * 0.07);

    [Fact]
    public void CableShapesMatchTheOracle()
    {
        var m = new Mismatches();
        int frames = 0, lines = 0, trapped = 0;
        foreach (JsonElement sc in Carrier.GetProperty("cables").EnumerateArray())
        {
            string name = sc.GetProperty("name").GetString()!;
            JsonElement[] fs = sc.GetProperty("frames").EnumerateArray().ToArray();
            var shapes = new ArrestorCableShapes(Pose(fs[0]), DeckSampler(Num(sc, "deckBase")));
            int c0 = 0;
            foreach (JsonElement c in sc.GetProperty("initial").EnumerateArray())
            {
                SameFloats(m, $"{name} initial cable {c0} ribbonA", c.GetProperty("ribbonA"), shapes.Cables[c0].RibbonA);
                SameFloats(m, $"{name} initial cable {c0} ribbonB", c.GetProperty("ribbonB"), shapes.Cables[c0].RibbonB);
                SameFloats(m, $"{name} initial cable {c0} line", c.GetProperty("line"), shapes.Cables[c0].Line);
                c0++;
            }
            for (int i = 0; i < fs.Length; i++)
            {
                JsonElement f = fs[i];
                ArrestorCarrierPose pose = Pose(f);
                int latch = f.GetProperty("latch").GetInt32();
                Vec3d hinge = ArrestorCableShapes.HookHingeWorld(
                    V3(f.GetProperty("hingeBody")), Q(f.GetProperty("displayQuat")), V3(f.GetProperty("displayPos")));
                shapes.Update(pose, latch, hinge, V3(f.GetProperty("camera")));
                string at = $"{name} frame {i}";
                m.Equal($"{at} useLineLod", f.GetProperty("useLineLod").GetBoolean(), shapes.UseLineLod);
                bool[] ribbonVisible = f.GetProperty("ribbonVisible").EnumerateArray().Select(x => x.GetBoolean()).ToArray();
                bool[] lineVisible = f.GetProperty("lineVisible").EnumerateArray().Select(x => x.GetBoolean()).ToArray();
                int k = 0;
                foreach (JsonElement c in f.GetProperty("cables").EnumerateArray())
                {
                    ArrestorCableShape s = shapes.Cables[k];
                    SameFloats(m, $"{at} cable {k} ribbonA", c.GetProperty("ribbonA"), s.RibbonA);
                    SameFloats(m, $"{at} cable {k} ribbonB", c.GetProperty("ribbonB"), s.RibbonB);
                    SameFloats(m, $"{at} cable {k} line", c.GetProperty("line"), s.Line);
                    m.Equal($"{at} cable {k} ribbon visible", ribbonVisible[k], shapes.RibbonsVisible);
                    m.Equal($"{at} cable {k} line visible", lineVisible[k], shapes.LinesVisible);
                    // World polyline: the float32 local line through the pose, within float32 rounding.
                    float[] line = Floats(c.GetProperty("line"));
                    for (int p = 0; p < 3; p++)
                    {
                        Vec3d expected = ArrestorCables.CarrierLocalToWorld(line[p * 3], line[p * 3 + 1], line[p * 3 + 2], pose);
                        m.Close($"{at} cable {k} world[{p}]", expected, s.PolylineWorld[p], 1e-6);
                    }
                    k++;
                }
                frames++;
                if (shapes.UseLineLod) lines++;
                if (latch >= 0) trapped++;
            }
        }
        m.AssertNone();
        Assert.True(frames >= 200 && lines > 20 && trapped > 50, $"coverage: {frames} frames, {lines} line, {trapped} trapped");
    }

    [Fact]
    public void SternRibbonMatchesTheOracle()
    {
        JsonElement r = Carrier.GetProperty("sternRibbon");
        var m = new Mismatches();
        var ribbon = new SternWakeRibbon();
        double[] dithers = Nums(r, "segmentDither");
        for (int j = 0; j < dithers.Length; j++) m.Close($"segmentDither[{j}]", dithers[j], ribbon.SegmentDither[j], 0);
        foreach (JsonElement x in r.GetProperty("ramps").EnumerateArray())
        {
            double d = Num(x, "d");
            m.Close($"alphaAt({d})", Num(x, "alpha"), SternWakeRibbon.AlphaAt(d), 0);
            m.Close($"halfWidthAt({d})", Num(x, "halfWidth"), SternWakeRibbon.HalfWidthAt(d), 0);
        }
        int i = 0;
        foreach (JsonElement s in r.GetProperty("steps").EnumerateArray())
        {
            ribbon.Update(V3(s.GetProperty("stern")), V3(s.GetProperty("aft")));
            m.Close($"step {i} object", V3(s.GetProperty("object")), ribbon.ObjectPosition, 0);
            bool[] visible = s.GetProperty("visible").EnumerateArray().Select(x => x.GetBoolean()).ToArray();
            for (int j = 0; j < visible.Length; j++) m.Equal($"step {i} visible[{j}]", visible[j], ribbon.SegmentVisible[j]);
            m.Equal($"step {i} hash", s.GetProperty("hash").GetString(), Hash(ribbon.Positions));
            if (s.TryGetProperty("positions", out JsonElement dump)) SameFloats(m, $"step {i} positions", dump, ribbon.Positions);
            i++;
        }
        m.AssertNone();
    }

    [Fact]
    public void ShipWakeMatchesTheOracle()
    {
        var m = new Mismatches();
        int dumps = 0, maxCount = 0;
        foreach (JsonElement sc in Carrier.GetProperty("shipWake").EnumerateArray())
        {
            string name = sc.GetProperty("name").GetString()!;
            Func<double> rng = Gun.Mulberry32((uint)sc.GetProperty("seed").GetInt64());
            int draws = 0;
            var wake = new ShipWake(() => { draws++; return rng(); });
            double dt = Num(sc, "dt");
            int i = 0;
            foreach (JsonElement f in sc.GetProperty("frames").EnumerateArray())
            {
                wake.Update(dt, Pose(f));
                string at = $"{name} frame {i}";
                int n = wake.InstanceCount;
                m.Equal($"{at} draws", f.GetProperty("draws").GetInt32(), draws);
                m.Equal($"{at} count", f.GetProperty("count").GetInt32(), n);
                m.Equal($"{at} offsets", f.GetProperty("offsets").GetString(), Hash(wake.Offsets.AsSpan(0, n * 3)));
                m.Equal($"{at} scales", f.GetProperty("scales").GetString(), Hash(wake.Scales.AsSpan(0, n)));
                m.Equal($"{at} rotations", f.GetProperty("rotations").GetString(), Hash(wake.Rotations.AsSpan(0, n)));
                m.Equal($"{at} colors", f.GetProperty("colors").GetString(), Hash(wake.Colors.AsSpan(0, n * 4)));
                m.Close($"{at} ribbon object", V3(f.GetProperty("ribbonObject")), wake.SternRibbon.ObjectPosition, 0);
                m.Equal($"{at} ribbon", f.GetProperty("ribbon").GetString(), Hash(wake.SternRibbon.Positions));
                if (f.TryGetProperty("dump", out JsonElement d))
                {
                    SameFloats(m, $"{at} offsets", d.GetProperty("offsets"), wake.Offsets.AsSpan(0, n * 3));
                    SameFloats(m, $"{at} scales", d.GetProperty("scales"), wake.Scales.AsSpan(0, n));
                    SameFloats(m, $"{at} rotations", d.GetProperty("rotations"), wake.Rotations.AsSpan(0, n));
                    SameFloats(m, $"{at} colors", d.GetProperty("colors"), wake.Colors.AsSpan(0, n * 4));
                    dumps++;
                }
                for (int k = 0; k < n; k++)
                {
                    if ((float)wake.OffsetsWorld[k].X != wake.Offsets[k * 3]) { m.Fail($"{at} OffsetsWorld[{k}] != Offsets"); break; }
                }
                maxCount = Math.Max(maxCount, n);
                i++;
            }
        }
        m.AssertNone();
        Assert.True(dumps >= 8 && maxCount > 800, $"coverage: {dumps} dumps, max {maxCount} puffs");
    }

    // ------------------------------------------------ sternWake.test.ts

    /// <summary>Fraction of pixels a 4x4 Bayer stipple keeps at the given dither opacity (x16).</summary>
    private static int DitherLevels(double alpha)
    {
        int kept = 0;
        for (int v = 0; v < 16; v++)
        {
            if (alpha + (v / 16.0 - 0.5) >= 0.5) kept++;
        }
        return kept;
    }

    [Fact]
    public void SternWakeCoversExactly2Km()
    {
        Assert.Equal(2000, SternWakeRibbon.LengthM);
        Assert.Equal(SternWakeRibbon.LengthM, SternWakeRibbon.SegmentCount * SternWakeRibbon.SegmentLengthM);
    }

    [Fact]
    public void SternWakeFadesLinearlyWithDistance()
    {
        double head = SternWakeRibbon.AlphaAt(0);
        double tail = SternWakeRibbon.AlphaAt(SternWakeRibbon.LengthM);
        Assert.True(head > tail);
        for (double d = 0; d <= SternWakeRibbon.LengthM; d += 100)
        {
            double expected = head + (tail - head) * (d / SternWakeRibbon.LengthM);
            Assert.True(Math.Abs(SternWakeRibbon.AlphaAt(d) - expected) < 1e-9, $"alpha at {d} m");
        }
    }

    [Fact]
    public void SternWakeStaysVisibleOverTheWhole2Km()
    {
        for (int i = 0; i < SternWakeRibbon.SegmentCount; i++)
        {
            double mid = (i + 0.5) * SternWakeRibbon.SegmentLengthM;
            Assert.True(DitherLevels(SternWakeRibbon.AlphaAt(mid)) >= 1, $"segment {i} renders nothing");
        }
    }

    [Fact]
    public void SternWakeClampsOutsideTheTrail()
    {
        Assert.Equal(SternWakeRibbon.AlphaAt(0), SternWakeRibbon.AlphaAt(-10));
        Assert.Equal(SternWakeRibbon.AlphaAt(SternWakeRibbon.LengthM), SternWakeRibbon.AlphaAt(SternWakeRibbon.LengthM * 2));
        Assert.Equal(SternWakeRibbon.HalfWidthAt(0), SternWakeRibbon.HalfWidthAt(-10));
    }

    [Fact]
    public void SternWakeFansOutAstern()
    {
        double stern = SternWakeRibbon.HalfWidthAt(0);
        double tail = SternWakeRibbon.HalfWidthAt(SternWakeRibbon.LengthM);
        Assert.True(tail > stern);
        Assert.True(SternWakeRibbon.HalfWidthAt(SternWakeRibbon.LengthM * 0.5) > SternWakeRibbon.HalfWidthAt(0));
        double halfAngleDeg = Math.Atan2(tail - stern, SternWakeRibbon.LengthM) * 180 / Math.PI;
        Assert.True(halfAngleDeg < 19.47, $"spread {halfAngleDeg} deg");
    }

    // ------------------------------------------------ arrestorCables.test.ts

    private static readonly Vec3d Origin = ArrestorCables.ArrestorCarrierOrigin;
    private static ArrestorCableField Field() => ArrestorCables.BuildArrestorCableField(Origin.X, Origin.Y, Origin.Z);
    private static Vec3d Mid(ArrestorCableSegment s) => (s.A + s.B) * 0.5;

    [Fact]
    public void CablesBuildFourLateralSegmentsOnTheLandingDeck()
    {
        ArrestorCableField field = Field();
        Assert.Equal(4, field.Segments.Count);
        for (int i = 0; i < 4; i++)
        {
            ArrestorCableSegment seg = field.Segments[i];
            double z = Origin.Z + ArrestorCables.ArrestorCableLocalZ[i];
            Assert.True(Math.Abs(seg.A.Z - z) < 1e-6);
            Assert.True(Math.Abs(seg.B.Z - z) < 1e-6);
            Assert.True(Math.Abs(seg.A.Y - ArrestorCables.ArrestorCableY) < 1e-6);
            Assert.True(Math.Abs(seg.A.X - (Origin.X + ArrestorCables.ArrestorDeckMidX - ArrestorCables.ArrestorHalfSpanM)) < 1e-6);
            Assert.True(Math.Abs(seg.B.X - (Origin.X + ArrestorCables.ArrestorDeckMidX + ArrestorCables.ArrestorHalfSpanM)) < 1e-6);
        }
    }

    [Fact]
    public void CableFieldRotatesWithCarrierYaw()
    {
        Quatd yaw = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), Math.PI / 2);
        ArrestorCableField yawed = ArrestorCables.BuildArrestorCableField(100, 0, 200, null, yaw);
        double localAx = ArrestorCables.ArrestorDeckMidX - ArrestorCables.ArrestorHalfSpanM;
        Vec3d expected = new Vec3d(localAx, ArrestorCables.ArrestorCableY, ArrestorCables.ArrestorCableLocalZ[0]).Rotate(yaw)
            + new Vec3d(100, 0, 200);
        Assert.True(Vec3d.Distance(yawed.Segments[0].A, expected) < 1e-5);
        Assert.True(Math.Abs(yawed.DeckAxis.X - (-1)) < 1e-5, "deck axis should face -X");
    }

    [Fact]
    public void HookWorldPosTransformsBodyOffsetByPose()
    {
        double[] hb = ArrestorCables.DefaultArrestorHookBody;
        Vec3d o = ArrestorCables.HookWorldPos(new Vec3d(10, 20, 30), Quatd.Identity, new Vec3d(hb[0], hb[1], hb[2]));
        Assert.True(Math.Abs(o.X - (10 + hb[0])) < 1e-6);
        Assert.True(Math.Abs(o.Y - (20 + hb[1])) < 1e-6);
        Assert.True(Math.Abs(o.Z - (30 + hb[2])) < 1e-6);
    }

    [Fact]
    public void ResolveArrestorHookTipUsesNozzleExitZ()
    {
        Assert.Equal(-4.85, ArrestorCables.ResolveArrestorHookTip(new[] { 0, -1.7, -8 }, new[] { -4.2, -4.85 }, null)[2]);
        Assert.Equal(-6.2, ArrestorCables.ResolveArrestorHookTip(new[] { 0, -1.7, -6.2 }, null, null)[2]);
        Assert.Equal(ArrestorCables.DefaultEngineNozzles[0][2], ArrestorCables.DefaultArrestorHookBody[2]);
    }

    [Fact]
    public void LatchedHookTipIsColinearWithHingeToSheaveAtArmLength()
    {
        var hinge = new Vec3d(2505, 15, -2000);
        var sheave = new Vec3d(2480, 13.85, -2005);
        Vec3d tip = ArrestorCables.LatchedHookTipWorld(hinge, sheave, out Vec3d dir);
        Assert.True(Math.Abs(Vec3d.Distance(tip, hinge) - ArrestorCables.TailhookArmLengthM) < 1e-6);
        Vec3d toSheave = (sheave - hinge).Normalized();
        Assert.True(Vec3d.Distance(dir, toSheave) < 1e-6);
        Assert.True(Vec3d.Distance((tip - hinge).Normalized(), toSheave) < 1e-6);
    }

    [Fact]
    public void DistancePointToSegmentIsZeroOnTheWireAndLargeWhenHigh()
    {
        ArrestorCableSegment seg = Field().Segments[0];
        Vec3d mid = Mid(seg);
        Assert.True(ArrestorCables.DistancePointToSegment(mid, seg.A, seg.B) < 1e-6);
        mid.Y += 5;
        Assert.True(ArrestorCables.DistancePointToSegment(mid, seg.A, seg.B) > 4.9);
    }

    [Fact]
    public void SnagMissesHighOrHookUp()
    {
        ArrestorCableField field = Field();
        Vec3d mid = Mid(field.Segments[0]);
        Vec3d high = mid + new Vec3d(0, 5, 0);
        Assert.Equal(-1, ArrestorCables.TrySnag(high, high + new Vec3d(0, 0, 2), new Vec3d(0, 0, -40), field, true));
        Assert.Equal(-1, ArrestorCables.TrySnag(mid, mid + new Vec3d(0, 0, 1), new Vec3d(0, 0, -40), field, false));
    }

    [Fact]
    public void SnagCatchesCrossingsAndProximity()
    {
        ArrestorCableField field = Field();
        ArrestorCableSegment s1 = field.Segments[1];
        double z1 = (s1.A.Z + s1.B.Z) * 0.5, x1 = (s1.A.X + s1.B.X) * 0.5;
        double y = ArrestorCables.ArrestorCableY;
        Assert.Equal(1, ArrestorCables.TrySnag(new Vec3d(x1, y, z1 - 0.1), new Vec3d(x1, y, z1 + 1), new Vec3d(0, 0, -50), field, true));

        Vec3d m2 = Mid(field.Segments[2]);
        m2.X += ArrestorCables.ArrestorCatchRadiusM * 0.25;
        Assert.Equal(2, ArrestorCables.TrySnag(m2, null, new Vec3d(0, 0, -40), field, true));

        ArrestorCableSegment s0 = field.Segments[0];
        double z0 = (s0.A.Z + s0.B.Z) * 0.5, x0 = (s0.A.X + s0.B.X) * 0.5;
        Assert.Equal(0, ArrestorCables.TrySnag(new Vec3d(x0, 13.85, z0 - 0.2), new Vec3d(x0, 13.85, z0 + 1.0), new Vec3d(0, 0, -55), field, true));

        Assert.Equal(1, ArrestorCables.TrySnag(new Vec3d(x1 + 1, y, z1 - 0.5), new Vec3d(x1 + 1, y, z1 + 1.5), new Vec3d(0, 0, -60), field, true));
    }

    [Theory]
    [InlineData(70)]
    [InlineData(50)]
    public void ArrestStopsNear140M(double speed)
    {
        ArrestorCableField field = Field();
        var vel = new Vec3d(0, 0, -speed);
        double dt = 1.0 / 60, dist = 0, remaining = ArrestorCables.ArrestorPullOutM;
        int steps = 0;
        while (ArrestorCables.ApplyArrestorVelocity(ref vel, field.DeckAxis, dt, remaining))
        {
            dist += Math.Abs(Vec3d.Dot(vel, field.DeckAxis)) * dt;
            remaining = ArrestorCables.ArrestorPullOutM - dist;
            Assert.True(++steps < 10000, "arrestor should stop");
        }
        Assert.True(Math.Abs(Vec3d.Dot(vel, field.DeckAxis)) <= ArrestorCables.ArrestorStopSpeedMps + 1e-6);
        Assert.True(Math.Abs(dist - ArrestorCables.ArrestorPullOutM) < 12, $"stop distance {dist} m");
    }

    // ------------------------------------------------ shapes, beyond the oracle

    [Fact]
    public void IdleCablesAreStraightAndUnlatchedAfterATrap()
    {
        var pose = new ArrestorCarrierPose { Position = new Vec3d(100, 0, -50), Quaternion = Quatd.Identity };
        var shapes = new ArrestorCableShapes(pose);
        Vec3d hinge = ArrestorCables.ArrestorCableStartWorld(2, pose) + new Vec3d(20, 1.5, -30);
        shapes.Update(pose, 2, hinge, pose.Position);
        Assert.NotEqual(shapes.Cables[2].Line[4], shapes.Cables[2].Line[1]);
        shapes.Update(pose, -1, hinge, pose.Position);
        foreach (ArrestorCableShape c in shapes.Cables)
        {
            // Fallback deck 13.55 + 0.35 clearance; mid half way between the sheaves.
            Assert.Equal((float)(13.55 + 0.35), c.Line[1]);
            Assert.Equal(c.Line[1], c.Line[4]);
            Assert.Equal((float)((c.Local.Ax + c.Local.Bx) * 0.5), c.Line[3]);
            Assert.Equal(c.Line[2], c.Line[5]);
        }
        Assert.False(shapes.UseLineLod);
    }
}
