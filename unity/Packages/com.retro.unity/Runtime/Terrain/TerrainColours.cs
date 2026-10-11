using UnityEngine;

namespace Retro.Unity
{
    /// <summary>The four land colour modes (tones.ts TerrainColourMode).</summary>
    public enum TerrainColourMode
    {
        Landcover = 0,
        Swatch = 1,
        Hybrid = 2,
        Imagery = 3,
    }

    /// <summary>
    /// Inputs of the land colour decision (terrainCover.ts facetColor):
    /// palette tone per land tone (noon palette), tone per cover class, the
    /// bake's swatch table and luminance window, and the Hybrid shading
    /// constants. Pushed to the land material as shader arrays.
    /// </summary>
    public static class TerrainColours
    {
        /// <summary>LAND_TONE_BASE: tones 0 and 1 are the two waters.</summary>
        public const int LandToneBase = 2;
        public const int LandToneCount = 9;
        public const int ClassCount = 16;
        public const int SwatchCount = 24;
        /// <summary>terrainEntity.ts HYBRID_SHADE_STEPS / HYBRID_SHADE_RANGE.</summary>
        public const float HybridShadeSteps = 5;
        public const float HybridShadeRange = 0.35f;
        /// <summary>hd-noon.ts TERRAIN_WATER / TERRAIN_SHALLOW_WATER (sRGB; Unity linearises colour properties).</summary>
        public const string WaterHex = "#16355e";
        public const string ShallowWaterHex = "#153c6a";
        /// <summary>tones.ts LANDUSE_BLEND_DEFAULT.</summary>
        public const float LanduseBlendDefault = 0.5f;

        /// <summary>hd-noon.ts TERRAIN_* colours for Sand, Grass, Bare, Forest, Scrub, Crop, Urban, Snow, Wetland.</summary>
        private static readonly string[] NoonToneHex =
        {
            "#b09a63", "#4a7a52", "#7d5f45", "#2f6b3c", "#6a7742", "#7f8f3c", "#7d7a76", "#d8dde2", "#3f7357",
        };

        /// <summary>CLASS_TO_TONE, as a land tone index (tone - LAND_TONE_BASE). Classes 14 and 15 default to Grass.</summary>
        private static readonly float[] ClassTone =
        {
            1, // Unknown -> Grass
            3, // Tree -> Forest
            4, // Shrub -> Scrub
            1, // Grass -> Grass
            5, // Crop -> Crop
            6, // Built -> Urban
            2, // Bare -> Bare
            7, // Snow -> Snow
            1, // Water -> Grass
            8, // Wetland -> Wetland
            8, // Mangrove -> Wetland
            2, // Moss -> Bare
            0, // Sand -> Sand
            1, // Ground -> Grass (Ground keeps its sampled colour in the shader)
            1,
            1,
        };

        public static Color FromHex(string hex)
        {
            ColorUtility.TryParseHtmlString(hex, out Color c);
            return c;
        }

        /// <summary>
        /// Configure land drawing from the manifest's swatches and luminance window.
        /// The values go in the draws' property block, not the material: none of
        /// them is a declared shader property, and Unity drops undeclared material
        /// values whenever it reloads the shader (an asset import in the editor
        /// is enough), which left the land black mid-flight.
        /// </summary>
        public static void Apply(MaterialPropertyBlock m, TerrainColourMode mode, float landuseBlend, string[] swatchesHex, float shadeMid, float shadeSpread)
        {
            var tones = new Vector4[LandToneCount];
            for (int i = 0; i < LandToneCount; i++)
            {
                // Palette colours are authored sRGB and used linear (THREE.Color does the same decode).
                Color linear = FromHex(NoonToneHex[i]).linear;
                tones[i] = new Vector4(linear.r, linear.g, linear.b, 1);
            }
            var swatches = new Vector4[SwatchCount];
            int count = swatchesHex == null ? 0 : Mathf.Min(swatchesHex.Length, SwatchCount);
            for (int i = 0; i < count; i++)
            {
                // Swatches stay sRGB: the bake matched in sRGB, so the shader does too.
                Color s = FromHex(swatchesHex[i]);
                swatches[i] = new Vector4(s.r, s.g, s.b, 1);
            }
            m.SetVectorArray("_ToneColor", tones);
            m.SetFloatArray("_ClassTone", ClassTone);
            m.SetVectorArray("_Swatch", swatches);
            m.SetFloat("_SwatchCount", count);
            m.SetFloat("_TerrainMode", (int)mode);
            m.SetFloat("_ShadeSteps", HybridShadeSteps);
            m.SetFloat("_ShadeRange", HybridShadeRange);
            m.SetVector("_ShadeWindow", new Vector4(shadeMid, shadeSpread, 0, 0));
            m.SetVector("_RawLight", Vector4.one);
            m.SetFloat("_LanduseBlend", landuseBlend);
        }
    }
}
