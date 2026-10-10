using System;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// Pure geometry and energy helpers for the AI dogfight logic (port of
    /// ai/dogfightGeometry.ts). No engine or class state, so each is tested
    /// directly against the oracle's fixtures.
    /// </summary>
    public static class DogfightGeometry
    {
        private const double G = 9.80665;

        /// <summary>Energy height (m): altitude plus v^2 / 2g.</summary>
        public static double SpecificEnergyHeight(double altitude, double speed) => altitude + (speed * speed) / (2 * G);

        /// <summary>Signed closure rate (m/s) along the line of sight; positive = closing.</summary>
        public static double ClosureRate(Vec3d myPos, Vec3d myVel, Vec3d targetPos, Vec3d targetVel)
        {
            Vec3d los = targetPos - myPos;
            double range = los.Length;
            if (range < 1e-6) return 0;
            los = los / range;
            return Vec3d.Dot(myVel - targetVel, los);
        }

        /// <summary>Antenna train angle (rad, [0, pi]) between the shooter's nose and the line to the target.</summary>
        public static double TrackingAngle(Vec3d shooterPos, Vec3d shooterForward, Vec3d targetPos)
        {
            Vec3d los = targetPos - shooterPos;
            if (los.LengthSquared < 1e-9 || shooterForward.LengthSquared < 1e-9) return 0;
            los = los.Normalized();
            Vec3d fwd = shooterForward.Normalized();
            return Math.Acos(JsMath.Clamp(Vec3d.Dot(fwd, los), -1, 1));
        }

        /// <summary>Aspect angle (rad, [0, pi]) at the target, from its tail to the observer; 0 = dead astern.</summary>
        public static double AspectAngle(Vec3d observerPos, Vec3d targetPos, Vec3d targetVel)
        {
            if (targetVel.LengthSquared < 1e-9) return 0;
            Vec3d tail = targetVel.Normalized() * -1;
            return TrackingAngle(targetPos, tail, observerPos);
        }

        /// <summary>Angle-off (rad, [0, pi]) between two velocity vectors.</summary>
        public static double AngleOff(Vec3d myVel, Vec3d targetVel)
        {
            if (myVel.LengthSquared < 1e-9 || targetVel.LengthSquared < 1e-9) return 0;
            double dot = Vec3d.Dot(myVel, targetVel) / (myVel.Length * targetVel.Length);
            return Math.Acos(JsMath.Clamp(dot, -1, 1));
        }

        /// <summary>Bullet time of flight (s) to intercept, by three fixed-point iterations, clamped to [0, maxTof].</summary>
        public static double SolveInterceptTime(Vec3d relPos, Vec3d relVel, double muzzleSpeed, double maxTof = 5)
        {
            double speed = Math.Max(1, muzzleSpeed);
            double tof = relPos.Length / speed;
            for (int i = 0; i < 3; i++)
            {
                Vec3d iter = relVel * tof + relPos;
                tof = iter.Length / speed;
            }
            return JsMath.Clamp(tof, 0, maxTof);
        }

        /// <summary>
        /// Gun-lead aim point (world) for rounds that inherit the shooter's
        /// velocity and drop under gravity. Returns the time of flight.
        /// </summary>
        public static double BallisticAimPoint(out Vec3d aim, Vec3d myPos, Vec3d myVel,
            Vec3d targetPos, Vec3d targetVel, Vec3d targetAcc, double muzzleSpeed)
        {
            Vec3d relPos = targetPos - myPos;
            Vec3d relVel = targetVel - myVel;
            double tof = SolveInterceptTime(relPos, relVel, muzzleSpeed);
            aim = targetPos.AddScaled(relVel, tof).AddScaled(targetAcc, 0.5 * tof * tof);
            aim.Y += 0.5 * G * tof * tof;
            return tof;
        }

        /// <summary>Minimum separation (m) between a dropping round and the extrapolated target, around tof.</summary>
        public static double PredictedMissDistance(Vec3d shooterPos, Vec3d bulletVel,
            Vec3d targetPos, Vec3d targetVel, Vec3d targetAcc, double tof)
        {
            double best = double.PositiveInfinity;
            for (double f = 0.8; f <= 1.2001; f += 0.05)
            {
                double t = tof * f;
                Vec3d bullet = shooterPos.AddScaled(bulletVel, t);
                bullet.Y -= 0.5 * G * t * t;
                Vec3d tgt = targetPos.AddScaled(targetVel, t).AddScaled(targetAcc, 0.5 * t * t);
                double d = Vec3d.Distance(bullet, tgt);
                if (d < best) best = d;
            }
            return best;
        }
    }
}
