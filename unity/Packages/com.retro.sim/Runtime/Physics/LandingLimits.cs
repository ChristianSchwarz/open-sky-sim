using System;

namespace Retro.Sim
{
    /// <summary>
    /// Touchdown grading shared by FM2 and FM3 (port of model/landingLimits.ts):
    /// normal, hard but survivable, or fatal, on one "hardness" scale in m/s of sink.
    /// </summary>
    public static class LandingLimits
    {
        public const double GearFatalSinkMps = 15;
        public const double BellySoftHardness = 6.5;
        public const double BellyFatalHardness = 11;
        public const double BellySoftSpeedMps = 110;
        public const double BellyFatalSpeedMps = 140;
        public const double BellySoftRollRad = 0.45;
        public const double BellyFatalRollRad = 0.9;

        /// <summary>0 up to soft, 1 at fatal, linear between.</summary>
        public static double DamageFraction(double value, double soft, double fatal)
        {
            if (value <= soft) return 0;
            return Math.Min(1, (value - soft) / (fatal - soft));
        }

        private static double Ramp(double value, double soft, double fatal)
        {
            if (value <= soft) return 0;
            return BellySoftHardness + (BellyFatalHardness - BellySoftHardness) * (value - soft) / (fatal - soft);
        }

        /// <summary>Hardness of a gear-up touchdown; minPitchRad is the envelope's (negative) nose-down limit.</summary>
        public static double BellyHardness(double sinkMps, double speedMps, double rollRad, double pitchRad, double minPitchRad)
        {
            double nose = Math.Min(0, minPitchRad);
            return Math.Max(
                Math.Max(sinkMps, Ramp(speedMps, BellySoftSpeedMps, BellyFatalSpeedMps)),
                Math.Max(Ramp(Math.Abs(rollRad), BellySoftRollRad, BellyFatalRollRad),
                    nose < 0 ? Ramp(-pitchRad, -nose, -2 * nose) : 0));
        }
    }
}
