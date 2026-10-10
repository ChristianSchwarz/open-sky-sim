using System;
using Retro.Core;

namespace Retro.Terrain
{
    /// <summary>
    /// Terrain LOD policy: screen-space error refinement, the far-field
    /// falloff, altitude caps and the frame-time governor (port of
    /// src/script/terrain/lod.ts). All distances in metres.
    /// </summary>
    public static class Lod
    {
        public const double SpaceSkyAltitudeM = 100000;
        public const double LeafRefineDistanceScale = 1.5;
        public const double LeafRefineDistanceScaleMin = 1;
        public const double LeafRefineDistanceScaleMax = 10;
        public const int TerrainVisibleZoomMin = 5;
        public const int TerrainVisibleZoomMax = 12;
        public const double TerrainDetailDistanceDefaultM = 12000;
        public const double TerrainDetailDistanceMinM = 2000;
        public const double TerrainDetailDistanceMaxM = 40000;
        /// <summary>Leaves refinement to screen space alone.</summary>
        public const double DetailDistanceOff = double.PositiveInfinity;
        public const double LodFadeNear = 0.55;
        public const double LodFadeSoftness = 0.08;
        public const double LodFadeMs = 600;
        public const double LodDepthPushScale = 1.5;
        public const double LanduseRevealMinPx = 6;
        public const double LanduseRevealMinPxMin = 1;
        public const double LanduseRevealMinPxMax = 24;
        public const double ReconcileIntervalMs = 100;
        public const double TargetFrameMs = 25;
        public const double DetailScaleMin = 1;
        public const double DetailScaleMax = 4;
        public const int TerrainTriangleBudget = 600000;
        public const int TerrainTriangleBudgetMin = 200000;
        public const int TerrainTriangleBudgetMax = 4000000;
        public const double TileUploadBudgetMs = 4;
        public const int StreamConcurrencyMin = 6;
        public const int StreamConcurrencyMax = 32;
        public const double PrefetchLookaheadS = 4;
        public const double PrefetchMinDistanceM = 3000;
        public const long MeshCacheBytes = 256L * 1024 * 1024;
        public const double CockpitFar = 550000;
        public const double TerrainViewRangeM0 = 450000;
        public const double TerrainViewRangeMaxM = 3000000;

        private const int TerrainZoomOffset = 1;
        private const double SseTargetPx = 1;
        private const double MaxViewTurnRateRadS = Math.PI;
        private const double DetailClimb = 1.06;
        private const double DetailDecay = 0.96;

        public static readonly double FrustumCullMarginRad = MaxViewTurnRateRadS * (ReconcileIntervalMs / 1000) * 1.2;
        public static readonly double FrustumCullMarginTan = Math.Tan(FrustumCullMarginRad);

        private static readonly double[][] ZoomAltitudeAnchorsM =
        {
            new double[] { 0, 12 },
            new double[] { 6000, 12 },
            new double[] { 15000, 11 },
            new double[] { 22000, 10 },
            new double[] { 35000, 8 },
            new double[] { 55000, 7 },
            new double[] { 80000, 6 },
            new double[] { 120000, 5 },
            new double[] { 200000, 4.5 },
            new double[] { 400000, 4 },
        };

        public static double ClampLeafRefineScale(double v) =>
            double.IsNaN(v) || double.IsInfinity(v) ? LeafRefineDistanceScale
            : Math.Min(LeafRefineDistanceScaleMax, Math.Max(LeafRefineDistanceScaleMin, v));

        /// <summary>max(1, d / knee); 1 when the knee is off.</summary>
        public static double DetailFalloff(double distanceM, double kneeM)
        {
            if (!(kneeM > 0)) return 1;
            return Math.Max(1, distanceM / kneeM);
        }

        /// <summary>The distance at which a tile with this error refines (with the falloff's sqrt past the knee).</summary>
        public static double RefineDistanceM(double geometricErrorM, double screenHeightPx, double fovYDeg,
            double detailScale = 1, double kneeM = DetailDistanceOff, double targetPx = SseTargetPx)
        {
            double a = geometricErrorM * screenHeightPx
                / (2 * Math.Tan(fovYDeg * Math.PI / 360) * targetPx * Math.Max(detailScale, 1e-6));
            if (!(kneeM > 0) || a <= kneeM) return Math.Max(0, a);
            return Math.Sqrt(a * kneeM);
        }

        public static double ClampLanduseRevealPx(double v) =>
            double.IsNaN(v) || double.IsInfinity(v) ? LanduseRevealMinPx
            : Math.Min(LanduseRevealMinPxMax, Math.Max(LanduseRevealMinPxMin, v));

        public static double LanduseRevealScale(double screenHeightPx, double fovYDeg, double minPx = LanduseRevealMinPx) =>
            screenHeightPx / (2 * Math.Tan(fovYDeg * Math.PI / 360)) / Math.Max(minPx, 1e-3);

        public static double ClampDetailDistanceM(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return DetailDistanceOff;
            if (v >= TerrainDetailDistanceMaxM) return DetailDistanceOff;
            return Math.Max(TerrainDetailDistanceMinM, v);
        }

        public static double ClampTriangleBudget(double v) =>
            double.IsNaN(v) || double.IsInfinity(v) ? TerrainTriangleBudget
            : Math.Min(TerrainTriangleBudgetMax, Math.Max(TerrainTriangleBudgetMin, JsMath.Round(v)));

        private static double GeometricHorizonDistanceM(double altitudeM, double radiusM = Geodesy.Wgs84A)
        {
            double h = Math.Max(0, altitudeM);
            return Math.Sqrt(Math.Max(0, 2 * radiusM * h + h * h));
        }

        public static double TerrainViewRangeM(double altitudeM)
        {
            double horizon = GeometricHorizonDistanceM(altitudeM) * 1.15;
            return Math.Min(TerrainViewRangeMaxM, Math.Max(TerrainViewRangeM0, horizon));
        }

        public static double CameraFarForAltitudeM(double altitudeM) => Math.Max(CockpitFar, TerrainViewRangeM(altitudeM) * 1.05);

        private static double ZoomCurveForAltitudeM(double altitudeM)
        {
            double h = Math.Max(0, altitudeM);
            double[][] anchors = ZoomAltitudeAnchorsM;
            if (h <= anchors[0][0]) return anchors[0][1];
            for (int i = 1; i < anchors.Length; i++)
            {
                double h1 = anchors[i - 1][0], z1 = anchors[i - 1][1];
                double h2 = anchors[i][0], z2 = anchors[i][1];
                if (h <= h2)
                {
                    double t = (h - h1) / (h2 - h1);
                    return z1 + (z2 - z1) * t;
                }
            }
            return anchors[anchors.Length - 1][1];
        }

        public static double TerrainMaxZoomForAltitudeM(double altitudeM, double absoluteMax, bool coastal = false)
        {
            double z = JsMath.Round(ZoomCurveForAltitudeM(altitudeM));
            double capped = Math.Min(absoluteMax, Math.Max(0, z));
            return coastal ? capped : Math.Max(0, capped - TerrainZoomOffset);
        }

        /// <summary>The frame-time governor: climb 6 % when slow, decay 4 % when fast, clamped to [1, 4].</summary>
        public static double AdjustDetailScale(double current, double frameEmaMs, double targetMs = TargetFrameMs)
        {
            double next = current;
            if (frameEmaMs > targetMs * 1.08) next = current * DetailClimb;
            else if (frameEmaMs < targetMs * 0.9) next = current * DetailDecay;
            return Math.Min(DetailScaleMax, Math.Max(DetailScaleMin, next));
        }

        /// <summary>Chord sagitta of a flat patch spanning the tile: how far an ocean stand-in sags below the ellipsoid.</summary>
        public static double EllipsoidSagittaM(TileKey id)
        {
            double arc = Tiling.ApproxEdgeMetres(id);
            return (arc * arc) / (8 * Geodesy.Wgs84A);
        }

        private static double ScreenSpaceErrorPx(double geometricErrorM, double distanceM, double screenHeightPx, double fovYDeg)
        {
            double d = Math.Max(1, distanceM);
            return geometricErrorM * screenHeightPx / (2 * d * Math.Tan(fovYDeg * Math.PI / 360));
        }

        public static bool ShouldRefine(double geometricErrorM, double distanceM, double screenHeightPx, double fovYDeg,
            double detailScale = 1, double targetPx = SseTargetPx)
        {
            return ScreenSpaceErrorPx(geometricErrorM, distanceM, screenHeightPx, fovYDeg) > targetPx * detailScale;
        }
    }
}
