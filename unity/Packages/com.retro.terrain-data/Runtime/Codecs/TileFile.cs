namespace Retro.Terrain
{
    /// <summary>Entry points that take file bytes as they sit on disk (gzip for most streams, zlib for .pdm).</summary>
    public static class TileFile
    {
        /// <summary>Gunzip if the bytes are gzip; the decoders take inflated bytes.</summary>
        public static byte[] Inflate(byte[] onDisk) => Bytes.Gunzip(onDisk);

        public static PtmTile Ptm(byte[] onDisk) => PtmCodec.Decode(Inflate(onDisk));
        public static PtxTile Ptx(byte[] onDisk) => PtxCodec.Decode(Inflate(onDisk));
        public static PtrTile Ptr(byte[] onDisk) => PtrCodec.Decode(Inflate(onDisk));
        public static PbrTile Pbr(byte[] onDisk) => PbrCodec.Decode(Inflate(onDisk));
        public static PbhTile Pbh(byte[] onDisk) => PbhCodec.Decode(Inflate(onDisk));
        public static PbdTile Pbd(byte[] onDisk) => PbdCodec.Decode(Inflate(onDisk));
        public static PflTile Pfl(byte[] onDisk) => PflCodec.Decode(Inflate(onDisk));
        public static DemTile Pdm(byte[] onDisk) => DemCodec.Decode(onDisk);
    }
}
