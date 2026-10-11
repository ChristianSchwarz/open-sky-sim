using System;
using System.Globalization;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>
    /// The cockpit HUD (port of scene/entities/overlay/hud.ts, HUDEntity):
    /// pitch ladder, altitude / heading / airspeed tapes (or their boxed
    /// focus-mode readouts), throttle and AP labels, Mach/AoA/G, the AoA
    /// indexer, the stick / rudder / throttle / FCS indicator, the target box,
    /// the gun readout and pipper or (on an airfield / carrier target) the ILS
    /// needles with approach cues, the boresight cross, the flight path marker
    /// (with the E-bracket on approach), stall warning and bar, the vertical
    /// velocity bar, and the FPS / triangle readout.
    ///
    /// Everything airframe-fixed moves as one block with the boresight, so a
    /// padlocked view leaves the HUD where the nose is; the target box stays
    /// on the target in the view camera. Draws only through the painter.
    ///
    /// State kept between frames, as in the TS entity: the blink clock
    /// (Update), the FPS moving average (HudInputs.NowMs) and the last
    /// velocity direction (kept while the aircraft is stopped).
    /// </summary>
    public sealed class Hud
    {
        private const double AltitudeHeight = 32;
        private const double AltitudeHalfHeight = AltitudeHeight / 2;

        private const double HeadingWidth = 26;
        private const double HeadingHalfWidth = HeadingWidth / 2;
        private const double HeadingSpacing = 5;
        private const double HeadingStep = 5;

        private const double AirspeedHeight = 32;
        private const double AirspeedHalfHeight = AirspeedHeight / 2;

        private const double AoaStallDeg = 22;

        private const double LadderExtraMarkers = 2;
        private const double LadderHorizonHalfGap = 12;
        private const double LadderSize = 100;
        private const double LadderWidth = 164;
        private const double LadderHeight = 70;
        private const double LadderSizeHalf = 50; // Math.floor(LADDER_SIZE / 2)
        private const double LadderHalfWidth = 82;
        private const double LadderHalfHeight = 35;

        private const double TargetHalfWidth = 8;

        /// <summary>GUN_MUZZLE_VELOCITY_MPS: matches the player gun / combat sim.</summary>
        private const double GunMuzzleVelocityMps = 1000;

        /// <summary>defs.ts COCKPIT_FOV (deg): the ladder's pitch scale.</summary>
        public const double CockpitFov = 50;

        /// <summary>defs.ts PITCH_STICK_FWD_UNITS / PITCH_STICK_AFT_UNITS: stick travel split.</summary>
        public const double PitchStickFwdUnits = 20, PitchStickAftUnits = 80;

        private readonly DisplayUnits displayUnits = new DisplayUnits();

        private double heading;
        private double altitude;
        private double altitudeM;
        private double renderFps;
        private double speed;
        private double verticalSpeed;
        private Vec3d velocityDirection;
        private double machNumber;
        private double pitch;
        private double roll;
        private double elapsed;
        private double lastRenderTime;

        // The frame being drawn.
        private HudInputs actor;
        private HudTarget weaponsTarget;
        private ThreeCameraView camera;
        private ThreeCameraView noseCamera;

        /// <summary>HUDEntity.update: advances the STALL blink clock (seconds).</summary>
        public void Update(double delta)
        {
            elapsed += delta;
        }

        /// <summary>FCS_MODE_LABELS.</summary>
        private static string FcsModeLabel(int mode)
        {
            switch (mode)
            {
                case (int)FcsPitchLimiter.Soft: return "FCS1 SOFT";
                case (int)FcsPitchLimiter.Predictive: return "FCS2 PRED";
                case (int)FcsPitchLimiter.Smooth: return "FCS3 SMTH";
                default: return "";
            }
        }

        private static string Num(double x) => JsText.NumberToString(x);

        private void RefreshVisualState(HudInputs input)
        {
            double now = input.NowMs;
            if (lastRenderTime > 0)
            {
                double frameDtMs = now - lastRenderTime;
                double instantFps = 1000 / frameDtMs;
                renderFps = renderFps > 0 ? renderFps * 0.9 + instantFps * 0.1 : instantFps;
            }
            lastRenderTime = now;

            altitudeM = input.AltitudeM;
            altitude = JsMath.Round(displayUnits.AltitudeFromMeters(altitudeM) * 10) / 10;
            heading = HudMath.HeadingOf(input.Quaternion);
            (pitch, roll) = HudMath.PitchRoll(input.Quaternion);

            Vec3d vel = input.Velocity;
            speed = displayUnits.SpeedFromMps(vel.Length);
            verticalSpeed = displayUnits.VerticalSpeedFromMps(vel.Y);
            if (vel.LengthSquared > 1e-6)
            {
                velocityDirection = vel.Normalized();
            }
            machNumber = AeroUtils.MachNumber(vel.Length, altitudeM);
        }

        /// <summary>
        /// HUDEntity.render2D: draws one frame of the HUD on a canvas of
        /// targetWidth x targetHeight pixels.
        /// </summary>
        public void Render2D(double targetWidth, double targetHeight, HudInputs input, HudCamera view, Palette palette, ICanvasPainter painter)
        {
            actor = input;
            weaponsTarget = input.Target;
            displayUnits.System = input.Units;
            camera = new ThreeCameraView(view.Position, view.Quaternion, view.Projection);
            // projectOnHudGlass: the view camera turned to the nose (three.js cameras look down -Z).
            noseCamera = new ThreeCameraView(view.Position, input.Quaternion * Quatd.FromAxisAngle(HudMath.Up, Math.PI), view.Projection);

            RefreshVisualState(input);

            OverlayLayout layout = OverlayUtils.GetOverlayLayout(targetWidth, targetHeight);
            double detailScale = layout.DetailScale, layoutScale = layout.LayoutScale;
            double tickStep = OverlayUtils.GetOverlayTickStep(layout);

            HudFont font = layoutScale > 1 ? HudFont.Large : HudFont.Small;
            HudFont fontSmall = layoutScale > 1 ? HudFont.Medium : HudFont.Small;
            string hudColor = palette.Color(PaletteCategory.HUD_TEXT);
            string hudSecondaryColor = palette.Color(PaletteCategory.HUD_TEXT_SECONDARY);
            string hudWarnColor = palette.Color(PaletteCategory.HUD_TEXT_WARN);
            string hudLimitColor = palette.Color(PaletteCategory.LIGHT_RED);
            painter.SetColor(hudColor);

            double halfWidth = targetWidth / 2;
            double halfHeight = targetHeight / 2;
            var (hudX, hudY) = ProjectBoresight(halfWidth, halfHeight);
            double dx = hudX - halfWidth;
            double dy = hudY - halfHeight;
            double ladderSpread = layoutScale > 1 ? Math.Max(1.5, layoutScale / detailScale) : 1;

            double geomScale = layoutScale / detailScale;

            RenderTarget(targetWidth, targetHeight, halfWidth, halfHeight, painter, geomScale);

            RenderPitchLadder(layout, hudX, hudY, painter, hudColor, hudSecondaryColor, fontSmall);

            double altitudeX = hudX + Math.Ceiling((LadderHalfWidth + 6) * ladderSpread);
            double altitudeY = hudY;
            if (input.FocusMode == HudFocusMode.Disabled)
            {
                RenderAltitude(layout, tickStep, altitudeX, altitudeY, targetWidth, painter, hudColor, font, fontSmall);
            }
            else
            {
                RenderAltitudeFocusMode(altitudeX, altitudeY, painter, hudColor, font);
            }

            double headingX = hudX;
            double headingY = hudY - layoutScale * (LadderHalfHeight + 2);
            if (input.FocusMode != HudFocusMode.Full)
            {
                RenderHeading(layout, headingX, headingY, painter, hudColor, font);
            }
            else
            {
                RenderHeadingFocusMode(headingX, headingY, painter, hudColor, font);
            }

            double airSpeedX = hudX - Math.Floor((LadderHalfWidth + 6) * ladderSpread);
            double airSpeedY = hudY;
            if (input.FocusMode == HudFocusMode.Disabled)
            {
                RenderAirSpeed(layout, tickStep, airSpeedX, airSpeedY, painter, hudColor, font, fontSmall);
            }
            else
            {
                RenderAirSpeedFocusMode(airSpeedX, airSpeedY, painter, hudColor, font);
            }

            double throttleX = airSpeedX - (font.CharWidth + font.CharSpacing) * 4 - 1;
            double throttleY = headingY - font.CharHeight - 3;
            painter.Text(font, throttleX, throttleY, actor.ThrottleHudText, hudColor);

            if (actor.AutopilotEnabled)
            {
                painter.Text(font, throttleX, throttleY - font.CharHeight - 2, "AP", hudColor);
            }

            RenderFlightDataIndicators(layout, airSpeedX, airSpeedY, painter, hudColor, hudWarnColor, fontSmall);
            RenderAoaIndexer(airSpeedX, airSpeedY, geomScale, painter, hudColor, hudWarnColor, hudSecondaryColor, palette);

            double stickArm = Math.Max(8, JsMath.Round(11 * geomScale));
            double stickGap = JsMath.Round(10 * geomScale);
            double stickLabelMargin = (fontSmall.CharWidth + fontSmall.CharSpacing) * 4 + 6;
            double stickCenterX = altitudeX + stickLabelMargin + stickGap + stickArm;
            double stickCenterY = hudY;
            RenderStickIndicator(stickCenterX, stickCenterY, stickArm, geomScale, painter, hudColor, hudSecondaryColor, hudLimitColor, fontSmall);

            RenderGunReticle(dx, dy, targetHeight, painter, geomScale, hudColor, hudWarnColor, font);
            bool ilsTarget = ApproachAids.IsIlsApproachTarget(weaponsTarget);
            if (ilsTarget && weaponsTarget != null)
            {
                RenderIlsIndicator(halfWidth, halfHeight, dx, dy, painter, geomScale, hudColor, hudSecondaryColor, palette);
                RenderApproachTargets(layout, airSpeedX, airSpeedY, painter, hudColor, hudSecondaryColor, fontSmall);
            }
            else
            {
                RenderGunAimIndicator(targetWidth, targetHeight, halfWidth, halfHeight, dx, dy, painter, geomScale, hudColor);
            }
            RenderBoresight(hudX, hudY, painter, geomScale, hudColor);
            RenderFlightPathMarker(targetWidth, targetHeight, halfWidth, halfHeight, dx, dy, painter, geomScale, ilsTarget, hudColor, hudSecondaryColor, palette);
            RenderStallWarning(layout, airSpeedX, airSpeedY, painter, hudColor, hudWarnColor, font);

            if (input.FocusMode == HudFocusMode.Disabled)
            {
                RenderStallStatus(layout, airSpeedX, airSpeedY, painter, hudColor, hudWarnColor);
                RenderVerticalVelocityIndicator(layout, altitudeX, altitudeY, painter, hudColor, hudWarnColor);
            }

            RenderPerfStats(targetWidth, layoutScale, dx, dy, painter, hudSecondaryColor, fontSmall);
        }

        /// <summary>projectBoresight: the nose's screen position in the view (screen centre when it is behind).</summary>
        private (double, double) ProjectBoresight(double halfWidth, double halfHeight)
        {
            Vec3d w = camera.Position.AddScaled(HudMath.Forward.Rotate(actor.Quaternion), 1000);
            if (camera.DistanceToPoint(w) <= 0)
            {
                return (halfWidth, halfHeight);
            }
            w = camera.Project(w);
            return (JsMath.Round((w.X * halfWidth) + halfWidth), JsMath.Round(-(w.Y * halfHeight) + halfHeight));
        }

        /// <summary>projectOnHudGlass: nose-camera projection plus the padlock offset; null behind.</summary>
        private bool ProjectOnHudGlass(Vec3d worldPoint, double halfWidth, double halfHeight, double dx, double dy, out double x, out double y)
        {
            x = y = 0;
            if (!(noseCamera.DistanceToPoint(worldPoint) > 0)) return false;
            Vec3d w = noseCamera.Project(worldPoint);
            x = JsMath.Round((w.X * halfWidth) + halfWidth + dx);
            y = JsMath.Round(-(w.Y * halfHeight) + halfHeight + dy);
            return true;
        }

        private void RenderPerfStats(double targetWidth, double layoutScale, double dx, double dy, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double margin = Math.Max(4, JsMath.Round(4 * layoutScale));
            double lineHeight = font.CharHeight + font.CharSpacing;
            double x = targetWidth - margin + dx;

            double terrainTriangles = actor.TerrainTriangles;
            double cloudTriangles = actor.CloudTriangles;
            double sceneTriangles = actor.SceneTriangles;
            double objectTriangles = Math.Max(0, sceneTriangles - terrainTriangles - cloudTriangles);

            painter.Text(font, x, margin + dy, JsText.ToFixed(renderFps, 0) + "FPS", hudColor, TextAlignment.Right);
            painter.Text(font, x, margin + dy + lineHeight, "OBJ " + JsText.ToFixed(objectTriangles / 1000, 1) + "K", hudColor, TextAlignment.Right);
            painter.Text(font, x, margin + dy + lineHeight * 2, "TER " + JsText.ToFixed(terrainTriangles / 1000, 1) + "K", hudColor, TextAlignment.Right);
            painter.Text(font, x, margin + dy + lineHeight * 3, "CLD " + JsText.ToFixed(cloudTriangles / 1000, 1) + "K", hudColor, TextAlignment.Right);
        }

        private void RenderFlightDataIndicators(OverlayLayout layout, double airSpeedX, double airSpeedY, ICanvasPainter painter, string hudColor, string hudWarnColor, HudFont font)
        {
            double lineHeight = font.CharHeight + font.CharSpacing;
            double ladderBottom = airSpeedY + layout.LayoutScale * AirspeedHalfHeight * 2;
            double x = airSpeedX + 9;
            double y = ladderBottom + font.CharSpacing + 2;
            double aoaDeg = HudMath.ToDegrees(actor.AngleOfAttackRad);
            double g = actor.LoadFactorG;

            RenderFlightDataIndicator(x, y, "Mach:", JsText.ToFixed(machNumber, 1), painter, hudColor, font);
            RenderFlightDataIndicator(x, y + lineHeight, "AoA:", JsText.ToFixed(aoaDeg, 0),
                painter, aoaDeg >= AoaStallDeg - 2 ? hudWarnColor : hudColor, font);
            RenderFlightDataIndicator(x, y + lineHeight * 2, "G:", JsText.ToFixed(g, 1),
                painter, g >= 4 || g < 0 ? hudWarnColor : hudColor, font);
        }

        private static void RenderFlightDataIndicator(double x, double y, string label, string value, ICanvasPainter painter, string color, HudFont font)
        {
            double charStep = font.CharWidth + font.CharSpacing;
            double valueX = x + charStep * 6;
            painter.Text(font, x, y, label, color);
            painter.Text(font, valueX, y, value, color);
        }

        private void RenderAltitude(OverlayLayout layout, double tickStep, double x, double y, double width, ICanvasPainter painter, string hudColor, HudFont font, HudFont fontSmall)
        {
            double detailScale = layout.DetailScale, layoutScale = layout.LayoutScale;
            double altitudeStep = displayUnits.AltitudeStep;
            double altitudeLowThreshold = displayUnits.AltitudeLowThreshold;
            bool lowp = displayUnits.UseBarometricAltitude && altitude >= altitudeLowThreshold;
            double markerScale = lowp ? 10 : 1;
            double tapeUnit = altitudeStep * markerScale;
            double tapeOrigin = tapeUnit * Math.Floor(altitude / tapeUnit);
            double scrollOffset = tapeUnit > 0
                ? ((altitude - tapeOrigin) / tapeUnit) * tickStep
                : 0;
            double labelInterval = displayUnits.AltitudeTapeLabelInterval * markerScale;
            double charHeightHalf = Math.Truncate(font.CharHeight / 2.0);

            IBatchPainter batch = painter.Batch();
            for (double i = AltitudeHalfHeight * detailScale; i >= -AltitudeHalfHeight * detailScale; i--)
            {
                double current = tapeOrigin + i * altitudeStep;
                if (current >= 0 || lowp)
                {
                    double barWidth = displayUnits.GetAltitudeTickWidth(current, markerScale);
                    if (barWidth > 0)
                    {
                        batch.HLine(x, x + barWidth, y - i * tickStep + scrollOffset);
                    }
                }
            }
            batch.HLine(x - 5, x - 2, y);
            batch.Commit();

            IClipPainter clip = painter.Clip();
            clip.Rectangle(x, y - AltitudeHeight * layoutScale, width - x, (AltitudeHeight * 2 + 3) * layoutScale).Clip();
            for (double i = detailScale * (AltitudeHalfHeight + 1) + 1; i >= -detailScale * (AltitudeHalfHeight + 1) - 1; i--)
            {
                double current = tapeOrigin + i * altitudeStep;
                if ((current >= 0 || lowp) && current % labelInterval == 0)
                {
                    painter.Text(fontSmall,
                        x + 6 + (fontSmall.CharWidth + fontSmall.CharSpacing) * 3,
                        y - i * tickStep + scrollOffset - charHeightHalf,
                        displayUnits.FormatAltitudeTape(current, lowp), hudColor, TextAlignment.Right);
                }
            }
            clip.Clear();

            painter.Text(font, x - 8, y - Math.Floor(font.CharHeight / 2.0),
                displayUnits.FormatAltitudeReadout(altitude), hudColor, TextAlignment.Right);
        }

        private void RenderAltitudeFocusMode(double x, double y, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double textX = x + font.CharWidth * 4;
            double textY = y - Math.Floor(font.CharHeight / 2.0);
            painter.Text(font, textX, textY, displayUnits.FormatAltitudeReadout(altitude), hudColor, TextAlignment.Right);
            painter.Rectangle(
                textX - ((font.CharWidth + font.CharSpacing) * 5 + font.CharSpacing + 1),
                textY - font.CharSpacing * 2 - 1,
                (font.CharWidth + font.CharSpacing) * 5 + font.CharSpacing * 3 + 2,
                2 + font.CharSpacing * 4 + font.CharHeight);
        }

        private void RenderVerticalVelocityIndicator(OverlayLayout layout, double x, double y, ICanvasPainter painter, string hudColor, string hudWarnColor)
        {
            double layoutScale = layout.LayoutScale;
            double maxPixels = AltitudeHeight * layoutScale;
            double pixelLength = JsMath.Clamp(layoutScale * verticalSpeed / displayUnits.VerticalSpeedBarDivisor, -maxPixels, maxPixels);
            painter.SetColor(hudWarnColor);
            painter.VLine(x - 1, y, y - pixelLength);
            painter.SetColor(hudColor);
        }

        private void RenderHeading(OverlayLayout layout, double x, double y, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double detailScale = layout.DetailScale, layoutScale = layout.LayoutScale;
            double headingSpacing = HeadingSpacing * layoutScale / detailScale;
            double offset = heading % HeadingSpacing;
            IBatchPainter batch = painter.Batch();
            for (double i = -HeadingHalfWidth; i <= HeadingHalfWidth; i++)
            {
                double height = (heading + i * HeadingStep - offset) % 10 == 0 ? 2 * layoutScale / detailScale : 0;
                batch.VLine(x + i * headingSpacing - offset, y - height, y);
            }
            batch.VLine(x, y + 2 * layoutScale / detailScale, y + 4 * layoutScale / detailScale);
            batch.Commit();

            IClipPainter clip = painter.Clip()
                .Rectangle(x - HeadingHalfWidth * headingSpacing - font.CharWidth - 1,
                    y - font.CharHeight - 4 * layoutScale / detailScale,
                    HeadingWidth * headingSpacing + 2 * font.CharWidth,
                    font.CharHeight + 3 * layoutScale / detailScale)
                .Clip();
            for (double i = -HeadingHalfWidth - 1 - detailScale; i <= HeadingHalfWidth + 1 + detailScale; i++)
            {
                double value = heading + i * HeadingStep - offset;
                if (value % 45 == 0)
                {
                    painter.Text(font,
                        x + i * headingSpacing - offset,
                        y - font.CharHeight - 3 * layoutScale / detailScale,
                        OverlayUtils.FormatHeading(value), hudColor, TextAlignment.Center);
                }
            }
            clip.Clear();
        }

        private void RenderHeadingFocusMode(double x, double y, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double textY = y - font.CharHeight;
            painter.Text(font, x, textY, OverlayUtils.FormatHeading(heading), hudColor, TextAlignment.Center);
            painter.Rectangle(
                x - (Math.Truncate(font.CharWidth * 1.5) + 1 + font.CharSpacing * 2 + 1),
                textY - font.CharSpacing * 2 - 1,
                (font.CharWidth + font.CharSpacing) * 3 + font.CharSpacing * 3 + 2,
                2 + font.CharSpacing * 4 + font.CharHeight);
        }

        private void RenderAirSpeed(OverlayLayout layout, double tickStep, double x, double y, ICanvasPainter painter, string hudColor, HudFont font, HudFont fontSmall)
        {
            double detailScale = layout.DetailScale, layoutScale = layout.LayoutScale;
            double airspeedStep = displayUnits.AirspeedStep;
            double airspeedScale = displayUnits.AirspeedScale;
            double airspeed = airspeedScale * airspeedStep * Math.Floor(speed / airspeedStep);
            double tmp = 25 * Math.Floor(speed * 10 / 25);
            double offset = tmp % 50 == 0 ? 0 : 1;
            double labelsRes = detailScale > 1 ? 1000 : 500;
            double charHeightHalf = Math.Truncate(font.CharHeight / 2.0);
            double smallCharHeightHalf = Math.Truncate(fontSmall.CharHeight / 2.0);

            IBatchPainter batch = painter.Batch();
            for (double i = AirspeedHalfHeight * detailScale; i >= -AirspeedHalfHeight * detailScale; i--)
            {
                double current = airspeed + (i * 2 - offset) * airspeedStep * airspeedScale;
                if (current >= 0)
                {
                    double barWidth = 0;
                    if (current % 500 == 0)
                    {
                        barWidth = 2;
                    }
                    else if (current % 250 == 0)
                    {
                        barWidth = 1;
                    }
                    batch.HLine(x - barWidth, x, y - i * tickStep + offset);
                }
            }
            batch.HLine(x + 2, x + 5, y);
            batch.Commit();

            IClipPainter clip = painter.Clip();
            clip.Rectangle(0, y - AirspeedHeight * layoutScale, x, layoutScale * AirspeedHeight * 2 + 3).Clip();
            for (double i = detailScale * (AirspeedHalfHeight + 1) + 1; i >= -detailScale * (AirspeedHalfHeight + 1) - 1; i--)
            {
                double current = airspeed + (i * 2 - offset) * airspeedStep * airspeedScale;
                if (current >= 0 && current % labelsRes == 0)
                {
                    painter.Text(fontSmall,
                        x - 6,
                        y - i * tickStep + offset - smallCharHeightHalf,
                        JsText.ToFixed(current / airspeedScale, 0), hudColor, TextAlignment.Right);
                }
            }
            clip.Clear();

            painter.Text(font,
                x + 9,
                y - charHeightHalf,
                Num(Math.Floor(speed)),
                hudColor,
                TextAlignment.Left);
        }

        private void RenderAirSpeedFocusMode(double x, double y, ICanvasPainter painter, string hudColor, HudFont font)
        {
            double textX = x - font.CharWidth * 4;
            double textY = y - Math.Truncate(font.CharHeight / 2.0);
            painter.Text(font,
                textX,
                y - Math.Truncate(font.CharHeight / 2.0),
                Num(Math.Floor(speed)),
                hudColor,
                TextAlignment.Left);

            painter.Rectangle(
                textX - (font.CharSpacing * 2 + 1),
                textY - font.CharSpacing * 2 - 1,
                (font.CharWidth + font.CharSpacing) * 5 + font.CharSpacing * 3 + 2,
                2 + font.CharSpacing * 4 + font.CharHeight);
        }

        private void RenderStickIndicator(double centerX, double centerY, double arm, double geomScale, ICanvasPainter painter, string hudColor, string hudSecondaryColor, string hudLimitColor, HudFont font)
        {
            double rollTravel = arm - Math.Max(2, JsMath.Round(2 * geomScale));
            double pitchTotalUnits = PitchStickFwdUnits + PitchStickAftUnits;
            double pitchTotalSpan = Math.Max(arm * 2, JsMath.Round(40 * geomScale));
            double pitchFwdTravel = JsMath.Round(pitchTotalSpan * PitchStickFwdUnits / pitchTotalUnits);
            double pitchAftTravel = pitchTotalSpan - pitchFwdTravel;
            double pitchIn = actor.PitchInput;
            double rollIn = actor.RollInput;
            double yawIn = actor.YawInput;
            double throttle = actor.Throttle;
            double crossArm = Math.Max(2, JsMath.Round(2 * geomScale));
            double gap = Math.Max(2, JsMath.Round(2 * geomScale));

            painter.SetColor(hudSecondaryColor);
            painter.Batch()
                .HLine(centerX - arm, centerX + arm, centerY)
                .VLine(centerX, centerY - pitchFwdTravel, centerY + pitchAftTravel)
                .Commit();

            double PitchCmdYOffset(double v) => v >= 0 ? v * pitchAftTravel : v * pitchFwdTravel;
            double LimitY(double v) => Math.Max(
                centerY - pitchFwdTravel,
                Math.Min(centerY + pitchAftTravel, JsMath.Round(centerY + PitchCmdYOffset(v))));
            double limitHiY = LimitY(actor.ElevatorLimitHigh);
            double limitLoY = LimitY(actor.ElevatorLimitLow);
            painter.SetColor(hudLimitColor);
            painter.Batch()
                .HLine(centerX - arm, centerX + arm, limitHiY)
                .HLine(centerX - arm, centerX + arm, limitLoY)
                .Commit();

            double stickX = centerX + rollIn * rollTravel;
            double stickY = centerY + PitchCmdYOffset(pitchIn);
            painter.SetColor(hudColor);
            painter.Circle(JsMath.Round(stickX), JsMath.Round(stickY), crossArm);

            double rudderY = centerY + pitchAftTravel + gap;
            painter.SetColor(hudSecondaryColor);
            painter.HLine(centerX - arm, centerX + arm, rudderY);
            painter.SetColor(hudColor);
            painter.VLine(centerX + yawIn * (arm - 1), rudderY - 1, rudderY + 1);

            double throttleX = centerX - arm - gap;
            painter.SetColor(hudSecondaryColor);
            painter.VLine(throttleX, centerY - arm, centerY + arm);
            painter.SetColor(hudColor);
            double throttleY = centerY + arm - 1 - throttle * (arm * 2 - 1);
            painter.HLine(throttleX - 1, throttleX + 1, throttleY);

            bool limitersOn = actor.FcsLimitersEnabled;
            string label = limitersOn
                ? (actor.FlightModelFm3 ? "FCS FM3" : FcsModeLabel(actor.FcsPitchLimiterMode))
                : "FCS OFF";
            string labelColor = limitersOn ? hudColor : hudLimitColor;
            double labelY = rudderY + gap + 2;
            painter.Text(font, centerX, labelY, label, labelColor, TextAlignment.Center);
        }

        private void RenderPitchLadder(OverlayLayout layout, double x, double y, ICanvasPainter painter, string hudColor, string hudSecondaryColor, HudFont font)
        {
            double detailScale = layout.DetailScale, layoutScale = layout.LayoutScale;
            double fov = HudMath.ToRadians(CockpitFov);
            double logicalHeight = OverlayUtils.GetOverlayLogicalHeight(layout);
            double current = HudMath.ToDegrees(-pitch) / 10 * detailScale;
            double minMarker = Math.Max(Math.Ceiling(current) - LadderExtraMarkers * detailScale, -9 * detailScale);
            double maxMarker = Math.Min(Math.Floor(current) + LadderExtraMarkers * detailScale, 9 * detailScale);

            painter.SetColor(hudSecondaryColor);

            double ladderSpread = layoutScale > 1 ? Math.Max(1.5, layoutScale / detailScale) : 1;
            IClipPainter clip = painter.Clip()
                .Rectangle(x - Math.Floor(LadderHalfWidth * ladderSpread),
                    y - LadderHalfHeight * layoutScale,
                    Math.Floor(LadderWidth * ladderSpread),
                    (LadderHeight + font.CharHeight) * layoutScale)
                .Clip();

            double geomScale = layoutScale / detailScale;
            // FORWARD.negate(): the zeros keep their sign.
            var back = new Vec3d(-0.0, -0.0, -1);
            Quatd rollQ = Quatd.FromAxisAngle(HudMath.Up, roll);

            for (double i = minMarker; i <= maxMarker; i++)
            {
                double offset = ((pitch + HudMath.ToRadians(i * 10 / detailScale)) / fov) * logicalHeight;
                Vec3d normal = back.Rotate(rollQ);
                Vec3d center = new Vec3d(x, 0, y).AddScaled(normal, -offset);

                double ladderHalf = LadderSizeHalf * geomScale;
                normal = normal * ladderHalf;

                double c0X = center.X + normal.Z;
                double c0Y = center.Z + -normal.X;
                double c1X = center.X + -normal.Z;
                double c1Y = center.Z + normal.X;

                normal = normal / ladderHalf;

                IBatchPainter batch = painter.Batch();
                if (i >= 0)
                {
                    double horizonVerticalOffset = ladderHalf + LadderHorizonHalfGap * geomScale;
                    batch.Line(
                        c0X, c0Y,
                        c1X + normal.Z * horizonVerticalOffset,
                        c1Y + -normal.X * horizonVerticalOffset);
                    batch.Line(
                        c0X + -normal.Z * horizonVerticalOffset,
                        c0Y + normal.X * horizonVerticalOffset,
                        c1X, c1Y);
                }
                else
                {
                    batch.Line(c0X, c0Y, c1X, c1Y);
                }
                if (i != 0)
                {
                    double sign = JsMath.Sign(i);
                    double chevron = 5 * geomScale;
                    double nX = sign * normal.X * chevron;
                    double nY = sign * normal.Z * chevron;
                    batch.Line(c0X, c0Y, c0X + nX, c0Y + nY);
                    batch.Line(c1X, c1Y, c1X + nX, c1Y + nY);
                }
                batch.Commit();

                if (i == 0 && detailScale > 1) continue;

                string str = i == 0 ? "00" : Num(JsMath.Round(i * -10 / detailScale));
                double charHeightHalf = Math.Truncate(font.CharHeight / 2.0);
                double tX = JsMath.Round(normal.X * charHeightHalf);
                double tY = JsMath.Round(normal.Z * charHeightHalf);
                double labelOffset = 2 * (font.CharWidth + font.CharSpacing) * geomScale;
                double t0X = Math.Floor(normal.Z * labelOffset);
                double t0Y = JsMath.Round(-normal.X * labelOffset);
                double t1X = Math.Floor(-normal.Z * labelOffset);
                double t1Y = JsMath.Round(normal.X * labelOffset);
                painter.Text(font, c0X + tX + t0X, c0Y + tY + t0Y, str, hudSecondaryColor, TextAlignment.Center);
                painter.Text(font, c1X + tX + t1X, c1Y + tY + t1Y, str, hudSecondaryColor, TextAlignment.Center);
            }
            clip.Clear();

            painter.SetColor(hudColor);
        }

        private void RenderTarget(double width, double height, double halfWidth, double halfHeight, ICanvasPainter painter, double geomScale)
        {
            if (weaponsTarget == null) return;

            double targetHalfWidth = JsMath.Round(TargetHalfWidth * geomScale);
            double targetWidth = targetHalfWidth * 2 + 1;

            if (camera.DistanceToPoint(weaponsTarget.Position) > 0)
            {
                Vec3d v = camera.Project(weaponsTarget.Position);
                double x = JsMath.Round((v.X * halfWidth) + halfWidth);
                double y = JsMath.Round(-(v.Y * halfHeight) + halfHeight);
                if (0 <= x && x < width &&
                    0 <= y && y < height)
                {
                    painter.Rectangle(x - targetHalfWidth, y - targetHalfWidth, targetWidth, targetWidth);
                }
            }
        }

        /// <summary>Gun ammo / hull readout while a cannon is fitted.</summary>
        private void RenderGunReticle(double dx, double dy, double targetHeight, ICanvasPainter painter, double geomScale, string hudColor, string hudWarnColor, HudFont font)
        {
            if (!actor.HasGun) return;

            double lineHeight = font.CharHeight + font.CharSpacing;
            double x = Math.Max(4, JsMath.Round(4 * geomScale)) + dx;
            double y = targetHeight - lineHeight * 2 - 2 + dy;
            double hpPct = JsMath.Round(actor.HealthFraction * 100);
            painter.Text(font, x, y, "GUN " + actor.GunAmmo.ToString(CultureInfo.InvariantCulture),
                actor.GunAmmo > 0 ? hudColor : hudWarnColor, TextAlignment.Left);
            painter.Text(font, x, y + lineHeight, "HULL " + Num(hpPct) + "%", hpPct <= 30 ? hudWarnColor : hudColor, TextAlignment.Left);
        }

        /// <summary>Gun pipper: where rounds are at the target range, with a line from the boresight.</summary>
        private void RenderGunAimIndicator(double width, double height, double halfWidth, double halfHeight, double dx, double dy, ICanvasPainter painter, double geomScale, string hudColor)
        {
            if (!actor.HasGun) return;

            Vec3d pos = actor.Position;
            Quatd quat = actor.Quaternion;
            Vec3d vel = actor.Velocity;

            Vec3d forward = HudMath.Forward.Rotate(quat);
            Vec3d muzzle = GunPipper.MuzzleOffset.Rotate(quat) + pos;
            Vec3d? targetPos = null;
            if (weaponsTarget != null)
            {
                targetPos = weaponsTarget.Position + weaponsTarget.LocalCenter;
            }
            Vec3d pipper = GunPipper.WorldPoint(muzzle, forward, vel, GunMuzzleVelocityMps, targetPos, GunPipper.DefaultRangeM);

            if (!ProjectOnHudGlass(pipper, halfWidth, halfHeight, dx, dy, out double pipperX, out double pipperY)) return;
            if (pipperX < 0 || pipperX >= width || pipperY < 0 || pipperY >= height) return;

            double boreX = JsMath.Round(halfWidth + dx);
            double boreY = JsMath.Round(halfHeight + dy);
            painter.SetColor(hudColor);
            painter.Batch()
                .Line(boreX, boreY, pipperX, pipperY)
                .Commit();

            double r = Math.Max(3, JsMath.Round(5 * geomScale));
            painter.Circle(pipperX, pipperY, r);
            painter.Batch()
                .HLine(pipperX - 1, pipperX + 1, pipperY)
                .VLine(pipperX, pipperY - 1, pipperY + 1)
                .Commit();
        }

        /// <summary>
        /// ILS / OLS-style localizer and glideslope on an airfield or carrier
        /// target: reference box, green datums, needles and the yellow meatball.
        /// </summary>
        private void RenderIlsIndicator(double halfWidth, double halfHeight, double dx, double dy, ICanvasPainter painter, double geomScale, string hudColor, string hudSecondaryColor, Palette palette)
        {
            if (weaponsTarget == null) return;
            IlsDeviation? devOpt = ApproachAids.ComputeIlsDeviation(
                actor.Position,
                weaponsTarget.TargetType,
                weaponsTarget.TargetType == "Carrier" ? weaponsTarget.Position : (Vec3d?)null,
                weaponsTarget.ApproachRunway);
            if (!devOpt.HasValue) return;
            IlsDeviation dev = devOpt.Value;

            double cx = JsMath.Round(halfWidth + dx);
            double cy = JsMath.Round(halfHeight + dy);
            double u = Math.Max(1, JsMath.Round(geomScale));
            double arm = Math.Max(18, JsMath.Round(22 * geomScale));
            double tick = Math.Max(2, JsMath.Round(3 * geomScale));
            double needleTravel = arm - 2 * u;
            string datumColor = palette.Color(PaletteCategory.LIGHT_GREEN);
            string ballColor = palette.Color(PaletteCategory.LIGHT_YELLOW);

            painter.SetColor(hudSecondaryColor);
            painter.Batch()
                .HLine(cx - arm, cx + arm, cy - arm)
                .HLine(cx - arm, cx + arm, cy + arm)
                .VLine(cx - arm, cy - arm, cy + arm)
                .VLine(cx + arm, cy - arm, cy + arm)
                .HLine(cx - tick, cx + tick, cy)
                .VLine(cx, cy - tick, cy + tick)
                .Commit();

            double datumX = arm + JsMath.Round(4 * geomScale);
            painter.SetColor(datumColor);
            painter.Batch()
                .HLine(cx - datumX - tick, cx - datumX + tick, cy)
                .HLine(cx + datumX - tick, cx + datumX + tick, cy)
                .Commit();

            double locX = JsMath.Round(cx + dev.Localizer * needleTravel);
            painter.SetColor(hudColor);
            painter.Batch()
                .VLine(locX, cy - arm + u, cy + arm - u)
                .Commit();

            double ballY = JsMath.Round(cy - dev.Glideslope * needleTravel);
            double ballR = Math.Max(2, JsMath.Round(3 * geomScale));
            painter.SetColor(ballColor);
            painter.Circle(cx, ballY, ballR);

            painter.SetColor(hudColor);
            painter.Batch()
                .HLine(cx - arm + u, cx + arm - u, ballY)
                .Commit();
        }

        /// <summary>Approach cues beside the airspeed tape: target speed, sink and glideslope.</summary>
        private void RenderApproachTargets(OverlayLayout layout, double airSpeedX, double airSpeedY, ICanvasPainter painter, string hudColor, string hudSecondaryColor, HudFont font)
        {
            bool imperial = displayUnits.System == UnitSystem.Imperial;
            double tgtSpeed = ApproachAids.CarrierApproachTargetSpeed(imperial);
            double tgtSink = ApproachAids.CarrierApproachTargetSink(imperial);
            string speedUnit = displayUnits.SpeedUnitLabel();
            string sinkUnit = imperial ? "FPM" : "M/S";
            double lineHeight = font.CharHeight + font.CharSpacing;
            double geomScale = layout.LayoutScale / Math.Max(1, layout.DetailScale);
            double x = airSpeedX - JsMath.Round(14 * geomScale);
            double y = airSpeedY + JsMath.Round(16 * geomScale);

            painter.Text(font, x, y, "TGT " + Num(tgtSpeed) + speedUnit, hudColor, TextAlignment.Right);
            painter.Text(font, x, y + lineHeight, "VS " + Num(tgtSink) + sinkUnit, hudSecondaryColor, TextAlignment.Right);
            painter.Text(font, x, y + lineHeight * 2, "GS " + JsText.ToFixed(ApproachAids.GlideslopeDeg, 1), hudSecondaryColor, TextAlignment.Right);
        }

        /// <summary>Navy AoA indexer: slow chevron / on-speed donut / fast chevron.</summary>
        private void RenderAoaIndexer(double airSpeedX, double airSpeedY, double geomScale, ICanvasPainter painter, string hudColor, string hudWarnColor, string hudSecondaryColor, Palette palette)
        {
            double u = Math.Max(1, JsMath.Round(geomScale));
            double cx = airSpeedX - JsMath.Round(14 * geomScale);
            double cy = airSpeedY;
            double gap = JsMath.Round(7 * geomScale);
            double aoaDeg = HudMath.ToDegrees(actor.AngleOfAttackRad);
            AoaIndexerCue cue = ApproachAids.AoaIndexerCueFor(aoaDeg);
            bool nearStall = aoaDeg >= AoaStallDeg - 2;
            string donutColor = palette.Color(PaletteCategory.LIGHT_YELLOW);

            painter.SetColor(cue == AoaIndexerCue.Slow ? (nearStall ? hudWarnColor : hudColor) : hudSecondaryColor);
            painter.Batch()
                .Line(cx, cy - gap - 2 * u, cx - 4 * u, cy - gap + 3 * u)
                .Line(cx, cy - gap - 2 * u, cx + 4 * u, cy - gap + 3 * u)
                .Commit();

            painter.SetColor(cue == AoaIndexerCue.OnSpeed ? donutColor : hudSecondaryColor);
            double r = Math.Max(2, JsMath.Round(3 * geomScale));
            painter.Circle(cx, cy, r);

            painter.SetColor(cue == AoaIndexerCue.Fast ? hudColor : hudSecondaryColor);
            painter.Batch()
                .Line(cx, cy + gap + 2 * u, cx - 4 * u, cy + gap - 3 * u)
                .Line(cx, cy + gap + 2 * u, cx + 4 * u, cy + gap - 3 * u)
                .Commit();

            painter.SetColor(hudColor);
        }

        /// <summary>Boresight cross at the airframe combiner.</summary>
        private static void RenderBoresight(double hudX, double hudY, ICanvasPainter painter, double geomScale, string hudColor)
        {
            painter.SetColor(hudColor);
            double u = geomScale;
            double cx = JsMath.Round(hudX);
            double cy = JsMath.Round(hudY);
            double gap = Math.Max(1, JsMath.Round(u));
            double arm = Math.Max(4, JsMath.Round(5 * u));
            painter.Batch()
                .HLine(cx - arm - gap, cx - gap, cy)
                .HLine(cx + gap, cx + arm + gap, cy)
                .VLine(cx, cy - arm - gap, cy - gap)
                .VLine(cx, cy + gap, cy + arm + gap)
                .Commit();
        }

        private void RenderFlightPathMarker(double width, double height, double halfWidth, double halfHeight, double dx, double dy, ICanvasPainter painter, double geomScale, bool approachAids, string hudColor, string hudSecondaryColor, Palette palette)
        {
            double u = geomScale;
            Vec3d aim = camera.Position + velocityDirection;
            if (!ProjectOnHudGlass(aim, halfWidth, halfHeight, dx, dy, out double x, out double y)) return;
            if (0 <= x && x < width &&
                0 <= y && y < height)
            {
                painter.Batch()
                    .HLine(x - u, x + u, y - 2 * u)
                    .HLine(x - u, x + u, y + 2 * u)
                    .VLine(x - 2 * u, y - u, y + u)
                    .VLine(x + 2 * u, y - u, y + u)
                    .HLine(x - 5 * u, x - 3 * u, y)
                    .HLine(x + 3 * u, x + 5 * u, y)
                    .VLine(x, y - 4 * u, y - 3 * u)
                    .Commit();

                if (approachAids)
                {
                    AoaIndexerCue cue = ApproachAids.AoaIndexerCueFor(HudMath.ToDegrees(actor.AngleOfAttackRad));
                    string bracketColor = cue == AoaIndexerCue.OnSpeed
                        ? palette.Color(PaletteCategory.LIGHT_YELLOW)
                        : hudSecondaryColor;
                    double bx = JsMath.Round(x - 9 * u);
                    double arm = JsMath.Round(4 * u);
                    double gap = JsMath.Round(5 * u);
                    painter.SetColor(bracketColor);
                    painter.Batch()
                        .HLine(bx - arm, bx, y - gap)
                        .HLine(bx - arm, bx, y)
                        .HLine(bx - arm, bx, y + gap)
                        .VLine(bx - arm, y - gap, y + gap)
                        .Commit();
                    painter.SetColor(hudColor);
                }
            }
        }

        private void RenderStallStatus(OverlayLayout layout, double x, double y, ICanvasPainter painter, string hudColor, string hudWarnColor)
        {
            double halfHeightPixels = layout.LayoutScale * AirspeedHalfHeight * 2;
            painter.SetColor(hudWarnColor);
            painter.VLine(x + 1, y + halfHeightPixels + 1, y + halfHeightPixels + 1 - Math.Floor((actor.StallStatus + 1.0) * (halfHeightPixels + 1)));
            painter.SetColor(hudColor);
        }

        private void RenderStallWarning(OverlayLayout layout, double x, double y, ICanvasPainter painter, string hudColor, string hudWarnColor, HudFont font)
        {
            double halfHeightPixels = layout.LayoutScale * AirspeedHalfHeight * 2;
            painter.SetColor(hudWarnColor);
            bool blink = JsMath.Round(elapsed * 15) % 2 == 0;
            if (actor.StallStatus >= 0 && !actor.IsLanded && blink)
            {
                painter.Text(font, x + 9,
                    y + halfHeightPixels + 1 - font.CharHeight + font.CharSpacing,
                    "STALL",
                    hudWarnColor,
                    TextAlignment.Left);
            }
            painter.SetColor(hudColor);
        }
    }
}
