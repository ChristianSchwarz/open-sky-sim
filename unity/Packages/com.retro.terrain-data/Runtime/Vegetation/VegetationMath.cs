using System;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Arithmetic shared by the tree and clutter scatter (treeBillboards.ts, stones.ts) and the
    /// three.js bounding-sphere code their meshes rely on, operation for operation so the results
    /// are bit-identical to the browser.
    /// </summary>
    internal static class VegetationMath
    {
        /// <summary>hash01: fract(sin(n * 12.9898) * 43758.5453) with V8's sin.</summary>
        public static double Hash01(double n)
        {
            double s = JsTrig.Sin(n * 12.9898) * 43758.5453;
            return s - Math.Floor(s);
        }

        /// <summary>readVert: a land corner in metres.</summary>
        public static Vec3d ReadVert(PtmTile tile, int triangle, int corner)
        {
            int v = triangle * 3 + corner;
            double s = tile.QuantScale;
            return new Vec3d(tile.LandPositions[v * 3] * s, tile.LandPositions[v * 3 + 1] * s, tile.LandPositions[v * 3 + 2] * s);
        }

        public static double TriangleArea(Vec3d a, Vec3d b, Vec3d c)
        {
            double abx = b.X - a.X, aby = b.Y - a.Y, abz = b.Z - a.Z;
            double acx = c.X - a.X, acy = c.Y - a.Y, acz = c.Z - a.Z;
            double cx = aby * acz - abz * acy;
            double cy = abz * acx - abx * acz;
            double cz = abx * acy - aby * acx;
            return 0.5 * Math.Sqrt(cx * cx + cy * cy + cz * cz);
        }

        /// <summary>Uniform point-in-triangle sampling (Osada et al.).</summary>
        public static Vec3d PointInTriangle(Vec3d a, Vec3d b, Vec3d c, double r1, double r2)
        {
            double sr1 = Math.Sqrt(r1);
            double wa = 1 - sr1;
            double wb = sr1 * (1 - r2);
            double wc = sr1 * r2;
            return new Vec3d(
                wa * a.X + wb * b.X + wc * c.X,
                wa * a.Y + wb * b.Y + wc * c.Y,
                wa * a.Z + wb * b.Z + wc * c.Z);
        }

        /// <summary>Facet normal flipped to point up (tile axes: +X east, +Y up, +Z south), unit length.</summary>
        public static Vec3d UpNormal(Vec3d v0, Vec3d v1, Vec3d v2)
        {
            double nx = (v1.Y - v0.Y) * (v2.Z - v0.Z) - (v1.Z - v0.Z) * (v2.Y - v0.Y);
            double ny = (v1.Z - v0.Z) * (v2.X - v0.X) - (v1.X - v0.X) * (v2.Z - v0.Z);
            double nz = (v1.X - v0.X) * (v2.Y - v0.Y) - (v1.Y - v0.Y) * (v2.X - v0.X);
            double nLen = JsMath.Hypot(nx, ny, nz);
            // `|| 1`: zero and NaN both fall back.
            if (nLen == 0 || double.IsNaN(nLen)) nLen = 1;
            double nSign = ny < 0 ? -1 / nLen : 1 / nLen;
            return new Vec3d(nx * nSign, ny * nSign, nz * nSign);
        }

        /// <summary>
        /// buildTreeMesh's seeded xorshift shuffle of instance slots: an instance's slot is its
        /// thinning hash, so the trees any thinning keeps are a prefix.
        /// </summary>
        public static uint[] ShuffledSlots(int count)
        {
            var slot = new uint[count];
            for (int j = 0; j < count; j++) slot[j] = (uint)j;
            // (count * 2654435761) >>> 0 || 1: the product is exact in a double for any count here.
            uint seed = (uint)((ulong)count * 2654435761UL);
            if (seed == 0) seed = 1;
            for (int j = count - 1; j > 0; j--)
            {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                uint r = seed % (uint)(j + 1);
                uint t = slot[j];
                slot[j] = slot[r];
                slot[r] = t;
            }
            return slot;
        }

        /// <summary>BufferGeometry.computeBoundingSphere over a float32 position list (no index needed: all vertices count).</summary>
        public static (Vec3d Center, double Radius) GeometrySphere(float[] positions)
        {
            double minX = double.PositiveInfinity, minY = double.PositiveInfinity, minZ = double.PositiveInfinity;
            double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity, maxZ = double.NegativeInfinity;
            for (int i = 0; i < positions.Length; i += 3)
            {
                double x = positions[i], y = positions[i + 1], z = positions[i + 2];
                minX = Math.Min(minX, x); minY = Math.Min(minY, y); minZ = Math.Min(minZ, z);
                maxX = Math.Max(maxX, x); maxY = Math.Max(maxY, y); maxZ = Math.Max(maxZ, z);
            }
            var c = new Vec3d((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
            double maxSq = 0;
            for (int i = 0; i < positions.Length; i += 3)
            {
                double dx = c.X - positions[i], dy = c.Y - positions[i + 1], dz = c.Z - positions[i + 2];
                maxSq = Math.Max(maxSq, dx * dx + dy * dy + dz * dz);
            }
            return (c, Math.Sqrt(maxSq));
        }

        /// <summary>
        /// InstancedMesh.computeBoundingSphere: the geometry's sphere through each instance's
        /// (float32) scale-and-translate matrix, unioned in slot order with three.js's Sphere.union.
        /// </summary>
        public static (Vec3d Center, double Radius) InstancesSphere(Vec3d geoCenter, double geoRadius, float[] positions, float[] scales, int count)
        {
            double cx = 0, cy = 0, cz = 0, r = -1;
            for (int i = 0; i < count; i++)
            {
                double s = scales[i];
                double px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2];
                // Vector3.applyMatrix4 with e = [s,0,0,0, 0,s,0,0, 0,0,s,0, px,py,pz,1].
                double x = geoCenter.X, y = geoCenter.Y, z = geoCenter.Z;
                double w = 1 / (0 * x + 0 * y + 0 * z + 1.0);
                double sx = (s * x + 0 * y + 0 * z + px) * w;
                double sy = (0 * x + s * y + 0 * z + py) * w;
                double sz = (0 * x + 0 * y + s * z + pz) * w;
                // Matrix4.getMaxScaleOnAxis.
                double scaleSq = s * s + 0 * 0 + 0 * 0;
                double sr = geoRadius * Math.Sqrt(scaleSq);
                // Sphere.union.
                if (sr < 0) continue;
                if (r < 0)
                {
                    cx = sx; cy = sy; cz = sz; r = sr;
                    continue;
                }
                if (cx == sx && cy == sy && cz == sz)
                {
                    r = Math.Max(r, sr);
                    continue;
                }
                // _v2 = (other.center - this.center).setLength(other.radius)
                double vx = sx - cx, vy = sy - cy, vz = sz - cz;
                double len = Math.Sqrt(vx * vx + vy * vy + vz * vz);
                double inv = 1 / (len == 0 || double.IsNaN(len) ? 1 : len);
                vx = vx * inv * sr;
                vy = vy * inv * sr;
                vz = vz * inv * sr;
                ExpandByPoint(ref cx, ref cy, ref cz, ref r, sx + vx, sy + vy, sz + vz);
                ExpandByPoint(ref cx, ref cy, ref cz, ref r, sx - vx, sy - vy, sz - vz);
            }
            return (new Vec3d(cx, cy, cz), r);
        }

        /// <summary>Sphere.expandByPoint on a non-empty sphere.</summary>
        private static void ExpandByPoint(ref double cx, ref double cy, ref double cz, ref double r, double px, double py, double pz)
        {
            double vx = px - cx, vy = py - cy, vz = pz - cz;
            double lengthSq = vx * vx + vy * vy + vz * vz;
            if (lengthSq > r * r)
            {
                double length = Math.Sqrt(lengthSq);
                double delta = (length - r) * 0.5;
                double k = delta / length;
                cx += vx * k;
                cy += vy * k;
                cz += vz * k;
                r += delta;
            }
        }
    }
}
