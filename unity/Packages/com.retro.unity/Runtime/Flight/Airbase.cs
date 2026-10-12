using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using UnityEngine;
using UnityEngine.Rendering;
using SimPad = Retro.Sim.SurfacePadCollider;
using SkiJumpCollider = Retro.Sim.SkiJumpCollider;
using CarrierMeshCollider = Retro.Sim.CarrierMeshCollider;

namespace Retro.Unity
{
    /// <summary>
    /// The authored scenery around the area's base runway (game.ts addAirBase,
    /// addRefinery and the Canaries targets): the two apron squares (unless
    /// the field has aprons of its own), the authored runway where the bake
    /// found none, the ski jump, four hangars, the parked F-22s and the tower;
    /// at home also the refinery and its depots, the SAM radar and the
    /// warehouse, which are weapons targets. Every glTF piece is also solid
    /// (addSolidSceneryMesh: its drawn triangles become a deck-style collider);
    /// the aprons and the authored runway are pads, the ski jump its analytic
    /// ramp. Placement is fixed when the world is built, so it reads only the
    /// ground and the pads laid before it, as on the web.
    /// </summary>
    public sealed class Airbase
    {
        private static readonly UnityEngine.Quaternion HalfTurnY = UnityEngine.Quaternion.Euler(0, 180, 0);

        private sealed class Piece
        {
            public string File;
            public Vec3d Position;
            public double Heading;
            public bool Solid;
            public Transform Instance;
            /// <summary>The weapons target this piece is (GroundTargetEntity), sized from its model.</summary>
            public WeaponsTargets.Entry Target;
        }

        private readonly BaseFrame frame;
        private readonly bool hasRunway, hasRealAprons, isHome;
        private readonly List<Piece> pieces = new List<Piece>();
        private readonly List<(Mesh Mesh, Material Material, Matrix4x4 Local)> flats = new List<(Mesh, Material, Matrix4x4)>();
        private readonly List<(Vec3d Position, double Heading)> aprons = new List<(Vec3d, double)>();
        private readonly List<Material> ownMaterials = new List<Material>();
        private Mesh apronMesh, skiJumpDeck, skiJumpSides;
        private Vec3d skiJumpOrigin;
        private Transform root;

        /// <summary>The aprons and the authored runway, as solid ground (addSurfacePad).</summary>
        public readonly List<SimPad> Pads = new List<SimPad>();
        public readonly List<SkiJumpCollider> SkiJumps = new List<SkiJumpCollider>();
        /// <summary>The glTF pieces' colliders, once their models have loaded (activateSceneryColliders).</summary>
        public readonly List<CarrierMeshCollider> SceneryMeshes = new List<CarrierMeshCollider>();
        /// <summary>The authored runway, a target where the bake found no real one (GroundTargetEntity 'Airbase').</summary>
        public WeaponsTargets.Entry RunwayTarget { get; private set; }
        /// <summary>The Canaries scenario's targets, at home: the refinery, the SAM radar, the warehouse.</summary>
        public readonly List<WeaponsTargets.Entry> Targets = new List<WeaponsTargets.Entry>();
        /// <summary>Every model loaded (or failed): the colliders are final.</summary>
        public bool Settled { get; private set; }

        public Airbase(BaseFrame frame, bool hasRunway, bool hasRealAprons, bool isHome)
        {
            this.frame = frame;
            this.hasRunway = hasRunway;
            this.hasRealAprons = hasRealAprons;
            this.isHome = isHome;
        }

        /// <summary>The AI's cylinders (setupCombat): the hangars and the tower, and at home the targets.</summary>
        public IEnumerable<(double X, double Z, double Radius, double Height)> ObstacleSpecs()
        {
            foreach (var o in AirbaseLayout.AirbaseObstacles)
            {
                (double x, double z) = AirbaseLayout.At(frame, o.At);
                yield return (x, z, o.Radius, o.Height);
            }
            if (!isHome) yield break;
            foreach (var o in AirbaseLayout.TargetObstacles)
            {
                (double x, double z) = AirbaseLayout.At(frame, o.At);
                yield return (x, z, o.Radius, o.Height);
            }
        }

        /// <summary>
        /// addAirBase's first part, before the carrier looks for its berth: the apron squares
        /// and the authored runway, as pads added to <paramref name="pads"/> too.
        /// </summary>
        public void AddPads(Func<double, double, double> groundAt, List<SimPad> pads)
        {
            double heading = frame.Heading;
            if (!hasRealAprons)
            {
                foreach (var local in new[] { AirbaseLayout.HangarGround1, AirbaseLayout.HangarGround2 })
                {
                    (double x, double z) = AirbaseLayout.At(frame, local);
                    double y = AirbaseLayout.GroundMaxUnder(groundAt, x, z, 100, 100);
                    aprons.Add((new Vec3d(x, y + AirbaseLayout.ScenerySurfaceEpsM, z), heading));
                    Add(pads, new SimPad
                    {
                        CenterX = x, CenterZ = z, Heading = heading,
                        HalfLength = AirbaseLayout.HangarGroundHalfM, HalfWidth = AirbaseLayout.HangarGroundHalfM,
                        SurfaceY = y + AirbaseLayout.ScenerySurfaceEpsM, BaseY = y, Feather = AirbaseLayout.SurfacePadFeatherM,
                    });
                }
            }
            if (!hasRunway)
            {
                // The authored strip at the ENU origin, only where the bake found no real runway.
                double y = AirbaseLayout.GroundMaxUnder(groundAt, 0, 0, 80, 900);
                var runway = new Piece { File = "runway01.gltf", Position = new Vec3d(0, y + AirbaseLayout.ScenerySurfaceEpsM, 0), Heading = 0 };
                Vec3d at = runway.Position;
                runway.Target = RunwayTarget = new WeaponsTargets.Entry { Type = "Airbase", Location = "Stosneehar", Position = () => at };
                pieces.Add(runway);
                Add(pads, new SimPad
                {
                    CenterX = 0, CenterZ = 0, Heading = AirbaseLayout.PlayerStartingHeading,
                    HalfLength = AirbaseLayout.RunwayHalfLengthM, HalfWidth = AirbaseLayout.RunwayPavementHalfWidth,
                    SurfaceY = y + AirbaseLayout.ScenerySurfaceEpsM, BaseY = y, Feather = AirbaseLayout.SurfacePadFeatherM,
                });
            }
        }

        private void Add(List<SimPad> pads, SimPad pad)
        {
            Pads.Add(pad);
            pads.Add(pad);
        }

        /// <summary>
        /// The rest, once the carrier has its berth: the ski jump, then the hangars, the ramp,
        /// the tower and (at home) the scenario scenery, each stood on the highest ground
        /// under its footprint; the models load in the background.
        /// </summary>
        public void Place(Func<double, double, double> groundAt, IAircraftFiles files)
        {
            double Y(double x, double z, double halfW = 40, double halfD = 40) => AirbaseLayout.GroundMaxUnder(groundAt, x, z, halfW, halfD);
            void Put(string file, (double X, double Z) at, double halfW, double halfD, double heading, double lift = 0)
            {
                pieces.Add(new Piece { File = file, Position = new Vec3d(at.X, Y(at.X, at.Z, halfW, halfD) + lift, at.Z), Heading = heading, Solid = true });
            }

            // The ski jump, ninety metres past the runway spawn, rising toward the take-off.
            (double sx, double sz) = AirbaseLayout.SkiJumpOrigin(frame);
            skiJumpOrigin = new Vec3d(sx, Y(sx, sz, 30, 40), sz);
            SkiJumps.Add(SkiJump.CreateSkiJumpCollider(skiJumpOrigin.X, skiJumpOrigin.Y, skiJumpOrigin.Z, frame.Heading));

            double h = frame.Heading;
            Put("hangar01.gltf", AirbaseLayout.At(frame, AirbaseLayout.Hangar1), 40, 50, h + Math.PI / 2);
            Put("hangar01.gltf", AirbaseLayout.At(frame, AirbaseLayout.Hangar2), 40, 50, h + Math.PI / 2);
            Put("hangar01.gltf", AirbaseLayout.At(frame, AirbaseLayout.Hangar3), 40, 50, h + Math.PI / 2);
            Put("hangar01.gltf", AirbaseLayout.At(frame, AirbaseLayout.Hangar4), 40, 50, h + Math.PI);
            foreach (var (x, z, heading) in AirbaseLayout.RampSlots(frame))
            {
                Put("f22_scenery.glb", (x, z), 15, 15, heading, SimConstants.PlaneDistanceToGround);
            }
            // The tower faces the same way whatever the runway does (game.ts sets -pi/2 outright).
            Put("control01.gltf", AirbaseLayout.At(frame, AirbaseLayout.Tower), 30, 30, -Math.PI / 2);

            if (isHome)
            {
                // addRefinery: the towers, then the depots at fixed scene offsets around them.
                (double rx, double rz) = AirbaseLayout.At(frame, AirbaseLayout.Refinery);
                Put("refinery_towers01.gltf", (rx, rz), 80, 80, 0);
                Target("Oil Refinery", "Radlydd");
                Put("refinery_depot01.gltf", (rx, rz - 100), 40, 40, 0);
                Put("refinery_depot01.gltf", (rx, rz + 100), 40, 40, Math.PI);
                Put("refinery_depot01.gltf", (rx + 100, rz - 100), 40, 40, 0);
                Put("refinery_depot02.gltf", (rx - 150, rz - 50), 40, 40, 0);
                Put("refinery_depot02.gltf", (rx + 150, rz + 50), 40, 40, 0);
                Put("samradar01.glb", AirbaseLayout.At(frame, AirbaseLayout.Sam), 25, 25, 0);
                Target("SAM Radar", "Stosneehar");
                Put("hangar01.gltf", AirbaseLayout.At(frame, AirbaseLayout.Warehouse), 30, 40, Math.PI / 2);
                Target("Warehouse", "Radlydd");
            }

            BuildFlats();
            Load(files);
        }

        private void Target(string type, string location)
        {
            Piece p = pieces[pieces.Count - 1];
            Vec3d at = p.Position;
            p.Target = new WeaponsTargets.Entry { Type = type, Location = location, Position = () => at };
            Targets.Add(p.Target);
        }

        private async void Load(IAircraftFiles files)
        {
            root = new GameObject("Airbase").transform;
            var templates = new Dictionary<string, Transform>();
            try
            {
                foreach (Piece p in pieces)
                {
                    if (root == null) return;
                    if (!templates.TryGetValue(p.File, out Transform template))
                    {
                        template = await AircraftModel.LoadScenery(files, p.File, root, "template " + p.File);
                        if (template != null) template.gameObject.SetActive(false);
                        templates[p.File] = template;
                    }
                    if (template == null || root == null) continue;
                    if (p.Target != null)
                    {
                        // GroundTargetEntity maxSize and localCenter: the model's box.
                        (Vec3d centre, double size) = ModelBounds(template);
                        p.Target.LocalCenter = centre;
                        p.Target.MaxSize = size;
                    }
                    p.Instance = UnityEngine.Object.Instantiate(template, root);
                    p.Instance.name = p.File;
                    p.Instance.gameObject.SetActive(true);
                    if (p.Solid)
                    {
                        // addSolidSceneryMesh: the model's triangles turned with the piece, at its position.
                        AircraftCollisionMesh soup = Carrier.BakeCollision(template, Quatd.FromAxisAngle(new Vec3d(0, 1, 0), p.Heading));
                        if (soup.Triangles.Length > 0)
                        {
                            SceneryMeshes.Add(CarrierDeck.CreateCarrierMeshCollider(p.Position.X, p.Position.Y, p.Position.Z, soup));
                        }
                    }
                }
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
            finally
            {
                Settled = true;
            }
        }

        /// <summary>
        /// models.ts maxSize and center: the box round a model's drawn vertices, in the model
        /// frame (glTFast negated x, so it is negated back).
        /// </summary>
        public static (Vec3d Center, double MaxSize) ModelBounds(Transform model)
        {
            var min = new Vec3d(double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity);
            var max = new Vec3d(double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity);
            var vertices = new List<Vector3>();
            foreach (MeshFilter mf in model.GetComponentsInChildren<MeshFilter>(true))
            {
                if (mf.sharedMesh == null) continue;
                Matrix4x4 toModel = model.worldToLocalMatrix * mf.transform.localToWorldMatrix;
                mf.sharedMesh.GetVertices(vertices);
                foreach (Vector3 v in vertices)
                {
                    Vector3 p = toModel.MultiplyPoint3x4(v);
                    var s = new Vec3d(-p.x, p.y, p.z);
                    min = new Vec3d(Math.Min(min.X, s.X), Math.Min(min.Y, s.Y), Math.Min(min.Z, s.Z));
                    max = new Vec3d(Math.Max(max.X, s.X), Math.Max(max.Y, s.Y), Math.Max(max.Z, s.Z));
                }
            }
            if (double.IsInfinity(min.X)) return (Vec3d.Zero, 0);
            Vec3d size = max - min;
            return ((min + max) * 0.5, Math.Max(size.X, Math.Max(size.Y, size.Z)));
        }

        /// <summary>The apron squares (lib:pavement) and the ski jump (lib:skiJump), as scene-wound meshes.</summary>
        private void BuildFlats()
        {
            if (aprons.Count > 0)
            {
                // A 200 m square on the ground plane, its face up in the scene frame (drawn mirrored, culled front).
                const float half = (float)AirbaseLayout.HangarGroundHalfM;
                apronMesh = new Mesh { name = "apron" };
                apronMesh.SetVertices(new[] { new Vector3(-half, 0, -half), new Vector3(half, 0, -half), new Vector3(half, 0, half), new Vector3(-half, 0, half) });
                apronMesh.SetTriangles(new[] { 0, 2, 1, 0, 3, 2 }, 0);
                apronMesh.RecalculateBounds();
                var m = new Material(Shader.Find("Retro/AirfieldFlat")) { name = "apron" };
                ScenePalette.Bind(m, "_Color", PaletteCategory.SCENERY_ROAD_SECONDARY);
                ownMaterials.Add(m);
                foreach (var (p, heading) in aprons)
                {
                    flats.Add((apronMesh, m, default));
                }
            }
            // skiJumpModelBuilder.ts: a cosine-arc deck over two sides, the underside and the tip face.
            const int segs = 16;
            double L = SkiJump.SkiJumpLengthM, H = SkiJump.SkiJumpHeightM, hw = SkiJump.SkiJumpWidthM * 0.5;
            var deck = new List<Vector3>();
            var sides = new List<Vector3>();
            void Tri(List<Vector3> o, double ax, double ay, double az, double bx, double by, double bz, double cx, double cy, double cz)
            {
                o.Add(new Vector3((float)ax, (float)ay, (float)az));
                o.Add(new Vector3((float)bx, (float)by, (float)bz));
                o.Add(new Vector3((float)cx, (float)cy, (float)cz));
            }
            for (int i = 0; i < segs; i++)
            {
                double t0 = (double)i / segs, t1 = (double)(i + 1) / segs;
                double z0 = t0 * L, z1 = t1 * L;
                double y0 = SkiJump.SkiJumpDeckHeight(t0, H), y1 = SkiJump.SkiJumpDeckHeight(t1, H);
                Tri(deck, -hw, y0, z0, hw, y1, z1, hw, y0, z0);
                Tri(deck, -hw, y0, z0, -hw, y1, z1, hw, y1, z1);
                Tri(sides, -hw, 0, z0, -hw, y0, z0, -hw, y1, z1);
                Tri(sides, -hw, 0, z0, -hw, y1, z1, -hw, 0, z1);
                Tri(sides, hw, 0, z0, hw, 0, z1, hw, y1, z1);
                Tri(sides, hw, 0, z0, hw, y1, z1, hw, y0, z0);
                Tri(sides, -hw, 0, z0, -hw, 0, z1, hw, 0, z1);
                Tri(sides, -hw, 0, z0, hw, 0, z1, hw, 0, z0);
            }
            Tri(sides, -hw, 0, L, -hw, H, L, hw, H, L);
            Tri(sides, -hw, 0, L, hw, H, L, hw, 0, L);
            skiJumpDeck = SoupMesh("ski jump deck", deck);
            skiJumpSides = SoupMesh("ski jump sides", sides);
            Material Lit(PaletteCategory c)
            {
                // Scene-wound like the airfields' lit parts: the shader's defaults expect that.
                var m = new Material(Shader.Find("Retro/SceneryLit")) { name = "ski jump " + c };
                ScenePalette.Bind(m, "_Color", c);
                ownMaterials.Add(m);
                return m;
            }
            flats.Add((skiJumpDeck, Lit(PaletteCategory.SCENERY_ROAD_MAIN), default));
            flats.Add((skiJumpSides, Lit(PaletteCategory.SCENERY_BASE_RUNWAY_THRESHOLD), default));
        }

        private static Mesh SoupMesh(string name, List<Vector3> v)
        {
            var mesh = new Mesh { name = name };
            mesh.SetVertices(v);
            var idx = new int[v.Count];
            for (int i = 0; i < idx.Length; i++) idx[i] = i;
            mesh.SetTriangles(idx, 0);
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
            return mesh;
        }

        public void Draw(Vec3d camera)
        {
            foreach (Piece p in pieces)
            {
                if (p.Instance == null) continue;
                p.Instance.SetPositionAndRotation(SceneFrame.ToUnity(p.Position - camera),
                    SceneFrame.ToUnity(Quatd.FromAxisAngle(new Vec3d(0, 1, 0), p.Heading)) * HalfTurnY);
            }
            int apron = 0;
            foreach ((Mesh mesh, Material mat, _) in flats)
            {
                Matrix4x4 m;
                if (mesh == apronMesh)
                {
                    var (p, heading) = aprons[apron++];
                    m = SceneFrame.TileMatrix(p, camera, Quatd.FromAxisAngle(new Vec3d(0, 1, 0), heading), 1);
                }
                else
                {
                    m = SceneFrame.TileMatrix(skiJumpOrigin, camera, Quatd.FromAxisAngle(new Vec3d(0, 1, 0), frame.Heading), 1);
                }
                Graphics.RenderMesh(new RenderParams(mat) { shadowCastingMode = ShadowCastingMode.On, receiveShadows = true }, mesh, 0, m);
            }
        }

        public void Destroy()
        {
            if (root != null) UnityEngine.Object.Destroy(root.gameObject);
            root = null;
            foreach (Material m in ownMaterials) UnityEngine.Object.Destroy(m);
            foreach (Mesh m in new[] { apronMesh, skiJumpDeck, skiJumpSides })
            {
                if (m != null) UnityEngine.Object.Destroy(m);
            }
        }
    }
}
