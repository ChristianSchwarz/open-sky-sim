using System;
using System.Collections.Generic;

namespace Retro.Game
{
    /// <summary>__kernelStats: the frame's logic and render time (ms).</summary>
    public sealed class PerfKernelStats
    {
        public double UpdateMs;
        public double RenderMs;
    }

    /// <summary>One entry of __drawStats: one render pass's draw calls and triangles.</summary>
    public sealed class PerfDrawPass
    {
        public double Calls;
        public double Triangles;
    }

    /// <summary>
    /// __terrainStats as the perf readout uses it (planet/debug.ts). Optional
    /// fields are null when the terrain does not report them.
    /// </summary>
    public sealed class PerfTerrainStats
    {
        /// <summary>Tiles drawn.</summary>
        public double Drawn;
        /// <summary>Terrain triangles drawn.</summary>
        public double Triangles;
        /// <summary>The LOD governor's detail scale.</summary>
        public double DetailScale;
        /// <summary>Which tier answered the last CPU height query: "fine", "coarse", "none"; null shows "?".</summary>
        public string HeightTier;
        public double? Queued;
        public double? CacheBytes;
        public double? Failed;
        public double? Textured;
        public double? RoadTiles;
        public double? RoadTriangles;
        public double? BridgeTiles;
        public double? BridgeTriangles;
        public double? BuildingTiles;
        public double? BuildingShownTriangles;
        public bool TriangleBudgetHit;
    }

    /// <summary>The perf globals the F9 readout shows; each section null when absent.</summary>
    public sealed class PerfStats
    {
        public PerfKernelStats Kernel;
        /// <summary>__drawStats values in insertion order (one per render pass), or null.</summary>
        public IReadOnlyList<PerfDrawPass> Draw;
        public PerfTerrainStats Terrain;
    }

    /// <summary>
    /// The F9 perf readout (port of scene/entities/overlay/perfHud.ts,
    /// PerfHudEntity): frame-time EMA and FPS, kernel times, draw totals and
    /// the terrain streaming state, right-aligned on a black box top right.
    /// </summary>
    public sealed class PerfHud
    {
        /// <summary>FRAME_EMA_ALPHA.</summary>
        private const double FrameEmaAlpha = 0.1;

        private double frameEmaMs = 1000.0 / 60;

        /// <summary>PerfHudEntity.update: feeds the frame time (seconds) into the EMA.</summary>
        public void Update(double delta)
        {
            double ms = delta * 1000;
            frameEmaMs += (ms - frameEmaMs) * FrameEmaAlpha;
        }

        private static string Num(double x) => JsText.NumberToString(x);

        public void Render2D(double targetWidth, double targetHeight, PerfStats stats, Palette palette, ICanvasPainter painter)
        {
            double layoutScale = OverlayUtils.GetOverlayLayout(targetWidth, targetHeight).LayoutScale;
            HudFont font = layoutScale > 1 ? HudFont.Medium : HudFont.Small;
            string hudColor = palette.Color(PaletteCategory.HUD_TEXT);
            double lineHeight = font.CharHeight + 2;

            var lines = new List<string>();
            double fps = frameEmaMs > 0 ? 1000 / frameEmaMs : 0;
            lines.Add(JsText.ToFixed(fps, 0) + " FPS " + JsText.ToFixed(frameEmaMs, 1) + "ms");

            if (stats?.Kernel != null)
            {
                lines.Add("LOG " + JsText.ToFixed(stats.Kernel.UpdateMs, 1) + " RND " + JsText.ToFixed(stats.Kernel.RenderMs, 1) + "ms");
            }

            if (stats?.Draw != null)
            {
                double calls = 0;
                double triangles = 0;
                foreach (PerfDrawPass entry in stats.Draw)
                {
                    calls += entry.Calls;
                    triangles += entry.Triangles;
                }
                lines.Add(Num(calls) + " DRW " + JsText.ToFixed(triangles / 1000, 1) + "K TRI");
            }

            PerfTerrainStats t = stats?.Terrain;
            if (t != null)
            {
                string budgetSuffix = t.TriangleBudgetHit ? " BUDGET" : "";
                lines.Add("TER " + Num(t.Drawn) + "T " + JsText.ToFixed(t.Triangles / 1000, 1) + "K"
                    + " D" + JsText.ToFixed(t.DetailScale, 2) + budgetSuffix);
                double mb = (t.CacheBytes ?? 0) / 1048576;
                string failSuffix = (t.Failed ?? 0) > 0 ? " F" + Num(t.Failed.Value) : "";
                string texSuffix = (t.Textured ?? 0) > 0 ? " TEX" + Num(t.Textured.Value) : "";
                string roadSuffix = (t.RoadTiles ?? 0) > 0
                    ? " RD" + Num(t.RoadTiles.Value) + "/" + JsText.ToFixed((t.RoadTriangles ?? 0) / 1000, 1) + "K" : "";
                string bridgeSuffix = (t.BridgeTiles ?? 0) > 0
                    ? " BR" + Num(t.BridgeTiles.Value) + "/" + JsText.ToFixed((t.BridgeTriangles ?? 0) / 1000, 1) + "K" : "";
                string buildingSuffix = (t.BuildingTiles ?? 0) > 0
                    ? " BL" + Num(t.BuildingTiles.Value) + "/" + JsText.ToFixed((t.BuildingShownTriangles ?? 0) / 1000, 1) + "K" : "";
                lines.Add("Q" + Num(t.Queued ?? 0) + " " + JsText.ToFixed(mb, 0) + "MB " + (t.HeightTier ?? "?")
                    + failSuffix + texSuffix + roadSuffix + bridgeSuffix + buildingSuffix);
            }

            const double pad = 2;
            double boxWidth = double.NegativeInfinity;
            foreach (string line in lines)
            {
                boxWidth = Math.Max(boxWidth, line.Length * font.CharWidth + Math.Max(0, line.Length - 1) * font.CharSpacing);
            }
            boxWidth += pad * 2;
            double boxHeight = lines.Count * lineHeight + pad * 2;
            double right = targetWidth - pad;
            painter.SetBackground("#000000");
            painter.Rectangle(targetWidth - boxWidth, 0, boxWidth, boxHeight, true);

            double y = pad + 1;
            foreach (string line in lines)
            {
                painter.Text(font, right, y, line, hudColor, TextAlignment.Right);
                y += lineHeight;
            }
        }
    }
}
