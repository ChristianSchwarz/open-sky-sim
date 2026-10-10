using System;

namespace Retro.Core
{
    /// <summary>
    /// Math.sin / cos / atan / atan2 / asin / acos exactly as V8 computes them:
    /// a port of the fdlibm routines in V8's src/base/ieee754.cc (V8 13.6, the
    /// engine in Node 24 that generated the golden fixtures).
    ///
    /// The .NET Math versions are accurate but not bit-identical — on random
    /// inputs about 18 % of atan2 results and 1–3 % of sin/cos/asin/acos results
    /// differ from V8's by an ulp. The AI pilots' closed loops normally wash
    /// that out, but near the FakeAircraft's quaternion singularity (heading
    /// through ±pi, where setFromUnitVectors(+Z, fwd) goes antipodal) a single
    /// ulp of attitude grows ~10x per frame and the shaw_turning_target trace
    /// diverges past tolerance. Matching V8 bit for bit removes the source.
    ///
    /// Original copyright: Copyright (C) 1993 by Sun Microsystems, Inc. All rights
    /// reserved. Developed at SunSoft, a Sun Microsystems, Inc. business.
    /// Permission to use, copy, modify, and distribute this software is freely
    /// granted, provided that this notice is preserved.
    /// </summary>
    public static class JsTrig
    {
        // --- word access (fdlibm's GET_HIGH_WORD etc.) -----------------------------

        private static int HighWord(double d) => (int)(BitConverter.DoubleToInt64Bits(d) >> 32);

        private static uint LowWord(double d) => (uint)BitConverter.DoubleToInt64Bits(d);

        private static double FromWords(int hi, uint lo) =>
            BitConverter.Int64BitsToDouble((long)(((ulong)(uint)hi << 32) | lo));

        private static double WithLowWord(double d, uint lo) => FromWords(HighWord(d), lo);

        private static double WithHighWord(double d, int hi) => FromWords(hi, LowWord(d));

        /// <summary>scalbn: x * 2^n (exact in the ranges argument reduction uses).</summary>
        private static double ScaleB(double x, int n)
        {
            while (n > 1023)
            {
                x *= BitConverter.Int64BitsToDouble(0x7FE0000000000000L); // 2^1023
                n -= 1023;
            }
            while (n < -1022)
            {
                x *= BitConverter.Int64BitsToDouble(0x0010000000000000L); // 2^-1022
                n += 1022;
            }
            return x * BitConverter.Int64BitsToDouble((long)(n + 1023) << 52);
        }

        // --- argument reduction -----------------------------------------------------

        private static readonly int[] TwoOverPi =
        {
            0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C,
            0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649,
            0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129, 0xA73EE8, 0x8235F5, 0x2EBB44,
            0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C, 0x845F8B,
            0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D,
            0x367ECF, 0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
            0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330,
            0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3, 0x91615E, 0xE61B08,
            0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
            0x73A8C9, 0x60E27B, 0xC08C6B,
        };

        private static readonly int[] Npio2Hw =
        {
            0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C,
            0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
            0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
            0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
            0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB,
            0x404858EB, 0x404921FB,
        };

        /// <summary>__ieee754_rem_pio2: x rem pi/2 in y0 + y1; returns n.</summary>
        private static int RemPio2(double x, out double y0, out double y1)
        {
            const double half = 5.00000000000000000000e-01;
            const double two24 = 1.67772160000000000000e+07;
            const double invpio2 = 6.36619772367581382433e-01;
            const double pio2_1 = 1.57079632673412561417e+00;
            const double pio2_1t = 6.07710050650619224932e-11;
            const double pio2_2 = 6.07710050630396597660e-11;
            const double pio2_2t = 2.02226624879595063154e-21;
            const double pio2_3 = 2.02226624871116645580e-21;
            const double pio2_3t = 8.47842766036889956997e-32;

            double z, w, t, r, fn;
            int e0, i, j, nx, n, ix, hx;

            hx = HighWord(x);
            ix = hx & 0x7FFFFFFF;
            if (ix <= 0x3FE921FB)
            {
                // |x| ~<= pi/4, no need for reduction
                y0 = x;
                y1 = 0;
                return 0;
            }
            if (ix < 0x4002D97C)
            {
                // |x| < 3pi/4, special case with n=+-1
                if (hx > 0)
                {
                    z = x - pio2_1;
                    if (ix != 0x3FF921FB)
                    {
                        // 33+53 bit pi is good enough
                        y0 = z - pio2_1t;
                        y1 = (z - y0) - pio2_1t;
                    }
                    else
                    {
                        // near pi/2, use 33+33+53 bit pi
                        z -= pio2_2;
                        y0 = z - pio2_2t;
                        y1 = (z - y0) - pio2_2t;
                    }
                    return 1;
                }
                else
                {
                    z = x + pio2_1;
                    if (ix != 0x3FF921FB)
                    {
                        y0 = z + pio2_1t;
                        y1 = (z - y0) + pio2_1t;
                    }
                    else
                    {
                        z += pio2_2;
                        y0 = z + pio2_2t;
                        y1 = (z - y0) + pio2_2t;
                    }
                    return -1;
                }
            }
            if (ix <= 0x413921FB)
            {
                // |x| ~<= 2^19*(pi/2), medium size
                t = Math.Abs(x);
                n = (int)(t * invpio2 + half);
                fn = n;
                r = t - fn * pio2_1;
                w = fn * pio2_1t; // 1st round good to 85 bit
                if (n < 32 && ix != Npio2Hw[n - 1])
                {
                    y0 = r - w; // quick check no cancellation
                }
                else
                {
                    j = ix >> 20;
                    y0 = r - w;
                    int high = HighWord(y0);
                    i = j - ((high >> 20) & 0x7FF);
                    if (i > 16)
                    {
                        // 2nd iteration needed, good to 118
                        t = r;
                        w = fn * pio2_2;
                        r = t - w;
                        w = fn * pio2_2t - ((t - r) - w);
                        y0 = r - w;
                        high = HighWord(y0);
                        i = j - ((high >> 20) & 0x7FF);
                        if (i > 49)
                        {
                            // 3rd iteration need, 151 bits acc
                            t = r;
                            w = fn * pio2_3;
                            r = t - w;
                            w = fn * pio2_3t - ((t - r) - w);
                            y0 = r - w;
                        }
                    }
                }
                y1 = (r - y0) - w;
                if (hx < 0)
                {
                    y0 = -y0;
                    y1 = -y1;
                    return -n;
                }
                return n;
            }
            // all other (large) arguments
            if (ix >= 0x7FF00000)
            {
                // x is inf or NaN
                y0 = y1 = x - x;
                return 0;
            }
            // set z = scalbn(|x|,ilogb(x)-23)
            z = WithLowWord(0, LowWord(x));
            e0 = (ix >> 20) - 1046; // e0 = ilogb(z)-23;
            z = WithHighWord(z, ix - (int)((uint)e0 << 20));
            var tx = new double[3];
            for (i = 0; i < 2; i++)
            {
                tx[i] = (int)z;
                z = (z - tx[i]) * two24;
            }
            tx[2] = z;
            nx = 3;
            while (tx[nx - 1] == 0) nx--; // skip zero term
            var y = new double[3];
            n = KernelRemPio2(tx, y, e0, nx, 2, TwoOverPi);
            if (hx < 0)
            {
                y0 = -y[0];
                y1 = -y[1];
                return -n;
            }
            y0 = y[0];
            y1 = y[1];
            return n;
        }

        private static readonly double[] PIo2 =
        {
            1.57079625129699707031e+00,
            7.54978941586159635335e-08,
            5.39030252995776476554e-15,
            3.28200341580791294123e-22,
            1.27065575308067607349e-29,
            1.22933308981111328932e-36,
            2.73370053816464559624e-44,
            2.16741683877804819444e-51,
        };

        /// <summary>__kernel_rem_pio2 (only reached for |x| &gt; 2^19*pi/2).</summary>
        private static int KernelRemPio2(double[] x, double[] y, int e0, int nx, int prec, int[] ipio2)
        {
            int[] initJk = { 2, 3, 4, 6 };
            const double two24 = 1.67772160000000000000e+07;
            const double twon24 = 5.96046447753906250000e-08;

            int jz, jx, jv, jp, jk, carry, n, i, j, k, m, q0, ih;
            var iq = new int[20];
            double z, fw;
            var f = new double[20];
            var fq = new double[20];
            var q = new double[20];

            jk = initJk[prec];
            jp = jk;

            jx = nx - 1;
            jv = (e0 - 3) / 24;
            if (jv < 0) jv = 0;
            q0 = e0 - 24 * (jv + 1);

            j = jv - jx;
            m = jx + jk;
            for (i = 0; i <= m; i++, j++)
            {
                f[i] = j < 0 ? 0.0 : ipio2[j];
            }

            for (i = 0; i <= jk; i++)
            {
                for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
                q[i] = fw;
            }

            jz = jk;
            while (true)
            {
                // distill q[] into iq[] reversingly
                for (i = 0, j = jz, z = q[jz]; j > 0; i++, j--)
                {
                    fw = (int)(twon24 * z);
                    iq[i] = (int)(z - two24 * fw);
                    z = q[j - 1] + fw;
                }

                // compute n
                z = ScaleB(z, q0);
                z -= 8.0 * Math.Floor(z * 0.125);
                n = (int)z;
                z -= n;
                ih = 0;
                if (q0 > 0)
                {
                    i = iq[jz - 1] >> (24 - q0);
                    n += i;
                    iq[jz - 1] -= i << (24 - q0);
                    ih = iq[jz - 1] >> (23 - q0);
                }
                else if (q0 == 0)
                {
                    ih = iq[jz - 1] >> 23;
                }
                else if (z >= 0.5)
                {
                    ih = 2;
                }

                if (ih > 0)
                {
                    n += 1;
                    carry = 0;
                    for (i = 0; i < jz; i++)
                    {
                        j = iq[i];
                        if (carry == 0)
                        {
                            if (j != 0)
                            {
                                carry = 1;
                                iq[i] = 0x1000000 - j;
                            }
                        }
                        else
                        {
                            iq[i] = 0xFFFFFF - j;
                        }
                    }
                    if (q0 > 0)
                    {
                        switch (q0)
                        {
                            case 1: iq[jz - 1] &= 0x7FFFFF; break;
                            case 2: iq[jz - 1] &= 0x3FFFFF; break;
                        }
                    }
                    if (ih == 2)
                    {
                        z = 1.0 - z;
                        if (carry != 0) z -= ScaleB(1.0, q0);
                    }
                }

                // check if recomputation is needed
                if (z == 0)
                {
                    j = 0;
                    for (i = jz - 1; i >= jk; i--) j |= iq[i];
                    if (j == 0)
                    {
                        for (k = 1; jk >= k && iq[jk - k] == 0; k++)
                        {
                            // k = no. of terms needed
                        }
                        for (i = jz + 1; i <= jz + k; i++)
                        {
                            f[jx + i] = ipio2[jv + i];
                            for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
                            q[i] = fw;
                        }
                        jz += k;
                        continue;
                    }
                }
                break;
            }

            // chop off zero terms
            if (z == 0.0)
            {
                jz -= 1;
                q0 -= 24;
                while (iq[jz] == 0)
                {
                    jz--;
                    q0 -= 24;
                }
            }
            else
            {
                // break z into 24-bit if necessary
                z = ScaleB(z, -q0);
                if (z >= two24)
                {
                    fw = (int)(twon24 * z);
                    iq[jz] = (int)(z - two24 * fw);
                    jz += 1;
                    q0 += 24;
                    iq[jz] = (int)fw;
                }
                else
                {
                    iq[jz] = (int)z;
                }
            }

            // convert integer "bit" chunk to floating-point value
            fw = ScaleB(1.0, q0);
            for (i = jz; i >= 0; i--)
            {
                q[i] = fw * iq[i];
                fw *= twon24;
            }

            // compute PIo2[0,...,jp]*q[jz,...,0]
            for (i = jz; i >= 0; i--)
            {
                for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIo2[k] * q[i + k];
                fq[jz - i] = fw;
            }

            // compress fq[] into y[] (prec 2)
            fw = 0.0;
            for (i = jz; i >= 0; i--) fw += fq[i];
            y[0] = ih == 0 ? fw : -fw;
            fw = fq[0] - fw;
            for (i = 1; i <= jz; i++) fw += fq[i];
            y[1] = ih == 0 ? fw : -fw;
            return n & 7;
        }

        // --- kernels on [-pi/4, pi/4] ---------------------------------------------------

        private static double KernelCos(double x, double y)
        {
            const double one = 1.00000000000000000000e+00;
            const double C1 = 4.16666666666666019037e-02;
            const double C2 = -1.38888888888741095749e-03;
            const double C3 = 2.48015872894767294178e-05;
            const double C4 = -2.75573143513906633035e-07;
            const double C5 = 2.08757232129817482790e-09;
            const double C6 = -1.13596475577881948265e-11;

            double a, iz, z, r, qx;
            int ix = HighWord(x) & 0x7FFFFFFF;
            if (ix < 0x3E400000)
            {
                // if x < 2**27
                if ((int)x == 0) return one;
            }
            z = x * x;
            r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
            if (ix < 0x3FD33333)
            {
                // if |x| < 0.3
                return one - (0.5 * z - (z * r - x * y));
            }
            if (ix > 0x3FE90000)
            {
                // x > 0.78125
                qx = 0.28125;
            }
            else
            {
                qx = FromWords(ix - 0x00200000, 0); // x/4
            }
            iz = 0.5 * z - qx;
            a = one - qx;
            return a - (iz - (z * r - x * y));
        }

        private static double KernelSin(double x, double y, int iy)
        {
            const double half = 5.00000000000000000000e-01;
            const double S1 = -1.66666666666666324348e-01;
            const double S2 = 8.33333333332248946124e-03;
            const double S3 = -1.98412698298579493134e-04;
            const double S4 = 2.75573137070700676789e-06;
            const double S5 = -2.50507602534068634195e-08;
            const double S6 = 1.58969099521155010221e-10;

            double z, r, v;
            int ix = HighWord(x) & 0x7FFFFFFF;
            if (ix < 0x3E400000)
            {
                // |x| < 2**-27
                if ((int)x == 0) return x;
            }
            z = x * x;
            v = z * x;
            r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
            if (iy == 0)
            {
                return x + v * (S1 + z * r);
            }
            return x - ((z * (half * y - v * r) - y) - v * S1);
        }

        // --- public functions --------------------------------------------------------

        public static double Sin(double x)
        {
            int ix = HighWord(x) & 0x7FFFFFFF;
            if (ix <= 0x3FE921FB)
            {
                return KernelSin(x, 0.0, 0);
            }
            if (ix >= 0x7FF00000)
            {
                return x - x;
            }
            int n = RemPio2(x, out double y0, out double y1);
            switch (n & 3)
            {
                case 0: return KernelSin(y0, y1, 1);
                case 1: return KernelCos(y0, y1);
                case 2: return -KernelSin(y0, y1, 1);
                default: return -KernelCos(y0, y1);
            }
        }

        public static double Cos(double x)
        {
            int ix = HighWord(x) & 0x7FFFFFFF;
            if (ix <= 0x3FE921FB)
            {
                return KernelCos(x, 0.0);
            }
            if (ix >= 0x7FF00000)
            {
                return x - x;
            }
            int n = RemPio2(x, out double y0, out double y1);
            switch (n & 3)
            {
                case 0: return KernelCos(y0, y1);
                case 1: return -KernelSin(y0, y1, 1);
                case 2: return -KernelCos(y0, y1);
                default: return KernelSin(y0, y1, 1);
            }
        }

        private const double pS0 = 1.66666666666666657415e-01;
        private const double pS1 = -3.25565818622400915405e-01;
        private const double pS2 = 2.01212532134862925881e-01;
        private const double pS3 = -4.00555345006794114027e-02;
        private const double pS4 = 7.91534994289814532176e-04;
        private const double pS5 = 3.47933107596021167570e-05;
        private const double qS1 = -2.40339491173441421878e+00;
        private const double qS2 = 2.02094576023350569471e+00;
        private const double qS3 = -6.88283971605453293030e-01;
        private const double qS4 = 7.70381505559019352791e-02;
        private const double pio2_hi = 1.57079632679489655800e+00;
        private const double pio2_lo = 6.12323399573676603587e-17;

        public static double Acos(double x)
        {
            const double one = 1.0;
            const double pi = 3.14159265358979311600e+00;

            double z, p, q, r, w, s, c, df;
            int hx = HighWord(x);
            int ix = hx & 0x7FFFFFFF;
            if (ix >= 0x3FF00000)
            {
                // |x| >= 1
                uint lx = LowWord(x);
                if (((ix - 0x3FF00000) | (int)lx) == 0)
                {
                    // |x|==1
                    if (hx > 0) return 0.0; // acos(1) = 0
                    return pi + 2.0 * pio2_lo; // acos(-1)= pi
                }
                return double.NaN; // acos(|x|>1) is NaN
            }
            if (ix < 0x3FE00000)
            {
                // |x| < 0.5
                if (ix <= 0x3C600000) return pio2_hi + pio2_lo; // if|x|<2**-57
                z = x * x;
                p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
                q = one + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
                r = p / q;
                return pio2_hi - (x - (pio2_lo - x * r));
            }
            if (hx < 0)
            {
                // x < -0.5
                z = (one + x) * 0.5;
                p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
                q = one + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
                s = Math.Sqrt(z);
                r = p / q;
                w = r * s - pio2_lo;
                return pi - 2.0 * (s + w);
            }
            // x > 0.5
            z = (one - x) * 0.5;
            s = Math.Sqrt(z);
            df = WithLowWord(s, 0);
            c = (z - df * df) / (s + df);
            p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
            q = one + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
            r = p / q;
            w = r * s + c;
            return 2.0 * (df + w);
        }

        public static double Asin(double x)
        {
            const double one = 1.0;
            const double huge = 1.000e+300;
            const double pio4_hi = 7.85398163397448278999e-01;

            double t, w, p, q, c, r, s;
            t = 0;
            int hx = HighWord(x);
            int ix = hx & 0x7FFFFFFF;
            if (ix >= 0x3FF00000)
            {
                // |x|>= 1
                uint lx = LowWord(x);
                if (((ix - 0x3FF00000) | (int)lx) == 0)
                {
                    // asin(1)=+-pi/2 with inexact
                    return x * pio2_hi + x * pio2_lo;
                }
                return double.NaN; // asin(|x|>1) is NaN
            }
            if (ix < 0x3FE00000)
            {
                // |x|<0.5
                if (ix < 0x3E400000)
                {
                    // if |x| < 2**-27
                    if (huge + x > one) return x; // return x with inexact if x!=0
                }
                else
                {
                    t = x * x;
                }
                p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
                q = one + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
                w = p / q;
                return x + x * w;
            }
            // 1> |x|>= 0.5
            w = one - Math.Abs(x);
            t = w * 0.5;
            p = t * (pS0 + t * (pS1 + t * (pS2 + t * (pS3 + t * (pS4 + t * pS5)))));
            q = one + t * (qS1 + t * (qS2 + t * (qS3 + t * qS4)));
            s = Math.Sqrt(t);
            if (ix >= 0x3FEF3333)
            {
                // if |x| > 0.975
                w = p / q;
                t = pio2_hi - (2.0 * (s + s * w) - pio2_lo);
            }
            else
            {
                w = WithLowWord(s, 0);
                c = (t - w * w) / (s + w);
                r = p / q;
                p = 2.0 * s * r - (pio2_lo - 2.0 * c);
                q = pio4_hi - 2.0 * w;
                t = pio4_hi - (p - q);
            }
            return hx > 0 ? t : -t;
        }

        private static readonly double[] AtanHi =
        {
            4.63647609000806093515e-01,
            7.85398163397448278999e-01,
            9.82793723247329054082e-01,
            1.57079632679489655800e+00,
        };

        private static readonly double[] AtanLo =
        {
            2.26987774529616870924e-17,
            3.06161699786838301793e-17,
            1.39033110312309984516e-17,
            6.12323399573676603587e-17,
        };

        private static readonly double[] AT =
        {
            3.33333333333329318027e-01,
            -1.99999999998764832476e-01,
            1.42857142725034663711e-01,
            -1.11111104054623557880e-01,
            9.09088713343650656196e-02,
            -7.69187620504482999495e-02,
            6.66107313738753120669e-02,
            -5.83357013379057348645e-02,
            4.97687799461593236017e-02,
            -3.65315727442169155270e-02,
            1.62858201153657823623e-02,
        };

        public static double Atan(double x)
        {
            const double one = 1.0, huge = 1.0e300;
            double w, s1, s2, z;
            int ix, hx, id;

            hx = HighWord(x);
            ix = hx & 0x7FFFFFFF;
            if (ix >= 0x44100000)
            {
                // if |x| >= 2^66
                uint low = LowWord(x);
                if (ix > 0x7FF00000 || (ix == 0x7FF00000 && low != 0))
                {
                    return x + x; // NaN
                }
                if (hx > 0) return AtanHi[3] + AtanLo[3];
                return -AtanHi[3] - AtanLo[3];
            }
            if (ix < 0x3FDC0000)
            {
                // |x| < 0.4375
                if (ix < 0x3E400000)
                {
                    // |x| < 2^-27
                    if (huge + x > one) return x; // raise inexact
                }
                id = -1;
            }
            else
            {
                x = Math.Abs(x);
                if (ix < 0x3FF30000)
                {
                    // |x| < 1.1875
                    if (ix < 0x3FE60000)
                    {
                        // 7/16 <=|x|<11/16
                        id = 0;
                        x = (2.0 * x - one) / (2.0 + x);
                    }
                    else
                    {
                        // 11/16<=|x|< 19/16
                        id = 1;
                        x = (x - one) / (x + one);
                    }
                }
                else
                {
                    if (ix < 0x40038000)
                    {
                        // |x| < 2.4375
                        id = 2;
                        x = (x - 1.5) / (one + 1.5 * x);
                    }
                    else
                    {
                        // 2.4375 <= |x| < 2^66
                        id = 3;
                        x = -1.0 / x;
                    }
                }
            }
            // end of argument reduction
            z = x * x;
            w = z * z;
            // break sum from i=0 to 10 aT[i]z**(i+1) into odd and even poly
            s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
            s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
            if (id < 0)
            {
                return x - x * (s1 + s2);
            }
            z = AtanHi[id] - ((x * (s1 + s2) - AtanLo[id]) - x);
            return hx < 0 ? -z : z;
        }

        public static double Atan2(double y, double x)
        {
            const double tiny = 1.0e-300;
            const double pi_o_4 = 7.8539816339744827900E-01;
            const double pi_o_2 = 1.5707963267948965580E+00;
            const double pi = 3.1415926535897931160E+00;
            const double pi_lo = 1.2246467991473531772E-16;

            double z;
            int k, m, hx, hy, ix, iy;
            uint lx, ly;

            hx = HighWord(x);
            lx = LowWord(x);
            ix = hx & 0x7FFFFFFF;
            hy = HighWord(y);
            ly = LowWord(y);
            iy = hy & 0x7FFFFFFF;
            if ((ix | (int)((lx | unchecked((uint)-(int)lx)) >> 31)) > 0x7FF00000
                || (iy | (int)((ly | unchecked((uint)-(int)ly)) >> 31)) > 0x7FF00000)
            {
                return x + y; // x or y is NaN
            }
            if ((unchecked(hx - 0x3FF00000) | (int)lx) == 0)
            {
                return Atan(y); // x=1.0
            }
            m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2*sign(x)+sign(y)

            // when y = 0
            if ((iy | (int)ly) == 0)
            {
                switch (m)
                {
                    case 0:
                    case 1:
                        return y; // atan(+-0,+anything)=+-0
                    case 2:
                        return pi + tiny; // atan(+0,-anything) = pi
                    case 3:
                        return -pi - tiny; // atan(-0,-anything) =-pi
                }
            }
            // when x = 0
            if ((ix | (int)lx) == 0) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;

            // when x is INF
            if (ix == 0x7FF00000)
            {
                if (iy == 0x7FF00000)
                {
                    switch (m)
                    {
                        case 0: return pi_o_4 + tiny;
                        case 1: return -pi_o_4 - tiny;
                        case 2: return 3.0 * pi_o_4 + tiny;
                        case 3: return -3.0 * pi_o_4 - tiny;
                    }
                }
                else
                {
                    switch (m)
                    {
                        case 0: return 0.0;
                        case 1: return -0.0;
                        case 2: return pi + tiny;
                        case 3: return -pi - tiny;
                    }
                }
            }
            // when y is INF
            if (iy == 0x7FF00000) return hy < 0 ? -pi_o_2 - tiny : pi_o_2 + tiny;

            // compute y/x
            k = (iy - ix) >> 20;
            if (k > 60)
            {
                // |y/x| >  2**60
                z = pi_o_2 + 0.5 * pi_lo;
                m &= 1;
            }
            else if (hx < 0 && k < -60)
            {
                z = 0.0; // 0 > |y|/x > -2**-60
            }
            else
            {
                z = Atan(Math.Abs(y / x)); // safe to do y/x
            }
            switch (m)
            {
                case 0: return z; // atan(+,+)
                case 1: return -z; // atan(-,+)
                case 2: return pi - (z - pi_lo); // atan(+,-)
                default: return (z - pi_lo) - pi; // atan(-,-)
            }
        }
    }
}
