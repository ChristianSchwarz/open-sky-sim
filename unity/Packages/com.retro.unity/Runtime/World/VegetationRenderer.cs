using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Retro.Core;
using Retro.Game;
using Retro.Terrain;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>
    /// Trees, shrubs and rocks on the drawn tiles (terrainEntity.ts attachTrees on
    /// the ported <see cref="TileVegetation"/>): each drawn, non-under tile with
    /// tree or open-ground cover is scattered on a worker thread, clear of its
    /// roads, buildings and the area's airfields, at the density its distance
    /// asks for; rescattered when that density moves past a factor of 1.6.
    /// Every 4x4 cell is one procedural instanced draw of a prefix of its
    /// shuffled instances.
    /// </summary>
    [DefaultExecutionOrder(104)]
    public sealed class VegetationRenderer : MonoBehaviour
    {
        public TerrainRenderer terrain;
        public FlyCamera viewer;
        [Range(0, 20)] public float densityMultiplier = 1;

        [Header("Stats (read only)")]
        public int scatteredTiles;
        public int drawnCells;
        public int drawnInstances;
        public int pendingScatters;

        [StructLayout(LayoutKind.Sequential)]
        private struct Instance
        {
            public Vector3 Position;
            public float Scale;
            public Vector3 Normal;
            public float Kind;
            public Vector4 Shade;
        }

        private sealed class Draw
        {
            public BillboardInstances Cpu;
            public GraphicsBuffer Buffer;
            public Vector3 SphereCenter;
        }

        private sealed class TileTrees
        {
            public double DensityScale;
            public List<Draw> Cells = new List<Draw>();
            public Draw Stones;
            public Task<TileVegetation> Pending;
            public double PendingScale;
            public int LastSeenFrame;
        }

        private string root;
        private TileIndex roadIndex, buildingIndex, bedIndex;
        private Func<double, double, bool> onAirfield;
        private readonly Dictionary<TileKey, TileTrees> tiles = new Dictionary<TileKey, TileTrees>();
        private Mesh treeQuad, stoneQuad;
        private Material treeMaterial, stoneMaterial;
        private MaterialPropertyBlock props;
        private static readonly int InstancesId = Shader.PropertyToID("_Instances");
        private static readonly int TileMatrixId = Shader.PropertyToID("_TileMatrix");
        private static readonly int SpacingId = Shader.PropertyToID("_SpacingM");
        private static readonly int InvCountId = Shader.PropertyToID("_InvCount");

        private bool TryBoot()
        {
            if (terrain == null || viewer == null || terrain.Session == null || terrain.Root == null) return false;
            root = terrain.Root;
            roadIndex = LoadIndex("index_roads.bin");
            buildingIndex = LoadIndex("index_buildings.bin");
            bedIndex = LoadIndex("index_beds.bin");

            // The area's airfields, once (airfieldExclusion.ts), in the play frame.
            EnuBasis basis = terrain.Session.Basis;
            string airfieldsPath = Path.Combine(root, "airfields.json");
            if (File.Exists(airfieldsPath))
            {
                var footprints = new List<AirfieldFootprint>();
                foreach (Airfield a in AirfieldsJson.Parse(File.ReadAllText(airfieldsPath)).Items) footprints.Add(Footprint(a));
                onAirfield = AirfieldExclusion.Build(footprints, (lat, lon, h) =>
                {
                    Enu e = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, h));
                    return (e.E, e.N);
                });
            }

            Texture2D treeAtlas = LoadAtlas("TreeAtlas.png");
            Texture2D stoneAtlas = LoadAtlas("StoneAtlas.png");
            if (treeAtlas == null || stoneAtlas == null)
            {
                Debug.LogWarning("Retro vegetation: atlases not found under unity/Packages/com.retro.unity/Textures");
                enabled = false;
                return false;
            }
            Shader shader = Shader.Find("Retro/VegetationBillboard");
            treeMaterial = new Material(shader) { name = "trees" };
            treeMaterial.SetTexture("_MainTex", treeAtlas);
            ScenePalette.Bind(treeMaterial, "_Palette", PaletteCategory.TERRAIN_FOREST);
            treeMaterial.SetColor("_NoonForest", TerrainColours.FromHex("#2f6b3c"));
            stoneMaterial = new Material(shader) { name = "stones" };
            stoneMaterial.SetTexture("_MainTex", stoneAtlas);
            ScenePalette.Bind(stoneMaterial, "_Palette", PaletteCategory.TERRAIN_BARE);
            stoneMaterial.SetColor("_NoonForest", TerrainColours.FromHex("#2f6b3c"));
            treeQuad = Quad(TreeBillboards.QuadPositions, TreeBillboards.QuadUvs, TreeBillboards.QuadIndices);
            var stoneIdx = new int[GroundClutter.QuadPositions.Length / 3];
            for (int i = 0; i < stoneIdx.Length; i++) stoneIdx[i] = i;
            stoneQuad = Quad(GroundClutter.QuadPositions, GroundClutter.QuadUvs, stoneIdx);
            props = new MaterialPropertyBlock();
            return true;
        }

        private TileIndex LoadIndex(string name)
        {
            string p = Path.Combine(root, name);
            return File.Exists(p) ? TileIndex.Decode(File.ReadAllBytes(p)) : null;
        }

        /// <summary>The atlases live beside this package's code; found by walking up from the project, as the terrain is.</summary>
        private static Texture2D LoadAtlas(string file)
        {
            var dir = new DirectoryInfo(Application.dataPath);
            for (int i = 0; i < 5 && dir != null; i++, dir = dir.Parent)
            {
                string p = Path.Combine(dir.FullName, "unity", "Packages", "com.retro.unity", "Textures", file);
                if (!File.Exists(p)) p = Path.Combine(dir.FullName, "Packages", "com.retro.unity", "Textures", file);
                if (!File.Exists(p)) continue;
                var tex = new Texture2D(2, 2, TextureFormat.RGBA32, true, false) { name = file };
                tex.LoadImage(File.ReadAllBytes(p));
                tex.wrapMode = TextureWrapMode.Clamp;
                tex.filterMode = FilterMode.Trilinear;
                tex.Apply(true, true);
                return tex;
            }
            return null;
        }

        private static AirfieldFootprint Footprint(Airfield a)
        {
            var f = new AirfieldFootprint { PlaneHeightMsl = a.Plane.HeightMsl };
            foreach (AirfieldRunway r in a.Runways)
            {
                f.Runways.Add(new RunwayFootprint { Lat = r.Lat, Lon = r.Lon, HeadingDeg = r.HeadingDeg, LengthM = r.LengthM, WidthM = r.WidthM });
            }
            foreach (AirfieldTaxiway t in a.Taxiways) f.Taxiways.Add(new TaxiwayFootprint { WidthM = t.WidthM, Points = t.Points });
            foreach (AirfieldApron p in a.Aprons) f.Aprons.Add(p.Ring);
            return f;
        }

        private static Mesh Quad(float[] positions, float[] uvs, int[] indices)
        {
            int n = positions.Length / 3;
            var v = new Vector3[n];
            var uv = new Vector2[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
                uv[i] = new Vector2(uvs[i * 2], uvs[i * 2 + 1]);
            }
            var mesh = new Mesh { name = "billboard quad" };
            mesh.SetVertices(v);
            mesh.SetUVs(0, uv);
            mesh.SetTriangles(indices, 0);
            // Procedural instances are placed in the shader; the bounds only have to never cull.
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            return mesh;
        }

        private void Update()
        {
            if (treeMaterial == null && !TryBoot()) return;
            Vec3d cam = viewer.ScenePosition;
            Camera unityCam = viewer.UnityCamera;
            double pixelAngle = 2 * Math.Tan(unityCam.fieldOfView * Math.PI / 360) / Math.Max(1, unityCam.pixelHeight);
            int frame = Time.frameCount;
            bool startedScatter = false;
            drawnCells = 0;
            drawnInstances = 0;
            pendingScatters = 0;

            foreach (DrawTile d in terrain.Session.DrawList)
            {
                // A tile drawn under its dissolving leaves leaves the trees to them.
                if (d.Under) continue;
                double want = TreeBillboards.TileDensityScale((d.Origin - cam).Length, densityMultiplier);
                if (!tiles.TryGetValue(d.Key, out TileTrees t))
                {
                    if (!TreeBillboards.HasVegetationSource(d.Tile)) continue;
                    t = new TileTrees { DensityScale = double.NaN };
                    tiles[d.Key] = t;
                }
                t.LastSeenFrame = frame;

                if (t.Pending != null)
                {
                    pendingScatters++;
                    if (t.Pending.IsCompleted) Apply(t);
                }
                // One scatter started per frame (treeInitialAttachesThisFrame), first scatters and rescatters alike.
                bool stale = double.IsNaN(t.DensityScale) ? want > 0 : TreeBillboards.NeedsRescatter(want, t.DensityScale);
                if (t.Pending == null && stale && !startedScatter)
                {
                    startedScatter = true;
                    t.PendingScale = want;
                    t.Pending = Scatter(d, want);
                }
                DrawTrees(t, d, cam, pixelAngle);
            }

            // Release what has not been drawn for a while.
            var gone = new List<TileKey>();
            foreach (var kv in tiles)
            {
                if (frame - kv.Value.LastSeenFrame > 120 && kv.Value.Pending == null) gone.Add(kv.Key);
            }
            foreach (TileKey k in gone)
            {
                Release(tiles[k]);
                tiles.Remove(k);
            }
            scatteredTiles = tiles.Count;
        }

        private Task<TileVegetation> Scatter(DrawTile d, double densityScale)
        {
            PtmTile tile = d.Tile;
            TileKey key = d.Key;
            Vec3d origin = d.Origin;
            Quatd frameFix = d.FrameFix;
            bool hasRoads = roadIndex != null && roadIndex.Has(key);
            bool hasBuildings = buildingIndex != null && buildingIndex.Has(key);
            bool hasBeds = bedIndex != null && bedIndex.Has(key);
            EnuBasis bakeBasis = terrain.Session.BakeBasis;
            int maxZoom = terrain.MaxZoom;
            Func<double, double, bool> airfields = onAirfield;
            string dir = Path.Combine(root, key.Z.ToString(), key.X.ToString());
            return Task.Run(() =>
            {
                if (densityScale <= 0) return new TileVegetation { DensityScale = 0 };
                Func<double, double, bool> road = null;
                if (hasRoads)
                {
                    string p = Path.Combine(dir, key.Y + ".ptr");
                    RoadExclusion r = File.Exists(p) ? RoadExclusion.Build(TileFile.Ptr(File.ReadAllBytes(p))) : null;
                    if (r != null) road = r.Test;
                }
                Func<double, double, double, bool> building = null;
                if (hasBuildings)
                {
                    string p = Path.Combine(dir, key.Y + ".pbh");
                    BuildingExclusion b = File.Exists(p) ? BuildingExclusion.Build(TileFile.Pbh(File.ReadAllBytes(p))) : null;
                    if (b != null) building = b.Contains;
                }
                // Off the railway beds and their batters (loadBeds): the bed's own vertical, a 32 m grid at the leaf.
                Func<double, double, double, bool> bed = null;
                if (hasBeds)
                {
                    string p = Path.Combine(dir, key.Y + ".pbd");
                    PbdTile pbd = File.Exists(p) ? TileFile.Pbd(File.ReadAllBytes(p)) : null;
                    if (pbd != null && pbd.Beds.Length > 0)
                    {
                        bed = RailBedExclusion.Build(pbd.Beds, RailBedExclusion.TileUp(bakeBasis, key), RailBedExclusion.CellMFor(key.Z, maxZoom));
                    }
                }
                // No surface pads: the Unity world places no scenery pads yet (surfaceExclusion.ts has nothing to test).
                Func<double, double, double, bool> manMade = VegetationExclusion.ForTile(origin, frameFix, airfields, null, null, null);
                return TileVegetation.Build(tile, densityScale, VegetationExclusion.Combine(road, bed, manMade, building));
            });
        }

        private void Apply(TileTrees t)
        {
            Task<TileVegetation> task = t.Pending;
            t.Pending = null;
            if (task.IsFaulted)
            {
                Debug.LogException(task.Exception);
                t.DensityScale = t.PendingScale;
                return;
            }
            Release(t);
            TileVegetation v = task.Result;
            t.DensityScale = t.PendingScale;
            foreach (BillboardInstances cell in v.TreeCells) t.Cells.Add(Upload(cell));
            if (v.Stones != null) t.Stones = Upload(v.Stones);
        }

        private static Draw Upload(BillboardInstances b)
        {
            var data = new Instance[b.Count];
            for (int i = 0; i < b.Count; i++)
            {
                data[i] = new Instance
                {
                    Position = new Vector3(b.Positions[i * 3], b.Positions[i * 3 + 1], b.Positions[i * 3 + 2]),
                    Scale = b.Scales[i],
                    Normal = new Vector3(b.Normals[i * 3], b.Normals[i * 3 + 1], b.Normals[i * 3 + 2]),
                    Kind = b.Kinds[i],
                    Shade = new Vector4(b.Shade[i * 4], b.Shade[i * 4 + 1], b.Shade[i * 4 + 2], b.Shade[i * 4 + 3]),
                };
            }
            var buffer = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Math.Max(1, b.Count), Marshal.SizeOf<Instance>());
            if (b.Count > 0) buffer.SetData(data);
            return new Draw
            {
                Cpu = b,
                Buffer = buffer,
                SphereCenter = new Vector3((float)b.SphereCenter.X, (float)b.SphereCenter.Y, (float)b.SphereCenter.Z),
            };
        }

        private void DrawTrees(TileTrees t, DrawTile d, Vec3d cam, double pixelAngle)
        {
            Matrix4x4 matrix = SceneFrame.TileMatrix(d.Origin, cam, d.FrameFix, 1);
            foreach (Draw cell in t.Cells) Submit(cell, treeMaterial, treeQuad, d, cam, pixelAngle, matrix);
            if (t.Stones != null) Submit(t.Stones, stoneMaterial, stoneQuad, d, cam, pixelAngle, matrix);
        }

        private void Submit(Draw draw, Material material, Mesh quad, DrawTile d, Vec3d cam, double pixelAngle, Matrix4x4 matrix)
        {
            BillboardInstances b = draw.Cpu;
            if (b.Total == 0) return;
            Vec3d centre = d.Origin + b.SphereCenter.Rotate(d.FrameFix);
            int count = b.Stones
                ? b.Total
                : TreeBillboards.InstancesToDraw(b, TreeBillboards.NearDistance(centre, b.SphereRadius, cam), pixelAngle);
            if (count <= 0) return;
            props.SetBuffer(InstancesId, draw.Buffer);
            props.SetMatrix(TileMatrixId, matrix);
            props.SetFloat(SpacingId, (float)b.SpacingM);
            props.SetFloat(InvCountId, (float)b.InvCount);
            var rp = new RenderParams(material)
            {
                matProps = props,
                shadowCastingMode = ShadowCastingMode.Off,
                receiveShadows = false,
                worldBounds = new Bounds(SceneFrame.ToUnity(centre - cam), Vector3.one * (float)(2 * b.SphereRadius + 40)),
            };
            Graphics.RenderMeshPrimitives(rp, quad, 0, count);
            drawnCells++;
            drawnInstances += count;
        }

        private static void Release(TileTrees t)
        {
            foreach (Draw c in t.Cells) c.Buffer?.Release();
            t.Cells.Clear();
            t.Stones?.Buffer?.Release();
            t.Stones = null;
        }

        private void OnDestroy()
        {
            foreach (TileTrees t in tiles.Values) Release(t);
            tiles.Clear();
        }
    }
}
