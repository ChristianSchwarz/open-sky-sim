using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
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
        [Tooltip("Main-thread time of the last upload (the build itself runs on a worker).")]
        public float lastBuildMs;

        private const int FlatQueueBase = 2010;
        private static readonly IReadOnlyList<(double X, double Y)>[] NoHoles = Array.Empty<IReadOnlyList<(double X, double Y)>>();

        private sealed class Gpu
        {
            public Mesh Mesh;
            public Material Material;
            public AirfieldPaint Paint;
        }

        private sealed class Built
        {
            public AirfieldGeometry Geometry;
            public List<Gpu>[] Flats;
            public List<Gpu>[] Volumes;
            public Texture2D[] Marks;
            /// <summary>Unpaved strips waiting for the colour of the ground under them.</summary>
            public List<(AirfieldGroundStrip Strip, Task<TileCover?> Cover)> Strips = new List<(AirfieldGroundStrip, Task<TileCover?>)>();
        }

        private readonly List<(Airfield Airfield, Vec3d Centre)> airfields = new List<(Airfield, Vec3d)>();
        private readonly Dictionary<Airfield, Built> built = new Dictionary<Airfield, Built>();
        private readonly Queue<Airfield> toBuild = new Queue<Airfield>();
        private readonly HashSet<Airfield> queued = new HashSet<Airfield>();
        private Shader flatShader, litShader;
        private EnuBasis basis;
        private float scanTimer;

        private void Update()
        {
            if (basis == null && !TryBoot()) return;

            scanTimer -= Time.unscaledDeltaTime;
            if (scanTimer <= 0)
            {
                scanTimer = 1;
                Scan();
            }
            PumpBuilds();
            FinishStrips();
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

        /// <summary>Reach of the fine ground an airfield is draped on: its runways and taxiways.</summary>
        private const double DrapeRadiusM = 6000;
        /// <summary>How long a build waits for the fine tier before draping on what is there.</summary>
        private const float DrapeWaitS = 3;

        private sealed class Job
        {
            public Airfield Airfield;
            public Vec3d Centre;
            public float Since;
            public Task<AirfieldGeometry> Task;
        }

        private Job job;

        /// <summary>
        /// One airfield at a time: hold the fine ground under it, then build its
        /// geometry on a worker against a snapshot of that ground, then upload.
        /// Nothing here blocks the frame on the tile loads.
        /// </summary>
        private void PumpBuilds()
        {
            DemHeightField ground = player != null ? player.HeightField : null;
            if (job == null)
            {
                if (toBuild.Count == 0) return;
                Airfield next = toBuild.Dequeue();
                job = new Job
                {
                    Airfield = next,
                    Centre = Geodesy.GeodeticToWorld(basis, next.Lat, next.Lon, 0),
                    Since = Time.unscaledTime,
                };
                ground?.HoldFocus(this, job.Centre, DrapeRadiusM);
            }
            if (job.Task == null)
            {
                Func<double, double, double> groundAt = null;
                if (ground != null)
                {
                    bool late = Time.unscaledTime - job.Since > DrapeWaitS;
                    if (!ground.TrySnapshot(job.Centre, DrapeRadiusM, late, out HeightSampler snapshot)) return;
                    ground.ReleaseFocus(this);
                    groundAt = (e, n) => snapshot.GeodeticHeightAtEnu(e, n);
                }
                Airfield a = job.Airfield;
                EnuBasis frame = basis;
                job.Task = Task.Run(() => AirfieldGeometryBuilder.Build(a, frame, groundAt,
                    contour => ShapeUtils.TriangulateShape(contour, NoHoles)));
                return;
            }
            if (!job.Task.IsCompleted) return;
            Job done = job;
            job = null;
            queued.Remove(done.Airfield);
            if (done.Task.IsFaulted)
            {
                Debug.LogException(done.Task.Exception);
                return;
            }
            if (done.Task.Result != null) built[done.Airfield] = UploadAll(done.Task.Result);
        }

        private Built UploadAll(AirfieldGeometry g)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
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
            // game.ts finalizeGroundStrip: once, from the finest baked tile under each sample
            // (a guarded sea-level strip is never repainted).
            foreach (AirfieldGroundStrip strip in g.GroundStrips)
            {
                if (!double.IsPositiveInfinity(strip.PaintedZoom)) b.Strips.Add((strip, FinestCover(strip)));
            }
            lastBuildMs = (float)clock.Elapsed.TotalMilliseconds;
            return b;
        }

        /// <summary>terrainEntity.ts finestCoverAtWorld for a strip's three samples, combined, off the main thread.</summary>
        private Task<TileCover?> FinestCover(AirfieldGroundStrip strip)
        {
            TerrainSession session = terrain.Session;
            string dir = terrain.Root;
            int zoom = terrain.MaxZoom;
            Vec3d[] samples = strip.Samples;
            return Task.Run(() =>
            {
                var covers = new List<TileCover?>();
                foreach (Vec3d p in samples)
                {
                    Geodetic geo = Geodesy.GeodeticOnSurfaceAtEnu(session.Basis, p.X, -p.Z);
                    TileKey id = Tiling.AtLonLat(zoom, geo.Lon, geo.Lat);
                    string path = Path.Combine(dir, id.Z.ToString(), id.X.ToString(), id.Y + ".ptm");
                    if (!File.Exists(path))
                    {
                        covers.Add(null);
                        continue;
                    }
                    PtmTile tile = TileFile.Ptm(File.ReadAllBytes(path));
                    // Into the tile's own axes (the TS skips the frame fix; exact only at the bake origin).
                    Vec3d local = (p - session.TileOrigin(id, tile.CenterHeightM)).Rotate(session.FrameFix.Conjugate());
                    covers.Add(TileCovers.CoverInPtmTile(tile, local.X / tile.QuantScale, local.Z / tile.QuantScale, zoom));
                }
                return TileCovers.Combine(covers);
            });
        }

        /// <summary>repaintGroundStrip: the strip's pavement, in every level, takes the ground's colour lifted by its lighten.</summary>
        private static void Repaint(Built b, AirfieldGroundStrip strip, TileCover cover)
        {
            string hex = "#" + cover.Rgb.ToString("x6");
            foreach (List<Gpu> level in b.Flats)
            {
                foreach (Gpu g in level)
                {
                    if (g.Mesh.name != strip.PaintKey) continue;
                    // On the paint, so the palette binding keeps lighting it as the day goes.
                    g.Paint.RawColor = hex;
                    g.Material.SetColor("_Color", ScenePalette.Raw(hex));
                    g.Material.SetFloat("_Overbright", (float)strip.Lighten);
                }
            }
            strip.PaintedZoom = double.PositiveInfinity;
        }

        private void FinishStrips()
        {
            foreach (Built b in built.Values)
            {
                for (int i = b.Strips.Count - 1; i >= 0; i--)
                {
                    var (strip, task) = b.Strips[i];
                    if (!task.IsCompleted) continue;
                    b.Strips.RemoveAt(i);
                    if (task.IsFaulted) Debug.LogException(task.Exception);
                    else if (task.Result.HasValue) Repaint(b, strip, task.Result.Value);
                }
            }
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
            AirfieldPaint paint = part.Paint;
            // A literal colour (a repainted strip) takes the palette's light; a tone is the palette's own.
            Func<Color> tone = () => paint.RawColor != null ? ScenePalette.Raw(paint.RawColor) : ScenePalette.Tone(paint.Category);
            if (part.Shaded)
            {
                material = new Material(litShader);
                ScenePalette.Bind(material, "_Color", tone);
            }
            else
            {
                material = new Material(flatShader) { renderQueue = queue };
                ScenePalette.Bind(material, "_Color", tone);
                material.SetFloat("_Overbright", (float)part.Paint.Lighten);
                material.SetFloat("_MaxFootprint", (float)(part.Paint.MaxFootprintM ?? 0));
                if (part.MarkedRunway >= 0 && b.Marks[part.MarkedRunway] != null)
                {
                    material.SetTexture("_MarkMap", b.Marks[part.MarkedRunway]);
                    material.SetFloat("_Markings", 1);
                    ScenePalette.Bind(material, "_MarkColorA", PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD);
                    ScenePalette.Bind(material, "_MarkColorB", PaletteCategory.SCENERY_BASE_RUNWAY_LINES);
                    material.SetVector("_MarkFade", new Vector4(
                        (float)AirfieldGeometryBuilder.MarkingTextureFadeOutM, (float)AirfieldGeometryBuilder.PaintMaxFootprintM, 0, 0));
                }
            }
            return new Gpu { Mesh = mesh, Material = material, Paint = part.Paint };
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
