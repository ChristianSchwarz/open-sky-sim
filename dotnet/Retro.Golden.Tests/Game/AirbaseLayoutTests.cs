using System;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>AirbaseLayout: game.ts airbaseAt, frameOf, the ramp, groundHeightMaxUnder and buildingCollider.</summary>
public class AirbaseLayoutTests
{
    [Fact]
    public void NorthRunwayKeepsTheAuthoredOffsets()
    {
        BaseFrame f = AirbaseLayout.FrameOf(null);
        Assert.Equal(1500, f.HalfLength);
        (double x, double z) = AirbaseLayout.At(f, AirbaseLayout.Hangar1);
        Assert.Equal(-170, x, 9);
        Assert.Equal(0, z, 9);
    }

    [Fact]
    public void LayoutTurnsWithTheRunway()
    {
        var f = new BaseFrame { CenterX = 1000, CenterZ = -500, Heading = Math.PI / 2 };
        // Heading pi/2: "along" (+z local) is scene +x, "right" (+x local) is scene -z.
        (double x, double z) = AirbaseLayout.At(f, 10, 100);
        Assert.Equal(1100, x, 9);
        Assert.Equal(-510, z, 9);
    }

    [Fact]
    public void RampHasFourSlotsNoseOutAcrossTheRunway()
    {
        var f = new BaseFrame { Heading = 0.3 };
        var slots = AirbaseLayout.RampSlots(f);
        Assert.Equal(4, slots.Count);
        foreach (var s in slots) Assert.Equal(0.3 - Math.PI / 2, s.Heading, 12);
        (double x0, double z0) = AirbaseLayout.At(f, AirbaseLayout.RampX, -40);
        Assert.Equal(x0, slots[0].X, 12);
        Assert.Equal(z0, slots[0].Z, 12);
    }

    [Fact]
    public void SkiJumpStandsNinetyMetresPastTheRunwaySpawn()
    {
        var f = new BaseFrame { HalfLength = 1500, Heading = 0 };
        (double x, double z) = AirbaseLayout.SkiJumpOrigin(f);
        Vec3d fwd = ActiveAirfield.HeadingForward(0);
        // The spawn is halfLength - 120 m behind the centre; the ramp 90 m ahead of it.
        Assert.Equal(-fwd.Z * (1500 - 120 - 90), z, 9);
        Assert.Equal(-fwd.X * (1500 - 120 - 90), x, 9);
    }

    [Fact]
    public void GroundMaxUnderTakesTheHighestSampleAndTheCorners()
    {
        // A spike at one corner only.
        double Ground(double x, double z) => (x == 45 && z == 37) ? 30 : 2;
        Assert.Equal(30, AirbaseLayout.GroundMaxUnder(Ground, 0, 0, 45, 37));
        Assert.Equal(2, AirbaseLayout.GroundMaxUnder(Ground, 0, 0, 40, 40));
    }

    [Fact]
    public void BuildingIsARoofPadAndACylinder()
    {
        EnuBasis basis = Geodesy.MakeEnuBasis(28.0, -15.4);
        var b = new AirfieldBuilding
        {
            Kind = AirfieldBuildingKind.Hangar, Lat = 28.01, Lon = -15.39, HeadingDeg = 30, WidthM = 40, DepthM = 60, HeightM = 12,
        };
        var c = AirbaseLayout.BuildingCollider(b, basis, (x, z) => 5 + x * 0.001);
        Assert.NotNull(c);
        var (pad, obstacle) = c.Value;
        Vec3d centre = Geodesy.GeodeticToWorld(basis, 28.01, -15.39, 0);
        Assert.Equal(centre.X, pad.CenterX, 9);
        Assert.Equal(centre.Z, pad.CenterZ, 9);
        // Depth along the building's heading (clockwise from north, scene north is -z): pi - heading.
        // (to a milliradian: metres per degree is a flat approximation, as in the TS)
        Assert.True(Math.Abs(Math.PI - 30 * Math.PI / 180 - pad.Heading) < 2e-3);
        Assert.Equal(30, pad.HalfLength);
        Assert.Equal(20, pad.HalfWidth);
        Assert.Equal(pad.BaseY + 12, pad.SurfaceY, 12);
        // The lowest corner: the ground rises with x, so the base is below the centre's.
        Assert.True(pad.BaseY < 5 + centre.X * 0.001);
        Assert.Equal(AirbaseLayout.BuildingPadFeatherM, pad.Feather);
        Assert.Equal(Math.Sqrt(40 * 40 + 60 * 60) / 2, obstacle.Radius, 12);
        Assert.Equal(12, obstacle.Height);
    }

    [Fact]
    public void BuildingOverUnknownGroundHasNoCollider()
    {
        EnuBasis basis = Geodesy.MakeEnuBasis(28.0, -15.4);
        var b = new AirfieldBuilding { Lat = 28.0, Lon = -15.4, WidthM = 10, DepthM = 10 };
        Assert.Null(AirbaseLayout.BuildingCollider(b, basis, (x, z) => double.NegativeInfinity));
    }
}
