using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Retro.Unity
{
    /// <summary>
    /// Builds the M2 terrain spike at runtime: a fly camera at Gran Canaria, a
    /// sun, the terrain and the sea. Runs on Play in any scene that does not
    /// already contain a TerrainRenderer, so an empty scene is enough.
    /// </summary>
    public static class SpikeBootstrap
    {
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        private static void AutoCreate()
        {
            // A scene restart (the menu's pick in another area) builds the world again.
            UnityEngine.SceneManagement.SceneManager.sceneLoaded -= Reloaded;
            UnityEngine.SceneManagement.SceneManager.sceneLoaded += Reloaded;
            if (Object.FindAnyObjectByType<TerrainRenderer>() != null) return;
            Create();
        }

        private static void Reloaded(UnityEngine.SceneManagement.Scene scene, UnityEngine.SceneManagement.LoadSceneMode mode)
        {
            if (mode != UnityEngine.SceneManagement.LoadSceneMode.Single) return;
            if (Object.FindAnyObjectByType<TerrainRenderer>() != null) return;
            Create();
        }

        /// <summary>
        /// The web game draws its palette as authored: no tonemapping, no vignette.
        /// Bloom stays for what is brighter than white (the sun's overbright disc),
        /// and SMAA stands in for the mip-trick supersampling. A global volume of
        /// our own, above whatever the scene carries.
        /// </summary>
        private static void ConfigurePostProcessing(Camera cam)
        {
            var data = cam.GetComponent<UniversalAdditionalCameraData>() ?? cam.gameObject.AddComponent<UniversalAdditionalCameraData>();
            data.renderPostProcessing = true;
            data.antialiasing = AntialiasingMode.SubpixelMorphologicalAntiAliasing;
            var profile = ScriptableObject.CreateInstance<VolumeProfile>();
            var tone = profile.Add<Tonemapping>(true);
            tone.mode.Override(TonemappingMode.None);
            var vignette = profile.Add<Vignette>(true);
            vignette.intensity.Override(0f);
            var bloom = profile.Add<Bloom>(true);
            bloom.threshold.Override(1.1f);
            bloom.intensity.Override(0.6f);
            var volume = new GameObject("Retro post-processing").AddComponent<Volume>();
            volume.isGlobal = true;
            volume.priority = 100;
            volume.sharedProfile = profile;
        }

        /// <summary>PlayerPrefs key holding a one-shot spawn point, "lat,lon".</summary>
        public const string SpawnPref = "retro.spawn";

        private static bool TryParseSpawn(string s, out double lat, out double lon)
        {
            lat = lon = double.NaN;
            string[] parts = (s ?? "").Split(',');
            var inv = System.Globalization.CultureInfo.InvariantCulture;
            return parts.Length == 2
                && double.TryParse(parts[0], System.Globalization.NumberStyles.Float, inv, out lat)
                && double.TryParse(parts[1], System.Globalization.NumberStyles.Float, inv, out lon);
        }

        public static TerrainRenderer Create()
        {
            Camera cam = Camera.main;
            if (cam == null)
            {
                cam = new GameObject("Main Camera") { tag = "MainCamera" }.AddComponent<Camera>();
            }
            cam.clearFlags = CameraClearFlags.Skybox;
            // Not `??`: Unity's destroyed/missing objects only compare equal to null through ==.
            FlyCamera fly = cam.GetComponent<FlyCamera>();
            if (fly == null) fly = cam.gameObject.AddComponent<FlyCamera>();

            Light sun = Object.FindAnyObjectByType<Light>();
            if (sun == null)
            {
                sun = new GameObject("Sun").AddComponent<Light>();
                sun.type = LightType.Directional;
            }
            sun.shadows = LightShadows.Hard; // aircraft shadows (they replace the planform silhouettes)
            // A bias of its own: the asset's 0.1 / 0.5 left acne on large flat-shaded hulls (the carrier island)
            // over a 1500 m shadow distance on a 2048 map.
            UniversalAdditionalLightData lightData = sun.GetComponent<UniversalAdditionalLightData>();
            if (lightData == null) lightData = sun.gameObject.AddComponent<UniversalAdditionalLightData>();
            lightData.usePipelineSettings = false;
            sun.shadowBias = 1f;
            sun.shadowNormalBias = 1f;
            ConfigurePostProcessing(cam);
            // The sim keeps flying with the window in the background (and the editor unfocused).
            Application.runInBackground = true;
            // Time of day: the palette, sun, ambient, fog and sky all follow it (14:00 by default).
            var sky = new GameObject("Sky").AddComponent<SkyRenderer>();
            sky.sun = sun;
            sky.viewer = fly;
            sky.gameObject.AddComponent<CloudRenderer>().viewer = fly;

            var root = new GameObject("Terrain");
            var terrain = root.AddComponent<TerrainRenderer>();
            terrain.viewer = fly;

            // A spawn picked elsewhere ("lat,lon"), read once like the web game's
            // sessionStorage reload: the play area centres on it and the aircraft
            // starts on the nearest base runway there.
            string spawn = PlayerPrefs.GetString(SpawnPref, "");
            PlayerPrefs.DeleteKey(SpawnPref);
            if (TryParseSpawn(spawn, out double lat, out double lon))
            {
                terrain.originLat = lat;
                terrain.originLon = lon;
                fly.startLat = lat;
                fly.startLon = lon;
            }
            var sea = root.AddComponent<SeaSurface>();
            sea.viewer = fly;

            // M4: the player's aircraft on the ported sim; F10 hands the camera back to free flight.
            var player = new GameObject("Player").AddComponent<PlayerFlight>();
            player.terrain = terrain;
            player.view = fly;
            var targetView = player.gameObject.AddComponent<TargetCameraView>();
            targetView.flight = player;
            targetView.viewer = fly;

            // M5: the world on top of the terrain.
            var airfields = root.AddComponent<AirfieldRenderer>();
            airfields.terrain = terrain;
            airfields.viewer = fly;
            airfields.player = player;
            var roads = root.AddComponent<RoadRenderer>();
            roads.terrain = terrain;
            roads.viewer = fly;
            var buildings = root.AddComponent<BuildingRenderer>();
            buildings.terrain = terrain;
            buildings.viewer = fly;
            var bridges = root.AddComponent<BridgeRenderer>();
            bridges.terrain = terrain;
            bridges.viewer = fly;
            bridges.roads = roads;
            // terrainEntity.ts tileTriangles: roads and bridges count against the 600k fold.
            terrain.extraTriangles = k => roads.BudgetTrianglesOf(k) + bridges.TrianglesOf(k);
            var walls = root.AddComponent<RailWallRenderer>();
            walls.terrain = terrain;
            walls.viewer = fly;
            var vegetation = root.AddComponent<VegetationRenderer>();
            vegetation.terrain = terrain;
            vegetation.viewer = fly;

            // M8: the menu (Esc), with the spawn starts and the settings.
            var menu = new GameObject("Menu").AddComponent<MenuDialog>();
            menu.flight = player;
            menu.terrain = terrain;
            // M8: the 2D overlay (cockpit MFDs, then the HUD) over the 3D view.
            var overlay = new GameObject("Overlay").AddComponent<OverlayHost>();
            overlay.flight = player;
            overlay.terrain = terrain;
            overlay.viewer = fly;
            overlay.targetView = targetView;
            // The stored settings, applied before anything above boots.
            var settings = menu.gameObject.AddComponent<SettingsBridge>();
            settings.flight = player;
            settings.terrain = terrain;
            settings.sky = sky;
            settings.overlay = overlay;
            settings.roads = roads;
            settings.buildings = buildings;
            settings.vegetation = vegetation;
            settings.menu = menu;
            settings.Init();
            var boot = new GameObject("Boot").AddComponent<BootOverlay>();
            boot.flight = player;
            boot.terrain = terrain;
            return terrain;
        }
    }
}
