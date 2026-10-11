using System;

namespace Retro.Game
{
    /// <summary>
    /// The exterior-view readout (port of scene/entities/overlay/exteriorData.ts,
    /// ExteriorDataEntity): heading, speed and altitude along the bottom of the
    /// screen and the weapons target's type and location above them. Shown
    /// instead of the HUD while the camera is outside the aircraft.
    /// Reads Units, Quaternion, Velocity, AltitudeM and Target from the inputs.
    /// </summary>
    public sealed class ExteriorData
    {
        private readonly DisplayUnits displayUnits = new DisplayUnits();

        public void Render2D(double targetWidth, double targetHeight, HudInputs input, Palette palette, ICanvasPainter painter)
        {
            displayUnits.System = input.Units;
            double altitude = displayUnits.AltitudeFromMeters(input.AltitudeM);
            double heading = HudMath.HeadingOf(input.Quaternion);
            double speed = displayUnits.SpeedFromMps(input.Velocity.Length);

            double layoutScale = OverlayUtils.GetOverlayLayout(targetWidth, targetHeight).LayoutScale;
            HudFont font = layoutScale > 1 ? HudFont.Large : HudFont.Small;
            string hudColor = palette.Color(PaletteCategory.HUD_TEXT);

            painter.SetColor(hudColor);

            double halfWidth = targetWidth / 2;
            double headingX = halfWidth - (font.CharWidth + font.CharSpacing) * 19;
            double airspeedX = halfWidth - (font.CharWidth + font.CharSpacing) * 5;
            double altitudeX = halfWidth + (font.CharWidth + font.CharSpacing) * 12;
            double navY = targetHeight - font.CharHeight * 2;

            double targetInfoX = halfWidth;
            double targetInfoY = navY - font.CharHeight * 2;

            painter.Text(font, altitudeX, navY,
                "ALT " + JsText.ToFixed(altitude, 0) + " " + displayUnits.AltitudeUnitLabel(), hudColor, TextAlignment.Left);
            painter.Text(font, headingX, navY, "Heading " + JsText.ToFixed(heading, 0), hudColor, TextAlignment.Left);
            painter.Text(font, airspeedX, navY,
                "SPD " + JsText.ToFixed(Math.Floor(speed), 0) + " " + displayUnits.SpeedUnitLabel(), hudColor, TextAlignment.Left);
            if (input.Target != null)
            {
                painter.Text(font, targetInfoX, targetInfoY,
                    input.Target.TargetType + " at " + input.Target.TargetLocation, hudColor, TextAlignment.Center);
            }
        }
    }
}
