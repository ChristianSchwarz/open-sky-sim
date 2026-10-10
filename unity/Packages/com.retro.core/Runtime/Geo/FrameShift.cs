using System;

namespace Retro.Core
{
    /// <summary>
    /// The rigid move that re-expresses scene coordinates of one ENU frame in
    /// another: p' = rotation * p + offset for points, rotation * v for
    /// directions, rotation * q for orientations. This is what a mid-flight
    /// re-base hands every holder of scene state (port of geodesy.ts FrameShift).
    /// </summary>
    public sealed class FrameShift
    {
        public readonly Quatd Rotation;
        public readonly Vec3d Offset;

        public FrameShift(Quatd rotation, Vec3d offset)
        {
            Rotation = rotation;
            Offset = offset;
        }

        public static FrameShift Between(EnuBasis from, EnuBasis to)
        {
            return new FrameShift(
                Geodesy.EnuFrameRotation(from, to),
                Geodesy.SceneFromEnu(Geodesy.EcefToEnu(to, from.Origin)));
        }

        public Vec3d Point(Vec3d p) => p.Rotate(Rotation) + Offset;

        public Vec3d Vector(Vec3d v) => v.Rotate(Rotation);

        /// <summary>An orientation (local to scene): premultiplied by the rotation.</summary>
        public Quatd Orientation(Quatd q) => Rotation * q;

        /// <summary>A scene heading (0 = +Z) turned into the new frame; the tilt is dropped.</summary>
        public double Heading(double h) => SlopedHeading(h, 0).Heading;

        /// <summary>A heading with a rise per metre along it, turned into the new frame.</summary>
        public (double Heading, double Slope) SlopedHeading(double h, double slope)
        {
            Vec3d d = Vector(new Vec3d(JsTrig.Sin(h), slope, JsTrig.Cos(h)));
            double run = JsMath.Hypot(d.X, d.Z);
            return (JsTrig.Atan2(d.X, d.Z), d.Y / run);
        }
    }
}
