using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// The target-camera helpers the updaters call: updateTargetCamera
    /// (scene/utils.ts), restoreMainCameraParameters (state/stateUtils.ts),
    /// visibleWidthAtDistance (render/helpers.ts) and the defs.ts constants
    /// they use.
    /// </summary>
    public static class TargetCamera
    {
        public const double CockpitFov = 50;
        public const double PlaneDistanceToGround = 2.0;
        public const double CockpitFar = 550000;

        private const double TargetSizeFactor = 2.0;
        private const double TargetMaxSize = 250;
        private const double TargetCameraMinAltitude = 15;
        private const double TargetCameraAdaptiveThreshold = 5000;
        private const double TargetCameraConstantNear = 10;
        private const double TargetCameraConstantFar = 10000;

        /// <summary>restoreMainCameraParameters: the cockpit field of view and clip planes.</summary>
        public static void RestoreMainCameraParameters(CameraPose camera)
        {
            camera.Fov = CockpitFov;
            camera.Near = PlaneDistanceToGround;
            camera.Far = CockpitFar;
        }

        /// <summary>Visible width of the view frustum at a distance.</summary>
        public static double VisibleWidthAtDistance(CameraPose camera, double distance)
        {
            double fov = camera.Fov * (Math.PI / 180);
            return camera.Aspect * 2 * Math.Tan(fov / 2) * distance;
        }

        public static double VisibleWidthAtDistance(CameraPose camera, Vec3d position) =>
            VisibleWidthAtDistance(camera, Vec3d.Distance(camera.Position, position));

        /// <summary>
        /// Place `targetCamera` at the actor (no lower than 15 m), aimed at the
        /// weapons target, zoomed so the target fills a useful part of the view.
        /// Returns the zoom factor, 0 when there is no target.
        /// </summary>
        public static double UpdateTargetCamera(ICameraActor actor, CameraPose mainCamera, CameraPose targetCamera)
        {
            WeaponsTarget weaponsTarget = actor.WeaponsTarget;
            if (weaponsTarget == null) return 0;

            Vec3d actorPosition = actor.GetDisplayPosition();
            double d = Vec3d.Distance(actorPosition, weaponsTarget.Position);
            double weaponsTargetZoomFactor = GetWeaponsTargetZoomFactor(mainCamera, weaponsTarget, d);

            Vec3d position = actorPosition;
            position.Y = Math.Max(TargetCameraMinAltitude, actorPosition.Y);
            targetCamera.Position = position;
            targetCamera.LookAt(weaponsTarget.Position + weaponsTarget.LocalCenter);
            targetCamera.Fov = CockpitFov * 1 / weaponsTargetZoomFactor;
            if (d > TargetCameraAdaptiveThreshold)
            {
                targetCamera.Near = Vec3d.Distance(actorPosition, weaponsTarget.Position) / 2;
                targetCamera.Far = Vec3d.Distance(actorPosition, weaponsTarget.Position) * 2;
            }
            else
            {
                targetCamera.Near = TargetCameraConstantNear;
                targetCamera.Far = TargetCameraConstantFar;
            }
            return weaponsTargetZoomFactor;
        }

        private static double GetWeaponsTargetZoomFactor(CameraPose mainCamera, WeaponsTarget weaponsTarget, double distance)
        {
            double farWidth = VisibleWidthAtDistance(mainCamera, distance);
            double relativeSize = TargetSizeFactor * Math.Min(TargetMaxSize, weaponsTarget.MaxSize) / farWidth;
            return Math.Pow(2, relativeSize >= 1 ? 0 : Math.Max(0, FloorNegLog2(relativeSize)));
        }

        /// <summary>
        /// Math.floor(-Math.log2(x)), computed from the exponent bits:
        /// netstandard2.1 has no Math.Log2, and Math.Log(x, 2) is off by an ulp
        /// at exact powers of two, which is exactly where the floor turns.
        /// </summary>
        private static double FloorNegLog2(double x)
        {
            if (double.IsNaN(x) || x < 0) return double.NaN;
            if (x == 0) return double.PositiveInfinity;
            if (double.IsPositiveInfinity(x)) return double.NegativeInfinity;
            long bits = BitConverter.DoubleToInt64Bits(x);
            int biased = (int)((bits >> 52) & 0x7ff);
            long fraction = bits & 0xfffffffffffffL;
            int exponent;
            if (biased == 0)
            {
                // Subnormal: normalise the fraction.
                exponent = -1022;
                while ((fraction & (1L << 52)) == 0)
                {
                    fraction <<= 1;
                    exponent--;
                }
                fraction &= 0xfffffffffffffL;
            }
            else
            {
                exponent = biased - 1023;
            }
            // x = 1.f * 2^exponent, so -log2(x) = -exponent - log2(1.f), log2(1.f) in [0, 1).
            return fraction == 0 ? -exponent : -exponent - 1;
        }
    }
}
