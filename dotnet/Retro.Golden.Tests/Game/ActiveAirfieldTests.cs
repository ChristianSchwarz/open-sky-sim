using System;
using System.Collections.Generic;
using System.Linq;
using Retro.Core;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>Port of src/script/state/activeAirfield.test.ts.</summary>
public class ActiveAirfieldTests
{
    private static readonly EnuBasis Basis = Geodesy.MakeEnuBasis(28.0015, -15.3937, 0);
    private const double Eps = 1.5;
    private const double Deg = 180 / Math.PI;

    private static AirfieldRunway Gclp03() => new()
    {
        Ref = "03L/21R", HeadingDeg = 21.4354, LengthM = 3103, WidthM = 45,
        Surface = RunwaySurface.Asphalt, Lit = true, Lat = 27.931904, Lon = -15.386584,
        Thresholds = new[] { new[] { 27.918871, -15.392346 }, new[] { 27.944937, -15.380823 } },
    };

    private static AirfieldRunway Runway(string @ref, double heading, double length, double width,
        RunwaySurface surface, bool lit, double lat, double lon, double[][] thresholds) => new()
    {
        Ref = @ref, HeadingDeg = heading, LengthM = length, WidthM = width, Surface = surface,
        Lit = lit, Lat = lat, Lon = lon, Thresholds = thresholds,
    };

    /// <summary>Gran Canaria with any fields overridden, like the TS `{ ...defaults, ...over }`.</summary>
    private static Airfield MakeAirfield(Action<Airfield> over = null)
    {
        var a = new Airfield
        {
            Name = "Gran Canaria",
            Icao = "GCLP",
            Iata = "LPA",
            Kind = "international",
            Area = "home",
            Lat = 27.93016,
            Lon = -15.38801,
            ElevationM = 12.97,
            Plane = new AirfieldPlane { HeightMsl = 12.97, Gradient = -0.00385, HeadingDeg = 21.4354 },
            Runways = new List<AirfieldRunway> { Gclp03() },
        };
        over?.Invoke(a);
        return a;
    }

    // scene runway

    [Fact]
    public void TurnsATrueBearingIntoASceneHeading()
    {
        // Scene axes are x east, z south, so a runway on 021 true faces 159 in the scene.
        var r = ActiveAirfield.SceneRunwayOf(MakeAirfield(), MakeAirfield().Runways[0], Basis, Eps);
        double heading = ((r.Heading * Deg) % 360 + 360) % 360;
        Assert.True(Math.Abs(heading - (180 - 21.4354)) < 0.5, $"scene heading {heading:F2}");
    }

    [Fact]
    public void KeepsTheRunwayItsOwnSize()
    {
        var r = ActiveAirfield.SceneRunwayOf(MakeAirfield(), MakeAirfield().Runways[0], Basis, Eps);
        Assert.Equal(3103 / 2.0, r.HalfLength);
        Assert.Equal(22.5, r.HalfWidth);
        Assert.Equal("03L/21R", r.Ref);
        Assert.Equal("GCLP", r.Icao);
    }

    [Fact]
    public void FacesTheLowDesignatorSoTheNumbersReadOnLanding()
    {
        // Landing on 03 means flying roughly north-east: +x and -z in scene axes.
        var r = ActiveAirfield.SceneRunwayOf(MakeAirfield(), MakeAirfield().Runways[0], Basis, Eps);
        Vec3d fwd = ActiveAirfield.HeadingForward(r.Heading);
        Assert.True(fwd.X > 0, "not heading east");
        Assert.True(fwd.Z < 0, "not heading north");
    }

    [Fact]
    public void CarriesTheRunwaySlopeDownhillTowardTheFarThreshold()
    {
        var r = ActiveAirfield.SceneRunwayOf(MakeAirfield(), MakeAirfield().Runways[0], Basis, Eps);
        Assert.True(r.Slope < 0, $"slope {r.Slope} is not downhill");
        Assert.True(Math.Abs(r.Slope) > 0.001, $"slope {r.Slope} is flat");
        Assert.True(Math.Abs(r.Slope) < 0.008, $"slope {r.Slope} is not a runway");
    }

    [Fact]
    public void IsLevelWhenTheAirfieldIs()
    {
        var level = MakeAirfield(a => a.Plane = new AirfieldPlane { HeightMsl = 100, Gradient = 0, HeadingDeg = 21.4354 });
        var r = ActiveAirfield.SceneRunwayOf(level, level.Runways[0], Basis, Eps);
        // Not exactly zero: the two thresholds sit at different distances from the play origin.
        Assert.True(Math.Abs(r.Slope) < 0.003, $"slope {r.Slope}");
    }

    // the area's runways

    private static Airfield[] TwoFields() => new[]
    {
        MakeAirfield(),
        MakeAirfield(a =>
        {
            a.Name = "La Palma"; a.Icao = "GCLA"; a.Lat = 28.627; a.Lon = -17.755;
            a.Plane = new AirfieldPlane { HeightMsl = 26, Gradient = 0, HeadingDeg = 179 };
            a.Runways = new List<AirfieldRunway>
            {
                Runway("18/36", 179, 2112, 45, RunwaySurface.Asphalt, true, 28.627, -17.755,
                    new[] { new[] { 28.636, -17.755 }, new[] { 28.617, -17.755 } }),
            };
        }),
    };

    [Fact]
    public void ListsEveryRunwayLongestFirst()
    {
        var runways = ActiveAirfield.SceneRunwaysOf(TwoFields(), Basis, Eps);
        Assert.Equal(2, runways.Count);
        Assert.True(runways[0].HalfLength >= runways[1].HalfLength);
        Assert.Equal("GCLP", runways[0].Icao);
    }

    private static Airfield Parallel() => MakeAirfield(a =>
    {
        var second = Gclp03();
        second.Ref = "03R/21L";
        second.LengthM = 3099;
        a.Runways = new List<AirfieldRunway> { Gclp03(), second };
    });

    [Fact]
    public void MarksOneRunwayPerAirfieldAsItsPrimary()
    {
        var runways = ActiveAirfield.SceneRunwaysOf(new[] { Parallel() }, Basis, Eps);
        Assert.Single(runways.Where(r => r.Primary));
        Assert.Equal("03L/21R", runways.First(r => r.Primary).Ref);
    }

    [Fact]
    public void StartsAtTheUsableFieldNearestThePlayOrigin()
    {
        var distant = MakeAirfield(a =>
        {
            a.Name = "Tenerife Norte"; a.Icao = "GCXO"; a.Lat = 28.483; a.Lon = -16.341;
            a.Plane = new AirfieldPlane { HeightMsl = 621, Gradient = 0, HeadingDeg = 110.6 };
            a.Runways = new List<AirfieldRunway>
            {
                Runway("12/30", 110.6, 3395, 45, RunwaySurface.Asphalt, true, 28.483, -16.341,
                    new[] { new[] { 28.49, -16.36 }, new[] { 28.47, -16.32 } }),
            };
        });
        var runways = ActiveAirfield.SceneRunwaysOf(TwoFields().Append(distant).ToArray(), Basis, Eps);
        Assert.Equal("GCXO", runways[0].Icao); // the long one should sort first
        Assert.Equal("GCLP", ActiveAirfield.PickStartRunway(runways)!.Icao);
    }

    [Fact]
    public void HonoursANamedAirfield()
    {
        var runways = ActiveAirfield.SceneRunwaysOf(TwoFields(), Basis, Eps);
        Assert.Equal("GCLA", ActiveAirfield.PickStartRunway(runways, "GCLA")!.Icao);
    }

    [Fact]
    public void IgnoresANameThatIsNotInThisArea()
    {
        var runways = ActiveAirfield.SceneRunwaysOf(TwoFields(), Basis, Eps);
        Assert.Equal("GCLP", ActiveAirfield.PickStartRunway(runways, "EDDB")!.Icao);
    }

    private static Airfield Gatow(double lat) => MakeAirfield(a =>
    {
        a.Icao = ""; a.Name = "Gatow"; a.Lat = lat; a.Lon = -15.39;
        a.Plane = new AirfieldPlane { HeightMsl = 46, Gradient = 0, HeadingDeg = 77 };
        a.Runways = new List<AirfieldRunway>
        {
            Runway("08R/26L", 77, 871, 46, RunwaySurface.Asphalt, false, lat, -15.39,
                new[] { new[] { lat, -15.4 }, new[] { lat, -15.38 } }),
        };
    });

    [Fact]
    public void HonoursAnUnnamedAirfieldPickedByItsName()
    {
        var runways = ActiveAirfield.SceneRunwaysOf(TwoFields().Append(Gatow(28.05)).ToArray(), Basis, Eps);
        Assert.Equal("Gatow", ActiveAirfield.PickStartRunway(runways, "Gatow")!.Name);
    }

    [Fact]
    public void WouldRatherStartOnGrassThanNowhere()
    {
        var grass = ActiveAirfield.SceneRunwaysOf(new[]
        {
            MakeAirfield(a =>
            {
                var r = Gclp03();
                r.Surface = RunwaySurface.Grass;
                a.Runways = new List<AirfieldRunway> { r };
            }),
        }, Basis, Eps);
        Assert.NotNull(ActiveAirfield.PickStartRunway(grass));
    }

    [Fact]
    public void KeepsThePavementWhenNothingIsLongEnoughToBeABase()
    {
        var nearGrass = MakeAirfield(a =>
        {
            a.Icao = "EDBE"; a.Name = "grass"; a.Lat = 28.01; a.Lon = -15.39;
            a.Plane = new AirfieldPlane { HeightMsl = 30, Gradient = 0, HeadingDeg = 100 };
            a.Runways = new List<AirfieldRunway>
            {
                Runway("10/28", 100, 910, 40, RunwaySurface.Grass, false, 28.01, -15.39,
                    new[] { new[] { 28.01, -15.4 }, new[] { 28.01, -15.38 } }),
            };
        });
        var fartherPaved = MakeAirfield(a =>
        {
            a.Icao = "EDAZ"; a.Name = "paved"; a.Lat = 28.2; a.Lon = -15.39;
            a.Plane = new AirfieldPlane { HeightMsl = 40, Gradient = 0, HeadingDeg = 76 };
            a.Runways = new List<AirfieldRunway>
            {
                Runway("07/25", 76, 1101, 23, RunwaySurface.Asphalt, true, 28.2, -15.39,
                    new[] { new[] { 28.2, -15.4 }, new[] { 28.2, -15.38 } }),
            };
        });
        var runways = ActiveAirfield.SceneRunwaysOf(new[] { nearGrass, fartherPaved }, Basis, Eps);
        Assert.Equal("EDAZ", ActiveAirfield.PickStartRunway(runways)!.Icao);
    }

    [Fact]
    public void TakesTheLongestStripWhenNoneOfThemIsABase()
    {
        var near = Gatow(28.05);
        var far = MakeAirfield(a =>
        {
            a.Icao = "EDAZ"; a.Name = "Schoenhagen"; a.Lat = 28.25; a.Lon = -15.39;
            a.Plane = new AirfieldPlane { HeightMsl = 40, Gradient = 0, HeadingDeg = 76 };
            a.Runways = new List<AirfieldRunway>
            {
                Runway("07/25", 76, 1101, 23, RunwaySurface.Asphalt, true, 28.25, -15.39,
                    new[] { new[] { 28.25, -15.4 }, new[] { 28.25, -15.38 } }),
            };
        });
        Assert.Equal("EDAZ",
            ActiveAirfield.PickStartRunway(ActiveAirfield.SceneRunwaysOf(new[] { near, far }, Basis, Eps))!.Icao);
    }

    [Fact]
    public void HasNoRunwayWhenTheAreaHasNoAirfield()
    {
        Assert.Null(ActiveAirfield.PickStartRunway(new List<SceneRunway>()));
        Assert.Null(ActiveAirfield.NearestSceneRunway(new List<SceneRunway>(), 0, 0));
    }

    [Fact]
    public void FindsTheClosestOneToAPoint()
    {
        var runways = ActiveAirfield.SceneRunwaysOf(TwoFields(), Basis, Eps);
        var gclp = runways.First(r => r.Icao == "GCLP");
        var near = ActiveAirfield.NearestSceneRunway(runways, gclp.Center.X + 500, gclp.Center.Z - 500);
        Assert.Equal("GCLP", near!.Icao);
    }

    // the airfield menu

    [Fact]
    public void OffersOneEntryPerAirfieldNotPerRunway()
    {
        var choices = ActiveAirfield.AirfieldChoices(ActiveAirfield.SceneRunwaysOf(new[] { Parallel() }, Basis, Eps));
        Assert.Single(choices);
        Assert.Equal("GCLP", choices[0].Icao);
        Assert.Equal("03L/21R", choices[0].Ref);
        Assert.Equal(3103, JsMath.Round(choices[0].LengthM));
    }

    [Fact]
    public void KeepsTwoUnnamedAirstripsApart()
    {
        var strips = new[]
        {
            MakeAirfield(a => { a.Icao = ""; a.Name = "north strip"; }),
            MakeAirfield(a => { a.Icao = ""; a.Name = "south strip"; a.Lat = 27.8; }),
        };
        Assert.Equal(2, ActiveAirfield.AirfieldChoices(ActiveAirfield.SceneRunwaysOf(strips, Basis, Eps)).Count);
    }

    [Fact]
    public void MatchesTheTsSceneRunway()
    {
        // Not in the TS tests: sceneRunwayOf(GCLP) as the TS computes it in node.
        var r = ActiveAirfield.SceneRunwayOf(MakeAirfield(), MakeAirfield().Runways[0], Basis, Eps);
        Assert.True(Vec3d.Distance(new Vec3d(700.3841520483677, 9.747456769976907, 7712.548400530662), r.Center) < 1e-6);
        Assert.True(Math.Abs(2.767534657924522 - r.Heading) < 1e-12);
        Assert.True(Math.Abs(-0.0027594045166547845 - r.Slope) < 1e-12);
    }

    // heading forward

    [Fact]
    public void PointsAlongPlusZAtHeadingZeroAsTheAiAndThePlayerAgree()
    {
        Vec3d f = ActiveAirfield.HeadingForward(0);
        Assert.True(Math.Abs(f.X) < 1e-12);
        Assert.Equal(1, f.Z);
        Vec3d east = ActiveAirfield.HeadingForward(Math.PI / 2);
        Assert.Equal(1, east.X);
        Assert.True(Math.Abs(east.Z) < 1e-12);
    }
}
