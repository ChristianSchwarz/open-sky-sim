using System;
using System.Collections.Generic;
using Retro.Core;

namespace Retro.Sim
{
    /// <summary>Callbacks the input handler uses to read and mutate the owning aircraft.</summary>
    public interface ISimPlayerInputSink
    {
        SimControlMode Control { get; }
        double Health { get; }
        bool IsLanded();
        bool IsOnGround();
        bool IsCrashed();
        double GetThrottle();
        bool GetAfterburner();
        bool IsGearDeployed();
        bool IsFlapsExtended();
        bool IsAirbrakesExtended();
        bool IsHookDeployed();
        void ToggleGear();
        void ToggleFlaps();
        void ToggleAirbrakes();
        void ToggleHook();
        void ToggleAutopilot();
        void SetPitchLimiterMode(FcsPitchLimiter mode);
    }

    /// <summary>The input values packed into the render snapshot for HUD / telemetry.</summary>
    public sealed class SimInputMirror
    {
        public double Pitch;
        public double Roll;
        public double Yaw;
        public double Throttle;
        public double PitchStickUnits;
        public bool WheelBrakes;
        public bool LimitersEnabled;
        public FcsPitchLimiter PitchLimiterMode;
        public bool Autopilot;
    }

    /// <summary>
    /// Sim-side keyboard / gamepad input for one externally-controlled aircraft
    /// (port of physics/sim/simPlayerInput.ts). The client posts raw key events;
    /// this turns them into normalized <see cref="SimControlInputs"/> each physics step.
    /// </summary>
    public sealed class SimPlayerInput
    {
        // src/script/defs.ts
        public const double ThrottleRate = 33;
        public const double PitchStickFwdUnits = 20;
        public const double PitchStickAftUnits = 80;
        public const double PitchStickBaseUnitRate = 10;
        public const double PitchStickMaxUnitRate = 80;
        public const double PitchStickUnitAccel = 120;

        private enum Stick
        {
            IDLE,
            POSITIVE_ENDED,
            NEGATIVE_ENDED,
            POSITIVE,
            NEGATIVE,
        }

        private KeyboardControlLayoutId layoutId = KeyboardControlLayoutId.ARROWS;
        private KeyboardControlLayout layout = KeyboardLayouts.GetKeyboardLayout(KeyboardControlLayoutId.ARROWS);
        private KeyboardPitchStickMode pitchStickMode = KeyboardPitchStickMode.LAYOUT_DEFAULT;

        private Stick pitchState = Stick.IDLE;
        private Stick rollState = Stick.IDLE;
        private Stick yawState = Stick.IDLE;
        private Stick throttleState = Stick.IDLE;
        private bool wheelBrakeHeld;
        private bool wKeyDown;
        private double pitchHoldSeconds;
        private double pitchUnitAccum;
        private readonly HashSet<string> keysDown = new HashSet<string>();

        private double pitch;
        private double pitchStickUnits;
        private double roll;
        private double yaw;
        private double throttle;
        private bool wheelBrakes;
        private bool limitersEnabled = true;
        private FcsPitchLimiter pitchLimiterMode = FcsPitchLimiter.Soft;
        private bool firing;
        private bool forceVectorsRequested;

        private bool inputEnabled = true;

        /// <summary>Gamepad axes, or NaN when disconnected.</summary>
        private double gamepadPitch = double.NaN;
        private double gamepadRoll = double.NaN;
        private double gamepadYaw = double.NaN;
        private double gamepadThrottle = double.NaN;

        public void SetKeyboardLayout(KeyboardControlLayoutId id)
        {
            layoutId = id;
            layout = KeyboardLayouts.GetKeyboardLayout(id);
        }

        public void SetKeyboardPitchStickMode(KeyboardPitchStickMode mode)
        {
            pitchStickMode = mode;
            pitchState = Stick.IDLE;
            SetPitchDeflection(0);
        }

        public void SetInputEnabled(bool enabled)
        {
            inputEnabled = enabled;
            if (!enabled)
            {
                ClearSticks();
            }
        }

        public void SetForceVectorsRequested(bool want)
        {
            forceVectorsRequested = want;
        }

        public void SetGamepadAxes(double pitchAxis, double rollAxis, double yawAxis, double throttleAxis, bool connected)
        {
            if (!connected)
            {
                gamepadPitch = double.NaN;
                gamepadRoll = double.NaN;
                gamepadYaw = double.NaN;
                gamepadThrottle = double.NaN;
                return;
            }
            gamepadPitch = pitchAxis;
            gamepadRoll = rollAxis;
            gamepadYaw = yawAxis;
            gamepadThrottle = throttleAxis;
        }

        public void Blur()
        {
            keysDown.Clear();
            ClearSticks();
        }

        /// <summary>Initialize throttle after spawn / reset.</summary>
        public void SyncThrottle(double value)
        {
            throttle = value;
        }

        public void KeyDown(string key, bool repeat, ISimPlayerInputSink sink)
        {
            if (repeat && IsLayoutKey(key))
            {
                return;
            }
            keysDown.Add(key);

            if (!inputEnabled || sink.Control == SimControlMode.Ai)
            {
                return;
            }
            if (sink.Health <= 0 || sink.IsCrashed())
            {
                return;
            }

            if (HandleWheelBrakeKeyDown(key, sink))
            {
                return;
            }
            if (key == "w")
            {
                wKeyDown = true;
            }
            if (key == " " || key == "space")
            {
                firing = true;
                return;
            }
            HandleLayoutKeyDown(key, sink);
            HandleActionKeyDown(key, sink);
        }

        public void KeyUp(string key, ISimPlayerInputSink sink)
        {
            keysDown.Remove(key);

            if (!inputEnabled || sink.Control == SimControlMode.Ai)
            {
                return;
            }
            if (sink.Health <= 0 || sink.IsCrashed())
            {
                return;
            }

            if (HandleWheelBrakeKeyUp(key))
            {
                return;
            }
            if (key == "w")
            {
                wKeyDown = false;
            }
            if (key == " " || key == "space")
            {
                firing = false;
                return;
            }
            HandleLayoutKeyUp(key);
        }

        /// <summary>Advance stick/throttle state and produce this frame's control inputs.</summary>
        public SimControlInputs Tick(double delta, ISimPlayerInputSink sink)
        {
            if (sink.Health <= 0 || sink.IsCrashed())
            {
                return NeutralInputs(false, sink);
            }
            if (!inputEnabled || sink.Control == SimControlMode.Ai)
            {
                return NeutralInputs(false, sink);
            }

            if (!double.IsNaN(gamepadPitch) && !double.IsInfinity(gamepadPitch))
            {
                ApplyGamepad();
            }
            else
            {
                TickKeyboardSticks(delta, sink);
            }

            return new SimControlInputs
            {
                Pitch = pitch,
                Roll = roll,
                Yaw = yaw,
                Throttle = throttle,
                LandingGearDeployed = sink.IsGearDeployed(),
                FlapsExtended = sink.IsFlapsExtended(),
                AirbrakesExtended = sink.IsAirbrakesExtended(),
                HookDeployed = sink.IsHookDeployed(),
                WheelBrakesApplied = wheelBrakes,
                PitchLimiterMode = pitchLimiterMode,
                LimitersEnabled = limitersEnabled,
                WantForceVectors = forceVectorsRequested,
                Firing = firing,
            };
        }

        /// <summary>Mirror values packed into the render snapshot for HUD / telemetry.</summary>
        public void ReadMirror(SimInputMirror output, SimControlMode control)
        {
            output.Pitch = pitch;
            output.Roll = roll;
            output.Yaw = yaw;
            output.Throttle = throttle;
            output.PitchStickUnits = pitchStickUnits;
            output.WheelBrakes = wheelBrakes;
            output.LimitersEnabled = limitersEnabled;
            output.PitchLimiterMode = pitchLimiterMode;
            output.Autopilot = control == SimControlMode.Ai;
        }

        private void ApplyGamepad()
        {
            pitch = JsMath.Clamp(gamepadPitch, -1, 1);
            roll = JsMath.Clamp(gamepadRoll, -1, 1);
            yaw = JsMath.Clamp(gamepadYaw, -1, 1);
            throttle = JsMath.Clamp(gamepadThrottle, 0, 1);
            pitchStickUnits = pitch >= 0
                ? pitch * PitchStickAftUnits
                : pitch * PitchStickFwdUnits;
        }

        private void TickKeyboardSticks(double delta, ISimPlayerInputSink sink)
        {
            if (wKeyDown && CanApplyWheelBrakes(sink))
            {
                if (!wheelBrakeHeld)
                {
                    EngageWheelBrakes();
                }
            }
            else if (wheelBrakeHeld && !(wKeyDown && CanApplyWheelBrakes(sink)))
            {
                ReleaseWheelBrakes();
                if (wKeyDown)
                {
                    RestoreLayoutActionForKey("w");
                }
            }

            if (pitchState != Stick.IDLE && !UsesSteppedPitchStick())
            {
                switch (pitchState)
                {
                    case Stick.POSITIVE_ENDED:
                    case Stick.NEGATIVE_ENDED:
                        pitchState = Stick.IDLE;
                        SetPitchDeflection(0);
                        break;
                    case Stick.NEGATIVE:
                        SetPitchDeflection(-1);
                        break;
                    case Stick.POSITIVE:
                        SetPitchDeflection(1);
                        break;
                }
            }
            else if (UsesSteppedPitchStick())
            {
                if (pitchState == Stick.POSITIVE || pitchState == Stick.NEGATIVE)
                {
                    pitchHoldSeconds += delta;
                    int direction = pitchState == Stick.POSITIVE ? 1 : -1;
                    double rate = Math.Min(
                        PitchStickMaxUnitRate,
                        PitchStickBaseUnitRate + PitchStickUnitAccel * pitchHoldSeconds);
                    pitchUnitAccum += rate * delta * direction;
                    double steps = Math.Truncate(pitchUnitAccum);
                    if (steps != 0)
                    {
                        StepPitchStickUnits(steps);
                        pitchUnitAccum -= steps;
                    }
                }
                else if (pitchState == Stick.POSITIVE_ENDED || pitchState == Stick.NEGATIVE_ENDED)
                {
                    pitchState = Stick.IDLE;
                    pitchHoldSeconds = 0;
                    pitchUnitAccum = 0;
                }
            }

            if (rollState != Stick.IDLE)
            {
                switch (rollState)
                {
                    case Stick.POSITIVE_ENDED:
                    case Stick.NEGATIVE_ENDED:
                        rollState = Stick.IDLE;
                        roll = 0;
                        break;
                    case Stick.NEGATIVE:
                        roll = -1;
                        break;
                    case Stick.POSITIVE:
                        roll = 1;
                        break;
                }
            }

            if (yawState != Stick.IDLE)
            {
                switch (yawState)
                {
                    case Stick.POSITIVE_ENDED:
                    case Stick.NEGATIVE_ENDED:
                        yawState = Stick.IDLE;
                        yaw = 0;
                        break;
                    case Stick.NEGATIVE:
                        yaw = -1;
                        break;
                    case Stick.POSITIVE:
                        yaw = 1;
                        break;
                }
            }

            if (throttleState != Stick.IDLE)
            {
                bool isPositive = throttleState == Stick.POSITIVE || throttleState == Stick.POSITIVE_ENDED;
                double step = delta * 0.01 * (isPositive ? ThrottleRate : -ThrottleRate);
                bool skipContinuousInAbBand = sink.GetAfterburner()
                    && F16Engine.IsAbDetentBand(throttle) && isPositive;
                if (throttleState == Stick.POSITIVE_ENDED || throttleState == Stick.NEGATIVE_ENDED)
                {
                    throttleState = Stick.IDLE;
                }
                if (!skipContinuousInAbBand)
                {
                    AdjustThrottle(step, sink);
                }
            }
        }

        private void HandleLayoutKeyDown(string key, ISimPlayerInputSink sink)
        {
            // A JS switch: the first case whose key matches wins.
            if (key == layout[KeyboardControlAction.PITCH_POS])
            {
                LatchPitch(Stick.POSITIVE);
            }
            else if (key == layout[KeyboardControlAction.PITCH_NEG])
            {
                LatchPitch(Stick.NEGATIVE);
            }
            else if (key == layout[KeyboardControlAction.ROLL_POS])
            {
                rollState = Stick.POSITIVE;
            }
            else if (key == layout[KeyboardControlAction.ROLL_NEG])
            {
                rollState = Stick.NEGATIVE;
            }
            else if (key == layout[KeyboardControlAction.YAW_POS])
            {
                yawState = Stick.POSITIVE;
            }
            else if (key == layout[KeyboardControlAction.YAW_NEG])
            {
                yawState = Stick.NEGATIVE;
            }
            else if (key == layout[KeyboardControlAction.THROTTLE_POS])
            {
                if (sink.GetAfterburner() && F16Engine.IsAbDetentBand(throttle))
                {
                    StepThrottle(1, sink);
                }
                else
                {
                    throttleState = Stick.POSITIVE;
                }
            }
            else if (key == layout[KeyboardControlAction.THROTTLE_NEG])
            {
                if (sink.GetAfterburner() && throttle >= 0.99)
                {
                    StepThrottle(-1, sink);
                }
                else
                {
                    throttleState = Stick.NEGATIVE;
                }
            }
        }

        private void HandleLayoutKeyUp(string key)
        {
            if (key == layout[KeyboardControlAction.PITCH_POS])
            {
                if (IsActionKeyHeld(KeyboardControlAction.PITCH_NEG))
                {
                    LatchPitch(Stick.NEGATIVE);
                }
                else if (pitchState == Stick.POSITIVE)
                {
                    pitchState = Stick.POSITIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.PITCH_NEG])
            {
                if (IsActionKeyHeld(KeyboardControlAction.PITCH_POS))
                {
                    LatchPitch(Stick.POSITIVE);
                }
                else if (pitchState == Stick.NEGATIVE)
                {
                    pitchState = Stick.NEGATIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.ROLL_POS])
            {
                if (IsActionKeyHeld(KeyboardControlAction.ROLL_NEG))
                {
                    rollState = Stick.NEGATIVE;
                }
                else if (rollState == Stick.POSITIVE)
                {
                    rollState = Stick.POSITIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.ROLL_NEG])
            {
                if (IsActionKeyHeld(KeyboardControlAction.ROLL_POS))
                {
                    rollState = Stick.POSITIVE;
                }
                else if (rollState == Stick.NEGATIVE)
                {
                    rollState = Stick.NEGATIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.YAW_POS])
            {
                if (IsActionKeyHeld(KeyboardControlAction.YAW_NEG))
                {
                    yawState = Stick.NEGATIVE;
                }
                else if (yawState == Stick.POSITIVE)
                {
                    yawState = Stick.POSITIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.YAW_NEG])
            {
                if (IsActionKeyHeld(KeyboardControlAction.YAW_POS))
                {
                    yawState = Stick.POSITIVE;
                }
                else if (yawState == Stick.NEGATIVE)
                {
                    yawState = Stick.NEGATIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.THROTTLE_POS])
            {
                if (IsActionKeyHeld(KeyboardControlAction.THROTTLE_NEG))
                {
                    throttleState = Stick.NEGATIVE;
                }
                else if (throttleState == Stick.POSITIVE)
                {
                    throttleState = Stick.POSITIVE_ENDED;
                }
            }
            else if (key == layout[KeyboardControlAction.THROTTLE_NEG])
            {
                if (IsActionKeyHeld(KeyboardControlAction.THROTTLE_POS))
                {
                    throttleState = Stick.POSITIVE;
                }
                else if (throttleState == Stick.NEGATIVE)
                {
                    throttleState = Stick.NEGATIVE_ENDED;
                }
            }
        }

        private void HandleActionKeyDown(string key, ISimPlayerInputSink sink)
        {
            switch (key)
            {
                case "f":
                    sink.ToggleFlaps();
                    break;
                case "g":
                    sink.ToggleGear();
                    break;
                case "b":
                    sink.ToggleAirbrakes();
                    break;
                case "h":
                    sink.ToggleHook();
                    break;
                case "l":
                    ToggleLimiters();
                    break;
                case "a":
                    sink.ToggleAutopilot();
                    break;
                case "1":
                    pitchLimiterMode = FcsPitchLimiter.Soft;
                    sink.SetPitchLimiterMode(FcsPitchLimiter.Soft);
                    break;
                case "2":
                    pitchLimiterMode = FcsPitchLimiter.Predictive;
                    sink.SetPitchLimiterMode(FcsPitchLimiter.Predictive);
                    break;
                case "3":
                    pitchLimiterMode = FcsPitchLimiter.Smooth;
                    sink.SetPitchLimiterMode(FcsPitchLimiter.Smooth);
                    break;
            }
        }

        private void ToggleLimiters()
        {
            limitersEnabled = !limitersEnabled;
        }

        private void LatchPitch(Stick direction)
        {
            pitchState = direction;
            if (UsesSteppedPitchStick())
            {
                pitchHoldSeconds = 0;
                pitchUnitAccum = 0;
                StepPitchStickUnits(direction == Stick.POSITIVE ? 1 : -1);
            }
        }

        private void SetPitchDeflection(double value)
        {
            pitch = value;
            pitchStickUnits = value >= 0
                ? value * PitchStickAftUnits
                : value * PitchStickFwdUnits;
        }

        private void StepPitchStickUnits(double delta)
        {
            pitchStickUnits = JsMath.Clamp(
                pitchStickUnits + delta,
                -PitchStickFwdUnits,
                PitchStickAftUnits);
            pitch = pitchStickUnits >= 0
                ? pitchStickUnits / PitchStickAftUnits
                : pitchStickUnits / PitchStickFwdUnits;
        }

        private void AdjustThrottle(double step, ISimPlayerInputSink sink)
        {
            if (sink.GetAfterburner())
            {
                throttle = F16Engine.AdjustInput(throttle, step);
            }
            else
            {
                throttle = JsMath.Clamp(throttle + step, 0, 1);
            }
        }

        private void StepThrottle(int direction, ISimPlayerInputSink sink)
        {
            if (sink.GetAfterburner())
            {
                throttle = F16Engine.StepDetent(throttle, direction);
            }
            else
            {
                throttle = JsMath.Clamp(throttle + direction * 0.1, 0, 1);
            }
        }

        private bool UsesSteppedPitchStick()
        {
            return layoutId == KeyboardControlLayoutId.ARROWS
                && pitchStickMode != KeyboardPitchStickMode.HOLD;
        }

        private bool IsActionKeyHeld(KeyboardControlAction action)
        {
            return keysDown.Contains(layout[action]);
        }

        private static bool CanApplyWheelBrakes(ISimPlayerInputSink sink)
        {
            return sink.IsLanded() || sink.IsOnGround();
        }

        private bool HandleWheelBrakeKeyDown(string key, ISimPlayerInputSink sink)
        {
            if (key != "w" || !CanApplyWheelBrakes(sink))
            {
                return false;
            }
            wKeyDown = true;
            EngageWheelBrakes();
            return true;
        }

        private bool HandleWheelBrakeKeyUp(string key)
        {
            if (key != "w")
            {
                return false;
            }
            wKeyDown = false;
            if (wheelBrakeHeld)
            {
                ReleaseWheelBrakes();
                return true;
            }
            return false;
        }

        private void EngageWheelBrakes()
        {
            wheelBrakeHeld = true;
            wheelBrakes = true;
            if (pitchState == Stick.NEGATIVE)
            {
                pitchState = Stick.IDLE;
                pitch = 0;
            }
            if (throttleState == Stick.POSITIVE)
            {
                throttleState = Stick.IDLE;
            }
        }

        private void ReleaseWheelBrakes()
        {
            wheelBrakeHeld = false;
            wheelBrakes = false;
        }

        private void RestoreLayoutActionForKey(string key)
        {
            if (key == layout[KeyboardControlAction.PITCH_NEG])
            {
                pitchState = Stick.NEGATIVE;
            }
            else if (key == layout[KeyboardControlAction.THROTTLE_POS])
            {
                throttleState = Stick.POSITIVE;
            }
        }

        private bool IsLayoutKey(string key)
        {
            foreach (string k in layout.Values)
            {
                if (k == key) return true;
            }
            return false;
        }

        private void ClearSticks()
        {
            pitchState = Stick.IDLE;
            pitchHoldSeconds = 0;
            pitchUnitAccum = 0;
            rollState = Stick.IDLE;
            yawState = Stick.IDLE;
            throttleState = Stick.IDLE;
            wKeyDown = false;
            firing = false;
            ReleaseWheelBrakes();
        }

        private SimControlInputs NeutralInputs(bool firingNow, ISimPlayerInputSink sink)
        {
            return new SimControlInputs
            {
                Pitch = 0,
                Roll = 0,
                Yaw = 0,
                Throttle = 0,
                LandingGearDeployed = true,
                FlapsExtended = true,
                AirbrakesExtended = false,
                // Keep the hook where the pilot left it: dropping it here would
                // shed a latched wire whenever input is disabled mid-trap.
                HookDeployed = sink.IsHookDeployed(),
                WheelBrakesApplied = false,
                PitchLimiterMode = pitchLimiterMode,
                LimitersEnabled = limitersEnabled,
                WantForceVectors = forceVectorsRequested,
                Firing = firingNow,
            };
        }

        /// <summary>Whether an FM2 config uses afterburner throttle detents.</summary>
        public static bool Fm2UsesAfterburner(Fm2AircraftConfig config)
        {
            return config?.Engine?.Afterburner ?? false;
        }
    }
}
