using System;
using Retro.Core;
using Retro.Terrain;
using Xunit;

namespace Retro.Golden.Tests;

/// <summary>CoverTexture: the far-tile texture frame (coverFrame) and mip chain (buildCoverMips).</summary>
public class CoverTextureTests
{
    [Theory]
    [InlineData(10, 486, 435, 28.0, -15.4)]
    [InlineData(6, 34, 21, 48.1, 11.6)]
    [InlineData(8, 136, 87, 52.5, 13.4)]
    public void FrameMapsPositionsToTheTilesLonLatFractions(int z, int x, int y, double lat0, double lon0)
    {
        EnuBasis basis = Geodesy.MakeEnuBasis(lat0, lon0);
        var id = new TileKey(z, x, y);
        LonLatBounds b = Tiling.Bounds(id);
        const double quant = 0.75;
        CoverFrame f = CoverTexture.Frame(id, basis, quant);
        Vec3d At(double lat, double lon)
        {
            Enu e = Geodesy.EcefToEnu(basis, Geodesy.GeodeticToEcef(lat, lon, 0));
            return new Vec3d(e.E, e.U, -e.N);
        }
        Vec3d centre = At((b.South + b.North) / 2, (b.West + b.East) / 2);
        foreach (var (fu, fv) in new[] { (0.5, 0.5), (0.1, 0.2), (0.9, 0.85), (0.3, 0.95) })
        {
            double lat = b.North - fv * (b.North - b.South);
            double lon = b.West + fu * (b.East - b.West);
            // A tile position is its offset from the centre in quantisation steps.
            Vec3d raw = (At(lat, lon) - centre) * (1 / quant);
            double coverE = Vec3d.Dot(raw, f.East), coverN = Vec3d.Dot(raw, f.North);
            double u = 0.5 + coverE / (1 - f.K * coverN);
            double v = 0.5 - coverN;
            // To half a percent of the tile: the frame is first-order by design (a z6 tile is 5 degrees).
            Assert.True(Math.Abs(u - fu) < 5e-3, $"u {u} vs {fu}");
            Assert.True(Math.Abs(v - fv) < 5e-3, $"v {v} vs {fv}");
        }
    }

    [Fact]
    public void MipsAverageColourAndTakeTheFirstDataClass()
    {
        byte nd = PtxCodec.NoData;
        byte[] level0 =
        {
            10, 20, 30, nd,   100, 50, 0, 7,
            200, 60, 1, 3,    0, 0, 0, nd,
        };
        var mips = CoverTexture.Mips(level0, 2);
        Assert.Equal(2, mips.Count);
        Assert.Equal(new byte[] { 150, 55, 1, 7 }, mips[1]);
        var empty = CoverTexture.Mips(new byte[] { 1, 2, 3, nd, 4, 5, 6, nd, 7, 8, 9, nd, 1, 1, 1, nd }, 2);
        Assert.Equal(new byte[] { 0, 0, 0, nd }, empty[1]);
    }
}
