using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>Retaining walls along road and rail beds, tile-local metres.</summary>
    public sealed class RailWalls
    {
        public float[] Positions;
        public float[] Normals;
        public uint[] Indices;
    }

    /// <summary>A decoded PBD1 bed tile: graded road/rail beds and their retaining walls.</summary>
    public sealed class PbdTile
    {
        public TileKey Id;
        public float QuantScale;
        /// <summary>
        /// SegmentFloats per bed: end A xyz, end B xyz (tile-local metres),
        /// half width, lift, open flags, tier, batter reach (metres).
        /// </summary>
        public double[] Beds;
        /// <summary>Null when the tile has none.</summary>
        public RailWalls Walls;
    }

    public static class PbdCodec
    {
        public const uint Magic = 0x31444250; // 'PBD1'
        public const int Version = 1;
        public const int HeaderBytes = 32;
        public const int BedBytes = 20;
        /// <summary>RAIL_BED_SEGMENT_FLOATS in railBed.ts.</summary>
        public const int SegmentFloats = 11;

        public static PbdTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes || Bytes.U32(raw, 0) != Magic || Bytes.U8(raw, 4) != Version)
            {
                throw new InvalidDataException("not a PBD1 v1 file");
            }
            float q = Bytes.F32(raw, 16);
            int n = (int)Bytes.U32(raw, 20), wv = (int)Bytes.U32(raw, 24), wi = (int)Bytes.U32(raw, 28);
            var beds = new double[n * SegmentFloats];
            int o = HeaderBytes;
            for (int i = 0; i < n; i++, o += BedBytes)
            {
                int b = i * SegmentFloats;
                for (int k = 0; k < 6; k++) beds[b + k] = Bytes.I16(raw, o + k * 2) * (double)q;
                beds[b + 6] = Bytes.U16(raw, o + 12) / 100.0;
                beds[b + 7] = Bytes.U16(raw, o + 14) / 100.0;
                beds[b + 8] = Bytes.U8(raw, o + 16);
                beds[b + 9] = Bytes.U8(raw, o + 17);
                beds[b + 10] = Bytes.U16(raw, o + 18) / 100.0;
            }
            RailWalls walls = null;
            if (wv > 0 && wi > 0)
            {
                var positions = new float[wv * 3];
                var normals = new float[wv * 3];
                for (int i = 0; i < wv * 3; i++) positions[i] = (float)(Bytes.I16(raw, o + i * 2) * (double)q);
                o += Bytes.Align4(wv * 6);
                for (int i = 0; i < wv; i++)
                {
                    for (int k = 0; k < 3; k++) normals[i * 3 + k] = (float)(Bytes.I8(raw, o + i * 4 + k) / 127.0);
                }
                o += wv * 4;
                var indices = Bytes.Section<uint>(raw, o, wi);
                walls = new RailWalls { Positions = positions, Normals = normals, Indices = indices };
            }
            return new PbdTile
            {
                Id = new TileKey(Bytes.U8(raw, 5), (int)Bytes.U32(raw, 8), (int)Bytes.U32(raw, 12)),
                QuantScale = q,
                Beds = beds,
                Walls = walls,
            };
        }
    }
}
