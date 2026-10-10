using System;
using Retro.Core;

namespace Retro.Sim
{
    public struct FcsInput
    {
        /// <summary>[-1, 1] positive = nose up / pull.</summary>
        public double PitchStick;
        /// <summary>[-1, 1] positive = roll right.</summary>
        public double RollStick;
        /// <summary>[-1, 1] positive = nose right.</summary>
        public double YawPedal;
        /// <summary>About +X (rad/s).</summary>
        public double PitchRate;
        /// <summary>About +Y (rad/s).</summary>
        public double YawRate;
        /// <summary>About +Z (rad/s).</summary>
        public double RollRate;
        public double LoadFactorG;
        public double AoaRad;
        public double DynamicPressure;
        public double QRef;
        public double Speed;
        public double AltitudeM;
        public bool FlapsExtended;
        public bool Landed;
        /// <summary>Active pitch AoA/g limiter strategy (keys 1/2/3).</summary>
        public FcsPitchLimiter PitchLimiterMode;
        /// <summary>When false, pilot stick maps straight to the surfaces (no envelope protection).</summary>
        public bool LimitersEnabled;
    }

    public struct FcsOutput
    {
        public double Elevator;
        public double Aileron;
        public double Rudder;
        /// <summary>Max nose-up elevator command available this frame (HUD clamp line).</summary>
        public double ElevatorLimitHi;
        /// <summary>Max nose-down elevator command available this frame (HUD clamp line).</summary>
        public double ElevatorLimitLo;
    }

    /// <summary>
    /// Unified flight-control system for the FM2 model (port of physics/fm2/fcs.ts).
    ///
    /// One config-driven class flies every aircraft, turning stick/pedal inputs plus
    /// body rates and flight condition into normalised surface commands in [-1, 1]:
    ///   - Pitch: an AoA/g-limiting law with three runtime-selectable limiter
    ///     strategies (FcsPitchLimiter).
    ///   - Roll: a roll-rate command loop (capped and faded by dynamic pressure, Mach,
    ///     altitude and AoA) or a mechanical direct path with roll-rate damping.
    ///   - Yaw: a washed-out yaw-rate damper plus aileron-rudder interconnect and
    ///     direct pedal authority.
    /// A first-order actuator lag keeps surfaces from snapping.
    /// </summary>
    public sealed class Fm2Fcs
    {
        private const double Deg = Math.PI / 180;

        // Local limiter tuning (the FEEL of each strategy, not the envelope).
        // Pitch-rate damping folded into every limiter law: it adds the phase lead
        // that lets the feed-forward authority fade capture the AoA/g limit without
        // overshoot or hunting, and relaxes the stabilator as a steady rate builds.
        private const double PitchRateDamp = 1.1;
        private const double AuthFilterTauS = 0.14;          // authority low-pass (mode 1)
        private const double PredictAuthFilterTauS = 0.2;    // predicted authority low-pass (mode 2)
        private const double PredictAoaDamp = 0.9;           // extra alpha-dot damping near the limit (mode 2)
        private const double PredictAoaDampClamp = 0.3;      // cap on the alpha-dot damping term (mode 2)
        private const double SmoothAuthFilterTauS = 0.3;     // heavier authority low-pass (mode 3)
        private const double SmoothSlewPerS = 5.0;           // max elevator-target change per second (mode 3)

        private readonly Fm2FcsConfig cfg;

        private double elevator;
        private double aileron;
        private double rudder;
        private double yawRateLowPass;
        private double elevatorLimitHi = 1;
        private double elevatorLimitLo = -1;

        // Pitch-limiter filter / derivative state.
        private double prevAoaRad;
        private double prevLoadG = 1;
        private double aoaRateLowPass;  // filtered alpha-dot (rad/s)
        private double gRateLowPass;    // filtered g-dot (g/s)
        private double authLowPass = 1; // filtered soft-band authority (modes 1 & 2)
        private double pitchTarget;     // slew-limited elevator target (mode 3)

        public Fm2Fcs(Fm2FcsConfig cfg)
        {
            this.cfg = cfg;
        }

        /// <summary>Smooth Hermite fade: 0 at edge0, 1 at edge1 (edges may be reversed).</summary>
        private static double Smoothstep(double edge0, double edge1, double x)
        {
            if (edge0 == edge1) return x < edge0 ? 0 : 1;
            double t = JsMath.Clamp((x - edge0) / (edge1 - edge0), 0, 1);
            return t * t * (3 - 2 * t);
        }

        /// <summary>
        /// Stick to commanded body roll rate (rad/s) for the rate-command roll law:
        /// the peak rate scaled by a dynamic-pressure gain schedule and faded by Mach,
        /// altitude, AoA and flap limiters.
        /// </summary>
        private static double ComputeCommandedRollRate(in FcsInput input, Fm2RollLawConfig roll)
        {
            if (input.Landed || Math.Abs(input.RollStick) < 1e-6)
            {
                return 0;
            }
            double mach = AeroUtils.MachNumber(input.Speed, input.AltitudeM);
            double flapFactor = input.FlapsExtended ? (roll.FlapsFactor ?? 0.65) : 1;
            double limiter = RollMachLimiter(mach, roll)
                * RollAltitudeLimiter(input.AltitudeM, roll)
                * RollAoaLimiter(input.AoaRad, roll)
                * flapFactor;
            double qGain = RollDynamicPressureGain(input.DynamicPressure, input.QRef, roll);
            return input.RollStick * roll.MaxRollRateDegS * Deg * qGain * limiter;
        }

        private static double RollDynamicPressureGain(double dynamicPressure, double qRef, Fm2RollLawConfig roll)
        {
            double min = roll.QGainMin ?? 0.12;
            double max = roll.QGainMax ?? 1.0;
            double q = Math.Max(dynamicPressure, 1);
            double reference = Math.Max(qRef, 1);
            double raw = min + (max - min) * Math.Sqrt(reference / (reference + q));
            return JsMath.Clamp(raw, min, max);
        }

        private static double RollMachLimiter(double mach, Fm2RollLawConfig roll)
        {
            double onset = roll.MachLimiterOnset ?? 0.85;
            if (mach <= onset)
            {
                return 1;
            }
            return JsMath.Clamp(1 - (mach - onset) / (roll.MachLimiterSlope ?? 0.55), roll.MachLimiterFloor ?? 0.35, 1);
        }

        private static double RollAltitudeLimiter(double altitudeM, Fm2RollLawConfig roll)
        {
            double onset = roll.AltLimiterOnsetM ?? 12000;
            if (altitudeM <= onset)
            {
                return 1;
            }
            return JsMath.Clamp(1 - (altitudeM - onset) / (roll.AltLimiterSlopeM ?? 20000), roll.AltLimiterFloor ?? 0.45, 1);
        }

        private static double RollAoaLimiter(double aoaRad, Fm2RollLawConfig roll)
        {
            double onset = roll.AoaLimiterOnsetDeg ?? 15;
            double aoaDeg = Math.Abs(aoaRad) / Deg;
            if (aoaDeg <= onset)
            {
                return 1;
            }
            return JsMath.Clamp(1 - (aoaDeg - onset) / (roll.AoaLimiterSlopeDeg ?? 22), roll.AoaLimiterFloor ?? 0.15, 1);
        }

        public void Reset()
        {
            elevator = 0;
            aileron = 0;
            rudder = 0;
            yawRateLowPass = 0;
            prevAoaRad = 0;
            prevLoadG = 1;
            aoaRateLowPass = 0;
            gRateLowPass = 0;
            authLowPass = 1;
            pitchTarget = 0;
            elevatorLimitHi = 1;
            elevatorLimitLo = -1;
        }

        public FcsOutput GetState() => new FcsOutput
        {
            Elevator = elevator,
            Aileron = aileron,
            Rudder = rudder,
            ElevatorLimitHi = elevatorLimitHi,
            ElevatorLimitLo = elevatorLimitLo,
        };

        public FcsOutput Update(in FcsInput input, double dt)
        {
            TrackPitchRates(input, dt);

            double elevatorTarget;
            double aileronTarget;
            double rudderTarget;

            if (input.LimitersEnabled == false)
            {
                elevatorTarget = JsMath.Clamp(input.PitchStick, -1, 1);
                aileronTarget = JsMath.Clamp(-input.RollStick, -1, 1);
                rudderTarget = JsMath.Clamp(input.YawPedal, -1, 1);
                elevatorLimitHi = 1;
                elevatorLimitLo = -1;
            }
            else
            {
                elevatorTarget = PitchLaw(input, dt);
                UpdateElevatorLimits(input, dt);
                aileronTarget = cfg.Roll.RateCommand
                    ? RateCommandRollLaw(input)
                    : DirectRollLaw(input);
                rudderTarget = YawLaw(input, aileronTarget, dt);
            }

            double a = dt <= 0 ? 1 : 1 - Math.Exp(-dt / Math.Max(cfg.ActuatorTauS, 1e-3));
            elevator += (elevatorTarget - elevator) * a;
            aileron += (aileronTarget - aileron) * a;
            rudder += (rudderTarget - rudder) * a;

            return GetState();
        }

        /// <summary>Publish the current AoA/g envelope caps for the HUD stick box.</summary>
        private void UpdateElevatorLimits(in FcsInput input, double dt)
        {
            double pullAuth = FilterAuthority(PitchAuthority(input.AoaRad, input.LoadFactorG, true), dt);
            double pushAuth = FilterAuthority(PitchAuthority(input.AoaRad, input.LoadFactorG, false), dt);
            elevatorLimitHi = pullAuth;
            elevatorLimitLo = -pushAuth;
        }

        /// <summary>Maintain filtered AoA-rate and g-rate estimates for the limiter laws.</summary>
        private void TrackPitchRates(in FcsInput input, double dt)
        {
            if (dt > 0)
            {
                double rawAoaRate = (input.AoaRad - prevAoaRad) / dt;
                double rawGRate = (input.LoadFactorG - prevLoadG) / dt;
                double tau = Math.Max(cfg.Pitch.AoaRateFilterTauS, 1e-3);
                double b = 1 - Math.Exp(-dt / tau);
                aoaRateLowPass += (rawAoaRate - aoaRateLowPass) * b;
                gRateLowPass += (rawGRate - gRateLowPass) * b;
            }
            prevAoaRad = input.AoaRad;
            prevLoadG = input.LoadFactorG;
        }

        /// <summary>Dispatch to the selected pitch AoA/g limiter strategy.</summary>
        private double PitchLaw(in FcsInput input, double dt)
        {
            switch (input.PitchLimiterMode)
            {
                case FcsPitchLimiter.Predictive:
                    return PitchLawPredictive(input, dt);
                case FcsPitchLimiter.Smooth:
                    return PitchLawSmooth(input, dt);
                default:
                    return PitchLawSoft(input, dt);
            }
        }

        /// <summary>
        /// Soft-band authority in [0, 1] for the requested direction: 1 well inside the
        /// envelope, 0 at the AoA or g hard limit (whichever bites first), with a
        /// smoothstep fade over each soft band.
        /// </summary>
        private double PitchAuthority(double aoaRad, double g, bool pull)
        {
            Fm2PitchLawConfig p = cfg.Pitch;
            double gMargin = p.GLimiterSoftMarginG ?? 1.0;
            double aoaDeg = aoaRad / Deg;
            if (pull)
            {
                double aoaAuthPull = 1 - Smoothstep(p.AoaSoftDeg, p.AoaLimitDeg, aoaDeg);
                double gAuthPull = 1 - Smoothstep(p.MaxCommandG - gMargin, p.MaxCommandG, g);
                return JsMath.Clamp(Math.Min(aoaAuthPull, gAuthPull), 0, 1);
            }
            double aoaAuth = 1 - Smoothstep(-p.AoaSoftDeg, -p.AoaLimitDeg, aoaDeg);
            double gAuth = 1 - Smoothstep(p.MinCommandG + gMargin, p.MinCommandG, g);
            return JsMath.Clamp(Math.Min(aoaAuth, gAuth), 0, 1);
        }

        private double FilterAuthority(double rawAuth, double dt, double tau = AuthFilterTauS)
        {
            double b = dt <= 0 ? 1 : 1 - Math.Exp(-dt / tau);
            authLowPass += (rawAuth - authLowPass) * b;
            return authLowPass;
        }

        /// <summary>
        /// Strategy 1, SOFT: feed-forward authority scaling on the current AoA/g plus
        /// pitch-rate damping. Open-loop on the envelope, so it cannot limit-cycle.
        /// </summary>
        private double PitchLawSoft(in FcsInput input, double dt)
        {
            double stick = input.PitchStick;
            double rawAuth = PitchAuthority(input.AoaRad, input.LoadFactorG, stick >= 0);
            double auth = FilterAuthority(rawAuth, dt);
            return JsMath.Clamp(stick * auth + PitchRateDamp * input.PitchRate, -1, 1);
        }

        /// <summary>
        /// Strategy 2, PREDICTIVE: the authority fade sees the lead-predicted AoA/g, so
        /// it eases the pull before the boundary; an alpha-dot damping term that grows
        /// as authority is withdrawn arrests the approach without a hard stop.
        /// </summary>
        private double PitchLawPredictive(in FcsInput input, double dt)
        {
            Fm2PitchLawConfig p = cfg.Pitch;
            double stick = input.PitchStick;
            bool pull = stick >= 0;
            double aoaLead = (p.AoaLimiterLeadS ?? 0.08) + (p.EnvelopeAuthorityLeadS ?? 0.2);
            double gLead = pull
                ? (p.GLimiterLeadS ?? 0.05) + (p.EnvelopeAuthorityLeadS ?? 0.2)
                : (p.GLimiterNegLeadS ?? 0.02) + (p.EnvelopeAuthorityLeadS ?? 0.2);
            double predAoa = input.AoaRad + aoaRateLowPass * aoaLead;
            double predG = input.LoadFactorG + gRateLowPass * gLead;

            double rawAuth = PitchAuthority(predAoa, predG, pull);
            double auth = FilterAuthority(rawAuth, dt, PredictAuthFilterTauS);

            // Alpha-dot damping grows toward the limit (1 - auth): a smooth aerodynamic
            // "wall", clamped so a transient spike can never jerk the stabilator.
            double aoaDamp = JsMath.Clamp(
                PredictAoaDamp * (1 - auth) * aoaRateLowPass,
                -PredictAoaDampClamp, PredictAoaDampClamp);
            return JsMath.Clamp(stick * auth + PitchRateDamp * input.PitchRate - aoaDamp, -1, 1);
        }

        /// <summary>
        /// Strategy 3, SMOOTH: the SOFT fade with a heavier authority low-pass and a
        /// slew-rate limit on the elevator target; the gentlest of the three.
        /// </summary>
        private double PitchLawSmooth(in FcsInput input, double dt)
        {
            double stick = input.PitchStick;
            double rawAuth = PitchAuthority(input.AoaRad, input.LoadFactorG, stick >= 0);
            double auth = FilterAuthority(rawAuth, dt, SmoothAuthFilterTauS);
            double target = JsMath.Clamp(stick * auth + PitchRateDamp * input.PitchRate, -1, 1);

            double maxStep = dt <= 0 ? 1 : SmoothSlewPerS * dt;
            pitchTarget = JsMath.Clamp(
                pitchTarget + JsMath.Clamp(target - pitchTarget, -maxStep, maxStep),
                -1, 1);
            return pitchTarget;
        }

        /// <summary>Mechanical direct roll: stick straight through, with roll-rate damping.</summary>
        private double DirectRollLaw(in FcsInput input)
        {
            return JsMath.Clamp(-input.RollStick - cfg.Roll.RateDamp * input.RollRate, -1, 1);
        }

        /// <summary>Roll-rate command law to aileron.</summary>
        private double RateCommandRollLaw(in FcsInput input)
        {
            if (input.Landed)
            {
                return 0;
            }
            double commandedRateRad = ComputeCommandedRollRate(input, cfg.Roll);
            double rateError = input.RollRate - commandedRateRad;
            return JsMath.Clamp(cfg.Roll.RateGain * rateError, -1, 1);
        }

        /// <summary>Yaw damper (washed out) + aileron-rudder interconnect + pedal.</summary>
        private double YawLaw(in FcsInput input, double aileronCmd, double dt)
        {
            Fm2YawLawConfig yaw = cfg.Yaw;
            double tau = Math.Max(yaw.DamperWashoutTauS, 1e-3);
            double a = dt <= 0 ? 1 : 1 - Math.Exp(-dt / tau);
            yawRateLowPass += (input.YawRate - yawRateLowPass) * a;
            double yawRateHighPass = input.YawRate - yawRateLowPass;

            double damper = -yaw.DamperGain * yawRateHighPass;
            double ari = yaw.AriGain * aileronCmd;
            double pedal = input.YawPedal * yaw.MaxRudderCmd;
            return JsMath.Clamp(pedal + damper + ari, -1, 1);
        }
    }
}
