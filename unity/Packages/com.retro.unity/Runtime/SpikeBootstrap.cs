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
            var vegetation = root.AddComponent<VegetationRenderer>();
            vegetation.terrain = terrain;
            vegetation.viewer = fly;
            return terrain;
        }
    }
}
