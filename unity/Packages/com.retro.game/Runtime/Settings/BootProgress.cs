using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>bootProgress.ts BootStage: where the boot bar stands (percent) and what it says.</summary>
    public readonly struct BootStage
    {
        public readonly double Percent;
        public readonly string Label;

        public BootStage(double percent, string label)
        {
            Percent = percent;
            Label = label;
        }

        public override string ToString() => $"{Percent}% {Label}";
    }

    /// <summary>
    /// bootProgress.ts: the boot overlay's stages and labels, the terrain and
    /// first-bake progress in between, and the streaming hold after boot with
    /// its "get ready" countdown. Drawing it is the host's business: a full
    /// screen bar while booting, the same bar over a blurred live view while
    /// streaming (<see cref="StreamBar"/>), then a fade and the countdown.
    /// </summary>
    public static class BootProgress
    {
        public static readonly BootStage Start = new BootStage(0, "Loading...");
        public static readonly BootStage Renderer = new BootStage(5, "Initializing renderer...");
        public static readonly BootStage AircraftPacks = new BootStage(15, "Loading aircraft packs...");
        public static readonly BootStage Scene = new BootStage(25, "Building scene...");
        public static readonly BootStage Terrain = new BootStage(35, "Loading terrain...");
        public static readonly BootStage TerrainTiles = new BootStage(45, "Loading terrain tiles...");
        public static readonly BootStage TerrainMeshes = new BootStage(50, "Building terrain meshes...");
        public static readonly BootStage Airfields = new BootStage(60, "Loading airfields...");
        public static readonly BootStage Airbase = new BootStage(68, "Loading airbase...");
        public static readonly BootStage Scenery = new BootStage(75, "Loading scenery...");
        public static readonly BootStage Aircraft = new BootStage(90, "Loading aircraft...");
        public static readonly BootStage Ready = new BootStage(100, "Ready");

        /// <summary>
        /// bootProgress.ts BOOT_STAGES by TS key, in the order the web game
        /// passes them. Between "aircraft" and "ready" the bar runs through
        /// <see cref="TerrainRangeMin"/>..<see cref="TerrainRangeMax"/> as the
        /// terrain under the spawn meshes (<see cref="TerrainBootStage"/>); a
        /// first boot with no terrain shows the bake (<see cref="BootstrapBakeStage"/>)
        /// before "terrain".
        /// </summary>
        public static readonly IReadOnlyList<KeyValuePair<string, BootStage>> Stages = new[]
        {
            new KeyValuePair<string, BootStage>("start", Start),
            new KeyValuePair<string, BootStage>("renderer", Renderer),
            new KeyValuePair<string, BootStage>("aircraftPacks", AircraftPacks),
            new KeyValuePair<string, BootStage>("scene", Scene),
            new KeyValuePair<string, BootStage>("terrain", Terrain),
            new KeyValuePair<string, BootStage>("terrainTiles", TerrainTiles),
            new KeyValuePair<string, BootStage>("terrainMeshes", TerrainMeshes),
            new KeyValuePair<string, BootStage>("airfields", Airfields),
            new KeyValuePair<string, BootStage>("airbase", Airbase),
            new KeyValuePair<string, BootStage>("scenery", Scenery),
            new KeyValuePair<string, BootStage>("aircraft", Aircraft),
            new KeyValuePair<string, BootStage>("ready", Ready),
        };

        /// <summary>BOOT_TERRAIN_RANGE: the stretch of the bar the pinned terrain fills.</summary>
        public const double TerrainRangeMin = 90;
        public const double TerrainRangeMax = 99;

        /// <summary>RESPAWN_STAGE: the blurred pane over a respawn before the streaming hold.</summary>
        public static readonly BootStage Respawn = new BootStage(0, "Loading terrain...");

        /// <summary>How long the terrain backlog must stay empty before the blur lifts, ms.</summary>
        public const double StreamSettleMs = 600;
        /// <summary>The blur lifts after this even if streaming never goes quiet, ms.</summary>
        public const double StreamHoldMaxMs = 20000;
        /// <summary>Seconds counted down, still paused, once streaming has settled; "Go" follows.</summary>
        public const int StreamCountdownFrom = 3;
        /// <summary>How long "Go" stays up over the running flight, ms.</summary>
        public const double StreamGoShownMs = 800;
        /// <summary>Fastest the streaming bar may advance, fraction of full per second.</summary>
        public const double StreamBarRatePerS = 0.5;

        /// <summary>terrainBootStage: meshed of total tiles across [min, max].</summary>
        public static BootStage TerrainBootStage(double meshed, double total, double min, double max)
        {
            double frac = total > 0 ? meshed / total : 1;
            return new BootStage(min + (max - min) * frac,
                total > 0
                    ? $"Loading terrain ({JsText.NumberToString(meshed)}/{JsText.NumberToString(total)})..."
                    : "Loading terrain...");
        }

        /// <summary>
        /// bootstrapBakeStage: the dev server baking the first terrain. Absent
        /// fields are null and print as the TS template prints undefined.
        /// </summary>
        public static BootStage BootstrapBakeStage(
            string name, string step, double? stepIndex, double? stepCount, double? percent)
        {
            double count = Math.Max(1, stepCount ?? 1);
            double overall = (((stepIndex ?? 0) + (percent ?? 0) / 100) / count) * 100;
            return new BootStage(Math.Min(99, overall),
                $"No terrain yet - baking {name ?? "undefined"} (step {JsText.NumberToString((stepIndex ?? 0) + 1)}/"
                + $"{JsText.NumberToString(count)}: {step ?? "undefined"}). This runs once and can take a while.");
        }

        /// <summary>bootFailedStage: what the bar says when the boot throws.</summary>
        public static BootStage BootFailedStage(string message) => new BootStage(100, $"Load failed: {message}");

        /// <summary>streamingLabel: "Streaming terrain... 42%".</summary>
        public static string StreamingLabel(double shown) =>
            $"Streaming terrain... {JsText.NumberToString(Math.Floor(100 * shown))}%";

        /// <summary>countdownTexts: one a second, "3", "2", "1", then "Go".</summary>
        public static IReadOnlyList<string> CountdownTexts()
        {
            var output = new List<string>();
            for (int n = StreamCountdownFrom; n > 0; n--) output.Add(n.ToString(System.Globalization.CultureInfo.InvariantCulture));
            output.Add("Go");
            return output;
        }

        /// <summary>clampBootPercent: the overlay's fill, 0..100 (NaN stays NaN).</summary>
        public static double ClampBootPercent(double percent) => Math.Max(0, Math.Min(100, percent));
    }

    /// <summary>
    /// bootProgress.ts StreamBar: the streaming hold's bar. The backlog grows
    /// as the LOD pass finds more to want, so a plain backlog/peak ratio jumps
    /// back and forth; this counts what drained instead, never goes backwards,
    /// and moves at a capped rate so it reads as a steady sweep.
    /// </summary>
    public sealed class StreamBar
    {
        private readonly double start;
        private double prevBacklog;
        private double drained;
        private double lastTick;
        private double? idleSince;

        /// <param name="startMs">performance.now() when the hold began.</param>
        public StreamBar(double startMs)
        {
            start = startMs;
            lastTick = startMs;
        }

        /// <summary>0..1, what the bar and its label show.</summary>
        public double Shown { get; private set; }

        /// <summary>One frame at <paramref name="nowMs"/> with <paramref name="backlog"/> tiles still wanted; true once the hold should end.</summary>
        public bool Tick(double nowMs, double backlog)
        {
            drained += Math.Max(0, prevBacklog - backlog);
            prevBacklog = backlog;
            double target = backlog > 0 ? drained / (drained + backlog) : 1;
            double step = BootProgress.StreamBarRatePerS * (nowMs - lastTick) / 1000;
            lastTick = nowMs;
            Shown = Math.Min(Math.Max(Shown, target), Shown + step);
            if (backlog > 0) idleSince = null;
            else idleSince ??= nowMs;
            // Let the bar finish its sweep before clearing, so it never vanishes at 70%.
            bool settled = idleSince.HasValue && nowMs - idleSince.Value >= BootProgress.StreamSettleMs && Shown >= 1;
            return settled || nowMs - start >= BootProgress.StreamHoldMaxMs;
        }
    }
}
