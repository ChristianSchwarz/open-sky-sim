#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/damage_smoke.json: scripted scenarios through
/// DamageSmokeField (leaks on moving aircraft, a ground crash with fireball,
/// lake of fire and fires riding on pieces, dust by surface, splashes and foam,
/// a carrier deck, a rebase, pool expiry, reset) with a seeded Math.random.
/// Instance matrices, dither levels and tones must be bit-identical float32,
/// the mark streams bit-identical doubles.
/// </summary>
public class DamageSmokeTests
{
    private static readonly JsonElement Smoke = Load("damage_smoke.json");

    private static string Hash(ReadOnlySpan<float> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    private static string Hash(ReadOnlySpan<double> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    private static string Hash(ReadOnlySpan<byte> a) => Structural.Fnv1a32(a).ToString("x8");

    private sealed class Deck : IMovingSurface
    {
        public Vec3d V;
        public Vec3d Velocity => V;
        public double Y, XMin, XMax;
        public bool Contains(double x, double y, double z) => Math.Abs(y - Y) < 3 && x >= XMin && x <= XMax;
    }

    /// <summary>The analytic world of one scenario (see the fixture notes).</summary>
    private sealed class World
    {
        public readonly JsonElement In;
        public readonly double Dt;
        public int Frame;
        public FrameShift? Shift;
        public readonly Deck? Deck;
        private readonly double? waterBelowX;
        private readonly double[]? concrete;
        private readonly Dictionary<string, JsonElement> targets = new();
        public readonly JsonElement[] Anchors;

        public World(JsonElement input)
        {
            In = input;
            Dt = Num(input, "dt");
            if (input.GetProperty("deck").ValueKind == JsonValueKind.Object)
            {
                JsonElement d = input.GetProperty("deck");
                Deck = new Deck { Y = Num(d, "y"), XMin = Num(d, "xMin"), XMax = Num(d, "xMax") };
            }
            if (input.GetProperty("waterBelowX").ValueKind == JsonValueKind.Number) waterBelowX = Num(input, "waterBelowX");
            if (input.GetProperty("concrete").ValueKind == JsonValueKind.Array) concrete = Nums(input, "concrete");
            foreach (JsonElement t in input.GetProperty("targets").EnumerateArray()) targets[t.GetProperty("id").GetString()!] = t;
            Anchors = input.GetProperty("anchors").EnumerateArray().ToArray();
        }

        private double T => Frame * Dt;

        public bool HasWater => waterBelowX.HasValue;

        public void UpdateDeck()
        {
            if (Deck == null) return;
            JsonElement d = In.GetProperty("deck");
            Deck.V = new Vec3d(Num(d, "vxAmp") * JsTrig.Sin(0.05 * T), 0, Num(d, "vz"));
        }

        public double Ground(double x, double z)
        {
            JsonElement g = In.GetProperty("ground");
            if (g.GetProperty("kind").GetString() == "deck")
            {
                return Deck != null && x >= Deck.XMin && x <= Deck.XMax ? Deck.Y : 0;
            }
            return Num(g, "base") + Num(g, "sx") * x + Num(g, "sz") * z + Num(g, "amp") * JsTrig.Sin(0.05 * x) * JsTrig.Cos(0.04 * z);
        }

        public bool Water(double x, double z) =>
            waterBelowX.HasValue && x < waterBelowX.Value && !(Deck != null && x >= Deck.XMin && x <= Deck.XMax);

        public SmokeSurfaceKind Surface(double x, double z)
        {
            if (Deck != null && x >= Deck.XMin && x <= Deck.XMax) return SmokeSurfaceKind.Concrete;
            if (Water(x, z)) return SmokeSurfaceKind.Water;
            if (concrete != null && x >= concrete[0] && x <= concrete[1]) return SmokeSurfaceKind.Concrete;
            return SmokeSurfaceKind.Dirt;
        }

        private static bool Has(JsonElement e, string p, out double v)
        {
            if (e.TryGetProperty(p, out JsonElement x))
            {
                v = Num(x);
                return true;
            }
            v = 0;
            return false;
        }

        public DamageSmokePose? Pose(string id)
        {
            if (!targets.TryGetValue(id, out JsonElement t)) return null;
            if (Has(t, "goneAt", out double goneAt) && Frame >= goneAt) return null;
            bool crashed = Has(t, "crashedAt", out double crashedAt) && Frame >= crashedAt;
            double tt = crashed ? crashedAt * Dt : T;
            double r = Num(t, "r"), w = Num(t, "w");
            double a = Num(t, "phase") + w * tt;
            var position = new Vec3d(Num(t, "cx") + r * JsTrig.Sin(a), crashed ? Num(t, "crashY") : Num(t, "cy"), Num(t, "cz") + r * JsTrig.Cos(a));
            Quatd q = Quatd.FromAxisAngle(Vec3d.UnitY, a + Math.PI / 2) * Quatd.FromAxisAngle(Vec3d.UnitZ, Num(t, "bank"));
            Vec3d velocity = crashed ? new Vec3d(0, 0, 0) : new Vec3d(r * w * JsTrig.Cos(a), 0, -r * w * JsTrig.Sin(a));
            if (Shift != null)
            {
                position = Shift.Point(position);
                q = Shift.Orientation(q);
                velocity = Shift.Vector(velocity);
            }
            return new DamageSmokePose
            {
                Position = position,
                Quaternion = q,
                Velocity = velocity,
                IsAlive = !Has(t, "deadAt", out double deadAt) || Frame < deadAt,
                IsCrashed = crashed,
            };
        }

        public bool Anchor(int index, out Vec3d world)
        {
            JsonElement a = Anchors[index];
            world = default;
            if (Has(a, "goneAt", out double goneAt) && Frame >= goneAt) return false;
            double t = (Frame - Num(a, "from")) * Dt;
            double x = Num(a, "x"), y = Num(a, "y"), z = Num(a, "z");
            switch (a.GetProperty("kind").GetString())
            {
                case "slide":
                {
                    double speed = Num(a, "speed"), tT = Num(a, "T");
                    double d = t < tT ? speed * (t - t * t / (2 * tT)) : speed * tT / 2;
                    world = new Vec3d(x + Num(a, "dirX") * d, y, z + Num(a, "dirZ") * d);
                    break;
                }
                case "fall":
                    world = new Vec3d(x + Num(a, "vx") * t, Math.Max(Num(a, "floor"), y + Num(a, "vy") * t - 4.903325 * t * t), z + Num(a, "vz") * t);
                    break;
                case "fixed":
                    world = new Vec3d(x, y, z);
                    break;
                case "deck":
                    world = new Vec3d(x, y, z + Num(In.GetProperty("deck"), "vz") * t);
                    break;
            }
            if (Shift != null) world = Shift.Point(world);
            return true;
        }
    }

    private static Palette PaletteOf(string name) => name switch
    {
        "noon" => Palettes.HdNoon,
        "midnight" => Palettes.HdMidnight,
        _ => Palettes.HdNightVision,
    };

    private static SimHitEvent Hit(JsonElement h)
    {
        return new SimHitEvent
        {
            Position = Nums(h, "position"),
            Velocity = Nums(h, "velocity"),
            TargetId = h.GetProperty("targetId").GetString()!,
            Damage = Num(h, "damage"),
            Source = h.TryGetProperty("source", out JsonElement s) ? s.GetString() : null,
            Slide = h.TryGetProperty("slide", out JsonElement sl) ? sl.GetBoolean() : null,
        };
    }

    private static List<SimHitEvent> Hits(JsonElement ev) => ev.GetProperty("hits").EnumerateArray().Select(Hit).ToList();

    private static SmokeSurfaceKind Kind(string s) => s switch
    {
        "water" => SmokeSurfaceKind.Water,
        "concrete" => SmokeSurfaceKind.Concrete,
        _ => SmokeSurfaceKind.Dirt,
    };

    private static double? Opt(JsonElement e, string p) => e.TryGetProperty(p, out JsonElement x) ? Num(x) : null;

    private static void SameFloats(Mismatches m, string what, JsonElement expected, ReadOnlySpan<float> actual)
    {
        float[] want = expected.EnumerateArray().Select(x => (float)Num(x)).ToArray();
        m.Equal($"{what} length", want.Length, actual.Length);
        int bad = 0;
        for (int i = 0; i < Math.Min(want.Length, actual.Length); i++)
        {
            if (BitConverter.SingleToInt32Bits(want[i]) != BitConverter.SingleToInt32Bits(actual[i]) && bad++ < 3)
            {
                m.Fail($"{what}[{i}]: expected {want[i]:R}, got {actual[i]:R}");
            }
        }
    }

    [Fact]
    public void ScenariosMatchTheOracle()
    {
        var m = new Mismatches();
        int frames = 0, dumps = 0, marks = 0, maxCount = 0;
        foreach (JsonElement sc in Smoke.GetProperty("scenarios").EnumerateArray())
        {
            JsonElement input = sc.GetProperty("input");
            string name = input.GetProperty("name").GetString()!;
            var world = new World(input);
            Func<double> rng = Gun.Mulberry32((uint)input.GetProperty("seed").GetInt64());
            int draws = 0;
            var field = new DamageSmokeField(() => { draws++; return rng(); });
            field.SetPoseProvider(world.Pose);
            field.SetGroundHeightAt(world.Ground);
            if (world.HasWater) field.SetWaterTest(world.Water);
            if (input.GetProperty("surfaceProbe").GetBoolean()) field.SurfaceAt = world.Surface;
            if (world.Deck != null) field.SetMovingSurface(world.Deck);
            var poolRows = new List<double[]>();
            var burnRows = new List<double[]>();
            if (input.GetProperty("marks").GetBoolean())
            {
                field.OnPoolMark = (p, dx, dz, l, w, c) => poolRows.Add(new[] { p.X, p.Y, p.Z, dx, dz, l, w, c ? 1 : 0 });
                field.OnBurnMark = (p, r, s, g) => burnRows.Add(new[] { p.X, p.Y, p.Z, r, s, g });
            }
            Palette palette = PaletteOf(input.GetProperty("palette").GetString()!);
            double dt = world.Dt;
            double[] c0 = Nums(input.GetProperty("camera"), "c0"), cv = Nums(input.GetProperty("camera"), "cv");
            var events = input.GetProperty("events").EnumerateArray().ToList();

            JsonElement[] expected = sc.GetProperty("output").GetProperty("frames").EnumerateArray().ToArray();
            int frameCount = input.GetProperty("frames").GetInt32();
            m.Equal($"{name} frames", frameCount, expected.Length);
            for (int f = 0; f < frameCount; f++)
            {
                world.Frame = f;
                poolRows.Clear();
                burnRows.Clear();
                world.UpdateDeck();
                foreach (JsonElement ev in events.Where(e => e.GetProperty("frame").GetInt32() == f))
                {
                    switch (ev.GetProperty("kind").GetString())
                    {
                        case "hits": field.SpawnFromHits(Hits(ev)); break;
                        case "scrapes": field.SpawnGroundScrapes(Hits(ev)); break;
                        case "debugLeak": field.SpawnDebugLeak(ev.GetProperty("id").GetString()!); break;
                        case "crashPlume": field.EnsureCrashPlume(ev.GetProperty("id").GetString()!); break;
                        case "fireball": field.SpawnFireball(V3(ev.GetProperty("position")), V3(ev.GetProperty("velocity")), Num(ev, "severity")); break;
                        case "firePool": field.AddFirePool(V3(ev.GetProperty("position")), V3(ev.GetProperty("velocity")), Num(ev, "severity")); break;
                        case "dust": field.SpawnDust(V3(ev.GetProperty("position")), V3(ev.GetProperty("velocity")), ev.GetProperty("count").GetInt32(), Num(ev, "strength")); break;
                        case "splash": field.SpawnSplash(V3(ev.GetProperty("position")), Num(ev, "strength")); break;
                        case "foam": field.SpawnFoam(V3(ev.GetProperty("position")), Num(ev, "radius"), Num(ev, "count")); break;
                        case "contact": field.SpawnContactPuffs(V3(ev.GetProperty("position")), Kind(ev.GetProperty("surface").GetString()!), Num(ev, "count"), Num(ev, "scale")); break;
                        case "burnSpot": field.AddBurnSpot(V3(ev.GetProperty("position")), Num(ev, "life"), Num(ev, "intensity")); break;
                        case "anchored":
                        {
                            int anchor = ev.GetProperty("anchor").GetInt32();
                            field.AddAnchoredFire(
                                ev.GetProperty("targetId").GetString()!,
                                (out Vec3d at) => world.Anchor(anchor, out at),
                                Num(ev, "rate"), Num(ev, "life"), ev.GetProperty("small").GetBoolean(),
                                Opt(ev, "trickle"), Opt(ev, "drips"));
                            break;
                        }
                        case "rebase":
                        {
                            var shift = new FrameShift(Q(ev.GetProperty("rotation")), V3(ev.GetProperty("offset")));
                            field.Rebase(shift);
                            world.Shift = shift;
                            break;
                        }
                        case "reset": field.Reset(); break;
                        case "surfaceProbe":
                            field.SurfaceAt = ev.GetProperty("on").GetBoolean() ? world.Surface : null;
                            break;
                        default: throw new InvalidOperationException(ev.GetProperty("kind").GetString());
                    }
                }
                field.Update(dt);
                field.SyncPuffs(new Vec3d(c0[0] + cv[0] * f, c0[1] + cv[1] * f, c0[2] + cv[2] * f), palette);

                JsonElement e = expected[f];
                string at = $"{name} frame {f}";
                int n = field.InstanceCount;
                maxCount = Math.Max(maxCount, n);
                m.Equal($"{at} draws", e.GetProperty("draws").GetInt32(), draws);
                m.Equal($"{at} count", e.GetProperty("count").GetInt32(), n);
                var flags = new List<byte>();
                for (int i = 0; i < DamageSmokeField.ParticleCount; i++)
                {
                    if (field.System.Particles[i].IsActive) flags.Add(field.SlotKinds[i]);
                }
                m.Equal($"{at} flags", e.GetProperty("flags").GetString(), Hash(flags.ToArray()));
                m.Equal($"{at} matrices", e.GetProperty("matrices").GetString(), Hash(field.InstanceMatrices.AsSpan(0, n * 16)));
                m.Equal($"{at} level", e.GetProperty("level").GetString(), Hash(field.DitherLevels.AsSpan(0, n)));
                m.Equal($"{at} toneA", e.GetProperty("toneA").GetString(), Hash(field.ToneA.AsSpan(0, n * 3)));
                m.Equal($"{at} toneB", e.GetProperty("toneB").GetString(), Hash(field.ToneB.AsSpan(0, n * 3)));
                int[] state =
                {
                    field.Leaks.Count(l => l.Active), field.Anchored.Count(a => a.Active), field.BurnSpots.Count(s => s.Active),
                    field.FuelDrops.Count(d => d.Active), field.Pools.Count(p => p.Active),
                    field.Pools.Sum(p => p.Active ? p.Trail.Count : 0),
                };
                m.Equal($"{at} state", string.Join(",", e.GetProperty("state").EnumerateArray().Select(x => x.GetInt32())), string.Join(",", state));

                if (e.TryGetProperty("marks", out JsonElement mk))
                {
                    m.Equal($"{at} pool marks", mk[0].GetInt32(), poolRows.Count);
                    m.Equal($"{at} burn marks", mk[1].GetInt32(), burnRows.Count);
                    double[] all = poolRows.Concat(burnRows).SelectMany(r => r).ToArray();
                    m.Equal($"{at} marks hash", mk[2].GetString(), Hash(all));
                    marks += poolRows.Count + burnRows.Count;
                    if (e.TryGetProperty("poolMarks", out JsonElement pr))
                    {
                        int k = 0;
                        foreach (JsonElement row in pr.EnumerateArray())
                        {
                            if (k < poolRows.Count) m.Equal($"{at} pool mark {k}", string.Join(",", Nums(row).Select(v => v.ToString("R"))), string.Join(",", poolRows[k].Select(v => v.ToString("R"))));
                            k++;
                        }
                        k = 0;
                        foreach (JsonElement row in e.GetProperty("burnMarks").EnumerateArray())
                        {
                            if (k < burnRows.Count) m.Equal($"{at} burn mark {k}", string.Join(",", Nums(row).Select(v => v.ToString("R"))), string.Join(",", burnRows[k].Select(v => v.ToString("R"))));
                            k++;
                        }
                    }
                }
                else
                {
                    m.Equal($"{at} marks", 0, poolRows.Count + burnRows.Count);
                }

                if (e.TryGetProperty("dump", out JsonElement d))
                {
                    int k = Math.Min(n, 6);
                    SameFloats(m, $"{at} matrices", d.GetProperty("matrices"), field.InstanceMatrices.AsSpan(0, k * 16));
                    SameFloats(m, $"{at} level", d.GetProperty("level"), field.DitherLevels.AsSpan(0, k));
                    SameFloats(m, $"{at} toneA", d.GetProperty("toneA"), field.ToneA.AsSpan(0, k * 3));
                    SameFloats(m, $"{at} toneB", d.GetProperty("toneB"), field.ToneB.AsSpan(0, k * 3));
                    m.Equal($"{at} flags dump", string.Join(",", d.GetProperty("flags").EnumerateArray().Select(x => x.GetInt32())), string.Join(",", flags.Take(64)));
                    dumps++;
                }
                for (int i = 0; i < n; i++)
                {
                    if ((float)field.InstancePositions[i].X != field.InstanceMatrices[i * 16 + 12]) { m.Fail($"{at} InstancePositions[{i}] != matrix"); break; }
                }
                frames++;
            }
        }
        m.AssertNone();
        Assert.True(frames > 3000 && dumps >= 20 && marks > 500 && maxCount > 4000, $"coverage: {frames} frames, {dumps} dumps, {marks} marks, max {maxCount} puffs");
    }
}
