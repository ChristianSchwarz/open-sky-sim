using System;
using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// particleSystem.ts ParticleEmitter: places a newly spawned particle and gives
    /// it its velocity. <see cref="CpuParticleSystem"/> calls it before drawing the
    /// particle's life / size / rotation, so every Math.random draw here comes first.
    /// </summary>
    public interface ICpuParticleEmitter
    {
        /// <param name="source">The system's emitter position (ParticleSystem.position).</param>
        void Emit(Vec3d source, CpuParticle particle, Func<double> random);
    }

    /// <summary>
    /// Port of physics/particles/emitters/sphereEmitter.ts: a particle on or near a
    /// sphere shell around the source, flying outward, plus a velocity bias (e.g.
    /// the parent aircraft's velocity). Random draws per emit: 3 per rejection-loop
    /// try (direction xyz, retried while outside the unit ball or ~zero), then the
    /// radius, then the speed.
    /// </summary>
    public sealed class SphereParticleEmitter : ICpuParticleEmitter
    {
        private readonly double minRadius;
        private readonly double radius;
        private readonly double minSpeed;
        private readonly double maxSpeed;

        /// <summary>Added to every emitted velocity (setVelocityBias).</summary>
        public Vec3d VelocityBias;

        /// <param name="minRadius">Inner radius (m); equal to <paramref name="radius"/> for a surface shell.</param>
        public SphereParticleEmitter(double minRadius, double radius, double minSpeed, double maxSpeed)
        {
            this.minRadius = minRadius;
            this.radius = radius;
            this.minSpeed = minSpeed;
            this.maxSpeed = maxSpeed;
        }

        public void SetVelocityBias(Vec3d v) => VelocityBias = v;

        public void Emit(Vec3d source, CpuParticle particle, Func<double> random)
        {
            Vec3d s;
            do
            {
                double x = random() * 2 - 1;
                double y = random() * 2 - 1;
                double z = random() * 2 - 1;
                s = new Vec3d(x, y, z);
            } while (s.LengthSquared > 1 || s.LengthSquared < 1e-6);

            s = s.Normalized();
            double r = Lerp(random(), minRadius, radius);
            particle.Position = source.AddScaled(s, r);

            s = s * Lerp(random(), minSpeed, maxSpeed);
            particle.Velocity = s + VelocityBias;
        }

        /// <summary>utils/math.ts lerp(t, n0, n1).</summary>
        private static double Lerp(double t, double n0, double n1) => n0 + t * (n1 - n0);
    }
}
