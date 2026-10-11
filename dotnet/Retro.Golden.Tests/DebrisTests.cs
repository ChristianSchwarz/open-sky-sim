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
/// Replays tests/golden/debris.json: the hit-debris / scrape-spark pools
/// (debrisField.ts with the sphere emitter, gravity and drag) and the impact /
/// burn mark rings (impactMarks.ts) with a seeded Math.random. Float32 outputs
/// and the particle doubles must be bit-identical. Also ports impactMarks.test.ts.
/// </summary>
public class DebrisTests
{
    private static readonly JsonElement Debris = Load("debris.json");

    private static string Hash(ReadOnlySpan<float> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    private static void SameFloats(Mismatches m, string what, JsonElement expected, ReadOnlySpan<float> actual)
    {
        // JSON writes -0 as 0, so a dumped zero matches either sign; the hashes cover the sign bit.
        float[] want = expected.EnumerateArray().Select(x => (float)Num(x)).ToArray();
        int bad = 0;
        for (int i = 0; i < want.Length; i++)
        {
            int w = BitConverter.SingleToInt32Bits(want[i]);
            int g = actual[i] == 0 && want[i] == 0 ? w : BitConverter.SingleToInt32Bits(actual[i]);
            m.Equal($"{what}[{i}] bits", w, g);
            if (w != g && ++bad >= 3) break;
        }
    }

    private static SimHitEvent[] Hits(JsonElement a) => a.GetProperty("hits").EnumerateArray().Select(h => new SimHitEvent
    {
        Position = Nums(h, "position"),
        Velocity = Nums(h, "velocity"),
        TargetId = "ai0",
        Damage = 1,
        Source = h.TryGetProperty("source", out JsonElement s) ? s.GetString() : null,
    }).ToArray();

    private static FrameShift Shift(JsonElement a) => new(Q(a.GetProperty("rotation")), V3(a.GetProperty("offset")));

    private static string Mask(DebrisInstance[] xs) => new(xs.Select(x => x.Visible ? '1' : '0').ToArray());

    private static void SameParticles(Mismatches m, string what, JsonElement dump, CpuParticleSystem sys)
    {
        var live = sys.Particles.Select((p, i) => (p, i)).Where(t => t.p.IsActive).ToArray();
        JsonElement[] want = dump.EnumerateArray().ToArray();
        m.Equal($"{what} live", want.Length, live.Length);
        for (int k = 0; k < Math.Min(want.Length, live.Length); k++)
        {
            JsonElement w = want[k];
            (CpuParticle p, int i) = live[k];
            string at = $"{what} particle {i}";
            m.Equal($"{at} index", w.GetProperty("i").GetInt32(), i);
            m.Close($"{at} life", Num(w, "life"), p.Life, 0);
            m.Close($"{at} lifespan", Num(w, "lifespan"), p.Lifespan, 0);
            m.Close($"{at} position", V3(w.GetProperty("position")), p.Position, 0);
            m.Close($"{at} velocity", V3(w.GetProperty("velocity")), p.Velocity, 0);
            m.Close($"{at} sizeStart", Num(w, "sizeStart"), p.SizeStart, 0);
            m.Close($"{at} sizeEnd", Num(w, "sizeEnd"), p.SizeEnd, 0);
            m.Close($"{at} rotationStart", Num(w, "rotationStart"), p.RotationStart, 0);
            m.Close($"{at} rotationEnd", Num(w, "rotationEnd"), p.RotationEnd, 0);
        }
    }

    [Fact]
    public void DebrisMatchesTheOracle()
    {
        var m = new Mismatches();
        int dumps = 0, recycled = 0;
        foreach (JsonElement sc in Debris.GetProperty("debris").EnumerateArray())
        {
            string name = sc.GetProperty("name").GetString()!;
            Func<double> rng = Gun.Mulberry32((uint)sc.GetProperty("seed").GetInt64());
            int draws = 0;
            var field = new DebrisField(() => { draws++; return rng(); });
            int a = 0;
            foreach (JsonElement axis in sc.GetProperty("spinAxes").EnumerateArray())
            {
                m.Close($"{name} spin axis {a}", V3(axis), field.SpinAxis(a), 0);
                a++;
            }
            double dt = Num(sc, "dt");
            int i = 0;
            foreach (JsonElement f in sc.GetProperty("frames").EnumerateArray())
            {
                foreach (JsonElement act in f.GetProperty("actions").EnumerateArray())
                {
                    switch (act.GetProperty("type").GetString())
                    {
                        case "hits":
                            if (act.GetProperty("hits").GetArrayLength() > DebrisField.DebrisMaxHitsPerFrame) recycled++;
                            field.SpawnFromHits(Hits(act));
                            break;
                        case "scrapes":
                            field.SpawnGroundScrapes(Hits(act));
                            break;
                        case "debug":
                            field.SpawnDebugBurst(V3(act.GetProperty("position")),
                                act.TryGetProperty("velocity", out JsonElement v) ? V3(v) : null);
                            break;
                        case "rebase":
                            field.Rebase(Shift(act));
                            break;
                    }
                }
                field.Update(dt);
                string at = $"{name} frame {i}";
                m.Equal($"{at} draws", f.GetProperty("draws").GetInt32(), draws);
                m.Equal($"{at} chips visible", f.GetProperty("chipsVisible").GetString(), Mask(field.Chips));
                m.Equal($"{at} sparks visible", f.GetProperty("sparksVisible").GetString(), Mask(field.Sparks));
                m.Equal($"{at} chip matrices", f.GetProperty("chipMatrices").GetString(), Hash(field.ChipMatrices));
                m.Equal($"{at} spark matrices", f.GetProperty("sparkMatrices").GetString(), Hash(field.SparkMatrices));
                if (f.TryGetProperty("dump", out JsonElement d))
                {
                    SameFloats(m, $"{at} chip matrices", d.GetProperty("chipMatrices"), field.ChipMatrices);
                    SameFloats(m, $"{at} spark matrices", d.GetProperty("sparkMatrices"), field.SparkMatrices);
                    SameParticles(m, $"{at} chips", d.GetProperty("chips"), field.DebrisSystem);
                    SameParticles(m, $"{at} sparks", d.GetProperty("sparks"), field.SparkSystem);
                    dumps++;
                }
                i++;
            }
        }
        m.AssertNone();
        Assert.True(dumps >= 10 && recycled >= 1, $"coverage: {dumps} dumps, {recycled} capped batches");
    }

    private sealed class ScriptedSurface : IMovingSurface
    {
        public Vec3d Velocity { get; set; }
        public bool OnDeck;
        public Func<double, double, double, bool> Test = null!;
        public bool Contains(double x, double y, double z) => Test?.Invoke(x, y, z) ?? OnDeck;
    }

    private static void SamePool(Mismatches m, string at, JsonElement want, MarkPool pool)
    {
        m.Equal($"{at} count", want.GetProperty("count").GetInt32(), pool.Count);
        m.Equal($"{at} visible", want.GetProperty("visible").GetBoolean(), pool.Visible);
        m.Equal($"{at} next", want.GetProperty("next").GetInt32(), pool.Next);
        m.Equal($"{at} matrices", want.GetProperty("matrices").GetString(), Hash(pool.Matrices));
        m.Equal($"{at} levels", want.GetProperty("levels").GetString(), Hash(pool.Levels));
        if (want.TryGetProperty("dumpMatrices", out JsonElement dm))
        {
            SameFloats(m, $"{at} matrices", dm, pool.Matrices);
            SameFloats(m, $"{at} levels", want.GetProperty("dumpLevels"), pool.Levels);
        }
    }

    [Fact]
    public void ImpactMarksMatchTheOracle()
    {
        var m = new Mismatches();
        JsonElement sc = Debris.GetProperty("marks");
        Func<double> rng = Gun.Mulberry32((uint)sc.GetProperty("seed").GetInt64());
        int draws = 0;
        var marks = new ImpactMarks(() => { draws++; return rng(); });
        var surface = new ScriptedSurface();
        marks.SetMovingSurface(surface);
        double dt = Num(sc, "dt");
        int i = 0, maxMovers = 0;
        foreach (JsonElement f in sc.GetProperty("frames").EnumerateArray())
        {
            surface.Velocity = V3(f.GetProperty("deckVelocity"));
            foreach (JsonElement a in f.GetProperty("actions").EnumerateArray())
            {
                string type = a.GetProperty("type").GetString()!;
                if (type == "add" || type == "burn")
                {
                    surface.OnDeck = a.GetProperty("onDeck").GetBoolean();
                    Vec3d p = V3(a.GetProperty("position")), n = V3(a.GetProperty("normal"));
                    if (type == "add")
                    {
                        marks.Add(p, n, Num(a, "dirX"), Num(a, "dirZ"), Num(a, "length"), Num(a, "width"), Num(a, "strength"));
                    }
                    else
                    {
                        marks.AddBurn(p, n, Num(a, "dirX"), Num(a, "dirZ"), Num(a, "length"), Num(a, "width"),
                            Num(a, "strength"), Num(a, "growSeconds"));
                    }
                }
                else if (type == "rebase")
                {
                    marks.Rebase(Shift(a));
                }
                else
                {
                    marks.Clear();
                }
            }
            marks.Update(dt);
            string at = $"marks frame {i}";
            m.Equal($"{at} draws", f.GetProperty("draws").GetInt32(), draws);
            SamePool(m, $"{at} impact", f.GetProperty("impact"), marks.Impact);
            SamePool(m, $"{at} burn", f.GetProperty("burn"), marks.Burn);
            maxMovers = Math.Max(maxMovers, f.GetProperty("burn").GetProperty("movers").GetInt32());
            i++;
        }
        m.AssertNone();
        Assert.True(maxMovers > 100 && draws > 50, $"coverage: {maxMovers} movers, {draws} draws");
    }

    [Fact]
    public void ExpMatchesV8()
    {
        var m = new Mismatches();
        foreach (JsonElement pair in Debris.GetProperty("exp").EnumerateArray())
        {
            double x = Num(pair[0]), want = Num(pair[1]);
            m.Equal($"exp({x:R}) bits", BitConverter.DoubleToInt64Bits(want), BitConverter.DoubleToInt64Bits(JsExp.Exp(x)));
        }
        m.AssertNone();
    }

    [Fact]
    public void MeshesMatchThreeJs()
    {
        var m = new Mismatches();
        JsonElement meshes = Debris.GetProperty("meshes");
        void Same(string name, float[] positions, ushort[] indices)
        {
            JsonElement g = meshes.GetProperty(name);
            m.Equal($"{name} vertex floats", g.GetProperty("positions").GetArrayLength(), positions.Length);
            SameFloats(m, $"{name} positions", g.GetProperty("positions"), positions);
            int[] want = g.GetProperty("indices").EnumerateArray().Select(x => x.GetInt32()).ToArray();
            m.Equal($"{name} indices", string.Join(",", want), string.Join(",", indices));
        }
        Same("chip", DebrisField.ChipPositions, DebrisField.ChipIndices);
        Same("spark", DebrisField.SparkPositions, DebrisField.SparkIndices);
        Same("blob", ImpactMarks.BlobPositions, ImpactMarks.BlobIndices);
        m.AssertNone();
    }

    [Fact]
    public void SlotPaletteCategoriesFollowTheTs()
    {
        Assert.Equal(PaletteCategory.VEHICLE_PLANE_GREY, DebrisField.ChipCategory(0));
        Assert.Equal(PaletteCategory.SCENERY_ROAD_SECONDARY, DebrisField.ChipCategory(5));
        Assert.Equal(PaletteCategory.VEHICLE_PLANE_GREY, DebrisField.ChipCategory(6));
        Assert.Equal(PaletteCategory.FX_FIRE, DebrisField.SparkCategory(4));
        Assert.Equal(PaletteCategory.SCENERY_FIELD_YELLOW, DebrisField.SparkCategory(47));
    }

    // ------------------------------------------------ impactMarks.test.ts

    private static readonly Vec3d Up = new(0, 1, 0);
    private static readonly Vec3d At = new(10, 0, 20);

    private static ImpactMarks NewMarks() => new(Gun.Mulberry32(1));

    /// <summary>The x scale a mark is drawn with (its width): the length of the matrix's first column.</summary>
    private static double WidthOf(MarkPool pool, int index)
    {
        int o = index * 16;
        float[] e = pool.Matrices;
        return Math.Sqrt((double)e[o] * e[o] + (double)e[o + 1] * e[o + 1] + (double)e[o + 2] * e[o + 2]);
    }

    private static Vec3d PositionOf(MarkPool pool, int index)
    {
        int o = index * 16;
        return new Vec3d(pool.Matrices[o + 12], pool.Matrices[o + 13], pool.Matrices[o + 14]);
    }

    [Fact]
    public void BurnMarksStartTooFaintThenDarkenToTheirTarget()
    {
        ImpactMarks marks = NewMarks();
        marks.AddBurn(At, Up, 0, 1, 6, 6, 1, 20);
        float start = marks.Burn.Levels[0];
        // Dithering only happens above a hair over zero, so it must not be exactly zero (that would be solid).
        Assert.True(start > 0.001 && start < 0.02);
        marks.Update(10);
        float half = marks.Burn.Levels[0];
        Assert.True(half > start);
        marks.Update(11);
        float done = marks.Burn.Levels[0];
        Assert.True(done > half && done > 0.5);
        // It stops at the target.
        marks.Update(30);
        Assert.Equal(done, marks.Burn.Levels[0]);
    }

    [Fact]
    public void BurnMarksGrowFromAPartOfTheirSize()
    {
        ImpactMarks marks = NewMarks();
        marks.AddBurn(At, Up, 0, 1, 8, 8, 1, 20);
        Assert.True(WidthOf(marks.Burn, 0) < 8 * 0.7);
        marks.Update(25);
        Assert.Equal(8, WidthOf(marks.Burn, 0), 3);
    }

    [Fact]
    public void BurnMarksEndUpDarkerForAStrongerStrength()
    {
        float Target(double strength)
        {
            ImpactMarks marks = NewMarks();
            marks.AddBurn(At, Up, 0, 1, 4, 4, strength, 5);
            marks.Update(10);
            return marks.Burn.Levels[0];
        }
        Assert.True(Target(1) > Target(0.1));
    }

    [Fact]
    public void BurnMarksNeverPushOutTheImpactScars()
    {
        ImpactMarks marks = NewMarks();
        marks.Add(At, Up, 0, 1, 10, 6, 0.8);
        float scar = marks.Impact.Levels[0];
        for (int i = 0; i < 2000; i++)
        {
            marks.AddBurn(At, Up, 0, 1, 3, 3, 0.8, 10);
        }
        Assert.Equal(1, marks.Impact.Count);
        Assert.Equal(scar, marks.Impact.Levels[0]);
        // The burn marks are capped; the oldest are overwritten.
        Assert.True(marks.Burn.Count <= 600);
    }

    [Fact]
    public void BurnMarksAreClearedTogetherWithTheRest()
    {
        ImpactMarks marks = NewMarks();
        marks.Add(At, Up, 0, 1, 5, 5, 0.5);
        marks.AddBurn(At, Up, 0, 1, 5, 5, 0.5, 10);
        marks.Clear();
        Assert.Equal(0, marks.Impact.Count + marks.Burn.Count);
        Assert.False(marks.AnyMarks);
    }

    private static readonly Vec3d OnDeck = new(10, 0, 20);
    private static readonly Vec3d Beside = new(200, 0, 20);

    /// <summary>The deck is the strip x &lt; 50, steaming at 20 m/s towards -Z.</summary>
    private static ScriptedSurface Deck() => new() { Velocity = new Vec3d(0, 0, -20), Test = (x, _, _) => x < 50 };

    [Fact]
    public void DeckMarksGoAlongWithTheShip()
    {
        ImpactMarks marks = NewMarks();
        marks.SetMovingSurface(Deck());
        marks.Add(OnDeck, Up, 0, 1, 10, 6, 0.8);
        Vec3d start = PositionOf(marks.Impact, 0);
        marks.Update(3);
        Vec3d now = PositionOf(marks.Impact, 0);
        Assert.Equal(60, start.Z - now.Z, 3);
        Assert.Equal(start.X, now.X, 5);
    }

    [Fact]
    public void MarksBesideTheDeckStayWhereTheyAre()
    {
        ImpactMarks marks = NewMarks();
        marks.SetMovingSurface(Deck());
        marks.Add(Beside, Up, 0, 1, 10, 6, 0.8);
        Vec3d start = PositionOf(marks.Impact, 0);
        marks.Update(3);
        Assert.True(Vec3d.Distance(PositionOf(marks.Impact, 0), start) < 1e-6);
    }

    [Fact]
    public void MarksStayPutWithNoMovingSurface()
    {
        ImpactMarks marks = NewMarks();
        marks.Add(OnDeck, Up, 0, 1, 10, 6, 0.8);
        Vec3d start = PositionOf(marks.Impact, 0);
        marks.Update(3);
        Assert.True(Vec3d.Distance(PositionOf(marks.Impact, 0), start) < 1e-6);
    }

    [Fact]
    public void DeckBurnMarksGoAlongWhileTheyDarkenAndGrow()
    {
        ImpactMarks marks = NewMarks();
        marks.SetMovingSurface(Deck());
        marks.AddBurn(OnDeck, Up, 0, 1, 8, 8, 1, 10);
        double startZ = PositionOf(marks.Burn, 0).Z;
        float startLevel = marks.Burn.Levels[0];
        double startWidth = WidthOf(marks.Burn, 0);
        marks.Update(5);
        Assert.Equal(100, startZ - PositionOf(marks.Burn, 0).Z, 3);
        Assert.True(marks.Burn.Levels[0] > startLevel);
        Assert.True(WidthOf(marks.Burn, 0) > startWidth);
    }

    [Fact]
    public void AMarkOverwrittenByOneOnLandNoLongerMoves()
    {
        ImpactMarks marks = NewMarks();
        marks.SetMovingSurface(Deck());
        // Fill the whole impact pool with deck marks, then overwrite them all with ones beside it.
        for (int i = 0; i < 400; i++) marks.Add(OnDeck, Up, 0, 1, 4, 4, 0.5);
        for (int i = 0; i < 400; i++) marks.Add(Beside, Up, 0, 1, 4, 4, 0.5);
        Vec3d before = PositionOf(marks.Impact, 0);
        marks.Update(2);
        Assert.True(Vec3d.Distance(PositionOf(marks.Impact, 0), before) < 1e-6);
    }
}
