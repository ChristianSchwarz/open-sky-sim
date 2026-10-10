using System;

namespace Retro.Core
{
    /// <summary>
    /// Double-precision quaternion, [x, y, z, w] like three.js, with the same
    /// formulas (multiplyQuaternions, setFromRotationMatrix, normalize).
    /// </summary>
    public struct Quatd : IEquatable<Quatd>
    {
        public double X;
        public double Y;
        public double Z;
        public double W;

        public Quatd(double x, double y, double z, double w)
        {
            X = x;
            Y = y;
            Z = z;
            W = w;
        }

        public static readonly Quatd Identity = new Quatd(0, 0, 0, 1);

        public double Length => Math.Sqrt(X * X + Y * Y + Z * Z + W * W);

        /// <summary>a * b (three.js multiplyQuaternions(a, b)).</summary>
        public static Quatd operator *(Quatd a, Quatd b)
        {
            double qax = a.X, qay = a.Y, qaz = a.Z, qaw = a.W;
            double qbx = b.X, qby = b.Y, qbz = b.Z, qbw = b.W;
            return new Quatd(
                qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
                qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
                qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
                qaw * qbw - qax * qbx - qay * qby - qaz * qbz);
        }

        /// <summary>three.js normalize: a zero quaternion becomes the identity.</summary>
        public Quatd Normalized()
        {
            double l = Length;
            if (l == 0) return Identity;
            l = 1 / l;
            return new Quatd(X * l, Y * l, Z * l, W * l);
        }

        /// <summary>three.js invert: the conjugate (assumes unit length).</summary>
        public Quatd Conjugate() => new Quatd(-X, -Y, -Z, W);

        public static double Dot(Quatd a, Quatd b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z + a.W * b.W;

        public static Quatd FromAxisAngle(Vec3d axis, double angle)
        {
            double half = angle / 2, s = Math.Sin(half);
            return new Quatd(axis.X * s, axis.Y * s, axis.Z * s, Math.Cos(half));
        }

        /// <summary>three.js setFromRotationMatrix on a pure rotation (same branch order).</summary>
        public static Quatd FromRotationMatrix(Mat3d m)
        {
            double m11 = m.M11, m12 = m.M12, m13 = m.M13;
            double m21 = m.M21, m22 = m.M22, m23 = m.M23;
            double m31 = m.M31, m32 = m.M32, m33 = m.M33;
            double trace = m11 + m22 + m33;
            if (trace > 0)
            {
                double s = 0.5 / Math.Sqrt(trace + 1.0);
                return new Quatd((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
            }
            if (m11 > m22 && m11 > m33)
            {
                double s = 2.0 * Math.Sqrt(1.0 + m11 - m22 - m33);
                return new Quatd(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
            }
            if (m22 > m33)
            {
                double s = 2.0 * Math.Sqrt(1.0 + m22 - m11 - m33);
                return new Quatd((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
            }
            {
                double s = 2.0 * Math.Sqrt(1.0 + m33 - m11 - m22);
                return new Quatd((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
            }
        }

        public bool Equals(Quatd other) => X == other.X && Y == other.Y && Z == other.Z && W == other.W;
        public override bool Equals(object obj) => obj is Quatd q && Equals(q);
        public override int GetHashCode() => HashCode.Combine(X, Y, Z, W);
        public override string ToString() => $"({X}, {Y}, {Z}, {W})";
    }
}
