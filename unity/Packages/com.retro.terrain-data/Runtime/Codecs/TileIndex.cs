using System.Collections.Generic;
using System.IO;
using System.Linq;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// PIX1 "tile exists" bitmask (index*.bin). Per level a bounding box and an
    /// LSB-first bit per tile in it. A missing tile is sea, not an error.
    /// </summary>
    public sealed class TileIndex
    {
        public const uint Magic = 0x31584950; // 'PIX1'

        private sealed class Level
        {
            public int MinX, MinY, W, H;
            public byte[] Bits;
        }

        private readonly Dictionary<int, Level> _levels = new Dictionary<int, Level>();

        public int MinZoom { get; private set; }
        public int MaxZoom { get; private set; }

        public static TileIndex Decode(byte[] raw)
        {
            if (raw.Length < 8 || Bytes.U32(raw, 0) != Magic) throw new InvalidDataException("Bad planet index.bin magic");
            var idx = new TileIndex { MinZoom = Bytes.U16(raw, 4), MaxZoom = Bytes.U16(raw, 6) };
            int levelCount = idx.MaxZoom - idx.MinZoom + 1;
            int o = 8;
            var headers = new List<(int z, Level l)>();
            for (int i = 0; i < levelCount; i++, o += 16)
            {
                headers.Add((idx.MinZoom + i, new Level
                {
                    MinX = (int)Bytes.U32(raw, o),
                    MinY = (int)Bytes.U32(raw, o + 4),
                    W = (int)Bytes.U32(raw, o + 8),
                    H = (int)Bytes.U32(raw, o + 12),
                }));
            }
            foreach (var (z, l) in headers)
            {
                int byteCount = (int)(((long)l.W * l.H + 7) / 8);
                l.Bits = Bytes.Section<byte>(raw, o, byteCount);
                o += byteCount;
                idx._levels[z] = l;
            }
            return idx;
        }

        /// <summary>Levels the index describes, ascending.</summary>
        public int[] Levels => _levels.Keys.OrderBy(z => z).ToArray();

        /// <summary>Every tile the index holds at z, in row-major order.</summary>
        public List<TileKey> TilesAt(int z)
        {
            var output = new List<TileKey>();
            if (!_levels.TryGetValue(z, out Level l)) return output;
            for (int i = 0; i < l.W * l.H; i++)
            {
                if ((l.Bits[i >> 3] & (1 << (i & 7))) != 0)
                {
                    output.Add(new TileKey(z, l.MinX + i % l.W, l.MinY + i / l.W));
                }
            }
            return output;
        }

        public bool Has(TileKey key)
        {
            if (!_levels.TryGetValue(key.Z, out Level l)) return false;
            int lx = key.X - l.MinX, ly = key.Y - l.MinY;
            if (lx < 0 || ly < 0 || lx >= l.W || ly >= l.H) return false;
            int i = ly * l.W + lx;
            return (l.Bits[i >> 3] & (1 << (i & 7))) != 0;
        }
    }
}
