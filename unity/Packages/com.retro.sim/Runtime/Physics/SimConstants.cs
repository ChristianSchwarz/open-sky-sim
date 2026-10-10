using Retro.Core;

namespace Retro.Sim
{
    /// <summary>
    /// The handful of src/script/defs.ts and utils/math.ts values the sim uses.
    /// Body axes in the sim: +Z forward, +Y up, and +X is PORT (the TS constant
    /// is named RIGHT but physics/fm3/frames.ts shows starboard is -X). Keep the
    /// names as the TypeScript has them so ported code reads the same.
    /// </summary>
    public static class SimConstants
    {
        public const double PitchRate = System.Math.PI / 5;
        public const double RollRate = System.Math.PI / 2;
        public const double YawRate = System.Math.PI / 12;
        public const double MaxSpeed = 250.0;
        public const double PlaneDistanceToGround = 2.0;
        public const double MaxAltitude = 400000;

        public static readonly Vec3d Up = new Vec3d(0, 1, 0);
        public static readonly Vec3d Forward = new Vec3d(0, 0, 1);
        /// <summary>Named RIGHT in utils/math.ts; it is the port side of the aircraft body.</summary>
        public static readonly Vec3d Right = new Vec3d(1, 0, 0);

        private const double Epsilon = 0.0001;

        public static bool IsZero(double n) => -Epsilon <= n && n <= Epsilon;

        public static double Clamp(double n, double min, double max) => JsMath.Clamp(n, min, max);
    }
}
