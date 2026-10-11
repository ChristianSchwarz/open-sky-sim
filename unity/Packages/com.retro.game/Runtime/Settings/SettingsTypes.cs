using System;
using System.Collections.Generic;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>gameDefs.ts TechProfiles: the rendering profiles, by id. Only HD exists.</summary>
    public static class TechProfiles
    {
        public const string HD = "HD";

        public static readonly IReadOnlyList<string> All = new[] { HD };
    }

    /// <summary>gameDefs.ts FlightModels: the player's flight model. Stored and keyed by name.</summary>
    public enum FlightModels
    {
        FM2,
        FM3,
        DEBUG,
    }

    /// <summary>gameDefs.ts UnitSystems.</summary>
    public enum UnitSystems
    {
        METRIC,
        IMPERIAL,
    }

    /// <summary>gameDefs.ts TerrainColours: how baked terrain cover turns into colour on screen.</summary>
    public enum TerrainColours
    {
        /// <summary>Landcover class picks a palette tone. The most retro of the four.</summary>
        LANDCOVER,
        /// <summary>Satellite colour, snapped to the small colour table the bake derived.</summary>
        SWATCH,
        /// <summary>Palette tone for the hue, satellite luminance for a banded shade.</summary>
        HYBRID,
        /// <summary>The satellite colour itself.</summary>
        IMAGERY,
    }

    /// <summary>gameDefs.ts TerrainShading: flat per-facet colour, or smooth interpolation across it.</summary>
    public enum TerrainShading
    {
        FACETED,
        SMOOTH,
    }

    /// <summary>
    /// settingsStorage.ts SpawnMode: the spawn menu's start modes, stored by
    /// their TS names (see <see cref="SettingsCodec.Name(SpawnMode)"/>).
    /// </summary>
    public enum SpawnMode
    {
        Approach,
        Runway,
        Headon,
        Carrier,
        CarrierBarricade,
        CarrierTakeoff,
        HighAlt,
        Space,
        CloseWing,
    }

    /// <summary>
    /// The strings the web game stores and compares for each settings enum
    /// (the TS enum values), and back. Parsing is exact: case and spelling
    /// must match, as the TS Set lookups require.
    /// </summary>
    public static class SettingsCodec
    {
        private static readonly string[] SpawnModeNames =
        {
            "approach", "runway", "headon", "carrier", "carrierBarricade", "carrierTakeoff", "highAlt", "space", "closeWing",
        };

        private static readonly string[] RoadsNames = { "OFF", "MAJOR", "ALL" };

        /// <summary>settingsStorage.ts SPAWN_MODES, in its order.</summary>
        public static IReadOnlyList<string> SpawnModes => SpawnModeNames;

        public static string Name(SpawnMode mode) => SpawnModeNames[(int)mode];
        public static string Name(RoadsMode mode) => RoadsNames[(int)mode];
        public static string Name(FlightModels model) => model.ToString();
        public static string Name(UnitSystems system) => system.ToString();
        public static string Name(TerrainColours mode) => mode.ToString();
        public static string Name(TerrainShading mode) => mode.ToString();
        public static string Name(AiPilotModels model) => model.ToString();

        public static bool TryParse(string s, out SpawnMode mode) => TryIndex(SpawnModeNames, s, out mode);
        public static bool TryParse(string s, out RoadsMode mode) => TryIndex(RoadsNames, s, out mode);
        public static bool TryParse(string s, out FlightModels model) => TryEnum(s, out model);
        public static bool TryParse(string s, out UnitSystems system) => TryEnum(s, out system);
        public static bool TryParse(string s, out TerrainColours mode) => TryEnum(s, out mode);
        public static bool TryParse(string s, out TerrainShading mode) => TryEnum(s, out mode);
        public static bool TryParse(string s, out AiPilotModels model) => TryEnum(s, out model);

        /// <summary>KeyboardControlLayoutId as stored: its numeric value, 0..4.</summary>
        public static bool IsKeyboardLayout(double value) =>
            value == Math.Floor(value) && value >= 0 && value <= (int)KeyboardControlLayoutId.ARROWS;

        /// <summary>KeyboardPitchStickMode as stored: its numeric value, 0..1.</summary>
        public static bool IsPitchStickMode(double value) =>
            value == Math.Floor(value) && value >= 0 && value <= (int)KeyboardPitchStickMode.HOLD;

        private static bool TryIndex<T>(string[] names, string s, out T value) where T : struct, Enum
        {
            int i = s == null ? -1 : Array.IndexOf(names, s);
            value = i >= 0 ? (T)Enum.ToObject(typeof(T), i) : default;
            return i >= 0;
        }

        private static bool TryEnum<T>(string s, out T value) where T : struct, Enum
        {
            foreach (T v in (T[])Enum.GetValues(typeof(T)))
            {
                if (v.ToString() == s)
                {
                    value = v;
                    return true;
                }
            }
            value = default;
            return false;
        }
    }

    /// <summary>
    /// Change listeners with the semantics of the TS settings' `Set` of
    /// listeners: called in the order added, a second add of the same listener
    /// is ignored, one added during a notify is called in that same notify, one
    /// removed during it (and not yet called) is not, and one removed and added
    /// again moves to the end. Listeners compare with delegate equality.
    /// </summary>
    public sealed class ListenerSet<TDelegate> where TDelegate : Delegate
    {
        private readonly List<TDelegate> items = new List<TDelegate>();
        private int depth;

        public int Count
        {
            get
            {
                int n = 0;
                foreach (TDelegate d in items) if (d != null) n++;
                return n;
            }
        }

        public void Add(TDelegate listener)
        {
            if (listener == null) throw new ArgumentNullException(nameof(listener));
            if (IndexOf(listener) >= 0) return;
            items.Add(listener);
        }

        public void Remove(TDelegate listener)
        {
            int i = IndexOf(listener);
            if (i < 0) return;
            if (depth > 0) items[i] = null;
            else items.RemoveAt(i);
        }

        /// <summary>Calls <paramref name="call"/> on every listener, as iterating the TS Set does.</summary>
        public void ForEach(Action<TDelegate> call)
        {
            depth++;
            try
            {
                for (int i = 0; i < items.Count; i++)
                {
                    TDelegate d = items[i];
                    if (d != null) call(d);
                }
            }
            finally
            {
                depth--;
                if (depth == 0) items.RemoveAll(d => d == null);
            }
        }

        private int IndexOf(TDelegate listener)
        {
            for (int i = 0; i < items.Count; i++)
            {
                if (items[i] != null && items[i].Equals(listener)) return i;
            }
            return -1;
        }
    }
}
