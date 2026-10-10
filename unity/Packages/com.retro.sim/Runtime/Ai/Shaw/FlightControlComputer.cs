using System;
using Retro.Core;
using static Retro.Sim.AiMath;

namespace Retro.Sim
{
    /// <summary>
    /// Minimal shape <see cref="FlightControlComputer"/> actually consumes. Any
    /// tactical FSM's command type (Shaw's <see cref="FlightCommand"/>, Aggressive's
    /// <see cref="AggressiveFlightCommand"/>, ...) implements it — the extra
    /// state/maneuver-label fields those richer command types carry are for
    /// telemetry only and are ignored here.
    /// </summary>
    public interface IFlightSetpoint
    {
        /// <summary>World-space aim direction the nose should track.</summary>
        Vec3d TargetDirection { get; }
        /// <summary>Desired airspeed (m/s).</summary>
        double TargetSpeed { get; }
        /// <summary>When true, cut throttle hard (stand-in for speedbrakes).</summary>
        bool UseAirbrakes { get; }
        /// <summary>Allow the hard-turn pull when angular error is large.</summary>
        bool AllowHardTurn { get; }
    }

    public sealed class FlightControlComputerOptions
    {
        public double? MaxSpeed;
        public double? HardDeck;
        public double? PitchKp;
        public double? PitchKd;
        public double? PitchSlew;
    }

    /// <summary>
    /// Maps <see cref="IFlightSetpoint"/> setpoints into normalized stick/throttle for FM2.
    /// Uses the same P/PD bank/pitch/speed loops as classic AiPilot — not a naive
    /// independent PID that would fight the rate-commanded roll axis.
    /// </summary>
    public sealed class FlightControlComputer
    {
        // FM2-friendly gains — mirrored from AiPilot (rate-commanded roll → P-only bank).
        private const double ROLL_KP = 2.2;
        private const double ROLL_YAW_COORD = 0.05;
        private const double BANK_PER_HEADING = 2.5;
        private const double HEADING_DEADBAND = 1.0 * Math.PI / 180;
        private const double TURN_LATCH_ENTER = 150 * Math.PI / 180;
        private const double TURN_LATCH_RELEASE = 110 * Math.PI / 180;
        private const double MAX_BANK_COMBAT = 75 * Math.PI / 180;
        private const double PITCH_KP = 1.0;
        private const double PITCH_KD = 0.35;
        private const double PITCH_CMD_SLEW = 2.5;
        private const double PITCH_MIN = -0.7;
        private const double PITCH_MAX = 0.85;
        private const double MAX_ELEV_CMD = 50 * Math.PI / 180;
        private const double THROTTLE_KP = 0.04;
        private const double RATE_EMA = 0.35;
        private const double HARD_TURN_ENTER = 35 * Math.PI / 180;
        private const double HARD_TURN_EXIT = 12 * Math.PI / 180;
        private const double HARD_TURN_BANK_GAIN = 2.8;
        private const double HARD_TURN_MIN_PULL = 0.45;
        private const double HARD_TURN_FULL_PULL_ANGLE = 60 * Math.PI / 180;
        private const double REVERSAL_LATCH_ENTER = 150 * Math.PI / 180;
        private const double REVERSAL_LATCH_RELEASE = 110 * Math.PI / 180;
        private const double OVERSPEED_ELEV_GAIN = 0.01;
        private const double OVERSPEED_ELEV_MAX = 0.35;
        private const double OVERSPEED_IDLE_MARGIN = 15;
        private const double TERRAIN_LOOKAHEAD_S = 4;

        private readonly IPilotableAircraft aircraft;
        private readonly IWorldQuery world;
        private readonly double maxSpeed;
        private readonly double hardDeck;
        private readonly double pitchKp;
        private readonly double pitchKd;
        private readonly double pitchSlew;

        private double throttleCmd = 0.5;
        private double pitchCmdState;
        private double lastDelta = 1.0 / 60;
        private double turnDir;
        private double reversalDir;
        private bool hardTurnActive;
        private bool pullUpActive;
        private double prevNosePitch;
        private bool hasPrevAttitude;
        private double pitchRateEst;

        private Vec3d pos;
        private Vec3d vel;
        private Quatd quat;
        private Vec3d fwd;
        private Vec3d right;
        private Vec3d up;
        private Vec3d aimDir;
        private Vec3d probe;

        public FlightControlComputer(IPilotableAircraft aircraft, IWorldQuery world, FlightControlComputerOptions options = null)
        {
            options ??= new FlightControlComputerOptions();
            this.aircraft = aircraft;
            this.world = world;
            maxSpeed = options.MaxSpeed ?? 240;
            hardDeck = options.HardDeck ?? 150;
            pitchKp = options.PitchKp ?? PITCH_KP;
            pitchKd = options.PitchKd ?? PITCH_KD;
            pitchSlew = options.PitchSlew ?? PITCH_CMD_SLEW;
        }

        /// <summary>
        /// Apply a tactical command. Returns true if terrain pull-up pre-empted the
        /// command this frame (caller should suppress firing).
        /// </summary>
        public bool ApplyCommand(IFlightSetpoint command, double delta)
        {
            ReadState(delta);
            aircraft.SetLandingGearDeployed(false);
            aircraft.SetFlapsExtended(false);
            aircraft.SetAirbrakesExtended(command.UseAirbrakes);
            aircraft.SetWheelBrakes(false);

            if (UpdateTerrainAvoidance())
            {
                return true;
            }

            aimDir = command.TargetDirection;
            if (aimDir.LengthSquared < 1e-9)
            {
                aimDir = fwd;
            }
            else
            {
                aimDir = Normalize(aimDir);
            }

            double desiredSpeed = Math.Min(command.TargetSpeed, maxSpeed);
            if (command.UseAirbrakes)
            {
                desiredSpeed = Math.Min(desiredSpeed, aircraft.GetAirspeed() * 0.85);
                throttleCmd = Math.Min(throttleCmd, 0.15);
            }

            if (command.AllowHardTurn && CommandHardTurn(aimDir, desiredSpeed))
            {
                return false;
            }

            double desiredHeading = JsTrig.Atan2(aimDir.X, aimDir.Z);
            double desiredElev = JsTrig.Asin(JsMath.Clamp(aimDir.Y, -1, 1));
            CommandHeading(desiredHeading, MAX_BANK_COMBAT);
            CommandElevation(desiredElev);
            CommandSpeed(desiredSpeed, delta);
            return false;
        }

        private void ReadState(double delta)
        {
            lastDelta = delta > 1e-4 ? delta : lastDelta;
            pos = aircraft.GetPosition();
            vel = aircraft.GetVelocity();
            quat = aircraft.GetQuaternion();
            fwd = SimConstants.Forward.Rotate(quat);
            right = SimConstants.Right.Rotate(quat);
            up = SimConstants.Up.Rotate(quat);

            double nosePitch = JsTrig.Asin(JsMath.Clamp(fwd.Y, -1, 1));
            if (hasPrevAttitude && delta > 1e-4)
            {
                double pitchRateRaw = (nosePitch - prevNosePitch) / delta;
                pitchRateEst += (pitchRateRaw - pitchRateEst) * RATE_EMA;
            }
            else
            {
                pitchRateEst = 0;
            }
            prevNosePitch = nosePitch;
            hasPrevAttitude = true;
        }

        private double Heading => JsTrig.Atan2(fwd.X, fwd.Z);

        private double Bank => JsTrig.Atan2(right.Y, up.Y);

        private double NosePitch => JsTrig.Asin(JsMath.Clamp(fwd.Y, -1, 1));

        private void CommandBank(double desiredBank)
        {
            double rollCmd = JsMath.Clamp((desiredBank - Bank) * ROLL_KP, -1, 1);
            aircraft.SetRoll(rollCmd);
        }

        private void CommandHeading(double desiredHeading, double maxBank)
        {
            double hErr = WrapPi(desiredHeading - Heading);
            if (turnDir != 0)
            {
                if (Math.Abs(hErr) < TURN_LATCH_RELEASE)
                {
                    turnDir = 0;
                }
                else
                {
                    hErr = turnDir * Math.Abs(hErr);
                }
            }
            else if (Math.Abs(hErr) > TURN_LATCH_ENTER)
            {
                turnDir = hErr >= 0 ? 1 : -1;
                hErr = turnDir * Math.Abs(hErr);
            }
            if (Math.Abs(hErr) < HEADING_DEADBAND)
            {
                hErr = 0;
            }
            double desiredBank = JsMath.Clamp(-hErr * BANK_PER_HEADING, -maxBank, maxBank);
            CommandBank(desiredBank);
            aircraft.SetYaw(JsMath.Clamp(Bank * ROLL_YAW_COORD, -0.3, 0.3));
        }

        private void CommandElevation(double desiredElev)
        {
            desiredElev = JsMath.Clamp(desiredElev, -MAX_ELEV_CMD, MAX_ELEV_CMD);
            double over = aircraft.GetAirspeed() - maxSpeed;
            if (over > 0)
            {
                desiredElev = Math.Max(desiredElev, JsMath.Clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX));
            }
            double pitchErr = desiredElev - NosePitch;
            double raw = pitchErr * pitchKp + BankPitchComp() - pitchRateEst * pitchKd;
            ApplyPitch(raw);
        }

        private void ApplyPitch(double raw)
        {
            double target = LimitPitchForAttitude(raw);
            double maxStep = pitchSlew * lastDelta;
            pitchCmdState += JsMath.Clamp(target - pitchCmdState, -maxStep, maxStep);
            aircraft.SetPitch(pitchCmdState);
        }

        private void ApplyPitchImmediate(double raw)
        {
            pitchCmdState = LimitPitchForAttitude(raw);
            aircraft.SetPitch(pitchCmdState);
        }

        private double LimitPitchForAttitude(double pitch)
        {
            if (up.Y < 0)
            {
                return JsMath.Clamp(pitch, PITCH_MIN, 0.1);
            }
            return JsMath.Clamp(pitch, PITCH_MIN, PITCH_MAX);
        }

        private double BankPitchComp()
        {
            if (up.Y <= 0) return 0;
            double c = JsTrig.Cos(JsMath.Clamp(Bank, -1.4, 1.4));
            if (c <= 0.05) return 0.35;
            return JsMath.Clamp((1 / c - 1) * 0.25, 0, 0.5);
        }

        private void CommandSpeed(double desiredSpeed, double delta)
        {
            desiredSpeed = Math.Min(desiredSpeed, maxSpeed);
            double airspeed = aircraft.GetAirspeed();
            double speedErr = desiredSpeed - airspeed;
            throttleCmd = JsMath.Clamp(throttleCmd + speedErr * THROTTLE_KP * delta, 0, 1);
            if (airspeed > maxSpeed + OVERSPEED_IDLE_MARGIN)
            {
                throttleCmd = 0;
            }
            aircraft.SetThrottle(throttleCmd);
        }

        private bool CommandHardTurn(Vec3d aimDirection, double desiredSpeed)
        {
            aimDir = Normalize(aimDirection);
            double aimAngle = JsTrig.Acos(JsMath.Clamp(Vec3d.Dot(fwd, aimDir), -1, 1));
            if (hardTurnActive)
            {
                if (aimAngle < HARD_TURN_EXIT)
                {
                    hardTurnActive = false;
                }
            }
            else if (aimAngle > HARD_TURN_ENTER)
            {
                hardTurnActive = true;
            }
            if (!hardTurnActive)
            {
                return false;
            }

            double desiredHeading = JsTrig.Atan2(aimDir.X, aimDir.Z);
            double hErr = WrapPi(desiredHeading - Heading);
            if (reversalDir != 0)
            {
                if (Math.Abs(hErr) < REVERSAL_LATCH_RELEASE)
                {
                    reversalDir = 0;
                }
                else
                {
                    hErr = reversalDir * Math.Abs(hErr);
                }
            }
            else if (Math.Abs(hErr) > REVERSAL_LATCH_ENTER)
            {
                reversalDir = hErr >= 0 ? 1 : -1;
                hErr = reversalDir * Math.Abs(hErr);
            }
            double desiredBank = JsMath.Clamp(-hErr * HARD_TURN_BANK_GAIN, -MAX_BANK_COMBAT, MAX_BANK_COMBAT);
            CommandBank(desiredBank);
            aircraft.SetYaw(JsMath.Clamp(Bank * ROLL_YAW_COORD, -0.3, 0.3));

            double pullT = JsMath.Clamp(aimAngle / HARD_TURN_FULL_PULL_ANGLE, 0, 1);
            double pull = HARD_TURN_MIN_PULL + pullT * (PITCH_MAX - HARD_TURN_MIN_PULL);
            ApplyPitchImmediate(pull);

            double over = aircraft.GetAirspeed() - maxSpeed;
            if (over > 0)
            {
                double floor = JsMath.Clamp(over * OVERSPEED_ELEV_GAIN, 0, OVERSPEED_ELEV_MAX);
                ApplyPitchImmediate(Math.Max(pull, floor));
            }

            CommandSpeed(desiredSpeed, lastDelta);
            return true;
        }

        private bool UpdateTerrainAvoidance()
        {
            double minClearance = double.PositiveInfinity;
            for (double t = 0.5; t <= TERRAIN_LOOKAHEAD_S; t += 0.5)
            {
                probe = vel * t + pos;
                double g = world.GroundHeightAt(probe.X, probe.Z);
                minClearance = Math.Min(minClearance, probe.Y - g);
            }
            double nowClearance = pos.Y - world.GroundHeightAt(pos.X, pos.Z);
            minClearance = Math.Min(minClearance, nowClearance);

            if (pullUpActive)
            {
                if (minClearance > hardDeck * 2.0 && nowClearance > hardDeck)
                {
                    pullUpActive = false;
                }
            }
            else if (minClearance < hardDeck)
            {
                pullUpActive = true;
            }

            if (!pullUpActive)
            {
                return false;
            }

            CommandBank(0);
            aircraft.SetYaw(0);
            ApplyPitch(PITCH_MAX);
            throttleCmd = 1;
            aircraft.SetThrottle(1);
            return true;
        }
    }
}
