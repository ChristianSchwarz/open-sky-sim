using System;

namespace Retro.Game
{
    /// <summary>
    /// Port of scene/entities/overlay/displayUnits.ts: converts SI flight data
    /// into the active unit system and formats the HUD tapes. Metric shows
    /// metres, km/h and m/s; imperial shows feet, knots and ft/min, and above
    /// 1000 ft switches the altitude tape to its barometric ("lowp") scale.
    /// </summary>
    public sealed class DisplayUnits
    {
        private const double MpsToKmh = 3.6;

        public UnitSystem System { get; set; }

        public DisplayUnits(UnitSystem system = UnitSystem.Metric)
        {
            System = system;
        }

        private bool Metric => System == UnitSystem.Metric;

        public double AltitudeFromMeters(double meters) => Metric ? meters : OverlayUtils.ToFeet(meters);

        public double SpeedFromMps(double metersPerSecond) =>
            Metric ? metersPerSecond * MpsToKmh : OverlayUtils.ToKnots(metersPerSecond);

        public double VerticalSpeedFromMps(double metersPerSecond) =>
            Metric ? metersPerSecond : OverlayUtils.ToFeet(metersPerSecond) * 60.0;

        public double AltitudeStep => Metric ? 10 : 5;

        public double AltitudeLowThreshold => 1000;

        public bool UseBarometricAltitude => System == UnitSystem.Imperial;

        public double AltitudeTapeLabelInterval => 100;

        public double AirspeedStep => 2.5;

        public double AirspeedScale => 10;

        public double VerticalSpeedBarDivisor => Metric ? 15 : 500;

        public string FormatAltitudeReadout(double altitude)
        {
            if (Metric)
            {
                return JsText.ToFixed(Math.Floor(altitude / 10) * 10, 0);
            }
            double step = AltitudeStep;
            return JsText.ToFixed(step * Retro.Core.JsMath.Round(altitude / step), 0);
        }

        public string FormatAltitudeTape(double n, bool lowp)
        {
            if (Metric)
            {
                return JsText.ToFixed(Math.Floor(n / 10) * 10, 0);
            }
            if (n < AltitudeLowThreshold)
            {
                double low = lowp ? 900 + n / 10 : n;
                return JsText.ToFixed(low, 0);
            }
            double num = !lowp && n > AltitudeLowThreshold ? (n - 900) * 10 : n;
            return JsText.ToFixed(num / 1000, 0) + "K";
        }

        public double GetAltitudeTickWidth(double current, double markerScale)
        {
            if (Metric)
            {
                if (current % 100 == 0) return 2;
                if (current % 50 == 0) return 1;
                if (current % 10 == 0) return 1;
                return 0;
            }
            if (current % (100 * markerScale) == 0) return 2;
            if (current % (50 * markerScale) == 0) return 1;
            return 0;
        }

        public string AltitudeUnitLabel() => Metric ? "M" : "FT";

        public string SpeedUnitLabel() => Metric ? "KMH" : "KT";
    }
}
