using System;
using System.Collections.Generic;
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
    /// Road and rail bridges on the drawn z12 leaves (bridgeMeshes.ts on the
    /// ported <see cref="BridgeMeshes"/>): decks, concrete and rail decks from
    /// the .pbr sidecar's shared vertices, level-crossing furniture as boxes,
    /// and the track along a rail deck drawn with the road layer's three rail
    /// passes. Every part hides once it is under half a pixel across
    /// (<see cref="BridgeMeshes.ShowPart"/>). Lit, double-sided, depth-writing.
    /// </summary>
    [DefaultExecutionOrder(103)]
    public sealed class BridgeRenderer : MonoBehaviour
    {
        public TerrainRenderer terrain;
        public FlyCamera viewer;
        [Tooltip("Supplies the rail bed, sleeper and rail materials for deck tracks.")]
        public RoadRenderer roads;

        [Header("Stats (read only)")]
        public int residentTiles;
        public int drawnParts;

        private const int LeafZoom = 12;

        private sealed class TileBridges
        {
            public BridgeTileMeshes Cpu;
            public float TileQuantScale;
            /// <summary>The shared vertices, a submesh per role slot that has bridge geometry.</summary>
            public Mesh Shared;
            public int[] SlotSubmesh = { -1, -1, -1, -1, -1, -1 };
            /// <summary>Box parts (slots or extras), each its own float mesh.</summary>
            public List<(BridgePart Part, Mesh Mesh)> Boxes = new List<(BridgePart, Mesh)>();
            public Mesh Track;
        }

        private string root;
        private TileIndex index;
        private TileCache<PbrTile> cache;
        private readonly Dictionary<TileKey, TileBridges> gpu = new Dictionary<TileKey, TileBridges>();
        private readonly Material[] roleMaterials = new Material[6];

        private bool TryBoot()
        {
            if (terrain == null || viewer == null || terrain.Session == null || terrain.Root == null) return false;
            root = terrain.Root;
            string indexPath = Path.Combine(root, "index_bridges.bin");
            if (!File.Exists(indexPath))
            {
                enabled = false;
                return false;
            }
            index = TileIndex.Decode(File.ReadAllBytes(indexPath));
            cache = new TileCache<PbrTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".pbr"),
                TileFile.Pbr,
                t => t.Positions.Length * 2L + t.Normals.Length + t.Indices.Length * 2L + 256,
                BridgeMeshes.CacheBytes);
            cache.Evicted += (k, _) => Release(k);
            Shader lit = Shader.Find("Retro/SceneryLit");
            Palette palette = Palettes.HdNoon;
            PaletteCategory[] tones =
            {
                PaletteCategory.SCENERY_ROAD_MAIN, PaletteCategory.SCENERY_ROAD_SECONDARY, PaletteCategory.SCENERY_RAIL,
                PaletteCategory.SCENERY_BUILDING_METAL_RED, PaletteCategory.SCENERY_BUILDING_METAL_WHITE, PaletteCategory.SCENERY_BUILDING_METAL,
            };
            for (int r = 0; r < 6; r++)
            {
                roleMaterials[r] = new Material(lit) { name = "bridge " + (BridgeRole)r };
                roleMaterials[r].SetColor("_Color", TerrainColours.FromHex(palette.Color(tones[r])));
                roleMaterials[r].SetFloat("_Cull", (float)CullMode.Off);
            }
            return true;
        }

        private void Update()
        {
            if (cache == null && !TryBoot()) return;
            Vec3d cam = viewer.ScenePosition;
            Camera unityCam = viewer.UnityCamera;
            double pixelAngle = RoadStrokes.PixelAngle(unityCam.fieldOfView, unityCam.pixelHeight);
            double trackReach = RoadStrokes.TrackDetailReachM(unityCam.fieldOfView, unityCam.aspect, unityCam.pixelHeight);
            IReadOnlyList<DrawTile> draw = terrain.Session.DrawList;

            cache.NextGeneration();
            var wants = new List<(TileKey, double)>();
            foreach (DrawTile d in draw)
            {
                if (d.Under || d.Key.Z != LeafZoom || !index.Has(d.Key)) continue;
                if (cache.Get(d.Key) == null) wants.Add((d.Key, -(d.Origin - cam).Length));
            }
            cache.SetWants(wants);
            cache.Pump();

            drawnParts = 0;
            bool uploaded = false;
            foreach (DrawTile d in draw)
            {
                if (d.Under || d.Key.Z != LeafZoom) continue;
                if (!gpu.TryGetValue(d.Key, out TileBridges t))
                {
                    PbrTile pbr = cache.Peek(d.Key);
                    if (pbr == null || uploaded) continue;
                    t = Upload(pbr, d.Tile.QuantScale);
                    gpu[d.Key] = t;
                    uploaded = true; // one tile a frame
                }
                DrawBridges(t, d, cam, pixelAngle, trackReach);
            }
            residentTiles = cache.Count;
        }

        private static TileBridges Upload(PbrTile pbr, float tileQuantScale)
        {
            var t = new TileBridges { Cpu = BridgeMeshes.Build(pbr, tileQuantScale), TileQuantScale = tileQuantScale };
            BridgeTileMeshes cpu = t.Cpu;
            var lists = new List<ushort[]>();
            for (int r = 0; r < 6; r++)
            {
                BridgePart p = cpu.Slots[r];
                if (p == null) continue;
                if (p.Indices != null)
                {
                    t.SlotSubmesh[r] = lists.Count;
                    lists.Add(p.Indices);
                }
                else
                {
                    t.Boxes.Add((p, BoxMesh(p.Box)));
                }
            }
            foreach (BridgePart p in cpu.Extra) t.Boxes.Add((p, BoxMesh(p.Box)));
            if (lists.Count > 0) t.Shared = SharedMesh(pbr, lists);
            if (cpu.Track != null)
            {
                t.Track = RoadRenderer.BuildVertexMesh(cpu.Track);
                ushort[] idx = cpu.Track.Indices;
                t.Track.SetIndexBufferParams(idx.Length, IndexFormat.UInt16);
                t.Track.SetIndexBufferData(idx, 0, 0, idx.Length, MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices);
                Bounds b = t.Track.bounds;
                t.Track.SetSubMesh(0, new SubMeshDescriptor(0, idx.Length) { bounds = b }, MeshUpdateFlags.DontRecalculateBounds);
                t.Track.bounds = b;
            }
            return t;
        }

        private static Mesh SharedMesh(PbrTile pbr, List<ushort[]> lists)
        {
            int n = pbr.Positions.Length / 3;
            var mesh = new Mesh { name = $"bridges {pbr.Id}" };
            mesh.SetVertexBufferParams(n,
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.SNorm16, 4, 0),
                new VertexAttributeDescriptor(VertexAttribute.Normal, VertexAttributeFormat.SNorm8, 4, 1));
            const MeshUpdateFlags quiet = MeshUpdateFlags.DontValidateIndices | MeshUpdateFlags.DontRecalculateBounds
                | MeshUpdateFlags.DontNotifyMeshUsers;
            using (var pos = new NativeArray<short>(n * 4, Allocator.Temp))
            {
                var p = pos;
                Vector3 min = Vector3.positiveInfinity, max = Vector3.negativeInfinity;
                for (int i = 0; i < n; i++)
                {
                    for (int c = 0; c < 3; c++) p[i * 4 + c] = pbr.Positions[i * 3 + c];
                    var v = new Vector3(pbr.Positions[i * 3], pbr.Positions[i * 3 + 1], pbr.Positions[i * 3 + 2]) / (float)TileMeshUpload.SNorm16Max;
                    min = Vector3.Min(min, v);
                    max = Vector3.Max(max, v);
                }
                mesh.SetVertexBufferData(p, 0, 0, p.Length, 0, quiet);
                var b = new Bounds();
                b.SetMinMax(min, max);
                mesh.bounds = b;
            }
            using (var nrm = new NativeArray<sbyte>(pbr.Normals, Allocator.Temp))
            {
                mesh.SetVertexBufferData(nrm, 0, 0, nrm.Length, 1, quiet);
            }
            int total = 0;
            foreach (ushort[] l in lists) total += l.Length;
            mesh.SetIndexBufferParams(total, IndexFormat.UInt16);
            var descriptors = new SubMeshDescriptor[lists.Count];
            int at = 0;
            for (int i = 0; i < lists.Count; i++)
            {
                mesh.SetIndexBufferData(lists[i], 0, at, lists[i].Length, quiet);
                descriptors[i] = new SubMeshDescriptor(at, lists[i].Length) { bounds = mesh.bounds };
                at += lists[i].Length;
            }
            Bounds keep = mesh.bounds;
            mesh.SetSubMeshes(descriptors, quiet);
            mesh.bounds = keep;
            return mesh;
        }

        private static Mesh BoxMesh(BridgeBoxMesh box)
        {
            int n = box.Positions.Length / 3;
            var v = new Vector3[n];
            var nm = new Vector3[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(box.Positions[i * 3], box.Positions[i * 3 + 1], box.Positions[i * 3 + 2]);
                nm[i] = new Vector3(box.Normals[i * 3], box.Normals[i * 3 + 1], box.Normals[i * 3 + 2]);
            }
            var idx = new int[box.Indices.Length];
            for (int i = 0; i < idx.Length; i++) idx[i] = (int)box.Indices[i];
            var mesh = new Mesh { name = "bridge furniture", indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(v);
            mesh.SetNormals(nm);
            mesh.SetTriangles(idx, 0);
            return mesh;
        }

        /// <summary>A part's near-edge distance: its bounds sphere, placed with the tile, from the camera.</summary>
        private static double NearM(BoundsSphere s, double scale, DrawTile d, Vec3d cam)
        {
            Vec3d centre = d.Origin + (new Vec3d(s.CenterX, s.CenterY, s.CenterZ) * scale).Rotate(d.FrameFix);
            return Math.Max(0, (centre - cam).Length - s.Radius * scale);
        }

        private void DrawBridges(TileBridges t, DrawTile d, Vec3d cam, double pixelAngle, double trackReach)
        {
            double metres = t.Cpu.GroupScale * t.TileQuantScale;
            Matrix4x4 shared = SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, metres * TileMeshUpload.SNorm16Max);
            for (int r = 0; r < 6; r++)
            {
                BridgePart p = t.Cpu.Slots[r];
                if (p == null || t.SlotSubmesh[r] < 0) continue;
                if (!BridgeMeshes.ShowPart(NearM(p.Bounds, metres, d, cam), pixelAngle, BridgeMeshes.HidePixelM(p.Role))) continue;
                Graphics.RenderMesh(Params(roleMaterials[r]), t.Shared, t.SlotSubmesh[r], shared);
                drawnParts++;
            }
            if (t.Boxes.Count > 0)
            {
                Matrix4x4 boxes = SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, metres);
                foreach (var (p, mesh) in t.Boxes)
                {
                    if (!BridgeMeshes.ShowPart(NearM(p.Bounds, metres, d, cam), pixelAngle, BridgeMeshes.HidePixelM(p.Role))) continue;
                    Graphics.RenderMesh(Params(roleMaterials[(int)p.Role]), mesh, 0, boxes);
                    drawnParts++;
                }
            }
            if (t.Track != null && roads != null && roads.RailBedMaterial != null)
            {
                double nearM = NearM(t.Cpu.TrackBounds, metres, d, cam);
                if (!BridgeMeshes.ShowPart(nearM, pixelAngle, BridgeMeshes.TrackHidePixelM)) return;
                Graphics.RenderMesh(Params(roads.RailBedMaterial), t.Track, 0, shared);
                if (nearM <= trackReach)
                {
                    Graphics.RenderMesh(Params(roads.SleeperMaterial), t.Track, 0, shared);
                    Graphics.RenderMesh(Params(roads.RailMaterial), t.Track, 0, shared);
                }
                drawnParts++;
            }
        }

        private static RenderParams Params(Material m) =>
            new RenderParams(m) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };

        private void Release(TileKey key)
        {
            if (!gpu.TryGetValue(key, out TileBridges t)) return;
            if (t.Shared != null) Destroy(t.Shared);
            if (t.Track != null) Destroy(t.Track);
            foreach (var (_, m) in t.Boxes) Destroy(m);
            gpu.Remove(key);
        }

        private void OnDestroy()
        {
            foreach (TileKey k in new List<TileKey>(gpu.Keys)) Release(k);
            foreach (Material m in roleMaterials) if (m != null) Destroy(m);
        }
    }
}
