using System;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>Port of src/script/state/carrierSite.test.ts.</summary>
public class CarrierSiteTests
{
    private static bool AllUsable(double x, double z) => true;

    [Fact]
    public void TakesTheNearestOpenWaterAndLetsTheShipSteam()
    {
        // Sea east of x = 6000, plain land to the west.
        var s = new CarrierSiteSamplers
        {
            GroundAt = (x, z) => x > 6000 ? -3 : 120,
            IsLand = (x, z) => x <= 6000,
            Usable = AllUsable,
        };
        var site = CarrierSites.ChooseCarrierSite(0, 0, 2000, s);
        Assert.True(site.AtSea);
        Assert.True(site.X > 6000 + 40);
        Assert.Equal(-3, site.SurfaceY);
    }

    [Fact]
    public void MoorsOnLevelGroundWhenThereIsNoWaterAvoidingAHillside()
    {
        // A ridge rising to the east and north, a plain to the south-west.
        Func<double, double, double> ground = (x, z) => x > 0 || z < 0 ? 400 + Math.Abs(x) * 0.2 : 300;
        var s = new CarrierSiteSamplers { GroundAt = ground, IsLand = (x, z) => true, Usable = AllUsable };
        var site = CarrierSites.ChooseCarrierSite(0, 0, 2000, s);
        Assert.False(site.AtSea);
        double y = CarrierSites.CarrierSurfaceY(site.X, site.Z, ground);
        Assert.Equal(y, site.SurfaceY);
        // On the plain, not up the slope.
        Assert.True(y < 330, $"seated at {y}");
    }

    [Fact]
    public void StaysInsideWhatIsUsableAndAlwaysAnswers()
    {
        var s = new CarrierSiteSamplers
        {
            GroundAt = (x, z) => 100,
            IsLand = (x, z) => true,
            Usable = (x, z) => JsMath.Hypot(x, z) < 5000,
        };
        var site = CarrierSites.ChooseCarrierSite(0, 0, 1500, s);
        Assert.True(JsMath.Hypot(site.X, site.Z) < 5000);
        Assert.False(site.AtSea);
    }

    [Fact]
    public void PicksTheSameBerthsAsTheTs()
    {
        // Not in the TS tests: chooseCarrierSite on the scenarios above, as the TS answers in node.
        static void Is(CarrierSite s, double x, double z, double y, bool atSea)
        {
            Assert.True(Math.Abs(s.X - x) < 1e-9 && Math.Abs(s.Z - z) < 1e-9, $"({s.X}, {s.Z}) vs ({x}, {z})");
            Assert.Equal(y, s.SurfaceY);
            Assert.Equal(atSea, s.AtSea);
        }
        Is(CarrierSites.ChooseCarrierSite(0, 0, 2000, new CarrierSiteSamplers
        {
            GroundAt = (x, z) => x > 6000 ? -3 : 120, IsLand = (x, z) => x <= 6000, Usable = AllUsable,
        }), 7000, 0, -3, true);
        Is(CarrierSites.ChooseCarrierSite(0, 0, 2000, new CarrierSiteSamplers
        {
            GroundAt = (x, z) => x > 0 || z < 0 ? 400 + Math.Abs(x) * 0.2 : 300, IsLand = (x, z) => true, Usable = AllUsable,
        }), -261.05238444010274, 1982.889722747621, 300, false);
        Is(CarrierSites.ChooseCarrierSite(0, 0, 1500, new CarrierSiteSamplers
        {
            GroundAt = (x, z) => 100, IsLand = (x, z) => true, Usable = (x, z) => JsMath.Hypot(x, z) < 5000,
        }), 1487.1672920607157, 195.78928833007737, 100, false);
        Is(CarrierSites.ChooseCarrierSite(100, -50, 2300, new CarrierSiteSamplers
        {
            GroundAt = (x, z) => 0, IsLand = (x, z) => true, Usable = AllUsable,
        }), 2380.323181159764, 250.21024210611864, 0, false);
        // Nothing usable anywhere: parked beside the runway on the ground there.
        Is(CarrierSites.ChooseCarrierSite(0, 0, 2000, new CarrierSiteSamplers
        {
            GroundAt = (x, z) => 7, IsLand = (x, z) => true, Usable = (x, z) => false,
        }), 2000, 0, 7, false);
    }

    [Fact]
    public void DoesNotBerthOnTopOfTheAirbase()
    {
        var s = new CarrierSiteSamplers { GroundAt = (x, z) => 0, IsLand = (x, z) => true, Usable = AllUsable };
        var site = CarrierSites.ChooseCarrierSite(100, -50, 2300, s);
        Assert.True(JsMath.Hypot(site.X - 100, site.Z + 50) > 2299.9);
    }
}
