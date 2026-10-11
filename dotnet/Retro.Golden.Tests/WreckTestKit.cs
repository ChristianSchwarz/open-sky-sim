using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Core;
using Retro.Game;
using static Retro.Golden.Tests.Golden;

namespace Retro.Golden.Tests;

/// <summary>
/// Helpers shared by the wreck tests: a float32-exact replica of three.js
/// BoxGeometry(...).toNonIndexed().translate(), model specs from wreck.json, the
/// golden worlds, and FNV hashes over float32 / float64 bytes.
/// </summary>
public static class WreckTestKit
{
    public static string HashF32(ReadOnlySpan<float> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    public static string HashF64(ReadOnlySpan<double> a) => Structural.Fnv1a32(MemoryMarshal.AsBytes(a)).ToString("x8");

    /// <summary>A non-indexed geometry: float32 attributes, three vertices per triangle.</summary>
    public sealed class Geo
    {
        public float[] Position = Array.Empty<float>();
        public float[] Normal;
        public float[] Uv;
    }

    /// <summary>three.js BoxGeometry(width, height, depth, ws, hs, ds).toNonIndexed(), term for term.</summary>
    public static Geo Box(double width, double height, double depth, int widthSegments = 1, int heightSegments = 1, int depthSegments = 1)
    {
        var vertices = new List<float>();
        var normals = new List<float>();
        var uvs = new List<float>();
        var indices = new List<int>();
        int numberOfVertices = 0;
        void BuildPlane(int u, int v, int w, double udir, double vdir, double pw, double ph, double pd, int gridX, int gridY)
        {
            double segmentWidth = pw / gridX;
            double segmentHeight = ph / gridY;
            double widthHalf = pw / 2;
            double heightHalf = ph / 2;
            double depthHalf = pd / 2;
            int gridX1 = gridX + 1;
            int gridY1 = gridY + 1;
            int vertexCounter = 0;
            var vector = new double[3];
            for (int iy = 0; iy < gridY1; iy++)
            {
                double y = iy * segmentHeight - heightHalf;
                for (int ix = 0; ix < gridX1; ix++)
                {
                    double x = ix * segmentWidth - widthHalf;
                    vector[u] = x * udir;
                    vector[v] = y * vdir;
                    vector[w] = depthHalf;
                    vertices.Add((float)vector[0]);
                    vertices.Add((float)vector[1]);
                    vertices.Add((float)vector[2]);
                    vector[u] = 0;
                    vector[v] = 0;
                    vector[w] = pd > 0 ? 1 : -1;
                    normals.Add((float)vector[0]);
                    normals.Add((float)vector[1]);
                    normals.Add((float)vector[2]);
                    uvs.Add((float)((double)ix / gridX));
                    uvs.Add((float)(1 - ((double)iy / gridY)));
                    vertexCounter += 1;
                }
            }
            for (int iy = 0; iy < gridY; iy++)
            {
                for (int ix = 0; ix < gridX; ix++)
                {
                    int a = numberOfVertices + ix + gridX1 * iy;
                    int b = numberOfVertices + ix + gridX1 * (iy + 1);
                    int c = numberOfVertices + (ix + 1) + gridX1 * (iy + 1);
                    int d = numberOfVertices + (ix + 1) + gridX1 * iy;
                    indices.AddRange(new[] { a, b, d, b, c, d });
                }
            }
            numberOfVertices += vertexCounter;
        }
        BuildPlane(2, 1, 0, -1, -1, depth, height, width, depthSegments, heightSegments);
        BuildPlane(2, 1, 0, 1, -1, depth, height, -width, depthSegments, heightSegments);
        BuildPlane(0, 2, 1, 1, 1, width, depth, height, widthSegments, depthSegments);
        BuildPlane(0, 2, 1, 1, -1, width, depth, -height, widthSegments, depthSegments);
        BuildPlane(0, 1, 2, 1, -1, width, height, depth, widthSegments, heightSegments);
        BuildPlane(0, 1, 2, -1, -1, width, height, -depth, widthSegments, heightSegments);
        float[] Flat(List<float> src, int itemSize)
        {
            var output = new float[indices.Count * itemSize];
            for (int i = 0; i < indices.Count; i++)
            {
                for (int j = 0; j < itemSize; j++) output[i * itemSize + j] = src[indices[i] * itemSize + j];
            }
            return output;
        }
        return new Geo { Position = Flat(vertices, 3), Normal = Flat(normals, 3), Uv = Flat(uvs, 2) };
    }

    /// <summary>BufferGeometry.translate: positions through makeTranslation (float32 store), normals through its normal matrix.</summary>
    public static Geo Translate(Geo g, double x, double y, double z)
    {
        double[] m = WreckMath.MakeTranslation(x, y, z);
        double[] nm = WreckMath.NormalMatrix(m);
        var p = (float[])g.Position.Clone();
        for (int i = 0; i + 2 < p.Length; i += 3)
        {
            Vec3d r = WreckMath.ApplyMatrix4(new Vec3d(p[i], p[i + 1], p[i + 2]), m);
            p[i] = (float)r.X;
            p[i + 1] = (float)r.Y;
            p[i + 2] = (float)r.Z;
        }
        float[] n = g.Normal == null ? null : (float[])g.Normal.Clone();
        for (int i = 0; n != null && i + 2 < n.Length; i += 3)
        {
            Vec3d r = WreckMath.ApplyMatrix3(new Vec3d(n[i], n[i + 1], n[i + 2]), nm).Normalized();
            n[i] = (float)r.X;
            n[i + 1] = (float)r.Y;
            n[i + 2] = (float)r.Z;
        }
        return new Geo { Position = p, Normal = n, Uv = g.Uv };
    }

    public static WreckMeshInput Mesh(Geo g, object material, Vec3d position = default) => new WreckMeshInput
    {
        Positions = g.Position,
        Normals = g.Normal,
        Uvs = g.Uv,
        UvSize = 2,
        Matrix = WreckMath.Compose(position, Quatd.Identity, new Vec3d(1, 1, 1)),
        Material = material,
    };

    private static float[] Floats(JsonElement e) => e.EnumerateArray().Select(x => (float)Num(x)).ToArray();

    /// <summary>A model spec of wreck.json; for box specs, the replica's hashes are checked against the TS ones.</summary>
    public static WreckModel ModelFromSpec(JsonElement spec, Mismatches m, string name)
    {
        var model = new WreckModel { MaxSize = Num(spec, "maxSize") };
        if (spec.TryGetProperty("meshes", out JsonElement meshes) && meshes.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement mesh in meshes.EnumerateArray())
            {
                model.Meshes.Add(new WreckMeshInput
                {
                    Positions = Floats(mesh.GetProperty("positions")),
                    Normals = mesh.GetProperty("normals").ValueKind == JsonValueKind.Null ? null : Floats(mesh.GetProperty("normals")),
                    Indices = mesh.GetProperty("indices").ValueKind == JsonValueKind.Null ? null : mesh.GetProperty("indices").EnumerateArray().Select(x => x.GetInt32()).ToArray(),
                    Matrix = Nums(mesh, "matrix"),
                    Material = mesh.GetProperty("material").GetString(),
                });
            }
        }
        if (spec.TryGetProperty("boxes", out JsonElement boxes) && boxes.ValueKind == JsonValueKind.Array)
        {
            int k = 0;
            foreach (JsonElement b in boxes.EnumerateArray())
            {
                double[] a = Nums(b, "args");
                Geo g = Box(a[0], a[1], a[2], (int)a[3], (int)a[4], (int)a[5]);
                if (b.GetProperty("translate").ValueKind != JsonValueKind.Null)
                {
                    double[] t = Nums(b, "translate");
                    g = Translate(g, t[0], t[1], t[2]);
                }
                JsonElement hash = b.GetProperty("hash");
                m.Equal($"{name} box {k} position", hash.GetProperty("position").GetString(), HashF32(g.Position));
                m.Equal($"{name} box {k} normal", hash.GetProperty("normal").GetString(), HashF32(g.Normal));
                m.Equal($"{name} box {k} uv", hash.GetProperty("uv").GetString(), HashF32(g.Uv));
                model.Meshes.Add(Mesh(g, b.GetProperty("material").GetString(), V3(b.GetProperty("position"))));
                k++;
            }
        }
        return model;
    }

    /// <summary>The golden worlds' ground height (see wreck.json notes).</summary>
    public static Func<double, double, double> Ground(string world, Func<double> deckZ) => world switch
    {
        "slope" => (x, z) => 3 + 0.02 * x - 0.015 * z + 1.5 * JsTrig.Sin(x * 0.013) * JsTrig.Cos(z * 0.011),
        "seabed" => (x, z) => -30,
        "deck" => (x, z) => Math.Abs(x) < 15 && Math.Abs(z - deckZ()) < 140 ? 18 : -25,
        "coast" => (x, z) => x > 60 ? -20 : 0.5 + 0.01 * z,
        _ => (x, z) => 0,
    };

    public sealed class Surface : IWreckMovingSurface
    {
        public Vec3d Velocity { get; set; }
        public Func<double, double, double, bool> Test;
        public bool Contains(double x, double y, double z) => Test(x, y, z);
    }
}
