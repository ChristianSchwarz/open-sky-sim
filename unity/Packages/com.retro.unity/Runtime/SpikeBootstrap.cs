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
            if (Object.FindFirstObjectByType<TerrainRenderer>() != null) return;
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

            if (Object.FindFirstObjectByType<Light>() == null)
            {
                var sun = new GameObject("Sun").AddComponent<Light>();
                sun.type = LightType.Directional;
                sun.intensity = 1.2f;
                sun.color = new Color(1f, 0.96f, 0.88f);
                sun.transform.rotation = Quaternion.Euler(45, 150, 0);
                sun.shadows = LightShadows.None;
            }
            RenderSettings.ambientMode = AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = new Color(0.55f, 0.65f, 0.80f);
            RenderSettings.ambientEquatorColor = new Color(0.45f, 0.48f, 0.50f);
            RenderSettings.ambientGroundColor = new Color(0.25f, 0.23f, 0.20f);
            RenderSettings.fog = true;
            RenderSettings.fogMode = FogMode.ExponentialSquared;
            RenderSettings.fogDensity = 0.000012f;
            RenderSettings.fogColor = new Color(0.68f, 0.76f, 0.86f);

            var root = new GameObject("Terrain");
            var terrain = root.AddComponent<TerrainRenderer>();
            terrain.viewer = fly;
            var sea = root.AddComponent<SeaSurface>();
            sea.viewer = fly;
            return terrain;
        }
    }
}
