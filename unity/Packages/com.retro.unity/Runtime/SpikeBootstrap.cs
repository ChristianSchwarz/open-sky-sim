using UnityEngine;
using UnityEngine.Rendering;

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
            if (Object.FindAnyObjectByType<TerrainRenderer>() != null) return;
            Create();
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
            sun.shadows = LightShadows.None;
            // The web game's sun at its default 14:00, and its direct/ambient balance.
            SunModel.Apply(sun, SunModel.DefaultHours);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = 0.000012f;
            RenderSettings.fogColor = new Color(0.68f, 0.76f, 0.86f);

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
            return terrain;
        }
    }
}
