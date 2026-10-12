using System;
using System.Collections.Generic;
using Retro.Game;
using UnityEngine;

namespace Retro.Unity
{
    /// <summary>
    /// The palette everything is drawn in this frame (the web game's current
    /// palette: noon, midnight or night vision, blended by the sun). Layers
    /// read their colours from here and re-read them whenever
    /// <see cref="Version"/> moves, so a day/night change reaches every
    /// material without each layer knowing about the sun.
    /// </summary>
    public static class ScenePalette
    {
        public static Palette Current { get; private set; } = Palettes.HdNoon;

        /// <summary>
        /// palette.ts Palette.light: the linear-light factor for colours the palette
        /// does not own (imagery, measured roofs, mod liveries); white at noon.
        /// </summary>
        public static Color RawLight { get; private set; } = Color.white;

        /// <summary>Bumped on every change.</summary>
        public static int Version { get; private set; } = 1;

        public static void Set(Palette palette, Color rawLight)
        {
            Current = palette;
            RawLight = rawLight;
            Version++;
            // Every bound material takes the new colours now; destroyed ones drop out.
            bindings.RemoveAll(b => b.Material == null);
            foreach (Binding b in bindings) b.Apply();
        }

        private sealed class Binding
        {
            public Material Material;
            public int Property;
            public Func<Color> Colour;
            public void Apply() => Material.SetColor(Property, Colour());
        }

        private static readonly List<Binding> bindings = new List<Binding>();

        /// <summary>
        /// Keep a material's colour property in the palette: set now and again on
        /// every <see cref="Set"/>. `colour` is evaluated against the current palette.
        /// </summary>
        public static void Bind(Material material, string property, Func<Color> colour)
        {
            var b = new Binding { Material = material, Property = Shader.PropertyToID(property), Colour = colour };
            b.Apply();
            bindings.Add(b);
        }

        /// <summary><see cref="Bind"/> to a palette category's base colour.</summary>
        public static void Bind(Material material, string property, PaletteCategory category) =>
            Bind(material, property, () => Tone(category));

        /// <summary>A category's base colour (sRGB; Unity linearises colour properties); water with the player's water sliders.</summary>
        public static Color Tone(PaletteCategory category) => Water(category, TerrainColours.FromHex(Current.Color(category)));

        /// <summary>
        /// The player's water hue, saturation and brightness (materials.ts setWaterTweak): water is a
        /// flat palette colour, so it is adjusted here rather than in a shader.
        /// </summary>
        public static ColourTweak WaterTweak { get; private set; } = ColourTweak.Default;

        public static void SetWaterTweak(ColourTweak tweak)
        {
            WaterTweak = tweak;
            Set(Current, RawLight);
        }

        private static Color Water(PaletteCategory category, Color srgb)
        {
            if (category != PaletteCategory.TERRAIN_WATER && category != PaletteCategory.TERRAIN_SHALLOW_WATER) return srgb;
            if (WaterTweak.Equals(ColourTweak.Default)) return srgb;
            Color c = srgb.linear;
            // colourAdjust.ts adjustColourInPlace: Rodrigues turn about the grey axis, then saturation and brightness.
            double a = WaterTweak.Hue * Math.PI / 180;
            double cos = Math.Cos(a), sin = Math.Sin(a);
            const double InvSqrt3 = 0.5773502691896258;
            double mean = (c.r + c.g + c.b) / 3.0 * (1 - cos);
            double hr = c.r * cos + (c.b - c.g) * InvSqrt3 * sin + mean;
            double hg = c.g * cos + (c.r - c.b) * InvSqrt3 * sin + mean;
            double hb = c.b * cos + (c.g - c.r) * InvSqrt3 * sin + mean;
            double l = 0.2126 * hr + 0.7152 * hg + 0.0722 * hb;
            float Channel(double v) => (float)(Math.Max(0, l + (v - l) * WaterTweak.Saturation) * WaterTweak.Brightness);
            return new Color(Channel(hr), Channel(hg), Channel(hb), srgb.a).gamma;
        }

        public static Color ToneShade(PaletteCategory category) => TerrainColours.FromHex(Current.ColorShade(category));

        /// <summary>
        /// A literal sRGB colour lit as the palette's own colours are: multiplied by
        /// <see cref="RawLight"/> in linear light, handed back sRGB for a colour property.
        /// </summary>
        public static Color Raw(Color srgb)
        {
            Color l = srgb.linear;
            return new Color(l.r * RawLight.r, l.g * RawLight.g, l.b * RawLight.b, srgb.a).gamma;
        }

        public static Color Raw(string hex) => Raw(TerrainColours.FromHex(hex));
    }
}
