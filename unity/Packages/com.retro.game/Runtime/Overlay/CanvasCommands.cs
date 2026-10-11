using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Retro.Game
{
    /// <summary>
    /// A 2D affine transform in the canvas convention (DOMMatrix a..f):
    /// device = (A x + C y + E, B x + D y + F). Canvas pixels, y down.
    /// </summary>
    public readonly struct CanvasMatrix
    {
        public readonly double A, B, C, D, E, F;

        public static readonly CanvasMatrix Identity = new CanvasMatrix(1, 0, 0, 1, 0, 0);

        public CanvasMatrix(double a, double b, double c, double d, double e, double f)
        {
            A = a; B = b; C = c; D = d; E = e; F = f;
        }

        public (double x, double y) Apply(double x, double y) => (A * x + C * y + E, B * x + D * y + F);

        /// <summary>ctx.translate: this * T(x, y).</summary>
        public CanvasMatrix Translated(double x, double y) => new CanvasMatrix(A, B, C, D, E + A * x + C * y, F + B * x + D * y);

        /// <summary>ctx.rotate: this * R(t), t clockwise on screen (y down).</summary>
        public CanvasMatrix Rotated(double t)
        {
            double c = Math.Cos(t), s = Math.Sin(t);
            return new CanvasMatrix(A * c + C * s, B * c + D * s, C * c - A * s, D * c - B * s, E, F);
        }

        /// <summary>ctx.scale: this * S(sx, sy).</summary>
        public CanvasMatrix Scaled(double sx, double sy) => new CanvasMatrix(A * sx, B * sx, C * sy, D * sy, E, F);

        public double Determinant => A * D - B * C;

        /// <summary>The inverse (device to user); a singular matrix gives NaNs.</summary>
        public CanvasMatrix Inverse()
        {
            double det = Determinant;
            double ia = D / det, ib = -B / det, ic = -C / det, id = A / det;
            return new CanvasMatrix(ia, ib, ic, id, -(ia * E + ic * F), -(ib * E + id * F));
        }

        /// <summary>True when the matrix only translates (no rotation, scale or shear).</summary>
        public bool IsTranslation => A == 1 && B == 0 && C == 0 && D == 1;
    }

    /// <summary>A parsed colour: straight (not premultiplied) RGBA in 0..1.</summary>
    public readonly struct CanvasColor
    {
        public readonly float R, G, B, A;

        public CanvasColor(float r, float g, float b, float a)
        {
            R = r; G = g; B = b; A = a;
        }

        public static readonly CanvasColor Black = new CanvasColor(0, 0, 0, 1);
        public static readonly CanvasColor White = new CanvasColor(1, 1, 1, 1);
    }

    /// <summary>
    /// The CSS colour syntaxes the overlay uses (#rgb, #rgba, #rrggbb,
    /// #rrggbbaa, rgb(), rgba(), a few names). A string that does not parse is
    /// what a browser ignores on assignment to fillStyle/strokeStyle; the
    /// golden mock (tools/golden/mockContext2d.ts isCssColor) accepts the same set.
    /// </summary>
    public static class CssColor
    {
        private static readonly Regex Hex = new Regex("^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$", RegexOptions.CultureInvariant);
        private static readonly Regex Func = new Regex(
            @"^rgba?\(\s*([-+0-9.]+%?)\s*,\s*([-+0-9.]+%?)\s*,\s*([-+0-9.]+%?)\s*(,\s*([-+0-9.]+%?)\s*)?\)$", RegexOptions.CultureInvariant);

        private static readonly Dictionary<string, CanvasColor> Names = new Dictionary<string, CanvasColor>
        {
            ["transparent"] = new CanvasColor(0, 0, 0, 0),
            ["black"] = new CanvasColor(0, 0, 0, 1),
            ["white"] = new CanvasColor(1, 1, 1, 1),
            ["red"] = new CanvasColor(1, 0, 0, 1),
            ["green"] = new CanvasColor(0, 128 / 255f, 0, 1),
            ["blue"] = new CanvasColor(0, 0, 1, 1),
            ["yellow"] = new CanvasColor(1, 1, 0, 1),
            ["cyan"] = new CanvasColor(0, 1, 1, 1),
            ["magenta"] = new CanvasColor(1, 0, 1, 1),
            ["gray"] = new CanvasColor(128 / 255f, 128 / 255f, 128 / 255f, 1),
            ["grey"] = new CanvasColor(128 / 255f, 128 / 255f, 128 / 255f, 1),
        };

        public static bool IsValid(string s) => TryParse(s, out _);

        public static bool TryParse(string s, out CanvasColor color)
        {
            color = default;
            if (s == null) return false;
            string t = s.Trim().ToLowerInvariant();
            if (Names.TryGetValue(t, out color)) return true;
            Match m = Hex.Match(t);
            if (m.Success)
            {
                string h = m.Groups[1].Value;
                int Nib(int i) => Convert.ToInt32(h.Substring(i, 1), 16) * 17;
                int Byte(int i) => Convert.ToInt32(h.Substring(i, 2), 16);
                int r, g, b, a = 255;
                if (h.Length <= 4)
                {
                    r = Nib(0); g = Nib(1); b = Nib(2);
                    if (h.Length == 4) a = Nib(3);
                }
                else
                {
                    r = Byte(0); g = Byte(2); b = Byte(4);
                    if (h.Length == 8) a = Byte(6);
                }
                color = new CanvasColor(r / 255f, g / 255f, b / 255f, a / 255f);
                return true;
            }
            m = Func.Match(t);
            if (m.Success)
            {
                // Validity is the pattern alone (as in the mock); a malformed number reads as 0.
                float r = Channel(m.Groups[1].Value, 255), g = Channel(m.Groups[2].Value, 255), b = Channel(m.Groups[3].Value, 255);
                float a = m.Groups[5].Success ? Channel(m.Groups[5].Value, 1) : 1;
                color = new CanvasColor(r, g, b, a);
                return true;
            }
            return false;
        }

        private static float Channel(string v, double full)
        {
            bool pct = v.EndsWith("%", StringComparison.Ordinal);
            if (!double.TryParse(pct ? v.Substring(0, v.Length - 1) : v, NumberStyles.Float, CultureInfo.InvariantCulture, out double d)) d = 0;
            double unit = pct ? d / 100 : (full > 1 ? Math.Round(d) / full : d);
            return (float)Math.Max(0, Math.Min(1, unit));
        }
    }

    public enum PathShapeKind
    {
        /// <summary>A straight piece of a subpath, already in device pixels.</summary>
        Segment,
        /// <summary>ctx.rect, in user units with the matrix current when it was added.</summary>
        Rect,
        /// <summary>ctx.arc, in user units with the matrix current when it was added.</summary>
        Arc,
    }

    /// <summary>
    /// One piece of a path. Path points are transformed when they are added
    /// (canvas semantics), so a Segment is stored in device pixels and Rect/Arc
    /// carry their own matrix.
    /// </summary>
    public sealed class PathShape
    {
        public PathShapeKind Kind;
        /// <summary>Segment: device endpoints.</summary>
        public double X0, Y0, X1, Y1;
        /// <summary>Rect: user rectangle (w/h may be negative).</summary>
        public double X, Y, W, H;
        /// <summary>Arc: user centre, radius, angles (radians, clockwise on screen) and direction.</summary>
        public double Cx, Cy, R, Start, End;
        public bool Ccw;
        /// <summary>Rect and Arc: the matrix current when the shape was added.</summary>
        public CanvasMatrix M;

        public static PathShape Segment(double x0, double y0, double x1, double y1) =>
            new PathShape { Kind = PathShapeKind.Segment, X0 = x0, Y0 = y0, X1 = x1, Y1 = y1, M = CanvasMatrix.Identity };

        public static PathShape Rectangle(double x, double y, double w, double h, CanvasMatrix m) =>
            new PathShape { Kind = PathShapeKind.Rect, X = x, Y = y, W = w, H = h, M = m };

        public static PathShape ArcShape(double cx, double cy, double r, double start, double end, bool ccw, CanvasMatrix m) =>
            new PathShape { Kind = PathShapeKind.Arc, Cx = cx, Cy = cy, R = r, Start = start, End = end, Ccw = ccw, M = m };
    }

    public enum CanvasCommandKind
    {
        ClearRect,
        FillRect,
        StrokeRect,
        StrokePath,
        FillPath,
        Glyph,
        Image,
        ClipPush,
        ClipPop,
    }

    /// <summary>
    /// One low-level drawing command, in the order the browser would draw it.
    /// Coordinates are user units mapped to canvas pixels by <see cref="M"/>
    /// (the transform current when the command was issued) unless a field says
    /// device. See <see cref="CanvasCommandPainter"/> for how each kind must be
    /// rasterised to match the browser.
    /// </summary>
    public abstract class CanvasCommand
    {
        public abstract CanvasCommandKind Kind { get; }
        public CanvasMatrix M;
    }

    /// <summary>ctx.clearRect: the rectangle (through M, inside the clip) becomes transparent black.</summary>
    public sealed class ClearRectCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.ClearRect;
        public double X, Y, W, H;
    }

    /// <summary>ctx.fillRect with fillStyle.</summary>
    public sealed class FillRectCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.FillRect;
        public string Color;
        public CanvasColor Rgba;
        public double X, Y, W, H;
    }

    /// <summary>ctx.strokeRect with strokeStyle, lineWidth (user units), miter joins.</summary>
    public sealed class StrokeRectCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.StrokeRect;
        public string Color;
        public CanvasColor Rgba;
        public double LineWidth;
        public double X, Y, W, H;
    }

    /// <summary>ctx.stroke of the current path with strokeStyle, lineWidth (user units of M), butt caps.</summary>
    public sealed class StrokePathCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.StrokePath;
        public string Color;
        public CanvasColor Rgba;
        public double LineWidth;
        public PathShape[] Shapes;
    }

    /// <summary>ctx.fill of the current path with fillStyle, nonzero rule.</summary>
    public sealed class FillPathCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.FillPath;
        public string Color;
        public CanvasColor Rgba;
        public PathShape[] Shapes;
    }

    /// <summary>A 9-argument drawImage from a HUD font atlas.</summary>
    public sealed class GlyphCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.Glyph;
        public HudFont Font;
        /// <summary>The tint colour string, or null for the untinted (white) atlas.</summary>
        public string Tint;
        /// <summary>The parsed tint (white when Tint is null or unparseable).</summary>
        public CanvasColor TintRgba;
        /// <summary>Source rectangle in atlas texels.</summary>
        public double Sx, Sy, Sw, Sh;
        /// <summary>Destination rectangle in user units.</summary>
        public double Dx, Dy, Dw, Dh;
        /// <summary>imageSmoothingEnabled at the time: bilinear when true, nearest when false.</summary>
        public bool Smooth;
    }

    /// <summary>A 5-argument drawImage of an opaque image handle.</summary>
    public sealed class ImageCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.Image;
        public object Image;
        public double Dx, Dy, Dw, Dh;
        public bool Smooth;
    }

    /// <summary>
    /// ctx.clip: intersect the clip region with the path (nonzero, union of its
    /// shapes; no shapes = clip everything away). Undone by the ClipPop the
    /// matching restore() emits.
    /// </summary>
    public sealed class ClipPushCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.ClipPush;
        public PathShape[] Shapes;
    }

    /// <summary>Drop the innermost clip.</summary>
    public sealed class ClipPopCommand : CanvasCommand
    {
        public override CanvasCommandKind Kind => CanvasCommandKind.ClipPop;
    }
}
