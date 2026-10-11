using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// player.ts AircraftDeviceState, under a cockpit-local name until the HUD
    /// port's copy and this one are merged.
    /// </summary>
    public enum CockpitDeviceState
    {
        Retracting,
        Retracted,
        Extending,
        Extended,
    }

    /// <summary>
    /// weaponsTarget.ts WeaponsTarget, the fields the cockpit reads. One
    /// instance per designatable thing; the cockpit tells the designated one
    /// apart by reference (<see cref="CockpitInputs.Target"/> is one of
    /// <see cref="CockpitInputs.Contacts"/>, as in the TS).
    /// </summary>
    public sealed class CockpitTarget
    {
        /// <summary>World/display position (scene metres) used for range, bearing and the target camera.</summary>
        public Vec3d Position;
        /// <summary>Offset from Position to the visual centre (metres); the target camera looks there.</summary>
        public Vec3d LocalCenter;
        /// <summary>Largest visible extent (m); drives the target-camera zoom factor.</summary>
        public double MaxSize;
        /// <summary>Type label, first line of MFD2.</summary>
        public string TargetType = "";
        /// <summary>Location / status label.</summary>
        public string TargetLocation = "";
        /// <summary>Airborne enemy (diamond blip, telemetry) or fixed ground installation (square blip).</summary>
        public bool Airborne;
        /// <summary>Airspeed (m/s); null shows 0. Airborne only.</summary>
        public double? SpeedMps;
        /// <summary>Load factor (g); null shows 1.</summary>
        public double? LoadFactorG;
        /// <summary>Remaining hull [0, 1]; null shows 1.</summary>
        public double? HealthFraction;
        /// <summary>Raw stick pitch [-1, 1] (clamped when drawn); null is 0.</summary>
        public double? StickPitch;
        /// <summary>Raw stick roll [-1, 1]; null is 0.</summary>
        public double? StickRoll;
        /// <summary>Throttle lever [0, 1]; null is 0.</summary>
        public double? Throttle;
        /// <summary>AI manoeuvre label (e.g. "PURSUE"); null falls back to TargetLocation.</summary>
        public string Maneuver;
    }

    /// <summary>The palette colours the cockpit paints with, as CSS "#rrggbb" strings.</summary>
    public sealed class CockpitColors
    {
        /// <summary>PaletteCategory.HUD_TEXT.</summary>
        public string HudText;
        /// <summary>PaletteCategory.HUD_TEXT_SECONDARY.</summary>
        public string HudTextSecondary;
        /// <summary>PaletteCategory.HUD_TEXT_WARN.</summary>
        public string HudTextWarn;
        /// <summary>PaletteCategory.COCKPIT_AI_SKY.</summary>
        public string AiSky;
        /// <summary>PaletteCategory.COCKPIT_AI_GROUND.</summary>
        public string AiGround;
        /// <summary>PaletteCategory.COCKPIT_MFD_BACKGROUND.</summary>
        public string MfdBackground;
        /// <summary>PaletteCategory.TERRAIN_WATER (the moving map's no-data colour).</summary>
        public string TerrainWater;

        /// <summary>PaletteColor(palette, category) for each: the first entry.</summary>
        public static CockpitColors FromPalette(Palette p) => new CockpitColors
        {
            HudText = p.Color(PaletteCategory.HUD_TEXT),
            HudTextSecondary = p.Color(PaletteCategory.HUD_TEXT_SECONDARY),
            HudTextWarn = p.Color(PaletteCategory.HUD_TEXT_WARN),
            AiSky = p.Color(PaletteCategory.COCKPIT_AI_SKY),
            AiGround = p.Color(PaletteCategory.COCKPIT_AI_GROUND),
            MfdBackground = p.Color(PaletteCategory.COCKPIT_MFD_BACKGROUND),
            TerrainWater = p.Color(PaletteCategory.TERRAIN_WATER),
        };
    }

    /// <summary>
    /// Everything cockpit.ts render2D reads from the game, as one snapshot.
    /// Scene frame: metres, +X east, +Y up, -Z north (z grows south).
    /// </summary>
    public sealed class CockpitInputs
    {
        /// <summary>PlayerEntity.getDisplayPosition(): the interpolated (drawn) aircraft position.</summary>
        public Vec3d DisplayPosition;
        /// <summary>PlayerEntity.getDisplayQuaternion(): body to world (three.js convention: nose body +Z, up +Y, utils/math.ts RIGHT +X).</summary>
        public Quatd DisplayQuaternion = Quatd.Identity;

        public CockpitDeviceState LandingGear = CockpitDeviceState.Retracted;
        public CockpitDeviceState Flaps = CockpitDeviceState.Retracted;
        public CockpitDeviceState Airbrakes = CockpitDeviceState.Retracted;
        public CockpitDeviceState Tailhook = CockpitDeviceState.Retracted;
        public bool WheelBrakesApplied;
        /// <summary>PlayerEntity.barricadeStatus: the carrier barricade line, or null off the boat.</summary>
        public string BarricadeStatus;

        /// <summary>PlayerEntity.weaponsTarget: the designated target, or null.</summary>
        public CockpitTarget Target;
        /// <summary>
        /// PlayerEntity.collectWeaponsTargets(): the designatable targets in
        /// cycling order. The TS rescans this list every
        /// <see cref="CockpitRenderer.TacticalScanInterval"/> seconds (positions
        /// are read every frame); the frontend may do the same or pass it fresh.
        /// </summary>
        public IReadOnlyList<CockpitTarget> Contacts = new CockpitTarget[0];

        /// <summary>The main (player) camera; its Fov (vertical, degrees) and Aspect (width / height) set the target-camera zoom.</summary>
        public CameraPose MainCamera = new CameraPose(50, 16.0 / 9.0, 2, 550000);

        public CockpitColors Colors;
    }

    /// <summary>An MFD's square on the overlay canvas: top-left pixel and edge (pixels, y down).</summary>
    public struct CockpitViewport
    {
        public double X;
        public double Y;
        public double Size;
    }

    /// <summary>What a cockpit frame produced besides its paint.</summary>
    public sealed class CockpitFrame
    {
        /// <summary>MFD1, the tactical scope (and the moving map under it).</summary>
        public CockpitViewport Mfd1;
        /// <summary>
        /// MFD2, the target display. With a target designated the cockpit
        /// clears this square on the overlay (painter.Clear) and the game's
        /// target-camera render shows through it.
        /// </summary>
        public CockpitViewport Mfd2;
        /// <summary>The posed target camera (<see cref="CockpitRenderer.TargetCameraPose"/>) when a target is designated; null otherwise (no target render).</summary>
        public CameraPose TargetCamera;
        /// <summary>The target-camera zoom (a power of two, 0 without a target): its FOV is 50 / zoom degrees.</summary>
        public double TargetZoomFactor;
        /// <summary>The moving map was painted this frame.</summary>
        public bool MovingMapDrawn;
        /// <summary>Scope range in Km (the ladder step holding the lock, 20 with no lock).</summary>
        public double ScopeRangeKm;
        /// <summary>Aircraft heading in whole degrees (vectorHeading of the display forward).</summary>
        public double HeadingDeg;
    }
}
