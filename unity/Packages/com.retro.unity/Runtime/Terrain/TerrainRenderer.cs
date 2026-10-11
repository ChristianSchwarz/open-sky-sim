using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Retro.Core;
using Retro.Terrain;
using UnityEngine;
using UnityEngine.Rendering;
using Debug = UnityEngine.Debug;

namespace Retro.Unity
{
    /// <summary>The subset of manifest.json the spike reads (JsonUtility).</summary>
    [Serializable]
    internal sealed class ManifestJson
    {
        public EnuOriginJson enuOrigin;
        public MeshJson mesh;
        public double seaLevel;
    }

    [Serializable]
    internal sealed class EnuOriginJson
    {
        public double lat;
        public double lon;
        public double height;
    }

    [Serializable]
    internal sealed class MeshJson
    {
        public int maxZoom;
        public double[] levelGeometricErrorM;
    }

    /// <summary>
    /// Streams the baked terrain pyramid and draws it with URP (M2 spike).
    ///
    /// The engine-free <see cref="TerrainSession"/> picks tiles (the quadtree
    /// verified against the TypeScript game) and loads them off-thread; this
    /// component uploads meshes within a per-frame time budget, releases them
    /// when the cache evicts, and submits the draw list camera-relative each
    /// frame with Graphics.RenderMesh.
    /// </summary>
    [DefaultExecutionOrder(100)]
    public sealed class TerrainRenderer : MonoBehaviour
    {
        [Tooltip("Folder with manifest.json, index_mesh.bin and {z}/{x}/{y}.ptm. Empty: find assets/terrain above the project.")]
        public string terrainRoot = "";

        [Tooltip("The view this terrain follows (position and orientation in double precision).")]
        public FlyCamera viewer;

        public Material landMaterial;
        public Material waterDeepMaterial;
        public Material waterShallowMaterial;

        [Range(1, 4)] public float detailScale = 1;
        public float detailDistanceKm = 12;
        [Range(1, 10)] public float leafScale = 1.5f;
        public float uploadBudgetMs = 4;
        [Tooltip("TERRAIN_TRIANGLE_BUDGET: far tiles fold into coarser ones to fit.")]
        public int triangleBudget = Lod.TerrainTriangleBudget;

        [Header("Stats (read only)")]
        public int drawnTiles;
        public int residentTiles;
        public int uploadedTiles;
        public int pendingLoads;
        public int drawnTriangles;
        public float residentMb;
        public int coarsenedTiles;
        public bool triangleBudgetHit;

        private TerrainSession session;
        private readonly Dictionary<TileKey, TileGpuMeshes> gpu = new Dictionary<TileKey, TileGpuMeshes>();
        private readonly Queue<(TileKey Key, PtmTile Tile)> uploadQueue = new Queue<(TileKey, PtmTile)>();
        private float reconcileTimer;
        private readonly Stopwatch clock = Stopwatch.StartNew();

        public TerrainSession Session => session;

        private void Start()
        {
            string root = ResolveRoot();
            if (root == null)
            {
                Debug.LogError("Retro terrain: no assets/terrain/manifest.json found. Set TerrainRenderer.terrainRoot.");
                enabled = false;
                return;
            }
            ManifestJson manifest = JsonUtility.FromJson<ManifestJson>(File.ReadAllText(Path.Combine(root, "manifest.json")));
            session = new TerrainSession(new TerrainSessionOptions
            {
                Root = root,
                LevelGeometricErrorM = manifest.mesh.levelGeometricErrorM,
                MaxZoom = manifest.mesh.maxZoom,
                BakeLat = manifest.enuOrigin.lat, BakeLon = manifest.enuOrigin.lon, BakeHeight = manifest.enuOrigin.height,
                OriginLat = manifest.enuOrigin.lat, OriginLon = manifest.enuOrigin.lon, OriginHeight = manifest.enuOrigin.height,
            });
            session.IsUploaded = k => gpu.ContainsKey(k);
            session.Meshes.Loaded += (k, t) => uploadQueue.Enqueue((k, t));
            session.Meshes.Evicted += (k, _) =>
            {
                if (gpu.TryGetValue(k, out TileGpuMeshes m))
                {
                    m.Destroy();
                    gpu.Remove(k);
                }
            };
            if (viewer != null) viewer.Basis = session.Basis;
            EnsureMaterials();
            Debug.Log($"Retro terrain: {root}, max zoom {manifest.mesh.maxZoom}, origin {manifest.enuOrigin.lat}, {manifest.enuOrigin.lon}");
        }

        private string ResolveRoot()
        {
            if (!string.IsNullOrEmpty(terrainRoot))
            {
                return File.Exists(Path.Combine(terrainRoot, "manifest.json")) ? terrainRoot : null;
            }
            // The project lives in <repo>/unity/<Project>; the baked pyramid in <repo>/assets/terrain.
            DirectoryInfo dir = new DirectoryInfo(Application.dataPath);
            for (int i = 0; i < 5 && dir != null; i++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, "assets", "terrain");
                if (File.Exists(Path.Combine(candidate, "manifest.json"))) return candidate;
            }
            return null;
        }

        private void EnsureMaterials()
        {
            if (landMaterial == null) landMaterial = new Material(Shader.Find("Retro/TerrainLand"));
            if (waterDeepMaterial == null)
            {
                waterDeepMaterial = new Material(Shader.Find("Retro/TerrainWater"));
                waterDeepMaterial.SetColor("_Color", new Color(0.05f, 0.16f, 0.30f));
            }
            if (waterShallowMaterial == null)
            {
                waterShallowMaterial = new Material(Shader.Find("Retro/TerrainWater"));
                waterShallowMaterial.SetColor("_Color", new Color(0.10f, 0.30f, 0.40f));
            }
        }

        private void Update()
        {
            if (session == null || viewer == null) return;

            // Reconcile at the TS cadence (RECONCILE_INTERVAL_MS); upload every frame within budget.
            reconcileTimer -= Time.unscaledDeltaTime * 1000;
            if (reconcileTimer <= 0)
            {
                reconcileTimer = (float)Lod.ReconcileIntervalMs;
                session.TriangleBudget = triangleBudget;
                Camera cam = viewer.UnityCamera;
                session.Update(new TerrainView
                {
                    Position = viewer.ScenePosition,
                    Orientation = SceneFrame.SceneCameraOrientation(viewer.headingDeg, viewer.pitchDeg),
                    FovYDeg = cam.fieldOfView,
                    Aspect = cam.aspect,
                    ScreenHeightPx = cam.pixelHeight,
                    Near = cam.nearClipPlane,
                    DetailScale = detailScale,
                    DetailDistanceM = detailDistanceKm * 1000,
                    LeafScale = leafScale,
                    NowMs = clock.Elapsed.TotalMilliseconds,
                });
            }
            else
            {
                session.Meshes.Pump();
            }
            PumpUploads();
            Draw();

            residentTiles = session.Meshes.Count;
            uploadedTiles = gpu.Count;
            pendingLoads = session.Meshes.InFlight;
            residentMb = session.Meshes.ResidentBytes / 1048576f;
            coarsenedTiles = session.CoarsenedTiles;
            triangleBudgetHit = session.TriangleBudgetHit;
        }

        private void PumpUploads()
        {
            long start = clock.ElapsedTicks;
            long budget = (long)(uploadBudgetMs / 1000 * Stopwatch.Frequency);
            while (uploadQueue.Count > 0 && clock.ElapsedTicks - start < budget)
            {
                var (key, tile) = uploadQueue.Dequeue();
                if (gpu.ContainsKey(key) || !session.Meshes.Has(key)) continue;
                gpu[key] = TileMeshUpload.Build(tile);
            }
        }

        private void Draw()
        {
            Vec3d cam = viewer.ScenePosition;
            var landParams = new RenderParams(landMaterial) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = true };
            var deepParams = new RenderParams(waterDeepMaterial) { shadowCastingMode = ShadowCastingMode.Off };
            var shallowParams = new RenderParams(waterShallowMaterial) { shadowCastingMode = ShadowCastingMode.Off };
            drawnTiles = 0;
            drawnTriangles = 0;
            foreach (DrawTile d in session.DrawList)
            {
                if (!gpu.TryGetValue(d.Key, out TileGpuMeshes m)) continue;
                // Under-parents of the leaf dissolve are skipped in the spike (no
                // dither cross-fade yet); their leaves are drawn opaque.
                if (d.Under) continue;
                Matrix4x4 matrix = SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, d.Tile.QuantScale * TileMeshUpload.SNorm16Max);
                if (m.Land != null) Graphics.RenderMesh(landParams, m.Land, 0, matrix);
                if (m.Water != null)
                {
                    if (d.Tile.WaterGroups[0][1] > 0) Graphics.RenderMesh(deepParams, m.Water, 0, matrix);
                    if (d.Tile.WaterGroups[1][1] > 0) Graphics.RenderMesh(shallowParams, m.Water, 1, matrix);
                }
                drawnTiles++;
                drawnTriangles += m.TriangleCount;
            }
        }

        private void OnDestroy()
        {
            foreach (TileGpuMeshes m in gpu.Values) m.Destroy();
            gpu.Clear();
        }
    }
}
