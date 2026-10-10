using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// Forebody vortex asymmetry, the high-alpha "nose slice" after Ericsson,
    /// "Cobra Maneuver Considerations" (ICAS-92-4.6R); port of physics/fm2/forebodyAsymmetry.ts.
    ///
    /// Above a critical AoA a slender forebody sheds an asymmetric vortex pair; the
    /// side force on the long nose arm makes a large yawing moment. The direction
    /// locks in with the vehicle's own coning motion (moving-wall coupling). This
    /// only develops in laminar / subscale flow; at full-scale Reynolds numbers it is
    /// suppressed, which is why the model applies it only in the laminar regime.
    /// </summary>
    public static class ForebodyAsymmetry
    {
        /// <summary>Smooth Hermite step (0 below a, 1 above b, C1 in between).</summary>
        private static double Smoothstep(double a, double b, double x)
        {
            if (b <= a) return x >= b ? 1 : 0;
            double t = Math.Min(1, Math.Max(0, (x - a) / (b - a)));
            return t * t * (3 - 2 * t);
        }

        /// <summary>
        /// Asymmetric forebody side-force coefficient Cy (referenced to cfg.RefAreaM2),
        /// positive toward body +X. Combines an AoA envelope (optionally shifted by
        /// Ericsson's pitch-rate nose incidence) with a tanh-saturated lock-in drive
        /// seed + gain * yawRate.
        /// </summary>
        public static double Cy(double aoaRad, double yawRateRadS, double pitchRateRadS, double speed,
            Fm2ForebodyAsymmetryConfig cfg)
        {
            double sign = Fm2Math.Or(JsMath.Sign(aoaRad), 1);
            double arm = cfg.PitchRateArmRatio;
            // Pitch-rate-induced nose incidence: alpha-dot at the nose ~ q * armZ / U; the
            // nose sees a lower AoA magnitude during a nose-up pull (delayed onset).
            double alphaDotNose = speed > 1 ? (pitchRateRadS * cfg.ArmZ) / speed : 0;
            double aoaEffMag = Math.Abs(aoaRad) - arm * alphaDotNose * sign;

            double env = Smoothstep(cfg.OnsetAoaRad, cfg.FullAoaRad, aoaEffMag);
            if (env <= 0) return 0;

            // Moving-wall lock-in: the coning/yaw motion (plus the micro-asymmetry seed)
            // sets the asymmetry direction; tanh saturates it to +-1.
            double drive = cfg.SeedDrive + cfg.LockInRateGain * yawRateRadS;
            double lockIn = Math.Tanh(drive / Math.Max(cfg.DriveScale, 1e-3));

            return env * cfg.MaxSideForceCoeff * lockIn;
        }
    }
}
