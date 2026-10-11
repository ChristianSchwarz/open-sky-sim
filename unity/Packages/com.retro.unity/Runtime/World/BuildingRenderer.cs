using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Retro.Core;
using Retro.Terrain;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// OSM buildings on the drawn z12 leaves (buildingMeshes.ts on the ported
    /// <see cref="BuildingTileBuilder"/>): each leaf's .pbh is decoded and
    /// extruded off the main thread inside the tile cache's loader, uploaded
    /// once, and drawn as a prefix of its most prominent buildings - the
    /// <see cref="BuildingDrawBudget"/> holds the whole view under 300k
    /// triangles and grows tiles in gradually.
    /// </summary>
    [DefaultExecutionOrder(103)]
    public sealed class BuildingRenderer : MonoBehaviour
    {
        public TerrainRenderer terrain;
        public FlyCamera viewer;
        public bool buildingsEnabled = true;
        [Tooltip("Imagery and Hybrid colour modes show measured roof colours; the palette modes keep the tones.")]
        public bool rawRoofColours = true;
        public float uploadMs = 2;

        [Header("Stats (read only)")]
        public int residentTiles;
        public int uploadedTiles;
        public int drawnTiles;
        public int shownTriangles;
        public float minPixels;

        private const int LeafZoom = 12;

        private sealed class TileBuildings
        {
            public BuildingTileMesh Cpu;
            public BuildingDrawSet Set;
            public Mesh Mesh;
            public int Applied = -1;
        }

        private string root;
        private TileIndex index;
        private TileCache<BuildingTileMesh> cache;
        private readonly Dictionary<TileKey, TileBuildings> gpu = new Dictionary<TileKey, TileBuildings>();
        private readonly BuildingDrawBudget budget = new BuildingDrawBudget();
        private Material material;
        private readonly Stopwatch clock = Stopwatch.StartNew();

        private bool TryBoot()
        {
            if (terrain == null || viewer == null || terrain.Session == null || terrain.Root == null) return false;
            root = terrain.Root;
            string indexPath = Path.Combine(root, "index_buildings.bin");
            if (!File.Exists(indexPath))
            {
                enabled = false;
                return false;
            }
            index = TileIndex.Decode(File.ReadAllBytes(indexPath));
            // Decode and extrude on the loader threads: the builder owns all its state.
            cache = new TileCache<BuildingTileMesh>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".pbh"),
                bytes => BuildingTileBuilder.Build(TileFile.Pbh(bytes)) ?? new BuildingTileMesh { Triangles = 0 },
                m => m.Bytes + 256,
                BuildingConstants.CacheBytes);
            cache.Evicted += (k, _) => Release(k);
            material = new Material(Shader.Find("Retro/BuildingLit")) { name = "buildings" };
            return true;
        }

        private void Update()
        {
            if (cache == null && !TryBoot()) return;
            budget.Enabled = buildingsEnabled;
            Vec3d cam = viewer.ScenePosition;
            Camera unityCam = viewer.UnityCamera;
            IReadOnlyList<DrawTile> draw = terrain.Session.DrawList;

            cache.NextGeneration();
            var wants = new List<(TileKey, double)>();
            foreach (DrawTile d in draw)
            {
                if (d.Under || d.Key.Z != LeafZoom || !index.Has(d.Key)) continue;
                if (cache.Get(d.Key) == null) wants.Add((d.Key, -(d.Origin - cam).Length));
            }
            if (buildingsEnabled) cache.SetWants(wants);
            cache.Pump();

            // Upload what came in, then the budget walk (terrainEntity.ts limitTrackDetail).
            var upload = Stopwatch.StartNew();
            budget.BeginFrame();
            var drawn = new List<(TileBuildings T, DrawTile D)>();
            foreach (DrawTile d in draw)
            {
                if (d.Under || d.Key.Z != LeafZoom) continue;
                if (!gpu.TryGetValue(d.Key, out TileBuildings t))
                {
                    BuildingTileMesh m = cache.Peek(d.Key);
                    if (m == null || m.Triangles == 0 || upload.Elapsed.TotalMilliseconds > uploadMs) continue;
                    t = Upload(m);
                    gpu[d.Key] = t;
                }
                double nearM = Math.Max(0, (d.Origin - cam).Length - Tiling.ApproxEdgeMetres(d.Key) * 0.75);
                budget.Want(t.Set, nearM);
                drawn.Add((t, d));
            }
            double pixelAngle = BuildingConstants.PixelAngle(unityCam.fieldOfView * Math.PI / 180, unityCam.pixelHeight);
            budget.EndFrame(pixelAngle, clock.Elapsed.TotalMilliseconds);

            drawnTiles = 0;
            var rp = new RenderParams(material) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            foreach (var (t, d) in drawn)
            {
                if (!t.Set.Visible || t.Set.Shown <= 0) continue;
                if (t.Applied != t.Set.Shown)
                {
                    t.Mesh.SetSubMesh(0, new SubMeshDescriptor(0, t.Set.Shown * 3) { bounds = t.Mesh.bounds },
                        MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontNotifyMeshUsers);
                    t.Applied = t.Set.Shown;
                }
                Graphics.RenderMesh(rp, t.Mesh, 0, SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, 1));
                drawnTiles++;
            }
            shownTriangles = budget.ShownTriangles;
            minPixels = (float)budget.MinPixels;
            residentTiles = cache.Count;
            uploadedTiles = gpu.Count;
        }

        private TileBuildings Upload(BuildingTileMesh m)
        {
            int n = m.Triangles * 3;
            var layout = new[]
            {
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.Float32, 3, 0),
                new VertexAttributeDescriptor(VertexAttribute.Normal, VertexAttributeFormat.SNorm8, 4, 1),
                new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4, 2),
            };
            var mesh = new Mesh { name = $"buildings {m.Id}", indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertexBufferParams(n, layout);
            var normals = new NativeArray<sbyte>(n * 4, Allocator.Temp, NativeArrayOptions.ClearMemory);
            var colors = new NativeArray<byte>(n * 4, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            try
            {
                for (int i = 0; i < n; i++)
                {
                    normals[i * 4] = m.Normals[i * 3];
                    normals[i * 4 + 1] = m.Normals[i * 3 + 1];
                    normals[i * 4 + 2] = m.Normals[i * 3 + 2];
                    // A measured roof colour where there is one (and the colour mode shows them), else the tone.
                    if (rawRoofColours && m.RawColors[i * 4 + 3] > 127)
                    {
                        colors[i * 4] = m.RawColors[i * 4];
                        colors[i * 4 + 1] = m.RawColors[i * 4 + 1];
                        colors[i * 4 + 2] = m.RawColors[i * 4 + 2];
                    }
                    else
                    {
                        int rgb = BuildingTones.Noon[m.Tones[i] % BuildingTones.Noon.Count];
                        colors[i * 4] = (byte)(rgb >> 16);
                        colors[i * 4 + 1] = (byte)(rgb >> 8);
                        colors[i * 4 + 2] = (byte)rgb;
                    }
                    colors[i * 4 + 3] = 255;
                }
                const MeshUpdateFlags quiet = MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds
                    | MeshUpdateFlags.DontNotifyMeshUsers;
                using (var pos = new NativeArray<float>(m.Positions, Allocator.Temp))
                {
                    mesh.SetVertexBufferData(pos, 0, 0, pos.Length, 0, quiet);
                }
                mesh.SetVertexBufferData(normals, 0, 0, normals.Length, 1, quiet);
                mesh.SetVertexBufferData(colors, 0, 0, colors.Length, 2, quiet);

                Vector3 min = Vector3.positiveInfinity, max = Vector3.negativeInfinity;
                for (int i = 0; i < n; i++)
                {
                    var p = new Vector3(m.Positions[i * 3], m.Positions[i * 3 + 1], m.Positions[i * 3 + 2]);
                    min = Vector3.Min(min, p);
                    max = Vector3.Max(max, p);
                }
                var bounds = new Bounds();
                bounds.SetMinMax(min, max);
                mesh.bounds = bounds;

                // Sequential indices: the draw range is a prefix of the soup.
                if (n > 65535)
                {
                    var idx = new NativeArray<int>(n, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
                    for (int i = 0; i < n; i++) idx[i] = i;
                    mesh.SetIndexBufferParams(n, IndexFormat.UInt32);
                    mesh.SetIndexBufferData(idx, 0, 0, n, quiet);
                    idx.Dispose();
                }
                else
                {
                    var idx = new NativeArray<ushort>(n, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
                    for (int i = 0; i < n; i++) idx[i] = (ushort)i;
                    mesh.SetIndexBufferParams(n, IndexFormat.UInt16);
                    mesh.SetIndexBufferData(idx, 0, 0, n, quiet);
                    idx.Dispose();
                }
                mesh.SetSubMesh(0, new SubMeshDescriptor(0, 0) { bounds = bounds }, quiet);
            }
            finally
            {
                normals.Dispose();
                colors.Dispose();
            }
            return new TileBuildings { Cpu = m, Set = new BuildingDrawSet(m), Mesh = mesh };
        }

        private void Release(TileKey key)
        {
            if (!gpu.TryGetValue(key, out TileBuildings t)) return;
            Destroy(t.Mesh);
            gpu.Remove(key);
        }

        private void OnDestroy()
        {
            foreach (TileBuildings t in gpu.Values) Destroy(t.Mesh);
            gpu.Clear();
            if (material != null) Destroy(material);
        }
    }
}
