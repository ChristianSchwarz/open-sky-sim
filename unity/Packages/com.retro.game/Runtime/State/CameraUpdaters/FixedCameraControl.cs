using System;
using System.Collections.Generic;

namespace Retro.Game
{
    // Port of src/script/state/cameraUpdaters/fixedCameraControl.ts.

    /// <summary>Rates the fixed camera is moving at: metres per second and degrees per second.</summary>
    public sealed class FixedCameraRates
    {
        public double Forward;
        public double Right;
        public double Up;
        public double Yaw;
        public double Pitch;

        public double this[string key]
        {
            get
            {
                switch (key)
                {
                    case "forward": return Forward;
                    case "right": return Right;
                    case "up": return Up;
                    case "yaw": return Yaw;
                    case "pitch": return Pitch;
                    default: throw new ArgumentOutOfRangeException(nameof(key), key, null);
                }
            }
            set
            {
                switch (key)
                {
                    case "forward": Forward = value; break;
                    case "right": Right = value; break;
                    case "up": Up = value; break;
                    case "yaw": Yaw = value; break;
                    case "pitch": Pitch = value; break;
                    default: throw new ArgumentOutOfRangeException(nameof(key), key, null);
                }
            }
        }
    }

    /// <summary>Direction each key pair asks for: +1, -1 or 0.</summary>
    public sealed class FixedCameraInput
    {
        public double Forward;
        public double Right;
        public double Up;
        public double Yaw;
        public double Pitch;

        public double this[string key]
        {
            get
            {
                switch (key)
                {
                    case "forward": return Forward;
                    case "right": return Right;
                    case "up": return Up;
                    case "yaw": return Yaw;
                    case "pitch": return Pitch;
                    default: throw new ArgumentOutOfRangeException(nameof(key), key, null);
                }
            }
        }
    }

    public sealed class FixedCameraTuning
    {
        /// <summary>Speed a move starts at, m/s.</summary>
        public double StartMps;
        /// <summary>Speed a held move never exceeds, m/s.</summary>
        public double MaxMps;
        /// <summary>Factor the speed grows by per second held.</summary>
        public double GrowthPerS;
        /// <summary>Turn rate on the numpad, deg/s.</summary>
        public double TurnDegPerS;
        /// <summary>Time constant for easing turns in and every axis out, seconds.</summary>
        public double EaseS;
    }

    public static class FixedCameraControl
    {
        private static readonly string[] MoveAxes = { "forward", "right", "up" };
        private static readonly string[] TurnAxes = { "yaw", "pitch" };

        public static FixedCameraRates ZeroFixedCameraRates() => new FixedCameraRates();

        /// <summary>
        /// Held key codes (DOM KeyboardEvent.code names: ArrowUp, PageDown,
        /// Numpad6, ...) to the direction on each axis. The Unity input layer
        /// maps its keys to these names.
        /// </summary>
        public static FixedCameraInput FixedCameraInputOf(ICollection<string> held)
        {
            double Axis(string plus, string minus) => (held.Contains(plus) ? 1 : 0) - (held.Contains(minus) ? 1 : 0);
            return new FixedCameraInput
            {
                Forward = Axis("ArrowUp", "ArrowDown"),
                Right = Axis("ArrowRight", "ArrowLeft"),
                Up = Axis("PageUp", "PageDown"),
                Yaw = Axis("Numpad6", "Numpad4"),
                Pitch = Axis("Numpad8", "Numpad2"),
            };
        }

        /// <summary>
        /// Advance `rates` by `delta` seconds. A held move key accelerates: the
        /// speed starts at StartMps and multiplies by GrowthPerS every second
        /// until MaxMps. Turns ease to a fixed rate. Anything released coasts to
        /// a stop. Returns whether something is still moving.
        /// </summary>
        public static bool StepFixedCameraRates(
            FixedCameraRates rates, FixedCameraInput input, double delta, FixedCameraTuning t)
        {
            double k = 1 - Math.Exp(-delta / t.EaseS);
            void Settle(string key)
            {
                rates[key] -= rates[key] * k;
                if (Math.Abs(rates[key]) < 1e-3)
                {
                    rates[key] = 0;
                }
            }
            foreach (string key in MoveAxes)
            {
                double dir = input[key];
                if (dir == 0)
                {
                    Settle(key);
                    continue;
                }
                double along = rates[key] * dir;
                double speed = along < t.StartMps
                    ? t.StartMps
                    : Math.Min(t.MaxMps, along * Math.Pow(t.GrowthPerS, delta));
                rates[key] = dir * speed;
            }
            foreach (string key in TurnAxes)
            {
                double want = input[key] * t.TurnDegPerS;
                rates[key] += (want - rates[key]) * k;
                if (want == 0 && Math.Abs(rates[key]) < 1e-3)
                {
                    rates[key] = 0;
                }
            }
            foreach (string key in MoveAxes)
            {
                if (rates[key] != 0) return true;
            }
            foreach (string key in TurnAxes)
            {
                if (rates[key] != 0) return true;
            }
            return false;
        }
    }
}
