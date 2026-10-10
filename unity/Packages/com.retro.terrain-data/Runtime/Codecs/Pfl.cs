using System.Collections.Generic;
using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>One simplified level of a leaf's land, non-indexed like the PTM land soup.</summary>
    public sealed class PflLevel
    {
        public float ToleranceM;
        /// <summary>9 per triangle.</summary>
        public short[] Positions;
        /// <summary>12 per triangle (stride 4 per vertex).</summary>
        public sbyte[] Normals;
        /// <summary>12 per triangle (stride 4 per vertex).</summary>
        public byte[] Attrs;
        public ushort[] RegionSizes;
        /// <summary>Two entries per pair: level corner to near-tile border vertex.</summary>
        public uint[] BorderMap;
    }

    /// <summary>A decoded PFL1 far-land tile: lighter levels of a z12 leaf's land, finest first.</summary>
    public sealed class PflTile
    {
        public TileKey Id;
        public float QuantScale;
        public uint NearTriangles;
        /// <summary>FNV-1a over the near tile's int16 land positions (seam moves reverted); a mismatch means stale.</summary>
        public uint NearFingerprint;
        public List<PflLevel> Levels;
    }

    public static class PflCodec
    {
        public const uint Magic = 0x314C4650; // 'PFL1'
        public const int Version = 1;
        public const int HeaderBytes = 32;
        public const int LevelHeaderBytes = 16;

        /// <summary>landFingerprint in pfl.ts: FNV-1a over each int16's low 16 bits.</summary>
        public static uint LandFingerprint(short[] positions)
        {
            uint h = 0x811C9DC5;
            for (int i = 0; i < positions.Length; i++)
            {
                h = unchecked((h ^ (uint)(positions[i] & 0xFFFF)) * 0x01000193);
            }
            return h;
        }

        public static PflTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes || Bytes.U32(raw, 0) != Magic) throw new InvalidDataException("Not a PFL1 tile");
            int version = Bytes.U8(raw, 4);
            if (version != Version) throw new InvalidDataException($"PFL1 version {version}, expected {Version}");
            int levelCount = Bytes.U8(raw, 6);
            var tile = new PflTile
            {
                Id = new TileKey(Bytes.U8(raw, 5), (int)Bytes.U32(raw, 8), (int)Bytes.U32(raw, 12)),
                QuantScale = Bytes.F32(raw, 16),
                NearTriangles = Bytes.U32(raw, 20),
                NearFingerprint = Bytes.U32(raw, 24),
                Levels = new List<PflLevel>(levelCount),
            };
            int off = HeaderBytes;
            for (int i = 0; i < levelCount; i++)
            {
                if (off + LevelHeaderBytes > raw.Length) throw new InvalidDataException("PFL1 truncated");
                float tolerance = Bytes.F32(raw, off);
                int tris = (int)Bytes.U32(raw, off + 4);
                int pairs = (int)Bytes.U32(raw, off + 8);
                off += LevelHeaderBytes;
                tile.Levels.Add(new PflLevel
                {
                    ToleranceM = tolerance,
                    Positions = Take<short>(raw, ref off, tris * 9, 2),
                    Normals = Take<sbyte>(raw, ref off, tris * 12, 1),
                    Attrs = Take<byte>(raw, ref off, tris * 12, 1),
                    RegionSizes = Take<ushort>(raw, ref off, tris * 3, 2),
                    BorderMap = Take<uint>(raw, ref off, pairs * 2, 4),
                });
            }
            return tile;
        }

        private static T[] Take<T>(byte[] raw, ref int off, int count, int bytesPer) where T : struct
        {
            int need = count * bytesPer;
            if (off + need > raw.Length) throw new InvalidDataException("PFL1 truncated");
            T[] v = Bytes.Section<T>(raw, off, count);
            off = Bytes.Align4(off + need);
            return v;
        }
    }
}
