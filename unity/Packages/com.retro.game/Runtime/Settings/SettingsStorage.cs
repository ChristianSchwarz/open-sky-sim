using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Retro.Core;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>
    /// settingsStorage.ts AppSettings: everything the game remembers between
    /// sessions. Fields are written in this order, under the TS names given
    /// on each. Values written through <see cref="SettingsStorage.Update"/> are
    /// stored as given; <see cref="SettingsStorage.Load"/> validates on the way
    /// back in, field by field, and a field that fails is its default.
    /// </summary>
    public sealed class AppSettings
    {
        /// <summary>techProfile: one of <see cref="TechProfiles.All"/> (default HD).</summary>
        public string TechProfile = TechProfiles.HD;
        /// <summary>flightModel: "FM2", "FM3" or "DEBUG" (default FM2).</summary>
        public string FlightModel = "FM2";
        /// <summary>keyboardLayout: stored as its number 0..4 (default ARROWS = 4).</summary>
        public KeyboardControlLayoutId KeyboardLayout = KeyboardControlLayoutId.ARROWS;
        /// <summary>keyboardPitchStickMode: stored as its number 0..1 (default LAYOUT_DEFAULT = 0).</summary>
        public KeyboardPitchStickMode KeyboardPitchStickMode = KeyboardPitchStickMode.LAYOUT_DEFAULT;
        /// <summary>aiPilotModel: CLASSIC, SHAW, AGGRESSIVE or ACE (default CLASSIC).</summary>
        public AiPilotModels AiPilotModel = AiPilotModels.CLASSIC;
        /// <summary>terrainColour: LANDCOVER, SWATCH, HYBRID or IMAGERY (default HYBRID).</summary>
        public TerrainColours TerrainColour = TerrainColours.HYBRID;
        /// <summary>terrainShading: FACETED or SMOOTH (default FACETED).</summary>
        public TerrainShading TerrainShading = TerrainShading.FACETED;
        /// <summary>landuseBlend: 0..1 (default 0.5).</summary>
        public double LanduseBlend = LanduseBlendSetting.Default;
        /// <summary>treeDensity: 0..20 (default 1).</summary>
        public double TreeDensity = TreeBillboards.DensityMultiplierDefault;
        /// <summary>colourAdjust: per group hue/saturation/brightness (default as authored).</summary>
        public ColourAdjust ColourAdjust = ColourAdjust.Default;
        /// <summary>aircraftId: last aircraft (+ livery) id, 1..199 UTF-16 units (default "f22").</summary>
        public string AircraftId = "f22";
        /// <summary>spawnMode: last start mode, by its TS name (default "headon").</summary>
        public SpawnMode SpawnMode = SpawnMode.Headon;
        /// <summary>daytime: hours, [0, 24) (default 14).</summary>
        public double Daytime = SunClock.DefaultSunHours;
        /// <summary>terrainArea: baked area name, any string; "" is home (default "").</summary>
        public string TerrainArea = "";
        /// <summary>terrainDetailDistanceM: metres, any number; null is off (default 12000).</summary>
        public double? TerrainDetailDistanceM = Lod.TerrainDetailDistanceDefaultM;
        /// <summary>landuseReach: 1..10 (default 1.5).</summary>
        public double LanduseReach = Lod.LeafRefineDistanceScale;
        /// <summary>visibleZoom: an integer 5..12 (default 12).</summary>
        public double VisibleZoom = Lod.TerrainVisibleZoomMax;
        /// <summary>landuseRevealPx: 1..24 (default 6).</summary>
        public double LanduseRevealPx = Lod.LanduseRevealMinPx;
        /// <summary>terrainTriangleBudget: 200000..4000000 (default 600000).</summary>
        public double TerrainTriangleBudget = Lod.TerrainTriangleBudget;
        /// <summary>farTileTextures (default true).</summary>
        public bool FarTileTextures = true;
        /// <summary>buildings (default true).</summary>
        public bool Buildings = true;
        /// <summary>roads: OFF, MAJOR or ALL (default ALL).</summary>
        public RoadsMode Roads = RoadsMode.All;
        /// <summary>renderScale: one of <see cref="RenderScaleSetting.RenderScales"/> (default 1).</summary>
        public double RenderScale = 1;
        /// <summary>supersampling (default false).</summary>
        public bool Supersampling;
        /// <summary>volume: master volume 0..1 (default 0.7).</summary>
        public double Volume = 0.7;

        /// <summary>The TS field names, in the order JSON.stringify writes them.</summary>
        public static readonly IReadOnlyList<string> FieldNames = new[]
        {
            "techProfile", "flightModel", "keyboardLayout", "keyboardPitchStickMode", "aiPilotModel", "terrainColour",
            "terrainShading", "landuseBlend", "treeDensity", "colourAdjust", "aircraftId", "spawnMode", "daytime",
            "terrainArea", "terrainDetailDistanceM", "landuseReach", "visibleZoom", "landuseRevealPx",
            "terrainTriangleBudget", "farTileTextures", "buildings", "roads", "renderScale", "supersampling", "volume",
        };

        public AppSettings Clone() => (AppSettings)MemberwiseClone();
    }

    /// <summary>
    /// Where settings live: the web game's window.localStorage, as an
    /// interface. Unity backs it with <see cref="JsonFileKeyValueStore"/>.
    /// Any member may throw (a full disk, a locked file); the settings code
    /// catches that the way the TS catches quota and private-mode failures.
    /// </summary>
    public interface IKeyValueStore
    {
        /// <summary>The stored string, or null when there is none.</summary>
        string GetItem(string key);

        void SetItem(string key, string value);

        void RemoveItem(string key);
    }

    /// <summary>A store that lasts as long as the object (tests, or a session that must not persist).</summary>
    public sealed class MemoryKeyValueStore : IKeyValueStore
    {
        private readonly Dictionary<string, string> items = new Dictionary<string, string>();

        public string GetItem(string key) => items.TryGetValue(key, out string v) ? v : null;

        public void SetItem(string key, string value) => items[key] = value ?? "null";

        public void RemoveItem(string key) => items.Remove(key);
    }

    /// <summary>
    /// A localStorage kept in one JSON file: a flat object from key to stored
    /// string. A stored string that is itself a JSON object or array (as the
    /// settings are) is written as that JSON, so the file reads naturally:
    /// <c>{"retroflightsim.settings": {"techProfile": "HD", ...}}</c>. That is
    /// only done when writing it back out reproduces the stored string exactly,
    /// so every value round-trips byte for byte; anything else is a JSON string.
    /// A missing or unreadable file is an empty store. Every write rewrites the
    /// whole file (through a temporary file, then a replace).
    /// </summary>
    public sealed class JsonFileKeyValueStore : IKeyValueStore
    {
        private readonly string path;
        private Dictionary<string, string> items;
        private List<string> order;

        public JsonFileKeyValueStore(string path)
        {
            this.path = path ?? throw new ArgumentNullException(nameof(path));
        }

        public string Path => path;

        public string GetItem(string key)
        {
            EnsureLoaded();
            return items.TryGetValue(key, out string v) ? v : null;
        }

        public void SetItem(string key, string value)
        {
            EnsureLoaded();
            value ??= "null";
            if (!items.ContainsKey(key)) order.Add(key);
            items[key] = value;
            Write();
        }

        public void RemoveItem(string key)
        {
            EnsureLoaded();
            if (!items.Remove(key)) return;
            order.Remove(key);
            Write();
        }

        /// <summary>Forget what was read, so the next access reads the file again.</summary>
        public void Reload()
        {
            items = null;
            order = null;
        }

        /// <summary>The file's text for a set of entries (what <see cref="SetItem"/> writes).</summary>
        public static string Format(IEnumerable<KeyValuePair<string, string>> entries)
        {
            var sb = new StringBuilder();
            sb.Append("{\n");
            bool first = true;
            foreach (KeyValuePair<string, string> e in entries)
            {
                if (!first) sb.Append(",\n");
                first = false;
                sb.Append("  ");
                JsJsonWriter.AppendString(sb, e.Key);
                sb.Append(": ");
                string embedded = Embeddable(e.Value);
                if (embedded != null) sb.Append(embedded);
                else JsJsonWriter.AppendString(sb, e.Value);
            }
            sb.Append(first ? "}\n" : "\n}\n");
            return sb.ToString();
        }

        /// <summary>The entries a file's text holds; empty for anything that is not a JSON object.</summary>
        public static List<KeyValuePair<string, string>> Parse(string text)
        {
            var output = new List<KeyValuePair<string, string>>();
            JsonValue root;
            try
            {
                root = JsonReader.Parse(text);
            }
            catch (FormatException)
            {
                return output;
            }
            if (root.Kind != JsonKind.Object) return output;
            foreach (string key in root.Keys)
            {
                JsonValue v = root[key];
                output.Add(new KeyValuePair<string, string>(key,
                    v.Kind == JsonKind.String ? v.AsString : JsJsonWriter.Stringify(v)));
            }
            return output;
        }

        /// <summary>The value as raw JSON, when it is an object or array that stringifies back to itself.</summary>
        private static string Embeddable(string value)
        {
            if (value.Length == 0 || (value[0] != '{' && value[0] != '[')) return null;
            try
            {
                JsonValue v = JsonReader.Parse(value);
                return JsJsonWriter.Stringify(v) == value ? value : null;
            }
            catch (FormatException)
            {
                return null;
            }
        }

        private void EnsureLoaded()
        {
            if (items != null) return;
            items = new Dictionary<string, string>();
            order = new List<string>();
            string text = null;
            try
            {
                if (File.Exists(path)) text = File.ReadAllText(path, Encoding.UTF8);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
            if (text == null) return;
            foreach (KeyValuePair<string, string> e in Parse(text))
            {
                if (!items.ContainsKey(e.Key)) order.Add(e.Key);
                items[e.Key] = e.Value;
            }
        }

        private void Write()
        {
            var entries = new List<KeyValuePair<string, string>>();
            foreach (string key in order) entries.Add(new KeyValuePair<string, string>(key, items[key]));
            string dir = System.IO.Path.GetDirectoryName(System.IO.Path.GetFullPath(path));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, Format(entries), new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }
    }

    /// <summary>
    /// settingsStorage.ts: the settings as one JSON string under
    /// <see cref="StorageKey"/>, read with per-field validation and written
    /// back whole.
    /// </summary>
    public sealed class SettingsStorage
    {
        /// <summary>settingsStorage.ts STORAGE_KEY.</summary>
        public const string StorageKey = "retroflightsim.settings";

        private readonly IKeyValueStore store;

        public SettingsStorage(IKeyValueStore store)
        {
            this.store = store ?? throw new ArgumentNullException(nameof(store));
        }

        public IKeyValueStore Store => store;

        /// <summary>A fresh copy of the defaults (settingsStorage.ts DEFAULT_SETTINGS).</summary>
        public static AppSettings Defaults() => new AppSettings();

        /// <summary>settingsStorage.ts loadSettings: never throws; anything unusable is its default.</summary>
        public AppSettings Load()
        {
            try
            {
                return Parse(store.GetItem(StorageKey));
            }
            catch (Exception)
            {
                return Defaults();
            }
        }

        /// <summary>
        /// settingsStorage.ts updateSettings: load, apply <paramref name="change"/>
        /// (the TS partial), save, and return the result. Nothing is validated
        /// on the way out; an out-of-range value is stored and fails on the next load.
        /// </summary>
        public AppSettings Update(Action<AppSettings> change)
        {
            AppSettings next = Load();
            change?.Invoke(next);
            Save(next);
            return next;
        }

        /// <summary>settingsStorage.ts saveSettings: failures are ignored, the settings still apply for the session.</summary>
        public void Save(AppSettings settings)
        {
            try
            {
                store.SetItem(StorageKey, Serialize(settings));
            }
            catch (Exception)
            {
                // Ignore quota / disk failures, as the TS does.
            }
        }

        /// <summary>JSON.stringify(settings): every field, in <see cref="AppSettings.FieldNames"/> order.</summary>
        public static string Serialize(AppSettings s)
        {
            var w = new JsJsonWriter();
            w.BeginObject();
            w.Key("techProfile").String(s.TechProfile);
            w.Key("flightModel").String(s.FlightModel);
            w.Key("keyboardLayout").Number((int)s.KeyboardLayout);
            w.Key("keyboardPitchStickMode").Number((int)s.KeyboardPitchStickMode);
            w.Key("aiPilotModel").String(SettingsCodec.Name(s.AiPilotModel));
            w.Key("terrainColour").String(SettingsCodec.Name(s.TerrainColour));
            w.Key("terrainShading").String(SettingsCodec.Name(s.TerrainShading));
            w.Key("landuseBlend").Number(s.LanduseBlend);
            w.Key("treeDensity").Number(s.TreeDensity);
            w.Key("colourAdjust");
            (s.ColourAdjust ?? ColourAdjust.Default).WriteJson(w);
            w.Key("aircraftId").String(s.AircraftId);
            w.Key("spawnMode").String(SettingsCodec.Name(s.SpawnMode));
            w.Key("daytime").Number(s.Daytime);
            w.Key("terrainArea").String(s.TerrainArea);
            w.Key("terrainDetailDistanceM");
            if (s.TerrainDetailDistanceM.HasValue) w.Number(s.TerrainDetailDistanceM.Value);
            else w.Null();
            w.Key("landuseReach").Number(s.LanduseReach);
            w.Key("visibleZoom").Number(s.VisibleZoom);
            w.Key("landuseRevealPx").Number(s.LanduseRevealPx);
            w.Key("terrainTriangleBudget").Number(s.TerrainTriangleBudget);
            w.Key("farTileTextures").Bool(s.FarTileTextures);
            w.Key("buildings").Bool(s.Buildings);
            w.Key("roads").String(SettingsCodec.Name(s.Roads));
            w.Key("renderScale").Number(s.RenderScale);
            w.Key("supersampling").Bool(s.Supersampling);
            w.Key("volume").Number(s.Volume);
            w.EndObject();
            return w.ToString();
        }

        /// <summary>
        /// The loadSettings body for one stored string: null, empty, unparsable
        /// or a non-object is all defaults; otherwise each field is taken when
        /// it passes its check and is its default when it does not. Unknown
        /// keys are dropped (there are no migrations of old keys in the TS).
        /// </summary>
        public static AppSettings Parse(string raw)
        {
            var d = Defaults();
            if (string.IsNullOrEmpty(raw)) return d;
            JsonValue p;
            try
            {
                p = JsonReader.Parse(raw);
            }
            catch (FormatException)
            {
                return d;
            }
            // `null.x` throws (all defaults); any other non-object reads every field as undefined.
            if (p.Kind != JsonKind.Object) return d;

            var s = new AppSettings();
            JsonValue v;

            v = p["techProfile"];
            if (v.Kind == JsonKind.String && Contains(TechProfiles.All, v.AsString)) s.TechProfile = v.AsString;
            v = p["flightModel"];
            if (v.Kind == JsonKind.String && Contains(ConfigService.FlightModelIds, v.AsString)) s.FlightModel = v.AsString;
            v = p["keyboardLayout"];
            if (v.Kind == JsonKind.Number && SettingsCodec.IsKeyboardLayout(v.AsNumber)) s.KeyboardLayout = (KeyboardControlLayoutId)(int)v.AsNumber;
            v = p["keyboardPitchStickMode"];
            if (v.Kind == JsonKind.Number && SettingsCodec.IsPitchStickMode(v.AsNumber)) s.KeyboardPitchStickMode = (KeyboardPitchStickMode)(int)v.AsNumber;
            v = p["aiPilotModel"];
            if (v.Kind == JsonKind.String && SettingsCodec.TryParse(v.AsString, out AiPilotModels ai)) s.AiPilotModel = ai;
            v = p["terrainColour"];
            if (v.Kind == JsonKind.String && SettingsCodec.TryParse(v.AsString, out TerrainColours tc)) s.TerrainColour = tc;
            v = p["terrainShading"];
            if (v.Kind == JsonKind.String && SettingsCodec.TryParse(v.AsString, out TerrainShading ts)) s.TerrainShading = ts;
            v = p["landuseBlend"];
            if (IsNumberIn(v, 0, 1)) s.LanduseBlend = v.AsNumber;
            v = p["treeDensity"];
            if (IsNumberIn(v, TreeBillboards.DensityMultiplierMin, TreeBillboards.DensityMultiplierMax)) s.TreeDensity = v.AsNumber;
            s.ColourAdjust = ColourAdjust.Clamp(p["colourAdjust"]);
            v = p["aircraftId"];
            if (v.Kind == JsonKind.String && v.AsString.Length > 0 && v.AsString.Length < 200) s.AircraftId = v.AsString;
            v = p["spawnMode"];
            if (v.Kind == JsonKind.String && SettingsCodec.TryParse(v.AsString, out SpawnMode sm)) s.SpawnMode = sm;
            v = p["daytime"];
            if (v.Kind == JsonKind.Number && JsText.IsFinite(v.AsNumber) && v.AsNumber >= 0 && v.AsNumber < 24) s.Daytime = v.AsNumber;
            v = p["terrainArea"];
            if (v.Kind == JsonKind.String) s.TerrainArea = v.AsString;
            // null is the top of the slider and a real value; any number at all is taken.
            v = p["terrainDetailDistanceM"];
            if (v.Kind == JsonKind.Null && p.Has("terrainDetailDistanceM")) s.TerrainDetailDistanceM = null;
            else if (v.Kind == JsonKind.Number) s.TerrainDetailDistanceM = v.AsNumber;
            v = p["landuseReach"];
            if (IsNumberIn(v, Lod.LeafRefineDistanceScaleMin, Lod.LeafRefineDistanceScaleMax)) s.LanduseReach = v.AsNumber;
            v = p["visibleZoom"];
            if (v.Kind == JsonKind.Number && v.AsNumber == Math.Floor(v.AsNumber)
                && v.AsNumber >= Lod.TerrainVisibleZoomMin && v.AsNumber <= Lod.TerrainVisibleZoomMax) s.VisibleZoom = v.AsNumber;
            v = p["landuseRevealPx"];
            if (IsNumberIn(v, Lod.LanduseRevealMinPxMin, Lod.LanduseRevealMinPxMax)) s.LanduseRevealPx = v.AsNumber;
            v = p["terrainTriangleBudget"];
            if (IsNumberIn(v, Lod.TerrainTriangleBudgetMin, Lod.TerrainTriangleBudgetMax)) s.TerrainTriangleBudget = v.AsNumber;
            v = p["farTileTextures"];
            if (v.Kind == JsonKind.Bool) s.FarTileTextures = v.AsBool;
            v = p["buildings"];
            if (v.Kind == JsonKind.Bool) s.Buildings = v.AsBool;
            v = p["roads"];
            if (v.Kind == JsonKind.String && SettingsCodec.TryParse(v.AsString, out RoadsMode roads)) s.Roads = roads;
            v = p["renderScale"];
            if (v.Kind == JsonKind.Number && RenderScaleSetting.IsRenderScale(v.AsNumber)) s.RenderScale = v.AsNumber;
            v = p["supersampling"];
            if (v.Kind == JsonKind.Bool) s.Supersampling = v.AsBool;
            v = p["volume"];
            if (IsNumberIn(v, 0, 1)) s.Volume = v.AsNumber;
            return s;
        }

        private static bool IsNumberIn(JsonValue v, double min, double max) =>
            v.Kind == JsonKind.Number && JsText.IsFinite(v.AsNumber) && v.AsNumber >= min && v.AsNumber <= max;

        private static bool Contains(IReadOnlyList<string> list, string s)
        {
            foreach (string x in list) if (x == s) return true;
            return false;
        }
    }
}
