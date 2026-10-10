using System;
using Retro.Core;

namespace Retro.Sim
{
    public sealed class Fm3PitchFcsConfig
    {
        public double MaxG;
        public double MinG;
        /// <summary>Stick shaping, 0 = linear ... 1 = cubic.</summary>
        public double StickExpo;
        /// <summary>Pitch-rate command at full stick where the rate law rules (rad/s).</summary>
        public double MaxPitchRate;
        /// <summary>Dynamic pressure band (Pa) over which the rate law hands over to the g law.</summary>
        public double BlendQbarLow;
        public double BlendQbarHigh;
        /// <summary>Gains at QbarRef, scheduled proportional to QbarRef / qbar within [ScheduleMin, ScheduleMax].</summary>
        public double QbarRef;
        public double ScheduleMin;
        public double ScheduleMax;
        /// <summary>Stabilator (rad) per g of error.</summary>
        public double Kg;
        /// <summary>Stabilator (rad) per (rad/s) of pitch-rate error (rate law).</summary>
        public double KqCommand;
        /// <summary>Integral gain (per second, on the stabilator-unit error).</summary>
        public double Ki;
        public double IntegratorLimit;
        /// <summary>Pitch-rate damping (rad of stabilator per rad/s).</summary>
        public double Kq;
        /// <summary>AoA feedback (rad of stabilator per rad).</summary>
        public double KAlpha;
        /// <summary>Lead on the load factor fed to the g loop (s).</summary>
        public double GLead;
        /// <summary>First-order prefilter on the g command (s): a stick step asks for g gradually.</summary>
        public double CommandTau;
        /// <summary>Lead on the load factor the structural g limits protect (s), longer than GLead.</summary>
        public double GLimitLead;
        public double AlphaLimit;
        public double NegativeAlphaLimit;
        /// <summary>Lead on the AoA the limiter protects (s).</summary>
        public double AlphaLead;
        /// <summary>Headroom to the AoA limit, in g of allowed command per radian.</summary>
        public double AlphaLimitG;
        /// <summary>Band below the limit over which AoA feedback fades out with limiters off.</summary>
        public double AlphaFadeBand;
        public double MaxStab;
    }

    public sealed class Fm3RollFcsConfig
    {
        public double MaxRate;
        /// <summary>Aileron (rad) per rad/s of stability-axis roll-rate error.</summary>
        public double Kp;
        /// <summary>Cap on the dynamic-pressure schedule for the lateral loops (roll and yaw damper).</summary>
        public double ScheduleMax;
        /// <summary>Commanded roll rate fades between these AoA with the limiters on.</summary>
        public double AlphaFadeStart;
        public double AlphaFadeEnd;
        public double AlphaFadeFloor;
        /// <summary>Lateral feedback gains fade between these AoA, whatever the limiters.</summary>
        public double GainFadeStart;
        public double GainFadeEnd;
        public double GainFadeFloor;
        /// <summary>Differential stabilator per unit aileron.</summary>
        public double DifferentialStab;
        public double MaxAileron;
    }

    public sealed class Fm3YawFcsConfig
    {
        /// <summary>Rudder (rad) per rad/s of washed-out stability-axis yaw rate.</summary>
        public double Kr;
        public double WashoutTau;
        /// <summary>Rudder per unit aileron per radian of AoA.</summary>
        public double AriPerAlpha;
        public double AriMax;
        public double MaxRudder;
        public double PedalFadeStart;
        public double PedalFadeEnd;
        /// <summary>Rudder (rad) per rad of sideslip.</summary>
        public double KBeta;
        public double AntiSpinAlpha;
        public double AntiSpinGain;
    }

    public sealed class Fm3FcsConfig
    {
        public Fm3PitchFcsConfig Pitch;
        public Fm3RollFcsConfig Roll;
        public Fm3YawFcsConfig Yaw;
        public bool LefEnabled;
        /// <summary>Trailing-edge flap deflection with flaps extended.</summary>
        public double FlapDeflection;
        public double SpeedbrakeAngle;
    }

    public sealed class Fm3FcsInput
    {
        public double PitchStick;
        public double RollStick;
        public double Pedal;
        public double Alpha;
        public double Beta;
        public double P;
        public double Q;
        public double R;
        public double Nz;
        public double Qbar;
        public double StaticPressure;
        public bool Landed;
        public bool LimitersEnabled;
        public bool FlapsExtended;
        public bool AirbrakesExtended;
    }

    /// <summary>
    /// FM3 flight control system, laid out like the F-16's (port of physics/fm3/fcs.ts).
    ///
    ///  - Pitch: normal-acceleration command blended with pitch-rate command at low
    ///    dynamic pressure, proportional-integral on the error, pitch-rate damping,
    ///    and angle-of-attack feedback that gives the relaxed-stability airframe its
    ///    apparent static stability. Envelope protection is a min-select: the g
    ///    error the loop acts on can never exceed the headroom left to the AoA limit,
    ///    both taken from lead-predicted values.
    ///  - Roll: roll-rate command, faded at high AoA.
    ///  - Yaw: washed-out stability-axis yaw damper, aileron-rudder interconnect
    ///    growing with AoA, pedal authority faded at high AoA, and automatic spin
    ///    prevention above 29 degrees AoA.
    ///  - Leading-edge flaps on the Stevens and Lewis schedule.
    ///
    /// With the limiters off the AoA limit, the high-AoA roll and pedal fades and
    /// spin prevention go, and AoA feedback fades out past the limit; the stability
    /// augmentation stays.
    ///
    /// Sensor and command conventions are NASA: alpha, beta, p, q, r; stabilator and
    /// flaperon trailing edge down positive; rudder positive = nose right.
    /// </summary>
    public sealed class Fm3Fcs
    {
        private const double Deg = Math.PI / 180;
        /// <summary>Low-pass time constant for the alpha-dot and n-dot estimates (s).</summary>
        private const double RateFilterTauS = 0.05;

        private readonly Fm3FcsConfig cfg;
        private double integrator;
        private double yawLowPass;
        private double lastStab;
        private double alphaRate;
        private double nzRate;
        private double prevAlpha;
        private double prevNz = 1;
        private bool hasPrev;
        private double nCommand = 1;
        /// <summary>Roll command in [-1, 1] after shaping and fades, for the HUD / animation.</summary>
        public double RollCommand;

        public Fm3Fcs(Fm3FcsConfig cfg)
        {
            this.cfg = cfg;
        }

        public void Reset()
        {
            integrator = 0;
            yawLowPass = 0;
            lastStab = 0;
            alphaRate = 0;
            nzRate = 0;
            hasPrev = false;
            nCommand = 1;
            RollCommand = 0;
        }

        /// <summary>Preload the pitch integrator so a spawn starts near 1 g without a transient.</summary>
        public void TrimTo(double stab, Fm3FcsInput input)
        {
            Fm3PitchFcsConfig p = cfg.Pitch;
            double k = Schedule(input.Qbar);
            double feedback = k * (p.Kq * input.Q + p.KAlpha * input.Alpha);
            integrator = JsMath.Clamp((feedback - stab) / Math.Max(1e-6, k * p.Ki), -p.IntegratorLimit, p.IntegratorLimit);
            lastStab = stab;
            hasPrev = false;
        }

        private double Schedule(double qbar)
        {
            Fm3PitchFcsConfig p = cfg.Pitch;
            return JsMath.Clamp(p.QbarRef / Math.Max(qbar, 1), p.ScheduleMin, p.ScheduleMax);
        }

        /// <summary>Writes channel commands (rad) into o, indexed by Fm3Channel.</summary>
        public void Update(Fm3FcsInput input, double dt, double[] o)
        {
            Fm3PitchFcsConfig cp = cfg.Pitch;
            Fm3RollFcsConfig cr = cfg.Roll;
            Fm3YawFcsConfig cy = cfg.Yaw;
            bool limiters = input.LimitersEnabled;
            double alpha = input.Alpha;
            double k = Schedule(input.Qbar);

            if (dt > 0 && hasPrev)
            {
                double b = 1 - Math.Exp(-dt / RateFilterTauS);
                alphaRate += ((alpha - prevAlpha) / dt - alphaRate) * b;
                nzRate += ((input.Nz - prevNz) / dt - nzRate) * b;
            }
            prevAlpha = alpha;
            prevNz = input.Nz;
            hasPrev = true;

            // ---- Pitch ----
            double stick = JsMath.Clamp(input.PitchStick, -1, 1);
            double s = (1 - cp.StickExpo) * stick + cp.StickExpo * stick * stick * stick;
            double nTarget = s >= 0 ? 1 + s * (cp.MaxG - 1) : 1 + s * (1 - cp.MinG);
            nCommand += (nTarget - nCommand) * (dt > 0 ? 1 - Math.Exp(-dt / Math.Max(cp.CommandTau, 1e-3)) : 1);
            double blend = input.Landed ? 0 : Smoothstep(cp.BlendQbarLow, cp.BlendQbarHigh, input.Qbar);
            double gError = nCommand - (input.Nz + cp.GLead * nzRate);
            double rateError = s * cp.MaxPitchRate - input.Q;
            double error = blend * cp.Kg * gError + (1 - blend) * cp.KqCommand * rateError;
            if (limiters)
            {
                // Envelope protection: never ask for more than the headroom to the
                // lead-predicted AoA and g limits, in the same stabilator units.
                double alphaPredicted = alpha + cp.AlphaLead * alphaRate;
                double nPredicted = input.Nz + cp.GLimitLead * nzRate;
                double upper = Math.Min(
                    cp.Kg * cp.AlphaLimitG * (cp.AlphaLimit - alphaPredicted),
                    cp.Kg * (cp.MaxG - nPredicted));
                double lower = Math.Max(
                    cp.Kg * cp.AlphaLimitG * (cp.NegativeAlphaLimit - alphaPredicted),
                    cp.Kg * (cp.MinG - nPredicted));
                if (error > upper) error = upper;
                if (error < lower) error = lower;
            }

            double alphaFade = limiters ? 1 : 1 - Smoothstep(cp.AlphaLimit - cp.AlphaFadeBand, cp.AlphaLimit, alpha);
            double damping = k * cp.Kq * input.Q;
            if (!limiters)
            {
                // Past the envelope the pilot, not the damper, owns the stabilator:
                // pitch rocking a deep stall has to be possible.
                damping = JsMath.Clamp(damping, -0.4 * cp.MaxStab, 0.4 * cp.MaxStab);
            }
            double stab = -k * (error + cp.Ki * integrator) + damping + k * cp.KAlpha * alphaFade * alpha;
            bool saturatedHigh = stab >= cp.MaxStab && error < 0;
            bool saturatedLow = stab <= -cp.MaxStab && error > 0;
            if (input.Landed)
            {
                integrator *= Math.Exp(-dt / 0.5);
            }
            else if (!saturatedHigh && !saturatedLow)
            {
                integrator = JsMath.Clamp(integrator + error * dt, -cp.IntegratorLimit, cp.IntegratorLimit);
            }
            stab = JsMath.Clamp(stab, -cp.MaxStab, cp.MaxStab);
            lastStab = stab;

            // ---- Roll ----
            double rollFade = 1;
            if (limiters)
            {
                double t = Smoothstep(cr.AlphaFadeStart, cr.AlphaFadeEnd, Math.Abs(alpha));
                rollFade = 1 - (1 - cr.AlphaFadeFloor) * t;
            }
            bool antiSpin = limiters && alpha > cy.AntiSpinAlpha;
            double rollStick = antiSpin ? 0 : JsMath.Clamp(input.RollStick, -1, 1);
            double pCmd = rollStick * cr.MaxRate * rollFade;
            RollCommand = rollStick * rollFade;
            // Roll about the velocity vector (stability axes), as the F-16's system
            // does: rolling about the body axis at high AoA would trade angle of
            // attack for sideslip. The lateral feedback gains are capped at low
            // dynamic pressure and fade at high AoA, where the surfaces lose
            // effectiveness and a high-gain damper only drives itself into a cycle.
            double cosA = Math.Cos(alpha), sinA = Math.Sin(alpha);
            double pStab = input.P * cosA + input.R * sinA;
            double rStab = input.R * cosA - input.P * sinA;
            double gainFade = 1 - (1 - cr.GainFadeFloor) * Smoothstep(cr.GainFadeStart, cr.GainFadeEnd, Math.Abs(alpha));
            double kLat = Math.Min(k, cr.ScheduleMax) * gainFade;
            double aileron = JsMath.Clamp(kLat * cr.Kp * (pCmd - pStab), -cr.MaxAileron, cr.MaxAileron);

            // ---- Yaw ----
            yawLowPass += (rStab - yawLowPass) * (1 - Math.Exp(-dt / cy.WashoutTau));
            double washed = rStab - yawLowPass;
            double rudder;
            if (antiSpin)
            {
                rudder = -cy.AntiSpinGain * input.R;
            }
            else
            {
                double pedalFade = limiters ? 1 - Smoothstep(cy.PedalFadeStart, cy.PedalFadeEnd, alpha) : 1;
                double ari = JsMath.Clamp(cy.AriPerAlpha * alpha, 0, cy.AriMax) * aileron;
                rudder = JsMath.Clamp(input.Pedal, -1, 1) * cy.MaxRudder * pedalFade - kLat * cy.Kr * washed + ari + gainFade * cy.KBeta * input.Beta;
            }
            rudder = JsMath.Clamp(rudder, -cy.MaxRudder, cy.MaxRudder);

            // ---- Mixing ----
            double flap = input.FlapsExtended ? cfg.FlapDeflection : 0;
            double diff = aileron * cr.DifferentialStab;
            o[(int)Fm3Channel.StabL] = stab + diff;
            o[(int)Fm3Channel.StabR] = stab - diff;
            o[(int)Fm3Channel.FlapL] = flap + aileron;
            o[(int)Fm3Channel.FlapR] = flap - aileron;
            o[(int)Fm3Channel.Rudder] = rudder;
            o[(int)Fm3Channel.Speedbrake] = input.AirbrakesExtended ? cfg.SpeedbrakeAngle : 0;

            o[(int)Fm3Channel.Lef] = cfg.LefEnabled && !input.Landed
                ? LeadingEdgeFlapSchedule(alpha, input.Qbar, input.StaticPressure)
                : 0;
        }

        /// <summary>Last symmetric stabilator command (rad).</summary>
        public double StabCommand => lastStab;

        /// <summary>
        /// The F-16's leading-edge flap deflection (rad) at angle of attack alpha,
        /// Stevens and Lewis: 1.38 alpha_deg - 9.05 qbar/p_s + 1.45, limited to 0..25 degrees.
        /// </summary>
        public static double LeadingEdgeFlapSchedule(double alpha, double qbar, double staticPressure)
        {
            double deg = 1.38 * alpha / Deg - 9.05 * qbar / Math.Max(staticPressure, 1) + 1.45;
            return JsMath.Clamp(deg, 0, 25) * Deg;
        }

        private static double Smoothstep(double edge0, double edge1, double x)
        {
            if (edge1 == edge0) return x < edge0 ? 0 : 1;
            double t = JsMath.Clamp((x - edge0) / (edge1 - edge0), 0, 1);
            return t * t * (3 - 2 * t);
        }

        /// <summary>Gains for the F-16, tuned with tools/fm3/stepResponses.ts.</summary>
        public static readonly Fm3FcsConfig F16 = new Fm3FcsConfig
        {
            Pitch = new Fm3PitchFcsConfig
            {
                MaxG = 9,
                MinG = -3,
                StickExpo = 0.6,
                MaxPitchRate = 20 * Deg,
                BlendQbarLow = 2500,
                BlendQbarHigh = 6000,
                QbarRef = 12000,
                ScheduleMin = 0.15,
                ScheduleMax = 3,
                Kg = 0.06,
                KqCommand = 0.8,
                Ki = 1.5,
                IntegratorLimit = 0.5,
                Kq = 0.35,
                KAlpha = 0.5,
                GLead = 0.15,
                CommandTau = 0.12,
                GLimitLead = 0.35,
                AlphaLimit = 25 * Deg,
                NegativeAlphaLimit = -5 * Deg,
                AlphaLead = 0.3,
                AlphaLimitG = 30,
                AlphaFadeBand = 5 * Deg,
                MaxStab = 25 * Deg,
            },
            Roll = new Fm3RollFcsConfig
            {
                MaxRate = 300 * Deg,
                Kp = 0.2,
                ScheduleMax = 1.5,
                AlphaFadeStart = 15 * Deg,
                AlphaFadeEnd = 30 * Deg,
                AlphaFadeFloor = 0.2,
                GainFadeStart = 30 * Deg,
                GainFadeEnd = 60 * Deg,
                GainFadeFloor = 0.25,
                DifferentialStab = 5.375 / 21.5,
                MaxAileron = 21.5 * Deg,
            },
            Yaw = new Fm3YawFcsConfig
            {
                Kr = 0.8,
                WashoutTau = 1.0,
                AriPerAlpha = 1.0,
                AriMax = 0.5,
                MaxRudder = 30 * Deg,
                PedalFadeStart = 20 * Deg,
                PedalFadeEnd = 30 * Deg,
                KBeta = 0.5,
                AntiSpinAlpha = 29 * Deg,
                AntiSpinGain = 1.5,
            },
            LefEnabled = true,
            FlapDeflection = 20 * Deg,
            SpeedbrakeAngle = 60 * Deg,
        };
    }
}
