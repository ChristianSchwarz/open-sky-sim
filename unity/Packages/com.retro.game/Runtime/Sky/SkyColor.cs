using System;
using System.Collections.Generic;
using System.Globalization;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The colour helpers daytimePalette.ts and skyDomeModelBuilder.ts define
    /// locally: "#rrggbb" parsing, the sRGB transfer function in both
    /// directions (0..255 bytes against 0..1 linear) and Rec. 709 luma.
    /// Math.pow goes through .NET (no V8-exact port).
    /// </summary>
    public static class SkyColor
    {
        private static readonly object Gate = new object();
        private static readonly Dictionary<string, double[]> LinearCache = new Dictionary<string, double[]>();

        /// <summary>parseHex: "#rrggbb" to 0..255 channels (parseInt of the hex digits).</summary>
        public static double[] ParseHex(string css)
        {
            int n = int.Parse(css.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            return new double[] { (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff };
        }

        private static double ToLinearChannel(double v)
        {
            double s = v / 255;
            return s <= 0.04045 ? s / 12.92 : Math.Pow((s + 0.055) / 1.055, 2.4);
        }

        /// <summary>toLinear: sRGB 0..255 to linear 0..1.</summary>
        public static double[] ToLinear(double[] rgb) =>
            new[] { ToLinearChannel(rgb[0]), ToLinearChannel(rgb[1]), ToLinearChannel(rgb[2]) };

        private static double ToSrgbChannel(double v)
        {
            double c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.Pow(v, 1 / 2.4) - 0.055;
            return c * 255;
        }

        /// <summary>toSrgb: linear 0..1 to sRGB 0..255 (unrounded, unclamped).</summary>
        public static double[] ToSrgb(double[] rgb) =>
            new[] { ToSrgbChannel(rgb[0]), ToSrgbChannel(rgb[1]), ToSrgbChannel(rgb[2]) };

        /// <summary>toHex: clamp to 0..255, JS Math.round, lower-case "#rrggbb".</summary>
        public static string ToHex(double[] rgb)
        {
            int Clamp(double v) => (int)Math.Max(0, Math.Min(255, JsMath.Round(v)));
            int n = (Clamp(rgb[0]) << 16) | (Clamp(rgb[1]) << 8) | Clamp(rgb[2]);
            return "#" + n.ToString("x6", CultureInfo.InvariantCulture);
        }

        /// <summary>linearOf: "#rrggbb" straight to linear 0..1 (cached).</summary>
        public static double[] LinearOf(string css)
        {
            lock (Gate)
            {
                if (LinearCache.TryGetValue(css, out double[] hit)) return hit;
            }
            double[] rgb = ToLinear(ParseHex(css));
            lock (Gate)
            {
                LinearCache[css] = rgb;
            }
            return rgb;
        }

        /// <summary>Rec. 709 relative luminance of a linear colour.</summary>
        public static double Luma(double[] rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }
}
