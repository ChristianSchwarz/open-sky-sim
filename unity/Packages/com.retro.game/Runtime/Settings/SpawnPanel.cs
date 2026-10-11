using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading.Tasks;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// settingsModel.ts SpawnMenuState: what the Flight tab shows, labels plus
    /// the selected index of each list. Immutable; every change is a new one.
    /// </summary>
    public sealed class SpawnMenuState
    {
        public IReadOnlyList<string> Aircraft = Array.Empty<string>();
        public int AircraftIndex;
        public IReadOnlyList<string> Liveries = Array.Empty<string>();
        public int LiveryIndex;
        public IReadOnlyList<string> Airfields = Array.Empty<string>();
        public int AirfieldIndex;

        public SpawnMenuState Clone() => (SpawnMenuState)MemberwiseClone();
    }

    /// <summary>aircraftRegistry.ts AircraftModelGroup: one airframe type and its liveries.</summary>
    public sealed class AircraftModelGroup
    {
        public string Key = "";
        public string Label = "";
        public List<FlyableAircraftDef> Variants = new List<FlyableAircraftDef>();
    }

    /// <summary>The spawn menu's pure helpers (settingsModel.ts, aircraftRegistry.ts groupAircraftByModel).</summary>
    public static class SpawnMenu
    {
        /// <summary>
        /// String.prototype.localeCompare as the web game sorts aircraft names:
        /// the invariant culture's collation, which is ICU root order on .NET
        /// with ICU (what V8 uses too) for the names the packs carry.
        /// </summary>
        public static int LocaleCompare(string a, string b) =>
            string.Compare(a, b, CultureInfo.InvariantCulture, CompareOptions.None);

        /// <summary>
        /// aircraftRegistry.ts groupAircraftByModel: defs grouped by
        /// canonicalName ?? id, labelled modelName ?? name; liveries sorted by
        /// liveryName ?? name and groups by label (both stable).
        /// </summary>
        public static List<AircraftModelGroup> GroupAircraftByModel(IEnumerable<FlyableAircraftDef> defs)
        {
            var groups = new List<AircraftModelGroup>();
            var byKey = new Dictionary<string, AircraftModelGroup>();
            foreach (FlyableAircraftDef def in defs)
            {
                string key = def.CanonicalName ?? def.Id;
                if (!byKey.TryGetValue(key, out AircraftModelGroup group))
                {
                    group = new AircraftModelGroup { Key = key, Label = def.ModelName ?? def.Name };
                    byKey[key] = group;
                    groups.Add(group);
                }
                group.Variants.Add(def);
            }
            foreach (AircraftModelGroup group in groups)
            {
                StableSort(group.Variants, (a, b) => LocaleCompare(a.LiveryName ?? a.Name, b.LiveryName ?? b.Name));
            }
            StableSort(groups, (a, b) => LocaleCompare(a.Label, b.Label));
            return groups;
        }

        /// <summary>Array.prototype.sort is stable; List.Sort is not.</summary>
        private static void StableSort<T>(List<T> list, Comparison<T> compare)
        {
            var indexed = new List<(T Item, int Index)>(list.Count);
            for (int i = 0; i < list.Count; i++) indexed.Add((list[i], i));
            indexed.Sort((x, y) =>
            {
                int c = compare(x.Item, y.Item);
                return c != 0 ? c : x.Index.CompareTo(y.Index);
            });
            for (int i = 0; i < list.Count; i++) list[i] = indexed[i].Item;
        }

        /// <summary>The key the airfield picker uses for a choice (ActiveAirfield.cs AirfieldChoice): icao || name.</summary>
        public static string AirfieldKey(AirfieldChoice choice) => JsText.Or(choice.Icao, choice.Name);

        /// <summary>settingsModel.ts airfieldLabel: "GCLP — Gran Canaria (03L/21R, 3100 m)"; no prefix without an ICAO.</summary>
        public static string AirfieldLabel(AirfieldChoice choice)
        {
            string id = JsText.Truthy(choice.Icao) ? $"{choice.Icao} — " : "";
            return $"{id}{choice.Name} ({choice.Ref}, {JsText.NumberToString(JsMath.Round(choice.LengthM))} m)";
        }

        /// <summary>settingsModel.ts airfieldMenu: labels, and the index of the selected key (0 when absent).</summary>
        public static (List<string> Airfields, int AirfieldIndex) AirfieldMenu(
            IReadOnlyList<AirfieldChoice> choices, string selectedKey)
        {
            var labels = new List<string>(choices.Count);
            int index = -1;
            for (int i = 0; i < choices.Count; i++)
            {
                labels.Add(AirfieldLabel(choices[i]));
                if (index < 0 && AirfieldKey(choices[i]) == selectedKey) index = i;
            }
            return (labels, index >= 0 ? index : 0);
        }

        /// <summary>settingsModel.ts aircraftMenu: aircraft and livery labels, both indices clamped into their lists.</summary>
        public static (List<string> Aircraft, int AircraftIndex, List<string> Liveries, int LiveryIndex) AircraftMenu(
            IReadOnlyList<AircraftModelGroup> groups, int modelIndex, int liveryIndex)
        {
            int aircraftIndex = Math.Min(modelIndex, Math.Max(0, groups.Count - 1));
            var liveries = new List<string>();
            // groups[-1] is undefined in JS: no liveries.
            if (aircraftIndex >= 0 && aircraftIndex < groups.Count)
            {
                foreach (FlyableAircraftDef v in groups[aircraftIndex].Variants) liveries.Add(v.LiveryName ?? v.Name);
            }
            var aircraft = new List<string>(groups.Count);
            foreach (AircraftModelGroup g in groups) aircraft.Add(g.Label);
            return (aircraft, aircraftIndex, liveries, Math.Min(liveryIndex, Math.Max(0, liveries.Count - 1)));
        }

        /// <summary>
        /// settingsModel.ts quickSearch: matches that need no network, as the
        /// player types: a coordinate pair, then airfields of every baked area.
        /// </summary>
        public static List<SpawnDestination> QuickSearch(
            string query, IReadOnlyList<AirfieldEntry> entries, IReadOnlyList<TerrainArea> areas, string currentArea)
        {
            var output = new List<SpawnDestination>();
            var coords = SpawnSearch.ParseCoordinates(query);
            if (coords.HasValue)
            {
                output.Add(SpawnSearch.CoordinateDestination(coords.Value.Lat, coords.Value.Lon, areas, currentArea));
            }
            foreach (AirfieldEntry entry in SpawnSearch.SearchAirfields(entries, query))
            {
                output.Add(SpawnSearch.AirfieldDestination(entry, currentArea));
            }
            return output;
        }
    }

    /// <summary>
    /// Place search by name (spawnSearch.ts searchPlaces): the host does the
    /// geocoder request (Nominatim, rate limited) and returns the destinations,
    /// for instance through <see cref="SpawnSearch.PlacesFromNominatim"/>.
    /// </summary>
    public delegate Task<List<SpawnDestination>> PlaceSearch(string query, IReadOnlyList<TerrainArea> areas, string currentArea);

    /// <summary>
    /// spawnPanel.ts SpawnPanel: the spawn menu, the first tab of the settings
    /// dialog. It has no UI of its own: the dialog reads <see cref="State"/>
    /// and reports choices back through it, and the game hears them through
    /// the callbacks given here.
    /// </summary>
    public sealed class SpawnPanel
    {
        private readonly Action<int> onModelSelect;
        private readonly Action<int> onLiverySelect;
        private readonly Action<string> onAirfieldSelect;
        private readonly Action<SpawnMode> onSpawn;
        private readonly Action<SpawnDestination> onDestination;
        private readonly Action onOpened;
        private readonly Action onClosed;
        private readonly Action<SettingsTab?> show;
        private readonly Action hide;
        private readonly PlaceSearch placeSearch;
        private readonly ListenerSet<Action<SpawnMenuState>> listeners = new ListenerSet<Action<SpawnMenuState>>();
        private IReadOnlyList<AirfieldChoice> airfieldChoices = Array.Empty<AirfieldChoice>();
        private IReadOnlyList<AirfieldEntry> searchEntries = Array.Empty<AirfieldEntry>();
        private IReadOnlyList<TerrainArea> searchAreas = Array.Empty<TerrainArea>();
        private string currentArea = "";
        private SpawnMenuState state = new SpawnMenuState();

        /// <param name="show">Opens the settings dialog on a tab (settingsLauncher.ts openSettingsDialog).</param>
        /// <param name="hide">Closes the settings dialog (closeSettingsDialog).</param>
        /// <param name="placeSearch">The geocoder; null finds no places.</param>
        public SpawnPanel(
            Action<int> onModelSelect,
            Action<int> onLiverySelect,
            Action<string> onAirfieldSelect,
            Action<SpawnMode> onSpawn,
            Action<SpawnDestination> onDestination,
            Action onOpened,
            Action onClosed,
            Action<SettingsTab?> show = null,
            Action hide = null,
            PlaceSearch placeSearch = null)
        {
            this.onModelSelect = onModelSelect;
            this.onLiverySelect = onLiverySelect;
            this.onAirfieldSelect = onAirfieldSelect;
            this.onSpawn = onSpawn;
            this.onDestination = onDestination;
            this.onOpened = onOpened;
            this.onClosed = onClosed;
            this.show = show;
            this.hide = hide;
            this.placeSearch = placeSearch;
        }

        public SpawnMenuState State => state;

        public SpawnMenuState GetState() => state;

        /// <summary>Calls <paramref name="listener"/> on every change; returns the unsubscribe.</summary>
        public Action Subscribe(Action<SpawnMenuState> listener)
        {
            listeners.Add(listener);
            return () => listeners.Remove(listener);
        }

        public void SelectModel(int index) => onModelSelect?.Invoke(index);

        public void SelectLivery(int index) => onLiverySelect?.Invoke(index);

        public void SelectAirfield(int index)
        {
            if (index < 0 || index >= airfieldChoices.Count) return;
            AirfieldChoice choice = airfieldChoices[index];
            Update(s => s.AirfieldIndex = index);
            onAirfieldSelect?.Invoke(SpawnMenu.AirfieldKey(choice));
        }

        public void Spawn(SpawnMode mode) => onSpawn?.Invoke(mode);

        /// <summary>What the search box searches: every baked area's airfields, and the areas themselves.</summary>
        public void SetSearchIndex(IReadOnlyList<AirfieldEntry> entries, IReadOnlyList<TerrainArea> areas, string area)
        {
            searchEntries = entries;
            searchAreas = areas;
            currentArea = area;
        }

        public List<SpawnDestination> QuickSearch(string query) =>
            SpawnMenu.QuickSearch(query, searchEntries, searchAreas, currentArea);

        /// <summary>Places by name, from the geocoder; only on an explicit search. Empty for a blank query.</summary>
        public Task<List<SpawnDestination>> SearchPlaces(string query)
        {
            if (placeSearch == null || JsText.Trim(query).Length == 0)
            {
                return Task.FromResult(new List<SpawnDestination>());
            }
            return placeSearch(JsText.Trim(query), searchAreas, currentArea);
        }

        /// <summary>
        /// Go to a search result: an airfield becomes the base the start
        /// buttons use, a place starts an airborne flight over it. Either may
        /// reload into another area first. Nothing happens for one with no terrain.
        /// </summary>
        public void GoTo(SpawnDestination destination)
        {
            if (destination.Area != null) onDestination?.Invoke(destination);
        }

        /// <summary>Offer the airfields of the area being flown; the list is hidden when there are none.</summary>
        public void SetAirfields(IReadOnlyList<AirfieldChoice> choices, string selectedKey)
        {
            airfieldChoices = choices;
            var (labels, index) = SpawnMenu.AirfieldMenu(choices, selectedKey);
            Update(s =>
            {
                s.Airfields = labels;
                s.AirfieldIndex = index;
            });
        }

        public void SetSelection(IReadOnlyList<AircraftModelGroup> groups, int modelIndex, int liveryIndex)
        {
            var (aircraft, aircraftIndex, liveries, livery) = SpawnMenu.AircraftMenu(groups, modelIndex, liveryIndex);
            Update(s =>
            {
                s.Aircraft = aircraft;
                s.AircraftIndex = aircraftIndex;
                s.Liveries = liveries;
                s.LiveryIndex = livery;
            });
        }

        /// <summary>Open the settings dialog on the Flight tab.</summary>
        public void Show() => show?.Invoke(SettingsTab.Flight);

        /// <summary>Close the settings dialog: a flight is starting.</summary>
        public void Hide() => hide?.Invoke();

        /// <summary>The settings dialog opened, whichever way.</summary>
        public void NotifyOpened() => onOpened?.Invoke();

        /// <summary>The settings dialog closed, whether by a spawn or not.</summary>
        public void NotifyClosed() => onClosed?.Invoke();

        private void Update(Action<SpawnMenuState> change)
        {
            SpawnMenuState next = state.Clone();
            change(next);
            state = next;
            listeners.ForEach(l => l(next));
        }
    }

    /// <summary>
    /// The aircraft choice the spawn menu edits (game.ts
    /// findSelectionIndices / selectAircraftModel / selectAircraftLivery /
    /// selectAircraftById / refreshAircraftMenu / persistSpawnSelection):
    /// which def is selected, kept on the menu and saved as the aircraftId.
    /// </summary>
    public sealed class AircraftChoice
    {
        private readonly Func<IReadOnlyList<FlyableAircraftDef>> registry;
        private readonly SpawnPanel panel;
        private readonly SettingsStorage storage;

        /// <param name="registry">aircraftRegistry.list(): the defs in registration order.</param>
        public AircraftChoice(Func<IReadOnlyList<FlyableAircraftDef>> registry, SpawnPanel panel, SettingsStorage storage)
        {
            this.registry = registry;
            this.panel = panel;
            this.storage = storage;
        }

        public string SelectedId { get; private set; } = "";

        public List<AircraftModelGroup> Groups() => SpawnMenu.GroupAircraftByModel(registry());

        /// <summary>The selected def, or the first variant of the first group when the id is unknown.</summary>
        public FlyableAircraftDef SelectedDef()
        {
            foreach (FlyableAircraftDef d in registry()) if (d.Id == SelectedId) return d;
            List<AircraftModelGroup> groups = Groups();
            return groups.Count > 0 && groups[0].Variants.Count > 0 ? groups[0].Variants[0] : null;
        }

        /// <summary>game.ts findSelectionIndices: (0, 0) when the id is in no group.</summary>
        public (int ModelIndex, int LiveryIndex) FindSelectionIndices(string id)
        {
            List<AircraftModelGroup> groups = Groups();
            for (int m = 0; m < groups.Count; m++)
            {
                int l = groups[m].Variants.FindIndex(d => d.Id == id);
                if (l >= 0) return (m, l);
            }
            return (0, 0);
        }

        /// <summary>game.ts refreshAircraftMenu: settle on a real def and show the selection.</summary>
        public void RefreshMenu()
        {
            FlyableAircraftDef def = SelectedDef();
            if (def != null) SelectedId = def.Id;
            var (m, l) = FindSelectionIndices(SelectedId);
            panel?.SetSelection(Groups(), m, l);
        }

        /// <summary>game.ts selectAircraftModel: a model's livery (clamped to its last); nothing for an unknown model.</summary>
        public void SelectModel(int modelIndex, int liveryIndex = 0)
        {
            List<AircraftModelGroup> groups = Groups();
            if (modelIndex < 0 || modelIndex >= groups.Count) return;
            List<FlyableAircraftDef> variants = groups[modelIndex].Variants;
            // variants[Math.min(i, n - 1)]: a negative index finds nothing in JS.
            int i = Math.Min(liveryIndex, variants.Count - 1);
            if (i < 0) return;
            SelectedId = variants[i].Id;
            RefreshMenu();
            Persist();
        }

        /// <summary>game.ts selectAircraftLivery: another livery of the selected model.</summary>
        public void SelectLivery(int liveryIndex) => SelectModel(FindSelectionIndices(SelectedId).ModelIndex, liveryIndex);

        /// <summary>game.ts selectAircraftById: the id if registered, else the fallback if registered, else unchanged.</summary>
        public void SelectById(string id, string fallbackId = null)
        {
            if (Has(id)) SelectedId = id;
            else if (fallbackId != null && Has(fallbackId)) SelectedId = fallbackId;
            RefreshMenu();
            Persist();
        }

        /// <summary>game.ts persistSpawnSelection: the aircraft id, and the spawn mode when one is given.</summary>
        public void Persist(SpawnMode? spawnMode = null)
        {
            string id = SelectedId;
            storage?.Update(s =>
            {
                s.AircraftId = id;
                if (spawnMode.HasValue) s.SpawnMode = spawnMode.Value;
            });
        }

        private bool Has(string id)
        {
            foreach (FlyableAircraftDef d in registry()) if (d.Id == id) return true;
            return false;
        }
    }
}
