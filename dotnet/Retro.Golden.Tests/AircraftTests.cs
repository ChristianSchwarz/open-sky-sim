using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>Replays tests/golden/aircraft.json: pack manifests to flyable defs, and each one's arrestor hook.</summary>
public class AircraftTests
{
    private static readonly JsonElement Fx = Load("aircraft.json");

    private static string Base(string path) => path == null ? null : AircraftDefs.PackEntry(path);

    private static string OptStr(JsonElement e, string prop) =>
        e.GetProperty(prop).ValueKind == JsonValueKind.String ? e.GetProperty(prop).GetString() : null;

    private static void Compare(string at, JsonElement x, FlyableAircraftDef d, Mismatches m)
    {
        m.Equal($"{at} id", x.GetProperty("id").GetString(), d.Id);
        m.Equal($"{at} name", x.GetProperty("name").GetString(), d.Name);
        m.Equal($"{at} canonicalName", OptStr(x, "canonicalName"), d.CanonicalName);
        m.Equal($"{at} modelName", OptStr(x, "modelName"), d.ModelName);
        m.Equal($"{at} liveryName", OptStr(x, "liveryName"), d.LiveryName);
        m.Equal($"{at} body", Base(x.GetProperty("body").GetString()), d.Body);
        m.Equal($"{at} shadow", Base(x.GetProperty("shadow").GetString()), d.Shadow);
        m.Equal($"{at} gear", Base(OptStr(x, "gear")), d.Gear);
        m.Equal($"{at} gearAnimated", x.GetProperty("gearAnimated").GetBoolean(), d.GearAnimated);
        m.Equal($"{at} collision", Base(OptStr(x, "collision")), d.Collision);
        m.Close($"{at} cockpitOffset", V3(x.GetProperty("cockpitOffset")), d.CockpitOffset, 0);
        JsonElement nozzles = x.GetProperty("nozzles");
        m.Equal($"{at} nozzles", nozzles.ValueKind == JsonValueKind.Null ? null : string.Join(";", nozzles.EnumerateArray().Select(n => string.Join(",", Nums(n)))),
            d.Nozzles == null ? null : string.Join(";", d.Nozzles.Select(n => string.Join(",", n))));
        JsonElement sweep = x.GetProperty("swingWings");
        m.Equal($"{at} swingWings", sweep.ValueKind == JsonValueKind.Null ? null : $"{Num(sweep, "minKias")},{Num(sweep, "maxKias")},{Num(sweep, "travelSeconds")}",
            d.SwingWings == null ? null : $"{d.SwingWings.MinKias},{d.SwingWings.MaxKias},{d.SwingWings.TravelSeconds}");
        var surfaces = x.GetProperty("surfaces").EnumerateArray().ToList();
        m.Equal($"{at} surfaces", surfaces.Count, d.Surfaces.Count);
        for (int i = 0; i < Math.Min(surfaces.Count, d.Surfaces.Count); i++)
        {
            JsonElement s = surfaces[i];
            ControlSurfaceDef c = d.Surfaces[i];
            string w = $"{at} surface {i}";
            m.Equal($"{w} role", s.GetProperty("role").GetString(), c.Role);
            m.Equal($"{w} model", Base(s.GetProperty("model").GetString()), c.Model);
            m.Close($"{w} pivot", V3(s.GetProperty("pivot")), c.Pivot, 0);
            m.Close($"{w} axis", V3(s.GetProperty("axis")), c.Axis, 0);
            m.Equal($"{w} control", s.GetProperty("control").GetString(), c.Control);
            m.Close($"{w} sign", Num(s, "sign"), c.Sign, 0);
            m.Close($"{w} rangeRad", Num(s, "rangeRad"), c.RangeRad, 0);
            m.Equal($"{w} sweepParent", OptStr(s, "sweepParent"), c.SweepParent);
        }
        m.Equal($"{at} hookTip", string.Join(",", Nums(x, "hookTip")), string.Join(",", AircraftDefs.ArrestorHookTip(d)));
        m.Equal($"{at} flightHook", string.Join(",", Nums(x, "flightHook")),
            string.Join(",", AircraftDefs.FlightConfigWithArrestorHook(d).Hook));
    }

    [Fact]
    public void PackManifestsBecomeTheOraclesDefs()
    {
        var m = new Mismatches();
        foreach (JsonElement p in Fx.GetProperty("packs").EnumerateArray())
        {
            string id = p.GetProperty("id").GetString()!;
            FlyableAircraftDef def = AircraftDefs.FromPackManifest(id, JsonReader.Parse(p.GetProperty("manifest").GetRawText()));
            Compare(id, p.GetProperty("def"), def, m);
        }
        m.AssertNone();
    }

    [Fact]
    public void F22MatchesTheOracle()
    {
        var m = new Mismatches();
        Compare("f22", Fx.GetProperty("f22"), AircraftDefs.F22(), m);
        m.AssertNone();
    }
}
