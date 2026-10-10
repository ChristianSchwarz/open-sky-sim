using System;

namespace Retro.Sim
{
    public sealed class EngineSchedule
    {
        public double IdleThrustN;
        public double MilThrustN;
        /// <summary>0 = no afterburner.</summary>
        public double AbMinThrustN;
        public double MaxThrustN;
        /// <summary>Lever position at 100% military (the quadrant's MIL detent).</summary>
        public double MilLeverEnd;
        /// <summary>Lever position at the first afterburner detent.</summary>
        public double AbMinLeverEnd;
    }

    /// <summary>
    /// FM3 engine (port of physics/fm3/propulsion.ts): Stevens and Lewis's F100
    /// power-level dynamics driving the same thrust schedule and throttle quadrant
    /// FM2 uses.
    ///
    /// Power runs 0-100%: 0-50 is idle to military, 50-100 afterburner. The core
    /// spools with a rate that depends on how far it has to go (slowly for a big
    /// change, briskly for a small one) and lighting the afterburner from below
    /// military first spools the core to 60%.
    /// </summary>
    public sealed class Fm3Engine
    {
        /// <summary>Current power level, percent.</summary>
        public double Power;

        private readonly EngineSchedule schedule;

        public Fm3Engine(EngineSchedule schedule)
        {
            this.schedule = schedule;
        }

        /// <summary>Reciprocal time constant (1/s) for a core power change of dp percent.</summary>
        private static double Rtau(double dp)
        {
            if (dp <= 25) return 1.0;
            if (dp >= 50) return 0.1;
            return 1.9 - 0.036 * dp;
        }

        public bool Afterburner => schedule.AbMinThrustN > 0;

        /// <summary>Power level at the first afterburner detent.</summary>
        private double AbMinPower
        {
            get
            {
                EngineSchedule s = schedule;
                return 50 + 50 * (s.AbMinThrustN - s.MilThrustN) / Math.Max(1, s.MaxThrustN - s.MilThrustN);
            }
        }

        /// <summary>Commanded power for a throttle lever in [0, 1].</summary>
        public double CommandedPower(double lever)
        {
            double l = lever < 0 ? 0 : lever > 1 ? 1 : lever;
            if (!Afterburner) return 50 * l;
            EngineSchedule s = schedule;
            if (l <= s.MilLeverEnd) return 50 * l / s.MilLeverEnd;
            if (l < s.AbMinLeverEnd) return 50;
            if (l < 1) return AbMinPower;
            return 100;
        }

        /// <summary>Jump straight to the commanded power (airborne spawn).</summary>
        public void Sync(double lever)
        {
            Power = CommandedPower(lever);
        }

        public void Update(double dt, double lever)
        {
            double pc = CommandedPower(lever);
            double p = Power;
            double target;
            double rate;
            if (pc >= 50)
            {
                if (p >= 50) { target = pc; rate = 5.0; }
                else { target = 60; rate = Rtau(target - p); }
            }
            else if (p >= 50)
            {
                target = 40; rate = 5.0;
            }
            else
            {
                target = pc; rate = Rtau(target - p);
            }
            // Frozen target and rate over the step: an exact first-order update.
            double next = p + (target - p) * (1 - Math.Exp(-rate * dt));
            // Don't let the intermediate 60% / 40% targets carry the core past the command.
            if ((target == 60 && pc < 60 && next > pc && p <= pc) || (target == 40 && pc > 40 && next < pc && p >= pc))
            {
                next = pc;
            }
            Power = next < 0 ? 0 : next > 100 ? 100 : next;
        }

        /// <summary>Delivered thrust (N) with the sim's ISA turbofan lapse.</summary>
        public double ThrustN(double rho, double altitudeM)
        {
            EngineSchedule s = schedule;
            double p = Power;
            double sl = p <= 50
                ? s.IdleThrustN + (s.MilThrustN - s.IdleThrustN) * p / 50
                : s.MilThrustN + (s.MaxThrustN - s.MilThrustN) * (p - 50) / 50;
            return sl * AeroUtils.ThrustDensityFactor(rho, altitudeM);
        }

        /// <summary>The lever position that would command the current power (HUD, audio, nozzle glow).</summary>
        public double EquivalentLever()
        {
            double p = Power;
            if (!Afterburner) return p / 50;
            EngineSchedule s = schedule;
            if (p <= 50) return s.MilLeverEnd * p / 50;
            double ab1 = AbMinPower;
            if (p < ab1) return s.MilLeverEnd + (s.AbMinLeverEnd - s.MilLeverEnd) * (p - 50) / Math.Max(1e-6, ab1 - 50);
            return s.AbMinLeverEnd + (1 - s.AbMinLeverEnd) * (p - ab1) / Math.Max(1e-6, 100 - ab1);
        }
    }
}
