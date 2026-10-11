using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>h = A*s + B*t + C, with s along the ridge and t across it, centred on the footprint (buildingRoofs.ts Plane).</summary>
    public readonly struct RoofPlane
    {
        public readonly double A, B, C;

        public RoofPlane(double a, double b, double c)
        {
            A = a;
            B = b;
            C = c;
        }
    }

    /// <summary>buildingRoofs.ts BuildingShape: one building's parameters in the PBH1 local frame.</summary>
    public sealed class BuildingShape
    {
        /// <summary>Outline first, then courtyards; open rings of (u, v) metres, any winding.</summary>
        public IReadOnlyList<IReadOnlyList<(double U, double V)>> Rings;
        public double BaseM;
        public double EaveM;
        public double RidgeM;
        public RoofForm Form;
        /// <summary>Ridge direction, radians from u toward v.</summary>
        public double RidgeAngle;
        /// <summary>A roof on posts: no walls.</summary>
        public bool NoWalls;
    }

    /// <summary>
    /// Receives one triangle: <paramref name="p"/> holds three points as (u, v, h),
    /// wound counter-clockwise seen from the side the normal points to, and
    /// whether it belongs to the roof. The buffer is reused for the next
    /// triangle, so consume it before returning.
    /// </summary>
    public delegate void BuildingTriangleSink(double[] p, double nu, double nv, double nh, bool roof);

    /// <summary>
    /// A building's walls and roof as triangles, from its PBH1 parameters: a
    /// port of src/script/terrain/buildingRoofs.ts. Every roof is the lowest
    /// of a few planes over the footprint; each plane's face is the footprint
    /// clipped to where that plane is lowest, and each wall's top follows the
    /// roof along its edge. Works in the PBH1 local frame (u, v horizontal,
    /// h up, right-handed). Pure and allocation-local: safe on any thread.
    /// </summary>
    public static class BuildingRoofs
    {
        private const double Eps = 1e-6;
        /// <summary>Wall pieces and roof faces thinner than this are skipped.</summary>
        public const double MinEdgeM = 0.01;
        /// <summary>Neither extent of a pitched roof goes below this, so the slopes stay finite.</summary>
        public const double MinHalfExtentM = 0.5;

        private static double SignedArea(IReadOnlyList<(double U, double V)> ring)
        {
            double a = 0;
            for (int i = 0, j = ring.Count - 1; i < ring.Count; j = i++)
            {
                a += (ring[j].U - ring[i].U) * (ring[j].V + ring[i].V);
            }
            return a / 2;
        }

        /// <summary>Counter-clockwise copy of a ring (seen from up), or clockwise with `clockwise`.</summary>
        private static List<(double U, double V)> Wound(IReadOnlyList<(double U, double V)> ring, bool clockwise)
        {
            var output = new List<(double U, double V)>(ring);
            if ((SignedArea(output) < 0) != clockwise)
            {
                output.Reverse();
            }
            return output;
        }

        /// <summary>buildingRoofs.ts roofPlanes.</summary>
        public static RoofPlane[] RoofPlanes(RoofForm form, double halfLength, double halfWidth, double eave, double ridge)
        {
            double L = Math.Max(halfLength, MinHalfExtentM);
            double W = Math.Max(halfWidth, MinHalfExtentM);
            double rise = Math.Max(0, ridge - eave);
            if (form == RoofForm.Flat || rise < 0.05)
            {
                return new[] { new RoofPlane(0, 0, Math.Max(eave, ridge)) };
            }
            double k = rise / W;
            var g0 = new RoofPlane(0, -k, ridge);
            var g1 = new RoofPlane(0, k, ridge);
            switch (form)
            {
                case RoofForm.Skillion:
                    // Up toward +t: the eave on one long side, the top on the other.
                    return new[] { new RoofPlane(0, rise / (2 * W), eave + rise / 2) };
                case RoofForm.Gabled:
                    return new[] { g0, g1 };
                case RoofForm.Hipped:
                    return new[] { g0, g1, new RoofPlane(-k, 0, eave + k * L), new RoofPlane(k, 0, eave + k * L) };
                case RoofForm.HalfHipped:
                {
                    // Gable walls up to half the rise, then a steeper hip above.
                    double k2 = 2 * k;
                    double c = eave + rise / 2 + k2 * L;
                    return new[] { g0, g1, new RoofPlane(-k2, 0, c), new RoofPlane(k2, 0, c) };
                }
                case RoofForm.Pyramidal:
                    return new[] { g0, g1, new RoofPlane(-rise / L, 0, ridge), new RoofPlane(rise / L, 0, ridge) };
                default:
                    return new[] { g0, g1 };
            }
        }

        private static double Lowest(RoofPlane[] planes, double s, double t)
        {
            double h = double.PositiveInfinity;
            foreach (RoofPlane p in planes)
            {
                h = JsMin(h, p.A * s + p.B * t + p.C);
            }
            return h;
        }

        private static bool IsConvex(IReadOnlyList<(double U, double V)> ring)
        {
            double sign = 0;
            int n = ring.Count;
            for (int i = 0; i < n; i++)
            {
                var a = ring[i];
                var b = ring[(i + 1) % n];
                var c = ring[(i + 2) % n];
                double cross = (b.U - a.U) * (c.V - b.V) - (b.V - a.V) * (c.U - b.U);
                if (Math.Abs(cross) < 1e-9)
                {
                    continue;
                }
                if (sign == 0)
                {
                    sign = JsMath.Sign(cross);
                }
                else if (JsMath.Sign(cross) != sign)
                {
                    return false;
                }
            }
            return true;
        }

        /// <summary>Sutherland-Hodgman against the half-plane da*s + db*t + dc &lt;= 0.</summary>
        private static List<(double U, double V)> ClipHalfPlane(List<(double U, double V)> poly, double da, double db, double dc)
        {
            if (poly.Count == 0)
            {
                return poly;
            }
            var output = new List<(double U, double V)>();
            int n = poly.Count;
            for (int i = 0; i < n; i++)
            {
                var cur = poly[i];
                var prev = poly[(i + n - 1) % n];
                double fc = da * cur.U + db * cur.V + dc;
                double fp = da * prev.U + db * prev.V + dc;
                if (fc <= Eps)
                {
                    if (fp > Eps)
                    {
                        double k = fp / (fp - fc);
                        output.Add((prev.U + (cur.U - prev.U) * k, prev.V + (cur.V - prev.V) * k));
                    }
                    output.Add(cur);
                }
                else if (fp <= Eps)
                {
                    double k = fp / (fp - fc);
                    output.Add((prev.U + (cur.U - prev.U) * k, prev.V + (cur.V - prev.V) * k));
                }
            }
            // Clipping a concave outline can leave repeated points; earcut wants none.
            var clean = new List<(double U, double V)>(output.Count);
            foreach (var p in output)
            {
                if (clean.Count == 0)
                {
                    clean.Add(p);
                    continue;
                }
                var q = clean[clean.Count - 1];
                if (Math.Abs(q.U - p.U) > 1e-5 || Math.Abs(q.V - p.V) > 1e-5)
                {
                    clean.Add(p);
                }
            }
            while (clean.Count > 1
                && Math.Abs(clean[0].U - clean[clean.Count - 1].U) <= 1e-5
                && Math.Abs(clean[0].V - clean[clean.Count - 1].V) <= 1e-5)
            {
                clean.RemoveAt(clean.Count - 1);
            }
            return clean;
        }

        /// <summary>
        /// buildingRoofs.ts buildingTriangles: emits the triangles of one building
        /// and returns how many there were. Pitched forms on a footprint with
        /// courtyards are drawn flat.
        /// </summary>
        public static int BuildingTriangles(BuildingShape shape, BuildingTriangleSink emit)
        {
            if (shape.Rings.Count == 0 || shape.Rings[0].Count < 3)
            {
                return 0;
            }
            List<(double U, double V)> outer = Wound(shape.Rings[0], false);
            var holes = new List<List<(double U, double V)>>();
            for (int r = 1; r < shape.Rings.Count; r++)
            {
                if (shape.Rings[r].Count >= 3)
                {
                    holes.Add(Wound(shape.Rings[r], true));
                }
            }
            RoofForm form = holes.Count > 0 ? RoofForm.Flat : shape.Form;

            // The ridge frame: s along the ridge, t across it, centred on the outline's extent.
            double dx = JsTrig.Cos(shape.RidgeAngle), dy = JsTrig.Sin(shape.RidgeAngle);
            double sMin = double.PositiveInfinity, sMax = double.NegativeInfinity;
            double tMin = double.PositiveInfinity, tMax = double.NegativeInfinity;
            foreach (var (u, v) in outer)
            {
                double s = u * dx + v * dy, t = -u * dy + v * dx;
                sMin = JsMin(sMin, s);
                sMax = JsMax(sMax, s);
                tMin = JsMin(tMin, t);
                tMax = JsMax(tMax, t);
            }
            double sc = (sMin + sMax) / 2, tc = (tMin + tMax) / 2;
            (double, double) ToST((double U, double V) p) => (p.U * dx + p.V * dy - sc, -p.U * dy + p.V * dx - tc);
            RoofPlane[] planes = RoofPlanes(form, (sMax - sMin) / 2, (tMax - tMin) / 2, shape.EaveM, shape.RidgeM);

            int tris = 0;
            var buf = new double[9];
            void Put((double, double, double) p0, (double, double, double) p1, (double, double, double) p2,
                double n0, double n1, double n2, bool roof)
            {
                double e1x = p1.Item1 - p0.Item1, e1y = p1.Item2 - p0.Item2, e1z = p1.Item3 - p0.Item3;
                double e2x = p2.Item1 - p0.Item1, e2y = p2.Item2 - p0.Item2, e2z = p2.Item3 - p0.Item3;
                double cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
                double along = cx * n0 + cy * n1 + cz * n2;
                if (Math.Abs(along) < 1e-8)
                {
                    return; // degenerate
                }
                var a = along > 0 ? p1 : p2;
                var b = along > 0 ? p2 : p1;
                buf[0] = p0.Item1; buf[1] = p0.Item2; buf[2] = p0.Item3;
                buf[3] = a.Item1; buf[4] = a.Item2; buf[5] = a.Item3;
                buf[6] = b.Item1; buf[7] = b.Item2; buf[8] = b.Item3;
                emit(buf, n0, n1, n2, roof);
                tris++;
            }

            // Roof faces. A face is the footprint clipped to where its plane is the
            // lowest, a convex region, so it is clipped exactly piece by piece: the
            // outline whole when it is convex, else each triangle of it.
            var outerST = new List<(double U, double V)>(outer.Count);
            foreach (var p in outer) outerST.Add(ToST(p));
            var holesST = new List<List<(double U, double V)>>(holes.Count);
            foreach (var h in holes)
            {
                var hs = new List<(double U, double V)>(h.Count);
                foreach (var p in h) hs.Add(ToST(p));
                holesST.Add(hs);
            }
            var pieces = new List<List<(double U, double V)>>();
            if (planes.Length > 1 && !IsConvex(outerST))
            {
                foreach (int[] f in ShapeUtils.TriangulateShape(Xy(outerST), Array.Empty<IReadOnlyList<(double X, double Y)>>()))
                {
                    pieces.Add(new List<(double U, double V)> { outerST[f[0]], outerST[f[1]], outerST[f[2]] });
                }
            }
            else
            {
                pieces.Add(outerST);
            }
            for (int i = 0; i < planes.Length; i++)
            {
                RoofPlane pl = planes[i];
                // Normal of h = a*s + b*t + c is (-a, -b, 1) in (s, t, h); back to (u, v, h).
                double ns = -pl.A, nt = -pl.B;
                double nu = ns * dx - nt * dy, nv = ns * dy + nt * dx;
                double len = JsMath.Hypot(nu, nv, 1);
                double n0 = nu / len, n1 = nv / len, n2 = 1 / len;
                (double, double, double) Lift((double U, double V) p)
                {
                    double s = p.U, t = p.V;
                    return ((s + sc) * dx - (t + tc) * dy, (s + sc) * dy + (t + tc) * dx, pl.A * s + pl.B * t + pl.C);
                }
                if (planes.Length == 1)
                {
                    // One plane (flat or skillion): the outline as it is, courtyards and all.
                    // `all` is the rings as they were: three dropped a closing duplicate
                    // point from the copies it triangulated, not from these.
                    var all = new List<(double U, double V)>(outerST);
                    var holeXy = new IReadOnlyList<(double X, double Y)>[holesST.Count];
                    for (int h = 0; h < holesST.Count; h++)
                    {
                        all.AddRange(holesST[h]);
                        holeXy[h] = Xy(holesST[h]);
                    }
                    foreach (int[] f in ShapeUtils.TriangulateShape(Xy(outerST), holeXy))
                    {
                        Put(Lift(all[f[0]]), Lift(all[f[1]]), Lift(all[f[2]]), n0, n1, n2, true);
                    }
                    continue;
                }
                foreach (var piece in pieces)
                {
                    var face = piece;
                    for (int j = 0; j < planes.Length && face.Count >= 3; j++)
                    {
                        if (j == i)
                        {
                            continue;
                        }
                        double da = pl.A - planes[j].A, db = pl.B - planes[j].B, dc = pl.C - planes[j].C;
                        if (Math.Abs(da) < Eps && Math.Abs(db) < Eps)
                        {
                            if (dc > Eps)
                            {
                                face = new List<(double U, double V)>(); // plane j lies wholly under plane i
                            }
                            continue;
                        }
                        face = ClipHalfPlane(face, da, db, dc);
                    }
                    if (face.Count < 3 || Math.Abs(SignedArea(face)) < MinEdgeM * MinEdgeM)
                    {
                        continue;
                    }
                    // Convex: a fan.
                    var f0 = Lift(face[0]);
                    for (int k = 1; k + 1 < face.Count; k++)
                    {
                        Put(f0, Lift(face[k]), Lift(face[k + 1]), n0, n1, n2, true);
                    }
                }
            }

            if (shape.NoWalls)
            {
                return tris;
            }

            // Walls: each edge from the base up to the roof, split where the lowest
            // plane changes so a gable end rises to its ridge.
            double baseM = shape.BaseM;
            var cuts = new List<double>();
            for (int r = -1; r < holes.Count; r++)
            {
                List<(double U, double V)> ring = r < 0 ? outer : holes[r];
                for (int i = 0; i < ring.Count; i++)
                {
                    var p0 = ring[i];
                    var p1 = ring[(i + 1) % ring.Count];
                    double ex = p1.U - p0.U, ey = p1.V - p0.V;
                    double len = JsMath.Hypot(ex, ey);
                    if (len < MinEdgeM)
                    {
                        continue;
                    }
                    // Outward: right of a counter-clockwise outline's edges, and of a
                    // clockwise courtyard's, which faces into the courtyard.
                    double n0 = ey / len, n1 = -ex / len, n2 = 0;
                    var s0 = ToST(p0);
                    var s1 = ToST(p1);
                    cuts.Clear();
                    cuts.Add(0);
                    cuts.Add(1);
                    for (int a = 0; a < planes.Length; a++)
                    {
                        for (int b = a + 1; b < planes.Length; b++)
                        {
                            double ka = planes[a].A - planes[b].A, kb = planes[a].B - planes[b].B, kc = planes[a].C - planes[b].C;
                            double d0 = ka * s0.Item1 + kb * s0.Item2 + kc;
                            double d1 = ka * s1.Item1 + kb * s1.Item2 + kc;
                            if ((d0 > Eps && d1 < -Eps) || (d0 < -Eps && d1 > Eps))
                            {
                                cuts.Add(d0 / (d0 - d1));
                            }
                        }
                    }
                    cuts.Sort();
                    for (int k = 0; k + 1 < cuts.Count; k++)
                    {
                        double ta = cuts[k], tb = cuts[k + 1];
                        if ((tb - ta) * len < MinEdgeM)
                        {
                            continue;
                        }
                        double qau = p0.U + ex * ta, qav = p0.V + ey * ta;
                        double qbu = p0.U + ex * tb, qbv = p0.V + ey * tb;
                        double ha = Lowest(planes, s0.Item1 + (s1.Item1 - s0.Item1) * ta, s0.Item2 + (s1.Item2 - s0.Item2) * ta);
                        double hb = Lowest(planes, s0.Item1 + (s1.Item1 - s0.Item1) * tb, s0.Item2 + (s1.Item2 - s0.Item2) * tb);
                        if (ha <= baseM + MinEdgeM && hb <= baseM + MinEdgeM)
                        {
                            continue;
                        }
                        var a0 = (qau, qav, baseM);
                        var b0 = (qbu, qbv, baseM);
                        var a1 = (qau, qav, JsMax(baseM, ha));
                        var b1 = (qbu, qbv, JsMax(baseM, hb));
                        Put(a0, b0, b1, n0, n1, n2, false);
                        Put(a0, b1, a1, n0, n1, n2, false);
                    }
                }
            }
            return tris;
        }

        private static IReadOnlyList<(double X, double Y)> Xy(List<(double U, double V)> ring)
        {
            var output = new (double X, double Y)[ring.Count];
            for (int i = 0; i < ring.Count; i++) output[i] = (ring[i].U, ring[i].V);
            return output;
        }

        private static double JsMin(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Min(a, b);

        private static double JsMax(double a, double b) => double.IsNaN(a) || double.IsNaN(b) ? double.NaN : Math.Max(a, b);
    }
}
