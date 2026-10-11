using Retro.Core;
using Retro.Game;
using Retro.Sim;

namespace Retro.Unity
{
    /// <summary>A sim aircraft as a camera subject (the AI chase view's orbit subject).</summary>
    public sealed class SimChaseTarget : IChaseTarget
    {
        private readonly CombatSim sim;
        private readonly string id;

        public SimChaseTarget(CombatSim sim, string id)
        {
            this.sim = sim;
            this.id = id;
        }

        public Vec3d GetDisplayPosition() => sim.GetAircraft(id)?.GetPosition() ?? Vec3d.Zero;
        public Quatd GetDisplayQuaternion() => sim.GetAircraft(id)?.GetQuaternion() ?? Quatd.Identity;
    }
}
