using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>World-space solid contact against terrain or an obstacle cylinder.</summary>
    public struct SolidWorldContact
    {
        /// <summary>Deepest penetrating sample (world).</summary>
        public Vec3d Point;
        /// <summary>Unit normal pointing out of the solid (into free air).</summary>
        public Vec3d Normal;
        /// <summary>Metres the sample is past the allowed surface (margin already applied).</summary>
        public double Penetration;
    }

    /// <summary>A hull contact point at or just under the ground: where it is, and how deep (m).</summary>
    public sealed class TerrainContactSample
    {
        public double X;
        public double Y;
        public double Z;
        public double Pen;
    }

    /// <summary>
    /// Body-frame collider helpers for bullet hits and solid-world crashes
    /// (port of physics/sim/aircraftCollision.ts). Triangles are a flat soup
    /// (9 numbers per triangle) in the body frame.
    /// </summary>
    public static class AircraftCollision
    {
        private const double Eps = 1e-8;
        /// <summary>XZ cells the hull is sampled in; 8 gives ~2 m cells on a fighter.</summary>
        private const int ContactGrid = 8;

        /// <summary>Points on the airframe used for solid contact. Float32, as the TS keeps them.</summary>
        private sealed class ContactSamples
        {
            /// <summary>Lowest hull vertex per XZ cell.</summary>
            public float[] Lower;
            /// <summary>Lowest and highest per cell.</summary>
            public float[] All;
        }

        private static readonly ConditionalWeakTable<AircraftCollisionMesh, ContactSamples> ContactCache =
            new ConditionalWeakTable<AircraftCollisionMesh, ContactSamples>();

        /// <summary>
        /// Closest-point segment vs sphere; returns the earliest surface intersection
        /// along the segment in outHit when it hits. seg = end - start.
        /// </summary>
        public static bool SegmentHitsSphere(Vec3d start, Vec3d seg, double segLenSq, Vec3d center, double radius, out Vec3d outHit)
        {
            outHit = default;
            Vec3d scratch = start - center;
            double a = segLenSq;
            double b = 2 * Vec3d.Dot(scratch, seg);
            double c = scratch.LengthSquared - radius * radius;
            if (a < 1e-12)
            {
                if (c > 0) return false;
                outHit = start;
                return true;
            }
            double disc = b * b - 4 * a * c;
            if (disc < 0) return false;
            double sqrtDisc = Math.Sqrt(disc);
            double inv2a = 0.5 / a;
            double t = (-b - sqrtDisc) * inv2a;
            if (t < 0 || t > 1)
            {
                t = (-b + sqrtDisc) * inv2a;
                if (t < 0 || t > 1) return false;
            }
            outHit = seg * t + start;
            return true;
        }

        /// <summary>Moller-Trumbore for a finite segment [origin, origin+dir]. Returns t in [0,1], or -1.</summary>
        public static double SegmentHitsTriangleBody(
            Vec3d origin, Vec3d dir,
            double ax, double ay, double az,
            double bx, double by, double bz,
            double cx, double cy, double cz)
        {
            var a = new Vec3d(ax, ay, az);
            var b = new Vec3d(bx, by, bz);
            var c = new Vec3d(cx, cy, cz);
            Vec3d e1 = b - a;
            Vec3d e2 = c - a;
            Vec3d pvec = Vec3d.Cross(dir, e2);
            double det = Vec3d.Dot(e1, pvec);
            if (det > -Eps && det < Eps) return -1;
            double invDet = 1 / det;
            Vec3d tvec = origin - a;
            double u = Vec3d.Dot(tvec, pvec) * invDet;
            if (u < 0 || u > 1) return -1;
            Vec3d qvec = Vec3d.Cross(tvec, e1);
            double v = Vec3d.Dot(dir, qvec) * invDet;
            if (v < 0 || u + v > 1) return -1;
            double t = Vec3d.Dot(e2, qvec) * invDet;
            return t >= 0 && t <= 1 ? t : -1;
        }

        private static double Component(Vec3d v, int i) => i == 0 ? v.X : i == 1 ? v.Y : v.Z;

        /// <summary>Axis-aligned body-frame AABB vs body-frame segment (slab method).</summary>
        public static bool SegmentHitsAabbBody(Vec3d start, Vec3d end, double[] min, double[] max)
        {
            Vec3d d = end - start;
            double tmin = 0;
            double tmax = 1;
            for (int i = 0; i < 3; i++)
            {
                double s = Component(start, i);
                double di = Component(d, i);
                double mn = min[i];
                double mx = max[i];
                if (Math.Abs(di) < Eps)
                {
                    if (s < mn || s > mx) return false;
                    continue;
                }
                double t1 = (mn - s) / di;
                double t2 = (mx - s) / di;
                if (t1 > t2)
                {
                    double tmp = t1; t1 = t2; t2 = tmp;
                }
                tmin = Math.Max(tmin, t1);
                tmax = Math.Min(tmax, t2);
                if (tmin > tmax) return false;
            }
            return true;
        }

        /// <summary>True when the world segment hits the body-frame mesh; outHitWorld is the earliest impact.</summary>
        public static bool SegmentHitsCollisionMesh(
            Vec3d worldStart, Vec3d worldEnd, Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh, out Vec3d outHitWorld)
        {
            outHitWorld = default;
            Quatd invQ = quaternion.Conjugate();
            Vec3d bodyStart = (worldStart - position).Rotate(invQ);
            Vec3d bodyEnd = (worldEnd - position).Rotate(invQ);
            if (!SegmentHitsAabbBody(bodyStart, bodyEnd, mesh.Aabb.Min, mesh.Aabb.Max))
            {
                return false;
            }
            Vec3d d = bodyEnd - bodyStart;
            double[] tris = mesh.Triangles;
            double bestT = double.PositiveInfinity;
            for (int i = 0; i + 8 < tris.Length; i += 9)
            {
                double t = SegmentHitsTriangleBody(
                    bodyStart, d,
                    tris[i], tris[i + 1], tris[i + 2],
                    tris[i + 3], tris[i + 4], tris[i + 5],
                    tris[i + 6], tris[i + 7], tris[i + 8]);
                if (t >= 0 && t < bestT)
                {
                    bestT = t;
                }
            }
            if (bestT == double.PositiveInfinity)
            {
                return false;
            }
            outHitWorld = (d * bestT + bodyStart).Rotate(quaternion) + position;
            return true;
        }

        /// <summary>True when `world` is inside the airframe (in its box, and not past its skin from its origin).</summary>
        private static bool PointInsideCollisionMesh(Vec3d world, Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh)
        {
            Vec3d local = (world - position).Rotate(quaternion.Conjugate());
            double[] min = mesh.Aabb.Min, max = mesh.Aabb.Max;
            if (local.X < min[0] || local.X > max[0] || local.Y < min[1] || local.Y > max[1]
                || local.Z < min[2] || local.Z > max[2])
            {
                return false;
            }
            // From the origin out to the point: if that crosses the skin, the point is outside it.
            return !SegmentHitsCollisionMesh(position, world, position, quaternion, mesh, out _);
        }

        /// <summary>
        /// Two airframes in contact: a hull point of one inside the other. Writes the
        /// point (world) and the normal pointing from B toward A, and returns true.
        /// </summary>
        public static bool FindAircraftPairContact(
            Vec3d posA, Quatd quatA, AircraftCollisionMesh meshA,
            Vec3d posB, Quatd quatB, AircraftCollisionMesh meshB,
            out Vec3d outPoint, out Vec3d outNormal)
        {
            bool found = false;
            double deepest = double.NegativeInfinity;
            Vec3d point = default, normal = default;

            void Test(float[] points, Vec3d p1, Quatd q1, Vec3d p2, Quatd q2, AircraftCollisionMesh m2, double sign)
            {
                for (int i = 0; i + 2 < points.Length; i += 3)
                {
                    Vec3d sample = new Vec3d(points[i], points[i + 1], points[i + 2]).Rotate(q1) + p1;
                    if (!PointInsideCollisionMesh(sample, p2, q2, m2))
                    {
                        continue;
                    }
                    // The deeper into the other, the closer to its centre.
                    double depth = -Vec3d.Distance(sample, p2);
                    if (depth > deepest)
                    {
                        deepest = depth;
                        found = true;
                        point = sample;
                        normal = (sample - p2) * sign;
                    }
                }
            }

            Test(CollisionContactPoints(meshA).All, posA, quatA, posB, quatB, meshB, 1);
            Test(CollisionContactPoints(meshB).All, posB, quatB, posA, quatA, meshA, -1);
            if (found)
            {
                if (normal.LengthSquared < 1e-8)
                {
                    normal = posA - posB;
                }
                if (normal.LengthSquared < 1e-8)
                {
                    normal = new Vec3d(0, 1, 0);
                }
                normal = normal.Normalized();
            }
            outPoint = point;
            outNormal = normal;
            return found;
        }

        /// <summary>
        /// Contact points on the airframe: the lowest (and highest) hull vertex in each
        /// cell of an XZ grid over the collider. Map insertion order is kept.
        /// </summary>
        private static ContactSamples CollisionContactPoints(AircraftCollisionMesh mesh)
        {
            return ContactCache.GetValue(mesh, BuildContactPoints);
        }

        private static ContactSamples BuildContactPoints(AircraftCollisionMesh mesh)
        {
            double[] min = mesh.Aabb.Min, max = mesh.Aabb.Max;
            double spanX = Math.Max(1e-6, max[0] - min[0]);
            double spanZ = Math.Max(1e-6, max[2] - min[2]);
            var lo = new Dictionary<int, double[]>();
            var hi = new Dictionary<int, double[]>();
            var loOrder = new List<int>();
            var hiOrder = new List<int>();
            double[] t = mesh.Triangles;
            for (int i = 0; i + 2 < t.Length; i += 3)
            {
                double x = t[i];
                double y = t[i + 1];
                double z = t[i + 2];
                double cx = Math.Min(ContactGrid - 1, Math.Max(0, Math.Floor((x - min[0]) / spanX * ContactGrid)));
                double cz = Math.Min(ContactGrid - 1, Math.Max(0, Math.Floor((z - min[2]) / spanZ * ContactGrid)));
                int key = (int)(cz * ContactGrid + cx);
                if (!lo.TryGetValue(key, out double[] l))
                {
                    loOrder.Add(key);
                    lo[key] = new[] { x, y, z };
                }
                else if (y < l[1])
                {
                    lo[key] = new[] { x, y, z };
                }
                if (!hi.TryGetValue(key, out double[] h))
                {
                    hiOrder.Add(key);
                    hi[key] = new[] { x, y, z };
                }
                else if (y > h[1])
                {
                    hi[key] = new[] { x, y, z };
                }
            }
            var lower = new float[lo.Count * 3];
            int n = 0;
            foreach (int key in loOrder)
            {
                double[] p = lo[key];
                lower[n++] = (float)p[0]; lower[n++] = (float)p[1]; lower[n++] = (float)p[2];
            }
            var extra = new List<double>();
            foreach (int key in hiOrder)
            {
                double[] p = hi[key];
                double[] l = lo[key];
                if (p[0] != l[0] || p[1] != l[1] || p[2] != l[2])
                {
                    extra.Add(p[0]); extra.Add(p[1]); extra.Add(p[2]);
                }
            }
            var all = new float[lower.Length + extra.Count];
            Array.Copy(lower, all, lower.Length);
            for (int i = 0; i < extra.Count; i++)
            {
                all[lower.Length + i] = (float)extra[i];
            }
            return new ContactSamples { Lower = lower, All = all };
        }

        /// <summary>Visit the body-frame contact points (and then the origin) in world space; stop when visit returns true.</summary>
        private static bool ForEachContactWorldSample(Vec3d position, Quatd quaternion, float[] points, Func<Vec3d, bool> visit)
        {
            for (int i = 0; i + 2 < points.Length; i += 3)
            {
                Vec3d world = new Vec3d(points[i], points[i + 1], points[i + 2]).Rotate(quaternion) + position;
                if (visit(world)) return true;
            }
            return visit(position);
        }

        /// <summary>True when any hull contact point is below local terrain by more than `margin`.</summary>
        public static bool CollisionMeshHitsTerrain(
            Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh, Func<double, double, double> groundHeightAt, double margin)
        {
            return FindCollisionMeshTerrainContact(position, quaternion, mesh, groundHeightAt, margin).HasValue;
        }

        /// <summary>Deepest terrain penetration of the airframe, or null if clear.</summary>
        public static SolidWorldContact? FindCollisionMeshTerrainContact(
            Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh, Func<double, double, double> groundHeightAt, double margin)
        {
            double bestPen = 0;
            double bestX = 0;
            double bestZ = 0;
            Vec3d best = default;
            ForEachContactWorldSample(position, quaternion, CollisionContactPoints(mesh).Lower, w =>
            {
                double gy = groundHeightAt(w.X, w.Z);
                double pen = (gy - margin) - w.Y;
                if (pen > bestPen)
                {
                    bestPen = pen;
                    best = w;
                    bestX = w.X;
                    bestZ = w.Z;
                }
                return false;
            });
            if (!(bestPen > 0))
            {
                return null;
            }
            const double e = 0.5;
            double hL = groundHeightAt(bestX - e, bestZ);
            double hR = groundHeightAt(bestX + e, bestZ);
            double hD = groundHeightAt(bestX, bestZ - e);
            double hU = groundHeightAt(bestX, bestZ + e);
            Vec3d normal = new Vec3d(-(hR - hL) / (2 * e), 1, -(hU - hD) / (2 * e)).Normalized();
            return new SolidWorldContact { Point = best, Normal = normal, Penetration = bestPen };
        }

        /// <summary>
        /// Every hull contact point under the ground or within `activeSlop` of it.
        /// Fills `out` (reusing its entries), returns the count.
        /// </summary>
        public static int CollectCollisionMeshTerrainContacts(
            Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh, Func<double, double, double> groundHeightAt,
            double margin, double activeSlop, List<TerrainContactSample> output)
        {
            int n = 0;
            ForEachContactWorldSample(position, quaternion, CollisionContactPoints(mesh).Lower, w =>
            {
                double pen = (groundHeightAt(w.X, w.Z) - margin) - w.Y;
                if (pen <= -activeSlop || n >= 96)
                {
                    return false;
                }
                if (n >= output.Count)
                {
                    output.Add(new TerrainContactSample());
                }
                TerrainContactSample s = output[n++];
                s.X = w.X;
                s.Y = w.Y;
                s.Z = w.Z;
                s.Pen = pen;
                return false;
            });
            return n;
        }

        /// <summary>True when any hull contact point lies inside an upright obstacle cylinder.</summary>
        public static bool CollisionMeshHitsObstacle(Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh, Obstacle obstacle)
        {
            return FindCollisionMeshObstacleContact(position, quaternion, mesh, obstacle).HasValue;
        }

        /// <summary>Deepest cylinder penetration of the airframe, or null if clear.</summary>
        public static SolidWorldContact? FindCollisionMeshObstacleContact(
            Vec3d position, Quatd quaternion, AircraftCollisionMesh mesh, Obstacle obstacle)
        {
            double ox = obstacle.Position.X;
            double oy = obstacle.Position.Y;
            double oz = obstacle.Position.Z;
            double r = obstacle.Radius;
            double top = oy + obstacle.Height;
            double reach = JsMath.Hypot(
                Math.Max(Math.Abs(mesh.Aabb.Min[0]), Math.Abs(mesh.Aabb.Max[0])),
                Math.Max(Math.Abs(mesh.Aabb.Min[2]), Math.Abs(mesh.Aabb.Max[2])));
            double dx0 = position.X - ox;
            double dz0 = position.Z - oz;
            if (JsMath.Hypot(dx0, dz0) > r + reach)
            {
                return null;
            }
            double bestPen = 0;
            Vec3d best = default, normal = default;
            ForEachContactWorldSample(position, quaternion, CollisionContactPoints(mesh).All, w =>
            {
                if (w.Y < oy || w.Y > top) return false;
                double dx = w.X - ox;
                double dz = w.Z - oz;
                double dist = JsMath.Hypot(dx, dz);
                if (dist > r) return false;
                double sidePen = r - dist;
                double roofPen = top - w.Y;
                bool useRoof = dist < r * 0.25 && roofPen < sidePen;
                double pen = useRoof ? roofPen : sidePen;
                if (pen > bestPen)
                {
                    bestPen = pen;
                    best = w;
                    if (useRoof)
                    {
                        normal = new Vec3d(0, 1, 0);
                    }
                    else if (dist > 1e-4)
                    {
                        normal = new Vec3d(dx / dist, 0, dz / dist);
                    }
                    else
                    {
                        normal = new Vec3d(1, 0, 0);
                    }
                }
                return false;
            });
            if (!(bestPen > 0))
            {
                return null;
            }
            return new SolidWorldContact { Point = best, Normal = normal, Penetration = bestPen };
        }

        /// <summary>Sphere (hit-radius) vs upright cylinder; fallback when no collision mesh.</summary>
        public static bool SphereHitsObstacle(Vec3d position, double radius, Obstacle obstacle)
        {
            double dx = position.X - obstacle.Position.X;
            double dz = position.Z - obstacle.Position.Z;
            if (JsMath.Hypot(dx, dz) > obstacle.Radius + radius) return false;
            double y0 = position.Y - radius;
            double y1 = position.Y + radius;
            double top = obstacle.Position.Y + obstacle.Height;
            return y1 >= obstacle.Position.Y && y0 <= top;
        }
    }
}
