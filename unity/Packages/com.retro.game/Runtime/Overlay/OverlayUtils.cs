using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>gameDefs.ts UnitSystems: what the HUD and the overlays show altitude and speed in.</summary>
    public enum UnitSystem
    {
        /// <summary>Metres, km/h, m/s.</summary>
        Metric,
        /// <summary>Feet, knots, ft/min.</summary>
        Imperial,
    }

    /// <summary>gameDefs.ts HUDFocusMode: how much of the HUD's tape clutter is shown.</summary>
    public enum HudFocusMode
    {
        /// <summary>Full tapes for altitude, heading and airspeed, plus stall bar and VVI.</summary>
        Disabled = 0,
        /// <summary>Boxed altitude and airspeed readouts; heading tape kept.</summary>
        Partial = 1,
        /// <summary>Boxed altitude, airspeed and heading readouts.</summary>
        Full = 2,
    }

    /// <summary>player.ts AircraftDeviceState (gear, flaps, airbrakes, hook).</summary>
    public enum AircraftDeviceState
    {
        Retracting = 0,
        Retracted = 1,
        Extending = 2,
        Extended = 3,
    }

    /// <summary>overlayUtils.ts OverlayLayout: how the overlays scale with the canvas.</summary>
    public readonly struct OverlayLayout
    {
        /// <summary>Tick/marker density: 1 = low (up to ~1.5x H_RES wide), 2 = normal.</summary>
        public readonly double DetailScale;
        /// <summary>Uniform visual zoom for HUD elements (at least DetailScale).</summary>
        public readonly double LayoutScale;

        public OverlayLayout(double detailScale, double layoutScale)
        {
            DetailScale = detailScale;
            LayoutScale = layoutScale;
        }
    }

    /// <summary>
    /// The aircraft devices the bottom-left GEAR / FLAPS / AIRBRK / HOOK / BRAKE
    /// stack shows (PlayerEntity.landingGear etc.); drawn by the cockpit beside
    /// the map MFD through <see cref="OverlayUtils.RenderAircraftDeviceStatus"/>.
    /// </summary>
    public sealed class AircraftDeviceStatus
    {
        public AircraftDeviceState LandingGear = AircraftDeviceState.Retracted;
        public AircraftDeviceState Flaps = AircraftDeviceState.Retracted;
        public AircraftDeviceState Airbrakes = AircraftDeviceState.Retracted;
        public AircraftDeviceState Tailhook = AircraftDeviceState.Retracted;
        public bool WheelBrakesApplied;
        /// <summary>The ship's barricade status label, or null while the net is stowed.</summary>
        public string BarricadeStatus;
    }

    /// <summary>
    /// Port of scene/entities/overlay/overlayUtils.ts: overlay layout scales,
    /// heading formatting, unit conversions and the device-status stack.
    /// </summary>
    public static class OverlayUtils
    {
        /// <summary>defs.ts H_RES / V_RES: the logical (retro) canvas the overlays were drawn for.</summary>
        public const double HRes = 320, VRes = 200;

        /// <summary>AIRCRAFT_DEVICE_STATUS_OUTWARD_GAP: gap between the map MFD edge and the device labels.</summary>
        private const double AircraftDeviceStatusOutwardGap = 50;

        public static OverlayLayout GetOverlayLayout(double targetWidth, double targetHeight)
        {
            double detailScale = Math.Min(2, Math.Max(1, JsMath.Round(targetWidth / HRes)));
            double layoutScale = Math.Max(detailScale, Math.Min(targetWidth / HRes, targetHeight / VRes));
            return new OverlayLayout(detailScale, layoutScale);
        }

        public static double GetOverlayTickStep(OverlayLayout layout) => 2 * layout.LayoutScale / layout.DetailScale;

        public static double GetOverlayLogicalHeight(OverlayLayout layout) => VRes * layout.LayoutScale;

        /// <summary>The painter line width the renderer sets before the overlays draw.</summary>
        public static double GetOverlayStrokeWidth(OverlayLayout layout)
        {
            double geomScale = layout.LayoutScale / layout.DetailScale;
            return Math.Max(1, Math.Ceiling(geomScale / 2));
        }

        /// <summary>Three digits, wrapped into [0, 360): 5 -> "005", -1 -> "359".</summary>
        public static string FormatHeading(double n)
        {
            string s = "00" + JsText.ToFixed(((n % 360) + 360) % 360, 0);
            return s.Substring(s.Length - 3);
        }

        public static double ToFeet(double meters) => meters * 3.28084;

        public static double ToKnots(double metersPerSecond) => metersPerSecond * 1.94384;

        /// <summary>Top-left of the device stack's bottom line, beside a map MFD of mfdSize pixels.</summary>
        public static (double X, double Y) GetAircraftDeviceStatusPosition(double targetHeight, double mfdSize, HudFont font) =>
            (mfdSize + font.CharSpacing + 2 + AircraftDeviceStatusOutwardGap,
                targetHeight - font.CharHeight - font.CharSpacing);

        /// <summary>
        /// The bottom-left GEAR / FLAPS / AIRBRK / HOOK / BRAKE stack (plus the
        /// ship's barricade), drawn upwards from bottomY. Devices count while
        /// extending as well as extended.
        /// </summary>
        public static void RenderAircraftDeviceStatus(
            AircraftDeviceStatus status, double x, double bottomY, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double lineStep = font.CharHeight + font.CharSpacing;
            var labels = new List<string>(6);
            if (Shown(status.LandingGear)) labels.Add("GEAR");
            if (Shown(status.Flaps)) labels.Add("FLAPS");
            if (Shown(status.Airbrakes)) labels.Add("AIRBRK");
            if (Shown(status.Tailhook)) labels.Add("HOOK");
            if (status.WheelBrakesApplied) labels.Add("BRAKE");
            if (status.BarricadeStatus != null) labels.Add(status.BarricadeStatus);
            for (int i = 0; i < labels.Count; i++)
            {
                painter.Text(font, x, bottomY - i * lineStep, labels[i], hudColor);
            }
        }

        private static bool Shown(AircraftDeviceState s) => s == AircraftDeviceState.Extended || s == AircraftDeviceState.Extending;

        /// <summary>
        /// What renderer.ts render2D sets on the overlay painter before any
        /// entity draws: the text effect (palette HUD_TEXT_EFFECT colour) and
        /// the layout's stroke width.
        /// </summary>
        public static void BeginOverlayFrame(ICanvasPainter painter, double targetWidth, double targetHeight, TextEffect textEffect, Palette palette)
        {
            painter.SetTextEffect(textEffect, palette.Color(PaletteCategory.HUD_TEXT_EFFECT));
            painter.SetLineWidth(GetOverlayStrokeWidth(GetOverlayLayout(targetWidth, targetHeight)));
        }
    }
}
