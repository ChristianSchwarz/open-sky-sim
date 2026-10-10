using System;
using System.Collections.Generic;

namespace Retro.Sim
{
    /// <summary>Analytic ski-jump collider matching the lib:skiJump mesh (port of skiJump.ts).</summary>
    public sealed class SkiJumpCollider
    {
        /// <summary>World XZ of the ramp origin (south/base end).</summary>
        public double OriginX;
        /// <summary>World Y of the ramp base (matches the placed mesh).</summary>
        public double OriginY;
        public double OriginZ;
        /// <summary>Runway heading (rad); 0 = takeoff along +Z.</summary>
        public double Heading;
        public double Length;
        public double Height;
        public double HalfWidth;
    }

    /// <summary>Carrier-style ski-jump ramp: curved incline along the runway takeoff axis.</summary>
    public static class SkiJump
    {
        /// <summary>Ramp length along takeoff (+Z when heading=0), metres.</summary>
        public const double SkiJumpLengthM = 90;
        /// <summary>Tip height above flat deck, metres.</summary>
        public const double SkiJumpHeightM = 12;
        /// <summary>Ramp width across the runway, metres.</summary>
        public const double SkiJumpWidthM = 48;

        public static SkiJumpCollider CreateSkiJumpCollider(
            double originX, double originY, double originZ, double heading,
            double length = SkiJumpLengthM, double height = SkiJumpHeightM, double width = SkiJumpWidthM)
        {
            return new SkiJumpCollider
            {
                OriginX = originX,
                OriginY = originY,
                OriginZ = originZ,
                Heading = heading,
                Length = length,
                Height = height,
                HalfWidth = width * 0.5,
            };
        }

        /// <summary>Deck height along the ramp for progress t in [0,1] (cosine arc).</summary>
        public static double SkiJumpDeckHeight(double t, double height)
        {
            double u = Math.Max(0, Math.Min(1, t));
            return height * (1 - JsTrig.Cos((Math.PI * 0.5) * u));
        }

        /// <summary>Surface Y of a ski jump at (worldX, worldZ), or <see cref="CarrierDeck.NoSurfaceY"/> outside the ramp.</summary>
        public static double SampleSkiJumpSurfaceY(double worldX, double worldZ, SkiJumpCollider ramp)
        {
            double cos = JsTrig.Cos(ramp.Heading);
            double sin = JsTrig.Sin(ramp.Heading);
            double dx = worldX - ramp.OriginX;
            double dz = worldZ - ramp.OriginZ;
            double localX = dx * cos - dz * sin;
            double localZ = dx * sin + dz * cos;
            if (localZ < 0 || localZ > ramp.Length)
            {
                return CarrierDeck.NoSurfaceY;
            }
            if (Math.Abs(localX) > ramp.HalfWidth)
            {
                return CarrierDeck.NoSurfaceY;
            }
            return ramp.OriginY + SkiJumpDeckHeight(localZ / ramp.Length, ramp.Height);
        }

        /// <summary>Highest ski-jump surface among ramps, or <see cref="CarrierDeck.NoSurfaceY"/>.</summary>
        public static double SampleSkiJumpSurfaceYMax(double worldX, double worldZ, IReadOnlyList<SkiJumpCollider> ramps)
        {
            double maxY = CarrierDeck.NoSurfaceY;
            for (int i = 0; i < ramps.Count; i++)
            {
                double y = SampleSkiJumpSurfaceY(worldX, worldZ, ramps[i]);
                if (y > maxY) maxY = y;
            }
            return maxY;
        }
    }
}
