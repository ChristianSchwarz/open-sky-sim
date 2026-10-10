using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>A decoded PTX1 far-tile cover texture: RGBA8, row 0 north, column 0 west; alpha is the TerrainClass.</summary>
    public sealed class PtxTile
    {
        public TileKey Id;
        public int Size;
        public byte[] Texels;
    }

    public static class PtxCodec
    {
        public const uint Magic = 0x31585450; // 'PTX1'
        public const int Version = 1;
        public const int HeaderBytes = 16;
        /// <summary>The class byte that marks a texel as carrying nothing.</summary>
        public const byte NoData = 255;

        public static PtxTile Decode(byte[] raw)
        {
            if (raw.Length < HeaderBytes) throw new InvalidDataException($"PTX1 too short: {raw.Length}");
            Bytes.Magic(raw, Magic, "PTX1");
            int version = Bytes.U8(raw, 4);
            if (version != Version) throw new InvalidDataException($"PTX1 version {version}, expected {Version}");
            // Note: x and y are u16 here, unlike every other format.
            int z = Bytes.U8(raw, 5), x = Bytes.U16(raw, 8), y = Bytes.U16(raw, 10), size = Bytes.U16(raw, 12);
            int count = size * size * 4;
            if (raw.Length < HeaderBytes + count)
            {
                throw new InvalidDataException($"PTX1 {z}/{x}/{y}: {raw.Length} bytes for a {size}x{size} raster");
            }
            return new PtxTile { Id = new TileKey(z, x, y), Size = size, Texels = Bytes.Section<byte>(raw, HeaderBytes, count) };
        }
    }
}
