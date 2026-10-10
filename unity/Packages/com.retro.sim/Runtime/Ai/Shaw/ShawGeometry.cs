using Retro.Core;

namespace Retro.Sim
{
    public static class ShawGeometry
    {
        /// <summary>
        /// Shaw-named geometry aliases over the shared dogfight helpers.
        /// AOT ≈ aspect angle (0 = on target's six); TAA ≈ enemy ATA on us.
        /// </summary>
        public static TacticalGeometry ComputeTacticalGeometry(AircraftSnapshot self, AircraftSnapshot target)
        {
            Vec3d los = target.Position - self.Position;
            double range = los.Length;
            Vec3d losVector = range > 1e-6
                ? los / range
                : new Vec3d(0, 0, 1);

            double selfEs = DogfightGeometry.SpecificEnergyHeight(self.Altitude, self.Airspeed);
            double targetEs = DogfightGeometry.SpecificEnergyHeight(target.Altitude, target.Airspeed);

            double ata = DogfightGeometry.TrackingAngle(self.Position, self.Forward, target.Position);
            // Aspect angle helper measures observer vs target's *tail*; that is AOT.
            double aot = DogfightGeometry.AspectAngle(self.Position, target.Position, target.Velocity);
            // TAA: how well the target is tracking us (velocity as nose proxy).
            double taa = DogfightGeometry.TrackingAngle(target.Position, target.Velocity, self.Position);
            double closure = DogfightGeometry.ClosureRate(self.Position, self.Velocity, target.Position, target.Velocity);

            return new TacticalGeometry
            {
                Range = range,
                LosVector = losVector,
                Aot = aot,
                Taa = taa,
                Ata = ata,
                ClosureRate = closure,
                EnergyDelta = selfEs - targetEs,
                SelfEs = selfEs,
                TargetEs = targetEs,
            };
        }
    }
}
