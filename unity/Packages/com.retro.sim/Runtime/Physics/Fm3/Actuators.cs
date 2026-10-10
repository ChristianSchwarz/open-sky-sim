using System;

namespace Retro.Sim
{
    /// <summary>
    /// FM3 surface actuators (port of physics/fm3/actuators.ts): each channel
    /// follows its command through a first-order lag, a rate limit and position
    /// limits, writing straight into the aerodynamic model's control array.
    /// </summary>
    public sealed class Fm3Actuators
    {
        public readonly double[] Command = new double[Fm3Channels.Count];
        /// <summary>The array the deflections are written into (the aero model's controls).</summary>
        public readonly double[] Position;
        private readonly double[] min = new double[Fm3Channels.Count];
        private readonly double[] max = new double[Fm3Channels.Count];
        private readonly double[] rate = new double[Fm3Channels.Count];
        private readonly double[] tau = new double[Fm3Channels.Count];
        private readonly byte[] present = new byte[Fm3Channels.Count];

        public Fm3Actuators(Fm3Airframe airframe, double[] position)
        {
            Position = position;
            foreach (Fm3Actuator a in airframe.Actuators)
            {
                int i = (int)a.Channel;
                min[i] = a.Min;
                max[i] = a.Max;
                rate[i] = a.Rate;
                tau[i] = a.Tau;
                present[i] = 1;
            }
        }

        public void Reset()
        {
            Array.Clear(Command, 0, Command.Length);
            for (int i = 0; i < Position.Length; i++)
            {
                Position[i] = present[i] != 0 ? Math.Min(max[i], Math.Max(min[i], 0)) : 0;
            }
        }

        /// <summary>Put every surface exactly at its (limited) command, e.g. for a spawn.</summary>
        public void Snap()
        {
            for (int i = 0; i < Position.Length; i++)
            {
                if (present[i] == 0) continue;
                Position[i] = Math.Min(max[i], Math.Max(min[i], Command[i]));
            }
        }

        public void Update(double dt)
        {
            for (int i = 0; i < Position.Length; i++)
            {
                if (present[i] == 0)
                {
                    Position[i] = 0;
                    continue;
                }
                double cmd = Math.Min(max[i], Math.Max(min[i], Command[i]));
                double pos = Position[i];
                double next = tau[i] > 0 ? pos + (cmd - pos) * (1 - Math.Exp(-dt / tau[i])) : cmd;
                double maxStep = rate[i] * dt;
                if (next - pos > maxStep) next = pos + maxStep;
                else if (pos - next > maxStep) next = pos - maxStep;
                Position[i] = next;
            }
        }
    }
}
