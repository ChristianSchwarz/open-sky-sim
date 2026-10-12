using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Retro.Game;
using Retro.Sim;
using Retro.Terrain;
using UnityEngine;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;

namespace Retro.Unity
{
    /// <summary>
    /// The game's settings in the Unity frontend (index.ts + osdPanel.ts boot,
    /// settingsStorage.ts): loaded from one JSON file under the player's data
    /// folder (the localStorage key's value, same encoding), turned into the
    /// ported <see cref="ConfigService"/>, applied to the components that act
    /// on each setting and re-applied when one changes; the dialog's other
    /// tabs are built from the ported <see cref="SettingsDialogModel"/>.
    ///
    /// Wired: time of day, flight model, AI pilot model, units, terrain colour
    /// mode and land-use blend, terrain detail distance, land-use reach,
    /// triangle budget, finest terrain level, tree density, buildings, roads,
    /// render scale and supersampling, smooth shading, land-use reveal,
    /// far-tile textures, colour adjust, keyboard layout and pitch-stick mode,
    /// volume, and the aircraft and spawn mode kept between sessions.
    /// </summary>
    [DefaultExecutionOrder(-300)]
    public sealed class SettingsBridge : MonoBehaviour, ISettingsDevices
    {
        public PlayerFlight flight;
        public TerrainRenderer terrain;
        public SkyRenderer sky;
        public OverlayHost overlay;
        public RoadRenderer roads;
        public BuildingRenderer buildings;
        public VegetationRenderer vegetation;
        public MenuDialog menu;

        private SettingsStorage storage;
        private ConfigService config;
        private SettingsDialogModel model;
        private readonly Dictionary<SettingsTab, SettingsTabView> views = new Dictionary<SettingsTab, SettingsTabView>();
        private string savedAircraft;
        private SpawnMode savedSpawn;

        public ConfigService Config => config;
        public SettingsStorage Storage => storage;

        /// <summary>The settings file: what localStorage holds on the web.</summary>
        public static string FilePath => Path.Combine(Application.persistentDataPath, "settings.json");

        /// <summary>Load, apply to the components before they boot, and listen for changes.</summary>
        public void Init()
        {
            storage = new SettingsStorage(new JsonFileKeyValueStore(FilePath));
            config = SettingsActions.Boot(storage, this, out AppSettings s);
            SettingsActions.PersistSettingChanges(config, storage);
            flight.aircraftId = s.AircraftId;
            flight.spawnMode = s.SpawnMode;
            savedAircraft = s.AircraftId;
            savedSpawn = s.SpawnMode;
            ApplyAll();
            config.Daytime.AddChangeListener(_ => ApplyDaytime());
            config.FlightModels.AddChangeListener((_, __) => ApplyFlightModel());
            config.AiPilotModels.AddChangeListener(_ => ApplyAiModel());
            config.UnitSystem.AddChangeListener(_ => ApplyUnits());
            config.TerrainColour.AddChangeListener(_ => ApplyTerrain());
            config.LanduseBlend.AddChangeListener(_ => ApplyTerrain());
            config.TerrainDetail.AddChangeListener(_ => ApplyTerrain());
            config.LanduseReach.AddChangeListener(_ => ApplyTerrain());
            config.TriangleBudget.AddChangeListener(_ => ApplyTerrain());
            config.VisibleZoom.AddChangeListener(_ => ApplyTerrain());
            config.TerrainShading.AddChangeListener(_ => ApplyTerrain());
            config.LanduseReveal.AddChangeListener(_ => ApplyTerrain());
            config.FarTileTextures.AddChangeListener(_ => ApplyTerrain());
            config.TreeDensity.AddChangeListener(_ => ApplyLayers());
            config.Buildings.AddChangeListener(_ => ApplyLayers());
            config.Roads.AddChangeListener(_ => ApplyLayers());
            config.RenderScale.AddChangeListener(_ => ApplyRenderScale());
            config.Supersampling.AddChangeListener(_ => ApplyRenderScale());
            config.ColourAdjust.AddChangeListener(_ => ApplyColourAdjust());
        }

        private void Start()
        {
            model = new SettingsDialogModel(new SettingsDialogHost
            {
                Config = config,
                Storage = storage,
                Devices = this,
                KeyboardLayout = flight.keyboardLayout,
                Areas = terrain.Areas(),
                TerrainImport = false,
                ReloadIntoArea = ReloadIntoArea,
            });
            model.Changed += () =>
            {
                foreach (SettingsTabView v in views.Values) v.Refresh();
            };
            foreach (SettingsTabModel tab in model.Tabs)
            {
                if (tab.Tab == SettingsTab.Flight) continue; // the menu's own Flight tab (live aircraft list and search)
                SettingsTabModel t = tab;
                menu.SetTab(t.Name, () =>
                {
                    var view = new SettingsTabView(t);
                    views[t.Tab] = view;
                    return view.Root;
                });
            }
        }

        private void Update()
        {
            // onViewportResize: the supersample tapers with the window.
            if (Screen.width != appliedWidth || Screen.height != appliedHeight) ApplyRenderScale();
            // The N key moves the sun outside the dialog: the setting follows it (and is saved).
            if (sky != null && Math.Abs(sky.hours - config.Daytime.Active) > 1e-6) config.Daytime.SetActive(sky.hours);
            // The aircraft and the start the player last picked, kept like the web's settings.
            if (flight.aircraftId != savedAircraft || flight.spawnMode != savedSpawn)
            {
                savedAircraft = flight.aircraftId;
                savedSpawn = flight.spawnMode;
                string id = savedAircraft;
                SpawnMode mode = savedSpawn;
                storage.Update(s =>
                {
                    s.AircraftId = id;
                    s.SpawnMode = mode;
                });
            }
            // Settings that act on objects made at the flight's boot.
            if (flight.Combat != null && flight.Combat.PilotModel != config.AiPilotModels.Active) ApplyAiModel();
        }

        private void ApplyAll()
        {
            ApplyDaytime();
            ApplyFlightModel();
            ApplyUnits();
            ApplyTerrain();
            ApplyLayers();
            ApplyRenderScale();
            ApplyColourAdjust();
        }

        private void ApplyDaytime()
        {
            if (sky != null) sky.hours = (float)config.Daytime.Active;
        }

        private void ApplyFlightModel()
        {
            flight.flightModel = config.FlightModels.ActiveKey switch
            {
                "FM3" => SimFlightModelKind.Fm3,
                "DEBUG" => SimFlightModelKind.Debug,
                _ => SimFlightModelKind.Fm2,
            };
        }

        /// <summary>Takes on the next opponent spawn, as on the web.</summary>
        private void ApplyAiModel()
        {
            if (flight.Combat != null) flight.Combat.PilotModel = config.AiPilotModels.Active;
        }

        private void ApplyUnits()
        {
            if (overlay != null) overlay.units = config.UnitSystem.Active == UnitSystems.IMPERIAL ? UnitSystem.Imperial : UnitSystem.Metric;
        }

        private void ApplyTerrain()
        {
            terrain.colourMode = config.TerrainColour.Active switch
            {
                Retro.Game.TerrainColours.LANDCOVER => TerrainColourMode.Landcover,
                Retro.Game.TerrainColours.SWATCH => TerrainColourMode.Swatch,
                Retro.Game.TerrainColours.IMAGERY => TerrainColourMode.Imagery,
                _ => TerrainColourMode.Hybrid,
            };
            terrain.landuseBlend = (float)config.LanduseBlend.Active;
            double detail = config.TerrainDetail.Active;
            terrain.detailDistanceKm = double.IsInfinity(detail) ? 1e6f : (float)(detail / 1000);
            terrain.leafScale = (float)config.LanduseReach.Active;
            terrain.triangleBudget = (int)config.TriangleBudget.Active;
            terrain.visibleZoom = (int)config.VisibleZoom.Active;
            terrain.smoothShading = config.TerrainShading.Active == TerrainShading.SMOOTH;
            terrain.landuseRevealPx = (float)config.LanduseReveal.Active;
            terrain.farTileTextures = config.FarTileTextures.Active;
        }

        private void ApplyLayers()
        {
            if (buildings != null) buildings.buildingsEnabled = config.Buildings.Active;
            if (roads != null) roads.mode = config.Roads.Active;
            if (vegetation != null) vegetation.densityMultiplier = (float)config.TreeDensity.Active;
        }

        private int appliedWidth, appliedHeight;

        private static readonly int AdjTrees = Shader.PropertyToID("_AdjTrees");
        private static readonly int AdjTerrain = Shader.PropertyToID("_AdjTerrain");
        private static readonly int AdjSky = Shader.PropertyToID("_AdjSky");

        /// <summary>
        /// index.ts applyColourAdjust: the trees', terrain's and sky's sliders to their shaders
        /// (ColourAdjust.hlsl, as offsets from neutral), the water's to its palette colours.
        /// </summary>
        private void ApplyColourAdjust()
        {
            ColourAdjust adjust = config.ColourAdjust.Active;
            Vector4 Tweak(ColourTweak t) => new Vector4((float)(t.Saturation - 1), (float)(t.Brightness - 1), (float)(t.Hue * Math.PI / 180), 0);
            Shader.SetGlobalVector(AdjTrees, Tweak(adjust[ColourAdjustGroup.Trees]));
            Shader.SetGlobalVector(AdjTerrain, Tweak(adjust[ColourAdjustGroup.Terrain]));
            Shader.SetGlobalVector(AdjSky, Tweak(adjust[ColourAdjustGroup.Sky]));
            ScenePalette.SetWaterTweak(adjust[ColourAdjustGroup.Water]);
        }

        /// <summary>game.ts hdSupersampleScale: 2x up to ~1440p, 1.5x to ~1800p, native above.</summary>
        public static double HdSupersampleScale(int width, int height)
        {
            double megapixels = width * (double)height / 1e6;
            if (megapixels <= 2.3) return 2;
            if (megapixels <= 4.5) return 1.5;
            return 1;
        }

        /// <summary>
        /// game.ts updateHdResolution: the main image is drawn at the render scale when it is
        /// below 1, else at the supersample (URP draws it larger and filters it down to the
        /// screen); the render scale replaces the supersample rather than multiplying it. The
        /// terrain measures its detail in those pixels.
        /// </summary>
        private void ApplyRenderScale()
        {
            appliedWidth = Screen.width;
            appliedHeight = Screen.height;
            double renderScale = config.RenderScale.Active;
            double supersample = config.Supersampling.Active ? HdSupersampleScale(Screen.width, Screen.height) : 1;
            double main = renderScale < 1 ? renderScale : supersample;
            if (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp)
            {
                urp.renderScale = (float)main;
            }
            if (terrain != null) terrain.renderScale = (float)main;
        }

        private void OnDestroy()
        {
            // Shader globals outlive play mode in the editor: back to neutral.
            Shader.SetGlobalVector(AdjTrees, Vector4.zero);
            Shader.SetGlobalVector(AdjTerrain, Vector4.zero);
            Shader.SetGlobalVector(AdjSky, Vector4.zero);
            // The URP asset is a project asset: in the editor a runtime change would stick to it.
            if (UnityEngine.Rendering.GraphicsSettings.currentRenderPipeline is UniversalRenderPipelineAsset urp) urp.renderScale = 1;
        }

        // ---- ISettingsDevices ----

        public void SetMasterVolume(double volume) => AudioListener.volume = (float)volume;

        public void SetKeyboardLayout(KeyboardControlLayoutId layout)
        {
            flight.keyboardLayout = layout;
            flight.Sim?.SetKeyboardLayout(layout);
        }

        public void SetKeyboardPitchStickMode(KeyboardPitchStickMode mode)
        {
            // Kept on the flight too: the settings boot before the sim exists.
            flight.keyboardPitchStickMode = mode;
            flight.Sim?.SetKeyboardPitchStickMode(mode);
        }

        /// <summary>"Fly here": the area was saved; restart the world around its centre.</summary>
        private void ReloadIntoArea()
        {
            string name = storage.Load().TerrainArea;
            foreach (TerrainArea a in terrain.Areas())
            {
                if (a.Name != name) continue;
                var inv = CultureInfo.InvariantCulture;
                double lat = (a.South + a.North) / 2, lon = (a.West + a.East) / 2;
                PlayerPrefs.SetString(SpikeBootstrap.SpawnPref, lat.ToString("R", inv) + "," + lon.ToString("R", inv));
                PlayerPrefs.Save();
                flight.menuOpen = false;
                SceneManager.LoadScene(SceneManager.GetActiveScene().buildIndex);
                return;
            }
        }
    }
}
