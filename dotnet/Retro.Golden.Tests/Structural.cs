using System;
using System.Collections;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Retro.Core;

namespace Retro.Golden.Tests;

/// <summary>
/// Compares a C# object against the oracle's describe() output (tools/golden/lib.ts):
/// scalars verbatim, typed arrays as {type, length, fnv1a32, head}, objects by
/// field with camelCase keys, Vec3d as [x, y, z]. Keys must match both ways, so
/// a field the port forgot (or invented) fails too.
/// </summary>
public static class Structural
{
    public static uint Fnv1a32(ReadOnlySpan<byte> bytes)
    {
        uint h = 0x811C9DC5;
        foreach (byte b in bytes) h = unchecked((h ^ b) * 0x01000193);
        return h;
    }

    // Exact runtime types: the CLR lets byte[] pass as sbyte[] (and ushort[] as
    // short[], uint[] as int[]), so `is` patterns would misname them.
    private static string TypedName(Array a)
    {
        Type t = a.GetType();
        if (t == typeof(short[])) return "Int16Array";
        if (t == typeof(sbyte[])) return "Int8Array";
        if (t == typeof(byte[])) return "Uint8Array";
        if (t == typeof(ushort[])) return "Uint16Array";
        if (t == typeof(uint[])) return "Uint32Array";
        if (t == typeof(float[])) return "Float32Array";
        if (t == typeof(double[])) return "Float64Array";
        return null;
    }

    private static ReadOnlySpan<byte> RawBytes(Array a) => a switch
    {
        short[] s => MemoryMarshal.AsBytes(s.AsSpan()),
        sbyte[] s => MemoryMarshal.AsBytes(s.AsSpan()),
        byte[] s => s,
        ushort[] s => MemoryMarshal.AsBytes(s.AsSpan()),
        uint[] s => MemoryMarshal.AsBytes(s.AsSpan()),
        float[] s => MemoryMarshal.AsBytes(s.AsSpan()),
        double[] s => MemoryMarshal.AsBytes(s.AsSpan()),
        _ => throw new ArgumentException(a.GetType().Name),
    };

    private static bool IsNumber(object o) =>
        o is byte or sbyte or short or ushort or int or uint or long or float or double || o is Enum;

    private static double ToDouble(object o) => o is Enum e ? Convert.ToDouble(Convert.ToInt64(e)) : Convert.ToDouble(o);

    private static string Camel(string name) => char.ToLowerInvariant(name[0]) + name.Substring(1);

    public static void Compare(string path, JsonElement expected, object actual, Mismatches m, double tol = 1e-12)
    {
        switch (expected.ValueKind)
        {
            case JsonValueKind.Null:
                if (actual != null) m.Fail($"{path}: expected null, got {actual}");
                else m.Equal(path, true, true);
                return;
            case JsonValueKind.True:
            case JsonValueKind.False:
                m.Equal(path, expected.GetBoolean(), actual is bool b && b);
                return;
            case JsonValueKind.Number:
                if (actual == null || !IsNumber(actual)) { m.Fail($"{path}: expected number {expected}, got {actual ?? "null"}"); return; }
                m.Close(path, expected.GetDouble(), ToDouble(actual), tol);
                return;
            case JsonValueKind.String:
                if (actual != null && IsNumber(actual)) { m.Close(path, Golden.Num(expected), ToDouble(actual), tol); return; }
                m.Equal(path, expected.GetString(), actual?.ToString());
                return;
            case JsonValueKind.Array:
                CompareArray(path, expected, actual, m, tol);
                return;
            case JsonValueKind.Object:
                CompareObject(path, expected, actual, m, tol);
                return;
        }
    }

    private static void CompareArray(string path, JsonElement expected, object actual, Mismatches m, double tol)
    {
        JsonElement[] items = expected.EnumerateArray().ToArray();
        if (actual is Vec3d v)
        {
            object[] xyz = { v.X, v.Y, v.Z };
            m.Equal(path + ".length", items.Length, 3);
            for (int i = 0; i < Math.Min(3, items.Length); i++) Compare($"{path}[{i}]", items[i], xyz[i], m, tol);
            return;
        }
        if (actual is not IList list) { m.Fail($"{path}: expected an array, got {actual?.GetType().Name ?? "null"}"); return; }
        if (actual is Array arr && TypedName(arr) != null && arr.GetType() != typeof(double[]))
        {
            m.Fail($"{path}: expected a plain array but the port has a typed {TypedName(arr)}");
            return;
        }
        m.Equal(path + ".length", items.Length, list.Count);
        for (int i = 0; i < Math.Min(items.Length, list.Count); i++) Compare($"{path}[{i}]", items[i], list[i], m, tol);
    }

    private static void CompareObject(string path, JsonElement expected, object actual, Mismatches m, double tol)
    {
        if (expected.TryGetProperty("fnv1a32", out JsonElement fnv) && expected.TryGetProperty("type", out JsonElement type))
        {
            if (actual is not Array a || TypedName(a) == null)
            {
                m.Fail($"{path}: expected {type.GetString()}, got {actual?.GetType().Name ?? "null"}");
                return;
            }
            m.Equal(path + ".type", type.GetString(), TypedName(a));
            m.Equal(path + ".length", expected.GetProperty("length").GetInt32(), a.Length);
            m.Equal(path + ".fnv1a32", fnv.GetString(), Fnv1a32(RawBytes(a)).ToString("x8"));
            int i = 0;
            foreach (JsonElement h in expected.GetProperty("head").EnumerateArray())
            {
                Compare($"{path}.head[{i}]", h, a.GetValue(i), m, tol);
                i++;
            }
            return;
        }
        if (expected.TryGetProperty("type", out JsonElement t2) && t2.GetString() == "Array" && expected.TryGetProperty("first", out JsonElement first))
        {
            if (actual is not IList list) { m.Fail($"{path}: expected a long array, got {actual?.GetType().Name ?? "null"}"); return; }
            m.Equal(path + ".length", expected.GetProperty("length").GetInt32(), list.Count);
            if (list.Count > 0) Compare(path + "[0]", first, list[0], m, tol);
            return;
        }
        if (actual == null) { m.Fail($"{path}: expected an object, got null"); return; }
        if (actual is TileKey k)
        {
            m.Equal(path + ".z", expected.GetProperty("z").GetInt32(), k.Z);
            m.Equal(path + ".x", expected.GetProperty("x").GetInt32(), k.X);
            m.Equal(path + ".y", expected.GetProperty("y").GetInt32(), k.Y);
            return;
        }
        FieldInfo[] fields = actual.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance);
        var byName = fields.ToDictionary(f => Camel(f.Name));
        foreach (JsonProperty p in expected.EnumerateObject())
        {
            if (!byName.TryGetValue(p.Name, out FieldInfo f)) { m.Fail($"{path}.{p.Name}: the port has no such field"); continue; }
            Compare($"{path}.{p.Name}", p.Value, f.GetValue(actual), m, tol);
        }
        foreach (var (name, f) in byName)
        {
            if (!expected.TryGetProperty(name, out _) && f.GetValue(actual) != null) m.Fail($"{path}.{name}: field not in the oracle's output");
        }
    }
}
