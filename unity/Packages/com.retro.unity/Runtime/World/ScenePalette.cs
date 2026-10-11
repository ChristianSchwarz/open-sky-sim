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

        /// <summary>A category's base colour (sRGB; Unity linearises colour properties).</summary>
        public static Color Tone(PaletteCategory category) => TerrainColours.FromHex(Current.Color(category));

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
