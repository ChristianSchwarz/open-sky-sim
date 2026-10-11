using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/settings.json: stored settings read and written
/// (settingsStorage.ts), the live settings' clamping and listeners
/// (configService.ts), every dialog action (settingsModel.ts SettingsActions),
/// the dialog's text, options, ranges, readouts and layout, the spawn menu,
/// and the boot progress.
/// </summary>
public class SettingsTests
{
    private static readonly JsonElement Fx = Load("settings.json");

    /// <summary>A fixture string, read with the port's own JSON reader (System.Text.Json refuses lone surrogates).</summary>
    private static string S(JsonElement e) => e.ValueKind == JsonValueKind.Null ? null : JsonReader.Parse(e.GetRawText()).AsString;

    private static string S(JsonElement e, string prop) => S(e.GetProperty(prop));

    private static JsonValue J(JsonElement e) => JsonReader.Parse(e.GetRawText());

    private static JsonElement? Opt(JsonElement e, string prop) =>
        e.TryGetProperty(prop, out JsonElement v) ? v : null;

    // ---- AppSettings fields by TS name ----

    private static object FieldOf(AppSettings s, string field) => field switch
    {
        "techProfile" => s.TechProfile,
        "flightModel" => s.FlightModel,
        "keyboardLayout" => (double)(int)s.KeyboardLayout,
        "keyboardPitchStickMode" => (double)(int)s.KeyboardPitchStickMode,
        "aiPilotModel" => SettingsCodec.Name(s.AiPilotModel),
        "terrainColour" => SettingsCodec.Name(s.TerrainColour),
        "terrainShading" => SettingsCodec.Name(s.TerrainShading),
        "landuseBlend" => s.LanduseBlend,
        "treeDensity" => s.TreeDensity,
        "aircraftId" => s.AircraftId,
        "spawnMode" => SettingsCodec.Name(s.SpawnMode),
        "daytime" => s.Daytime,
        "terrainArea" => s.TerrainArea,
        "terrainDetailDistanceM" => s.TerrainDetailDistanceM,
        "landuseReach" => s.LanduseReach,
        "visibleZoom" => s.VisibleZoom,
        "landuseRevealPx" => s.LanduseRevealPx,
        "terrainTriangleBudget" => s.TerrainTriangleBudget,
        "farTileTextures" => s.FarTileTextures,
        "buildings" => s.Buildings,
        "roads" => SettingsCodec.Name(s.Roads),
        "renderScale" => s.RenderScale,
        "supersampling" => s.Supersampling,
        "volume" => s.Volume,
        _ => throw new ArgumentException(field),
    };

    private static readonly HashSet<string> StringFields = new()
    {
        "techProfile", "flightModel", "aiPilotModel", "terrainColour", "terrainShading", "aircraftId", "spawnMode",
        "terrainArea", "roads",
    };

    private static void CompareField(Mismatches m, string what, string field, JsonElement expected, object actual)
    {
        if (expected.ValueKind == JsonValueKind.Null)
        {
            m.Equal(what, "null", actual == null ? "null" : actual.ToString());
        }
        else if (expected.ValueKind is JsonValueKind.True or JsonValueKind.False)
        {
            m.Equal(what, expected.GetBoolean(), actual is bool b && b);
        }
        else if (StringFields.Contains(field))
        {
            m.Equal(what, S(expected), actual as string);
        }
        else
        {
            double a = actual is double d ? d : actual is null ? double.NaN : Convert.ToDouble(actual);
            m.Equal(what, Num(expected), a);
        }
    }

    private static void CompareAdjust(Mismatches m, string what, JsonElement expected, ColourAdjust actual)
    {
        foreach (ColourAdjustGroup g in ColourAdjust.Groups)
        {
            JsonElement t = expected.GetProperty(ColourAdjust.Key(g));
            m.Equal($"{what}.{ColourAdjust.Key(g)}.hue", Num(t, "hue"), actual[g].Hue);
            m.Equal($"{what}.{ColourAdjust.Key(g)}.saturation", Num(t, "saturation"), actual[g].Saturation);
            m.Equal($"{what}.{ColourAdjust.Key(g)}.brightness", Num(t, "brightness"), actual[g].Brightness);
        }
    }

    private static void CompareSettings(Mismatches m, string what, JsonElement expected, AppSettings actual)
    {
        foreach (string field in AppSettings.FieldNames)
        {
            if (field == "colourAdjust") CompareAdjust(m, $"{what}.colourAdjust", expected.GetProperty(field), actual.ColourAdjust);
            else CompareField(m, $"{what}.{field}", field, expected.GetProperty(field), FieldOf(actual, field));
        }
    }

    /// <summary>The TS partial applied to the C# settings, key by key, unvalidated as in updateSettings.</summary>
    private static void ApplyPartial(AppSettings s, JsonElement partial)
    {
        foreach (JsonProperty p in partial.EnumerateObject())
        {
            JsonElement v = p.Value;
            switch (p.Name)
            {
                case "techProfile": s.TechProfile = S(v); break;
                case "flightModel": s.FlightModel = S(v); break;
                case "keyboardLayout": s.KeyboardLayout = (KeyboardControlLayoutId)v.GetInt32(); break;
                case "keyboardPitchStickMode": s.KeyboardPitchStickMode = (KeyboardPitchStickMode)v.GetInt32(); break;
                case "aiPilotModel": SettingsCodec.TryParse(S(v), out s.AiPilotModel); break;
                case "terrainColour": SettingsCodec.TryParse(S(v), out s.TerrainColour); break;
                case "terrainShading": SettingsCodec.TryParse(S(v), out s.TerrainShading); break;
                case "landuseBlend": s.LanduseBlend = Num(v); break;
                case "treeDensity": s.TreeDensity = Num(v); break;
                case "colourAdjust": s.ColourAdjust = ColourAdjust.Clamp(J(v)); break;
                case "aircraftId": s.AircraftId = S(v); break;
                case "spawnMode": SettingsCodec.TryParse(S(v), out s.SpawnMode); break;
                case "daytime": s.Daytime = Num(v); break;
                case "terrainArea": s.TerrainArea = S(v); break;
                case "terrainDetailDistanceM": s.TerrainDetailDistanceM = v.ValueKind == JsonValueKind.Null ? null : Num(v); break;
                case "landuseReach": s.LanduseReach = Num(v); break;
                case "visibleZoom": s.VisibleZoom = Num(v); break;
                case "landuseRevealPx": s.LanduseRevealPx = Num(v); break;
                case "terrainTriangleBudget": s.TerrainTriangleBudget = Num(v); break;
                case "farTileTextures": s.FarTileTextures = v.GetBoolean(); break;
                case "buildings": s.Buildings = v.GetBoolean(); break;
                case "roads": SettingsCodec.TryParse(S(v), out s.Roads); break;
                case "renderScale": s.RenderScale = Num(v); break;
                case "supersampling": s.Supersampling = v.GetBoolean(); break;
                case "volume": s.Volume = Num(v); break;
                default: throw new ArgumentException(p.Name);
            }
        }
    }

    private static SettingsStorage StorageWith(string raw)
    {
        var store = new MemoryKeyValueStore();
        if (raw != null) store.SetItem(SettingsStorage.StorageKey, raw);
        return new SettingsStorage(store);
    }

    [Fact]
    public void DefaultsAndKeys()
    {
        var m = new Mismatches();
        m.Equal("storageKey", S(Fx, "storageKey"), SettingsStorage.StorageKey);
        m.Equal("fields", string.Join(",", Fx.GetProperty("fields").EnumerateArray().Select(S)), string.Join(",", AppSettings.FieldNames));
        CompareSettings(m, "defaults", Fx.GetProperty("defaults"), SettingsStorage.Defaults());
        m.Equal("defaultsJson", S(Fx, "defaultsJson"), SettingsStorage.Serialize(SettingsStorage.Defaults()));
        JsonElement enums = Fx.GetProperty("enums");
        string Names(string key) => string.Join(",", enums.GetProperty(key).EnumerateArray().Select(S));
        m.Equal("techProfiles", Names("techProfiles"), string.Join(",", TechProfiles.All));
        m.Equal("flightModels", Names("flightModels"), string.Join(",", ConfigService.FlightModelIds));
        m.Equal("flightModels enum", Names("flightModels"), string.Join(",", Enum.GetValues<FlightModels>().Select(SettingsCodec.Name)));
        m.Equal("aiPilotModels", Names("aiPilotModels"), string.Join(",", Enum.GetValues<AiPilotModels>().Select(SettingsCodec.Name)));
        m.Equal("terrainColours", Names("terrainColours"), string.Join(",", Enum.GetValues<TerrainColours>().Select(SettingsCodec.Name)));
        m.Equal("terrainShading", Names("terrainShading"), string.Join(",", Enum.GetValues<TerrainShading>().Select(SettingsCodec.Name)));
        m.Equal("unitSystems", Names("unitSystems"), string.Join(",", Enum.GetValues<UnitSystems>().Select(SettingsCodec.Name)));
        m.Equal("spawnModes", Names("spawnModes"), string.Join(",", Enum.GetValues<SpawnMode>().Select(SettingsCodec.Name)));
        var roads = enums.GetProperty("roads").EnumerateArray().Select(S).OrderBy(x => x, StringComparer.Ordinal);
        m.Equal("roads", string.Join(",", roads), string.Join(",", Enum.GetValues<RoadsMode>().Select(SettingsCodec.Name).OrderBy(x => x, StringComparer.Ordinal)));
        m.AssertNone();
    }

    [Fact]
    public void LoadEachFieldFromEachValue()
    {
        var m = new Mismatches();
        foreach (JsonElement f in Fx.GetProperty("load").GetProperty("fields").EnumerateArray())
        {
            string field = S(f, "field");
            foreach (JsonElement row in f.GetProperty("results").EnumerateArray())
            {
                string text = S(row[0]);
                AppSettings s = SettingsStorage.Parse($"{{\"{field}\": {text}}}");
                CompareField(m, $"{field} <- {text}", field, row[1], FieldOf(s, field));
            }
        }
        m.AssertNone();
    }

    [Fact]
    public void LoadWholeStoredStrings()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("load").GetProperty("raw").EnumerateArray())
        {
            string raw = S(c, "raw");
            string what = raw == null ? "(absent)" : JsonSerializer.Serialize(raw);
            AppSettings viaStore = StorageWith(raw).Load();
            CompareSettings(m, what, c.GetProperty("settings"), viaStore);
            m.Equal(what + " normalized", S(c, "normalized"), SettingsStorage.Serialize(viaStore));
        }
        m.AssertNone();
    }

    [Fact]
    public void UpdatesWriteTheStoredString()
    {
        var m = new Mismatches();
        foreach (JsonElement seq in Fx.GetProperty("update").EnumerateArray())
        {
            var store = new MemoryKeyValueStore();
            string start = S(seq, "start");
            if (start != null) store.SetItem(SettingsStorage.StorageKey, start);
            var storage = new SettingsStorage(store);
            int i = 0;
            foreach (JsonElement step in seq.GetProperty("steps").EnumerateArray())
            {
                string what = $"{start ?? "(absent)"} step {i++}";
                JsonElement partial = step.GetProperty("partial");
                AppSettings returned = storage.Update(s => ApplyPartial(s, partial));
                m.Equal(what + " written", S(step, "written"), store.GetItem(SettingsStorage.StorageKey));
                CompareSettings(m, what + " returned", step.GetProperty("returned"), returned);
                CompareSettings(m, what + " reloaded", step.GetProperty("reloaded"), storage.Load());
            }
        }
        m.AssertNone();
    }

    private static Setting<double> MakeNumeric(string name, double? initial) => name switch
    {
        "daytime" => initial.HasValue ? new DaytimeSetting(initial.Value) : new DaytimeSetting(),
        "terrainDetail" => initial.HasValue ? new TerrainDetailSetting(initial.Value) : new TerrainDetailSetting(),
        "landuseReach" => initial.HasValue ? new LanduseReachSetting(initial.Value) : new LanduseReachSetting(),
        "visibleZoom" => initial.HasValue ? new VisibleZoomSetting(initial.Value) : new VisibleZoomSetting(),
        "landuseReveal" => initial.HasValue ? new LanduseRevealSetting(initial.Value) : new LanduseRevealSetting(),
        "triangleBudget" => initial.HasValue ? new TriangleBudgetSetting(initial.Value) : new TriangleBudgetSetting(),
        "landuseBlend" => initial.HasValue ? new LanduseBlendSetting(initial.Value) : new LanduseBlendSetting(),
        "treeDensity" => initial.HasValue ? new TreeDensitySetting(initial.Value) : new TreeDensitySetting(),
        "renderScale" => initial.HasValue ? new RenderScaleSetting(initial.Value) : new RenderScaleSetting(),
        _ => throw new ArgumentException(name),
    };

    [Fact]
    public void NumericSettingsClampAndNotify()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("numeric").EnumerateArray())
        {
            string name = S(c, "name");
            m.Equal(name + " default", Num(c, "default"), MakeNumeric(name, null).Active);
            foreach (JsonElement row in c.GetProperty("initial").EnumerateArray())
            {
                double input = Num(row[0]);
                m.Equal($"{name} new({input})", Num(row[1]), MakeNumeric(name, input).Active);
            }
            Setting<double> setting = MakeNumeric(name, null);
            int calls = 0;
            setting.AddChangeListener(_ => calls++);
            foreach (JsonElement row in c.GetProperty("steps").EnumerateArray())
            {
                double input = Num(row[0]);
                calls = 0;
                setting.SetActive(input);
                m.Equal($"{name} set({input})", Num(row[1]), setting.Active);
                m.Equal($"{name} set({input}) notified", row[2].GetInt32(), calls);
            }
        }
        m.AssertNone();
    }

    private static void EnumSequence<T>(Mismatches m, JsonElement c, Setting<T> fresh, Setting<T> setting, Func<T, string> name, Func<JsonElement, T> parse)
    {
        string what = S(c, "name");
        JsonElement def = c.GetProperty("default");
        m.Equal(what + " default", def.ValueKind == JsonValueKind.String ? S(def) : def.GetRawText(), name(fresh.Active));
        int calls = 0;
        setting.AddChangeListener(_ => calls++);
        foreach (JsonElement row in c.GetProperty("steps").EnumerateArray())
        {
            calls = 0;
            setting.SetActive(parse(row[0]));
            m.Equal($"{what} set {row[0]}", row[1].ValueKind == JsonValueKind.String ? S(row[1]) : row[1].GetRawText(), name(setting.Active));
            m.Equal($"{what} set {row[0]} notified", row[2].GetInt32(), calls);
        }
    }

    private static T ParseEnum<T>(JsonElement e) where T : struct, Enum
    {
        string s = S(e);
        if (typeof(T) == typeof(RoadsMode)) { SettingsCodec.TryParse(s, out RoadsMode r); return (T)(object)r; }
        return Enum.Parse<T>(s);
    }

    [Fact]
    public void EnumAndToggleSettings()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("enumSettings").EnumerateArray())
        {
            switch (S(c, "name"))
            {
                case "unitSystem": EnumSequence(m, c, new UnitSystemSetting(), new UnitSystemSetting(), SettingsCodec.Name, ParseEnum<UnitSystems>); break;
                case "aiPilotModel": EnumSequence(m, c, new AiPilotModelSetting(), new AiPilotModelSetting(), SettingsCodec.Name, ParseEnum<AiPilotModels>); break;
                case "terrainColour": EnumSequence(m, c, new TerrainColourSetting(), new TerrainColourSetting(), SettingsCodec.Name, ParseEnum<TerrainColours>); break;
                case "terrainShading": EnumSequence(m, c, new TerrainShadingSetting(), new TerrainShadingSetting(), SettingsCodec.Name, ParseEnum<TerrainShading>); break;
                case "roads": EnumSequence(m, c, new RoadsSetting(), new RoadsSetting(), SettingsCodec.Name, ParseEnum<RoadsMode>); break;
                case "farTileTextures": EnumSequence(m, c, new FarTileTexturesSetting(), new FarTileTexturesSetting(), B, e => e.GetBoolean()); break;
                case "buildings": EnumSequence(m, c, new BuildingsSetting(), new BuildingsSetting(), B, e => e.GetBoolean()); break;
                case "supersampling": EnumSequence(m, c, new SupersamplingSetting(), new SupersamplingSetting(), B, e => e.GetBoolean()); break;
                default: m.Fail("unknown setting " + S(c, "name")); break;
            }
        }
        m.AssertNone();
    }

    private static string B(bool b) => b ? "true" : "false";

    [Fact]
    public void ConfigSetFallsBackAndThrows()
    {
        var m = new Mismatches();
        JsonElement c = Fx.GetProperty("configSet");
        foreach (JsonElement row in c.GetProperty("initial").EnumerateArray())
        {
            var set = new ConfigSet(ConfigService.FlightModelIds, S(row[0]));
            m.Equal($"initial {S(row[0])}", S(row[1]), set.ActiveKey);
        }
        var config = new ConfigService(TechProfiles.All, ConfigService.FlightModelIds);
        var log = new List<string>();
        config.FlightModels.AddChangeListener((id, old) => log.Add($"change,{id},{old}"));
        foreach (string id in new[] { "FM3", "FM3", "DEBUG", "BOGUS", "FM2" })
        {
            try
            {
                config.FlightModels.SetActive(id);
                log.Add($"set,{id},{config.FlightModels.ActiveKey}");
            }
            catch (ArgumentException)
            {
                log.Add($"throws,{id},{config.FlightModels.ActiveKey}");
            }
        }
        config.FlightModels.NotifyActive();
        log.Add($"notified,{config.FlightModels.ActiveKey}");
        var expected = c.GetProperty("log").EnumerateArray().Select(r => string.Join(",", r.EnumerateArray().Select(S))).ToList();
        m.Equal("log", string.Join(" | ", expected), string.Join(" | ", log));
        m.AssertNone();
    }

    [Fact]
    public void ListenersFollowSetSemantics()
    {
        var setting = new DaytimeSetting();
        var log = new List<string>();
        Action<double> c = h => log.Add($"C{h}");
        Action<double> b = h => log.Add($"B{h}");
        Action<double> d = h => log.Add($"D{h}");
        Action<double> a = null;
        a = h =>
        {
            log.Add($"A{h}");
            if (h == 1)
            {
                setting.RemoveChangeListener(b);
                setting.AddChangeListener(c);
            }
            if (h == 2)
            {
                setting.RemoveChangeListener(d);
                setting.AddChangeListener(d);
                setting.AddChangeListener(b);
            }
            if (h == 3) setting.RemoveChangeListener(a);
        };
        setting.AddChangeListener(a);
        setting.AddChangeListener(b);
        setting.AddChangeListener(a);
        setting.AddChangeListener(d);
        var actions = new Dictionary<string, Action>
        {
            ["set 1"] = () => setting.SetActive(1),
            ["set 2"] = () => setting.SetActive(2),
            ["set 2 again"] = () => setting.SetActive(2),
            ["notify"] = () => setting.NotifyActive(),
            ["set 3"] = () => setting.SetActive(3),
            ["remove d, add b, set 4"] = () =>
            {
                setting.RemoveChangeListener(d);
                setting.AddChangeListener(b);
                setting.SetActive(4);
            },
        };
        var m = new Mismatches();
        foreach (JsonElement step in Fx.GetProperty("listeners").EnumerateArray())
        {
            log.Clear();
            actions[S(step, "action")]();
            m.Equal(S(step, "action"), string.Join(",", step.GetProperty("log").EnumerateArray().Select(S)), string.Join(",", log));
        }
        m.AssertNone();
    }

    private static ColourTweak Tweak(JsonElement e) => new(Num(e, "hue"), Num(e, "saturation"), Num(e, "brightness"));

    private static ColourAdjustGroup Group(string key) => ColourAdjust.Groups.First(g => ColourAdjust.Key(g) == key);

    [Fact]
    public void ColourAdjustClampsAndNotifies()
    {
        var m = new Mismatches();
        JsonElement c = Fx.GetProperty("colourAdjust");
        CompareAdjust(m, "defaults", c.GetProperty("defaults"), ColourAdjust.Default);
        int i = 0;
        foreach (JsonElement row in c.GetProperty("clamp").EnumerateArray())
        {
            JsonElement input = row.GetProperty("input");
            JsonValue value = input.ValueKind == JsonValueKind.String && S(input) == "(undefined)" ? JsonValue.Null : J(input);
            CompareAdjust(m, $"clamp[{i++}]", row.GetProperty("output"), ColourAdjust.Clamp(value));
        }
        var setting = new ColourAdjustSetting(ColourAdjust.Clamp(JsonReader.Parse("{\"sky\": {\"hue\": 10, \"saturation\": 1, \"brightness\": 1}}")));
        int calls = 0;
        setting.AddChangeListener(_ => calls++);
        i = 0;
        foreach (JsonElement step in c.GetProperty("steps").EnumerateArray())
        {
            calls = 0;
            setting.SetTweak(Group(S(step, "group")), Tweak(step.GetProperty("tweak")));
            CompareAdjust(m, $"step[{i}]", step.GetProperty("active"), setting.Active);
            m.Equal($"step[{i++}] notified", step.GetProperty("notified").GetInt32(), calls);
        }
        m.AssertNone();
    }

    private static void CompareSnapshot(Mismatches m, string what, JsonElement e, ConfigService c)
    {
        m.Equal(what + ".techProfile", S(e, "techProfile"), c.TechProfiles.ActiveKey);
        m.Equal(what + ".flightModel", S(e, "flightModel"), c.FlightModels.ActiveKey);
        m.Equal(what + ".unitSystem", S(e, "unitSystem"), SettingsCodec.Name(c.UnitSystem.Active));
        m.Equal(what + ".aiPilotModel", S(e, "aiPilotModel"), SettingsCodec.Name(c.AiPilotModels.Active));
        m.Equal(what + ".terrainColour", S(e, "terrainColour"), SettingsCodec.Name(c.TerrainColour.Active));
        m.Equal(what + ".terrainShading", S(e, "terrainShading"), SettingsCodec.Name(c.TerrainShading.Active));
        m.Equal(what + ".landuseBlend", Num(e, "landuseBlend"), c.LanduseBlend.Active);
        m.Equal(what + ".treeDensity", Num(e, "treeDensity"), c.TreeDensity.Active);
        m.Equal(what + ".terrainDetail", Num(e, "terrainDetail"), c.TerrainDetail.Active);
        m.Equal(what + ".landuseReach", Num(e, "landuseReach"), c.LanduseReach.Active);
        m.Equal(what + ".visibleZoom", Num(e, "visibleZoom"), c.VisibleZoom.Active);
        m.Equal(what + ".landuseReveal", Num(e, "landuseReveal"), c.LanduseReveal.Active);
        m.Equal(what + ".triangleBudget", Num(e, "triangleBudget"), c.TriangleBudget.Active);
        m.Equal(what + ".farTileTextures", e.GetProperty("farTileTextures").GetBoolean(), c.FarTileTextures.Active);
        m.Equal(what + ".buildings", e.GetProperty("buildings").GetBoolean(), c.Buildings.Active);
        m.Equal(what + ".roads", S(e, "roads"), SettingsCodec.Name(c.Roads.Active));
        m.Equal(what + ".renderScale", Num(e, "renderScale"), c.RenderScale.Active);
        m.Equal(what + ".supersampling", e.GetProperty("supersampling").GetBoolean(), c.Supersampling.Active);
        m.Equal(what + ".daytime", Num(e, "daytime"), c.Daytime.Active);
        CompareAdjust(m, what + ".colourAdjust", e.GetProperty("colourAdjust"), c.ColourAdjust.Active);
    }

    private sealed class RecordingDevices : ISettingsDevices
    {
        public readonly List<string> Calls = new();
        public void SetMasterVolume(double volume) => Calls.Add($"volume,{JsText.NumberToString(volume)}");
        public void SetKeyboardLayout(KeyboardControlLayoutId layout) => Calls.Add($"keyboardLayout,{(int)layout}");
        public void SetKeyboardPitchStickMode(KeyboardPitchStickMode mode) => Calls.Add($"pitchStickMode,{(int)mode}");
    }

    private static string Row(JsonElement r) =>
        string.Join(",", r.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? S(x) : JsText.NumberToString(Num(x))));

    [Fact]
    public void DialogActionsChangeSaveAndDrive()
    {
        var m = new Mismatches();
        JsonElement c = Fx.GetProperty("actions");
        var store = new MemoryKeyValueStore();
        var storage = new SettingsStorage(store);
        var config = ConfigService.FromSettings(storage.Load());
        CompareSnapshot(m, "initial", c.GetProperty("initial"), config);
        SettingsActions.PersistSettingChanges(config, storage);
        var devices = new RecordingDevices();
        var actions = new SettingsActions(config, devices, storage);
        int i = 0;
        foreach (JsonElement step in c.GetProperty("steps").EnumerateArray())
        {
            string name = S(step, "action");
            JsonElement[] args = step.GetProperty("args").EnumerateArray().ToArray();
            string what = $"[{i++}] {name}({string.Join(", ", args.Select(a => a.GetRawText()))})";
            devices.Calls.Clear();
            double? returned = null;
            switch (name)
            {
                case "setTerrainDetail": actions.SetTerrainDetail(Num(args[0])); break;
                case "setTerrainColour": actions.SetTerrainColour(Enum.Parse<TerrainColours>(S(args[0]))); break;
                case "setTerrainShading": actions.SetTerrainShading(Enum.Parse<TerrainShading>(S(args[0]))); break;
                case "setLanduseReach": actions.SetLanduseReach(Num(args[0])); break;
                case "setVisibleZoom": actions.SetVisibleZoom(Num(args[0])); break;
                case "setLanduseReveal": actions.SetLanduseReveal(Num(args[0])); break;
                case "setFarTileTextures": actions.SetFarTileTextures(args[0].GetBoolean()); break;
                case "setBuildings": actions.SetBuildings(args[0].GetBoolean()); break;
                case "setRoads": SettingsCodec.TryParse(S(args[0]), out RoadsMode roads); actions.SetRoads(roads); break;
                case "setRenderScale": actions.SetRenderScale(Num(args[0])); break;
                case "setSupersampling": actions.SetSupersampling(args[0].GetBoolean()); break;
                case "setTriangleBudget": actions.SetTriangleBudget(Num(args[0])); break;
                case "setLanduseBlend": returned = actions.SetLanduseBlend(Num(args[0])); break;
                case "setTreeDensity": returned = actions.SetTreeDensity(Num(args[0])); break;
                case "setColourTweak":
                    {
                        ColourChannelOption channel = SettingsContent.ColourChannelOptions.First(o => ColourAdjust.Key(o.Channel) == S(args[1]));
                        actions.SetColourTweak(config.ColourAdjust.Active, Group(S(args[0])), channel, Num(args[2]));
                        break;
                    }
                case "resetColourAdjust": actions.ResetColourAdjust(); break;
                case "setDaytime": actions.SetDaytime(Num(args[0])); break;
                case "setFlightModel": actions.SetFlightModel(S(args[0])); break;
                case "setAiPilotModel": actions.SetAiPilotModel(Enum.Parse<AiPilotModels>(S(args[0]))); break;
                case "setUnitSystem": actions.SetUnitSystem(Enum.Parse<UnitSystems>(S(args[0]))); break;
                case "setVolume": returned = actions.SetVolume(Num(args[0])); break;
                case "setKeyboardLayout": actions.SetKeyboardLayout((KeyboardControlLayoutId)args[0].GetInt32()); break;
                case "setPitchStickMode": actions.SetPitchStickMode((KeyboardPitchStickMode)args[0].GetInt32()); break;
                default: m.Fail("unknown action " + name); continue;
            }
            JsonElement ret = step.GetProperty("returned");
            m.Equal(what + " returned", ret.ValueKind == JsonValueKind.Null ? "null" : JsText.NumberToString(Num(ret)),
                returned.HasValue ? JsText.NumberToString(returned.Value) : "null");
            m.Equal(what + " devices", string.Join(" | ", step.GetProperty("devices").EnumerateArray().Select(Row)), string.Join(" | ", devices.Calls));
            m.Equal(what + " stored", S(step, "stored"), store.GetItem(SettingsStorage.StorageKey));
            CompareSnapshot(m, what, step.GetProperty("config"), config);
        }
        m.AssertNone();
    }

    [Fact]
    public void BootBuildsTheConfigFromStoredSettings()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("bootFromSettings").EnumerateArray())
        {
            string raw = S(c, "raw");
            CompareSnapshot(m, raw ?? "(absent)", c.GetProperty("config"), ConfigService.FromSettings(StorageWith(raw).Load()));
        }
        m.AssertNone();
    }

    // ---- Dialog content ----

    private static void Flatten(JsonElement e, string prefix, Dictionary<string, string> into)
    {
        foreach (JsonProperty p in e.EnumerateObject())
        {
            string path = prefix.Length == 0 ? p.Name : prefix + "." + p.Name;
            if (p.Value.ValueKind == JsonValueKind.Object) Flatten(p.Value, path, into);
            else into[path] = S(p.Value);
        }
    }

    private static void CompareOptions(Mismatches m, string what, JsonElement expected, IReadOnlyList<SettingsOption> actual)
    {
        var e = expected.EnumerateArray().Select(o =>
        {
            JsonElement v = o.GetProperty("value");
            string value = v.ValueKind == JsonValueKind.String ? S(v) : JsText.NumberToString(Num(v));
            return $"{value}={S(o, "label")}";
        });
        m.Equal(what, string.Join(" | ", e), string.Join(" | ", actual.Select(o => $"{o.Value}={o.Label}")));
    }

    private static string Help(IEnumerable<HelpEntry> entries) =>
        string.Join(" | ", entries.Select(h => string.Join("+", h.Keys) + "=" + h.Action));

    private static string Help(JsonElement entries) =>
        string.Join(" | ", entries.EnumerateArray().Select(h =>
            string.Join("+", h.GetProperty("keys").EnumerateArray().Select(S)) + "=" + S(h, "action")));

    [Fact]
    public void DialogTextOptionsAndHelp()
    {
        var m = new Mismatches();
        JsonElement d = Fx.GetProperty("dialog");
        m.Equal("tabs", string.Join(",", d.GetProperty("tabs").EnumerateArray().Select(S)), string.Join(",", SettingsContent.Tabs));

        var text = new Dictionary<string, string>();
        Flatten(d.GetProperty("text"), "", text);
        m.Equal("text keys", string.Join(",", text.Keys.OrderBy(k => k, StringComparer.Ordinal)),
            string.Join(",", SettingsContent.Text.Keys.OrderBy(k => k, StringComparer.Ordinal)));
        foreach (var (key, value) in text)
        {
            m.Equal("text " + key, value, SettingsContent.Text.TryGetValue(key, out string v) ? v : null);
        }

        foreach (JsonProperty p in d.GetProperty("sliders").EnumerateObject())
        {
            SliderRange r = SettingsContent.Sliders[p.Name];
            m.Equal(p.Name + ".min", Num(p.Value, "min"), r.Min);
            m.Equal(p.Name + ".max", Num(p.Value, "max"), r.Max);
            m.Equal(p.Name + ".step", Num(p.Value, "step"), r.Step);
        }
        m.Equal("sliders count", d.GetProperty("sliders").EnumerateObject().Count(), SettingsContent.Sliders.Count);
        m.Equal("detailOffKm", Num(d, "detailOffKm"), SettingsContent.DetailOffKm);

        JsonElement o = d.GetProperty("options");
        CompareOptions(m, "terrainColour", o.GetProperty("terrainColour"), SettingsContent.TerrainColourOptions);
        CompareOptions(m, "roads", o.GetProperty("roads"), SettingsContent.RoadsOptions);
        CompareOptions(m, "terrainShading", o.GetProperty("terrainShading"), SettingsContent.TerrainShadingOptions);
        CompareOptions(m, "flightModel", o.GetProperty("flightModel"), SettingsContent.FlightModelOptions);
        CompareOptions(m, "aiPilotModel", o.GetProperty("aiPilotModel"), SettingsContent.AiPilotModelOptions);
        CompareOptions(m, "unitSystem", o.GetProperty("unitSystem"), SettingsContent.UnitSystemOptions);
        CompareOptions(m, "keyboardLayout", o.GetProperty("keyboardLayout"), SettingsContent.KeyboardLayoutOptions);
        CompareOptions(m, "pitchStickMode", o.GetProperty("pitchStickMode"), SettingsContent.PitchStickModeOptions);
        CompareOptions(m, "renderScale", o.GetProperty("renderScale"), SettingsContent.RenderScaleOptions);
        m.Equal("renderScales", string.Join(",", Nums(d, "renderScales")), string.Join(",", RenderScaleSetting.RenderScales));

        m.Equal("colourGroups", string.Join(" | ", d.GetProperty("colourGroups").EnumerateArray().Select(g => $"{S(g, "key")}={S(g, "label")}")),
            string.Join(" | ", SettingsContent.ColourGroupOptions.Select(g => $"{ColourAdjust.Key(g.Group)}={g.Label}")));
        int ci = 0;
        foreach (JsonElement ch in d.GetProperty("colourChannels").EnumerateArray())
        {
            ColourChannelOption a = SettingsContent.ColourChannelOptions[ci++];
            m.Equal("channel key", S(ch, "key"), ColourAdjust.Key(a.Channel));
            m.Equal("channel label", S(ch, "label"), a.Label);
            m.Equal("channel min", Num(ch, "min"), a.Min);
            m.Equal("channel max", Num(ch, "max"), a.Max);
            m.Equal("channel step", Num(ch, "step"), a.Step);
            m.Equal("channel scale", Num(ch, "scale"), a.Scale);
            m.Equal("channel unit", S(ch, "unit"), a.Unit);
        }
        m.Equal("channels", ci, SettingsContent.ColourChannelOptions.Count);

        m.Equal("spawnActions", string.Join(" | ", d.GetProperty("spawnActions").EnumerateArray().Select(a =>
                $"{S(a, "mode")},{S(a, "label")},{S(a, "key")},{S(a, "button")}")),
            string.Join(" | ", SettingsContent.SpawnActions.Select(a => $"{SettingsCodec.Name(a.Mode)},{a.Label},{a.Key},{a.ButtonLabel}")));

        JsonElement h = d.GetProperty("help");
        m.Equal("systems", Help(h.GetProperty("systems")), Help(SettingsContent.SystemsHelp));
        m.Equal("spawn", Help(h.GetProperty("spawn")), Help(SettingsContent.SpawnHelp));
        m.Equal("views", Help(h.GetProperty("views")), Help(SettingsContent.ViewsHelp));
        foreach (JsonElement f in h.GetProperty("flight").EnumerateArray())
        {
            int layout = f.GetProperty("layout").GetInt32();
            m.Equal($"flight {layout}", Help(f.GetProperty("entries")), Help(SettingsContent.FlightHelp((KeyboardControlLayoutId)layout)));
        }
        foreach (JsonElement k in h.GetProperty("controlKeys").EnumerateArray())
        {
            m.Equal("key " + S(k[0]), S(k[1]), SettingsContent.FormatControlKey(S(k[0])));
        }
        foreach (JsonElement k in h.GetProperty("joystickNames").EnumerateArray())
        {
            m.Equal("joystick " + S(k[0]), S(k[1]), SettingsContent.JoystickName(S(k[0])));
        }
        foreach (JsonElement j in h.GetProperty("joystick").EnumerateArray())
        {
            int n = j.GetProperty("axisCount").GetInt32();
            m.Equal($"joystick axes {n}", Help(j.GetProperty("axes")), Help(SettingsContent.JoystickAxes(n)));
            m.Equal($"joystick name {n}", S(j, "name"), SettingsContent.JoystickName("Stick (Vendor: 1)"));
        }
        m.AssertNone();
    }

    [Fact]
    public void AboutTabDataSources()
    {
        var m = new Mismatches();
        JsonElement d = Fx.GetProperty("dialog");
        JsonElement[] groups = d.GetProperty("dataSources").EnumerateArray().ToArray();
        m.Equal("groups", groups.Length, SettingsContent.DataSources.Count);
        for (int g = 0; g < Math.Min(groups.Length, SettingsContent.DataSources.Count); g++)
        {
            DataSourceGroup a = SettingsContent.DataSources[g];
            m.Equal($"[{g}].title", S(groups[g], "title"), a.Title);
            m.Equal($"[{g}].feeds", S(groups[g], "feeds"), a.Feeds);
            JsonElement[] sources = groups[g].GetProperty("sources").EnumerateArray().ToArray();
            m.Equal($"[{g}].sources", sources.Length, a.Sources.Count);
            for (int s = 0; s < Math.Min(sources.Length, a.Sources.Count); s++)
            {
                DataSource x = a.Sources[s];
                string w = $"[{g}][{s}]";
                m.Equal(w + ".name", S(sources[s], "name"), x.Name);
                m.Equal(w + ".scope", S(sources[s], "scope"), x.Scope);
                m.Equal(w + ".credit", S(sources[s], "credit"), x.Credit);
                m.Equal(w + ".creditUrl", S(sources[s], "creditUrl"), x.CreditUrl);
                m.Equal(w + ".licence", S(sources[s], "licence"), x.Licence);
                m.Equal(w + ".licenceUrl", S(sources[s], "licenceUrl"), x.LicenceUrl);
            }
        }
        var urls = d.GetProperty("licenceUrls").EnumerateObject().Select(p => $"{p.Name}={S(p.Value)}");
        m.Equal("licenceUrls", string.Join(" | ", urls), string.Join(" | ", SettingsContent.LicenceUrls.Select(p => $"{p.Key}={p.Value}")));
        m.AssertNone();
    }

    [Fact]
    public void SliderReadouts()
    {
        var m = new Mismatches();
        JsonElement r = Fx.GetProperty("dialog").GetProperty("readouts");
        foreach (JsonElement row in r.GetProperty("terrainDetail").EnumerateArray())
        {
            double v = Num(row[0]);
            m.Equal($"detailKm {v}", Num(row[1]), SettingsContent.TerrainDetailToKm(v));
            m.Equal($"detailLabel {v}", S(row[2]), SettingsContent.TerrainDetailLabel(v));
        }
        foreach (JsonElement row in r.GetProperty("terrainDetailFromKm").EnumerateArray())
        {
            m.Equal($"fromKm {Num(row[0])}", Num(row[1]), SettingsContent.TerrainDetailFromKm(Num(row[0])));
        }
        void Labels(string key, Func<double, string> f)
        {
            foreach (JsonElement row in r.GetProperty(key).EnumerateArray()) m.Equal($"{key} {Num(row[0])}", S(row[1]), f(Num(row[0])));
        }
        Labels("landuseReach", SettingsContent.LanduseReachLabel);
        Labels("visibleZoom", SettingsContent.VisibleZoomLabel);
        Labels("landuseReveal", SettingsContent.LanduseRevealLabel);
        Labels("triangleBudget", SettingsContent.TriangleBudgetLabel);
        Labels("percent", SettingsContent.PercentLabel);
        Labels("multiplier", SettingsContent.MultiplierLabel);
        Labels("daytime", SettingsContent.DaytimeLabel);
        ColourAdjust adjust = ColourAdjust.Clamp(J(Fx.GetProperty("dialog").GetProperty("colourAdjustForReadouts")));
        foreach (JsonElement row in r.GetProperty("colour").EnumerateArray())
        {
            ColourAdjustGroup g = Group(S(row[0]));
            ColourChannelOption c = SettingsContent.ColourChannelOptions.First(o => ColourAdjust.Key(o.Channel) == S(row[1]));
            m.Equal($"colour {S(row[0])}.{S(row[1])}", Num(row[2]), SettingsContent.ColourSliderValue(adjust, g, c));
            m.Equal($"colour label {S(row[0])}.{S(row[1])}", S(row[3]), SettingsContent.ColourSliderLabel(adjust, g, c));
        }
        m.AssertNone();
    }

    private static List<TerrainArea> Areas(JsonElement e) => e.EnumerateArray().Select(a =>
        new TerrainArea(S(a, "name"), Num(a, "west"), Num(a, "south"), Num(a, "east"), Num(a, "north"))).ToList();

    [Fact]
    public void AreaPicker()
    {
        var m = new Mismatches();
        foreach (JsonElement c in Fx.GetProperty("dialog").GetProperty("areaOptions").EnumerateArray())
        {
            JsonElement home = c.GetProperty("home");
            m.Equal("home lat", Num(home, "lat"), SettingsContent.PlayOriginLat);
            m.Equal("home lon", Num(home, "lon"), SettingsContent.PlayOriginLon);
            var (options, selected) = SettingsContent.AreaOptions(Areas(c.GetProperty("areas")), Num(home, "lat"), Num(home, "lon"), S(c, "saved"));
            string what = $"saved {S(c, "saved")} of {c.GetProperty("areas").GetArrayLength()}";
            m.Equal(what + " selected", S(c, "selected"), selected);
            CompareOptions(m, what + " options", c.GetProperty("options"), options);
        }
        m.AssertNone();
    }

    private static SettingsDialogModel DialogModel(SettingsStorage storage = null, SpawnPanel spawn = null)
    {
        storage ??= new SettingsStorage(new MemoryKeyValueStore());
        return new SettingsDialogModel(new SettingsDialogHost
        {
            Config = ConfigService.FromSettings(storage.Load()),
            Storage = storage,
            Devices = new RecordingDevices(),
            Spawn = spawn,
        });
    }

    private static string KindName(SettingsControlKind k) => k.ToString().ToLowerInvariant();

    [Fact]
    public void DialogLayoutMatchesTheTemplate()
    {
        var m = new Mismatches();
        SettingsDialogModel model = DialogModel();
        JsonElement[] tabs = Fx.GetProperty("dialog").GetProperty("layout").EnumerateArray().ToArray();
        m.Equal("tab count", tabs.Length, model.Tabs.Count);
        for (int t = 0; t < Math.Min(tabs.Length, model.Tabs.Count); t++)
        {
            SettingsTabModel tab = model.Tabs[t];
            m.Equal($"tab[{t}]", S(tabs[t], "tab"), tab.Name);
            JsonElement[] sections = tabs[t].GetProperty("sections").EnumerateArray().ToArray();
            m.Equal($"{tab.Name} sections", string.Join(",", sections.Select(s => S(s, "id"))), string.Join(",", tab.Sections.Select(s => s.Id)));
            foreach (JsonElement es in sections)
            {
                SettingsSection s = tab.Sections.FirstOrDefault(x => x.Id == S(es, "id"));
                if (s == null) continue;
                string w = $"{tab.Name}/{s.Id}";
                m.Equal(w + ".title", S(es, "title"), s.Title);
                m.Equal(w + ".help", S(es, "help"), s.Help);
                m.Equal(w + ".note", Opt(es, "note") is JsonElement n ? S(n) : null, s.Note);
                JsonElement[] controls = es.GetProperty("controls").EnumerateArray().ToArray();
                m.Equal(w + " controls", string.Join(",", controls.Select(c => $"{S(c, "id")}:{S(c, "kind")}")),
                    string.Join(",", s.Controls.Select(c => $"{c.Id}:{KindName(c.Kind)}")));
                foreach (JsonElement ec in controls)
                {
                    SettingsControl c = s.Controls.FirstOrDefault(x => x.Id == S(ec, "id"));
                    if (c == null) continue;
                    string wc = $"{w}/{c.Id}";
                    if (Opt(ec, "label") is JsonElement label) m.Equal(wc + ".label", S(label), c.Label);
                    switch (c)
                    {
                        case SliderControl sl:
                            m.Equal(wc + ".min", Num(ec, "min"), sl.Range.Min);
                            m.Equal(wc + ".max", Num(ec, "max"), sl.Range.Max);
                            m.Equal(wc + ".step", Num(ec, "step"), sl.Range.Step);
                            m.Equal(wc + ".minLabel", Opt(ec, "minLabel") is JsonElement lo ? S(lo) : null, sl.MinLabel);
                            m.Equal(wc + ".maxLabel", Opt(ec, "maxLabel") is JsonElement hi ? S(hi) : null, sl.MaxLabel);
                            break;
                        case ChoiceControl ch when Opt(ec, "options") is JsonElement opts:
                            m.Equal(wc + ".options", string.Join(" | ", opts.EnumerateArray().Select(Row)),
                                string.Join(" | ", ch.Options().Select(o => $"{o.Value},{o.Label}")));
                            m.Equal(wc + ".columns", Opt(ec, "columns") is JsonElement cols ? cols.GetInt32() : 0, ch.Columns);
                            break;
                        case ButtonControl b when Opt(ec, "key") is JsonElement key:
                            m.Equal(wc + ".key", S(key), b.Key);
                            m.Equal(wc + ".mode", S(ec, "mode"), b.Mode.HasValue ? SettingsCodec.Name(b.Mode.Value) : null);
                            break;
                        case SearchControl sc:
                            m.Equal(wc + ".placeholder", S(ec, "placeholder"), sc.Placeholder);
                            m.Equal(wc + ".hint", S(ec, "hint"), sc.Hint);
                            break;
                    }
                }
            }
        }
        m.AssertNone();
    }

    // ---- Spawn menu ----

    private static FlyableAircraftDef Def(JsonElement d) => new()
    {
        Id = S(d, "id"), Name = S(d, "name"), CanonicalName = S(d, "canonicalName"), ModelName = S(d, "modelName"),
        LiveryName = S(d, "liveryName"),
    };

    [Fact]
    public void SpawnMenuListsAndSearch()
    {
        var m = new Mismatches();
        JsonElement sp = Fx.GetProperty("spawn");
        List<AircraftModelGroup> groups = SpawnMenu.GroupAircraftByModel(sp.GetProperty("defs").EnumerateArray().Select(Def).ToList());
        m.Equal("groups", string.Join(" | ", sp.GetProperty("groups").EnumerateArray().Select(g =>
                $"{S(g, "key")}/{S(g, "label")}/{string.Join(",", g.GetProperty("variants").EnumerateArray().Select(S))}")),
            string.Join(" | ", groups.Select(g => $"{g.Key}/{g.Label}/{string.Join(",", g.Variants.Select(v => v.Id))}")));
        foreach (JsonElement c in sp.GetProperty("menus").EnumerateArray())
        {
            int mi = c.GetProperty("modelIndex").GetInt32(), li = c.GetProperty("liveryIndex").GetInt32();
            var (aircraft, ai, liveries, l) = SpawnMenu.AircraftMenu(groups, mi, li);
            JsonElement e = c.GetProperty("menu");
            string w = $"menu({mi},{li})";
            m.Equal(w + ".aircraft", string.Join(",", e.GetProperty("aircraft").EnumerateArray().Select(S)), string.Join(",", aircraft));
            m.Equal(w + ".aircraftIndex", e.GetProperty("aircraftIndex").GetInt32(), ai);
            m.Equal(w + ".liveries", string.Join(",", e.GetProperty("liveries").EnumerateArray().Select(S)), string.Join(",", liveries));
            m.Equal(w + ".liveryIndex", e.GetProperty("liveryIndex").GetInt32(), l);
        }
        var choices = sp.GetProperty("airfieldChoices").EnumerateArray().Select(c => new AirfieldChoice
        {
            Icao = S(c, "icao"), Name = S(c, "name"), Ref = S(c, "ref"), LengthM = Num(c, "lengthM"),
        }).ToList();
        foreach (JsonElement c in sp.GetProperty("airfields").EnumerateArray())
        {
            string key = S(c, "selected");
            var (labels, index) = SpawnMenu.AirfieldMenu(choices, key);
            JsonElement e = c.GetProperty("menu");
            m.Equal($"airfields({key})", string.Join(" | ", e.GetProperty("airfields").EnumerateArray().Select(S)), string.Join(" | ", labels));
            m.Equal($"airfieldIndex({key})", e.GetProperty("airfieldIndex").GetInt32(), index);
        }
        JsonElement search = sp.GetProperty("search");
        List<TerrainArea> areas = Areas(search.GetProperty("areas"));
        var entries = search.GetProperty("entries").EnumerateArray().Select(e => new AirfieldEntry
        {
            Icao = S(e, "icao"), Iata = S(e, "iata"), Name = S(e, "name"), Area = S(e, "area"),
            Lat = Num(e, "lat"), Lon = Num(e, "lon"), LengthM = Num(e, "lengthM"),
        }).ToList();
        foreach (JsonElement c in search.GetProperty("results").EnumerateArray())
        {
            string q = S(c, "query"), current = S(c, "currentArea");
            List<SpawnDestination> got = SpawnMenu.QuickSearch(q, entries, areas, current);
            string Dest(SpawnDestination d) =>
                $"{d.Kind.ToString().ToLowerInvariant()};{d.Label};{d.Detail};{JsText.NumberToString(d.Lat)};{JsText.NumberToString(d.Lon)};{d.Area};{d.AirfieldKey}";
            string Exp(JsonElement d) =>
                $"{S(d, "kind")};{S(d, "label")};{S(d, "detail")};{JsText.NumberToString(Num(d, "lat"))};{JsText.NumberToString(Num(d, "lon"))};"
                + $"{(Opt(d, "area") is JsonElement a ? S(a) : null)};{(Opt(d, "airfieldKey") is JsonElement k ? S(k) : null)}";
            m.Equal($"search '{q}' in {current}", string.Join(" | ", c.GetProperty("results").EnumerateArray().Select(Exp)),
                string.Join(" | ", got.Select(Dest)));
        }
        m.AssertNone();
    }

    // ---- Boot progress ----

    [Fact]
    public void BootStagesAndStreamingBar()
    {
        var m = new Mismatches();
        JsonElement b = Fx.GetProperty("boot");
        var stages = b.GetProperty("stages").EnumerateObject().Select(p => $"{p.Name}={Num(p.Value, "percent")}:{S(p.Value, "label")}");
        m.Equal("stages", string.Join(" | ", stages), string.Join(" | ", BootProgress.Stages.Select(p => $"{p.Key}={p.Value.Percent}:{p.Value.Label}")));
        m.Equal("range.min", Num(b.GetProperty("terrainRange"), "min"), BootProgress.TerrainRangeMin);
        m.Equal("range.max", Num(b.GetProperty("terrainRange"), "max"), BootProgress.TerrainRangeMax);
        m.Equal("respawn", $"{Num(b.GetProperty("respawn"), "percent")}:{S(b.GetProperty("respawn"), "label")}",
            $"{BootProgress.Respawn.Percent}:{BootProgress.Respawn.Label}");
        JsonElement st = b.GetProperty("stream");
        m.Equal("settleMs", Num(st, "settleMs"), BootProgress.StreamSettleMs);
        m.Equal("holdMaxMs", Num(st, "holdMaxMs"), BootProgress.StreamHoldMaxMs);
        m.Equal("countdownFrom", Num(st, "countdownFrom"), BootProgress.StreamCountdownFrom);
        m.Equal("goShownMs", Num(st, "goShownMs"), BootProgress.StreamGoShownMs);
        m.Equal("barRatePerS", Num(st, "barRatePerS"), BootProgress.StreamBarRatePerS);
        m.Equal("countdown", string.Join(",", b.GetProperty("countdown").EnumerateArray().Select(S)), string.Join(",", BootProgress.CountdownTexts()));
        foreach (JsonElement t in b.GetProperty("terrain").EnumerateArray())
        {
            BootStage s = BootProgress.TerrainBootStage(Num(t, "meshed"), Num(t, "total"), BootProgress.TerrainRangeMin, BootProgress.TerrainRangeMax);
            m.Equal($"terrain {t.GetRawText()} percent", Num(t, "percent"), s.Percent);
            m.Equal($"terrain {t.GetRawText()} label", S(t, "label"), s.Label);
        }
        double? N(JsonElement e, string p) => e.GetProperty(p).ValueKind == JsonValueKind.Null ? null : Num(e, p);
        foreach (JsonElement t in b.GetProperty("bake").EnumerateArray())
        {
            BootStage s = BootProgress.BootstrapBakeStage(S(t, "name"), S(t, "step"), N(t, "stepIndex"), N(t, "stepCount"), N(t, "percent"));
            m.Equal($"bake {t.GetRawText()} percent", Num(t, "percent"), s.Percent);
            m.Equal($"bake {t.GetRawText()} label", S(t, "label"), s.Label);
        }
        BootStage failed = BootProgress.BootFailedStage("Unsupported terrain manifest scheme: x");
        m.Equal("failed", $"{Num(b.GetProperty("failed"), "percent")}:{S(b.GetProperty("failed"), "label")}", $"{failed.Percent}:{failed.Label}");
        foreach (JsonElement row in b.GetProperty("streamingLabels").EnumerateArray())
        {
            m.Equal($"streaming {Num(row[0])}", S(row[1]), BootProgress.StreamingLabel(Num(row[0])));
        }
        foreach (JsonElement row in b.GetProperty("clamp").EnumerateArray())
        {
            m.Equal($"clamp {Num(row[0])}", Num(row[1]), BootProgress.ClampBootPercent(Num(row[0])));
        }
        foreach (JsonElement trace in b.GetProperty("traces").EnumerateArray())
        {
            var bar = new StreamBar(0);
            foreach (JsonElement f in trace.GetProperty("frames").EnumerateArray())
            {
                string w = $"{S(trace, "name")} t={Num(f[0])}";
                bool done = bar.Tick(Num(f[0]), Num(f[1]));
                m.Equal(w + " shown", Num(f[2]), bar.Shown);
                m.Equal(w + " done", f[3].GetBoolean(), done);
                m.Equal(w + " label", S(f[5]), BootProgress.StreamingLabel(bar.Shown));
            }
        }
        m.AssertNone();
    }
}
