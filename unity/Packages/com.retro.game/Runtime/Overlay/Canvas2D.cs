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

        /// <summary>
        /// Recycled command and shape objects: a frame's commands are used up before the
        /// next frame begins (<see cref="BeginFrame"/>), so the overlay, which repaints every
        /// frame, allocates nothing once the pools have grown to a frame's needs.
        /// </summary>
        private sealed class Pool<T> where T : class, new()
        {
            private readonly List<T> items = new List<T>();
            private int used;

            public T Get()
            {
                if (used < items.Count) return items[used++];
                var t = new T();
                items.Add(t);
                used++;
                return t;
            }

            public void Reset() => used = 0;
        }

        /// <summary>Shape arrays by length, reused frame to frame.</summary>
        private sealed class ArrayPool
        {
            private readonly Dictionary<int, List<PathShape[]>> byLength = new Dictionary<int, List<PathShape[]>>();
            private readonly Dictionary<int, int> used = new Dictionary<int, int>();

            public PathShape[] Copy(List<PathShape> path)
            {
                int n = path.Count;
                if (!byLength.TryGetValue(n, out List<PathShape[]> list))
                {
                    list = new List<PathShape[]>();
                    byLength[n] = list;
                }
                used.TryGetValue(n, out int u);
                PathShape[] a;
                if (u < list.Count) a = list[u];
                else
                {
                    a = new PathShape[n];
                    list.Add(a);
                }
                used[n] = u + 1;
                path.CopyTo(a);
                return a;
            }

            public void Reset() => used.Clear();
        }

        private readonly Pool<PathShape> shapes = new Pool<PathShape>();
        private readonly ArrayPool shapeArrays = new ArrayPool();
        private readonly Pool<StrokePathCommand> strokePaths = new Pool<StrokePathCommand>();
        private readonly Pool<FillPathCommand> fillPaths = new Pool<FillPathCommand>();
        private readonly Pool<ClipPushCommand> clipPushes = new Pool<ClipPushCommand>();
        private readonly Pool<ClipPopCommand> clipPops = new Pool<ClipPopCommand>();
        private readonly Pool<ClearRectCommand> clearRects = new Pool<ClearRectCommand>();
        private readonly Pool<FillRectCommand> fillRects = new Pool<FillRectCommand>();
        private readonly Pool<StrokeRectCommand> strokeRects = new Pool<StrokeRectCommand>();
        private readonly Pool<ImageCommand> images = new Pool<ImageCommand>();
        private readonly Pool<GlyphCommand> glyphs = new Pool<GlyphCommand>();

        /// <summary>Drop last frame's commands and hand their objects back to the pools.</summary>
        public void BeginFrame()
        {
            Commands.Clear();
            shapes.Reset();
            shapeArrays.Reset();
            strokePaths.Reset();
            fillPaths.Reset();
            clipPushes.Reset();
            clipPops.Reset();
            clearRects.Reset();
            fillRects.Reset();
            strokeRects.Reset();
            images.Reset();
            glyphs.Reset();
        }

        private PathShape Segment(double x0, double y0, double x1, double y1)
        {
            PathShape p = shapes.Get();
            p.Kind = PathShapeKind.Segment;
            p.X0 = x0; p.Y0 = y0; p.X1 = x1; p.Y1 = y1;
            p.X = p.Y = p.W = p.H = 0;
            p.Cx = p.Cy = p.R = p.Start = p.End = 0;
            p.Ccw = false;
            p.M = CanvasMatrix.Identity;
            return p;
        }

        private PathShape RectShape(double x, double y, double w, double h, CanvasMatrix m)
        {
            PathShape p = shapes.Get();
            p.Kind = PathShapeKind.Rect;
            p.X0 = p.Y0 = p.X1 = p.Y1 = 0;
            p.X = x; p.Y = y; p.W = w; p.H = h;
            p.Cx = p.Cy = p.R = p.Start = p.End = 0;
            p.Ccw = false;
            p.M = m;
            return p;
        }

        private PathShape ArcShape(double cx, double cy, double r, double start, double end, bool ccw, CanvasMatrix m)
        {
            PathShape p = shapes.Get();
            p.Kind = PathShapeKind.Arc;
            p.X0 = p.Y0 = p.X1 = p.Y1 = 0;
            p.X = p.Y = p.W = p.H = 0;
            p.Cx = cx; p.Cy = cy; p.R = r; p.Start = start; p.End = end;
            p.Ccw = ccw;
            p.M = m;
            return p;
        }

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
                if (Log != null) Set("fillStyle", value);
                if (CssColor.IsValid(value)) s.FillStyle = value;
            }
        }

        public string StrokeStyle
        {
            get => s.StrokeStyle;
            set
            {
                if (Log != null) Set("strokeStyle", value);
                if (CssColor.IsValid(value)) s.StrokeStyle = value;
            }
        }

        public double LineWidth
        {
            get => s.LineWidth;
            set
            {
                if (Log != null) Set("lineWidth", value);
                if (!double.IsNaN(value) && !double.IsInfinity(value) && value > 0) s.LineWidth = value;
            }
        }

        public string LineCap
        {
            get => s.LineCap;
            set
            {
                if (Log != null) Set("lineCap", value);
                if (value == "butt" || value == "round" || value == "square") s.LineCap = value;
            }
        }

        public bool ImageSmoothingEnabled
        {
            get => s.ImageSmoothingEnabled;
            set
            {
                if (Log != null) Set("imageSmoothingEnabled", value);
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
            if (Log != null) Rec("save");
            stack.Push(s);
        }

        public void Restore()
        {
            if (Log != null) Rec("restore");
            if (stack.Count == 0) return;
            State popped = stack.Pop();
            for (int i = popped.ClipDepth; i < s.ClipDepth; i++)
            {
                ClipPopCommand pop = clipPops.Get();
                pop.M = s.M;
                Commands.Add(pop);
            }
            s = popped;
        }

        public void Translate(double x, double y)
        {
            if (Log != null) Rec("translate", x, y);
            s.M = s.M.Translated(x, y);
        }

        public void Rotate(double angle)
        {
            if (Log != null) Rec("rotate", angle);
            s.M = s.M.Rotated(angle);
        }

        public void Scale(double sx, double sy)
        {
            if (Log != null) Rec("scale", sx, sy);
            s.M = s.M.Scaled(sx, sy);
        }

        // ---- path ----

        public void BeginPath()
        {
            if (Log != null) Rec("beginPath");
            path.Clear();
            hasCurrent = false;
        }

        public void MoveTo(double x, double y)
        {
            if (Log != null) Rec("moveTo", x, y);
            (curX, curY) = s.M.Apply(x, y);
            hasCurrent = true;
        }

        public void LineTo(double x, double y)
        {
            if (Log != null) Rec("lineTo", x, y);
            var (px, py) = s.M.Apply(x, y);
            if (hasCurrent) path.Add(Segment(curX, curY, px, py));
            (curX, curY, hasCurrent) = (px, py, true);
        }

        public void Rect(double x, double y, double w, double h)
        {
            if (Log != null) Rec("rect", x, y, w, h);
            path.Add(RectShape(x, y, w, h, s.M));
            (curX, curY) = s.M.Apply(x, y);
            hasCurrent = true;
        }

        public void Arc(double x, double y, double r, double start, double end, bool ccw = false)
        {
            if (Log != null) Rec("arc", x, y, r, start, end, ccw);
            var (sx, sy) = s.M.Apply(x + r * Math.Cos(start), y + r * Math.Sin(start));
            if (hasCurrent) path.Add(Segment(curX, curY, sx, sy));
            path.Add(ArcShape(x, y, r, start, end, ccw, s.M));
            (curX, curY) = s.M.Apply(x + r * Math.Cos(end), y + r * Math.Sin(end));
            hasCurrent = true;
        }

        public void Stroke()
        {
            if (Log != null) Rec("stroke");
            if (path.Count == 0) return;
            StrokePathCommand c = strokePaths.Get();
            c.Color = s.StrokeStyle;
            c.Rgba = Parse(s.StrokeStyle);
            c.LineWidth = s.LineWidth;
            c.M = s.M;
            c.Shapes = shapeArrays.Copy(path);
            Commands.Add(c);
        }

        public void Fill()
        {
            if (Log != null) Rec("fill");
            if (path.Count == 0) return;
            FillPathCommand c = fillPaths.Get();
            c.Color = s.FillStyle;
            c.Rgba = Parse(s.FillStyle);
            c.M = s.M;
            c.Shapes = shapeArrays.Copy(path);
            Commands.Add(c);
        }

        public void Clip()
        {
            if (Log != null) Rec("clip");
            ClipPushCommand c = clipPushes.Get();
            c.M = s.M;
            c.Shapes = shapeArrays.Copy(path);
            Commands.Add(c);
            s.ClipDepth++;
        }

        // ---- immediate ----

        public void ClearRect(double x, double y, double w, double h)
        {
            if (Log != null) Rec("clearRect", x, y, w, h);
            ClearRectCommand c = clearRects.Get();
            c.X = x; c.Y = y; c.W = w; c.H = h;
            c.M = s.M;
            Commands.Add(c);
        }

        public void FillRect(double x, double y, double w, double h)
        {
            if (Log != null) Rec("fillRect", x, y, w, h);
            FillRectCommand c = fillRects.Get();
            c.Color = s.FillStyle;
            c.Rgba = Parse(s.FillStyle);
            c.X = x; c.Y = y; c.W = w; c.H = h;
            c.M = s.M;
            Commands.Add(c);
        }

        public void StrokeRect(double x, double y, double w, double h)
        {
            if (Log != null) Rec("strokeRect", x, y, w, h);
            StrokeRectCommand c = strokeRects.Get();
            c.Color = s.StrokeStyle;
            c.Rgba = Parse(s.StrokeStyle);
            c.LineWidth = s.LineWidth;
            c.X = x; c.Y = y; c.W = w; c.H = h;
            c.M = s.M;
            Commands.Add(c);
        }

        /// <summary>drawImage(image, dx, dy, dw, dh).</summary>
        public void DrawImage(object image, double dx, double dy, double dw, double dh)
        {
            if (Log != null) Rec("drawImage", LabelOf(image), dx, dy, dw, dh);
            if (image is HudAtlasImage atlas)
            {
                var (w, h) = HudFontAtlas.AtlasSize(atlas.Font);
                AddGlyph(atlas, 0, 0, w, h, dx, dy, dw, dh);
                return;
            }
            ImageCommand c = images.Get();
            c.Image = image;
            c.Dx = dx; c.Dy = dy; c.Dw = dw; c.Dh = dh;
            c.Smooth = s.ImageSmoothingEnabled;
            c.M = s.M;
            Commands.Add(c);
        }

        /// <summary>drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh); only atlases are drawn this way.</summary>
        public void DrawImage(HudAtlasImage image, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh)
        {
            if (Log != null) Rec("drawImage", LabelOf(image), sx, sy, sw, sh, dx, dy, dw, dh);
            AddGlyph(image, sx, sy, sw, sh, dx, dy, dw, dh);
        }

        private void AddGlyph(HudAtlasImage image, double sx, double sy, double sw, double sh, double dx, double dy, double dw, double dh)
        {
            CanvasColor tint = CanvasColor.White;
            if (image.Tint != null && CssColor.TryParse(image.Tint, out CanvasColor c)) tint = c;
            GlyphCommand g = glyphs.Get();
            g.Font = image.Font;
            g.Tint = image.Tint;
            g.TintRgba = tint;
            g.Sx = sx; g.Sy = sy; g.Sw = sw; g.Sh = sh;
            g.Dx = dx; g.Dy = dy; g.Dw = dw; g.Dh = dh;
            g.Smooth = s.ImageSmoothingEnabled;
            g.M = s.M;
            Commands.Add(g);
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
