using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>
/// The parts of the settings port the golden fixture cannot drive: the JSON
/// file store, the dialog model's live rules and search, the spawn panel and
/// aircraft choice, and the JS JSON writer.
/// </summary>
public class SettingsModelTests
{
    private sealed class Devices : ISettingsDevices
    {
        public readonly List<string> Calls = new();
        public void SetMasterVolume(double volume) => Calls.Add($"volume {JsText.NumberToString(volume)}");
        public void SetKeyboardLayout(KeyboardControlLayoutId layout) => Calls.Add($"layout {layout}");
        public void SetKeyboardPitchStickMode(KeyboardPitchStickMode mode) => Calls.Add($"pitch {mode}");
    }

    private static string TempFile() => Path.Combine(Path.GetTempPath(), $"retro-settings-{Guid.NewGuid():N}", "settings.json");

    [Fact]
    public void JsonFileStoreKeepsTheStoredStringExactly()
    {
        string path = TempFile();
        try
        {
            var store = new JsonFileKeyValueStore(path);
            var storage = new SettingsStorage(store);
            storage.Update(s =>
            {
                s.Volume = 0.25;
                s.TerrainArea = "Grüße \"q\" \\ \n \u0001 \ud800";
                s.TerrainDetailDistanceM = null;
            });
            string stored = store.GetItem(SettingsStorage.StorageKey);
            store.SetItem("plain", "not json");
            store.SetItem("jsonString", "\"looks like json\"");
            store.SetItem("spaced", "{ \"a\": 1 }");

            string text = File.ReadAllText(path);
            // The settings object is embedded as JSON, not as an escaped string.
            Assert.Contains("\"retroflightsim.settings\": {\"techProfile\":\"HD\"", text);
            Assert.Contains("\"spaced\": \"{ \\\"a\\\": 1 }\"", text);

            var reread = new JsonFileKeyValueStore(path);
            Assert.Equal(stored, reread.GetItem(SettingsStorage.StorageKey));
            Assert.Equal("not json", reread.GetItem("plain"));
            Assert.Equal("\"looks like json\"", reread.GetItem("jsonString"));
            Assert.Equal("{ \"a\": 1 }", reread.GetItem("spaced"));
            Assert.Null(reread.GetItem("missing"));
            AppSettings loaded = new SettingsStorage(reread).Load();
            Assert.Equal(0.25, loaded.Volume);
            Assert.Null(loaded.TerrainDetailDistanceM);
            Assert.Equal("Grüße \"q\" \\ \n \u0001 \ud800", loaded.TerrainArea);

            reread.RemoveItem("plain");
            Assert.Null(new JsonFileKeyValueStore(path).GetItem("plain"));
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(path)!, true);
        }
    }

    [Fact]
    public void JsonFileStoreTreatsAnUnreadableFileAsEmpty()
    {
        string path = TempFile();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, "{ not json");
            var storage = new SettingsStorage(new JsonFileKeyValueStore(path));
            Assert.Equal(SettingsStorage.Serialize(SettingsStorage.Defaults()), SettingsStorage.Serialize(storage.Load()));
            storage.Update(s => s.Buildings = false);
            Assert.False(new SettingsStorage(new JsonFileKeyValueStore(path)).Load().Buildings);
            // Hand-edited values that are not strings read back as their JSON text.
            File.WriteAllText(path, "{\"n\": 1.50, \"b\": true, \"o\": {\"x\": [1, 2]}}");
            var store = new JsonFileKeyValueStore(path);
            Assert.Equal("1.5", store.GetItem("n"));
            Assert.Equal("true", store.GetItem("b"));
            Assert.Equal("{\"x\":[1,2]}", store.GetItem("o"));
        }
        finally
        {
            Directory.Delete(Path.GetDirectoryName(path)!, true);
        }
    }

    [Fact]
    public void JsonReaderIsAsStrictAsJsonParse()
    {
        foreach (string bad in new[] { "01", "1.", ".5", "+1", "0x1", "[1,]", "{\"a\":1,}", "\"a\u0001\"", "\"\\u12\"", "\"\\x41\"", "-", "1e", "NaN" })
        {
            Assert.Throws<FormatException>(() => JsonReader.Parse(bad));
        }
        Assert.Equal(double.PositiveInfinity, JsonReader.Parse("1e400").AsNumber);
        Assert.Equal(double.NegativeInfinity, JsonReader.Parse("-1e400").AsNumber);
        Assert.Equal(0.5, JsonReader.Parse(" 5e-1 ").AsNumber);
        Assert.Equal("\u00e9", JsonReader.Parse("\"\\u00E9\"").AsString);
    }

    [Fact]
    public void JsJsonWriterEscapesAsJsonStringify()
    {
        Assert.Equal("\"a\\\"b\\\\c\\n\\t\\b\\f\\r\\u0001\\u001f \u00e9 \ud83d\ude00 \\ud800 \\udc00\"",
            JsJsonWriter.Stringify(JsonReader.Parse("\"a\\\"b\\\\c\\n\\t\\b\\f\\r\\u0001\\u001f \u00e9 \ud83d\ude00 \\ud800 \\udc00\"")));
        Assert.Equal("{\"a\":[1,1e+21,1e-7,null,true],\"b\":{}}", JsJsonWriter.Stringify(JsonReader.Parse("{\"a\": [1.0, 1e21, 0.0000001, null, true], \"b\": {}}")));
        Assert.Equal("null", new JsJsonWriter().Number(double.NaN).ToString());
    }

    [Fact]
    public void ToFixedRoundsTiesUpLikeJs()
    {
        Assert.Equal("1.3", JsText.ToFixed(1.25, 1));
        Assert.Equal("1.1", JsText.ToFixed(1.05, 1)); // 1.05 is just above the tie
        Assert.Equal("2.35", JsText.ToFixed(2.345, 2));
        Assert.Equal("-0.00", JsText.ToFixed(-0.0001, 2));
        Assert.Equal("0.00", JsText.ToFixed(-0.0, 2));
        Assert.Equal("3", JsText.ToFixed(2.5, 0));
        Assert.Equal("-3", JsText.ToFixed(-2.5, 0));
        Assert.Equal("0.000010", JsText.ToFixed(0.00001, 6));
        Assert.Equal("123456789012345683968.00", JsText.ToFixed(123456789012345680000.0, 2));
    }

    private static (SettingsDialogModel Model, SettingsStorage Storage, Devices Devices) Dialog(
        SpawnPanel spawn = null, IReadOnlyList<TerrainArea> areas = null, bool terrainImport = false,
        Func<JoystickInfo> joystick = null, Action reload = null)
    {
        var storage = new SettingsStorage(new MemoryKeyValueStore());
        var devices = new Devices();
        var model = new SettingsDialogModel(new SettingsDialogHost
        {
            Config = ConfigService.FromSettings(storage.Load()),
            Storage = storage,
            Devices = devices,
            Spawn = spawn,
            Areas = areas,
            TerrainImport = terrainImport,
            Joystick = joystick ?? (() => null),
            ReloadIntoArea = reload,
        });
        return (model, storage, devices);
    }

    private static SettingsControl Control(SettingsDialogModel model, SettingsTab tab, string id) =>
        model.Tabs[(int)tab].Sections.SelectMany(s => s.Controls).First(c => c.Id == id);

    private static SettingsSection Section(SettingsDialogModel model, SettingsTab tab, string id) =>
        model.Tabs[(int)tab].Sections.First(s => s.Id == id);

    [Fact]
    public void DialogControlsDriveTheSettingsAndShowReadouts()
    {
        var (model, storage, devices) = Dialog();
        int changed = 0;
        model.Changed += () => changed++;

        var detail = (SliderControl)Control(model, SettingsTab.Graphics, "terrainDetail");
        Assert.Equal("12 km", detail.Readout());
        detail.Set(42);
        Assert.Equal("Off", detail.Readout());
        Assert.Equal(42, detail.Value());

        var scale = (ChoiceControl)Control(model, SettingsTab.Graphics, "renderScale");
        var ssaa = (ToggleControl)Control(model, SettingsTab.Graphics, "supersampling");
        Assert.True(ssaa.Enabled());
        scale.Set("0.7");
        Assert.Equal("0.7", scale.Value());
        Assert.False(ssaa.Enabled());
        Assert.Equal(0.7, storage.Load().RenderScale);

        var blend = (SliderControl)Control(model, SettingsTab.Graphics, "landuseBlend");
        blend.Set(37.4);
        Assert.Equal("37%", blend.Readout());
        Assert.Equal(0.37, storage.Load().LanduseBlend);
        Assert.Equal("Sampled", blend.MinLabel);

        var volume = (SliderControl)Control(model, SettingsTab.General, "volume");
        Assert.Equal("70%", volume.Readout());
        volume.Set(42.5);
        Assert.Equal("43%", volume.Readout());
        Assert.Contains("volume 0.43", devices.Calls);

        var layout = (ChoiceControl)Control(model, SettingsTab.General, "keyboardLayout");
        layout.Set("1");
        Assert.Equal("1", layout.Value());
        Assert.Equal(KeyboardControlLayoutId.QWERTZ, storage.Load().KeyboardLayout);
        var keys = (KeysControl)Control(model, SettingsTab.Help, "help.keyboard");
        Assert.Equal(new[] { "Y", "X" }, keys.Entries()[3].Keys);

        var units = (ChoiceControl)Control(model, SettingsTab.General, "units");
        units.Set("IMPERIAL");
        Assert.Equal("IMPERIAL", units.Value());
        Assert.DoesNotContain("IMPERIAL", SettingsStorage.Serialize(storage.Load()));

        var hue = (SliderControl)Control(model, SettingsTab.Colours, "colour.sky.hue");
        hue.Set(47);
        Assert.Equal("47\u00b0", hue.Readout());
        ((ButtonControl)Control(model, SettingsTab.Colours, "colourReset")).Click();
        Assert.Equal("0\u00b0", hue.Readout());
        Assert.True(changed > 5);
    }

    [Fact]
    public void DialogVisibilityRulesAndTabMemory()
    {
        var areas = new[]
        {
            new TerrainArea("gc", -18, 27, -13, 29.5),
            new TerrainArea("DACH", 5.8, 45.8, 17.2, 55.1),
        };
        bool reloaded = false;
        var (model, storage, _) = Dialog(areas: areas, reload: () => reloaded = true);
        Assert.True(Section(model, SettingsTab.World, "area").Visible());
        Assert.False(Section(model, SettingsTab.World, "importTerrain").Visible());
        Assert.False(Section(model, SettingsTab.World, "singleArea").Visible());
        var area = (ChoiceControl)Control(model, SettingsTab.World, "area");
        var fly = (ButtonControl)Control(model, SettingsTab.World, "flyHere");
        Assert.Equal("gc", area.Value());
        Assert.Equal("gc (home)", area.Options()[0].Label);
        Assert.False(fly.Enabled());
        area.Set("DACH");
        Assert.True(fly.Enabled());
        fly.Click();
        Assert.True(reloaded);
        Assert.Equal("DACH", storage.Load().TerrainArea);

        var (single, _, _) = Dialog(areas: areas.Take(1).ToList());
        Assert.False(Section(single, SettingsTab.World, "area").Visible());
        Assert.True(Section(single, SettingsTab.World, "singleArea").Visible());
        var (loading, _, _) = Dialog();
        Assert.False(Section(loading, SettingsTab.World, "singleArea").Visible());

        var joystick = (KeysControl)Control(single, SettingsTab.Help, "help.joystick");
        Assert.Equal("No device detected", joystick.Caption());
        var (withStick, _, _) = Dialog(joystick: () => new JoystickInfo { DeviceId = "Pad (Vendor: 1)", AxisCount = 3 });
        var stick = (KeysControl)Control(withStick, SettingsTab.Help, "help.joystick");
        Assert.Equal("Pad", stick.Caption());
        Assert.Equal(new[] { "Pitch", "Roll", "Throttle" }, stick.Entries().Select(e => e.Action));

        withStick.SelectTab(SettingsTab.About);
        var (reopened, _, _) = Dialog();
        Assert.Equal(SettingsTab.About, reopened.Tab);
        reopened.SelectTab(SettingsTab.Flight);
    }

    [Fact]
    public async Task SpawnPanelSearchAndStartButtons()
    {
        var spawned = new List<SpawnMode>();
        var picked = new List<string>();
        var gone = new List<SpawnDestination>();
        var release = new TaskCompletionSource<List<SpawnDestination>>();
        var panel = new SpawnPanel(_ => { }, _ => { }, picked.Add, spawned.Add, gone.Add, () => { }, () => { },
            placeSearch: (q, areas, current) => release.Task);
        panel.SetSearchIndex(new[]
        {
            new AirfieldEntry { Icao = "GCLP", Iata = "LPA", Name = "Gran Canaria", Area = "gc", LengthM = 3100 },
        }, new[] { new TerrainArea("gc", -18, 27, -13, 29.5) }, "gc");
        panel.SetAirfields(new List<AirfieldChoice>
        {
            new() { Icao = "", Name = "Strip", Ref = "09/27", LengthM = 600.4 },
            new() { Icao = "GCLP", Name = "Gran Canaria", Ref = "03L/21R", LengthM = 3100 },
        }, "GCLP");
        Assert.Equal(1, panel.State.AirfieldIndex);
        Assert.Equal("Strip (09/27, 600 m)", panel.State.Airfields[0]);

        var (model, _, _) = Dialog(spawn: panel);
        var airfield = (ChoiceControl)Control(model, SettingsTab.Flight, "airfield");
        Assert.True(airfield.Visible());
        airfield.Set("0");
        Assert.Equal(new[] { "Strip" }, picked);
        Assert.Equal("0", airfield.Value());

        var start = (ButtonControl)Control(model, SettingsTab.Flight, "spawn.carrierBarricade");
        Assert.Equal("Carrier barricade (8)", start.Label);
        start.Click();
        Assert.Equal(new[] { SpawnMode.CarrierBarricade }, spawned);

        var searchButton = (ButtonControl)Control(model, SettingsTab.Flight, "searchButton");
        Assert.False(searchButton.Enabled());
        model.SetSearchQuery("gclp");
        Assert.Single(model.QuickResults);
        Assert.True(searchButton.Enabled());
        Task search = model.SearchPlaces();
        Assert.Equal(PlaceSearchStatus.Searching, model.PlaceStatus);
        Assert.False(searchButton.Enabled());
        release.SetResult(new List<SpawnDestination>());
        await search;
        Assert.Equal(PlaceSearchStatus.None, model.PlaceStatus);
        Assert.Equal("No places found", SettingsDialogModel.PlaceStatusText(model.PlaceStatus));

        // A slow answer to an old query cannot land on a new one.
        release = new TaskCompletionSource<List<SpawnDestination>>();
        Task stale = model.SearchPlaces();
        model.SetSearchQuery("gran");
        release.SetResult(new List<SpawnDestination> { new() { Label = "late", Area = "gc" } });
        await stale;
        Assert.Equal(PlaceSearchStatus.Idle, model.PlaceStatus);
        Assert.Empty(model.PlaceResults);

        model.GoTo(model.QuickResults[0]);
        Assert.Single(gone);
        Assert.Equal("", model.SearchQuery);
        model.GoTo(new SpawnDestination { Label = "nowhere", Area = null });
        Assert.Single(gone);
    }

    private static FlyableAircraftDef Def(string id, string name, string canonical = null, string model = null, string livery = null) =>
        new() { Id = id, Name = name, CanonicalName = canonical, ModelName = model, LiveryName = livery };

    [Fact]
    public void AircraftChoiceSelectsClampsAndSaves()
    {
        var defs = new List<FlyableAircraftDef>
        {
            Def("f22", "F-22 Raptor"),
            Def("su33-a", "Su-33 (Navy)", "Su-33", "Su-33", "Navy"),
            Def("su33-b", "Su-33 (Akula)", "Su-33", "Su-33", "Akula"),
        };
        var panel = new SpawnPanel(_ => { }, _ => { }, _ => { }, _ => { }, _ => { }, () => { }, () => { });
        var storage = new SettingsStorage(new MemoryKeyValueStore());
        var choice = new AircraftChoice(() => defs, panel, storage);

        choice.SelectById("nope", "f22");
        Assert.Equal("f22", choice.SelectedId);
        Assert.Equal(new[] { "F-22 Raptor", "Su-33" }, panel.State.Aircraft);
        Assert.Equal(0, panel.State.AircraftIndex);

        choice.SelectModel(1, 9);
        Assert.Equal("su33-a", choice.SelectedId); // Akula, Navy: index 9 clamps to the last
        Assert.Equal(new[] { "Akula", "Navy" }, panel.State.Liveries);
        Assert.Equal(1, panel.State.LiveryIndex);
        Assert.Equal("su33-a", storage.Load().AircraftId);

        choice.SelectLivery(0);
        Assert.Equal("su33-b", choice.SelectedId);
        choice.SelectModel(7);
        Assert.Equal("su33-b", choice.SelectedId);
        choice.Persist(SpawnMode.Space);
        Assert.Equal(SpawnMode.Space, storage.Load().SpawnMode);
    }

    [Fact]
    public void BootWiresStoredValuesAndPersistsDaytime()
    {
        var store = new MemoryKeyValueStore();
        store.SetItem(SettingsStorage.StorageKey, "{\"keyboardLayout\": 1, \"volume\": 0.2, \"daytime\": 6, \"terrainDetailDistanceM\": null}");
        var storage = new SettingsStorage(store);
        var devices = new Devices();
        ConfigService config = SettingsActions.Boot(storage, devices, out AppSettings settings);
        Assert.Equal(new[] { "layout QWERTZ", "pitch LAYOUT_DEFAULT", "volume 0.2" }, devices.Calls);
        Assert.Equal(double.PositiveInfinity, config.TerrainDetail.Active);
        Assert.Equal(6, settings.Daytime);
        config.Daytime.SetActive(25);
        Assert.Equal(1, storage.Load().Daytime);
        config.TerrainDetail.SetActive(5000);
        Assert.Equal(5000, storage.Load().TerrainDetailDistanceM);
        config.TerrainDetail.SetActive(double.PositiveInfinity);
        Assert.Null(storage.Load().TerrainDetailDistanceM);
    }
}
