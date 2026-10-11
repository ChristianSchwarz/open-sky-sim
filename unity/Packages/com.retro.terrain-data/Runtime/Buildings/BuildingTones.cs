using System;
using System.Collections.Generic;

namespace Retro.Terrain
{
    /// <summary>
    /// The palette indices PBH1 stores per roof and per wall (buildingTones.ts
    /// BuildingTone). Append only: the indices are baked into the sidecars.
    /// </summary>
    public enum BuildingTone
    {
        WallPlaster = 0,
        WallBrick = 1,
        WallWood = 2,
        WallConcrete = 3,
        WallMetal = 4,
        RoofTileRed = 5,
        RoofTileBrown = 6,
        RoofSlate = 7,
        RoofGrey = 8,
        RoofMetal = 9,
        RoofCopper = 10,
        RoofGlass = 11,
        RoofWhite = 12,
    }

    /// <summary>
    /// The colour table buildings are drawn from (buildingTones.ts), as the
    /// web game's material sees it: one entry per BuildingTone, sRGB hex from
    /// the three HD palettes (config/palettes/hd-*.ts). Each of these palette
    /// entries is a single colour, so the shade (uVertexToneShade) equals the
    /// colour (uVertexTone).
    /// </summary>
    public static class BuildingTones
    {
        /// <summary>The material's tone table size (shadedVP.ts VERTEX_TONE_COUNT); entries past the list repeat entry 0.</summary>
        public const int VertexToneCount = 16;

        /// <summary>BUILDING_TONES: the PaletteCategory of each tone.</summary>
        public static readonly IReadOnlyList<string> PaletteCategories = new[]
        {
            "SCENERY_WALL_PLASTER",
            "SCENERY_WALL_BRICK",
            "SCENERY_WALL_WOOD",
            "SCENERY_BUILDING_CONCRETE",
            "SCENERY_BUILDING_METAL",
            "SCENERY_ROOF_TILE_RED",
            "SCENERY_ROOF_TILE_BROWN",
            "SCENERY_ROOF_SLATE",
            "SCENERY_ROOF_GREY",
            "SCENERY_ROOF_METAL",
            "SCENERY_ROOF_COPPER",
            "SCENERY_ROOF_GLASS",
            "SCENERY_ROOF_WHITE",
        };

        /// <summary>hd-noon.ts, 0xRRGGBB sRGB, by tone.</summary>
        public static readonly IReadOnlyList<int> Noon = new[]
        {
            0xe2dccd, 0xa0604a, 0x7c5c3e, 0xa8a8a8, 0xcccccc,
            0xb65a40, 0x7e4c38, 0x4c4f56, 0x8e8e8a, 0xa8b0b4, 0x5e9e86, 0xb8d2d6, 0xdcdcd6,
        };

        /// <summary>hd-midnight.ts, 0xRRGGBB sRGB, by tone.</summary>
        public static readonly IReadOnlyList<int> Midnight = new[]
        {
            0x3e3c38, 0x301c16, 0x261c14, 0x404040, 0x282828,
            0x341a14, 0x261812, 0x18191c, 0x2c2c2a, 0x323638, 0x1c3028, 0x363e40, 0x404040,
        };

        /// <summary>hd-nightvision.ts, 0xRRGGBB sRGB, by tone.</summary>
        public static readonly IReadOnlyList<int> NightVision = new[]
        {
            0x848484, 0x5e5e5e, 0x545454, 0x626262, 0x6c6c6c,
            0x626262, 0x525252, 0x404040, 0x6a6a6a, 0x767676, 0x626262, 0x7c7c7c, 0x8a8a8a,
        };

        /// <summary>ROOF_TONES: the tones a roof may take.</summary>
        public static readonly IReadOnlyList<BuildingTone> RoofTones = new[]
        {
            BuildingTone.RoofTileRed, BuildingTone.RoofTileBrown, BuildingTone.RoofSlate, BuildingTone.RoofGrey,
            BuildingTone.RoofMetal, BuildingTone.RoofCopper, BuildingTone.RoofGlass, BuildingTone.RoofWhite,
        };

        /// <summary>WALL_TONES: the tones a wall may take.</summary>
        public static readonly IReadOnlyList<BuildingTone> WallTones = new[]
        {
            BuildingTone.WallPlaster, BuildingTone.WallBrick, BuildingTone.WallWood, BuildingTone.WallConcrete,
            BuildingTone.WallMetal, BuildingTone.RoofWhite,
        };

        /// <summary>noonRgb: a tone's noon colour as 0-255 sRGB.</summary>
        public static (int R, int G, int B) NoonRgb(BuildingTone tone)
        {
            int n = Noon[(int)tone];
            return ((n >> 16) & 255, (n >> 8) & 255, n & 255);
        }

        /// <summary>
        /// nearestTone: the tone among `candidates` whose noon colour is nearest
        /// to 0xRRGGBB by the "redmean" weighted RGB distance. Bake-side in the
        /// web game; here for tools and for snapping measured colours.
        /// </summary>
        public static BuildingTone NearestTone(int rgb, IReadOnlyList<BuildingTone> candidates)
        {
            int r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
            BuildingTone best = candidates[0];
            double bestD = double.PositiveInfinity;
            foreach (BuildingTone tone in candidates)
            {
                var (tr, tg, tb) = NoonRgb(tone);
                double rm = (r + tr) / 2.0;
                double d = (2 + rm / 256) * Math.Pow(r - tr, 2) + 4 * Math.Pow(g - tg, 2) + (2 + (255 - rm) / 256) * Math.Pow(b - tb, 2);
                if (d < bestD)
                {
                    bestD = d;
                    best = tone;
                }
            }
            return best;
        }
    }
}
