using System.Collections.Generic;
using System.Linq;
using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>Port of src/script/state/spawnSearch.test.ts.</summary>
public class SpawnSearchTests
{
    private static readonly TerrainArea[] Areas =
    {
        new("gc", -18, 27, -13, 29.5),
        new("DACH", 5.8, 45.8, 17.2, 55.1),
    };

    private static AirfieldEntry Field(string icao, string iata, string name, string area, double lengthM) =>
        new() { Icao = icao, Iata = iata, Name = name, Area = area, Lat = 0, Lon = 0, LengthM = lengthM };

    private static readonly AirfieldEntry[] Fields =
    {
        Field("GCLP", "LPA", "Gran Canaria Airport", "gc", 3100),
        Field("GCXO", "TFN", "Tenerife Norte", "gc", 3400),
        Field("EDDF", "FRA", "Frankfurt am Main", "DACH", 4000),
        Field("EDFE", "", "Flugplatz Frankfurt-Egelsbach", "DACH", 1400),
        Field("LSZH", "ZRH", "Zürich Airport", "DACH", 3700),
        Field("", "", "Segelfluggelände Hornberg", "DACH", 600),
    };

    // searchAirfields

    [Fact]
    public void PutsAnExactIcaoOrIataFirst()
    {
        Assert.Equal("EDDF", SpawnSearch.SearchAirfields(Fields, "eddf")[0].Icao);
        Assert.Equal("GCLP", SpawnSearch.SearchAirfields(Fields, "LPA")[0].Icao);
    }

    [Fact]
    public void MatchesEveryWordOfANameLongestRunwayFirstAmongEquals()
    {
        var hits = SpawnSearch.SearchAirfields(Fields, "frankfurt");
        Assert.Equal(new[] { "EDDF", "EDFE" }, hits.Select(h => h.Icao));
    }

    [Fact]
    public void IgnoresAccentsAndNeedsAllWords()
    {
        Assert.Equal("LSZH", SpawnSearch.SearchAirfields(Fields, "zurich")[0].Icao);
        Assert.Empty(SpawnSearch.SearchAirfields(Fields, "frankfurt zurich"));
    }

    [Fact]
    public void FindsAirfieldsWithNoIcaoByName()
    {
        Assert.Equal("Segelfluggelände Hornberg", SpawnSearch.SearchAirfields(Fields, "hornberg")[0].Name);
    }

    [Fact]
    public void ReturnsNothingForAnEmptyQuery()
    {
        Assert.Empty(SpawnSearch.SearchAirfields(Fields, "  "));
    }

    // airfieldDestination

    [Fact]
    public void KeysByIcaoFallingBackToTheNameAndFlagsAnotherArea()
    {
        var here = SpawnSearch.AirfieldDestination(Fields[0], "gc");
        Assert.Equal("GCLP", here.AirfieldKey);
        Assert.DoesNotContain("reloads", here.Detail);
        var there = SpawnSearch.AirfieldDestination(Fields[5], "gc");
        Assert.Equal("Segelfluggelände Hornberg", there.AirfieldKey);
        Assert.Contains("DACH (reloads)", there.Detail);
    }

    // parseCoordinates

    [Fact]
    public void ReadsDecimalPairsInCommonForms()
    {
        Assert.Equal((47.45, 8.56), SpawnSearch.ParseCoordinates("47.45, 8.56"));
        Assert.Equal((27.93, -15.39), SpawnSearch.ParseCoordinates("27.93 -15.39"));
        Assert.Equal((27.93, -15.39), SpawnSearch.ParseCoordinates("27.93N 15.39W"));
        Assert.Equal((-33.9, 18.6), SpawnSearch.ParseCoordinates("33.9° S, 18.6° E"));
    }

    [Fact]
    public void RejectsNamesAndOutOfRangeValues()
    {
        Assert.Null(SpawnSearch.ParseCoordinates("Zurich"));
        Assert.Null(SpawnSearch.ParseCoordinates("95, 10"));
        Assert.Null(SpawnSearch.ParseCoordinates("10, 200"));
    }

    // coordinateDestination

    [Fact]
    public void FindsTheAreaOrSaysThereIsNoTerrain()
    {
        Assert.Equal("DACH", SpawnSearch.CoordinateDestination(48, 11, Areas, "gc").Area);
        var nowhere = SpawnSearch.CoordinateDestination(0, 0, Areas, "gc");
        Assert.Null(nowhere.Area);
        Assert.Contains("no terrain", nowhere.Detail);
    }

    // placesFromNominatim

    [Fact]
    public void ListsStartablePlacesFirstAndSkipsBadCoordinates()
    {
        var output = SpawnSearch.PlacesFromNominatim(new List<NominatimPlace>
        {
            new() { Lat = "40.7", Lon = "-74.0", Name = "New York", DisplayName = "New York, United States", Type = "city" },
            new() { Lat = "x", Lon = "1", DisplayName = "Broken" },
            new() { Lat = "48.14", Lon = "11.58", Name = "München", DisplayName = "München, Bayern, Deutschland", Addresstype = "city" },
        }, Areas, "gc");
        Assert.Equal(new[] { "München", "New York" }, output.Select(p => p.Label));
        Assert.Equal("DACH", output[0].Area);
        Assert.Null(output[1].Area);
        Assert.StartsWith("city · Bayern, Deutschland", output[0].Detail);
    }

    // searchPlaces: the request itself is the Unity layer's; what is ported is the URL it asks for.

    [Fact]
    public void AsksNominatimWithTheQueryEncoded()
    {
        Assert.Contains("q=Santa%20Cruz", SpawnSearch.NominatimSearchUrl("Santa Cruz"));
        Assert.Null(SpawnSearch.NominatimSearchUrl("   "));
    }

    // Not in the TS tests: JS-semantics edges, values checked against the TS running in node.

    [Fact]
    public void MatchesTheTsOnWhitespaceSeparatorsAndRanking()
    {
        Assert.Equal((47.45, 8.56), SpawnSearch.ParseCoordinates("47.45, 8.56\n"));
        Assert.Equal((47.45, 8.56), SpawnSearch.ParseCoordinates($"47.45{(char)0xa0},{(char)0x3000} 8.56"));
        Assert.Equal((47.45, 8.56), SpawnSearch.ParseCoordinates("47.45 ; 8.56"));
        Assert.Null(SpawnSearch.ParseCoordinates("47.45,,8.56"));

        var entries = new[]
        {
            Field("AB", "", "Zz", "", 1),
            Field("", "", "Ab-cd", "", 2),
            Field("", "", "Xcd ab", "", 3),
            Field("", "", "xxabxx", "", 4),
        };
        var expected = new[] { "Zz", "Xcd ab", "Ab-cd", "xxabxx" };
        Assert.Equal(expected, SpawnSearch.SearchAirfields(entries, $" a{(char)0xa0}b,, ").Select(e => e.Name));
        Assert.Equal(expected, SpawnSearch.SearchAirfields(entries, "ab").Select(e => e.Name));
    }

    [Fact]
    public void FormatsLikeTheTs()
    {
        Assert.Equal("-0.00000, 180.00000", SpawnSearch.CoordinateDestination(-0.0000049, 179.999995, Areas.Take(0).ToList(), "gc").Label);

        var d = SpawnSearch.AirfieldDestination(Field("", "", "", "x", 2499.5), "gc");
        Assert.Equal("Unnamed airfield", d.Label);
        Assert.Equal("2500 m runway · x (reloads)", d.Detail);
        Assert.Equal("", d.AirfieldKey);

        var p = SpawnSearch.PlacesFromNominatim(new List<NominatimPlace>
        {
            new() { Lat = " 1e1 ", Lon = "0x10", DisplayName = "A, B, C, D, E", Addresstype = "admin_level_x" },
        }, new List<TerrainArea>(), "gc");
        Assert.Single(p);
        Assert.Equal("A", p[0].Label);
        Assert.Equal("admin level x · C, D, E · no terrain baked here", p[0].Detail);
        Assert.Equal((10.0, 16.0), (p[0].Lat, p[0].Lon));
    }

    // savePendingDestination / takePendingDestination over an injected store.

    private sealed class MemoryStore : IPendingDestinationStore
    {
        public SpawnDestination Saved;
        public void Write(SpawnDestination d) => Saved = d;
        public SpawnDestination Read() => Saved;
        public void Remove() => Saved = null;
    }

    [Fact]
    public void TakesAPendingDestinationOnceAndDropsANonFiniteOne()
    {
        var store = new MemoryStore();
        SpawnSearch.SavePendingDestination(store, SpawnSearch.CoordinateDestination(48, 11, Areas, "gc"));
        Assert.Equal("DACH", SpawnSearch.TakePendingDestination(store)!.Area);
        Assert.Null(SpawnSearch.TakePendingDestination(store));
        SpawnSearch.SavePendingDestination(store, new SpawnDestination { Lat = double.NaN, Lon = 1 });
        Assert.Null(SpawnSearch.TakePendingDestination(store));
    }
}
