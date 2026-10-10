using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Retro.Core;
using Xunit;

namespace Retro.Golden.Tests;

/// <summary>
/// Loads tests/golden fixtures (written by tools/golden/generate.ts) and
/// collects mismatches so one run reports every failure, not just the first.
/// </summary>
public static class Golden
{
    public static string Root
    {
        get
        {
            string root = typeof(Golden).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .First(a => a.Key == "GoldenRoot").Value!;
            return Path.GetFullPath(root);
        }
    }

    public static JsonElement Load(string file)
    {
        string path = Path.Combine(Root, file);
        Assert.True(File.Exists(path), $"missing fixture {path}; run npm run golden:generate");
        return JsonDocument.Parse(File.ReadAllText(path)).RootElement;
    }

    /// <summary>A fixture number; non-finite values are written as strings.</summary>
    public static double Num(JsonElement e)
    {
        if (e.ValueKind == JsonValueKind.String)
        {
            return e.GetString() switch
            {
                "NaN" => double.NaN,
                "Infinity" => double.PositiveInfinity,
                "-Infinity" => double.NegativeInfinity,
                var s => throw new FormatException($"not a number: {s}"),
            };
        }
        return e.GetDouble();
    }

    public static double Num(JsonElement e, string prop) => Num(e.GetProperty(prop));

    public static double[] Nums(JsonElement e) => e.EnumerateArray().Select(Num).ToArray();

    public static double[] Nums(JsonElement e, string prop) => Nums(e.GetProperty(prop));

    public static Vec3d V3(JsonElement e)
    {
        double[] a = Nums(e);
        return new Vec3d(a[0], a[1], a[2]);
    }

    public static Quatd Q(JsonElement e)
    {
        double[] a = Nums(e);
        return new Quatd(a[0], a[1], a[2], a[3]);
    }
}

/// <summary>Accumulates comparison failures for one test.</summary>
public sealed class Mismatches
{
    private readonly List<string> _items = new();
    public int Checked { get; private set; }

    public void Close(string what, double expected, double actual, double tol)
    {
        Checked++;
        if (double.IsNaN(expected) && double.IsNaN(actual)) return;
        if (double.IsInfinity(expected) && expected == actual) return;
        double scale = Math.Max(1, Math.Abs(expected));
        if (!(Math.Abs(expected - actual) <= tol * scale))
        {
            _items.Add($"{what}: expected {expected:R}, got {actual:R} (diff {actual - expected:G3}, tol {tol})");
        }
    }

    public void Close(string what, Vec3d expected, Vec3d actual, double tol)
    {
        Close(what + ".x", expected.X, actual.X, tol);
        Close(what + ".y", expected.Y, actual.Y, tol);
        Close(what + ".z", expected.Z, actual.Z, tol);
    }

    /// <summary>Quaternions compare up to sign: q and -q are the same rotation.</summary>
    public void CloseRotation(string what, Quatd expected, Quatd actual, double tol)
    {
        if (Quatd.Dot(expected, actual) < 0) actual = new Quatd(-actual.X, -actual.Y, -actual.Z, -actual.W);
        Close(what + ".x", expected.X, actual.X, tol);
        Close(what + ".y", expected.Y, actual.Y, tol);
        Close(what + ".z", expected.Z, actual.Z, tol);
        Close(what + ".w", expected.W, actual.W, tol);
    }

    public void Equal<T>(string what, T expected, T actual)
    {
        Checked++;
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            _items.Add($"{what}: expected {expected}, got {actual}");
        }
    }

    public void Fail(string what) => _items.Add(what);

    public void AssertNone()
    {
        Assert.True(Checked > 0, "nothing was compared");
        Assert.True(_items.Count == 0,
            $"{_items.Count} of {Checked} checks failed:\n  " + string.Join("\n  ", _items.Take(40)));
    }
}
