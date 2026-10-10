using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>Replays tests/golden/heights.json: HeightSampler over real DEM tiles with airfield pads.</summary>
public class HeightTests
{
    private static readonly JsonElement Fx = Load("heights.json");

    private static double? Opt(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out JsonElement v) && v.ValueKind != JsonValueKind.Null ? Num(v) : (double?)null;

    private static (HeightSampler sampler, List<FlattenPad> pads) Build()
    {
        string tiles = Path.Combine(Root, "tiles");
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(tiles, "manifest.json")));
        JsonElement manifest = doc.RootElement;
        JsonElement origin = manifest.GetProperty("enuOrigin");
        EnuBasis basis = Geodesy.MakeEnuBasis(Num(origin, "lat"), Num(origin, "lon"), Num(origin, "height"));
        (double, double) ToEnu(double lat, double lon)
        {
            Enu enu = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, 0));
            return (enu.E, enu.N);
        }
        var pads = manifest.GetProperty("flattenPads").EnumerateArray()
            .Select(p => FlattenPads.FromRecord(new FlattenPadRecord
            {
                Lat = Num(p, "lat"),
                Lon = Num(p, "lon"),
                HalfW = Num(p, "halfW"),
                HalfD = Num(p, "halfD"),
                FeatherM = Num(p, "featherM"),
                HeightMsl = Num(p, "heightMsl"),
                HeadingDeg = Opt(p, "headingDeg"),
                Gradient = Opt(p, "gradient"),
                GradientHeadingDeg = Opt(p, "gradientHeadingDeg"),
            }, ToEnu))
            .Where(p => JsMath.Hypot(p.CenterX, p.CenterZ) - FlattenPads.ReachM(p) <= 400000)
            .ToList();

        var dem = new Dictionary<string, DemTile>();
        foreach (string file in Directory.GetFiles(Path.Combine(tiles, "height"), "*.pdm"))
        {
            string[] parts = Path.GetFileNameWithoutExtension(file).Split('_');
            dem[$"{parts[0]}/{parts[1]}/{parts[2]}"] = TileFile.Pdm(File.ReadAllBytes(file));
        }
        var sampler = new HeightSampler(new HeightSamplerOptions
        {
            Basis = basis,
            SeaLevel = Num(manifest, "seaLevel"),
            QueryZoom = 11,
            CoarseZoom = 7,
            Pads = pads,
            Fine = id => id.Z == 11 && dem.TryGetValue(id.ToString(), out DemTile t) ? t : null,
            Coarse = id => id.Z == 7 && dem.TryGetValue(id.ToString(), out DemTile t) ? t : null,
        });
        return (sampler, pads);
    }

    [Fact]
    public void PadsMatchTheOracle()
    {
        var (_, pads) = Build();
        var m = new Mismatches();
        m.Equal("padCount", Fx.GetProperty("padCount").GetInt32(), pads.Count);
        int i = 0;
        foreach (JsonElement p in Fx.GetProperty("pads").EnumerateArray())
        {
            FlattenPad got = pads[i];
            string at = $"pad {i++}";
            m.Close($"{at} centerX", Num(p, "centerX"), got.CenterX, 1e-9);
            m.Close($"{at} centerZ", Num(p, "centerZ"), got.CenterZ, 1e-9);
            m.Close($"{at} heightMsl", Num(p, "heightMsl"), got.HeightMsl, 0);
            m.Equal($"{at} has axis", p.TryGetProperty("axisE", out _), got.AxisE.HasValue);
            if (got.AxisE.HasValue)
            {
                m.Close($"{at} axisE", Num(p, "axisE"), got.AxisE.Value, 1e-12);
                m.Close($"{at} axisN", Num(p, "axisN"), got.AxisN.Value, 1e-12);
                m.Close($"{at} gradE", Num(p, "gradE"), got.GradE.Value, 1e-12);
                m.Close($"{at} gradN", Num(p, "gradN"), got.GradN.Value, 1e-12);
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void QueriesMatchTheOracle()
    {
        var (sampler, _) = Build();
        var m = new Mismatches();
        double metres = Num(Fx.GetProperty("tolerances"), "metres");
        foreach (JsonElement q in Fx.GetProperty("queries").EnumerateArray())
        {
            double e = Num(q, "e"), n = Num(q, "n");
            string at = $"({e:F1}, {n:F1})";
            m.Close($"{at} heightAtEnu", Num(q, "heightAtEnu"), sampler.HeightAtEnu(e, n), metres);
            m.Close($"{at} geodeticHeightAtEnu", Num(q, "geodeticHeightAtEnu"), sampler.GeodeticHeightAtEnu(e, n), metres);
            m.Equal($"{at} isLand", q.GetProperty("isLandEnu").GetBoolean(), sampler.IsLandEnu(e, n));
            m.Equal($"{at} tier", q.GetProperty("tier").GetString(), sampler.TierAtEnu(e, n).ToString().ToLowerInvariant());
            m.Equal($"{at} fineTileKey", q.GetProperty("fineTileKey").GetString(), sampler.FineTileKeyAtEnu(e, n));
            m.Close($"{at} altitude", Num(q, "geodeticAltitudeAt100m"), sampler.GeodeticAltitudeAtEnu(e, n, 100), metres);
        }
        foreach (JsonElement l in Fx.GetProperty("lonLat").EnumerateArray())
        {
            double lon = Num(l, "lon"), lat = Num(l, "lat");
            double h = sampler.HeightAtLonLat(lon, lat);
            m.Close($"heightAtLonLat({lon}, {lat})", Num(l, "height"), h, metres);
            m.Equal($"water({lon}, {lat})", l.GetProperty("water").GetBoolean(), HeightSampler.IsWaterHeight(h, sampler.SeaLevel));
        }
        foreach (JsonElement c in Fx.GetProperty("padChecks").EnumerateArray())
        {
            JsonElement p = c.GetProperty("pad");
            var pad = new FlattenPad
            {
                CenterX = Num(p, "centerX"), CenterZ = Num(p, "centerZ"), HalfW = Num(p, "halfW"), HalfD = Num(p, "halfD"),
                FeatherM = Num(p, "featherM"), HeightMsl = Num(p, "heightMsl"),
                AxisE = Opt(p, "axisE"), AxisN = Opt(p, "axisN"), GradE = Opt(p, "gradE"), GradN = Opt(p, "gradN"),
            };
            double e = Num(c, "e"), n = Num(c, "n");
            m.Close("pad weight", Num(c, "weight"), FlattenPads.BlendWeight(e, n, pad), 1e-12);
            m.Close("pad surface", Num(c, "surface"), FlattenPads.SurfaceHeight(e, n, pad), 1e-9);
            m.Close("pad applied", Num(c, "applied"), FlattenPads.Apply(37.5, e, n, pad), 1e-9);
            m.Close("pad appliedNaN", Num(c, "appliedNaN"), FlattenPads.Apply(double.NaN, e, n, pad), 1e-9);
        }
        m.AssertNone();
    }
}
