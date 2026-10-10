namespace Retro.Core
{
    /// <summary>
    /// Double-precision 3x3 matrix in mathematical row/column naming (M12 is
    /// row 1, column 2). Only what the ports of geodesy and the flight models
    /// need; three.js Matrix4 is used there only for its upper 3x3.
    /// </summary>
    public struct Mat3d
    {
        public double M11, M12, M13;
        public double M21, M22, M23;
        public double M31, M32, M33;

        public Mat3d(
            double m11, double m12, double m13,
            double m21, double m22, double m23,
            double m31, double m32, double m33)
        {
            M11 = m11; M12 = m12; M13 = m13;
            M21 = m21; M22 = m22; M23 = m23;
            M31 = m31; M32 = m32; M33 = m33;
        }

        public static readonly Mat3d Identity = new Mat3d(1, 0, 0, 0, 1, 0, 0, 0, 1);

        public Mat3d Transposed() => new Mat3d(M11, M21, M31, M12, M22, M32, M13, M23, M33);

        /// <summary>a * b, summed in the order three.js multiplyMatrices uses.</summary>
        public static Mat3d operator *(Mat3d a, Mat3d b) => new Mat3d(
            a.M11 * b.M11 + a.M12 * b.M21 + a.M13 * b.M31,
            a.M11 * b.M12 + a.M12 * b.M22 + a.M13 * b.M32,
            a.M11 * b.M13 + a.M12 * b.M23 + a.M13 * b.M33,
            a.M21 * b.M11 + a.M22 * b.M21 + a.M23 * b.M31,
            a.M21 * b.M12 + a.M22 * b.M22 + a.M23 * b.M32,
            a.M21 * b.M13 + a.M22 * b.M23 + a.M23 * b.M33,
            a.M31 * b.M11 + a.M32 * b.M21 + a.M33 * b.M31,
            a.M31 * b.M12 + a.M32 * b.M22 + a.M33 * b.M32,
            a.M31 * b.M13 + a.M32 * b.M23 + a.M33 * b.M33);

        public static Vec3d operator *(Mat3d m, Vec3d v) => new Vec3d(
            m.M11 * v.X + m.M12 * v.Y + m.M13 * v.Z,
            m.M21 * v.X + m.M22 * v.Y + m.M23 * v.Z,
            m.M31 * v.X + m.M32 * v.Y + m.M33 * v.Z);
    }
}
