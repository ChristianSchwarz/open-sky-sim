using Retro.Core;

namespace Retro.Game
{
    /// <summary>
    /// particleSystem.ts ParticleForce: changes a live particle's velocity once per
    /// <see cref="CpuParticleSystem.Update"/>, after its life ticks and before its
    /// position integrates, in the order the forces were added.
    /// </summary>
    public interface ICpuParticleForce
    {
        void Apply(double delta, CpuParticle particle);
    }

    /// <summary>Port of physics/particles/forces/constantForce.ts: a constant world acceleration (gravity).</summary>
    public sealed class ConstantParticleForce : ICpuParticleForce
    {
        public readonly Vec3d Acceleration;

        public ConstantParticleForce(Vec3d acceleration) => Acceleration = acceleration;

        public void Apply(double delta, CpuParticle particle)
        {
            particle.Velocity = particle.Velocity.AddScaled(Acceleration, delta);
        }
    }

    /// <summary>
    /// Port of physics/particles/forces/linearDragForce.ts: velocity *= exp(-drag dt),
    /// the exact integral of dv/dt = -drag v. The exponential is V8's (<see cref="JsExp"/>).
    /// </summary>
    public sealed class LinearDragParticleForce : ICpuParticleForce
    {
        /// <summary>Drag coefficient (1/s).</summary>
        public readonly double Drag;

        public LinearDragParticleForce(double drag) => Drag = drag;

        public void Apply(double delta, CpuParticle particle)
        {
            double factor = JsExp.Exp(-Drag * delta);
            particle.Velocity = particle.Velocity * factor;
        }
    }
}
