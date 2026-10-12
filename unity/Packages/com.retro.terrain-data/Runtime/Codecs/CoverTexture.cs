using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>A tile's lon/lat grid in the bake frame's axes (coverTextures.ts CoverFrame).</summary>
    public struct CoverFrame
    {
        /// <summary>Local east at the tile centre, scaled so dot(raw position, East) is the lon fraction from the centre.</summary>
        public Vec3d East;
        /// <summary>Same for north and the lat fraction.</summary>
        public Vec3d North;
        /// <summary>The lon span's shrink toward the pole, per lat fraction.</summary>
        public double K;
    }

    /// <summary>
    /// The far-tile cover textures' CPU side (coverTextures.ts): where a tile's texels lie
    /// relative to its quantised positions, and the texture's mip chain.
    /// </summary>
    public static class CoverTexture
    {
        /// <summary>LEAF_COVER_FROM_M: how far from the camera a leaf's own texture replaces its facets.</summary>
        public const double LeafCoverFromM = 3000;

        /// <summary>
        /// coverFrame: positions are quantised offsets from the tile centre in the bake frame's ENU
        /// axes (x = e, y = u, z = -n). East and north at the centre are stepped along and turned
        /// into directions there, scaled by quantScale over the tile's width or height; k is the
        /// south edge's width over the north edge's, so u = 0.5 + e / (1 - k n).
        /// </summary>
        public static CoverFrame Frame(TileKey id, EnuBasis basis, double quantScale)
        {
            LonLatBounds b = Tiling.Bounds(id);
            double lat0 = (b.South + b.North) / 2;
            double lon0 = (b.West + b.East) / 2;
            Vec3d At(double lat, double lon)
            {
                Enu enu = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, 0));
                return new Vec3d(enu.E, enu.U, -enu.N);
            }
            Vec3d centre = At(lat0, lon0);
            const double stepDeg = 1e-3;
            Vec3d east = (At(lat0, lon0 + stepDeg) - centre).Normalized();
            Vec3d north = (At(lat0 + stepDeg, lon0) - centre).Normalized();
            double WidthAt(double lat) => Vec3d.Distance(At(lat, b.East), At(lat, b.West));
            double width = WidthAt(lat0);
            double height = Vec3d.Distance(At(b.North, lon0), At(b.South, lon0));
            double k = (WidthAt(b.South) - WidthAt(b.North)) / width;
            return new CoverFrame { East = east * (quantScale / width), North = north * (quantScale / height), K = k };
        }

        /// <summary>
        /// buildCoverMips: level 0 and every half below it to 1x1. Colour is the mean of a block's
        /// data texels, the class the first data texel's in row order (a class averaged is
        /// garbage); a block without data stays no-data.
        /// </summary>
        public static List<byte[]> Mips(byte[] texels, int size)
        {
            var levels = new List<byte[]> { texels };
            byte[] src = texels;
            int n = size;
            while (n > 1)
            {
                int half = n >> 1;
                var dst = new byte[half * half * 4];
                for (int y = 0; y < half; y++)
                {
                    for (int x = 0; x < half; x++)
                    {
                        int count = 0, r = 0, g = 0, bl = 0;
                        byte cls = PtxCodec.NoData;
                        for (int dy = 0; dy < 2; dy++)
                        {
                            for (int dx = 0; dx < 2; dx++)
                            {
                                int o = ((y * 2 + dy) * n + (x * 2 + dx)) * 4;
                                byte c = src[o + 3];
                                if (c == PtxCodec.NoData) continue;
                                if (count == 0) cls = c;
                                r += src[o];
                                g += src[o + 1];
                                bl += src[o + 2];
                                count++;
                            }
                        }
                        int d = (y * half + x) * 4;
                        if (count > 0)
                        {
                            dst[d] = (byte)JsMath.Round((double)r / count);
                            dst[d + 1] = (byte)JsMath.Round((double)g / count);
                            dst[d + 2] = (byte)JsMath.Round((double)bl / count);
                        }
                        dst[d + 3] = cls;
                    }
                }
                levels.Add(dst);
                src = dst;
                n = half;
            }
            return levels;
        }
    }
}
