using System;
using System.Collections.Generic;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// The Kuznetsov (game.ts setupScene's carrier, advanceCarrier,
    /// seatCarrierOnSea, syncCarrierSystems): berthed by the ported
    /// <see cref="CarrierSites"/> search near the base airfield - open water
    /// if there is some in reach, else moored on level ground - drawn from
    /// assets/kuz.glb with the hull clipped at the sea, its deck baked from the
    /// same mesh into a <see cref="CarrierMeshCollider"/> for the sim, steaming
    /// at 45 km/h along its bow until land comes up ahead, with the deck,
    /// arrestor wires and ship velocity kept in step in the sim.
    /// </summary>
    public sealed class Carrier : IPosedEntity, IMovingSurface, IWreckMovingSurface
    {
        // game.ts
        /// <summary>KUZ_HULL_RAISE_M: the hull mesh runs 15 m below its origin, the real ship draws ~10 m.</summary>
        private const double HullRaiseM = 4;
        public const double HullMinX = -34.33, HullMaxX = 43.83, HullMinZ = -177.88, HullMaxZ = 124.28;
        public const double DeckMidX = (HullMinX + HullMaxX) * 0.5;
        public const double DeckY = 14;
        private const double SpeedMps = 45 / 3.6;
        private const double ApproachFinalDistanceM = 3500;
        private const double ApproachAltitudeM = DeckY + 183;
        private const double TakeoffFromBowM = 120;
        /// <summary>PLAYER_CARRIER_HEADING and PLAYER_CARRIER_TAKEOFF_HEADING: toward the bow (-Z).</summary>
        public const double Heading = Math.PI;
        private const string ModelFile = "kuz.glb";
        private static readonly UnityEngine.Quaternion HalfTurnY = UnityEngine.Quaternion.Euler(0, 180, 0);

        private readonly DemHeightField heightField;
        private readonly Transform root;
        private readonly List<Material> materials = new List<Material>();
        private Transform model;
        private Vec3d position;
        private readonly Quatd quaternion = Quatd.Identity;
        private Vec3d velocity;
        private double speedMps;
        private double clipY;
        private Vec3d syncedPosition = new Vec3d(double.NaN, double.NaN, double.NaN);

        public bool AtSea { get; }
        /// <summary>The model has loaded (or failed to) and the deck collider is known.</summary>
        public bool Settled { get; private set; }
        public Retro.Sim.CarrierMeshCollider Deck { get; private set; }
        public Vec3d Position => position;
        public Quatd Quaternion => quaternion;
        public Vec3d Velocity => velocity;
        public ArrestorCarrierPose Pose => new ArrestorCarrierPose { Position = position, Quaternion = quaternion, Velocity = velocity };

        public Carrier(DemHeightField heightField, SceneRunway baseRunway, Func<double, double, bool> onPad, IAircraftFiles files)
        {
            this.heightField = heightField;
            Vec3d centre = baseRunway?.Center ?? Vec3d.Zero;
            double reach = (baseRunway?.HalfLength ?? 1500) + 800;
            CarrierSite site = CarrierSites.ChooseCarrierSite(centre.X, centre.Z, reach, new CarrierSiteSamplers
            {
                GroundAt = heightField.HeightAtWorld,
                IsLand = heightField.IsLandAtWorld,
                Usable = (x, z) => !onPad(x, z),
            });
            AtSea = site.AtSea;
            speedMps = AtSea ? SpeedMps : 0;
            // The search ran on whatever tier was resident: seat the hull on the fine one.
            heightField.Focus(new[] { new Vec3d(site.X, 0, site.Z) });
            heightField.WaitIdle(TimeSpan.FromSeconds(5));
            double seaY = AtSea
                ? heightField.HeightAtWorld(site.X, site.Z)
                : CarrierSites.CarrierSurfaceY(site.X, site.Z, heightField.HeightAtWorld);
            position = new Vec3d(site.X, ArrestorCables.ArrestorCarrierOrigin.Y + seaY + HullRaiseM, site.Z);
            clipY = seaY + 0.05;
            root = new GameObject("Carrier").transform;
            Load(files);
        }

        private async void Load(IAircraftFiles files)
        {
            try
            {
                model = await AircraftModel.LoadGltf(files, ModelFile, root, "kuz");
                if (model != null)
                {
                    Deck = CarrierDeck.CreateCarrierMeshCollider(position.X, position.Y, position.Z, BakeCollision(model));
                    Paint(model);
                }
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
            Settled = true;
        }

        /// <summary>
        /// carrierDeck.ts bakeCollisionMeshFromModel: every drawn triangle with some area,
        /// in the model frame (glTFast negated x on import, so it is negated back).
        /// </summary>
        /// <param name="rotation">The placed entity's turn (addSolidSceneryMesh's root matrix), applied in the scene frame.</param>
        internal static AircraftCollisionMesh BakeCollision(Transform model, Quatd? rotation = null)
        {
            Quatd q = rotation ?? Quatd.Identity;
            var flat = new List<double>();
            var vertices = new List<Vector3>();
            foreach (MeshFilter mf in model.GetComponentsInChildren<MeshFilter>(true))
            {
                if (mf.sharedMesh == null) continue;
                Matrix4x4 toModel = model.worldToLocalMatrix * mf.transform.localToWorldMatrix;
                Mesh mesh = mf.sharedMesh;
                mesh.GetVertices(vertices);
                for (int sub = 0; sub < mesh.subMeshCount; sub++)
                {
                    // Lines and points (lights) have no area: only meshes are solid, as in the TS.
                    if (mesh.GetTopology(sub) != MeshTopology.Triangles) continue;
                    int[] tris = mesh.GetTriangles(sub);
                    for (int t = 0; t < tris.Length; t += 3)
                    {
                        Vec3d a = Scene(toModel.MultiplyPoint3x4(vertices[tris[t]])).Rotate(q);
                        Vec3d b = Scene(toModel.MultiplyPoint3x4(vertices[tris[t + 1]])).Rotate(q);
                        Vec3d c = Scene(toModel.MultiplyPoint3x4(vertices[tris[t + 2]])).Rotate(q);
                        if (Vec3d.Cross(b - a, c - a).Length * 0.5 < 1e-6) continue;
                        flat.Add(a.X); flat.Add(a.Y); flat.Add(a.Z);
                        flat.Add(b.X); flat.Add(b.Y); flat.Add(b.Z);
                        flat.Add(c.X); flat.Add(c.Y); flat.Add(c.Z);
                    }
                }
            }
            var aabb = new ColliderAabb();
            double[] min = { double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity };
            double[] max = { double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity };
            for (int i = 0; i < flat.Count; i++)
            {
                min[i % 3] = Math.Min(min[i % 3], flat[i]);
                max[i % 3] = Math.Max(max[i % 3], flat[i]);
            }
            aabb.Min = min;
            aabb.Max = max;
            return new AircraftCollisionMesh { Triangles = flat.ToArray(), Aabb = aabb };
        }

        private static Vec3d Scene(Vector3 v) => new Vec3d(-v.x, v.y, v.z);

        /// <summary>The hull in its palette colour, clipped at the sea (models.ts clipBelowY for kuz volumes).</summary>
        private void Paint(Transform part)
        {
            foreach (Renderer r in part.GetComponentsInChildren<Renderer>(true))
            {
                Material[] mats = r.sharedMaterials;
                for (int i = 0; i < mats.Length; i++)
                {
                    string name = mats[i] != null ? mats[i].name : "";
                    var m = new Material(Shader.Find("Retro/SceneryLit")) { name = "carrier " + name };
                    PaletteCategory category = Enum.TryParse(name, out PaletteCategory c) ? c : PaletteCategory.SCENERY_BUILDING_METAL;
                    ScenePalette.Bind(m, "_Color", category);
                    m.SetFloat("_Cull", (float)UnityEngine.Rendering.CullMode.Back);
            m.SetFloat("_GltfWinding", 1);
                    materials.Add(m);
                    mats[i] = m;
                }
                r.sharedMaterials = mats;
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.On;
                r.receiveShadows = true;
            }
        }

        /// <summary>advanceCarrier: steam along the bow; drop anchor when land is across it.</summary>
        public void Advance(double dt)
        {
            if (speedMps > 0 && LandAhead()) speedMps = 0;
            Vec3d bow = new Vec3d(0, 0, -1).Rotate(quaternion);
            velocity = bow * speedMps;
            position = position.AddScaled(velocity, dt);
            if (!AtSea) return;
            // seatCarrierOnSea: the sea curves away from the tangent plane; near a coast the DEM reads land.
            double seaY = Math.Min(heightField.HeightAtWorld(position.X, position.Z), Geodesy.SeaLevelSceneY(position.X, position.Z) + 2);
            position.Y = ArrestorCables.ArrestorCarrierOrigin.Y + seaY + HullRaiseM;
            clipY = seaY + 0.05;
        }

        /// <summary>landAheadOfCarrier.</summary>
        private bool LandAhead()
        {
            foreach (double dx in new[] { HullMinX - 30, DeckMidX, HullMaxX + 30 })
            {
                foreach (double dz in new[] { HullMinZ - 150, HullMinZ - 600 })
                {
                    Vec3d p = new Vec3d(dx, 0, dz).Rotate(quaternion) + position;
                    if (heightField.IsLandAtWorld(p.X, p.Z)) return true;
                }
            }
            return false;
        }

        /// <summary>The arrestor wires where the ship is now (defaultArrestorCableField).</summary>
        public ArrestorCableField CableField() =>
            ArrestorCables.BuildArrestorCableField(position.X, position.Y, position.Z, null, quaternion);

        /// <summary>syncCarrierSystems: deck origin, wires and ship velocity into the sim when the ship moved.</summary>
        public void Sync(CombatSim sim)
        {
            if (Math.Abs(position.X - syncedPosition.X) < 1e-4 && Math.Abs(position.Y - syncedPosition.Y) < 1e-4
                && Math.Abs(position.Z - syncedPosition.Z) < 1e-4)
            {
                return;
            }
            syncedPosition = position;
            if (Deck != null)
            {
                Deck.OriginX = position.X;
                Deck.OriginY = position.Y;
                Deck.OriginZ = position.Z;
                sim.SetCarrierMeshOrigins(new[] { position });
            }
            sim.SetArrestorCables(new[] { Serialize(CableField()) });
            sim.SetCarrierVelocity(velocity.X, velocity.Y, velocity.Z);
        }

        public static SerializedArrestorCables Serialize(ArrestorCableField field)
        {
            var s = new SerializedArrestorCables
            {
                OriginX = field.OriginX,
                OriginY = field.OriginY,
                OriginZ = field.OriginZ,
                DeckAxis = new[] { field.DeckAxis.X, field.DeckAxis.Y, field.DeckAxis.Z },
            };
            foreach (ArrestorCableSegment seg in field.Segments)
            {
                s.SegmentsLocal.Add(new[]
                {
                    seg.A.X - field.OriginX, seg.A.Y - field.OriginY, seg.A.Z - field.OriginZ,
                    seg.B.X - field.OriginX, seg.B.Y - field.OriginY, seg.B.Z - field.OriginZ,
                });
            }
            return s;
        }

        /// <summary>game.ts carrierSurface.contains: over the ship, and on it rather than high above it or below it.</summary>
        public bool Contains(double x, double y, double z)
        {
            double deck = DeckYAt(x, z);
            return !double.IsNegativeInfinity(deck) && y - deck < 5 && y - deck > -3;
        }

        /// <summary>The deck (or nothing) at a scene point: -Infinity off the ship.</summary>
        public double DeckYAt(double x, double z) => Deck != null ? CarrierDeck.SampleCarrierMeshSurfaceY(x, z, Deck) : double.NegativeInfinity;

        /// <summary>carrierApproachSpawnPosition + carrierApproachSpawn: astern on the centreline, ship speed plus approach speed.</summary>
        public SimAircraftSpawn ApproachSpawn(double approachSpeedMps)
        {
            var p = new Vec3d(position.X + DeckMidX, position.Y + ApproachAltitudeM, position.Z + HullMaxZ + ApproachFinalDistanceM);
            return Spawn(p, (speedMps + approachSpeedMps), 0.38, true);
        }

        /// <summary>carrierTakeoffSpawnPosition + carrierTakeoffSpawn: on the deck 120 m aft of the bow, moving with the ship.</summary>
        public SimAircraftSpawn TakeoffSpawn(double gearRestHeight, Func<double, double, double> groundAt)
        {
            double x = position.X + DeckMidX, z = position.Z + HullMinZ + TakeoffFromBowM;
            return Spawn(new Vec3d(x, groundAt(x, z) + gearRestHeight, z), speedMps, 0, false);
        }

        private static SimAircraftSpawn Spawn(Vec3d p, double speed, double throttle, bool airborne)
        {
            Quatd q = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), Heading);
            Vec3d v = ActiveAirfield.HeadingForward(Heading) * speed;
            return new SimAircraftSpawn
            {
                Position = new[] { p.X, p.Y, p.Z },
                Quaternion = new[] { q.X, q.Y, q.Z, q.W },
                Velocity = new[] { v.X, v.Y, v.Z },
                Landed = !airborne,
                Throttle = throttle,
                Airborne = airborne,
            };
        }

        /// <summary>Place the hull for this frame (camera-relative) and move the waterline clip with it.</summary>
        public void Draw(Vec3d camera)
        {
            if (model == null) return;
            model.SetPositionAndRotation(SceneFrame.ToUnity(position - camera), SceneFrame.ToUnity(quaternion) * HalfTurnY);
            foreach (Material m in materials) m.SetFloat("_ClipBelowY", (float)(clipY - camera.Y));
        }

        public void Destroy()
        {
            if (root != null) UnityEngine.Object.Destroy(root.gameObject);
            foreach (Material m in materials) UnityEngine.Object.Destroy(m);
        }
    }
}
