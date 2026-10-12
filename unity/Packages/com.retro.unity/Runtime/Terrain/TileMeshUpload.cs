using Retro.Terrain;
using Unity.Collections;
using UnityEngine;
using UnityEngine.Rendering;

namespace Retro.Unity
{
    /// <summary>The GPU meshes of one tile.</summary>
    public sealed class TileGpuMeshes
    {
        public Mesh Land;
        /// <summary>The land is the welded SMOOTH mesh (else the faceted soup).</summary>
        public bool Smooth;
        /// <summary>Submesh 0 deep, 1 shallow; null when the tile has no water.</summary>
        public Mesh Water;
        public int TriangleCount;

        public void Destroy()
        {
            if (Land != null) Object.Destroy(Land);
            if (Water != null) Object.Destroy(Water);
        }
    }

    /// <summary>
    /// The CPU side of a land upload, made off the main thread (tileMesh.ts landGeometryFromArrays):
    /// the normals with their edge lean (a copy: the decoded tile stays as read), each vertex's
    /// land-use region width (regionSizes), and for SMOOTH the welded mesh.
    /// </summary>
    public sealed class LandPrep
    {
        public sbyte[] Normals;
        public float[] Sizes;
        public SmoothLandMesh Smooth;
        public float[] SmoothSizes;

        public static LandPrep Make(PtmTile tile, bool smooth)
        {
            var prep = new LandPrep();
            if (tile.LandPositions.Length == 0) return prep;
            prep.Normals = (sbyte[])tile.LandNormals.Clone();
            LandMesh.LeanEdgeNormals(tile.LandPositions, prep.Normals);
            ushort[] sizes = LandMesh.RegionSizes(tile.LandPositions, tile.LandAttrs, tile.QuantScale);
            prep.Sizes = Floats(sizes);
            if (smooth)
            {
                prep.Smooth = LandMesh.BuildSmoothLandGeometry(tile.LandPositions, prep.Normals, tile.LandAttrs, sizes);
                if (prep.Smooth != null) prep.SmoothSizes = Floats(prep.Smooth.OutSizes);
            }
            return prep;
        }

        private static float[] Floats(ushort[] a)
        {
            var f = new float[a.Length];
            for (int i = 0; i < a.Length; i++) f[i] = a[i];
            return f;
        }
    }

    /// <summary>
    /// Builds Unity meshes straight from decoded PTM arrays, keeping the wire
    /// formats: positions SNorm16 (padded to 4 for alignment; the tile matrix
    /// carries quantScale * 32767), normals SNorm8 x4 (xyz + pad), colour UNorm8
    /// x4 (sRGB rgb + TerrainClass). Land is a non-indexed soup on the wire, so
    /// it gets a sequential index buffer.
    /// </summary>
    public static class TileMeshUpload
    {
        public const double SNorm16Max = 32767;

        private const MeshUpdateFlags Quiet =
            MeshUpdateFlags.DontRecalculateBounds | MeshUpdateFlags.DontValidateIndices
            | MeshUpdateFlags.DontNotifyMeshUsers | MeshUpdateFlags.DontResetBoneBounds;

        /// <summary>Object-space bounds: SNorm16 positions live in [-1, 1].</summary>
        private static readonly Bounds UnitBounds = new Bounds(Vector3.zero, Vector3.one * 2);

        public static TileGpuMeshes Build(PtmTile tile, LandPrep prep)
        {
            var result = new TileGpuMeshes();
            int land = tile.LandPositions.Length / 3;
            if (land > 0)
            {
                result.Smooth = prep.Smooth != null;
                result.Land = result.Smooth ? BuildSmoothLand(tile, prep) : BuildLand(tile, prep, land);
                result.TriangleCount += land / 3;
            }
            if (tile.WaterIndices.Length > 0)
            {
                result.Water = BuildWater(tile);
                result.TriangleCount += tile.WaterIndices.Length / 3;
            }
            return result;
        }

        private static NativeArray<short> PadPositions(short[] xyz, int count)
        {
            var padded = new NativeArray<short>(count * 4, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            for (int i = 0, j = 0; i < count; i++, j += 3)
            {
                padded[i * 4] = xyz[j];
                padded[i * 4 + 1] = xyz[j + 1];
                padded[i * 4 + 2] = xyz[j + 2];
                padded[i * 4 + 3] = 0;
            }
            return padded;
        }

        private static void LandStreams(Mesh mesh, int count, short[] xyz, sbyte[] normals, byte[] attrs, float[] sizes)
        {
            mesh.SetVertexBufferParams(count,
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.SNorm16, 4, 0),
                new VertexAttributeDescriptor(VertexAttribute.Normal, VertexAttributeFormat.SNorm8, 4, 1),
                new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4, 2),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.Float32, 1, 3));
            using (NativeArray<short> positions = PadPositions(xyz, count))
            {
                mesh.SetVertexBufferData(positions, 0, 0, positions.Length, 0, Quiet);
            }
            mesh.SetVertexBufferData(normals, 0, 0, count * 4, 1, Quiet);
            mesh.SetVertexBufferData(attrs, 0, 0, count * 4, 2, Quiet);
            mesh.SetVertexBufferData(sizes, 0, 0, count, 3, Quiet);
        }

        /// <summary>buildSmoothLandGeometry's welded mesh: shared vertices, an index list.</summary>
        private static Mesh BuildSmoothLand(PtmTile tile, LandPrep prep)
        {
            SmoothLandMesh s = prep.Smooth;
            var mesh = new Mesh { name = $"land {tile.Id} smooth" };
            LandStreams(mesh, s.VertexCount, s.OutPositions, s.OutNormals, s.OutAttrs, prep.SmoothSizes);
            int indexCount = s.Indices.Length;
            mesh.SetIndexBufferParams(indexCount, IndexFormat.UInt32);
            mesh.SetIndexBufferData(s.Indices, 0, 0, indexCount, Quiet);
            mesh.SetSubMeshes(new[] { new SubMeshDescriptor(0, indexCount, MeshTopology.Triangles) { bounds = UnitBounds, vertexCount = s.VertexCount } }, Quiet);
            mesh.bounds = UnitBounds;
            mesh.UploadMeshData(true);
            return mesh;
        }

        private static Mesh BuildLand(PtmTile tile, LandPrep prep, int count)
        {
            var mesh = new Mesh { name = $"land {tile.Id}" };
            LandStreams(mesh, count, tile.LandPositions, prep.Normals, tile.LandAttrs, prep.Sizes);

            mesh.SetIndexBufferParams(count, IndexFormat.UInt32);
            // Not a `using` declaration: C# forbids writing through a using-declared struct.
            var indices = new NativeArray<int>(count, Allocator.Temp, NativeArrayOptions.UninitializedMemory);
            try
            {
                for (int i = 0; i < count; i++) indices[i] = i;
                mesh.SetIndexBufferData(indices, 0, 0, count, Quiet);
            }
            finally
            {
                indices.Dispose();
            }
            // SetSubMeshes, not subMeshCount: the setter recalculates bounds, which a
            // non-Float3 position stream cannot do (it warns per tile).
            mesh.SetSubMeshes(new[] { new SubMeshDescriptor(0, count, MeshTopology.Triangles) { bounds = UnitBounds, vertexCount = count } }, Quiet);
            mesh.bounds = UnitBounds;
            mesh.UploadMeshData(true);
            return mesh;
        }

        private static Mesh BuildWater(PtmTile tile)
        {
            int count = tile.WaterPositions.Length / 3;
            var mesh = new Mesh { name = $"water {tile.Id}" };
            mesh.SetVertexBufferParams(count,
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.SNorm16, 4, 0));
            using (NativeArray<short> positions = PadPositions(tile.WaterPositions, count))
            {
                mesh.SetVertexBufferData(positions, 0, 0, positions.Length, 0, Quiet);
            }
            int indexCount = tile.WaterIndices.Length;
            mesh.SetIndexBufferParams(indexCount, IndexFormat.UInt16);
            mesh.SetIndexBufferData(tile.WaterIndices, 0, 0, indexCount, Quiet);
            var groups = new SubMeshDescriptor[2];
            for (int tone = 0; tone < 2; tone++)
            {
                int start = tile.WaterGroups[tone][0], n = tile.WaterGroups[tone][1];
                groups[tone] = new SubMeshDescriptor(start, n, MeshTopology.Triangles) { bounds = UnitBounds, vertexCount = count };
            }
            mesh.SetSubMeshes(groups, Quiet);
            mesh.bounds = UnitBounds;
            mesh.UploadMeshData(true);
            return mesh;
        }
    }
}
