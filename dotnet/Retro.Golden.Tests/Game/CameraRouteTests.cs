using Retro.Game;
using Xunit;

namespace Retro.Golden.Tests.Game;

/// <summary>Port of src/script/state/cameraRoute.test.ts.</summary>
public class CameraRouteTests
{
    private static CameraRoute R(double lat, double lon, double alt, double hdg, double pitch) => new(lat, lon, alt, hdg, pitch);

    // parseCameraRoute

    [Fact]
    public void ReadsAGoogleMapsStyleViewFromTheQuery()
    {
        Assert.Equal(R(28.1, -15.4, 500, 90, -10), CameraRoutes.ParseCameraRoute("?@28.1,-15.4,500a,90h,80t"));
    }

    [Fact]
    public void TakesTheAtPartOfAMapsUrlAsPastedIgnoringWhatItDoesNotUse()
    {
        Assert.Equal(R(46.5584197, 7.9853448, 2499.83, 150.27, 84.97 - 90),
            CameraRoutes.ParseCameraRoute("?@46.5584197,7.9853448,2499.83a,35y,150.27h,84.97t/data=!3m1!1e3"));
        Assert.Equal(R(46.55, 7.98, 1000, 0, 0), CameraRoutes.ParseCameraRoute("?@46.55,7.98,15z"));
        Assert.Equal(1200, CameraRoutes.ParseCameraRoute("?@46.55,7.98,1200m")?.AltM);
    }

    [Fact]
    public void StillReadsTheOlderNamedParameters()
    {
        Assert.Equal(R(28.1, -15.4, 500, 90, -10),
            CameraRoutes.ParseCameraRoute("?lat=28.1&lng=-15.4&alt=500&hdg=90&pitch=-10"));
    }

    [Fact]
    public void DefaultsAltitudeHeadingAndPitchAndReadsTheFragmentToo()
    {
        Assert.Equal(R(28.1, -15.4, 1000, 0, 0), CameraRoutes.ParseCameraRoute("", "#@28.1,-15.4"));
        Assert.Equal(R(28.1, -15.4, 1000, 0, 0), CameraRoutes.ParseCameraRoute("", "#lat=28.1&lng=-15.4"));
    }

    [Fact]
    public void WrapsHeadingAndClampsPitch()
    {
        var r = CameraRoutes.ParseCameraRoute("?@0,0,-90h,210t");
        Assert.Equal(270, r?.HeadingDeg);
        Assert.Equal(89, r?.PitchDeg);
        Assert.Equal(-89, CameraRoutes.ParseCameraRoute("?@0,0,0t")?.PitchDeg);
    }

    [Fact]
    public void RejectsAbsentOrMalformedRoutes()
    {
        Assert.Null(CameraRoutes.ParseCameraRoute(""));
        Assert.Null(CameraRoutes.ParseCameraRoute("?@1"));
        Assert.Null(CameraRoutes.ParseCameraRoute("?@1,x"));
        Assert.Null(CameraRoutes.ParseCameraRoute("?@95,0"));
        Assert.Null(CameraRoutes.ParseCameraRoute("?@1,2,abc"));
        Assert.Null(CameraRoutes.ParseCameraRoute("?lat=1"));
        Assert.Null(CameraRoutes.ParseCameraRoute("?lat=1&lng=x"));
        Assert.Null(CameraRoutes.ParseCameraRoute("?camera=1,2,3"));
    }

    // formatCameraRoute

    [Fact]
    public void RoundTripsThroughTheParserAtSensiblePrecision()
    {
        var route = R(45.93001234, 6.87, 2500.4, 150.3, -5);
        Assert.Equal("@45.93001,6.87,2500a,150h,85t", CameraRoutes.FormatCameraRoute(route));
        Assert.Equal(R(45.93001, 6.87, 2500, 150, -5),
            CameraRoutes.ParseCameraRoute(CameraRoutes.SearchWithCameraRoute("", route)));
    }

    // searchWithCameraRoute

    private static readonly CameraRoute Route = R(1, 2, 3, 4, 5);

    [Fact]
    public void WritesTheViewUnescapedAndKeepsOtherParameters()
    {
        Assert.Equal("?@1,2,3a,4h,95t", CameraRoutes.SearchWithCameraRoute("", Route));
        Assert.Equal("?@1,2,3a,4h,95t&x=1", CameraRoutes.SearchWithCameraRoute("?@9,9,9a&x=1", Route));
        Assert.Equal("?@1,2,3a,4h,95t&x=1", CameraRoutes.SearchWithCameraRoute("?%409,9&x=1", Route));
    }

    [Fact]
    public void ReplacesTheOlderNamedParameters()
    {
        Assert.Equal("?@1,2,3a,4h,95t&x=1", CameraRoutes.SearchWithCameraRoute("?lat=9&x=1&hdg=7", Route));
    }

    // Not in the TS tests: the JS-semantics edges the port has to reproduce.

    [Fact]
    public void FollowsJsNumberParsingAndFormatting()
    {
        // Number(' 5 ') trims, Number('0x10') is hex, '1e3' is decimal, '5.' is fine.
        Assert.Equal(R(5, 16, 1000, 0, 0), CameraRoutes.ParseCameraRoute("?lat=%205%20&lng=0x10"));
        Assert.Equal(R(5, 1, 1000, 0, 0), CameraRoutes.ParseCameraRoute("?@5.,1e0"));
        // A key that does not percent-decode is kept as written.
        Assert.Equal("?@1,2,3a,4h,95t&%zz=1", CameraRoutes.SearchWithCameraRoute("?%zz=1", Route));
        // -0 prints as 0; tiny values print without exponent once fixed.
        Assert.Equal("@0,0.00001,0a,0h,90t", CameraRoutes.FormatCameraRoute(R(-0.000001, 0.00001, -0.4, -0.2, 0)));
        // toFixed rounds the exact binary value half up; 1e21 and over print in exponent form.
        Assert.Equal("@1.005,-180,1e+21a,360h,90t", CameraRoutes.FormatCameraRoute(R(1.005, -179.999995, 1e21, 359.5, -0.5)));
    }

    [Fact]
    public void ReadsTokensAndParametersTheWayTheBrowserDoes()
    {
        // Values checked against the TS running in node.
        Assert.Equal(R(1, 2, 0.5, 0, 0), CameraRoutes.ParseCameraRoute("?@1,2,+.5a,-1.5e", "#x"));
        Assert.Equal(R(1, 2, 3, 0, 0), CameraRoutes.ParseCameraRoute("?@1,2,3a\n"));
        // The query's view wins over the fragment's.
        Assert.Equal(R(1, 2, 1000, 0, 0), CameraRoutes.ParseCameraRoute("?x=1&@1,2", "#@3,4"));
    }
}
