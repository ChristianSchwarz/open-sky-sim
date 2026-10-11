using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;

namespace Retro.Game
{
    public sealed partial class WreckField
    {
        // --- connectivity (weldKey, groupTriangles, joinedSections, connectedParts) ----------

        private const double WeldInv = 1 / WeldM;

        /// <summary>The welded position of vertex k (0-2) of triangle t in a flat xyz array, as a lookup key (wreckField.ts weldKey).</summary>
        public static (long, long, long) WeldKey(IList<double> pos, int t, int k)
        {
            int o = t * 9 + k * 3;
            return ((long)JsMath.Round(pos[o] * WeldInv), (long)JsMath.Round(pos[o + 1] * WeldInv), (long)JsMath.Round(pos[o + 2] * WeldInv));
        }

        /// <summary>
        /// Group triangles that share a (welded) vertex (wreckField.ts groupTriangles).
        /// Each item is a flat xyz array with nine numbers per triangle and the
        /// triangle's index in it. Returns groups of indices into the items, in the
        /// order the TS Map yields them.
        /// </summary>
        public static List<List<int>> GroupTriangles(IReadOnlyList<(IList<double> Pos, int T)> items)
        {
            var parent = new int[items.Count];
            for (int i = 0; i < parent.Length; i++)
            {
                parent[i] = i;
            }
            int Find(int a)
            {
                while (parent[a] != a)
                {
                    parent[a] = parent[parent[a]];
                    a = parent[a];
                }
                return a;
            }
            var seen = new Dictionary<(long, long, long), int>();
            for (int i = 0; i < items.Count; i++)
            {
                (IList<double> pos, int t) = items[i];
                for (int k = 0; k < 3; k++)
                {
                    (long, long, long) key = WeldKey(pos, t, k);
                    if (!seen.TryGetValue(key, out int j))
                    {
                        seen[key] = i;
                    }
                    else
                    {
                        int a = Find(i);
                        int b = Find(j);
                        if (a != b)
                        {
                            parent[a] = b;
                        }
                    }
                }
            }
            var order = new List<int>();
            var groups = new Dictionary<int, List<int>>();
            for (int i = 0; i < items.Count; i++)
            {
                int r = Find(i);
                if (groups.TryGetValue(r, out List<int> g))
                {
                    g.Add(i);
                }
                else
                {
                    groups[r] = new List<int> { i };
                    order.Add(r);
                }
            }
            return order.Select(r => groups[r]).ToList();
        }

        /// <summary>Split sections into runs that are actually joined to each other (see CellNeighbours).</summary>
        private static List<List<WreckChunk>> JoinedSections(List<WreckChunk> chunks)
        {
            var byCell = new Dictionary<int, WreckChunk>();
            foreach (WreckChunk c in chunks)
            {
                byCell[c.Cell] = c;
            }
            var seen = new HashSet<int>();
            var output = new List<List<WreckChunk>>();
            foreach (WreckChunk c in chunks)
            {
                if (seen.Contains(c.Cell))
                {
                    continue;
                }
                var run = new List<WreckChunk>();
                var stack = new List<int> { c.Cell };
                seen.Add(c.Cell);
                while (stack.Count > 0)
                {
                    int cell = stack[stack.Count - 1];
                    stack.RemoveAt(stack.Count - 1);
                    run.Add(byCell[cell]);
                    int[] neighbours = cell >= 0 && cell < CellNeighbours.Length ? CellNeighbours[cell] : Array.Empty<int>();
                    foreach (int n in neighbours)
                    {
                        if (byCell.ContainsKey(n) && !seen.Contains(n))
                        {
                            seen.Add(n);
                            stack.Add(n);
                        }
                    }
                }
                output.Add(run);
            }
            return output;
        }

        /// <summary>
        /// Test hook: <see cref="ConnectedParts"/> on meshes given by their flat
        /// positions; each component as the positions of its parts.
        /// </summary>
        public static List<List<double[]>> ConnectedPositions(IEnumerable<IEnumerable<double>> parts)
        {
            var meshes = parts.Select(p => new WreckChunkMesh(null) { Pos = p.ToList() }).ToList();
            return ConnectedParts(meshes).Select(c => c.Select(cm => cm.Pos.ToArray()).ToList()).ToList();
        }

        /// <summary>
        /// Test hook: <see cref="ExtractShards"/> on one fuselage mesh given by its
        /// flat positions (the list loses the shards' triangles, as the mesh does);
        /// returns each shard's positions.
        /// </summary>
        public List<double[]> ExtractShardsFrom(List<double> positions, int count, double size)
        {
            var chunk = new WreckChunk { Cell = 1, Weakness = 1 };
            chunk.Meshes.Add(new WreckChunkMesh(null) { Pos = positions });
            return ExtractShards(new List<WreckChunk> { chunk }, count, size).Select(c => c.Meshes[0].Pos.ToArray()).ToList();
        }

        /// <summary>Test hook: <see cref="JoinedSections"/> on bare cell numbers.</summary>
        public static List<List<int>> JoinedCells(IEnumerable<int> cells) =>
            JoinedSections(cells.Select(c => new WreckChunk { Cell = c }).ToList()).Select(r => r.Select(c => c.Cell).ToList()).ToList();

        /// <summary>
        /// The connected pieces of a cut half, as parts ready to build from. Scraps
        /// smaller than ComponentMinTris are dropped; if everything is small the
        /// largest is kept.
        /// </summary>
        private static List<List<WreckChunkMesh>> ConnectedParts(List<WreckChunkMesh> parts)
        {
            var items = new List<(IList<double> Pos, int T)>();
            var itemPart = new List<int>();
            for (int partI = 0; partI < parts.Count; partI++)
            {
                List<double> pos = parts[partI].Pos;
                for (int t = 0; t < pos.Count / 9; t++)
                {
                    items.Add((pos, t));
                    itemPart.Add(partI);
                }
            }
            var result = new List<List<WreckChunkMesh>>();
            if (items.Count == 0)
            {
                return result;
            }
            List<List<int>> groups = GroupTriangles(items);
            WreckMath.JsSort(groups, (a, b) => b.Count - a.Count);
            List<List<int>> kept = groups.Where(g => g.Count >= ComponentMinTris).Take(ComponentMaxKeep).ToList();
            if (kept.Count == 0)
            {
                kept.Add(groups[0]);
            }
            foreach (List<int> group in kept)
            {
                var outOrder = new List<int>();
                var outParts = new Dictionary<int, WreckChunkMesh>();
                foreach (int i in group)
                {
                    int part = itemPart[i];
                    int t = items[i].T;
                    if (!outParts.TryGetValue(part, out WreckChunkMesh dst))
                    {
                        dst = new WreckChunkMesh(parts[part].Material);
                        outParts[part] = dst;
                        outOrder.Add(part);
                    }
                    foreach ((List<double> data, int itemSize, int which) in parts[part].Attrs())
                    {
                        List<double> d = dst.Ensure(which, itemSize);
                        int per = itemSize * 3;
                        for (int k = 0; k < per; k++)
                        {
                            d.Add(data[t * per + k]);
                        }
                    }
                }
                result.Add(outOrder.Select(p => outParts[p]).ToList());
            }
            return result;
        }

        // --- shards -----------------------------------------------------------------------

        /// <summary>
        /// Cut <paramref name="count"/> small shards out of the body chunks. Each is a
        /// cluster of neighbouring triangles around a random point, removed from its
        /// source so the piece it came from is left with a hole rather than a duplicate.
        /// </summary>
        private List<WreckChunk> ExtractShards(List<WreckChunk> chunks, int count, double size)
        {
            var shards = new List<WreckChunk>();
            var cands = new List<WreckChunkMesh>();
            foreach (WreckChunk chunk in chunks)
            {
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    if (cm.HasPosition)
                    {
                        cands.Add(cm);
                    }
                }
            }
            double TrisOf(WreckChunkMesh cm) => cm.Pos.Count / 9.0;
            for (int n = 0; n < count && cands.Count > 0; n++)
            {
                double total = 0;
                foreach (WreckChunkMesh c in cands)
                {
                    total += TrisOf(c);
                }
                // Weighted pick: bigger meshes lose shards more often.
                double pick = random() * total;
                WreckChunkMesh cm = cands[0];
                foreach (WreckChunkMesh c in cands)
                {
                    pick -= TrisOf(c);
                    if (pick <= 0)
                    {
                        cm = c;
                        break;
                    }
                }
                List<double> pos = cm.Pos;
                double trisD = pos.Count / 9.0;
                if (trisD < ShardMinSourceTris)
                {
                    continue;
                }
                int tris = pos.Count / 9;
                int t0 = (int)Math.Floor(random() * trisD);
                double cx = (pos[t0 * 9] + pos[t0 * 9 + 3] + pos[t0 * 9 + 6]) / 3;
                double cy = (pos[t0 * 9 + 1] + pos[t0 * 9 + 4] + pos[t0 * 9 + 7]) / 3;
                double cz = (pos[t0 * 9 + 2] + pos[t0 * 9 + 5] + pos[t0 * 9 + 8]) / 3;
                double rr = size * (0.045 + random() * 0.05);
                double r2 = rr * rr;
                // The triangles nearest the seed (so the seed itself is always in, and the shard is round).
                var near = new List<(int T, double D2)>();
                for (int t = 0; t < tris; t++)
                {
                    double x = (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3 - cx;
                    double y = (pos[t * 9 + 1] + pos[t * 9 + 4] + pos[t * 9 + 7]) / 3 - cy;
                    double z = (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3 - cz;
                    double d2 = x * x + y * y + z * z;
                    if (d2 < r2)
                    {
                        near.Add((t, d2));
                    }
                }
                WreckMath.JsSort(near, (a, b) => a.D2 - b.D2);
                // Ascending, as the removal below needs.
                List<int> picked = near.Take(ShardMaxTris).Select(x => x.T).ToList();
                WreckMath.JsSort(picked, (a, b) => a - b);
                // Only the triangles joined to the seed one.
                List<List<int>> pickedGroups = GroupTriangles(picked.Select(t => ((IList<double>)pos, t)).ToList());
                List<int> joined = pickedGroups.FirstOrDefault(g => g.Any(i => picked[i] == t0)) ?? new List<int>();
                List<int> pickedBefore = picked;
                picked = joined.Select(i => pickedBefore[i]).ToList();
                WreckMath.JsSort(picked, (a, b) => a - b);
                if (picked.Count < 2 || tris - picked.Count < ShardMinLeftTris)
                {
                    continue;
                }
                // Triangles left hanging by their corners from the hole go with the shard.
                var takenKeys = new HashSet<(long, long, long)>();
                foreach (int t in picked)
                {
                    for (int k = 0; k < 3; k++)
                    {
                        takenKeys.Add(WeldKey(pos, t, k));
                    }
                }
                var taken = new HashSet<int>(picked);
                var rest = new List<int>();
                for (int t = 0; t < tris; t++)
                {
                    if (!taken.Contains(t))
                    {
                        rest.Add(t);
                    }
                }
                List<List<int>> islands = GroupTriangles(rest.Select(t => ((IList<double>)pos, t)).ToList());
                if (islands.Count > 1)
                {
                    int main = 0;
                    for (int i = 1; i < islands.Count; i++)
                    {
                        if (islands[i].Count > islands[main].Count)
                        {
                            main = i;
                        }
                    }
                    for (int i = 0; i < islands.Count; i++)
                    {
                        if (i == main)
                        {
                            continue;
                        }
                        List<int> tri = islands[i].Select(j => rest[j]).ToList();
                        bool touchesHole = tri.Any(t => takenKeys.Contains(WeldKey(pos, t, 0)) || takenKeys.Contains(WeldKey(pos, t, 1)) || takenKeys.Contains(WeldKey(pos, t, 2)));
                        if (touchesHole && tri.Count < ComponentMinTris * 4)
                        {
                            picked.AddRange(tri);
                        }
                    }
                    WreckMath.JsSort(picked, (a, b) => a - b);
                }
                var output = new WreckChunkMesh(cm.Material);
                var box = new WreckBox3();
                foreach ((List<double> data, int itemSize, int which) in cm.Attrs())
                {
                    int per = itemSize * 3;
                    List<double> takenData = output.Ensure(which, itemSize);
                    foreach (int t in picked)
                    {
                        for (int k = 0; k < per; k++)
                        {
                            takenData.Add(data[t * per + k]);
                        }
                    }
                    if (which == 0)
                    {
                        for (int i = 0; i + 2 < takenData.Count; i += 3)
                        {
                            box.ExpandByPoint(takenData[i], takenData[i + 1], takenData[i + 2]);
                        }
                    }
                }
                cm.RemoveTriangles(new HashSet<int>(picked));
                shards.Add(new WreckChunk { Cell = -1, Meshes = new List<WreckChunkMesh> { output }, Box = box, Weakness = 1 });
            }
            return shards;
        }

        /// <summary>
        /// Throw a shard out to the side of the line of travel, up and a little away
        /// from the impact, spinning hard: the burning bits that spray clear of a crash.
        /// </summary>
        private void BurstSideways(WreckFragment frag, Vec3d vTangent, Vec3d impact, double severity)
        {
            var side = new Vec3d(-vTangent.Z, 0, vTangent.X);
            if (side.LengthSquared < 1e-4)
            {
                double sx = random() - 0.5;
                double sz = random() - 0.5;
                side = new Vec3d(sx, 0, sz);
            }
            side = side.Normalized() * (random() < 0.5 ? -1 : 1);
            Vec3d away = frag.Centre - impact;
            away = new Vec3d(away.X, 0, away.Z);
            if (away.LengthSquared > 1e-4)
            {
                away = away.Normalized();
            }
            Vec3d dir = (side * 0.85).AddScaled(away, 0.3);
            dir = new Vec3d(dir.X, 0.55, dir.Z).Normalized();
            double speed = (10 + random() * 24) * (0.6 + 0.5 * Math.Min(severity, 1.2));
            frag.Velocity = frag.Velocity.AddScaled(dir, speed);
            double spx = (random() - 0.5) * 20;
            double spy = (random() - 0.5) * 12;
            double spz = (random() - 0.5) * 20;
            frag.Spin = new Vec3d(frag.Spin.X + spx, frag.Spin.Y + spy, frag.Spin.Z + spz);
        }

        // --- marks ------------------------------------------------------------------------

        /// <summary>Scorch where the airframe struck, with pocks thrown around it.</summary>
        private void MarkFirstImpact(Vec3d origin, Vec3d impact, Vec3d normal, Vec3d vTangent, double severity)
        {
            if (OnMark == null)
            {
                return;
            }
            double x = origin.X + impact.X;
            double z = origin.Z + impact.Z;
            Vec3d dir;
            if (JsMath.Hypot(vTangent.X, vTangent.Z) > 1e-3)
            {
                dir = new Vec3d(vTangent.X, 0, vTangent.Z).Normalized();
            }
            else
            {
                double rx = random() - 0.5;
                double rz = random() - 0.5;
                dir = new Vec3d(rx, 0, rz).Normalized();
            }
            double dx = dir.X;
            double dz = dir.Z;
            var at = new Vec3d(x, groundHeightAt(x, z), z);
            Vec3d n = GroundNormal(x, z);
            OnMark(at, n, dx, dz, 6 + 14 * severity, 4 + 7 * severity, 0.9);
            double pocks = 3 + JsMath.Round(4 * severity);
            for (int i = 0; i < pocks; i++)
            {
                double r = (2 + random() * 10) * (0.5 + severity);
                double a = random() * Math.PI * 2;
                double px = x + JsTrig.Cos(a) * r + dx * r * 0.6;
                double pz = z + JsTrig.Sin(a) * r + dz * r * 0.6;
                double size = 1 + random() * 2.5 * (0.5 + severity);
                var p = new Vec3d(px, groundHeightAt(px, pz), pz);
                Vec3d pn = GroundNormal(px, pz);
                double mx = random() - 0.5;
                double mz = random() - 0.5;
                double strength = 0.6 + random() * 0.3;
                OnMark(p, pn, mx, mz, size * 1.4, size, strength);
            }
        }

        /// <summary>The impression a piece leaves where it finally settles: roughly its footprint.</summary>
        private void MarkRest(WreckFragment f)
        {
            if (OnMark == null)
            {
                return;
            }
            double x = f.Position.X;
            double z = f.Position.Z;
            // The piece's long horizontal axis, from its own orientation.
            Vec3d v = new Vec3d(0, 0, 1).Rotate(f.Quaternion);
            double lng = Math.Max(f.Half.X, f.Half.Z);
            double shrt = Math.Min(f.Half.X, f.Half.Z);
            var at = new Vec3d(x, groundHeightAt(x, z), z);
            OnMark(at, GroundNormal(x, z), v.X, v.Z,
                JsMath.Clamp(lng * 2, 1.2, 14), JsMath.Clamp(shrt * 2, 1, 9), 0.5);
        }

        /// <summary>The strongest fire riding on this piece, if any.</summary>
        private WreckFireKind? BurningKind(WreckFragment f)
        {
            WreckFireKind? kind = null;
            foreach (WreckFire fire in fires)
            {
                if (fire.Fragment == f)
                {
                    if (fire.Kind == WreckFireKind.Fuselage)
                    {
                        return WreckFireKind.Fuselage;
                    }
                    kind = WreckFireKind.WingRoot;
                }
            }
            return kind;
        }

        // --- splitting pieces on the ground -----------------------------------------------

        private void ApplySplits()
        {
            if (pendingSplits.Count == 0)
            {
                return;
            }
            var queue = pendingSplits.ToList();
            pendingSplits.Clear();
            foreach ((WreckFragment fragment, double impact) in queue)
            {
                fragment.SplitQueued = false;
                if (fragment.Disposed || fragments.Count >= MaxFragments)
                {
                    continue;
                }
                SplitFragment(fragment, impact);
            }
        }

        /// <summary>
        /// Cut a piece in two along a plane across its longest side. Each half keeps
        /// the motion of its part of the parent, plus a kick apart; fires and the
        /// cockpit go with whichever half they were in. False if it will not split.
        /// </summary>
        private bool SplitFragment(WreckFragment parent, double impact)
        {
            List<WreckMeshData> meshes = parent.Meshes;
            var box = new WreckBox3();
            foreach (WreckMeshData m in meshes)
            {
                float[] pos = m.Position;
                for (int i = 0; i + 2 < pos.Length; i += 3)
                {
                    box.ExpandByPoint(pos[i], pos[i + 1], pos[i + 2]);
                }
            }
            Vec3d size = box.Size;
            if (Math.Max(size.X, Math.Max(size.Y, size.Z)) < SplitMinSizeM)
            {
                return false;
            }

            var axes = new List<int> { 0, 1, 2 };
            WreckMath.JsSort(axes, (a, b) => WreckMath.Component(size, b) - WreckMath.Component(size, a));
            foreach (int axis in axes)
            {
                double extent = WreckMath.Component(size, axis);
                if (extent < 1.2)
                {
                    continue;
                }
                double mid = WreckMath.Component(box.Min, axis) + extent * (0.5 + (random() - 0.5) * 0.4);
                var sides = new[] { new List<WreckChunkMesh>(), new List<WreckChunkMesh>() };
                var tris = new int[2];
                foreach (WreckMeshData m in meshes)
                {
                    float[] pos = m.Position;
                    int count = pos.Length / 3;
                    var parts = new[] { new WreckChunkMesh(m.Material), new WreckChunkMesh(m.Material) };
                    for (int t = 0; t + 2 < count; t += 3)
                    {
                        double c = ((double)pos[t * 3 + axis] + pos[(t + 1) * 3 + axis] + pos[(t + 2) * 3 + axis]) / 3;
                        int s = c < mid ? 0 : 1;
                        tris[s]++;
                        CopyVertexAttr(parts[s], 0, m.Position, 3, t);
                        if (m.Normal != null) CopyVertexAttr(parts[s], 1, m.Normal, 3, t);
                        if (m.Color != null) CopyVertexAttr(parts[s], 2, m.Color, m.ColorSize, t);
                        if (m.Uv != null) CopyVertexAttr(parts[s], 3, m.Uv, m.UvSize, t);
                    }
                    for (int s = 0; s < 2; s++)
                    {
                        if (parts[s].AttrCount > 0)
                        {
                            sides[s].Add(parts[s]);
                        }
                    }
                }
                if (tris[0] < 2 || tris[1] < 2)
                {
                    continue;
                }
                if (MakeHalves(parent, sides, axis, impact))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>Append vertices t, t+1, t+2 of a float32 attribute to a split part.</summary>
        private static void CopyVertexAttr(WreckChunkMesh part, int which, float[] src, int itemSize, int t)
        {
            List<double> dst = part.Ensure(which, itemSize);
            for (int k = 0; k < 3; k++)
            {
                for (int j = 0; j < itemSize; j++)
                {
                    dst.Add(src[(t + k) * itemSize + j]);
                }
            }
        }

        private bool MakeHalves(WreckFragment parent, List<WreckChunkMesh>[] sides, int axis, double impact)
        {
            // Each half is cut into its connected pieces.
            var pieces = new List<(List<WreckChunkMesh> Parts, int Side)>();
            for (int s = 0; s < 2; s++)
            {
                foreach (List<WreckChunkMesh> parts in ConnectedParts(sides[s]))
                {
                    pieces.Add((parts, s));
                }
            }
            if (pieces.Count < 2)
            {
                return false;
            }
            Quatd q = parent.Quaternion;
            Vec3d axisDir = WreckMath.Unit(axis).Rotate(q);
            var children = new List<WreckFragment>();
            var centresLocal = new List<Vec3d>();
            var boxes = new List<WreckBox3>();

            foreach ((List<WreckChunkMesh> parts, int side) in pieces)
            {
                var box = new WreckBox3();
                foreach (WreckChunkMesh part in parts)
                {
                    List<double> d = part.Pos;
                    for (int i = 0; i + 2 < d.Count; i += 3)
                    {
                        box.ExpandByPoint(d[i], d[i + 1], d[i + 2]);
                    }
                }
                Vec3d centreLocal = box.Center;
                var child = new WreckFragment();
                foreach (WreckChunkMesh part in parts)
                {
                    child.Meshes.Add(ToMeshData(part, centreLocal, true));
                }
                Vec3d rel = centreLocal.Rotate(q);
                child.Quaternion = q;
                child.Position = parent.Position + rel;

                Vec3d half = box.Size * 0.5;
                // Motion of this piece: the parent at its centre, plus a kick apart.
                Vec3d velocity = Vec3d.Cross(parent.Spin, rel) + parent.Velocity;
                double apart = (side == 0 ? -1 : 1) * (1.5 + random() * 4) * Math.Min(1.5, impact / 20);
                velocity = velocity.AddScaled(axisDir, apart);
                velocity = new Vec3d(velocity.X, velocity.Y + random() * 2.5, velocity.Z);
                double sx = (random() - 0.5) * 6;
                double sy = (random() - 0.5) * 4;
                double sz = (random() - 0.5) * 6;
                Vec3d spin = new Vec3d(parent.Spin.X + sx, parent.Spin.Y + sy, parent.Spin.Z + sz);

                child.Centre = parent.Centre;
                child.OriginLocal = parent.OriginLocal - centreLocal;
                child.Depth = parent.Depth + 1;
                child.Tough = parent.Tough;
                child.TrailWidth = JsMath.Clamp(Math.Min(half.X, half.Z), 0.7, 2.5);
                child.ImpactCooldown = 0.4;
                child.Velocity = velocity;
                child.Spin = spin;
                child.Corners = Corners(half);
                child.Half = half;
                child.MarkCooldown = 0.4;
                child.BobPhase = random() * Math.PI * 2;
                child.Gyration2 = Math.Max(0.05, (2.0 / 9) * half.LengthSquared);
                child.Serial = parent.Serial;
                children.Add(child);
                centresLocal.Add(centreLocal);
                boxes.Add(box);
                fragments.Add(child);
                FragmentAdded?.Invoke(child);
            }

            // A point of the parent frame goes with the piece whose geometry is nearest it.
            int Pick(Vec3d local)
            {
                int best = 0;
                double bestD = double.PositiveInfinity;
                for (int i = 0; i < boxes.Count; i++)
                {
                    double d = boxes[i].DistanceToPoint(local);
                    if (d < bestD)
                    {
                        bestD = d;
                        best = i;
                    }
                }
                return best;
            }
            foreach (WreckFire fire in fires)
            {
                if (fire.Fragment == parent)
                {
                    int i = Pick(fire.Local);
                    fire.Fragment = children[i];
                    fire.Local = fire.Local - centresLocal[i];
                }
            }
            foreach (Cockpit c in cockpits.Values)
            {
                if (c.Fragment == parent)
                {
                    int i = Pick(c.Local);
                    c.Fragment = children[i];
                    c.Local = c.Local - centresLocal[i];
                }
            }

            OnSplit?.Invoke(parent.Position, parent.Velocity, Math.Min(1.5, impact / 30));
            int index = fragments.IndexOf(parent);
            if (index >= 0)
            {
                fragments.RemoveAt(index);
            }
            DisposeFragment(parent);
            return true;
        }

        // --- building pieces ----------------------------------------------------------------

        /// <summary>
        /// Triangles of the body sections of a piece that end up joined to nothing:
        /// too small to be a piece and not part of one, so they are dropped. Gear,
        /// surfaces and shards are separate by design and left alone.
        /// </summary>
        private void DropScraps(List<WreckChunk> chunks)
        {
            var meshes = new List<WreckChunkMesh>();
            foreach (WreckChunk chunk in chunks)
            {
                if (chunk.Cell < 0)
                {
                    continue;
                }
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    if (cm.HasPosition)
                    {
                        meshes.Add(cm);
                    }
                }
            }
            var items = new List<(IList<double> Pos, int T)>();
            var itemMesh = new List<int>();
            for (int mesh = 0; mesh < meshes.Count; mesh++)
            {
                List<double> pos = meshes[mesh].Pos;
                for (int t = 0; t < pos.Count / 9; t++)
                {
                    items.Add((pos, t));
                    itemMesh.Add(mesh);
                }
            }
            if (items.Count == 0)
            {
                return;
            }
            List<List<int>> groups = GroupTriangles(items);
            if (groups.Count < 2)
            {
                return;
            }
            int main = 0;
            for (int i = 1; i < groups.Count; i++)
            {
                if (groups[i].Count > groups[main].Count)
                {
                    main = i;
                }
            }
            var dropOrder = new List<int>();
            var drop = new Dictionary<int, HashSet<int>>();
            for (int i = 0; i < groups.Count; i++)
            {
                if (i == main || groups[i].Count >= ComponentMinTris)
                {
                    continue;
                }
                foreach (int j in groups[i])
                {
                    int mesh = itemMesh[j];
                    if (!drop.TryGetValue(mesh, out HashSet<int> list))
                    {
                        list = new HashSet<int>();
                        drop[mesh] = list;
                        dropOrder.Add(mesh);
                    }
                    list.Add(items[j].T);
                }
            }
            foreach (int mesh in dropOrder)
            {
                meshes[mesh].RemoveTriangles(drop[mesh]);
                LastScrapTriangles += drop[mesh].Count;
            }
        }

        private static Vec3d[] Corners(Vec3d half)
        {
            var corners = new Vec3d[8];
            for (int i = 0; i < 8; i++)
            {
                corners[i] = new Vec3d(
                    ((i & 1) != 0 ? 1 : -1) * half.X,
                    ((i & 2) != 0 ? 1 : -1) * half.Y,
                    ((i & 4) != 0 ? 1 : -1) * half.Z);
            }
            return corners;
        }

        /// <summary>
        /// A chunk mesh as the float32 geometry the TS builds: <c>new Float32Array(data)</c>,
        /// positions then less the centre in float32 (when <paramref name="subtract"/>).
        /// </summary>
        private static WreckMeshData ToMeshData(WreckChunkMesh cm, Vec3d centre, bool subtract)
        {
            var mesh = new WreckMeshData { Material = cm.Material };
            if (cm.Pos != null)
            {
                var data = new float[cm.Pos.Count];
                for (int i = 0; i < data.Length; i++)
                {
                    data[i] = (float)cm.Pos[i];
                }
                if (subtract)
                {
                    for (int i = 0; i + 2 < data.Length; i += 3)
                    {
                        data[i] = (float)(data[i] - centre.X);
                        data[i + 1] = (float)(data[i + 1] - centre.Y);
                        data[i + 2] = (float)(data[i + 2] - centre.Z);
                    }
                }
                mesh.Position = data;
            }
            if (cm.Nrm != null) mesh.Normal = ToFloats(cm.Nrm);
            if (cm.Col != null)
            {
                mesh.Color = ToFloats(cm.Col);
                mesh.ColorSize = cm.ColSize;
            }
            if (cm.Uv != null)
            {
                mesh.Uv = ToFloats(cm.Uv);
                mesh.UvSize = cm.UvSize;
            }
            return mesh;
        }

        private static float[] ToFloats(List<double> data)
        {
            var output = new float[data.Count];
            for (int i = 0; i < output.Length; i++)
            {
                output[i] = (float)data[i];
            }
            return output;
        }

        private WreckFragment BuildFragment(List<WreckChunk> chunks, bool isHull, Vec3d origin, Vec3d vNormal, Vec3d vTangent,
            Vec3d groundN, Vec3d impact, double severity, double size)
        {
            DropScraps(chunks);
            var box = new WreckBox3();
            foreach (WreckChunk c in chunks)
            {
                box.Union(c.Box);
            }
            Vec3d centre = box.Center;

            var fragment = new WreckFragment();
            foreach (WreckChunk c in chunks)
            {
                foreach (WreckChunkMesh cm in c.Meshes)
                {
                    fragment.Meshes.Add(ToMeshData(cm, centre, true));
                }
            }
            fragment.Position = origin + centre;

            Vec3d half = box.Size * 0.5;
            double gyration2 = Math.Max(0.05, (2.0 / 9) * half.LengthSquared);

            // Velocity at this piece: what the airframe carried, less what the ground took out of it
            // close to the impact, plus a kick away from it.
            Vec3d away = centre - impact;
            double dist = away.Length;
            double loss = JsMath.Clamp(1.15 - dist / size, 0, 1) * Math.Min(1, severity);
            // Normal component: stop going into the ground, with a little bounce.
            double into = Math.Min(0, Vec3d.Dot(vNormal, groundN));
            Vec3d velocity = vTangent * (1 - (BaseFriction + 0.45 * loss) * Math.Min(1, severity));
            velocity = velocity.AddScaled(groundN, -into * (0.04 + 0.08 * random()) * (isHull ? 0.4 : 1));
            if (dist > 1e-3)
            {
                away = away * (1 / dist);
            }
            else
            {
                away = new Vec3d(0, 1, 0);
            }
            away = away.AddScaled(groundN, 0.6);
            double ax = (random() - 0.5) * 0.6;
            double az = (random() - 0.5) * 0.6;
            away = new Vec3d(away.X + ax, away.Y, away.Z + az).Normalized();
            double kick = isHull ? 0 : severity * (3 + 11 * random()) * (0.4 + loss);
            velocity = velocity.AddScaled(away, kick);
            // A piece nearest a hard hit also loses forward speed outright.
            velocity = velocity * (isHull ? 1 : 1 - 0.3 * loss);

            // Spin: lever arm from the impact point, plus tumble that scales with the hit.
            Vec3d spin = Vec3d.Cross(centre - impact, vTangent) * (0.012 / Math.Max(1, size * 0.1));
            double tumble = isHull ? 0.12 : 0.6;
            double tx = (random() - 0.5) * 2 * severity * 9 * tumble;
            double ty = (random() - 0.5) * 2 * severity * 6 * tumble;
            double tz = (random() - 0.5) * 2 * severity * 9 * tumble;
            spin = new Vec3d(spin.X + tx, spin.Y + ty, spin.Z + tz);

            fragment.Centre = centre;
            fragment.OriginLocal = -centre;
            fragment.Tough = chunks.Any(c => c.Cell >= 0 && c.Cell <= 2);
            fragment.TrailWidth = JsMath.Clamp(Math.Min(half.X, half.Z), 0.7, 2.5);
            fragment.Half = half;
            fragment.BobPhase = random() * Math.PI * 2;
            fragment.Velocity = velocity;
            fragment.Spin = spin;
            fragment.Corners = Corners(half);
            fragment.Gyration2 = gyration2;
            fragment.Serial = serial;
            fragments.Add(fragment);
            FragmentAdded?.Invoke(fragment);
            return fragment;
        }

        // --- physics ------------------------------------------------------------------------

        /// <summary>How big a piece is across, for the foam round it (m, kept to a sensible range).</summary>
        private static double Footprint(WreckFragment f) => JsMath.Clamp(Math.Max(f.Half.X, f.Half.Z), 0.8, 8);

        /// <summary>
        /// A piece over the sea: it falls until it reaches the surface, splashes,
        /// floats for a while riding low and bobbing, then sinks slowly.
        /// </summary>
        private void StepOverWater(WreckFragment f, double dt)
        {
            double waterY = waterSurfaceAt != null
                ? waterSurfaceAt(f.Position.X, f.Position.Z)
                : groundHeightAt(f.Position.X, f.Position.Z);
            f.WaterY = waterY;
            f.WasTouching = false;
            f.RestTime = 0;
            if (!f.Wet)
            {
                if (f.Position.Y - f.Half.Y * 0.4 > waterY)
                {
                    return; // still on its way down
                }
                f.Wet = true;
                double horizontal = JsMath.Hypot(f.Velocity.X, f.Velocity.Z);
                double strength = JsMath.Clamp((Math.Max(0, -f.Velocity.Y) + 0.3 * horizontal) / 60, 0.2, 1.6);
                OnSplash?.Invoke(new Vec3d(f.Position.X, waterY, f.Position.Z), f.Velocity, strength);
                f.Velocity = f.Velocity * WaterEntryKeep;
                f.Spin = f.Spin * WaterSpinKeep;
                OnFoam?.Invoke(new Vec3d(f.Position.X, waterY, f.Position.Z), Footprint(f), FoamEntryPuffs);
                return;
            }
            f.WetTime += dt;
            // The water carries the piece's weight: undo the gravity step() has just applied.
            double vy = f.Velocity.Y + Gravity * dt;
            double drag = Math.Max(0, 1 - WaterDragPerS * dt);
            double vx = f.Velocity.X * drag;
            double vz = f.Velocity.Z * drag;
            if (f.WetTime < WaterFloatS)
            {
                // Buoyant: held with its lower part under, bobbing a little.
                double bob = JsTrig.Sin(f.WetTime * 1.7 + f.BobPhase) * WaterBobM;
                double rideY = waterY - f.Half.Y * WaterFloatDepth + bob;
                double want = JsMath.Clamp((rideY - f.Position.Y) * 3, -3, 3);
                vy += (want - vy) * (1 - WreckMath.Exp(-6 * dt));
            }
            else
            {
                // Then it starts to sink, easing into the slow descent.
                double ease = Math.Min(1, (f.WetTime - WaterFloatS) / WaterSinkEaseS);
                vy += (-WaterSinkMps * ease - vy) * (1 - WreckMath.Exp(-WaterSinkRelaxPerS * dt));
            }
            f.Velocity = new Vec3d(vx, vy, vz);
            f.Spin = f.Spin * Math.Max(0, 1 - WaterSpinDragPerS * dt);
            double depth = waterY - f.Position.Y;
            f.Submerged = depth > WaterSubmergedM;
            if (OnFoam != null)
            {
                double churn = f.WetTime < FoamEntryS ? 1
                    : f.WetTime < WaterFloatS ? FoamFloatingStrength
                    : JsMath.Clamp(1 - Math.Max(0, depth) / FoamNoneDepthM, 0, 1);
                double size = Footprint(f);
                f.FoamAccum += (FoamRateBase + FoamRatePerM * size) * churn * dt;
                double puffs = Math.Floor(f.FoamAccum);
                if (puffs > 0)
                {
                    f.FoamAccum -= puffs;
                    // On the surface, over the piece's own spot.
                    OnFoam(new Vec3d(f.Position.X, waterY, f.Position.Z), size, (int)puffs);
                }
            }
            if (depth > WaterHideDepthM)
            {
                f.Asleep = true;
                f.Visible = false;
                f.Velocity = Vec3d.Zero;
                f.Spin = Vec3d.Zero;
            }
        }

        private void Step(WreckFragment f, double dt)
        {
            // The ground may itself be moving (a carrier deck): friction acts on the piece's velocity
            // relative to it, and a piece that comes to rest does so on it.
            Vec3d vs = f.OnMover && movingSurface != null ? movingSurface.Velocity : Vec3d.Zero;
            Vec3d vel = new Vec3d(f.Velocity.X, f.Velocity.Y - Gravity * dt, f.Velocity.Z);
            // Light drag so debris does not carry like a bullet.
            double drag = Math.Max(0, 1 - 0.04 * dt);
            f.Velocity = vel * drag;
            f.Position = f.Position.AddScaled(f.Velocity, dt);

            double angle = f.Spin.Length * dt;
            if (angle > 1e-6)
            {
                Quatd dq = Quatd.FromAxisAngle(f.Spin.Normalized(), angle);
                f.Quaternion = (dq * f.Quaternion).Normalized();
            }

            // Over open water there is no ground to land on; once in, a piece stays in.
            if (isWaterAt != null && (f.Wet || isWaterAt(f.Position.X, f.Position.Z)))
            {
                StepOverWater(f, dt);
                return;
            }

            // Contact: each AABB corner against the ground, resolved with impulses.
            Vec3d n = GroundNormal(f.Position.X, f.Position.Z);
            bool touched = false;
            double worst = 0;
            double hardest = 0;
            double hitX = 0;
            double hitZ = 0;
            f.ImpactCooldown -= dt;
            foreach (Vec3d c in f.Corners)
            {
                Vec3d r = c.Rotate(f.Quaternion);
                double wx = f.Position.X + r.X;
                double wz = f.Position.Z + r.Z;
                double pen = groundHeightAt(wx, wz) - (f.Position.Y + r.Y);
                if (pen <= 0)
                {
                    continue;
                }
                touched = true;
                worst = Math.Max(worst, pen);
                // Velocity of the corner, relative to the ground it is on.
                Vec3d v = Vec3d.Cross(f.Spin, r) + f.Velocity - vs;
                double vn = Vec3d.Dot(v, n);
                if (vn >= 0)
                {
                    continue;
                }
                if (-vn > hardest)
                {
                    hardest = -vn;
                    hitX = wx;
                    hitZ = wz;
                }
                Vec3d rn = Vec3d.Cross(r, n);
                double e = vn < -6 ? 0.07 : 0;
                double j = -(1 + e) * vn / (1 + rn.LengthSquared / f.Gyration2);
                f.Velocity = f.Velocity.AddScaled(n, j);
                // angular impulse: r x (j n) / k^2
                f.Spin = f.Spin.AddScaled(rn, j / f.Gyration2);
                // Coulomb friction along the sliding direction.
                v = Vec3d.Cross(f.Spin, r) + f.Velocity - vs;
                Vec3d vtan = v.AddScaled(n, -Vec3d.Dot(v, n));
                double vtLen = vtan.Length;
                if (vtLen > 1e-4)
                {
                    double jt = Math.Min(0.55 * j, vtLen / (1 + 1 / f.Gyration2 * 0.5));
                    vtan = vtan * (-jt / vtLen);
                    f.Velocity = f.Velocity + vtan;
                    f.Spin = f.Spin.AddScaled(Vec3d.Cross(r, vtan), 1 / f.Gyration2);
                }
            }
            if (hardest > 2.5 && f.ImpactCooldown <= 0 && OnDust != null)
            {
                // A puff where the piece struck: more for a harder blow.
                f.ImpactCooldown = 0.25;
                var at = new Vec3d(hitX, groundHeightAt(hitX, hitZ) + 0.3, hitZ);
                OnDust(at, f.Velocity, (int)Math.Min(30, JsMath.Round(5 + hardest * 0.7)), Math.Min(1.2, hardest / 40));
            }
            // (A piece holding fuselage is never split: the fuselage stays whole.)
            if (!f.Tough && hardest > SplitMinImpactMps && !f.SplitQueued && f.Depth < SplitMaxDepth
                && random() < (hardest - SplitMinImpactMps) / (SplitSureImpactMps - SplitMinImpactMps))
            {
                f.SplitQueued = true;
                pendingSplits.Add((f, hardest));
            }
            f.MarkCooldown -= dt;
            if (OnMark != null && f.MarkCooldown <= 0 && (hardest > 0.6 || (touched && !f.WasTouching)))
            {
                // A dent wherever a piece touches down, sized by how hard it struck.
                f.MarkCooldown = 0.12;
                double x = hardest > 0 ? hitX : f.Position.X;
                double z = hardest > 0 ? hitZ : f.Position.Z;
                double size = Math.Min(5, 0.8 + Math.Max(hardest, 1) * 0.12);
                OnMark(new Vec3d(x, groundHeightAt(x, z), z), GroundNormal(x, z),
                    f.Velocity.X - vs.X, f.Velocity.Z - vs.Z, size * 1.3, size, Math.Min(0.8, 0.4 + hardest * 0.04));
            }
            f.WasTouching = touched;
            if (touched)
            {
                f.Position = new Vec3d(f.Position.X, f.Position.Y + Math.Min(worst, 3) * 0.8, f.Position.Z);
                double relX = f.Velocity.X - vs.X;
                double relZ = f.Velocity.Z - vs.Z;
                double slide = JsMath.Hypot(relX, relZ);
                if (OnMark != null && slide > 0.8 && f.TrailMarks < TrailMarksMax)
                {
                    f.SlideAccum += slide * dt;
                    if (f.SlideAccum >= TrailStepM)
                    {
                        f.SlideAccum = 0;
                        f.TrailMarks++;
                        double px = f.Position.X;
                        double pz = f.Position.Z;
                        var at = new Vec3d(px, groundHeightAt(px, pz), pz);
                        OnMark(at, GroundNormal(px, pz), relX, relZ, TrailStepM * 1.25, f.TrailWidth, 0.45);
                        // A piece with a fire on it sets its scratch alight: the fuselage burns longest.
                        if (OnBurn != null)
                        {
                            WreckFireKind? kind = BurningKind(f);
                            if (kind != null)
                            {
                                bool fuselage = kind == WreckFireKind.Fuselage;
                                OnBurn(at, fuselage ? 40 + random() * 25 : 18 + random() * 14, fuselage ? 1 : 0.6);
                            }
                        }
                    }
                }
                if (OnDust != null && slide > 5)
                {
                    f.DustAccum += dt * Math.Min(14, slide * 0.5);
                    if (f.DustAccum >= 1)
                    {
                        double count = Math.Floor(f.DustAccum);
                        f.DustAccum -= count;
                        var at = new Vec3d(f.Position.X, groundHeightAt(f.Position.X, f.Position.Z) + 0.3, f.Position.Z);
                        OnDust(at, f.Velocity, (int)count, Math.Min(1, slide / 60));
                    }
                }
                // Sliding wreckage scrubs off spin and speed.
                f.Spin = f.Spin * Math.Max(0, 1 - 1.2 * dt);
                // A long piece does not stand on end: once it is slow it topples onto its side.
                double standing = StandingAmount(f);
                if (standing == 0)
                {
                    // Not on its end, but perched on a wingtip or an edge: settle onto its flat side.
                    standing = SettleTilt(f);
                }
                if (standing > 0)
                {
                    // A piece that cannot settle gives up after a while and is let to rest as it is.
                    f.SettleS = (f.SettleS ?? 0) + dt;
                    if (f.SettleS > SettleGiveUpS)
                    {
                        standing = 0;
                    }
                    else
                    {
                        Vec3d torque = Vec3d.Cross(new Vec3d(0, 1, 0), toppleAxis);
                        if (torque.LengthSquared < 1e-6)
                        {
                            // Exactly upright: no torque at all. A breath of wind tips it.
                            double t = random() * Math.PI * 2;
                            torque = new Vec3d(JsTrig.Cos(t), 0, JsTrig.Sin(t));
                        }
                        f.Spin = f.Spin.AddScaled(torque, ToppleRadps2 * standing * dt);
                    }
                }
                double scrub = Math.Max(0, 1 - 0.35 * dt);
                f.Velocity = new Vec3d(vs.X + (f.Velocity.X - vs.X) * scrub, f.Velocity.Y, vs.Z + (f.Velocity.Z - vs.Z) * scrub);
                double restX = f.Velocity.X - vs.X;
                double restZ = f.Velocity.Z - vs.Z;
                if (standing == 0 && restX * restX + f.Velocity.Y * f.Velocity.Y + restZ * restZ < SleepSpeedMps * SleepSpeedMps
                    && f.Spin.LengthSquared < SleepSpinRadps * SleepSpinRadps)
                {
                    f.RestTime += dt;
                    if (f.RestTime > SleepAfterS)
                    {
                        f.Asleep = true;
                        // At rest relative to the ground: still going with it if that moves.
                        f.Velocity = vs;
                        f.Spin = Vec3d.Zero;
                        MarkRest(f);
                    }
                }
                else
                {
                    f.RestTime = 0;
                }
            }
            else
            {
                f.RestTime = 0;
            }
        }

        // --- toppling and settling ---------------------------------------------------------

        /// <summary>0 for a piece lying down; up to 1 for a long piece standing on end. Leaves its long axis (world) in toppleAxis.</summary>
        private double StandingAmount(WreckFragment f)
        {
            Vec3d h = f.Half;
            int axis = 0;
            double len = h.X;
            if (h.Y > len)
            {
                axis = 1;
                len = h.Y;
            }
            if (h.Z > len)
            {
                axis = 2;
                len = h.Z;
            }
            double others = h.X + h.Y + h.Z - len;
            if (len < ToppleMinHalfM || len < 0.5 * others * 1.0)
            {
                return TallAmount(f);
            }
            toppleAxis = WreckMath.Unit(axis).Rotate(f.Quaternion);
            if (toppleAxis.Y < 0)
            {
                toppleAxis = -toppleAxis;
            }
            double up = Math.Abs(toppleAxis.Y);
            return up > ToppleMinUp ? up : 0;
        }

        /// <summary>A piece tall for its footprint (a fuselage folded into a V, standing on its ends): how far over the limit, up to 1.</summary>
        private double TallAmount(WreckFragment f)
        {
            double[] e = WreckMath.RotationFromQuaternion(f.Quaternion);
            Vec3d h = f.Half;
            double worldY = Math.Abs(e[1]) * h.X + Math.Abs(e[5]) * h.Y + Math.Abs(e[9]) * h.Z;
            double worldX = Math.Abs(e[0]) * h.X + Math.Abs(e[4]) * h.Y + Math.Abs(e[8]) * h.Z;
            double worldZ = Math.Abs(e[2]) * h.X + Math.Abs(e[6]) * h.Y + Math.Abs(e[10]) * h.Z;
            double footprint = Math.Max(worldX, worldZ);
            if (worldY < ToppleMinHalfM || worldY < TallRatio * footprint)
            {
                return 0;
            }
            double ax = Math.Abs(e[1]);
            double ay = Math.Abs(e[5]);
            double az = Math.Abs(e[9]);
            int k = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
            toppleAxis = new Vec3d(e[k * 4], e[k * 4 + 1], e[k * 4 + 2]);
            if (toppleAxis.Y < 0)
            {
                toppleAxis = -toppleAxis;
            }
            return Math.Min(1, (worldY / footprint - TallRatio) + 0.3);
        }

        /// <summary>0 for a flat-ish piece lying on its broad side; otherwise how far it is tipped from that (sin of the angle, scaled, up to 1).</summary>
        private double SettleTilt(WreckFragment f)
        {
            Vec3d h = f.Half;
            double big = Math.Max(h.X, Math.Max(h.Y, h.Z));
            if (big < SettleMinHalfM)
            {
                return 0;
            }
            // The thinnest axis, and the middle one: only a clearly flat piece has a "flat side".
            int axis = 0;
            double thin = h.X;
            if (h.Y < thin)
            {
                axis = 1;
                thin = h.Y;
            }
            if (h.Z < thin)
            {
                axis = 2;
                thin = h.Z;
            }
            double mid = h.X + h.Y + h.Z - big - thin;
            if (thin > SettleFlatness * mid)
            {
                return 0;
            }
            toppleAxis = WreckMath.Unit(axis).Rotate(f.Quaternion);
            if (toppleAxis.Y < 0)
            {
                toppleAxis = -toppleAxis;
            }
            double sin = Math.Sqrt(Math.Max(0, 1 - toppleAxis.Y * toppleAxis.Y));
            if (sin < SettleMinSin)
            {
                return 0;
            }
            toppleAxis = -toppleAxis; // so up x (-axis) = axis x up
            return Math.Min(1, sin * 1.5);
        }
    }
}
