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
/// Replays the combat-sim scenario traces from tests/golden/combat_sim.json
/// (tools/golden/suites/combatSim.ts): a CombatSim stepped at 1/60 s with the
/// fixture's world, aircraft, scripted events and external combatants. Every
/// sample (every 6th step and the last) is compared, and the first divergent
/// sample is reported; the per-step hit list is compared in full.
/// </summary>
public class CombatSimTests
{
    private static readonly JsonElement Fx = Load("combat_sim.json");

    public static IEnumerable<object[]> TraceNames() =>
        Fx.GetProperty("traces").EnumerateArray().Select(t => new object[] { t.GetProperty("name").GetString()! });

    private static JsonElement Trace(string name) =>
        Fx.GetProperty("traces").EnumerateArray().First(t => t.GetProperty("name").GetString() == name);

    [Fact]
    public void FixtureHasEveryTrace() => Assert.Equal(12, TraceNames().Count());

    [Theory]
    [MemberData(nameof(TraceNames))]
    public void CombatSimTrace(string name) => Replay(Trace(name));

    // --- Fixture JSON -> runtime types -------------------------------------------

    private static bool Has(JsonElement e, string prop, out JsonElement v) =>
        e.TryGetProperty(prop, out v) && v.ValueKind != JsonValueKind.Null && v.ValueKind != JsonValueKind.Undefined;

    private static double[] Arr(JsonElement e, string prop) => Nums(e.GetProperty(prop));

    private static ColliderAabb Aabb(JsonElement e) => new(Arr(e, "min"), Arr(e, "max"));

    private static SerializedCarrierMesh CarrierMesh(JsonElement c) => new()
    {
        OriginX = Num(c, "originX"),
        OriginY = Num(c, "originY"),
        OriginZ = Num(c, "originZ"),
        Triangles = Arr(c, "triangles"),
        Aabb = Aabb(c.GetProperty("aabb")),
    };

    private static SurfacePadCollider Pad(JsonElement p) => new()
    {
        CenterX = Num(p, "centerX"),
        CenterZ = Num(p, "centerZ"),
        Heading = Num(p, "heading"),
        HalfLength = Num(p, "halfLength"),
        HalfWidth = Num(p, "halfWidth"),
        SurfaceY = Num(p, "surfaceY"),
        BaseY = Num(p, "baseY"),
        Feather = Num(p, "feather"),
        Slope = Has(p, "slope", out JsonElement s) ? Num(s) : null,
    };

    private static SerializedObstacle Obstacle(JsonElement o) => new()
    {
        Position = Arr(o, "position"),
        Radius = Num(o, "radius"),
        Height = Num(o, "height"),
    };

    private static List<T> List<T>(JsonElement e, string prop, Func<JsonElement, T> map) =>
        Has(e, prop, out JsonElement a) ? a.EnumerateArray().Select(map).ToList() : null;

    internal static SerializedWorld World(JsonElement w) => new()
    {
        Hills = List(w, "hills", h => new SerializedHill
        {
            WorldToLocal = Arr(h, "worldToLocal"),
            LocalToWorld = Arr(h, "localToWorld"),
            BaseRadius = Num(h, "baseRadius"),
            Height = Num(h, "height"),
            WorldX = Num(h, "worldX"),
            WorldZ = Num(h, "worldZ"),
            WorldReach = Num(h, "worldReach"),
        }) ?? new(),
        Obstacles = List(w, "obstacles", Obstacle) ?? new(),
        Runways = List(w, "runways", r => new SerializedRunway
        {
            Center = Arr(r, "center"),
            Heading = Num(r, "heading"),
            HalfLength = Num(r, "halfLength"),
            HalfWidth = Num(r, "halfWidth"),
        }),
        SkiJumps = List(w, "skiJumps", r => new SerializedSkiJump
        {
            OriginX = Num(r, "originX"),
            OriginY = Has(r, "originY", out JsonElement oy) ? Num(oy) : null,
            OriginZ = Num(r, "originZ"),
            Heading = Num(r, "heading"),
            Length = Num(r, "length"),
            Height = Num(r, "height"),
            HalfWidth = Num(r, "halfWidth"),
        }),
        CarrierMeshes = List(w, "carrierMeshes", CarrierMesh),
        ArrestorCables = List(w, "arrestorCables", s => new SerializedArrestorCables
        {
            OriginX = Num(s, "originX"),
            OriginY = Num(s, "originY"),
            OriginZ = Num(s, "originZ"),
            DeckAxis = Arr(s, "deckAxis"),
            SegmentsLocal = s.GetProperty("segmentsLocal").EnumerateArray().Select(Nums).ToList(),
        }),
        SurfacePads = List(w, "surfacePads", Pad),
        SceneryMeshes = List(w, "sceneryMeshes", CarrierMesh),
    };

    private static SimFlightModelKind ModelKind(string s) => s switch
    {
        "fm2" => SimFlightModelKind.Fm2,
        "fm3" => SimFlightModelKind.Fm3,
        "debug" => SimFlightModelKind.Debug,
        _ => throw new FormatException(s),
    };

    private static SimAircraftDesc Desc(JsonElement d, Fm2AircraftConfig config)
    {
        // The fixture serialises aircraftConfig, but the notes pin it to defaultFm2Config.
        Assert.True(Has(d, "aircraftConfig", out _));
        var desc = new SimAircraftDesc
        {
            Id = d.GetProperty("id").GetString(),
            Faction = (Faction)d.GetProperty("faction").GetInt32(),
            Control = d.GetProperty("control").GetString() switch
            {
                "ai" => SimControlMode.Ai,
                "external" => SimControlMode.External,
                var s => throw new FormatException(s),
            },
            Model = Has(d, "model", out JsonElement m) ? ModelKind(m.GetString()) : null,
            Kinematic = Has(d, "kinematic", out JsonElement k) ? k.GetBoolean() : null,
            AircraftConfig = config,
            HitRadius = Num(d, "hitRadius"),
            MaxHealth = Num(d, "maxHealth"),
            Enabled = d.GetProperty("enabled").GetBoolean(),
        };
        if (Has(d, "pilotOptions", out JsonElement po))
        {
            var opts = new AiPilotOptions();
            foreach (JsonProperty p in po.EnumerateObject())
            {
                switch (p.Name)
                {
                    case "cruiseAltitude": opts.CruiseAltitude = Num(p.Value); break;
                    case "cruiseSpeed": opts.CruiseSpeed = Num(p.Value); break;
                    case "hardDeck": opts.HardDeck = Num(p.Value); break;
                    case "model": opts.Model = Enum.Parse<AiPilotModels>(p.Value.GetString()!); break;
                    default: throw new FormatException($"pilotOptions.{p.Name} not handled");
                }
            }
            desc.PilotOptions = opts;
        }
        if (Has(d, "gun", out JsonElement g))
        {
            desc.Gun = new SimGunConfig
            {
                MuzzleVelocity = Num(g, "muzzleVelocity"),
                RoundsPerSecond = Num(g, "roundsPerSecond"),
                Damage = Num(g, "damage"),
                Ammo = Num(g, "ammo"),
                MuzzleOffset = Arr(g, "muzzleOffset"),
                Spread = Has(g, "spread", out JsonElement sp) ? Num(sp) : null,
            };
        }
        if (Has(d, "collision", out JsonElement c))
        {
            desc.Collision = new AircraftCollisionMesh { Triangles = Arr(c, "triangles"), Aabb = Aabb(c.GetProperty("aabb")) };
        }
        JsonElement s0 = d.GetProperty("spawn");
        desc.Spawn = new SimAircraftSpawn
        {
            Position = Arr(s0, "position"),
            Quaternion = Arr(s0, "quaternion"),
            Velocity = Has(s0, "velocity", out JsonElement v) ? Nums(v) : null,
            Landed = s0.GetProperty("landed").GetBoolean(),
            Throttle = Num(s0, "throttle"),
            Airborne = s0.GetProperty("airborne").GetBoolean(),
        };
        return desc;
    }

    private static void ApplyEvent(CombatSim sim, JsonElement ev)
    {
        string id = ev.TryGetProperty("id", out JsonElement idEl) ? idEl.GetString() : null;
        switch (ev.GetProperty("kind").GetString())
        {
            case "keyDown": sim.KeyDown(id, ev.GetProperty("key").GetString(), false); break;
            case "keyUp": sim.KeyUp(id, ev.GetProperty("key").GetString()); break;
            case "setPhase": sim.SetPhase(id, Enum.Parse<AiFlightPhase>(ev.GetProperty("phase").GetString()!)); break;
            case "setTargetFaction":
                sim.SetTargetFaction(id, Has(ev, "faction", out JsonElement f) ? (Faction)f.GetInt32() : null);
                break;
            case "setFormationLead":
                sim.SetFormationLead(id, Has(ev, "leadId", out JsonElement l) ? l.GetString() : null);
                break;
            case "setKeyboardLayout":
                sim.SetKeyboardLayout(Enum.Parse<KeyboardControlLayoutId>(ev.GetProperty("layout").GetString()!));
                break;
            case "addStaticColliders":
            {
                JsonElement c = ev.GetProperty("colliders");
                sim.AddStaticColliders(new SerializedStaticColliders
                {
                    SurfacePads = c.GetProperty("surfacePads").EnumerateArray().Select(Pad).ToList(),
                    Obstacles = c.GetProperty("obstacles").EnumerateArray().Select(Obstacle).ToList(),
                });
                break;
            }
            case "gamepad":
                sim.GamepadAxes(id, Num(ev, "pitch"), Num(ev, "roll"), Num(ev, "yaw"), Num(ev, "throttle"), true);
                break;
            case var k:
                throw new FormatException($"event kind {k} not handled");
        }
    }

    private sealed class ExternalScript
    {
        public string Id;
        public Faction Faction;
        public Vec3d Position;
        public Vec3d Velocity;
    }

    // --- Replay ----------------------------------------------------------------------

    private static void Replay(JsonElement trace)
    {
        JsonElement tol = Fx.GetProperty("tolerances");
        double posTol = Num(tol, "position"), velTol = Num(tol, "velocity");
        double quatTol = Num(tol, "quaternion"), healthTol = Num(tol, "health");
        double dt = Num(trace, "dt");
        Assert.Equal(1.0 / 60, dt);

        var sim = new CombatSim();
        sim.SetWorld(World(trace.GetProperty("world")));
        Fm2AircraftConfig config = Fm2Defaults.Default();
        foreach (JsonElement d in trace.GetProperty("aircraft").EnumerateArray())
        {
            sim.AddAircraft(Desc(d, config));
        }
        var externals = trace.GetProperty("externals").EnumerateArray().Select(e => new ExternalScript
        {
            Id = e.GetProperty("id").GetString(),
            Faction = (Faction)e.GetProperty("faction").GetInt32(),
            Position = V3(e.GetProperty("position")),
            Velocity = V3(e.GetProperty("velocity")),
        }).ToList();
        var events = trace.GetProperty("events").EnumerateArray().ToList();
        var samples = trace.GetProperty("samples").EnumerateArray().ToDictionary(s => s.GetProperty("step").GetInt32());
        int steps = trace.GetProperty("steps").GetInt32();

        var mm = new Mismatches();
        var hits = new List<(int Step, SimHitEvent Hit)>();
        int firstBadStep = -1;
        for (int step = 1; step <= steps && firstBadStep < 0; step++)
        {
            foreach (ExternalScript e in externals)
            {
                sim.SetExternalState(e.Id, true, e.Faction, e.Position, e.Velocity, true);
            }
            foreach (JsonElement ev in events)
            {
                if (ev.GetProperty("step").GetInt32() == step) ApplyEvent(sim, ev);
            }
            sim.Step(dt, new Dictionary<string, SimControlInputs>());
            foreach (ExternalScript e in externals)
            {
                e.Position = e.Position.AddScaled(e.Velocity, dt);
            }
            foreach (SimHitEvent h in sim.Hits) hits.Add((step, h));

            if (!samples.TryGetValue(step, out JsonElement s)) continue;
            var local = new Mismatches();
            string at = $"step {step}";
            local.Equal($"{at} projectiles", s.GetProperty("projectiles").GetInt32(), sim.ActiveProjectileCount);
            List<JsonElement> expected = s.GetProperty("aircraft").EnumerateArray().ToList();
            IReadOnlyList<SimAircraft> actual = sim.Aircraft;
            local.Equal($"{at} aircraft count", expected.Count, actual.Count);
            for (int i = 0; i < Math.Min(expected.Count, actual.Count); i++)
            {
                JsonElement x = expected[i];
                SimAircraft a = actual[i];
                string w = $"{at} {a.Id}";
                local.Equal($"{w} id", x.GetProperty("id").GetString(), a.Id);
                local.Close($"{w} position", V3(x.GetProperty("position")), a.Model.Position, posTol);
                local.CloseRotation($"{w} quaternion", Q(x.GetProperty("quaternion")), a.Model.Quaternion, quatTol);
                local.Close($"{w} velocity", V3(x.GetProperty("velocity")), a.Model.Velocity, velTol);
                local.Close($"{w} aoa", Num(x, "aoa"), a.Model.AngleOfAttack, quatTol);
                local.Close($"{w} throttle", Num(x, "throttle"), a.Model.EffectiveThrottle, healthTol);
                local.Equal($"{w} landed", x.GetProperty("landed").GetBoolean(), a.Model.IsLanded);
                local.Equal($"{w} crashed", x.GetProperty("crashed").GetBoolean(), a.Model.IsCrashed);
                local.Equal($"{w} gear", x.GetProperty("gear").GetBoolean(), a.IsGearDeployed());
                local.Equal($"{w} flaps", x.GetProperty("flaps").GetBoolean(), a.IsFlapsExtended());
                local.Close($"{w} health", Num(x, "health"), a.Health, healthTol);
                if (Has(x, "ammo", out JsonElement ammo))
                {
                    local.Equal($"{w} has gun", true, a.Gun != null);
                    if (a.Gun != null) local.Close($"{w} ammo", Num(ammo), a.Gun.AmmoRemaining, 0);
                }
                else
                {
                    local.Equal($"{w} has gun", false, a.Gun != null);
                }
                local.Equal($"{w} firing", x.GetProperty("firing").GetBoolean(), a.Firing);
                local.Equal($"{w} arrestorLatch", x.GetProperty("arrestorLatch").GetInt32(), a.ArrestorLatch);
                local.Equal($"{w} arrestorHeld", x.GetProperty("arrestorHeld").GetBoolean(), a.ArrestorHeld);
                local.Equal($"{w} target", Has(x, "target", out JsonElement t) ? t.GetString() : null, a.AutoTargetId);
                local.Equal($"{w} phase", Has(x, "phase", out JsonElement ph) ? ph.GetString() : null, a.Pilot?.GetPhase().ToString());
                local.Equal($"{w} label", Has(x, "label", out JsonElement lb) ? lb.GetString() : null, a.Pilot?.GetManeuverLabel());
            }
            try
            {
                local.AssertNone();
            }
            catch (Exception ex)
            {
                firstBadStep = step;
                mm.Fail($"first divergent sample at step {step} (t = {step * dt:F3} s):\n{ex.Message}");
            }
            mm.Equal(at, true, true);
        }

        // The hit list, up to the first divergent sample when there is one.
        List<JsonElement> expectedHits = trace.GetProperty("hits").EnumerateArray()
            .Where(h => firstBadStep < 0 || h.GetProperty("step").GetInt32() <= firstBadStep).ToList();
        mm.Equal("hit count", expectedHits.Count, hits.Count);
        for (int i = 0; i < Math.Min(expectedHits.Count, hits.Count); i++)
        {
            JsonElement x = expectedHits[i];
            (int step, SimHitEvent h) = hits[i];
            string w = $"hit {i}";
            mm.Equal($"{w} step", x.GetProperty("step").GetInt32(), step);
            mm.Equal($"{w} targetId", x.GetProperty("targetId").GetString(), h.TargetId);
            mm.Close($"{w} damage", Num(x, "damage"), h.Damage, healthTol);
            mm.Close($"{w} position", V3(x.GetProperty("position")), new Vec3d(h.Position[0], h.Position[1], h.Position[2]), posTol);
            mm.Close($"{w} velocity", V3(x.GetProperty("velocity")), new Vec3d(h.Velocity[0], h.Velocity[1], h.Velocity[2]), velTol);
            CloseOptional(mm, $"{w} impactSpeed", x, "impactSpeed", h.ImpactSpeed, velTol);
            CloseOptional(mm, $"{w} severity", x, "severity", h.Severity, healthTol);
            mm.Equal($"{w} source", Has(x, "source", out JsonElement src) ? src.GetString() : null, h.Source);
            mm.Equal($"{w} slide", Has(x, "slide", out JsonElement sl) ? sl.GetBoolean() : (bool?)null, h.Slide);
        }
        mm.AssertNone();
    }

    private static void CloseOptional(Mismatches mm, string what, JsonElement x, string prop, double? actual, double tol)
    {
        if (Has(x, prop, out JsonElement e))
        {
            mm.Equal($"{what} present", true, actual.HasValue);
            if (actual.HasValue) mm.Close(what, Num(e), actual.Value, tol);
        }
        else
        {
            mm.Equal($"{what} present", false, actual.HasValue);
        }
    }
}
