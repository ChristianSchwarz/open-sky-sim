using Retro.Core;
using System;

namespace Retro.Game
{
    // The plain collider records the game keeps beside its entities, as
    // src/script/scene/entities/{surfacePad,skiJump,carrierDeck}.ts define them,
    // carried here so worldRebase can be ported. Only the records and the pad's
    // height query; building them from meshes stays with the entity ports.

    /// <summary>Solid surface: an oriented rectangle, optionally sloping along its axis (surfacePad.ts).</summary>
    public sealed class SurfacePadCollider
    {
        /// <summary>World XZ of the pad centre.</summary>
        public double CenterX;
        public double CenterZ;
        /// <summary>Pad heading (rad); 0 = long axis aligned with +Z.</summary>
        public double Heading;
        /// <summary>Half extent along the pad axis (m).</summary>
        public double HalfLength;
        /// <summary>Half extent across the pad axis (m).</summary>
        public double HalfWidth;
        /// <summary>World Y of the surface top, at the pad centre.</summary>
        public double SurfaceY;
        /// <summary>World Y of the surrounding ground the edge skirt blends down to.</summary>
        public double BaseY;
        /// <summary>Horizontal skirt width beyond the pad edge (m).</summary>
        public double Feather;
        /// <summary>Rise in world Y per metre along the pad axis; null means level.</summary>
        public double? Slope;
    }

    public static class SurfacePad
    {
        /// <summary>World Y of the pad surface (or its feathered skirt) at a point, or -Infinity off it.</summary>
        public static double SampleSurfacePadY(double worldX, double worldZ, SurfacePadCollider pad)
        {
            return PadY(worldX, worldZ, pad, pad.Feather);
        }

        /// <summary>SampleSurfacePadY with the skirt `feather` metres wide; 0 is the footprint alone.</summary>
        private static double PadY(double worldX, double worldZ, SurfacePadCollider pad, double feather)
        {
            double cos = JsTrig.Cos(pad.Heading);
            double sin = JsTrig.Sin(pad.Heading);
            double dx = worldX - pad.CenterX;
            double dz = worldZ - pad.CenterZ;
            // World delta into pad local XZ: the inverse of the scene heading
            // convention, where +localZ is (sin h, cos h). heading 0 -> identity.
            double localX = dx * cos - dz * sin;
            double localZ = dx * sin + dz * cos;
            double outX = Math.Abs(localX) - pad.HalfWidth;
            double outZ = Math.Abs(localZ) - pad.HalfLength;
            double outside = Math.Max(outX, outZ);
            if (outside > 0 && outside >= feather) return double.NegativeInfinity;
            double surfaceY = pad.SurfaceY + (pad.Slope ?? 0) * localZ;
            if (outside <= 0) return surfaceY;
            return pad.BaseY + (surfaceY - pad.BaseY) * (1 - outside / feather);
        }
    }

    /// <summary>skiJump.ts SkiJumpCollider.</summary>
    public sealed class SkiJumpCollider
    {
        /// <summary>World XZ of the ramp origin (south/base end).</summary>
        public double OriginX;
        /// <summary>World Y of the ramp base.</summary>
        public double OriginY;
        public double OriginZ;
        /// <summary>Runway heading (rad); 0 = takeoff along +Z.</summary>
        public double Heading;
        public double Length;
        public double Height;
        public double HalfWidth;
    }

    public sealed class Aabb
    {
        public double[] Min = new double[3];
        public double[] Max = new double[3];
    }

    /// <summary>carrierDeck.ts CarrierMeshCollider: a local-frame triangle soup about a world origin.</summary>
    public sealed class CarrierMeshCollider
    {
        public double OriginX;
        public double OriginY;
        public double OriginZ;
        /// <summary>Local-frame triangle soup, x y z per vertex. Shared with the model it was baked from.</summary>
        public double[] Triangles = Array.Empty<double>();
        public Aabb Aabb = new Aabb();
    }
}
