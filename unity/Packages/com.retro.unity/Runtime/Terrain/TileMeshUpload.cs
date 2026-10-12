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
        /// <summary>The watercourse strokes (riverVP.ts), in RoadStroke's streams; null when none.</summary>
        public Mesh Rivers;
        /// <summary>The seam stitcher's T-junction fill (seamStitch.ts), drawn as part of the land; null when none.</summary>
        public Mesh Fill;
        /// <summary>
        /// What the land was built from, to build it again when the stitcher moves it (GPU-only
        /// meshes cannot be written in part): the region widths, and for SMOOTH the weld.
        /// </summary>
        public float[] Sizes;
        public SmoothLandMesh SmoothSource;
        public float[] SmoothSizes;
        public int TriangleCount;

        public void Destroy()
        {
            if (Land != null) Object.Destroy(Land);
            if (Water != null) Object.Destroy(Water);
            if (Rivers != null) Object.Destroy(Rivers);
            if (Fill != null) Object.Destroy(Fill);
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
        public ushort[] RawSizes;
        public SmoothLandMesh Smooth;
        public float[] SmoothSizes;

        /// <param name="live">The land as the seam stitcher left it, for the SMOOTH weld (buildSmoothLandGeometryFromFaceted); null: as baked.</param>
        public static LandPrep Make(PtmTile tile, bool smooth, short[] live = null)
        {
            var prep = new LandPrep();
            if (tile.LandPositions.Length == 0) return prep;
            prep.Normals = (sbyte[])tile.LandNormals.Clone();
            LandMesh.LeanEdgeNormals(tile.LandPositions, prep.Normals);
            ushort[] sizes = LandMesh.RegionSizes(tile.LandPositions, tile.LandAttrs, tile.QuantScale);
            prep.Sizes = Floats(sizes);
            prep.RawSizes = sizes;
            if (smooth)
            {
                prep.Smooth = LandMesh.BuildSmoothLandGeometry(live ?? tile.LandPositions, prep.Normals, tile.LandAttrs, sizes);
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

        /// <param name="live">The faceted land positions to upload (the stitcher's live copy); null: as baked.</param>
        public static TileGpuMeshes Build(PtmTile tile, LandPrep prep, short[] live = null)
        {
            var result = new TileGpuMeshes();
            int land = tile.LandPositions.Length / 3;
            if (land > 0)
            {
                result.Smooth = prep.Smooth != null;
                result.Land = result.Smooth
                    ? BuildSmoothLand(tile, prep)
                    : MakeSoupLand($"land {tile.Id}", live ?? tile.LandPositions, prep.Normals, tile.LandAttrs, prep.Sizes);
                result.Sizes = prep.Sizes;
                result.SmoothSource = prep.Smooth;
                result.SmoothSizes = prep.SmoothSizes;
                result.TriangleCount += land / 3;
            }
            if (tile.WaterIndices.Length > 0)
            {
                result.Water = BuildWater(tile);
                result.TriangleCount += tile.WaterIndices.Length / 3;
            }
            if (tile.RiverIndices.Length > 0) result.Rivers = BuildRivers(tile);
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
        private static Mesh BuildSmoothLand(PtmTile tile, LandPrep prep) =>
            MakeSmoothLand($"land {tile.Id} smooth", prep.Smooth, prep.SmoothSizes);

        /// <summary>A welded land mesh (the near land's, or a far level's) in the land streams.</summary>
        internal static Mesh MakeSmoothLand(string name, SmoothLandMesh s, float[] sizes)
        {
            var mesh = new Mesh { name = name };
            LandStreams(mesh, s.VertexCount, s.OutPositions, s.OutNormals, s.OutAttrs, sizes);
            int indexCount = s.Indices.Length;
            mesh.SetIndexBufferParams(indexCount, IndexFormat.UInt32);
            mesh.SetIndexBufferData(s.Indices, 0, 0, indexCount, Quiet);
            mesh.SetSubMeshes(new[] { new SubMeshDescriptor(0, indexCount, MeshTopology.Triangles) { bounds = UnitBounds, vertexCount = s.VertexCount } }, Quiet);
            mesh.bounds = UnitBounds;
            mesh.UploadMeshData(true);
            return mesh;
        }

        /// <summary>A faceted land soup (the near land's, or a far level's) with a sequential index.</summary>
        internal static Mesh MakeSoupLand(string name, short[] xyz, sbyte[] normals, byte[] attrs, float[] sizes)
        {
            int count = xyz.Length / 3;
            var mesh = new Mesh { name = name };
            LandStreams(mesh, count, xyz, normals, attrs, sizes);

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

        /// <summary>
        /// tileMesh.ts strokeGeometry(PTM_STROKE_KIND_WATER): the centreline doubled, each vertex with
        /// its unit offset across the flow and half width (dm), in RoadStroke's streams. The stream
        /// also holds land-use outlines (kind byte in the offset's pad), which the web never draws:
        /// only the water triangles are indexed. Null when the tile has none.
        /// </summary>
        private static Mesh BuildRivers(PtmTile tile)
        {
            const sbyte KindWater = 0;
            ushort[] all = tile.RiverIndices;
            sbyte[] dirs = tile.RiverDirections;
            var indices = new System.Collections.Generic.List<int>(all.Length);
            for (int i = 0; i + 2 < all.Length; i += 3)
            {
                if (dirs[all[i] * 4 + 3] != KindWater) continue;
                indices.Add(all[i]);
                indices.Add(all[i + 1]);
                indices.Add(all[i + 2]);
            }
            if (indices.Count == 0) return null;
            int n = tile.RiverHalfWidths.Length;
            var mesh = new Mesh { name = $"rivers {tile.Id}" };
            mesh.SetVertexBufferParams(n,
                new VertexAttributeDescriptor(VertexAttribute.Position, VertexAttributeFormat.SNorm16, 4, 0),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord0, VertexAttributeFormat.SNorm8, 4, 1),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord1, VertexAttributeFormat.UNorm16, 2, 2),
                new VertexAttributeDescriptor(VertexAttribute.TexCoord2, VertexAttributeFormat.UNorm8, 4, 3));
            using (NativeArray<short> positions = PadPositions(tile.RiverPositions, n))
            {
                mesh.SetVertexBufferData(positions, 0, 0, positions.Length, 0, Quiet);
            }
            mesh.SetVertexBufferData(dirs, 0, 0, n * 4, 1, Quiet);
            var half = new ushort[n * 2];
            for (int i = 0; i < n; i++) half[i * 2] = tile.RiverHalfWidths[i];
            mesh.SetVertexBufferData(half, 0, 0, half.Length, 2, Quiet);
            mesh.SetVertexBufferData(new byte[n * 4], 0, 0, n * 4, 3, Quiet);
            mesh.SetIndexBufferParams(indices.Count, IndexFormat.UInt32);
            mesh.SetIndexBufferData(indices, 0, 0, indices.Count, Quiet);
            mesh.SetSubMeshes(new[] { new SubMeshDescriptor(0, indices.Count, MeshTopology.Triangles) { bounds = UnitBounds, vertexCount = n } }, Quiet);
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
