using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>The SMOOTH land weld's output: indexed, one vertex per (position, region).</summary>
    public sealed class SmoothLandMesh
    {
        /// <summary>Quantised int16 xyz, three per vertex.</summary>
        public short[] OutPositions;
        /// <summary>Normalised int8 xyz + one zero pad byte, four per vertex.</summary>
        public sbyte[] OutNormals;
        /// <summary>Cover colour rgb + class, four per vertex.</summary>
        public byte[] OutAttrs;
        /// <summary>Per-vertex land-use region width in metres (see RegionSizes).</summary>
        public ushort[] OutSizes;
        /// <summary>Triangle list, one entry per input (faceted) vertex.</summary>
        public uint[] Indices;
        public int VertexCount;
    }

    /// <summary>
    /// Engine-free port of the land preparation in src/script/terrain/tileMesh.ts:
    /// regionSizes, leanEdgeNormals and buildSmoothLandGeometry, bit for bit.
    /// Inputs are a .ptm tile's non-indexed land soup (three vertices a triangle).
    /// </summary>
    public static class LandMesh
    {
        /// <summary>TerrainClass.Ground: land no land-use polygon claims.</summary>
        public const byte GroundClass = 13;
        /// <summary>Fraction of the tile's width, from each edge, that counts as its border.</summary>
        public const double EdgeNormalBand = 0.01;
        /// <summary>How far a border normal leans toward straight up, 0..1.</summary>
        public const double EdgeNormalLean = 0;

        /// <summary>
        /// Whether any land vertex is Ground, i.e. the tile has land-use: only then
        /// are its other classes land-use regions.
        /// </summary>
        public static bool HasLanduseGround(byte[] landAttrs)
        {
            for (int i = 3; i < landAttrs.Length; i += 4)
            {
                if (landAttrs[i] == GroundClass)
                {
                    return true;
                }
            }
            return false;
        }

        private readonly struct CornerKey : IEquatable<CornerKey>
        {
            private readonly short _x, _y, _z;
            private readonly byte _cls;

            public CornerKey(short x, short y, short z, byte cls)
            {
                _x = x; _y = y; _z = z; _cls = cls;
            }

            public bool Equals(CornerKey o) => _x == o._x && _y == o._y && _z == o._z && _cls == o._cls;
            public override bool Equals(object obj) => obj is CornerKey o && Equals(o);
            public override int GetHashCode() => unchecked((((_x * 73856093) ^ (_y * 19349663)) ^ (_z * 83492791)) ^ (_cls * 0x01000193));
        }

        /// <summary>
        /// Per vertex, the width in metres of the land-use region it belongs to
        /// (sqrt of the region's area on this tile, capped at 65535). 0 for Ground
        /// and for every vertex of a raster-only tile. A region is the triangles of
        /// one class connected through corners at exactly the same quantised position.
        /// </summary>
        public static ushort[] RegionSizes(short[] positions, byte[] attrs, double quantScale)
        {
            int vertexCount = positions.Length / 3;
            var output = new ushort[vertexCount];
            if (!HasLanduseGround(attrs))
            {
                return output;
            }
            int triCount = vertexCount / 3;
            var parent = new int[triCount];
            for (int t = 0; t < triCount; t++)
            {
                parent[t] = t;
            }
            int Find(int t)
            {
                while (parent[t] != t)
                {
                    parent[t] = parent[parent[t]];
                    t = parent[t];
                }
                return t;
            }
            var triArea = new double[triCount];
            var cornerToTri = new Dictionary<CornerKey, int>();
            for (int t = 0; t < triCount; t++)
            {
                int v = t * 3;
                byte cls = attrs[v * 4 + 3];
                if (cls == GroundClass)
                {
                    continue;
                }
                double ax = positions[v * 3], ay = positions[v * 3 + 1], az = positions[v * 3 + 2];
                double bx = positions[v * 3 + 3] - ax, by = positions[v * 3 + 4] - ay, bz = positions[v * 3 + 5] - az;
                double cx = positions[v * 3 + 6] - ax, cy = positions[v * 3 + 7] - ay, cz = positions[v * 3 + 8] - az;
                double nx = by * cz - bz * cy;
                double ny = bz * cx - bx * cz;
                double nz = bx * cy - by * cx;
                triArea[t] = 0.5 * JsMath.Hypot(nx, ny, nz) * quantScale * quantScale;
                for (int k = 0; k < 3; k++)
                {
                    int i = v + k;
                    var key = new CornerKey(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], cls);
                    if (!cornerToTri.TryGetValue(key, out int other))
                    {
                        cornerToTri.Add(key, t);
                    }
                    else
                    {
                        int ra = Find(t);
                        int rb = Find(other);
                        if (ra != rb)
                        {
                            parent[ra] = rb;
                        }
                    }
                }
            }
            var area = new double[triCount];
            for (int t = 0; t < triCount; t++)
            {
                if (attrs[t * 3 * 4 + 3] != GroundClass)
                {
                    area[Find(t)] += triArea[t];
                }
            }
            for (int t = 0; t < triCount; t++)
            {
                if (attrs[t * 3 * 4 + 3] == GroundClass)
                {
                    continue;
                }
                var size = (ushort)Math.Min(65535, JsMath.Round(Math.Sqrt(area[Find(t)])));
                output[t * 3] = size;
                output[t * 3 + 1] = size;
                output[t * 3 + 2] = size;
            }
            return output;
        }

        /// <summary>
        /// Renormalises (and, with a non-zero lean, tilts toward straight up) the
        /// normals of vertices within EdgeNormalBand of the tile's bounding-box
        /// edge, so neighbouring tiles light a shared edge alike. Edits
        /// <paramref name="normals"/> (xyz + pad, stride 4) in place.
        /// </summary>
        public static void LeanEdgeNormals(short[] positions, sbyte[] normals)
        {
            int count = positions.Length / 3;
            double minX = double.PositiveInfinity, maxX = double.NegativeInfinity;
            double minZ = double.PositiveInfinity, maxZ = double.NegativeInfinity;
            for (int v = 0; v < count; v++)
            {
                minX = Math.Min(minX, positions[v * 3]);
                maxX = Math.Max(maxX, positions[v * 3]);
                minZ = Math.Min(minZ, positions[v * 3 + 2]);
                maxZ = Math.Max(maxZ, positions[v * 3 + 2]);
            }
            double edgeX = (maxX - minX) * EdgeNormalBand;
            double edgeZ = (maxZ - minZ) * EdgeNormalBand;
            for (int v = 0; v < count; v++)
            {
                double px = positions[v * 3];
                double pz = positions[v * 3 + 2];
                if (px - minX > edgeX && maxX - px > edgeX && pz - minZ > edgeZ && maxZ - pz > edgeZ)
                {
                    continue;
                }
                double nx = (normals[v * 4] / 127.0) * (1 - EdgeNormalLean);
                double ny = (normals[v * 4 + 1] / 127.0) * (1 - EdgeNormalLean) + EdgeNormalLean;
                double nz = (normals[v * 4 + 2] / 127.0) * (1 - EdgeNormalLean);
                double len = OrOne(JsMath.Hypot(nx, ny, nz));
                normals[v * 4] = ToInt8(JsMath.Round((nx / len) * 127));
                normals[v * 4 + 1] = ToInt8(JsMath.Round((ny / len) * 127));
                normals[v * 4 + 2] = ToInt8(JsMath.Round((nz / len) * 127));
            }
        }

        /// <summary>
        /// The faceted land soup welded into shared vertices: by exact quantised
        /// position plus region (see RegionKeyOf), colour the mean over the
        /// region's contributors, normal the renormalised mean over every
        /// contributor at the position, size the largest. First-seen order.
        /// Null for an empty soup.
        /// </summary>
        public static SmoothLandMesh BuildSmoothLandGeometry(
            short[] positions, sbyte[] normals, byte[] attrs, ushort[] sizes = null)
        {
            int vertexCount = positions.Length / 3;
            if (vertexCount == 0)
            {
                return null;
            }

            int capacity = 16;
            while (capacity < vertexCount * 2)
            {
                capacity *= 2;
            }
            int mask = capacity - 1;
            var table = new int[capacity];
            for (int i = 0; i < capacity; i++) table[i] = -1;
            var slotPositions = new short[vertexCount * 3];
            var firstOut = new int[vertexCount];
            var normalSum = new double[vertexCount * 3];
            int slots = 0;
            var nextOut = new int[vertexCount];
            var outRegion = new int[vertexCount];
            var normalOf = new int[vertexCount];
            var uniquePositions = new short[vertexCount * 3];
            var colorSum = new double[vertexCount * 4];
            var vertexClass = new byte[vertexCount];
            var sizeMax = new ushort[vertexCount];
            int uniqueCount = 0;
            var remap = new uint[vertexCount];
            bool landuse = HasLanduseGround(attrs);

            for (int i = 0; i < vertexCount; i++)
            {
                short px = positions[i * 3];
                short py = positions[i * 3 + 1];
                short pz = positions[i * 3 + 2];
                int h = unchecked((px * 73856093) ^ (py * 19349663) ^ (pz * 83492791)) & mask;
                int n = table[h];
                while (n != -1 && (slotPositions[n * 3] != px || slotPositions[n * 3 + 1] != py || slotPositions[n * 3 + 2] != pz))
                {
                    h = (h + 1) & mask;
                    n = table[h];
                }
                if (n == -1)
                {
                    n = slots++;
                    table[h] = n;
                    slotPositions[n * 3] = px;
                    slotPositions[n * 3 + 1] = py;
                    slotPositions[n * 3 + 2] = pz;
                    firstOut[n] = -1;
                }
                int region = RegionKeyOf(attrs, i, landuse);
                int idx = firstOut[n];
                while (idx != -1 && outRegion[idx] != region)
                {
                    idx = nextOut[idx];
                }
                if (idx == -1)
                {
                    idx = uniqueCount++;
                    outRegion[idx] = region;
                    nextOut[idx] = firstOut[n];
                    firstOut[n] = idx;
                    uniquePositions[idx * 3] = px;
                    uniquePositions[idx * 3 + 1] = py;
                    uniquePositions[idx * 3 + 2] = pz;
                    normalOf[idx] = n;
                    vertexClass[idx] = attrs[i * 4 + 3];
                }
                remap[i] = (uint)idx;
                if (sizes != null && sizes[i] > sizeMax[idx])
                {
                    sizeMax[idx] = sizes[i];
                }

                int ni = i * 4;
                normalSum[n * 3] += normals[ni];
                normalSum[n * 3 + 1] += normals[ni + 1];
                normalSum[n * 3 + 2] += normals[ni + 2];

                int ai = i * 4;
                colorSum[idx * 4] += attrs[ai];
                colorSum[idx * 4 + 1] += attrs[ai + 1];
                colorSum[idx * 4 + 2] += attrs[ai + 2];
                colorSum[idx * 4 + 3] += 1;
            }

            var outPositions = new short[uniqueCount * 3];
            Array.Copy(uniquePositions, outPositions, uniqueCount * 3);
            var outNormals = new sbyte[uniqueCount * 4];
            var outAttrs = new byte[uniqueCount * 4];
            var outSizes = new ushort[uniqueCount];
            Array.Copy(sizeMax, outSizes, uniqueCount);
            for (int v = 0; v < uniqueCount; v++)
            {
                int n = normalOf[v];
                double nx = normalSum[n * 3];
                double ny = normalSum[n * 3 + 1];
                double nz = normalSum[n * 3 + 2];
                double len = OrOne(JsMath.Hypot(nx, ny, nz));
                outNormals[v * 4] = ToInt8(JsMath.Round((nx / len) * 127));
                outNormals[v * 4 + 1] = ToInt8(JsMath.Round((ny / len) * 127));
                outNormals[v * 4 + 2] = ToInt8(JsMath.Round((nz / len) * 127));
                outNormals[v * 4 + 3] = 0;

                double count = OrOne(colorSum[v * 4 + 3]);
                outAttrs[v * 4] = ToUint8(JsMath.Round(colorSum[v * 4] / count));
                outAttrs[v * 4 + 1] = ToUint8(JsMath.Round(colorSum[v * 4 + 1] / count));
                outAttrs[v * 4 + 2] = ToUint8(JsMath.Round(colorSum[v * 4 + 2] / count));
                outAttrs[v * 4 + 3] = vertexClass[v];
            }

            return new SmoothLandMesh
            {
                OutPositions = outPositions,
                OutNormals = outNormals,
                OutAttrs = outAttrs,
                OutSizes = outSizes,
                Indices = remap,
                VertexCount = uniqueCount,
            };
        }

        /// <summary>
        /// The weld's region of a land vertex: on a land-use tile a non-ground
        /// vertex is its whole cover word (rgb + class); Ground, and every vertex of
        /// a raster-only tile, keys on class alone.
        /// </summary>
        private static int RegionKeyOf(byte[] attrs, int v, bool landuse)
        {
            byte cls = attrs[v * 4 + 3];
            if (!landuse || cls == GroundClass)
            {
                return cls;
            }
            return attrs[v * 4] | (attrs[v * 4 + 1] << 8) | (attrs[v * 4 + 2] << 16) | (cls << 24);
        }

        /// <summary>JS `x || 1`: 0 and NaN fall back to 1.</summary>
        private static double OrOne(double x) => x == 0 || double.IsNaN(x) ? 1 : x;

        /// <summary>A typed-array store into Int8Array: ToInt32 then wrap.</summary>
        private static sbyte ToInt8(double x) => unchecked((sbyte)(int)x);

        /// <summary>A typed-array store into Uint8Array: ToInt32 then wrap.</summary>
        private static byte ToUint8(double x) => unchecked((byte)(int)x);
    }
}
