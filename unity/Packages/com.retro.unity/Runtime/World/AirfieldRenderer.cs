using System;
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
    /// The real airfields around the camera (M5): runways with their paint,
    /// taxiways, aprons and building boxes from the ported
    /// <see cref="AirfieldGeometryBuilder"/>, built within <see cref="buildRadiusKm"/>
    /// as the web game streams them, drawn camera-relative at the web game's
    /// screen-size level of detail. Flats are unlit paint without depth write,
    /// drawn in the builder's order through their render queues; buildings are
    /// lit solids.
    /// </summary>
    [DefaultExecutionOrder(105)]
    public sealed class AirfieldRenderer : MonoBehaviour
    {
        public TerrainRenderer terrain;
        public FlyCamera viewer;
        [Tooltip("Ground for draping taxiways and buildings; without it they lie on the airfield plane.")]
        public PlayerFlight player;

        [Tooltip("Airfields are built within this distance (game.ts streams them at 50 km).")]
        public float buildRadiusKm = 50;
        [Tooltip("And released beyond this one.")]
        public float dropRadiusKm = 60;

        [Header("Stats (read only)")]
        public int knownAirfields;
        public int builtAirfields;
        public int drawnAirfields;
        public float lastBuildMs;

        private const int FlatQueueBase = 2010;

        private sealed class Gpu
        {
            public Mesh Mesh;
            public Material Material;
        }

        private sealed class Built
        {
            public AirfieldGeometry Geometry;
            public List<Gpu>[] Flats;
            public List<Gpu>[] Volumes;
            public Texture2D[] Marks;
        }

        private readonly List<(Airfield Airfield, Vec3d Centre)> airfields = new List<(Airfield, Vec3d)>();
        private readonly Dictionary<Airfield, Built> built = new Dictionary<Airfield, Built>();
        private readonly Queue<Airfield> toBuild = new Queue<Airfield>();
        private readonly HashSet<Airfield> queued = new HashSet<Airfield>();
        private Shader flatShader, litShader;
        private EnuBasis basis;
        private float scanTimer;
        private readonly Palette palette = Palettes.HdNoon;

        private void Update()
        {
            if (basis == null && !TryBoot()) return;

            scanTimer -= Time.unscaledDeltaTime;
            if (scanTimer <= 0)
            {
                scanTimer = 1;
                Scan();
            }
            if (toBuild.Count > 0) BuildOne(toBuild.Dequeue());
            Draw();
            builtAirfields = built.Count;
        }

        private bool TryBoot()
        {
            if (terrain == null || viewer == null || terrain.Session == null || terrain.Root == null) return false;
            basis = terrain.Session.Basis;
            string path = Path.Combine(terrain.Root, "airfields.json");
            AirfieldsFile file = File.Exists(path) ? AirfieldsJson.Parse(File.ReadAllText(path)) : Airfields.Empty;
            foreach (Airfield a in file.Items)
            {
                if (a.Runways.Count == 0) continue;
                airfields.Add((a, Geodesy.GeodeticToWorld(basis, a.Lat, a.Lon, a.ElevationM)));
            }
            knownAirfields = airfields.Count;
            flatShader = Shader.Find("Retro/AirfieldFlat");
            litShader = Shader.Find("Retro/SceneryLit");
            return true;
        }

        /// <summary>Queue what came within reach, release what went out of it.</summary>
        private void Scan()
        {
            Vec3d cam = viewer.ScenePosition;
            double build = buildRadiusKm * 1000, drop = dropRadiusKm * 1000;
            var near = new List<(Airfield, double)>();
            foreach (var (a, c) in airfields)
            {
                double d = JsMath.Hypot(c.X - cam.X, c.Z - cam.Z);
                if (d <= build && !built.ContainsKey(a) && !queued.Contains(a)) near.Add((a, d));
                else if (d > drop && built.TryGetValue(a, out Built b))
                {
                    Release(b);
                    built.Remove(a);
                }
            }
            near.Sort((x, y) => x.Item2.CompareTo(y.Item2));
            foreach (var (a, _) in near)
            {
                queued.Add(a);
                toBuild.Enqueue(a);
            }
        }

        private void BuildOne(Airfield airfield)
        {
            queued.Remove(airfield);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            DemHeightField ground = player != null ? player.HeightField : null;
            Func<double, double, double> groundAt = null;
            if (ground != null)
            {
                // The fine tier under the airfield first, so the drape is not a coarse guess.
                Vec3d centre = Geodesy.GeodeticToWorld(basis, airfield.Lat, airfield.Lon, 0);
                ground.Focus(new[] { player.Aircraft != null ? player.Aircraft.GetPosition() : centre, centre });
                ground.WaitIdle(TimeSpan.FromSeconds(2));
                groundAt = (e, n) => ground.Sampler.GeodeticHeightAtEnu(e, n);
            }
            AirfieldGeometry g = AirfieldGeometryBuilder.Build(airfield, basis, groundAt, null);
            if (g == null) return;
            var b = new Built
            {
                Geometry = g,
                Flats = new List<Gpu>[g.Levels.Length],
                Volumes = new List<Gpu>[g.Levels.Length],
                Marks = new Texture2D[g.MarkingTextures.Length],
            };
            for (int i = 0; i < g.MarkingTextures.Length; i++)
            {
                if (g.MarkingTextures[i] != null) b.Marks[i] = MarkTexture(g.MarkingTextures[i]);
            }
            for (int l = 0; l < g.Levels.Length; l++)
            {
                b.Flats[l] = new List<Gpu>();
                b.Volumes[l] = new List<Gpu>();
                List<AirfieldPart> flats = g.Levels[l].Flats;
                for (int i = 0; i < flats.Count; i++) b.Flats[l].Add(Upload(flats[i], b, FlatQueueBase + i));
                foreach (AirfieldPart p in g.Levels[l].Volumes) b.Volumes[l].Add(Upload(p, b, -1));
            }
            built[airfield] = b;
            lastBuildMs = (float)clock.Elapsed.TotalMilliseconds;
        }

        private static Texture2D MarkTexture(MarkingTexture m)
        {
            var tex = new Texture2D(m.Width, m.Height, TextureFormat.RG16, true, true)
            {
                wrapMode = TextureWrapMode.Clamp,
                filterMode = FilterMode.Trilinear,
                // Seen end-on far more often than from above.
                anisoLevel = 16,
                name = "runway markings",
            };
            // The base level only; Apply builds the mip chain, the box average the web game's mipmaps are.
            tex.SetPixelData(m.Data, 0);
            tex.Apply(true, true);
            return tex;
        }

        private Gpu Upload(AirfieldPart part, Built b, int queue)
        {
            int count = part.Positions.Length / 3;
            var vertices = new Vector3[count];
            for (int i = 0; i < count; i++)
            {
                vertices[i] = new Vector3(part.Positions[i * 3], part.Positions[i * 3 + 1], part.Positions[i * 3 + 2]);
            }
            var indices = new int[count];
            for (int i = 0; i < count; i++) indices[i] = i;
            var mesh = new Mesh { name = part.Key, indexFormat = count > 65000 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            mesh.SetVertices(vertices);
            if (part.Uvs != null)
            {
                var uvs = new Vector2[count];
                for (int i = 0; i < count; i++) uvs[i] = new Vector2(part.Uvs[i * 2], part.Uvs[i * 2 + 1]);
                mesh.SetUVs(0, uvs);
            }
            mesh.SetTriangles(indices, 0);
            if (part.Shaded) mesh.RecalculateNormals();
            mesh.RecalculateBounds();

            Material material;
            Color tone = TerrainColours.FromHex(part.Paint.RawColor ?? palette.Color(part.Paint.Category));
            if (part.Shaded)
            {
                material = new Material(litShader);
                material.SetColor("_Color", tone);
            }
            else
            {
                material = new Material(flatShader) { renderQueue = queue };
                material.SetColor("_Color", tone);
                material.SetFloat("_Overbright", (float)part.Paint.Lighten);
                material.SetFloat("_MaxFootprint", (float)(part.Paint.MaxFootprintM ?? 0));
                if (part.MarkedRunway >= 0 && b.Marks[part.MarkedRunway] != null)
                {
                    material.SetTexture("_MarkMap", b.Marks[part.MarkedRunway]);
                    material.SetFloat("_Markings", 1);
                    material.SetColor("_MarkColorA", TerrainColours.FromHex(palette.Color(PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD)));
                    material.SetColor("_MarkColorB", TerrainColours.FromHex(palette.Color(PaletteCategory.SCENERY_BASE_RUNWAY_LINES)));
                    material.SetVector("_MarkFade", new Vector4(
                        (float)AirfieldGeometryBuilder.MarkingTextureFadeOutM, (float)AirfieldGeometryBuilder.PaintMaxFootprintM, 0, 0));
                }
            }
            return new Gpu { Mesh = mesh, Material = material };
        }

        private void Draw()
        {
            Camera cam = viewer.UnityCamera;
            Vec3d eye = viewer.ScenePosition;
            drawnAirfields = 0;
            foreach (Built b in built.Values)
            {
                Vec3d o = b.Geometry.Origin;
                double distance = (o - eye).Length;
                int level = ModelLod.Resolve(
                    ModelLod.GetLodLevel(distance, cam.fieldOfView, cam.aspect, cam.pixelWidth, b.Geometry.MaxSize),
                    b.Geometry.Levels.Length);
                if (level < 0) continue;
                Matrix4x4 matrix = SceneFrame.TileMatrix(o, eye, Quatd.Identity, 1);
                foreach (Gpu g in b.Flats[level]) Graphics.RenderMesh(Params(g.Material), g.Mesh, 0, matrix);
                foreach (Gpu g in b.Volumes[level]) Graphics.RenderMesh(Params(g.Material), g.Mesh, 0, matrix);
                drawnAirfields++;
            }
        }

        private static RenderParams Params(Material m) =>
            new RenderParams(m) { shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false };

        private static void Release(Built b)
        {
            foreach (List<Gpu>[] set in new[] { b.Flats, b.Volumes })
            {
                foreach (List<Gpu> list in set)
                {
                    foreach (Gpu g in list)
                    {
                        Destroy(g.Mesh);
                        Destroy(g.Material);
                    }
                }
            }
            foreach (Texture2D t in b.Marks)
            {
                if (t != null) Destroy(t);
            }
        }

        private void OnDestroy()
        {
            foreach (Built b in built.Values) Release(b);
            built.Clear();
        }
    }
}
