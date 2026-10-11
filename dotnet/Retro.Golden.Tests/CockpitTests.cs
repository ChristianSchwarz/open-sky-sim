using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Replays tests/golden/cockpit.json: the cockpit MFDs, attitude indicator,
/// device stack and moving map painted through the RecordingPainter, frame by
/// frame with one renderer per sequence (so the map's raster cache, ancestor
/// fallback and image identity carry over), plus the target camera pose,
/// every sidecar request and every raster built. Also ports cockpit.test.ts
/// and movingMap.test.ts.
/// </summary>
public class CockpitTests
{
    private static readonly JsonElement Cockpit = Load("cockpit.json");

    private static Palette PaletteByName(string name) => name switch
    {
        "noon" => Palettes.HdNoon,
        "midnight" => Palettes.HdMidnight,
        "nightvision" => Palettes.HdNightVision,
        _ => throw new ArgumentException(name),
    };

    private static string Hash(byte[] a) => Structural.Fnv1a32(a).ToString("x8");

    /// <summary>The suite's stubTile: a formula of the key, some texels no-data.</summary>
    private static PtxTile StubTile(TileKey id, int size)
    {
        int n = size * size;
        var texels = new byte[n * 4];
        for (int i = 0; i < n; i++)
        {
            int o = i * 4;
            texels[o] = (byte)((id.X * 31 + i * 7) & 255);
            texels[o + 1] = (byte)((id.Y * 17 + i * 13) & 255);
            texels[o + 2] = (byte)((id.Z * 29 + i * 5) & 255);
            texels[o + 3] = (byte)((i + id.X + id.Y) % 5 == 0 ? 255 : (i + id.Z) % 12);
        }
        return new PtxTile { Id = id, Size = size, Texels = texels };
    }

    /// <summary>The suite's StubMapSource.</summary>
    private sealed class StubSource : IMapTileSource
    {
        private readonly int size;
        public readonly HashSet<string> Loaded = new();
        public readonly HashSet<string> Pending = new();
        public readonly List<(string Key, double Priority)> Requests = new();

        public StubSource(int min, int max, int size)
        {
            ZoomMin = min;
            ZoomMax = max;
            this.size = size;
        }

        public int ZoomMin { get; }
        public int ZoomMax { get; }
        public int TexelsAt(int z) => z >= 10 ? 512 : 256;

        private static bool Exists(TileKey id) => id.Z <= 11 && !(id.Z >= 9 && (id.X * 7 + id.Y * 3) % 11 == 0);

        public PtxTile Sidecar(TileKey id, double priority)
        {
            string key = id.ToString();
            Requests.Add((key, priority));
            if (Exists(id) && (id.Z <= 6 || Loaded.Contains(key))) return StubTile(id, size);
            if (priority > 0 && Exists(id)) Pending.Add(key);
            return null;
        }

        public void Tick()
        {
            foreach (string k in Pending) Loaded.Add(k);
            Pending.Clear();
        }
    }

    private sealed class RecordingRasters : IMapRasterFactory
    {
        public readonly List<(string Tile, int Size, byte[] Rgba)> Created = new();
        public int Released;

        public object Create(TileKey id, int size, byte[] rgba)
        {
            Created.Add((id.ToString(), size, rgba));
            return new object();
        }

        public void Release(object raster) => Released++;
    }

    private static CockpitDeviceState Device(JsonElement f, string prop) => (CockpitDeviceState)f.GetProperty(prop).GetInt32();

    private static double? OptNum(JsonElement o, string prop) =>
        o.TryGetProperty(prop, out JsonElement v) && v.ValueKind != JsonValueKind.Null ? Num(v) : null;

    private static string OptStr(JsonElement o, string prop) =>
        o.TryGetProperty(prop, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static CockpitTarget Target(JsonElement o) => new()
    {
        Position = V3(o.GetProperty("position")),
        LocalCenter = V3(o.GetProperty("localCenter")),
        MaxSize = Num(o, "maxSize"),
        TargetType = o.GetProperty("targetType").GetString()!,
        TargetLocation = o.GetProperty("targetLocation").GetString()!,
        Airborne = o.GetProperty("airborne").GetBoolean(),
        SpeedMps = OptNum(o, "targetSpeedMps"),
        LoadFactorG = OptNum(o, "targetLoadFactorG"),
        HealthFraction = OptNum(o, "targetHealthFraction"),
        StickPitch = OptNum(o, "targetStickPitch"),
        StickRoll = OptNum(o, "targetStickRoll"),
        Throttle = OptNum(o, "targetThrottle"),
        Maneuver = OptStr(o, "targetManeuver"),
    };

    private static CockpitInputs Inputs(JsonElement f)
    {
        CockpitTarget[] objects = f.GetProperty("objects").EnumerateArray().Select(Target).ToArray();
        JsonElement target = f.GetProperty("target");
        return new CockpitInputs
        {
            DisplayPosition = V3(f.GetProperty("position")),
            DisplayQuaternion = Q(f.GetProperty("quaternion")),
            LandingGear = Device(f, "landingGear"),
            Flaps = Device(f, "flaps"),
            Airbrakes = Device(f, "airbrakes"),
            Tailhook = Device(f, "tailhook"),
            WheelBrakesApplied = f.GetProperty("wheelBrakes").GetBoolean(),
            BarricadeStatus = OptStr(f, "barricade"),
            Contacts = f.GetProperty("contacts").EnumerateArray().Select(k => objects[k.GetInt32()]).ToArray(),
            Target = target.ValueKind == JsonValueKind.Null ? null : objects[target.GetInt32()],
            MainCamera = new CameraPose(Num(f, "fov"), Num(f, "aspect"), 1, 10000),
            Colors = CockpitColors.FromPalette(PaletteByName(f.GetProperty("palette").GetString()!)),
        };
    }

    [Fact]
    public void SequencesMatchTheOracle()
    {
        var m = new Mismatches();
        int tileSize = Cockpit.GetProperty("stubTileSize").GetInt32();
        int frames = 0, calls = 0, rasters = 0, images = 0;
        foreach (JsonElement seq in Cockpit.GetProperty("sequences").EnumerateArray())
        {
            string name = seq.GetProperty("name").GetString()!;
            JsonElement zr = seq.GetProperty("zoomRange");
            double[] basisLatLon = Nums(seq, "basis");
            StubSource source = zr.ValueKind == JsonValueKind.Null ? null
                : new StubSource(zr.GetProperty("min").GetInt32(), zr.GetProperty("max").GetInt32(), tileSize);
            var factory = new RecordingRasters();
            var cockpit = new CockpitRenderer(source == null ? null : new MovingMapSource
            {
                Basis = Geodesy.MakeEnuBasis(basisLatLon[0], basisLatLon[1]),
                Tiles = source,
                Rasters = factory,
            });
            var painter = new RecordingPainter();
            int i = 0;
            foreach (JsonElement fr in seq.GetProperty("frames").EnumerateArray())
            {
                string at = $"{name} frame {i}";
                JsonElement f = fr.GetProperty("input");
                source?.Tick();
                source?.Requests.Clear();
                factory.Created.Clear();

                CockpitInputs inputs = Inputs(f);
                cockpit.SetMovingMapEnabled(f.GetProperty("mapEnabled").GetBoolean());
                int start = painter.Calls.Count;
                CockpitFrame frame = cockpit.Render(Num(f, "width"), Num(f, "height"), inputs, painter);
                List<object[]> got = painter.Calls.GetRange(start, painter.Calls.Count - start);

                PainterCalls.AssertSame(fr.GetProperty("calls"), got, at);
                calls += got.Count;
                images += got.Count(c => (string)c[0] == "image");
                m.Equal($"{at} movingMapEnabled", fr.GetProperty("movingMapEnabled").GetBoolean(), cockpit.MovingMapEnabled);
                m.Equal($"{at} map drawn", fr.GetProperty("movingMapEnabled").GetBoolean(), frame.MovingMapDrawn);

                JsonElement tc = fr.GetProperty("targetCamera");
                m.Equal($"{at} target camera present", tc.ValueKind != JsonValueKind.Null, frame.TargetCamera != null);
                if (tc.ValueKind != JsonValueKind.Null && frame.TargetCamera != null)
                {
                    CameraPose c = frame.TargetCamera;
                    double[] p = Nums(tc, "position");
                    double[] q = Nums(tc, "quaternion");
                    m.Equal($"{at} camera position", string.Join(",", p), string.Join(",", new[] { c.Position.X, c.Position.Y, c.Position.Z }));
                    m.Equal($"{at} camera quaternion", string.Join(",", q), string.Join(",", new[] { c.Quaternion.X, c.Quaternion.Y, c.Quaternion.Z, c.Quaternion.W }));
                    m.Equal($"{at} camera fov", Num(tc, "fov"), c.Fov);
                    m.Equal($"{at} camera near", Num(tc, "near"), c.Near);
                    m.Equal($"{at} camera far", Num(tc, "far"), c.Far);
                    m.Equal($"{at} zoom", 50 / Num(tc, "fov"), frame.TargetZoomFactor);
                }

                string[] wantReq = fr.GetProperty("requests").EnumerateArray()
                    .Select(r => r[0].GetString() + "@" + Num(r[1])).ToArray();
                string[] gotReq = source == null ? new string[0] : source.Requests.Select(r => r.Key + "@" + r.Priority).ToArray();
                m.Equal($"{at} requests", string.Join(" ", wantReq), string.Join(" ", gotReq));

                JsonElement[] wantRasters = fr.GetProperty("rasters").EnumerateArray().ToArray();
                m.Equal($"{at} raster count", wantRasters.Length, factory.Created.Count);
                for (int k = 0; k < Math.Min(wantRasters.Length, factory.Created.Count); k++)
                {
                    JsonElement w = wantRasters[k];
                    var g = factory.Created[k];
                    m.Equal($"{at} raster {k} tile", w.GetProperty("tile").GetString(), g.Tile);
                    m.Equal($"{at} raster {k} size", w.GetProperty("size").GetInt32(), g.Size);
                    m.Equal($"{at} raster {k} hash", w.GetProperty("hash").GetString(), Hash(g.Rgba));
                    if (w.TryGetProperty("rgba", out JsonElement dump))
                    {
                        m.Equal($"{at} raster {k} rgba", string.Join(",", dump.EnumerateArray().Select(x => x.GetInt32())), string.Join(",", g.Rgba));
                    }
                    rasters++;
                }
                frames++;
                i++;
            }
            m.Equal($"{name} movingMapAvailable", seq.GetProperty("movingMapAvailable").GetBoolean(), cockpit.MovingMapAvailable);
            if (name == "flight")
            {
                // The flight overflows the 48-raster cache.
                Assert.True(factory.Released > 0, "flight evicted nothing");
                Assert.Equal(MovingMapGeometry.RasterCache, cockpit.MovingMap!.CachedRasters);
            }
        }
        m.AssertNone();
        Assert.True(frames >= 150, $"{frames} frames");
        Assert.True(calls > 10000 && rasters > 100 && images > 200, $"{calls} calls, {rasters} rasters, {images} images");
    }

    [Fact]
    public void FunctionsMatchTheOracle()
    {
        var m = new Mismatches();
        JsonElement fn = Cockpit.GetProperty("functions");

        foreach (JsonElement c in fn.GetProperty("layout").EnumerateArray())
        {
            double w = Num(c, "width"), h = Num(c, "height");
            string at = $"layout {w}x{h}";
            double s = CockpitLayout.MfdSize(h, w);
            m.Equal($"{at} size by height", Num(c, "sizeByHeight"), CockpitLayout.MfdSize(h));
            m.Equal($"{at} size", Num(c, "size"), s);
            double[] mfd1 = Nums(c, "mfd1"), mfd2 = Nums(c, "mfd2");
            m.Equal($"{at} mfd1", $"{mfd1[0]},{mfd1[1]}", $"{CockpitLayout.Mfd1X(w, h, s)},{CockpitLayout.Mfd1Y(w, h, s)}");
            m.Equal($"{at} mfd2", $"{mfd2[0]},{mfd2[1]}", $"{CockpitLayout.Mfd2X(w, h, s)},{CockpitLayout.Mfd2Y(w, h, s)}");
            CockpitViewport v = CockpitLayout.Mfd2(w, h);
            m.Equal($"{at} mfd2 viewport", $"{mfd2[0]},{mfd2[1]},{s}", $"{v.X},{v.Y},{v.Size}");
        }

        foreach (JsonElement c in fn.GetProperty("scopeRange").EnumerateArray())
        {
            double? km = c[0].ValueKind == JsonValueKind.Null ? null : Num(c[0]);
            m.Equal($"scope range {km}", Num(c[1]), TacticalScope.Range(km));
        }

        int pi = 0;
        foreach (JsonElement c in fn.GetProperty("plots").EnumerateArray())
        {
            TacticalPlot p = TacticalScope.Plot(Num(c, "dx"), Num(c, "dz"), Num(c, "heading"), Num(c, "rangeKm"), Num(c, "radius"));
            m.Equal($"plot {pi} x", Num(c, "x"), p.X);
            m.Equal($"plot {pi} y", Num(c, "y"), p.Y);
            m.Equal($"plot {pi} offScope", c.GetProperty("offScope").GetBoolean(), p.OffScope);
            pi++;
        }

        Func<int, int> texelsAt = z => z >= 10 ? 512 : 256;
        foreach (JsonElement c in fn.GetProperty("zooms").EnumerateArray())
        {
            double mpp = Num(c, "metresPerPixel");
            m.Equal($"zoom {mpp}", c.GetProperty("z").GetInt32(), MovingMapGeometry.Zoom(mpp, texelsAt, 4, 11));
            m.Equal($"zoom narrow {mpp}", c.GetProperty("zNarrow").GetInt32(), MovingMapGeometry.Zoom(mpp, texelsAt, 7, 9));
        }
        foreach (JsonElement c in fn.GetProperty("texel").EnumerateArray())
        {
            int z = c[0].GetInt32();
            m.Equal($"texel {z}/256", Num(c[1]), MovingMapGeometry.TexelMetres(z, 256));
            m.Equal($"texel {z}/512", Num(c[2]), MovingMapGeometry.TexelMetres(z, 512));
        }
        int k = 0;
        foreach (JsonElement c in fn.GetProperty("placements").EnumerateArray())
        {
            int[] id = c.GetProperty("id").EnumerateArray().Select(x => x.GetInt32()).ToArray();
            MapTilePlacement p = MovingMapGeometry.Place(new TileKey(id[0], id[1], id[2]), Num(c, "lat"), Num(c, "lon"));
            m.Equal($"place {k} x", Num(c, "x"), p.X);
            m.Equal($"place {k} y", Num(c, "y"), p.Y);
            m.Equal($"place {k} w", Num(c, "width"), p.Width);
            m.Equal($"place {k} h", Num(c, "height"), p.Height);
            k++;
        }
        k = 0;
        foreach (JsonElement c in fn.GetProperty("inView").EnumerateArray())
        {
            List<TileKey> ids = MovingMapGeometry.TilesInView(c.GetProperty("z").GetInt32(), Num(c, "lat"), Num(c, "lon"), Num(c, "halfExtentM"));
            m.Equal($"in view {k}", string.Join(" ", c.GetProperty("tiles").EnumerateArray().Select(x => x.GetString())), string.Join(" ", ids));
            k++;
        }
        foreach (JsonElement c in fn.GetProperty("colors").EnumerateArray())
        {
            string s = c[0].GetString()!;
            m.Equal($"color '{s}'", string.Join(",", c[1].EnumerateArray().Select(x => x.GetInt32())), string.Join(",", MovingMapGeometry.ParseHexColor(s)));
        }
        foreach (JsonElement c in fn.GetProperty("pixels").EnumerateArray())
        {
            byte[] texels = c.GetProperty("texels").EnumerateArray().Select(x => (byte)x.GetInt32()).ToArray();
            byte[] water = c.GetProperty("water").EnumerateArray().Select(x => (byte)x.GetInt32()).ToArray();
            TileKey id = Tiling.Parse(c.GetProperty("id").GetString()!);
            m.Equal($"stub texels {id}", string.Join(",", texels), string.Join(",", StubTile(id, 4).Texels));
            byte[] px = MovingMapGeometry.TilePixels(new PtxTile { Id = id, Size = 4, Texels = texels }, water);
            m.Equal($"pixels {id}", string.Join(",", c.GetProperty("rgba").EnumerateArray().Select(x => x.GetInt32())), string.Join(",", px));
        }
        m.AssertNone();
    }

    // ------------------------------------------------ cockpit.test.ts

    private const double Radius = 28;

    [Fact]
    public void ScopeRangeHoldsTheDefaultAndPicksTheSmallestLadderStep()
    {
        Assert.Equal(TacticalScope.DefaultRangeKm, TacticalScope.Range(null));
        Assert.Equal(5, TacticalScope.Range(0.5));
        Assert.Equal(5, TacticalScope.Range(5));
        Assert.Equal(10, TacticalScope.Range(5.1));
        Assert.Equal(20, TacticalScope.Range(12));
        Assert.Equal(80, TacticalScope.Range(41));
        Assert.Equal(80, TacticalScope.Range(500));
    }

    [Fact]
    public void ContactPlotIsHeadingUpAndScalesWithRange()
    {
        TacticalPlot ahead = TacticalScope.Plot(0, -10000, 0, 20, Radius);
        Assert.True(Math.Abs(ahead.X) < 1e-6 && ahead.Y < 0 && !ahead.OffScope);
        Assert.True(Math.Abs(Math.Sqrt(ahead.X * ahead.X + ahead.Y * ahead.Y) - Radius / 2) < 1e-6);

        TacticalPlot right = TacticalScope.Plot(10000, 0, 0, 20, Radius);
        Assert.True(right.X > 0 && Math.Abs(right.Y) < 1e-6);

        TacticalPlot east = TacticalScope.Plot(10000, 0, 90, 20, Radius);
        Assert.True(Math.Abs(east.X) < 1e-6 && Math.Abs(east.Y + Radius / 2) < 1e-6);
        Assert.True(TacticalScope.Plot(10000, 0, 180, 20, Radius).X < 0);

        Assert.True(TacticalScope.Plot(0, 10000, 0, 20, Radius).Y > 0);
    }

    [Fact]
    public void ContactPlotPinsToTheRimAndParksColocatedContacts()
    {
        TacticalPlot far = TacticalScope.Plot(0, -50000, 0, 20, Radius);
        Assert.True(far.OffScope);
        Assert.True(Math.Abs(Math.Sqrt(far.X * far.X + far.Y * far.Y) - Radius) < 1e-6);
        Assert.True(Math.Abs(far.X) < 1e-6);

        TacticalPlot ring = TacticalScope.Plot(0, -20000, 0, 20, Radius);
        Assert.False(ring.OffScope);
        Assert.True(Math.Abs(Math.Sqrt(ring.X * ring.X + ring.Y * ring.Y) - Radius) < 1e-6);

        TacticalPlot here = TacticalScope.Plot(0.2, -0.3, 45, 20, Radius);
        Assert.Equal(0, here.X);
        Assert.Equal(0, here.Y);
        Assert.False(here.OffScope);
    }

    // ------------------------------------------------ movingMap.test.ts

    private static readonly Func<int, int> ShippedTexels = z => z >= 10 ? 512 : 256;

    [Fact]
    public void MapZoomTakesTheCoarsestZoomWhoseTexelsFitAPixel()
    {
        Assert.True(MovingMapGeometry.TexelMetres(8, 256) > 200);
        Assert.True(MovingMapGeometry.TexelMetres(9, 256) <= 200);
        Assert.Equal(9, MovingMapGeometry.Zoom(200, ShippedTexels, 4, 11));
        Assert.Equal(10, MovingMapGeometry.Zoom(100, ShippedTexels, 4, 11));
        Assert.Equal(9, MovingMapGeometry.Zoom(160, ShippedTexels, 4, 11));
        Assert.Equal(11, MovingMapGeometry.Zoom(1, ShippedTexels, 4, 11));
        Assert.Equal(4, MovingMapGeometry.Zoom(1e6, ShippedTexels, 4, 11));
    }

    [Fact]
    public void MapTilePlacementCentresTheOwnshipTile()
    {
        double lat = 48.1, lon = 11.6;
        TileKey id = Tiling.AtLonLat(10, lon, lat);
        MapTilePlacement place = MovingMapGeometry.Place(id, lat, lon);
        Assert.True(place.X <= 0 && place.X + place.Width >= 0);
        Assert.True(place.Y <= 0 && place.Y + place.Height >= 0);
        MapTilePlacement nw = MovingMapGeometry.Place(new TileKey(id.Z, id.X - 1, id.Y - 1), lat, lon);
        Assert.True(nw.X + nw.Width <= 0);
        Assert.True(nw.Y + nw.Height <= 0);

        var key = new TileKey(10, 1090, 238);
        LonLatBounds b = Tiling.Bounds(key);
        MapTilePlacement p = MovingMapGeometry.Place(key, (b.North + b.South) / 2, b.West);
        Assert.True(p.Width < p.Height);
        Assert.True(Math.Abs(p.Height - (b.North - b.South) * 110540) < 1e-6);
    }

    [Fact]
    public void MapTilesInViewCoverTheOwnshipTile()
    {
        double lat = 48.1, lon = 11.6;
        TileKey own = Tiling.AtLonLat(10, lon, lat);
        List<TileKey> ids = MovingMapGeometry.TilesInView(10, lat, lon, 30000);
        Assert.Contains(ids, t => t.X == own.X && t.Y == own.Y);
        Assert.InRange(ids.Count, 4, 25);
        Assert.All(ids, t => Assert.True(Math.Abs(t.X - own.X) <= 3 && Math.Abs(t.Y - own.Y) <= 3));

        LonLatBounds b = Tiling.Bounds(new TileKey(8, 272, 59));
        Assert.Single(MovingMapGeometry.TilesInView(8, (b.North + b.South) / 2, (b.East + b.West) / 2, 100));
    }

    [Fact]
    public void MapPixelsParseColoursAndPaintNoDataWater()
    {
        Assert.Equal(new byte[] { 0x16, 0x35, 0x5e }, MovingMapGeometry.ParseHexColor("#16355e"));
        Assert.Equal(new byte[] { 0, 0, 0 }, MovingMapGeometry.ParseHexColor("nope"));
        var tile = new PtxTile { Id = new TileKey(4, 0, 0), Size = 1, Texels = new byte[] { 10, 20, 30, 3, 0, 0, 0, PtxCodec.NoData } };
        Assert.Equal(new byte[] { 10, 20, 30, 255, 1, 2, 3, 255 }, MovingMapGeometry.TilePixels(tile, new byte[] { 1, 2, 3 }));
    }

    [Fact]
    public void MapOptionIsANoOpWithoutAChart()
    {
        var none = new CockpitRenderer();
        none.SetMovingMapEnabled(true);
        Assert.False(none.MovingMapAvailable);
        Assert.False(none.MovingMapEnabled);

        var empty = new CockpitRenderer(new MovingMapSource { Tiles = new StubSource(5, 4, 4), Basis = Geodesy.MakeEnuBasis(0, 0) });
        empty.SetMovingMapEnabled(true);
        Assert.False(empty.MovingMapEnabled);

        var chart = new CockpitRenderer(new MovingMapSource { Tiles = new StubSource(4, 11, 4), Basis = Geodesy.MakeEnuBasis(0, 0) });
        chart.SetMovingMapEnabled(true);
        Assert.True(chart.MovingMapEnabled);
        chart.SetMovingMapEnabled(false);
        Assert.False(chart.MovingMapEnabled);
    }
}
