using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// sun.ts SunState plus the SUN_DIRECTION and SUN_UNIFORMS values
    /// setSunTime writes alongside it: everything that follows from the time of
    /// day. Scene axes: +X east, +Y up, +Z south.
    /// </summary>
    public sealed class SunState
    {
        /// <summary>Local solar time, 0..24.</summary>
        public double Hours;
        /// <summary>Sun elevation above the horizon, degrees (negative at night).</summary>
        public double ElevationDeg;
        /// <summary>0 below civil twilight (-6 deg), 1 from 8 deg up; scales the direct light.</summary>
        public double DayFactor;
        /// <summary>0 = noon palette, 1 = midnight palette (the sky model's crossover).</summary>
        public double NightMix;
        /// <summary>0..1 weight for cast shadows (smoothstep over 1..5 deg).</summary>
        public double ShadowStrength;
        /// <summary>SUN_DIRECTION: unit vector towards the sun, scene axes.</summary>
        public double DirX, DirY, DirZ;
        /// <summary>uSunShade: (ambient, direct) scalar weights; ambient = 1 - direct.</summary>
        public double ShadeAmbient, ShadeDirect;
        /// <summary>uSunAmbient: ambientTint * (1 - direct).</summary>
        public double[] Ambient;
        /// <summary>uSunDirect: directTint * direct.</summary>
        public double[] Direct;
        /// <summary>uSunTint: the beam's hue at luminance 1 (rim light).</summary>
        public double[] Tint;
        /// <summary>The sky sample the tints and night mix came from.</summary>
        public SkySample Sky;
    }

    /// <summary>
    /// Port of the pure parts of src/script/scene/materials/shaders/sun.ts: the
    /// sun's path at an equinox at 29 N (sunrise 06:00, sunset 18:00 local solar
    /// time), the state setSunTime derives, the disc visibility over a skyline
    /// and the settings readout. The TS keeps this in module globals; here
    /// <see cref="SetSunTime"/> returns a fresh <see cref="SunState"/>.
    /// </summary>
    public static class SunClock
    {
        private const double Deg2Rad = Math.PI / 180;
        private const double Rad2Deg = 180 / Math.PI;

        /// <summary>sun.ts SUN_LATITUDE_RAD (29 degrees).</summary>
        public const double SunLatitudeRad = 29 * Deg2Rad;
        /// <summary>sun.ts DEFAULT_SUN_HOURS: the sim starts at 14:00.</summary>
        public const double DefaultSunHours = 14;
        public const double DayFactorMinElevationDeg = -6;
        public const double DayFactorMaxElevationDeg = 8;
        public const double ShadowMinElevationDeg = 1;
        public const double ShadowMaxElevationDeg = 5;
        /// <summary>sun.ts SUN_SHADE_AMBIENT: ambient floor of the shaded ramp with the sun high.</summary>
        public const double SunShadeAmbient = 0.55;

        /// <summary>sun.ts SHADOW_MIN_SUN_Y = sin(1 deg).</summary>
        public static readonly double ShadowMinSunY = JsTrig.Sin(ShadowMinElevationDeg * Deg2Rad);

        /// <summary>three MathUtils.smoothstep.</summary>
        public static double Smoothstep(double x, double min, double max)
        {
            if (x <= min) return 0;
            if (x >= max) return 1;
            x = (x - min) / (max - min);
            return x * x * (3 - 2 * x);
        }

        /// <summary>sun.ts sunDirectionAt: unit vector towards the sun at hours local solar time (not wrapped).</summary>
        public static void SunDirectionAt(double hours, out double x, out double y, out double z)
        {
            double hourAngle = (hours - 12) * 15 * Deg2Rad;
            double sinElevation = JsMath.Clamp(JsTrig.Cos(SunLatitudeRad) * JsTrig.Cos(hourAngle), -1, 1);
            double cosElevation = Math.Sqrt(Math.Max(0, 1 - sinElevation * sinElevation));

            double cosAzimuth = cosElevation > 1e-6
                ? JsMath.Clamp(-sinElevation * JsTrig.Sin(SunLatitudeRad) / (cosElevation * JsTrig.Cos(SunLatitudeRad)), -1, 1)
                : -1;
            double azimuth = JsTrig.Acos(cosAzimuth);
            if (hours > 12)
            {
                azimuth = 2 * Math.PI - azimuth;
            }
            x = cosElevation * JsTrig.Sin(azimuth);
            y = sinElevation;
            z = -cosElevation * JsTrig.Cos(azimuth);
        }

        /// <summary>sun.ts sunElevationAt: degrees.</summary>
        public static double SunElevationAt(double hours)
        {
            double hourAngle = (hours - 12) * 15 * Deg2Rad;
            double sinElevation = JsMath.Clamp(JsTrig.Cos(SunLatitudeRad) * JsTrig.Cos(hourAngle), -1, 1);
            return JsTrig.Asin(sinElevation) * Rad2Deg;
        }

        /// <summary>
        /// sun.ts setSunTime: moves the sun to hours (wrapped into 0..24) and
        /// derives elevation, day factor, shadow strength, night mix and the
        /// light uniforms (the sky model sample is cached per 0.25 deg).
        /// </summary>
        public static SunState SetSunTime(double hours)
        {
            double wrapped = ((hours % 24) + 24) % 24;
            SunDirectionAt(wrapped, out double dx, out double dy, out double dz);
            var s = new SunState { Hours = wrapped, DirX = dx, DirY = dy, DirZ = dz };
            s.ElevationDeg = JsTrig.Asin(JsMath.Clamp(dy, -1, 1)) * Rad2Deg;
            s.DayFactor = Smoothstep(s.ElevationDeg, DayFactorMinElevationDeg, DayFactorMaxElevationDeg);
            s.ShadowStrength = Smoothstep(s.ElevationDeg, ShadowMinElevationDeg, ShadowMaxElevationDeg);

            double direct = (1 - SunShadeAmbient) * s.DayFactor;
            s.ShadeAmbient = 1 - direct;
            s.ShadeDirect = direct;

            SkySample sky = SkyModel.SkyFor(s.ElevationDeg);
            s.Sky = sky;
            s.NightMix = sky.NightMix;
            double ambientWeight = 1 - direct;
            s.Ambient = new[] { sky.AmbientTint[0] * ambientWeight, sky.AmbientTint[1] * ambientWeight, sky.AmbientTint[2] * ambientWeight };
            s.Direct = new[] { sky.DirectTint[0] * direct, sky.DirectTint[1] * direct, sky.DirectTint[2] * direct };
            s.Tint = new[] { sky.DirectTint[0], sky.DirectTint[1], sky.DirectTint[2] };
            return s;
        }

        /// <summary>
        /// sun.ts sunVisibilityFor: fraction of a disc diameterDeg wide standing
        /// above a skyline at skylineDeg (linear in the height cleared).
        /// </summary>
        public static double SunVisibilityFor(double sunElevationDeg, double skylineDeg, double diameterDeg) =>
            JsMath.Clamp((sunElevationDeg - skylineDeg) / diameterDeg + 0.5, 0, 1);

        /// <summary>sun.ts formatSunTime: "HH:MM" for the settings readout.</summary>
        public static string FormatSunTime(double hours)
        {
            double wrapped = ((hours % 24) + 24) % 24;
            double totalMinutes = JsMath.Round(wrapped * 60) % (24 * 60);
            int h = (int)Math.Floor(totalMinutes / 60);
            int m = (int)(totalMinutes % 60);
            return h.ToString("00", System.Globalization.CultureInfo.InvariantCulture) + ":"
                + m.ToString("00", System.Globalization.CultureInfo.InvariantCulture);
        }

        /// <summary>
        /// game.ts 'n' key: the quick day/night flip jumps the daytime setting
        /// to 0 (midnight) when the sun is up (dayFactor &gt; 0.5), else back to
        /// <see cref="DefaultSunHours"/>.
        /// </summary>
        public static double ToggleDayNight(SunState current) =>
            current.DayFactor > 0.5 ? 0 : DefaultSunHours;
    }
}
