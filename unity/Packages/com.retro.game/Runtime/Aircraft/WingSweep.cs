using System;
using Retro.Core;

namespace Retro.Game
{
    public enum WingSweepMode
    {
        Auto,
        Spread,
        Swept,
    }

    /// <summary>A hinge in the body frame and how far it is turned (wingSweep.ts SurfaceHinge).</summary>
    public struct SurfaceHinge
    {
        public Vec3d Pivot;
        public Vec3d Axis;
        public double Deflection;
    }

    /// <summary>Variable-geometry wings and hinged surface poses (port of wingSweep.ts).</summary>
    public static class WingSweep
    {
        private const double KnotsToMps = 0.514444;
        public static readonly SwingWingsDef Default = new SwingWingsDef { MinKias = 400, MaxKias = 500, TravelSeconds = 6 };

        /// <summary>The next mode in the Auto, Spread, Swept cycle (the N key).</summary>
        public static WingSweepMode Next(WingSweepMode mode) => (WingSweepMode)(((int)mode + 1) % 3);

        /// <summary>Target sweep for a mode; Auto follows the mod's schedule on true airspeed as indicated.</summary>
        public static double Target(WingSweepMode mode, double airspeed, SwingWingsDef cfg)
        {
            cfg ??= Default;
            switch (mode)
            {
                case WingSweepMode.Spread: return 0;
                case WingSweepMode.Swept: return 1;
                default:
                    double kias = airspeed / KnotsToMps;
                    double span = Math.Max(cfg.MaxKias - cfg.MinKias, 1e-3);
                    return Math.Min(1, Math.Max(0, (kias - cfg.MinKias) / span));
            }
        }

        /// <summary>Slew toward the target at the wing actuator's rate.</summary>
        public static double Step(double current, double target, double delta, SwingWingsDef cfg)
        {
            cfg ??= Default;
            double maxStep = delta / Math.Max(cfg.TravelSeconds, 1e-3);
            double diff = target - current;
            return Math.Abs(diff) <= maxStep ? target : current + Math.Sign(diff) * maxStep;
        }

        /// <summary>
        /// poseSurface: world pose of a hinged surface model. One on a sweeping
        /// wing (`parent`) is first carried round the wing's pivot, its hinge with
        /// it, then deflected about that moved hinge. Axes are normalised here; the
        /// web game hands three.js its authored, unnormalised axes, whose rotations
        /// come out slightly non-rigid.
        /// </summary>
        public static (Vec3d Position, Quatd Rotation) PoseSurface(
            SurfaceHinge hinge, SurfaceHinge? parent, Vec3d displayPosition, Quatd displayQuaternion)
        {
            Vec3d axis = hinge.Axis;
            Vec3d pivot = hinge.Pivot;
            Quatd hingeQ;
            if (parent.HasValue && parent.Value.Deflection != 0)
            {
                SurfaceHinge p = parent.Value;
                Quatd sweepQ = Quatd.FromAxisAngle(p.Axis.Normalized(), p.Deflection);
                axis = axis.Rotate(sweepQ);
                pivot = (pivot - p.Pivot).Rotate(sweepQ) + p.Pivot;
                hingeQ = Quatd.FromAxisAngle(axis.Normalized(), hinge.Deflection) * sweepQ;
            }
            else
            {
                hingeQ = Quatd.FromAxisAngle(axis.Normalized(), hinge.Deflection);
            }
            return (pivot.Rotate(displayQuaternion) + displayPosition, displayQuaternion * hingeQ);
        }
    }
}
