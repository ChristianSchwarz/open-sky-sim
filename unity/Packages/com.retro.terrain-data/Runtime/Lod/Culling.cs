using System;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// A camera frustum as six normalised planes, built from projection * view
    /// exactly like three.js Frustum.setFromProjectionMatrix (WebGL clip space).
    /// Engine-free so the quadtree can run in tests; the Unity side builds it
    /// from its camera's matrices in the same scene axes.
    /// </summary>
    public sealed class CameraFrustum
    {
        /// <summary>Plane normals (x, y, z) and constants, 6 planes.</summary>
        private readonly double[] nx = new double[6], ny = new double[6], nz = new double[6], c = new double[6];

        public static CameraFrustum FromProjectionView(Mat4d projectionTimesView)
        {
            var f = new CameraFrustum();
            double[] me = projectionTimesView.E;
            double me0 = me[0], me1 = me[1], me2 = me[2], me3 = me[3];
            double me4 = me[4], me5 = me[5], me6 = me[6], me7 = me[7];
            double me8 = me[8], me9 = me[9], me10 = me[10], me11 = me[11];
            double me12 = me[12], me13 = me[13], me14 = me[14], me15 = me[15];
            f.Set(0, me3 - me0, me7 - me4, me11 - me8, me15 - me12);
            f.Set(1, me3 + me0, me7 + me4, me11 + me8, me15 + me12);
            f.Set(2, me3 + me1, me7 + me5, me11 + me9, me15 + me13);
            f.Set(3, me3 - me1, me7 - me5, me11 - me9, me15 - me13);
            f.Set(4, me3 - me2, me7 - me6, me11 - me10, me15 - me14);
            f.Set(5, me3 + me2, me7 + me6, me11 + me10, me15 + me14);
            return f;
        }

        /// <summary>A perspective camera at `position` with orientation `q` (three.js camera conventions: looks down -Z).</summary>
        public static CameraFrustum FromCamera(Vec3d position, Quatd q, double fovYDeg, double aspect, double near, double far)
        {
            Mat4d projection = Mat4d.PerspectiveProjection(fovYDeg, aspect, near, far);
            Mat4d view = Mat4d.Compose(position, q, new Vec3d(1, 1, 1)).Inverted();
            return FromProjectionView(Mat4d.Multiply(projection, view));
        }

        /// <summary>Plane.setComponents(...).normalize().</summary>
        private void Set(int i, double x, double y, double z, double w)
        {
            double inv = 1.0 / Math.Sqrt(x * x + y * y + z * z);
            nx[i] = x * inv;
            ny[i] = y * inv;
            nz[i] = z * inv;
            c[i] = w * inv;
        }

        /// <summary>True when the sphere is at least partly inside (three.js intersectsSphere).</summary>
        public bool IntersectsSphere(Vec3d center, double radius)
        {
            double negRadius = -radius;
            for (int i = 0; i < 6; i++)
            {
                double distance = nx[i] * center.X + ny[i] * center.Y + nz[i] * center.Z + c[i];
                if (distance < negRadius) return false;
            }
            return true;
        }
    }

    public static class Culling
    {
        /// <summary>
        /// Horizon cull on the WGS84 sphere (culling.ts behindHorizon): the bounding
        /// sphere's centre hidden behind the limb, with a slack of its radius.
        /// </summary>
        public static bool BehindHorizon(Vec3d sphereCenterWorld, double sphereRadius, Vec3d cameraWorld,
            Vec3d earthCenterWorld, double radiusM = Geodesy.Wgs84A)
        {
            Vec3d toCenter = cameraWorld - earthCenterWorld;
            double camDist = toCenter.Length;
            if (camDist <= radiusM) return false;
            double sinHorizon = radiusM / camDist;
            double cosHorizon = Math.Sqrt(Math.Max(0, 1 - sinHorizon * sinHorizon));
            Vec3d toPoint = sphereCenterWorld - earthCenterWorld;
            double pointDist = toPoint.Length;
            if (pointDist < 1) return false;
            double cosAngle = Vec3d.Dot(toCenter, toPoint) / (camDist * pointDist);
            double slack = sphereRadius / Math.Max(pointDist, 1);
            return cosAngle < cosHorizon - slack;
        }
    }
}
