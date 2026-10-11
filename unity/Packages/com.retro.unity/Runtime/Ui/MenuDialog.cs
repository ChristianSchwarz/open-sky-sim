using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using Retro.Core;
using Retro.Game;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;
#if RETRO_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace Retro.Unity
{
    /// <summary>
    /// The game menu (settingsDialog.ts, spawnPanel.ts): a dark rounded dialog
    /// over the paused flight, opened by Esc or the button in the corner, with
    /// tabs along the top. The Flight tab carries the aircraft list, the
    /// airfield and place search (airfields as you type, places from
    /// Nominatim on Enter, at most one request per 1.1 s) and the start
    /// buttons. A pick in another area, or out of reach, restarts the scene
    /// around it, as the web game reloads the page.
    /// </summary>
    public sealed class MenuDialog : MonoBehaviour
    {
        public PlayerFlight flight;
        public TerrainRenderer terrain;

        /// <summary>PlayerPrefs key of a destination carried over a scene restart: "airfield|key" or "place|lat,lon".</summary>
        public const string PendingPref = "retro.pending";

        // The web dialog's look (Angular Material dark + the game's teal).
        public static readonly Color Surface = new Color32(0x15, 0x19, 0x1b, 0xff);
        public static readonly Color Field = new Color32(0x3a, 0x3f, 0x42, 0xff);
        public static readonly Color Text = new Color32(0xe6, 0xe8, 0xea, 0xff);
        public static readonly Color Muted = new Color32(0xa8, 0xad, 0xb0, 0xff);
        public static readonly Color Accent = new Color32(0x00, 0xdc, 0xdc, 0xff);
        public static readonly Color Line = new Color32(0x3a, 0x3f, 0x42, 0xff);

        private UIDocument document;
        private VisualElement overlay, tabBar, page;
        private Button menuButton;
        private readonly List<(string Name, Func<VisualElement> Build, Button Tab)> tabs = new List<(string, Func<VisualElement>, Button)>();
        private int activeTab;
        private readonly Dictionary<string, Func<VisualElement>> overrides = new Dictionary<string, Func<VisualElement>>();
        private bool open;
        private TextField search;
        private VisualElement results;
        private List<AirfieldEntry> airfieldEntries;
        private List<TerrainArea> areas;
        private string currentArea;
        private float lastNominatim = -10;
        private string placeStatus = "idle";
        private readonly List<SpawnDestination> placeResults = new List<SpawnDestination>();

        public bool IsOpen => open;

        private void Start()
        {
            document = gameObject.AddComponent<UIDocument>();
            document.panelSettings = Resources.Load<PanelSettings>("RetroPanelSettings");
            VisualElement root = document.rootVisualElement;
            root.style.flexGrow = 1;
            root.pickingMode = PickingMode.Ignore;

            menuButton = new Button(() => SetOpen(!open)) { text = "⋮" };
            Style(menuButton, s =>
            {
                s.position = Position.Absolute;
                s.left = 12;
                s.top = 12;
                s.width = 40;
                s.height = 40;
                s.fontSize = 22;
                s.unityFontStyleAndWeight = FontStyle.Bold;
                s.backgroundColor = new Color(0, 0, 0, 0.85f);
                s.color = Color.white;
                Round(s, 20);
                NoBorder(s);
            });
            root.Add(menuButton);

            overlay = new VisualElement();
            Style(overlay, s =>
            {
                s.position = Position.Absolute;
                s.left = s.right = s.top = s.bottom = 0;
                s.alignItems = Align.Center;
                s.justifyContent = Justify.Center;
                s.backgroundColor = new Color(0, 0, 0, 0.25f);
            });
            root.Add(overlay);

            var dialog = new VisualElement();
            Style(dialog, s =>
            {
                s.width = Length.Percent(80);
                s.maxWidth = 880;
                s.height = Length.Percent(82);
                s.backgroundColor = Surface;
                Round(s, 24);
                s.paddingLeft = s.paddingRight = 24;
                s.paddingTop = 22;
                s.paddingBottom = 14;
                s.flexDirection = FlexDirection.Column;
            });
            overlay.Add(dialog);

            dialog.Add(Label("Settings", 22, Text));
            tabBar = new VisualElement();
            Style(tabBar, s =>
            {
                s.flexDirection = FlexDirection.Row;
                s.marginTop = 16;
                s.borderBottomWidth = 1;
                s.borderBottomColor = Line;
                s.flexShrink = 0;
            });
            dialog.Add(tabBar);

            var scroll = new ScrollView(ScrollViewMode.Vertical);
            Style(scroll, s =>
            {
                s.flexGrow = 1;
                s.marginTop = 16;
            });
            page = scroll.contentContainer;
            dialog.Add(scroll);

            var footer = new VisualElement();
            Style(footer, s =>
            {
                s.flexDirection = FlexDirection.Row;
                s.justifyContent = Justify.FlexEnd;
                s.flexShrink = 0;
                s.marginTop = 8;
            });
            footer.Add(TextButton("Close", () => SetOpen(false)));
            dialog.Add(footer);

            AddTab("Flight", BuildFlightTab);
            foreach (string name in new[] { "Graphics", "Colours", "World", "Simulation", "General", "Help", "About" })
            {
                AddTab(name, () => Label("(not ported yet)", 14, Muted));
            }
            SelectTab(0);
            SetOpen(false);
        }

        /// <summary>A tab whose page is built each time it is shown.</summary>
        public void AddTab(string name, Func<VisualElement> build)
        {
            int index = tabs.Count;
            if (overrides.TryGetValue(name, out Func<VisualElement> given)) build = given;
            var tab = new Button(() => SelectTab(index)) { text = name };
            Style(tab, s =>
            {
                s.flexGrow = 1;
                s.backgroundColor = Color.clear;
                s.color = Text;
                s.fontSize = 14;
                s.height = 40;
                NoBorder(s);
                s.borderBottomWidth = 2;
                s.borderBottomColor = Color.clear;
            });
            tabBar.Add(tab);
            tabs.Add((name, build, tab));
        }

        /// <summary>Replace a tab's page builder (the settings model fills the other tabs).</summary>
        public void SetTab(string name, Func<VisualElement> build)
        {
            // Before the tabs exist (another component's Start ran first): used when the tab is added.
            overrides[name] = build;
            for (int i = 0; i < tabs.Count; i++)
            {
                if (tabs[i].Name != name) continue;
                tabs[i] = (name, build, tabs[i].Tab);
                if (i == activeTab && open) SelectTab(i);
            }
        }

        private void SelectTab(int index)
        {
            activeTab = index;
            for (int i = 0; i < tabs.Count; i++)
            {
                tabs[i].Tab.style.borderBottomColor = i == index ? Accent : Color.clear;
                tabs[i].Tab.style.color = i == index ? Accent : Text;
            }
            page.Clear();
            page.Add(tabs[index].Build());
        }

        public void SetOpen(bool value)
        {
            open = value;
            overlay.style.display = value ? DisplayStyle.Flex : DisplayStyle.None;
            if (flight != null) flight.menuOpen = value;
            if (value) SelectTab(activeTab);
        }

        private void Update()
        {
            ConsumePending();
#if RETRO_INPUT_SYSTEM
            Keyboard k = Keyboard.current;
            if (k == null) return;
            if (k.escapeKey.wasPressedThisFrame) SetOpen(!open);
            // The start buttons' digits, while nothing is being typed.
            if (open && (search == null || search.focusController?.focusedElement != search))
            {
                foreach (SpawnMode mode in StartModes)
                {
                    if (k[Key.Digit1 + (SpawnKeys.Digit(mode) - 1)].wasPressedThisFrame) Start(mode);
                }
            }
#endif
        }

        // --- Flight tab ------------------------------------------------------------------

        /// <summary>The spawn menu's start buttons (the barricade start is gone).</summary>
        private static readonly SpawnMode[] StartModes =
        {
            SpawnMode.Approach, SpawnMode.Runway, SpawnMode.Headon, SpawnMode.Carrier,
            SpawnMode.CarrierTakeoff, SpawnMode.HighAlt, SpawnMode.Space, SpawnMode.CloseWing,
        };

        private static string StartLabel(SpawnMode mode) => mode switch
        {
            SpawnMode.Approach => "Approach (1)",
            SpawnMode.Runway => "Runway (2)",
            SpawnMode.Headon => "Head-on (3)",
            SpawnMode.Carrier => "Carrier land (4)",
            SpawnMode.CarrierTakeoff => "Carrier TO (5)",
            SpawnMode.HighAlt => "10 km (6)",
            SpawnMode.Space => "Space (7)",
            SpawnMode.CloseWing => "Wingtip (9)",
            _ => mode.ToString(),
        };

        private void Start(SpawnMode mode)
        {
            flight.BeginFlight(mode);
            SetOpen(false);
        }

        private VisualElement BuildFlightTab()
        {
            var col = new VisualElement();
            col.Add(Label("Aircraft", 15, Text));
            var list = new ScrollView(ScrollViewMode.Vertical);
            Style(list, s =>
            {
                s.height = 96;
                s.marginTop = 6;
                s.marginBottom = 12;
            });
            if (flight.Catalogue != null)
            {
                foreach (AircraftCatalogue.Entry e in flight.Catalogue)
                {
                    string id = e.Def.Id;
                    bool selected = flight.aircraftId == id;
                    var row = new Button(() =>
                    {
                        flight.aircraftId = id;
                        SelectTab(activeTab);
                    }) { text = (selected ? "◉  " : "○  ") + e.Def.Name };
                    Style(row, s =>
                    {
                        s.backgroundColor = Color.clear;
                        s.color = selected ? Accent : Text;
                        s.unityTextAlign = TextAnchor.MiddleLeft;
                        s.fontSize = 14;
                        s.height = 30;
                        NoBorder(s);
                    });
                    list.Add(row);
                }
            }
            col.Add(list);

            var searchRow = new VisualElement();
            Style(searchRow, s => s.flexDirection = FlexDirection.Row);
            search = new TextField { label = "" };
            search.textEdition.placeholder = "Find an airfield or place (ICAO, name, town, or lat, lon)";
            Style(search, s =>
            {
                s.flexGrow = 1;
                s.height = 44;
                s.fontSize = 15;
            });
            StyleInput(search);
            search.RegisterValueChangedCallback(_ =>
            {
                placeStatus = "idle";
                placeResults.Clear();
                ShowResults();
            });
            search.RegisterCallback<KeyDownEvent>(ev =>
            {
                if (ev.keyCode == KeyCode.Return || ev.keyCode == KeyCode.KeypadEnter) SearchPlaces();
            }, TrickleDown.TrickleDown);
            searchRow.Add(search);
            searchRow.Add(OutlineButton("Search", SearchPlaces));
            col.Add(searchRow);
            col.Add(Label("Airfields match as you type; Enter also looks up places.", 12, Muted));
            results = new VisualElement();
            col.Add(results);
            ShowResults();

            var start = Label("Start", 15, Text);
            start.style.marginTop = 14;
            col.Add(start);
            var grid = new VisualElement();
            Style(grid, s =>
            {
                s.flexDirection = FlexDirection.Row;
                s.flexWrap = Wrap.Wrap;
                s.marginTop = 8;
            });
            foreach (SpawnMode mode in StartModes)
            {
                SpawnMode m = mode;
                var b = new Button(() => Start(m)) { text = StartLabel(m) };
                Style(b, s =>
                {
                    s.width = Length.Percent(23);
                    s.height = 34;
                    s.marginRight = Length.Percent(2);
                    s.marginBottom = 8;
                    s.backgroundColor = Accent;
                    s.color = (Color)new Color32(0x06, 0x2a, 0x2a, 0xff);
                    s.fontSize = 13;
                    Round(s, 17);
                    NoBorder(s);
                });
                grid.Add(b);
            }
            col.Add(grid);
            if (flight.BaseRunway != null)
            {
                SceneRunway r = flight.BaseRunway;
                col.Add(Label($"Base: {JsText.Or(r.Icao, r.Name)} {r.Name} runway {r.Ref}", 12, Muted));
            }
            return col;
        }

        private void EnsureSearchData()
        {
            if (airfieldEntries != null) return;
            airfieldEntries = new List<AirfieldEntry>();
            string path = System.IO.Path.Combine(terrain.Root, "airfields.json");
            if (System.IO.File.Exists(path))
            {
                foreach (Airfield a in AirfieldsJson.Parse(System.IO.File.ReadAllText(path)).Items)
                {
                    airfieldEntries.Add(SpawnSearch.AirfieldEntryOf(a));
                }
            }
            areas = terrain.Areas();
            currentArea = SpawnSearch.AreaAt(areas, terrain.OriginLat, terrain.OriginLon);
        }

        /// <summary>The drop-down under the search field: airfields, then places.</summary>
        private void ShowResults()
        {
            if (results == null) return;
            results.Clear();
            string q = search?.value?.Trim() ?? "";
            if (q.Length == 0) return;
            EnsureSearchData();
            var quick = new List<SpawnDestination>();
            (double Lat, double Lon)? coords = SpawnSearch.ParseCoordinates(q);
            if (coords.HasValue)
            {
                quick.Add(SpawnSearch.CoordinateDestination(coords.Value.Lat, coords.Value.Lon, areas, currentArea));
            }
            foreach (AirfieldEntry e in SpawnSearch.SearchAirfields(airfieldEntries, q))
            {
                quick.Add(SpawnSearch.AirfieldDestination(e, currentArea));
            }
            if (quick.Count > 0)
            {
                results.Add(Label("Airfields", 12, Muted));
                foreach (SpawnDestination d in quick) results.Add(ResultRow(d));
            }
            results.Add(Label("Places", 12, Muted));
            foreach (SpawnDestination d in placeResults) results.Add(ResultRow(d));
            string status = placeStatus switch
            {
                "idle" => "Press Enter to look up places",
                "searching" => "Searching…",
                "none" => "No places found",
                "error" => "Place search failed",
                _ => null,
            };
            if (status != null) results.Add(Label(status, 13, Muted));
        }

        private VisualElement ResultRow(SpawnDestination d)
        {
            var row = new Button(() => GoTo(d));
            row.SetEnabled(d.Area != null);
            Style(row, s =>
            {
                s.backgroundColor = Field;
                s.color = Text;
                s.unityTextAlign = TextAnchor.MiddleLeft;
                s.flexDirection = FlexDirection.Column;
                s.alignItems = Align.FlexStart;
                s.marginTop = 2;
                s.paddingTop = s.paddingBottom = 4;
                NoBorder(s);
            });
            row.Add(Label(d.Label, 14, Text));
            row.Add(Label(d.Detail, 11, Muted));
            return row;
        }

        /// <summary>game.ts goToDestination.</summary>
        private void GoTo(SpawnDestination d)
        {
            if (d.Area == null) return;
            bool here = d.Area == currentArea;
            if (here && d.Kind == SpawnDestinationKind.Airfield && d.AirfieldKey != null && flight.SelectAirfield(d.AirfieldKey))
            {
                // An airfield becomes the base the start buttons use.
                search.value = "";
                SelectTab(activeTab);
                return;
            }
            if (here && d.Kind != SpawnDestinationKind.Airfield)
            {
                flight.BeginFlightAt(d.Lat, d.Lon);
                SetOpen(false);
                return;
            }
            // Another area, or an airfield beyond the ones in reach: restart around it.
            var inv = CultureInfo.InvariantCulture;
            PlayerPrefs.SetString(SpikeBootstrap.SpawnPref, d.Lat.ToString("R", inv) + "," + d.Lon.ToString("R", inv));
            PlayerPrefs.SetString(PendingPref, d.Kind == SpawnDestinationKind.Airfield
                ? "airfield|" + d.AirfieldKey
                : "place|" + d.Lat.ToString("R", inv) + "," + d.Lon.ToString("R", inv));
            PlayerPrefs.Save();
            flight.menuOpen = false;
            SceneManager.LoadScene(SceneManager.GetActiveScene().buildIndex);
        }

        /// <summary>After a restart: the airfield picked becomes the base, a place starts a flight over it.</summary>
        private void ConsumePending()
        {
            if (flight == null || flight.Sim == null) return;
            string pending = PlayerPrefs.GetString(PendingPref, "");
            if (pending.Length == 0) return;
            PlayerPrefs.DeleteKey(PendingPref);
            string[] parts = pending.Split('|');
            if (parts.Length != 2) return;
            if (parts[0] == "airfield")
            {
                if (flight.SelectAirfield(parts[1])) flight.BeginFlight(flight.spawnMode);
                return;
            }
            string[] ll = parts[1].Split(',');
            var inv = CultureInfo.InvariantCulture;
            if (ll.Length == 2 && double.TryParse(ll[0], NumberStyles.Float, inv, out double lat)
                && double.TryParse(ll[1], NumberStyles.Float, inv, out double lon))
            {
                flight.BeginFlightAt(lat, lon);
            }
        }

        private void SearchPlaces()
        {
            string q = search?.value?.Trim() ?? "";
            if (q.Length == 0 || placeStatus == "searching") return;
            StartCoroutine(Nominatim(q));
        }

        /// <summary>One Nominatim lookup, no sooner than 1.1 s after the last (its usage policy).</summary>
        private IEnumerator Nominatim(string q)
        {
            EnsureSearchData();
            placeStatus = "searching";
            ShowResults();
            float wait = lastNominatim + (float)(SpawnSearch.NominatimMinIntervalMs / 1000) - Time.realtimeSinceStartup;
            if (wait > 0) yield return new WaitForSecondsRealtime(wait);
            lastNominatim = Time.realtimeSinceStartup;
            using (UnityWebRequest req = UnityWebRequest.Get(SpawnSearch.NominatimSearchUrl(q)))
            {
                req.SetRequestHeader("User-Agent", "RetroFlightSim-Unity/0.1 (flight simulator place search)");
                yield return req.SendWebRequest();
                placeResults.Clear();
                if (req.result != UnityWebRequest.Result.Success)
                {
                    placeStatus = "error";
                }
                else
                {
                    List<NominatimPlace> places = ParsePlaces(req.downloadHandler.text);
                    placeResults.AddRange(SpawnSearch.PlacesFromNominatim(places, areas, currentArea));
                    placeStatus = placeResults.Count == 0 ? "none" : "done";
                }
            }
            if (search != null && search.value.Trim() == q) ShowResults();
        }

        private static List<NominatimPlace> ParsePlaces(string json)
        {
            var list = new List<NominatimPlace>();
            JsonValue root = JsonReader.Parse(json);
            if (root.Kind != JsonKind.Array) return list;
            foreach (JsonValue p in root.Items)
            {
                list.Add(new NominatimPlace
                {
                    Lat = p["lat"].Str(null),
                    Lon = p["lon"].Str(null),
                    Name = p["name"].Str(null),
                    DisplayName = p["display_name"].Str(""),
                    Type = p["type"].Str(null),
                    Addresstype = p["addresstype"].Str(null),
                });
            }
            return list;
        }

        // --- Widgets ---------------------------------------------------------------------

        public static Label Label(string text, int size, Color colour)
        {
            var l = new Label(text);
            l.style.fontSize = size;
            l.style.color = colour;
            l.style.whiteSpace = WhiteSpace.Normal;
            l.style.marginTop = 2;
            return l;
        }

        public static Button TextButton(string text, Action click)
        {
            var b = new Button(click) { text = text };
            Style(b, s =>
            {
                s.backgroundColor = Color.clear;
                s.color = Accent;
                s.fontSize = 14;
                NoBorder(s);
            });
            return b;
        }

        public static Button OutlineButton(string text, Action click)
        {
            var b = new Button(click) { text = text };
            Style(b, s =>
            {
                s.backgroundColor = Color.clear;
                s.color = Muted;
                s.fontSize = 13;
                s.width = 76;
                s.height = 36;
                s.marginLeft = 8;
                s.borderTopWidth = s.borderBottomWidth = s.borderLeftWidth = s.borderRightWidth = 1;
                s.borderTopColor = s.borderBottomColor = s.borderLeftColor = s.borderRightColor = Line;
                Round(s, 18);
            });
            return b;
        }

        public static void StyleInput(TextField f)
        {
            VisualElement input = f.Q(className: TextField.inputUssClassName);
            if (input == null) return;
            input.style.backgroundColor = Field;
            input.style.color = Text;
            input.style.paddingLeft = 10;
            NoBorder(input.style);
            input.style.borderBottomWidth = 1;
            input.style.borderBottomColor = Muted;
        }

        public static void Style(VisualElement e, Action<IStyle> apply) => apply(e.style);

        public static void Round(IStyle s, float r)
        {
            s.borderTopLeftRadius = s.borderTopRightRadius = s.borderBottomLeftRadius = s.borderBottomRightRadius = r;
        }

        public static void NoBorder(IStyle s)
        {
            s.borderTopWidth = s.borderBottomWidth = s.borderLeftWidth = s.borderRightWidth = 0;
        }
    }
}
