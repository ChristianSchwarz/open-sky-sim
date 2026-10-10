using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Analytic cone collider matching lib:hill / lib:mountain geometry (port of hillCollider.ts).</summary>
    public sealed class HillCollider
    {
        public Mat4d WorldToLocal = Mat4d.Identity();
        public Mat4d LocalToWorld = Mat4d.Identity();
        public double BaseRadius;
        public double Height;
        public double WorldX;
        public double WorldZ;
        /// <summary>Horizontal reach in world XZ for cheap proximity tests.</summary>
        public double WorldReach;
    }

    public static class HillColliders
    {
        private static bool HillMayAffectPoint(double worldX, double worldZ, HillCollider hill)
        {
            double dx = Math.Abs(worldX - hill.WorldX);
            double dz = Math.Abs(worldZ - hill.WorldZ);
            if (dx > hill.WorldReach || dz > hill.WorldReach)
            {
                return false;
            }
            return dx + dz <= hill.WorldReach;
        }

        /// <summary>three.js Vector3.applyMatrix4 (with the projective divide).</summary>
        internal static Vec3d ApplyMatrix4(Vec3d v, Mat4d m)
        {
            double x = v.X, y = v.Y, z = v.Z;
            double[] e = m.E;
            double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            return new Vec3d(
                (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
                (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
                (e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
        }

        /// <summary>World Y of the highest hill/mountain surface at (worldX, worldZ), or <see cref="CarrierDeck.NoSurfaceY"/>.</summary>
        public static double SampleHillSurfaceY(double worldX, double worldZ, IReadOnlyList<HillCollider> hills)
        {
            if (hills.Count == 0)
            {
                return CarrierDeck.NoSurfaceY;
            }
            double maxY = CarrierDeck.NoSurfaceY;
            for (int i = 0; i < hills.Count; i++)
            {
                HillCollider hill = hills[i];
                if (!HillMayAffectPoint(worldX, worldZ, hill))
                {
                    continue;
                }
                Vec3d local = ApplyMatrix4(new Vec3d(worldX, 0, worldZ), hill.WorldToLocal);
                // 4-sided cone base is a diamond (|x|+|z|<=R), not a circle.
                double footprint = Math.Abs(local.X) + Math.Abs(local.Z);
                if (footprint > hill.BaseRadius)
                {
                    continue;
                }
                local.Y = hill.Height * (1 - footprint / hill.BaseRadius);
                Vec3d world = ApplyMatrix4(local, hill.LocalToWorld);
                if (world.Y > maxY)
                {
                    maxY = world.Y;
                }
            }
            return maxY;
        }
    }
}
