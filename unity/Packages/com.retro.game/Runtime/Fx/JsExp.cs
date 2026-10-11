using System;

namespace Retro.Game
{
    /// <summary>
    /// Math.exp exactly as V8 computes it: the fdlibm __ieee754_exp in V8's
    /// src/base/ieee754.cc. .NET Math.Exp is accurate but can differ from it by
    /// an ulp, and a particle drag factor that is off by an ulp walks every
    /// debris chip off the oracle's track. (Used by <see cref="LinearDragParticleForce"/>.)
    ///
    /// Original copyright: Copyright (C) 2004 by Sun Microsystems, Inc. All rights
    /// reserved. Permission to use, copy, modify, and distribute this software is
    /// freely granted, provided that this notice is preserved.
    /// </summary>
    public static class JsExp
    {
        private static double D(ulong bits) => BitConverter.Int64BitsToDouble((long)bits);

        private static readonly double Huge = 1.0e+300;
        private static readonly double TwoM1000 = D(0x0170000000000000UL);
        private static readonly double OThreshold = D(0x40862E42FEFA39EFUL);
        private static readonly double UThreshold = D(0xC0874910D52D3051UL);
        private static readonly double Ln2Hi = D(0x3FE62E42FEE00000UL);
        private static readonly double Ln2Lo = D(0x3DEA39EF35793C76UL);
        private static readonly double InvLn2 = D(0x3FF71547652B82FEUL);
        private static readonly double P1 = D(0x3FC555555555553EUL);
        private static readonly double P2 = D(0xBF66C16C16BEBD93UL);
        private static readonly double P3 = D(0x3F11566AAF25DE2CUL);
        private static readonly double P4 = D(0xBEBBBD41C5D26BF1UL);
        private static readonly double P5 = D(0x3E66376972BEA4D0UL);
        private static readonly double TwoP1023 = D(0x7FE0000000000000UL);

        public static double Exp(double x)
        {
            double hi = 0, lo = 0;
            int k = 0;
            long bits = BitConverter.DoubleToInt64Bits(x);
            uint hx = (uint)(bits >> 32);
            int xsb = (int)((hx >> 31) & 1);
            hx &= 0x7fffffff;

            // Non-finite and out-of-range arguments.
            if (hx >= 0x40862E42)
            {
                if (hx >= 0x7ff00000)
                {
                    uint lx = (uint)bits;
                    if (((hx & 0xfffff) | lx) != 0) return x + x;
                    return xsb == 0 ? x : 0.0;
                }
                if (x > OThreshold) return double.PositiveInfinity;
                if (x < UThreshold) return 0.0;
            }

            // Argument reduction.
            if (hx > 0x3fd62e42)
            {
                if (hx < 0x3FF0A2B2)
                {
                    // V8 special-cases exp(1) to return E (the reduction below gets its last bit wrong).
                    if (x == 1.0) return Math.E;
                    hi = xsb == 0 ? x - Ln2Hi : x + Ln2Hi;
                    lo = xsb == 0 ? Ln2Lo : -Ln2Lo;
                    k = 1 - xsb - xsb;
                }
                else
                {
                    k = (int)(InvLn2 * x + (xsb == 0 ? 0.5 : -0.5));
                    double t0 = k;
                    hi = x - t0 * Ln2Hi;
                    lo = t0 * Ln2Lo;
                }
                x = hi - lo;
            }
            else if (hx < 0x3e300000)
            {
                if (Huge + x > 1) return 1 + x;
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
            if (k == 0) return 1 - ((x * c) / (c - 2.0) - x);
            double y = 1 - ((lo - (x * c) / (2.0 - c)) - hi);
            if (k >= -1021)
            {
                if (k == 1024) return y * 2.0 * TwoP1023;
                return y * twopk;
            }
            return y * twopk * TwoM1000;
        }
    }
}
