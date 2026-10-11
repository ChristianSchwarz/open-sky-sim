using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// What the aircraft fx read each frame, in scene axes (x east, y up, z south).
    /// The pose is the display (render-interpolated) one: FlightModel
    /// RenderPosition / RenderQuaternion / RenderVelocity, or the carrier-ride
    /// display transform for the player.
    /// </summary>
    public struct AircraftFxInput
    {
        /// <summary>
        /// Throttle lever [0, 1] (the player's throttle unit; an AI's sim throttle
        /// lever). 0.99 and up is AB1, 1 is AB2.
        /// </summary>
        public double ThrottleLever;
        /// <summary>FlightModel.UseAfterburnerThrottleDetents (the FM flies an AB quadrant).</summary>
        public bool AbDetents;
        public Vec3d Position;
        public Quatd Quaternion;
        public Vec3d Velocity;
        /// <summary>Current wing sweep [0, 1] (WingSweep.Step output); ignored without swing wings.</summary>
        public double WingSweep;
    }

    /// <summary>
    /// Shared exterior FX of a flyable aircraft, player or AI (port of
    /// aircraftFx.ts): afterburner plumes and wingtip trails, built from the
    /// same <see cref="FlyableAircraftDef"/>. Per frame: <see cref="Update"/>
    /// (may run more than once, as the web game calls it from the sim step and
    /// again from render), then <see cref="LayoutTrails"/> with the camera
    /// before drawing.
    /// </summary>
    public sealed class AircraftFx
    {
        private bool hasNozzles;
        private Vec3d thrustOrigin;
        private bool hasThrustOrigin;
        private TipSweep[] tipSweeps;

        public AfterburnerCones AfterburnerCones { get; } = new AfterburnerCones();

        /// <summary>Replaced on every <see cref="ConfigureFromDef"/>, like the oracle.</summary>
        public WingtipTrails WingtipTrails { get; private set; } = new WingtipTrails();

        /// <summary>Whether trail tips are known (from the def or the body model); trails draw only then.</summary>
        public bool WingtipsReady { get; private set; }

        /// <summary>configureFromDef: nozzles, tips and swing-wing tips from a def (load or swap).</summary>
        public void ConfigureFromDef(FlyableAircraftDef def)
        {
            WingtipsReady = false;
            WingtipTrails = new WingtipTrails();
            WingtipTrails.Reset();

            double[][] nozzles = def.Nozzles;
            hasNozzles = nozzles != null && nozzles.Length > 0;
            AfterburnerCones.SetNozzles(nozzles, def.NozzleRadius);

            hasThrustOrigin = hasNozzles;
            if (hasNozzles)
            {
                Vec3d sum = Vec3d.Zero;
                foreach (double[] n in nozzles) sum = sum + new Vec3d(n[0], n[1], n[2]);
                thrustOrigin = sum * (1.0 / nozzles.Length);
            }

            tipSweeps = TipSweep.FromDef(def);
            double[][] tips = def.Wingtips;
            if (tips != null && tips.Length >= 2)
            {
                WingtipTrails.SetTipOrigins(new Vec3d(tips[0][0], tips[0][1], tips[0][2]), new Vec3d(tips[1][0], tips[1][1], tips[1][2]));
                WingtipTrails.Reset();
                WingtipsReady = true;
            }
        }

        /// <summary>
        /// bindWingtipOrigins (onBodyModelLoaded / ensureBound): once the body model is
        /// loaded and the def gave no tips, derive them from LOD0's vertices (see
        /// <see cref="WingtipOrigins.Derive"/>). Pass nothing while no LOD is loaded.
        /// </summary>
        public void BindWingtipOrigins(ReadOnlySpan<float> lod0Positions)
        {
            if (WingtipsReady) return;
            if (WingtipOrigins.CountVertices(lod0Positions) < 8) return;
            var derived = WingtipOrigins.Derive(lod0Positions);
            if (!derived.HasValue) return;
            WingtipTrails.SetTipOrigins(derived.Value.Left, derived.Value.Right);
            WingtipTrails.Reset();
            WingtipsReady = true;
        }

        /// <summary>
        /// update: plumes when the FM has AB detents or the def has nozzles; trails
        /// (with swept tips on swing wings) once tips are known.
        /// </summary>
        public void Update(in AircraftFxInput input)
        {
            bool hasAfterburner = input.AbDetents || hasNozzles;
            AfterburnerCones.Update(input.ThrottleLever, hasAfterburner, input.Position, input.Quaternion);
            if (WingtipsReady)
            {
                if (tipSweeps != null)
                {
                    WingtipTrails.SetTipOrigins(tipSweeps[0].At(input.WingSweep), tipSweeps[1].At(input.WingSweep));
                }
                WingtipTrails.Update(input.Position, input.Quaternion, input.Velocity);
            }
        }

        /// <summary>addTrailsToRenderList: lay out the trail quads facing the camera (scene position).</summary>
        public void LayoutTrails(Vec3d cameraPosition)
        {
            if (WingtipsReady) WingtipTrails.Layout(cameraPosition);
        }

        /// <summary>Carry the trails into a re-based frame; the plumes are re-posed every frame.</summary>
        public void Rebase(FrameShift shift) => WingtipTrails.Rebase(shift);

        public void ResetTrails() => WingtipTrails.Reset();

        /// <summary>getThrustOrigin: the mean of the def's (unsymmetrised) nozzles; null without def nozzles.</summary>
        public Vec3d? ThrustOrigin => hasThrustOrigin ? thrustOrigin : (Vec3d?)null;
    }
}
