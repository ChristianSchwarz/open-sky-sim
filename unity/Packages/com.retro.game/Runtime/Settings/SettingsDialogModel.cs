using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using Retro.Core;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>What a control is, for the UI to pick a widget.</summary>
    public enum SettingsControlKind
    {
        /// <summary><see cref="SliderControl"/>: a slider with a readout.</summary>
        Slider,
        /// <summary><see cref="ChoiceControl"/> shown as a drop-down.</summary>
        Select,
        /// <summary><see cref="ChoiceControl"/> shown as radio buttons in <see cref="ChoiceControl.Columns"/> columns.</summary>
        Radio,
        /// <summary><see cref="ToggleControl"/>: a switch with its label.</summary>
        Toggle,
        /// <summary><see cref="ButtonControl"/>.</summary>
        Button,
        /// <summary><see cref="ListControl"/>: a single-choice scrolling list (the aircraft).</summary>
        List,
        /// <summary><see cref="SearchControl"/>: the airfield / place search box with its result groups.</summary>
        Search,
        /// <summary><see cref="KeysControl"/>: rows of key caps and what they do.</summary>
        Keys,
        /// <summary><see cref="CreditsControl"/>: one group of the About tab's data sources.</summary>
        Credits,
    }

    /// <summary>One control of a section. Visibility and enablement are live rules.</summary>
    public abstract class SettingsControl
    {
        public string Id = "";
        public SettingsControlKind Kind;
        /// <summary>The label as shown, or null when the control has none of its own.</summary>
        public string Label;
        public Func<bool> Visible = () => true;
        public Func<bool> Enabled = () => true;
    }

    public sealed class SliderControl : SettingsControl
    {
        public SliderRange Range;
        /// <summary>Text at the slider's left and right ends, or null ("Sampled" / "Land type").</summary>
        public string MinLabel;
        public string MaxLabel;
        /// <summary>The thumb position, in slider units.</summary>
        public Func<double> Value;
        /// <summary>The thumb moved to this position (raw, as the input element reports it).</summary>
        public Action<double> Set;
        /// <summary>The text next to the slider ("12 km", "1.50x", "14:00").</summary>
        public Func<string> Readout;
    }

    public sealed class ChoiceControl : SettingsControl
    {
        public Func<IReadOnlyList<SettingsOption>> Options;
        /// <summary>The selected option's value.</summary>
        public Func<string> Value;
        public Action<string> Set;
        /// <summary>Radio columns at full width (one column on narrow screens); 0 for a select.</summary>
        public int Columns;
    }

    public sealed class ToggleControl : SettingsControl
    {
        public Func<bool> Value;
        public Action<bool> Set;
    }

    public sealed class ButtonControl : SettingsControl
    {
        public Action Click;
        /// <summary>The key that does the same in game, for a start button; otherwise null.</summary>
        public string Key;
        /// <summary>The spawn a start button starts; otherwise null.</summary>
        public SpawnMode? Mode;
    }

    public sealed class ListControl : SettingsControl
    {
        public Func<IReadOnlyList<string>> Items;
        public Func<int> Selected;
        public Action<int> Select;
    }

    /// <summary>The search box; its query, results and status live on <see cref="SettingsDialogModel"/>.</summary>
    public sealed class SearchControl : SettingsControl
    {
        public string Placeholder;
        public string Hint;
    }

    public sealed class KeysControl : SettingsControl
    {
        public Func<IReadOnlyList<HelpEntry>> Entries;
        /// <summary>A line above the keys (the joystick's name, or that there is none), or null.</summary>
        public Func<string> Caption = () => null;
    }

    public sealed class CreditsControl : SettingsControl
    {
        public DataSourceGroup Group;
    }

    /// <summary>A titled block of a tab: heading, explanation, an optional small note, then its controls.</summary>
    public sealed class SettingsSection
    {
        public string Id = "";
        /// <summary>The heading, or null for a section without one.</summary>
        public string Title;
        /// <summary>The explanation under the heading, or null.</summary>
        public string Help;
        /// <summary>A smaller line under the help (or, for the spawn keys, after the list), or null.</summary>
        public string Note;
        public Func<bool> Visible = () => true;
        public IReadOnlyList<SettingsControl> Controls = Array.Empty<SettingsControl>();
    }

    public sealed class SettingsTabModel
    {
        public SettingsTab Tab;
        public string Name => Tab.ToString();
        public IReadOnlyList<SettingsSection> Sections = Array.Empty<SettingsSection>();
    }

    /// <summary>The place search's state (settingsDialog.ts placeStatus).</summary>
    public enum PlaceSearchStatus
    {
        Idle,
        Searching,
        Done,
        None,
        Error,
    }

    /// <summary>A connected joystick, as the Help tab lists it.</summary>
    public sealed class JoystickInfo
    {
        /// <summary>The Gamepad id ("Logitech Extreme 3D (Vendor: 046d Product: c215)").</summary>
        public string DeviceId = "";
        public int AxisCount;
    }

    /// <summary>What the dialog edits and reads from the game (settingsDialog.ts SettingsDialogData).</summary>
    public sealed class SettingsDialogHost
    {
        public ConfigService Config;
        public SettingsStorage Storage;
        public ISettingsDevices Devices;
        public SpawnPanel Spawn;
        /// <summary>The keyboard device's current layout and pitch mode.</summary>
        public KeyboardControlLayoutId KeyboardLayout = KeyboardControlLayoutId.ARROWS;
        public KeyboardPitchStickMode PitchStickMode = KeyboardPitchStickMode.LAYOUT_DEFAULT;
        /// <summary>The joystick now, or null when none is connected.</summary>
        public Func<JoystickInfo> Joystick = () => null;
        /// <summary>The terrain manifest's areas; null until it has loaded (or when it failed).</summary>
        public IReadOnlyList<TerrainArea> Areas;
        /// <summary>Whether the World tab offers terrain import (only the dev server can bake).</summary>
        public bool TerrainImport;
        /// <summary>
        /// "Fly here": the area was saved; clear any camera route from the
        /// launch arguments and restart into it (settingsDialog.ts flyToArea).
        /// </summary>
        public Action ReloadIntoArea;
    }

    /// <summary>
    /// The settings dialog (settingsDialog.ts) without its widgets: eight tabs
    /// of sections of controls, each control bound to the live settings
    /// through <see cref="SettingsActions"/>, with the dialog's own view state
    /// (the tab, the search, the area picker). A UI walks
    /// <see cref="Tabs"/> -> <see cref="SettingsTabModel.Sections"/> ->
    /// <see cref="SettingsSection.Controls"/>, builds a widget per
    /// <see cref="SettingsControl.Kind"/>, reads the Value/Readout/Visible/
    /// Enabled functions when <see cref="Changed"/> fires, and calls Set/Click.
    /// </summary>
    public sealed class SettingsDialogModel
    {
        /// <summary>The tab the player last looked at, so reopening lands back on it.</summary>
        public static SettingsTab LastTab = SettingsTab.Flight;

        private readonly SettingsDialogHost host;
        private readonly SettingsActions actions;
        private readonly ConfigService config;
        private int placeSearchToken;
        private Action unsubscribe;

        // The dialog's signals that do not simply mirror a setting.
        private double landuseBlendPercent;
        private double treeDensity;
        private double volumePercent;
        private double renderScale;
        private ColourAdjust colourAdjust;
        private KeyboardControlLayoutId keyboardLayout;
        private KeyboardPitchStickMode pitchStickMode;

        public SettingsDialogModel(SettingsDialogHost host, SettingsTab? initialTab = null)
        {
            this.host = host;
            config = host.Config;
            actions = new SettingsActions(config, host.Devices, host.Storage);
            Tab = initialTab ?? LastTab;
            landuseBlendPercent = JsMath.Round(config.LanduseBlend.Active * 100);
            treeDensity = JsMath.Round(config.TreeDensity.Active);
            volumePercent = JsMath.Round(host.Storage.Load().Volume * 100);
            renderScale = config.RenderScale.Active;
            colourAdjust = config.ColourAdjust.Active;
            keyboardLayout = host.KeyboardLayout;
            pitchStickMode = host.PitchStickMode;
            if (host.Areas != null) SetAreas(host.Areas);
            if (host.Spawn != null) unsubscribe = host.Spawn.Subscribe(_ => RaiseChanged());
            Tabs = BuildTabs();
        }

        /// <summary>Something the UI shows may have changed; re-read the controls.</summary>
        public event Action Changed;

        public SettingsActions Actions => actions;

        public IReadOnlyList<SettingsTabModel> Tabs { get; }

        public SettingsTab Tab { get; private set; }

        public SettingsTabModel CurrentTab => Tabs[(int)Tab];

        public void SelectTab(SettingsTab tab)
        {
            LastTab = tab;
            Tab = tab;
            RaiseChanged();
        }

        /// <summary>The dialog closed: stop following the spawn menu.</summary>
        public void Close()
        {
            unsubscribe?.Invoke();
            unsubscribe = null;
        }

        public string Title => SettingsContent.T("title");
        public string SectionPickerLabel => SettingsContent.T("sectionPicker");
        public string CloseLabel => SettingsContent.T("close");

        // ---- Search (Flight tab) ----

        public string SearchQuery { get; private set; } = "";
        public IReadOnlyList<SpawnDestination> QuickResults { get; private set; } = Array.Empty<SpawnDestination>();
        public IReadOnlyList<SpawnDestination> PlaceResults { get; private set; } = Array.Empty<SpawnDestination>();
        public PlaceSearchStatus PlaceStatus { get; private set; } = PlaceSearchStatus.Idle;

        public string AirfieldsGroupLabel => SettingsContent.T("search.airfieldsGroup");
        public string PlacesGroupLabel => SettingsContent.T("search.placesGroup");

        /// <summary>Whether the Places group shows at all (only for a non-blank query).</summary>
        public bool ShowPlaces => JsText.Trim(SearchQuery).Length > 0;

        /// <summary>The disabled line under the places for a status, or null for Done.</summary>
        public static string PlaceStatusText(PlaceSearchStatus status) => status switch
        {
            PlaceSearchStatus.Idle => SettingsContent.T("search.idle"),
            PlaceSearchStatus.Searching => SettingsContent.T("search.searching"),
            PlaceSearchStatus.None => SettingsContent.T("search.none"),
            PlaceSearchStatus.Error => SettingsContent.T("search.error"),
            _ => null,
        };

        /// <summary>A result with no terrain under it is listed but cannot be picked.</summary>
        public static bool IsPickable(SpawnDestination d) => d.Area != null;

        public void SetSearchQuery(string query)
        {
            SearchQuery = query;
            QuickResults = host.Spawn?.QuickSearch(query) ?? new List<SpawnDestination>();
            PlaceResults = Array.Empty<SpawnDestination>();
            PlaceStatus = PlaceSearchStatus.Idle;
            placeSearchToken++;
            RaiseChanged();
        }

        /// <summary>Enter in the box: picks the highlighted result if there is one (the UI's call), else this.</summary>
        public async Task SearchPlaces()
        {
            string query = JsText.Trim(SearchQuery);
            if (query.Length == 0 || host.Spawn == null) return;
            int token = ++placeSearchToken;
            PlaceStatus = PlaceSearchStatus.Searching;
            RaiseChanged();
            try
            {
                List<SpawnDestination> places = await host.Spawn.SearchPlaces(query);
                if (token != placeSearchToken) return;
                PlaceResults = places;
                PlaceStatus = places.Count > 0 ? PlaceSearchStatus.Done : PlaceSearchStatus.None;
            }
            catch (Exception)
            {
                if (token != placeSearchToken) return;
                PlaceStatus = PlaceSearchStatus.Error;
            }
            RaiseChanged();
        }

        /// <summary>A result was picked: the box empties and the spawn menu goes there.</summary>
        public void GoTo(SpawnDestination destination)
        {
            SetSearchQuery("");
            host.Spawn?.GoTo(destination);
        }

        // ---- Areas (World tab) ----

        public IReadOnlyList<SettingsOption> AreaOptions { get; private set; } = Array.Empty<SettingsOption>();
        public string Area { get; private set; } = "";
        public string InitialArea { get; private set; } = "";
        /// <summary>Set once the manifest has answered (or failed), so "nothing to choose" never flashes up.</summary>
        public bool AreasLoaded { get; private set; }

        /// <summary>The manifest's areas arrived (settingsDialog.ts loadAreas).</summary>
        public void SetAreas(IReadOnlyList<TerrainArea> areas)
        {
            var (options, selected) = SettingsContent.AreaOptions(
                areas, SettingsContent.PlayOriginLat, SettingsContent.PlayOriginLon, host.Storage.Load().TerrainArea);
            Area = selected;
            InitialArea = selected;
            AreaOptions = options;
            AreasLoaded = true;
            RaiseChanged();
        }

        /// <summary>The manifest could not be read: no picker, and no "nothing to choose" either way.</summary>
        public void SetAreasFailed()
        {
            AreasLoaded = true;
            RaiseChanged();
        }

        /// <summary>Save the picked area and reload into it.</summary>
        public void FlyToArea()
        {
            string area = Area;
            host.Storage.Update(s => s.TerrainArea = area);
            host.ReloadIntoArea?.Invoke();
        }

        // ---- Live values the dialog shows ----

        public double VolumePercent => volumePercent;
        public KeyboardControlLayoutId KeyboardLayout => keyboardLayout;
        public KeyboardPitchStickMode PitchStickMode => pitchStickMode;
        public ColourAdjust ColourAdjust => colourAdjust;

        /// <summary>The Help tab's joystick entry: its name and axes, or null when none is connected.</summary>
        public (string Name, IReadOnlyList<HelpEntry> Axes)? Joystick()
        {
            JoystickInfo j = host.Joystick?.Invoke();
            if (j == null) return null;
            return (SettingsContent.JoystickName(j.DeviceId), SettingsContent.JoystickAxes(j.AxisCount));
        }

        private void RaiseChanged() => Changed?.Invoke();

        private Action<double> Then(Action<double> set) => v =>
        {
            set(v);
            RaiseChanged();
        };

        private static string Num(double v) => JsText.NumberToString(v);

        private static double ParseNum(string s) => JsText.ToNumber(s);

        // ---- The tabs ----

        private IReadOnlyList<SettingsTabModel> BuildTabs()
        {
            return new[]
            {
                new SettingsTabModel { Tab = SettingsTab.Flight, Sections = FlightTab() },
                new SettingsTabModel { Tab = SettingsTab.Graphics, Sections = GraphicsTab() },
                new SettingsTabModel { Tab = SettingsTab.Colours, Sections = ColoursTab() },
                new SettingsTabModel { Tab = SettingsTab.World, Sections = WorldTab() },
                new SettingsTabModel { Tab = SettingsTab.Simulation, Sections = SimulationTab() },
                new SettingsTabModel { Tab = SettingsTab.General, Sections = GeneralTab() },
                new SettingsTabModel { Tab = SettingsTab.Help, Sections = HelpTab() },
                new SettingsTabModel { Tab = SettingsTab.About, Sections = AboutTab() },
            };
        }

        private static string T(string path) => SettingsContent.T(path);

        private static SettingsSection Section(string id, string title, string help, params SettingsControl[] controls) =>
            new SettingsSection { Id = id, Title = title, Help = help, Controls = controls };

        private SliderControl Slider(string id, SliderRange range, Func<double> value, Action<double> set, Func<string> readout,
            string label = null, string minLabel = null, string maxLabel = null) =>
            new SliderControl
            {
                Id = id, Kind = SettingsControlKind.Slider, Label = label, Range = range, Value = value, Set = Then(set),
                Readout = readout, MinLabel = minLabel, MaxLabel = maxLabel,
            };

        private ChoiceControl Radio(string id, IReadOnlyList<SettingsOption> options, int columns, Func<string> value, Action<string> set) =>
            new ChoiceControl
            {
                Id = id, Kind = SettingsControlKind.Radio, Options = () => options, Columns = columns, Value = value,
                Set = v =>
                {
                    set(v);
                    RaiseChanged();
                },
            };

        private ToggleControl Toggle(string id, string label, Func<bool> value, Action<bool> set) =>
            new ToggleControl
            {
                Id = id, Kind = SettingsControlKind.Toggle, Label = label, Value = value,
                Set = v =>
                {
                    set(v);
                    RaiseChanged();
                },
            };

        private IReadOnlyList<SettingsSection> FlightTab()
        {
            SpawnPanel spawn = host.Spawn;
            SpawnMenuState State() => spawn?.State ?? new SpawnMenuState();
            var startButtons = new List<SettingsControl>();
            foreach (SpawnAction a in SettingsContent.SpawnActions)
            {
                SpawnMode mode = a.Mode;
                startButtons.Add(new ButtonControl
                {
                    Id = "spawn." + SettingsCodec.Name(mode), Kind = SettingsControlKind.Button, Label = a.ButtonLabel,
                    Key = a.Key, Mode = mode, Click = () => spawn?.Spawn(mode),
                });
            }
            return new[]
            {
                Section("aircraft", T("aircraft.title"), null, new ListControl
                {
                    Id = "aircraft", Kind = SettingsControlKind.List,
                    Items = () => State().Aircraft, Selected = () => State().AircraftIndex,
                    Select = i => spawn?.SelectModel(i),
                }),
                Section("livery", null, null, new ChoiceControl
                {
                    Id = "livery", Kind = SettingsControlKind.Select, Label = T("livery.label"),
                    Visible = () => State().Liveries.Count > 1,
                    Options = () => IndexOptions(State().Liveries),
                    Value = () => Num(State().LiveryIndex),
                    Set = v => spawn?.SelectLivery((int)ParseNum(v)),
                }),
                Section("search", null, null,
                    new SearchControl
                    {
                        Id = "search", Kind = SettingsControlKind.Search, Label = T("search.label"),
                        Placeholder = T("search.placeholder"), Hint = T("search.hint"),
                    },
                    new ButtonControl
                    {
                        Id = "searchButton", Kind = SettingsControlKind.Button, Label = T("search.button"),
                        Enabled = () => JsText.Trim(SearchQuery).Length > 0 && PlaceStatus != PlaceSearchStatus.Searching,
                        Click = () => { _ = SearchPlaces(); },
                    }),
                Section("airfield", null, null, new ChoiceControl
                {
                    Id = "airfield", Kind = SettingsControlKind.Select, Label = T("airfield.label"),
                    Visible = () => State().Airfields.Count > 0,
                    Options = () => IndexOptions(State().Airfields),
                    Value = () => Num(State().AirfieldIndex),
                    Set = v => spawn?.SelectAirfield((int)ParseNum(v)),
                }),
                Section("start", T("start.title"), null, startButtons.ToArray()),
            };
        }

        /// <summary>A list's labels as options whose values are their indices.</summary>
        private static IReadOnlyList<SettingsOption> IndexOptions(IReadOnlyList<string> labels)
        {
            var output = new SettingsOption[labels.Count];
            for (int i = 0; i < output.Length; i++) output[i] = new SettingsOption(Num(i), labels[i]);
            return output;
        }

        private IReadOnlyList<SettingsSection> GraphicsTab()
        {
            var renderScaleSection = Section("renderScale", T("renderScale.title"), T("renderScale.help"),
                new ChoiceControl
                {
                    Id = "renderScale", Kind = SettingsControlKind.Select, Label = T("renderScale.select"),
                    Options = () => SettingsContent.RenderScaleOptions,
                    Value = () => Num(renderScale),
                    Set = v =>
                    {
                        double scale = ParseNum(v);
                        actions.SetRenderScale(scale);
                        renderScale = scale;
                        RaiseChanged();
                    },
                },
                Toggle("supersampling", T("renderScale.supersampling"), () => config.Supersampling.Active, actions.SetSupersampling));
            ((ToggleControl)renderScaleSection.Controls[1]).Enabled = () => renderScale >= 1;

            var buildings = Section("buildings", T("buildings.title"), T("buildings.help"),
                Toggle("buildings", T("buildings.toggle"), () => config.Buildings.Active, actions.SetBuildings));
            buildings.Note = T("buildings.note");

            return new[]
            {
                renderScaleSection,
                Section("terrainDetail", T("terrainDetail.title"), T("terrainDetail.help"),
                    Slider("terrainDetail", SettingsContent.TerrainDetailKm,
                        () => SettingsContent.TerrainDetailToKm(config.TerrainDetail.Active), actions.SetTerrainDetail,
                        () => SettingsContent.TerrainDetailLabel(config.TerrainDetail.Active))),
                Section("landuseReach", T("landuseReach.title"), T("landuseReach.help"),
                    Slider("landuseReach", SettingsContent.LanduseReach, () => config.LanduseReach.Active, actions.SetLanduseReach,
                        () => SettingsContent.LanduseReachLabel(config.LanduseReach.Active))),
                Section("visibleZoom", T("visibleZoom.title"), T("visibleZoom.help"),
                    Slider("visibleZoom", SettingsContent.VisibleZoom, () => config.VisibleZoom.Active, actions.SetVisibleZoom,
                        () => SettingsContent.VisibleZoomLabel(config.VisibleZoom.Active))),
                Section("landuseReveal", T("landuseReveal.title"), T("landuseReveal.help"),
                    Slider("landuseReveal", SettingsContent.LanduseRevealPx, () => config.LanduseReveal.Active, actions.SetLanduseReveal,
                        () => SettingsContent.LanduseRevealLabel(config.LanduseReveal.Active))),
                Section("triangleBudget", T("triangleBudget.title"), T("triangleBudget.help"),
                    Slider("triangleBudget", SettingsContent.TriangleBudgetK, () => config.TriangleBudget.Active / 1000,
                        actions.SetTriangleBudget, () => SettingsContent.TriangleBudgetLabel(config.TriangleBudget.Active))),
                Section("farTileTextures", T("farTileTextures.title"), T("farTileTextures.help"),
                    Toggle("farTileTextures", T("farTileTextures.toggle"), () => config.FarTileTextures.Active, actions.SetFarTileTextures)),
                buildings,
                Section("roads", T("roads.title"), T("roads.help"),
                    Radio("roads", SettingsContent.RoadsOptions, 3, () => SettingsCodec.Name(config.Roads.Active), v =>
                    {
                        if (SettingsCodec.TryParse(v, out RoadsMode m)) actions.SetRoads(m);
                    })),
                Section("terrainColour", T("terrainColour.title"), T("terrainColour.help"),
                    Radio("terrainColour", SettingsContent.TerrainColourOptions, 2, () => SettingsCodec.Name(config.TerrainColour.Active), v =>
                    {
                        if (SettingsCodec.TryParse(v, out TerrainColours m)) actions.SetTerrainColour(m);
                    })),
                Section("landuseBlend", T("landuseBlend.title"), T("landuseBlend.help"),
                    Slider("landuseBlend", SettingsContent.LanduseBlendPercent, () => landuseBlendPercent,
                        v => landuseBlendPercent = actions.SetLanduseBlend(v),
                        () => SettingsContent.PercentLabel(landuseBlendPercent),
                        minLabel: T("landuseBlend.minLabel"), maxLabel: T("landuseBlend.maxLabel"))),
                Section("treeDensity", T("treeDensity.title"), T("treeDensity.help"),
                    Slider("treeDensity", SettingsContent.TreeDensity, () => treeDensity,
                        v => treeDensity = actions.SetTreeDensity(v),
                        () => SettingsContent.MultiplierLabel(treeDensity),
                        minLabel: T("treeDensity.minLabel"), maxLabel: T("treeDensity.maxLabel"))),
                Section("terrainShading", T("terrainShading.title"), T("terrainShading.help"),
                    Radio("terrainShading", SettingsContent.TerrainShadingOptions, 2, () => SettingsCodec.Name(config.TerrainShading.Active), v =>
                    {
                        if (SettingsCodec.TryParse(v, out TerrainShading m)) actions.SetTerrainShading(m);
                    })),
            };
        }

        private IReadOnlyList<SettingsSection> ColoursTab()
        {
            var sections = new List<SettingsSection> { Section("colours", null, T("colours.help")) };
            foreach (var (group, label) in SettingsContent.ColourGroupOptions)
            {
                var sliders = new List<SettingsControl>();
                foreach (ColourChannelOption channel in SettingsContent.ColourChannelOptions)
                {
                    ColourAdjustGroup g = group;
                    ColourChannelOption c = channel;
                    sliders.Add(Slider($"colour.{ColourAdjust.Key(g)}.{ColourAdjust.Key(c.Channel)}",
                        new SliderRange(c.Min, c.Max, c.Step),
                        () => SettingsContent.ColourSliderValue(colourAdjust, g, c),
                        v =>
                        {
                            actions.SetColourTweak(colourAdjust, g, c, v);
                            colourAdjust = config.ColourAdjust.Active;
                        },
                        () => SettingsContent.ColourSliderLabel(colourAdjust, g, c),
                        label: c.Label));
                }
                sections.Add(Section($"colour.{ColourAdjust.Key(group)}", label, null, sliders.ToArray()));
            }
            sections.Add(Section("colourReset", null, null, new ButtonControl
            {
                Id = "colourReset", Kind = SettingsControlKind.Button, Label = T("colours.reset"),
                Click = () =>
                {
                    actions.ResetColourAdjust();
                    colourAdjust = config.ColourAdjust.Active;
                    RaiseChanged();
                },
            }));
            return sections;
        }

        private IReadOnlyList<SettingsSection> WorldTab()
        {
            var area = Section("area", T("area.title"), T("area.help"),
                new ChoiceControl
                {
                    Id = "area", Kind = SettingsControlKind.Select, Label = T("area.select"),
                    Options = () => AreaOptions, Value = () => Area,
                    Set = v =>
                    {
                        Area = v;
                        RaiseChanged();
                    },
                },
                new ButtonControl
                {
                    Id = "flyHere", Kind = SettingsControlKind.Button, Label = T("area.button"),
                    Enabled = () => Area != InitialArea, Click = FlyToArea,
                });
            area.Visible = () => AreaOptions.Count > 1;
            var import = Section("importTerrain", T("importTerrain.title"), T("importTerrain.help"));
            import.Visible = () => host.TerrainImport;
            var single = Section("singleArea", null, T("singleArea"));
            single.Visible = () => AreasLoaded && AreaOptions.Count < 2 && !host.TerrainImport;
            return new[] { area, import, single };
        }

        private IReadOnlyList<SettingsSection> SimulationTab()
        {
            return new[]
            {
                Section("daytime", T("daytime.title"), T("daytime.help"),
                    Slider("daytime", SettingsContent.DaytimeHours, () => config.Daytime.Active, actions.SetDaytime,
                        () => SettingsContent.DaytimeLabel(config.Daytime.Active))),
                Section("flightModel", T("flightModel.title"), null,
                    Radio("flightModel", SettingsContent.FlightModelOptions, 2, () => config.FlightModels.ActiveKey, actions.SetFlightModel)),
                Section("aiPilotModel", T("aiPilotModel.title"), T("aiPilotModel.help"),
                    Radio("aiPilotModel", SettingsContent.AiPilotModelOptions, 2, () => SettingsCodec.Name(config.AiPilotModels.Active), v =>
                    {
                        if (SettingsCodec.TryParse(v, out AiPilotModels m)) actions.SetAiPilotModel(m);
                    })),
            };
        }

        private IReadOnlyList<SettingsSection> GeneralTab()
        {
            return new[]
            {
                Section("volume", T("volume.title"), null,
                    Slider("volume", SettingsContent.VolumePercent, () => volumePercent,
                        v => volumePercent = actions.SetVolume(v), () => SettingsContent.PercentLabel(volumePercent))),
                Section("units", T("units.title"), null,
                    Radio("units", SettingsContent.UnitSystemOptions, 2, () => SettingsCodec.Name(config.UnitSystem.Active), v =>
                    {
                        if (SettingsCodec.TryParse(v, out UnitSystems m)) actions.SetUnitSystem(m);
                    })),
                Section("keyboardLayout", T("keyboardLayout.title"), null,
                    Radio("keyboardLayout", SettingsContent.KeyboardLayoutOptions, 3, () => Num((int)keyboardLayout), v =>
                    {
                        double n = ParseNum(v);
                        if (!SettingsCodec.IsKeyboardLayout(n)) return;
                        keyboardLayout = (KeyboardControlLayoutId)(int)n;
                        actions.SetKeyboardLayout(keyboardLayout);
                    })),
                Section("pitchStick", T("pitchStick.title"), null,
                    Radio("pitchStick", SettingsContent.PitchStickModeOptions, 2, () => Num((int)pitchStickMode), v =>
                    {
                        double n = ParseNum(v);
                        if (!SettingsCodec.IsPitchStickMode(n)) return;
                        pitchStickMode = (KeyboardPitchStickMode)(int)n;
                        actions.SetPitchStickMode(pitchStickMode);
                    })),
            };
        }

        private IReadOnlyList<SettingsSection> HelpTab()
        {
            KeysControl Keys(string id, Func<IReadOnlyList<HelpEntry>> entries) =>
                new KeysControl { Id = id, Kind = SettingsControlKind.Keys, Entries = entries };
            var joystick = Keys("help.joystick", () => Joystick()?.Axes ?? Array.Empty<HelpEntry>());
            joystick.Caption = () => Joystick()?.Name ?? T("help.noJoystick");
            var spawn = Section("help.spawnMenu", T("help.spawnMenu"), null, Keys("help.spawnMenu", () => SettingsContent.SpawnHelp));
            spawn.Note = T("help.spawnMenuNote");
            return new[]
            {
                Section("help.keyboard", T("help.keyboard"), null, Keys("help.keyboard", () => SettingsContent.FlightHelp(keyboardLayout))),
                Section("help.joystick", T("help.joystick"), null, joystick),
                Section("help.systems", T("help.systems"), null, Keys("help.systems", () => SettingsContent.SystemsHelp)),
                spawn,
                Section("help.views", T("help.views"), null, Keys("help.views", () => SettingsContent.ViewsHelp)),
            };
        }

        private IReadOnlyList<SettingsSection> AboutTab()
        {
            var sections = new List<SettingsSection> { Section("about", T("about.title"), T("about.help")) };
            for (int i = 0; i < SettingsContent.DataSources.Count; i++)
            {
                DataSourceGroup g = SettingsContent.DataSources[i];
                string id = "about." + i.ToString(CultureInfo.InvariantCulture);
                sections.Add(Section(id, g.Title, g.Feeds,
                    new CreditsControl { Id = id, Kind = SettingsControlKind.Credits, Group = g }));
            }
            return sections;
        }
    }
}
