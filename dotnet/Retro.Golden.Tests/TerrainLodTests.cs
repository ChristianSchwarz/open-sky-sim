using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Retro.Core;
using Retro.Terrain;
using Xunit;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>Replays tests/golden/terrain_lod.json: lod.ts functions, horizon culling and quadtree camera paths.</summary>
public class TerrainLodTests
{
    private static readonly JsonElement Fx = Load("terrain_lod.json");

    private static double Inf(JsonElement e) => Num(e);

    [Fact]
    public void LodFunctions()
    {
        var m = new Mismatches();
        JsonElement lod = Fx.GetProperty("lod");
        foreach (JsonElement r in lod.GetProperty("refine").EnumerateArray())
        {
            double err = Num(r, "geometricErrorM"), dist = Num(r, "distanceM"), h = Num(r, "screenHeightPx");
            double fov = Num(r, "fovYDeg"), scale = Num(r, "detailScale"), knee = Num(r, "kneeM");
            m.Equal($"shouldRefine({err}, {dist})", r.GetProperty("shouldRefine").GetBoolean(), Lod.ShouldRefine(err, dist, h, fov, scale));
            m.Close($"refineDistanceM({err})", Num(r, "refineDistanceM"), Lod.RefineDistanceM(err, h, fov, scale, knee), 1e-12);
            m.Close($"detailFalloff({dist}, {knee})", Num(r, "detailFalloff"), Lod.DetailFalloff(dist, knee), 1e-12);
        }
        foreach (JsonElement a in lod.GetProperty("altitude").EnumerateArray())
        {
            double alt = Num(a, "altitudeM");
            m.Close($"viewRange({alt})", Num(a, "terrainViewRangeM"), Lod.TerrainViewRangeM(alt), 1e-12);
            m.Close($"far({alt})", Num(a, "cameraFarForAltitudeM"), Lod.CameraFarForAltitudeM(alt), 1e-12);
            m.Close($"maxZoom12({alt})", Num(a, "maxZoom12"), Lod.TerrainMaxZoomForAltitudeM(alt, 12), 0);
            m.Close($"maxZoom12Coastal({alt})", Num(a, "maxZoom12Coastal"), Lod.TerrainMaxZoomForAltitudeM(alt, 12, true), 0);
            m.Close($"maxZoom9Coastal({alt})", Num(a, "maxZoom9Coastal"), Lod.TerrainMaxZoomForAltitudeM(alt, 9, true), 0);
        }
        foreach (JsonElement s in lod.GetProperty("sagitta").EnumerateArray())
        {
            JsonElement k = s.GetProperty("key");
            var key = new TileKey(k.GetProperty("z").GetInt32(), k.GetProperty("x").GetInt32(), k.GetProperty("y").GetInt32());
            m.Close($"sagitta {key}", Num(s, "ellipsoidSagittaM"), Lod.EllipsoidSagittaM(key), 1e-12);
        }
        foreach (JsonElement s in lod.GetProperty("landuseRevealScale").EnumerateArray())
        {
            m.Close("landuseRevealScale", Num(s, "scale"), Lod.LanduseRevealScale(Num(s, "screenHeightPx"), Num(s, "fovYDeg"), Num(s, "minPx")), 1e-12);
        }
        foreach (JsonElement s in lod.GetProperty("adjustDetailScale").EnumerateArray())
        {
            m.Close("adjustDetailScale", Num(s, "next"), Lod.AdjustDetailScale(Num(s, "current"), Num(s, "frameEmaMs")), 1e-12);
        }
        JsonElement clamps = lod.GetProperty("clamps");
        foreach (JsonElement c in clamps.GetProperty("detailDistance").EnumerateArray()) m.Close("clampDetailDistance", Num(c, "out"), Lod.ClampDetailDistanceM(Num(c, "value")), 0);
        foreach (JsonElement c in clamps.GetProperty("landuseRevealPx").EnumerateArray()) m.Close("clampLanduseRevealPx", Num(c, "out"), Lod.ClampLanduseRevealPx(Num(c, "value")), 0);
        foreach (JsonElement c in clamps.GetProperty("triangleBudget").EnumerateArray()) m.Close("clampTriangleBudget", Num(c, "out"), Lod.ClampTriangleBudget(Num(c, "value")), 0);
        m.Close("frustumCullMarginTan", Num(lod, "frustumCullMarginTan"), Lod.FrustumCullMarginTan, 1e-15);
        m.AssertNone();
    }

    [Fact]
    public void Horizon()
    {
        var m = new Mismatches();
        var earth = new Vec3d(0, -Geodesy.Wgs84A, 0);
        int i = 0;
        foreach (JsonElement h in Fx.GetProperty("horizon").EnumerateArray())
        {
            m.Equal($"horizon {i++}", h.GetProperty("behind").GetBoolean(),
                Culling.BehindHorizon(V3(h.GetProperty("center")), Num(h, "radius"), V3(h.GetProperty("camera")), earth));
        }
        m.AssertNone();
    }

    public static IEnumerable<object[]> Paths() =>
        Fx.GetProperty("paths").EnumerateArray().Select(p => new object[] { p.GetProperty("name").GetString()! });

    [Theory]
    [MemberData(nameof(Paths))]
    public void QuadtreePath(string name)
    {
        JsonElement p = Fx.GetProperty("paths").EnumerateArray().First(x => x.GetProperty("name").GetString() == name);
        string tiles = Path.Combine(Root, "tiles");
        using JsonDocument manifest = JsonDocument.Parse(File.ReadAllText(Path.Combine(tiles, "manifest.json")));
        double[] levelErrors = Nums(manifest.RootElement.GetProperty("mesh"), "levelGeometricErrorM");
        TileIndex index = TileIndex.Decode(File.ReadAllBytes(Path.Combine(tiles, "index", "index_mesh.bin")));

        double[] origin = Nums(p, "basisOrigin");
        EnuBasis basis = Geodesy.MakeEnuBasis(origin[0], origin[1], origin[2]);
        int residentMaxZoom = p.GetProperty("residentMaxZoom").GetInt32();
        var quadtree = new Quadtree(new QuadtreeOptions
        {
            LevelGeometricErrorM = levelErrors,
            MaxZoom = p.GetProperty("maxZoom").GetInt32(),
            TilePosition = id =>
            {
                LonLatBounds b = Tiling.Bounds(id);
                return Geodesy.GeodeticToWorld(basis, (b.South + b.North) / 2, (b.West + b.East) / 2, 0);
            },
            TileRadius = id => Tiling.ApproxEdgeMetres(id) * 0.75,
            IsResident = id => index.Has(id) && id.Z <= residentMaxZoom,
            IsOcean = id => !index.Has(id),
            EarthCenter = V3(p.GetProperty("earthCenterScene")),
        });

        double fov = Num(p, "fovYDeg"), aspect = Num(p, "aspect"), screenH = Num(p, "screenHeightPx");
        var m = new Mismatches();
        var draw = new List<QuadNode>();
        var wants = new List<TileWant>();
        foreach (JsonElement f in p.GetProperty("frames").EnumerateArray())
        {
            int frame = f.GetProperty("frame").GetInt32();
            Vec3d pos = V3(f.GetProperty("position"));
            Quatd q = Q(f.GetProperty("quaternion"));
            double far = Num(f, "far");
            m.Close($"frame {frame} far", far, Lod.CameraFarForAltitudeM(pos.Y), 1e-12);

            Mat4d proj = Mat4d.PerspectiveProjection(fov, aspect, 2, far);
            Mat4d view = Mat4d.Compose(pos, q, new Vec3d(1, 1, 1)).Inverted();
            double[] wantProj = Nums(f, "projectionMatrix"), wantView = Nums(f, "matrixWorldInverse");
            for (int i = 0; i < 16; i++)
            {
                m.Close($"frame {frame} projection[{i}]", wantProj[i], proj.E[i], 1e-12);
                m.Close($"frame {frame} view[{i}]", wantView[i], view.E[i], 1e-9);
            }

            CameraFrustum frustum = CameraFrustum.FromProjectionView(Mat4d.Multiply(proj, view));
            quadtree.Update(pos, frustum, screenH, fov, Num(p, "detailScale"), Inf(p.GetProperty("detailDistanceM")), null,
                Num(p, "leafScale"), Num(f, "nowMs"), Inf(p.GetProperty("visibleZoomCap")), draw, wants);

            JsonElement d = f.GetProperty("draw");
            string[] wantKeys = d.GetProperty("keys").GetString()!.Split(',');
            string gotKeys = string.Join(",", draw.Select(n => n.Key));
            if (gotKeys != d.GetProperty("keys").GetString())
            {
                int first = 0;
                while (first < Math.Min(wantKeys.Length, draw.Count) && wantKeys[first] == draw[first].Key) first++;
                m.Fail($"frame {frame} draw differs: {wantKeys.Length} vs {draw.Count} nodes, first difference at #{first}: "
                    + $"{(first < wantKeys.Length ? wantKeys[first] : "-")} vs {(first < draw.Count ? draw[first].Key : "-")}");
                continue;
            }
            m.Equal($"frame {frame} state", d.GetProperty("state").GetString(),
                string.Concat(draw.Select(n => n.Resident ? 'R' : n.Ocean ? 'O' : '-')));
            m.Equal($"frame {frame} under", string.Join(",", d.GetProperty("under").EnumerateArray().Select(x => x.GetInt32())),
                string.Join(",", draw.Select((n, i) => (n, i)).Where(t => t.n.Under).Select(t => t.i)));
            var fades = d.GetProperty("fade").EnumerateArray().ToArray();
            var gotFades = draw.Select((n, i) => (n, i)).Where(t => t.n.FadeM != 0).ToArray();
            m.Equal($"frame {frame} fade count", fades.Length, gotFades.Length);
            for (int i = 0; i < Math.Min(fades.Length, gotFades.Length); i++)
            {
                double[] fe = Nums(fades[i]);
                m.Equal($"frame {frame} fade[{i}] index", (int)fe[0], gotFades[i].i);
                m.Close($"frame {frame} fade[{i}] fadeM", fe[1], gotFades[i].n.FadeM, 1e-9);
                m.Close($"frame {frame} fade[{i}] fadeFromMs", fe[2], gotFades[i].n.FadeFromMs, 0);
            }
            var expectedWants = f.GetProperty("wants").EnumerateArray().ToArray();
            m.Equal($"frame {frame} want count", expectedWants.Length, wants.Count);
            for (int i = 0; i < Math.Min(expectedWants.Length, wants.Count); i++)
            {
                m.Equal($"frame {frame} want[{i}] key", expectedWants[i].GetProperty("key").GetString(), wants[i].Id.ToString());
                m.Close($"frame {frame} want[{i}] ssePx", Num(expectedWants[i], "ssePx"), wants[i].SsePx, 1e-12);
                m.Close($"frame {frame} want[{i}] distanceM", Num(expectedWants[i], "distanceM"), wants[i].DistanceM, 1e-9);
            }
        }
        m.AssertNone();
    }
}
