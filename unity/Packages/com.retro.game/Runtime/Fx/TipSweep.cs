using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>A wingtip (spread position) riding on a sweeping wing (wingSweep.ts TipSweep).</summary>
    public readonly struct TipSweep
    {
        public readonly Vec3d Spread;
        public readonly Vec3d Pivot;
        public readonly Vec3d Axis;
        /// <summary>Radians of rotation per unit of sweep (sign folded in).</summary>
        public readonly double RadPerUnit;

        public TipSweep(Vec3d spread, Vec3d pivot, Vec3d axis, double radPerUnit)
        {
            Spread = spread;
            Pivot = pivot;
            Axis = axis;
            RadPerUnit = radPerUnit;
        }

        /// <summary>
        /// tipSweepsFromDef: for the [left, right] wingtips of a swing-wing aircraft, the
        /// sweep surface each rides on - the unparented <c>sweep</c> surface on the same
        /// side (sign of pivot x equals sign of tip x) with the largest travel, so not a
        /// glove fairing. Null without two tips or without such a surface on either side.
        /// </summary>
        public static TipSweep[] FromDef(FlyableAircraftDef def)
        {
            double[][] tips = def.Wingtips;
            if (tips == null || tips.Length < 2) return null;
            TipSweep? Build(double[] tip)
            {
                ControlSurfaceDef best = null;
                foreach (ControlSurfaceDef w in def.Surfaces)
                {
                    if (w.Control != "sweep" || !string.IsNullOrEmpty(w.SweepParent)) continue;
                    if (Math.Sign(w.Pivot.X) == Math.Sign(tip[0]) && (best == null || w.RangeRad > best.RangeRad)) best = w;
                }
                return best == null ? (TipSweep?)null : new TipSweep(
                    new Vec3d(tip[0], tip[1], tip[2]), best.Pivot, best.Axis, best.Sign * best.RangeRad);
            }
            TipSweep? left = Build(tips[0]);
            TipSweep? right = Build(tips[1]);
            return left.HasValue && right.HasValue ? new[] { left.Value, right.Value } : null;
        }

        /// <summary>
        /// sweptTip: the tip's body-frame position at <paramref name="sweepUnit"/> [0, 1]. Like
        /// the oracle the axis is used as authored (three.js setFromAxisAngle does not
        /// normalise; every shipping pack's sweep axis is unit), unlike
        /// <see cref="WingSweep.PoseSurface"/>, which normalises.
        /// </summary>
        public Vec3d At(double sweepUnit)
        {
            Quatd q = Quatd.FromAxisAngle(Axis, RadPerUnit * sweepUnit);
            return (Spread - Pivot).Rotate(q) + Pivot;
        }
    }
}
