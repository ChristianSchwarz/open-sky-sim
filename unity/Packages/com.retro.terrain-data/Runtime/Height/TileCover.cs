using System.Collections.Generic;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>The cover of one drawn facet: its class, its imagery colour (0xRRGGBB, sRGB) and the zoom it was read at (tileHeightIndex.ts TileCover).</summary>
    public readonly struct TileCover
    {
        public readonly int Cls;
        public readonly int Rgb;
        public readonly double Zoom;

        public TileCover(int cls, int rgb, double zoom)
        {
            Cls = cls;
            Rgb = rgb;
            Zoom = zoom;
        }
    }

    public static class TileCovers
    {
        private static double EdgeSign(double px, double pz, double ax, double az, double bx, double bz) =>
            (px - bx) * (az - bz) - (ax - bx) * (pz - bz);

        private static bool PointInTriangle(double x, double z, double ax, double az, double bx, double bz, double cx, double cz)
        {
            double d1 = EdgeSign(x, z, ax, az, bx, bz);
            double d2 = EdgeSign(x, z, bx, bz, cx, cz);
            double d3 = EdgeSign(x, z, cx, cz, ax, az);
            bool hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
            bool hasPos = d1 > 0 || d2 > 0 || d3 > 0;
            return !(hasNeg && hasPos);
        }

        /// <summary>
        /// finestCover.ts coverInPtmTile: the first land facet holding a point
        /// given in the tile's quantisation units (x, z), or null.
        /// </summary>
        public static TileCover? CoverInPtmTile(PtmTile tile, double localX, double localZ, double zoom)
        {
            short[] pos = tile.LandPositions;
            byte[] attrs = tile.LandAttrs;
            int triCount = attrs.Length / 4 / 3;
            for (int t = 0; t < triCount; t++)
            {
                int v0 = t * 3, v1 = v0 + 1, v2 = v0 + 2;
                if (PointInTriangle(localX, localZ,
                        pos[v0 * 3], pos[v0 * 3 + 2], pos[v1 * 3], pos[v1 * 3 + 2], pos[v2 * 3], pos[v2 * 3 + 2]))
                {
                    int a = v0 * 4;
                    return new TileCover(attrs[a + 3], (attrs[a] << 16) | (attrs[a + 1] << 8) | attrs[a + 2], zoom);
                }
            }
            return null;
        }

        /// <summary>
        /// airfieldModel.ts combineCover: the plain average colour of whichever
        /// samples resolved, the first one's class, the worst zoom; null when none did.
        /// </summary>
        public static TileCover? Combine(IEnumerable<TileCover?> covers)
        {
            int r = 0, g = 0, b = 0, n = 0, cls = 0;
            double zoom = double.PositiveInfinity;
            foreach (TileCover? c in covers)
            {
                if (c == null) continue;
                TileCover v = c.Value;
                if (n == 0) cls = v.Cls;
                r += (v.Rgb >> 16) & 0xff;
                g += (v.Rgb >> 8) & 0xff;
                b += v.Rgb & 0xff;
                zoom = System.Math.Min(zoom, v.Zoom);
                n++;
            }
            if (n == 0) return null;
            int rgb = ((int)JsMath.Round((double)r / n) << 16) | ((int)JsMath.Round((double)g / n) << 8) | (int)JsMath.Round((double)b / n);
            return new TileCover(cls, rgb, zoom);
        }
    }
}
