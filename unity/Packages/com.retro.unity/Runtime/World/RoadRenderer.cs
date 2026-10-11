using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using Retro.Core;
using Retro.Game;
using Retro.Terrain;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// OSM roads and railway beds over the drawn terrain tiles (roadStrokes.ts,
    /// roadLod.ts on the ported <see cref="RoadStrokes"/>): each drawn, non-under
    /// tile's .ptr sidecar is streamed, uploaded in its wire formats once, and
    /// drawn per kind at the far road level its pixel footprint allows. Levels
    /// are simplified on demand within a frame budget, as terrainEntity.ts
    /// buildPendingLevels does.
    /// </summary>
    [DefaultExecutionOrder(102)]
    public sealed class RoadRenderer : MonoBehaviour
    {
        public TerrainRenderer terrain;
        public FlyCamera viewer;
        public RoadsMode mode = RoadsMode.All;
        [Tooltip("ROAD_LEVEL_BUILD_MS: time per frame for simplifying far road levels.")]
        public float levelBuildMs = 2;
        [Tooltip("Time per frame for uploading new tiles.")]
        public float uploadMs = 2;

        [Header("Stats (read only)")]
        public int residentTiles;
        public int uploadedTiles;
        public int drawnTiles;
        public int drawnTriangles;
        public int pendingLevels;

        private static readonly StrokeKind[] Kinds = { StrokeKind.Major, StrokeKind.Minor, StrokeKind.Rail };

        private sealed class TileRoads
        {
            public RoadTileMeshes Cpu;
            public Mesh Mesh;
            public float TileQuantScale;
            public RoadLevels[] Levels = new RoadLevels[3];
            /// <summary>Index lists in the index buffer, by reference (levels share arrays when a level saves too little).</summary>
            public readonly List<ushort[]> Lists = new List<ushort[]>();
            public readonly Dictionary<ushort[], int> Submesh = new Dictionary<ushort[], int>(ReferenceComparer.Instance);
            public bool Dirty;
        }

        private sealed class ReferenceComparer : IEqualityComparer<ushort[]>
        {
            public static readonly ReferenceComparer Instance = new ReferenceComparer();
            public bool Equals(ushort[] a, ushort[] b) => ReferenceEquals(a, b);
            public int GetHashCode(ushort[] a) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(a);
        }

        private string root;
        private TileIndex index;
        private TileCache<PtrTile> cache;
        private readonly Dictionary<TileKey, TileRoads> gpu = new Dictionary<TileKey, TileRoads>();
        private readonly Queue<(TileRoads Tile, int Kind, int Level)> levelQueue = new Queue<(TileRoads, int, int)>();
        private readonly HashSet<(TileRoads, int, int)> queuedLevels = new HashSet<(TileRoads, int, int)>();
        private Material[] materials;
        private Vec3d earthCentre;
        private readonly Stopwatch clock = new Stopwatch();
        private readonly Palette palette = Palettes.HdNoon;

        private bool TryBoot()
        {
            if (terrain == null || viewer == null || terrain.Session == null || terrain.Root == null) return false;
            root = terrain.Root;
            string indexPath = Path.Combine(root, "index_roads.bin");
            if (!File.Exists(indexPath))
            {
                enabled = false;
                return false;
            }
            index = TileIndex.Decode(File.ReadAllBytes(indexPath));
            cache = new TileCache<PtrTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".ptr"),
                TileFile.Ptr,
                t => t.Positions.Length * 2L + t.Directions.Length + t.HalfWidths.Length * 2L + t.Along.Length * 2L
                    + t.Flags.Length + t.Indices.Length * 2L + 128,
                RoadStrokes.CacheBytes);
            cache.Evicted += (k, _) => Release(k);
            Shader shader = Shader.Find("Retro/RoadStroke");
            materials = new Material[3];
            PaletteCategory[] tones = { PaletteCategory.SCENERY_ROAD_MAIN, PaletteCategory.SCENERY_ROAD_SECONDARY, PaletteCategory.SCENERY_RAIL };
            for (int i = 0; i < 3; i++)
            {
                materials[i] = new Material(shader) { name = "roads " + Kinds[i], renderQueue = 2001 };
                materials[i].SetColor("_Color", TerrainColours.FromHex(palette.Color(tones[i])));
            }
            earthCentre = Geodesy.SceneFromEnu(Geodesy.EcefToEnu(terrain.Session.Basis, new Vec3d(0, 0, 0)));
            return true;
        }

        private void Update()
        {
            if (cache == null && !TryBoot()) return;
            if (mode == RoadsMode.Off)
            {
                drawnTiles = 0;
                return;
            }

            Vec3d cam = viewer.ScenePosition;
            Camera unityCam = viewer.UnityCamera;
            double pixelAngle = RoadStrokes.PixelAngle(unityCam.fieldOfView, unityCam.pixelHeight);
            IReadOnlyList<DrawTile> draw = terrain.Session.DrawList;

            // Stream the sidecars of what is drawn, nearest first.
            cache.NextGeneration();
            var wants = new List<(TileKey, double)>();
            foreach (DrawTile d in draw)
            {
                if (d.Under || !index.Has(d.Key)) continue;
                if (cache.Get(d.Key) == null) wants.Add((d.Key, -(d.Origin - cam).Length));
            }
            cache.SetWants(wants);
            cache.Pump();

            clock.Restart();
            drawnTiles = 0;
            drawnTriangles = 0;
            foreach (DrawTile d in draw)
            {
                // A parent drawn under its dissolving leaves leaves the roads to them (setUnder).
                if (d.Under) continue;
                if (!gpu.TryGetValue(d.Key, out TileRoads t))
                {
                    PtrTile ptr = cache.Peek(d.Key);
                    if (ptr == null || clock.Elapsed.TotalMilliseconds > uploadMs) continue;
                    t = Upload(ptr, d);
                    gpu[d.Key] = t;
                }
                double nearM = Math.Max(0, (d.Origin - cam).Length - Tiling.ApproxEdgeMetres(d.Key) * 0.75);
                int level = RoadLod.LevelFor(nearM * pixelAngle);
                DrawTileRoads(t, d, cam, level);
            }
            BuildPendingLevels();
            residentTiles = cache.Count;
            uploadedTiles = gpu.Count;
            pendingLevels = levelQueue.Count;
        }

        private TileRoads Upload(PtrTile ptr, DrawTile d)
        {
            var t = new TileRoads { TileQuantScale = d.Tile.QuantScale };
            t.Cpu = RoadStrokes.Build(ptr, d.Tile.QuantScale);
            // The tile's local vertical, for simplifying in the tile's own axes.
            Vec3d up = (d.Origin - earthCentre).Normalized().Rotate(d.FrameFix.Conjugate());
            for (int k = 0; k < 3; k++)
            {
                ushort[] full = t.Cpu.Of(Kinds[k]);
                if (full != null) t.Levels[k] = new RoadLevels(ptr, full, up.X, up.Y, up.Z);
            }
            t.Mesh = BuildVertexMesh(ptr);
            for (int k = 0; k < 3; k++)
            {
                if (t.Levels[k] != null) AddList(t, t.Levels[k].Get(0));
            }
            ApplyIndices(t);
            return t;
        }

        private static Mesh BuildVertexMesh(PtrTile ptr)
        {
            int n = ptr.HalfWidths.Length;
            var layout = new[]
            {
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.SNorm16, 4, 0),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.SNorm8, 4, 1),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord1, VertexAttributeFormat.UNorm16, 2, 2),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord2, VertexAttributeFormat.UNorm8, 4, 3),
            };
            var mesh = new Mesh { name = $"roads {ptr.Id}" };
            mesh.SetVertexBufferParams(n, layout);
            var pos = new NativeArray<short>(n * 4, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            var dir = new NativeArray<sbyte>(n * 4, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            var half = new NativeArray<ushort>(n * 2, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            var flags = new NativeArray<byte>(n * 4, Allocator.Temp, NativeArrayOptions.ClearMemory);
            try
            {
                Vector3 min = Vector3.positiveInfinity, max = Vector3.negativeInfinity;
                for (int i = 0; i < n; i++)
                {
                    short x = ptr.Positions[i * 3], y = ptr.Positions[i * 3 + 1], z = ptr.Positions[i * 3 + 2];
                    pos[i * 4] = x;
                    pos[i * 4 + 1] = y;
                    pos[i * 4 + 2] = z;
                    pos[i * 4 + 3] = 0;
                    var p = new Vector3(x, y, z) / (float)TileMeshUpload.SNorm16Max;
                    min = Vector3.Min(min, p);
                    max = Vector3.Max(max, p);
                    for (int c = 0; c < 4; c++) dir[i * 4 + c] = ptr.Directions[i * 4 + c];
                    half[i * 2] = ptr.HalfWidths[i];
                    half[i * 2 + 1] = ptr.Along.Length > i ? ptr.Along[i] : (ushort)0;
                    flags[i * 4] = ptr.Flags.Length > i ? ptr.Flags[i] : (byte)0;
                }
                const MeshUpdateFlags quiet = MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds
                    | MeshUpdateFlags.DontNotifyMeshUsers;
                mesh.SetVertexBufferData(pos, 0, 0, pos.Length, 0, quiet);
                mesh.SetVertexBufferData(dir, 0, 0, dir.Length, 1, quiet);
                mesh.SetVertexBufferData(half, 0, 0, half.Length, 2, quiet);
                mesh.SetVertexBufferData(flags, 0, 0, flags.Length, 3, quiet);
                // Strokes are widened in the vertex shader; pad the bounds by the widest half width.
                var bounds = new Bounds();
                bounds.SetMinMax(min, max);
                mesh.bounds = bounds;
            }
            finally
            {
                pos.Dispose();
                dir.Dispose();
                half.Dispose();
                flags.Dispose();
            }
            return mesh;
        }

        private static void AddList(TileRoads t, ushort[] list)
        {
            if (list == null || t.Submesh.ContainsKey(list)) return;
            t.Submesh[list] = t.Lists.Count;
            t.Lists.Add(list);
            t.Dirty = true;
        }

        /// <summary>One index buffer holding every list built so far, a submesh each.</summary>
        private static void ApplyIndices(TileRoads t)
        {
            if (!t.Dirty) return;
            t.Dirty = false;
            int total = 0;
            foreach (ushort[] l in t.Lists) total += l.Length;
            t.Mesh.SetIndexBufferParams(Math.Max(total, 3), IndexFormat.UInt16);
            var all = new NativeArray<ushort>(Math.Max(total, 3), Allocator.Temp);
            try
            {
                var descriptors = new SubMeshDescriptor[t.Lists.Count];
                int at = 0;
                for (int i = 0; i < t.Lists.Count; i++)
                {
                    NativeArray<ushort>.Copy(t.Lists[i], 0, all, at, t.Lists[i].Length);
                    descriptors[i] = new SubMeshDescriptor(at, t.Lists[i].Length) { bounds = t.Mesh.bounds };
                    at += t.Lists[i].Length;
                }
                const MeshUpdateFlags quiet = MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds
                    | MeshUpdateFlags.DontNotifyMeshUsers;
                t.Mesh.SetIndexBufferData(all, 0, 0, all.Length, quiet);
                Bounds keep = t.Mesh.bounds;
                t.Mesh.SetSubMeshes(descriptors, quiet);
                t.Mesh.bounds = keep;
            }
            finally
            {
                all.Dispose();
            }
        }

        private void DrawTileRoads(TileRoads t, DrawTile d, Vec3d cam, int level)
        {
            double scale = t.Cpu.GroupScale * t.TileQuantScale * TileMeshUpload.SNorm16Max;
            Matrix4x4 matrix = SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, scale);
            bool any = false;
            for (int k = 0; k < 3; k++)
            {
                RoadLevels levels = t.Levels[k];
                if (levels == null) continue;
                if (mode == RoadsMode.Major && Kinds[k] == StrokeKind.Minor) continue;
                if (!levels.Has(level) && queuedLevels.Add((t, k, level))) levelQueue.Enqueue((t, k, level));
                ushort[] list = levels.Get(level);
                if (!t.Submesh.TryGetValue(list, out int sub)) continue;
                var rp = new RenderParams(materials[k]) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
                Graphics.RenderMesh(rp, t.Mesh, sub, matrix);
                drawnTriangles += list.Length / 3;
                any = true;
            }
            if (any) drawnTiles++;
        }

        private void BuildPendingLevels()
        {
            var watch = Stopwatch.StartNew();
            while (levelQueue.Count > 0 && watch.Elapsed.TotalMilliseconds < levelBuildMs)
            {
                var (t, k, level) = levelQueue.Dequeue();
                queuedLevels.Remove((t, k, level));
                if (t.Mesh == null) continue;
                t.Levels[k].Build(level);
                AddList(t, t.Levels[k].Get(level));
                ApplyIndices(t);
            }
        }

        private void Release(TileKey key)
        {
            if (!gpu.TryGetValue(key, out TileRoads t)) return;
            Destroy(t.Mesh);
            t.Mesh = null;
            gpu.Remove(key);
        }

        private void OnDestroy()
        {
            foreach (TileRoads t in gpu.Values) Destroy(t.Mesh);
            gpu.Clear();
            if (materials != null) foreach (Material m in materials) Destroy(m);
        }
    }
}
