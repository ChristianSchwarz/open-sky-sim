using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>ISA atmosphere, Mach and thrust lapse; port of physics/aeroUtils.ts.</summary>
    public static class AeroUtils
    {
        private const double LegacyGravity = 9.8;
        private const double GroundAirDensity = 1.225;
        private const double VneMach = 0.95;
        private const double IsaSeaLevelPressure = 101325;
        private const double IsaSeaLevelTemp = 288.15;
        private const double IsaLapseRate = 0.0065;
        private const double IsaTropopauseAlt = 11000;
        private const double IsaTropopausePressure = 22632.1;
        private const double IsaTropopauseTemp = 216.65;
        private const double GravityIsa = 9.80665;
        private const double GasConstant = 287.053;
        private const double Gamma = 1.4;

        /// <summary>ISA density (kg/m^3).</summary>
        public static double IsaAirDensity(double altitudeMeters)
        {
            double h = Math.Max(0, altitudeMeters);
            double temperature, pressure;
            if (h <= IsaTropopauseAlt)
            {
                temperature = IsaSeaLevelTemp - IsaLapseRate * h;
                pressure = IsaSeaLevelPressure * Math.Pow(temperature / IsaSeaLevelTemp, GravityIsa / (GasConstant * IsaLapseRate));
            }
            else
            {
                temperature = IsaTropopauseTemp;
                pressure = IsaTropopausePressure * Math.Exp(-GravityIsa * (h - IsaTropopauseAlt) / (GasConstant * IsaTropopauseTemp));
            }
            return pressure / (GasConstant * temperature);
        }

        public static double AirDensity(double altitudeMeters) => IsaAirDensity(altitudeMeters);

        public static double DynamicPressure(double airDensity, double speed) => 0.5 * airDensity * speed * speed;

        public static double ThrustDensityFactor(double airDensity, double altitudeMeters = 0)
        {
            double sigma = airDensity / GroundAirDensity;
            double lapse = Math.Pow(sigma, 0.7);
            const double optimumAltitude = 11000;
            double altPenalty = altitudeMeters <= optimumAltitude
                ? 1
                : Math.Max(0.35, 1 - (altitudeMeters - optimumAltitude) / 9000);
            return lapse * altPenalty;
        }

        public static double SpeedOfSound(double altitudeMeters)
        {
            double temperature = Math.Max(IsaTropopauseTemp, IsaSeaLevelTemp - IsaLapseRate * altitudeMeters);
            return Math.Sqrt(Gamma * GasConstant * temperature);
        }

        public static double MachNumber(double speedMps, double altitudeMeters)
        {
            double a = SpeedOfSound(altitudeMeters);
            return a <= 0 ? 0 : speedMps / a;
        }

        public static double DynamicPressureDragPenalty(double speedMps, double altitudeMeters)
        {
            double a = SpeedOfSound(altitudeMeters);
            if (a <= 0 || speedMps <= 0) return 0;
            double mach = speedMps / a;
            if (mach <= VneMach) return 0;
            double excess = (mach - VneMach) / VneMach;
            return 0.55 * excess * excess;
        }

        /// <summary>Note the legacy 9.8 default, as in aeroUtils.ts.</summary>
        public static double LoadFactorG(Vec3d accel, Vec3d up, double gravity = LegacyGravity)
        {
            return (accel.X * up.X + (accel.Y + gravity) * up.Y + accel.Z * up.Z) / gravity;
        }
    }
}
