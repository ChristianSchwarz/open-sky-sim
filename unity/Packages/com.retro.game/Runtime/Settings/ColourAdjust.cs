using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>colourAdjust.ts COLOUR_ADJUST_GROUPS, in display order; stored by <see cref="ColourAdjust.Key"/>.</summary>
    public enum ColourAdjustGroup
    {
        Trees,
        Terrain,
        Water,
        Sky,
    }

    /// <summary>colourAdjust.ts ColourTweak's three channels; stored by <see cref="ColourAdjust.Key(ColourChannel)"/>.</summary>
    public enum ColourChannel
    {
        Hue,
        Saturation,
        Brightness,
    }

    /// <summary>colourAdjust.ts ColourTweak: one scenery group's hue (degrees), saturation and brightness.</summary>
    public readonly struct ColourTweak : IEquatable<ColourTweak>
    {
        /// <summary>Degrees around the colour wheel, -180..180; 0 is as authored.</summary>
        public readonly double Hue;
        /// <summary>0..2; 1 is as authored, 0 grey.</summary>
        public readonly double Saturation;
        /// <summary>0..2; 1 is as authored.</summary>
        public readonly double Brightness;

        public ColourTweak(double hue, double saturation, double brightness)
        {
            Hue = hue;
            Saturation = saturation;
            Brightness = brightness;
        }

        /// <summary>colourAdjust.ts defaultColourTweak: hue 0, saturation 1, brightness 1.</summary>
        public static ColourTweak Default => new ColourTweak(0, 1, 1);

        public double this[ColourChannel channel] =>
            channel == ColourChannel.Hue ? Hue : channel == ColourChannel.Saturation ? Saturation : Brightness;

        public ColourTweak With(ColourChannel channel, double value) => channel switch
        {
            ColourChannel.Hue => new ColourTweak(value, Saturation, Brightness),
            ColourChannel.Saturation => new ColourTweak(Hue, value, Brightness),
            _ => new ColourTweak(Hue, Saturation, value),
        };

        /// <summary>The TS `===` on every channel (so NaN never equals).</summary>
        public bool Equals(ColourTweak other) =>
            Hue == other.Hue && Saturation == other.Saturation && Brightness == other.Brightness;

        public override bool Equals(object obj) => obj is ColourTweak t && Equals(t);
        public override int GetHashCode() => (Hue, Saturation, Brightness).GetHashCode();
        public override string ToString() => $"{{hue {Hue}, saturation {Saturation}, brightness {Brightness}}}";
    }

    /// <summary>
    /// colourAdjust.ts ColourAdjust: the player's hue, saturation and
    /// brightness per kind of scenery (trees, terrain, water, sky), applied
    /// after the palette, imagery and time of day have had their say. A value
    /// type in effect: every change makes a new one.
    /// </summary>
    public sealed class ColourAdjust : IEquatable<ColourAdjust>
    {
        /// <summary>Saturation and brightness range; 1 is as authored.</summary>
        public const double TweakMin = 0;
        public const double TweakMax = 2;
        public const double HueMaxDeg = 180;

        public static readonly IReadOnlyList<ColourAdjustGroup> Groups =
            new[] { ColourAdjustGroup.Trees, ColourAdjustGroup.Terrain, ColourAdjustGroup.Water, ColourAdjustGroup.Sky };

        public static readonly IReadOnlyList<ColourChannel> Channels =
            new[] { ColourChannel.Hue, ColourChannel.Saturation, ColourChannel.Brightness };

        private readonly ColourTweak[] tweaks;

        public ColourAdjust(ColourTweak trees, ColourTweak terrain, ColourTweak water, ColourTweak sky)
        {
            tweaks = new[] { trees, terrain, water, sky };
        }

        public ColourTweak Trees => tweaks[0];
        public ColourTweak Terrain => tweaks[1];
        public ColourTweak Water => tweaks[2];
        public ColourTweak Sky => tweaks[3];

        public ColourTweak this[ColourAdjustGroup group] => tweaks[(int)group];

        /// <summary>colourAdjust.ts defaultColourAdjust: every group as authored.</summary>
        public static ColourAdjust Default =>
            new ColourAdjust(ColourTweak.Default, ColourTweak.Default, ColourTweak.Default, ColourTweak.Default);

        /// <summary>A copy with one group replaced (not clamped).</summary>
        public ColourAdjust With(ColourAdjustGroup group, ColourTweak tweak)
        {
            var t = (ColourTweak[])tweaks.Clone();
            t[(int)group] = tweak;
            return new ColourAdjust(t[0], t[1], t[2], t[3]);
        }

        /// <summary>The key a group is stored under: trees, terrain, water, sky.</summary>
        public static string Key(ColourAdjustGroup group) => group switch
        {
            ColourAdjustGroup.Trees => "trees",
            ColourAdjustGroup.Terrain => "terrain",
            ColourAdjustGroup.Water => "water",
            _ => "sky",
        };

        /// <summary>The key a channel is stored under: hue, saturation, brightness.</summary>
        public static string Key(ColourChannel channel) => channel switch
        {
            ColourChannel.Hue => "hue",
            ColourChannel.Saturation => "saturation",
            _ => "brightness",
        };

        /// <summary>
        /// colourAdjust.ts clampColourAdjust on a typed value: every channel
        /// clamped into its range, a non-finite one back to as authored.
        /// </summary>
        public static ColourAdjust Clamp(ColourAdjust value)
        {
            if (value == null) return Default;
            var t = new ColourTweak[4];
            for (int g = 0; g < 4; g++)
            {
                ColourTweak tw = value.tweaks[g];
                t[g] = new ColourTweak(
                    ClampTo(tw.Hue, -HueMaxDeg, HueMaxDeg, 0),
                    ClampTo(tw.Saturation, TweakMin, TweakMax, 1),
                    ClampTo(tw.Brightness, TweakMin, TweakMax, 1));
            }
            return new ColourAdjust(t[0], t[1], t[2], t[3]);
        }

        /// <summary>
        /// colourAdjust.ts clampColourAdjust on anything stored: a missing or
        /// unusable group or channel is as authored, the rest clamped.
        /// </summary>
        public static ColourAdjust Clamp(JsonValue value)
        {
            var t = new[] { ColourTweak.Default, ColourTweak.Default, ColourTweak.Default, ColourTweak.Default };
            if (value != null && value.Kind == JsonKind.Object)
            {
                for (int g = 0; g < 4; g++)
                {
                    JsonValue tweak = value[Key((ColourAdjustGroup)g)];
                    // typeof 'object' && not null: arrays count, and read no channels.
                    if (tweak.Kind == JsonKind.Object || tweak.Kind == JsonKind.Array)
                    {
                        t[g] = new ColourTweak(
                            ClampTo(tweak["hue"], -HueMaxDeg, HueMaxDeg, 0),
                            ClampTo(tweak["saturation"], TweakMin, TweakMax, 1),
                            ClampTo(tweak["brightness"], TweakMin, TweakMax, 1));
                    }
                }
            }
            return new ColourAdjust(t[0], t[1], t[2], t[3]);
        }

        private static double ClampTo(JsonValue v, double min, double max, double fallback) =>
            v.Kind == JsonKind.Number ? ClampTo(v.AsNumber, min, max, fallback) : fallback;

        private static double ClampTo(double v, double min, double max, double fallback)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return fallback;
            return Math.Min(max, Math.Max(min, v));
        }

        /// <summary>Writes the object JSON.stringify writes: groups then channels, in TS key order.</summary>
        public void WriteJson(JsJsonWriter w)
        {
            w.BeginObject();
            foreach (ColourAdjustGroup g in Groups)
            {
                ColourTweak t = this[g];
                w.Key(Key(g)).BeginObject()
                    .Key("hue").Number(t.Hue)
                    .Key("saturation").Number(t.Saturation)
                    .Key("brightness").Number(t.Brightness)
                    .EndObject();
            }
            w.EndObject();
        }

        public bool Equals(ColourAdjust other)
        {
            if (other == null) return false;
            for (int g = 0; g < 4; g++) if (!tweaks[g].Equals(other.tweaks[g])) return false;
            return true;
        }

        public override bool Equals(object obj) => obj is ColourAdjust a && Equals(a);
        public override int GetHashCode() => (tweaks[0], tweaks[1], tweaks[2], tweaks[3]).GetHashCode();
    }
}
