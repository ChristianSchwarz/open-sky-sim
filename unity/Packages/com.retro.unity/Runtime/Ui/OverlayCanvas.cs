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
    ///
    /// Everything lives in pooled flat buffers that keep their capacity from
    /// frame to frame: the overlay redraws every frame and must not feed the
    /// garbage collector.
    /// </summary>
    public sealed class OverlayCanvas : VisualElement
    {
        private const int ArcSegments = 48;

        private struct Prim
        {
            public int Start, Count;
            public bool Textured;
            public Color32 Color;
            public Texture Texture;
            public Rect Bounds;
            public bool Removed;
        }

        private readonly List<Prim> prims = new List<Prim>();
        private readonly List<Vector2> verts = new List<Vector2>();
        private readonly List<Vector2> uvs = new List<Vector2>();
        // A polygon being built, and two buffers the clipper ping-pongs between.
        private List<Vector2> poly = new List<Vector2>(), polyUv = new List<Vector2>();
        private List<Vector2> work = new List<Vector2>(), workUv = new List<Vector2>();
        private readonly List<Vector2> arc = new List<Vector2>();
        private readonly List<List<Vector2>> clipPool = new List<List<Vector2>>();
        private int clipDepth;
        private readonly Func<HudFont, Texture> atlas;
        private static readonly Color32 White = new Color32(255, 255, 255, 255);

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
            verts.Clear();
            uvs.Clear();
            clipDepth = 0;
            for (int i = 0; i < commands.Count; i++) Add(commands[i]);
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
                {
                    Color32 colour = C(s.Rgba);
                    for (int i = 0; i < s.Shapes.Length; i++) StrokeShape(s.Shapes[i], s.LineWidth, s.M, colour);
                    break;
                }
                case FillPathCommand f:
                {
                    Color32 colour = C(f.Rgba);
                    for (int i = 0; i < f.Shapes.Length; i++) FillShape(f.Shapes[i], colour);
                    break;
                }
                case GlyphCommand g:
                {
                    Texture tex = atlas(g.Font);
                    if (tex == null) break;
                    Color32 tint = g.Tint == null ? White : C(g.TintRgba);
                    AddTextured(g.Dx, g.Dy, g.Dw, g.Dh, g.M, tex,
                        g.Sx / tex.width, 1 - g.Sy / tex.height, (g.Sx + g.Sw) / tex.width, 1 - (g.Sy + g.Sh) / tex.height, tint);
                    break;
                }
                case ImageCommand im:
                    if (im.Image is Texture t) AddTextured(im.Dx, im.Dy, im.Dw, im.Dh, im.M, t, 0, 1, 1, 0, White);
                    break;
                case ClearRectCommand cl:
                    Clear(cl);
                    break;
                case ClipPushCommand cp:
                    PushClip(cp.Shapes);
                    break;
                case ClipPopCommand _:
                    if (clipDepth > 0) clipDepth--;
                    break;
            }
        }

        private void Quad(double x, double y, double w, double h, CanvasMatrix m)
        {
            poly.Clear();
            poly.Add(P(m.Apply(x, y)));
            poly.Add(P(m.Apply(x + w, y)));
            poly.Add(P(m.Apply(x + w, y + h)));
            poly.Add(P(m.Apply(x, y + h)));
        }

        private void AddRect(double x, double y, double w, double h, CanvasMatrix m, Color32 colour)
        {
            if (w == 0 || h == 0) return;
            if (w < 0) { x += w; w = -w; }
            if (h < 0) { y += h; h = -h; }
            Quad(x, y, w, h, m);
            Emit(false, colour, null);
        }

        private void AddTextured(double x, double y, double w, double h, CanvasMatrix m, Texture tex,
            double u0, double v0, double u1, double v1, Color32 tint)
        {
            Quad(x, y, w, h, m);
            polyUv.Clear();
            polyUv.Add(new Vector2((float)u0, (float)v0));
            polyUv.Add(new Vector2((float)u1, (float)v0));
            polyUv.Add(new Vector2((float)u1, (float)v1));
            polyUv.Add(new Vector2((float)u0, (float)v1));
            Emit(true, tint, tex);
        }

        /// <summary>A butt-capped segment between device points, the line's width measured in user units of m.</summary>
        private void Segment(double x0, double y0, double x1, double y1, double width, CanvasMatrix m, Color32 colour)
        {
            if (x0 == x1 && y0 == y1) return;
            (double x, double y)[] q = CanvasCommandPainter.SegmentQuad(x0, y0, x1, y1, width, m);
            poly.Clear();
            for (int i = 0; i < 4; i++) poly.Add(P(q[i]));
            Emit(false, colour, null);
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
                    ArcPoints(s.Cx, s.Cy, s.R, s.Start, s.End, s.Ccw, s.M);
                    for (int i = 1; i < arc.Count; i++) Segment(arc[i - 1].x, arc[i - 1].y, arc[i].x, arc[i].y, width, m, colour);
                    break;
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
                    ArcPoints(s.Cx, s.Cy, s.R, s.Start, s.End, s.Ccw, s.M);
                    poly.Clear();
                    poly.Add(P(s.M.Apply(s.Cx, s.Cy)));
                    poly.AddRange(arc);
                    Emit(false, colour, null);
                    break;
            }
        }

        /// <summary>An arc's outline in device space into <see cref="arc"/> (start to end, ccw as given; a full turn for a circle).</summary>
        private void ArcPoints(double cx, double cy, double r, double start, double end, bool ccw, CanvasMatrix m)
        {
            double sweep = ccw ? start - end : end - start;
            if (sweep < 0 || sweep > 2 * Math.PI) sweep = 2 * Math.PI;
            int n = Math.Max(2, (int)Math.Ceiling(ArcSegments * sweep / (2 * Math.PI)));
            arc.Clear();
            for (int i = 0; i <= n; i++)
            {
                double t = start + (ccw ? -1 : 1) * sweep * i / n;
                arc.Add(P(m.Apply(cx + r * Math.Cos(t), cy + r * Math.Sin(t))));
            }
        }

        /// <summary>strokeRect: the outline grown and shrunk by half the width, mitred (top and bottom carry the corners).</summary>
        private void StrokeRect(StrokeRectCommand s)
        {
            double x = s.X, y = s.Y, w = s.W, h = s.H, lw = s.LineWidth;
            Color32 colour = C(s.Rgba);
            if (w == 0 && h == 0) return;
            if (w == 0 || h == 0)
            {
                (double x, double y) a = s.M.Apply(x, y), b = s.M.Apply(x + w, y + h);
                Segment(a.x, a.y, b.x, b.y, lw, s.M, colour);
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
        private void PushClip(PathShape[] shapes)
        {
            if (clipPool.Count <= clipDepth) clipPool.Add(new List<Vector2>());
            List<Vector2> clip = clipPool[clipDepth++];
            clip.Clear();
            foreach (PathShape s in shapes)
            {
                if (s.Kind == PathShapeKind.Rect)
                {
                    clip.Add(P(s.M.Apply(s.X, s.Y)));
                    clip.Add(P(s.M.Apply(s.X + s.W, s.Y)));
                    clip.Add(P(s.M.Apply(s.X + s.W, s.Y + s.H)));
                    clip.Add(P(s.M.Apply(s.X, s.Y + s.H)));
                    return;
                }
                if (s.Kind == PathShapeKind.Arc)
                {
                    ArcPoints(s.Cx, s.Cy, s.R, 0, 2 * Math.PI, false, s.M);
                    for (int i = 0; i < arc.Count - 1; i++) clip.Add(arc[i]);
                    return;
                }
            }
        }

        /// <summary>The polygon in <see cref="poly"/> (and <see cref="polyUv"/>), clipped, appended as a primitive.</summary>
        private void Emit(bool textured, Color32 colour, Texture tex)
        {
            for (int c = 0; c < clipDepth; c++)
            {
                List<Vector2> clip = clipPool[c];
                if (clip.Count < 3) return;
                ClipConvex(textured, clip);
                if (poly.Count < 3) return;
            }
            if (poly.Count < 3) return;
            Vector2 min = poly[0], max = poly[0];
            for (int i = 0; i < poly.Count; i++)
            {
                min = Vector2.Min(min, poly[i]);
                max = Vector2.Max(max, poly[i]);
            }
            prims.Add(new Prim
            {
                Start = verts.Count, Count = poly.Count, Textured = textured, Color = colour, Texture = tex,
                Bounds = Rect.MinMaxRect(min.x, min.y, max.x, max.y),
            });
            verts.AddRange(poly);
            if (textured) uvs.AddRange(polyUv);
            else for (int i = 0; i < poly.Count; i++) uvs.Add(Vector2.zero);
        }

        /// <summary>Sutherland-Hodgman of <see cref="poly"/> against a convex polygon of either winding, carrying the UVs.</summary>
        private void ClipConvex(bool textured, List<Vector2> clip)
        {
            float area = 0;
            for (int i = 0; i < clip.Count; i++)
            {
                Vector2 a = clip[i], b = clip[(i + 1) % clip.Count];
                area += a.x * b.y - b.x * a.y;
            }
            float sign = area >= 0 ? 1 : -1;
            for (int e = 0; e < clip.Count && poly.Count > 0; e++)
            {
                Vector2 a = clip[e], b = clip[(e + 1) % clip.Count];
                work.Clear();
                workUv.Clear();
                for (int i = 0; i < poly.Count; i++)
                {
                    int j = (i + 1) % poly.Count;
                    float si = sign * ((b.x - a.x) * (poly[i].y - a.y) - (b.y - a.y) * (poly[i].x - a.x));
                    float sj = sign * ((b.x - a.x) * (poly[j].y - a.y) - (b.y - a.y) * (poly[j].x - a.x));
                    if (si >= 0)
                    {
                        work.Add(poly[i]);
                        if (textured) workUv.Add(polyUv[i]);
                    }
                    if ((si >= 0) != (sj >= 0))
                    {
                        float t = si / (si - sj);
                        work.Add(Vector2.Lerp(poly[i], poly[j], t));
                        if (textured) workUv.Add(Vector2.Lerp(polyUv[i], polyUv[j], t));
                    }
                }
                (poly, work) = (work, poly);
                (polyUv, workUv) = (workUv, polyUv);
            }
        }

        /// <summary>clearRect: what lies wholly inside the rectangle goes.</summary>
        private void Clear(ClearRectCommand cl)
        {
            (double x, double y) a = cl.M.Apply(cl.X, cl.Y), b = cl.M.Apply(cl.X + cl.W, cl.Y + cl.H);
            Rect r = Rect.MinMaxRect((float)Math.Min(a.x, b.x), (float)Math.Min(a.y, b.y), (float)Math.Max(a.x, b.x), (float)Math.Max(a.y, b.y));
            for (int i = 0; i < prims.Count; i++)
            {
                Prim p = prims[i];
                if (!p.Removed && r.Contains(p.Bounds.min) && r.Contains(p.Bounds.max))
                {
                    p.Removed = true;
                    prims[i] = p;
                }
            }
        }

        private void Generate(MeshGenerationContext mgc)
        {
            int i = 0;
            while (i < prims.Count)
            {
                if (prims[i].Removed)
                {
                    i++;
                    continue;
                }
                // A run of primitives on one texture, under the 16-bit index limit.
                Texture tex = prims[i].Texture;
                int vertices = 0, indices = 0, j = i;
                while (j < prims.Count && (prims[j].Removed || (prims[j].Texture == tex && vertices + prims[j].Count < 60000)))
                {
                    if (!prims[j].Removed)
                    {
                        vertices += prims[j].Count;
                        indices += (prims[j].Count - 2) * 3;
                    }
                    j++;
                }
                MeshWriteData mesh = mgc.Allocate(vertices, indices, tex);
                ushort baseIndex = 0;
                for (int k = i; k < j; k++)
                {
                    Prim p = prims[k];
                    if (p.Removed) continue;
                    float area = 0;
                    for (int v = 0; v < p.Count; v++)
                    {
                        Vector2 pos = verts[p.Start + v];
                        mesh.SetNextVertex(new Vertex
                        {
                            position = new Vector3(pos.x, pos.y, Vertex.nearZ),
                            tint = p.Color,
                            uv = uvs[p.Start + v],
                        });
                        Vector2 next = verts[p.Start + (v + 1) % p.Count];
                        area += pos.x * next.y - next.x * pos.y;
                    }
                    // A fan, wound one way or the other by the polygon's own orientation.
                    for (int v = 1; v < p.Count - 1; v++)
                    {
                        mesh.SetNextIndex(baseIndex);
                        mesh.SetNextIndex((ushort)(baseIndex + (area >= 0 ? v : v + 1)));
                        mesh.SetNextIndex((ushort)(baseIndex + (area >= 0 ? v + 1 : v)));
                    }
                    baseIndex += (ushort)p.Count;
                }
                i = j;
            }
        }
    }
}
