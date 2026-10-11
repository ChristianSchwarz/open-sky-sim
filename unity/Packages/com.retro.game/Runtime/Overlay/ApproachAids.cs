using System;
using Retro.Core;
using Retro.Sim;

namespace Retro.Game
{
    /// <summary>approachAids.ts AoaIndexerCue: the navy AoA indexer's three lights.</summary>
    public enum AoaIndexerCue
    {
        /// <summary>AoA above the on-speed band (upper chevron).</summary>
        Slow,
        /// <summary>8.0..8.5 degrees (centre donut).</summary>
        OnSpeed,
        /// <summary>AoA below the band (lower chevron).</summary>
        Fast,
    }

    /// <summary>approachAids.ts ApproachRunway: the runway the ILS needles guide down.</summary>
    public sealed class ApproachRunway
    {
        /// <summary>Runway centre, scene frame (m).</summary>
        public Vec3d Center;
        /// <summary>Scene heading (rad) landing on it; 0 faces +Z, positive turns toward +X.</summary>
        public double Heading;
        /// <summary>Half the runway length (m).</summary>
        public double HalfLength;
    }

    /// <summary>approachAids.ts IlsDeviation: needle deflections in [-1, 1].</summary>
    public readonly struct IlsDeviation
    {
        /// <summary>-1 = fly left (course to the left), +1 = fly right.</summary>
        public readonly double Localizer;
        /// <summary>-1 = fly down (above path), +1 = fly up (below path).</summary>
        public readonly double Glideslope;

        public IlsDeviation(double localizer, double glideslope)
        {
            Localizer = localizer;
            Glideslope = glideslope;
        }
    }

    /// <summary>
    /// Port of scene/entities/overlay/approachAids.ts: shared ILS / approach
    /// geometry for airfield and carrier HUD symbology.
    /// Carrier recovery reference: AoA 8.0..8.5 on-speed, 3.0 degree glide
    /// path, ~137 KIAS, ~700 fpm sink.
    /// </summary>
    public static class ApproachAids
    {
        /// <summary>ILS_GLIDESLOPE_DEG: visual / ILS glideslope angle (deg).</summary>
        public const double GlideslopeDeg = 3.0;

        /// <summary>ILS_GLIDESLOPE_TAN = Math.tan(3 deg) as V8 computes it (checked by the golden test).</summary>
        public const double GlideslopeTan = 0.0524077792830412;

        /// <summary>CARRIER_AOA_ON_SPEED_MIN_DEG / MAX_DEG: the on-speed band (deg).</summary>
        public const double CarrierAoaOnSpeedMinDeg = 8.0, CarrierAoaOnSpeedMaxDeg = 8.5;

        /// <summary>CARRIER_APPROACH_SPEED_KIAS: mid of the 130..145 band.</summary>
        public const double CarrierApproachSpeedKias = 137;

        private const double CarrierApproachSinkFpm = 700;
        private const double KiasToMps = 0.514444;
        private const double FpmToMps = 0.00508;
        private const double CarrierApproachSpeedMps = CarrierApproachSpeedKias * KiasToMps;
        private const double CarrierApproachSinkMps = -CarrierApproachSinkFpm * FpmToMps;

        /// <summary>LOC_FULL_SCALE_M / GS_FULL_SCALE_M: lateral / vertical miss at full deflection (m).</summary>
        private const double LocFullScaleM = 90, GsFullScaleM = 40;

        /// <summary>Kuznetsov hull extents in carrier-local space (KUZ_HULL).</summary>
        private const double KuzMinX = -34.33, KuzMaxX = 43.83, KuzMaxZ = 124.28;
        private const double KuzDeckMidX = (KuzMinX + KuzMaxX) * 0.5;
        private const double KuzTouchdownLocalZ = KuzMaxZ - 30;
        private const double KuzDeckY = 13.55;

        /// <summary>TOUCHDOWN_PAST_THRESHOLD_M: the aiming point past the threshold.</summary>
        private const double TouchdownPastThresholdM = 200;

        /// <summary>LEGACY_RUNWAY: the authored airbase runway, heading 0 through the ENU origin (defs AIRBASE_RUNWAY, RUNWAY_HALF_LENGTH_M).</summary>
        public static readonly ApproachRunway LegacyRunway = new ApproachRunway { Center = Vec3d.Zero, Heading = 0, HalfLength = 1500 };

        /// <summary>isIlsApproachTarget: a ground airbase or carrier target.</summary>
        public static bool IsIlsApproachTarget(HudTarget t) =>
            t != null && !t.Airborne && (t.TargetType == "Airbase" || t.TargetType == "Carrier");

        public static AoaIndexerCue AoaIndexerCueFor(double aoaDeg)
        {
            if (aoaDeg > CarrierAoaOnSpeedMaxDeg) return AoaIndexerCue.Slow;
            if (aoaDeg < CarrierAoaOnSpeedMinDeg) return AoaIndexerCue.Fast;
            return AoaIndexerCue.OnSpeed;
        }

        /// <summary>Target approach speed in the active unit (kt, or km/h rounded).</summary>
        public static double CarrierApproachTargetSpeed(bool imperial) =>
            imperial ? CarrierApproachSpeedKias : JsMath.Round(CarrierApproachSpeedMps * 3.6);

        /// <summary>Target sink magnitude in the active unit (fpm, or m/s to one decimal).</summary>
        public static double CarrierApproachTargetSink(bool imperial) =>
            imperial ? CarrierApproachSinkFpm : JsMath.Round(Math.Abs(CarrierApproachSinkMps) * 10) / 10;

        /// <summary>
        /// computeIlsDeviation: needle deviations for the aircraft at position
        /// (scene frame). Null when the target type is no approach aid. For a
        /// carrier pass its live world origin (null = ARRESTOR_CARRIER_ORIGIN);
        /// for an airbase the runway (null = the legacy runway).
        /// </summary>
        public static IlsDeviation? ComputeIlsDeviation(Vec3d position, string targetType, Vec3d? carrierOrigin = null, ApproachRunway runway = null)
        {
            if (targetType == "Airbase") return AirbaseIls(position, runway ?? LegacyRunway);
            if (targetType == "Carrier") return CarrierIls(position, carrierOrigin ?? ArrestorCables.ArrestorCarrierOrigin);
            return null;
        }

        private static IlsDeviation AirbaseIls(Vec3d position, ApproachRunway runway)
        {
            double fwdX = JsTrig.Sin(runway.Heading);
            double fwdZ = JsTrig.Cos(runway.Heading);
            double touchX = runway.Center.X - fwdX * (runway.HalfLength - TouchdownPastThresholdM);
            double touchZ = runway.Center.Z - fwdZ * (runway.HalfLength - TouchdownPastThresholdM);
            double distToTouch = Math.Max(0, -((position.X - touchX) * fwdX + (position.Z - touchZ) * fwdZ));
            double desiredAlt = runway.Center.Y + distToTouch * GlideslopeTan;
            double lateral = (position.X - runway.Center.X) * fwdZ - (position.Z - runway.Center.Z) * fwdX;
            double altErr = position.Y - desiredAlt;
            return new IlsDeviation(Clamp1(-lateral / LocFullScaleM), Clamp1(-altErr / GsFullScaleM));
        }

        private static IlsDeviation CarrierIls(Vec3d position, Vec3d origin)
        {
            double centerX = origin.X + KuzDeckMidX;
            double touchZ = origin.Z + KuzTouchdownLocalZ;
            double distToTouch = Math.Max(0, position.Z - touchZ);
            double desiredAlt = origin.Y + KuzDeckY + distToTouch * GlideslopeTan;
            double lateral = position.X - centerX;
            double altErr = position.Y - desiredAlt;
            return new IlsDeviation(Clamp1(lateral / LocFullScaleM), Clamp1(-altErr / GsFullScaleM));
        }

        private static double Clamp1(double v)
        {
            if (v < -1) return -1;
            if (v > 1) return 1;
            return v;
        }
    }
}
