using System;

namespace Retro.Core
{
    /// <summary>
    /// The handful of JavaScript Math functions whose C# namesakes behave
    /// differently. The TypeScript game is the reference implementation, so
    /// ported code calls these wherever the original called Math.round,
    /// Math.sign or Math.hypot.
    /// </summary>
    public static class JsMath
    {
        /// <summary>
        /// JS Math.round: halves round toward +Infinity (-2.5 -> -2, 2.5 -> 3).
        /// C# Math.Round rounds halves to even, and MidpointRounding.AwayFromZero
        /// is wrong for negative halves, so neither can stand in.
        /// </summary>
        public static double Round(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x))
            {
                return x;
            }
            double r = Math.Floor(x);
            return x - r >= 0.5 ? r + 1 : r;
        }

        /// <summary>JS Math.sign: NaN stays NaN, zero keeps its sign.</summary>
        public static double Sign(double x)
        {
            if (double.IsNaN(x)) return double.NaN;
            if (x > 0) return 1;
            if (x < 0) return -1;
            return x;
        }

        /// <summary>
        /// JS Math.hypot as V8 computes it: scale by the largest magnitude and
        /// sum with Kahan compensation. Matching the algorithm keeps the last
        /// bit equal more often than a plain sqrt(x*x + y*y) would.
        /// </summary>
        public static double Hypot(double a, double b)
        {
            return Hypot3(a, b, 0, 2);
        }

        public static double Hypot(double a, double b, double c)
        {
            return Hypot3(a, b, c, 3);
        }

        private static double Hypot3(double a, double b, double c, int n)
        {
            a = Math.Abs(a);
            b = Math.Abs(b);
            c = Math.Abs(c);
            if (double.IsInfinity(a) || double.IsInfinity(b) || double.IsInfinity(c)) return double.PositiveInfinity;
            if (double.IsNaN(a) || double.IsNaN(b) || double.IsNaN(c)) return double.NaN;
            double max = Math.Max(a, Math.Max(b, c));
            if (max == 0) return 0;
            double sum = 0, compensation = 0;
            for (int i = 0; i < n; i++)
            {
                double v = i == 0 ? a : i == 1 ? b : c;
                double r = v / max;
                double summand = r * r - compensation;
                double preliminary = sum + summand;
                compensation = (preliminary - sum) - summand;
                sum = preliminary;
            }
            return Math.Sqrt(sum) * max;
        }

        /// <summary>The utils/math.ts clamp: max(min, min(n, max)).</summary>
        public static double Clamp(double n, double min, double max)
        {
            return Math.Max(min, Math.Min(n, max));
        }
    }
}
