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

        public static TileGpuMeshes Build(PtmTile tile)
        {
            var result = new TileGpuMeshes();
            int land = tile.LandPositions.Length / 3;
            if (land > 0)
            {
                result.Land = BuildLand(tile, land);
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

        private static Mesh BuildLand(PtmTile tile, int count)
        {
            var mesh = new Mesh { name = $"land {tile.Id}" };
            mesh.SetVertexBufferParams(count,
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.SNorm16, 4, 0),
                new VertexAttributeDescriptor(VertexAttribute.Normal, VertexAttributeFormat.SNorm8, 4, 1),
                new VertexAttributeDescriptor(VertexAttribute.Color, VertexAttributeFormat.UNorm8, 4, 2));
            using (NativeArray<short> positions = PadPositions(tile.LandPositions, count))
            {
                mesh.SetVertexBufferData(positions, 0, 0, positions.Length, 0, Quiet);
            }
            mesh.SetVertexBufferData(tile.LandNormals, 0, 0, tile.LandNormals.Length, 1, Quiet);
            mesh.SetVertexBufferData(tile.LandAttrs, 0, 0, tile.LandAttrs.Length, 2, Quiet);

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
