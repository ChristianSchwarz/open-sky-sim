using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;

namespace Retro.Game
{
    public sealed partial class WreckField
    {
        // --- slicing (wreckField.ts sliceBody, slicePartChunks, splitGearLegs) ---------------

        private static double[] MatrixOf(WreckMeshInput mesh) => mesh.Matrix ?? WreckMath.Identity();

        private static bool Drawable(WreckMeshInput mesh) => mesh != null && mesh.Positions != null;

        private static int TriangleCount(WreckMeshInput mesh) =>
            (mesh.Indices != null ? mesh.Indices.Length : mesh.Positions.Length / 3) / 3;

        /// <summary>Cut the body's meshes into sections. Null if there is no geometry.</summary>
        private List<WreckChunk> SliceBody(WreckSource src)
        {
            if (src.Body == null || src.Body.Meshes == null || src.Body.Meshes.Count == 0)
            {
                return null;
            }
            List<WreckMeshInput> meshes = src.Body.Meshes.Where(Drawable).ToList();
            if (meshes.Count == 0)
            {
                return null;
            }

            // Body-local bounds decide where the section cuts fall.
            var bounds = new WreckBox3();
            foreach (WreckMeshInput mesh in meshes)
            {
                double[] matrix = MatrixOf(mesh);
                float[] pos = mesh.Positions;
                for (int i = 0; i + 2 < pos.Length; i += 3)
                {
                    bounds.ExpandByPoint(WreckMath.ApplyMatrix4(new Vec3d(pos[i], pos[i + 1], pos[i + 2]), matrix));
                }
            }
            double cx = 0.5 * (bounds.Min.X + bounds.Max.X);
            double halfSpan = Math.Max(0.5 * (bounds.Max.X - bounds.Min.X), 1e-3);
            double zMin = bounds.Min.Z;
            double zLen = Math.Max(bounds.Max.Z - bounds.Min.Z, 1e-3);
            bodyFrame = new BodyFrameInfo { Cx = cx, ZMin = zMin, ZMax = bounds.Max.Z, HalfSpan = halfSpan };

            int CellOf(double x, double z)
            {
                double ax = Math.Abs(x - cx) / halfSpan;
                if (ax < 0.2)
                {
                    return (int)Math.Min(2, Math.Floor(JsMath.Clamp((z - zMin) / zLen, 0, 0.999) * 3));
                }
                int side = x < cx ? 0 : 1;
                return 3 + side * 2 + (ax > 0.6 ? 1 : 0);
            }

            var chunks = new List<WreckChunk>();
            var localBoxes = new List<WreckBox3>();
            for (int c = 0; c < CellCount; c++)
            {
                chunks.Add(new WreckChunk { Cell = c, Weakness = CellWeakness[c] });
                localBoxes.Add(new WreckBox3());
            }
            double[] rot = WreckMath.RotationFromQuaternion(src.Quaternion);
            double[] scaleM = WreckMath.MakeScale(src.Scale.X, src.Scale.Y, src.Scale.Z);
            double[] toWorldRel = WreckMath.Multiply(rot, scaleM);

            foreach (WreckMeshInput mesh in meshes)
            {
                double[] matrix = MatrixOf(mesh);
                float[] pos = mesh.Positions;
                int[] index = mesh.Indices;
                int triCount = TriangleCount(mesh);
                var perCell = new WreckChunkMesh[CellCount];
                double[] modelToWorldRel = WreckMath.Multiply(toWorldRel, matrix);
                double[] nm = WreckMath.NormalMatrix(modelToWorldRel);

                for (int t = 0; t < triCount; t++)
                {
                    int ia = index != null ? index[t * 3] : t * 3;
                    int ib = index != null ? index[t * 3 + 1] : t * 3 + 1;
                    int ic = index != null ? index[t * 3 + 2] : t * 3 + 2;
                    double sx = 0, sy = 0, sz = 0;
                    foreach (int vi in new[] { ia, ib, ic })
                    {
                        sx += pos[vi * 3];
                        sy += pos[vi * 3 + 1];
                        sz += pos[vi * 3 + 2];
                    }
                    Vec3d centroid = WreckMath.ApplyMatrix4(new Vec3d(sx, sy, sz) * (1.0 / 3), matrix);
                    int cell = CellOf(centroid.X, centroid.Z);
                    localBoxes[cell].ExpandByPoint(centroid);
                    WreckChunkMesh cm = perCell[cell];
                    if (cm == null)
                    {
                        cm = new WreckChunkMesh(mesh.Material);
                        perCell[cell] = cm;
                        chunks[cell].Meshes.Add(cm);
                    }
                    AppendTriangle(cm, mesh, ia, ib, ic, modelToWorldRel, nm, chunks[cell].Box);
                }
            }

            // Fire spots, in body-local space: the fuselage's middle, and each wing root.
            void AnchorAt(int cell, Func<WreckBox3, Vec3d> pick)
            {
                if (localBoxes[cell].IsEmpty)
                {
                    return;
                }
                chunks[cell].Anchor = WreckMath.ApplyMatrix4(pick(localBoxes[cell]), toWorldRel);
            }
            AnchorAt(1, b => b.Center);
            AnchorAt(3, b => { Vec3d o = b.Center; return new Vec3d(b.Max.X, o.Y, o.Z); });
            AnchorAt(5, b => { Vec3d o = b.Center; return new Vec3d(b.Min.X, o.Y, o.Z); });
            return chunks.Where(c => c.Meshes.Count > 0).ToList();
        }

        /// <summary>Copy one triangle's attributes (position transformed, normal by the normal matrix) into a chunk mesh.</summary>
        private static void AppendTriangle(WreckChunkMesh cm, WreckMeshInput mesh, int ia, int ib, int ic, double[] m, double[] nm, WreckBox3 box)
        {
            int[] verts = { ia, ib, ic };
            {
                List<double> dst = cm.Ensure(0, 3);
                foreach (int vi in verts)
                {
                    Vec3d r = WreckMath.ApplyMatrix4(new Vec3d(mesh.Positions[vi * 3], mesh.Positions[vi * 3 + 1], mesh.Positions[vi * 3 + 2]), m);
                    dst.Add(r.X);
                    dst.Add(r.Y);
                    dst.Add(r.Z);
                    box.ExpandByPoint(r);
                }
            }
            if (mesh.Normals != null)
            {
                List<double> dst = cm.Ensure(1, 3);
                foreach (int vi in verts)
                {
                    Vec3d r = WreckMath.ApplyMatrix3(new Vec3d(mesh.Normals[vi * 3], mesh.Normals[vi * 3 + 1], mesh.Normals[vi * 3 + 2]), nm).Normalized();
                    dst.Add(r.X);
                    dst.Add(r.Y);
                    dst.Add(r.Z);
                }
            }
            if (mesh.Colors != null)
            {
                List<double> dst = cm.Ensure(2, mesh.ColorSize);
                foreach (int vi in verts)
                {
                    for (int k = 0; k < mesh.ColorSize; k++) dst.Add(mesh.Colors[vi * mesh.ColorSize + k]);
                }
            }
            if (mesh.Uvs != null)
            {
                List<double> dst = cm.Ensure(3, mesh.UvSize);
                foreach (int vi in verts)
                {
                    for (int k = 0; k < mesh.UvSize; k++) dst.Add(mesh.Uvs[vi * mesh.UvSize + k]);
                }
            }
        }

        /// <summary>Each gear leg / control surface is a chunk of its own.</summary>
        private List<WreckChunk> SlicePartChunks(WreckSource src)
        {
            var output = new List<WreckChunk>();
            for (int partIndex = 0; partIndex < src.Parts.Count; partIndex++)
            {
                WreckPart part = src.Parts[partIndex];
                if (part.Model == null || part.Model.Meshes == null || part.Model.Meshes.Count == 0)
                {
                    continue;
                }
                List<WreckMeshInput> meshes = part.Model.Meshes.Where(Drawable).ToList();
                if (meshes.Count == 0)
                {
                    continue;
                }
                Vec3d rel = part.Position - src.Position;
                double[] xf = WreckMath.Compose(rel, part.Quaternion, src.Scale);
                var chunk = new WreckChunk
                {
                    Cell = -1,
                    Gear = part.Kind == WreckPartKind.Gear,
                    PartId = part.Id ?? partIndex,
                    Weakness = part.Kind == WreckPartKind.Gear ? 1.4 : 1.2,
                };
                foreach (WreckMeshInput mesh in meshes)
                {
                    double[] m = WreckMath.Multiply(xf, MatrixOf(mesh));
                    double[] nm = WreckMath.NormalMatrix(m);
                    var cm = new WreckChunkMesh(mesh.Material);
                    int triCount = TriangleCount(mesh);
                    int[] index = mesh.Indices;
                    for (int t = 0; t < triCount; t++)
                    {
                        int ia = index != null ? index[t * 3] : t * 3;
                        int ib = index != null ? index[t * 3 + 1] : t * 3 + 1;
                        int ic = index != null ? index[t * 3 + 2] : t * 3 + 2;
                        AppendTriangle(cm, mesh, ia, ib, ic, m, nm, chunk.Box);
                    }
                    chunk.Meshes.Add(cm);
                }
                if (part.Kind == WreckPartKind.Gear)
                {
                    output.AddRange(SplitGearLegs(chunk));
                }
                else
                {
                    output.Add(chunk);
                }
            }
            return output;
        }

        private sealed class GearLeg
        {
            public List<(int Cm, int T)> Tris = new List<(int, int)>();
            public WreckBox3 Box = new WreckBox3();
        }

        /// <summary>
        /// A gear part is a lump of several legs: split it into one chunk per leg, so
        /// each can bend or tear off on its own. Triangles that share a vertex belong
        /// together, and so do pieces whose boxes touch. The first leg keeps the
        /// part's own id, the others get 1000 + 16 id + k.
        /// </summary>
        private static List<WreckChunk> SplitGearLegs(WreckChunk chunk)
        {
            var tris = new List<(int Cm, int T)>();
            for (int ci = 0; ci < chunk.Meshes.Count; ci++)
            {
                int n = (chunk.Meshes[ci].Pos?.Count ?? 0) / 9;
                for (int t = 0; t < n; t++)
                {
                    tris.Add((ci, t));
                }
            }
            if (tris.Count < 2)
            {
                return new List<WreckChunk> { chunk };
            }
            var parent = new int[tris.Count];
            for (int i = 0; i < parent.Length; i++) parent[i] = i;
            int Find(int i)
            {
                while (parent[i] != i)
                {
                    parent[i] = parent[parent[i]];
                    i = parent[i];
                }
                return i;
            }
            var keyOwner = new Dictionary<(long, long, long), int>();
            for (int ti = 0; ti < tris.Count; ti++)
            {
                List<double> d = chunk.Meshes[tris[ti].Cm].Pos;
                for (int v = 0; v < 3; v++)
                {
                    int o = tris[ti].T * 9 + v * 3;
                    var key = ((long)JsMath.Round(d[o] / WeldM), (long)JsMath.Round(d[o + 1] / WeldM), (long)JsMath.Round(d[o + 2] / WeldM));
                    if (!keyOwner.TryGetValue(key, out int seen))
                    {
                        keyOwner[key] = ti;
                    }
                    else
                    {
                        parent[Find(ti)] = Find(seen);
                    }
                }
            }
            // Group, with a box each.
            var groupOrder = new List<int>();
            var groups = new Dictionary<int, GearLeg>();
            for (int ti = 0; ti < tris.Count; ti++)
            {
                int r = Find(ti);
                if (!groups.TryGetValue(r, out GearLeg g))
                {
                    g = new GearLeg();
                    groups[r] = g;
                    groupOrder.Add(r);
                }
                g.Tris.Add(tris[ti]);
                List<double> d = chunk.Meshes[tris[ti].Cm].Pos;
                for (int v = 0; v < 3; v++)
                {
                    int o = tris[ti].T * 9 + v * 3;
                    g.Box.ExpandByPoint(d[o], d[o + 1], d[o + 2]);
                }
            }
            // Merge pieces whose boxes touch.
            List<GearLeg> legs = groupOrder.Select(r => groups[r]).ToList();
            bool merged = true;
            while (merged && legs.Count > 1)
            {
                merged = false;
                for (int i = 0; i < legs.Count && !merged; i++)
                {
                    for (int j = i + 1; j < legs.Count; j++)
                    {
                        WreckBox3 grown = legs[i].Box.Clone();
                        grown.ExpandByScalar(GearLegMergeM);
                        if (grown.IntersectsBox(legs[j].Box))
                        {
                            legs[i].Tris.AddRange(legs[j].Tris);
                            legs[i].Box.Union(legs[j].Box);
                            legs.RemoveAt(j);
                            merged = true;
                            break;
                        }
                    }
                }
            }
            if (legs.Count < 2)
            {
                return new List<WreckChunk> { chunk };
            }
            WreckMath.JsSort(legs, (a, b) =>
            {
                Vec3d centreA = a.Box.Center;
                Vec3d centreB = b.Box.Center;
                return Math.Abs(centreA.X - centreB.X) > 0.05 ? centreA.X - centreB.X : centreA.Z - centreB.Z;
            });
            int baseId = chunk.PartId ?? 0;
            var output = new List<WreckChunk>();
            for (int k = 0; k < legs.Count; k++)
            {
                GearLeg leg = legs[k];
                var outChunk = new WreckChunk
                {
                    Cell = -1,
                    Gear = true,
                    PartId = k == 0 ? baseId : GearLegIdBase + baseId * 16 + k,
                    Box = leg.Box,
                    Weakness = chunk.Weakness,
                };
                for (int ci = 0; ci < chunk.Meshes.Count; ci++)
                {
                    WreckChunkMesh cm = chunk.Meshes[ci];
                    List<(int Cm, int T)> mine = leg.Tris.Where(t => t.Cm == ci).ToList();
                    if (mine.Count == 0)
                    {
                        continue;
                    }
                    var nm = new WreckChunkMesh(cm.Material);
                    foreach ((List<double> data, int itemSize, int which) in cm.Attrs())
                    {
                        List<double> dst = nm.Ensure(which, itemSize);
                        int per = itemSize * 3;
                        foreach ((int _, int t) in mine)
                        {
                            for (int i = 0; i < per; i++)
                            {
                                dst.Add(data[t * per + i]);
                            }
                        }
                    }
                    outChunk.Meshes.Add(nm);
                }
                output.Add(outChunk);
            }
            return output;
        }

        private static Vec3d LowestVertex(IEnumerable<WreckChunk> chunks)
        {
            Vec3d best = Vec3d.Zero;
            double bestY = double.PositiveInfinity;
            foreach (WreckChunk c in chunks)
            {
                foreach (WreckChunkMesh cm in c.Meshes)
                {
                    List<double> p = cm.Pos;
                    if (p == null) continue;
                    for (int i = 0; i + 2 < p.Count; i += 3)
                    {
                        if (p[i + 1] < bestY)
                        {
                            bestY = p[i + 1];
                            best = new Vec3d(p[i], p[i + 1], p[i + 2]);
                        }
                    }
                }
            }
            return best;
        }

        // --- bending (bendGearLegs, bendWings, dislocateFuselage) ----------------------------

        /// <summary>
        /// Fold the gear legs the blow reached: each leg near the impact swings about
        /// its top, as a whole, by up to 2.4 rad, and stays on until it tears.
        /// </summary>
        private void BendGearLegs(List<WreckChunk> partChunks, WreckSource src, Vec3d impact, double severity, double size)
        {
            if (severity <= BendRampFrom)
            {
                return;
            }
            Quatd inv = src.Quaternion.Conjugate();
            Vec3d impactLocal = impact.Rotate(inv);
            Vec3d vb = src.Velocity.Rotate(inv);
            foreach (WreckChunk chunk in partChunks)
            {
                if (!chunk.Gear)
                {
                    continue;
                }
                double top = double.NegativeInfinity;
                double bottom = double.PositiveInfinity;
                int n = 0;
                Vec3d centre = Vec3d.Zero;
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    List<double> d = cm.Pos;
                    if (d == null) continue;
                    for (int i = 0; i + 2 < d.Count; i += 3)
                    {
                        Vec3d p = new Vec3d(d[i], d[i + 1], d[i + 2]).Rotate(inv);
                        top = Math.Max(top, p.Y);
                        bottom = Math.Min(bottom, p.Y);
                        centre = centre + p;
                        n++;
                    }
                }
                double length = top - bottom;
                if (n == 0 || length < 0.2)
                {
                    continue;
                }
                centre = centre * (1.0 / n);
                double near = JsMath.Clamp(1.15 - Vec3d.Distance(centre, impactLocal) / size, 0, 1.15);
                double angle = JsMath.Clamp(
                    BendRamp(severity) * GearBendGain * severity * near * (0.6 + 0.8 * random()), 0, GearBendMaxRad);
                if (angle < 0.08)
                {
                    continue;
                }
                // Folded away from the impact, and the way it was travelling.
                double dx = centre.X - impactLocal.X;
                double dz = centre.Z - impactLocal.Z;
                double away = JsMath.Hypot(dx, dz);
                if (away > 1e-3)
                {
                    dx /= away;
                    dz /= away;
                }
                else
                {
                    double a = random() * Math.PI * 2;
                    dx = JsTrig.Cos(a);
                    dz = JsTrig.Sin(a);
                }
                double speed = JsMath.Hypot(vb.X, vb.Z);
                if (speed > 1)
                {
                    dx = 0.5 * dx + 0.5 * vb.X / speed;
                    dz = 0.5 * dz + 0.5 * vb.Z / speed;
                }
                double dl = JsMath.Hypot(dx, dz);
                if (dl == 0 || double.IsNaN(dl)) dl = 1;
                dx /= dl;
                dz /= dl;
                // The whole leg swings about its top, as a rigid piece.
                Vec3d axis = Vec3d.Cross(new Vec3d(dx, 0, dz), new Vec3d(0, 1, 0)).Normalized();
                var pivot = new Vec3d(centre.X, top, centre.Z);
                Quatd swing = Quatd.FromAxisAngle(axis, angle);
                chunk.Box.MakeEmpty();
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    List<double> d = cm.Pos;
                    List<double> nrm = cm.Nrm;
                    if (d == null) continue;
                    for (int i = 0; i + 2 < d.Count; i += 3)
                    {
                        Vec3d p = new Vec3d(d[i], d[i + 1], d[i + 2]).Rotate(inv);
                        p = ((p - pivot).Rotate(swing) + pivot).Rotate(src.Quaternion);
                        d[i] = p.X;
                        d[i + 1] = p.Y;
                        d[i + 2] = p.Z;
                        chunk.Box.ExpandByPoint(p);
                        if (nrm != null)
                        {
                            p = new Vec3d(nrm[i], nrm[i + 1], nrm[i + 2]).Rotate(inv).Rotate(swing).Rotate(src.Quaternion);
                            nrm[i] = p.X;
                            nrm[i + 1] = p.Y;
                            nrm[i + 2] = p.Z;
                        }
                    }
                }
            }
        }

        private struct Hinge
        {
            public double X, Y, Cos, Sin;
        }

        /// <summary>
        /// Bend the wings: each wing section the blow reached folds about its root
        /// edge (the outer about the inner one's end, so the angles add up), by up
        /// to 20 degrees as the blow approaches what would tear the section off; a
        /// section that would fold further breaks off. Control surfaces over a bent
        /// section turn with it. Returns the ids of the parts it moved.
        /// </summary>
        private HashSet<int> BendWings(List<WreckChunk> bodyChunks, List<WreckChunk> partChunks, WreckSource src, Vec3d impact,
            double severity, double size, Dictionary<int, double> fold)
        {
            var moved = new HashSet<int>();
            lastBentCells = new OrderedIntSet();
            lastBrokenCells = new OrderedIntSet();
            bool hadFold = fold.Values.Any(v => v != 0);
            if (!bodyFrame.HasValue || (severity < DislocateMinSeverity && !hadFold))
            {
                return moved;
            }
            BodyFrameInfo frame = bodyFrame.Value;
            Quatd inv = src.Quaternion.Conjugate();
            Vec3d impactLocal = impact.Rotate(inv);
            double cx = frame.Cx * src.Scale.X;
            double halfSpan = frame.HalfSpan * src.Scale.X;
            var byCell = new Dictionary<int, WreckChunk>();
            foreach (WreckChunk c in bodyChunks)
            {
                byCell[c.Cell] = c;
            }
            int Sections(double x)
            {
                double ax = Math.Abs(x - cx) / halfSpan;
                return ax < 0.2 ? -1 : ax > 0.6 ? 1 : 0; // -1 fuselage, 0 inner, 1 outer
            }
            foreach (int side in new[] { 0, 1 })
            {
                int sign = side == 0 ? -1 : 1; // left wing is at -x
                // The way this blow folds this wing: mostly up (the tip rises), sometimes down.
                int wingDir = random() < BendUpShare ? 1 : -1;
                var hinges = new List<Hinge>();
                double yMean = 0;
                int yCount = 0;
                if (byCell.TryGetValue(3 + side * 2, out WreckChunk inner))
                {
                    foreach (WreckChunkMesh cm in inner.Meshes)
                    {
                        List<double> d = cm.Pos;
                        if (d == null) continue;
                        for (int i = 0; i + 2 < d.Count; i += 3)
                        {
                            yMean += new Vec3d(d[i], d[i + 1], d[i + 2]).Rotate(inv).Y;
                            yCount++;
                        }
                    }
                }
                if (yCount == 0)
                {
                    continue;
                }
                yMean /= yCount;
                for (int level = 0; level < 2; level++)
                {
                    if (!byCell.TryGetValue(3 + side * 2 + level, out WreckChunk chunk))
                    {
                        break;
                    }
                    Vec3d centre = chunk.Box.Center.Rotate(inv);
                    double near = JsMath.Clamp(1.15 - Vec3d.Distance(centre, impactLocal) / size, 0, 1.15);
                    double score = severity * chunk.Weakness * near + 0.6 * Math.Max(0, severity - 0.7);
                    double frac = JsMath.Clamp(score / WingTearThreshold, 0, 1);
                    int cell = 3 + side * 2 + level;
                    // This blow's fold, added to what the section already has, in its own direction.
                    double inc = severity > BendRampFrom
                        ? wingDir * WingBendMaxRad * frac * BendRamp(severity) * (0.7 + 0.3 * random()) : 0;
                    double wanted = (fold.TryGetValue(cell, out double had) ? had : 0) + inc;
                    if (Math.Abs(wanted) > WingBendMaxRad + 1e-9)
                    {
                        // Further than a wing bends: it goes.
                        lastBrokenCells.Add(cell);
                    }
                    double folded = JsMath.Clamp(wanted, -WingBendMaxRad, WingBendMaxRad);
                    fold[cell] = folded;
                    double angle = Math.Abs(folded) >= WingBendMinRad ? folded : 0;
                    if (Math.Abs(inc) >= WingBendMinRad)
                    {
                        lastBentCells.Add(cell);
                    }
                    // Hinge at this section's inner edge, in the frame after the earlier hinges.
                    double hx0 = cx + sign * (level == 0 ? 0.2 : 0.6) * halfSpan;
                    double hx = hx0;
                    double hy = yMean;
                    foreach (Hinge h in hinges)
                    {
                        double dx = hx - h.X;
                        double dy = hy - h.Y;
                        hx = h.X + dx * h.Cos - dy * h.Sin;
                        hy = h.Y + dx * h.Sin + dy * h.Cos;
                    }
                    double a = sign * angle; // the tip goes up (angle > 0) or down
                    hinges.Add(new Hinge { X = hx, Y = hy, Cos = JsTrig.Cos(a), Sin = JsTrig.Sin(a) });
                }
                if (hinges.All(h => h.Sin == 0))
                {
                    continue;
                }
                // Which hinges act on a point: the inner one on both sections, the outer one on the outer only.
                Vec3d Turn(Vec3d v, int upTo)
                {
                    double vx = v.X, vy = v.Y;
                    for (int k = 0; k < Math.Min(hinges.Count, upTo + 1); k++)
                    {
                        Hinge h = hinges[k];
                        double dx = vx - h.X;
                        double dy = vy - h.Y;
                        vx = h.X + dx * h.Cos - dy * h.Sin;
                        vy = h.Y + dx * h.Sin + dy * h.Cos;
                    }
                    return new Vec3d(vx, vy, v.Z);
                }
                int levelsFolded = hinges.Count;
                void Apply(WreckChunk chunk, int level)
                {
                    chunk.Box.MakeEmpty();
                    foreach (WreckChunkMesh cm in chunk.Meshes)
                    {
                        List<double> pos = cm.Pos;
                        List<double> nrm = cm.Nrm;
                        if (pos == null) continue;
                        for (int i = 0; i + 2 < pos.Count; i += 3)
                        {
                            Vec3d p = Turn(new Vec3d(pos[i], pos[i + 1], pos[i + 2]).Rotate(inv), level).Rotate(src.Quaternion);
                            pos[i] = p.X;
                            pos[i + 1] = p.Y;
                            pos[i + 2] = p.Z;
                            chunk.Box.ExpandByPoint(p);
                            if (nrm != null)
                            {
                                p = new Vec3d(nrm[i], nrm[i + 1], nrm[i + 2]).Rotate(inv);
                                double px = p.X, py = p.Y;
                                for (int k = 0; k < Math.Min(levelsFolded, level + 1); k++)
                                {
                                    Hinge h = hinges[k];
                                    double x = px * h.Cos - py * h.Sin;
                                    py = px * h.Sin + py * h.Cos;
                                    px = x;
                                }
                                p = new Vec3d(px, py, p.Z).Rotate(src.Quaternion);
                                nrm[i] = p.X;
                                nrm[i + 1] = p.Y;
                                nrm[i + 2] = p.Z;
                            }
                        }
                    }
                    if (chunk.Anchor.HasValue)
                    {
                        chunk.Anchor = Turn(chunk.Anchor.Value.Rotate(inv), level).Rotate(src.Quaternion);
                    }
                }
                for (int level = 0; level < 2; level++)
                {
                    if (byCell.TryGetValue(3 + side * 2 + level, out WreckChunk chunk))
                    {
                        Apply(chunk, level);
                    }
                }
                // Parts (control surfaces) on a bent section turn with it.
                foreach (WreckChunk part in partChunks)
                {
                    if (part.Gear)
                    {
                        continue;
                    }
                    Vec3d centre = part.Box.Center.Rotate(inv);
                    if (JsMath.Sign(centre.X - cx) != sign)
                    {
                        continue;
                    }
                    int where = Sections(centre.X);
                    if (where < 0)
                    {
                        continue;
                    }
                    Apply(part, where);
                    if (part.PartId != null)
                    {
                        moved.Add(part.PartId.Value);
                    }
                }
            }
            return moved;
        }

        /// <summary>
        /// Dislocate and bend the fuselage: its three sections (fore, middle, aft)
        /// are moved whole against each other at the joints, shifted sideways and
        /// hinged in a plane anywhere from sideways to vertical. The front (cockpit)
        /// section keeps its place; the joint nearest the impact takes most of the
        /// movement. Wings, gear and surfaces move with the section they are on.
        /// </summary>
        private void DislocateFuselage(List<WreckChunk> bodyChunks, List<WreckChunk> partChunks, WreckSource src, Vec3d impact,
            double severity, JointState[] joints)
        {
            LastDislocationM = 0;
            LastKinkRad = 0;
            LastBendRad = 0;
            LastBendUpRad = 0;
            LastTotalBendRad = 0;
            lastPartBends = new Dictionary<WreckChunk, PartBend>();
            bool hadBend = joints.Any(j => j.Yaw != 0 || j.Pitch != 0 || j.Shift != 0);
            if (!bodyFrame.HasValue || (severity < DislocateMinSeverity && !hadBend))
            {
                return;
            }
            BodyFrameInfo frame = bodyFrame.Value;
            double length = frame.ZMax - frame.ZMin;
            if (length < 1e-3)
            {
                return;
            }
            Quatd inv = src.Quaternion.Conjugate();
            Vec3d scale = src.Scale;
            bool frontPlus = src.Cockpit.HasValue ? src.Cockpit.Value.Z >= 0.5 * (frame.ZMin + frame.ZMax) : true;
            double dirZ = frontPlus ? 1 : -1;
            double zFront = frontPlus ? frame.ZMax : frame.ZMin;
            double third = length / 3;

            // Which way: the rear goes the way the aircraft was being thrown sideways, else either.
            Vec3d vb = src.Velocity.Rotate(inv);
            double side = Math.Abs(vb.X) > 2 ? JsMath.Sign(vb.X) : (random() < 0.5 ? -1 : 1);

            // In which plane it folds, from sideways (0) to vertical (pi/2): by the blow and by chance.
            double lateral = Math.Abs(vb.X);
            double vertical = Math.Abs(vb.Y);
            double planeByBlow = JsTrig.Atan2(0.6 * vertical + 1, lateral + 1);
            double plane = JsMath.Clamp(
                BendPlaneBlowShare * planeByBlow + (1 - BendPlaneBlowShare) * random() * Math.PI / 2, 0, Math.PI / 2);
            double upSign = random() < BendUpShare ? 1 : -1;

            // How wide the fuselage is, and where its centreline runs (height).
            double halfWidth = 0;
            double ySum = 0;
            int yCount = 0;
            foreach (WreckChunk chunk in bodyChunks)
            {
                if (chunk.Cell < 0 || chunk.Cell > 2)
                {
                    continue;
                }
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    List<double> d = cm.Pos;
                    if (d == null) continue;
                    for (int i = 0; i + 2 < d.Count; i += 3)
                    {
                        Vec3d probe = new Vec3d(d[i], d[i + 1], d[i + 2]).Rotate(inv);
                        halfWidth = Math.Max(halfWidth, Math.Abs(probe.X / scale.X - frame.Cx));
                        ySum += probe.Y / scale.Y;
                        yCount++;
                    }
                }
            }
            if (halfWidth < 1e-3)
            {
                return;
            }
            double centreY = yCount > 0 ? ySum / yCount : 0;
            // This blow's own bend (none if it is too gentle to bend anything).
            bool bends = severity > BendRampFrom;
            double ramp = BendRamp(severity);
            double total = bends ? ramp * halfWidth * JsMath.Clamp(
                DislocateBaseHalfWidths + DislocatePerSeverityHalfWidths * severity, 0, DislocateMaxHalfWidths) : 0;
            double kink = bends ? ramp * JsMath.Clamp(KinkBaseRad + KinkPerSeverityRad * severity, 0, KinkMaxRad) : 0;
            double theta = bends ? ramp * JsMath.Clamp(BendBaseRad + BendPerSeverityRad * severity, 0, BendMaxRad) : 0;

            // The joints, front to back (1: fore/middle, 2: middle/aft), and the share each takes.
            Vec3d impactLocal = impact.Rotate(inv);
            double uImpact = dirZ * (zFront - impactLocal.Z / scale.Z);
            int nearJoint = uImpact < 0.5 * length ? 1 : 2;
            var share = new double[3];
            share[nearJoint] = DislocateNearJointShare;
            share[3 - nearJoint] = 1 - DislocateNearJointShare;

            // Each section's rigid move in model units, composed from the front backward.
            var sections = new List<double[]> { WreckMath.Identity() };
            var sectionQuats = new List<Quatd> { Quatd.Identity };
            double yawBend = side * dirZ * theta * JsTrig.Cos(plane);
            double pitchBend = upSign * dirZ * theta * JsTrig.Sin(plane);
            // Add this blow to what the joints already have, and keep the whole within what a fuselage can take.
            for (int j = 1; j <= 2; j++)
            {
                joints[j].Yaw += side * dirZ * kink * share[j] + yawBend * share[j];
                joints[j].Pitch += pitchBend * share[j];
                joints[j].Shift += side * total * share[j];
            }
            {
                double sumYaw = joints[1].Yaw + joints[2].Yaw;
                double sumPitch = joints[1].Pitch + joints[2].Pitch;
                double mag = JsMath.Hypot(sumYaw, sumPitch);
                double cap = BendMaxRad + KinkMaxRad;
                if (mag > cap)
                {
                    for (int j = 1; j <= 2; j++)
                    {
                        joints[j].Yaw *= cap / mag;
                        joints[j].Pitch *= cap / mag;
                    }
                }
                double sumShift = Math.Abs(joints[1].Shift) + Math.Abs(joints[2].Shift);
                double shiftCap = halfWidth * DislocateMaxHalfWidths;
                if (sumShift > shiftCap)
                {
                    for (int j = 1; j <= 2; j++)
                    {
                        joints[j].Shift *= shiftCap / sumShift;
                    }
                }
                LastTotalBendRad = JsMath.Hypot(joints[1].Yaw + joints[2].Yaw, joints[1].Pitch + joints[2].Pitch);
            }
            for (int j = 1; j <= 2; j++)
            {
                double yaw = joints[j].Yaw;
                double pitch = joints[j].Pitch;
                var jointPoint = new Vec3d(frame.Cx, centreY, zFront - dirZ * third * j);
                double[] toJoint = WreckMath.MakeTranslation(jointPoint.X, jointPoint.Y, jointPoint.Z);
                double[] fromJoint = WreckMath.MakeTranslation(-jointPoint.X, -jointPoint.Y, -jointPoint.Z);
                double[] turn = WreckMath.Multiply(WreckMath.MakeRotationY(-yaw), WreckMath.MakeRotationX(pitch));
                double[] hinge = WreckMath.Multiply(WreckMath.Multiply(toJoint, turn), fromJoint);
                double[] shift = WreckMath.MakeTranslation(joints[j].Shift, 0, 0);
                double[] m = WreckMath.Multiply(WreckMath.Multiply(sections[j - 1], shift), hinge);
                sections.Add(m);
                sectionQuats.Add(WreckMath.QuaternionFromMatrix(m));
            }
            LastDislocationM = side * total;
            LastKinkRad = side * dirZ * kink;
            LastBendRad = side * dirZ * theta;
            LastBendUpRad = pitchBend;

            int SectionAt(double u) => (int)JsMath.Clamp(Math.Floor(u / third), 0, 2);

            Vec3d MovePoint(Vec3d p, int section) =>
                WreckMath.Mul(WreckMath.ApplyMatrix4(WreckMath.Div(p.Rotate(inv), scale), sections[section]), scale).Rotate(src.Quaternion);

            Vec3d MoveNormal(Vec3d n, int section) => n.Rotate(inv).Rotate(sectionQuats[section]).Rotate(src.Quaternion);

            void MoveChunk(WreckChunk chunk, int section, bool isPart)
            {
                chunk.Box.MakeEmpty();
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    List<double> pos = cm.Pos;
                    List<double> nrm = cm.Nrm;
                    if (pos == null) continue;
                    for (int i = 0; i + 2 < pos.Count; i += 3)
                    {
                        Vec3d p = MovePoint(new Vec3d(pos[i], pos[i + 1], pos[i + 2]), section);
                        pos[i] = p.X;
                        pos[i + 1] = p.Y;
                        pos[i + 2] = p.Z;
                        chunk.Box.ExpandByPoint(p);
                        if (nrm != null)
                        {
                            Vec3d n = MoveNormal(new Vec3d(nrm[i], nrm[i + 1], nrm[i + 2]), section);
                            nrm[i] = n.X;
                            nrm[i + 1] = n.Y;
                            nrm[i + 2] = n.Z;
                        }
                    }
                }
                if (chunk.Anchor.HasValue)
                {
                    chunk.Anchor = MovePoint(chunk.Anchor.Value, section);
                }
                if (isPart)
                {
                    // A part rides on its section: p' = M p in the body's model units (see PartBend).
                    lastPartBends[chunk] = new PartBend { M = (double[])sections[section].Clone(), Q = sectionQuats[section] };
                }
            }

            // The station of a chunk not in the fuselage: the mean distance back of its vertices.
            double StationOf(WreckChunk chunk)
            {
                double sum = 0;
                int count = 0;
                foreach (WreckChunkMesh cm in chunk.Meshes)
                {
                    List<double> d = cm.Pos;
                    if (d == null) continue;
                    for (int i = 0; i + 2 < d.Count; i += 3)
                    {
                        Vec3d p = new Vec3d(d[i], d[i + 1], d[i + 2]).Rotate(inv);
                        sum += dirZ * (zFront - p.Z / scale.Z);
                        count++;
                    }
                }
                return count > 0 ? sum / count : 0;
            }

            foreach (WreckChunk chunk in bodyChunks)
            {
                if (chunk.Cell >= 0 && chunk.Cell <= 2)
                {
                    // The fuselage thirds run from low z to high z; the front section is the one at the cockpit end.
                    MoveChunk(chunk, frontPlus ? 2 - chunk.Cell : chunk.Cell, false);
                }
                else
                {
                    MoveChunk(chunk, SectionAt(StationOf(chunk)), false);
                }
            }
            foreach (WreckChunk chunk in partChunks)
            {
                MoveChunk(chunk, SectionAt(StationOf(chunk)), true);
            }
        }
    }
}
