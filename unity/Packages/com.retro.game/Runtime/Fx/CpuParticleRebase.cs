using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// ParticleSystem.rebase (physics/particles/particleSystem.ts) for
    /// <see cref="CpuParticleSystem"/>: the emitter position and every particle's
    /// position and velocity, live or not, carried into the re-based frame.
    /// (The TS also moves its bounding box, which the C# pool does not keep.)
    /// Kept apart from CpuParticleSystem.cs so parallel ports that extend the
    /// pool merge cleanly; an instance method of the same name would win.
    /// </summary>
    public static class CpuParticleSystemFrameShift
    {
        public static void Rebase(this CpuParticleSystem system, FrameShift shift)
        {
            system.Position = shift.Point(system.Position);
            foreach (CpuParticle p in system.Particles)
            {
                p.Position = shift.Point(p.Position);
                p.Velocity = shift.Vector(p.Velocity);
            }
        }
    }
}
