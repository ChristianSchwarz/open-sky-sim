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
/// Replays the scripted FM2/FM3 traces from tests/golden/flight_models.json
/// (tools/golden/suites/flightModels.ts) and compares every 20 Hz sample.
/// </summary>
public class FlightModelTests
{
    private static readonly JsonElement Fx = Load("flight_models.json");
    private static readonly JsonElement Configs = Load("flight_configs.json").GetProperty("configs");

    public static IEnumerable<object[]> Traces(string model) =>
        Fx.GetProperty("traces").EnumerateArray()
            .Where(t => t.GetProperty("model").GetString() == model)
            .Select(t => new object[] { t.GetProperty("name").GetString()! });

    public static IEnumerable<object[]> Fm2Traces() => Traces("FM2");
    public static IEnumerable<object[]> Fm3Traces() => Traces("FM3");

    private static JsonElement Trace(string name) =>
        Fx.GetProperty("traces").EnumerateArray().First(t => t.GetProperty("name").GetString() == name);

    [Fact]
    public void DefaultFm2ConfigMatchesTheOracle()
    {
        var m = new Mismatches();
        Structural.Compare("defaultFm2Config", Configs.GetProperty("defaultFm2Config"), Fm2Defaults.Default(), m);
        m.Close("groundRestHeight", Num(Configs, "fm2GroundRestHeight"),
            Fm2AircraftConfig.GroundRestHeight(Fm2Defaults.Default()), 0);
        m.AssertNone();
    }

    [Theory]
    [MemberData(nameof(Fm2Traces))]
    public void Fm2Trace(string name) => Replay(Trace(name), () => new Fm2FlightModel(), "fm2");

    [Theory]
    [MemberData(nameof(Fm3Traces))]
    public void Fm3Trace(string name) => Replay(Trace(name), () => new Fm3FlightModel(), "fm3");

    private static void Apply(FlightModel m, JsonElement set)
    {
        foreach (JsonProperty p in set.EnumerateObject())
        {
            switch (p.Name)
            {
                case "pitch": m.SetPitch(p.Value.GetDouble()); break;
                case "roll": m.SetRoll(p.Value.GetDouble()); break;
                case "yaw": m.SetYaw(p.Value.GetDouble()); break;
                case "throttle": m.SetThrottle(p.Value.GetDouble()); break;
                case "gear": m.SetLandingGearDeployed(p.Value.GetBoolean()); break;
                case "flaps": m.SetFlapsExtended(p.Value.GetBoolean()); break;
                case "airbrakes": m.SetAirbrakesExtended(p.Value.GetBoolean()); break;
                case "wheelBrakes": m.SetWheelBrakes(p.Value.GetBoolean()); break;
                case "limiters": m.SetLimitersEnabled(p.Value.GetBoolean()); break;
                case "pitchLimiter": m.SetPitchLimiterMode((FcsPitchLimiter)p.Value.GetInt32()); break;
                default: throw new InvalidOperationException($"unknown control {p.Name}");
            }
        }
    }

    private static bool Bool(JsonElement e, string prop) => e.TryGetProperty(prop, out JsonElement v) && v.GetBoolean();

    /// <summary>Mirrors initialise() in flightModels.ts.</summary>
    private static void Initialise(FlightModel m, JsonElement init)
    {
        double rest = Fm2AircraftConfig.GroundRestHeight(Fm2Defaults.Default());
        m.Reset();
        double y = Bool(init, "onGround") ? rest
            : init.TryGetProperty("aboveRest", out JsonElement ar) ? rest + ar.GetDouble()
            : init.GetProperty("altitude").GetDouble();
        m.Position = new Vec3d(0, y, 0);
        m.Quaternion = Quatd.Identity;
        double pitch = (init.TryGetProperty("pitchDeg", out JsonElement pd) ? pd.GetDouble() : 0) * Math.PI / 180;
        if (pitch != 0) m.Quaternion = Quatd.FromAxisAngle(new Vec3d(1, 0, 0), -pitch);
        double gamma = (init.TryGetProperty("gammaDeg", out JsonElement gd) ? gd.GetDouble() : 0) * Math.PI / 180;
        double speed = init.GetProperty("speed").GetDouble();
        double sink = init.TryGetProperty("sink", out JsonElement sk) ? sk.GetDouble() : 0;
        m.Velocity = new Vec3d(0, speed * Math.Sin(gamma) - sink, speed * Math.Cos(gamma));
        m.SetLanded(Bool(init, "onGround"));
        m.SetLandingGearDeployed(init.GetProperty("gear").GetBoolean());
        m.SetFlapsExtended(Bool(init, "flaps"));
        m.SetThrottle(init.GetProperty("throttle").GetDouble());
        if (init.TryGetProperty("limiters", out JsonElement lim)) m.SetLimitersEnabled(lim.GetBoolean());
        m.SyncEffectiveThrottle();
        m.SnapPhysicsState();
    }

    private static void Replay(JsonElement trace, Func<FlightModel> create, string prefix)
    {
        JsonElement tol = Fx.GetProperty("tolerances");
        double posTol = Num(tol, prefix + "Position"), velTol = Num(tol, prefix + "Velocity"), qTol = Num(tol, prefix + "Quaternion");
        double dt = Num(trace, "dt");
        int steps = trace.GetProperty("steps").GetInt32();
        var script = trace.GetProperty("script").EnumerateArray().OrderBy(s => Num(s, "t")).ToArray();
        var samples = trace.GetProperty("samples").EnumerateArray().ToDictionary(s => s.GetProperty("step").GetInt32());

        FlightModel m = create();
        Initialise(m, trace.GetProperty("initial"));
        var mm = new Mismatches();
        int next = 0;
        double maxHard = 0;
        int firstBadStep = -1;

        void Check(int step)
        {
            if (!samples.TryGetValue(step, out JsonElement s)) return;
            int before = mm.Checked;
            var local = new Mismatches();
            local.Close($"step {step} position", V3(s.GetProperty("position")), m.Position, posTol);
            local.CloseRotation($"step {step} quaternion", Q(s.GetProperty("quaternion")), m.Quaternion, qTol);
            local.Close($"step {step} velocity", V3(s.GetProperty("velocity")), m.Velocity, velTol);
            local.Close($"step {step} aoa", Num(s, "aoa"), m.AngleOfAttack, qTol * 1000);
            local.Equal($"step {step} landed", s.GetProperty("landed").GetBoolean(), m.IsLanded);
            local.Equal($"step {step} crashed", s.GetProperty("crashed").GetBoolean(), m.IsCrashed);
            try
            {
                local.AssertNone();
            }
            catch (Exception ex)
            {
                if (firstBadStep < 0)
                {
                    firstBadStep = step;
                    mm.Fail($"first divergence at step {step} (t = {step * dt:F3} s):\n{ex.Message}");
                }
            }
            mm.Equal($"step {step}", true, true);
        }

        Check(0);
        for (int step = 1; step <= steps && firstBadStep < 0; step++)
        {
            double t = (step - 1) * dt;
            while (next < script.Length && Num(script[next], "t") <= t + 1e-9)
            {
                Apply(m, script[next].GetProperty("set"));
                next++;
            }
            m.Update(dt);
            maxHard = Math.Max(maxHard, m.ConsumeHardLanding());
            Check(step);
        }
        if (firstBadStep < 0)
        {
            JsonElement sum = trace.GetProperty("summary");
            mm.Close("summary maxHardLandingFraction", Num(sum, "maxHardLandingFraction"), maxHard, 1e-6);
        }
        mm.AssertNone();
    }
}
