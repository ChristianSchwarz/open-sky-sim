using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;
using Retro.Game;
using Xunit;
using static Retro.Golden.Tests.WreckTestKit;

namespace Retro.Golden.Tests;

/// <summary>
/// Port of src/script/scene/entities/airframeDamage.test.ts: damage to an
/// aircraft that survives a hard impact (WreckField.ApplyDamage + AirframeDamage),
/// on one seeded random stream per test.
/// </summary>
public class AirframeDamageTests
{
    private const string FuselageMat = "fuselage";
    private const string WingMat = "wing";
    private const string AileronMat = "aileron";
    private const string GearMat = "gear";

    private static readonly Vec3d Position = new Vec3d(100, 5, 40);
    private static readonly Vec3d Hit = Position + new Vec3d(0, -1.2, 0);

    /// <summary>A fuselage (z -7..7, front +Z) with a 14 m wing across it.</summary>
    private static WreckModel Jet() => new WreckModel
    {
        MaxSize = 14,
        Meshes = { Mesh(Box(2, 2, 14, 3, 3, 28), FuselageMat), Mesh(Translate(Box(14, 0.3, 3, 14, 1, 3), 0, 0, 0.5), WingMat) },
    };

    private static WreckModel SmallPart(string mat, double x, double y, double z) => new WreckModel
    {
        MaxSize = x,
        Meshes = { Mesh(Box(x, y, z, 2, 1, 2), mat) },
    };

    private static List<WreckPart> Parts() => new List<WreckPart>
    {
        // gear = 0, surface i = 1 + i: two ailerons far out on the wing and an elevator at the tail
        new WreckPart { Model = SmallPart(GearMat, 0.5, 1.5, 0.5), Kind = WreckPartKind.Gear, Id = 0, Position = Position + new Vec3d(0, -1, 1), Quaternion = Quatd.Identity },
        new WreckPart { Model = SmallPart(AileronMat, 3, 0.2, 1), Kind = WreckPartKind.Surface, Id = 1, Position = Position + new Vec3d(5, 0, -1), Quaternion = Quatd.Identity },
        new WreckPart { Model = SmallPart(AileronMat, 3, 0.2, 1), Kind = WreckPartKind.Surface, Id = 2, Position = Position + new Vec3d(-5, 0, -1), Quaternion = Quatd.Identity },
        new WreckPart { Model = SmallPart(AileronMat, 3, 0.2, 1), Kind = WreckPartKind.Surface, Id = 3, Position = Position + new Vec3d(0, 0.8, -6), Quaternion = Quatd.Identity },
    };

    private static WreckSource Src(Vec3d? velocity = null, Quatd? quaternion = null) => new WreckSource
    {
        Id = "t",
        Body = Jet(),
        Position = Position,
        Quaternion = quaternion ?? Quatd.Identity,
        Scale = new Vec3d(1, 1, 1),
        Velocity = velocity ?? new Vec3d(0, -20, 40),
        Parts = Parts(),
        Cockpit = new Vec3d(0, 0.8, 5.5),
    };

    private static WreckField Field(Func<double> rng)
    {
        var f = new WreckField(rng);
        f.SetGroundHeightAt((x, z) => Position.Y - 1.2);
        return f;
    }

    private static int CountVerts(IEnumerable<WreckMeshData> meshes, string mat = null) =>
        meshes.Where(m => mat == null || (string)m.Material == mat).Sum(m => m.VertexCount);

    private static WreckBox3 BoxOf(IEnumerable<WreckMeshData> meshes)
    {
        var box = new WreckBox3();
        foreach (WreckMeshData m in meshes)
        {
            for (int i = 0; i + 2 < m.Position.Length; i += 3) box.ExpandByPoint(m.Position[i], m.Position[i + 1], m.Position[i + 2]);
        }
        return box;
    }

    [Fact]
    public void BendsTheFuselageAndDrawsTheDamagedAirframeInTheBodyFrame()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        Assert.False(state.Active);
        Assert.True(f.ApplyDamage(Src(new Vec3d(15, -20, 40)), state, 0.6, Hit));
        Assert.True(state.Active);
        Assert.True(Math.Abs(state.Severity - 0.6) < 1e-6);
        Assert.True(Math.Abs(f.LastDislocationM) > 0.2);
        Assert.True(BoxOf(state.Root).Center.Length < 8);
        Assert.True(CountVerts(state.Root, FuselageMat) > 100);
    }

    [Fact]
    public void TearsOffWingSectionsAndControlSurfacesOnAHardEnoughBlowAsPiecesThatFlyOff()
    {
        Func<double> rng = WreckFieldTests.Rng();
        bool sawWing = false, sawSurface = false;
        for (int run = 0; run < 40 && !(sawWing && sawSurface); run++)
        {
            WreckField f = Field(rng);
            var state = new AirframeDamage();
            f.ApplyDamage(Src(), state, 0.9, Hit);
            sawWing = sawWing || state.RippedCells.Count > 0;
            sawSurface = sawSurface || state.RippedParts.Count > 0;
            if (state.RippedCells.Count > 0 || state.RippedParts.Count > 0)
            {
                Assert.NotEmpty(f.Fragments);
            }
            Assert.All(state.RippedCells, cell => Assert.True(cell >= 3));
        }
        Assert.True(sawWing);
        Assert.True(sawSurface);
    }

    [Fact]
    public void DoesNothingForABlowNoHarderThanOneItHasAlreadyHad()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.6, Hit);
        List<WreckMeshData> root = state.Root;
        int pieces = f.Fragments.Count;
        Assert.False(f.ApplyDamage(Src(), state, 0.5, Hit));
        Assert.False(f.ApplyDamage(Src(), state, 0.605, Hit));
        Assert.Same(root, state.Root);
        Assert.Equal(pieces, f.Fragments.Count);
    }

    [Fact]
    public void StartsFuelFiresAsSoonAsTheFuselageIsBentAndWhereWingsAreBentOrTornOncePerSite()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var events = new List<WreckDamageEvent>();
        f.OnDamage = e => events.Add(e);
        var state = new AirframeDamage();
        f.ApplyDamage(Src(new Vec3d(15, -40, 60)), state, 0.8, Hit);
        Assert.Single(events);
        Assert.Contains(events[0].Fires, x => x.Kind == WreckFireKind.Fuselage);
        Assert.Contains(events[0].Fires, x => x.Kind == WreckFireKind.WingRoot);
        int sites = state.FireSites.Count;
        f.Update(2);
        f.ApplyDamage(Src(new Vec3d(15, -40, 60)), state, 0.8, Hit);
        int again = events.Skip(1).Sum(e => e.Fires.Count);
        Assert.True(state.FireSites.Count >= sites);
        Assert.Equal(state.FireSites.Count - sites, again);
    }

    [Fact]
    public void StartsNoFireForABlowTooGentleToBendAnything()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        int fired = 0;
        f.OnDamage = e => fired++;
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.2, Hit);
        Assert.Equal(0, f.LastDislocationM);
        if (state.RippedCells.Count == 0)
        {
            Assert.Equal(0, fired);
        }
    }

    [Fact]
    public void AddsUpLaterSeparateImpactsOfTheSameSizeDoMoreThanTheFirst()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.5, Hit);
        Assert.True(Math.Abs(state.Severity - 0.5) < 1e-5);
        f.Update(1);
        Assert.True(f.ApplyDamage(Src(), state, 0.5, Hit));
        Assert.True(state.Severity > 0.65);
        f.Update(1);
        f.ApplyDamage(Src(), state, 0.5, Hit);
        Assert.True(state.Severity > 0.8);
    }

    [Fact]
    public void BendsFurtherWithEachImpactInTheDirectionOfThatImpact()
    {
        double YawSum(AirframeDamage st) => st.Joints[1].Yaw + st.Joints[2].Yaw;
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(new Vec3d(25, -30, 40)), state, 0.6, Hit);
        double afterOne = YawSum(state);
        Assert.True(Math.Abs(afterOne) > 0.05);
        f.Update(1);
        f.ApplyDamage(Src(new Vec3d(25, -30, 40)), state, 0.6, Hit);
        double afterTwo = YawSum(state);
        Assert.True(Math.Abs(afterTwo) > Math.Abs(afterOne));
        f.Update(1);
        f.ApplyDamage(Src(new Vec3d(-25, -30, 40)), state, 0.6, Hit);
        double afterThree = YawSum(state);
        Assert.Equal(-Math.Sign(afterOne), Math.Sign(afterThree - afterTwo));
        Assert.True(f.LastTotalBendRad > 0);
    }

    [Fact]
    public void FoldsAWingFurtherWithEachImpactAndTheOtherWayToo()
    {
        Func<double> rng = WreckFieldTests.Rng();
        int further = 0, back = 0;
        for (int run = 0; run < 40; run++)
        {
            WreckField f = Field(rng);
            var state = new AirframeDamage();
            f.ApplyDamage(Src(new Vec3d(5, -12, 30)), state, 0.3, Hit);
            var first = state.WingFold.ToList();
            f.Update(1);
            f.ApplyDamage(Src(new Vec3d(5, -12, 30)), state, 0.3, Hit);
            foreach (KeyValuePair<int, double> kv in first)
            {
                double now = state.WingFold.TryGetValue(kv.Key, out double n) ? n : 0;
                if (kv.Value != 0 && Math.Abs(now) > Math.Abs(kv.Value) + 1e-9) further++;
                if (kv.Value != 0 && Math.Sign(now - kv.Value) == -Math.Sign(kv.Value)) back++;
            }
        }
        Assert.True(further > 0);
        Assert.True(back > 0);
    }

    [Fact]
    public void FoldsAWingAtMost20DegreesThenItBreaksOff()
    {
        Func<double> rng = WreckFieldTests.Rng();
        double max = 20 * Math.PI / 180;
        bool sawBreak = false;
        for (int run = 0; run < 30; run++)
        {
            WreckField f = Field(rng);
            var state = new AirframeDamage();
            for (int k = 0; k < 8; k++)
            {
                f.ApplyDamage(Src(new Vec3d(5, -12, 30)), state, 0.35, Hit);
                f.Update(1);
                Assert.All(state.WingFold.Values, v => Assert.True(Math.Abs(v) <= max + 1e-9));
            }
            sawBreak = sawBreak || state.RippedCells.Count > 0;
        }
        Assert.True(sawBreak);
    }

    [Fact]
    public void TreatsBlowsInQuickSuccessionAsOneImpact()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.5, Hit);
        f.Update(0.1);
        f.ApplyDamage(Src(), state, 0.5, Hit);
        f.Update(0.1);
        f.ApplyDamage(Src(), state, 0.55, Hit);
        Assert.True(Math.Abs(state.Severity - 0.55) < 1e-5);
    }

    [Fact]
    public void TearsMoreOffWithEveryImpact()
    {
        Func<double> rng = WreckFieldTests.Rng();
        int single = 0, repeated = 0;
        for (int run = 0; run < 60; run++)
        {
            WreckField a = Field(rng);
            var one = new AirframeDamage();
            a.ApplyDamage(Src(new Vec3d(0, -12, 30)), one, 0.35, Hit);
            single += one.RippedCells.Count + one.RippedParts.Count;
            WreckField b = Field(rng);
            var many = new AirframeDamage();
            for (int k = 0; k < 4; k++)
            {
                b.ApplyDamage(Src(new Vec3d(0, -12, 30)), many, 0.35, Hit);
                b.Update(1);
            }
            repeated += many.RippedCells.Count + many.RippedParts.Count;
        }
        Assert.True(repeated > single);
    }

    [Fact]
    public void GoesOnGettingWorseWithHarderBlowsAndNothingTornOffComesBack()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.45, Hit);
        double bendA = Math.Abs(f.LastDislocationM);
        var cellsA = state.RippedCells.ToList();
        var partsA = state.RippedParts.ToList();
        f.ApplyDamage(Src(), state, 0.95, Hit);
        Assert.True(Math.Abs(f.LastDislocationM) > bendA);
        Assert.All(cellsA, c => Assert.Contains(c, state.RippedCells));
        Assert.All(partsA, p => Assert.Contains(p, state.RippedParts));
        Assert.All(cellsA, c => Assert.True(c >= 3));
    }

    [Fact]
    public void LosesAndDoublesNothingWhatIsDrawnPlusWhatFlewOffIsTheAirframe()
    {
        Func<double> rng = WreckFieldTests.Rng();
        WreckModel jet = Jet();
        int original = jet.Meshes.Sum(m => m.Positions.Length / 3);
        for (int run = 0; run < 20; run++)
        {
            WreckField f = Field(rng);
            var state = new AirframeDamage();
            f.ApplyDamage(Src(), state, 1.0, Hit);
            int drawn = CountVerts(state.Root, FuselageMat) + CountVerts(state.Root, WingMat);
            int flown = f.Fragments.Sum(frag => CountVerts(frag.Meshes, FuselageMat) + CountVerts(frag.Meshes, WingMat));
            Assert.Equal(original, drawn + flown + 3 * f.LastScrapTriangles);
        }
    }

    [Fact]
    public void CarriesThePartsThatStayOnRigidlyWithTheBend()
    {
        Func<double> rng = WreckFieldTests.Rng();
        var state = new AirframeDamage();
        for (int tries = 0; tries < 40 && !state.PartBends.ContainsKey(3); tries++)
        {
            state = new AirframeDamage();
            Field(rng).ApplyDamage(Src(new Vec3d(30, -20, 40)), state, 0.5, Position + new Vec3d(0, -1.2, 5));
        }
        Assert.True(state.PartBends.TryGetValue(3, out PartBend bend));
        Quatd rot = bend.Q;
        Assert.True(WreckMath.AngleTo(rot, Quatd.Identity) > 0.02);
        var scale = new Vec3d(1, 1, 1);
        Vec3d origA = Position + new Vec3d(0.3, 0.8, -6.2);
        Vec3d a = origA;
        Vec3d b = Position + new Vec3d(-0.3, 0.8, -5.8);
        double before = Vec3d.Distance(a, b);
        Quatd qa = Quatd.Identity, qb = Quatd.Identity;
        state.TransformPart(3, ref a, ref qa, Position, Quatd.Identity, scale);
        state.TransformPart(3, ref b, ref qb, Position, Quatd.Identity, scale);
        Assert.True(Math.Abs(Vec3d.Distance(a, b) - before) < 1e-6);
        Assert.True(Vec3d.Distance(a, origA) > 0.05);
        Assert.True(Math.Abs(WreckMath.AngleTo(qa, Quatd.Identity) - WreckMath.AngleTo(rot, Quatd.Identity)) < 1e-6);
    }

    [Fact]
    public void LeavesThePartsAloneWhereTheFuselageHasNotBent()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.2, Hit);
        Vec3d p = Position + new Vec3d(1, 0, -6);
        Quatd q = Quatd.Identity;
        Vec3d before = p;
        state.TransformPart(0, ref p, ref q, Position, Quatd.Identity, new Vec3d(1, 1, 1));
        Assert.True(Vec3d.Distance(p, before) < 1e-9);
        Assert.True(WreckMath.AngleTo(q, Quatd.Identity) < 1e-9);
    }

    [Fact]
    public void WorksForAnAircraftThatIsBankedAndPointingSomewhere()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        // three.js setFromEuler(0.2, 1.2, -0.4), order XYZ.
        double c1 = Math.Cos(0.1), c2 = Math.Cos(0.6), c3 = Math.Cos(-0.2);
        double s1 = Math.Sin(0.1), s2 = Math.Sin(0.6), s3 = Math.Sin(-0.2);
        var q = new Quatd(s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3);
        f.ApplyDamage(Src(new Vec3d(20, -20, 40), q), state, 0.7, Hit);
        Assert.True(BoxOf(state.Root).Size.Length < 30);
        Assert.True(state.Active);
    }

    [Fact]
    public void TheFinalBreakUpCarriesOnFromTheDamageTornSectionsAreNotTornAgain()
    {
        Func<double> rng = WreckFieldTests.Rng();
        WreckField f = Field(rng);
        var state = new AirframeDamage();
        var tornFirst = new List<int>();
        for (int run = 0; run < 30 && state.RippedCells.Count == 0; run++)
        {
            state.Reset();
            f.Clear();
            f.ApplyDamage(Src(), state, 0.9, Hit);
            tornFirst = state.RippedCells.ToList();
        }
        Assert.NotEmpty(tornFirst);
        WreckField final = Field(rng);
        WreckSource withDamage = Src(new Vec3d(0, -100, 100));
        withDamage.Damage = state;
        Assert.True(final.Spawn(withDamage));
        WreckField bare = Field(rng);
        bare.Spawn(Src(new Vec3d(0, -100, 100)));
        int after = final.Fragments.Sum(o => CountVerts(o.Meshes, WingMat));
        int full = bare.Fragments.Sum(o => CountVerts(o.Meshes, WingMat));
        Assert.True(after < full);
    }

    [Fact]
    public void IsAtLeastAsBentInTheFinalBreakUpAsItAlreadyWas()
    {
        Func<double> rng = WreckFieldTests.Rng();
        WreckField f = Field(rng);
        var state = new AirframeDamage();
        f.ApplyDamage(Src(new Vec3d(10, -40, 40)), state, 0.9, Hit);
        WreckField final = Field(rng);
        WreckSource src = Src(new Vec3d(0, -8, 12));
        src.Damage = state;
        final.Spawn(src);
        Assert.True(final.LastTotalBendRad > 0.3);
    }

    [Fact]
    public void ResetsForANewAircraft()
    {
        WreckField f = Field(WreckFieldTests.Rng());
        var state = new AirframeDamage();
        f.ApplyDamage(Src(), state, 0.9, Hit);
        state.Reset();
        Assert.False(state.Active);
        Assert.Equal(0, state.Severity);
        Assert.Equal(0, state.RippedCells.Count + state.RippedParts.Count + state.PartBends.Count);
    }
}
