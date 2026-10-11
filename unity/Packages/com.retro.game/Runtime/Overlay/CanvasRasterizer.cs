using System;
using System.Collections.Generic;

namespace Retro.Game
{
    /// <summary>RGBA8 pixels, rows top-down, straight alpha.</summary>
    public sealed class RgbaImage
    {
        public readonly int Width, Height;
        public readonly byte[] Pixels;

        public RgbaImage(int width, int height, byte[] pixels = null)
        {
            Width = width;
            Height = height;
            Pixels = pixels ?? new byte[width * height * 4];
        }
    }

    /// <summary>
    /// A small reference CPU rasteriser for <see cref="CanvasCommand"/> lists:
    /// the documentation of <see cref="CanvasCommandPainter"/> in executable
    /// form, for tests and for checking a GPU frontend against. Shapes are
    /// covered by 4 x 4 supersampling (exact for axis-aligned edges on whole,
    /// half or quarter pixels; approximate elsewhere, where a browser's
    /// analytic antialiasing differs slightly); glyphs and images
    /// sample once per pixel centre. Blending is source-over in premultiplied
    /// floats; clips are a stack of coverage masks.
    /// </summary>
    public sealed class CanvasRasterizer
    {
        private const int SS = 4;
        public readonly int Width, Height;
        /// <summary>Premultiplied RGBA, 0..1.</summary>
        private readonly float[] px;
        private readonly List<float[]> clips = new List<float[]>();
        private readonly Func<HudFont, RgbaImage> atlas;
        private readonly Func<object, RgbaImage> images;

        /// <param name="atlas">The decoded atlas PNG of a font.</param>
        /// <param name="images">The pixels of an Image command's handle (null: skip).</param>
        public CanvasRasterizer(int width, int height, Func<HudFont, RgbaImage> atlas = null, Func<object, RgbaImage> images = null)
        {
            Width = width;
            Height = height;
            px = new float[width * height * 4];
            this.atlas = atlas;
            this.images = images;
        }

        public void Run(IEnumerable<CanvasCommand> commands)
        {
            foreach (CanvasCommand c in commands) Execute(c);
        }

        public RgbaImage ToImage()
        {
            var img = new RgbaImage(Width, Height);
            for (int i = 0; i < Width * Height; i++)
            {
                float a = px[i * 4 + 3];
                for (int k = 0; k < 3; k++)
                {
                    float v = a > 0 ? px[i * 4 + k] / a : 0;
                    img.Pixels[i * 4 + k] = ToByte(v);
                }
                img.Pixels[i * 4 + 3] = ToByte(a);
            }
            return img;
        }

        private static byte ToByte(float v) => (byte)Math.Max(0, Math.Min(255, (int)Math.Round(v * 255)));

        private float Clip(int i) => clips.Count == 0 ? 1 : clips[clips.Count - 1][i];

        public void Execute(CanvasCommand c)
        {
            switch (c)
            {
                case ClearRectCommand k:
                    Cover(RectBox(k.X, k.Y, k.W, k.H, k.M), (x, y) => InRect(k.M, x, y, k.X, k.Y, k.W, k.H), (i, cov) =>
                    {
                        float keep = 1 - cov * Clip(i);
                        for (int j = 0; j < 4; j++) px[i * 4 + j] *= keep;
                    });
                    break;
                case FillRectCommand k:
                    Paint(RectBox(k.X, k.Y, k.W, k.H, k.M), (x, y) => InRect(k.M, x, y, k.X, k.Y, k.W, k.H), k.Rgba);
                    break;
                case StrokeRectCommand k:
                {
                    double g = k.LineWidth / 2;
                    var box = RectBox(Math.Min(k.X, k.X + k.W) - g, Math.Min(k.Y, k.Y + k.H) - g, Math.Abs(k.W) + 2 * g, Math.Abs(k.H) + 2 * g, k.M);
                    Paint(box, (x, y) => InStrokeRect(k, x, y), k.Rgba);
                    break;
                }
                case StrokePathCommand k:
                    Paint(PathBox(k.Shapes, k.LineWidth, k.M), (x, y) => InStroke(k, x, y), k.Rgba);
                    break;
                case FillPathCommand k:
                    Paint(PathBox(k.Shapes, 0, k.M), (x, y) => InFill(k.Shapes, x, y), k.Rgba);
                    break;
                case ClipPushCommand k:
                {
                    var mask = new float[Width * Height];
                    var box = PathBox(k.Shapes, 0, k.M);
                    Cover(box, (x, y) => InFill(k.Shapes, x, y), (i, cov) => mask[i] = cov);
                    if (clips.Count > 0)
                    {
                        float[] prev = clips[clips.Count - 1];
                        for (int i = 0; i < mask.Length; i++) mask[i] *= prev[i];
                    }
                    clips.Add(mask);
                    break;
                }
                case ClipPopCommand _:
                    if (clips.Count > 0) clips.RemoveAt(clips.Count - 1);
                    break;
                case GlyphCommand k:
                {
                    RgbaImage src = atlas?.Invoke(k.Font);
                    if (src != null) Blit(src, k.Sx, k.Sy, k.Sw, k.Sh, k.Dx, k.Dy, k.Dw, k.Dh, k.Smooth, k.M, k.Tint == null ? (CanvasColor?)null : k.TintRgba);
                    break;
                }
                case ImageCommand k:
                {
                    RgbaImage src = images?.Invoke(k.Image);
                    if (src != null) Blit(src, 0, 0, src.Width, src.Height, k.Dx, k.Dy, k.Dw, k.Dh, k.Smooth, k.M, null);
                    break;
                }
            }
        }

        // ---- coverage ----

        private (int x0, int y0, int x1, int y1) RectBox(double x, double y, double w, double h, CanvasMatrix m)
        {
            double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
            foreach (var (cx, cy) in new[] { (x, y), (x + w, y), (x, y + h), (x + w, y + h) })
            {
                var (dx, dy) = m.Apply(cx, cy);
                minX = Math.Min(minX, dx); minY = Math.Min(minY, dy); maxX = Math.Max(maxX, dx); maxY = Math.Max(maxY, dy);
            }
            return Clamp(minX, minY, maxX, maxY);
        }

        private (int x0, int y0, int x1, int y1) Clamp(double minX, double minY, double maxX, double maxY)
        {
            if (double.IsNaN(minX + minY + maxX + maxY)) return (0, 0, -1, -1);
            int x0 = (int)Math.Max(0, Math.Floor(minX) - 1), y0 = (int)Math.Max(0, Math.Floor(minY) - 1);
            int x1 = (int)Math.Min(Width - 1, Math.Ceiling(maxX) + 1), y1 = (int)Math.Min(Height - 1, Math.Ceiling(maxY) + 1);
            return (x0, y0, x1, y1);
        }

        private (int x0, int y0, int x1, int y1) PathBox(PathShape[] shapes, double lineWidth, CanvasMatrix m)
        {
            double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
            double pad = lineWidth / 2 * Math.Max(Math.Sqrt(m.A * m.A + m.B * m.B), Math.Sqrt(m.C * m.C + m.D * m.D));
            void Add(double x, double y, double p)
            {
                minX = Math.Min(minX, x - p); minY = Math.Min(minY, y - p); maxX = Math.Max(maxX, x + p); maxY = Math.Max(maxY, y + p);
            }
            foreach (PathShape s in shapes)
            {
                switch (s.Kind)
                {
                    case PathShapeKind.Segment:
                        Add(s.X0, s.Y0, pad);
                        Add(s.X1, s.Y1, pad);
                        break;
                    case PathShapeKind.Rect:
                        foreach (var (cx, cy) in new[] { (s.X, s.Y), (s.X + s.W, s.Y), (s.X, s.Y + s.H), (s.X + s.W, s.Y + s.H) })
                        {
                            var (dx, dy) = s.M.Apply(cx, cy);
                            Add(dx, dy, pad);
                        }
                        break;
                    case PathShapeKind.Arc:
                    {
                        var (dx, dy) = s.M.Apply(s.Cx, s.Cy);
                        double r = Math.Abs(s.R) * Math.Max(Math.Sqrt(s.M.A * s.M.A + s.M.B * s.M.B), Math.Sqrt(s.M.C * s.M.C + s.M.D * s.M.D));
                        Add(dx, dy, r + pad);
                        break;
                    }
                }
            }
            return shapes.Length == 0 ? (0, 0, Width - 1, Height - 1) : Clamp(minX, minY, maxX, maxY);
        }

        /// <summary>Supersampled coverage of each pixel in the box; calls write(index, coverage) for every pixel in it.</summary>
        private void Cover((int x0, int y0, int x1, int y1) box, Func<double, double, bool> inside, Action<int, float> write)
        {
            for (int y = box.y0; y <= box.y1; y++)
            {
                for (int x = box.x0; x <= box.x1; x++)
                {
                    int n = 0;
                    for (int sy = 0; sy < SS; sy++)
                    {
                        for (int sx = 0; sx < SS; sx++)
                        {
                            if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) n++;
                        }
                    }
                    write(y * Width + x, n / (float)(SS * SS));
                }
            }
        }

        private void Paint((int x0, int y0, int x1, int y1) box, Func<double, double, bool> inside, CanvasColor c)
        {
            Cover(box, inside, (i, cov) =>
            {
                if (cov > 0) Blend(i, c.R, c.G, c.B, c.A * cov * Clip(i));
            });
        }

        /// <summary>Source-over of a straight colour with effective alpha a.</summary>
        private void Blend(int i, float r, float g, float b, float a)
        {
            if (a <= 0) return;
            int o = i * 4;
            float k = 1 - a;
            px[o] = r * a + px[o] * k;
            px[o + 1] = g * a + px[o + 1] * k;
            px[o + 2] = b * a + px[o + 2] * k;
            px[o + 3] = a + px[o + 3] * k;
        }

        private static bool InRect(CanvasMatrix m, double x, double y, double rx, double ry, double rw, double rh)
        {
            var (u, v) = m.Inverse().Apply(x, y);
            return u >= Math.Min(rx, rx + rw) && u < Math.Max(rx, rx + rw) && v >= Math.Min(ry, ry + rh) && v < Math.Max(ry, ry + rh);
        }

        private static bool InStrokeRect(StrokeRectCommand k, double x, double y)
        {
            double g = k.LineWidth / 2;
            if (k.W == 0 && k.H == 0) return false;
            var (u, v) = k.M.Inverse().Apply(x, y);
            if (k.W == 0 || k.H == 0)
            {
                return InSegment(u, v, k.X, k.Y, k.X + k.W, k.Y + k.H, g);
            }
            double x0 = Math.Min(k.X, k.X + k.W), x1 = Math.Max(k.X, k.X + k.W);
            double y0 = Math.Min(k.Y, k.Y + k.H), y1 = Math.Max(k.Y, k.Y + k.H);
            bool outer = u >= x0 - g && u < x1 + g && v >= y0 - g && v < y1 + g;
            bool inner = u >= x0 + g && u < x1 - g && v >= y0 + g && v < y1 - g;
            return outer && !inner;
        }

        /// <summary>Inside a butt-capped segment of half width g (all in one user space).</summary>
        private static bool InSegment(double u, double v, double ax, double ay, double bx, double by, double g)
        {
            double dx = bx - ax, dy = by - ay;
            double len2 = dx * dx + dy * dy;
            if (!(len2 > 0)) return false;
            double t = ((u - ax) * dx + (v - ay) * dy) / len2;
            if (t < 0 || t >= 1) return false;
            double cross = ((u - ax) * dy - (v - ay) * dx) / Math.Sqrt(len2);
            return cross >= -g && cross < g;
        }

        private static bool InStroke(StrokePathCommand k, double x, double y)
        {
            CanvasMatrix inv = k.M.Inverse();
            var (u, v) = inv.Apply(x, y);
            double g = k.LineWidth / 2;
            foreach (PathShape s in k.Shapes)
            {
                switch (s.Kind)
                {
                    case PathShapeKind.Segment:
                    {
                        var (ax, ay) = inv.Apply(s.X0, s.Y0);
                        var (bx, by) = inv.Apply(s.X1, s.Y1);
                        if (InSegment(u, v, ax, ay, bx, by, g)) return true;
                        break;
                    }
                    case PathShapeKind.Arc:
                    {
                        // Assumes the arc was added under the stroke's matrix (always so for the painter).
                        var (au, av) = s.M.Inverse().Apply(x, y);
                        double d = Math.Sqrt((au - s.Cx) * (au - s.Cx) + (av - s.Cy) * (av - s.Cy));
                        if (Math.Abs(d - Math.Abs(s.R)) <= g && OnArc(s, au, av)) return true;
                        break;
                    }
                    case PathShapeKind.Rect:
                    {
                        var (ru, rv) = s.M.Inverse().Apply(x, y);
                        double x0 = Math.Min(s.X, s.X + s.W), x1 = Math.Max(s.X, s.X + s.W);
                        double y0 = Math.Min(s.Y, s.Y + s.H), y1 = Math.Max(s.Y, s.Y + s.H);
                        bool outer = ru >= x0 - g && ru < x1 + g && rv >= y0 - g && rv < y1 + g;
                        bool inner = ru >= x0 + g && ru < x1 - g && rv >= y0 + g && rv < y1 - g;
                        if (outer && !inner) return true;
                        break;
                    }
                }
            }
            return false;
        }

        private static bool OnArc(PathShape s, double u, double v)
        {
            double sweep = s.Ccw ? s.Start - s.End : s.End - s.Start;
            if (sweep >= 2 * Math.PI) return true;
            double a = Math.Atan2(v - s.Cy, u - s.Cx);
            double from = s.Ccw ? s.End : s.Start;
            double d = (a - from) % (2 * Math.PI);
            if (d < 0) d += 2 * Math.PI;
            return d <= sweep;
        }

        private static bool InFill(PathShape[] shapes, double x, double y)
        {
            foreach (PathShape s in shapes)
            {
                var (u, v) = s.M.Inverse().Apply(x, y);
                switch (s.Kind)
                {
                    case PathShapeKind.Rect:
                        if (u >= Math.Min(s.X, s.X + s.W) && u < Math.Max(s.X, s.X + s.W) && v >= Math.Min(s.Y, s.Y + s.H) && v < Math.Max(s.Y, s.Y + s.H)) return true;
                        break;
                    case PathShapeKind.Arc:
                        if ((u - s.Cx) * (u - s.Cx) + (v - s.Cy) * (v - s.Cy) <= s.R * s.R && OnArc(s, u, v)) return true;
                        break;
                }
            }
            return false;
        }

        // ---- images ----

        private void Blit(RgbaImage src, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh,
            bool smooth, CanvasMatrix m, CanvasColor? tint)
        {
            if (dw == 0 || dh == 0 || sw == 0 || sh == 0) return;
            CanvasMatrix inv = m.Inverse();
            var box = RectBox(dx, dy, dw, dh, m);
            double ux0 = Math.Min(dx, dx + dw), ux1 = Math.Max(dx, dx + dw), vy0 = Math.Min(dy, dy + dh), vy1 = Math.Max(dy, dy + dh);
            for (int y = box.y0; y <= box.y1; y++)
            {
                for (int x = box.x0; x <= box.x1; x++)
                {
                    var (u, v) = inv.Apply(x + 0.5, y + 0.5);
                    if (u < ux0 || u >= ux1 || v < vy0 || v >= vy1) continue;
                    double tx = sx + (u - dx) / dw * sw, ty = sy + (v - dy) / dh * sh;
                    float r, g, b, a;
                    if (smooth)
                    {
                        Bilinear(src, tx, ty, sx, sy, sw, sh, out r, out g, out b, out a);
                    }
                    else
                    {
                        Texel(src, (int)Math.Floor(tx), (int)Math.Floor(ty), out r, out g, out b, out a);
                    }
                    if (tint.HasValue)
                    {
                        // createColor: multiply-fill with the tint, then destination-in with the atlas alpha.
                        CanvasColor t = tint.Value;
                        r = t.A * t.R * r + (1 - t.A) * r;
                        g = t.A * t.G * g + (1 - t.A) * g;
                        b = t.A * t.B * b + (1 - t.A) * b;
                    }
                    int i = y * Width + x;
                    Blend(i, r, g, b, a * Clip(i));
                }
            }
        }

        private static void Texel(RgbaImage src, int x, int y, out float r, out float g, out float b, out float a)
        {
            x = Math.Max(0, Math.Min(src.Width - 1, x));
            y = Math.Max(0, Math.Min(src.Height - 1, y));
            int o = (y * src.Width + x) * 4;
            r = src.Pixels[o] / 255f;
            g = src.Pixels[o + 1] / 255f;
            b = src.Pixels[o + 2] / 255f;
            a = src.Pixels[o + 3] / 255f;
        }

        private static void Bilinear(RgbaImage src, double tx, double ty, double sx, double sy, double sw, double sh,
            out float r, out float g, out float b, out float a)
        {
            double fx = Math.Max(sx + 0.5, Math.Min(sx + sw - 0.5, tx)) - 0.5;
            double fy = Math.Max(sy + 0.5, Math.Min(sy + sh - 0.5, ty)) - 0.5;
            int x0 = (int)Math.Floor(fx), y0 = (int)Math.Floor(fy);
            float wx = (float)(fx - x0), wy = (float)(fy - y0);
            r = g = b = a = 0;
            for (int j = 0; j < 2; j++)
            {
                for (int k = 0; k < 2; k++)
                {
                    float w = (k == 0 ? 1 - wx : wx) * (j == 0 ? 1 - wy : wy);
                    if (w == 0) continue;
                    Texel(src, x0 + k, y0 + j, out float tr, out float tg, out float tb, out float ta);
                    // Premultiplied filtering, then back to straight.
                    r += tr * ta * w; g += tg * ta * w; b += tb * ta * w; a += ta * w;
                }
            }
            if (a > 0)
            {
                r /= a; g /= a; b /= a;
            }
        }
    }
}
