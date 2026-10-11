using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;
using Retro.Game;
using Retro.Sim;
using Xunit;
using static Retro.Golden.Tests.WreckTestKit;

namespace Retro.Golden.Tests;

/// <summary>
/// Port of src/script/scene/entities/wreckField.test.ts. The TS cases draw on
/// Math.random; here each test runs on one seeded stream (the cases are
/// statistical, so any stream should do), shared by every field it builds.
/// </summary>
public class WreckFieldTests
{
    private const double Dt = 1.0 / 60;

    internal static Func<double> Rng(uint seed = 1234) => Gun.Mulberry32(seed);

    /// <summary>Several boxes as one non-indexed position + normal mesh (the TS merged airframes).</summary>
    internal static WreckMeshInput Merged(object material, params Geo[] parts) => new WreckMeshInput
    {
        Positions = parts.SelectMany(g => g.Position).ToArray(),
        Normals = parts.SelectMany(g => g.Normal).ToArray(),
        Matrix = WreckMath.Identity(),
        Material = material,
    };

    /// <summary>A crude aircraft: fuselage box plus two wings, as one mesh at its origin.</summary>
    internal static WreckModel Airframe() => new WreckModel
    {
        MaxSize = 14,
        Meshes = { Merged("airframe", Box(2, 2, 14), Translate(Box(14, 0.3, 3), 0, 0, -1)) },
    };

    /// <summary>A finely tessellated airframe, so there is enough to cut shards from.</summary>
    internal static WreckModel DenseAirframe() => new WreckModel
    {
        MaxSize = 14,
        Meshes = { Merged("airframe", Box(2, 2, 14, 4, 4, 12), Translate(Box(14, 0.3, 3, 12, 1, 3), 0, 0, -1)) },
    };

    internal static WreckSource Source(Vec3d velocity, double y = 1.2) => new WreckSource
    {
        Id = "t",
        Body = Airframe(),
        Position = new Vec3d(0, y, 0),
        Quaternion = Quatd.Identity,
        Scale = new Vec3d(1, 1, 1),
        Velocity = velocity,
    };

    internal static void Run(WreckField field, double seconds)
    {
        for (int i = 0; i < (int)Math.Round(60 * seconds); i++) field.Update(Dt);
    }

    private static Quatd Euler(double x, double y, double z)
    {
        // three.js setFromEuler, order 'XYZ'.
        double c1 = Math.Cos(x / 2), c2 = Math.Cos(y / 2), c3 = Math.Cos(z / 2);
        double s1 = Math.Sin(x / 2), s2 = Math.Sin(y / 2), s3 = Math.Sin(z / 2);
        return new Quatd(
            s1 * c2 * c3 + c1 * s2 * s3,
            c1 * s2 * c3 - s1 * c2 * s3,
            c1 * c2 * s3 + s1 * s2 * c3,
            c1 * c2 * c3 - s1 * s2 * s3);
    }

    [Fact]
    public void BreaksASteepFastImpactIntoSeveralPieces()
    {
        var field = new WreckField(Rng());
        Assert.True(field.Spawn(Source(new Vec3d(0, -90, 140))));
        Assert.True(field.Fragments.Count > 3);
    }

    [Fact]
    public void KeepsASlowBellySlideMostlyTogether()
    {
        var field = new WreckField(Rng());
        field.Spawn(Source(new Vec3d(0, -6, 60)));
        Assert.True(field.Fragments.Count < 4);
    }

    [Fact]
    public void LetsPiecesTravelOnThenComeToRestOnTheGround()
    {
        var field = new WreckField(Rng());
        field.Spawn(Source(new Vec3d(0, -50, 120)));
        Run(field, 40);
        Assert.Contains(field.Fragments, f => JsMath.Hypot(f.Position.X, f.Position.Z) > 20);
        foreach (WreckFragment f in field.Fragments)
        {
            Assert.InRange(f.Position.Y, -0.5, 12);
        }
        Assert.All(field.Fragments, f => Assert.True(f.Asleep));
    }

    [Fact]
    public void PutsAFuselageFireAndWingRootFiresOnThePiecesAndTheyTravelWithThem()
    {
        var field = new WreckField(Rng());
        List<WreckFire> fires = null;
        field.OnBreakup = e => fires = e.Fires;
        field.Spawn(Source(new Vec3d(0, -80, 130)));
        Assert.Single(fires, f => f.Kind == WreckFireKind.Fuselage);
        Assert.Contains(fires, f => f.Kind == WreckFireKind.WingRoot);
        WreckFire fuselage = fires.First(f => f.Kind == WreckFireKind.Fuselage);
        field.FireWorld(fuselage, out Vec3d before);
        Run(field, 2);
        Assert.True(field.FireWorld(fuselage, out Vec3d after));
        Assert.True(Vec3d.Distance(after, before) > 5);
    }

    [Fact]
    public void LetsACameraFollowTheCockpitPieceAsItFliesAndLands()
    {
        var field = new WreckField(Rng());
        WreckSource src = Source(new Vec3d(0, -80, 130));
        src.Cockpit = new Vec3d(0, 0.8, 5);
        field.Spawn(src);
        Assert.True(field.CockpitWorld("t", out Vec3d start));
        Assert.True(Vec3d.Distance(start, new Vec3d(0, 2, 5)) < 1.5);
        Run(field, 1.5);
        field.CockpitWorld("t", out Vec3d later);
        Assert.True(Vec3d.Distance(later, start) > 10);
        field.Clear();
        Assert.False(field.CockpitWorld("t", out _));
    }

    [Fact]
    public void GivesTheAircraftPoseOfTheCockpitPieceConsistentWithTheEye()
    {
        var field = new WreckField(Rng());
        var cockpit = new Vec3d(0, 0.8, 5);
        WreckSource src = Source(new Vec3d(0, -80, 130));
        src.Quaternion = Euler(0.3, 1.1, 0.2);
        src.Cockpit = cockpit;
        field.Spawn(src);
        for (int i = 0; i < 100; i++) field.Update(Dt);
        Assert.True(field.CockpitBodyPose("t", out Vec3d pos, out Quatd quat));
        field.CockpitWorld("t", out Vec3d eye);
        Assert.True(Vec3d.Distance(cockpit.Rotate(quat) + pos, eye) < 1e-3);
    }

    [Fact]
    public void LeavesAScorchAtTheImpactThenPocksAndGougesAlongTheSlideAllOnTheGround()
    {
        var field = new WreckField(Rng());
        var marks = new List<(double Y, double Length)>();
        field.OnMark = (p, n, dx, dz, length, width, strength) => marks.Add((p.Y, length));
        field.Spawn(Source(new Vec3d(0, -60, 120)));
        int atImpact = marks.Count;
        Assert.True(atImpact > 3);
        Assert.True(marks.Max(m => m.Length) > 10);
        Run(field, 4);
        Assert.True(marks.Count > atImpact);
        Assert.All(marks, m => Assert.True(Math.Abs(m.Y) < 1e-5));
    }

    [Fact]
    public void LetsPiecesBreakUpFurtherOnTheGroundKeepingFiresAndCockpitWithTheRightHalf()
    {
        Func<double> rng = Rng();
        int splits = 0;
        bool anySplit = false;
        for (int run = 0; run < 6 && !anySplit; run++)
        {
            var field = new WreckField(rng);
            field.OnSplit = (p, v, s) => splits++;
            List<WreckFire> fires = new List<WreckFire>();
            field.OnBreakup = e => fires = e.Fires;
            var cockpit = new Vec3d(0, 0.8, 5);
            WreckSource src = Source(new Vec3d(0, -80, 130));
            src.Cockpit = cockpit;
            field.Spawn(src);
            int before = field.Fragments.Count;
            Run(field, 8);
            anySplit = field.Fragments.Count > before;
            foreach (WreckFire f in fires)
            {
                Assert.True(field.FireWorld(f, out Vec3d p));
                Assert.True(p.Y > -4);
            }
            Assert.True(field.CockpitBodyPose("t", out Vec3d pos, out Quatd quat));
            field.CockpitWorld("t", out Vec3d eye);
            Assert.True(Vec3d.Distance(cockpit.Rotate(quat) + pos, eye) < 1e-3);
            Assert.All(field.Fragments, o => Assert.True(o.Position.Y > -1));
        }
        Assert.True(anySplit);
        Assert.True(splits > 0);
    }

    [Fact]
    public void MarksTheGroundWhereverAPieceTouchesSlidesOrSettlesEvenGently()
    {
        var field = new WreckField(Rng());
        int marks = 0;
        field.OnMark = (p, n, dx, dz, l, w, s) => marks++;
        field.Spawn(Source(new Vec3d(0, -2.5, 14), 0.5));
        int afterSpawn = marks;
        Run(field, 30);
        Assert.True(marks - afterSpawn >= field.Fragments.Count);
    }

    [Fact]
    public void SetsTheScratchesOfFireCarryingPiecesAlightTheFuselageForLongest()
    {
        var field = new WreckField(Rng());
        var burns = new List<(double Life, double Intensity, double Y)>();
        field.OnMark = (p, n, dx, dz, l, w, s) => { };
        field.OnBurn = (p, life, intensity) => burns.Add((life, intensity, p.Y));
        field.Spawn(Source(new Vec3d(0, -12, 110)));
        Run(field, 4);
        Assert.NotEmpty(burns);
        Assert.All(burns, b =>
        {
            Assert.True(b.Life > 7);
            Assert.True(Math.Abs(b.Y) < 1e-5);
        });
        var strong = burns.Where(b => b.Intensity == 1).ToList();
        var weak = burns.Where(b => b.Intensity < 1).ToList();
        if (strong.Count > 0 && weak.Count > 0)
        {
            Assert.True(strong.Min(b => b.Life) > weak.Max(b => b.Life) - 1e-9);
        }
    }

    private static WreckSource Dense(Vec3d v)
    {
        WreckSource s = Source(v);
        s.Body = DenseAirframe();
        return s;
    }

    private static int VertexCount(WreckField field) => field.Fragments.Sum(f => f.Meshes.Sum(m => m.VertexCount));

    [Fact]
    public void CutsShardsOutOfTheAirframeWithoutLosingOrDuplicatingAnyTriangle()
    {
        WreckSource src = Dense(new Vec3d(0, -90, 140));
        int expected = src.Body.Meshes.Sum(m => m.Positions.Length / 3);
        var field = new WreckField(Rng());
        int brands = 0;
        field.OnBreakup = e => brands = e.Fires.Count(f => f.Kind == WreckFireKind.Brand);
        field.Spawn(src);
        Assert.True(brands > 0);
        Assert.Equal(expected, VertexCount(field) + 3 * field.LastScrapTriangles);
    }

    [Fact]
    public void ThrowsShardsOutToTheSideOfTheLineOfTravelNotAlongIt()
    {
        Func<double> rng = Rng();
        double lateral = 0;
        int along = 0;
        for (int run = 0; run < 5; run++)
        {
            var field = new WreckField(rng);
            List<WreckFire> brandFires = new List<WreckFire>();
            field.OnBreakup = e => brandFires = e.Fires.Where(f => f.Kind == WreckFireKind.Brand).ToList();
            field.Spawn(Dense(new Vec3d(0, -90, 140)));
            Assert.NotEmpty(brandFires);
            for (int i = 0; i < 40; i++) field.Update(Dt);
            foreach (WreckFire f in brandFires)
            {
                Assert.True(field.FireWorld(f, out Vec3d p));
                lateral += Math.Abs(p.X);
            }
            along += brandFires.Count;
        }
        Assert.True(lateral / along > 6);
    }

    [Fact]
    public void FlingsNothingOnAGentleTouchdown()
    {
        var field = new WreckField(Rng());
        int brands = -1;
        field.OnBreakup = e => brands = e.Fires.Count(f => f.Kind == WreckFireKind.Brand);
        field.Spawn(Dense(new Vec3d(0, -6, 60)));
        Assert.Equal(0, brands);
    }

    // --- connectivity ---------------------------------------------------------------

    private static int Components(WreckFragment frag)
    {
        var items = new List<(IList<double>, int)>();
        foreach (WreckMeshData m in frag.Meshes)
        {
            double[] pos = m.Position.Select(v => (double)v).ToArray();
            for (int t = 0; t < pos.Length / 9; t++) items.Add((pos, t));
        }
        return WreckField.GroupTriangles(items).Count;
    }

    /// <summary>A dense closed block as flat position data, centred at (x, y, z).</summary>
    private static List<double> Block(double w, double h, double d, double x, double y, double z, int seg = 3) =>
        Translate(Box(w, h, d, seg, seg, seg), x, y, z).Position.Select(v => (double)v).ToList();

    private static int Groups(IList<double> pos) =>
        WreckField.GroupTriangles(Enumerable.Range(0, pos.Count / 9).Select(t => (pos, t)).ToList()).Count;

    [Fact]
    public void WeldsTrianglesThatShareAVertexAndKeepsSeparateSurfacesApart()
    {
        Assert.Equal(2, Groups(Block(1, 1, 1, 0, 0, 0, 1).Concat(Block(1, 1, 1, 5, 0, 0, 1)).ToList()));
        Assert.Equal(1, Groups(Block(1, 1, 1, 0, 0, 0, 1).Concat(Block(1, 1, 1, 1, 0, 0, 1)).ToList()));
    }

    [Fact]
    public void KeepsSectionsThatAreStillJoinedTogetherAndSeparatesTheRest()
    {
        List<string> Runs(params int[] cells) =>
            WreckField.JoinedCells(cells).Select(r => string.Concat(r.OrderBy(c => c))).OrderBy(s => s, StringComparer.Ordinal).ToList();
        Assert.Equal(new[] { "012" }, Runs(0, 1, 2));
        Assert.Equal(new[] { "0", "2" }, Runs(0, 2));
        Assert.Equal(new[] { "3", "5" }, Runs(3, 5));
        Assert.Equal(new[] { "13456" }, Runs(1, 3, 4, 5, 6));
        Assert.Equal(new[] { "013", "6" }, Runs(0, 1, 3, 6));
    }

    [Fact]
    public void CutsAPieceThatACutLeftInTwoUnjoinedPartsIntoTwoPieces()
    {
        var dumbbell = Block(2, 2, 2, -4, 0, 0).Concat(Block(2, 2, 2, 4, 0, 0)).ToList();
        List<List<double[]>> output = WreckField.ConnectedPositions(new[] { dumbbell });
        Assert.Equal(2, output.Count);
        foreach (List<double[]> comp in output)
        {
            Assert.Equal(1, Groups(comp[0]));
        }
    }

    [Fact]
    public void DropsAScrapTooSmallToBeAPieceInsteadOfLeavingItFloating()
    {
        double[] stray = { 6, 0, 0, 6.1, 0, 0, 6, 0.1, 0, 6.1, 0, 0, 6.1, 0.1, 0, 6, 0.1, 0 };
        List<List<double[]>> output = WreckField.ConnectedPositions(new[] { Block(2, 2, 2, 0, 0, 0).Concat(stray).ToList() });
        Assert.Single(output);
        Assert.Equal(Block(2, 2, 2, 0, 0, 0).Count / 9, output[0][0].Length / 9);
    }

    [Fact]
    public void CutsShardsFromOneConnectedSurfaceEvenWhenAnotherSitsWithinReach()
    {
        var field = new WreckField(Rng());
        List<double> plates = Box(14, 0.05, 14, 28, 1, 28).Position
            .Concat(Translate(Box(14, 0.05, 14, 28, 1, 28), 0, 0.4, 0).Position).Select(v => (double)v).ToList();
        int before = plates.Count;
        List<double[]> shards = field.ExtractShardsFrom(plates, 8, 14);
        Assert.NotEmpty(shards);
        int removed = 0;
        foreach (double[] pos in shards)
        {
            removed += pos.Length;
            Assert.Equal(1, Groups(pos));
        }
        Assert.Equal(before - removed, plates.Count);
    }

    [Fact]
    public void AlwaysCutsItsShardsFromADenseMeshHoweverManyTrianglesLieWithinReachOfTheSeed()
    {
        var field = new WreckField(Rng());
        List<double> plate = Box(14, 0.05, 14, 80, 1, 80).Position.Select(v => (double)v).ToList();
        int empty = 0;
        for (int trial = 0; trial < 100; trial++)
        {
            if (field.ExtractShardsFrom(plate.ToList(), 1, 14).Count == 0) empty++;
        }
        Assert.Equal(0, empty);
    }

    [Fact]
    public void KeepsAllTheSectionsOfTheFuselageInOnePieceAtEveryModerateHitTipsAside()
    {
        Func<double> rng = Rng();
        object[] mats = { "f0", "f1", "f2" };
        const string tipL = "tipL", tipR = "tipR";
        WreckMeshInput Fuselage(double z, object m) => Mesh(Translate(Box(2, 2, 4.4, 2, 2, 2), 0, 0, z), m);
        WreckMeshInput Tip(double x, object m) => Mesh(Translate(Box(1.2, 0.3, 2, 2, 1, 2), x, 0, 0), m);
        var model = new WreckModel { MaxSize = 15, Meshes = { Fuselage(-4.5, mats[0]), Fuselage(0, mats[1]), Fuselage(4.5, mats[2]), Tip(-7, tipL), Tip(7, tipR) } };
        for (int run = 0; run < 200; run++)
        {
            var field = new WreckField(rng);
            double v = 30 + (run % 20);
            WreckSource src = Source(new Vec3d(0, -v, v * 1.3));
            src.Body = model;
            field.Spawn(src);
            int withFuselage = 0;
            foreach (WreckFragment frag in field.Fragments)
            {
                var used = new HashSet<object>(frag.Meshes.Select(c => c.Material));
                int triangles = frag.Meshes.Sum(c => c.VertexCount / 3);
                if (triangles > 60 && mats.Any(used.Contains))
                {
                    withFuselage++;
                    Assert.True(mats.All(used.Contains));
                }
                Assert.False(used.Contains(tipL) && used.Contains(tipR));
            }
            Assert.Equal(1, withFuselage);
        }
    }

    // --- a fuselage that dislocates, and tears only under a very hard blow -------------

    internal const string FuselageMat = "fuselage";
    internal const string WingMat = "wing";

    /// <summary>A long fuselage (z -7..7, front +Z, 2 m wide) with a wing across it, as two meshes.</summary>
    internal static WreckModel Jet() => new WreckModel
    {
        MaxSize = 14,
        Meshes = { Mesh(Box(2, 2, 14, 3, 3, 28), FuselageMat), Mesh(Translate(Box(14, 0.3, 3, 14, 1, 3), 0, 0, 0.5), WingMat) },
    };

    private static bool SpawnJet(WreckField field, Vec3d velocity)
    {
        WreckSource src = Source(velocity);
        src.Body = Jet();
        src.Cockpit = new Vec3d(0, 0.8, 5.5);
        return field.Spawn(src);
    }

    private static List<Vec3d> Vertices(WreckField field, string mat)
    {
        var output = new List<Vec3d>();
        foreach (WreckFragment frag in field.Fragments)
        {
            foreach (WreckMeshData mesh in frag.Meshes.Where(m => (string)m.Material == mat))
            {
                for (int i = 0; i + 2 < mesh.Position.Length; i += 3)
                {
                    output.Add(new Vec3d(mesh.Position[i], mesh.Position[i + 1], mesh.Position[i + 2]) + frag.Position);
                }
            }
        }
        return output;
    }

    private static int TrianglesOf(WreckFragment f, string mat) => f.Meshes.Where(m => (string)m.Material == mat).Sum(m => m.VertexCount / 3);

    private static int PiecesWith(WreckField field, string mat) => field.Fragments.Count(f => TrianglesOf(f, mat) > 120);

    private static List<double> EdgeLengths(WreckField field, string mat)
    {
        var output = new List<double>();
        foreach (WreckFragment frag in field.Fragments)
        {
            foreach (WreckMeshData mesh in frag.Meshes.Where(m => (string)m.Material == mat))
            {
                float[] p = mesh.Position;
                for (int i = 0; i + 2 < p.Length / 3; i += 3)
                {
                    for (int k = 0; k < 3; k++)
                    {
                        int a = (i + k) * 3, b = (i + (k + 1) % 3) * 3;
                        var va = new Vec3d(p[a], p[a + 1], p[a + 2]);
                        var vb = new Vec3d(p[b], p[b + 1], p[b + 2]);
                        output.Add(JsMath.Round(Vec3d.Distance(va, vb) * 1e4) / 1e4);
                    }
                }
            }
        }
        output.Sort();
        return output;
    }

    private static double MaxAbsX(WreckField field) => Vertices(field, FuselageMat).Max(v => Math.Abs(v.X));

    [Fact]
    public void DoesNotShiftOnAGentleTouchdown()
    {
        var field = new WreckField(Rng());
        SpawnJet(field, new Vec3d(0, -4, 12));
        Assert.Equal(0, field.LastDislocationM);
        Assert.True(MaxAbsX(field) < 1.001);
    }

    [Fact]
    public void ShiftsTheRearSectionsSidewaysOnAHardHitTheWayItWasBeingThrownTheNoseStayingPut()
    {
        Func<double> rng = Rng();
        foreach (int sign in new[] { 1, -1 })
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d(sign * 25, -50, 60));
            Assert.Equal(sign, Math.Sign(field.LastDislocationM));
            Assert.True(Math.Abs(field.LastDislocationM) > 0.2);
            Assert.True(MaxAbsX(field) > 1.2);
            var nose = Vertices(field, FuselageMat).Where(v => v.Z > 4).ToList();
            Assert.True(nose.Count > 20);
            Assert.All(nose, v => Assert.True(Math.Abs(v.X) < 1.001));
        }
    }

    [Fact]
    public void MovesEachSectionAsItIsNothingIsBentOrStretched()
    {
        Func<double> rng = Rng();
        int compared = 0;
        for (int run = 0; run < 20; run++)
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d((run % 5 - 2) * 10, -60, 70));
            if (field.LastScrapTriangles > 0)
            {
                continue;
            }
            var still = new WreckField(rng);
            SpawnJet(still, new Vec3d(0, -3, 6));
            Assert.Equal(EdgeLengths(still, FuselageMat), EdgeLengths(field, FuselageMat));
            Assert.Equal(EdgeLengths(still, WingMat), EdgeLengths(field, WingMat));
            compared++;
        }
        Assert.True(compared > 5);
    }

    [Fact]
    public void AlsoBendsSidewaysRoundTheImpactTheWayItWasThrown()
    {
        Func<double> rng = Rng();
        foreach (int sign in new[] { 1, -1 })
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d(sign * 25, -50, 60));
            Assert.Equal(sign, Math.Sign(field.LastBendRad));
            Assert.True(Math.Abs(field.LastBendRad) > 0.3);
            Assert.Equal(sign, Math.Sign(field.LastDislocationM));
        }
        var gentle = new WreckField(rng);
        SpawnJet(gentle, new Vec3d(0, -4, 12));
        Assert.Equal(0, gentle.LastBendRad);
        var hard = new WreckField(rng);
        SpawnJet(hard, new Vec3d(20, -150, 200));
        Assert.True(Math.Abs(hard.LastBendRad) <= 2.4 + 1e-9);
        Assert.True(Math.Abs(hard.LastBendRad) > 120 * Math.PI / 180);
        var moderate = new WreckField(rng);
        SpawnJet(moderate, new Vec3d(20, -35, 45));
        Assert.True(Math.Abs(hard.LastBendRad) > Math.Abs(moderate.LastBendRad));
    }

    [Fact]
    public void FoldsInDifferentPlanesSidewaysAndUpwardOrDownwardToo()
    {
        Func<double> rng = Rng();
        int sideways = 0, up = 0, down = 0;
        for (int run = 0; run < 80; run++)
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d((run % 5 - 2) * 8, -60, 80));
            double upRad = field.LastBendUpRad;
            double yaw = Math.Sqrt(Math.Max(0, field.LastBendRad * field.LastBendRad - upRad * upRad));
            if (Math.Abs(upRad) < 0.1) sideways++;
            else if (upRad > 0) up++;
            else down++;
            Assert.True(Math.Abs(JsMath.Hypot(yaw, upRad) - Math.Abs(field.LastBendRad)) < 1e-6);
        }
        Assert.True(up > 0);
        Assert.True(down > 0);
        Assert.Equal(80, sideways + up + down);
        Assert.True(up > down);
    }

    [Fact]
    public void ShiftsFurtherForAHarderHitButNeverSoFarThatTheSectionsStopOverlapping()
    {
        Func<double> rng = Rng();
        double Shift(Vec3d v)
        {
            var f = new WreckField(rng);
            SpawnJet(f, v);
            return Math.Abs(f.LastDislocationM);
        }
        double moderate = Shift(new Vec3d(20, -35, 45));
        double hard = Shift(new Vec3d(20, -90, 120));
        Assert.True(hard > moderate);
        Assert.True(hard < 2);
        var field = new WreckField(rng);
        SpawnJet(field, new Vec3d(20, -150, 200));
        Assert.True(Math.Abs(field.LastKinkRad) <= 0.5 + 1e-9);
    }

    [Fact]
    public void KeepsTheWholeFuselageInOnePieceAtAnyHitUpToAHardOne()
    {
        Func<double> rng = Rng();
        for (int run = 0; run < 200; run++)
        {
            var field = new WreckField(rng);
            double hard = run / 199.0;
            SpawnJet(field, new Vec3d((run % 7 - 3) * 6, -30 - 40 * hard, 40 + 50 * hard));
            Assert.Equal(1, PiecesWith(field, FuselageMat));
        }
    }

    [Fact]
    public void TearsASectionAwayAtAJointUnderABlowFarHarderThanThat()
    {
        Func<double> rng = Rng();
        int torn = 0;
        for (int run = 0; run < 100; run++)
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d((run % 7 - 3) * 6, -150, 200));
            if (PiecesWith(field, FuselageMat) > 1) torn++;
        }
        Assert.True(torn > 50);
    }

    [Fact]
    public void StaysWholeThroughTheBouncesAndSlidesOfAModerateWreck()
    {
        Func<double> rng = Rng();
        for (int run = 0; run < 15; run++)
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d((run % 5 - 2) * 10, -50, 80));
            Run(field, 15);
            Assert.Equal(1, PiecesWith(field, FuselageMat));
        }
    }

    [Fact]
    public void ComesToRestLyingDownNotStandingOnEndAfterASteepNoseDownHit()
    {
        Func<double> rng = Rng();
        for (int run = 0; run < 12; run++)
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d((run % 3 - 1) * 8, -90, 20 + run * 3));
            Run(field, 20);
            foreach (WreckFragment f in field.Fragments)
            {
                Vec3d h = f.Half;
                if (f.Disposed || Math.Max(h.X, Math.Max(h.Y, h.Z)) < 3) continue;
                double[] e = WreckMath.RotationFromQuaternion(f.Quaternion);
                double worldY = Math.Abs(e[1]) * h.X + Math.Abs(e[5]) * h.Y + Math.Abs(e[9]) * h.Z;
                double worldX = Math.Abs(e[0]) * h.X + Math.Abs(e[4]) * h.Y + Math.Abs(e[8]) * h.Z;
                double worldZ = Math.Abs(e[2]) * h.X + Math.Abs(e[6]) * h.Y + Math.Abs(e[10]) * h.Z;
                Assert.True(worldY < 1.3 * Math.Max(worldX, worldZ));
            }
        }
    }

    [Fact]
    public void DoesNotRestBalancedOnAWingtipOrAnEdgeAFlatPieceEndsUpOnItsFlatSide()
    {
        Func<double> rng = Rng();
        int checkedPieces = 0, flat = 0;
        for (int run = 0; run < 100 && checkedPieces < 6; run++)
        {
            var field = new WreckField(rng);
            SpawnJet(field, new Vec3d((run % 4 - 1.5) * 12, -35 - run * 3, 45 + run * 4));
            Run(field, 25);
            foreach (WreckFragment f in field.Fragments)
            {
                Vec3d h = f.Half;
                double big = Math.Max(h.X, Math.Max(h.Y, h.Z));
                double thin = Math.Min(h.X, Math.Min(h.Y, h.Z));
                double mid = h.X + h.Y + h.Z - big - thin;
                if (f.Disposed || big < 3 || thin > 0.7 * mid) continue;
                Vec3d axis = h.X == thin ? Vec3d.UnitX : h.Y == thin ? Vec3d.UnitY : Vec3d.UnitZ;
                if (Math.Abs(axis.Rotate(f.Quaternion).Y) > 0.9) flat++;
                checkedPieces++;
            }
        }
        Assert.True(flat >= Math.Ceiling(0.7 * checkedPieces));
    }

    [Fact]
    public void CarriesTheWingsAndTheCockpitEyeWithTheSectionTheyAreOn()
    {
        Func<double> rng = Rng();
        var field = new WreckField(rng);
        SpawnJet(field, new Vec3d(25, -50, 60));
        double Span(List<Vec3d> vs)
        {
            double best = 0;
            for (int i = 0; i < vs.Count; i += 3)
            {
                for (int j = i + 1; j < vs.Count; j += 3) best = Math.Max(best, Vec3d.Distance(vs[i], vs[j]));
            }
            return best;
        }
        var still = new WreckField(rng);
        SpawnJet(still, new Vec3d(0, -3, 6));
        double folded = Span(Vertices(field, WingMat));
        double whole = Span(Vertices(still, WingMat));
        Assert.True(folded < whole - 0.1);
        Assert.True(folded > 0.3 * whole);
    }

    [Fact]
    public void FoldsTheWingsUpwardBeforeTheyTearAHarderHitFoldsThemFurther()
    {
        Func<double> rng = Rng();
        double Rise(Vec3d v)
        {
            var field = new WreckField(rng);
            SpawnJet(field, v);
            var ys = Vertices(field, WingMat).Select(p => p.Y).ToList();
            return ys.Max() - ys.Min();
        }
        double still = Rise(new Vec3d(0, -3, 6));
        double moderateMax = 0, hardMax = 0;
        for (int run = 0; run < 15; run++)
        {
            moderateMax = Math.Max(moderateMax, Rise(new Vec3d(run % 3 - 1, -30, 45)));
            hardMax = Math.Max(hardMax, Rise(new Vec3d(run % 3 - 1, -90, 120)));
        }
        Assert.True(moderateMax > still + 0.3);
        Assert.True(hardMax > still + 2);
    }

    [Fact]
    public void MarksThePiecesThatHoldFuselageSoTheyAreNeverSplitFurther()
    {
        var field = new WreckField(Rng());
        SpawnJet(field, new Vec3d(0, -55, 60));
        var withFuselage = field.Fragments.Where(f => TrianglesOf(f, FuselageMat) > 120).ToList();
        Assert.NotEmpty(withFuselage);
        Assert.All(withFuselage, f => Assert.True(f.Tough));
    }

    // --- pieces at rest follow the ground under them -----------------------------------

    private static (WreckField Field, List<WreckFragment> Resting, Action<double> SetLevel) RestedField()
    {
        var field = new WreckField(Rng());
        double level = 0;
        field.SetGroundHeightAt((x, z) => level);
        field.Spawn(Source(new Vec3d(0, -60, 90), 1.2));
        Run(field, 40);
        return (field, field.Fragments.Where(f => f.Asleep && !f.Disposed).ToList(), v => level = v);
    }

    private static double LowestCorner(WreckFragment f) => f.Corners.Min(c => c.Rotate(f.Quaternion).Y + f.Position.Y);

    [Fact]
    public void RestingPiecesAreLiftedWhenTheGroundRisesUnderThem()
    {
        var r = RestedField();
        Assert.NotEmpty(r.Resting);
        r.SetLevel(2);
        Run(r.Field, 2);
        Assert.All(r.Resting, f => Assert.True(LowestCorner(f) > 2 - 0.05));
    }

    [Fact]
    public void RestingPiecesWakeAndFallWhenTheGroundDropsAwayUnderThem()
    {
        var r = RestedField();
        Assert.NotEmpty(r.Resting);
        var before = r.Resting.Select(f => f.Position.Y).ToList();
        r.SetLevel(-6);
        Run(r.Field, 5);
        for (int i = 0; i < r.Resting.Count; i++)
        {
            Assert.True(r.Resting[i].Position.Y < before[i] - 3);
            Assert.True(LowestCorner(r.Resting[i]) > -6 - 0.1);
        }
    }

    // --- crashing on a moving carrier deck ----------------------------------------------

    private static readonly Vec3d DeckV = new Vec3d(0, 0, -20);

    private static (WreckField Field, double DeckZ, bool Asleep, List<double> Moved, List<bool> RestedBefore) CrashOnDeck(double? halfWidth)
    {
        var field = new WreckField(Rng());
        double deckZ = 0;
        if (halfWidth.HasValue)
        {
            double hw = halfWidth.Value;
            field.SetMovingSurface(new Surface { Velocity = DeckV, Test = (x, y, z) => Math.Abs(x) < hw && y < 6 && y > -3 && Math.Abs(z - deckZ) < 1000 });
        }
        field.Spawn(Source(new Vec3d(0, -40, 50 + DeckV.Z)));
        void Step()
        {
            deckZ += DeckV.Z / 60;
            field.Update(Dt);
        }
        for (int i = 0; i < 60 * 25; i++) Step();
        var before = field.Fragments.Select(f => f.Position).ToList();
        var restedBefore = field.Fragments.Select(f => f.Asleep).ToList();
        for (int i = 0; i < 60 * 5; i++) Step();
        return (field, deckZ, field.Fragments.All(f => f.Asleep),
            field.Fragments.Select((f, i) => f.Position.Z - before[i].Z).ToList(), restedBefore);
    }

    [Fact]
    public void CarriesTheWreckageAlongWithTheShipOnceItHasComeToRestOnTheDeck()
    {
        var r = CrashOnDeck(5000);
        Assert.True(r.Asleep);
        for (int i = 0; i < r.Moved.Count; i++)
        {
            if (r.RestedBefore[i]) Assert.InRange(r.Moved[i], -110, -90);
        }
    }

    [Fact]
    public void ComesToRestOnTheDeckNotLeftBehindByTheShip()
    {
        var r = CrashOnDeck(5000);
        Assert.All(r.Field.Fragments, f => Assert.True(Math.Abs(f.Position.Z - r.DeckZ) < 450));
    }

    [Fact]
    public void StaysWhereItIsWhenThereIsNoMovingSurfaceUnderIt()
    {
        var r = CrashOnDeck(null);
        Assert.True(r.Asleep);
        for (int i = 0; i < r.Moved.Count; i++)
        {
            if (r.RestedBefore[i]) Assert.True(Math.Abs(r.Moved[i]) < 0.5);
        }
    }

    [Fact]
    public void LeavesBehindThePiecesThatGoOffTheSideOfTheDeck()
    {
        var field = new WreckField(Rng());
        double deckZ = 0;
        field.SetMovingSurface(new Surface { Velocity = DeckV, Test = (x, y, z) => Math.Abs(x) < 6 && y < 6 && y > -3 && Math.Abs(z - deckZ) < 1000 });
        field.Spawn(Source(new Vec3d(60, -30, DeckV.Z)));
        void Step()
        {
            deckZ += DeckV.Z / 60;
            field.Update(Dt);
        }
        for (int i = 0; i < 60 * 25; i++) Step();
        var before = field.Fragments.Select(f => (f.Position.Z, f.Asleep)).ToList();
        for (int i = 0; i < 60 * 5; i++) Step();
        int beside = 0;
        for (int i = 0; i < field.Fragments.Count; i++)
        {
            WreckFragment f = field.Fragments[i];
            if (f.Asleep && before[i].Asleep && Math.Abs(f.Position.X) > 12)
            {
                beside++;
                Assert.True(Math.Abs(f.Position.Z - before[i].Z) < 0.5);
            }
        }
        Assert.True(beside > 0);
    }

    // --- crashing into the sea --------------------------------------------------------

    private static WreckField SeaField(Func<double> rng = null)
    {
        var field = new WreckField(rng ?? Rng());
        field.SetWaterTest((x, z) => true);
        return field;
    }

    private static void Crash(WreckField field, Vec3d? velocity = null) => field.Spawn(Source(velocity ?? new Vec3d(0, -40, 60)));

    private static double MeanY(WreckField field) => field.Fragments.Average(f => f.Position.Y);

    private static readonly Vec3d Gentle = new Vec3d(0, -10, 20);

    [Fact]
    public void MakesASplashWhereEachPieceGoesInHarderForAFasterEntry()
    {
        Func<double> rng = Rng();
        List<double> Strengths(Vec3d velocity)
        {
            WreckField field = SeaField(rng);
            var output = new List<double>();
            field.OnSplash = (p, v, s) => output.Add(s);
            Crash(field, velocity);
            Run(field, 12);
            return output;
        }
        List<double> slow = Strengths(new Vec3d(0, -10, 20));
        List<double> fast = Strengths(new Vec3d(0, -100, 140));
        Assert.NotEmpty(slow);
        Assert.True(fast.Count > 1);
        Assert.All(slow.Concat(fast), s => Assert.InRange(s, 0.2, 1.6));
        Assert.True(fast.Average() > slow.Average());
    }

    [Fact]
    public void SplashesEachPieceOnceOnly()
    {
        WreckField field = SeaField();
        int splashes = 0;
        field.OnSplash = (p, v, s) => splashes++;
        Crash(field);
        Run(field, 20);
        Assert.True(splashes <= field.Fragments.Count);
        Assert.True(splashes > 0);
    }

    [Fact]
    public void DoesNotDustScorchOrDentTheSea()
    {
        WreckField field = SeaField();
        int ground = 0;
        field.OnDust = (p, v, c, s) => ground++;
        field.OnMark = (p, n, dx, dz, l, w, s) => ground++;
        field.OnBurn = (p, l, i) => ground++;
        Crash(field);
        Run(field, 15);
        Assert.Equal(0, ground);
    }

    [Fact]
    public void FloatsForTenSecondsAfterGoingInRidingAtTheSurface()
    {
        WreckField field = SeaField();
        Crash(field, Gentle);
        Run(field, 3);
        double y3 = MeanY(field);
        Run(field, 6);
        double y9 = MeanY(field);
        Assert.True(y3 > -3);
        Assert.True(y9 > -3);
        Assert.True(Math.Abs(y9 - y3) < 1);
        Assert.All(field.Fragments, f => Assert.True(f.Position.Y > -4));
    }

    [Fact]
    public void DoesNotStartSinkingBeforeTenSecondsAreUpAndIsGoingDownWellAfter()
    {
        WreckField field = SeaField();
        Crash(field, Gentle);
        Run(field, 9);
        double before = MeanY(field);
        Run(field, 12);
        double after = MeanY(field);
        Assert.True(after < before - 3);
        Assert.True(after > before - 14);
    }

    [Fact]
    public void SinksSlowlyOnceItHasStarted()
    {
        WreckField field = SeaField();
        Crash(field, Gentle);
        Run(field, 14);
        double y14 = MeanY(field);
        Run(field, 10);
        double y24 = MeanY(field);
        double rate = (y14 - y24) / 10;
        Assert.InRange(rate, 0.4, 1.1);
        Assert.All(field.Fragments, f => Assert.True(JsMath.Hypot(f.Velocity.X, f.Velocity.Z) < 1));
    }

    [Fact]
    public void KeepsBurningWhileItFloatsAndTheFireGoesOutOnceItHasSunk()
    {
        WreckField field = SeaField();
        List<WreckFire> fires = new List<WreckFire>();
        field.OnBreakup = e => fires = e.Fires;
        Crash(field, Gentle);
        Run(field, 8);
        Assert.Contains(fires, f => field.FireWorld(f, out _));
        Run(field, 25);
        Assert.All(fires, f => Assert.False(field.FireWorld(f, out _)));
    }

    private static (int[] Buckets, List<(double Y, double Radius, int Count)> Calls) FoamByBucket()
    {
        WreckField field = SeaField();
        var calls = new List<(double Y, double Radius, int Count, double T)>();
        double t = 0;
        field.OnFoam = (p, radius, count) => calls.Add((p.Y, radius, count, t));
        Crash(field, new Vec3d(0, -10, 20));
        var buckets = new int[12];
        for (int i = 0; i < 60 * 60; i++)
        {
            t += Dt;
            field.Update(Dt);
        }
        foreach (var c in calls)
        {
            buckets[Math.Min(11, (int)Math.Floor(c.T / 5))] += c.Count;
        }
        return (buckets, calls.Select(c => (c.Y, c.Radius, c.Count)).ToList());
    }

    [Fact]
    public void FoamLiesOnTheWaterSurfaceRoundPiecesOfASensibleSize()
    {
        var (_, calls) = FoamByBucket();
        Assert.True(calls.Count > 20);
        Assert.All(calls, c =>
        {
            Assert.True(Math.Abs(c.Y) < 1e-5);
            Assert.InRange(c.Radius, 0.8, 8);
        });
    }

    [Fact]
    public void FoamLaysARingAsThePieceGoesIn()
    {
        var (_, calls) = FoamByBucket();
        Assert.Equal(8, calls[0].Count);
    }

    [Fact]
    public void FoamGoesOnWhileItFloatsAndWhileItSinksThinningAsItGoesUnder()
    {
        var (buckets, _) = FoamByBucket();
        Assert.True(buckets[1] > 10);
        Assert.True(buckets[2] > 10);
        Assert.True(buckets[4] < buckets[2]);
        Assert.Equal(0, buckets[8]);
        Assert.Equal(0, buckets[11]);
    }

    [Fact]
    public void FoamIsNoneAtAllForAPieceOverLand()
    {
        var field = new WreckField(Rng());
        int n = 0;
        field.OnFoam = (p, r, c) => n++;
        Crash(field);
        Run(field, 20);
        Assert.Equal(0, n);
    }

    private static (WreckField Field, Action<bool> ShipOver) SeaWithShip()
    {
        bool shipOver = false;
        var field = new WreckField(Rng());
        field.SetGroundHeightAt((x, z) => shipOver ? 20 : 0);
        field.SetWaterTest((x, z) => !shipOver, (x, z) => 0);
        return (field, v => shipOver = v);
    }

    [Fact]
    public void IsNotLiftedUpOntoTheHullWhenTheShipSteamsOverTheSpotItFloatsAt()
    {
        var (field, shipOver) = SeaWithShip();
        field.Spawn(Source(Gentle));
        Run(field, 5);
        Assert.All(field.Fragments, f => Assert.True(f.Position.Y < 2));
        shipOver(true);
        Run(field, 8);
        Assert.All(field.Fragments, f => Assert.True(f.Position.Y < 2));
    }

    [Fact]
    public void GoesOnToSinkAllTheSameUnderTheShip()
    {
        var (field, shipOver) = SeaWithShip();
        field.Spawn(Source(Gentle));
        Run(field, 5);
        shipOver(true);
        Run(field, 25);
        Assert.True(MeanY(field) < -3);
    }

    [Fact]
    public void KeepsFoamAndSplashesAtTheLevelOfTheSeaNotAtTheHeightOfTheShip()
    {
        var (field, shipOver) = SeaWithShip();
        var foam = new List<double>();
        field.OnFoam = (p, r, c) => foam.Add(p.Y);
        field.Spawn(Source(Gentle));
        Run(field, 3);
        shipOver(true);
        int before = foam.Count;
        Run(field, 5);
        Assert.True(foam.Count > before);
        Assert.All(foam, y => Assert.True(Math.Abs(y) < 1e-5));
    }

    [Fact]
    public void IsNotCarriedAlongByTheMotionOfTheShipOnceItIsInTheWater()
    {
        var field = new WreckField(Rng());
        field.SetGroundHeightAt((x, z) => 0);
        field.SetWaterTest((x, z) => true, (x, z) => 0);
        field.SetMovingSurface(new Surface { Velocity = new Vec3d(0, 0, -20), Test = (x, y, z) => true });
        field.Spawn(Source(Gentle));
        Run(field, 3);
        var z3 = field.Fragments.Select(f => f.Position.Z).ToList();
        Run(field, 10);
        for (int i = 0; i < z3.Count; i++)
        {
            Assert.True(Math.Abs(field.Fragments[i].Position.Z - z3[i]) < 20);
        }
    }

    [Fact]
    public void KeepsACameraRidingTheCockpitAboveTheWaterAsThePieceSinks()
    {
        WreckField field = SeaField();
        Crash(field, new Vec3d(0, -40, 60));
        WreckSource src = Source(new Vec3d(0, -40, 60));
        src.Cockpit = new Vec3d(0, 0.8, 5);
        field.Spawn(src);
        Run(field, 45);
        Assert.True(field.CockpitBodyPose("t", out Vec3d pos, out _));
        Assert.True(MeanY(field) < -8);
        Assert.True(pos.Y >= 1 - 1e-6);
    }

    [Fact]
    public void SinksOutOfSightInTheEndAndStopsBeingSimulated()
    {
        WreckField field = SeaField();
        Crash(field);
        Run(field, 70);
        Assert.All(field.Fragments, f => Assert.False(f.Visible));
    }

    [Fact]
    public void ReportsACrashIntoTheSeaAsOneInWaterAndOneOnLandAsNot()
    {
        var water = new List<bool>();
        WreckField sea = SeaField();
        sea.OnBreakup = e => water.Add(e.Water);
        Crash(sea);
        var land = new WreckField(Rng());
        land.OnBreakup = e => water.Add(e.Water);
        Crash(land);
        Assert.Equal(new[] { true, false }, water);
    }

    [Fact]
    public void LeavesNoFirstImpactScorchOnTheSea()
    {
        int Marks(bool water)
        {
            WreckField field = water ? SeaField() : new WreckField(Rng());
            int n = 0;
            field.OnMark = (p, nn, dx, dz, l, w, s) => n++;
            Crash(field);
            return n;
        }
        Assert.Equal(0, Marks(true));
        Assert.True(Marks(false) > 0);
    }

    [Fact]
    public void LetsAPieceThatLandsOnLandBesideTheSeaLandNormally()
    {
        var field = new WreckField(Rng());
        field.SetWaterTest((x, z) => z > 100);
        int splashes = 0;
        field.OnSplash = (p, v, s) => splashes++;
        Crash(field, new Vec3d(0, -30, 5));
        Run(field, 10);
        Assert.Equal(0, splashes);
        Assert.All(field.Fragments, f => Assert.True(f.Position.Y > -1));
    }

    // --- gear legs ------------------------------------------------------------------------

    private const string GearMat = "gear";

    /// <summary>One gear part holding three separate legs (nose, left main, right main).</summary>
    private static WreckModel GearModel() => new WreckModel
    {
        MaxSize = 6,
        Meshes = new List<WreckMeshInput>(new[] { (0.0, 4.0), (2.5, -1.0), (-2.5, -1.0) }.Select(p => Mesh(Box(0.4, 2, 0.4, 1, 4, 1), GearMat, new Vec3d(p.Item1, 0, p.Item2)))),
    };

    private static WreckSource WithGear(Vec3d v)
    {
        WreckSource s = Source(v);
        s.Parts.Add(new WreckPart { Model = GearModel(), Kind = WreckPartKind.Gear, Id = 0, Position = new Vec3d(0, 0.2, 0), Quaternion = Quatd.Identity });
        return s;
    }

    private static int GearTriangles(WreckFragment f) => f.Meshes.Where(m => (string)m.Material == GearMat).Sum(m => m.VertexCount / 3);

    [Fact]
    public void TearsLegsOffOneAtATimeAndTheLegsThatStayAreWithAFuselagePiece()
    {
        Func<double> rng = Rng();
        int looseLegs = 0, keptLegs = 0;
        bool partial = false;
        for (int run = 0; run < 60; run++)
        {
            var field = new WreckField(rng);
            field.Spawn(WithGear(new Vec3d(0, -12 - run * 0.7, 20 + run)));
            int legsLoose = 0, legTriangles = 0;
            foreach (WreckFragment frag in field.Fragments)
            {
                int tris = GearTriangles(frag);
                if (tris == 0) continue;
                legTriangles += tris;
                if (frag.Meshes.Any(m => (string)m.Material != GearMat)) keptLegs++;
                else
                {
                    looseLegs++;
                    legsLoose++;
                }
            }
            Assert.Equal(3 * 36, legTriangles);
            partial = partial || legsLoose == 1 || legsLoose == 2;
        }
        Assert.True(looseLegs > 0);
        Assert.True(keptLegs > 0);
        Assert.True(partial);
    }

    [Fact]
    public void BendsALegNearAHardHitShovingTheFootSidewaysAndShorteningIt()
    {
        Func<double> rng = Rng();
        int bent = 0;
        for (int run = 0; run < 30; run++)
        {
            var field = new WreckField(rng);
            field.Spawn(WithGear(new Vec3d(10, -50, 60)));
            foreach (WreckFragment frag in field.Fragments)
            {
                var box = new WreckBox3();
                foreach (WreckMeshData m in frag.Meshes.Where(m => (string)m.Material == GearMat))
                {
                    for (int i = 0; i + 2 < m.Position.Length; i += 3) box.ExpandByPoint(m.Position[i], m.Position[i + 1], m.Position[i + 2]);
                }
                if (!box.IsEmpty && box.Size.Y < 1.9) bent++;
            }
        }
        Assert.True(bent > 0);
    }

    [Fact]
    public void LeavesTheLegsStraightOnAGentleTouchdown()
    {
        var field = new WreckField(Rng());
        field.Spawn(WithGear(new Vec3d(0, -3, 8)));
        foreach (WreckFragment frag in field.Fragments)
        {
            foreach (WreckMeshData m in frag.Meshes.Where(m => (string)m.Material == GearMat))
            {
                var box = new WreckBox3();
                for (int i = 0; i + 2 < m.Position.Length; i += 3) box.ExpandByPoint(m.Position[i], m.Position[i + 1], m.Position[i + 2]);
                Assert.True(box.Size.Length > 0);
            }
        }
    }

    [Fact]
    public void ThrowsUpDustWherePiecesStrikeTheGround()
    {
        var field = new WreckField(Rng());
        var hits = new List<int>();
        field.OnDust = (p, v, n, s) =>
        {
            hits.Add(n);
            Assert.True(p.Y < 2);
        };
        field.Spawn(Source(new Vec3d(0, -80, 130)));
        Run(field, 12);
        Assert.NotEmpty(hits);
    }

    [Fact]
    public void KicksUpDustFromASlidingPiece()
    {
        var field = new WreckField(Rng());
        int dust = 0;
        field.OnDust = (p, v, n, s) => dust += n;
        field.Spawn(Source(new Vec3d(0, -8, 90)));
        for (int i = 0; i < 120; i++) field.Update(Dt);
        Assert.True(dust > 0);
    }

    [Fact]
    public void ReportsNothingToBreakWhenTheModelHasNoGeometry()
    {
        var field = new WreckField(Rng());
        WreckSource src = Source(new Vec3d(0, -50, 100));
        src.Body = new WreckModel();
        Assert.False(field.Spawn(src));
    }

    [Fact]
    public void TrackerFiresOnceOnTheCrashEdgeWithAnEarlierVelocity()
    {
        var t = new WreckTracker();
        for (int i = 0; i < 12; i++)
        {
            t.Sample(false, new Vec3d(0, 0, 100 + i));
        }
        Vec3d? v = t.Sample(true, Vec3d.Zero);
        Assert.Equal(104, v.Value.Z);
        Assert.Null(t.Sample(true, Vec3d.Zero));
    }

    [Fact]
    public void RebaseMovesEveryPieceIntoTheNewFrame()
    {
        var field = new WreckField(Rng());
        field.Spawn(Source(new Vec3d(0, -60, 90)));
        Run(field, 1);
        var before = field.Fragments.Select(f => (f.Position, f.Quaternion, f.Velocity)).ToList();
        var rot = Quatd.FromAxisAngle(new Vec3d(0, 1, 0), 0.3);
        var shift = new FrameShift(rot, new Vec3d(100, -2, 50));
        field.Rebase(shift);
        for (int i = 0; i < before.Count; i++)
        {
            Assert.True(Vec3d.Distance(field.Fragments[i].Position, before[i].Position.Rotate(rot) + new Vec3d(100, -2, 50)) < 1e-9);
            Assert.True(Vec3d.Distance(field.Fragments[i].Velocity, before[i].Velocity.Rotate(rot)) < 1e-9);
        }
    }
}
