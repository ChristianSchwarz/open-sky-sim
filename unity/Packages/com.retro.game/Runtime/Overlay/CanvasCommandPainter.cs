using System;
using System.Collections.Generic;

namespace Retro.Game
{
    /// <summary>
    /// canvasPainter.ts CanvasPainter (with BatchCanvasPainter and
    /// ClipCanvasPainter) and text.ts TextRenderer, turning painter calls into
    /// the exact CanvasRenderingContext2D calls the browser game makes, on a
    /// <see cref="Canvas2D"/> that turns those into a flat list of
    /// <see cref="CanvasCommand"/>s for a GPU frontend.
    ///
    /// <para><b>Rasterising the commands like the browser.</b> Canvas pixel
    /// (i, j) is the square [i, i+1] x [j, j+1], centre (i + 0.5, j + 0.5); y
    /// is down; one canvas pixel per texel of the overlay texture. Every shape
    /// is a region in user space mapped to pixels by the command's M; a pixel's
    /// coverage is the fraction of its square inside that region (browsers
    /// antialias analytically; supersampling approximates it), and the colour
    /// is blended source-over with alpha x coverage, within the clip. When M is
    /// a translation by whole pixels and every edge falls on a pixel boundary,
    /// coverage is exactly 0 or 1 and the result is exact; that is the HUD's
    /// normal case, and a frontend can draw those as unantialiased quads.</para>
    ///
    /// <list type="bullet">
    /// <item><b>StrokePath</b>: each Segment is a rectangle around the segment,
    /// LineWidth/2 to each side measured in user units of M (map the device
    /// endpoints back through M's inverse, offset perpendicular, map the four
    /// corners forward again: <see cref="SegmentQuad"/>); butt caps, so it ends
    /// exactly at the endpoints; zero-length segments draw nothing. hLine(x0,
    /// x1, y) is the segment (min, y + 0.5) to (max + 1, y + 0.5): at width 1
    /// it covers row y, columns min..max, exactly; width 2 covers row y fully
    /// and rows y - 1 and y + 1 half (50 % coverage, a blurred 3-row band);
    /// width 3 covers rows y - 1..y + 1 exactly (odd widths are crisp, even
    /// ones are not). vLine likewise in x. line() and rightTriangle() are
    /// decomposed into such 1-pixel spans here, so they rasterise as the same
    /// pixel runs. Under rotation or scale the quad rotates/scales with M
    /// (antialiased). The shapes of one command form a single coverage mask:
    /// overlapping spans do not blend twice (union, e.g. max coverage). Arc
    /// shapes stroke as an annulus of radii R +- LineWidth/2 (user units).</item>
    /// <item><b>FillPath</b>: nonzero fill of the union of the shapes; an Arc
    /// shape is the disc of radius R about (Cx, Cy) through its M; Segments
    /// only ever join arcs and rectangles (zero area).</item>
    /// <item><b>FillRect</b>: the rectangle (X, Y, W, H), negative sizes
    /// flipped, through M. Zero width or height draws nothing.</item>
    /// <item><b>StrokeRect</b>: the closed rectangle path with miter joins,
    /// widened LineWidth/2 to each side: the outer rectangle grown by LineWidth/2
    /// minus the inner one shrunk by it (a filled outer rectangle if the inner
    /// is empty). painter.rectangle(x, y, w, h) strokes (x + .5, y + .5, w - 1,
    /// h - 1): at width 1 exactly the outline pixels x..x+w-1, y..y+h-1. When
    /// W and H are both 0 nothing is drawn; when exactly one is 0 it is a
    /// single butt-capped segment from (X, Y) to (X + W, Y + H), so
    /// rectangle(x, y, 1, 5) is a column at x + .5 from y + .5 to y + 4.5,
    /// half-covering its end pixels.</item>
    /// <item><b>ClearRect</b>: the rectangle through M (inside the clip) is set
    /// to transparent black, coverage-weighted (dst *= 1 - coverage).</item>
    /// <item><b>Glyph</b>: the destination rectangle (Dx, Dy, Dw, Dh) through M
    /// samples the atlas source rectangle (Sx, Sy, Sw, Sh) in texels: nearest
    /// when Smooth is false, bilinear (clamped to the source rectangle) when
    /// true. Text always has Dw = Sw and Dh = Sh, so at whole-pixel positions
    /// under a translation-only M both filters return the texel itself; text
    /// before the first image() runs with smoothing on (the canvas default), so
    /// fractional positions or a rotating M blur it, as in the browser. Smooth
    /// stays false for good once image() has run (it is never set back) unless
    /// a restore() pops it. A tinted texel is the multiply +
    /// destination-in recipe of text.ts createColor: for an atlas texel of
    /// colour T and alpha t and tint (C, a): rgb = (a C T + (1 - a) T) and
    /// alpha = t (the atlases are white or transparent, so an opaque tint is
    /// simply C on the glyph's texels). Tint null draws the atlas as it is.</item>
    /// <item><b>Image</b>: like Glyph over the whole image (handle's own size).</item>
    /// <item><b>ClipPush</b>: intersect the clip with the nonzero fill of the
    /// shapes (no shapes: everything is clipped away); <b>ClipPop</b> drops
    /// the innermost. Clips nest as a stack; a stencil buffer (increment on
    /// push, compare equal to depth) or a coverage-mask stack reproduces it.
    /// Browsers antialias clip edges. Note painter.Clip().Rectangle(x, y, w, h)
    /// is rect(x, y, w - 1, h - 1) with no half-pixel offset: it keeps pixels
    /// x..x+w-2, one fewer than rectangle(..., fill: true) covers; Circle is
    /// arc(x, y, r) with no offset either (circle() draws at x + .5).</item>
    /// </list>
    ///
    /// Frames: the context state (colours, width, transform stack, clip stack)
    /// carries over between frames exactly as on a real canvas; call
    /// <see cref="BeginFrame"/> to drop last frame's commands.
    /// </summary>
    public sealed class CanvasCommandPainter : ICanvasPainter
    {
        private readonly HudTextRenderer textRenderer;
        private readonly BatchPainter batchPainter;
        private readonly ClipPainter clipPainter;
        private TextEffect textEffect = TextEffect.None;
        private string textEffectColor = "#000000";

        public Canvas2D Context { get; }
        public HudTextRenderer TextRenderer => textRenderer;
        public List<CanvasCommand> Commands => Context.Commands;

        public CanvasCommandPainter(int width, int height, IEnumerable<string> textColors = null)
            : this(new Canvas2D(width, height), textColors)
        {
        }

        public CanvasCommandPainter(Canvas2D ctx, IEnumerable<string> textColors = null)
        {
            Context = ctx;
            textRenderer = new HudTextRenderer(ctx, textColors);
            batchPainter = new BatchPainter(ctx);
            clipPainter = new ClipPainter(ctx);
            ctx.LineCap = "butt";
            ctx.LineWidth = 1;
        }

        /// <summary>Drop the commands of the previous frame; the context state stays.</summary>
        public void BeginFrame() => Context.Commands.Clear();

        // State

        public void SetColor(string color) => Context.StrokeStyle = color;

        public void SetBackground(string color) => Context.FillStyle = color;

        public void SetTextEffect(TextEffect effect, string effectColor)
        {
            textEffect = effect;
            textEffectColor = effectColor;
        }

        public void SetLineWidth(double width) => Context.LineWidth = width;

        // Actions

        /// <summary>`x || 0`, `width || canvas.width`: 0 and NaN count as missing too.</summary>
        public void Clear(double? x = null, double? y = null, double? width = null, double? height = null)
        {
            Context.ClearRect(OrElse(x, 0), OrElse(y, 0), OrElse(width, Context.Width), OrElse(height, Context.Height));
        }

        private static double OrElse(double? v, double fallback) =>
            v.HasValue && v.Value != 0 && !double.IsNaN(v.Value) ? v.Value : fallback;

        public void FillRect(double x, double y, double width, double height) => Context.FillRect(x, y, width, height);

        public void HLine(double x0, double x1, double y) => Batch().HLine(x0, x1, y).Commit();

        public void VLine(double x, double y0, double y1) => Batch().VLine(x, y0, y1).Commit();

        public void Line(double x0, double y0, double x1, double y1) => Batch().Line(x0, y0, x1, y1).Commit();

        public void RightTriangle(double x0, double y0, double x1, double y1) => Batch().RightTriangle(x0, y0, x1, y1).Commit();

        public void Rectangle(double x, double y, double width, double height, bool fill = false)
        {
            if (fill)
            {
                Context.FillRect(x, y, width, height);
            }
            else
            {
                Context.StrokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
            }
        }

        public void Circle(double x, double y, double radius, bool fill = false)
        {
            Context.BeginPath();
            Context.Arc(x + 0.5, y + 0.5, radius, 0, Math.PI * 2);
            if (fill)
            {
                Context.Fill();
            }
            else
            {
                Context.Stroke();
            }
        }

        public void Text(HudFont font, double x, double y, string text, string color = null, TextAlignment alignment = TextAlignment.Left) =>
            textRenderer.Text(font, x, y, text, color, alignment, textEffect, textEffectColor);

        public void Image(object image, double x, double y, double width, double height)
        {
            Context.ImageSmoothingEnabled = false;
            Context.DrawImage(image, x, y, width, height);
        }

        public void PushTransform(double originX, double originY, double rotation, double scale)
        {
            Context.Save();
            Context.Translate(originX, originY);
            Context.Rotate(rotation);
            Context.Scale(scale, scale);
        }

        public void PopTransform() => Context.Restore();

        public IBatchPainter Batch()
        {
            Context.BeginPath();
            return batchPainter;
        }

        public IClipPainter Clip()
        {
            Context.Save();
            Context.BeginPath();
            return clipPainter;
        }

        /// <summary>
        /// The four device-space corners of a stroked segment's butt-capped
        /// rectangle (half width w/2 in user units of m): p0 - n, p1 - n, p1 + n,
        /// p0 + n in that order. Empty (all equal) for a zero-length segment.
        /// </summary>
        public static (double x, double y)[] SegmentQuad(double x0, double y0, double x1, double y1, double lineWidth, CanvasMatrix m)
        {
            CanvasMatrix inv = m.Inverse();
            var (ux0, uy0) = inv.Apply(x0, y0);
            var (ux1, uy1) = inv.Apply(x1, y1);
            double dx = ux1 - ux0, dy = uy1 - uy0;
            double len = Math.Sqrt(dx * dx + dy * dy);
            if (!(len > 0)) return new[] { (x0, y0), (x0, y0), (x0, y0), (x0, y0) };
            double nx = -dy / len * lineWidth / 2, ny = dx / len * lineWidth / 2;
            return new[]
            {
                m.Apply(ux0 - nx, uy0 - ny), m.Apply(ux1 - nx, uy1 - ny), m.Apply(ux1 + nx, uy1 + ny), m.Apply(ux0 + nx, uy0 + ny),
            };
        }

        /// <summary>canvasPainter.ts BatchCanvasPainter.</summary>
        private sealed class BatchPainter : IBatchPainter
        {
            private readonly Canvas2D ctx;

            public BatchPainter(Canvas2D ctx) => this.ctx = ctx;

            public IBatchPainter HLine(double x0, double x1, double y)
            {
                int inverted = x0 > x1 ? 1 : 0;
                ctx.MoveTo(x0 + inverted, y + 0.5);
                ctx.LineTo(x1 + 1 - inverted, y + 0.5);
                return this;
            }

            public IBatchPainter VLine(double x, double y0, double y1)
            {
                int inverted = y0 > y1 ? 1 : 0;
                ctx.MoveTo(x + 0.5, y0 + inverted);
                ctx.LineTo(x + 0.5, y1 + 1 - inverted);
                return this;
            }

            public IBatchPainter Line(double x0, double y0, double x1, double y1)
            {
                if (x0 == x1)
                {
                    VLine(x0, y0, y1);
                    return this;
                }
                if (y0 == y1)
                {
                    HLine(x0, x1, y0);
                    return this;
                }

                double lead0 = x0, lead1 = x1, offset0 = y0, offset1 = y1;
                bool flip = Math.Abs((y1 - y0) / (x1 - x0)) > 1;
                if (flip)
                {
                    lead0 = y0; lead1 = y1; offset0 = x0; offset1 = x1;
                }
                if (lead0 > lead1)
                {
                    (lead0, lead1) = (lead1, lead0);
                    (offset0, offset1) = (offset1, offset0);
                }
                double offsetStep = offset0 < offset1 ? 1 : -1;
                double offsetDelta = offsetStep * (offset1 - offset0);
                double leadDelta = lead1 - lead0;
                double error = 2 * offsetDelta - leadDelta;
                double offset = offset0;

                for (double lead = lead0; lead <= lead1; lead++)
                {
                    if (flip)
                    {
                        VLine(offset, lead, lead);
                    }
                    else
                    {
                        HLine(lead, lead, offset);
                    }
                    if (error > 0)
                    {
                        offset += offsetStep;
                        error -= 2 * leadDelta;
                    }
                    error += 2 * offsetDelta;
                }
                return this;
            }

            public IBatchPainter RightTriangle(double x0, double y0, double x1, double y1)
            {
                if (x0 == x1)
                {
                    VLine(x0, y0, y1);
                    return this;
                }
                if (y0 == y1)
                {
                    HLine(x0, x1, y0);
                    return this;
                }

                double lead0 = x0, lead1 = x1, offset0 = y0, offset1 = y1;
                bool flip = Math.Abs((y1 - y0) / (x1 - x0)) > 1;
                if (flip)
                {
                    lead0 = y0; lead1 = y1; offset0 = x0; offset1 = x1;
                }
                bool invertedLead = false;
                if (lead0 > lead1)
                {
                    invertedLead = true;
                    (lead0, lead1) = (lead1, lead0);
                    (offset0, offset1) = (offset1, offset0);
                }
                bool invertedOffset = offset0 > offset1;
                double offsetStep = invertedOffset ? -1 : 1;
                double offsetDelta = offsetStep * (offset1 - offset0);
                double leadDelta = lead1 - lead0;
                double error = 2 * offsetDelta - leadDelta;
                double offset = offset0;
                // XOR(invertedLead, !invertedOffset)
                bool fromOffset0 = invertedLead != !invertedOffset;

                for (double lead = lead0; lead <= lead1; lead++)
                {
                    if (flip)
                    {
                        HLine(fromOffset0 ? offset0 : offset1, offset, lead);
                    }
                    else
                    {
                        VLine(lead, fromOffset0 ? offset1 : offset0, offset);
                    }
                    if (error > 0)
                    {
                        offset += offsetStep;
                        error -= 2 * leadDelta;
                    }
                    error += 2 * offsetDelta;
                }
                return this;
            }

            public void Commit() => ctx.Stroke();
        }

        /// <summary>canvasPainter.ts ClipCanvasPainter.</summary>
        private sealed class ClipPainter : IClipPainter
        {
            private readonly Canvas2D ctx;

            public ClipPainter(Canvas2D ctx) => this.ctx = ctx;

            public IClipPainter Rectangle(double x, double y, double width, double height)
            {
                ctx.Rect(x, y, width - 1, height - 1);
                return this;
            }

            public IClipPainter Circle(double x, double y, double radius)
            {
                ctx.Arc(x, y, radius, 0, Math.PI * 2);
                return this;
            }

            public IClipPainter Clip()
            {
                ctx.Clip();
                return this;
            }

            public void Clear() => ctx.Restore();
        }
    }
}
