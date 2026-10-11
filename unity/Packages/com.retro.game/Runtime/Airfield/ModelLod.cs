using System;

namespace Retro.Game
{
    /// <summary>Screen-size level of detail for scenery models (render/helpers.ts getLodLevel, resolveLodLevel).</summary>
    public static class ModelLod
    {
        public const int DefaultLodBias = 3;
        /// <summary>REF_WIDTH: the render width the level thresholds were tuned at, pixels.</summary>
        private const double RefWidth = 320;

        /// <summary>visibleWidthAtDistance: how wide the view is at a distance.</summary>
        public static double VisibleWidthAtDistance(double fovDeg, double aspect, double distance) =>
            aspect * 2 * Math.Tan(fovDeg * Math.PI / 180 / 2) * distance;

        /// <summary>The level a model of `maxSize` metres wants at `distance`, before resolving against what it has.</summary>
        public static int GetLodLevel(double distance, double fovDeg, double aspect, double targetWidthPx, double maxSize,
            int bias = DefaultLodBias)
        {
            if (maxSize == 0) return 0;
            double visible = VisibleWidthAtDistance(fovDeg, aspect, distance);
            if (visible == 0) return 0;
            double relativeSize = maxSize / visible;
            double scaled = relativeSize * (targetWidthPx / RefWidth);
            return scaled >= 1 ? 0 : Math.Max(0, (int)Math.Floor(-Math.Log(scaled, 2)) - bias);
        }

        /// <summary>
        /// resolveLodLevel for a model whose levels are all populated: past the
        /// last level a multi-level model is culled (-1), a single-level one stays.
        /// </summary>
        public static int Resolve(int requested, int levelCount)
        {
            if (levelCount == 0) return -1;
            if (requested >= levelCount) return levelCount > 1 ? -1 : 0;
            return requested;
        }
    }
}
