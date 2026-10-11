using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// Port of src/script/config/palettes/daytimePalette.ts: builds the palette
    /// for a sun position by blending a profile's authored noon and midnight
    /// palettes in linear light at the sky model's nightMix, then multiplying
    /// each category by its sky slot's gain. Unlit categories (HUD*, COCKPIT*,
    /// LIGHT_*, FX*) switch between the two authored colours at nightMix 0.5.
    /// </summary>
    public static class DaytimePalette
    {
        private enum SkySlot { Horizon, Haze, Zenith, Cloud, Sun, Water, Ground }

        /// <summary>daytimePalette.ts LAND_TERRAIN_CATEGORIES: brighter and more saturated by day.</summary>
        public static readonly HashSet<PaletteCategory> LandTerrainCategories = new HashSet<PaletteCategory>
        {
            PaletteCategory.TERRAIN_DEFAULT,
            PaletteCategory.TERRAIN_SAND,
            PaletteCategory.TERRAIN_BARE,
            PaletteCategory.TERRAIN_GRASS,
            PaletteCategory.TERRAIN_FOREST,
            PaletteCategory.TERRAIN_SCRUB,
            PaletteCategory.TERRAIN_CROP,
            PaletteCategory.TERRAIN_URBAN,
            PaletteCategory.TERRAIN_SNOW,
            PaletteCategory.TERRAIN_WETLAND,
            PaletteCategory.SCENERY_MOUNTAIN_GRASS,
            PaletteCategory.SCENERY_MOUNTAIN_BARE,
        };

        public const double DaytimeTerrainBoost = 0.2;
        public const double DaytimeTerrainSaturationBoost = 0.1;
        /// <summary>Night mix at which the world flips to night models and the unlit colours switch.</summary>
        public const double NightModelsThreshold = 0.5;
        /// <summary>The category whose day-to-night travel stands for every lit surface (Palette.Light).</summary>
        public const PaletteCategory LitReference = PaletteCategory.VEHICLE_PLANE_GREY;

        private static readonly string[] UnlitPrefixes = { "HUD", "COCKPIT", "LIGHT_", "FX" };

        private static readonly Dictionary<PaletteCategory, SkySlot> SlotByCategory = new Dictionary<PaletteCategory, SkySlot>
        {
            [PaletteCategory.BACKGROUND] = SkySlot.Horizon,
            [PaletteCategory.FOG_SKY] = SkySlot.Horizon,
            [PaletteCategory.FOG_TERRAIN] = SkySlot.Haze,
            [PaletteCategory.FOG_LIGHT] = SkySlot.Horizon,
            [PaletteCategory.SKY] = SkySlot.Zenith,
            [PaletteCategory.GLASS] = SkySlot.Zenith,
            [PaletteCategory.SKY_CLOUD] = SkySlot.Cloud,
            [PaletteCategory.SKY_SUN] = SkySlot.Sun,
            [PaletteCategory.TERRAIN_WATER] = SkySlot.Water,
            [PaletteCategory.TERRAIN_SHALLOW_WATER] = SkySlot.Water,
        };

        private static readonly PaletteCategory[] AllCategories = (PaletteCategory[])Enum.GetValues(typeof(PaletteCategory));

        private static double[] GainForSlot(SkySample sky, SkySlot slot)
        {
            switch (slot)
            {
                case SkySlot.Horizon: return sky.Horizon;
                case SkySlot.Haze: return sky.Haze;
                case SkySlot.Zenith: return sky.Zenith;
                case SkySlot.Cloud: return sky.Cloud;
                case SkySlot.Sun: return sky.SunDisc;
                case SkySlot.Water: return sky.Water;
                default: return sky.Ground;
            }
        }

        /// <summary>True for the categories the sun neither tints nor darkens (by the TS string value's prefix).</summary>
        public static bool IsUnlit(PaletteCategory category)
        {
            string key = PaletteCategories.Key(category);
            foreach (string prefix in UnlitPrefixes)
            {
                if (key.StartsWith(prefix, StringComparison.Ordinal)) return true;
            }
            return false;
        }

        private static double[] Saturate(double[] rgb, double factor)
        {
            double l = SkyColor.Luma(rgb);
            return new[]
            {
                l + (rgb[0] - l) * factor,
                l + (rgb[1] - l) * factor,
                l + (rgb[2] - l) * factor,
            };
        }

        private static double[] Mix(double[] a, double[] b, double t) => new[]
        {
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
        };

        private static double[] LightFor(Palette day, Palette night, SkySample sky)
        {
            double dayLuma = SkyColor.Luma(SkyColor.LinearOf(day.Colors[LitReference][0]));
            double nightLuma = SkyColor.Luma(SkyColor.LinearOf(night.Colors[LitReference][0]));
            double level = dayLuma > 1e-6
                ? 1 + (nightLuma / dayLuma - 1) * sky.NightMix
                : 1;
            double[] gain = GainForSlot(sky, SkySlot.Ground);
            return new[] { gain[0] * level, gain[1] * level, gain[2] * level };
        }

        private static string BlendColor(string dayCss, string nightCss, double nightMix, double[] gain, double satBoost)
        {
            double[] b = Mix(SkyColor.LinearOf(dayCss), SkyColor.LinearOf(nightCss), nightMix);
            double[] lit = { b[0] * gain[0], b[1] * gain[1], b[2] * gain[2] };
            return SkyColor.ToHex(SkyColor.ToSrgb(satBoost == 1 ? lit : Saturate(lit, satBoost)));
        }

        /// <summary>
        /// daytimePalette.ts blendPalettes: the two authored palettes at
        /// sky.NightMix with the atmosphere's per-slot gains applied. Colours
        /// come out as lower-case "#rrggbb" (sRGB bytes); unlit categories keep
        /// the authored strings. Values (fog densities) are lerped; Time flips
        /// at nightMix 0.5; Light is set.
        /// </summary>
        public static Palette Blend(Palette day, Palette night, SkySample sky)
        {
            var colors = new Dictionary<PaletteCategory, string[]>();
            double nightMix = sky.NightMix;

            foreach (PaletteCategory category in AllCategories)
            {
                string[] dayEntry = day.Colors[category];
                string[] nightEntry = night.Colors[category];
                if (IsUnlit(category))
                {
                    colors[category] = nightMix < NightModelsThreshold ? dayEntry : nightEntry;
                    continue;
                }

                double[] gain = GainForSlot(sky, SlotByCategory.TryGetValue(category, out SkySlot slot) ? slot : SkySlot.Ground);
                double satBoost = 1;
                if (LandTerrainCategories.Contains(category))
                {
                    double boost = 1 + DaytimeTerrainBoost * (1 - nightMix);
                    gain = new[] { gain[0] * boost, gain[1] * boost, gain[2] * boost };
                    satBoost = 1 + DaytimeTerrainSaturationBoost * (1 - nightMix);
                }

                if (dayEntry.Length == 1 && nightEntry.Length == 1)
                {
                    colors[category] = new[] { BlendColor(dayEntry[0], nightEntry[0], nightMix, gain, satBoost) };
                }
                else
                {
                    string dayA = dayEntry[0], dayB = dayEntry.Length > 1 ? dayEntry[1] : dayEntry[0];
                    string nightA = nightEntry[0], nightB = nightEntry.Length > 1 ? nightEntry[1] : nightEntry[0];
                    colors[category] = new[]
                    {
                        BlendColor(dayA, nightA, nightMix, gain, satBoost),
                        BlendColor(dayB, nightB, nightMix, gain, satBoost),
                    };
                }
            }

            var values = new Dictionary<PaletteCategory, double>();
            foreach (KeyValuePair<PaletteCategory, double> kv in day.Values)
            {
                values[kv.Key] = kv.Value + (night.Values[kv.Key] - kv.Value) * nightMix;
            }

            return new Palette
            {
                Name = "daytime",
                Colors = colors,
                Values = values,
                Time = nightMix < NightModelsThreshold ? PaletteTime.Day : PaletteTime.Night,
                Light = LightFor(day, night, sky),
            };
        }

        /// <summary>
        /// materials.ts fog uniforms for a material of category c under palette
        /// p: fogColor = linear(PaletteColor(p, FogColorCategory(c))) and
        /// fogDensity = p.Values[FogValueCategory(c)].
        /// </summary>
        public static void FogFor(Palette p, PaletteCategory c, out double[] linearColor, out double density)
        {
            linearColor = SkyColor.LinearOf(p.Color(PaletteCategories.FogColorCategory(c)));
            density = p.Values[PaletteCategories.FogValueCategory(c)];
        }

        /// <summary>
        /// The fog weight every fogged web fragment program applies (reference
        /// for the URP shader, HD profile = unbanded):
        /// 0.92 * (1 - clamp(exp2(-density * dist), 0, 1)); colour = mix(base, fogColor, weight).
        /// </summary>
        public static double FogWeight(double density, double dist) =>
            0.92 * (1 - JsMath.Clamp(Math.Pow(2, -density * dist), 0, 1));

        /// <summary>daytimePalette.ts daytimePalette: the palette for a sun at elevationDeg (SunState.ElevationDeg).</summary>
        public static Palette ForElevation(Palette day, Palette night, double elevationDeg) =>
            Blend(day, night, SkyModel.SkyFor(elevationDeg));
    }
}
