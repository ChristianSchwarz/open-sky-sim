using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
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
        public HeightJson height;
        public FlattenPadJson[] flattenPads;
    }

    [Serializable]
    internal sealed class HeightJson
    {
        public int queryZoom = 11;
        public int coarseZoom = 7;
    }

    /// <summary>A manifest flatten pad. JsonUtility has no nullables: NaN stands for an absent field.</summary>
    [Serializable]
    internal sealed class FlattenPadJson
    {
        public double lat;
        public double lon;
        public double halfW;
        public double halfD;
        public double featherM;
        public double heightMsl;
        public double headingDeg = double.NaN;
        public double gradient = double.NaN;
        public double gradientHeadingDeg = double.NaN;
        public string icao;

        private static double? Opt(double v) => double.IsNaN(v) ? (double?)null : v;

        public FlattenPadRecord ToRecord() => new FlattenPadRecord
        {
            Lat = lat, Lon = lon, HalfW = halfW, HalfD = halfD, FeatherM = featherM, HeightMsl = heightMsl,
            HeadingDeg = Opt(headingDeg), Gradient = Opt(gradient), GradientHeadingDeg = Opt(gradientHeadingDeg),
            Icao = string.IsNullOrEmpty(icao) ? null : icao,
        };
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
        public string[] swatches;
        public LuminanceJson luminance;
    }

    [Serializable]
    internal sealed class LuminanceJson
    {
        public float mid = 0.28f;
        public float spread = 0.1f;
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

        [Tooltip("Play origin (the scene frame's tangent point); NaN keeps the bake's enuOrigin.")]
        public double originLat = double.NaN;
        public double originLon = double.NaN;

        /// <summary>What a tile costs beyond its land and water (roads, bridges); set before Start.</summary>
        public Func<TileKey, int> extraTriangles;

        [Tooltip("The view this terrain follows (position and orientation in double precision).")]
        public FlyCamera viewer;

        public Material landMaterial;
        public Material waterDeepMaterial;
        public Material waterShallowMaterial;

        [Tooltip("Land colour mode (the Graphics tab's Terrain colour).")]
        public TerrainColourMode colourMode = TerrainColourMode.Hybrid;
        [Range(0, 1)] public float landuseBlend = TerrainColours.LanduseBlendDefault;

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
        private ManifestJson manifest;
        private TerrainColourMode appliedMode = (TerrainColourMode)(-1);
        private float appliedBlend = -1;
        private int appliedPalette;
        private readonly Dictionary<TileKey, TileGpuMeshes> gpu = new Dictionary<TileKey, TileGpuMeshes>();
        private readonly Queue<(TileKey Key, PtmTile Tile)> uploadQueue = new Queue<(TileKey, PtmTile)>();
        private float reconcileTimer;
        private readonly Stopwatch clock = Stopwatch.StartNew();

        public TerrainSession Session => session;
        /// <summary>The folder the pyramid is read from; null until Start found it.</summary>
        public string Root { get; private set; }
        /// <summary>The pyramid's deepest mesh zoom (manifest mesh.maxZoom).</summary>
        public int MaxZoom => manifest != null ? manifest.mesh.maxZoom : 12;

        /// <summary>The collision surface over the same pyramid and frame, for the sim.</summary>
        public DemHeightField CreateHeightField()
        {
            if (session == null) return null;
            HeightJson h = manifest.height ?? new HeightJson();
            return new DemHeightField(Root, session.Basis, manifest.seaLevel, h.queryZoom, h.coarseZoom,
                (manifest.flattenPads ?? Array.Empty<FlattenPadJson>()).Select(p => p.ToRecord()));
        }

        private void Start()
        {
            string root = ResolveRoot();
            Root = root;
            if (root == null)
            {
                Debug.LogError("Retro terrain: no assets/terrain/manifest.json found. Set TerrainRenderer.terrainRoot.");
                enabled = false;
                return;
            }
            manifest = JsonUtility.FromJson<ManifestJson>(File.ReadAllText(Path.Combine(root, "manifest.json")));
            session = new TerrainSession(new TerrainSessionOptions
            {
                Root = root,
                LevelGeometricErrorM = manifest.mesh.levelGeometricErrorM,
                MaxZoom = manifest.mesh.maxZoom,
                BakeLat = manifest.enuOrigin.lat, BakeLon = manifest.enuOrigin.lon, BakeHeight = manifest.enuOrigin.height,
                // The play area's origin: anywhere in the pyramid, the bake frame stays the bake's.
                OriginLat = double.IsNaN(originLat) ? manifest.enuOrigin.lat : originLat,
                OriginLon = double.IsNaN(originLon) ? manifest.enuOrigin.lon : originLon,
                OriginHeight = double.IsNaN(originLat) ? manifest.enuOrigin.height : 0,
            });
            session.IsUploaded = k => gpu.ContainsKey(k);
            session.ExtraTriangles = extraTriangles;
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
                waterDeepMaterial.SetColor("_Color", TerrainColours.FromHex(TerrainColours.WaterHex));
            }
            if (waterShallowMaterial == null)
            {
                waterShallowMaterial = new Material(Shader.Find("Retro/TerrainWater"));
                waterShallowMaterial.SetColor("_Color", TerrainColours.FromHex(TerrainColours.ShallowWaterHex));
            }
        }

        private void Update()
        {
            if (session == null || viewer == null) return;
            if (colourMode != appliedMode || landuseBlend != appliedBlend || appliedPalette != ScenePalette.Version)
            {
                LuminanceJson lum = manifest.mesh.luminance ?? new LuminanceJson();
                if (lodProps == null) lodProps = new MaterialPropertyBlock();
                TerrainColours.Apply(lodProps, colourMode, landuseBlend, manifest.mesh.swatches, lum.mid, lum.spread);
                appliedMode = colourMode;
                appliedBlend = landuseBlend;
                appliedPalette = ScenePalette.Version;
                waterDeepMaterial.SetColor("_Color", ScenePalette.Tone(Retro.Game.PaletteCategory.TERRAIN_WATER));
                waterShallowMaterial.SetColor("_Color", ScenePalette.Tone(Retro.Game.PaletteCategory.TERRAIN_SHALLOW_WATER));
            }

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
                    Orientation = viewer.SceneOrientation,
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

        private static readonly int LodFadeMId = Shader.PropertyToID("_LodFadeM");
        private static readonly int LodFadeCapId = Shader.PropertyToID("_LodFadeCap");
        private static readonly int DepthPushId = Shader.PropertyToID("_DepthPush");
        private static readonly int LodUnderId = Shader.PropertyToID("_LodUnder");
        private MaterialPropertyBlock lodProps;

        private void Draw()
        {
            Vec3d cam = viewer.ScenePosition;
            double nowMs = clock.Elapsed.TotalMilliseconds;
            if (lodProps == null) lodProps = new MaterialPropertyBlock();
            var landParams = new RenderParams(landMaterial)
            {
                shadowCastingMode = ShadowCastingMode.Off, receiveShadows = true, matProps = lodProps,
            };
            var deepParams = new RenderParams(waterDeepMaterial) { shadowCastingMode = ShadowCastingMode.Off };
            var shallowParams = new RenderParams(waterShallowMaterial) { shadowCastingMode = ShadowCastingMode.Off };
            drawnTiles = 0;
            drawnTriangles = 0;
            foreach (DrawTile d in session.DrawList)
            {
                if (!gpu.TryGetValue(d.Key, out TileGpuMeshes m)) continue;
                Matrix4x4 matrix = SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, d.Tile.QuantScale * TileMeshUpload.SNorm16Max);
                if (m.Land != null)
                {
                    // The leaf dissolve, per draw (tileBeforeRender in terrainEntity.ts). The
                    // property block's values are copied when the draw is queued.
                    lodProps.SetFloat(LodFadeMId, (float)d.FadeM);
                    lodProps.SetFloat(LodFadeCapId, d.FadeM > 0 ? Mathf.Min(1f, (float)((nowMs - d.FadeFromMs) / Lod.LodFadeMs)) : 1f);
                    lodProps.SetFloat(DepthPushId, (float)d.PushM);
                    lodProps.SetFloat(LodUnderId, d.PushM > 0 ? 1f : 0f);
                    Graphics.RenderMesh(landParams, m.Land, 0, matrix);
                }
                // An under-parent's water is not drawn: its leaves' water covers the same sea.
                if (m.Water != null && !d.Under)
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
