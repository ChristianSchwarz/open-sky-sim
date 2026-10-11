using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Game;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/sky.json: sun path and state, atmosphere ray march,
/// sky model gains and dome shade, daytime palette blend, sky dome and sun
/// glare buffers and colours.
/// </summary>
public class SkyTests
{
    private static readonly JsonElement Fx = Load("sky.json");
    private const double Rel = 1e-12;

    private static readonly Dictionary<string, PaletteCategory> ByKey =
        ((PaletteCategory[])Enum.GetValues(typeof(PaletteCategory))).ToDictionary(PaletteCategories.Key);

    private static void CloseArr(Mismatches m, string what, JsonElement expected, double[] actual, double tol = Rel)
    {
        double[] e = Nums(expected);
        m.Equal(what + ".length", e.Length, actual.Length);
        for (int i = 0; i < Math.Min(e.Length, actual.Length); i++)
        {
            m.Close($"{what}[{i}]", e[i], actual[i], tol);
        }
    }

    /// <summary>Relative to the vector's magnitude (radiances span many decades).</summary>
    private static void CloseVec(Mismatches m, string what, JsonElement expected, double[] actual, double tol = Rel)
    {
        double[] e = Nums(expected);
        double scale = e.Select(Math.Abs).DefaultIfEmpty(0).Max();
        m.Equal(what + ".length", e.Length, actual.Length);
        for (int i = 0; i < Math.Min(e.Length, actual.Length); i++)
        {
            double diff = Math.Abs(e[i] - actual[i]);
            m.Close($"{what}[{i}]", 0, scale > 0 ? diff / scale : diff, tol);
        }
    }

    private static void ExactFloats(Mismatches m, string what, JsonElement expected, float[] actual)
    {
        double[] e = Nums(expected);
        m.Equal(what + ".length", e.Length, actual.Length);
        int bad = 0;
        for (int i = 0; i < Math.Min(e.Length, actual.Length); i++)
        {
            if ((float)e[i] != actual[i] && bad++ < 10)
            {
                m.Fail($"{what}[{i}]: expected {(float)e[i]:R}, got {actual[i]:R}");
            }
        }
        m.Equal(what + " mismatches", 0, bad);
    }

    private static void ExactInts(Mismatches m, string what, JsonElement expected, int[] actual)
    {
        int[] e = expected.EnumerateArray().Select(x => x.GetInt32()).ToArray();
        m.Equal(what + ".length", e.Length, actual.Length);
        m.Equal(what, true, e.SequenceEqual(actual));
    }

    [Fact]
    public void SunPathAndState()
    {
        var m = new Mismatches();
        foreach (JsonElement s in Fx.GetProperty("sun").EnumerateArray())
        {
            double h = Num(s, "input");
            string w = $"h={h:R}";
            SunClock.SunDirectionAt(h, out double rx, out double ry, out double rz);
            CloseArr(m, w + ".rawDirection", s.GetProperty("rawDirection"), new[] { rx, ry, rz });
            m.Close(w + ".elevationAt", Num(s, "elevationAt"), SunClock.SunElevationAt(h), Rel);
            m.Equal(w + ".format", s.GetProperty("format").GetString(), SunClock.FormatSunTime(h));

            SunState st = SunClock.SetSunTime(h);
            m.Close(w + ".hours", Num(s, "hours"), st.Hours, Rel);
            m.Close(w + ".elevationDeg", Num(s, "elevationDeg"), st.ElevationDeg, Rel);
            m.Close(w + ".dayFactor", Num(s, "dayFactor"), st.DayFactor, Rel);
            m.Close(w + ".nightMix", Num(s, "nightMix"), st.NightMix, Rel);
            m.Close(w + ".shadowStrength", Num(s, "shadowStrength"), st.ShadowStrength, Rel);
            CloseArr(m, w + ".direction", s.GetProperty("direction"), new[] { st.DirX, st.DirY, st.DirZ });
            CloseArr(m, w + ".shade", s.GetProperty("shade"), new[] { st.ShadeAmbient, st.ShadeDirect });
            CloseArr(m, w + ".ambient", s.GetProperty("ambient"), st.Ambient);
            CloseArr(m, w + ".direct", s.GetProperty("direct"), st.Direct);
            CloseArr(m, w + ".tint", s.GetProperty("tint"), st.Tint);
        }
        foreach (JsonElement v in Fx.GetProperty("visibility").EnumerateArray())
        {
            double[] a = Nums(v);
            m.Close("visibility", a[3], SunClock.SunVisibilityFor(a[0], a[1], a[2]), Rel);
        }
        m.Close("shadowMinSunY", Num(Fx.GetProperty("constants"), "shadowMinSunY"), SunClock.ShadowMinSunY, 0);
        m.AssertNone();
    }

    [Fact]
    public void AtmosphereMarch()
    {
        var m = new Mismatches();
        foreach (JsonElement p in Fx.GetProperty("phases").EnumerateArray())
        {
            double[] a = Nums(p);
            m.Close($"rayleigh({a[0]})", a[1], Atmosphere.RayleighPhase(a[0]), Rel);
            m.Close($"mie({a[0]},0.8)", a[2], Atmosphere.MiePhase(a[0], 0.8), Rel);
            m.Close($"mie({a[0]},0.3)", a[3], Atmosphere.MiePhase(a[0], 0.3), Rel);
        }
        foreach (JsonElement s in Fx.GetProperty("samples").EnumerateArray())
        {
            double e = Num(s, "elevationDeg");
            AtmosphereSample got = Atmosphere.Sample(e, Num(s, "altitude"));
            JsonElement x = s.GetProperty("sample");
            string w = $"sample e={e}";
            CloseVec(m, w + ".zenith", x.GetProperty("zenith"), got.Zenith);
            CloseVec(m, w + ".horizonSunward", x.GetProperty("horizonSunward"), got.HorizonSunward);
            CloseVec(m, w + ".horizonOpposite", x.GetProperty("horizonOpposite"), got.HorizonOpposite);
            CloseVec(m, w + ".sunDisc", x.GetProperty("sunDisc"), got.SunDisc);
            CloseVec(m, w + ".sunward", x.GetProperty("sunward"), got.Sunward);
            CloseVec(m, w + ".directIrradiance", x.GetProperty("directIrradiance"), got.DirectIrradiance);
            CloseVec(m, w + ".skyIrradiance", x.GetProperty("skyIrradiance"), got.SkyIrradiance);
        }
        foreach (JsonElement t in Fx.GetProperty("msTables").EnumerateArray())
        {
            double[][] table = Atmosphere.MultipleScatteringTable(Atmosphere.Earth, Nums(t, "sunDir"));
            int i = 0;
            foreach (JsonElement row in t.GetProperty("table").EnumerateArray())
            {
                CloseVec(m, $"ms[{i}]", row, table[i]);
                i++;
            }
        }
        foreach (JsonElement r in Fx.GetProperty("radiances").EnumerateArray())
        {
            double[] got = Atmosphere.SkyRadiance(Atmosphere.Earth, Num(r, "altitude"), Nums(r, "view"), Nums(r, "sunDir"));
            CloseVec(m, "radiance", r.GetProperty("radiance"), got);
        }
        foreach (JsonElement r in Fx.GetProperty("transmittances").EnumerateArray())
        {
            double[] got = Atmosphere.SunTransmittance(Atmosphere.Earth, Nums(r, "position"), Nums(r, "sunDir"));
            CloseVec(m, "transmittance", r.GetProperty("transmittance"), got);
        }
        m.AssertNone();
    }

    [Fact]
    public void SkyModelSlotsAndDomeShade()
    {
        var m = new Mismatches();
        foreach (JsonElement s in Fx.GetProperty("skySamples").EnumerateArray())
        {
            double e = Num(s, "input");
            SkySample got = SkyModel.SkyFor(e);
            JsonElement x = s.GetProperty("sky");
            string w = $"skyFor({e})";
            m.Close(w + ".elevationDeg", Num(x, "elevationDeg"), got.ElevationDeg, Rel);
            m.Close(w + ".nightMix", Num(x, "nightMix"), got.NightMix, Rel);
            CloseArr(m, w + ".zenith", x.GetProperty("zenith"), got.Zenith);
            CloseArr(m, w + ".horizon", x.GetProperty("horizon"), got.Horizon);
            CloseArr(m, w + ".horizonSunward", x.GetProperty("horizonSunward"), got.HorizonSunward);
            CloseArr(m, w + ".haze", x.GetProperty("haze"), got.Haze);
            CloseArr(m, w + ".cloud", x.GetProperty("cloud"), got.Cloud);
            CloseArr(m, w + ".sunDisc", x.GetProperty("sunDisc"), got.SunDisc);
            CloseArr(m, w + ".ground", x.GetProperty("ground"), got.Ground);
            CloseArr(m, w + ".water", x.GetProperty("water"), got.Water);
            CloseArr(m, w + ".directTint", x.GetProperty("directTint"), got.DirectTint);
            CloseArr(m, w + ".ambientTint", x.GetProperty("ambientTint"), got.AmbientTint);
        }
        foreach (JsonElement d in Fx.GetProperty("domeShades").EnumerateArray())
        {
            double[] a = Nums(d);
            DomeShade got = SkyModel.Shade(a[0], a[1], a[2]);
            string w = $"domeShade({a[0]},{a[1]},{a[2]})";
            m.Close(w + ".r", a[3], got.ChromaR, Rel);
            m.Close(w + ".g", a[4], got.ChromaG, Rel);
            m.Close(w + ".b", a[5], got.ChromaB, Rel);
            m.Close(w + ".hueWeight", a[6], got.HueWeight, Rel);
            m.Close(w + ".brightness", a[7], got.Brightness, Rel);
        }
        m.AssertNone();
    }

    private static void ComparePalette(Mismatches m, string w, JsonElement expected, Palette got)
    {
        int n = 0;
        foreach (JsonProperty c in expected.GetProperty("colors").EnumerateObject())
        {
            n++;
            string[] want = c.Value.ValueKind == JsonValueKind.String
                ? new[] { c.Value.GetString() }
                : c.Value.EnumerateArray().Select(x => x.GetString()).ToArray();
            string[] have = got.Colors[ByKey[c.Name]];
            m.Equal($"{w}.{c.Name}", string.Join(",", want), string.Join(",", have));
        }
        m.Equal(w + ".categories", n, got.Colors.Count);
        foreach (JsonProperty v in expected.GetProperty("values").EnumerateObject())
        {
            m.Close($"{w}.values.{v.Name}", Num(v.Value), got.Values[ByKey[v.Name]], Rel);
        }
        m.Equal(w + ".time", expected.GetProperty("time").GetString(), got.Time == PaletteTime.Day ? "day" : "night");
        CloseArr(m, w + ".light", expected.GetProperty("light"), got.Light);
    }

    [Fact]
    public void DaytimePaletteBlend()
    {
        var m = new Mismatches();
        foreach (JsonElement d in Fx.GetProperty("daytime").EnumerateArray())
        {
            double h = Num(d, "hours");
            SunState st = SunClock.SetSunTime(h);
            m.Close($"h={h}.elevation", Num(d, "elevationDeg"), st.ElevationDeg, Rel);
            Palette got = DaytimePalette.ForElevation(Palettes.HdNoon, Palettes.HdMidnight, st.ElevationDeg);
            ComparePalette(m, $"h={h}", d.GetProperty("palette"), got);
        }
        foreach (JsonElement d in Fx.GetProperty("nightVision").EnumerateArray())
        {
            double e = Num(d, "elevationDeg");
            Palette got = DaytimePalette.Blend(Palettes.HdNoon, Palettes.HdNightVision, SkyModel.SkyFor(e));
            ComparePalette(m, $"nv e={e}", d.GetProperty("palette"), got);
        }
        m.AssertNone();
    }

    [Fact]
    public void DomeAndSunGeometry()
    {
        var m = new Mismatches();
        SkyDomeGeometry dome = SkyDome.BuildGeometry();
        JsonElement d = Fx.GetProperty("dome");
        ExactFloats(m, "dome.positions", d.GetProperty("positions"), dome.Positions);
        ExactFloats(m, "dome.directions", d.GetProperty("directions"), dome.Directions);
        ExactInts(m, "dome.index", d.GetProperty("index"), dome.Indices);

        SunDiscGeometry disc = SunDisc.BuildDisc();
        ExactFloats(m, "disc.positions", Fx.GetProperty("disc").GetProperty("positions"), disc.Positions);
        ExactInts(m, "disc.index", Fx.GetProperty("disc").GetProperty("index"), disc.Indices);

        SunGlareGeometry glare = SunDisc.BuildGlare();
        JsonElement g = Fx.GetProperty("glare");
        ExactFloats(m, "glare.positions", g.GetProperty("positions"), glare.Positions);
        ExactFloats(m, "glare.falloff", g.GetProperty("falloff"), glare.Falloff);
        ExactFloats(m, "glare.cap", g.GetProperty("cap"), glare.Cap);
        ExactInts(m, "glare.index", g.GetProperty("index"), glare.Indices);
        m.AssertNone();
    }

    [Fact]
    public void DomeAndGlarePaint()
    {
        var m = new Mismatches();
        SkyDomeGeometry dome = SkyDome.BuildGeometry();
        SunGlareGeometry glare = SunDisc.BuildGlare();
        foreach (JsonElement p in Fx.GetProperty("paints").EnumerateArray())
        {
            double h = Num(p, "hours");
            SunState st = SunClock.SetSunTime(h);
            string w = $"h={h}";
            m.Close(w + ".nightMix", Num(p, "nightMix"), st.NightMix, Rel);
            CloseArr(m, w + ".sunDir", p.GetProperty("sunDir"), new[] { st.DirX, st.DirY, st.DirZ });

            float[] domeColors = SkyDome.Paint(dome, Palettes.HdNoon, Palettes.HdMidnight, st.NightMix, st.DirX, st.DirY, st.DirZ);
            ExactFloats(m, w + ".domeColors", p.GetProperty("domeColors"), domeColors);
            float[] glareColors = SunDisc.PaintGlare(glare, Palettes.HdNoon, Palettes.HdMidnight, st.NightMix, st.DirX, st.DirY, st.DirZ);
            ExactFloats(m, w + ".glareColors", p.GetProperty("glareColors"), glareColors);

            Palette active = DaytimePalette.ForElevation(Palettes.HdNoon, Palettes.HdMidnight, st.ElevationDeg);
            m.Close(w + ".veil", Num(p, "veilDensity"), SunDisc.VeilDensity(active), Rel);

            double[] pos = new double[3], q = new double[4];
            SunDisc.PlaceSun(st.DirX, st.DirY, st.DirZ, pos, q);
            CloseArr(m, w + ".sunPosition", p.GetProperty("sunPosition"), pos);
            CloseArr(m, w + ".sunQuaternion", p.GetProperty("sunQuaternion"), q);
        }
        m.AssertNone();
    }
}
