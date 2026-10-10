using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>Where a tile's land border lies, for runtime seam stitching. See PtmCodec for the packing.</summary>
    public sealed class PtmBorder
    {
        /// <summary>Side in the top 2 bits (W0 E1 N2 S3), land vertex index in the low 30.</summary>
        public uint[] Vertices;
        public float[] VertexParams;
        /// <summary>Two packed entries per edge.</summary>
        public uint[] Edges;
        public float[] EdgeParams;
    }

    /// <summary>A decoded PTM1 terrain mesh tile (v6). Field names mirror ptm.ts.</summary>
    public sealed class PtmTile
    {
        public TileKey Id;
        public int Version;
        public int Flags;
        /// <summary>Ellipsoidal height of the tile-frame origin.</summary>
        public float CenterHeightM;
        /// <summary>Metres per int16 unit, uniform on all axes.</summary>
        public float QuantScale;
        public float BoundingRadiusM;
        public float SkirtDepthM;
        public float GeometricErrorM;
        /// <summary>Non-indexed triangle soup, xyz per vertex, tile-local bake axes (x E, y U, z S).</summary>
        public short[] LandPositions;
        /// <summary>Stride 4: xyz /127 plus a pad byte.</summary>
        public sbyte[] LandNormals;
        /// <summary>Stride 4: sRGB r, g, b and the TerrainClass.</summary>
        public byte[] LandAttrs;
        public short[] WaterPositions;
        public byte[] WaterTones;
        public ushort[] WaterIndices;
        /// <summary>[start, count] into WaterIndices for tones 0 (deep) and 1 (shallow).</summary>
        public int[][] WaterGroups;
        public short[] RiverPositions;
        /// <summary>Stride 4: unit cross-flow offset /127; the 4th byte is the stroke kind.</summary>
        public sbyte[] RiverDirections;
        /// <summary>Decimetres.</summary>
        public ushort[] RiverHalfWidths;
        public ushort[] RiverIndices;
        /// <summary>Null for a tile baked without one.</summary>
        public PtmBorder Border;
    }

    public static class PtmCodec
    {
        public const uint Magic = 0x314D5450; // 'PTM1'
        public const int Version = 6;
        public const int HeaderBytes = 72;
        public const int FlagLand = 1, FlagWater = 2, FlagRivers = 4, FlagGraded = 8;
        public const int SideW = 0, SideE = 1, SideN = 2, SideS = 3;

        public static int BorderEntrySide(uint packed) => (int)(packed >> 30);
        public static int BorderEntryIndex(uint packed) => (int)(packed & ((1u << 30) - 1));

        /// <summary>Decode inflated PTM1 bytes (gunzip first; see Bytes.Gunzip).</summary>
        public static PtmTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes) throw new InvalidDataException($"PTM1 too short: {raw.Length}");
            Bytes.Magic(raw, Magic, "PTM1");
            int version = Bytes.U8(raw, 4);
            if (version != Version)
            {
                throw new InvalidDataException($"Unsupported PTM1 version {version}, expected {Version}. Re-bake the mesh.");
            }
            int z = Bytes.U8(raw, 5);
            int flags = Bytes.U16(raw, 6);
            int x = (int)Bytes.U32(raw, 8);
            int y = (int)Bytes.U32(raw, 12);
            int landVerts = (int)Bytes.U32(raw, 32);
            int waterVerts = (int)Bytes.U32(raw, 36);
            int waterIndexCount = (int)Bytes.U32(raw, 40);
            int riverVerts = (int)Bytes.U32(raw, 44);
            int riverIndexCount = (int)Bytes.U32(raw, 48);
            int waterDeep = (int)Bytes.U32(raw, 56);
            int waterShallow = (int)Bytes.U32(raw, 60);
            if (landVerts % 3 != 0) throw new InvalidDataException($"PTM1: landVertCount {landVerts} is not a multiple of 3");
            if (waterDeep + waterShallow != waterIndexCount)
            {
                throw new InvalidDataException("PTM1: water group counts do not sum to waterIndexCount");
            }

            var t = new PtmTile
            {
                Id = new TileKey(z, x, y),
                Version = version,
                Flags = flags,
                CenterHeightM = Bytes.F32(raw, 16),
                QuantScale = Bytes.F32(raw, 20),
                BoundingRadiusM = Bytes.F32(raw, 28),
                SkirtDepthM = Bytes.F32(raw, 64),
                GeometricErrorM = Bytes.F32(raw, 68),
                WaterGroups = new[] { new[] { 0, waterDeep }, new[] { waterDeep, waterShallow } },
            };

            int off = HeaderBytes;
            t.LandPositions = Bytes.Section<short>(raw, off, landVerts * 3); off += Bytes.Align4(landVerts * 6);
            t.LandNormals = Bytes.Section<sbyte>(raw, off, landVerts * 4); off += Bytes.Align4(landVerts * 4);
            t.LandAttrs = Bytes.Section<byte>(raw, off, landVerts * 4); off += Bytes.Align4(landVerts * 4);
            t.WaterPositions = Bytes.Section<short>(raw, off, waterVerts * 3); off += Bytes.Align4(waterVerts * 6);
            t.WaterTones = Bytes.Section<byte>(raw, off, waterVerts); off += Bytes.Align4(waterVerts);
            t.WaterIndices = Bytes.Section<ushort>(raw, off, waterIndexCount); off += Bytes.Align4(waterIndexCount * 2);
            t.RiverPositions = Bytes.Section<short>(raw, off, riverVerts * 3); off += Bytes.Align4(riverVerts * 6);
            t.RiverDirections = Bytes.Section<sbyte>(raw, off, riverVerts * 4); off += Bytes.Align4(riverVerts * 4);
            t.RiverHalfWidths = Bytes.Section<ushort>(raw, off, riverVerts); off += Bytes.Align4(riverVerts * 2);
            t.RiverIndices = Bytes.Section<ushort>(raw, off, riverIndexCount); off += Bytes.Align4(riverIndexCount * 2);

            uint borderBytes = Bytes.U32(raw, 24);
            if (borderBytes > 0)
            {
                if (raw.Length < off + borderBytes) throw new InvalidDataException("PTM1 truncated border");
                int vertexCount = (int)Bytes.U32(raw, off);
                int edgeCount = (int)Bytes.U32(raw, off + 4);
                int at = off + 8;
                var b = new PtmBorder();
                b.Vertices = Bytes.Section<uint>(raw, at, vertexCount); at += vertexCount * 4;
                b.VertexParams = Bytes.Section<float>(raw, at, vertexCount); at += vertexCount * 4;
                b.Edges = Bytes.Section<uint>(raw, at, edgeCount * 2); at += edgeCount * 8;
                b.EdgeParams = Bytes.Section<float>(raw, at, edgeCount * 2);
                t.Border = b;
            }
            return t;
        }
    }
}
