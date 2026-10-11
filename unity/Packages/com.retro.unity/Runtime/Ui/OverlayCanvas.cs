using System;
using System.Collections.Generic;
using Retro.Game;
using UnityEngine;
using UnityEngine.UIElements;

namespace Retro.Unity
{
    /// <summary>
    /// The 2D overlay canvas (renderer.ts render2D's canvas, composited over
    /// the 3D view): a UI Toolkit element on a pixel-exact panel that draws a
    /// frame's <see cref="CanvasCommand"/> list from the ported
    /// <see cref="CanvasCommandPainter"/> as one mesh, in painter order.
    /// Strokes become butt-capped segment quads, fills quads and fans, glyphs
    /// and images textured quads (nearest-sampled), all clipped on the CPU
    /// to the clip stack (convex: a rectangle or a circle, as the overlay
    /// code uses them). Edges are not antialiased: at the widths the HUD draws
    /// (1 px and odd multiples, pixel-centred) the browser's are crisp too.
    /// A clearRect erases what was drawn before it inside its rectangle (the
    /// cockpit's window onto the target camera).
    /// </summary>
    public sealed class OverlayCanvas : VisualElement
    {
        private const int ArcSegments = 48;

        private sealed class Prim
        {
            public List<Vector2> Points;
            public List<Vector2> Uvs;
            public Color32 Color;
            public Texture Texture;
            public Rect Bounds;
        }

        private readonly List<Prim> prims = new List<Prim>();
        private readonly List<List<Vector2>> clips = new List<List<Vector2>>();
        private readonly Func<HudFont, Texture> atlas;

        /// <summary>Primitives in the last frame (for stats).</summary>
        public int PrimitiveCount => prims.Count;

        public OverlayCanvas(Func<HudFont, Texture> atlas)
        {
            this.atlas = atlas;
            pickingMode = PickingMode.Ignore;
            style.position = Position.Absolute;
            style.left = style.top = style.right = style.bottom = 0;
            generateVisualContent += Generate;
        }

        /// <summary>Turn a frame's commands into clipped primitives and ask for a repaint.</summary>
        public void SetCommands(IReadOnlyList<CanvasCommand> commands)
        {
            prims.Clear();
            clips.Clear();
            foreach (CanvasCommand c in commands) Add(c);
            MarkDirtyRepaint();
        }

        private static Vector2 P((double x, double y) p) => new Vector2((float)p.x, (float)p.y);
        private static Color32 C(CanvasColor c) => new Color32(B(c.R), B(c.G), B(c.B), B(c.A));
        private static byte B(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(v * 255), 0, 255);

        private void Add(CanvasCommand cmd)
        {
            switch (cmd)
            {
                case FillRectCommand f:
                    AddRect(f.X, f.Y, f.W, f.H, f.M, C(f.Rgba));
                    break;
                case StrokeRectCommand s:
                    StrokeRect(s);
                    break;
                case StrokePathCommand s:
                    foreach (PathShape shape in s.Shapes) StrokeShape(shape, s.LineWidth, s.M, C(s.Rgba));
                    break;
                case FillPathCommand f:
                    foreach (PathShape shape in f.Shapes) FillShape(shape, C(f.Rgba));
                    break;
                case GlyphCommand g:
                {
                    Texture tex = atlas(g.Font);
                    if (tex == null) break;
                    Color32 tint = g.Tint == null ? new Color32(255, 255, 255, 255) : C(g.TintRgba);
                    AddTextured(g.Dx, g.Dy, g.Dw, g.Dh, g.M, tex,
                        g.Sx / tex.width, 1 - g.Sy / tex.height, (g.Sx + g.Sw) / tex.width, 1 - (g.Sy + g.Sh) / tex.height, tint);
                    break;
                }
                case ImageCommand im:
                    if (im.Image is Texture t) AddTextured(im.Dx, im.Dy, im.Dw, im.Dh, im.M, t, 0, 1, 1, 0, new Color32(255, 255, 255, 255));
                    break;
                case ClearRectCommand cl:
                    Clear(cl);
                    break;
                case ClipPushCommand cp:
                    clips.Add(ClipPolygon(cp.Shapes));
                    break;
                case ClipPopCommand _:
                    if (clips.Count > 0) clips.RemoveAt(clips.Count - 1);
                    break;
            }
        }

        private void AddRect(double x, double y, double w, double h, CanvasMatrix m, Color32 colour)
        {
            if (w == 0 || h == 0) return;
            if (w < 0) { x += w; w = -w; }
            if (h < 0) { y += h; h = -h; }
            Emit(new List<Vector2> { P(m.Apply(x, y)), P(m.Apply(x + w, y)), P(m.Apply(x + w, y + h)), P(m.Apply(x, y + h)) }, null, colour, null);
        }

        private void AddTextured(double x, double y, double w, double h, CanvasMatrix m, Texture tex,
            double u0, double v0, double u1, double v1, Color32 tint)
        {
            var pts = new List<Vector2> { P(m.Apply(x, y)), P(m.Apply(x + w, y)), P(m.Apply(x + w, y + h)), P(m.Apply(x, y + h)) };
            var uvs = new List<Vector2>
            {
                new Vector2((float)u0, (float)v0), new Vector2((float)u1, (float)v0),
                new Vector2((float)u1, (float)v1), new Vector2((float)u0, (float)v1),
            };
            Emit(pts, uvs, tint, tex);
        }

        /// <summary>A butt-capped segment between device points, the line's width measured in user units of m.</summary>
        private void Segment(double x0, double y0, double x1, double y1, double width, CanvasMatrix m, Color32 colour)
        {
            if (x0 == x1 && y0 == y1) return;
            (double x, double y)[] q = CanvasCommandPainter.SegmentQuad(x0, y0, x1, y1, width, m);
            Emit(new List<Vector2> { P(q[0]), P(q[1]), P(q[2]), P(q[3]) }, null, colour, null);
        }

        private void StrokeShape(PathShape s, double width, CanvasMatrix m, Color32 colour)
        {
            switch (s.Kind)
            {
                case PathShapeKind.Segment:
                    Segment(s.X0, s.Y0, s.X1, s.Y1, width, m, colour);
                    break;
                case PathShapeKind.Rect:
                {
                    (double x, double y) a = s.M.Apply(s.X, s.Y), b = s.M.Apply(s.X + s.W, s.Y);
                    (double x, double y) c = s.M.Apply(s.X + s.W, s.Y + s.H), d = s.M.Apply(s.X, s.Y + s.H);
                    Segment(a.x, a.y, b.x, b.y, width, m, colour);
                    Segment(b.x, b.y, c.x, c.y, width, m, colour);
                    Segment(c.x, c.y, d.x, d.y, width, m, colour);
                    Segment(d.x, d.y, a.x, a.y, width, m, colour);
                    break;
                }
                default:
                {
                    List<(double x, double y)> arc = ArcPoints(s);
                    for (int i = 1; i < arc.Count; i++) Segment(arc[i - 1].x, arc[i - 1].y, arc[i].x, arc[i].y, width, m, colour);
                    break;
                }
            }
        }

        private void FillShape(PathShape s, Color32 colour)
        {
            switch (s.Kind)
            {
                case PathShapeKind.Rect:
                    AddRect(s.X, s.Y, s.W, s.H, s.M, colour);
                    break;
                case PathShapeKind.Arc:
                {
                    var pts = new List<Vector2> { P(s.M.Apply(s.Cx, s.Cy)) };
                    foreach ((double x, double y) p in ArcPoints(s)) pts.Add(P(p));
                    Emit(pts, null, colour, null);
                    break;
                }
            }
        }

        /// <summary>An arc's outline in device space (start to end, ccw as given; a full turn for a circle).</summary>
        private static List<(double x, double y)> ArcPoints(PathShape s)
        {
            double start = s.Start, end = s.End;
            double sweep = s.Ccw ? start - end : end - start;
            if (sweep < 0 || sweep > 2 * Math.PI) sweep = 2 * Math.PI;
            int n = Math.Max(2, (int)Math.Ceiling(ArcSegments * sweep / (2 * Math.PI)));
            var pts = new List<(double, double)>(n + 1);
            for (int i = 0; i <= n; i++)
            {
                double t = start + (s.Ccw ? -1 : 1) * sweep * i / n;
                pts.Add(s.M.Apply(s.Cx + s.R * Math.Cos(t), s.Cy + s.R * Math.Sin(t)));
            }
            return pts;
        }

        /// <summary>strokeRect: the outline grown and shrunk by half the width, mitred (top and bottom carry the corners).</summary>
        private void StrokeRect(StrokeRectCommand s)
        {
            double x = s.X, y = s.Y, w = s.W, h = s.H, lw = s.LineWidth;
            Color32 colour = C(s.Rgba);
            if (w == 0 && h == 0) return;
            if (w == 0 || h == 0)
            {
                Segment(s.M.Apply(x, y).Item1, s.M.Apply(x, y).Item2, s.M.Apply(x + w, y + h).Item1, s.M.Apply(x + w, y + h).Item2, lw, s.M, colour);
                return;
            }
            if (w < 0) { x += w; w = -w; }
            if (h < 0) { y += h; h = -h; }
            double half = lw / 2;
            AddRect(x - half, y - half, w + lw, lw, s.M, colour);
            AddRect(x - half, y + h - half, w + lw, lw, s.M, colour);
            if (h - lw > 0)
            {
                AddRect(x - half, y + half, lw, h - lw, s.M, colour);
                AddRect(x + w - half, y + half, lw, h - lw, s.M, colour);
            }
        }

        /// <summary>A clip region as a convex device polygon: the first shape's rectangle or circle; none clips all.</summary>
        private static List<Vector2> ClipPolygon(PathShape[] shapes)
        {
            foreach (PathShape s in shapes)
            {
                if (s.Kind == PathShapeKind.Rect)
                {
                    return new List<Vector2>
                    {
                        P(s.M.Apply(s.X, s.Y)), P(s.M.Apply(s.X + s.W, s.Y)),
                        P(s.M.Apply(s.X + s.W, s.Y + s.H)), P(s.M.Apply(s.X, s.Y + s.H)),
                    };
                }
                if (s.Kind == PathShapeKind.Arc)
                {
                    var pts = new List<Vector2>();
                    var full = PathShape.ArcShape(s.Cx, s.Cy, s.R, 0, 2 * Math.PI, false, s.M);
                    List<(double x, double y)> arc = ArcPoints(full);
                    for (int i = 0; i < arc.Count - 1; i++) pts.Add(P(arc[i]));
                    return pts;
                }
            }
            return new List<Vector2>();
        }

        private void Emit(List<Vector2> pts, List<Vector2> uvs, Color32 colour, Texture tex)
        {
            foreach (List<Vector2> clip in clips)
            {
                if (clip.Count < 3) return;
                (pts, uvs) = ClipConvex(pts, uvs, clip);
                if (pts.Count < 3) return;
            }
            if (pts.Count < 3) return;
            Vector2 min = pts[0], max = pts[0];
            foreach (Vector2 p in pts)
            {
                min = Vector2.Min(min, p);
                max = Vector2.Max(max, p);
            }
            prims.Add(new Prim { Points = pts, Uvs = uvs, Color = colour, Texture = tex, Bounds = Rect.MinMaxRect(min.x, min.y, max.x, max.y) });
        }

        /// <summary>Sutherland-Hodgman against a convex polygon of either winding, carrying the UVs.</summary>
        private static (List<Vector2>, List<Vector2>) ClipConvex(List<Vector2> pts, List<Vector2> uvs, List<Vector2> clip)
        {
            float area = 0;
            for (int i = 0; i < clip.Count; i++)
            {
                Vector2 a = clip[i], b = clip[(i + 1) % clip.Count];
                area += a.x * b.y - b.x * a.y;
            }
            float sign = area >= 0 ? 1 : -1;
            for (int e = 0; e < clip.Count && pts.Count > 0; e++)
            {
                Vector2 a = clip[e], b = clip[(e + 1) % clip.Count];
                var outPts = new List<Vector2>();
                var outUvs = uvs != null ? new List<Vector2>() : null;
                float Side(Vector2 p) => sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
                for (int i = 0; i < pts.Count; i++)
                {
                    int j = (i + 1) % pts.Count;
                    float si = Side(pts[i]), sj = Side(pts[j]);
                    if (si >= 0)
                    {
                        outPts.Add(pts[i]);
                        outUvs?.Add(uvs[i]);
                    }
                    if ((si >= 0) != (sj >= 0))
                    {
                        float t = si / (si - sj);
                        outPts.Add(Vector2.Lerp(pts[i], pts[j], t));
                        outUvs?.Add(Vector2.Lerp(uvs[i], uvs[j], t));
                    }
                }
                pts = outPts;
                uvs = outUvs;
            }
            return (pts, uvs);
        }

        /// <summary>clearRect: what lies wholly inside goes; the rest is cut back to outside the rectangle where it is a quad astride an edge.</summary>
        private void Clear(ClearRectCommand cl)
        {
            (double x, double y) a = cl.M.Apply(cl.X, cl.Y), b = cl.M.Apply(cl.X + cl.W, cl.Y + cl.H);
            Rect r = Rect.MinMaxRect((float)Math.Min(a.x, b.x), (float)Math.Min(a.y, b.y), (float)Math.Max(a.x, b.x), (float)Math.Max(a.y, b.y));
            prims.RemoveAll(p => r.Contains(p.Bounds.min) && r.Contains(p.Bounds.max));
        }

        private void Generate(MeshGenerationContext mgc)
        {
            int i = 0;
            while (i < prims.Count)
            {
                // A run of primitives on one texture, under the 16-bit index limit.
                Texture tex = prims[i].Texture;
                int vertices = 0, indices = 0, j = i;
                while (j < prims.Count && prims[j].Texture == tex && vertices + prims[j].Points.Count < 60000)
                {
                    vertices += prims[j].Points.Count;
                    indices += (prims[j].Points.Count - 2) * 3;
                    j++;
                }
                MeshWriteData mesh = mgc.Allocate(vertices, indices, tex);
                ushort baseIndex = 0;
                for (int k = i; k < j; k++)
                {
                    Prim p = prims[k];
                    for (int v = 0; v < p.Points.Count; v++)
                    {
                        mesh.SetNextVertex(new Vertex
                        {
                            position = new Vector3(p.Points[v].x, p.Points[v].y, Vertex.nearZ),
                            tint = p.Color,
                            uv = p.Uvs != null ? p.Uvs[v] : Vector2.zero,
                        });
                    }
                    // UI Toolkit wants clockwise triangles (y down); fan both ways round by area sign.
                    float area = 0;
                    for (int v = 0; v < p.Points.Count; v++)
                    {
                        Vector2 a = p.Points[v], b = p.Points[(v + 1) % p.Points.Count];
                        area += a.x * b.y - b.x * a.y;
                    }
                    for (int v = 1; v < p.Points.Count - 1; v++)
                    {
                        if (area >= 0)
                        {
                            mesh.SetNextIndex(baseIndex);
                            mesh.SetNextIndex((ushort)(baseIndex + v));
                            mesh.SetNextIndex((ushort)(baseIndex + v + 1));
                        }
                        else
                        {
                            mesh.SetNextIndex(baseIndex);
                            mesh.SetNextIndex((ushort)(baseIndex + v + 1));
                            mesh.SetNextIndex((ushort)(baseIndex + v));
                        }
                    }
                    baseIndex += (ushort)p.Points.Count;
                }
                i = j;
            }
        }
    }
}
