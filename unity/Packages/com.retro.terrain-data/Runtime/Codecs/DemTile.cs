using System;
using System.IO;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>A decoded PDM1 height tile: size x size nodes, row 0 north, column 0 west, edges shared with neighbours.</summary>
    public sealed class DemTile
    {
        public int Size;
        public int Flags;
        public float MinH;
        public float MaxH;
        public float QuantScale;
        public float GeometricErrorM;
        /// <summary>Row-major metres; NaN marks nodata.</summary>
        public float[] Heights;
    }

    public static class DemCodec
    {
        public const uint Magic = 0x314D4450; // 'PDM1'
        public const ushort NoData = 0xFFFF;
        public const int HeaderBytes = 24;

        /// <summary>Decode a PDM1 file: zlib-compressed, or an already-inflated payload starting with the magic.</summary>
        public static DemTile Decode(byte[] raw)
        {
            byte[] payload = raw.Length >= 4 && raw[0] == 0x50 && raw[1] == 0x44 && raw[2] == 0x4D && raw[3] == 0x31
                ? raw
                : Bytes.Unzlib(raw);
            if (payload.Length < HeaderBytes) throw new InvalidDataException($"PDM1 too short: {payload.Length}");
            Bytes.Magic(payload, Magic, "PDM1");
            int size = Bytes.U16(payload, 4);
            var t = new DemTile
            {
                Size = size,
                Flags = Bytes.U8(payload, 6),
                MinH = Bytes.F32(payload, 8),
                MaxH = Bytes.F32(payload, 12),
                QuantScale = Bytes.F32(payload, 16),
                GeometricErrorM = Bytes.F32(payload, 20),
            };
            int expected = HeaderBytes + size * size * 2;
            if (payload.Length < expected) throw new InvalidDataException($"PDM1 truncated: {payload.Length} < {expected}");
            var heights = new float[size * size];
            double minH = t.MinH, scale = t.QuantScale;
            for (int i = 0, o = HeaderBytes; i < heights.Length; i++, o += 2)
            {
                ushort q = Bytes.U16(payload, o);
                // Computed in double, stored as float, exactly like the Float32Array in demTile.ts.
                heights[i] = q == NoData ? float.NaN : (float)(minH + q * scale);
            }
            t.Heights = heights;
            return t;
        }

        /// <summary>Nearest-node sample at normalised (u, v); NaN out of range or on nodata. Uses JS rounding.</summary>
        public static double SampleNearest(DemTile tile, double u, double v)
        {
            int n = tile.Size;
            double ix = JsMath.Round(u * (n - 1));
            double iy = JsMath.Round(v * (n - 1));
            if (ix < 0 || iy < 0 || ix >= n || iy >= n) return double.NaN;
            return tile.Heights[(int)iy * n + (int)ix];
        }

        /// <summary>Bilinear sample at normalised (u, v), v = 0 at the north edge. Nodata neighbours are skipped.</summary>
        public static double SampleBilinear(DemTile tile, double u, double v)
        {
            int n = tile.Size;
            double fx = u * (n - 1);
            double fy = v * (n - 1);
            if (fx < 0 || fy < 0 || fx > n - 1 || fy > n - 1) return double.NaN;
            int x0 = (int)Math.Floor(fx);
            int y0 = (int)Math.Floor(fy);
            int x1 = Math.Min(n - 1, x0 + 1);
            int y1 = Math.Min(n - 1, y0 + 1);
            double tx = fx - x0;
            double ty = fy - y0;
            double sum = 0, w = 0;
            void Add(double h, double weight)
            {
                if (!double.IsNaN(h) && !double.IsInfinity(h) && weight > 0)
                {
                    sum += h * weight;
                    w += weight;
                }
            }
            Add(tile.Heights[y0 * n + x0], (1 - tx) * (1 - ty));
            Add(tile.Heights[y0 * n + x1], tx * (1 - ty));
            Add(tile.Heights[y1 * n + x0], (1 - tx) * ty);
            Add(tile.Heights[y1 * n + x1], tx * ty);
            return w > 0 ? sum / w : double.NaN;
        }
    }
}
