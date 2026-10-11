using System;
using System.Collections.Generic;

namespace Retro.Game
{
    /// <summary>
    /// The overlayUtils.ts helpers cockpit.ts uses, copied here so the cockpit
    /// port stands alone: getOverlayLayout (layoutScale only), formatHeading,
    /// getAircraftDeviceStatusPosition and renderAircraftDeviceStatus. The HUD
    /// port carries the same functions; merge the two when both land.
    /// </summary>
    public static class CockpitFormat
    {
        /// <summary>defs.ts H_RES / V_RES: the logical overlay resolution.</summary>
        public const double HRes = 320;
        public const double VRes = 200;

        /// <summary>overlayUtils.ts AIRCRAFT_DEVICE_STATUS_OUTWARD_GAP.</summary>
        private const double DeviceStatusOutwardGap = 50;

        /// <summary>getOverlayLayout(...).detailScale.</summary>
        public static double DetailScale(double targetWidth) =>
            Math.Min(2, Math.Max(1, Retro.Core.JsMath.Round(targetWidth / HRes)));

        /// <summary>getOverlayLayout(...).layoutScale.</summary>
        public static double LayoutScale(double targetWidth, double targetHeight) =>
            Math.Max(DetailScale(targetWidth), Math.Min(targetWidth / HRes, targetHeight / VRes));

        /// <summary>formatHeading: whole degrees in [0, 360), zero-padded to three digits.</summary>
        public static string FormatHeading(double n)
        {
            string s = "00" + JsText.ToFixed(((n % 360) + 360) % 360, 0);
            return s.Substring(s.Length - 3);
        }

        /// <summary>getAircraftDeviceStatusPosition: where the bottom line of the device stack goes.</summary>
        public static (double X, double Y) DeviceStatusPosition(double targetHeight, double mfdSize, HudFont font) =>
            (mfdSize + font.CharSpacing + 2 + DeviceStatusOutwardGap, targetHeight - font.CharHeight - font.CharSpacing);

        private static bool Out(CockpitDeviceState s) => s == CockpitDeviceState.Extended || s == CockpitDeviceState.Extending;

        /// <summary>renderAircraftDeviceStatus: the bottom-left GEAR / FLAPS / AIRBRK / HOOK / BRAKE / barricade stack, growing upwards.</summary>
        public static void RenderDeviceStatus(CockpitInputs a, double x, double bottomY, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double lineStep = font.CharHeight + font.CharSpacing;
            var labels = new List<string>();
            if (Out(a.LandingGear)) labels.Add("GEAR");
            if (Out(a.Flaps)) labels.Add("FLAPS");
            if (Out(a.Airbrakes)) labels.Add("AIRBRK");
            if (Out(a.Tailhook)) labels.Add("HOOK");
            if (a.WheelBrakesApplied) labels.Add("BRAKE");
            if (a.BarricadeStatus != null) labels.Add(a.BarricadeStatus);
            for (int i = 0; i < labels.Count; i++)
            {
                painter.Text(font, x, bottomY - i * lineStep, labels[i], hudColor);
            }
        }
    }
}
