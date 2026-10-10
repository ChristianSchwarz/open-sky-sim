using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    public enum BridgeRole
    {
        Deck = 0,
        Concrete = 1,
        RailDeck = 2,
        SignRed = 3,
        SignWhite = 4,
        SignPost = 5,
    }

    /// <summary>Rail track strokes laid on a bridge deck (PBR v2+).</summary>
    public sealed class PbrTrack
    {
        public short[] Positions;
        public sbyte[] Directions;
        public ushort[] HalfWidths;
        public ushort[] Along;
        public ushort[] Indices;
    }

    /// <summary>A decoded PBR1 bridge tile (v1-v5).</summary>
    public sealed class PbrTile
    {
        public TileKey Id;
        public float QuantScale;
        public short[] Positions;
        /// <summary>Stride 4: xyz /127, then role | (tier + 1) &lt;&lt; 4.</summary>
        public sbyte[] Normals;
        public ushort[] Indices;
        public PbrTrack Track;
        /// <summary>16 floats per level-crossing box (centre, 3 axes, half sizes, role). Null when none.</summary>
        public float[] Boxes;
        /// <summary>4 floats per ramp (crossing point xyz, dh). Null when none.</summary>
        public float[] Ramps;
        /// <summary>7 floats per road deck end (end xyz, tier, point 1 m in xyz). Null when none.</summary>
        public float[] RoadEnds;
    }

    public static class PbrCodec
    {
        public const uint Magic = 0x31524250; // 'PBR1'
        public const int MaxVersion = 5;
        public const int HeaderBytes = 24;
        public const int BoxFloats = 16, RampFloats = 4, RoadEndFloats = 7;
        public const int RoleMask = 0x0F, TierShift = 4;

        public static BridgeRole Role(sbyte b) => (BridgeRole)(b & RoleMask);
        public static int Tier(sbyte b) => ((b & 0xFF) >> TierShift) - 1;

        public static PbrTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes) throw new InvalidDataException($"PBR1 too short: {raw.Length}");
            Bytes.Magic(raw, Magic, "PBR1");
            int version = Bytes.U8(raw, 4);
            if (version < 1 || version > MaxVersion) throw new InvalidDataException($"PBR1 version {version}, expected 1 to {MaxVersion}");
            int z = Bytes.U8(raw, 5);
            int x = (int)Bytes.U32(raw, 8), y = (int)Bytes.U32(raw, 12);
            float quantScale = Bytes.F32(raw, 16);
            int verts = Bytes.U16(raw, 20), tris = Bytes.U16(raw, 22);
            int need = HeaderBytes + Bytes.Align4(verts * 6) + Bytes.Align4(verts * 4) + Bytes.Align4(tris * 6);
            if (raw.Length < need) throw new InvalidDataException($"PBR1 {z}/{x}/{y}: {raw.Length} bytes, {need} needed");

            var t = new PbrTile { Id = new TileKey(z, x, y), QuantScale = quantScale };
            int off = HeaderBytes;
            t.Positions = Bytes.Section<short>(raw, off, verts * 3); off += Bytes.Align4(verts * 6);
            t.Normals = Bytes.Section<sbyte>(raw, off, verts * 4); off += Bytes.Align4(verts * 4);
            t.Indices = Bytes.Section<ushort>(raw, off, tris * 3); off += Bytes.Align4(tris * 6);

            if (version >= 2 && off + 4 <= raw.Length)
            {
                int tVerts = Bytes.U16(raw, off), tTris = Bytes.U16(raw, off + 2);
                off += 4;
                int tNeed = Bytes.Align4(tVerts * 6) + Bytes.Align4(tVerts * 4) + Bytes.Align4(tVerts * 2) * 2 + Bytes.Align4(tTris * 6);
                if (off + tNeed > raw.Length) throw new InvalidDataException($"PBR1 {z}/{x}/{y}: track truncated");
                int trackEnd = off + tNeed;
                if (tVerts > 0 && tTris > 0)
                {
                    var track = new PbrTrack();
                    track.Positions = Bytes.Section<short>(raw, off, tVerts * 3); off += Bytes.Align4(tVerts * 6);
                    track.Directions = Bytes.Section<sbyte>(raw, off, tVerts * 4); off += Bytes.Align4(tVerts * 4);
                    track.HalfWidths = Bytes.Section<ushort>(raw, off, tVerts); off += Bytes.Align4(tVerts * 2);
                    track.Along = Bytes.Section<ushort>(raw, off, tVerts); off += Bytes.Align4(tVerts * 2);
                    track.Indices = Bytes.Section<ushort>(raw, off, tTris * 3);
                    t.Track = track;
                }
                off = trackEnd;
            }
            t.Boxes = FloatBlock(raw, ref off, version >= 3, BoxFloats, z, x, y, "furniture");
            t.Ramps = FloatBlock(raw, ref off, version >= 4, RampFloats, z, x, y, "ramps");
            t.RoadEnds = FloatBlock(raw, ref off, version >= 5, RoadEndFloats, z, x, y, "road deck ends");
            return t;
        }

        /// <summary>A u32 count then count * stride floats; null when absent or empty.</summary>
        private static float[] FloatBlock(byte[] raw, ref int off, bool present, int stride, int z, int x, int y, string what)
        {
            if (!present || off + 4 > raw.Length) return null;
            int count = (int)Bytes.U32(raw, off);
            off += 4;
            if (off + count * stride * 4 > raw.Length) throw new InvalidDataException($"PBR1 {z}/{x}/{y}: {what} truncated");
            float[] block = count > 0 ? Bytes.Section<float>(raw, off, count * stride) : null;
            off += count * stride * 4;
            return block;
        }
    }
}
