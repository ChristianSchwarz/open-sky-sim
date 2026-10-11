using System.Collections.Generic;
using System.IO;
using Retro.Core;
using Retro.Game;
using Retro.Terrain;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// The railway retaining walls the bake grades into cuttings and embankments
    /// (terrainEntity.ts loadBeds / railWallMesh): each drawn, non-under tile's
    /// .pbd walls, tile-local metres, lit and double-sided in the bridges'
    /// concrete tone.
    /// </summary>
    [DefaultExecutionOrder(103)]
    public sealed class RailWallRenderer : MonoBehaviour
    {
        public TerrainRenderer terrain;
        public FlyCamera viewer;

        [Header("Stats (read only)")]
        public int residentTiles;
        public int drawnTiles;

        private string root;
        private TileIndex index;
        private TileCache<PbdTile> cache;
        private readonly Dictionary<TileKey, Mesh> gpu = new Dictionary<TileKey, Mesh>();
        private readonly HashSet<TileKey> empty = new HashSet<TileKey>();
        private Material material;

        private bool TryBoot()
        {
            if (terrain == null || viewer == null || terrain.Session == null || terrain.Root == null) return false;
            root = terrain.Root;
            string indexPath = Path.Combine(root, "index_beds.bin");
            if (!File.Exists(indexPath))
            {
                enabled = false;
                return false;
            }
            index = TileIndex.Decode(File.ReadAllBytes(indexPath));
            cache = new TileCache<PbdTile>(
                k => Path.Combine(root, k.Z.ToString(), k.X.ToString(), k.Y + ".pbd"),
                TileFile.Pbd,
                t => t.Beds.Length * 8L + (t.Walls != null ? t.Walls.Positions.Length * 8L + t.Walls.Indices.Length * 4L : 0) + 128,
                16L << 20);
            cache.Evicted += (k, _) =>
            {
                if (gpu.TryGetValue(k, out Mesh m)) Destroy(m);
                gpu.Remove(k);
                empty.Remove(k);
            };
            material = new Material(Shader.Find("Retro/SceneryLit")) { name = "rail walls" };
            ScenePalette.Bind(material, "_Color", PaletteCategory.SCENERY_ROAD_SECONDARY);
            material.SetFloat("_Cull", (float)CullMode.Off);
            return true;
        }

        private void Update()
        {
            if (cache == null && !TryBoot()) return;
            Vec3d cam = viewer.ScenePosition;
            IReadOnlyList<DrawTile> draw = terrain.Session.DrawList;
            cache.NextGeneration();
            var wants = new List<(TileKey, double)>();
            foreach (DrawTile d in draw)
            {
                if (d.Under || !index.Has(d.Key)) continue;
                if (cache.Get(d.Key) == null) wants.Add((d.Key, -(d.Origin - cam).Length));
            }
            cache.SetWants(wants);
            cache.Pump();

            drawnTiles = 0;
            var rp = new RenderParams(material) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };
            foreach (DrawTile d in draw)
            {
                if (d.Under || empty.Contains(d.Key)) continue;
                if (!gpu.TryGetValue(d.Key, out Mesh mesh))
                {
                    PbdTile pbd = cache.Peek(d.Key);
                    if (pbd == null) continue;
                    if (pbd.Walls == null || pbd.Walls.Indices.Length == 0)
                    {
                        empty.Add(d.Key);
                        continue;
                    }
                    mesh = Upload(pbd.Walls);
                    gpu[d.Key] = mesh;
                }
                Graphics.RenderMesh(rp, mesh, 0, SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, 1));
                drawnTiles++;
            }
            residentTiles = cache.Count;
        }

        private static Mesh Upload(RailWalls walls)
        {
            int n = walls.Positions.Length / 3;
            var v = new Vector3[n];
            var nm = new Vector3[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(walls.Positions[i * 3], walls.Positions[i * 3 + 1], walls.Positions[i * 3 + 2]);
                nm[i] = new Vector3(walls.Normals[i * 3], walls.Normals[i * 3 + 1], walls.Normals[i * 3 + 2]);
            }
            var idx = new int[walls.Indices.Length];
            for (int i = 0; i < idx.Length; i++) idx[i] = (int)walls.Indices[i];
            var mesh = new Mesh { name = "rail walls", indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(v);
            mesh.SetNormals(nm);
            mesh.SetTriangles(idx, 0);
            return mesh;
        }

        private void OnDestroy()
        {
            foreach (Mesh m in gpu.Values) Destroy(m);
            gpu.Clear();
            if (material != null) Destroy(material);
        }
    }
}
