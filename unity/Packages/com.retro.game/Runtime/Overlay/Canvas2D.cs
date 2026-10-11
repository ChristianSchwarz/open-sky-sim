using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace Retro.Game
{
    /// <summary>
    /// The subset of CanvasRenderingContext2D that canvasPainter.ts and text.ts
    /// use, as a state machine that turns calls into <see cref="CanvasCommand"/>s
    /// instead of pixels. It follows the HTML canvas spec:
    ///
    /// - fillStyle/strokeStyle assignments that are not a colour are ignored
    ///   (<see cref="CssColor"/>); lineWidth that is not finite and positive is
    ///   ignored; lineCap only takes butt/round/square.
    /// - save() pushes fillStyle, strokeStyle, lineWidth, lineCap,
    ///   imageSmoothingEnabled, globalCompositeOperation, the transform and the
    ///   clip; restore() pops them (no-op on an empty stack), emitting one
    ///   ClipPop per clip() made since the matching save(). The current path is
    ///   not part of the state.
    /// - Path points are transformed when added. moveTo opens a subpath, lineTo
    ///   without one only sets the point, rect() and arc() add shapes, arc()
    ///   first joins the current point to its start with a segment.
    /// - fillRect/strokeRect/clearRect leave the current path alone.
    ///
    /// When <see cref="Log"/> is set every call is also recorded verbatim, in the
    /// format of tools/golden/mockContext2d.ts: [method, args...] and
    /// ["set", prop, value]; images by label (atlas:&lt;font&gt;,
    /// tint:&lt;font&gt;:&lt;colour&gt;, img&lt;n&gt; by first appearance).
    /// </summary>
    public sealed class Canvas2D
    {
        private struct State
        {
            public string FillStyle;
            public string StrokeStyle;
            public double LineWidth;
            public string LineCap;
            public bool ImageSmoothingEnabled;
            public string GlobalCompositeOperation;
            public CanvasMatrix M;
            public int ClipDepth;
        }

        private sealed class ReferenceComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceComparer Instance = new ReferenceComparer();
            public new bool Equals(object a, object b) => ReferenceEquals(a, b);
            public int GetHashCode(object o) => RuntimeHelpers.GetHashCode(o);
        }

        private State s = new State
        {
            FillStyle = "#000000",
            StrokeStyle = "#000000",
            LineWidth = 1,
            LineCap = "butt",
            ImageSmoothingEnabled = true,
            GlobalCompositeOperation = "source-over",
            M = CanvasMatrix.Identity,
        };
        private readonly Stack<State> stack = new Stack<State>();
        private readonly List<PathShape> path = new List<PathShape>();
        private bool hasCurrent;
        private double curX, curY;
        private readonly Dictionary<object, string> otherImages = new Dictionary<object, string>(ReferenceComparer.Instance);

        /// <summary>The canvas size in pixels (ctx.canvas.width/height).</summary>
        public int Width, Height;

        /// <summary>Commands in draw order. The frontend drains it each frame (see <see cref="CanvasCommandPainter.BeginFrame"/>).</summary>
        public readonly List<CanvasCommand> Commands = new List<CanvasCommand>();

        /// <summary>Optional verbatim call log (golden tests); null to skip.</summary>
        public List<object[]> Log;

        public Canvas2D(int width, int height)
        {
            Width = width;
            Height = height;
        }

        // ---- state ----

        public string FillStyle
        {
            get => s.FillStyle;
            set
            {
                Set("fillStyle", value);
                if (CssColor.IsValid(value)) s.FillStyle = value;
            }
        }

        public string StrokeStyle
        {
            get => s.StrokeStyle;
            set
            {
                Set("strokeStyle", value);
                if (CssColor.IsValid(value)) s.StrokeStyle = value;
            }
        }

        public double LineWidth
        {
            get => s.LineWidth;
            set
            {
                Set("lineWidth", value);
                if (!double.IsNaN(value) && !double.IsInfinity(value) && value > 0) s.LineWidth = value;
            }
        }

        public string LineCap
        {
            get => s.LineCap;
            set
            {
                Set("lineCap", value);
                if (value == "butt" || value == "round" || value == "square") s.LineCap = value;
            }
        }

        public bool ImageSmoothingEnabled
        {
            get => s.ImageSmoothingEnabled;
            set
            {
                Set("imageSmoothingEnabled", value);
                s.ImageSmoothingEnabled = value;
            }
        }

        /// <summary>The current transform.</summary>
        public CanvasMatrix Transform => s.M;

        /// <summary>Clips in effect (each ClipPush not yet popped).</summary>
        public int ClipDepth => s.ClipDepth;

        public int SaveDepth => stack.Count;

        private void Set(string prop, object value) => Log?.Add(new object[] { "set", prop, value });

        private void Rec(params object[] call) => Log?.Add(call);

        public void Save()
        {
            Rec("save");
            stack.Push(s);
        }

        public void Restore()
        {
            Rec("restore");
            if (stack.Count == 0) return;
            State popped = stack.Pop();
            for (int i = popped.ClipDepth; i < s.ClipDepth; i++) Commands.Add(new ClipPopCommand { M = s.M });
            s = popped;
        }

        public void Translate(double x, double y)
        {
            Rec("translate", x, y);
            s.M = s.M.Translated(x, y);
        }

        public void Rotate(double angle)
        {
            Rec("rotate", angle);
            s.M = s.M.Rotated(angle);
        }

        public void Scale(double sx, double sy)
        {
            Rec("scale", sx, sy);
            s.M = s.M.Scaled(sx, sy);
        }

        // ---- path ----

        public void BeginPath()
        {
            Rec("beginPath");
            path.Clear();
            hasCurrent = false;
        }

        public void MoveTo(double x, double y)
        {
            Rec("moveTo", x, y);
            (curX, curY) = s.M.Apply(x, y);
            hasCurrent = true;
        }

        public void LineTo(double x, double y)
        {
            Rec("lineTo", x, y);
            var (px, py) = s.M.Apply(x, y);
            if (hasCurrent) path.Add(PathShape.Segment(curX, curY, px, py));
            (curX, curY, hasCurrent) = (px, py, true);
        }

        public void Rect(double x, double y, double w, double h)
        {
            Rec("rect", x, y, w, h);
            path.Add(PathShape.Rectangle(x, y, w, h, s.M));
            (curX, curY) = s.M.Apply(x, y);
            hasCurrent = true;
        }

        public void Arc(double x, double y, double r, double start, double end, bool ccw = false)
        {
            Rec("arc", x, y, r, start, end, ccw);
            var (sx, sy) = s.M.Apply(x + r * Math.Cos(start), y + r * Math.Sin(start));
            if (hasCurrent) path.Add(PathShape.Segment(curX, curY, sx, sy));
            path.Add(PathShape.ArcShape(x, y, r, start, end, ccw, s.M));
            (curX, curY) = s.M.Apply(x + r * Math.Cos(end), y + r * Math.Sin(end));
            hasCurrent = true;
        }

        public void Stroke()
        {
            Rec("stroke");
            if (path.Count == 0) return;
            Commands.Add(new StrokePathCommand
            {
                Color = s.StrokeStyle, Rgba = Parse(s.StrokeStyle), LineWidth = s.LineWidth, M = s.M, Shapes = path.ToArray(),
            });
        }

        public void Fill()
        {
            Rec("fill");
            if (path.Count == 0) return;
            Commands.Add(new FillPathCommand { Color = s.FillStyle, Rgba = Parse(s.FillStyle), M = s.M, Shapes = path.ToArray() });
        }

        public void Clip()
        {
            Rec("clip");
            Commands.Add(new ClipPushCommand { M = s.M, Shapes = path.ToArray() });
            s.ClipDepth++;
        }

        // ---- immediate ----

        public void ClearRect(double x, double y, double w, double h)
        {
            Rec("clearRect", x, y, w, h);
            Commands.Add(new ClearRectCommand { X = x, Y = y, W = w, H = h, M = s.M });
        }

        public void FillRect(double x, double y, double w, double h)
        {
            Rec("fillRect", x, y, w, h);
            Commands.Add(new FillRectCommand { Color = s.FillStyle, Rgba = Parse(s.FillStyle), X = x, Y = y, W = w, H = h, M = s.M });
        }

        public void StrokeRect(double x, double y, double w, double h)
        {
            Rec("strokeRect", x, y, w, h);
            Commands.Add(new StrokeRectCommand
            {
                Color = s.StrokeStyle, Rgba = Parse(s.StrokeStyle), LineWidth = s.LineWidth, X = x, Y = y, W = w, H = h, M = s.M,
            });
        }

        /// <summary>drawImage(image, dx, dy, dw, dh).</summary>
        public void DrawImage(object image, double dx, double dy, double dw, double dh)
        {
            Rec("drawImage", LabelOf(image), dx, dy, dw, dh);
            if (image is HudAtlasImage atlas)
            {
                var (w, h) = HudFontAtlas.AtlasSize(atlas.Font);
                AddGlyph(atlas, 0, 0, w, h, dx, dy, dw, dh);
                return;
            }
            Commands.Add(new ImageCommand { Image = image, Dx = dx, Dy = dy, Dw = dw, Dh = dh, Smooth = s.ImageSmoothingEnabled, M = s.M });
        }

        /// <summary>drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh); only atlases are drawn this way.</summary>
        public void DrawImage(HudAtlasImage image, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh)
        {
            Rec("drawImage", LabelOf(image), sx, sy, sw, sh, dx, dy, dw, dh);
            AddGlyph(image, sx, sy, sw, sh, dx, dy, dw, dh);
        }

        private void AddGlyph(HudAtlasImage image, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh)
        {
            CanvasColor tint = CanvasColor.White;
            if (image.Tint != null && CssColor.TryParse(image.Tint, out CanvasColor c)) tint = c;
            Commands.Add(new GlyphCommand
            {
                Font = image.Font, Tint = image.Tint, TintRgba = tint,
                Sx = sx, Sy = sy, Sw = sw, Sh = sh, Dx = dx, Dy = dy, Dw = dw, Dh = dh,
                Smooth = s.ImageSmoothingEnabled, M = s.M,
            });
        }

        /// <summary>The golden label of an image argument.</summary>
        public string LabelOf(object image)
        {
            if (image is HudAtlasImage atlas) return atlas.Label;
            if (!otherImages.TryGetValue(image, out string id))
            {
                id = "img" + otherImages.Count;
                otherImages[image] = id;
            }
            return id;
        }

        private static CanvasColor Parse(string css) => CssColor.TryParse(css, out CanvasColor c) ? c : CanvasColor.Black;
    }
}
