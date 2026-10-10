using System;
using System.Buffers.Binary;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;

namespace Retro.Terrain
{
    /// <summary>
    /// Little-endian reads and section copies shared by the tile decoders.
    /// Every format is little-endian with 4-byte aligned sections; every
    /// platform Unity ships on is little-endian, so sections are reinterpreted
    /// with MemoryMarshal rather than read element by element.
    /// </summary>
    internal static class Bytes
    {
        static Bytes()
        {
            if (!BitConverter.IsLittleEndian)
            {
                throw new PlatformNotSupportedException("terrain decoders assume a little-endian platform");
            }
        }

        public static int Align4(int n) => (n + 3) & ~3;

        public static byte U8(byte[] b, int o) => b[o];
        public static sbyte I8(byte[] b, int o) => unchecked((sbyte)b[o]);
        public static ushort U16(byte[] b, int o) => BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(o, 2));
        public static short I16(byte[] b, int o) => BinaryPrimitives.ReadInt16LittleEndian(b.AsSpan(o, 2));
        public static uint U32(byte[] b, int o) => BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(o, 4));
        public static float F32(byte[] b, int o) => BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(b.AsSpan(o, 4)));

        /// <summary>Copy `count` elements of T starting at byte offset `o`.</summary>
        public static T[] Section<T>(byte[] b, int o, int count) where T : struct
        {
            int size = Marshal.SizeOf<T>();
            if (o < 0 || o + count * size > b.Length)
            {
                throw new InvalidDataException($"section at {o} of {count} x {size} bytes runs past {b.Length}");
            }
            return MemoryMarshal.Cast<byte, T>(b.AsSpan(o, count * size)).ToArray();
        }

        /// <summary>Bytes as the HTTP stack would hand them to the browser decoders: gzip is inflated, anything else passes through.</summary>
        public static byte[] Gunzip(byte[] raw)
        {
            if (raw.Length >= 2 && raw[0] == 0x1F && raw[1] == 0x8B)
            {
                using (var input = new MemoryStream(raw))
                using (var gz = new GZipStream(input, CompressionMode.Decompress))
                using (var output = new MemoryStream())
                {
                    gz.CopyTo(output);
                    return output.ToArray();
                }
            }
            return raw;
        }

        /// <summary>
        /// Inflate a zlib (RFC 1950) stream. netstandard2.1 has no ZLibStream, so
        /// skip the 2-byte header and run the raw deflate body; the trailing
        /// Adler-32 is ignored, as the browser path never checked it either.
        /// </summary>
        public static byte[] Unzlib(byte[] raw)
        {
            if (raw.Length < 2 || (raw[0] & 0x0F) != 8 || ((raw[0] << 8) | raw[1]) % 31 != 0)
            {
                throw new InvalidDataException("not a zlib stream");
            }
            if ((raw[1] & 0x20) != 0)
            {
                throw new InvalidDataException("zlib preset dictionaries are not supported");
            }
            using (var input = new MemoryStream(raw, 2, raw.Length - 2))
            using (var deflate = new DeflateStream(input, CompressionMode.Decompress))
            using (var output = new MemoryStream())
            {
                deflate.CopyTo(output);
                return output.ToArray();
            }
        }

        public static void Magic(byte[] b, uint expected, string format)
        {
            if (b.Length < 4 || U32(b, 0) != expected)
            {
                throw new InvalidDataException($"Bad {format} magic");
            }
        }
    }
}
