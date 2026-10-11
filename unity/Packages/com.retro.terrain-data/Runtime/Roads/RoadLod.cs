using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>
    /// Coarser index lists over a tile's road strokes, for drawing them far off
    /// (src/script/terrain/roadLod.ts).
    ///
    /// A stroke is draped over its tile's land, so a coarse tile's roads carry a
    /// point every few tens of metres although the tile is drawn kilometres
    /// away. Each level drops the centreline points within its tolerance of the
    /// chord between the points it keeps; the vertices stay as they are, a level
    /// is another index list over the same buffers. A chord may run above the
    /// land by up to the tolerance but never below it (DownToleranceM). Junctions,
    /// ends, and points where width, class or track flags change are kept.
    /// </summary>
    public static class RoadLod
    {
        /// <summary>Metres off the original stroke each level allows, finest first (ROAD_LOD_TOLERANCES_M).</summary>
        public static readonly double[] TolerancesM = { 0.25, 1, 4, 16 };

        /// <summary>A level is used once its tolerance is at most this share of a pixel (ROAD_LOD_MAX_PIXELS).</summary>
        public const double MaxPixels = 0.5;

        /// <summary>How far a chord may dip below the land it replaces: none, to rounding.</summary>
        public const double DownToleranceM = 0.02;

        /// <summary>A level is kept only if it drops at least this share of the triangles of the one before it.</summary>
        public const double MinSaving = 0.1;

        /// <summary>Levels a stroke kind has: 0 full, then one per tolerance.</summary>
        public static int LevelCount => TolerancesM.Length + 1;

        /// <summary>
        /// The level to draw where a pixel at the screen centre spans
        /// <paramref name="metresPerPixel"/> of ground: the coarsest whose
        /// tolerance stays under MaxPixels of it (roadLod.ts roadLevelFor). The
        /// runtime passes <c>nearM * pixelAngle</c>, nearM being the distance
        /// from the camera to the tile's bounding sphere (0 inside it).
        /// </summary>
        public static int LevelFor(double metresPerPixel)
        {
            int level = 0;
            for (int i = 0; i < TolerancesM.Length; i++)
            {
                if (TolerancesM[i] <= MaxPixels * metresPerPixel) level = i + 1;
            }
            return level;
        }

        /// <summary>Every level of <paramref name="indices"/> at once, built in order (roadLod.ts roadLevels).</summary>
        public static ushort[][] AllLevels(PtrTile tile, ushort[] indices, double upX, double upY, double upZ)
        {
            var levels = new RoadLevels(tile, indices, upX, upY, upZ);
            for (int i = 1; i <= TolerancesM.Length; i++) levels.Build(i);
            var output = new ushort[LevelCount][];
            for (int i = 0; i < output.Length; i++) output[i] = levels.Get(i);
            return output;
        }
    }

    /// <summary>
    /// The levels of one stroke kind of a tile, built on demand (roadLod.ts
    /// RoadLevels): most tiles are only ever drawn at full detail, and a dense
    /// one takes milliseconds to simplify. Level 0 is the given list itself;
    /// level i uses TolerancesM[i - 1]. A level that saves too little repeats
    /// the one below it by reference, so callers can compare arrays by
    /// reference. Building skips the levels between, so the result of a level
    /// depends on which were built before it, exactly as in the oracle.
    /// </summary>
    public sealed class RoadLevels
    {
        private readonly PtrTile _tile;
        private readonly double _ux, _uy, _uz;
        private StrokeGraph _graph;
        private bool _graphBuilt;
        private readonly ushort[][] _levels;

        /// <summary>
        /// <paramref name="upX"/>..<paramref name="upZ"/>: the local vertical in
        /// the tile's own axes, unit length. terrainEntity.ts computes it as
        /// normalize(tileOrigin - earthCentre) in the scene frame, turned by the
        /// inverse of the tile's rotation (frameFix).
        /// </summary>
        public RoadLevels(PtrTile tile, ushort[] indices, double upX, double upY, double upZ)
        {
            _tile = tile;
            _ux = upX;
            _uy = upY;
            _uz = upZ;
            _levels = new ushort[RoadLod.LevelCount][];
            _levels[0] = indices;
        }

        public bool Has(int level) => _levels[Math.Min(level, _levels.Length - 1)] != null;

        /// <summary>Build <paramref name="level"/> straight away, skipping the ones between.</summary>
        public void Build(int level)
        {
            int at = Math.Min(level, _levels.Length - 1);
            if (_levels[at] != null) return;
            if (!_graphBuilt)
            {
                _graph = StrokeGraph.Build(_tile, _levels[0]);
                _graphBuilt = true;
            }
            ushort[] finer = Get(at - 1);
            ushort[] next = _graph != null
                ? Simplify(_tile, _levels[0], _graph, _ux, _uy, _uz, RoadLod.TolerancesM[at - 1])
                : finer;
            _levels[at] = next.Length <= finer.Length * (1 - RoadLod.MinSaving) ? next : finer;
        }

        /// <summary>The finest built level at or below <paramref name="level"/>.</summary>
        public ushort[] Get(int level)
        {
            for (int i = Math.Min(level, _levels.Length - 1); i > 0; i--)
            {
                if (_levels[i] != null) return _levels[i];
            }
            return _levels[0];
        }

        private static long SegKey(int a, int b, int n) => a < b ? (long)a * n + b : (long)b * n + a;

        /// <summary>Centreline points (the two banks of a pair share a position and class) and the segments between them.</summary>
        private sealed class StrokeGraph
        {
            /// <summary>Centreline point of each vertex used by the list, else -1.</summary>
            public int[] GroupOf;
            public int GroupCount;
            /// <summary>A vertex of each point, for its position, width and flags.</summary>
            public int[] Rep;
            /// <summary>Neighbour points, in first-seen order (the oracle's Set order).</summary>
            public List<int>[] Neighbours;
            /// <summary>Triangle offsets (into the index list) of each segment, by SegKey.</summary>
            public Dictionary<long, List<int>> SegTris;
            /// <summary>Points a run may not pass through.</summary>
            public byte[] Fixed;
            public List<List<int>> Chains;

            public static StrokeGraph Build(PtrTile tile, ushort[] indices)
            {
                short[] pos = tile.Positions;
                sbyte[] dirs = tile.Directions;
                int vertexCount = pos.Length / 3;
                var groupOf = new int[vertexCount];
                for (int i = 0; i < vertexCount; i++) groupOf[i] = -1;
                var byKey = new Dictionary<long, int>();
                var reps = new List<int>();
                for (int i = 0; i < indices.Length; i++)
                {
                    int v = indices[i];
                    if (groupOf[v] >= 0) continue;
                    // Three int16 and a 4-bit class: 52 bits.
                    long key = ((((long)pos[v * 3] + 32768) * 65536 + (pos[v * 3 + 1] + 32768)) * 65536
                        + (pos[v * 3 + 2] + 32768)) * 16 + (dirs[v * 4 + 3] & PtrCodec.RoadClassMask);
                    if (!byKey.TryGetValue(key, out int g))
                    {
                        g = reps.Count;
                        byKey.Add(key, g);
                        reps.Add(v);
                    }
                    groupOf[v] = g;
                }
                int n = reps.Count;
                if (n == 0) return null;
                var fixedPts = new byte[n];
                var neighbours = new List<int>[n];
                for (int g = 0; g < n; g++) neighbours[g] = new List<int>(2);
                var segTris = new Dictionary<long, List<int>>();
                for (int t = 0; t < indices.Length; t += 3)
                {
                    int a = groupOf[indices[t]];
                    int b = groupOf[indices[t + 1]];
                    int c = groupOf[indices[t + 2]];
                    bool two = (a == b) != (b == c) || (a == c && a != b);
                    if (!two)
                    {
                        // Not a segment quad half: leave it and its points alone.
                        fixedPts[a] = 1;
                        fixedPts[b] = 1;
                        fixedPts[c] = 1;
                        continue;
                    }
                    int p = a;
                    int q = a != b ? b : c;
                    if (!neighbours[p].Contains(q)) neighbours[p].Add(q);
                    if (!neighbours[q].Contains(p)) neighbours[q].Add(p);
                    long sk = SegKey(p, q, n);
                    if (segTris.TryGetValue(sk, out List<int> list)) list.Add(t);
                    else segTris.Add(sk, new List<int> { t });
                }
                ushort[] half = tile.HalfWidths;
                byte[] flags = tile.Flags;
                for (int g = 0; g < n; g++)
                {
                    if (neighbours[g].Count != 2) fixedPts[g] = 1;
                }
                foreach (KeyValuePair<long, List<int>> kv in segTris)
                {
                    if (kv.Value.Count != 2)
                    {
                        // Two strokes over the same span, or a lone half: keep both ends.
                        fixedPts[(int)(kv.Key / n)] = 1;
                        fixedPts[(int)(kv.Key % n)] = 1;
                    }
                }
                // A width or flag change is a point the stroke must keep.
                for (int g = 0; g < n; g++)
                {
                    if (fixedPts[g] != 0) continue;
                    int v = reps[g];
                    foreach (int h in neighbours[g])
                    {
                        int w = reps[h];
                        if (half[v] != half[w] || flags[v] != flags[w])
                        {
                            fixedPts[g] = 1;
                            break;
                        }
                    }
                }
                var graph = new StrokeGraph
                {
                    GroupOf = groupOf,
                    GroupCount = n,
                    Rep = reps.ToArray(),
                    Neighbours = neighbours,
                    SegTris = segTris,
                    Fixed = fixedPts,
                };
                graph.Chains = ChainsOf(graph);
                return graph;
            }

            /// <summary>The chains between fixed points, as point lists (a closed loop starts and ends on one point).</summary>
            private static List<List<int>> ChainsOf(StrokeGraph graph)
            {
                List<int>[] neighbours = graph.Neighbours;
                byte[] fixedPts = graph.Fixed;
                int n = graph.GroupCount;
                var visited = new HashSet<long>();
                var output = new List<List<int>>();
                void Walk(int start, int next)
                {
                    var chain = new List<int> { start };
                    int prev = start;
                    int cur = next;
                    visited.Add(SegKey(start, next, n));
                    while (true)
                    {
                        chain.Add(cur);
                        if (fixedPts[cur] != 0 || cur == start) break;
                        int a = neighbours[cur][0], b = neighbours[cur][1];
                        int nxt = a == prev ? b : a;
                        visited.Add(SegKey(cur, nxt, n));
                        prev = cur;
                        cur = nxt;
                    }
                    output.Add(chain);
                }
                for (int g = 0; g < n; g++)
                {
                    if (fixedPts[g] == 0) continue;
                    foreach (int h in neighbours[g])
                    {
                        if (!visited.Contains(SegKey(g, h, n))) Walk(g, h);
                    }
                }
                // Loops with no fixed point on them.
                for (int g = 0; g < n; g++)
                {
                    foreach (int h in neighbours[g])
                    {
                        if (!visited.Contains(SegKey(g, h, n)))
                        {
                            fixedPts[g] = 1;
                            Walk(g, h);
                        }
                    }
                }
                return output;
            }
        }

        private static ushort[] Simplify(
            PtrTile tile, ushort[] indices, StrokeGraph graph, double ux, double uy, double uz, double tolM)
        {
            int[] rep = graph.Rep;
            Dictionary<long, List<int>> segTris = graph.SegTris;
            int[] groupOf = graph.GroupOf;
            int n = graph.GroupCount;
            short[] pos = tile.Positions;
            double q = tile.QuantScale;
            sbyte[] dirs = tile.Directions;
            var output = new List<ushort>(indices.Length);
            var used = new byte[indices.Length / 3];

            // Is point m within tolerance of the chord a-b?
            bool Near(int a, int b, int m)
            {
                int va = rep[a] * 3, vb = rep[b] * 3, vm = rep[m] * 3;
                double abx = (pos[vb] - pos[va]) * q, aby = (pos[vb + 1] - pos[va + 1]) * q, abz = (pos[vb + 2] - pos[va + 2]) * q;
                double amx = (pos[vm] - pos[va]) * q, amy = (pos[vm + 1] - pos[va + 1]) * q, amz = (pos[vm + 2] - pos[va + 2]) * q;
                double len2 = abx * abx + aby * aby + abz * abz;
                if (len2 < 1e-12) return false;
                double s = (abx * amx + aby * amy + abz * amz) / len2;
                if (s < 0 || s > 1) return false;
                // The point less the chord under it: positive is land above the chord.
                double dx = amx - s * abx, dy = amy - s * aby, dz = amz - s * abz;
                double rise = dx * ux + dy * uy + dz * uz;
                if (rise > RoadLod.DownToleranceM || rise < -tolM) return false;
                double lx = dx - rise * ux, ly = dy - rise * uy, lz = dz - rise * uz;
                return lx * lx + ly * ly + lz * lz <= tolM * tolM;
            }

            // The vertex of point g on each bank, as segment (g, other) draws it: (positive, negative) or null.
            (int Pos, int Neg)? Banks(int g, int other)
            {
                if (!segTris.TryGetValue(SegKey(g, other, n), out List<int> tris)) return null;
                int pos0 = -1, neg = -1;
                foreach (int t in tris)
                {
                    for (int k = 0; k < 3; k++)
                    {
                        int v = indices[t + k];
                        if (groupOf[v] != g) continue;
                        bool negative = (dirs[v * 4 + 3] & PtrCodec.RoadSideBit) != 0;
                        if (negative)
                        {
                            if (neg >= 0 && neg != v) return null;
                            neg = v;
                        }
                        else
                        {
                            if (pos0 >= 0 && pos0 != v) return null;
                            pos0 = v;
                        }
                    }
                }
                return pos0 >= 0 && neg >= 0 ? (pos0, neg) : ((int, int)?)null;
            }

            void CopySegment(int a, int b)
            {
                if (!segTris.TryGetValue(SegKey(a, b, n), out List<int> tris)) return;
                foreach (int t in tris)
                {
                    output.Add(indices[t]);
                    output.Add(indices[t + 1]);
                    output.Add(indices[t + 2]);
                    used[t / 3] = 1;
                }
            }

            foreach (List<int> chain in graph.Chains)
            {
                int i = 0;
                while (i < chain.Count - 1)
                {
                    int k = i + 1;
                    for (int cand = i + 2; cand < chain.Count; cand++)
                    {
                        bool ok = chain[cand] != chain[i];
                        for (int m = i + 1; ok && m < cand; m++) ok = Near(chain[i], chain[cand], chain[m]);
                        if (!ok) break;
                        k = cand;
                    }
                    if (k == i + 1)
                    {
                        CopySegment(chain[i], chain[i + 1]);
                        i = k;
                        continue;
                    }
                    // The first segment's quad, its far end moved to the kept
                    // point, bank for bank, so the winding stays the original's.
                    (int Pos, int Neg)? from = Banks(chain[i + 1], chain[i]);
                    (int Pos, int Neg)? to = Banks(chain[k], chain[k - 1]);
                    if (from == null || to == null)
                    {
                        for (int m = i; m < k; m++) CopySegment(chain[m], chain[m + 1]);
                        i = k;
                        continue;
                    }
                    (int fromPos, int fromNeg) = from.Value;
                    (int toPos, int toNeg) = to.Value;
                    if (segTris.TryGetValue(SegKey(chain[i], chain[i + 1], n), out List<int> first))
                    {
                        foreach (int t in first)
                        {
                            for (int c = 0; c < 3; c++)
                            {
                                int v = indices[t + c];
                                output.Add((ushort)(v == fromPos ? toPos : v == fromNeg ? toNeg : v));
                            }
                        }
                    }
                    for (int m = i; m < k; m++)
                    {
                        if (!segTris.TryGetValue(SegKey(chain[m], chain[m + 1], n), out List<int> tris)) continue;
                        foreach (int t in tris) used[t / 3] = 1;
                    }
                    i = k;
                }
            }
            // Everything not on a chain (caps, odd triangles) as it was.
            for (int t = 0; t < indices.Length; t += 3)
            {
                if (used[t / 3] == 0)
                {
                    output.Add(indices[t]);
                    output.Add(indices[t + 1]);
                    output.Add(indices[t + 2]);
                }
            }
            return output.ToArray();
        }
    }
}
