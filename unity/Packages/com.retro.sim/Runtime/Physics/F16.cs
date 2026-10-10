using System;

namespace Retro.Sim
{
    /// <summary>F-16C profile (physics/f16Profile.ts with the f16PaperData.ts values it uses).</summary>
    public static class F16Profile
    {
        public const double CombatMassKg = 19051;
        public const double SimMassKg = 13608;
        public const double WingAreaM2 = 27.87;
        public const double WingSpanM = 9.45;
        public const double Cd0 = 0.018;
        public const double InducedDragK = 0.1489;
        public const double Cl0 = 0.2;
        public const double ClAlphaPerRad = 5.73;
        public const double AbThrustKn = 129.4;
        public const double MilThrustKn = 76.3;
        public const double MilLeverEnd = 0.98;
        public const double AbMinLeverEnd = 0.99;
        public const double MinFlyingSpeedMps = 68;
        public const double StallAoaDeg = 22;
        public const double ServiceCeilingM = 50000 * 0.3048;
        public const double CruiseAltitudeM = 30000 * 0.3048;
        public const double CruiseSpeedMps = 846 * 0.3048;
        public const double MaxRollRateDegS = 300;
        public const double Cat3MaxRollRateDegS = 180;
        public const double MaxLoadFactorG = 9.5;
        public const double RotationSpeedMps = 65;
        public const double LandingMaxSpeedMps = 90;
        public const double LandingMaxVerticalSpeedMps = 8;
        public const double LandingMaxRollDeg = 12;
        public const double LandingMinPitchDeg = -12;
        public const double MpsToKts = 1.94384;
    }

    public enum F16ThrottleZone
    {
        Mil,
        AbMin,
        AbMax,
    }

    /// <summary>F100-PW-229 quadrant and thrust schedule (physics/f16Engine.ts).</summary>
    public static class F16Engine
    {
        public const double IdleThrustKn = 0.5;
        public const double MilThrustKn = 76.3;
        public const double AbMinThrustKn = 104.0;
        public const double AbMaxThrustKn = F16Profile.AbThrustKn;
        public const double MilLeverEnd = F16Profile.MilLeverEnd;
        public const double AbMinLeverEnd = F16Profile.AbMinLeverEnd;

        public const string NozzleMil = "#0a0a0a";
        public const string NozzleAbMin = "#ff8800";
        public const string NozzleAbMax = "#ffff00";

        private static double ClampLever(double lever) => Math.Max(0, Math.Min(1, lever));

        private static double LeverToPercent(double lever) => ClampLever(lever) * 100;

        public static bool IsAbDetentBand(double lever) => LeverToPercent(lever) >= 98;

        public static F16ThrottleZone Zone(double lever)
        {
            double pct = LeverToPercent(lever);
            if (pct < 99) return F16ThrottleZone.Mil;
            if (pct < 100) return F16ThrottleZone.AbMin;
            return F16ThrottleZone.AbMax;
        }

        public static string NozzleColor(double lever)
        {
            switch (Zone(lever))
            {
                case F16ThrottleZone.AbMin: return NozzleAbMin;
                case F16ThrottleZone.AbMax: return NozzleAbMax;
                default: return NozzleMil;
            }
        }

        /// <summary>Afterburner cone length (m) by zone: 0 / 1.96 / 3.43.</summary>
        public static double AfterburnerConeLengthM(double lever)
        {
            switch (Zone(lever))
            {
                case F16ThrottleZone.AbMin: return 1.96;
                case F16ThrottleZone.AbMax: return 3.43;
                default: return 0;
            }
        }

        /// <summary>Sea-level rated thrust (kN) before altitude lapse.</summary>
        public static double SlThrustKn(double lever)
        {
            double pct = LeverToPercent(lever);
            if (pct <= 98)
            {
                double milFraction = pct / 98;
                return IdleThrustKn + (MilThrustKn - IdleThrustKn) * milFraction;
            }
            if (pct < 99) return MilThrustKn;
            if (pct >= 100) return AbMaxThrustKn;
            return AbMinThrustKn;
        }

        /// <summary>Delivered thrust (N) at altitude with the ISA turbofan lapse.</summary>
        public static double ThrustN(double lever, double altitudeMeters)
        {
            double rho = AeroUtils.AirDensity(altitudeMeters);
            return SlThrustKn(lever) * 1000 * AeroUtils.ThrustDensityFactor(rho, altitudeMeters);
        }

        /// <summary>HUD label: MIL 20-100, AB1, AB2.</summary>
        public static string HudText(double lever)
        {
            double pct = LeverToPercent(lever);
            switch (Zone(lever))
            {
                case F16ThrottleZone.Mil:
                    if (pct > 98) return "MIL 100";
                    return "MIL " + Retro.Core.JsMath.Round(20 + (pct / 98) * 80).ToString(System.Globalization.CultureInfo.InvariantCulture);
                case F16ThrottleZone.AbMin: return "AB1";
                default: return "AB2";
            }
        }

        public static double AudioLevel(double lever)
        {
            // The TS guards AbMax <= Idle; both are constants here, so it cannot happen.
            return ClampLever((SlThrustKn(lever) - IdleThrustKn) / (AbMaxThrustKn - IdleThrustKn));
        }

        /// <summary>Held-key ramp below the MIL stop.</summary>
        public static double AdjustInput(double lever, double step)
        {
            double current = ClampLever(lever);
            if (step > 0)
            {
                double target = current + step;
                return target >= MilLeverEnd ? MilLeverEnd : ClampLever(target);
            }
            if (step < 0)
            {
                return LeverToPercent(current) > 98 ? MilLeverEnd : ClampLever(current + step);
            }
            return current;
        }

        /// <summary>One detent per key press: MIL 100, AB1, AB2 and back.</summary>
        public static double StepDetent(double lever, int direction)
        {
            double pct = LeverToPercent(lever);
            if (direction > 0)
            {
                if (pct >= 99) return 1;
                if (pct >= 98) return AbMinLeverEnd;
                return lever;
            }
            if (pct >= 100) return AbMinLeverEnd;
            if (pct >= 99) return MilLeverEnd;
            return lever;
        }
    }
}
