using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Xunit;
using static Retro.Golden.Tests.Golden;
using static Retro.Golden.Tests.WreckTestKit;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/wreck.json: scripted crashes through the WreckField port
/// (F-22 glb parts on a slope, a steep dive, a ditching, a moving carrier deck,
/// survivable damage then the final break-up, a mid-air break-up, a procedural
/// jet with a three-leg gear at scale 1.25 on a coast, a dense airframe shedding
/// shards) with the oracle's seeded random stream. Every random draw, every
/// piece's pose and motion (hashed per frame, float64 bytes), every piece's
/// float32 geometry and every callback must match.
/// </summary>
public class WreckTests
{
    private static readonly JsonElement Fx = Load("wreck.json");
    private const double Dt = 1.0 / 60;
    private const double DeckVz = -12;

    [Fact]
    public void ExpMatchesV8()
    {
        var m = new Mismatches();
        foreach (JsonElement s in Fx.GetProperty("exp").EnumerateArray())
        {
            double x = Num(s[0]);
            m.Equal($"exp({x:R})", BitConverter.DoubleToInt64Bits(Num(s[1])), BitConverter.DoubleToInt64Bits(WreckMath.Exp(x)));
        }
        m.AssertNone();
    }

    [Fact]
    public void SortMatchesV8OnTheFuzzyGearComparator()
    {
        var m = new Mismatches();
        int k = 0;
        foreach (JsonElement s in Fx.GetProperty("sort").EnumerateArray())
        {
            double[] input = Nums(s[0]);
            double[] want = Nums(s[1]);
            var pts = new List<(double X, double Z)>();
            for (int i = 0; i < input.Length; i += 2) pts.Add((input[i], input[i + 1]));
            WreckMath.JsSort(pts, (a, b) => Math.Abs(a.X - b.X) > 0.05 ? a.X - b.X : a.Z - b.Z);
            m.Equal($"sort {k}", string.Join(",", want), string.Join(",", pts.SelectMany(p => new[] { p.X, p.Z })));
            k++;
        }
        m.AssertNone();
    }

    private static Dictionary<string, WreckModel> Models(Mismatches m)
    {
        var models = new Dictionary<string, WreckModel>();
        foreach (JsonProperty p in Fx.GetProperty("models").EnumerateObject())
        {
            models[p.Name] = ModelFromSpec(p.Value, m, p.Name);
        }
        return models;
    }

    [Fact]
    public void BoxGeometryReplicaMatchesThree()
    {
        var m = new Mismatches();
        Models(m);
        m.AssertNone();
    }

    private static WreckSource Source(JsonElement s, Dictionary<string, WreckModel> models)
    {
        var src = new WreckSource
        {
            Id = "p",
            Body = models[s.GetProperty("body").GetString()!],
            Position = V3(s.GetProperty("position")),
            Quaternion = Q(s.GetProperty("quaternion")),
            Scale = V3(s.GetProperty("scale")),
            Velocity = V3(s.GetProperty("velocity")),
            Cockpit = s.GetProperty("cockpit").ValueKind == JsonValueKind.Null ? null : V3(s.GetProperty("cockpit")),
        };
        foreach (JsonElement p in s.GetProperty("parts").EnumerateArray())
        {
            src.Parts.Add(new WreckPart
            {
                Model = models[p.GetProperty("model").GetString()!],
                Kind = p.GetProperty("kind").GetString() == "gear" ? WreckPartKind.Gear : WreckPartKind.Surface,
                Id = p.GetProperty("id").GetInt32(),
                Position = V3(p.GetProperty("position")),
                Quaternion = Q(p.GetProperty("quaternion")),
            });
        }
        return src;
    }

    private static string KindName(WreckFireKind k) => k switch
    {
        WreckFireKind.Fuselage => "fuselage",
        WreckFireKind.WingRoot => "wingRoot",
        _ => "brand",
    };

    private static double[] V(Vec3d v) => new[] { v.X, v.Y, v.Z };

    private static double[] Qa(Quatd q) => new[] { q.X, q.Y, q.Z, q.W };

    private static void Close(Mismatches m, string what, double[] expected, double[] actual, double tol = 1e-9)
    {
        m.Equal(what + " length", expected.Length, actual.Length);
        for (int i = 0; i < Math.Min(expected.Length, actual.Length); i++)
        {
            m.Close($"{what}[{i}]", expected[i], actual[i], tol);
        }
    }

    public static IEnumerable<object[]> ScenarioNames() =>
        Load("wreck.json").GetProperty("scenarios").EnumerateArray().Select(s => new object[] { s.GetProperty("name").GetString()! });

    [Theory]
    [MemberData(nameof(ScenarioNames))]
    public void ScenarioMatchesTheOracle(string name)
    {
        JsonElement sc = Fx.GetProperty("scenarios").EnumerateArray().First(s => s.GetProperty("name").GetString() == name);
        var m = new Mismatches();
        Dictionary<string, WreckModel> models = Models(m);
        Func<double> rng0 = Gun.Mulberry32((uint)sc.GetProperty("seed").GetInt32());
        int draws = 0;
        double Random()
        {
            draws++;
            return rng0();
        }
        string world = sc.GetProperty("world").GetString()!;
        double deckZ = 0;
        var field = new WreckField(Random);
        Func<double, double, double> ground = Ground(world, () => deckZ);
        field.SetGroundHeightAt(ground);
        bool OnDeck(double x, double z) => Math.Abs(x) < 15 && Math.Abs(z - deckZ) < 140;
        if (world == "seabed")
        {
            field.SetWaterTest((x, z) => true, (x, z) => 0);
        }
        else if (world == "coast")
        {
            field.SetWaterTest((x, z) => x > 60, (x, z) => 0);
        }
        else if (world == "deck")
        {
            field.SetWaterTest((x, z) => !OnDeck(x, z), (x, z) => 0);
            field.SetMovingSurface(new Surface { Velocity = new Vec3d(0, 0, DeckVz), Test = (x, y, z) => OnDeck(x, z) && y < 24 && y > 15 });
        }

        var ids = new Dictionary<WreckFragment, int>();
        var pieces = new List<WreckFragment>();
        void Scan()
        {
            foreach (WreckFragment f in field.Fragments)
            {
                if (ids.ContainsKey(f)) continue;
                ids[f] = ids.Count;
                pieces.Add(f);
            }
        }
        // Piece records are checked when the piece first appears (its state then).
        var expectedPieces = sc.GetProperty("pieces").EnumerateArray().ToList();
        int checkedPieces = 0;
        void CheckNewPieces()
        {
            for (; checkedPieces < pieces.Count; checkedPieces++)
            {
                WreckFragment f = pieces[checkedPieces];
                string at = $"{name} piece {checkedPieces}";
                if (checkedPieces >= expectedPieces.Count)
                {
                    m.Fail($"{at}: not in the oracle");
                    continue;
                }
                JsonElement e = expectedPieces[checkedPieces];
                Close(m, at + " centre", Nums(e, "centre"), V(f.Centre));
                Close(m, at + " half", Nums(e, "half"), V(f.Half));
                Close(m, at + " originLocal", Nums(e, "originLocal"), V(f.OriginLocal));
                m.Equal(at + " tough", e.GetProperty("tough").GetBoolean(), f.Tough);
                m.Equal(at + " depth", e.GetProperty("depth").GetInt32(), f.Depth);
                m.Equal(at + " serial", e.GetProperty("serial").GetInt32(), f.Serial);
                m.Close(at + " gyration2", Num(e, "gyration2"), f.Gyration2, 1e-9);
                m.Close(at + " trailWidth", Num(e, "trailWidth"), f.TrailWidth, 1e-9);
                m.Close(at + " bobPhase", Num(e, "bobPhase"), f.BobPhase, 1e-9);
                Close(m, at + " velocity", Nums(e, "velocity"), V(f.Velocity));
                Close(m, at + " spin", Nums(e, "spin"), V(f.Spin));
                var meshes = e.GetProperty("meshes").EnumerateArray().ToList();
                m.Equal(at + " meshes", meshes.Count, f.Meshes.Count);
                for (int k = 0; k < Math.Min(meshes.Count, f.Meshes.Count); k++)
                {
                    JsonElement x = meshes[k];
                    WreckMeshData mesh = f.Meshes[k];
                    m.Equal($"{at} mesh {k} material", x[0].GetString(), (string)mesh.Material);
                    m.Equal($"{at} mesh {k} vertices", x[1].GetInt32(), mesh.VertexCount);
                    m.Equal($"{at} mesh {k} position", x[2].ValueKind == JsonValueKind.Null ? null : x[2].GetString(), HashF32(mesh.Position));
                    m.Equal($"{at} mesh {k} normal", x[3].ValueKind == JsonValueKind.Null ? null : x[3].GetString(), mesh.Normal == null ? null : HashF32(mesh.Normal));
                    m.Equal($"{at} mesh {k} uv", x[4].ValueKind == JsonValueKind.Null ? null : x[4].GetString(), mesh.Uv == null ? null : HashF32(mesh.Uv));
                }
                if (e.TryGetProperty("dump", out JsonElement dump) && meshes.Count > 0 && f.Meshes.Count > 0)
                {
                    double[] want = Nums(dump[0]);
                    double[] got = f.Meshes[0].Position.Take(want.Length).Select(v => (double)v).ToArray();
                    Close(m, at + " dump", want, got, 0);
                }
            }
        }
        int frame = 0;
        var events = new List<(int Frame, string Type, double[] V, object Extra)>();
        field.OnBreakup = e =>
        {
            Scan();
            events.Add((frame, "breakup", V(e.Position).Concat(V(e.Velocity)).Concat(V(e.Normal)).Append(e.Severity).ToArray(), e));
        };
        field.OnMark = (p, n, dx, dz, length, width, strength) => events.Add((frame, "mark", V(p).Concat(V(n)).Concat(new[] { dx, dz, length, width, strength }).ToArray(), null));
        field.OnBurn = (p, life, intensity) => events.Add((frame, "burn", V(p).Concat(new[] { life, intensity }).ToArray(), null));
        field.OnSplit = (p, v, strength) => events.Add((frame, "split", V(p).Concat(V(v)).Append(strength).ToArray(), null));
        field.OnDust = (p, v, count, strength) => events.Add((frame, "dust", V(p).Concat(V(v)).Concat(new[] { (double)count, strength }).ToArray(), null));
        field.OnSplash = (p, v, strength) => events.Add((frame, "splash", V(p).Concat(V(v)).Append(strength).ToArray(), null));
        field.OnFoam = (p, radius, count) => events.Add((frame, "foam", V(p).Concat(new[] { radius, (double)count }).ToArray(), null));
        field.OnDamage = e => events.Add((frame, "damage", new[] { e.Severity }, e));
        // Fire records of a breakup are taken at the event (fragment ids as then).
        var breakupFires = new Dictionary<WreckEvent, List<object[]>>();
        field.OnBreakup += e => breakupFires[e] = e.Fires.Select(f => new object[] { KindName(f.Kind), ids.TryGetValue(f.Fragment, out int id) ? id : -1, f.Local }).ToList();

        var damage = new AirframeDamage();
        var actions = sc.GetProperty("actions").EnumerateArray().ToList();
        var perFrame = sc.GetProperty("perFrame").EnumerateArray().ToList();
        var samples = sc.GetProperty("samples").EnumerateArray().ToDictionary(s => s.GetProperty("frame").GetInt32());
        int frames = sc.GetProperty("frames").GetInt32();
        int firstDrift = -1;
        for (frame = 0; frame < frames; frame++)
        {
            foreach (JsonElement action in actions.Where(a => a.GetProperty("frame").GetInt32() == frame))
            {
                string at = $"{name} frame {frame} {action.GetProperty("op").GetString()}";
                switch (action.GetProperty("op").GetString())
                {
                    case "rebase":
                        field.Rebase(new FrameShift(Q(action.GetProperty("rotation")), V3(action.GetProperty("offset"))));
                        break;
                    case "damage":
                    {
                        WreckSource src = Source(action.GetProperty("source"), models);
                        bool changed = field.ApplyDamage(src, damage, Num(action, "severity"), V3(action.GetProperty("hit")));
                        Scan();
                        m.Equal(at + " changed", action.GetProperty("changed").GetBoolean(), changed);
                        m.Equal(at + " draws", action.GetProperty("draws").GetInt32(), draws);
                        CheckHooks(m, at, action.GetProperty("hooks"), field);
                        CheckDamage(m, at, action.GetProperty("state"), damage);
                        foreach (JsonElement c in action.GetProperty("carried").EnumerateArray())
                        {
                            int id = c.GetProperty("id").GetInt32();
                            WreckPart part = src.Parts.First(p => p.Id == id);
                            Vec3d pos = part.Position;
                            Quatd q = part.Quaternion;
                            damage.TransformPart(id, ref pos, ref q, src.Position, src.Quaternion, src.Scale);
                            Close(m, $"{at} carried {id} position", Nums(c, "position"), V(pos));
                            Close(m, $"{at} carried {id} quaternion", Nums(c, "quaternion"), Qa(q));
                        }
                        break;
                    }
                    default:
                    {
                        WreckSource src = Source(action.GetProperty("source"), models);
                        if (action.GetProperty("withDamage").GetBoolean())
                        {
                            src.Damage = damage;
                        }
                        bool ok = field.Spawn(src);
                        Scan();
                        m.Equal(at + " ok", action.GetProperty("ok").GetBoolean(), ok);
                        m.Equal(at + " draws", action.GetProperty("draws").GetInt32(), draws);
                        CheckHooks(m, at, action.GetProperty("hooks"), field);
                        break;
                    }
                }
                CheckNewPieces();
            }
            if (world == "deck")
            {
                deckZ += DeckVz * Dt;
            }
            field.Update(Dt);
            Scan();
            CheckNewPieces();
            JsonElement pf = perFrame[frame];
            IReadOnlyList<WreckFragment> list = field.Fragments;
            string hash = HashF64(list.SelectMany(x => V(x.Position).Concat(Qa(x.Quaternion)).Concat(V(x.Velocity)).Concat(V(x.Spin))).ToArray());
            bool same = pf[0].GetInt32() == list.Count && pf[1].GetInt32() == list.Count(x => x.Asleep)
                && pf[2].GetInt32() == list.Count(x => x.Wet) && pf[3].GetInt32() == draws && pf[4].GetString() == hash;
            m.Equal($"{name} frame {frame} [count, asleep, wet, draws, hash]",
                $"{pf[0]},{pf[1]},{pf[2]},{pf[3]},{pf[4].GetString()}",
                $"{list.Count},{list.Count(x => x.Asleep)},{list.Count(x => x.Wet)},{draws},{hash}");
            if (!same && firstDrift < 0)
            {
                firstDrift = frame;
            }
            if (samples.TryGetValue(frame, out JsonElement sample))
            {
                CheckSample(m, $"{name} frame {frame}", sample, field, ids);
            }
            if (firstDrift >= 0 && frame > firstDrift + 3)
            {
                break; // the rest only repeats the first drift
            }
        }

        // Events.
        var expectedEvents = sc.GetProperty("events").EnumerateArray().ToList();
        if (firstDrift < 0)
        {
            m.Equal($"{name} events", expectedEvents.Count, events.Count);
        }
        for (int i = 0; i < Math.Min(expectedEvents.Count, events.Count); i++)
        {
            JsonElement e = expectedEvents[i];
            (int f, string type, double[] v, object extra) = events[i];
            string at = $"{name} event {i}";
            if (firstDrift >= 0 && f > firstDrift) break;
            if (e.ValueKind == JsonValueKind.Array)
            {
                m.Equal(at + " frame", e[0].GetInt32(), f);
                m.Equal(at + " type", e[1].GetString(), type);
                if (e.GetArrayLength() == 3 && e[2].ValueKind == JsonValueKind.String)
                {
                    m.Equal(at + " hash", e[2].GetString(), HashF64(v));
                }
                else
                {
                    Close(m, at, e.EnumerateArray().Skip(2).Select(Num).ToArray(), v);
                }
                continue;
            }
            m.Equal(at + " frame", e.GetProperty("frame").GetInt32(), f);
            m.Equal(at + " type", e.GetProperty("type").GetString(), type);
            if (type == "breakup")
            {
                var be = (WreckEvent)extra;
                m.Equal(at + " id", e.GetProperty("id").GetString(), be.Id);
                Close(m, at + " position", Nums(e, "position"), V(be.Position));
                Close(m, at + " velocity", Nums(e, "velocity"), V(be.Velocity));
                Close(m, at + " normal", Nums(e, "normal"), V(be.Normal));
                m.Close(at + " severity", Num(e, "severity"), be.Severity, 1e-9);
                m.Equal(at + " water", e.GetProperty("water").GetBoolean(), be.Water);
                var fires = e.GetProperty("fires").EnumerateArray().ToList();
                List<object[]> got = breakupFires[be];
                m.Equal(at + " fires", fires.Count, got.Count);
                for (int k = 0; k < Math.Min(fires.Count, got.Count); k++)
                {
                    m.Equal($"{at} fire {k} kind", fires[k][0].GetString(), (string)got[k][0]);
                    m.Equal($"{at} fire {k} fragment", fires[k][1].GetInt32(), (int)got[k][1]);
                    Close(m, $"{at} fire {k} local", fires[k].EnumerateArray().Skip(2).Select(Num).ToArray(), V((Vec3d)got[k][2]));
                }
            }
            else if (type == "damage")
            {
                var de = (WreckDamageEvent)extra;
                m.Close(at + " severity", Num(e, "severity"), de.Severity, 1e-9);
                var fires = e.GetProperty("fires").EnumerateArray().ToList();
                m.Equal(at + " fires", fires.Count, de.Fires.Count);
                for (int k = 0; k < Math.Min(fires.Count, de.Fires.Count); k++)
                {
                    m.Equal($"{at} fire {k} kind", fires[k][0].GetString(), KindName(de.Fires[k].Kind));
                    Close(m, $"{at} fire {k} local", fires[k].EnumerateArray().Skip(1).Select(Num).ToArray(), V(de.Fires[k].Local));
                }
            }
        }
        m.AssertNone();
    }

    private static void CheckHooks(Mismatches m, string at, JsonElement h, WreckField field)
    {
        m.Close(at + " lastDislocationM", Num(h, "dislocation"), field.LastDislocationM, 1e-9);
        m.Close(at + " lastKinkRad", Num(h, "kink"), field.LastKinkRad, 1e-9);
        m.Close(at + " lastBendRad", Num(h, "bend"), field.LastBendRad, 1e-9);
        m.Close(at + " lastBendUpRad", Num(h, "bendUp"), field.LastBendUpRad, 1e-9);
        m.Close(at + " lastTotalBendRad", Num(h, "totalBend"), field.LastTotalBendRad, 1e-9);
        m.Equal(at + " lastScrapTriangles", h.GetProperty("scraps").GetInt32(), field.LastScrapTriangles);
        m.Equal(at + " bentCells", string.Join(",", Nums(h, "bentCells")), string.Join(",", field.LastBentCells));
        m.Equal(at + " brokenCells", string.Join(",", Nums(h, "brokenCells")), string.Join(",", field.LastBrokenCells));
    }

    private static void CheckDamage(Mismatches m, string at, JsonElement s, AirframeDamage d)
    {
        m.Close(at + " severity", Num(s, "severity"), d.Severity, 1e-12);
        m.Equal(at + " active", s.GetProperty("active").GetBoolean(), d.Active);
        m.Equal(at + " rippedCells", string.Join(",", Nums(s, "rippedCells")), string.Join(",", d.RippedCells.OrderBy(x => x)));
        m.Equal(at + " rippedParts", string.Join(",", Nums(s, "rippedParts")), string.Join(",", d.RippedParts.OrderBy(x => x)));
        int j = 0;
        foreach (JsonElement joint in s.GetProperty("joints").EnumerateArray())
        {
            Close(m, $"{at} joint {j}", Nums(joint), new[] { d.Joints[j].Yaw, d.Joints[j].Pitch, d.Joints[j].Shift });
            j++;
        }
        var folds = s.GetProperty("wingFold").EnumerateArray().ToList();
        m.Equal(at + " wingFold count", folds.Count, d.WingFold.Count);
        foreach (JsonElement f in folds)
        {
            int cell = f[0].GetInt32();
            m.Close($"{at} wingFold {cell}", Num(f[1]), d.WingFold.TryGetValue(cell, out double v) ? v : double.NaN, 1e-9);
        }
        var bends = s.GetProperty("partBends").EnumerateArray().ToList();
        m.Equal(at + " partBends", string.Join(",", bends.Select(b => b.GetProperty("id").GetInt32())), string.Join(",", d.PartBends.Keys.OrderBy(x => x)));
        foreach (JsonElement b in bends)
        {
            int id = b.GetProperty("id").GetInt32();
            if (!d.PartBends.TryGetValue(id, out PartBend pb)) continue;
            Close(m, $"{at} partBend {id} m", Nums(b, "m"), pb.M);
            Close(m, $"{at} partBend {id} q", Nums(b, "q"), Qa(pb.Q));
        }
        m.Equal(at + " rootParts", string.Join(",", Nums(s, "rootParts")), string.Join(",", d.RootParts.OrderBy(x => x)));
        m.Equal(at + " gearInRoot", s.GetProperty("gearInRoot").GetBoolean(), d.GearInRoot);
        m.Equal(at + " fireSites", string.Join(",", Nums(s, "fireSites")), string.Join(",", d.FireSites.OrderBy(x => x)));
        m.Close(at + " lastBlowAt", Num(s, "lastBlowAt"), d.LastBlowAt, 1e-12);
        JsonElement root = s.GetProperty("root");
        if (root.ValueKind == JsonValueKind.Null)
        {
            m.Equal(at + " root", true, d.Root == null);
            return;
        }
        var meshes = root.EnumerateArray().ToList();
        m.Equal(at + " root meshes", meshes.Count, d.Root?.Count ?? -1);
        for (int k = 0; d.Root != null && k < Math.Min(meshes.Count, d.Root.Count); k++)
        {
            JsonElement x = meshes[k];
            WreckMeshData mesh = d.Root[k];
            m.Equal($"{at} root {k} material", x.GetProperty("material").GetString(), (string)mesh.Material);
            m.Equal($"{at} root {k} vertices", x.GetProperty("vertices").GetInt32(), mesh.VertexCount);
            m.Equal($"{at} root {k} position", x.GetProperty("position").GetString(), HashF32(mesh.Position));
            m.Equal($"{at} root {k} normal", x.GetProperty("normal").ValueKind == JsonValueKind.Null ? null : x.GetProperty("normal").GetString(),
                mesh.Normal == null ? null : HashF32(mesh.Normal));
        }
    }

    private static void CheckSample(Mismatches m, string at, JsonElement sample, WreckField field, Dictionary<WreckFragment, int> ids)
    {
        var rows = sample.GetProperty("pieces").EnumerateArray().ToList();
        m.Equal(at + " pieces", rows.Count, field.Fragments.Count);
        for (int i = 0; i < Math.Min(rows.Count, field.Fragments.Count); i++)
        {
            double[] r = Nums(rows[i]);
            WreckFragment f = field.Fragments[i];
            m.Equal($"{at} piece {i} id", (int)r[0], ids[f]);
            Close(m, $"{at} piece {i} pose", r.Skip(1).Take(7).ToArray(), V(f.Position).Concat(Qa(f.Quaternion)).ToArray());
            m.Equal($"{at} piece {i} flags", $"{r[8]},{r[9]},{r[10]}", $"{(f.Asleep ? 1 : 0)},{(f.Visible ? 1 : 0)},{(f.Submerged ? 1 : 0)}");
        }
        JsonElement cockpit = sample.GetProperty("cockpit");
        bool hasPose = field.CockpitBodyPose("p", out Vec3d pos, out Quatd quat);
        bool hasEye = field.CockpitWorld("p", out Vec3d eye);
        if (cockpit.ValueKind == JsonValueKind.Null)
        {
            m.Equal(at + " cockpit", false, hasPose || hasEye);
        }
        else if (cockpit.GetArrayLength() == 10)
        {
            Close(m, at + " cockpit", Nums(cockpit), V(pos).Concat(Qa(quat)).Concat(V(eye)).ToArray());
        }
        else
        {
            Close(m, at + " cockpit eye", Nums(cockpit), V(eye));
        }
        var fires = sample.GetProperty("fires").EnumerateArray().ToList();
        m.Equal(at + " fires", fires.Count, field.Fires.Count);
        for (int i = 0; i < Math.Min(fires.Count, field.Fires.Count); i++)
        {
            JsonElement e = fires[i];
            WreckFire fire = field.Fires[i];
            m.Equal($"{at} fire {i} kind", e[0].GetString(), KindName(fire.Kind));
            m.Equal($"{at} fire {i} fragment", e[1].GetInt32(), ids.TryGetValue(fire.Fragment, out int id) ? id : -1);
            Close(m, $"{at} fire {i} local", new[] { Num(e[2]), Num(e[3]), Num(e[4]) }, V(fire.Local));
            bool live = field.FireWorld(fire, out Vec3d w);
            m.Equal($"{at} fire {i} live", e[5].GetInt32() == 1, live);
            if (live && e.GetArrayLength() == 9)
            {
                Close(m, $"{at} fire {i} world", new[] { Num(e[6]), Num(e[7]), Num(e[8]) }, V(w));
            }
        }
    }
}
