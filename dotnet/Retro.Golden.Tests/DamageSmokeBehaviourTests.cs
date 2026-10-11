#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Xunit;

namespace Retro.Golden.Tests;

/// <summary>
/// Port of src/script/scene/entities/damageSmokeField.test.ts: the lake of
/// fire made of falling fuel, burning down, the carrier deck, the sea, foam,
/// and contact puffs. The TS tests draw Math.random; these use a seeded
/// mulberry32 per field.
/// </summary>
public class DamageSmokeBehaviourTests
{
    private const double Ground = 4;
    private static readonly Vec3d Impact = new Vec3d(100, Ground, -50);
    private static readonly Vec3d Velocity = new Vec3d(0, -60, 120);
    private static readonly Vec3d Still = new Vec3d(0, 0, 0);

    /// <summary>Per test (xUnit makes a fresh instance for each), so the draws do not depend on test order.</summary>
    private uint seed = 0x50EA;

    private DamageSmokeField NewField(double ground = Ground)
    {
        var field = new DamageSmokeField(Gun.Mulberry32(seed++));
        field.SetGroundHeightAt((_, _) => ground);
        return field;
    }

    private readonly record struct Puff(Vec3d Position, byte Flag);

    private static List<Puff> Live(DamageSmokeField field)
    {
        var list = new List<Puff>();
        CpuParticle[] ps = field.System.Particles;
        for (int i = 0; i < ps.Length; i++)
        {
            if (ps[i].IsActive) list.Add(new Puff(ps[i].Position, field.SlotKinds[i]));
        }
        return list;
    }

    private static List<DamageSmokeField.PoolPoint> Trail(DamageSmokeField f, int pool = 0) => f.Pools[pool].Trail;

    private static int DropsInFlight(DamageSmokeField f) => f.FuelDrops.Count(d => d.Active);

    private static void Run(DamageSmokeField field, double seconds, Action? step = null)
    {
        for (int i = 0; i < seconds * 30; i++)
        {
            step?.Invoke();
            field.Update(1.0 / 30);
        }
    }

    private static double Spread(IEnumerable<double> a) => a.Max() - a.Min();

    /// <summary>A burning fuselage sliding along +Z from the impact, braking to rest after slideSeconds, 1.5 m up, shedding fuel.</summary>
    private sealed class Fuselage
    {
        private double t;
        public double Distance;
        private readonly double speed, slideSeconds;

        public Fuselage(DamageSmokeField field, double speed, double slideSeconds, double drips = 9)
        {
            this.speed = speed;
            this.slideSeconds = slideSeconds;
            field.AddAnchoredFire("p", (out Vec3d at) =>
            {
                at = new Vec3d(Impact.X, Ground + 1.5, Impact.Z + Distance);
                return true;
            }, 30, 200, false, drips: drips);
        }

        public void Step()
        {
            double dt = 1.0 / 30;
            t += dt;
            if (t < slideSeconds) Distance += speed * (1 - t / slideSeconds) * dt;
        }
    }

    private static SmokeAnchor Fixed(Vec3d p) => (out Vec3d at) => { at = p; return true; };

    // ------------------------------------------------------------ lake of fire made of falling fuel

    [Fact]
    public void BurnsNothingUntilFuelHasLanded()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1);
        Assert.Empty(Trail(field));
        Assert.True(DropsInFlight(field) > 20);
        Assert.Empty(Live(field));
        Run(field, 4);
        Assert.True(Trail(field).Count > 2);
        Assert.True(Live(field).Count > 50);
    }

    [Fact]
    public void IsSprayedAheadOfTheImpactOntoTheGround()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1);
        Run(field, 5);
        var trail = Trail(field);
        Assert.True(trail.Count > 3);
        var zs = trail.Select(p => p.Position.Z).ToList();
        Assert.True(zs.Min() > Impact.Z - 12);
        Assert.True(zs.Max() - Impact.Z > 15);
        foreach (var p in trail) Assert.Equal(Ground, p.Position.Y, 5);
    }

    [Fact]
    public void SpreadsAlongThePathOfTheSlidingFuselage()
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, 0.3);
        var fuselage = new Fuselage(field, 60, 5);
        Run(field, 10, fuselage.Step);
        double slid = fuselage.Distance;
        Assert.True(slid > 80);
        var trail = Trail(field);
        Assert.True(trail.Max(p => p.Position.Z - Impact.Z) > slid * 0.8);
        Assert.True(trail.Count > slid / 12);
        var flames = Live(field).Where(p => p.Flag == 0 || p.Flag == 3).ToList();
        double fz = Spread(flames.Select(p => p.Position.Z)), fx = Spread(flames.Select(p => p.Position.X));
        Assert.True(fz > slid * 0.6);
        Assert.True(fx > field.Pools[0].Radius);
        Assert.True(fz > fx);
    }

    [Fact]
    public void StopsSpreadingWhenTheFuselageStops()
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, 0.3);
        var fuselage = new Fuselage(field, 60, 4);
        Run(field, 8, fuselage.Step);
        int atRest = Trail(field).Count;
        Run(field, 30, fuselage.Step);
        Assert.True(Trail(field).Count <= atRest + 1);
    }

    [Fact]
    public void RunsOutOfWreckageLyingOnTheGround()
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, 0.3);
        field.AddAnchoredFire("p", Fixed(new Vec3d(Impact.X + 30, Ground + 1.5, Impact.Z)), 20, 100, true, drips: 6);
        Run(field, 6);
        Assert.Contains(Trail(field), p => JsMath.Hypot(p.Position.X - (Impact.X + 30), p.Position.Z - Impact.Z) < 3);
    }

    [Fact]
    public void ShedsNothingFromAFireWithNoDrips()
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, 0.3);
        field.AddAnchoredFire("p", Fixed(new Vec3d(Impact.X + 40, Ground + 3, Impact.Z)), 20, 100, true, drips: 0);
        Run(field, 6);
        Assert.DoesNotContain(Trail(field), p => Math.Abs(p.Position.X - (Impact.X + 40)) < 6);
    }

    [Fact]
    public void CarriesTheMotionOfThePieceItRunsOutOf()
    {
        double Reach(double speed)
        {
            var field = NewField();
            field.AddFirePool(Impact, Still, 0.3);
            double t = 0;
            field.AddAnchoredFire("p", (out Vec3d at) =>
            {
                at = new Vec3d(Impact.X + speed * t, Ground + 6, Impact.Z);
                t += 1.0 / 30;
                return true;
            }, 20, 100, false, drips: 10);
            Run(field, 4);
            return Trail(field).Max(p => p.Position.X - Impact.X);
        }
        Assert.True(Reach(30) > Reach(0) + 25);
    }

    [Fact]
    public void DrawsFallingFuelAsStreaksOfFlame()
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, 0.3);
        field.AddAnchoredFire("p", Fixed(new Vec3d(Impact.X + 50, Ground + 9, Impact.Z)), 0, 100, true, drips: 10);
        Run(field, 1);
        int falling = Live(field).Count(p =>
            Math.Abs(p.Position.X - (Impact.X + 50)) < 4 && p.Position.Y > Ground + 1 && p.Position.Y < Ground + 9);
        Assert.True(falling > 3);
    }

    // ------------------------------------------------------------ fallen fuel spreads out over the ground

    private static readonly Vec3d Spot = new Vec3d(Impact.X + 40, Ground, Impact.Z);

    private static DamageSmokeField.PoolPoint? PuddleAt(DamageSmokeField f) =>
        Trail(f).FirstOrDefault(p => JsMath.Hypot(p.Position.X - Spot.X, p.Position.Z - Spot.Z) < 4);

    private DamageSmokeField FieldWithDrip(double drips, double severity = 0.3)
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, severity);
        field.AddAnchoredFire("p", Fixed(new Vec3d(Spot.X, Ground + 1.5, Spot.Z)), 0, 200, true, drips: drips);
        return field;
    }

    private static double FlameReach(DamageSmokeField f)
    {
        var flames = Live(f).Where(p => (p.Flag == 0 || p.Flag == 3) && p.Position.X > Impact.X + 25).ToList();
        return flames.Count == 0 ? 0 : flames.Max(p => JsMath.Hypot(p.Position.X - Spot.X, p.Position.Z - Spot.Z));
    }

    [Fact]
    public void PuddleStartsAsASmallSplashAndCreepsOut()
    {
        var field = FieldWithDrip(8);
        Run(field, 1.2);
        var early = PuddleAt(field);
        Assert.NotNull(early);
        double radiusEarly = early!.RadiusNow;
        Assert.True(radiusEarly < 3.5);
        double reachEarly = FlameReach(field);
        Run(field, 12);
        Assert.True(PuddleAt(field)!.RadiusNow > radiusEarly * 2);
        Assert.True(PuddleAt(field)!.RadiusNow > 6);
        Assert.True(FlameReach(field) > Math.Max(6, reachEarly * 1.5));
    }

    [Fact]
    public void PuddleSpreadsFurtherWhereMoreFuelFell()
    {
        double Radius(double drips)
        {
            var field = FieldWithDrip(drips, 1.5);
            Run(field, 6);
            return PuddleAt(field)!.RadiusNow;
        }
        Assert.True(Radius(12) > Radius(1) + 3);
    }

    [Fact]
    public void PuddleNeverSpreadsPastTheLakeRadius()
    {
        var field = FieldWithDrip(30);
        Run(field, 40);
        foreach (var p in Trail(field)) Assert.True(p.RadiusNow <= field.Pools[0].Radius + 1e-6);
    }

    [Fact]
    public void CharsTheGroundInNewPatchesAsTheEdgeMovesOut()
    {
        var field = FieldWithDrip(8);
        var reach = new List<(double T, double D)>();
        double now = 0;
        field.OnPoolMark = (p, _, _, _, _, isChar) =>
        {
            if (isChar && p.X > Impact.X + 25) reach.Add((now, JsMath.Hypot(p.X - Spot.X, p.Z - Spot.Z)));
        };
        for (int i = 0; i < 30 * 12; i++)
        {
            now += 1.0 / 30;
            field.Update(1.0 / 30);
        }
        Assert.True(reach.Count > 3);
        Assert.True(reach.Max(r => r.T) - reach.Min(r => r.T) > 2);
        var early = reach.Where(r => r.T < 2).Select(r => r.D).ToList();
        var late = reach.Where(r => r.T >= 4).Select(r => r.D).ToList();
        double Mean(List<double> a) => a.Sum() / Math.Max(1, a.Count);
        Assert.NotEmpty(late);
        Assert.True(Mean(late) > Mean(early) + 1);
    }

    // ------------------------------------------------------------ burns like every other fire

    private static double FlameFraction(DamageSmokeField f)
    {
        var low = Live(f).Where(p => p.Position.Y < Ground + 3).ToList();
        return low.Count == 0 ? double.NaN : (double)low.Count(p => p.Flag == 0) / low.Count;
    }

    [Fact]
    public void AFreshLakeIsNearlyAllFlameADyingOneMostlySmoke()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1);
        Run(field, 4);
        double fresh = FlameFraction(field);
        Run(field, 146);
        double dying = FlameFraction(field);
        Assert.True(fresh > 0.8, $"fresh {fresh}");
        Assert.True(dying < 0.25, $"dying {dying}");
    }

    [Fact]
    public void FuelShedByANearlyBurntOutFireIsMostlySmoke()
    {
        double DropFlame(double runSeconds)
        {
            var field = NewField();
            field.AddFirePool(Impact, Still, 0.3);
            field.AddAnchoredFire("p", Fixed(new Vec3d(Impact.X + 60, Ground + 14, Impact.Z)), 0, 12, true, drips: 12);
            Run(field, runSeconds);
            var drops = field.FuelDrops.Where(d => d.Active).ToList();
            return drops.Sum(d => d.Flame) / Math.Max(1, drops.Count);
        }
        Assert.True(DropFlame(1.0) > 0.9);
        Assert.True(DropFlame(11.5) < 0.1);
    }

    // ------------------------------------------------------------ on a moving carrier deck

    private sealed class Surface : IMovingSurface
    {
        public Vec3d Velocity { get; set; } = new Vec3d(0, 0, -20);
        public Func<double, double, double, bool> Test = (_, y, _) => y > Ground - 3 && y < Ground + 5;
        public bool Contains(double x, double y, double z) => Test(x, y, z);
    }

    [Fact]
    public void MovesTheLakeWithTheShip()
    {
        var field = NewField();
        field.SetMovingSurface(new Surface());
        field.AddFirePool(Impact, Still, 0.3);
        Run(field, 5);
        Vec3d first = Trail(field)[0].Position;
        Vec3d originAt5 = field.Pools[0].Origin;
        Run(field, 10);
        Assert.Equal(200, first.Z - Trail(field)[0].Position.Z, 0);
        Assert.Equal(200, originAt5.Z - field.Pools[0].Origin.Z, 0);
        Assert.Equal(first.X, Trail(field)[0].Position.X, 5);
    }

    [Fact]
    public void LeavesALakeOnOrdinaryGroundWhereItIs()
    {
        var field = NewField();
        field.AddFirePool(Impact, Still, 0.3);
        Run(field, 5);
        Vec3d first = Trail(field)[0].Position;
        Run(field, 10);
        Assert.True(Vec3d.Distance(Trail(field)[0].Position, first) < 1e-6);
    }

    [Fact]
    public void OnlyCarriesWhatWasLaidOnTheDeck()
    {
        var field = NewField();
        field.SetMovingSurface(new Surface { Test = (x, y, _) => x < 110 && y < Ground + 5 });
        field.AddFirePool(new Vec3d(100, Ground, -50), Still, 0.3);
        field.AddFirePool(new Vec3d(300, Ground, -50), Still, 0.3);
        Run(field, 5);
        double beforeBeside = field.Pools[1].Origin.Z;
        double beforeDeck = field.Pools[0].Origin.Z;
        Run(field, 5);
        Assert.Equal(100, beforeDeck - field.Pools[0].Origin.Z, 0);
        Assert.Equal(beforeBeside, field.Pools[1].Origin.Z);
    }

    [Fact]
    public void CarriesBurningScratchesWithTheShip()
    {
        var field = NewField();
        field.SetMovingSurface(new Surface());
        var marks = new List<double>();
        field.OnBurnMark = (p, _, _, _) => marks.Add(p.Z);
        field.AddBurnSpot(new Vec3d(100, Ground, 0), 30, 1);
        Run(field, 12);
        Assert.NotEmpty(marks);
        Assert.True(marks.Min() < -100);
    }

    [Fact]
    public void FallsFromWreckageRidingTheDeckWithTheDecksSpeed()
    {
        var field = NewField();
        field.SetMovingSurface(new Surface());
        field.AddFirePool(Impact, Still, 0.3);
        double t = 0;
        field.AddAnchoredFire("p", (out Vec3d at) =>
        {
            at = new Vec3d(Impact.X + 30, Ground + 6, Impact.Z - 20 * t);
            t += 1.0 / 30;
            return true;
        }, 0, 100, false, drips: 12);
        Run(field, 5);
        var near = Trail(field).Where(p => p.Position.X > Impact.X + 20).ToList();
        Assert.NotEmpty(near);
        Assert.True(near.Min(p => p.Position.Z) < Impact.Z - 20 * 3);
    }

    // ------------------------------------------------------------ on the sea

    private DamageSmokeField Sea()
    {
        var field = NewField();
        field.SetWaterTest((_, _) => true);
        return field;
    }

    private static List<Puff> Flagged(DamageSmokeField f, byte flag) => Live(f).Where(p => p.Flag == flag).ToList();

    [Fact]
    public void ASplashThrowsUpSprayAndSpreadsAMist()
    {
        var field = Sea();
        field.SpawnSplash(new Vec3d(100, Ground, 0), 1);
        Run(field, 0.3);
        Assert.True(Flagged(field, DamageSmokeField.KindSpray).Count > 10);
        Assert.True(Flagged(field, DamageSmokeField.KindMist).Count > 5);
        Assert.True(Flagged(field, DamageSmokeField.KindSpray).Max(p => p.Position.Y) > Ground + 2);
    }

    [Fact]
    public void TheSprayIsGoneInACoupleOfSecondsTheMistLingers()
    {
        var field = Sea();
        field.SpawnSplash(new Vec3d(100, Ground, 0), 1);
        Run(field, 2.6);
        Assert.Empty(Flagged(field, DamageSmokeField.KindSpray));
        Assert.NotEmpty(Flagged(field, DamageSmokeField.KindMist));
        Run(field, 4);
        Assert.Empty(Live(field));
    }

    [Fact]
    public void TheMistSpreadsWiderThanTheSpray()
    {
        var field = Sea();
        field.SpawnSplash(new Vec3d(100, Ground, 0), 1);
        Run(field, 1.2);
        double reach = Flagged(field, DamageSmokeField.KindMist).Max(p => JsMath.Hypot(p.Position.X - 100, p.Position.Z));
        Assert.True(reach > 4);
        Assert.True(Flagged(field, DamageSmokeField.KindMist).Max(p => p.Position.Y)
            < Flagged(field, DamageSmokeField.KindSpray).Max(p => p.Position.Y));
    }

    private static readonly Vec3d FoamAt = new Vec3d(100, Ground, 0);

    [Fact]
    public void FoamIsLaidAsFlatPuffsOnTheSurface()
    {
        var field = Sea();
        field.SpawnFoam(FoamAt, 4, 30);
        var foam = Flagged(field, DamageSmokeField.KindFoam);
        Assert.Equal(30, foam.Count);
        foreach (var p in foam)
        {
            Assert.True(JsMath.Hypot(p.Position.X - FoamAt.X, p.Position.Z - FoamAt.Z) < 4 * 0.9 + 0.6 + 0.01);
            Assert.True(p.Position.Y > Ground);
            Assert.True(p.Position.Y < Ground + 0.5);
        }
    }

    [Fact]
    public void FoamStaysOnTheSurfaceAndIsGoneInAFewSeconds()
    {
        var field = Sea();
        field.SpawnFoam(FoamAt, 3, 20);
        Run(field, 1.5);
        foreach (var p in Flagged(field, DamageSmokeField.KindFoam)) Assert.True(p.Position.Y < Ground + 0.5);
        Run(field, 3.5);
        Assert.Empty(Flagged(field, DamageSmokeField.KindFoam));
    }

    [Fact]
    public void MoreFoamForMorePuffs()
    {
        int Count(int n)
        {
            var field = Sea();
            field.SpawnFoam(FoamAt, 3, n);
            return Flagged(field, DamageSmokeField.KindFoam).Count;
        }
        Assert.True(Count(40) > Count(5));
    }

    [Fact]
    public void FoamIsDrawnLaidFlat()
    {
        var field = Sea();
        field.SpawnFoam(FoamAt, 3, 12);
        field.SyncPuffs(new Vec3d(500, Ground + 3, 300), Palettes.HdNoon);
        Assert.Equal(12, field.InstanceCount);
        Vec3d normal = new Vec3d(0, 0, 1).Rotate(field.InstanceRotations[0]);
        Assert.True(Math.Abs(normal.Y) > 0.99);
        // The float32 matrix says the same: its third column is the (scaled) normal.
        double size = field.InstanceSizes[0];
        Assert.True(Math.Abs(field.InstanceMatrices[9] / size) > 0.99);
    }

    [Fact]
    public void OtherPuffsFaceTheCamera()
    {
        var field = NewField();
        field.SpawnContactPuffs(Impact, SmokeSurfaceKind.Dirt, 3, 1);
        var camera = new Vec3d(400, 50, 300);
        field.SyncPuffs(camera, Palettes.HdNoon);
        for (int i = 0; i < field.InstanceCount; i++)
        {
            Vec3d normal = new Vec3d(0, 0, 1).Rotate(field.InstanceRotations[i]);
            Vec3d toCamera = (camera - field.InstancePositions[i]).Normalized();
            Assert.True(Vec3d.Dot(normal, toCamera) > 0.999999);
        }
    }

    [Fact]
    public void AHarderSplashIsBigger()
    {
        int Count(double strength)
        {
            var field = Sea();
            field.SpawnSplash(new Vec3d(100, Ground, 0), strength);
            Run(field, 0.2);
            return Live(field).Count;
        }
        Assert.True(Count(1.5) > Count(0.2));
    }

    [Fact]
    public void FuelFallingOnTheSeaSplashesAndIsGone()
    {
        var field = Sea();
        int burnMarks = 0;
        field.OnBurnMark = (_, _, _, _) => burnMarks++;
        field.AddFirePool(Impact, Velocity, 1);
        int spray = 0;
        for (int i = 0; i < 30 * 6; i++)
        {
            field.Update(1.0 / 30);
            spray = Math.Max(spray, Flagged(field, DamageSmokeField.KindSpray).Count);
        }
        Assert.Empty(Trail(field));
        Assert.Equal(0, burnMarks);
        Assert.DoesNotContain(Live(field), p => p.Flag == 0 || p.Flag == 3);
        Assert.True(spray > 0);
    }

    [Fact]
    public void FuelShedByWreckageOverTheSeaSplashes()
    {
        var field = Sea();
        field.AddFirePool(Impact, Still, 0.3);
        field.AddAnchoredFire("p", Fixed(new Vec3d(Impact.X + 20, Ground + 3, Impact.Z)), 0, 100, true, drips: 10);
        int spray = 0;
        for (int i = 0; i < 30 * 4; i++)
        {
            field.Update(1.0 / 30);
            spray = Math.Max(spray, Flagged(field, DamageSmokeField.KindSpray).Count);
        }
        Assert.True(spray > 0);
        Assert.Empty(Trail(field));
    }

    [Fact]
    public void TheSameFuelOnLandDoesMakeALake()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1);
        Run(field, 6);
        Assert.NotEmpty(Trail(field));
    }

    // ------------------------------------------------------------ size, smoke, burn-out, marks, reset

    [Fact]
    public void IsBiggerAndFiercerForAHarderHit()
    {
        (double Radius, int Points) Measure(double severity)
        {
            var field = NewField();
            field.AddFirePool(Impact, Velocity, severity);
            Run(field, 6);
            return (field.Pools[0].Radius, Trail(field).Count);
        }
        var gentle = Measure(0.3);
        var hard = Measure(1.4);
        Assert.True(hard.Radius > gentle.Radius);
        Assert.True(hard.Points > gentle.Points);
    }

    [Fact]
    public void StandsBlackSmokeOverTheLakeWithoutExhaustingThePool()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1.5);
        var fuselage = new Fuselage(field, 80, 6);
        int peak = 0;
        bool sawTallBlack = false;
        for (int i = 0; i < 30 * 60; i++)
        {
            fuselage.Step();
            field.Update(1.0 / 30);
            if (i % 15 == 0)
            {
                var live = Live(field);
                peak = Math.Max(peak, live.Count);
                sawTallBlack = sawTallBlack || live.Any(p => p.Flag == 3 && p.Position.Y > Ground + 12);
            }
        }
        Assert.True(sawTallBlack);
        Assert.True(peak < DamageSmokeField.ParticleCount * 0.6, $"peak {peak}");
    }

    [Fact]
    public void BurnsOutInTheEndAndLeavesNothing()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1);
        Run(field, 230);
        Assert.Empty(Live(field));
    }

    [Fact]
    public void ScorchesTheGroundUnderEveryNewStretchOfLake()
    {
        var field = NewField();
        var chars = new List<double>();
        field.OnPoolMark = (p, _, _, _, _, isChar) => { if (isChar) chars.Add(p.Z); };
        field.AddFirePool(Impact, Still, 0.3);
        var fuselage = new Fuselage(field, 60, 5);
        Run(field, 8, fuselage.Step);
        Assert.True(chars.Count > 5);
        Assert.True(Spread(chars) > fuselage.Distance * 0.7);
    }

    [Fact]
    public void BlackensTheGroundUnderTheLakePatchByPatch()
    {
        var field = NewField();
        var marks = new List<(double Time, double Radius, double Strength, double Grow, double Z)>();
        double now = 0;
        field.OnBurnMark = (p, radius, strength, grow) => marks.Add((now, radius, strength, grow, p.Z));
        field.AddFirePool(Impact, Still, 0.3);
        var fuselage = new Fuselage(field, 60, 5);
        for (int i = 0; i < 30 * 60; i++)
        {
            now += 1.0 / 30;
            fuselage.Step();
            field.Update(1.0 / 30);
        }
        Assert.True(marks.Count > 100);
        Assert.True(marks.Count(m => m.Time > 20) > 30);
        foreach (var m in marks)
        {
            Assert.True(m.Radius > 0.5);
            Assert.True(m.Grow > 10);
            Assert.True(m.Strength > 0.5);
        }
        Assert.True(Spread(marks.Select(m => m.Z)) > fuselage.Distance * 0.6);
    }

    [Fact]
    public void BlackensTheGroundUnderAFireOnItButNotOneHighUp()
    {
        int BurnMarks(double height)
        {
            var field = NewField(0);
            int n = 0;
            field.OnBurnMark = (_, _, _, _) => n++;
            field.AddAnchoredFire("p", Fixed(new Vec3d(0, height, 0)), 20, 100, false);
            Run(field, 20);
            return n;
        }
        Assert.True(BurnMarks(1.5) > 5);
        Assert.Equal(0, BurnMarks(60));
    }

    [Fact]
    public void IsClearedByResetDropsInFlightIncluded()
    {
        var field = NewField();
        field.AddFirePool(Impact, Velocity, 1);
        Run(field, 3);
        Assert.NotEmpty(Live(field));
        field.Reset();
        Assert.Equal(0, DropsInFlight(field));
        Run(field, 3);
        Assert.Empty(Live(field));
        Assert.Empty(Trail(field));
    }

    // ------------------------------------------------------------ contact puffs

    private List<byte> FlagsAfter(SmokeSurfaceKind surface)
    {
        var field = NewField();
        field.SpawnContactPuffs(Impact, surface, 4, 0.5);
        return Live(field).Select(p => p.Flag).ToList();
    }

    [Fact]
    public void ContactPuffsAreColouredForTheSurface()
    {
        var dirt = FlagsAfter(SmokeSurfaceKind.Dirt);
        var water = FlagsAfter(SmokeSurfaceKind.Water);
        var concrete = FlagsAfter(SmokeSurfaceKind.Concrete);
        Assert.Equal(4, dirt.Count);
        Assert.All(dirt, f => Assert.Equal(1, f));
        Assert.Equal(4, water.Count);
        Assert.All(water, f => Assert.Equal(4, f));
        Assert.Equal(4, concrete.Count);
        Assert.All(concrete, f => Assert.Equal(7, f));
    }

    [Fact]
    public void ContactPuffsAreSmallAndShortLived()
    {
        var field = NewField();
        field.SpawnContactPuffs(Impact, SmokeSurfaceKind.Dirt, 6, 0.5);
        Assert.Equal(6, Live(field).Count);
        Run(field, 3);
        Assert.Empty(Live(field));
    }

    [Fact]
    public void SlidingContactsPuffInTheColourOfTheSurface()
    {
        var field = NewField();
        field.SurfaceAt = (x, _) => x < 0 ? SmokeSurfaceKind.Water : x < 1000 ? SmokeSurfaceKind.Dirt : SmokeSurfaceKind.Concrete;
        SimHitEvent Scrape(double x) => new SimHitEvent
        {
            Position = new[] { x, Ground, 0 }, Velocity = new double[] { 0, 0, 60 }, TargetId = "p", Damage = 0, Source = "scrape", Slide = true,
        };
        field.SpawnGroundScrapes(new[] { Scrape(-10), Scrape(10), Scrape(2000) });
        var flags = Live(field).Select(p => p.Flag).ToHashSet();
        Assert.Contains((byte)4, flags);
        Assert.Contains((byte)1, flags);
        Assert.Contains((byte)7, flags);
    }
}
