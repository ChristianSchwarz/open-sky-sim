namespace Retro.Core
{
    /// <summary>
    /// Double-precision 4x4 matrix stored column-major exactly like three.js
    /// Matrix4.elements (E[12..14] is the translation). Only the operations the
    /// terrain LOD needs for camera frusta, written term for term as three.js does.
    /// </summary>
    public sealed class Mat4d
    {
        public readonly double[] E = new double[16];

        public static Mat4d Identity()
        {
            var m = new Mat4d();
            m.E[0] = m.E[5] = m.E[10] = m.E[15] = 1;
            return m;
        }

        /// <summary>three.js compose(position, quaternion, scale).</summary>
        public static Mat4d Compose(Vec3d position, Quatd q, Vec3d scale)
        {
            var m = new Mat4d();
            double[] te = m.E;
            double x = q.X, y = q.Y, z = q.Z, w = q.W;
            double x2 = x + x, y2 = y + y, z2 = z + z;
            double xx = x * x2, xy = x * y2, xz = x * z2;
            double yy = y * y2, yz = y * z2, zz = z * z2;
            double wx = w * x2, wy = w * y2, wz = w * z2;
            double sx = scale.X, sy = scale.Y, sz = scale.Z;
            te[0] = (1 - (yy + zz)) * sx;
            te[1] = (xy + wz) * sx;
            te[2] = (xz - wy) * sx;
            te[3] = 0;
            te[4] = (xy - wz) * sy;
            te[5] = (1 - (xx + zz)) * sy;
            te[6] = (yz + wx) * sy;
            te[7] = 0;
            te[8] = (xz + wy) * sz;
            te[9] = (yz - wx) * sz;
            te[10] = (1 - (xx + yy)) * sz;
            te[11] = 0;
            te[12] = position.X;
            te[13] = position.Y;
            te[14] = position.Z;
            te[15] = 1;
            return m;
        }

        /// <summary>three.js makePerspective for the WebGL clip space (no reversed depth).</summary>
        public static Mat4d MakePerspective(double left, double right, double top, double bottom, double near, double far)
        {
            var m = new Mat4d();
            double[] te = m.E;
            double x = 2 * near / (right - left);
            double y = 2 * near / (top - bottom);
            double a = (right + left) / (right - left);
            double b = (top + bottom) / (top - bottom);
            double c = -(far + near) / (far - near);
            double d = (-2 * far * near) / (far - near);
            te[0] = x; te[4] = 0; te[8] = a; te[12] = 0;
            te[1] = 0; te[5] = y; te[9] = b; te[13] = 0;
            te[2] = 0; te[6] = 0; te[10] = c; te[14] = d;
            te[3] = 0; te[7] = 0; te[11] = -1; te[15] = 0;
            return m;
        }

        /// <summary>PerspectiveCamera.updateProjectionMatrix with zoom 1, no view offset, no film offset.</summary>
        public static Mat4d PerspectiveProjection(double fovYDeg, double aspect, double near, double far)
        {
            double top = near * System.Math.Tan(System.Math.PI / 180 * 0.5 * fovYDeg) / 1;
            double height = 2 * top;
            double width = aspect * height;
            double left = -0.5 * width;
            return MakePerspective(left, left + width, top, top - height, near, far);
        }

        /// <summary>a * b (three.js multiplyMatrices).</summary>
        public static Mat4d Multiply(Mat4d a, Mat4d b)
        {
            double[] ae = a.E, be = b.E;
            var m = new Mat4d();
            double[] te = m.E;
            double a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
            double a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
            double a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
            double a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
            double b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
            double b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
            double b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
            double b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
            te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
            te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
            te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
            te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
            te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
            te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
            te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
            te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
            te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
            te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
            te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
            te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
            te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
            te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
            te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
            te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
            return m;
        }

        /// <summary>three.js invert (gl-matrix); a singular matrix becomes all zeros.</summary>
        public Mat4d Inverted()
        {
            double[] te = E;
            double n11 = te[0], n21 = te[1], n31 = te[2], n41 = te[3];
            double n12 = te[4], n22 = te[5], n32 = te[6], n42 = te[7];
            double n13 = te[8], n23 = te[9], n33 = te[10], n43 = te[11];
            double n14 = te[12], n24 = te[13], n34 = te[14], n44 = te[15];
            double t1 = n11 * n22 - n21 * n12;
            double t2 = n11 * n32 - n31 * n12;
            double t3 = n11 * n42 - n41 * n12;
            double t4 = n21 * n32 - n31 * n22;
            double t5 = n21 * n42 - n41 * n22;
            double t6 = n31 * n42 - n41 * n32;
            double t7 = n13 * n24 - n23 * n14;
            double t8 = n13 * n34 - n33 * n14;
            double t9 = n13 * n44 - n43 * n14;
            double t10 = n23 * n34 - n33 * n24;
            double t11 = n23 * n44 - n43 * n24;
            double t12 = n33 * n44 - n43 * n34;
            double det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
            var m = new Mat4d();
            if (det == 0) return m;
            double detInv = 1 / det;
            double[] o = m.E;
            o[0] = (n22 * t12 - n32 * t11 + n42 * t10) * detInv;
            o[1] = (n31 * t11 - n21 * t12 - n41 * t10) * detInv;
            o[2] = (n24 * t6 - n34 * t5 + n44 * t4) * detInv;
            o[3] = (n33 * t5 - n23 * t6 - n43 * t4) * detInv;
            o[4] = (n32 * t9 - n12 * t12 - n42 * t8) * detInv;
            o[5] = (n11 * t12 - n31 * t9 + n41 * t8) * detInv;
            o[6] = (n34 * t3 - n14 * t6 - n44 * t2) * detInv;
            o[7] = (n13 * t6 - n33 * t3 + n43 * t2) * detInv;
            o[8] = (n12 * t11 - n22 * t9 + n42 * t7) * detInv;
            o[9] = (n21 * t9 - n11 * t11 - n41 * t7) * detInv;
            o[10] = (n14 * t5 - n24 * t3 + n44 * t1) * detInv;
            o[11] = (n23 * t3 - n13 * t5 - n43 * t1) * detInv;
            o[12] = (n22 * t8 - n12 * t10 - n32 * t7) * detInv;
            o[13] = (n11 * t10 - n21 * t8 + n31 * t7) * detInv;
            o[14] = (n24 * t2 - n14 * t4 - n34 * t1) * detInv;
            o[15] = (n13 * t4 - n23 * t2 + n33 * t1) * detInv;
            return m;
        }
    }
}
