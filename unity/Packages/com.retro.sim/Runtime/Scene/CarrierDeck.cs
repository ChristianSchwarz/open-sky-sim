using System;
using System.Collections.Generic;

namespace Retro.Sim
{
    /// <summary>Axis-aligned box in a collider's local frame.</summary>
    public sealed class ColliderAabb
    {
        public double[] Min = new double[3];
        public double[] Max = new double[3];

        public ColliderAabb()
        {
        }

        public ColliderAabb(double[] min, double[] max)
        {
            Min = min;
            Max = max;
        }
    }

    /// <summary>
    /// Baked collision soup: a flat list of triangles (9 numbers each) in the body
    /// (or entity-local) frame, with its bounding box (port of aircraftDef.ts AircraftCollisionMesh).
    /// </summary>
    public sealed class AircraftCollisionMesh
    {
        public double[] Triangles = Array.Empty<double>();
        public ColliderAabb Aabb = new ColliderAabb();
    }

    /// <summary>Static carrier collider: local triangle soup + world origin (port of carrierDeck.ts).</summary>
    public sealed class CarrierMeshCollider
    {
        /// <summary>World origin of the local mesh frame (carrier placement).</summary>
        public double OriginX;
        public double OriginY;
        public double OriginZ;
        /// <summary>Local-frame triangle soup (same layout as <see cref="AircraftCollisionMesh"/>).</summary>
        public double[] Triangles = Array.Empty<double>();
        public ColliderAabb Aabb = new ColliderAabb();
    }

    /// <summary>
    /// Carrier collision from the triangle mesh: gear springs and solid-world
    /// contacts sample surface height from the baked soup (highest triangle under
    /// each XZ query; works for flat deck and ski-jump ramp alike).
    /// </summary>
    public static class CarrierDeck
    {
        private const double Eps = 1e-8;

        /// <summary>
        /// Sentinel for "no surface of this kind here". It has to be -Infinity rather
        /// than 0: every sampler is folded into a max that decides the ground, and
        /// scene Y = 0 is the tangent plane, not the ground.
        /// </summary>
        public const double NoSurfaceY = double.NegativeInfinity;

        public static CarrierMeshCollider CreateCarrierMeshCollider(double originX, double originY, double originZ, AircraftCollisionMesh mesh)
        {
            return new CarrierMeshCollider
            {
                OriginX = originX,
                OriginY = originY,
                OriginZ = originZ,
                Triangles = mesh.Triangles,
                Aabb = mesh.Aabb,
            };
        }

        /// <summary>Barycentric test: is (px,pz) inside triangle projected on XZ?</summary>
        private static bool PointInTriangleXZ(
            double px, double pz,
            double ax, double az,
            double bx, double bz,
            double cx, double cz)
        {
            double v0x = cx - ax;
            double v0z = cz - az;
            double v1x = bx - ax;
            double v1z = bz - az;
            double v2x = px - ax;
            double v2z = pz - az;
            double dot00 = v0x * v0x + v0z * v0z;
            double dot01 = v0x * v1x + v0z * v1z;
            double dot02 = v0x * v2x + v0z * v2z;
            double dot11 = v1x * v1x + v1z * v1z;
            double dot12 = v1x * v2x + v1z * v2z;
            double denom = dot00 * dot11 - dot01 * dot01;
            if (Math.Abs(denom) < Eps)
            {
                return false;
            }
            double inv = 1 / denom;
            double u = (dot11 * dot02 - dot01 * dot12) * inv;
            double v = (dot00 * dot12 - dot01 * dot02) * inv;
            return u >= -Eps && v >= -Eps && u + v <= 1 + Eps;
        }

        /// <summary>Plane Y at (px,pz) for triangle ABC (non-vertical); null for a vertical face.</summary>
        private static double? PlaneYAtXZ(
            double px, double pz,
            double ax, double ay, double az,
            double bx, double by, double bz,
            double cx, double cy, double cz)
        {
            double e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            double e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            double nx = e1y * e2z - e1z * e2y;
            double ny = e1z * e2x - e1x * e2z;
            double nz = e1x * e2y - e1y * e2x;
            if (Math.Abs(ny) < Eps)
            {
                return null;
            }
            return ay - (nx * (px - ax) + nz * (pz - az)) / ny;
        }

        /// <summary>Highest mesh surface Y at (worldX, worldZ), or <see cref="NoSurfaceY"/> if no triangle covers that XZ.</summary>
        public static double SampleCarrierMeshSurfaceY(double worldX, double worldZ, CarrierMeshCollider carrier)
        {
            double lx = worldX - carrier.OriginX;
            double lz = worldZ - carrier.OriginZ;
            double[] min = carrier.Aabb.Min, max = carrier.Aabb.Max;
            if (lx < min[0] || lx > max[0] || lz < min[2] || lz > max[2])
            {
                return NoSurfaceY;
            }
            double[] tris = carrier.Triangles;
            double bestY = double.NegativeInfinity;
            for (int i = 0; i + 8 < tris.Length; i += 9)
            {
                double ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
                double bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
                double cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];
                if (!PointInTriangleXZ(lx, lz, ax, az, bx, bz, cx, cz))
                {
                    continue;
                }
                double? y = PlaneYAtXZ(lx, lz, ax, ay, az, bx, by, bz, cx, cy, cz);
                if (y.HasValue && y.Value > bestY)
                {
                    bestY = y.Value;
                }
            }
            if (bestY == double.NegativeInfinity)
            {
                return NoSurfaceY;
            }
            return carrier.OriginY + bestY;
        }

        /// <summary>Highest carrier-mesh surface among colliders, or <see cref="NoSurfaceY"/>.</summary>
        public static double SampleCarrierMeshSurfaceYMax(double worldX, double worldZ, IReadOnlyList<CarrierMeshCollider> carriers)
        {
            double maxY = NoSurfaceY;
            for (int i = 0; i < carriers.Count; i++)
            {
                double y = SampleCarrierMeshSurfaceY(worldX, worldZ, carriers[i]);
                if (y > maxY)
                {
                    maxY = y;
                }
            }
            return maxY;
        }
    }
}
