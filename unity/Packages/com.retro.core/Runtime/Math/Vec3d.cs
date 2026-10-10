using System;

namespace Retro.Core
{
    /// <summary>
    /// Double-precision 3-vector. Operations follow three.js term for term so
    /// results agree with the TypeScript reference to the last few bits.
    /// Scene convention: x = east, y = up, z = SOUTH (right-handed).
    /// </summary>
    public struct Vec3d : IEquatable<Vec3d>
    {
        public double X;
        public double Y;
        public double Z;

        public Vec3d(double x, double y, double z)
        {
            X = x;
            Y = y;
            Z = z;
        }

        public static readonly Vec3d Zero = new Vec3d(0, 0, 0);
        public static readonly Vec3d UnitX = new Vec3d(1, 0, 0);
        public static readonly Vec3d UnitY = new Vec3d(0, 1, 0);
        public static readonly Vec3d UnitZ = new Vec3d(0, 0, 1);

        public double LengthSquared => X * X + Y * Y + Z * Z;

        /// <summary>three.js Vector3.length: sqrt of the sum of squares (not hypot).</summary>
        public double Length => Math.Sqrt(X * X + Y * Y + Z * Z);

        public static Vec3d operator +(Vec3d a, Vec3d b) => new Vec3d(a.X + b.X, a.Y + b.Y, a.Z + b.Z);
        public static Vec3d operator -(Vec3d a, Vec3d b) => new Vec3d(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
        public static Vec3d operator -(Vec3d a) => new Vec3d(-a.X, -a.Y, -a.Z);
        public static Vec3d operator *(Vec3d a, double s) => new Vec3d(a.X * s, a.Y * s, a.Z * s);
        public static Vec3d operator *(double s, Vec3d a) => new Vec3d(a.X * s, a.Y * s, a.Z * s);

        /// <summary>three.js divideScalar multiplies by the reciprocal.</summary>
        public static Vec3d operator /(Vec3d a, double s) => a * (1 / s);

        public static double Dot(Vec3d a, Vec3d b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

        public static Vec3d Cross(Vec3d a, Vec3d b) => new Vec3d(
            a.Y * b.Z - a.Z * b.Y,
            a.Z * b.X - a.X * b.Z,
            a.X * b.Y - a.Y * b.X);

        /// <summary>three.js normalize: divideScalar(length || 1).</summary>
        public Vec3d Normalized()
        {
            double l = Length;
            return this / (l == 0 ? 1 : l);
        }

        /// <summary>this + v * s (three.js addScaledVector).</summary>
        public Vec3d AddScaled(Vec3d v, double s) => new Vec3d(X + v.X * s, Y + v.Y * s, Z + v.Z * s);

        public static double Distance(Vec3d a, Vec3d b) => (a - b).Length;

        /// <summary>three.js lerpVectors(a, b, t).</summary>
        public static Vec3d Lerp(Vec3d a, Vec3d b, double t) =>
            new Vec3d(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t, a.Z + (b.Z - a.Z) * t);

        /// <summary>three.js applyQuaternion (q assumed unit length).</summary>
        public Vec3d Rotate(Quatd q)
        {
            double vx = X, vy = Y, vz = Z;
            double qx = q.X, qy = q.Y, qz = q.Z, qw = q.W;
            double tx = 2 * (qy * vz - qz * vy);
            double ty = 2 * (qz * vx - qx * vz);
            double tz = 2 * (qx * vy - qy * vx);
            return new Vec3d(
                vx + qw * tx + qy * tz - qz * ty,
                vy + qw * ty + qz * tx - qx * tz,
                vz + qw * tz + qx * ty - qy * tx);
        }

        public bool Equals(Vec3d other) => X == other.X && Y == other.Y && Z == other.Z;
        public override bool Equals(object obj) => obj is Vec3d v && Equals(v);
        public override int GetHashCode() => HashCode.Combine(X, Y, Z);
        public override string ToString() => $"({X}, {Y}, {Z})";
    }
}
