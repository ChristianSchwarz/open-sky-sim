using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    // Plain views of the static world the sim needs (port of physics/sim/serializedWorld.ts).
    // isLand is deliberately not serialized: the AI never calls it, so the sim's query stubs it to true.

    public sealed class SerializedHill
    {
        public double[] WorldToLocal = new double[16];
        public double[] LocalToWorld = new double[16];
        public double BaseRadius;
        public double Height;
        public double WorldX;
        public double WorldZ;
        public double WorldReach;
    }

    public sealed class SerializedObstacle
    {
        public double[] Position = new double[3];
        public double Radius;
        public double Height;
    }

    public sealed class SerializedRunway
    {
        public double[] Center = new double[3];
        public double Heading;
        public double HalfLength;
        public double HalfWidth;
    }

    public sealed class SerializedSkiJump
    {
        public double OriginX;
        /// <summary>Older worlds omit it (?? 0).</summary>
        public double? OriginY;
        public double OriginZ;
        public double Heading;
        public double Length;
        public double Height;
        public double HalfWidth;
    }

    public sealed class SerializedCarrierMesh
    {
        public double OriginX;
        public double OriginY;
        public double OriginZ;
        public double[] Triangles = Array.Empty<double>();
        public ColliderAabb Aabb = new ColliderAabb();
    }

    /// <summary>Arrestor cable field (one carrier).</summary>
    public sealed class SerializedArrestorCables
    {
        public double OriginX;
        public double OriginY;
        public double OriginZ;
        /// <summary>Unit landing/roll-out direction.</summary>
        public double[] DeckAxis = { 0, 0, -1 };
        /// <summary>Local endpoints [ax, ay, az, bx, by, bz] per cable.</summary>
        public List<double[]> SegmentsLocal = new List<double[]>();
    }

    public sealed class SerializedWorld
    {
        public List<SerializedHill> Hills = new List<SerializedHill>();
        public List<SerializedObstacle> Obstacles = new List<SerializedObstacle>();
        /// <summary>Every runway in the play area, longest first.</summary>
        public List<SerializedRunway> Runways = new List<SerializedRunway>();
        public List<SerializedSkiJump> SkiJumps;
        public List<SerializedCarrierMesh> CarrierMeshes;
        public List<SerializedArrestorCables> ArrestorCables;
        /// <summary>Flat solid surfaces: runway strip, pavement pads.</summary>
        public List<SurfacePadCollider> SurfacePads;
        /// <summary>Static scenery collision soups (same layout as carrier meshes).</summary>
        public List<SerializedCarrierMesh> SceneryMeshes;
    }

    /// <summary>Static colliders added to a world already sent (an airfield's buildings, streamed in mid-flight).</summary>
    public sealed class SerializedStaticColliders
    {
        public List<SurfacePadCollider> SurfacePads = new List<SurfacePadCollider>();
        public List<SerializedObstacle> Obstacles = new List<SerializedObstacle>();
    }

    public static class SerializedWorlds
    {
        private static CarrierMeshCollider ToCollider(SerializedCarrierMesh c) => new CarrierMeshCollider
        {
            OriginX = c.OriginX,
            OriginY = c.OriginY,
            OriginZ = c.OriginZ,
            Triangles = c.Triangles,
            Aabb = c.Aabb,
        };

        private static SerializedCarrierMesh FromCollider(CarrierMeshCollider c) => new SerializedCarrierMesh
        {
            OriginX = c.OriginX,
            OriginY = c.OriginY,
            OriginZ = c.OriginZ,
            Triangles = c.Triangles,
            Aabb = c.Aabb,
        };

        public static SerializedWorld SerializeWorld(
            IReadOnlyList<HillCollider> hills,
            IReadOnlyList<Obstacle> obstacles,
            IReadOnlyList<Runway> runways,
            IReadOnlyList<SkiJumpCollider> skiJumps = null,
            IReadOnlyList<CarrierMeshCollider> carrierMeshes = null,
            IReadOnlyList<ArrestorCableField> arrestorCables = null,
            IReadOnlyList<SurfacePadCollider> surfacePads = null,
            IReadOnlyList<CarrierMeshCollider> sceneryMeshes = null)
        {
            var w = new SerializedWorld
            {
                SkiJumps = new List<SerializedSkiJump>(),
                CarrierMeshes = new List<SerializedCarrierMesh>(),
                ArrestorCables = new List<SerializedArrestorCables>(),
                SurfacePads = new List<SurfacePadCollider>(),
                SceneryMeshes = new List<SerializedCarrierMesh>(),
            };
            foreach (HillCollider h in hills)
            {
                w.Hills.Add(new SerializedHill
                {
                    WorldToLocal = (double[])h.WorldToLocal.E.Clone(),
                    LocalToWorld = (double[])h.LocalToWorld.E.Clone(),
                    BaseRadius = h.BaseRadius,
                    Height = h.Height,
                    WorldX = h.WorldX,
                    WorldZ = h.WorldZ,
                    WorldReach = h.WorldReach,
                });
            }
            foreach (Obstacle o in obstacles)
            {
                w.Obstacles.Add(SerializeObstacle(o));
            }
            foreach (Runway r in runways)
            {
                w.Runways.Add(new SerializedRunway
                {
                    Center = new[] { r.Center.X, r.Center.Y, r.Center.Z },
                    Heading = r.Heading,
                    HalfLength = r.HalfLength,
                    HalfWidth = r.HalfWidth,
                });
            }
            foreach (SkiJumpCollider r in skiJumps ?? Array.Empty<SkiJumpCollider>())
            {
                w.SkiJumps.Add(new SerializedSkiJump
                {
                    OriginX = r.OriginX,
                    OriginY = r.OriginY,
                    OriginZ = r.OriginZ,
                    Heading = r.Heading,
                    Length = r.Length,
                    Height = r.Height,
                    HalfWidth = r.HalfWidth,
                });
            }
            foreach (CarrierMeshCollider c in carrierMeshes ?? Array.Empty<CarrierMeshCollider>())
            {
                w.CarrierMeshes.Add(FromCollider(c));
            }
            foreach (ArrestorCableField f in arrestorCables ?? Array.Empty<ArrestorCableField>())
            {
                var s = new SerializedArrestorCables
                {
                    OriginX = f.OriginX,
                    OriginY = f.OriginY,
                    OriginZ = f.OriginZ,
                    DeckAxis = new[] { f.DeckAxis.X, f.DeckAxis.Y, f.DeckAxis.Z },
                };
                foreach (ArrestorCableSegment seg in f.Segments)
                {
                    s.SegmentsLocal.Add(new[]
                    {
                        seg.A.X - f.OriginX, seg.A.Y - f.OriginY, seg.A.Z - f.OriginZ,
                        seg.B.X - f.OriginX, seg.B.Y - f.OriginY, seg.B.Z - f.OriginZ,
                    });
                }
                w.ArrestorCables.Add(s);
            }
            foreach (SurfacePadCollider p in surfacePads ?? Array.Empty<SurfacePadCollider>())
            {
                w.SurfacePads.Add(p.Clone());
            }
            foreach (CarrierMeshCollider c in sceneryMeshes ?? Array.Empty<CarrierMeshCollider>())
            {
                w.SceneryMeshes.Add(FromCollider(c));
            }
            return w;
        }

        private static SerializedObstacle SerializeObstacle(Obstacle o) => new SerializedObstacle
        {
            Position = new[] { o.Position.X, o.Position.Y, o.Position.Z },
            Radius = o.Radius,
            Height = o.Height,
        };

        /// <summary>
        /// Rebuild a <see cref="SceneWorldQuery"/> from serialized world data.
        /// `baseHeightAt` is the DEM under everything (the sim's mirrored height field).
        /// </summary>
        public static SceneWorldQuery DeserializeWorldQuery(SerializedWorld world, Func<double, double, double> baseHeightAt = null)
        {
            baseHeightAt ??= (x, z) => 0;
            var hills = new List<HillCollider>();
            foreach (SerializedHill h in world.Hills)
            {
                var w2l = new Mat4d();
                Array.Copy(h.WorldToLocal, w2l.E, 16);
                var l2w = new Mat4d();
                Array.Copy(h.LocalToWorld, l2w.E, 16);
                hills.Add(new HillCollider
                {
                    WorldToLocal = w2l,
                    LocalToWorld = l2w,
                    BaseRadius = h.BaseRadius,
                    Height = h.Height,
                    WorldX = h.WorldX,
                    WorldZ = h.WorldZ,
                    WorldReach = h.WorldReach,
                });
            }
            List<Obstacle> obstacles = DeserializeObstacles(world.Obstacles);
            var runways = new List<Runway>();
            foreach (SerializedRunway r in world.Runways ?? new List<SerializedRunway>())
            {
                runways.Add(new Runway
                {
                    Center = new Vec3d(r.Center[0], r.Center[1], r.Center[2]),
                    Heading = r.Heading,
                    HalfLength = r.HalfLength,
                    HalfWidth = r.HalfWidth,
                });
            }
            var skiJumps = new List<SkiJumpCollider>();
            foreach (SerializedSkiJump r in world.SkiJumps ?? new List<SerializedSkiJump>())
            {
                skiJumps.Add(new SkiJumpCollider
                {
                    OriginX = r.OriginX,
                    OriginY = r.OriginY ?? 0,
                    OriginZ = r.OriginZ,
                    Heading = r.Heading,
                    Length = r.Length,
                    Height = r.Height,
                    HalfWidth = r.HalfWidth,
                });
            }
            var carrierMeshes = new List<CarrierMeshCollider>();
            foreach (SerializedCarrierMesh c in world.CarrierMeshes ?? new List<SerializedCarrierMesh>())
            {
                carrierMeshes.Add(ToCollider(c));
            }
            var sceneryMeshes = new List<CarrierMeshCollider>();
            foreach (SerializedCarrierMesh c in world.SceneryMeshes ?? new List<SerializedCarrierMesh>())
            {
                sceneryMeshes.Add(ToCollider(c));
            }
            return new SceneWorldQuery(
                hills, (x, z) => true, obstacles, runways, skiJumps, carrierMeshes, baseHeightAt,
                (IReadOnlyList<SurfacePadCollider>)world.SurfacePads ?? Array.Empty<SurfacePadCollider>(), sceneryMeshes);
        }

        private static List<Obstacle> DeserializeObstacles(IReadOnlyList<SerializedObstacle> list)
        {
            var result = new List<Obstacle>();
            foreach (SerializedObstacle o in list ?? Array.Empty<SerializedObstacle>())
            {
                result.Add(new Obstacle
                {
                    Position = new Vec3d(o.Position[0], o.Position[1], o.Position[2]),
                    Radius = o.Radius,
                    Height = o.Height,
                });
            }
            return result;
        }

        public static SerializedStaticColliders SerializeStaticColliders(IReadOnlyList<SurfacePadCollider> surfacePads, IReadOnlyList<Obstacle> obstacles)
        {
            var s = new SerializedStaticColliders();
            foreach (SurfacePadCollider p in surfacePads) s.SurfacePads.Add(p.Clone());
            foreach (Obstacle o in obstacles) s.Obstacles.Add(SerializeObstacle(o));
            return s;
        }

        public static void ApplyStaticColliders(SceneWorldQuery world, SerializedStaticColliders colliders)
        {
            world.AddStaticColliders(colliders.SurfacePads, DeserializeObstacles(colliders.Obstacles));
        }

        /// <summary>Rebuild arrestor cable fields for combat-sim trap physics.</summary>
        public static List<ArrestorCableField> DeserializeArrestorCables(SerializedWorld world)
        {
            return DeserializeArrestorCables(world.ArrestorCables);
        }

        public static List<ArrestorCableField> DeserializeArrestorCables(IReadOnlyList<SerializedArrestorCables> list)
        {
            var result = new List<ArrestorCableField>();
            foreach (SerializedArrestorCables s in list ?? Array.Empty<SerializedArrestorCables>())
            {
                ArrestorCableField field = ArrestorCables.BuildArrestorCableField(
                    s.OriginX, s.OriginY, s.OriginZ, new Vec3d(s.DeckAxis[0], s.DeckAxis[1], s.DeckAxis[2]));
                // Prefer serialized local endpoints when present.
                if (s.SegmentsLocal.Count > 0)
                {
                    field.Segments.Clear();
                    foreach (double[] seg in s.SegmentsLocal)
                    {
                        field.Segments.Add(new ArrestorCableSegment
                        {
                            A = new Vec3d(s.OriginX + seg[0], s.OriginY + seg[1], s.OriginZ + seg[2]),
                            B = new Vec3d(s.OriginX + seg[3], s.OriginY + seg[4], s.OriginZ + seg[5]),
                        });
                    }
                }
                result.Add(field);
            }
            return result;
        }

        /// <summary>Default Kuznetsov cable field at an origin.</summary>
        public static ArrestorCableField DefaultArrestorCableField(double originX, double originY, double originZ, Quatd? orientation = null)
        {
            return ArrestorCables.BuildArrestorCableField(originX, originY, originZ, null, orientation);
        }
    }
}
