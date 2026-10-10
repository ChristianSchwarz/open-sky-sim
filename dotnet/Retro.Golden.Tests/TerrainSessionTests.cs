using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Terrain;
using Xunit;
using Xunit.Abstractions;

namespace Retro.Golden.Tests;

/// <summary>
/// Integration check of the Unity spike's terrain core against the real baked
/// pyramid in assets/terrain (local only: the tree is not in git). Skips
/// quietly when it is absent.
/// </summary>
public class TerrainSessionTests
{
    private readonly ITestOutputHelper output;

    public TerrainSessionTests(ITestOutputHelper output) => this.output = output;

    private static string TerrainRoot => Path.GetFullPath(Path.Combine(Golden.Root, "..", "..", "assets", "terrain"));

    [Fact]
    public void StreamsAndDrawsGranCanaria()
    {
        if (!File.Exists(Path.Combine(TerrainRoot, "manifest.json")))
        {
            output.WriteLine($"skipped: no baked terrain at {TerrainRoot}");
            return;
        }
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(TerrainRoot, "manifest.json")));
        JsonElement m = doc.RootElement;
        JsonElement mesh = m.GetProperty("mesh"), origin = m.GetProperty("enuOrigin");
        var session = new TerrainSession(new TerrainSessionOptions
        {
            Root = TerrainRoot,
            LevelGeometricErrorM = mesh.GetProperty("levelGeometricErrorM").EnumerateArray().Select(e => e.GetDouble()).ToArray(),
            MaxZoom = mesh.GetProperty("maxZoom").GetInt32(),
            BakeLat = origin.GetProperty("lat").GetDouble(), BakeLon = origin.GetProperty("lon").GetDouble(), BakeHeight = 0,
            OriginLat = origin.GetProperty("lat").GetDouble(), OriginLon = origin.GetProperty("lon").GetDouble(), OriginHeight = 0,
        });

        // Over Gran Canaria at 3 km, looking north and down 15 degrees.
        Vec3d pos = Geodesy.GeodeticToWorld(session.Basis, 27.85, -15.55, 3000);
        Quatd look = Quatd.FromAxisAngle(new Vec3d(1, 0, 0), -15 * Math.PI / 180);
        var view = new TerrainView
        {
            Position = pos, Orientation = look, FovYDeg = 50, Aspect = 16.0 / 9, ScreenHeightPx = 720, NowMs = 0,
        };

        int frames = 0;
        for (; frames < 400; frames++)
        {
            view.NowMs = frames * 100;
            session.Update(view);
            if (session.WantCount == 0 && session.Meshes.InFlight == 0) break;
            session.Meshes.WaitIdle(TimeSpan.FromSeconds(30));
        }
        output.WriteLine($"settled after {frames} reconciles: {session.DrawList.Count} tiles drawn, "
            + $"{session.Meshes.Count} resident ({session.Meshes.ResidentBytes / 1048576.0:F1} MB), failures {session.Meshes.Failures} {session.Meshes.LastError}");
        var zooms = session.DrawList.GroupBy(d => d.Key.Z).OrderBy(g => g.Key).Select(g => $"z{g.Key}:{g.Count()}");
        output.WriteLine(string.Join(" ", zooms));

        Assert.Equal(0, session.Meshes.Failures);
        Assert.Equal(0, session.WantCount);
        Assert.True(session.DrawList.Count > 20, "too few tiles drawn");
        Assert.Contains(session.DrawList, d => d.Key.Z == 12);
        // Same origin as the bake: no frame fix.
        Assert.Equal(1.0, Math.Abs(session.FrameFix.W), 12);
    }
}
