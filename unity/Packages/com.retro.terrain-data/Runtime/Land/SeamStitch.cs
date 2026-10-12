using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// One drawn tile as the seam stitcher sees it: the TileMeshes fields
    /// seamStitch.ts reads, on plain arrays. The caller owns the arrays; the
    /// stitcher mutates <see cref="Positions"/> (and <see cref="SmoothPositions"/>)
    /// in place and keeps its bookkeeping in <see cref="Seam"/>, so keep one
    /// StitchTile per resident tile for the tile's lifetime.
    /// </summary>
    public sealed class StitchTile
    {
        public TileKey Id;
        /// <summary>The PTM border table; null for a tile baked without one (it neither moves nor masters).</summary>
        public PtmBorder Border;
        /// <summary>
        /// The tile group's local matrix, compose(position, quaternion, scale) as
        /// buildTileMeshes sets it: quantised land units to the drawing frame.
        /// Only the relative transform between neighbours is used.
        /// </summary>
        public Mat4d Matrix;
        /// <summary>The group's uniform scale (quantScale): metres per position unit.</summary>
        public double Scale;
        /// <summary>The LIVE faceted land soup, xyz per vertex; a copy of the decoded array. Mutated in place.</summary>
        public short[] Positions;
        /// <summary>Faceted land normals, stride 4, after LandMesh.LeanEdgeNormals; the fill copies them. May be null.</summary>
        public sbyte[] Normals;
        /// <summary>Faceted land attrs (rgb + class), stride 4; the fill blends them. May be null.</summary>
        public byte[] Attrs;
        /// <summary>LandMesh.RegionSizes per faceted vertex; the fill copies them. May be null.</summary>
        public ushort[] RegionSizes;
        /// <summary>The SMOOTH weld's positions (SmoothLandMesh.OutPositions), when built; moved along with the border.</summary>
        public short[] SmoothPositions;
        /// <summary>The SMOOTH weld's index (SmoothLandMesh.Indices): faceted vertex -> welded vertex.</summary>
        public uint[] SmoothIndices;

        /// <summary>Stitcher bookkeeping; created on first sight. Drop the tile, drop this.</summary>
        public SeamState Seam;
        /// <summary>The T-junction fill, while there is one; drawn as part of the tile with the land material.</summary>
        public SeamFill Fill;

        /// <summary>Set by the last Stitch call that drew this tile: Positions changed, re-upload them.</summary>
        public bool PositionsChanged;
        /// <summary>The changed range, in vertices (inclusive), when PositionsChanged.</summary>
        public int DirtyLo, DirtyHi;
        /// <summary>Set by the last Stitch call: SmoothPositions changed (only when PositionsChanged and a weld is present).</summary>
        public bool SmoothChanged;
        /// <summary>Set by the last Stitch call: Fill was rebuilt (it may now be null). Replace the fill mesh.</summary>
        public bool FillChanged;
    }

    /// <summary>Per-tile bookkeeping (seamStitch.ts SeamState).</summary>
    public sealed class SeamState
    {
        /// <summary>Positions of the border table's vertices as baked, 3 per entry.</summary>
        public short[] Orig;
        /// <summary>Each side's surface edges, sorted along the side.</summary>
        public SideEdges[] Edges;
        /// <summary>Master and its version per side, as last applied.</summary>
        public string Signature = "";
        /// <summary>Renewed whenever this tile's border moves; unique across tiles.</summary>
        public int Version;
        /// <summary>Land vertex -> its first border entry (applyStitch's firstEntry).</summary>
        internal Dictionary<int, int> FirstEntry;
    }

    public sealed class SideEdges
    {
        public double[] Lo, Hi;
        /// <summary>Params and land vertex indices of both ends, in edge order.</summary>
        public double[] Pa, Pb;
        public uint[] Va, Vb;
    }

    /// <summary>A side's master: the drawn tile this side moves onto.</summary>
    public sealed class SeamMaster
    {
        public TileKey Id;
        public StitchTile Tile;
        public SeamState State;
    }

    /// <summary>One fill vertex: where it is, and which border vertices it takes its look from.</summary>
    public struct FillVertex
    {
        public double X, Y, Z;
        /// <summary>The edge's two land vertices; the fill blends their colour by T.</summary>
        public int A, B;
        public double T;
    }

    /// <summary>The T-junction fill as vertex arrays in the tile's quantised frame; a non-indexed triangle soup.</summary>
    public sealed class SeamFill
    {
        public int VertexCount;
        /// <summary>xyz per vertex.</summary>
        public short[] Positions;
        /// <summary>Stride 4 (xyz/127, zero pad).</summary>
        public sbyte[] Normals;
        /// <summary>Stride 4 (sRGB rgb, class).</summary>
        public byte[] Attrs;
        public ushort[] Sizes;
    }

    /// <summary>
    /// seamStitch.ts: stitches each drawn tile's border onto its neighbour's, so
    /// tiles at different levels share one border line, and fills the
    /// T-junctions left over.
    /// </summary>
    public static class SeamStitch
    {
        private static readonly int[] Opposite = { PtmCodec.SideE, PtmCodec.SideW, PtmCodec.SideS, PtmCodec.SideN };
        /// <summary>Params are float32; this much slack lets an end of the side find its edge.</summary>
        private const double ParamEps = 1e-6;
        private const double I16Max = 32767;
        private static int _stamps;

        /// <summary>A master vertex closer than this (m) to the tile's edge gets no fill.</summary>
        public const double SeamFillMinGapM = 0.5;

        /// <summary>The tile across `side`, at the same level; false past a pole.</summary>
        public static bool NeighbourAcross(TileKey id, int side, out TileKey across)
        {
            int cols = Tiling.XCount(id.Z);
            switch (side)
            {
                case PtmCodec.SideW: across = new TileKey(id.Z, (id.X - 1 + cols) % cols, id.Y); return true;
                case PtmCodec.SideE: across = new TileKey(id.Z, (id.X + 1) % cols, id.Y); return true;
                case PtmCodec.SideN:
                    across = new TileKey(id.Z, id.X, id.Y - 1);
                    return id.Y > 0;
                default:
                    across = new TileKey(id.Z, id.X, id.Y + 1);
                    return id.Y + 1 < Tiling.YCount(id.Z);
            }
        }

        /// <summary>
        /// The drawn tile `id` moves its `side` onto, if any: the drawn tile covering
        /// the ground across that side when it is coarser, or the same level and to
        /// the west or north.
        /// </summary>
        public static bool MasterOf<T>(TileKey id, int side, IReadOnlyDictionary<TileKey, T> drawn, out TileKey key, out T tile)
        {
            key = default;
            tile = default;
            if (!NeighbourAcross(id, side, out TileKey across)) return false;
            for (int z = id.Z; z >= 0; z--)
            {
                int shift = id.Z - z;
                var k = new TileKey(z, across.X >> shift, across.Y >> shift);
                if (!drawn.TryGetValue(k, out T t)) continue;
                if (z == id.Z && side != PtmCodec.SideW && side != PtmCodec.SideN) return false;
                key = k;
                tile = t;
                return true;
            }
            return false;
        }

        /// <summary>Where `param` along this tile's `side` falls along the master's opposite side.</summary>
        public static double MasterParam(TileKey id, int side, TileKey master, double param)
        {
            double span = Math.Pow(2, id.Z - master.Z);
            double along = side == PtmCodec.SideW || side == PtmCodec.SideE
                ? id.Y - master.Y * span
                : id.X - master.X * span;
            return (along + param) / span;
        }

        /// <summary>The seam state of a tile, created on first sight; null when it cannot stitch.</summary>
        public static SeamState StateOf(StitchTile tile)
        {
            if (tile.Seam != null) return tile.Seam;
            PtmBorder border = tile.Border;
            short[] pos = tile.Positions;
            if (border == null || pos == null || pos.Length == 0 || border.Vertices.Length == 0) return null;
            var orig = new short[border.Vertices.Length * 3];
            var first = new Dictionary<int, int>();
            for (int i = 0; i < border.Vertices.Length; i++)
            {
                int v = PtmCodec.BorderEntryIndex(border.Vertices[i]);
                orig[i * 3] = pos[v * 3];
                orig[i * 3 + 1] = pos[v * 3 + 1];
                orig[i * 3 + 2] = pos[v * 3 + 2];
            }
            for (int i = border.Vertices.Length - 1; i >= 0; i--)
            {
                first[PtmCodec.BorderEntryIndex(border.Vertices[i])] = i;
            }
            var perSide = new List<int>[] { new List<int>(), new List<int>(), new List<int>(), new List<int>() };
            for (int e = 0; e < border.Edges.Length / 2; e++)
            {
                perSide[PtmCodec.BorderEntrySide(border.Edges[e * 2])].Add(e);
            }
            float[] ep = border.EdgeParams;
            var edges = new SideEdges[4];
            for (int s = 0; s < 4; s++)
            {
                // Stable, like Array.prototype.sort.
                int[] list = perSide[s].OrderBy(e => Math.Min((double)ep[e * 2], ep[e * 2 + 1])).ToArray();
                int n = list.Length;
                var o = new SideEdges
                {
                    Lo = new double[n], Hi = new double[n], Pa = new double[n], Pb = new double[n],
                    Va = new uint[n], Vb = new uint[n],
                };
                for (int i = 0; i < n; i++)
                {
                    int e = list[i];
                    o.Pa[i] = ep[e * 2];
                    o.Pb[i] = ep[e * 2 + 1];
                    o.Lo[i] = Math.Min(o.Pa[i], o.Pb[i]);
                    o.Hi[i] = Math.Max(o.Pa[i], o.Pb[i]);
                    o.Va[i] = (uint)PtmCodec.BorderEntryIndex(border.Edges[e * 2]);
                    o.Vb[i] = (uint)PtmCodec.BorderEntryIndex(border.Edges[e * 2 + 1]);
                }
                edges[s] = o;
            }
            tile.Seam = new SeamState { Orig = orig, Edges = edges, Signature = "", Version = NextStamp(), FirstEntry = first };
            return tile.Seam;
        }

        private static int NextStamp() => Interlocked.Increment(ref _stamps);

        /// <summary>The edge of `side` containing `param`, or -1 where the side has no land.</summary>
        private static int EdgeAt(SideEdges edges, double param)
        {
            int lo = 0;
            int hi = edges.Lo.Length - 1;
            int found = -1;
            while (lo <= hi)
            {
                int mid = (lo + hi) >> 1;
                if (edges.Lo[mid] <= param + ParamEps)
                {
                    found = mid;
                    lo = mid + 1;
                }
                else
                {
                    hi = mid - 1;
                }
            }
            for (int k = 0; k < 3; k++)
            {
                int i = k == 0 ? found : k == 1 ? found - 1 : found + 1;
                if (i >= 0 && i < edges.Lo.Length
                    && edges.Lo[i] - ParamEps <= param && param <= edges.Hi[i] + ParamEps)
                {
                    return i;
                }
            }
            return -1;
        }

        private delegate Vec3d Reader(uint v);

        /// <summary>Point at `param` on edge `i` (Vector3.lerp).</summary>
        private static Vec3d PointOn(SideEdges edges, int i, double param, Reader read)
        {
            Vec3d a = read(edges.Va[i]);
            Vec3d b = read(edges.Vb[i]);
            double len = edges.Pb[i] - edges.Pa[i];
            double t = len == 0 ? 0 : Math.Min(1, Math.Max(0, (param - edges.Pa[i]) / len));
            return new Vec3d(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t, a.Z + (b.Z - a.Z) * t);
        }

        /// <summary>three.js Vector3.applyMatrix4.</summary>
        private static Vec3d Apply(Mat4d m, double x, double y, double z)
        {
            double[] e = m.E;
            double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
            return new Vec3d(
                (e[0] * x + e[4] * y + e[8] * z + e[12]) * w,
                (e[1] * x + e[5] * y + e[9] * z + e[13]) * w,
                (e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
        }

        /// <summary>The master's frame into this tile's: inverse(tile) * master.</summary>
        private static Mat4d ToLocal(StitchTile tile, StitchTile master) => Mat4d.Multiply(tile.Matrix.Inverted(), master.Matrix);

        private static Reader MasterReader(StitchTile tile, StitchTile master)
        {
            short[] mPos = master.Positions;
            Mat4d toLocal = ToLocal(tile, master);
            return v => Apply(toLocal, mPos[v * 3], mPos[v * 3 + 1], mPos[v * 3 + 2]);
        }

        private static double Comp(Vec3d v, int k) => k == 0 ? v.X : k == 1 ? v.Y : v.Z;

        /// <summary>JS Math.min/max propagate NaN; C#'s do too on .NET Core, but spell it out.</summary>
        private static double JsMin(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Min(a, b);
        private static double JsMax(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Max(a, b);

        /// <summary>An Int16Array store (ECMAScript ToInt16).</summary>
        private static short ToInt16(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x)) return 0;
            double t = Math.Truncate(x);
            double m = t % 65536;
            if (m < 0) m += 65536;
            return unchecked((short)(ushort)m);
        }

        /// <summary>An Uint8Array store (ECMAScript ToUint8).</summary>
        private static byte ToUint8(double x)
        {
            if (double.IsNaN(x) || double.IsInfinity(x)) return 0;
            double t = Math.Truncate(x);
            double m = t % 256;
            if (m < 0) m += 256;
            return (byte)m;
        }

        /// <summary>
        /// Re-stitches every drawn tile whose neighbourhood changed since the last
        /// call (stitchSeams). `drawn` is what is on screen this pass, without the
        /// ancestors drawn under a leaf dissolve. Returns how many tiles moved.
        /// </summary>
        public static int Stitch(IReadOnlyList<StitchTile> drawn)
        {
            var byKey = new Dictionary<TileKey, StitchTile>();
            foreach (StitchTile d in drawn)
            {
                byKey[d.Id] = d;
                d.PositionsChanged = false;
                d.SmoothChanged = false;
                d.FillChanged = false;
            }
            // Masters first: coarser before finer, and among one level west and north first.
            StitchTile[] order = drawn.OrderBy(d => d.Id.Z).ThenBy(d => d.Id.Y).ThenBy(d => d.Id.X).ToArray();
            int moved = 0;
            foreach (StitchTile tile in order)
            {
                SeamState state = StateOf(tile);
                if (state == null) continue;
                var masters = new SeamMaster[4];
                for (int side = 0; side < 4; side++)
                {
                    if (!MasterOf(tile.Id, side, byKey, out TileKey mk, out StitchTile mt)) continue;
                    SeamState ms = StateOf(mt);
                    if (ms != null) masters[side] = new SeamMaster { Id = mk, Tile = mt, State = ms };
                }
                string signature = string.Join("|", masters.Select(m => m != null ? $"{m.Id}@{m.State.Version}" : "-"));
                if (signature == state.Signature) continue;
                state.Signature = signature;
                if (ApplyStitch(tile, state, masters))
                {
                    state.Version = NextStamp();
                    moved++;
                }
                RebuildFill(tile, state, masters);
            }
            return moved;
        }

        private static bool ApplyStitch(StitchTile tile, SeamState state, SeamMaster[] masters)
        {
            TileKey id = tile.Id;
            PtmBorder border = tile.Border;
            short[] pos = tile.Positions;
            short[] sp = tile.SmoothPositions;
            uint[] smoothIndex = tile.SmoothIndices;
            Dictionary<int, int> firstEntry = state.FirstEntry;
            Reader readOwn = v =>
            {
                if (!firstEntry.TryGetValue((int)v, out int i)) return new Vec3d(double.NaN, double.NaN, double.NaN);
                return new Vec3d(state.Orig[i * 3], state.Orig[i * 3 + 1], state.Orig[i * 3 + 2]);
            };

            // A corner is on two sides; the side with the coarser master wins it, so it is applied last.
            int Rank(int side) => masters[side] != null ? masters[side].Id.Z : 99;
            int[] sideOrder = new[] { 0, 1, 2, 3 }.OrderByDescending(Rank).ToArray();
            var target = new Dictionary<int, double[]>();
            foreach (int side in sideOrder)
            {
                SeamMaster m = masters[side];
                if (m == null) continue;
                Reader readMaster = MasterReader(tile, m.Tile);
                SideEdges ownEdges = state.Edges[side];
                SideEdges masterEdges = m.State.Edges[Opposite[side]];
                for (int i = 0; i < border.Vertices.Length; i++)
                {
                    if (PtmCodec.BorderEntrySide(border.Vertices[i]) != side) continue;
                    double p = border.VertexParams[i];
                    int oe = EdgeAt(ownEdges, p);
                    double mp = MasterParam(id, side, m.Id, p);
                    int me = EdgeAt(masterEdges, mp);
                    if (oe < 0 || me < 0) continue;
                    Vec3d own = PointOn(ownEdges, oe, p, readOwn);
                    Vec3d master = PointOn(masterEdges, me, mp, readMaster);
                    var q = new double[3];
                    for (int k = 0; k < 3; k++)
                    {
                        q[k] = JsMax(-I16Max, JsMin(I16Max, JsMath.Round(state.Orig[i * 3 + k] + Comp(master, k) - Comp(own, k))));
                    }
                    target[PtmCodec.BorderEntryIndex(border.Vertices[i])] = q;
                }
            }

            bool changed = false;
            int lo = int.MaxValue;
            int hi = int.MinValue;
            var to = new double[3];
            for (int i = 0; i < border.Vertices.Length; i++)
            {
                int v = PtmCodec.BorderEntryIndex(border.Vertices[i]);
                if (target.TryGetValue(v, out double[] t))
                {
                    to[0] = t[0]; to[1] = t[1]; to[2] = t[2];
                }
                else
                {
                    to[0] = state.Orig[i * 3]; to[1] = state.Orig[i * 3 + 1]; to[2] = state.Orig[i * 3 + 2];
                }
                for (int k = 0; k < 3; k++)
                {
                    if (!(pos[v * 3 + k] == to[k]))
                    {
                        pos[v * 3 + k] = ToInt16(to[k]);
                        changed = true;
                        lo = Math.Min(lo, v);
                        hi = Math.Max(hi, v);
                    }
                }
                if (sp != null && smoothIndex != null)
                {
                    long s = smoothIndex[v];
                    sp[s * 3] = ToInt16(to[0]);
                    sp[s * 3 + 1] = ToInt16(to[1]);
                    sp[s * 3 + 2] = ToInt16(to[2]);
                }
            }
            if (changed)
            {
                tile.PositionsChanged = true;
                tile.DirtyLo = lo;
                tile.DirtyHi = hi;
                tile.SmoothChanged = sp != null && smoothIndex != null;
            }
            return changed;
        }

        /// <summary>
        /// The fill for every moved side of `tile`, three vertices per triangle, in
        /// the tile's own frame (seamFillVertices).
        /// </summary>
        public static List<FillVertex> SeamFillVertices(StitchTile tile, SeamState state, IReadOnlyList<SeamMaster> masters)
        {
            var output = new List<FillVertex>();
            TileKey id = tile.Id;
            short[] pos = tile.Positions;
            Vec3d Own(uint v) => new Vec3d(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
            for (int side = 0; side < 4; side++)
            {
                SeamMaster m = masters[side];
                if (m == null) continue;
                Reader readMaster = MasterReader(tile, m.Tile);
                SideEdges masterEdges = m.State.Edges[Opposite[side]];
                double span = Math.Pow(2, id.Z - m.Id.Z);
                double ToMaster(double p) => MasterParam(id, side, m.Id, p);
                // The master's vertices along this tile's stretch, in this tile's params and frame, sorted.
                var inner = new List<(double p, Vec3d at)>();
                double start = ToMaster(0);
                for (int i = 0; i < masterEdges.Lo.Length; i++)
                {
                    for (int end = 0; end < 2; end++)
                    {
                        double mp = end == 0 ? masterEdges.Pa[i] : masterEdges.Pb[i];
                        uint v = end == 0 ? masterEdges.Va[i] : masterEdges.Vb[i];
                        double p = (mp - start) * span;
                        if (p > ParamEps && p < 1 - ParamEps) inner.Add((p, readMaster(v)));
                    }
                }
                var sorted = inner.OrderBy(q => q.p).ToList();
                SideEdges ownEdges = state.Edges[side];
                double scale = tile.Scale;
                double minGap = SeamFillMinGapM / (scale == 0 || double.IsNaN(scale) ? 1 : scale);
                for (int e = 0; e < ownEdges.Lo.Length; e++)
                {
                    bool forward = ownEdges.Pa[e] <= ownEdges.Pb[e];
                    double pa = forward ? ownEdges.Pa[e] : ownEdges.Pb[e];
                    double pb = forward ? ownEdges.Pb[e] : ownEdges.Pa[e];
                    uint va = forward ? ownEdges.Va[e] : ownEdges.Vb[e];
                    uint vb = forward ? ownEdges.Vb[e] : ownEdges.Va[e];
                    int startEdge = EdgeAt(masterEdges, ToMaster(pa));
                    int endEdge = EdgeAt(masterEdges, ToMaster(pb));
                    Vec3d a = Own(va);
                    Vec3d b = Own(vb);
                    double TOf(double p) => pb > pa ? (p - pa) / (pb - pa) : 0;
                    var line = new List<(double p, Vec3d at)>();
                    double lastP = pa;
                    if (startEdge >= 0)
                    {
                        Vec3d startAt = PointOn(masterEdges, startEdge, ToMaster(pa), readMaster);
                        if (Distance(startAt, a) >= minGap) line.Add((pa, startAt));
                    }
                    foreach (var q in sorted)
                    {
                        if (q.p > pa + ParamEps && q.p < pb - ParamEps && q.p - lastP > ParamEps)
                        {
                            double t = TOf(q.p);
                            var onEdge = new Vec3d(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t, a.Z + (b.Z - a.Z) * t);
                            if (Distance(q.at, onEdge) >= minGap)
                            {
                                line.Add(q);
                                lastP = q.p;
                            }
                        }
                    }
                    if (endEdge >= 0)
                    {
                        Vec3d endAt = PointOn(masterEdges, endEdge, ToMaster(pb), readMaster);
                        if (Distance(endAt, b) >= minGap) line.Add((pb, endAt));
                    }
                    if (line.Count == 0) continue;
                    line.Add((pb, b));
                    for (int i = 0; i + 1 < line.Count; i++)
                    {
                        Vec3d p = line[i].at;
                        Vec3d q = line[i + 1].at;
                        double ux = p.X - a.X, uy = p.Y - a.Y, uz = p.Z - a.Z;
                        double wx = q.X - a.X, wy = q.Y - a.Y, wz = q.Z - a.Z;
                        double cx = uy * wz - uz * wy;
                        double cy = uz * wx - ux * wz;
                        double cz = ux * wy - uy * wx;
                        if (cx * cx + cy * cy + cz * cz < 1) continue;
                        output.Add(new FillVertex { X = a.X, Y = a.Y, Z = a.Z, A = (int)va, B = (int)vb, T = 0 });
                        output.Add(new FillVertex { X = p.X, Y = p.Y, Z = p.Z, A = (int)va, B = (int)vb, T = TOf(line[i].p) });
                        output.Add(new FillVertex { X = q.X, Y = q.Y, Z = q.Z, A = (int)va, B = (int)vb, T = TOf(line[i + 1].p) });
                    }
                }
            }
            return output;
        }

        /// <summary>three.js distanceTo.</summary>
        private static double Distance(Vec3d u, Vec3d v)
        {
            double dx = u.X - v.X, dy = u.Y - v.Y, dz = u.Z - v.Z;
            return Math.Sqrt(dx * dx + dy * dy + dz * dz);
        }

        private static void RebuildFill(StitchTile tile, SeamState state, SeamMaster[] masters)
        {
            tile.Fill = null;
            tile.FillChanged = true;
            List<FillVertex> verts = SeamFillVertices(tile, state, masters);
            if (verts.Count == 0) return;
            int n = verts.Count;
            var position = new short[n * 3];
            var normals = new sbyte[n * 4];
            var attrs = new byte[n * 4];
            var sizes = new ushort[n];
            sbyte[] nArr = tile.Normals;
            byte[] cArr = tile.Attrs;
            ushort[] sArr = tile.RegionSizes;
            for (int i = 0; i < n; i++)
            {
                FillVertex v = verts[i];
                position[i * 3] = ToInt16(Clamp(v.X));
                position[i * 3 + 1] = ToInt16(Clamp(v.Y));
                position[i * 3 + 2] = ToInt16(Clamp(v.Z));
                for (int k = 0; k < 3; k++)
                {
                    normals[i * 4 + k] = nArr != null ? nArr[v.A * 4 + k] : (sbyte)(k == 1 ? 127 : 0);
                    attrs[i * 4 + k] = cArr != null
                        ? ToUint8(JsMath.Round(cArr[v.A * 4 + k] * (1 - v.T) + cArr[v.B * 4 + k] * v.T))
                        : (byte)128;
                }
                attrs[i * 4 + 3] = cArr != null ? cArr[v.A * 4 + 3] : (byte)0;
                sizes[i] = sArr != null ? sArr[v.A] : (ushort)0;
            }
            tile.Fill = new SeamFill { VertexCount = n, Positions = position, Normals = normals, Attrs = attrs, Sizes = sizes };
        }

        private static double Clamp(double q) => JsMax(-I16Max, JsMin(I16Max, JsMath.Round(q)));
    }
}
