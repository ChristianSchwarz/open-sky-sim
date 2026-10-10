using System;
using Retro.Core;

namespace Retro.Game
{
    // Port of src/script/state/flightRecorder.ts.

    /// <summary>Device animation state worth showing in a replay; all in 0..1 except throttle.</summary>
    public sealed class ReplayDevices
    {
        public double Throttle;
        public bool Gear;
        public bool Flaps;
        public bool Airbrakes;
        public bool Hook;
    }

    public sealed class ReplayPose
    {
        public Vec3d Position;
        public Quatd Quaternion = Quatd.Identity;
        public Vec3d Velocity;
        public ReplayDevices Devices = new ReplayDevices();

        /// <summary>newReplayPose: origin, identity, at rest, everything stowed.</summary>
        public static ReplayPose New() => new ReplayPose();
    }

    /// <summary>
    /// Flat, ring-buffered record of the player aircraft's pose over time.
    /// Sim time only advances while Record is called, so pauses leave no gap.
    /// Positions are kept in the live scene frame: a floating-origin re-base
    /// must be passed on through Rebase.
    /// </summary>
    public sealed class FlightRecorder
    {
        /// <summary>Samples per second of flight time. Poses are interpolated between them.</summary>
        public const double RecordRateHz = 30;
        /// <summary>How much flight the recorder keeps; older samples are dropped.</summary>
        public const double RecordMaxSeconds = 600;

        private const int Stride = 14; // px py pz  qx qy qz qw  vx vy vz  throttle flags  t
        private readonly double _rateHz;
        private readonly int _capacity;
        private readonly double[] _data;
        private int _head; // next write slot
        private int _count;
        private double _clock;
        private double _lastSampleAt = double.NegativeInfinity;

        public FlightRecorder(double rateHz = RecordRateHz, double maxSeconds = RecordMaxSeconds)
        {
            _rateHz = rateHz;
            _capacity = (int)Math.Max(2, Math.Ceiling(rateHz * maxSeconds));
            _data = new double[_capacity * Stride];
        }

        public int Length => _count;

        /// <summary>Time of the oldest sample, in recorder seconds.</summary>
        public double StartTime => _count == 0 ? 0 : Time(0);

        /// <summary>Time of the newest sample, in recorder seconds.</summary>
        public double EndTime => _count == 0 ? 0 : Time(_count - 1);

        public double Duration => EndTime - StartTime;

        public void Clear()
        {
            _head = 0;
            _count = 0;
            _clock = 0;
            _lastSampleAt = double.NegativeInfinity;
        }

        /// <summary>Advance by `delta` seconds of flight and keep a sample when one is due.</summary>
        public void Record(double delta, ReplayPose pose)
        {
            _clock += delta;
            if (_clock - _lastSampleAt < 1 / _rateHz - 1e-6)
            {
                return;
            }
            _lastSampleAt = _clock;
            int o = _head * Stride;
            double[] d = _data;
            d[o] = pose.Position.X; d[o + 1] = pose.Position.Y; d[o + 2] = pose.Position.Z;
            d[o + 3] = pose.Quaternion.X; d[o + 4] = pose.Quaternion.Y;
            d[o + 5] = pose.Quaternion.Z; d[o + 6] = pose.Quaternion.W;
            d[o + 7] = pose.Velocity.X; d[o + 8] = pose.Velocity.Y; d[o + 9] = pose.Velocity.Z;
            d[o + 10] = pose.Devices.Throttle;
            d[o + 11] = (pose.Devices.Gear ? 1 : 0) | (pose.Devices.Flaps ? 2 : 0)
                | (pose.Devices.Airbrakes ? 4 : 0) | (pose.Devices.Hook ? 8 : 0);
            d[o + 12] = _clock;
            _head = (_head + 1) % _capacity;
            _count = Math.Min(_count + 1, _capacity);
        }

        /// <summary>Carry every stored pose across a floating-origin re-base.</summary>
        public void Rebase(FrameShift shift)
        {
            double[] d = _data;
            for (int i = 0; i < _count; i++)
            {
                int o = Slot(i) * Stride;
                Vec3d p = shift.Point(new Vec3d(d[o], d[o + 1], d[o + 2]));
                d[o] = p.X; d[o + 1] = p.Y; d[o + 2] = p.Z;
                Quatd q = shift.Orientation(new Quatd(d[o + 3], d[o + 4], d[o + 5], d[o + 6]));
                d[o + 3] = q.X; d[o + 4] = q.Y; d[o + 5] = q.Z; d[o + 6] = q.W;
                Vec3d v = shift.Vector(new Vec3d(d[o + 7], d[o + 8], d[o + 9]));
                d[o + 7] = v.X; d[o + 8] = v.Y; d[o + 9] = v.Z;
            }
        }

        /// <summary>
        /// Pose at `t` (recorder seconds, clamped to the recorded span), blended
        /// between the two samples around it. False when nothing is recorded.
        /// </summary>
        public bool Sample(double t, ReplayPose into)
        {
            if (_count == 0)
            {
                return false;
            }
            t = Math.Min(Math.Max(t, StartTime), EndTime);
            // Binary search for the last sample at or before t.
            int lo = 0;
            int hi = _count - 1;
            while (lo < hi)
            {
                int mid = (lo + hi + 1) >> 1;
                if (Time(mid) <= t) lo = mid; else hi = mid - 1;
            }
            int next = Math.Min(lo + 1, _count - 1);
            double t0 = Time(lo);
            double t1 = Time(next);
            double k = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
            int a = Slot(lo) * Stride;
            int b = Slot(next) * Stride;
            double[] d = _data;
            into.Position = new Vec3d(
                d[a] + (d[b] - d[a]) * k,
                d[a + 1] + (d[b + 1] - d[a + 1]) * k,
                d[a + 2] + (d[b + 2] - d[a + 2]) * k);
            into.Velocity = new Vec3d(
                d[a + 7] + (d[b + 7] - d[a + 7]) * k,
                d[a + 8] + (d[b + 8] - d[a + 8]) * k,
                d[a + 9] + (d[b + 9] - d[a + 9]) * k);
            var qa = new Quatd(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
            var qb = new Quatd(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
            // three.js Quaternion.slerp, which Quatd.Slerp reproduces.
            into.Quaternion = Quatd.Slerp(qa, qb, k);
            into.Devices.Throttle = d[a + 10] + (d[b + 10] - d[a + 10]) * k;
            int flags = (int)d[a + 11];
            into.Devices.Gear = (flags & 1) != 0;
            into.Devices.Flaps = (flags & 2) != 0;
            into.Devices.Airbrakes = (flags & 4) != 0;
            into.Devices.Hook = (flags & 8) != 0;
            return true;
        }

        /// <summary>Slot in the ring of the i-th oldest sample.</summary>
        private int Slot(int i) => (_head - _count + i + _capacity * 2) % _capacity;

        private double Time(int i) => _data[Slot(i) * Stride + 12];
    }

    /// <summary>Playback cursor over a recorder: time, speed, pause, seek.</summary>
    public sealed class ReplayPlayer
    {
        public static readonly double[] ReplaySpeeds = { 0.25, 0.5, 1, 2, 4 };

        public double Time;
        public bool Paused;
        private int _speedIndex = 2;
        private readonly FlightRecorder _rec;

        public ReplayPlayer(FlightRecorder rec)
        {
            _rec = rec;
        }

        public double Speed => ReplaySpeeds[_speedIndex];

        /// <summary>Begin at the start of the last `seconds` of the recording.</summary>
        public void Start(double seconds = double.PositiveInfinity)
        {
            Time = Math.Max(_rec.StartTime, _rec.EndTime - seconds);
            Paused = false;
            _speedIndex = 2;
        }

        /// <summary>Advance by real `delta`; loops back to the start at the end.</summary>
        public void Advance(double delta)
        {
            if (Paused)
            {
                return;
            }
            Time += delta * Speed;
            if (Time >= _rec.EndTime)
            {
                Time = _rec.StartTime;
            }
        }

        /// <summary>Next speed, wrapping from the fastest back to the slowest.</summary>
        public void CycleSpeed()
        {
            _speedIndex = (_speedIndex + 1) % ReplaySpeeds.Length;
        }

        public void Seek(double deltaSeconds)
        {
            Time = Math.Min(Math.Max(Time + deltaSeconds, _rec.StartTime), _rec.EndTime);
        }

        /// <summary>direction is +1 or -1.</summary>
        public void ChangeSpeed(int direction)
        {
            _speedIndex = Math.Min(Math.Max(_speedIndex + direction, 0), ReplaySpeeds.Length - 1);
        }

        public double Fraction
        {
            get
            {
                double d = _rec.Duration;
                return d > 0 ? (Time - _rec.StartTime) / d : 0;
            }
        }
    }
}
