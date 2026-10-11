using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>settingsModel.ts SettingsTab, in display order.</summary>
    public enum SettingsTab
    {
        Flight,
        Graphics,
        Colours,
        World,
        Simulation,
        General,
        Help,
        About,
    }

    /// <summary>One entry of a select or radio group: the value as the TS stores or compares it, and its label.</summary>
    public sealed class SettingsOption
    {
        public readonly string Value;
        public readonly string Label;

        public SettingsOption(string value, string label)
        {
            Value = value;
            Label = label;
        }

        public override string ToString() => $"{Value}: {Label}";
    }

    /// <summary>A slider's range in slider units (what the thumb moves through).</summary>
    public sealed class SliderRange
    {
        public readonly double Min;
        public readonly double Max;
        public readonly double Step;

        public SliderRange(double min, double max, double step)
        {
            Min = min;
            Max = max;
            Step = step;
        }
    }

    /// <summary>settingsModel.ts HelpEntry: a row of the Help tab, the keys then what they do.</summary>
    public sealed class HelpEntry
    {
        public readonly IReadOnlyList<string> Keys;
        public readonly string Action;

        public HelpEntry(string action, params string[] keys)
        {
            Keys = keys;
            Action = action;
        }
    }

    /// <summary>settingsModel.ts DataSource: a dataset as the About tab credits it.</summary>
    public sealed class DataSource
    {
        public readonly string Name;
        /// <summary>Where or what it covers, when narrower than its group; null otherwise.</summary>
        public readonly string Scope;
        /// <summary>The attribution its licence asks for.</summary>
        public readonly string Credit;
        /// <summary>Where the credit links to, when the publisher asks for a link; null otherwise.</summary>
        public readonly string CreditUrl;
        public readonly string Licence;

        public DataSource(string name, string scope, string credit, string licence, string creditUrl = null)
        {
            Name = name;
            Scope = scope;
            Credit = credit;
            Licence = licence;
            CreditUrl = creditUrl;
        }

        /// <summary>The licence's canonical text, or null when it has none (LICENCE_URLS).</summary>
        public string LicenceUrl => SettingsContent.LicenceUrls.TryGetValue(Licence, out string url) ? url : null;
    }

    /// <summary>settingsModel.ts DataSourceGroup.</summary>
    public sealed class DataSourceGroup
    {
        public readonly string Title;
        /// <summary>What in the game the group's data ends up as.</summary>
        public readonly string Feeds;
        public readonly IReadOnlyList<DataSource> Sources;

        public DataSourceGroup(string title, string feeds, params DataSource[] sources)
        {
            Title = title;
            Feeds = feeds;
            Sources = sources;
        }
    }

    /// <summary>settingsModel.ts SPAWN_ACTIONS: a start button, the mode it starts and the key that also starts it.</summary>
    public sealed class SpawnAction
    {
        public readonly SpawnMode Mode;
        public readonly string Label;
        public readonly string Key;

        public SpawnAction(SpawnMode mode, string label, string key)
        {
            Mode = mode;
            Label = label;
            Key = key;
        }

        /// <summary>spawnButtonLabel: "Approach (1)".</summary>
        public string ButtonLabel => $"{Label} ({Key})";
    }

    /// <summary>settingsModel.ts ColourChannelOption: one colour slider, with the scale from stored value to slider units.</summary>
    public sealed class ColourChannelOption
    {
        public readonly ColourChannel Channel;
        public readonly string Label;
        public readonly double Min;
        public readonly double Max;
        public readonly double Step;
        public readonly double Scale;
        public readonly string Unit;

        public ColourChannelOption(ColourChannel channel, string label, double min, double max, double step, double scale, string unit)
        {
            Channel = channel;
            Label = label;
            Min = min;
            Max = max;
            Step = step;
            Scale = scale;
            Unit = unit;
        }
    }

    /// <summary>
    /// Everything the settings dialog shows that is not a live value: the
    /// text of every section (port of settingsModel.ts SETTINGS_TEXT, by its
    /// dotted path), option lists, slider ranges, the Help tab's keys, the
    /// About tab's data credits, and the readouts sliders print.
    /// </summary>
    public static class SettingsContent
    {
        public static readonly IReadOnlyList<SettingsTab> Tabs = (SettingsTab[])Enum.GetValues(typeof(SettingsTab));

        /// <summary>
        /// settingsModel.ts SETTINGS_TEXT flattened: "renderScale.help" is
        /// SETTINGS_TEXT.renderScale.help. <see cref="T"/> reads one.
        /// </summary>
        public static readonly IReadOnlyDictionary<string, string> Text = new Dictionary<string, string>
        {
            ["title"] = "Settings",
            ["sectionPicker"] = "Section",
            ["close"] = "Close",
            ["aircraft.title"] = "Aircraft",
            ["livery.label"] = "Livery",
            ["search.label"] = "Find an airfield or place",
            ["search.placeholder"] = "ICAO, name, town, or lat, lon",
            ["search.hint"] = "Airfields match as you type; Enter also looks up places.",
            ["search.button"] = "Search",
            ["search.airfieldsGroup"] = "Airfields",
            ["search.placesGroup"] = "Places",
            ["search.idle"] = "Press Enter to look up places",
            ["search.searching"] = "Searching…",
            ["search.none"] = "No places found",
            ["search.error"] = "Place search failed, check the connection",
            ["airfield.label"] = "Airfield",
            ["start.title"] = "Start",
            ["renderScale.title"] = "Render scale",
            ["renderScale.help"] = "Draws the 3D view at this fraction of the screen and stretches it to full size; the HUD and "
                + "cockpit displays stay sharp on top. Lower it if the frame rate is short on a large screen. 100% "
                + "is off and draws at native size, supersampled for anti-aliasing where the resolution affords it "
                + "unless that is switched off here.",
            ["renderScale.select"] = "3D resolution",
            ["renderScale.supersampling"] = "Supersampling (SSAA) at 100%",
            ["terrainDetail.title"] = "Terrain detail distance",
            ["terrainDetail.help"] = "How far out terrain keeps full detail. Past it the far field is drawn coarser, which is where "
                + "most of the triangles above the horizon go — lower this if the frame rate is short. The ground "
                + "you are flying over is never affected. Rightmost is off.",
            ["landuseReach.title"] = "Land-use detail reach",
            ["landuseReach.help"] = "Only the finest terrain tiles carry the exact field, wood and town outlines. This brings those "
                + "tiles in that many times further out than the terrain detail alone would, at the cost of more "
                + "triangles around the aircraft. 1x is no bias.",
            ["visibleZoom.title"] = "Finest terrain level",
            ["visibleZoom.help"] = "The deepest zoom level of terrain tiles drawn. Each level down halves the tile resolution and "
                + "drops the land-use outlines the finer tiles carry, for fewer triangles and fewer tile fetches. "
                + "12 is full detail.",
            ["landuseReveal.title"] = "Land-use region size",
            ["landuseReveal.help"] = "How large a field, wood or town has to be on screen before it is drawn, in pixels across. Big "
                + "regions show from far away and small ones fill in as you close; lower brings the small ones in "
                + "from further out, higher keeps the distance cleaner.",
            ["triangleBudget.title"] = "Terrain triangle cap",
            ["triangleBudget.help"] = "Ceiling on terrain triangles drawn per frame. When the view asks for more, the farthest tiles "
                + "are folded into coarser ones until it fits, so a low cap shows as a coarser far field rather "
                + "than coarser ground nearby. Raise it if the distance looks blocky; lower it if the frame rate "
                + "is short.",
            ["farTileTextures.title"] = "Far tile textures",
            ["farTileTextures.help"] = "Distant ground is drawn as large facets, one colour each. With this on, those facets are "
                + "painted with an image of the fields, woods and towns the detailed tiles hold, so the far view "
                + "keeps its detail instead of switching it on as you close. Off shows the plain facets.",
            ["farTileTextures.toggle"] = "Paint far tiles from the detailed ground",
            ["buildings.title"] = "Buildings",
            ["buildings.help"] = "Houses and other buildings from OpenStreetMap, with their roofs, where the terrain was baked "
                + "with them. Far off only the larger ones are drawn, and a busy view thins them out to hold the "
                + "frame rate. Where roofs were measured in aerial photos they show their real colour with the "
                + "Imagery and Hybrid terrain colours.",
            ["buildings.note"] = "Data sources and licences: see the About tab.",
            ["buildings.toggle"] = "Draw buildings",
            ["roads.title"] = "Roads",
            ["roads.help"] = "Roads are drawn as lines over the ground where the terrain was baked with them. Major keeps "
                + "motorways and main roads, the ones you can see from altitude, and drops the streets, which are "
                + "most of the cost over a city.",
            ["terrainColour.title"] = "Terrain colour",
            ["terrainColour.help"] = "Every facet is baked with both a landcover class and a satellite colour; this picks which one "
                + "paints it.",
            ["landuseBlend.title"] = "Land-use colour",
            ["landuseBlend.help"] = "In Hybrid colour, how much of a field, wood or town is its land type's colour, and how much "
                + "the terrain colour sampled from imagery.",
            ["landuseBlend.minLabel"] = "Sampled",
            ["landuseBlend.maxLabel"] = "Land type",
            ["treeDensity.title"] = "Tree density",
            ["treeDensity.help"] = "How many trees are placed in each wood, as a multiplier on the default spacing - 0 turns trees "
                + "off. Re-grows forest already loaded, so it takes a moment to catch up over a large area.",
            ["treeDensity.minLabel"] = "0x",
            ["treeDensity.maxLabel"] = "20x",
            ["terrainShading.title"] = "Terrain shading",
            ["terrainShading.help"] = "Flat colour per facet, or smoothly blended across neighbouring facets.",
            ["colours.help"] = "Hue, saturation and brightness of the trees and shrubs, the ground, water and the sky, on top "
                + "of whichever terrain colour is picked. 0° and 100% are the look as drawn; 0% saturation is "
                + "grey, and hue turns every colour round the colour wheel by that many degrees.",
            ["colours.reset"] = "Reset colours",
            ["area.title"] = "Area",
            ["area.help"] = "Where in the world to fly. Areas other than the home one are terrain only — no airbase, no "
                + "carrier — so you start airborne over the middle of them. Changing this reloads the sim.",
            ["area.select"] = "Area",
            ["area.button"] = "Fly here",
            ["importTerrain.title"] = "Import terrain",
            ["importTerrain.help"] = "Bake a new area into the terrain, or delete one. Runs on the dev server and carries on if this "
                + "dialog is closed.",
            ["singleArea"] = "Only one terrain area is baked, so there is nothing to choose between.",
            ["daytime.title"] = "Time of day",
            ["daytime.help"] = "Local solar time. Moves the sun, so sky, terrain and aircraft silhouettes follow it. Sunrise "
                + "06:00, sunset 18:00. N flips between afternoon and midnight.",
            ["flightModel.title"] = "Flight model",
            ["aiPilotModel.title"] = "AI pilot model",
            ["aiPilotModel.help"] = "Applies on the next merge / opponent spawn.",
            ["volume.title"] = "Volume",
            ["units.title"] = "Units",
            ["keyboardLayout.title"] = "Keyboard layout",
            ["pitchStick.title"] = "Pitch stick",
            ["help.keyboard"] = "Keyboard",
            ["help.joystick"] = "Joystick",
            ["help.noJoystick"] = "No device detected",
            ["help.systems"] = "Systems",
            ["help.spawnMenu"] = "Spawn menu",
            ["help.spawnMenuNote"] = "Aircraft list: pick from the combobox in the spawn menu.",
            ["help.views"] = "Views",
            ["about.title"] = "Data sources",
            ["about.help"] = "The world is built from open data. Each source is clipped, resampled, measured and combined "
                + "with the others when the terrain is baked, so none of it appears as published, and no "
                + "publisher endorses this game.",
        };

        /// <summary>The text at a SETTINGS_TEXT path; throws for a path that does not exist.</summary>
        public static string T(string path) =>
            Text.TryGetValue(path, out string s) ? s : throw new KeyNotFoundException($"no settings text {path}");

        /// <summary>settingsModel.ts SPAWN_ACTIONS, in display order.</summary>
        public static readonly IReadOnlyList<SpawnAction> SpawnActions = new[]
        {
            new SpawnAction(SpawnMode.Approach, "Approach", "1"),
            new SpawnAction(SpawnMode.Runway, "Runway", "2"),
            new SpawnAction(SpawnMode.Headon, "Head-on", "3"),
            new SpawnAction(SpawnMode.Carrier, "Carrier land", "4"),
            new SpawnAction(SpawnMode.CarrierTakeoff, "Carrier TO", "5"),
            new SpawnAction(SpawnMode.CarrierBarricade, "Carrier barricade", "8"),
            new SpawnAction(SpawnMode.HighAlt, "10 km", "6"),
            new SpawnAction(SpawnMode.Space, "Space", "7"),
            new SpawnAction(SpawnMode.CloseWing, "Wingtip", "9"),
        };

        public static readonly IReadOnlyList<HelpEntry> SystemsHelp = new[]
        {
            new HelpEntry("Landing gear", "G"),
            new HelpEntry("Flaps", "F"),
            new HelpEntry("FCS limiters (AoA/g) on/off", "L"),
            new HelpEntry("FCS limiter strategy (soft / predictive / smooth; FM2 only)", "1", "2", "3"),
            new HelpEntry("Select target", "T"),
            new HelpEntry("Target night view", "I"),
            new HelpEntry("Tailhook", "H"),
            new HelpEntry("Cycle HUD focus", "U"),
            new HelpEntry("Import or delete terrain areas (opens the World tab)", "F9"),
            new HelpEntry("Import aircraft mod (.zip)", "F10"),
        };

        public static readonly IReadOnlyList<HelpEntry> SpawnHelp = new[]
        {
            new HelpEntry("Open spawn menu", "Esc"),
            new HelpEntry("Approach spawn", "1"),
            new HelpEntry("Runway spawn", "2"),
            new HelpEntry("Head-on spawn", "3"),
            new HelpEntry("Carrier landing spawn", "4"),
            new HelpEntry("Carrier takeoff spawn", "5"),
            new HelpEntry("High-altitude spawn (10 km)", "6"),
            new HelpEntry("Space spawn (400 km)", "7"),
            new HelpEntry("Carrier barricade spawn (50 m astern of the ramp, net rigged, flying solo)", "8"),
        };

        public static readonly IReadOnlyList<HelpEntry> ViewsHelp = new[]
        {
            new HelpEntry("Day/night", "N"),
            new HelpEntry("Cockpit (press again with a target to toggle padlock)", "F1"),
            new HelpEntry("Exterior back/front", "F2"),
            new HelpEntry("Exterior left/right", "F3"),
            new HelpEntry("Exterior back/front of AI plane (looks at player)", "F6"),
            new HelpEntry("Aircraft showcase (black background, orbit with numpad)", "F12"),
            new HelpEntry("Replay the flight so far (Space pause, arrows seek and speed, or move the camera in the Free view; F4/Esc exit)", "F4"),
            new HelpEntry("To/from target", "4"),
            new HelpEntry("Move camera around aircraft", "Num 4", "Num 6", "Num 8", "Num 2"),
            new HelpEntry("Recenter camera", "Num 5"),
            new HelpEntry("Zoom in / out (F1: padlock target, F2: lock/unlock on enemy)", "Num *", "Num /"),
        };

        /// <summary>settingsModel.ts formatControlKey: a layout's key name as the Help tab prints it.</summary>
        public static string FormatControlKey(string key)
        {
            switch (key)
            {
                case "arrowup": return "↑";
                case "arrowdown": return "↓";
                case "arrowleft": return "←";
                case "arrowright": return "→";
                case "numpadadd": return "Num+";
                case "numpadsubtract": return "Num-";
                // String.prototype.toUpperCase: the one full case mapping a key name could need is ß.
                default: return key.ToUpperInvariant().Replace("ß", "SS");
            }
        }

        /// <summary>settingsModel.ts flightHelp: the Help tab's flight keys for a layout; empty for an unknown one.</summary>
        public static IReadOnlyList<HelpEntry> FlightHelp(KeyboardControlLayoutId layoutId)
        {
            if (!KeyboardLayouts.KeyboardControlLayouts.TryGetValue(layoutId, out KeyboardControlLayout layout))
            {
                return Array.Empty<HelpEntry>();
            }
            string K(KeyboardControlAction a) => FormatControlKey(layout[a]);
            return new[]
            {
                new HelpEntry("Pitch", K(KeyboardControlAction.PITCH_NEG), K(KeyboardControlAction.PITCH_POS)),
                new HelpEntry("Roll", K(KeyboardControlAction.ROLL_NEG), K(KeyboardControlAction.ROLL_POS)),
                new HelpEntry("Yaw", K(KeyboardControlAction.YAW_NEG), K(KeyboardControlAction.YAW_POS)),
                new HelpEntry("Throttle", K(KeyboardControlAction.THROTTLE_POS), K(KeyboardControlAction.THROTTLE_NEG)),
            };
        }

        /// <summary>settingsModel.ts joystickName: "Logitech Extreme 3D (Vendor: 046d Product: c215)" reads as "Logitech Extreme 3D".</summary>
        public static string JoystickName(string id)
        {
            int bracket = id.LastIndexOf('(');
            // JS substring(0, -1) is substring(0, 0).
            return bracket != -1 ? id.Substring(0, Math.Max(0, bracket - 1)) : id;
        }

        /// <summary>settingsModel.ts joystickHelp: the device's name and only the axes it actually has.</summary>
        public static IReadOnlyList<HelpEntry> JoystickAxes(int axisCount)
        {
            var axes = new (int Axis, string Action)[] { (1, "Pitch"), (0, "Roll"), (3, "Yaw"), (2, "Throttle") };
            var output = new List<HelpEntry>();
            foreach ((int axis, string action) in axes)
            {
                if (axis < axisCount) output.Add(new HelpEntry(action, $"Axis {axis}"));
            }
            return output;
        }

        /// <summary>settingsModel.ts LICENCE_URLS.</summary>
        public static readonly IReadOnlyDictionary<string, string> LicenceUrls = new Dictionary<string, string>
        {
            ["ODbL 1.0"] = "https://opendatacommons.org/licenses/odbl/1-0/",
            ["CC BY 4.0"] = "https://creativecommons.org/licenses/by/4.0/",
            ["CC BY-NC-SA 4.0"] = "https://creativecommons.org/licenses/by-nc-sa/4.0/",
            ["dl-de/by-2-0"] = "https://www.govdata.de/dl-de/by-2-0",
            ["dl-de/zero-2-0"] = "https://www.govdata.de/dl-de/zero-2-0",
        };

        private const string BavariaCredit = "Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de";

        /// <summary>
        /// settingsModel.ts DATA_SOURCES: every dataset the terrain bake reads,
        /// grouped by what it feeds, as the About tab credits them.
        /// </summary>
        public static readonly IReadOnlyList<DataSourceGroup> DataSources = new[]
        {
            new DataSourceGroup("Terrain heights",
                "The shape of the ground, from the whole planet down to the detailed areas.",
                new DataSource("FABDEM (Forest And Buildings removed Copernicus DEM)", "Detailed areas, 30 m",
                    "University of Bristol", "CC BY-NC-SA 4.0"),
                new DataSource("Copernicus DEM GLO-30", "Detailed areas, 30 m; the model FABDEM corrects",
                    "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
                    "Copernicus DEM licence"),
                new DataSource("ETOPO 2022, 60 arc-second", "The whole planet, 1.85 km",
                    "NOAA National Centers for Environmental Information", "Public domain")),
            new DataSourceGroup("Road and railway earthworks",
                "Embankments, cuttings and bridge ends, measured along each road and railway in lidar terrain models.",
                new DataSource("DGM1", "Bavaria", BavariaCredit, "CC BY 4.0"),
                new DataSource("ALS DTM 1 m (2025)", "Austria",
                    "BEV – Bundesamt für Eich- und Vermessungswesen", "CC BY 4.0"),
                new DataSource("swissALTI3D", "Switzerland", "© Data: swisstopo", "swisstopo OGD"),
                new DataSource("DGM1", "Niedersachsen",
                    "LGLN – Landesamt für Geoinformation und Landesvermessung Niedersachsen", "CC BY 4.0"),
                new DataSource("DGM1", "Baden-Württemberg",
                    "LGL – Landesamt für Geoinformation und Landentwicklung Baden-Württemberg", "dl-de/by-2-0"),
                new DataSource("DGM1", "Brandenburg and Berlin",
                    "LGB – Landesvermessung und Geobasisinformation Brandenburg; Berlin: Geoportal Berlin", "dl-de/by-2-0"),
                new DataSource("DGM1", "Hessen",
                    "HVBG – Hessische Verwaltung für Bodenmanagement und Geoinformation", "dl-de/zero-2-0"),
                new DataSource("DGM1", "Nordrhein-Westfalen", "Geobasis NRW", "dl-de/zero-2-0"),
                new DataSource("DGM1", "Rheinland-Pfalz",
                    "LVermGeo RLP – Landesamt für Vermessung und Geobasisinformation Rheinland-Pfalz", "dl-de/by-2-0"),
                new DataSource("DGM1", "Mecklenburg-Vorpommern",
                    "LAiV MV – Landesamt für innere Verwaltung Mecklenburg-Vorpommern", "CC BY 4.0"),
                new DataSource("DGM1 2020–2025", "Thüringen",
                    "TLBG – Thüringer Landesamt für Bodenmanagement und Geoinformation", "dl-de/by-2-0"),
                new DataSource("MDT 5 m", "Canary Islands", "IGN – Instituto Geográfico Nacional", "CC BY 4.0")),
            new DataSourceGroup("Land cover",
                "The colour of the ground: land-cover classes, true-colour imagery, and the planet seen from far off.",
                new DataSource("ESA WorldCover 2021 v200", "Land-cover classes, 10 m",
                    "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium",
                    "CC BY 4.0"),
                new DataSource("Sentinel-2 L2A true colour",
                    "Imagery and Hybrid terrain colours; roof colours of larger buildings outside the orthophoto areas",
                    "Contains modified Copernicus Sentinel data", "Copernicus Sentinel data terms"),
                new DataSource("Blue Marble Next Generation", "The whole planet, 500 m", "NASA Earth Observatory", "Public domain")),
            new DataSourceGroup("Roads, buildings and map features",
                "Coastlines, lakes and rivers, land use, roads, railways, bridges, airfields and buildings, and the place search on the Flight tab.",
                new DataSource("OpenStreetMap", null, "© OpenStreetMap contributors", "ODbL 1.0",
                    "https://www.openstreetmap.org/copyright")),
            new DataSourceGroup("Buildings",
                "Roof colours measured in aerial photos (with the Imagery and Hybrid terrain colours), building "
                + "heights and ridges fitted to a surface model, and official roof shapes and heights - plus the "
                + "buildings only the official models have.",
                new DataSource("DOP40 digital orthophotos, 40 cm", "Bavaria", BavariaCredit, "CC BY 4.0"),
                new DataSource("DOP20 digital orthophotos, 20 cm", "Brandenburg, Berlin",
                    "© GeoBasis-DE/LGB; © Geoportal Berlin (data changed)", "dl-de/by-2-0"),
                new DataSource("DOM20 digital surface model, 20 cm", "Bavaria", BavariaCredit, "CC BY 4.0"),
                new DataSource("DGM1 digital terrain model, 1 m (ground under the buildings)", "Bavaria", BavariaCredit, "CC BY 4.0"),
                new DataSource("LoD2 3D building models", "Bavaria", BavariaCredit, "CC BY 4.0"),
                new DataSource("bDOM digital surface model, 20 cm, over DGM1, 1 m", "Brandenburg",
                    "© GeoBasis-DE/LGB (data changed)", "dl-de/by-2-0"),
                new DataSource("LoD2 3D building models", "Brandenburg", "© GeoBasis-DE/LGB (data changed)", "dl-de/by-2-0"),
                new DataSource("LoD2 3D building models", "Berlin", "Geoportal Berlin", "dl-de/zero-2-0")),
        };

        public static readonly IReadOnlyList<SettingsOption> TerrainColourOptions = new[]
        {
            new SettingsOption("LANDCOVER", "Landcover (palette tones)"),
            new SettingsOption("SWATCH", "Swatches (quantised imagery)"),
            new SettingsOption("HYBRID", "Hybrid (palette hue, real shading)"),
            new SettingsOption("IMAGERY", "Imagery (true colour)"),
        };

        public static readonly IReadOnlyList<SettingsOption> RoadsOptions = new[]
        {
            new SettingsOption("ALL", "All roads"),
            new SettingsOption("MAJOR", "Major roads only"),
            new SettingsOption("OFF", "Off"),
        };

        public static readonly IReadOnlyList<SettingsOption> TerrainShadingOptions = new[]
        {
            new SettingsOption("FACETED", "Faceted (flat)"),
            new SettingsOption("SMOOTH", "Smooth (blended)"),
        };

        public static readonly IReadOnlyList<SettingsOption> FlightModelOptions = new[]
        {
            new SettingsOption("FM2", "FM2 (Rigid body)"),
            new SettingsOption("FM3", "FM3 (Physical, post-stall)"),
            new SettingsOption("DEBUG", "Debug (Free-fly)"),
        };

        public static readonly IReadOnlyList<SettingsOption> AiPilotModelOptions = new[]
        {
            new SettingsOption("CLASSIC", "Classic BFM"),
            new SettingsOption("SHAW", "Shaw (Fighter Combat)"),
            new SettingsOption("AGGRESSIVE", "Aggressive (Berserker)"),
            new SettingsOption("ACE", "Ace (vertical fight + post-stall)"),
        };

        public static readonly IReadOnlyList<SettingsOption> UnitSystemOptions = new[]
        {
            new SettingsOption("METRIC", "Metric (m, km/h)"),
            new SettingsOption("IMPERIAL", "Imperial (ft, kt)"),
        };

        /// <summary>Values are the layout ids' numbers, as stored.</summary>
        public static readonly IReadOnlyList<SettingsOption> KeyboardLayoutOptions = new[]
        {
            new SettingsOption("0", "QWERTY"),
            new SettingsOption("1", "QWERTZ"),
            new SettingsOption("2", "AZERTY"),
            new SettingsOption("3", "Dvorak"),
            new SettingsOption("4", "Arrows"),
        };

        /// <summary>Values are the modes' numbers, as stored.</summary>
        public static readonly IReadOnlyList<SettingsOption> PitchStickModeOptions = new[]
        {
            new SettingsOption("0", "Layout default"),
            new SettingsOption("1", "Hold: full while pressed"),
        };

        /// <summary>settingsModel.ts RENDER_SCALE_OPTIONS: "100% (off)", then percentages; values as numbers' JS strings.</summary>
        public static readonly IReadOnlyList<SettingsOption> RenderScaleOptions = BuildRenderScaleOptions();

        private static SettingsOption[] BuildRenderScaleOptions()
        {
            var output = new SettingsOption[RenderScaleSetting.RenderScales.Count];
            for (int i = 0; i < output.Length; i++)
            {
                double scale = RenderScaleSetting.RenderScales[i];
                output[i] = new SettingsOption(JsText.NumberToString(scale),
                    scale >= 1 ? "100% (off)" : $"{JsText.NumberToString(JsMath.Round(scale * 100))}%");
            }
            return output;
        }

        /// <summary>settingsModel.ts COLOUR_GROUP_OPTIONS.</summary>
        public static readonly IReadOnlyList<(ColourAdjustGroup Group, string Label)> ColourGroupOptions = new[]
        {
            (ColourAdjustGroup.Trees, "Trees and shrubs"),
            (ColourAdjustGroup.Terrain, "Terrain"),
            (ColourAdjustGroup.Water, "Water"),
            (ColourAdjustGroup.Sky, "Sky"),
        };

        /// <summary>settingsModel.ts COLOUR_CHANNEL_OPTIONS.</summary>
        public static readonly IReadOnlyList<ColourChannelOption> ColourChannelOptions = new[]
        {
            new ColourChannelOption(ColourChannel.Hue, "Hue", -ColourAdjust.HueMaxDeg, ColourAdjust.HueMaxDeg, 5, 1, "°"),
            new ColourChannelOption(ColourChannel.Saturation, "Saturation", ColourAdjust.TweakMin * 100, ColourAdjust.TweakMax * 100, 5, 100, "%"),
            new ColourChannelOption(ColourChannel.Brightness, "Brightness", ColourAdjust.TweakMin * 100, ColourAdjust.TweakMax * 100, 5, 100, "%"),
        };

        /// <summary>settingsModel.ts DETAIL_OFF_KM: the last terrain detail step before off.</summary>
        public const double DetailOffKm = Lod.TerrainDetailDistanceMaxM / 1000;

        // settingsModel.ts SLIDERS.
        public static readonly SliderRange TerrainDetailKm = new SliderRange(Lod.TerrainDetailDistanceMinM / 1000, DetailOffKm + 2, 2);
        public static readonly SliderRange LanduseReach = new SliderRange(Lod.LeafRefineDistanceScaleMin, Lod.LeafRefineDistanceScaleMax, 0.5);
        public static readonly SliderRange VisibleZoom = new SliderRange(Lod.TerrainVisibleZoomMin, Lod.TerrainVisibleZoomMax, 1);
        public static readonly SliderRange LanduseRevealPx = new SliderRange(Lod.LanduseRevealMinPxMin, Lod.LanduseRevealMinPxMax, 1);
        public static readonly SliderRange TriangleBudgetK = new SliderRange(Lod.TerrainTriangleBudgetMin / 1000.0, Lod.TerrainTriangleBudgetMax / 1000.0, 100);
        public static readonly SliderRange LanduseBlendPercent = new SliderRange(0, 100, 5);
        public static readonly SliderRange TreeDensity = new SliderRange(0, 20, 1);
        public static readonly SliderRange DaytimeHours = new SliderRange(0, 23.75, 0.25);
        public static readonly SliderRange VolumePercent = new SliderRange(0, 100, 1);

        /// <summary>SLIDERS by its TS key.</summary>
        public static readonly IReadOnlyDictionary<string, SliderRange> Sliders = new Dictionary<string, SliderRange>
        {
            ["terrainDetailKm"] = TerrainDetailKm,
            ["landuseReach"] = LanduseReach,
            ["visibleZoom"] = VisibleZoom,
            ["landuseRevealPx"] = LanduseRevealPx,
            ["triangleBudgetK"] = TriangleBudgetK,
            ["landuseBlendPercent"] = LanduseBlendPercent,
            ["treeDensity"] = TreeDensity,
            ["daytimeHours"] = DaytimeHours,
            ["volumePercent"] = VolumePercent,
        };

        /// <summary>settingsModel.ts terrainDetailKm: the slider position for a distance (off sits past the last step).</summary>
        public static double TerrainDetailToKm(double distanceM) =>
            JsText.IsFinite(distanceM) ? distanceM / 1000 : TerrainDetailKm.Max;

        /// <summary>settingsModel.ts terrainDetailLabel: "12 km", or "Off".</summary>
        public static string TerrainDetailLabel(double distanceM) =>
            JsText.IsFinite(distanceM) ? $"{JsText.NumberToString(JsMath.Round(distanceM / 1000))} km" : "Off";

        /// <summary>settingsModel.ts terrainDetailFromKm: past the last step is off.</summary>
        public static double TerrainDetailFromKm(double km) => km > DetailOffKm ? Lod.DetailDistanceOff : km * 1000;

        /// <summary>settingsModel.ts landuseReachLabel: "1.50x".</summary>
        public static string LanduseReachLabel(double scale) => $"{JsText.ToFixed(scale, 2)}x";

        /// <summary>settingsModel.ts visibleZoomLabel: "z12".</summary>
        public static string VisibleZoomLabel(double zoom) => $"z{JsText.NumberToString(zoom)}";

        /// <summary>settingsModel.ts landuseRevealLabel: "6 px".</summary>
        public static string LanduseRevealLabel(double px) => $"{JsText.NumberToString(px)} px";

        /// <summary>settingsModel.ts triangleBudgetLabel: "600K", "1.2M".</summary>
        public static string TriangleBudgetLabel(double n) =>
            n >= 1_000_000 ? $"{JsText.ToFixed(n / 1_000_000, 1)}M" : $"{JsText.NumberToString(JsMath.Round(n / 1000))}K";

        /// <summary>settingsModel.ts percentLabel: "50%".</summary>
        public static string PercentLabel(double percent) => $"{JsText.NumberToString(percent)}%";

        /// <summary>settingsModel.ts multiplierLabel: "3x".</summary>
        public static string MultiplierLabel(double multiplier) => $"{JsText.NumberToString(multiplier)}x";

        /// <summary>settingsModel.ts daytimeLabel: "HH:MM".</summary>
        public static string DaytimeLabel(double hours) => SunClock.FormatSunTime(hours);

        /// <summary>settingsModel.ts colourSliderValue: the stored channel in slider units, rounded.</summary>
        public static double ColourSliderValue(ColourAdjust adjust, ColourAdjustGroup group, ColourChannelOption channel) =>
            JsMath.Round(adjust[group][channel.Channel] * channel.Scale);

        /// <summary>settingsModel.ts colourSliderLabel: "45°", "120%".</summary>
        public static string ColourSliderLabel(ColourAdjust adjust, ColourAdjustGroup group, ColourChannelOption channel) =>
            JsText.NumberToString(ColourSliderValue(adjust, group, channel)) + channel.Unit;

        /// <summary>
        /// settingsModel.ts areaOptions: every baked area (the one holding
        /// <paramref name="homeLat"/>/<paramref name="homeLon"/> marked "(home)"),
        /// and the selected one: the saved name if still baked, else home, else the first.
        /// </summary>
        public static (IReadOnlyList<SettingsOption> Options, string Selected) AreaOptions(
            IReadOnlyList<TerrainArea> areas, double homeLat, double homeLon, string saved)
        {
            TerrainArea home = null;
            foreach (TerrainArea a in areas)
            {
                if (PlayArea.AreaContains(a, homeLat, homeLon))
                {
                    home = a;
                    break;
                }
            }
            bool savedBaked = false;
            foreach (TerrainArea a in areas) if (a.Name == saved) savedBaked = true;
            string selected = savedBaked ? saved : home?.Name ?? (areas.Count > 0 ? areas[0].Name : "");
            var options = new List<SettingsOption>();
            foreach (TerrainArea a in areas)
            {
                options.Add(new SettingsOption(a.Name, home != null && a.Name == home.Name ? $"{a.Name} (home)" : a.Name));
            }
            return (options, selected);
        }

        /// <summary>worldLayout.ts PLAY_ORIGIN: the home area is the one holding it.</summary>
        public const double PlayOriginLat = 28.0015;
        public const double PlayOriginLon = -15.3937;
    }
}
