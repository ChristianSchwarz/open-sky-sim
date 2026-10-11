using System;
using System.Collections.Generic;
using Retro.Sim;
using Retro.Terrain;

namespace Retro.Game
{
    /// <summary>
    /// One live setting (configService.ts's per-setting classes): the active
    /// value and its change listeners. <see cref="SetActive"/> clamps the
    /// value the way the TS setting does, does nothing when the clamped value
    /// equals the active one, and otherwise notifies every listener.
    /// </summary>
    public class Setting<T>
    {
        private readonly Func<T, T> clamp;
        private readonly ListenerSet<Action<T>> listeners = new ListenerSet<Action<T>>();
        protected T active;

        protected Setting(T initial, Func<T, T> clamp = null)
        {
            this.clamp = clamp;
            active = Clamp(initial);
        }

        public T Active => active;

        public T GetActive() => active;

        public virtual void SetActive(T value)
        {
            T clamped = Clamp(value);
            if (Same(clamped, active)) return;
            active = clamped;
            NotifyActive();
        }

        /// <summary>Push the current value to listeners (used once after they register).</summary>
        public void NotifyActive()
        {
            T value = active;
            listeners.ForEach(l => l(value));
        }

        public void AddChangeListener(Action<T> listener) => listeners.Add(listener);

        public void RemoveChangeListener(Action<T> listener) => listeners.Remove(listener);

        protected T Clamp(T value) => clamp != null ? clamp(value) : value;

        /// <summary>The TS `===`: for doubles, NaN never equals (and 0 equals -0).</summary>
        private static bool Same(T a, T b)
        {
            if (a is double x && b is double y) return x == y;
            return EqualityComparer<T>.Default.Equals(a, b);
        }
    }

    /// <summary>
    /// configService.ts DaytimeSetting: local solar time of day in hours,
    /// 0..24 with 24 wrapping to 0; drives the sun, the sky/terrain palette and
    /// the planform silhouettes. Non-finite is the default 14:00.
    /// </summary>
    public sealed class DaytimeSetting : Setting<double>
    {
        public DaytimeSetting(double initial = SunClock.DefaultSunHours) : base(initial, ClampDaytime) { }

        /// <summary>configService.ts clampDaytime: ((h % 24) + 24) % 24.</summary>
        public static double ClampDaytime(double hours)
        {
            if (double.IsNaN(hours) || double.IsInfinity(hours)) return SunClock.DefaultSunHours;
            return ((hours % 24) + 24) % 24;
        }
    }

    /// <summary>
    /// configService.ts TerrainDetailSetting: metres out to which terrain keeps
    /// full detail; <see cref="Lod.DetailDistanceOff"/> (+Infinity) is no falloff.
    /// Clamped by <see cref="Lod.ClampDetailDistanceM"/>: 2000 m up, and 40 km or
    /// more (or non-finite) is off.
    /// </summary>
    public sealed class TerrainDetailSetting : Setting<double>
    {
        public TerrainDetailSetting(double initial = Lod.TerrainDetailDistanceDefaultM) : base(initial, Lod.ClampDetailDistanceM) { }
    }

    /// <summary>configService.ts LanduseReachSetting: leaf refine distance multiplier, 1..10 (default 1.5).</summary>
    public sealed class LanduseReachSetting : Setting<double>
    {
        public LanduseReachSetting(double initial = Lod.LeafRefineDistanceScale) : base(initial, Lod.ClampLeafRefineScale) { }
    }

    /// <summary>configService.ts VisibleZoomSetting: deepest terrain zoom drawn, an integer 5..12 (default 12, no cap).</summary>
    public sealed class VisibleZoomSetting : Setting<double>
    {
        public VisibleZoomSetting(double initial = Lod.TerrainVisibleZoomMax) : base(initial, ClampVisibleZoom) { }

        /// <summary>lod.ts clampVisibleZoom: Math.round into 5..12; non-finite is 12.</summary>
        public static double ClampVisibleZoom(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return Lod.TerrainVisibleZoomMax;
            return Math.Min(Lod.TerrainVisibleZoomMax, Math.Max(Lod.TerrainVisibleZoomMin, Retro.Core.JsMath.Round(value)));
        }
    }

    /// <summary>configService.ts LanduseRevealSetting: on-screen width (px) a land-use region needs to be drawn, 1..24 (default 6).</summary>
    public sealed class LanduseRevealSetting : Setting<double>
    {
        public LanduseRevealSetting(double initial = Lod.LanduseRevealMinPx) : base(initial, Lod.ClampLanduseRevealPx) { }
    }

    /// <summary>configService.ts TriangleBudgetSetting: terrain triangles per frame, rounded, 200K..4M (default 600K).</summary>
    public sealed class TriangleBudgetSetting : Setting<double>
    {
        public TriangleBudgetSetting(double initial = Lod.TerrainTriangleBudget) : base(initial, Lod.ClampTriangleBudget) { }
    }

    /// <summary>configService.ts LanduseBlendSetting: share of a land-use facet's colour from its palette tone, 0..1 (default 0.5).</summary>
    public sealed class LanduseBlendSetting : Setting<double>
    {
        public const double Default = 0.5;

        public LanduseBlendSetting(double initial = Default) : base(initial, ClampLanduseBlend) { }

        /// <summary>tones.ts clampLanduseBlend: into 0..1; non-finite is the default.</summary>
        public static double ClampLanduseBlend(double value)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return Default;
            return Math.Min(1, Math.Max(0, value));
        }
    }

    /// <summary>configService.ts TreeDensitySetting: tree density multiplier, 0..20 (1 = baked spacing, 0 = no trees).</summary>
    public sealed class TreeDensitySetting : Setting<double>
    {
        public TreeDensitySetting(double initial = TreeBillboards.DensityMultiplierDefault) : base(initial, TreeBillboards.ClampDensityMultiplier) { }
    }

    /// <summary>
    /// configService.ts RenderScaleSetting: fraction of the screen the 3D view
    /// is drawn at, one of <see cref="RenderScales"/>; 1 is off. Anything else
    /// is ignored (and an invalid initial value is 1).
    /// </summary>
    public sealed class RenderScaleSetting : Setting<double>
    {
        /// <summary>configService.ts RENDER_SCALES, in the dialog's order.</summary>
        public static readonly IReadOnlyList<double> RenderScales = new[] { 1, 0.9, 0.8, 0.7, 0.6, 0.5 };

        public RenderScaleSetting(double initial = 1) : base(IsRenderScale(initial) ? initial : 1) { }

        public static bool IsRenderScale(double value)
        {
            foreach (double s in RenderScales) if (s == value) return true;
            return false;
        }

        public override void SetActive(double value)
        {
            if (!IsRenderScale(value)) return;
            base.SetActive(value);
        }
    }

    /// <summary>configService.ts SupersamplingSetting: SSAA where the resolution affords it (default off).</summary>
    public sealed class SupersamplingSetting : Setting<bool>
    {
        public SupersamplingSetting(bool initial = false) : base(initial) { }
    }

    /// <summary>configService.ts FarTileTexturesSetting: paint far tiles with the leaf cover texture (default on).</summary>
    public sealed class FarTileTexturesSetting : Setting<bool>
    {
        public FarTileTexturesSetting(bool initial = true) : base(initial) { }
    }

    /// <summary>configService.ts BuildingsSetting: draw the baked OSM buildings (default on).</summary>
    public sealed class BuildingsSetting : Setting<bool>
    {
        public BuildingsSetting(bool initial = true) : base(initial) { }
    }

    /// <summary>configService.ts RoadsSetting: which baked roads are drawn (default all).</summary>
    public sealed class RoadsSetting : Setting<RoadsMode>
    {
        public RoadsSetting(RoadsMode initial = RoadsMode.All) : base(initial) { }
    }

    /// <summary>configService.ts UnitSystemSetting: always starts metric; never stored.</summary>
    public sealed class UnitSystemSetting : Setting<UnitSystems>
    {
        public UnitSystemSetting() : base(UnitSystems.METRIC) { }
    }

    /// <summary>configService.ts AiPilotModelSetting (default CLASSIC); applies on the next opponent spawn.</summary>
    public sealed class AiPilotModelSetting : Setting<AiPilotModels>
    {
        public AiPilotModelSetting(AiPilotModels initial = AiPilotModels.CLASSIC) : base(initial) { }
    }

    /// <summary>configService.ts TerrainColourSetting (default HYBRID): a uniform write, nothing re-streams.</summary>
    public sealed class TerrainColourSetting : Setting<TerrainColours>
    {
        public TerrainColourSetting(TerrainColours initial = TerrainColours.HYBRID) : base(initial) { }
    }

    /// <summary>configService.ts TerrainShadingSetting (default FACETED): SMOOTH swaps the land mesh per tile.</summary>
    public sealed class TerrainShadingSetting : Setting<TerrainShading>
    {
        public TerrainShadingSetting(TerrainShading initial = TerrainShading.FACETED) : base(initial) { }
    }

    /// <summary>
    /// configService.ts ColourAdjustSetting: hue, saturation and brightness per
    /// scenery group. Changed only through <see cref="SetTweak"/>, which clamps
    /// and notifies only when that group's numbers changed.
    /// </summary>
    public sealed class ColourAdjustSetting
    {
        private readonly ListenerSet<Action<ColourAdjust>> listeners = new ListenerSet<Action<ColourAdjust>>();
        private ColourAdjust active;

        public ColourAdjustSetting(ColourAdjust initial = null)
        {
            active = ColourAdjust.Clamp(initial);
        }

        public ColourAdjust Active => active;

        public ColourAdjust GetActive() => active;

        public void SetTweak(ColourAdjustGroup group, ColourTweak tweak)
        {
            ColourAdjust next = ColourAdjust.Clamp(active.With(group, tweak));
            if (next[group].Equals(active[group])) return;
            active = next;
            NotifyActive();
        }

        public void NotifyActive()
        {
            ColourAdjust value = active;
            listeners.ForEach(l => l(value));
        }

        public void AddChangeListener(Action<ColourAdjust> listener) => listeners.Add(listener);

        public void RemoveChangeListener(Action<ColourAdjust> listener) => listeners.Remove(listener);
    }

    /// <summary>A <see cref="ConfigSet"/> change: the new active id, and the one before (equal on notifyActive).</summary>
    public delegate void ConfigSetChangeListener(string newId, string oldId);

    /// <summary>
    /// configService.ts ConfigSet: one active id out of a fixed, ordered set
    /// (tech profiles, flight models). The TS set also maps each id to its
    /// object (a TechProfile, a FlightModel); here the host keeps that map and
    /// the set carries only ids. An unknown initial id falls back to the first;
    /// setting an unknown id throws, as the TS assert does.
    /// </summary>
    public sealed class ConfigSet
    {
        private readonly List<string> ids;
        private readonly ListenerSet<ConfigSetChangeListener> listeners = new ListenerSet<ConfigSetChangeListener>();
        private string active;

        public ConfigSet(IEnumerable<string> ids, string initialActive = null)
        {
            this.ids = new List<string>(ids);
            if (this.ids.Count == 0) throw new ArgumentException("a config set needs at least one entry", nameof(ids));
            active = initialActive != null && this.ids.Contains(initialActive) ? initialActive : this.ids[0];
        }

        public IReadOnlyList<string> Ids => ids;

        public string ActiveKey => active;

        public string GetActiveKey() => active;

        public void SetActive(string id)
        {
            if (id == active) return;
            if (!ids.Contains(id)) throw new ArgumentException($"unknown id {id}", nameof(id));
            string oldId = active;
            active = id;
            listeners.ForEach(l => l(id, oldId));
        }

        /// <summary>Apply the current active item to listeners (used once after listeners are registered).</summary>
        public void NotifyActive()
        {
            string id = active;
            listeners.ForEach(l => l(id, id));
        }

        public void AddChangeListener(ConfigSetChangeListener listener) => listeners.Add(listener);

        public void RemoveChangeListener(ConfigSetChangeListener listener) => listeners.Remove(listener);
    }

    /// <summary>
    /// configService.ts ConfigService: every live setting the game reads and
    /// listens to. Built from the stored settings with <see cref="FromSettings"/>
    /// (as index.ts does); the setting classes clamp whatever they are given.
    /// </summary>
    public sealed class ConfigService
    {
        public readonly ConfigSet TechProfiles;
        public readonly ConfigSet FlightModels;
        public readonly UnitSystemSetting UnitSystem;
        public readonly AiPilotModelSetting AiPilotModels;
        public readonly TerrainColourSetting TerrainColour;
        public readonly TerrainShadingSetting TerrainShading;
        public readonly LanduseBlendSetting LanduseBlend;
        public readonly TreeDensitySetting TreeDensity;
        public readonly TerrainDetailSetting TerrainDetail;
        public readonly LanduseReachSetting LanduseReach;
        public readonly VisibleZoomSetting VisibleZoom;
        public readonly LanduseRevealSetting LanduseReveal;
        public readonly TriangleBudgetSetting TriangleBudget;
        public readonly FarTileTexturesSetting FarTileTextures;
        public readonly BuildingsSetting Buildings;
        public readonly RoadsSetting Roads;
        public readonly RenderScaleSetting RenderScale;
        public readonly SupersamplingSetting Supersampling;
        public readonly DaytimeSetting Daytime;
        public readonly ColourAdjustSetting ColourAdjust;

        /// <summary>The TS constructor, argument for argument; null is "not given" (the setting's default).</summary>
        public ConfigService(
            IEnumerable<string> techProfiles,
            IEnumerable<string> flightModels,
            string initialTechProfile = null,
            string initialFlightModel = null,
            AiPilotModels? initialAiPilotModel = null,
            double? initialDaytime = null,
            TerrainColours? initialTerrainColour = null,
            double? initialTerrainDetailM = null,
            TerrainShading? initialTerrainShading = null,
            double? initialLanduseBlend = null,
            double? initialLanduseReach = null,
            double? initialTriangleBudget = null,
            double? initialLanduseRevealPx = null,
            bool? initialFarTileTextures = null,
            double? initialRenderScale = null,
            bool? initialSupersampling = null,
            RoadsMode? initialRoads = null,
            double? initialTreeDensity = null,
            double? initialVisibleZoom = null,
            ColourAdjust initialColourAdjust = null,
            bool? initialBuildings = null)
        {
            TechProfiles = new ConfigSet(techProfiles, initialTechProfile);
            FlightModels = new ConfigSet(flightModels, initialFlightModel);
            UnitSystem = new UnitSystemSetting();
            AiPilotModels = new AiPilotModelSetting(initialAiPilotModel ?? Retro.Sim.AiPilotModels.CLASSIC);
            TerrainColour = new TerrainColourSetting(initialTerrainColour ?? TerrainColours.HYBRID);
            TerrainShading = new TerrainShadingSetting(initialTerrainShading ?? Retro.Game.TerrainShading.FACETED);
            LanduseBlend = new LanduseBlendSetting(initialLanduseBlend ?? LanduseBlendSetting.Default);
            TerrainDetail = new TerrainDetailSetting(initialTerrainDetailM ?? Lod.TerrainDetailDistanceDefaultM);
            LanduseReach = new LanduseReachSetting(initialLanduseReach ?? Lod.LeafRefineDistanceScale);
            VisibleZoom = new VisibleZoomSetting(initialVisibleZoom ?? Lod.TerrainVisibleZoomMax);
            LanduseReveal = new LanduseRevealSetting(initialLanduseRevealPx ?? Lod.LanduseRevealMinPx);
            TriangleBudget = new TriangleBudgetSetting(initialTriangleBudget ?? Lod.TerrainTriangleBudget);
            FarTileTextures = new FarTileTexturesSetting(initialFarTileTextures ?? true);
            Buildings = new BuildingsSetting(initialBuildings ?? true);
            Roads = new RoadsSetting(initialRoads ?? RoadsMode.All);
            RenderScale = new RenderScaleSetting(initialRenderScale ?? 1);
            Supersampling = new SupersamplingSetting(initialSupersampling ?? false);
            TreeDensity = new TreeDensitySetting(initialTreeDensity ?? TreeBillboards.DensityMultiplierDefault);
            Daytime = new DaytimeSetting(initialDaytime ?? SunClock.DefaultSunHours);
            ColourAdjust = new ColourAdjustSetting(initialColourAdjust);
        }

        /// <summary>The flight model ids index.ts registers, in its order.</summary>
        public static readonly IReadOnlyList<string> FlightModelIds = new[] { "FM2", "FM3", "DEBUG" };

        /// <summary>
        /// index.ts setup: the live settings from the stored ones, with a null
        /// terrain detail distance meaning off (+Infinity).
        /// </summary>
        public static ConfigService FromSettings(AppSettings s) => new ConfigService(
            Retro.Game.TechProfiles.All,
            FlightModelIds,
            s.TechProfile,
            s.FlightModel,
            s.AiPilotModel,
            s.Daytime,
            s.TerrainColour,
            s.TerrainDetailDistanceM ?? Lod.DetailDistanceOff,
            s.TerrainShading,
            s.LanduseBlend,
            s.LanduseReach,
            s.TerrainTriangleBudget,
            s.LanduseRevealPx,
            s.FarTileTextures,
            s.RenderScale,
            s.Supersampling,
            s.Roads,
            s.TreeDensity,
            s.VisibleZoom,
            s.ColourAdjust,
            s.Buildings);
    }
}
