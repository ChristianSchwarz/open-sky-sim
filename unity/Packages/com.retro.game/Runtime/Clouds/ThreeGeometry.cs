using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The few three.js (r185) geometry routines the cloud and cirrus builders lean on, ported for
    /// bit-identical float32 output: <c>IcosahedronGeometry</c>/<c>PolyhedronGeometry</c> positions
    /// (vertex order included), <c>BufferGeometry.translate/scale</c>, <c>computeVertexNormals</c>
    /// (triangle soup and indexed) and <c>BufferGeometryUtils.mergeVertices</c> on a position-only
    /// geometry. Positions are flat xyz float arrays, as three keeps them in a Float32Array; every
    /// intermediate is computed in double exactly as three does, and rounded to float only where
    /// three stores into the typed array.
    /// </summary>
    public static class ThreeGeometry
    {
        private static readonly int[] IcosahedronIndices =
        {
            0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
            1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
            3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
            4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
        };

        /// <summary>
        /// <c>new IcosahedronGeometry(radius, detail)</c>'s position attribute: non-indexed,
        /// 20 * (detail + 1)^2 triangles. Normals and uvs are not produced (no caller keeps them).
        /// </summary>
        public static float[] Icosahedron(double radius, int detail)
        {
            double t = (1 + Math.Sqrt(5)) / 2;
            double[] vertices =
            {
                -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0,
                0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t,
                t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1,
            };
            return Polyhedron(vertices, IcosahedronIndices, radius, detail);
        }

        /// <summary>PolyhedronGeometry: subdivide every face, push the vertices out to the radius.</summary>
        public static float[] Polyhedron(double[] vertices, int[] indices, double radius, int detail)
        {
            var buffer = new List<double>();
            for (int i = 0; i < indices.Length; i += 3)
            {
                SubdivideFace(Vertex(vertices, indices[i]), Vertex(vertices, indices[i + 1]), Vertex(vertices, indices[i + 2]),
                    detail, buffer);
            }
            var positions = new float[buffer.Count];
            for (int i = 0; i < buffer.Count; i += 3)
            {
                // vertex.normalize().multiplyScalar(radius)
                double x = buffer[i], y = buffer[i + 1], z = buffer[i + 2];
                double inv = 1 / LengthOrOne(x, y, z);
                x *= inv;
                y *= inv;
                z *= inv;
                positions[i] = (float)(x * radius);
                positions[i + 1] = (float)(y * radius);
                positions[i + 2] = (float)(z * radius);
            }
            return positions;
        }

        private static Vec3d Vertex(double[] vertices, int index) =>
            new Vec3d(vertices[index * 3], vertices[index * 3 + 1], vertices[index * 3 + 2]);

        private static void SubdivideFace(Vec3d a, Vec3d b, Vec3d c, int detail, List<double> buffer)
        {
            int cols = detail + 1;
            var v = new Vec3d[cols + 1][];
            for (int i = 0; i <= cols; i++)
            {
                Vec3d aj = Vec3d.Lerp(a, c, (double)i / cols);
                Vec3d bj = Vec3d.Lerp(b, c, (double)i / cols);
                int rows = cols - i;
                v[i] = new Vec3d[rows + 1];
                for (int j = 0; j <= rows; j++)
                {
                    v[i][j] = j == 0 && i == cols ? aj : Vec3d.Lerp(aj, bj, (double)j / rows);
                }
            }
            for (int i = 0; i < cols; i++)
            {
                for (int j = 0; j < 2 * (cols - i) - 1; j++)
                {
                    int k = j / 2;
                    if (j % 2 == 0)
                    {
                        Push(buffer, v[i][k + 1]);
                        Push(buffer, v[i + 1][k]);
                        Push(buffer, v[i][k]);
                    }
                    else
                    {
                        Push(buffer, v[i][k + 1]);
                        Push(buffer, v[i + 1][k + 1]);
                        Push(buffer, v[i + 1][k]);
                    }
                }
            }
        }

        private static void Push(List<double> buffer, Vec3d p)
        {
            buffer.Add(p.X);
            buffer.Add(p.Y);
            buffer.Add(p.Z);
        }

        /// <summary>Vector3.length() || 1: what normalize() divides by.</summary>
        private static double LengthOrOne(double x, double y, double z)
        {
            double l = Math.Sqrt(x * x + y * y + z * z);
            return l == 0 || double.IsNaN(l) ? 1 : l;
        }

        /// <summary>
        /// BufferAttribute.applyMatrix4 on positions: Vector3.applyMatrix4 per vertex, with the
        /// perspective divide, `e` column-major as in three's Matrix4.elements.
        /// </summary>
        public static void ApplyMatrix4(float[] positions, double[] e)
        {
            for (int i = 0; i < positions.Length; i += 3)
            {
                double x = positions[i], y = positions[i + 1], z = positions[i + 2];
                double w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
                positions[i] = (float)((e[0] * x + e[4] * y + e[8] * z + e[12]) * w);
                positions[i + 1] = (float)((e[1] * x + e[5] * y + e[9] * z + e[13]) * w);
                positions[i + 2] = (float)((e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
            }
        }

        /// <summary>BufferGeometry.translate(x, y, z) (Matrix4.makeTranslation).</summary>
        public static void Translate(float[] positions, double x, double y, double z) =>
            ApplyMatrix4(positions, new double[] { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 });

        /// <summary>BufferGeometry.scale(x, y, z) (Matrix4.makeScale).</summary>
        public static void Scale(float[] positions, double x, double y, double z) =>
            ApplyMatrix4(positions, new double[] { x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1 });

        /// <summary>Concatenate position arrays, as the builders' mergeGeometries do with Float32Array.set.</summary>
        public static float[] Concat(IReadOnlyList<float[]> parts)
        {
            int total = 0;
            foreach (float[] p in parts) total += p.Length;
            var result = new float[total];
            int offset = 0;
            foreach (float[] p in parts)
            {
                Array.Copy(p, 0, result, offset, p.Length);
                offset += p.Length;
            }
            return result;
        }

        /// <summary>computeVertexNormals on a non-indexed geometry: one flat normal per triangle.</summary>
        public static float[] SoupNormals(float[] positions)
        {
            var normals = new float[positions.Length];
            for (int i = 0; i < positions.Length; i += 9)
            {
                FaceCross(positions, i / 3, i / 3 + 1, i / 3 + 2, out double cx, out double cy, out double cz);
                for (int k = 0; k < 9; k += 3)
                {
                    normals[i + k] = (float)cx;
                    normals[i + k + 1] = (float)cy;
                    normals[i + k + 2] = (float)cz;
                }
            }
            NormalizeNormals(normals);
            return normals;
        }

        /// <summary>
        /// computeVertexNormals on an indexed geometry: face normals (unnormalised cross products)
        /// summed into each corner through the float32 attribute, then normalised. A triangle reads
        /// all three corners before writing any, so a welded degenerate one adds its face once.
        /// </summary>
        public static float[] IndexedNormals(float[] positions, int[] index)
        {
            var n = new float[positions.Length];
            for (int i = 0; i < index.Length; i += 3)
            {
                int a = index[i], b = index[i + 1], c = index[i + 2];
                FaceCross(positions, a, b, c, out double cx, out double cy, out double cz);
                double ax = n[a * 3], ay = n[a * 3 + 1], az = n[a * 3 + 2];
                double bx = n[b * 3], by = n[b * 3 + 1], bz = n[b * 3 + 2];
                double qx = n[c * 3], qy = n[c * 3 + 1], qz = n[c * 3 + 2];
                ax += cx; ay += cy; az += cz;
                bx += cx; by += cy; bz += cz;
                qx += cx; qy += cy; qz += cz;
                n[a * 3] = (float)ax; n[a * 3 + 1] = (float)ay; n[a * 3 + 2] = (float)az;
                n[b * 3] = (float)bx; n[b * 3 + 1] = (float)by; n[b * 3 + 2] = (float)bz;
                n[c * 3] = (float)qx; n[c * 3 + 1] = (float)qy; n[c * 3 + 2] = (float)qz;
            }
            NormalizeNormals(n);
            return n;
        }

        /// <summary>cb = pC - pB; ab = pA - pB; cb.cross(ab).</summary>
        private static void FaceCross(float[] p, int a, int b, int c, out double x, out double y, out double z)
        {
            double cbx = (double)p[c * 3] - p[b * 3], cby = (double)p[c * 3 + 1] - p[b * 3 + 1], cbz = (double)p[c * 3 + 2] - p[b * 3 + 2];
            double abx = (double)p[a * 3] - p[b * 3], aby = (double)p[a * 3 + 1] - p[b * 3 + 1], abz = (double)p[a * 3 + 2] - p[b * 3 + 2];
            x = cby * abz - cbz * aby;
            y = cbz * abx - cbx * abz;
            z = cbx * aby - cby * abx;
        }

        /// <summary>BufferGeometry.normalizeNormals.</summary>
        private static void NormalizeNormals(float[] n)
        {
            for (int i = 0; i < n.Length; i += 3)
            {
                double x = n[i], y = n[i + 1], z = n[i + 2];
                double inv = 1 / LengthOrOne(x, y, z);
                n[i] = (float)(x * inv);
                n[i + 1] = (float)(y * inv);
                n[i + 2] = (float)(z * inv);
            }
        }

        /// <summary>
        /// BufferGeometryUtils.mergeVertices(geometry) with the default 1e-4 tolerance on a
        /// position-only, non-indexed geometry: vertices are keyed by
        /// <c>~~(v * 10^4 + 0.5)</c> per component, first occurrence wins.
        /// </summary>
        public static (float[] Positions, int[] Index) MergeVertices(float[] positions, double tolerance = 1e-4)
        {
            tolerance = Math.Max(tolerance, 2.220446049250313e-16);
            double halfTolerance = tolerance * 0.5;
            double exponent = Math.Log10(1 / tolerance);
            double hashMultiplier = Math.Pow(10, exponent);
            double hashAdditive = halfTolerance * hashMultiplier;
            int count = positions.Length / 3;
            var lookup = new Dictionary<(int, int, int), int>(count);
            var merged = new List<float>(positions.Length);
            var index = new int[count];
            for (int i = 0; i < count; i++)
            {
                float x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
                var key = (ToInt32(x * hashMultiplier + hashAdditive), ToInt32(y * hashMultiplier + hashAdditive),
                    ToInt32(z * hashMultiplier + hashAdditive));
                if (!lookup.TryGetValue(key, out int at))
                {
                    at = merged.Count / 3;
                    lookup.Add(key, at);
                    merged.Add(x);
                    merged.Add(y);
                    merged.Add(z);
                }
                index[i] = at;
            }
            return (merged.ToArray(), index);
        }

        /// <summary>JavaScript's <c>~~x</c> (ToInt32) for the finite values a vertex hash sees.</summary>
        private static int ToInt32(double x)
        {
            double t = Math.Truncate(x);
            if (t >= int.MinValue && t <= int.MaxValue) return (int)t;
            double m = t % 4294967296.0;
            if (m < 0) m += 4294967296.0;
            return unchecked((int)(uint)m);
        }
    }
}
