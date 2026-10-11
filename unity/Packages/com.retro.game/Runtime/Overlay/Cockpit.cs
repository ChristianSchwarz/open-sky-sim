using System;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>cockpit.ts CockpitMFDSize / CockpitMFD1X..2Y: where the two MFDs sit (pixels).</summary>
    public static class CockpitLayout
    {
        /// <summary>CockpitMFDSize(height): a third of the height (height / 3.333, floored).</summary>
        public static double MfdSize(double height) => Math.Floor(height / 3.333);

        /// <summary>CockpitMFDSize(height, width): also no wider than half the width less a pixel, never above the height, at least 1.</summary>
        public static double MfdSize(double height, double width)
        {
            double byHeight = Math.Floor(height / 3.333);
            double maxByWidth = Math.Floor((width - 2) / 2);
            double maxByHeight = Math.Floor(height - 2);
            return Math.Max(1, Math.Min(byHeight, Math.Min(maxByWidth, maxByHeight)));
        }

        public static double Mfd1X(double width, double height, double size) => 1;

        public static double Mfd1Y(double width, double height, double size) => Math.Max(1, height - size - 1);

        public static double Mfd2X(double width, double height, double size) => Math.Max(1, width - size - 1);

        public static double Mfd2Y(double width, double height, double size) => Math.Max(1, height - size - 1);

        /// <summary>MFD1 (bottom left) for a canvas.</summary>
        public static CockpitViewport Mfd1(double width, double height)
        {
            double s = MfdSize(height, width);
            return new CockpitViewport { X = Mfd1X(width, height, s), Y = Mfd1Y(width, height, s), Size = s };
        }

        /// <summary>MFD2 (bottom right) for a canvas: the target camera's render target rectangle (game.ts createRenderTarget).</summary>
        public static CockpitViewport Mfd2(double width, double height)
        {
            double s = MfdSize(height, width);
            return new CockpitViewport { X = Mfd2X(width, height, s), Y = Mfd2Y(width, height, s), Size = s };
        }
    }

    /// <summary>cockpit.ts TacticalPlot: where a contact sits on the scope, in pixels from its centre.</summary>
    public struct TacticalPlot
    {
        public double X;
        public double Y;
        /// <summary>Past the outer ring, pinned to the rim.</summary>
        public bool OffScope;
    }

    /// <summary>cockpit.ts tacticalScopeRange / plotTacticalContact.</summary>
    public static class TacticalScope
    {
        /// <summary>TACTICAL_RANGES_KM: the scope range ladder (Km).</summary>
        public static readonly double[] RangesKm = { 5, 10, 20, 40, 80 };

        /// <summary>TACTICAL_DEFAULT_RANGE_KM: scope range while nothing is designated.</summary>
        public const double DefaultRangeKm = 20;

        /// <summary>Smallest ladder range that holds a lock at <paramref name="lockRangeKm"/>; null is the default.</summary>
        public static double Range(double? lockRangeKm)
        {
            if (!lockRangeKm.HasValue) return DefaultRangeKm;
            foreach (double r in RangesKm)
            {
                if (lockRangeKm.Value <= r) return r;
            }
            return RangesKm[RangesKm.Length - 1];
        }

        /// <summary>
        /// Plots a contact on the heading-up scope. <paramref name="dx"/> /
        /// <paramref name="dz"/> are world offsets from the aircraft (m),
        /// <paramref name="radius"/> the outer ring (px). Ahead plots up the screen.
        /// </summary>
        public static TacticalPlot Plot(double dx, double dz, double headingDeg, double rangeKm, double radius)
        {
            double heading = headingDeg * Math.PI / 180;
            double sinH = JsTrig.Sin(heading);
            double cosH = JsTrig.Cos(heading);
            double ahead = dx * sinH - dz * cosH;
            double right = dx * cosH + dz * sinH;
            double distance = JsMath.Hypot(right, ahead);
            if (distance < 1) return new TacticalPlot { X = 0, Y = 0, OffScope = false };
            double scopeDistance = distance * radius / (rangeKm * 1000);
            bool offScope = scopeDistance > radius;
            double plotted = offScope ? radius : scopeDistance;
            return new TacticalPlot { X = right / distance * plotted, Y = -ahead / distance * plotted, OffScope = offScope };
        }
    }

    /// <summary>The utils/math.ts attitude helpers cockpit.ts uses, over three.js-exact vector math.</summary>
    public static class CockpitAttitude
    {
        private static readonly Vec3d Forward = new Vec3d(0, 0, 1);
        private static readonly Vec3d Right = new Vec3d(1, 0, 0);

        /// <summary>vectorHeading: whole degrees [0, 360), 0 north (-Z), clockwise.</summary>
        public static double VectorHeading(Vec3d v)
        {
            double bearing = JsMath.Round(JsTrig.Atan2(v.X, -v.Z) / (2 * Math.PI) * 360);
            if (bearing < 0) bearing = 360 + bearing;
            return bearing;
        }

        /// <summary>three.js Vector3.angleTo.</summary>
        private static double AngleTo(Vec3d a, Vec3d b)
        {
            double denominator = Math.Sqrt(a.LengthSquared * b.LengthSquared);
            if (denominator == 0) return Math.PI / 2;
            double theta = Vec3d.Dot(a, b) / denominator;
            return JsTrig.Acos(Math.Max(-1, Math.Min(1, theta)));
        }

        /// <summary>calculatePitchRoll: [pitch, roll] in radians from a body-to-world quaternion.</summary>
        public static (double Pitch, double Roll) PitchRoll(Quatd q)
        {
            Vec3d forward = Forward.Rotate(q);
            Vec3d prjForward = new Vec3d(forward.X, 0, forward.Z).Normalized();
            double pitch = AngleTo(forward, prjForward) * JsMath.Sign(forward.Y);

            Quatd q1 = Quatd.FromUnitVectors(forward, prjForward);
            Vec3d right = Right.Rotate(q).Rotate(q1);
            Quatd q2 = Quatd.FromUnitVectors(prjForward, Forward);
            right = right.Rotate(q2);
            double roll = JsTrig.Acos(right.X) * JsMath.Sign(right.Y);
            if (double.IsNaN(roll)) roll = 0.0;
            return (pitch, roll);
        }
    }

    /// <summary>
    /// scene/utils.ts updateTargetCamera for a <see cref="CockpitTarget"/>
    /// (the camera updaters' <see cref="TargetCamera"/> takes the slimmer
    /// <see cref="WeaponsTarget"/> through an actor; same arithmetic).
    /// </summary>
    public static class CockpitTargetCamera
    {
        private const double TargetSizeFactor = 2.0;
        private const double TargetMaxSize = 250;
        private const double MinAltitude = 15;
        private const double AdaptiveThreshold = 5000;
        private const double ConstantNear = 10;
        private const double ConstantFar = 10000;

        /// <summary>getWeaponsTargetZoomFactor: a power of two, the "Nx" on MFD2.</summary>
        public static double ZoomFactor(CameraPose mainCamera, double targetMaxSize, double distance)
        {
            double farWidth = TargetCamera.VisibleWidthAtDistance(mainCamera, distance);
            double relativeSize = TargetSizeFactor * Math.Min(TargetMaxSize, targetMaxSize) / farWidth;
            return Math.Pow(2, relativeSize >= 1 ? 0 : Math.Max(0, TargetCamera.FloorNegLog2(relativeSize)));
        }

        /// <summary>
        /// Place <paramref name="targetCamera"/> at the aircraft (no lower than
        /// 15 m), aimed at the target's visual centre, its FOV narrowed by the
        /// zoom factor, clip planes adapted to the range. Returns the zoom factor.
        /// </summary>
        public static double Update(Vec3d actorPosition, CockpitTarget target, CameraPose mainCamera, CameraPose targetCamera)
        {
            double d = Vec3d.Distance(actorPosition, target.Position);
            double zoom = ZoomFactor(mainCamera, target.MaxSize, d);

            Vec3d position = actorPosition;
            position.Y = Math.Max(MinAltitude, actorPosition.Y);
            targetCamera.Position = position;
            targetCamera.LookAt(target.Position + target.LocalCenter);
            targetCamera.Fov = TargetCamera.CockpitFov * 1 / zoom;
            if (d > AdaptiveThreshold)
            {
                targetCamera.Near = d / 2;
                targetCamera.Far = d * 2;
            }
            else
            {
                targetCamera.Near = ConstantNear;
                targetCamera.Far = ConstantFar;
            }
            return zoom;
        }
    }

    /// <summary>
    /// cockpit.ts CockpitEntity.render2D: the cockpit overlay below the HUD -
    /// the attitude indicator (bottom centre), MFD1 the tactical display with
    /// the moving map under its scope (bottom left), MFD2 the target display
    /// (bottom right), and the GEAR / FLAPS / ... stack beside MFD1. Paints
    /// only through <see cref="ICanvasPainter"/>; the target camera's 3D image
    /// is the frontend's (see <see cref="CockpitFrame.Mfd2"/>).
    /// </summary>
    public sealed class CockpitRenderer
    {
        /// <summary>TACTICAL_SCAN_INTERVAL: seconds between rescans of the scene for designatable targets.</summary>
        public const double TacticalScanInterval = 0.5;

        private readonly MovingMapSource mapSource;
        private readonly MovingMapRenderer movingMap;
        private bool movingMapShown;

        // refreshVisualState
        private double aiPitch;
        private double aiRoll;
        private double ownHeading;
        private double targetRange; // Km
        private double targetBearing; // degrees, 0 north, clockwise
        private double targetZoomFactor = 1;
        private bool targetAirborne;
        private double targetDirX;
        private double targetDirY;
        private double targetOffAxis;
        private double targetSpeedMps;
        private double targetLoadG = 1;
        private double targetHealth = 1;
        private double targetStickPitch;
        private double targetStickRoll;
        private double targetThrottle;

        /// <param name="mapSource">The chart; null for an aircraft without one (the map option is then a no-op).</param>
        public CockpitRenderer(MovingMapSource mapSource = null)
        {
            this.mapSource = mapSource;
            movingMap = mapSource?.Tiles == null ? null : new MovingMapRenderer(mapSource.Tiles, mapSource.Rasters);
        }

        /// <summary>
        /// The target camera (game.ts targetCamera, aspect 1): posed every frame
        /// a target is designated, as updateTargetCamera does from render2D.
        /// Its Position / Quaternion / Fov / Near / Far drive the camera that
        /// renders into MFD2.
        /// </summary>
        public readonly CameraPose TargetCameraPose = new CameraPose(TargetCamera.CockpitFov, 1, TargetCamera.PlaneDistanceToGround, TargetCamera.CockpitFar);

        /// <summary>The map renderer (its raster cache), or null without a source.</summary>
        public MovingMapRenderer MovingMap => movingMap;

        /// <summary>Whether the aircraft carries a chart to show at all.</summary>
        public bool MovingMapAvailable => movingMap != null && mapSource.Tiles.ZoomMax >= mapSource.Tiles.ZoomMin;

        /// <summary>The MFD's map option (the M key toggles it).</summary>
        public bool MovingMapEnabled => movingMapShown && MovingMapAvailable;

        /// <summary>A no-op without a chart to show.</summary>
        public void SetMovingMapEnabled(bool on) => movingMapShown = on && MovingMapAvailable;

        /// <summary>
        /// render2D: paint one frame of the cockpit overlay for a
        /// <paramref name="targetWidth"/> x <paramref name="targetHeight"/> canvas.
        /// </summary>
        public CockpitFrame Render(double targetWidth, double targetHeight, CockpitInputs a, ICanvasPainter painter, CockpitFrame frame = null)
        {
            frame ??= new CockpitFrame();
            RefreshVisualState(a);

            double layoutScale = CockpitFormat.LayoutScale(targetWidth, targetHeight);
            HudFont font = layoutScale > 1 ? HudFont.Large : HudFont.Small;
            string hudColor = a.Colors.HudText;

            RenderAttitudeIndicator(targetWidth, targetHeight, layoutScale, painter, a.Colors);

            double mfdSize = CockpitLayout.MfdSize(targetHeight, targetWidth);
            frame.Mfd1 = new CockpitViewport
            {
                X = CockpitLayout.Mfd1X(targetWidth, targetHeight, mfdSize),
                Y = CockpitLayout.Mfd1Y(targetWidth, targetHeight, mfdSize),
                Size = mfdSize,
            };
            frame.Mfd2 = new CockpitViewport
            {
                X = CockpitLayout.Mfd2X(targetWidth, targetHeight, mfdSize),
                Y = CockpitLayout.Mfd2Y(targetWidth, targetHeight, mfdSize),
                Size = mfdSize,
            };
            frame.MovingMapDrawn = false;
            RenderMfd1(frame, frame.Mfd1.X, frame.Mfd1.Y, mfdSize, a, painter, font, hudColor);
            RenderMfd2(frame.Mfd2.X, frame.Mfd2.Y, mfdSize, a, painter, hudColor, font);

            (double gearX, double gearY) = CockpitFormat.DeviceStatusPosition(targetHeight, mfdSize, font);
            CockpitFormat.RenderDeviceStatus(a, gearX, gearY, painter, hudColor, font);

            frame.TargetCamera = a.Target != null ? TargetCameraPose : null;
            frame.TargetZoomFactor = a.Target != null ? targetZoomFactor : 0;
            frame.HeadingDeg = ownHeading;
            return frame;
        }

        private void RefreshVisualState(CockpitInputs a)
        {
            Vec3d displayPos = a.DisplayPosition;
            Quatd displayQuat = a.DisplayQuaternion;

            Vec3d forward = new Vec3d(0, 0, 1).Rotate(displayQuat);
            ownHeading = CockpitAttitude.VectorHeading(new Vec3d(forward.X, 0, forward.Z).Normalized());

            (aiPitch, aiRoll) = CockpitAttitude.PitchRoll(displayQuat);

            CockpitTarget t = a.Target;
            if (t != null)
            {
                targetAirborne = t.Airborne;

                Vec3d v = t.Position - displayPos;
                targetRange = v.Length / 1000.0;
                targetBearing = CockpitAttitude.VectorHeading(new Vec3d(v.X, 0, v.Z).Normalized());

                // Enemy direction in the aircraft body frame: +X right, +Y up, +Z the nose.
                Vec3d w = (t.Position - displayPos).Rotate(displayQuat.Conjugate());
                double perp = JsMath.Hypot(w.X, w.Y);
                if (perp > 1e-3)
                {
                    targetDirX = -w.X / perp;
                    targetDirY = -w.Y / perp;
                }
                else
                {
                    targetDirX = 0;
                    targetDirY = 0;
                }
                targetOffAxis = Math.Min(1, JsTrig.Atan2(perp, w.Z) / (Math.PI / 2));

                targetZoomFactor = CockpitTargetCamera.Update(displayPos, t, a.MainCamera, TargetCameraPose);

                targetSpeedMps = t.SpeedMps ?? 0;
                targetLoadG = t.LoadFactorG ?? 1;
                targetHealth = t.HealthFraction ?? 1;
                targetStickPitch = t.StickPitch ?? 0;
                targetStickRoll = t.StickRoll ?? 0;
                targetThrottle = t.Throttle ?? 0;
            }
        }

        private void RenderAttitudeIndicator(double targetWidth, double targetHeight, double scale, ICanvasPainter painter, CockpitColors colors)
        {
            double halfWidth = targetWidth / 2;

            double aiSize = 29 * scale;
            double aiSizeHalf = Math.Floor(aiSize / 2);
            double aiX = halfWidth - aiSizeHalf;
            double aiY = targetHeight - aiSize + 1;
            double aiXMax = aiX + aiSize - 1;
            double aiYMax = aiY + aiSize - 1;
            double aiCenterX = aiX + aiSizeHalf;
            double aiCenterY = aiY + aiSizeHalf;

            double offset = aiPitch / (Math.PI / 2);
            Vec3d normal = new Vec3d(-0.0, -0.0, -1).Rotate(Quatd.FromAxisAngle(new Vec3d(0, 1, 0), aiRoll));
            Vec3d center = new Vec3d(aiCenterX, 0, aiCenterY).AddScaled(normal, -offset * aiSize);
            normal = normal * aiSizeHalf;

            double c0X = Math.Floor(center.X + normal.Z);
            double c0Y = JsMath.Round(center.Z + -normal.X);
            double c1X = Math.Floor(center.X + -normal.Z);
            double c1Y = JsMath.Round(center.Z + normal.X);

            painter.SetBackground("#404042");
            painter.Rectangle(aiX - 2, aiY - 2, aiSize + 3, aiSize + 3, true);

            IClipPainter clip = painter.Clip().Circle(aiCenterX, aiCenterY, aiSizeHalf).Clip();

            painter.SetColor(colors.AiGround);

            painter.SetBackground(colors.AiSky);
            painter.Rectangle(aiX, aiY, aiSize - 1, aiSize - 1, true);

            painter.SetBackground(colors.AiGround);
            if (c0X < c1X)
            {
                if (c0X > aiX && c0Y < aiYMax)
                {
                    painter.Rectangle(aiX, c0Y, c0X - aiX, aiYMax - c0Y, true);
                }
                if (c1X < aiXMax && c1Y < aiYMax)
                {
                    painter.Rectangle(c1X + 1, c1Y, aiXMax - c1X - 1, aiYMax - c1Y, true);
                }
                double cY = Math.Max(c0Y, c1Y);
                if (c1Y < aiYMax)
                {
                    painter.Rectangle(c0X, cY, c1X - c0X + 1, aiYMax - cY, true);
                }
            }
            else
            {
                if (c1X > aiX && c1Y > aiY)
                {
                    painter.Rectangle(aiX, aiY, c1X - aiX, c1Y - aiY, true);
                }
                if (c0X < aiXMax && c0Y > aiY)
                {
                    painter.Rectangle(c0X + 1, aiY, aiXMax - c0X - 1, c0Y - aiY, true);
                }
                double cY = Math.Min(c0Y, c1Y);
                if (cY > aiY)
                {
                    painter.Rectangle(c1X, aiY, c0X - c1X + 1, cY - aiY, true);
                }
            }

            painter.RightTriangle(Math.Floor(c0X), JsMath.Round(c0Y), Math.Floor(c1X), JsMath.Round(c1Y));

            clip.Clear();

            painter.SetColor("#ffffff");
            painter.Batch()
                .HLine(-1 + aiCenterX - 8, -1 + aiCenterX - 4, aiCenterY - 2)
                .HLine(aiCenterX + 4, aiCenterX + 8, aiCenterY - 2)
                .Line(-1 + aiCenterX - 4, aiCenterY - 2, -1 + aiCenterX, aiCenterY + 2)
                .Line(aiCenterX, aiCenterY + 2, aiCenterX + 4, aiCenterY - 2)
                .Commit();
        }

        /// <summary>
        /// The tactical display: ownship at the centre of a heading-up scope,
        /// range rings on the ladder range that holds the lock, one blip per
        /// designatable target; contacts past the range tick the rim.
        /// </summary>
        private void RenderMfd1(CockpitFrame frame, double x, double y, double size, CockpitInputs a, ICanvasPainter painter, HudFont font, string hudColor)
        {
            painter.SetColor(hudColor);
            painter.Rectangle(x - 1, y - 1, size + 2, size + 2);
            painter.SetBackground(a.Colors.MfdBackground);
            painter.Rectangle(x, y, size, size, true);

            string secondary = a.Colors.HudTextSecondary;
            double pad = font.CharSpacing;
            double line = font.CharHeight + font.CharSpacing;
            double radius = Math.Max(4, Math.Floor((size - line - pad) / 2) - 1);
            double centerX = x + Math.Floor(size / 2);
            double centerY = y + pad + radius;
            double rangeKm = TacticalScope.Range(a.Target != null ? targetRange : (double?)null);
            frame.ScopeRangeKm = rangeKm;

            if (MovingMapEnabled)
            {
                RenderMovingMap(x, y, size, centerX, centerY, radius, rangeKm, a, painter);
                frame.MovingMapDrawn = true;
                painter.Text(font, x + size - pad, y + pad, "MAP", secondary, TextAlignment.Right);
            }
            RenderTacticalScope(centerX, centerY, radius, painter, font, hudColor, secondary);
            RenderTacticalContacts(centerX, centerY, radius, rangeKm, size, a, painter, hudColor, secondary);
            RenderTacticalOwnship(centerX, centerY, size, painter, hudColor);

            double textY = y + size - font.CharHeight - pad;
            painter.Text(font, x + pad, textY, JsText.NumberToString(rangeKm) + " KM", hudColor);
            painter.Text(font, x + size - pad, textY, JsText.NumberToString(a.Contacts.Count) + " TGT", secondary, TextAlignment.Right);
        }

        /// <summary>The chart under the scope, heading-up, clipped to the MFD face.</summary>
        private void RenderMovingMap(double x, double y, double size, double centerX, double centerY,
            double radius, double rangeKm, CockpitInputs a, ICanvasPainter painter)
        {
            if (movingMap == null || mapSource == null) return;
            Vec3d p = a.DisplayPosition;
            Geodetic here = Geodesy.WorldToGeodetic(mapSource.Basis, p.X, p.Y, p.Z);
            IClipPainter clip = painter.Clip().Rectangle(x, y, size + 1, size + 1).Clip();
            movingMap.Render(painter, new MovingMapView
            {
                CenterX = centerX,
                CenterY = centerY,
                PixelsPerMetre = radius / (rangeKm * 1000),
                HalfExtentPx = Math.Max(Math.Max(centerX - x, centerY - y), Math.Max(x + size - centerX, y + size - centerY)),
                LatDeg = here.Lat,
                LonDeg = here.Lon,
                HeadingDeg = ownHeading,
                WaterColor = a.Colors.TerrainWater,
            });
            clip.Clear();
        }

        /// <summary>Range rings, boresight cross, and the north index.</summary>
        private void RenderTacticalScope(double centerX, double centerY, double radius,
            ICanvasPainter painter, HudFont font, string hudColor, string secondary)
        {
            painter.SetColor(secondary);
            painter.Circle(centerX, centerY, radius);
            painter.Circle(centerX, centerY, Math.Floor(radius / 2));
            painter.Batch()
                .VLine(centerX, centerY - radius, centerY + radius)
                .HLine(centerX - radius, centerX + radius, centerY)
                .Commit();

            // Heading-up, so north swings around with the aircraft.
            double heading = ownHeading * Math.PI / 180;
            double northX = -JsTrig.Sin(heading);
            double northY = -JsTrig.Cos(heading);
            double tick = Math.Max(2, JsMath.Round(radius * 0.16));
            painter.SetColor(hudColor);
            painter.Line(
                JsMath.Round(centerX + northX * (radius - tick)),
                JsMath.Round(centerY + northY * (radius - tick)),
                JsMath.Round(centerX + northX * radius),
                JsMath.Round(centerY + northY * radius));
            double labelRadius = radius - tick - font.CharHeight;
            painter.Text(font,
                JsMath.Round(centerX + northX * labelRadius),
                JsMath.Round(centerY + northY * labelRadius - font.CharHeight / 2.0),
                "N", hudColor, TextAlignment.Center);
        }

        /// <summary>One blip per designatable target, in the heading-up scope frame.</summary>
        private void RenderTacticalContacts(double centerX, double centerY, double radius, double rangeKm,
            double size, CockpitInputs a, ICanvasPainter painter, string hudColor, string secondary)
        {
            Vec3d origin = a.DisplayPosition;
            double blipSize = Math.Max(2, Math.Min(8, JsMath.Round(size * 0.05)));
            double tick = Math.Max(2, JsMath.Round(radius * 0.1));

            foreach (CockpitTarget contact in a.Contacts)
            {
                TacticalPlot plot = TacticalScope.Plot(
                    contact.Position.X - origin.X,
                    contact.Position.Z - origin.Z,
                    ownHeading, rangeKm, radius);
                bool selected = ReferenceEquals(contact, a.Target);
                string color = selected ? hudColor : secondary;

                if (plot.OffScope)
                {
                    double inner = (radius - tick) / radius;
                    painter.SetColor(color);
                    painter.Line(
                        JsMath.Round(centerX + plot.X * inner),
                        JsMath.Round(centerY + plot.Y * inner),
                        JsMath.Round(centerX + plot.X),
                        JsMath.Round(centerY + plot.Y));
                    continue;
                }

                RenderTacticalBlip(
                    JsMath.Round(centerX + plot.X),
                    JsMath.Round(centerY + plot.Y),
                    blipSize, contact.Airborne, selected, painter, color);
            }
        }

        /// <summary>Airborne contacts are diamonds, ground installations squares; the lock is boxed.</summary>
        private static void RenderTacticalBlip(double px, double py, double blipSize, bool airborne,
            bool selected, ICanvasPainter painter, string color)
        {
            double half = Math.Max(1, Math.Floor(blipSize / 2));
            painter.SetColor(color);
            if (airborne)
            {
                painter.Batch()
                    .Line(px, py - half, px + half, py)
                    .Line(px + half, py, px, py + half)
                    .Line(px, py + half, px - half, py)
                    .Line(px - half, py, px, py - half)
                    .Commit();
            }
            else
            {
                painter.Rectangle(px - half, py - half, half * 2 + 1, half * 2 + 1);
            }
            if (selected)
            {
                double box = half + 2;
                painter.Rectangle(px - box, py - box, box * 2 + 1, box * 2 + 1);
            }
        }

        /// <summary>Fixed nose-up ownship marker at the scope centre.</summary>
        private static void RenderTacticalOwnship(double centerX, double centerY, double size, ICanvasPainter painter, string hudColor)
        {
            double arm = Math.Max(2, Math.Min(6, JsMath.Round(size * 0.05)));
            painter.SetColor(hudColor);
            painter.Batch()
                .Line(centerX, centerY - arm, centerX - arm, centerY + arm)
                .Line(centerX, centerY - arm, centerX + arm, centerY + arm)
                .Line(centerX - arm, centerY + arm, centerX + arm, centerY + arm)
                .Commit();
        }

        private void RenderMfd2(double x, double y, double size, CockpitInputs a, ICanvasPainter painter, string hudColor, HudFont font)
        {
            painter.SetColor(hudColor);
            painter.Rectangle(x - 1, y - 1, size + 2, size + 2);

            CockpitTarget t = a.Target;
            if (t == null)
            {
                painter.SetBackground(a.Colors.MfdBackground);
                painter.Rectangle(x, y, size, size, true);
                painter.Text(font, x + font.CharSpacing, y + size - font.CharHeight - font.CharSpacing, "No target", hudColor);
            }
            else
            {
                // The target camera's image shows through this hole.
                painter.Clear(x, y, size, size);
                double pad = font.CharSpacing;
                double line = font.CharHeight + font.CharSpacing;
                painter.Text(font, x + pad, y + pad, t.TargetType, hudColor);
                string locationLine = targetAirborne
                    ? (t.Maneuver ?? t.TargetLocation)
                    : "at " + t.TargetLocation;
                painter.Text(font, x + pad, y + pad + line, locationLine, hudColor);
                if (targetAirborne)
                {
                    RenderTargetDirectionMarker(x, y, size, painter, hudColor);
                    RenderTargetTelemetry(x, y, size, a, painter, font, hudColor);
                }
                painter.Text(font, x + pad, y + size - 2 * line,
                    "BRG " + CockpitFormat.FormatHeading(targetBearing), hudColor);
                painter.Text(font, x + size - pad, y + size - 2 * line,
                    JsText.ToFixed(targetZoomFactor, 0) + "x", hudColor, TextAlignment.Right);
                painter.Text(font, x + pad, y + size - font.CharHeight - pad,
                    "Range " + JsText.ToFixed(targetRange, 1) + " KM", hudColor);
            }
        }

        /// <summary>Speed, G, and hull bar for airborne weapons targets.</summary>
        private void RenderTargetTelemetry(double x, double y, double size, CockpitInputs a,
            ICanvasPainter painter, HudFont font, string hudColor)
        {
            double pad = font.CharSpacing;
            double line = font.CharHeight + font.CharSpacing;
            string warnColor = a.Colors.HudTextWarn;
            double ty = y + pad + line * 2;
            double speedKmh = JsMath.Round(targetSpeedMps * 3.6);
            painter.Text(font, x + pad, ty, "SPD " + JsText.NumberToString(speedKmh), hudColor);
            ty += line;
            string gColor = targetLoadG >= 4 || targetLoadG < 0 ? warnColor : hudColor;
            painter.Text(font, x + pad, ty, "G " + JsText.ToFixed(targetLoadG, 1), gColor);
            ty += line;

            RenderTargetControls(x, y, size, a, painter, font, hudColor);

            double barX = x + pad;
            double barY = ty + Math.Floor(font.CharHeight / 2.0) - 2;
            double barH = Math.Max(3, Math.Floor(font.CharHeight * 0.55));
            const string label = "HP";
            double labelW = label.Length * font.CharWidth + Math.Max(0, label.Length - 1) * font.CharSpacing;
            painter.Text(font, barX, ty, label, targetHealth <= 0.3 ? warnColor : hudColor);
            double trackX = barX + labelW + pad;
            // The right side is the enemy's control diagram.
            double controlWidth = Math.Max(18, Math.Min(48, JsMath.Round(size * 0.28)));
            double trackW = Math.Max(8, size - (trackX - x) - controlWidth - pad);
            painter.SetColor(hudColor);
            painter.Rectangle(trackX, barY, trackW, barH);
            double fillW = Math.Max(0, JsMath.Round(trackW * Math.Max(0, Math.Min(1, targetHealth))));
            if (fillW > 0)
            {
                painter.SetBackground(targetHealth <= 0.3 ? warnColor : hudColor);
                painter.Rectangle(trackX, barY, fillW, barH, true);
            }
        }

        /// <summary>
        /// Enemy stick and throttle in the HUD's visual language: cross-shaped
        /// stick travel, circular stick marker, a vertical throttle track and
        /// the engine label (MIL nn / AB1 / AB2).
        /// </summary>
        private void RenderTargetControls(double x, double y, double size, CockpitInputs a,
            ICanvasPainter painter, HudFont font, string hudColor)
        {
            double pad = font.CharSpacing;
            double line = font.CharHeight + font.CharSpacing;
            string secondary = a.Colors.HudTextSecondary;
            double arm = Math.Max(5, Math.Min(18, JsMath.Round(size * 0.09)));
            double gap = Math.Max(2, JsMath.Round(arm * 0.3));
            double centerX = x + size - pad - arm - 1;
            double centerY = y + pad + line * 3 + arm;

            // defs.ts PITCH_STICK_FWD_UNITS / PITCH_STICK_AFT_UNITS.
            const double fwdUnits = 20, aftUnits = 80;
            double pitchTotalUnits = fwdUnits + aftUnits;
            double pitchSpan = arm * 2;
            double pitchFwdTravel = Math.Max(2, JsMath.Round(pitchSpan * fwdUnits / pitchTotalUnits));
            double pitchAftTravel = Math.Max(2, pitchSpan - pitchFwdTravel);
            double rollTravel = Math.Max(2, arm - 2);
            double pitch = Math.Max(-1, Math.Min(1, targetStickPitch));
            double roll = Math.Max(-1, Math.Min(1, targetStickRoll));
            double throttle = Math.Max(0, Math.Min(1, targetThrottle));

            painter.SetColor(secondary);
            painter.Batch()
                .HLine(centerX - arm, centerX + arm, centerY)
                .VLine(centerX, centerY - pitchFwdTravel, centerY + pitchAftTravel)
                .Commit();

            double pitchOffset = pitch >= 0 ? pitch * pitchAftTravel : pitch * pitchFwdTravel;
            painter.SetColor(hudColor);
            painter.Circle(
                JsMath.Round(centerX + roll * rollTravel),
                JsMath.Round(centerY + pitchOffset),
                Math.Max(1, JsMath.Round(arm * 0.18)));

            double throttleX = centerX - arm - gap;
            painter.SetColor(secondary);
            painter.VLine(throttleX, centerY - arm, centerY + arm);
            painter.SetColor(hudColor);
            double throttleY = JsMath.Round(centerY + arm - throttle * arm * 2);
            painter.HLine(throttleX - 1, throttleX + 1, throttleY);

            painter.Text(font, centerX, centerY + pitchAftTravel + gap,
                F16Engine.HudText(throttle), hudColor, TextAlignment.Center);
        }

        /// <summary>
        /// Off-boresight cue: a needle from the MFD centre toward the enemy as
        /// seen down the nose, growing to the rim at 90 degrees or more, with a
        /// small square at its tip.
        /// </summary>
        private void RenderTargetDirectionMarker(double x, double y, double size, ICanvasPainter painter, string hudColor)
        {
            if (targetOffAxis <= 0) return;
            double centerX = JsMath.Round(x + size / 2);
            double centerY = JsMath.Round(y + size / 2);
            double tipRadius = size * 0.42 * targetOffAxis;
            double tipX = JsMath.Round(centerX + targetDirX * tipRadius);
            double tipY = JsMath.Round(centerY + targetDirY * tipRadius);
            double markerSize = Math.Max(3, JsMath.Round(size * 0.1));
            double half = Math.Floor(markerSize / 2);
            painter.SetColor(hudColor);
            painter.Line(centerX, centerY, tipX, tipY);
            painter.Rectangle(tipX - half, tipY - half, markerSize, markerSize);
        }
    }
}
