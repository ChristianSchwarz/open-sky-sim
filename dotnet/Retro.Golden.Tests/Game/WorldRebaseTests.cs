using System;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>Port of src/script/state/worldRebase.test.ts.</summary>
public class WorldRebaseTests
{
    private static readonly FrameShift Shift = FrameShift.Between(
        Geodesy.MakeEnuBasis(50.449, 11.536, 0), Geodesy.MakeEnuBasis(50.62, 11.79, 0));

    private sealed class RunwayRecord : IRunwayRecord
    {
        public Vec3d Center { get; set; }
        public double Heading { get; set; }
        public double? Slope { get; set; }
    }

    [Fact]
    public void KeepsAPointOnASlopedPadOnThePad()
    {
        var pad = new SurfacePadCollider
        {
            CenterX = -12_000, CenterZ = 8_000, Heading = 1.1, HalfLength = 1500, HalfWidth = 30,
            SurfaceY = 412, BaseY = 410, Feather = 20, Slope = 0.008,
        };
        Vec3d Local(double along, double across)
        {
            double h = pad.Heading;
            double x = pad.CenterX + Math.Sin(h) * along + Math.Cos(h) * across;
            double z = pad.CenterZ + Math.Cos(h) * along - Math.Sin(h) * across;
            return new Vec3d(x, SurfacePad.SampleSurfacePadY(x, z, pad), z);
        }
        var samples = new[] { Local(0, 0), Local(1400, 25), Local(-1400, -25), Local(700, -10) };
        WorldRebase.RebaseSurfacePad(pad, Shift);
        foreach (Vec3d s in samples)
        {
            Vec3d p = Shift.Point(s);
            // The cross-axis tilt a pad cannot hold: 25 m out, a 25 km shift.
            double y = SurfacePad.SampleSurfacePadY(p.X, p.Z, pad);
            Assert.True(Math.Abs(y - p.Y) < 0.15, $"{y} vs {p.Y}");
        }
    }

    [Fact]
    public void MovesARunwayCentreAndKeepsItsThresholdsOnItsAxis()
    {
        var r = new RunwayRecord { Center = new Vec3d(5000, 200, -3000), Heading = -2.3, Slope = -0.004 };
        const double half = 1200;
        Vec3d End(double sign) => new(
            r.Center.X + sign * half * Math.Sin(r.Heading),
            r.Center.Y + sign * half * r.Slope!.Value,
            r.Center.Z + sign * half * Math.Cos(r.Heading));
        Vec3d a = Shift.Point(End(1));
        WorldRebase.RebaseRunway(r, Shift);
        var want = new Vec3d(
            r.Center.X + half * Math.Sin(r.Heading), r.Center.Y + half * r.Slope!.Value,
            r.Center.Z + half * Math.Cos(r.Heading));
        Assert.True(Vec3d.Distance(a, want) < 0.01, $"{Vec3d.Distance(a, want)} m");
    }

    [Fact]
    public void TurnsAMeshSoupWithoutTouchingTheSharedSourceArray()
    {
        double[] source = { 10, 0, 0, 0, 5, 0, 0, 0, -20 };
        var c = new CarrierMeshCollider
        {
            OriginX = 100, OriginY = 50, OriginZ = -100, Triangles = source,
            Aabb = new Aabb { Min = new double[] { 0, 0, -20 }, Max = new double[] { 10, 5, 0 } },
        };
        var world = new Vec3d(100 + 10, 50, -100);
        WorldRebase.RebaseMeshCollider(c, Shift);
        Assert.Equal(new double[] { 10, 0, 0, 0, 5, 0, 0, 0, -20 }, source);
        var got = new Vec3d(c.OriginX + c.Triangles[0], c.OriginY + c.Triangles[1], c.OriginZ + c.Triangles[2]);
        Assert.True(Vec3d.Distance(got, Shift.Point(world)) < 1e-6);
        Assert.True(c.Aabb.Min[2] <= c.Triangles[8] && c.Aabb.Max[0] >= c.Triangles[0]);
    }
}
