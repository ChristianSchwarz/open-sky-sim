using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Sim;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays the closed-loop AI pilot traces from tests/golden/ai_pilots.json
/// (tools/golden/suites/ai.ts): every pilot model flies a scripted scenario
/// against the kinematic FakeAircraft, and every 3rd frame (20 Hz) is compared.
/// FakeAircraft, ScriptedTarget and TestWorld are reimplemented exactly as the
/// generator defines them, so any difference is the pilot's.
/// </summary>
public class AiPilotTests
{
    private const double DT = 1.0 / 60;
    private static readonly Vec3d FORWARD = new(0, 0, 1);

    private static readonly JsonElement Fx = Load("ai_pilots.json");

    public static IEnumerable<object[]> TraceNames() =>
        Fx.GetProperty("traces").EnumerateArray().Select(t => new object[] { t.GetProperty("name").GetString()! });

    private static JsonElement Trace(string name) =>
        Fx.GetProperty("traces").EnumerateArray().First(t => t.GetProperty("name").GetString() == name);

    [Fact]
    public void FixtureHasEveryTrace() => Assert.Equal(34, TraceNames().Count());

    [Theory]
    [MemberData(nameof(TraceNames))]
    public void AiPilotTrace(string name) => Replay(Trace(name));

    /// <summary>three.js Quaternion.setFromUnitVectors(vFrom, vTo), then normalize().</summary>
    internal static Quatd SetFromUnitVectors(Vec3d vFrom, Vec3d vTo)
    {
        double r = Vec3d.Dot(vFrom, vTo) + 1;
        double x, y, z, w;
        if (r < 1e-8)
        {
            // vFrom and vTo point in opposite directions
            r = 0;
            if (Math.Abs(vFrom.X) > Math.Abs(vFrom.Z))
            {
                x = -vFrom.Y; y = vFrom.X; z = 0; w = r;
            }
            else
            {
                x = 0; y = -vFrom.Z; z = vFrom.Y; w = r;
            }
        }
        else
        {
            x = vFrom.Y * vTo.Z - vFrom.Z * vTo.Y;
            y = vFrom.Z * vTo.X - vFrom.X * vTo.Z;
            z = vFrom.X * vTo.Y - vFrom.Y * vTo.X;
            w = r;
        }
        double l = Math.Sqrt(x * x + y * y + z * z + w * w);
        if (l == 0) return new Quatd(0, 0, 0, 1);
        l = 1 / l;
        return new Quatd(x * l, y * l, z * l, w * l);
    }

    /// <summary>Kinematic stand-in from aiPilot.dogfight.test.ts, plus recorded discrete commands.</summary>
    private sealed class FakeAircraft : IPilotableAircraft
    {
        public Vec3d Position;
        public Vec3d Velocity;
        public Quatd Quaternion = Quatd.Identity;
        public double Heading;
        public double PitchAngle;
        public double Airspeed = 200;
        public bool Crashed { get; set; }
        public double PitchCmd, RollCmd, YawCmd, ThrottleCmd;
        public bool Brakes, Gear, Flaps, Airbrakes;

        public void SetPitch(double pitch) => PitchCmd = pitch;
        public void SetRoll(double roll) => RollCmd = roll;
        public void SetYaw(double yaw) => YawCmd = yaw;
        public void SetThrottle(double throttle) => ThrottleCmd = throttle;
        public void SetWheelBrakes(bool applied) => Brakes = applied;
        public void SetLandingGearDeployed(bool deployed) => Gear = deployed;
        public void SetFlapsExtended(bool extended) => Flaps = extended;
        public void SetAirbrakesExtended(bool extended) => Airbrakes = extended;

        public Vec3d GetPosition() => Position;
        public Vec3d GetVelocity() => Velocity;
        public Quatd GetQuaternion() => Quaternion;
        public double GetAirspeed() => Airspeed;
        public double GetAltitude() => Position.Y;
        public double GetAngleOfAttack() => 0;
        public double GetLoadFactorG() => 1;
        public double GetStallStatus() => -1;
        public bool IsLanded() => false;
        public bool IsCrashed() => Crashed;
        public bool IsGearDeployed() => Gear;
        public bool IsFlapsExtended() => Flaps;
        public bool IsAirbrakesExtended() => Airbrakes;

        // JsTrig, not Math: the generator ran on V8's fdlibm, and the trace
        // passes through a near-antipodal setFromUnitVectors that amplifies ulps.
        private Vec3d Fwd() => new(
            JsTrig.Sin(Heading) * JsTrig.Cos(PitchAngle),
            JsTrig.Sin(PitchAngle),
            JsTrig.Cos(Heading) * JsTrig.Cos(PitchAngle));

        /// <summary>Sync velocity/quaternion to heading/pitch without moving (initial state).</summary>
        public void Orient()
        {
            Vec3d fwd = Fwd();
            Velocity = fwd * Airspeed;
            Quaternion = SetFromUnitVectors(FORWARD, fwd);
        }

        public void Step(double delta)
        {
            const double TURN_RATE_MAX = 1.0;
            const double PITCH_RATE_MAX = 0.8;
            Heading += RollCmd * TURN_RATE_MAX * delta;
            PitchAngle = JsMath.Clamp(PitchAngle + PitchCmd * PITCH_RATE_MAX * delta, -1.3, 1.3);
            double equilibriumSpeed = 50 + ThrottleCmd * 300;
            Airspeed = Math.Max(30, Airspeed + (equilibriumSpeed - Airspeed) * 0.5 * delta);
            Vec3d fwd = Fwd();
            Velocity = fwd * Airspeed;
            Position = Position.AddScaled(Velocity, delta);
            Quaternion = SetFromUnitVectors(FORWARD, fwd);
        }
    }

    /// <summary>
    /// A scripted target: straight line at constant velocity, or a level circle
    /// at turnRate rad/s (positive = turning toward +x from +z).
    /// </summary>
    private sealed class ScriptedTarget : ICombatant
    {
        private Vec3d _position;
        private Vec3d _velocity;
        private readonly double _turnRate;

        public ScriptedTarget(JsonElement s)
        {
            _position = V3(s.GetProperty("position"));
            _velocity = V3(s.GetProperty("velocity"));
            _turnRate = s.TryGetProperty("turnRate", out JsonElement tr) ? Num(tr) : 0;
        }

        public Faction Faction => Faction.PLAYER;
        public Vec3d ReadPosition() => _position;
        public Vec3d ReadVelocity() => _velocity;
        public double GetHitRadius() => 10;
        public bool IsAlive() => true;
        public void ApplyDamage(double amount) { /* scripted targets ignore damage */ }

        /// <summary>Rotate velocity about +Y by turnRate*dt (exact rotation), then move.</summary>
        public void Step(double dt)
        {
            if (_turnRate != 0)
            {
                double a = _turnRate * dt;
                double c = JsTrig.Cos(a), s = JsTrig.Sin(a);
                double vx = _velocity.X, vz = _velocity.Z;
                _velocity.X = vx * c + vz * s;
                _velocity.Z = -vx * s + vz * c;
            }
            _position = _position.AddScaled(_velocity, dt);
        }
    }

    /// <summary>Flat ground, or a ridge of `height` for z in [z0, z1]; two runways; no obstacles.</summary>
    private sealed class TestWorld : IWorldQuery
    {
        private readonly Runway[] _runwayList =
        {
            new Runway { Center = new Vec3d(0, 0, 0), Heading = 0, HalfLength = 1500, HalfWidth = 30 },
            new Runway { Center = new Vec3d(12000, 0, 8000), Heading = Math.PI / 2, HalfLength = 1000, HalfWidth = 25 },
        };

        private readonly bool _ridge;
        private readonly double _z0, _z1, _height;

        public TestWorld(JsonElement ground)
        {
            string kind = ground.GetProperty("kind").GetString()!;
            _ridge = kind == "ridge";
            if (_ridge)
            {
                _z0 = Num(ground, "z0");
                _z1 = Num(ground, "z1");
                _height = Num(ground, "height");
            }
            else
            {
                Assert.Equal("flat", kind);
            }
        }

        public double GroundHeightAt(double x, double z)
        {
            if (_ridge && z >= _z0 && z <= _z1)
            {
                return _height;
            }
            return 0;
        }

        public bool IsLand(double x, double z) => true;
        public IReadOnlyList<Obstacle> Obstacles() => Array.Empty<Obstacle>();
        public IReadOnlyList<Runway> Runways() => _runwayList;
        public Runway Runway() => _runwayList[0];

        public Runway NearestRunway(double x, double z)
        {
            Runway best = _runwayList[0];
            double bestD = double.PositiveInfinity;
            foreach (Runway r in _runwayList)
            {
                double d = JsMath.Hypot(r.Center.X - x, r.Center.Z - z);
                if (d < bestD) { bestD = d; best = r; }
            }
            return best;
        }
    }

    private static T ParseEnum<T>(string s) where T : struct, Enum => Enum.Parse<T>(s);

    private static void Replay(JsonElement trace)
    {
        JsonElement tol = Fx.GetProperty("tolerances");
        double cmdTol = Num(tol, "command"), posTol = Num(tol, "position"), angTol = Num(tol, "angle");

        JsonElement own = trace.GetProperty("own");
        var ac = new FakeAircraft
        {
            Position = V3(own.GetProperty("position")),
            Heading = Num(own, "heading"),
            PitchAngle = Num(own, "pitch"),
            Airspeed = Num(own, "airspeed"),
            ThrottleCmd = Num(own, "throttle"),
        };
        ac.Orient();
        var world = new TestWorld(trace.GetProperty("ground"));
        JsonElement skillEl = trace.GetProperty("skill");
        var options = new AiPilotOptions
        {
            Model = ParseEnum<AiPilotModels>(trace.GetProperty("model").GetString()!),
            Skill = skillEl.ValueKind == JsonValueKind.Null ? null : ParseEnum<AiSkillLevel>(skillEl.GetString()!),
        };
        IAiPilotController pilot = AiPilotFactory.CreateAiPilot(ac, world, options);
        JsonElement tEl = trace.GetProperty("target"), lEl = trace.GetProperty("lead");
        ScriptedTarget target = tEl.ValueKind == JsonValueKind.Null ? null : new ScriptedTarget(tEl);
        ScriptedTarget lead = lEl.ValueKind == JsonValueKind.Null ? null : new ScriptedTarget(lEl);
        pilot.SetTarget(target);
        pilot.SetFormationLead(lead);
        pilot.SetPhase(ParseEnum<AiFlightPhase>(trace.GetProperty("phase").GetString()!));

        int steps = (int)JsMath.Round(Num(trace, "duration") / DT);
        Assert.Equal(trace.GetProperty("steps").GetInt32(), steps);
        var samples = trace.GetProperty("samples").EnumerateArray().ToDictionary(s => s.GetProperty("step").GetInt32());

        var mm = new Mismatches();
        int firstBadStep = -1;
        int firedFrames = 0;
        for (int step = 1; step <= steps && firstBadStep < 0; step++)
        {
            pilot.Update(DT);
            if (pilot.IsFiring) firedFrames++;
            if (samples.TryGetValue(step, out JsonElement s))
            {
                var local = new Mismatches();
                string at = $"step {step}";
                local.Close($"{at} pitch", Num(s, "pitch"), ac.PitchCmd, cmdTol);
                local.Close($"{at} roll", Num(s, "roll"), ac.RollCmd, cmdTol);
                local.Close($"{at} yaw", Num(s, "yaw"), ac.YawCmd, cmdTol);
                local.Close($"{at} throttle", Num(s, "throttle"), ac.ThrottleCmd, cmdTol);
                local.Equal($"{at} gear", s.GetProperty("gear").GetBoolean(), ac.Gear);
                local.Equal($"{at} flaps", s.GetProperty("flaps").GetBoolean(), ac.Flaps);
                local.Equal($"{at} airbrakes", s.GetProperty("airbrakes").GetBoolean(), ac.Airbrakes);
                local.Equal($"{at} brakes", s.GetProperty("brakes").GetBoolean(), ac.Brakes);
                local.Equal($"{at} firing", s.GetProperty("firing").GetBoolean(), pilot.IsFiring);
                local.Equal($"{at} phase", s.GetProperty("phase").GetString(), pilot.GetPhase().ToString());
                local.Equal($"{at} label", s.GetProperty("label").GetString(), pilot.GetManeuverLabel());
                local.Close($"{at} position", V3(s.GetProperty("position")), ac.Position, posTol);
                local.Close($"{at} heading", Num(s, "heading"), ac.Heading, angTol);
                local.Close($"{at} pitchAngle", Num(s, "pitchAngle"), ac.PitchAngle, angTol);
                local.Close($"{at} airspeed", Num(s, "airspeed"), ac.Airspeed, posTol);
                try
                {
                    local.AssertNone();
                }
                catch (Exception ex)
                {
                    firstBadStep = step;
                    mm.Fail($"first divergence at step {step} (t = {step * DT:F3} s):\n{ex.Message}");
                }
                mm.Equal(at, true, true);
            }
            ac.Step(DT);
            target?.Step(DT);
            lead?.Step(DT);
        }
        if (firstBadStep < 0)
        {
            mm.Equal("firedFrames", trace.GetProperty("firedFrames").GetInt32(), firedFrames);
        }
        mm.AssertNone();
    }
}
