using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// The JavaScript / three.js semantics the AI pilots lean on that have no
    /// exact Retro.Core counterpart.
    /// </summary>
    internal static class AiMath
    {
        /// <summary>Wrap an angle to [-pi, pi].</summary>
        public static double WrapPi(double a)
        {
            while (a > Math.PI) a -= 2 * Math.PI;
            while (a < -Math.PI) a += 2 * Math.PI;
            return a;
        }

        /// <summary>JS <c>x || 1</c> on a number: 0 and NaN are falsy.</summary>
        public static double OrOne(double x) => x == 0 || double.IsNaN(x) ? 1 : x;

        /// <summary>three.js Vector3.normalize: divideScalar(length || 1).</summary>
        public static Vec3d Normalize(Vec3d v) => v / OrOne(v.Length);

        /// <summary>three.js Vector3.lerp: this += (v - this) * alpha.</summary>
        public static Vec3d Lerp(Vec3d a, Vec3d b, double alpha) =>
            new Vec3d(a.X + (b.X - a.X) * alpha, a.Y + (b.Y - a.Y) * alpha, a.Z + (b.Z - a.Z) * alpha);

        /// <summary>three.js Vector3.distanceTo: sqrt(dx*dx + dy*dy + dz*dz), d = this - v.</summary>
        public static double DistanceTo(Vec3d a, Vec3d b)
        {
            double dx = a.X - b.X, dy = a.Y - b.Y, dz = a.Z - b.Z;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }
    }
}
