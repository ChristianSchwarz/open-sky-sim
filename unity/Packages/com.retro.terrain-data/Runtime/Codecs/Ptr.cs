using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    public enum RoadClass
    {
        Motorway = 0,
        Trunk = 1,
        Primary = 2,
        Secondary = 3,
        Tertiary = 4,
        Unclassified = 5,
        Residential = 6,
        Rail = 7,
        RailService = 8,
        ZoneDiverging = 9,
        ZoneThrough = 10,
        Crossing = 11,
    }

    /// <summary>A decoded PTR1 road/rail stroke tile (v1-v3). Two vertices per centreline point.</summary>
    public sealed class PtrTile
    {
        public TileKey Id;
        public float QuantScale;
        public short[] Positions;
        /// <summary>Stride 4: cross-road unit offset /127; the 4th byte is the RoadClass, 0x40 = side bit.</summary>
        public sbyte[] Directions;
        /// <summary>Decimetres.</summary>
        public ushort[] HalfWidths;
        /// <summary>0.05 m steps, wrapping at 3276.8 m. Zero for v1 tiles.</summary>
        public ushort[] Along;
        /// <summary>TRACK_FLAG_* bits. Zero before v3.</summary>
        public byte[] Flags;
        public ushort[] Indices;
        /// <summary>bit0 = graded.</summary>
        public int TileFlags;
    }

    public static class PtrCodec
    {
        public const uint Magic = 0x31525450; // 'PTR1'
        public const int MaxVersion = 3;
        public const int HeaderBytes = 24;
        public const int RoadSideBit = 0x40;
        public const int RoadClassMask = 0x3F;
        public const double AlongStepM = 0.05;
        public const double AlongWrapM = 65536 * AlongStepM;
        public const int TileGraded = 1;

        public static PtrTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes) throw new InvalidDataException($"PTR1 too short: {raw.Length}");
            Bytes.Magic(raw, Magic, "PTR1");
            int version = Bytes.U8(raw, 4);
            if (version < 1 || version > MaxVersion) throw new InvalidDataException($"PTR1 version {version}, expected 1 to {MaxVersion}");
            int z = Bytes.U8(raw, 5);
            int tileFlags = Bytes.U16(raw, 6);
            int x = (int)Bytes.U32(raw, 8), y = (int)Bytes.U32(raw, 12);
            float quantScale = Bytes.F32(raw, 16);
            int verts = Bytes.U16(raw, 20), tris = Bytes.U16(raw, 22);
            int alongBytes = version >= 2 ? Bytes.Align4(verts * 2) : 0;
            int flagBytes = version >= 3 ? Bytes.Align4(verts) : 0;
            int need = HeaderBytes + Bytes.Align4(verts * 6) + Bytes.Align4(verts * 4) + Bytes.Align4(verts * 2)
                + alongBytes + flagBytes + Bytes.Align4(tris * 6);
            if (raw.Length < need) throw new InvalidDataException($"PTR1 {z}/{x}/{y}: {raw.Length} bytes, {need} needed");

            var t = new PtrTile { Id = new TileKey(z, x, y), QuantScale = quantScale, TileFlags = tileFlags };
            int off = HeaderBytes;
            t.Positions = Bytes.Section<short>(raw, off, verts * 3); off += Bytes.Align4(verts * 6);
            t.Directions = Bytes.Section<sbyte>(raw, off, verts * 4); off += Bytes.Align4(verts * 4);
            t.HalfWidths = Bytes.Section<ushort>(raw, off, verts); off += Bytes.Align4(verts * 2);
            t.Along = alongBytes > 0 ? Bytes.Section<ushort>(raw, off, verts) : new ushort[verts]; off += alongBytes;
            t.Flags = flagBytes > 0 ? Bytes.Section<byte>(raw, off, verts) : new byte[verts]; off += flagBytes;
            t.Indices = Bytes.Section<ushort>(raw, off, tris * 3);
            return t;
        }
    }
}
