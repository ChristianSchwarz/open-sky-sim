using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>One bar of a stencil glyph, in a unit box with the origin at the bottom-left, y up (glyphs.ts).</summary>
    public readonly struct GlyphBar
    {
        public readonly double X;
        public readonly double Y;
        public readonly double W;
        public readonly double H;

        public GlyphBar(double x, double y, double w, double h)
        {
            X = x;
            Y = y;
            W = w;
            H = h;
        }
    }

    /// <summary>The stencil alphabet painted on a runway threshold (port of glyphs.ts).</summary>
    public static class Glyphs
    {
        /// <summary>Bar thickness as a fraction of the glyph box.</summary>
        public const double GlyphStroke = 0.24;

        private const double T = GlyphStroke;
        private static readonly GlyphBar Mid = new GlyphBar(0, 0.5 - T / 2, 1, T);
        private static readonly GlyphBar Top = new GlyphBar(0, 1 - T, 1, T);
        private static readonly GlyphBar Bottom = new GlyphBar(0, 0, 1, T);
        private static readonly GlyphBar Left = new GlyphBar(0, 0, T, 1);
        private static readonly GlyphBar Right = new GlyphBar(1 - T, 0, T, 1);
        private static readonly GlyphBar LeftTop = new GlyphBar(0, 0.5 - T / 2, T, 0.5 + T / 2);
        private static readonly GlyphBar LeftBottom = new GlyphBar(0, 0, T, 0.5 + T / 2);
        private static readonly GlyphBar RightTop = new GlyphBar(1 - T, 0.5 - T / 2, T, 0.5 + T / 2);
        private static readonly GlyphBar RightBottom = new GlyphBar(1 - T, 0, T, 0.5 + T / 2);

        private static readonly Dictionary<char, GlyphBar[]> Table = new Dictionary<char, GlyphBar[]>
        {
            ['0'] = new[] { Top, Bottom, Left, Right },
            ['1'] = new[] { new GlyphBar(0.5 - T / 2, 0, T, 1) },
            ['2'] = new[] { Top, RightTop, Mid, LeftBottom, Bottom },
            ['3'] = new[] { Top, Mid, Bottom, Right },
            ['4'] = new[] { LeftTop, Mid, Right },
            ['5'] = new[] { Top, LeftTop, Mid, RightBottom, Bottom },
            ['6'] = new[] { Top, Left, Mid, RightBottom, Bottom },
            ['7'] = new[] { Top, Right },
            ['8'] = new[] { Top, Mid, Bottom, Left, Right },
            ['9'] = new[] { Top, LeftTop, Mid, Right, Bottom },
            ['L'] = new[] { Left, Bottom },
            ['C'] = new[] { Top, Left, Bottom },
            ['R'] = new[] { Top, Left, Mid, RightTop, new GlyphBar(1 - T, 0, T, 0.5 - T / 2) },
        };

        /// <summary>Bars of one character, or none for anything unpainted.</summary>
        public static GlyphBar[] GlyphBars(char ch) =>
            Table.TryGetValue(char.ToUpperInvariant(ch), out GlyphBar[] bars) ? bars : Array.Empty<GlyphBar>();

        public static bool IsPaintable(char ch) => GlyphBars(ch).Length > 0;
    }

    public enum MarkingKind
    {
        Pavement,
        Threshold,
        Designator,
        Aiming,
        Centreline,
        Edge,
    }

    /// <summary>An axis-aligned rectangle in runway-local metres (u along, v across to the right of the low end).</summary>
    public readonly struct MarkingRect
    {
        public readonly double U;
        public readonly double V;
        public readonly double LengthM;
        public readonly double WidthM;
        public readonly MarkingKind Kind;

        public MarkingRect(double u, double v, double lengthM, double widthM, MarkingKind kind)
        {
            U = u;
            V = v;
            LengthM = lengthM;
            WidthM = widthM;
            Kind = kind;
        }
    }

    /// <summary>What is painted on a runway, laid out in runway-local metres (port of runwayMarkings.ts).</summary>
    public static class RunwayMarkings
    {
        private const double ThresholdBarLengthM = 30;
        private const double ThresholdBarWidthM = 1.8;
        private const double ThresholdBarGapM = 1.8;
        private const double ThresholdInsetM = 6;

        private const double CentrelineStripeM = 30;
        private const double CentrelineGapM = 20;
        private const double CentrelineWidthM = 0.9;

        private const double AimingLengthM = 45;
        private const double AimingWidthM = 6;
        private const double AimingStartM = 300;
        private const double AimingOffsetM = 11;
        private const double AimingMinRunwayM = 1200;
        private const double EdgeClearanceM = 1.5;

        private const double EdgeWidthM = 0.9;
        private const double EdgeMinRunwayWidthM = 23;

        private const double GlyphHeightM = 20;
        private const double GlyphWidthM = 6;
        private const double GlyphSpacingM = 2;
        private const double DesignatorGapM = 12;

        /// <summary>Threshold bars by runway width (Annex 14's table).</summary>
        public static int ThresholdBarCount(double widthM)
        {
            if (widthM >= 45) return 12;
            if (widthM >= 30) return 8;
            if (widthM >= 23) return 6;
            return 4;
        }

        /// <summary>True where the surface is paved, the only kind that gets painted.</summary>
        public static bool IsPaintedSurface(RunwaySurface surface) =>
            surface == RunwaySurface.Asphalt || surface == RunwaySurface.Concrete;

        /// <summary>The two designators of a ref, low end first.</summary>
        public static (string Low, string High) DesignatorsOf(string reference)
        {
            string[] parts = (reference ?? "").Split('/');
            string Part(int i) => i < parts.Length ? parts[i].Trim().ToUpperInvariant() : "";
            return (Part(0), Part(1));
        }

        private static List<MarkingRect> EndMarkings(double lengthM, double widthM, string designator, double sign)
        {
            var output = new List<MarkingRect>();
            double threshold = -sign * lengthM / 2;
            double At(double distance) => threshold + sign * distance;

            int bars = ThresholdBarCount(widthM);
            double pitch = ThresholdBarWidthM + ThresholdBarGapM;
            double spread = bars * pitch - ThresholdBarGapM;
            for (int i = 0; i < bars; i++)
            {
                output.Add(new MarkingRect(
                    At(ThresholdInsetM + ThresholdBarLengthM / 2),
                    -spread / 2 + pitch * i + ThresholdBarWidthM / 2,
                    ThresholdBarLengthM, ThresholdBarWidthM, MarkingKind.Threshold));
            }

            double barsEnd = ThresholdInsetM + ThresholdBarLengthM + DesignatorGapM;
            output.AddRange(DesignatorRects(designator, At(barsEnd), sign));

            double aimingOffset = Math.Min(AimingOffsetM, widthM / 2 - EdgeClearanceM - AimingWidthM);
            if (lengthM >= AimingMinRunwayM && aimingOffset > AimingWidthM / 2)
            {
                foreach (int side in new[] { -1, 1 })
                {
                    output.Add(new MarkingRect(
                        At(AimingStartM + AimingLengthM / 2),
                        side * (aimingOffset + AimingWidthM / 2),
                        AimingLengthM, AimingWidthM, MarkingKind.Aiming));
                }
            }
            return output;
        }

        /// <summary>The painted numerals: `baseU` is the bottom of the characters, `sign` which way is up.</summary>
        public static List<MarkingRect> DesignatorRects(string designator, double baseU, double sign)
        {
            var chars = new List<char>();
            foreach (char c in designator ?? "")
            {
                if (Glyphs.GlyphBars(c).Length > 0) chars.Add(c);
            }
            var output = new List<MarkingRect>();
            if (chars.Count == 0) return output;
            double pitch = GlyphWidthM + GlyphSpacingM;
            double totalWidth = chars.Count * pitch - GlyphSpacingM;
            for (int i = 0; i < chars.Count; i++)
            {
                double left = -sign * (totalWidth / 2) + sign * i * pitch;
                foreach (GlyphBar bar in Glyphs.GlyphBars(chars[i]))
                {
                    output.Add(new MarkingRect(
                        baseU + sign * (bar.Y + bar.H / 2) * GlyphHeightM,
                        left + sign * (bar.X + bar.W / 2) * GlyphWidthM,
                        bar.H * GlyphHeightM, bar.W * GlyphWidthM, MarkingKind.Designator));
                }
            }
            return output;
        }

        /// <summary>Everything painted on one runway, pavement first.</summary>
        public static List<MarkingRect> For(double lengthM, double widthM, string reference, RunwaySurface surface)
        {
            var output = new List<MarkingRect> { new MarkingRect(0, 0, lengthM, widthM, MarkingKind.Pavement) };
            if (!IsPaintedSurface(surface)) return output;

            var (low, high) = DesignatorsOf(reference);
            output.AddRange(EndMarkings(lengthM, widthM, low, 1));
            output.AddRange(EndMarkings(lengthM, widthM, high, -1));

            double clear = lengthM / 2 - (ThresholdInsetM + ThresholdBarLengthM + DesignatorGapM + GlyphHeightM);
            double pitch = CentrelineStripeM + CentrelineGapM;
            double stripes = Math.Floor((2 * clear + CentrelineGapM) / pitch);
            for (int i = 0; i < stripes; i++)
            {
                double span = stripes * pitch - CentrelineGapM;
                output.Add(new MarkingRect(
                    -span / 2 + i * pitch + CentrelineStripeM / 2, 0,
                    CentrelineStripeM, CentrelineWidthM, MarkingKind.Centreline));
            }

            if (widthM >= EdgeMinRunwayWidthM)
            {
                foreach (int side in new[] { -1, 1 })
                {
                    output.Add(new MarkingRect(0, side * (widthM / 2 - EdgeWidthM / 2), lengthM, EdgeWidthM, MarkingKind.Edge));
                }
            }
            return output;
        }
    }

    /// <summary>A runway's paint as a two-channel coverage mask (runwayMarkingTexture.ts).</summary>
    public sealed class MarkingTexture
    {
        /// <summary>Texels along the runway (x, low threshold at 0).</summary>
        public int Width;
        /// <summary>Texels across it (y, -widthM/2 at 0).</summary>
        public int Height;
        /// <summary>Width * Height texel pairs, row by row from y = 0: threshold tone, line tone.</summary>
        public byte[] Data;
    }

    public static class RunwayMarkingTexture
    {
        public const double TexelAcrossM = 0.3;
        public const double TexelAlongM = 0.6;
        public const int TextureMax = 4096;

        /// <summary>Which channel a kind of paint goes in; -1 for what is not paint.</summary>
        public static int Channel(MarkingKind kind)
        {
            switch (kind)
            {
                case MarkingKind.Threshold:
                case MarkingKind.Designator:
                    return 0;
                case MarkingKind.Aiming:
                case MarkingKind.Centreline:
                case MarkingKind.Edge:
                    return 1;
                default:
                    return -1;
            }
        }

        /// <summary>Rasterise one runway's paint as exact area coverage per texel.</summary>
        public static MarkingTexture Rasterise(IReadOnlyList<MarkingRect> rects, double lengthM, double widthM)
        {
            int width = (int)Math.Max(1, Math.Min(TextureMax, Math.Ceiling(lengthM / TexelAlongM)));
            int height = (int)Math.Max(1, Math.Min(TextureMax, Math.Ceiling(widthM / TexelAcrossM)));
            double texelU = lengthM / width;
            double texelV = widthM / height;
            var coverage = new float[width * height * 2];

            foreach (MarkingRect rect in rects)
            {
                int channel = Channel(rect.Kind);
                if (channel < 0) continue;
                double x0 = (rect.U - rect.LengthM / 2 + lengthM / 2) / texelU;
                double x1 = (rect.U + rect.LengthM / 2 + lengthM / 2) / texelU;
                double y0 = (rect.V - rect.WidthM / 2 + widthM / 2) / texelV;
                double y1 = (rect.V + rect.WidthM / 2 + widthM / 2) / texelV;
                int ix0 = (int)Math.Max(0, Math.Floor(x0));
                int ix1 = (int)Math.Min(width, Math.Ceiling(x1));
                int iy0 = (int)Math.Max(0, Math.Floor(y0));
                int iy1 = (int)Math.Min(height, Math.Ceiling(y1));
                for (int y = iy0; y < iy1; y++)
                {
                    double cy = Math.Min(y + 1, y1) - Math.Max(y, y0);
                    if (cy <= 0) continue;
                    for (int x = ix0; x < ix1; x++)
                    {
                        double cx = Math.Min(x + 1, x1) - Math.Max(x, x0);
                        // Float32Array: the sum is rounded to float on every store.
                        if (cx > 0) coverage[(y * width + x) * 2 + channel] = (float)(coverage[(y * width + x) * 2 + channel] + cx * cy);
                    }
                }
            }

            var data = new byte[coverage.Length];
            for (int i = 0; i < coverage.Length; i++)
            {
                data[i] = (byte)JsMath.Round(Math.Min(1, (double)coverage[i]) * 255);
            }
            return new MarkingTexture { Width = width, Height = height, Data = data };
        }
    }
}
