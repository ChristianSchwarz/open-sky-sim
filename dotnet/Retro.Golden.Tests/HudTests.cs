using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/hud.json: the HUD, exterior readout, perf readout and
/// device-status stack drawn by the TS entities into the recording painter,
/// against the C# ports drawing into Retro.Game.RecordingPainter. Call
/// streams must match exactly. Also checks the overlay helpers (layout,
/// heading format, display units, ILS deviations) and ports approachAids.test.ts.
/// </summary>
public class HudTests
{
    private static readonly JsonElement Fixture = Load("hud.json");

    private static Palette PaletteNamed(string name) => name switch
    {
        "hd-noon" => Palettes.HdNoon,
        "hd-midnight" => Palettes.HdMidnight,
        "hd-nightvision" => Palettes.HdNightVision,
        _ => throw new ArgumentException(name),
    };

    private static UnitSystem Units(JsonElement e) => e.GetString() == "IMPERIAL" ? UnitSystem.Imperial : UnitSystem.Metric;

    private static HudFont FontNamed(string id) => id switch
    {
        "HUD_SMALL" => HudFont.Small,
        "HUD_MEDIUM" => HudFont.Medium,
        "HUD_LARGE" => HudFont.Large,
        _ => throw new ArgumentException(id),
    };

    private static HudTarget Target(JsonElement t)
    {
        if (t.ValueKind == JsonValueKind.Null) return null;
        var target = new HudTarget
        {
            Position = V3(t.GetProperty("position")),
            LocalCenter = V3(t.GetProperty("localCenter")),
            TargetType = t.GetProperty("targetType").GetString(),
            TargetLocation = t.GetProperty("targetLocation").GetString(),
            Airborne = t.GetProperty("airborne").GetBoolean(),
        };
        if (t.TryGetProperty("approachRunway", out JsonElement r))
        {
            target.ApproachRunway = Runway(r);
        }
        return target;
    }

    private static ApproachRunway Runway(JsonElement r) => new()
    {
        Center = V3(r.GetProperty("center")),
        Heading = Num(r, "heading"),
        HalfLength = Num(r, "halfLength"),
    };

    /// <summary>The player part of a frame into the inputs snapshot.</summary>
    private static void Player(HudInputs i, JsonElement p)
    {
        i.Position = V3(p.GetProperty("position"));
        i.Quaternion = Q(p.GetProperty("quaternion"));
        i.Velocity = V3(p.GetProperty("velocity"));
        i.AltitudeM = Num(p, "altitudeM");
        i.StallStatus = Num(p, "stallStatus");
        i.AngleOfAttackRad = Num(p, "angleOfAttack");
        i.LoadFactorG = Num(p, "loadFactorG");
        i.IsLanded = p.GetProperty("isLanded").GetBoolean();
        i.AutopilotEnabled = p.GetProperty("autopilot").GetBoolean();
        i.HasGun = p.GetProperty("hasGun").GetBoolean();
        i.GunAmmo = p.GetProperty("gunAmmo").GetInt32();
        i.HealthFraction = Num(p, "healthFraction");
        i.PitchInput = Num(p, "pitchInput");
        i.RollInput = Num(p, "rollInput");
        i.YawInput = Num(p, "yawInput");
        i.ElevatorLimitHigh = Num(p, "elevatorLimitHigh");
        i.ElevatorLimitLow = Num(p, "elevatorLimitLow");
        i.Throttle = Num(p, "throttle");
        i.ThrottleHudText = p.GetProperty("throttleHudText").GetString();
        i.FcsLimitersEnabled = p.GetProperty("fcsLimitersEnabled").GetBoolean();
        i.FcsPitchLimiterMode = p.GetProperty("fcsPitchLimiterMode").GetInt32();
    }

    [Fact]
    public void HudCallStreamsMatchTheOracle()
    {
        int frames = 0, calls = 0;
        foreach (JsonElement c in Fixture.GetProperty("hud").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            double width = Num(c, "width"), height = Num(c, "height");
            Palette palette = PaletteNamed(c.GetProperty("palette").GetString()!);
            var hud = new Hud();
            var input = new HudInputs
            {
                Units = Units(c.GetProperty("units")),
                FocusMode = (HudFocusMode)c.GetProperty("focus").GetInt32(),
                FlightModelFm3 = c.GetProperty("fm3").GetBoolean(),
            };
            int f = 0;
            foreach (JsonElement fr in c.GetProperty("frames").EnumerateArray())
            {
                Player(input, fr.GetProperty("player"));
                input.Target = Target(fr.GetProperty("target"));
                input.NowMs = Num(fr, "nowMs");
                JsonElement stats = fr.GetProperty("stats");
                input.TerrainTriangles = Num(stats, "terrainTriangles");
                input.CloudTriangles = Num(stats, "cloudTriangles");
                input.SceneTriangles = Num(stats, "sceneTriangles");
                JsonElement cam = fr.GetProperty("camera");
                var view = new HudCamera
                {
                    Position = V3(cam.GetProperty("position")),
                    Quaternion = Q(cam.GetProperty("quaternion")),
                    Projection = Nums(cam, "projection"),
                };

                hud.Update(Num(fr, "delta"));
                var rec = new RecordingPainter();
                hud.Render2D(width, height, input, view, palette, rec);
                JsonElement expected = fr.GetProperty("calls");
                PainterCalls.AssertSame(expected, rec.Calls, $"{name} frame {f}");
                frames++;
                calls += rec.Calls.Count;
                f++;
            }
        }
        Assert.True(frames >= 390, $"only {frames} frames");
        Assert.True(calls > 80000, $"only {calls} calls");
    }

    [Fact]
    public void ExteriorDataMatchesTheOracle()
    {
        int n = 0;
        foreach (JsonElement c in Fixture.GetProperty("exterior").EnumerateArray())
        {
            var input = new HudInputs { Units = Units(c.GetProperty("units")) };
            Player(input, c.GetProperty("player"));
            input.Target = Target(c.GetProperty("target"));
            var rec = new RecordingPainter();
            new ExteriorData().Render2D(Num(c, "width"), Num(c, "height"), input, PaletteNamed(c.GetProperty("palette").GetString()!), rec);
            PainterCalls.AssertSame(c.GetProperty("calls"), rec.Calls, c.GetProperty("name").GetString()!);
            n++;
        }
        Assert.True(n >= 10);
    }

    private static double? OptNum(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out JsonElement v) ? Num(v) : (double?)null;

    [Fact]
    public void PerfHudMatchesTheOracle()
    {
        int n = 0;
        foreach (JsonElement c in Fixture.GetProperty("perf").EnumerateArray())
        {
            JsonElement s = c.GetProperty("stats");
            var stats = new PerfStats();
            if (s.TryGetProperty("kernel", out JsonElement k))
            {
                stats.Kernel = new PerfKernelStats { UpdateMs = Num(k, "updateMs"), RenderMs = Num(k, "renderMs") };
            }
            if (s.TryGetProperty("draw", out JsonElement d))
            {
                stats.Draw = d.EnumerateArray().Select(x => new PerfDrawPass { Calls = Num(x, "calls"), Triangles = Num(x, "triangles") }).ToList();
            }
            if (s.TryGetProperty("terrain", out JsonElement t))
            {
                stats.Terrain = new PerfTerrainStats
                {
                    Drawn = Num(t, "drawn"),
                    Triangles = Num(t, "triangles"),
                    DetailScale = Num(t, "detailScale"),
                    HeightTier = t.TryGetProperty("heightTier", out JsonElement ht) ? ht.GetString() : null,
                    Queued = OptNum(t, "queued"),
                    CacheBytes = OptNum(t, "cacheBytes"),
                    Failed = OptNum(t, "failed"),
                    Textured = OptNum(t, "textured"),
                    RoadTiles = OptNum(t, "roadTiles"),
                    RoadTriangles = OptNum(t, "roadTriangles"),
                    BridgeTiles = OptNum(t, "bridgeTiles"),
                    BridgeTriangles = OptNum(t, "bridgeTriangles"),
                    BuildingTiles = OptNum(t, "buildingTiles"),
                    BuildingShownTriangles = OptNum(t, "buildingShownTriangles"),
                    TriangleBudgetHit = t.TryGetProperty("triangleBudgetHit", out JsonElement b) && b.GetBoolean(),
                };
            }
            var perf = new PerfHud();
            foreach (double delta in Nums(c, "deltas")) perf.Update(delta);
            var rec = new RecordingPainter();
            perf.Render2D(Num(c, "width"), Num(c, "height"), stats, PaletteNamed(c.GetProperty("palette").GetString()!), rec);
            PainterCalls.AssertSame(c.GetProperty("calls"), rec.Calls, c.GetProperty("name").GetString()!);
            n++;
        }
        Assert.True(n >= 8);
    }

    [Fact]
    public void DeviceStatusStackMatchesTheOracle()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fixture.GetProperty("deviceStatus").EnumerateArray())
        {
            var status = new AircraftDeviceStatus
            {
                LandingGear = (AircraftDeviceState)c.GetProperty("landingGear").GetInt32(),
                Flaps = (AircraftDeviceState)c.GetProperty("flaps").GetInt32(),
                Airbrakes = (AircraftDeviceState)c.GetProperty("airbrakes").GetInt32(),
                Tailhook = (AircraftDeviceState)c.GetProperty("tailhook").GetInt32(),
                WheelBrakesApplied = c.GetProperty("wheelBrakesApplied").GetBoolean(),
                BarricadeStatus = c.GetProperty("barricadeStatus").ValueKind == JsonValueKind.Null ? null : c.GetProperty("barricadeStatus").GetString(),
            };
            HudFont font = FontNamed(c.GetProperty("font").GetString()!);
            var (x, y) = OverlayUtils.GetAircraftDeviceStatusPosition(Num(c, "height"), Num(c, "mfdSize"), font);
            double[] pos = Nums(c, "position");
            m.Close("position.x", pos[0], x, 0);
            m.Close("position.y", pos[1], y, 0);
            var rec = new RecordingPainter();
            OverlayUtils.RenderAircraftDeviceStatus(status, x, y, rec, "#66FF66", font);
            PainterCalls.AssertSame(c.GetProperty("calls"), rec.Calls, "device status");
        }
        m.AssertNone();
    }

    [Fact]
    public void OverlayHelpersMatchTheOracle()
    {
        var m = new Mismatches();
        JsonElement h = Fixture.GetProperty("helpers");
        foreach (JsonElement l in h.GetProperty("layout").EnumerateArray())
        {
            string at = $"{Num(l, "width")}x{Num(l, "height")}";
            OverlayLayout layout = OverlayUtils.GetOverlayLayout(Num(l, "width"), Num(l, "height"));
            m.Close($"{at} detailScale", Num(l, "detailScale"), layout.DetailScale, 0);
            m.Close($"{at} layoutScale", Num(l, "layoutScale"), layout.LayoutScale, 0);
            m.Close($"{at} tickStep", Num(l, "tickStep"), OverlayUtils.GetOverlayTickStep(layout), 0);
            m.Close($"{at} logicalHeight", Num(l, "logicalHeight"), OverlayUtils.GetOverlayLogicalHeight(layout), 0);
            m.Close($"{at} strokeWidth", Num(l, "strokeWidth"), OverlayUtils.GetOverlayStrokeWidth(layout), 0);
        }
        foreach (JsonElement fh in h.GetProperty("formatHeading").EnumerateArray())
        {
            JsonElement[] a = fh.EnumerateArray().ToArray();
            m.Equal($"formatHeading({Num(a[0])})", a[1].GetString(), OverlayUtils.FormatHeading(Num(a[0])));
        }
        foreach (JsonElement u in h.GetProperty("displayUnits").EnumerateArray())
        {
            UnitSystem sys = Units(u.GetProperty("system"));
            var du = new DisplayUnits(sys);
            string s = sys.ToString();
            m.Close($"{s} altitudeStep", Num(u, "altitudeStep"), du.AltitudeStep, 0);
            m.Close($"{s} altitudeLowThreshold", Num(u, "altitudeLowThreshold"), du.AltitudeLowThreshold, 0);
            m.Equal($"{s} useBarometricAltitude", u.GetProperty("useBarometricAltitude").GetBoolean(), du.UseBarometricAltitude);
            m.Close($"{s} altitudeTapeLabelInterval", Num(u, "altitudeTapeLabelInterval"), du.AltitudeTapeLabelInterval, 0);
            m.Close($"{s} airspeedStep", Num(u, "airspeedStep"), du.AirspeedStep, 0);
            m.Close($"{s} airspeedScale", Num(u, "airspeedScale"), du.AirspeedScale, 0);
            m.Close($"{s} verticalSpeedBarDivisor", Num(u, "verticalSpeedBarDivisor"), du.VerticalSpeedBarDivisor, 0);
            m.Equal($"{s} altitudeUnitLabel", u.GetProperty("altitudeUnitLabel").GetString(), du.AltitudeUnitLabel());
            m.Equal($"{s} speedUnitLabel", u.GetProperty("speedUnitLabel").GetString(), du.SpeedUnitLabel());
            foreach (JsonElement e in u.GetProperty("samples").EnumerateArray())
            {
                double n = Num(e, "n");
                string at = $"{s} n={n}";
                m.Close($"{at} altitudeFromMeters", Num(e, "altitudeFromMeters"), du.AltitudeFromMeters(n), 0);
                m.Close($"{at} speedFromMps", Num(e, "speedFromMps"), du.SpeedFromMps(n), 0);
                m.Close($"{at} verticalSpeedFromMps", Num(e, "verticalSpeedFromMps"), du.VerticalSpeedFromMps(n), 0);
                m.Equal($"{at} readout", e.GetProperty("readout").GetString(), du.FormatAltitudeReadout(n));
                m.Equal($"{at} tape", e.GetProperty("tape").GetString(), du.FormatAltitudeTape(n, false));
                m.Equal($"{at} tapeLowp", e.GetProperty("tapeLowp").GetString(), du.FormatAltitudeTape(n, true));
                m.Close($"{at} tick1", Num(e, "tick1"), du.GetAltitudeTickWidth(n, 1), 0);
                m.Close($"{at} tick10", Num(e, "tick10"), du.GetAltitudeTickWidth(n, 10), 0);
            }
        }
        int k = 0;
        foreach (JsonElement c in h.GetProperty("ils").EnumerateArray())
        {
            Vec3d? origin = c.TryGetProperty("carrierOrigin", out JsonElement o) ? V3(o) : (Vec3d?)null;
            ApproachRunway runway = c.TryGetProperty("runway", out JsonElement r) ? Runway(r) : null;
            IlsDeviation? d = ApproachAids.ComputeIlsDeviation(V3(c.GetProperty("position")), c.GetProperty("targetType").GetString()!, origin, runway);
            JsonElement want = c.GetProperty("result");
            if (want.ValueKind == JsonValueKind.Null)
            {
                m.Equal($"ils {k} null", false, d.HasValue);
            }
            else
            {
                m.Equal($"ils {k} present", true, d.HasValue);
                if (d.HasValue)
                {
                    m.Close($"ils {k} localizer", Num(want, "localizer"), d.Value.Localizer, 0);
                    m.Close($"ils {k} glideslope", Num(want, "glideslope"), d.Value.Glideslope, 0);
                }
            }
            k++;
        }
        foreach (JsonElement c in h.GetProperty("aoaCues").EnumerateArray())
        {
            JsonElement[] a = c.EnumerateArray().ToArray();
            string want = a[1].GetString()!;
            AoaIndexerCue got = ApproachAids.AoaIndexerCueFor(Num(a[0]));
            m.Equal($"cue {Num(a[0])}", want, got switch { AoaIndexerCue.Slow => "slow", AoaIndexerCue.OnSpeed => "onSpeed", _ => "fast" });
        }
        foreach (JsonElement c in h.GetProperty("isIls").EnumerateArray())
        {
            JsonElement[] a = c.EnumerateArray().ToArray();
            var t = new HudTarget { TargetType = a[0].GetString()!, Airborne = a[1].GetBoolean() };
            m.Equal($"isIls {a[0]} {a[1]}", a[2].GetBoolean(), ApproachAids.IsIlsApproachTarget(t));
        }
        m.Equal("isIls null", false, ApproachAids.IsIlsApproachTarget(null));
        JsonElement ap = h.GetProperty("approach");
        m.Close("glideslopeTan", Num(ap, "glideslopeTan"), ApproachAids.GlideslopeTan, 0);
        m.Close("speedImperial", Num(ap, "speedImperial"), ApproachAids.CarrierApproachTargetSpeed(true), 0);
        m.Close("speedMetric", Num(ap, "speedMetric"), ApproachAids.CarrierApproachTargetSpeed(false), 0);
        m.Close("sinkImperial", Num(ap, "sinkImperial"), ApproachAids.CarrierApproachTargetSink(true), 0);
        m.Close("sinkMetric", Num(ap, "sinkMetric"), ApproachAids.CarrierApproachTargetSink(false), 0);
        m.AssertNone();
    }

    /// <summary>Number.prototype.toFixed on exact ties, where .NET's "F" format rounds to even.</summary>
    [Theory]
    [InlineData(0.5, 0, "1")]
    [InlineData(2.5, 0, "3")]
    [InlineData(154.5, 0, "155")]
    [InlineData(-2.5, 0, "-3")]
    [InlineData(-0.4, 0, "-0")]
    [InlineData(-0.0, 0, "0")]
    [InlineData(1.005, 2, "1.00")]
    [InlineData(1.25, 1, "1.3")]
    [InlineData(0.000001, 7, "0.0000010")]
    [InlineData(123.456, 0, "123")]
    [InlineData(1e20, 1, "100000000000000000000.0")]
    public void ToFixedRoundsTiesLikeJavaScript(double x, int digits, string expected)
    {
        Assert.Equal(expected, JsText.ToFixed(x, digits));
    }

    // approachAids.test.ts

    [Fact]
    public void DetectsAirbaseAndCarrierAsIlsTargets()
    {
        Assert.True(ApproachAids.IsIlsApproachTarget(new HudTarget { TargetType = "Airbase", TargetLocation = "x" }));
        Assert.True(ApproachAids.IsIlsApproachTarget(new HudTarget { TargetType = "Carrier", TargetLocation = "x" }));
        Assert.False(ApproachAids.IsIlsApproachTarget(new HudTarget { TargetType = "SAM Radar", TargetLocation = "x" }));
        Assert.False(ApproachAids.IsIlsApproachTarget(new HudTarget { TargetType = "Airbase", TargetLocation = "x", Airborne = true }));
    }

    [Fact]
    public void AoaIndexerIsOnSpeedOnlyInTheBand()
    {
        Assert.Equal(AoaIndexerCue.Fast, ApproachAids.AoaIndexerCueFor(7.9));
        Assert.Equal(AoaIndexerCue.OnSpeed, ApproachAids.AoaIndexerCueFor(8.0));
        Assert.Equal(AoaIndexerCue.OnSpeed, ApproachAids.AoaIndexerCueFor(8.25));
        Assert.Equal(AoaIndexerCue.OnSpeed, ApproachAids.AoaIndexerCueFor(8.5));
        Assert.Equal(AoaIndexerCue.Slow, ApproachAids.AoaIndexerCueFor(8.6));
        Assert.Equal(8.0, ApproachAids.CarrierAoaOnSpeedMinDeg);
        Assert.Equal(8.5, ApproachAids.CarrierAoaOnSpeedMaxDeg);
    }

    [Fact]
    public void CarrierApproachTargetSpeedIsMidBandKias()
    {
        Assert.Equal(137, ApproachAids.CarrierApproachSpeedKias);
        Assert.Equal(137, ApproachAids.CarrierApproachTargetSpeed(true));
        Assert.Equal(JsMath.Round(137 * 0.514444 * 3.6), ApproachAids.CarrierApproachTargetSpeed(false));
        Assert.Equal(3.0, ApproachAids.GlideslopeDeg);
    }

    [Fact]
    public void AirbaseIlsIsNearZeroOnThePath()
    {
        double touchZ = 0 - 1500 + 200;
        double dist = 2000;
        var pos = new Vec3d(0, dist * ApproachAids.GlideslopeTan, touchZ - dist);
        IlsDeviation? d = ApproachAids.ComputeIlsDeviation(pos, "Airbase");
        Assert.True(d.HasValue);
        Assert.True(Math.Abs(d!.Value.Localizer) < 0.05, $"loc {d.Value.Localizer}");
        Assert.True(Math.Abs(d.Value.Glideslope) < 0.05, $"gs {d.Value.Glideslope}");
    }

    [Fact]
    public void AirbaseIlsDeflectsWhenRightOfCourse()
    {
        double touchZ = 0 - 1500 + 200;
        IlsDeviation? d = ApproachAids.ComputeIlsDeviation(new Vec3d(90, 100, touchZ - 2000), "Airbase");
        Assert.True(d.HasValue);
        Assert.True(d!.Value.Localizer < -0.5, $"loc {d.Value.Localizer}");
    }
}
