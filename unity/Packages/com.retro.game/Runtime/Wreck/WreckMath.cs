using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// three.js Box3, as the wreck code uses it (wreckField.ts): a mutable box
    /// that starts empty (+inf / -inf), with the same min/max and clamp formulas.
    /// </summary>
    public sealed class WreckBox3
    {
        public Vec3d Min = new Vec3d(double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity);
        public Vec3d Max = new Vec3d(double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity);

        public WreckBox3 Clone() => new WreckBox3 { Min = Min, Max = Max };

        public void MakeEmpty()
        {
            Min = new Vec3d(double.PositiveInfinity, double.PositiveInfinity, double.PositiveInfinity);
            Max = new Vec3d(double.NegativeInfinity, double.NegativeInfinity, double.NegativeInfinity);
        }

        public bool IsEmpty => Max.X < Min.X || Max.Y < Min.Y || Max.Z < Min.Z;

        public void ExpandByPoint(Vec3d p)
        {
            Min = new Vec3d(Math.Min(Min.X, p.X), Math.Min(Min.Y, p.Y), Math.Min(Min.Z, p.Z));
            Max = new Vec3d(Math.Max(Max.X, p.X), Math.Max(Max.Y, p.Y), Math.Max(Max.Z, p.Z));
        }

        public void ExpandByPoint(double x, double y, double z) => ExpandByPoint(new Vec3d(x, y, z));

        public void Union(WreckBox3 b)
        {
            Min = new Vec3d(Math.Min(Min.X, b.Min.X), Math.Min(Min.Y, b.Min.Y), Math.Min(Min.Z, b.Min.Z));
            Max = new Vec3d(Math.Max(Max.X, b.Max.X), Math.Max(Max.Y, b.Max.Y), Math.Max(Max.Z, b.Max.Z));
        }

        public void ExpandByScalar(double s)
        {
            Min = new Vec3d(Min.X + -s, Min.Y + -s, Min.Z + -s);
            Max = new Vec3d(Max.X + s, Max.Y + s, Max.Z + s);
        }

        /// <summary>Box3.getCenter: the origin for an empty box.</summary>
        public Vec3d Center => IsEmpty ? Vec3d.Zero : new Vec3d((Min.X + Max.X) * 0.5, (Min.Y + Max.Y) * 0.5, (Min.Z + Max.Z) * 0.5);

        /// <summary>Box3.getSize: zero for an empty box.</summary>
        public Vec3d Size => IsEmpty ? Vec3d.Zero : Max - Min;

        public bool IntersectsBox(WreckBox3 b) =>
            !(b.Max.X < Min.X || b.Min.X > Max.X || b.Max.Y < Min.Y || b.Min.Y > Max.Y || b.Max.Z < Min.Z || b.Min.Z > Max.Z);

        public double DistanceToPoint(Vec3d p)
        {
            var c = new Vec3d(
                Math.Max(Min.X, Math.Min(Max.X, p.X)),
                Math.Max(Min.Y, Math.Min(Max.Y, p.Y)),
                Math.Max(Min.Z, Math.Min(Max.Z, p.Z)));
            return Vec3d.Distance(c, p);
        }
    }

    /// <summary>
    /// The three.js Matrix4 / Matrix3 operations the wreck code uses, on
    /// column-major double[16] (Matrix4.elements) and double[9] (Matrix3.elements),
    /// written term for term as three.js does; plus V8's Math.exp and Array.prototype.sort.
    /// </summary>
    public static class WreckMath
    {
        public static double[] Identity() => new double[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };

        /// <summary>Matrix4.compose(position, quaternion, scale).</summary>
        public static double[] Compose(Vec3d position, Quatd q, Vec3d scale) => (double[])Mat4d.Compose(position, q, scale).E.Clone();

        /// <summary>Matrix4.makeRotationFromQuaternion: compose(0, q, 1).</summary>
        public static double[] RotationFromQuaternion(Quatd q) => Compose(Vec3d.Zero, q, new Vec3d(1, 1, 1));

        /// <summary>Matrix4.multiplyMatrices(a, b).</summary>
        public static double[] Multiply(double[] a, double[] b)
        {
            var ma = new Mat4d();
            var mb = new Mat4d();
            Array.Copy(a, ma.E, 16);
            Array.Copy(b, mb.E, 16);
            return Mat4d.Multiply(ma, mb).E;
        }

        public static double[] MakeScale(double x, double y, double z) => new double[] { x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1 };

        public static double[] MakeTranslation(double x, double y, double z) => new double[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 };

        /// <summary>Matrix4.makeRotationX.</summary>
        public static double[] MakeRotationX(double theta)
        {
            double c = JsTrig.Cos(theta), s = JsTrig.Sin(theta);
            return new double[] { 1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1 };
        }

        /// <summary>Matrix4.makeRotationY.</summary>
        public static double[] MakeRotationY(double theta)
        {
            double c = JsTrig.Cos(theta), s = JsTrig.Sin(theta);
            return new double[] { c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1 };
        }

        /// <summary>Vector3.applyMatrix4 (with the perspective divide three.js always does).</summary>
        public static Vec3d ApplyMatrix4(Vec3d v, double[] e)
        {
            double x = v.X, y = v.Y, z = v.Z;
            double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            return new Vec3d(
                (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
                (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
                (e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
        }

        /// <summary>Vector3.applyMatrix3.</summary>
        public static Vec3d ApplyMatrix3(Vec3d v, double[] e)
        {
            double x = v.X, y = v.Y, z = v.Z;
            return new Vec3d(e[0] * x + e[3] * y + e[6] * z, e[1] * x + e[4] * y + e[7] * z, e[2] * x + e[5] * y + e[8] * z);
        }

        /// <summary>Matrix3.getNormalMatrix(m4): setFromMatrix4(m4).invert().transpose().</summary>
        public static double[] NormalMatrix(double[] me)
        {
            // setFromMatrix4 (column-major storage of the upper 3x3).
            double n11 = me[0], n21 = me[1], n31 = me[2];
            double n12 = me[4], n22 = me[5], n32 = me[6];
            double n13 = me[8], n23 = me[9], n33 = me[10];
            double t11 = n33 * n22 - n32 * n23;
            double t12 = n32 * n13 - n33 * n12;
            double t13 = n23 * n12 - n22 * n13;
            double det = n11 * t11 + n21 * t12 + n31 * t13;
            var te = new double[9];
            if (det != 0)
            {
                double detInv = 1 / det;
                te[0] = t11 * detInv;
                te[1] = (n31 * n23 - n33 * n21) * detInv;
                te[2] = (n32 * n21 - n31 * n22) * detInv;
                te[3] = t12 * detInv;
                te[4] = (n33 * n11 - n31 * n13) * detInv;
                te[5] = (n31 * n12 - n32 * n11) * detInv;
                te[6] = t13 * detInv;
                te[7] = (n21 * n13 - n23 * n11) * detInv;
                te[8] = (n22 * n11 - n21 * n12) * detInv;
            }
            // transpose
            double tmp = te[1]; te[1] = te[3]; te[3] = tmp;
            tmp = te[2]; te[2] = te[6]; te[6] = tmp;
            tmp = te[5]; te[5] = te[7]; te[7] = tmp;
            return te;
        }

        /// <summary>Quaternion.setFromRotationMatrix on a Matrix4's upper 3x3.</summary>
        public static Quatd QuaternionFromMatrix(double[] te) =>
            Quatd.FromRotationMatrix(new Mat3d(te[0], te[4], te[8], te[1], te[5], te[9], te[2], te[6], te[10]));

        /// <summary>Quaternion.angleTo: 2 acos |dot| (clamped).</summary>
        public static double AngleTo(Quatd a, Quatd b) => 2 * JsTrig.Acos(Math.Abs(JsMath.Clamp(Quatd.Dot(a, b), -1, 1)));

        /// <summary>Component-wise product (Vector3.multiply).</summary>
        public static Vec3d Mul(Vec3d a, Vec3d b) => new Vec3d(a.X * b.X, a.Y * b.Y, a.Z * b.Z);

        /// <summary>Component-wise quotient (Vector3.divide).</summary>
        public static Vec3d Div(Vec3d a, Vec3d b) => new Vec3d(a.X / b.X, a.Y / b.Y, a.Z / b.Z);

        public static double Component(Vec3d v, int axis) => axis == 0 ? v.X : axis == 1 ? v.Y : v.Z;

        public static Vec3d Unit(int axis) => new Vec3d(axis == 0 ? 1 : 0, axis == 1 ? 1 : 0, axis == 2 ? 1 : 0);

        // --- Math.exp as V8 computes it (fdlibm e_exp.c, the FreeBSD form in V8's ieee754.cc) ---

        private const double Huge = 1.0e+300;
        private const double TwoM1000 = 9.33263618503218878990e-302;
        private const double OThreshold = 7.09782712893383973096e+02;
        private const double UThreshold = -7.45133219101941108420e+02;
        private const double Ln2Hi0 = 6.93147180369123816490e-01;
        private const double Ln2Lo0 = 1.90821492927058770002e-10;
        private const double InvLn2 = 1.44269504088896338700e+00;
        private const double P1 = 1.66666666666666019037e-01;
        private const double P2 = -2.77777777770155933842e-03;
        private const double P3 = 6.61375632143793436117e-05;
        private const double P4 = -1.65339022054652515390e-06;
        private const double P5 = 4.13813679705723846039e-08;
        private const double Two1023 = 8.988465674311579539e307;

        /// <summary>JS Math.exp, bit for bit as V8 (fdlibm).</summary>
        public static double Exp(double x)
        {
            long bits = BitConverter.DoubleToInt64Bits(x);
            uint hx = (uint)(bits >> 32);
            int xsb = (int)((hx >> 31) & 1);
            hx &= 0x7fffffff;
            double hi = 0, lo = 0;
            int k = 0;
            if (hx >= 0x40862E42)
            {
                if (hx >= 0x7ff00000)
                {
                    if (((hx & 0xfffff) | (uint)bits) != 0) return x + x;
                    return xsb == 0 ? x : 0.0;
                }
                if (x > OThreshold) return Huge * Huge;
                if (x < UThreshold) return TwoM1000 * TwoM1000;
            }
            if (hx > 0x3fd62e42)
            {
                if (hx < 0x3FF0A2B2)
                {
                    // V8 special-cases exp(1) to return E exactly (the reduction gets its last bit wrong).
                    if (x == 1.0) return Math.E;
                    hi = x - (xsb == 0 ? Ln2Hi0 : -Ln2Hi0);
                    lo = xsb == 0 ? Ln2Lo0 : -Ln2Lo0;
                    k = 1 - xsb - xsb;
                }
                else
                {
                    k = (int)(InvLn2 * x + (xsb == 0 ? 0.5 : -0.5));
                    double t0 = k;
                    hi = x - t0 * Ln2Hi0;
                    lo = t0 * Ln2Lo0;
                }
                x = hi - lo;
            }
            else if (hx < 0x3e300000)
            {
                if (Huge + x > 1.0) return 1.0 + x;
            }
            else
            {
                k = 0;
            }
            double t = x * x;
            double twopk = k >= -1021
                ? BitConverter.Int64BitsToDouble((long)(0x3ff00000 + (k << 20)) << 32)
                : BitConverter.Int64BitsToDouble((long)(0x3ff00000 + ((k + 1000) << 20)) << 32);
            double c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
            if (k == 0) return 1.0 - ((x * c) / (c - 2.0) - x);
            double y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
            if (k >= -1021)
            {
                if (k == 1024) return y * 2.0 * Two1023;
                return y * twopk;
            }
            return y * twopk * TwoM1000;
        }

        // --- Array.prototype.sort as V8 does it ----------------------------------------

        /// <summary>
        /// V8's Array.prototype.sort (TimSort): stable, and for fewer than 64
        /// items exactly V8's run detection plus binary insertion sort, so even a
        /// comparator that is not a consistent order (splitGearLegs' fuzzy one)
        /// sorts as it does in the game. Larger arrays (only ever sorted with
        /// consistent comparators here) use a stable index-tiebroken sort.
        /// </summary>
        public static void JsSort<T>(List<T> a, Func<T, T, double> compare)
        {
            int n = a.Count;
            if (n < 2) return;
            if (n >= 64)
            {
                var indexed = new List<(T Item, int Index)>(n);
                for (int i = 0; i < n; i++) indexed.Add((a[i], i));
                indexed.Sort((x, y) =>
                {
                    double c = compare(x.Item, y.Item);
                    if (c < 0) return -1;
                    if (c > 0) return 1;
                    return x.Index.CompareTo(y.Index);
                });
                for (int i = 0; i < n; i++) a[i] = indexed[i].Item;
                return;
            }
            // CountAndMakeRun(0, n)
            int runLength = 2;
            if (n > 1)
            {
                T elementLow = a[1];
                T elementLowPre = a[0];
                double order = Order(compare(elementLow, elementLowPre));
                bool isDescending = order < 0;
                T previous = elementLow;
                for (int idx = 2; idx < n; ++idx)
                {
                    T current = a[idx];
                    order = Order(compare(current, previous));
                    if (isDescending)
                    {
                        if (order >= 0) break;
                    }
                    else if (order < 0)
                    {
                        break;
                    }
                    previous = current;
                    ++runLength;
                }
                if (isDescending) a.Reverse(0, runLength);
            }
            // BinaryInsertionSort(0, runLength, n)
            for (int start = runLength; start < n; ++start)
            {
                int left = 0, right = start;
                T pivot = a[start];
                while (left < right)
                {
                    int mid = left + ((right - left) >> 1);
                    double order = Order(compare(pivot, a[mid]));
                    if (order < 0) right = mid;
                    else left = mid + 1;
                }
                for (int p = start; p > left; --p) a[p] = a[p - 1];
                a[left] = pivot;
            }
        }

        /// <summary>V8 treats a NaN comparison result as 0.</summary>
        private static double Order(double c) => double.IsNaN(c) ? 0 : c;
    }
}
